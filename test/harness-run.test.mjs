import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createHarnessRunManager } from "../src/harness-runs.mjs";
import { createProjectRegistry } from "../src/project-registration.mjs";

const execFileAsync = promisify(execFile);
const hostId = `host-${"1".repeat(24)}`;
const controllerId = `runtime-${"2".repeat(24)}`;
const controllerSessionId = `controller-session-${"3".repeat(24)}`;

const waitForTerminal = async (manager, harnessRunId) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const observation = await manager.observe({
      requestId: "observe-run",
      harnessRunId,
      afterSequence: 0,
    });
    if (["succeeded", "failed", "cancelled"].includes(observation.run?.status)) {
      return observation;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("harness_run_terminal_timeout");
};

const createFixture = async (prefix) => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const dataDir = join(root, "host-state");
  const projectPath = join(root, "selected-project");
  const audits = [];
  const recordAudit = async (action, outcome, details = {}, requestedAuditId) => {
    if (requestedAuditId && audits.some((audit) => audit.auditId === requestedAuditId)) {
      return requestedAuditId;
    }
    const auditId = requestedAuditId
      ?? `audit-${String(audits.length + 1).padStart(24, "0")}`;
    audits.push({ auditId, action, outcome, details });
    return auditId;
  };
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
  await writeFile(join(projectPath, "README.md"), "ordinary Project content\n");
  const registry = await createProjectRegistry({ dataDir, recordAudit });
  const registered = await registry.registerProject({
    requestId: "register-run-project",
    path: projectPath,
    configuration: {
      issueWorkflow: { provider: "github", kind: "issues" },
      checks: [
        { checkId: "typecheck", command: "npm run typecheck" },
        { checkId: "test", command: "npm run test" },
      ],
    },
    authorizationClass: "host_local_project_registration",
    idempotencyKey: "register-run-project",
    expectedRevision: 0,
  });
  const harness = await registry.registerConformanceHarness({
    requestId: "register-run-harness",
    name: "Sand-King Conformance Harness",
    authorizationClass: "host_local_harness_registration",
    idempotencyKey: "register-run-harness",
    expectedRevision: 0,
  });
  await registry.pinConformanceHarness({
    requestId: "pin-run-harness",
    projectId: registered.project.projectId,
    harnessId: harness.harness.harnessId,
    immutableRevision: harness.harness.immutableRevision,
    boundedConfiguration: {
      adapterProtocol: "1.0.0",
      launchProfile: "delegated-work",
    },
    authorizationClass: "host_local_project_configuration",
    idempotencyKey: "pin-run-harness",
    expectedRevision: 1,
  });
  const manager = await createHarnessRunManager({
    dataDir,
    hostId,
    recordAudit,
    loadLaunchContext: registry.loadLaunchContext,
  });
  return {
    root,
    dataDir,
    projectPath,
    audits,
    registry,
    registered,
    harness,
    manager,
    recordAudit,
  };
};

const launchRequest = (projectId, issueNumber, overrides = {}) => ({
  requestId: `launch-${issueNumber}`,
  projectId,
  parameters: {
    issueNumber,
    targetBranch: `sandcastle/issue-${issueNumber}`,
  },
  controllerId,
  controllerSessionId,
  source: "controller-cli",
  authorizationClass: "harness_run_launch",
  idempotencyKey: `launch-${issueNumber}`,
  ...overrides,
});

const hashedLaunchRequest = (request) => {
  const { idempotencyKey, ...content } = request;
  return {
    ...content,
    idempotencyKeyHash: `sha256:${createHash("sha256").update(idempotencyKey).digest("hex")}`,
  };
};

