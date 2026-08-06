import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const recordAudit = async (action, outcome, details = {}) => {
    const auditId = `audit-${String(audits.length + 1).padStart(24, "0")}`;
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
  return { root, dataDir, projectPath, audits, registry, registered, manager, recordAudit };
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

test("adapter lifecycle failures remain truthful under the single launch action", async () => {
  const fixture = await createFixture("sandking-harness-failure-");
  try {
    const expected = new Map([
      [999_999_999, ["harness_result_incomplete", 0]],
      [999_999_996, ["harness_result_incomplete", 2]],
      [999_999_995, ["harness_adapter_protocol_invalid", 0]],
      [999_999_998, ["harness_adapter_protocol_invalid", 0]],
      [999_999_997, ["harness_adapter_protocol_invalid", 1]],
    ]);
    for (const [issueNumber, [outcomeCode, terminalCount]] of expected) {
      const launched = await fixture.manager.launch(launchRequest(
        fixture.registered.project.projectId,
        issueNumber,
      ));
      assert.equal(launched.type, "harness.run.launch.result");
      const observation = await waitForTerminal(fixture.manager, launched.run.harnessRunId);
      assert.equal(observation.run.status, "failed");
      assert.equal(observation.outcome.code, outcomeCode);
      assert.equal(observation.outcome.incompleteResult, true);
      assert.equal(
        observation.terminalEnvelopeValidation.validTerminalEnvelopeCount,
        terminalCount,
        `issue ${issueNumber}`,
      );
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
    assert.equal(retained.schemaVersion, 2);
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
  const legacyStartOutcome = {
    idempotencyKeyHash: `sha256:${"a".repeat(64)}`,
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
    });
    const migrated = JSON.parse(await readFile(join(dataDir, "harness-runs.json"), "utf8"));
    assert.equal(migrated.schemaVersion, 2);
    assert.deepEqual(migrated.runs, [legacyRun]);
    assert.deepEqual(migrated.launchOutcomes, []);
    assert.deepEqual(migrated.legacyStartOutcomes, [legacyStartOutcome]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