test("one revision-free action launches a fresh Project's Harness run", async () => {
  const fixture = await createFixture("sandking-harness-run-");
  const projectFilesBefore = (await readdir(fixture.projectPath)).sort();
  try {
    const request = launchRequest(fixture.registered.project.projectId, 152);
    assert.equal("expectedRevision" in request, false);
    const launched = await fixture.manager.launch(request);
    assert.equal(launched.type, "harness.run.launch.result");
    assert.equal(launched.code, "harness_run_created");
    assert.equal(launched.idempotentReplay, false);
    assert.equal(launched.run.status, "starting");
    assert.deepEqual(launched.run.parameters, request.parameters);
    assert.equal(launched.run.source, "controller-cli");
    assert.equal(launched.run.controllerSessionId, controllerSessionId);
    assert.equal("launchRequestId" in launched.run, false);
    assert.equal("expectedRevision" in launched, false);
    assert.match(launched.run.harnessRunId, /^harness-run-[a-f0-9]{24}$/);
    assert.deepEqual(launched.run.executionSnapshot, {
      schemaVersion: 1,
      capture: "launch",
      hostId,
      projectRegistration: {
        projectId: fixture.registered.project.projectId,
        revision: fixture.registered.project.revision + 1,
        displayName: fixture.registered.project.displayName,
      },
      harness: {
        harnessId: fixture.harness.harness.harnessId,
        revision: fixture.harness.harness.revision,
        name: fixture.harness.harness.name,
        pinnedRevision: fixture.harness.harness.immutableRevision,
      },
      adapter: {
        adapterId: "conformance-harness-adapter-v1",
        protocol: "1.0.0",
        entryPoint: "adapters/conformance.mjs",
      },
      parameters: request.parameters,
      source: "controller-cli",
      attribution: {
        controllerId,
        controllerSessionId,
      },
      createdAt: launched.run.createdAt,
      credentialCapabilityReferences: ["github.issues.read", "project.git.read"],
      launchAuditId: launched.auditId,
    });

    const replay = await fixture.manager.launch({ ...request, requestId: "launch-replay" });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.run.harnessRunId, launched.run.harnessRunId);
    assert.equal(replay.auditId, launched.auditId);
    const lookup = await fixture.manager.lookup({
      requestId: "lookup-launch",
      idempotencyKey: request.idempotencyKey,
    });
    assert.equal(lookup.code, "harness_run_launch_outcome_found");
    assert.equal(lookup.launchOutcome.run.harnessRunId, launched.run.harnessRunId);

    const observation = await waitForTerminal(fixture.manager, launched.run.harnessRunId);
    assert.equal(observation.run.status, "succeeded");
    assert.equal(observation.outcome.code, "conformance_run_succeeded");
    assert.equal("launchRequest" in observation, false);
    assert.deepEqual(observation.events.map(({ sequence, type }) => ({ sequence, type })), [
      { sequence: 1, type: "harness_run_created" },
      { sequence: 2, type: "harness_adapter_ready" },
      { sequence: 3, type: "harness_progress_published" },
      { sequence: 4, type: "harness_run_succeeded" },
    ]);
    assert.deepEqual((await readdir(fixture.projectPath)).sort(), projectFilesBefore);
    await assert.rejects(access(join(fixture.dataDir, "launch-requests.json")));
    assert.ok(fixture.audits.some((entry) =>
      entry.action === "harness.run.launch"
      && entry.outcome === "accepted"
      && entry.details.projectId === fixture.registered.project.projectId));
    assert.ok(fixture.audits.some((entry) =>
      entry.action === "harness.run.outcome"
      && entry.details.harnessRunId === launched.run.harnessRunId));

    const cockpitLaunch = await fixture.manager.launch(launchRequest(
      fixture.registered.project.projectId,
      153,
      {
        requestId: "cockpit-launch",
        idempotencyKey: "cockpit-launch",
        source: "cockpit",
        controllerSessionId: null,
      },
    ));
    assert.equal(cockpitLaunch.type, "harness.run.launch.result");
    assert.equal(cockpitLaunch.run.source, "cockpit");
    assert.equal(cockpitLaunch.run.controllerSessionId, null);
    await waitForTerminal(fixture.manager, cockpitLaunch.run.harnessRunId);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("launch commit interruptions leave pre-commit work unclaimed and replay post-commit work", async () => {
  const preCommit = await createFixture("sandking-harness-launch-pre-commit-");
  const postCommit = await createFixture("sandking-harness-launch-post-commit-");
  const auditCommit = await createFixture("sandking-harness-launch-audit-commit-");
  const rawRetryKey = "recognizable-raw-launch-retry-key";
  const pointBeforeCommit = "harness_run_launch.before_commit";
  const pointAfterCommit = "harness_run_launch.after_commit";
  try {
    const preFaults = [];
    const preManager = await createHarnessRunManager({
      dataDir: preCommit.dataDir,
      hostId,
      recordAudit: preCommit.recordAudit,
      loadLaunchContext: preCommit.registry.loadLaunchContext,
      faultInjector: async (point) => {
        preFaults.push(point);
        if (point === pointBeforeCommit) throw new Error("injected_pre_commit_interrupt");
      },
    });
    const preRequest = hashedLaunchRequest(launchRequest(
      preCommit.registered.project.projectId,
      159,
      { idempotencyKey: rawRetryKey },
    ));
    await assert.rejects(preManager.launch(preRequest), /injected_pre_commit_interrupt/);
    assert.deepEqual(preFaults, [pointBeforeCommit]);
    const preLookup = await preManager.lookup({
      requestId: "lookup-pre-commit-launch",
      idempotencyKeyHash: preRequest.idempotencyKeyHash,
    });
    assert.equal(preLookup.found, false);
    assert.equal(preCommit.audits.some((audit) =>
      audit.action === "harness.run.launch" && audit.outcome === "accepted"), false);
    assert.equal(
      await readFile(join(preCommit.dataDir, "harness-runs.json"), "utf8")
        .then((source) => JSON.parse(source).runs.length, () => 0),
      0,
    );

    const projectFilesBefore = (await readdir(postCommit.projectPath)).sort();
    const postFaults = [];
    const postManager = await createHarnessRunManager({
      dataDir: postCommit.dataDir,
      hostId,
      recordAudit: postCommit.recordAudit,
      loadLaunchContext: postCommit.registry.loadLaunchContext,
      faultInjector: async (point) => {
        postFaults.push(point);
        if (point === pointAfterCommit) throw new Error("injected_post_commit_interrupt");
      },
    });
    const postRequest = hashedLaunchRequest(launchRequest(
      postCommit.registered.project.projectId,
      159,
      { idempotencyKey: rawRetryKey },
    ));
    await assert.rejects(postManager.launch(postRequest), /injected_post_commit_interrupt/);
    assert.deepEqual(postFaults, [pointBeforeCommit, pointAfterCommit]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const committed = JSON.parse(
      await readFile(join(postCommit.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(committed.runs.length, 1);
    assert.equal(committed.launchOutcomes.length, 1);
    assert.equal(committed.runs[0].status, "starting");
    assert.deepEqual(committed.runs[0].events.map((event) => event.type), [
      "harness_run_created",
    ]);
    assert.equal(postCommit.audits.some((audit) =>
      audit.action === "harness.run.launch" && audit.outcome === "accepted"), false);
    assert.doesNotMatch(JSON.stringify({ committed, audits: postCommit.audits }),
      new RegExp(rawRetryKey));

    const restarted = await createHarnessRunManager({
      dataDir: postCommit.dataDir,
      hostId,
      recordAudit: postCommit.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("mutable_launch_context_must_not_be_resolved_for_replay");
      },
    });
    const lookup = await restarted.lookup({
      requestId: "lookup-post-commit-launch",
      idempotencyKeyHash: postRequest.idempotencyKeyHash,
    });
    assert.equal(lookup.found, true);
    const repairedLaunchAudits = postCommit.audits.filter((audit) =>
      audit.action === "harness.run.launch" && audit.outcome === "accepted");
    assert.equal(repairedLaunchAudits.length, 1);
    assert.equal(repairedLaunchAudits[0].auditId, committed.runs[0].launchAuditId);
    assert.equal(repairedLaunchAudits[0].details.harnessRunId,
      committed.runs[0].harnessRunId);
    const replay = await restarted.launch({
      ...postRequest,
      requestId: "replay-post-commit-launch",
      parameters: {
        targetBranch: "sandcastle/issue-159",
        issueNumber: 159,
      },
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.run.harnessRunId, lookup.launchOutcome.run.harnessRunId);

    const conflict = await restarted.launch({
      ...postRequest,
      requestId: "conflict-post-commit-launch",
      parameters: { issueNumber: 160, targetBranch: "sandcastle/issue-160" },
    });
    assert.equal(conflict.code, "idempotency_key_conflict");
    assert.deepEqual(conflict.prohibitedSideEffects, {
      harnessRunCreated: false,
      projectWrite: false,
    });
    const afterReplay = JSON.parse(
      await readFile(join(postCommit.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(afterReplay.runs.length, 1);
    assert.equal(afterReplay.launchOutcomes.length, 1);
    assert.equal(afterReplay.runs[0].events.length, 1);
    assert.deepEqual((await readdir(postCommit.projectPath)).sort(), projectFilesBefore);

    let interruptAcceptedAudit = true;
    const auditManager = await createHarnessRunManager({
      dataDir: auditCommit.dataDir,
      hostId,
      recordAudit: async (...args) => {
        const auditId = await auditCommit.recordAudit(...args);
        if (args[0] === "harness.run.launch" && args[1] === "accepted"
          && interruptAcceptedAudit) {
          interruptAcceptedAudit = false;
          throw new Error("injected_accepted_audit_interrupt");
        }
        return auditId;
      },
      loadLaunchContext: auditCommit.registry.loadLaunchContext,
    });
    const auditRequest = hashedLaunchRequest(launchRequest(
      auditCommit.registered.project.projectId,
      159,
      { idempotencyKey: "audit-commit-retry-key" },
    ));
    await assert.rejects(auditManager.launch(auditRequest),
      /injected_accepted_audit_interrupt/);
    const acceptedAudit = auditCommit.audits.find((audit) =>
      audit.action === "harness.run.launch" && audit.outcome === "accepted");
    assert.ok(acceptedAudit);
    const auditLookup = await auditManager.lookup({
      requestId: "lookup-audit-commit-launch",
      idempotencyKeyHash: auditRequest.idempotencyKeyHash,
    });
    assert.equal(auditLookup.found, true);
    assert.equal(auditLookup.launchOutcome.run.harnessRunId,
      acceptedAudit.details.harnessRunId);
    const auditReplay = await auditManager.launch({
      ...auditRequest,
      requestId: "replay-audit-commit-launch",
    });
    assert.equal(auditReplay.idempotentReplay, true);
    assert.equal(auditReplay.run.harnessRunId, acceptedAudit.details.harnessRunId);
    assert.equal(JSON.parse(
      await readFile(join(auditCommit.dataDir, "harness-runs.json"), "utf8"),
    ).runs.length, 1);
  } finally {
    await Promise.all([
      rm(preCommit.root, { recursive: true, force: true }),
      rm(postCommit.root, { recursive: true, force: true }),
      rm(auditCommit.root, { recursive: true, force: true }),
    ]);
  }
});

test("retained execution snapshots do not follow later Project or Harness registration changes", async () => {
  const fixture = await createFixture("sandking-immutable-execution-snapshot-");
  try {
    const request = launchRequest(fixture.registered.project.projectId, 159);
    const launched = await fixture.manager.launch(request);
    await waitForTerminal(fixture.manager, launched.run.harnessRunId);
    const originalSnapshot = structuredClone(launched.run.executionSnapshot);

    const projectStatePath = join(fixture.dataDir, "project-registrations.json");
    const harnessStatePath = join(fixture.dataDir, "harness-registry.json");
    const projectState = JSON.parse(await readFile(projectStatePath, "utf8"));
    const harnessState = JSON.parse(await readFile(harnessStatePath, "utf8"));
    projectState.projects[0].revision += 1;
    projectState.projects[0].displayName = "renamed-after-launch";
    projectState.projects[0].harness.pinnedRevision = "a".repeat(40);
    harnessState.harnesses[0].revision += 1;
    harnessState.harnesses[0].name = "Renamed Harness after launch";
    harnessState.harnesses[0].immutableRevision = "a".repeat(40);
    harnessState.harnesses[0].launchParameters = { kind: "none" };
    await Promise.all([
      writeFile(projectStatePath, `${JSON.stringify(projectState)}\n`),
      writeFile(harnessStatePath, `${JSON.stringify(harnessState)}\n`),
    ]);

    let mutableContextResolved = false;
    const restarted = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        mutableContextResolved = true;
        throw new Error("mutable_launch_context_must_not_be_resolved");
      },
    });
    const observation = await restarted.observe({
      requestId: "observe-immutable-execution-snapshot",
      harnessRunId: launched.run.harnessRunId,
      afterSequence: 0,
    });
    assert.deepEqual(observation.run.executionSnapshot, originalSnapshot);
    const replay = await restarted.launch({ ...request, requestId: "replay-immutable-snapshot" });
    assert.equal(replay.idempotentReplay, true);
    assert.deepEqual(replay.run.executionSnapshot, originalSnapshot);
    assert.equal(mutableContextResolved, false);
    assert.deepEqual(
      JSON.parse(await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"))
        .runs[0].executionSnapshot,
      originalSnapshot,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a pinned Harness declaration permits a launch with no parameters", async () => {
  const fixture = await createFixture("sandking-parameterless-harness-run-");
  try {
    assert.deepEqual(
      fixture.harness.harness.launchParameters.fields.map((field) => ({
        name: field.name,
        required: field.required,
      })),
      [
        { name: "issueNumber", required: false },
        { name: "targetBranch", required: false },
      ],
    );
    const launched = await fixture.manager.launch({
      requestId: "launch-without-parameters",
      projectId: fixture.registered.project.projectId,
      controllerId,
      controllerSessionId,
      source: "controller-cli",
      authorizationClass: "harness_run_launch",
      idempotencyKey: "launch-without-parameters",
    });

    assert.equal(launched.type, "harness.run.launch.result");
    assert.deepEqual(launched.run.parameters, {});
    const replay = await fixture.manager.launch({
      requestId: "launch-with-empty-parameters",
      projectId: fixture.registered.project.projectId,
      parameters: {},
      controllerId,
      controllerSessionId,
      source: "controller-cli",
      authorizationClass: "harness_run_launch",
      idempotencyKey: "launch-without-parameters",
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.run.harnessRunId, launched.run.harnessRunId);
    const observation = await waitForTerminal(fixture.manager, launched.run.harnessRunId);
    assert.equal(observation.run.status, "succeeded");
    assert.equal(observation.outcome.code, "conformance_run_succeeded");
    assert.match(
      observation.outcome.result.placeholderIdentifier,
      /^conformance-placeholder-[a-f0-9]{24}$/,
    );
    const rejected = await fixture.manager.launch({
      requestId: "launch-with-undeclared-parameter",
      projectId: fixture.registered.project.projectId,
      parameters: { genericSurfaceGuess: true },
      controllerId,
      controllerSessionId,
      source: "controller-cli",
      authorizationClass: "harness_run_launch",
      idempotencyKey: "launch-with-undeclared-parameter",
    });
    assert.equal(rejected.type, "harness.run.launch.failure");
    assert.equal(rejected.code, "bounded_configuration_invalid");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a retained pre-declaration Harness still launches with explicit parameters", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-retained-harness-run-"));
  const legacyCheckout = join(root, "pre-issue-155");
  const dataDir = join(root, "host-state");
  const projectPath = join(root, "selected-project");
  const audits = [];
  const recordAudit = async (action, outcome, details = {}, requestedAuditId) => {
    if (requestedAuditId && audits.some((audit) => audit.auditId === requestedAuditId)) {
      return requestedAuditId;
    }
    const auditId = requestedAuditId
      ?? `audit-${String(audits.length + 1).padStart(24, "0")}`;
    audits.push({ auditId, action, outcome, details });
    return auditId;
  };
  try {
    await execFileAsync("git", ["clone", "--quiet", "--no-checkout", process.cwd(), legacyCheckout]);
    await execFileAsync("git", [
      "-C", legacyCheckout,
      "checkout", "--quiet", "--detach", "ca06fb7906dca384c8a1ff49114d701df9e925b6",
    ]);
    await symlink(join(process.cwd(), "node_modules"), join(legacyCheckout, "node_modules"), "dir");
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
    await writeFile(join(projectPath, "README.md"), "ordinary Project content\n");

    const legacyModule = await import(pathToFileURL(
      join(legacyCheckout, "src", "project-registration.mjs"),
    ).href);
    const legacyRegistry = await legacyModule.createProjectRegistry({ dataDir, recordAudit });
    const registered = await legacyRegistry.registerProject({
      requestId: "register-retained-project",
      path: projectPath,
      configuration: {
        issueWorkflow: { provider: "github", kind: "issues" },
        checks: [{ checkId: "test", command: "npm test" }],
      },
      authorizationClass: "host_local_project_registration",
      idempotencyKey: "register-retained-project",
      expectedRevision: 0,
    });
    const harness = await legacyRegistry.registerConformanceHarness({
      requestId: "register-retained-harness",
      name: "Sand-King Conformance Harness",
      authorizationClass: "host_local_harness_registration",
      idempotencyKey: "register-retained-harness",
      expectedRevision: 0,
    });
    await legacyRegistry.pinConformanceHarness({
      requestId: "pin-retained-harness",
      projectId: registered.project.projectId,
      harnessId: harness.harness.harnessId,
      immutableRevision: harness.harness.immutableRevision,
      boundedConfiguration: {
        adapterProtocol: "1.0.0",
        launchProfile: "delegated-work",
      },
      authorizationClass: "host_local_project_configuration",
      idempotencyKey: "pin-retained-harness",
      expectedRevision: 1,
    });
    const retainedHarnessState = JSON.parse(
      await readFile(join(dataDir, "harness-registry.json"), "utf8"),
    );
    assert.equal("launchParameters" in retainedHarnessState.harnesses[0], false);

    const registry = await createProjectRegistry({ dataDir, recordAudit });
    const retainedContext = await registry.loadLaunchContext(registered.project.projectId);
    assert.deepEqual(
      retainedContext.harness.launchParameters.fields.map(({ name, required }) => ({
        name,
        required,
      })),
      [
        { name: "issueNumber", required: true },
        { name: "targetBranch", required: true },
      ],
    );
    const manager = await createHarnessRunManager({
      dataDir,
      hostId,
      recordAudit,
      loadLaunchContext: registry.loadLaunchContext,
    });
    const parameters = {
      issueNumber: 155,
      targetBranch: "sandcastle/issue-155",
    };
    const launched = await manager.launch({
      requestId: "launch-retained-harness",
      projectId: registered.project.projectId,
      parameters,
      controllerId,
      controllerSessionId,
      source: "controller-cli",
      authorizationClass: "harness_run_launch",
      idempotencyKey: "launch-retained-harness",
    });

    assert.equal(launched.type, "harness.run.launch.result", JSON.stringify(launched));
    assert.deepEqual(launched.run.parameters, parameters);
    const observation = await waitForTerminal(manager, launched.run.harnessRunId);
    assert.equal(observation.run.status, "succeeded");
    assert.deepEqual(observation.outcome.result, {
      kind: "conformance-result",
      issueNumber: 155,
      targetBranch: "sandcastle/issue-155",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter lifecycle failures remain truthful under the single launch action", async () => {
  const fixture = await createFixture("sandking-harness-failure-");
  try {
    const expected = new Map([
      [999_999_999, ["harness_result_incomplete", [0]]],
      [999_999_996, ["harness_result_incomplete", [2]]],
      [999_999_995, ["harness_adapter_protocol_invalid", [0]]],
      [999_999_998, ["harness_adapter_protocol_invalid", [0]]],
      // The terminal frame may already be buffered when the over-limit progress
      // frame terminates the adapter. Either count is truthful; it never makes
      // the protocol-invalid outcome an exactly-one valid terminal result.
      [999_999_997, ["harness_adapter_protocol_invalid", [0, 1]]],
    ]);
    for (const [issueNumber, [outcomeCode, terminalCounts]] of expected) {
      const launched = await fixture.manager.launch(launchRequest(
        fixture.registered.project.projectId,
        issueNumber,
      ));
      assert.equal(launched.type, "harness.run.launch.result");
      const observation = await waitForTerminal(fixture.manager, launched.run.harnessRunId);
      assert.equal(observation.run.status, "failed");
      assert.equal(observation.outcome.code, outcomeCode);
      assert.equal(observation.outcome.incompleteResult, true);
      assert.ok(
        terminalCounts.includes(
          observation.terminalEnvelopeValidation.validTerminalEnvelopeCount,
        ),
        `issue ${issueNumber}`,
      );
      assert.equal(observation.terminalEnvelopeValidation.exactlyOne, false);
      assert.equal(observation.events.at(-1).type, "harness_run_failed");
      if (issueNumber === 999_999_998) {
        assert.equal(observation.events.some((event) =>
          event.type === "harness_progress_published"), false);
      }
      if (issueNumber === 999_999_997) {
        assert.equal(observation.events.length, 1_024);
        assert.equal(observation.events.at(-1).sequence, 1_024);
      }
    }

    const misleading = (await fixture.manager.observe({
      requestId: "observe-incomplete",
      harnessRunId: null,
      afterSequence: 0,
    })).run;
    assert.ok(misleading);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("distinct launch outcomes remain durable and lookup-safe past 256 keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-harness-launch-outcomes-"));
  const dataDir = join(root, "host-state");
  let auditSequence = 0;
  const recordAudit = async () => {
    auditSequence += 1;
    return `audit-${String(auditSequence).padStart(24, "0")}`;
  };
  try {
    const options = {
      dataDir,
      hostId,
      recordAudit,
      loadLaunchContext: async () => {
        throw new Error("project_not_found");
      },
    };
    const manager = await createHarnessRunManager(options);
    for (let index = 0; index < 257; index += 1) {
      const outcome = await manager.launch(launchRequest(
        `project-${"4".repeat(24)}`,
        index + 1,
        {
          requestId: `missing-project-${index}`,
          idempotencyKey: `missing-project-key-${index}`,
        },
      ));
      assert.equal(outcome.type, "harness.run.launch.failure");
      assert.equal(outcome.code, "project_not_found");
    }
    const retained = JSON.parse(await readFile(join(dataDir, "harness-runs.json"), "utf8"));
    assert.equal(retained.schemaVersion, 3);
    assert.equal(retained.launchOutcomes.length, 257);
    const reloaded = await createHarnessRunManager(options);
    const first = await reloaded.lookup({
      requestId: "lookup-first",
      idempotencyKey: "missing-project-key-0",
    });
    assert.equal(first.found, true);
    assert.equal(first.launchOutcome.code, "project_not_found");
    const conflict = await reloaded.launch(launchRequest(
      `project-${"4".repeat(24)}`,
      999,
      {
        requestId: "conflicting-key",
        idempotencyKey: "missing-project-key-0",
      },
    ));
    assert.equal(conflict.code, "idempotency_key_conflict");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema-v2 execution history migrates deterministically without losing accepted state", async () => {
  const fixture = await createFixture("sandking-harness-v2-upgrade-");
  try {
    const request = launchRequest(fixture.registered.project.projectId, 159);
    const launched = await fixture.manager.launch(request);
    const terminal = await waitForTerminal(fixture.manager, launched.run.harnessRunId);
    assert.equal(terminal.run.status, "succeeded");

    const v3 = JSON.parse(await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"));
    const v2 = structuredClone(v3);
    v2.schemaVersion = 2;
    for (const run of v2.runs) delete run.executionSnapshot;
    for (const outcome of [...v2.launchOutcomes, ...v2.legacyStartOutcomes]) {
      if (outcome.response?.run) delete outcome.response.run.executionSnapshot;
    }
    const acceptedLaunchOutcome = structuredClone(v2.launchOutcomes[0].response);
    assert.equal(acceptedLaunchOutcome.run.revision, 1);
    assert.equal(acceptedLaunchOutcome.run.status, "starting");
    assert.ok(v2.runs[0].revision > acceptedLaunchOutcome.run.revision);
    assert.equal(v2.runs[0].status, "succeeded");
    await writeFile(join(fixture.dataDir, "harness-runs.json"), `${JSON.stringify(v2)}\n`);

    let mutableContextResolved = false;
    const migratedManager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        mutableContextResolved = true;
        throw new Error("project_not_found");
      },
    });
    assert.equal(mutableContextResolved, false);
    const migrated = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(migrated.schemaVersion, 3);
    const { executionSnapshot: migratedSnapshot, ...migratedHistory } = migrated.runs[0];
    const { executionSnapshot: originalSnapshot, ...originalHistory } = v3.runs[0];
    void originalSnapshot;
    assert.deepEqual(migratedHistory, originalHistory);
    assert.deepEqual(migratedSnapshot, {
      schemaVersion: 1,
      capture: "migration",
      hostId: originalHistory.hostId,
      projectRegistration: {
        projectId: originalHistory.projectId,
        revision: null,
        displayName: null,
      },
      harness: {
        harnessId: originalHistory.harnessId,
        revision: null,
        name: null,
        pinnedRevision: originalHistory.harnessPinnedRevision,
      },
      adapter: {
        adapterId: originalHistory.adapterId,
        protocol: originalHistory.adapterProtocol,
        entryPoint: originalHistory.adapterEntryPoint,
      },
      parameters: originalHistory.parameters,
      source: originalHistory.source,
      attribution: {
        controllerId: originalHistory.controllerId,
        controllerSessionId: originalHistory.controllerSessionId,
      },
      createdAt: originalHistory.createdAt,
      credentialCapabilityReferences: null,
      launchAuditId: originalHistory.launchAuditId,
    });
    assert.deepEqual(migrated.runs[0].events, v3.runs[0].events);
    assert.deepEqual(migrated.runs[0].outcome, v3.runs[0].outcome);
    assert.deepEqual(migrated.runs[0].logStreams, v3.runs[0].logStreams);
    const migratedLaunchOutcome = migrated.launchOutcomes[0].response;
    const { executionSnapshot: retainedOutcomeSnapshot, ...retainedOutcomeRun } =
      migratedLaunchOutcome.run;
    assert.deepEqual(retainedOutcomeRun, acceptedLaunchOutcome.run);
    assert.deepEqual({
      ...migratedLaunchOutcome,
      run: acceptedLaunchOutcome.run,
    }, acceptedLaunchOutcome);
    assert.deepEqual(retainedOutcomeSnapshot, migratedSnapshot);

    const lookup = await migratedManager.lookup({
      requestId: "lookup-migrated-v2-launch",
      idempotencyKey: request.idempotencyKey,
    });
    assert.equal(lookup.found, true);
    assert.equal(lookup.launchOutcome.run.harnessRunId, launched.run.harnessRunId);
    assert.equal(lookup.launchOutcome.run.revision, 1);
    assert.equal(lookup.launchOutcome.run.status, "starting");
    assert.deepEqual(lookup.launchOutcome.run.executionSnapshot, migratedSnapshot);

    await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("project_not_found");
      },
    });
    assert.deepEqual(
      JSON.parse(await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8")),
      migrated,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("main-era Harness-run history remains observable after the launch-schema upgrade", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-harness-v1-upgrade-"));
  const harnessRunId = `harness-run-${"5".repeat(24)}`;
  const legacyRun = {
    harnessRunId,
    revision: 3,
    status: "succeeded",
    launchRequestId: `launch-request-${"6".repeat(24)}`,
    launchRequestRevision: 2,
    hostId,
    projectId: `project-${"7".repeat(24)}`,
    harnessId: `harness-${"8".repeat(24)}`,
    harnessPinnedRevision: "9".repeat(40),
    adapterId: "conformance-harness-adapter-v1",
    adapterProtocol: "1.0.0",
    adapterEntryPoint: "adapters/conformance.mjs",
    controllerId,
    controllerSessionId,
    createdAt: "2026-08-01T10:00:00.000Z",
    adapterReadyAt: "2026-08-01T10:00:01.000Z",
    completedAt: "2026-08-01T10:00:02.000Z",
    startAuditId: `audit-${"1".repeat(24)}`,
    events: [],
    outcome: null,
    terminalEnvelopeValidation: {
      adapterReadyObserved: true,
      validTerminalEnvelopeCount: 1,
      exactlyOne: true,
      adapterChannelClosedObserved: true,
      processExitObserved: true,
    },
    logStreams: [
      {
        streamId: `harness-log-${"2".repeat(24)}`,
        producer: "stdout",
        availableStart: 0,
        availableEnd: 0,
        explicitRetrievalRequired: true,
        insertedIntoControllerConversation: false,
      },
      {
        streamId: `harness-log-${"3".repeat(24)}`,
        producer: "stderr",
        availableStart: 0,
        availableEnd: 0,
        explicitRetrievalRequired: true,
        insertedIntoControllerConversation: false,
      },
    ],
  };
  const legacyIdempotencyKey = "main-era-ambiguous-start";
  const legacyStartOutcome = {
    idempotencyKeyHash: `sha256:${createHash("sha256")
      .update(legacyIdempotencyKey).digest("hex")}`,
    requestFingerprint: `sha256:${"b".repeat(64)}`,
    response: {
      type: "harness.run.start.result",
      requestId: "legacy-start-request",
      code: "harness_run_created",
      run: legacyRun,
    },
  };
  await writeFile(join(dataDir, "harness-runs.json"), `${JSON.stringify({
    schemaVersion: 1,
    runs: [legacyRun],
    startOutcomes: [legacyStartOutcome],
  })}\n`);

  try {
    const manager = await createHarnessRunManager({
      dataDir,
      hostId,
      recordAudit: async () => `audit-${"4".repeat(24)}`,
      loadLaunchContext: async () => {
        throw new Error("project_not_found");
      },
    });
    const initialized = JSON.parse(await readFile(
      join(dataDir, "harness-runs.json"),
      "utf8",
    ));
    assert.equal(initialized.schemaVersion, 3);
    const [{ executionSnapshot, ...migratedLegacyRun }] = initialized.runs;
    assert.deepEqual(migratedLegacyRun, legacyRun);
    assert.deepEqual(executionSnapshot, {
      schemaVersion: 1,
      capture: "migration",
      hostId: legacyRun.hostId,
      projectRegistration: {
        projectId: legacyRun.projectId,
        revision: null,
        displayName: null,
      },
      harness: {
        harnessId: legacyRun.harnessId,
        revision: null,
        name: null,
        pinnedRevision: legacyRun.harnessPinnedRevision,
      },
      adapter: {
        adapterId: legacyRun.adapterId,
        protocol: legacyRun.adapterProtocol,
        entryPoint: legacyRun.adapterEntryPoint,
      },
      parameters: null,
      source: null,
      attribution: {
        controllerId: legacyRun.controllerId,
        controllerSessionId: legacyRun.controllerSessionId,
      },
      createdAt: legacyRun.createdAt,
      credentialCapabilityReferences: null,
      launchAuditId: legacyRun.startAuditId,
    });
    assert.deepEqual(initialized.launchOutcomes, []);
    assert.deepEqual({
      ...initialized.legacyStartOutcomes[0],
      response: {
        ...initialized.legacyStartOutcomes[0].response,
        run: legacyStartOutcome.response.run,
      },
    }, legacyStartOutcome);
    assert.deepEqual(
      initialized.legacyStartOutcomes[0].response.run.executionSnapshot,
      executionSnapshot,
    );
    const observation = await manager.observe({
      requestId: "observe-legacy-run",
      harnessRunId,
      afterSequence: 0,
    });
    assert.equal(observation.code, "harness_run_observed");
    assert.deepEqual(observation.run, {
      harnessRunId: legacyRun.harnessRunId,
      revision: legacyRun.revision,
      status: legacyRun.status,
      launchRequestId: legacyRun.launchRequestId,
      launchRequestRevision: legacyRun.launchRequestRevision,
      hostId: legacyRun.hostId,
      projectId: legacyRun.projectId,
      harnessId: legacyRun.harnessId,
      harnessPinnedRevision: legacyRun.harnessPinnedRevision,
      adapterId: legacyRun.adapterId,
      adapterProtocol: legacyRun.adapterProtocol,
      adapterEntryPoint: legacyRun.adapterEntryPoint,
      controllerId: legacyRun.controllerId,
      controllerSessionId: legacyRun.controllerSessionId,
      createdAt: legacyRun.createdAt,
      adapterReadyAt: legacyRun.adapterReadyAt,
      completedAt: legacyRun.completedAt,
      startAuditId: legacyRun.startAuditId,
      executionSnapshot,
    });
    const lookup = await manager.lookup({
      requestId: "lookup-legacy-start",
      idempotencyKey: legacyIdempotencyKey,
    });
    assert.equal(lookup.code, "harness_run_launch_outcome_found");
    assert.equal(lookup.found, true);
    assert.deepEqual({
      ...lookup.launchOutcome,
      run: legacyStartOutcome.response.run,
    }, legacyStartOutcome.response);
    assert.deepEqual(lookup.launchOutcome.run.executionSnapshot, executionSnapshot);
    const conflictingLaunch = await manager.launch({
      requestId: "launch-with-legacy-key",
      projectId: legacyRun.projectId,
      parameters: {
        issueNumber: 152,
        targetBranch: "sandcastle/issue-152",
      },
      controllerId,
      controllerSessionId,
      source: "controller-cli",
      authorizationClass: "harness_run_launch",
      idempotencyKey: legacyIdempotencyKey,
    });
    assert.equal(conflictingLaunch.code, "idempotency_key_conflict");
    assert.equal(conflictingLaunch.prohibitedSideEffects.harnessRunCreated, false);
    const migrated = JSON.parse(await readFile(join(dataDir, "harness-runs.json"), "utf8"));
    assert.equal(migrated.schemaVersion, 3);
    assert.deepEqual(migrated.runs, initialized.runs);
    assert.deepEqual(migrated.launchOutcomes, []);
    assert.deepEqual(migrated.legacyStartOutcomes, initialized.legacyStartOutcomes);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
