import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { promisify } from "node:util";
import test from "node:test";
import { createHarnessRunManager } from "../src/harness-runs.mjs";
import { createProjectRegistry } from "../src/project-registration.mjs";
import { installCurrentPackage } from "./installed-package.mjs";

const execFileAsync = promisify(execFile);

const commitProject = async (projectPath, message) => {
  await execFileAsync("git", ["-C", projectPath, "add", "--all"]);
  await execFileAsync("git", [
    "-C", projectPath,
    "-c", "user.name=Production Adapter Fixture",
    "-c", "user.email=production-adapter@sandking.invalid",
    "-c", "commit.gpgSign=false",
    "commit", "--quiet", "-m", message,
  ]);
};

const writeControlledFixture = (projectPath, value) => writeFile(
  join(projectPath, "sandcastle.worker-fixture.json"),
  `${JSON.stringify(value, null, 2)}\n`,
);

const createProductionFixture = async (root, fixture, managerOptions = {}) => {
  const dataDir = join(root, "host-state");
  const projectPath = join(root, "project");
  await mkdir(projectPath, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
  await writeFile(join(projectPath, "README.md"), "controlled production Project\n");
  await writeControlledFixture(projectPath, fixture);
  await commitProject(projectPath, "Initialize controlled production Project");

  const audits = [];
  const recordAudit = async (action, outcome, details, requestedAuditId) => {
    const auditId = requestedAuditId
      ?? `audit-${String(audits.length + 1).padStart(24, "0")}`;
    audits.push({ auditId, action, outcome, details });
    return auditId;
  };
  const registry = await createProjectRegistry({ dataDir, recordAudit });
  const harness = await registry.registerSandcastleHarness({
    requestId: "register-controlled-production-harness",
    name: "Sand-King Sandcastle Harness",
    authorizationClass: "host_local_harness_registration",
    idempotencyKey: "register-controlled-production-harness",
    expectedRevision: 0,
  });
  const project = await registry.registerProject({
    requestId: "register-controlled-production-project",
    path: projectPath,
    configuration: {
      issueWorkflow: { provider: "github", kind: "issues" },
      checks: [{ checkId: "test", command: "npm test" }],
    },
    authorizationClass: "host_local_project_registration",
    idempotencyKey: "register-controlled-production-project",
    expectedRevision: 0,
  });
  const pinned = await registry.pinHarness({
    requestId: "pin-controlled-production-harness",
    projectId: project.project.projectId,
    harnessId: harness.harness.harnessId,
    boundedConfiguration: {
      adapterProtocol: "1.0.0",
      launchProfile: "delegated-work",
    },
    authorizationClass: "host_local_project_configuration",
    idempotencyKey: "pin-controlled-production-harness",
    expectedRevision: 1,
  });
  const manager = await createHarnessRunManager({
    dataDir,
    hostId: `host-${"1".repeat(24)}`,
    recordAudit,
    loadLaunchContext: registry.loadLaunchContext,
    ...managerOptions,
  });
  return { audits, dataDir, harness, manager, pinned, project, projectPath, registry };
};

const launchRequest = (projectId, overrides = {}) => ({
  requestId: "launch-controlled-production-work",
  projectId,
  parameters: {},
  controllerId: `runtime-${"2".repeat(24)}`,
  controllerSessionId: `controller-session-${"3".repeat(24)}`,
  source: "controller-cli",
  authorizationClass: "harness_run_launch",
  idempotencyKeyHash: `sha256:${"4".repeat(64)}`,
  ...overrides,
});

const observeTerminal = async (manager, harnessRunId) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const observation = await manager.observe({
      requestId: "observe-controlled-production-work",
      harnessRunId,
      afterSequence: 0,
    });
    if (["succeeded", "failed", "cancelled"].includes(observation.run.status)) {
      await manager.waitForIdle();
      return observation;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("controlled_production_terminal_timeout");
};

const observeRunning = async (manager, harnessRunId) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const observation = await manager.observe({
      requestId: "observe-running-controlled-production-work",
      harnessRunId,
      afterSequence: 0,
    });
    if (
      observation.run.status === "running"
      && observation.events.some(({ type }) => type === "harness_progress_published")
    ) return observation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("controlled_production_running_timeout");
};

test("the ordinary launch seam delegates once through the pinned production adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-adapter-"));
  try {
    const fixture = await createProductionFixture(root, {
      schemaVersion: 1,
      provider: { kind: "controlled-worker-fixture", ready: true },
      scenario: "succeeded",
      artifact: {
        path: "controlled-delegation.txt",
        content: "controlled delegated work\n",
      },
    });
    const request = launchRequest(fixture.project.project.projectId);
    const launched = await fixture.manager.launch(request);
    assert.equal(launched.type, "harness.run.launch.result", JSON.stringify(launched));
    assert.equal(launched.run.adapterId, "sandcastle-harness-adapter-v1");
    assert.equal(
      launched.run.harnessPinnedRevision,
      fixture.harness.harness.immutableRevision,
    );
    assert.deepEqual(launched.run.executionSnapshot.productionHarness, {
      skillSetLockDigest:
        fixture.pinned.project.harness.preparation.skillSetLockDigest,
      resolvedSkills: fixture.pinned.project.harness.preparation.resolvedSkills,
      executionRuntimeInputs:
        fixture.pinned.project.harness.preparation.executionRuntimeInputs,
      projectionDigest: fixture.pinned.project.harness.preparation.projection.digest,
    });
    const snapshotText = JSON.stringify(launched.run.executionSnapshot);
    assert.doesNotMatch(snapshotText, new RegExp(root.replaceAll("/", "\\/")));
    assert.doesNotMatch(snapshotText, /secret|credentialValue|machinePath/i);

    const observed = await observeTerminal(fixture.manager, launched.run.harnessRunId);
    assert.equal(observed.run.status, "succeeded", JSON.stringify(observed));
    assert.equal(observed.outcome.code, "harness_run_succeeded");
    assert.deepEqual(observed.outcome.result, {
      schemaVersion: 1,
      kind: "sandcastle.delegation",
      code: "work_completed",
      selection: {},
      artifact: "controlled-delegation.txt",
    });
    assert.equal(observed.terminalEnvelopeValidation.exactlyOne, true);
    assert.equal(observed.terminalEnvelopeValidation.validTerminalEnvelopeCount, 1);
    const progress = observed.events.find((event) => event.progressRecord)?.progressRecord;
    assert.equal(progress?.type, "sandcastle.worker");
    assert.deepEqual(
      Object.keys(progress?.payload ?? {}).filter((key) =>
        /plan|ticket|topology|branch|successRules/i.test(key)),
      [],
    );
    assert.equal(
      await readFile(join(fixture.projectPath, "controlled-delegation.txt"), "utf8"),
      "controlled delegated work\n",
    );

    const replay = await fixture.manager.launch({
      ...request,
      requestId: "replay-controlled-production-work",
    });
    assert.equal(replay.type, "harness.run.launch.result");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.run.harnessRunId, launched.run.harnessRunId);
    const conflict = await fixture.manager.launch({
      ...request,
      requestId: "conflict-controlled-production-work",
      parameters: { issueNumber: 173 },
    });
    assert.equal(conflict.type, "harness.run.launch.failure");
    assert.equal(conflict.code, "idempotency_key_conflict");
    assert.equal(fixture.audits.filter(({ action }) =>
      action === "harness.adapter.start").length, 1);
    assert.equal(
      await readFile(join(fixture.projectPath, "controlled-delegation.txt"), "utf8"),
      "controlled delegated work\n",
    );
    const retained = JSON.parse(await readFile(
      join(fixture.dataDir, "harness-runs.json"),
      "utf8",
    ));
    assert.equal(retained.runs.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an accepted production launch executes its immutable pinned runtime snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-immutable-runtime-"));
  let fixture;
  try {
    fixture = await createProductionFixture(root, {
      schemaVersion: 1,
      provider: { kind: "controlled-worker-fixture", ready: true },
      scenario: "succeeded",
      artifact: {
        path: "pinned-runtime.txt",
        content: "exact pinned runtime executed\n",
      },
    }, {
      faultInjector: async (point) => {
        if (point !== "harness_run_launch.after_commit") return;
        const projectionPath = join(
          fixture.projectPath,
          ...fixture.pinned.project.harness.preparation.projection.path.split("/"),
        );
        await writeFile(
          join(projectionPath, ".sandcastle", "controlled-worker-fixture.mjs"),
          [
            'import { writeFile } from "node:fs/promises";',
            'import { join } from "node:path";',
            'await writeFile(join(process.cwd(), "tampered-runtime.txt"), "tampered runtime executed\\n");',
            'process.stdout.write(`${JSON.stringify({',
            '  type: "sandcastle.worker.result",',
            '  status: "succeeded",',
            '  result: {',
            '    schemaVersion: 1,',
            '    kind: "sandcastle.delegation",',
            '    code: "tampered_runtime_executed",',
            '  },',
            '})}\\n`);',
            "",
          ].join("\n"),
        );
      },
    });

    const launched = await fixture.manager.launch(launchRequest(
      fixture.project.project.projectId,
    ));
    assert.equal(launched.type, "harness.run.launch.result", JSON.stringify(launched));
    assert.equal(
      launched.run.executionSnapshot.productionHarness.projectionDigest,
      fixture.pinned.project.harness.preparation.projection.digest,
    );

    const terminal = await observeTerminal(fixture.manager, launched.run.harnessRunId);
    assert.equal(terminal.run.status, "succeeded", JSON.stringify(terminal));
    assert.equal(terminal.outcome.result.code, "work_completed");
    assert.equal(
      await readFile(join(fixture.projectPath, "pinned-runtime.txt"), "utf8"),
      "exact pinned runtime executed\n",
    );
    await assert.rejects(
      readFile(join(fixture.projectPath, "tampered-runtime.txt"), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await fixture?.manager.waitForIdle().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("the installed ordinary CLI discovers production parameters and launches the same adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-installed-cli-"));
  const endpoint = join(root, "controller.sock");
  let server;
  let fixture;
  try {
    fixture = await createProductionFixture(root, {
      schemaVersion: 1,
      provider: { kind: "controlled-worker-fixture", ready: true },
      scenario: "succeeded",
    });
    const projectId = fixture.project.project.projectId;
    assert.equal(fixture.harness.harness.launchParameters.kind, "fields");
    const controllerSessionId = `controller-session-${"5".repeat(24)}`;
    const requests = [];
    server = createServer((socket) => {
      socket.setEncoding("utf8");
      let input = "";
      socket.on("data", async (chunk) => {
        input += chunk;
        if (!input.includes("\n")) return;
        try {
          const request = JSON.parse(input.slice(0, input.indexOf("\n")));
          requests.push(request);
          let outcome;
          if (request.operation === "describe") {
            outcome = {
              type: "controller.cli.description",
              protocol: "1.0.0",
              command: "sandking launch",
              focusedProjectId: projectId,
              projectArgumentOptional: true,
              pluginRequired: false,
              launchParameters: fixture.harness.harness.launchParameters,
            };
          } else if (request.operation === "harness-run.launch") {
            outcome = await fixture.manager.launch({
              requestId: request.requestId,
              projectId,
              parameters: request.parameters ?? {},
              controllerId: `runtime-${"6".repeat(24)}`,
              controllerSessionId: request.controllerSessionId,
              source: "controller-cli",
              authorizationClass: "harness_run_launch",
              idempotencyKeyHash: request.idempotencyKeyHash,
            });
          } else {
            throw new Error("unexpected_controller_cli_operation");
          }
          socket.end(`${JSON.stringify({
            type: "sandking.cli.result",
            protocol: "1.0.0",
            requestId: request.requestId,
            ok: true,
            outcome,
          })}\n`);
        } catch (error) {
          socket.destroy(error instanceof Error ? error : undefined);
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    const installed = await installCurrentPackage(root);
    const retryDirectory = join(root, "controller-private");
    const userHome = join(root, "user-home");
    await Promise.all([
      mkdir(retryDirectory, { recursive: true }),
      mkdir(userHome, { recursive: true }),
    ]);
    const { stdout } = await execFileAsync(installed.command, [
      "launch", projectId,
      "--issue", "173",
      "--target-branch", "sandcastle/issue-173",
      "--json",
    ], {
      cwd: root,
      env: {
        ...process.env,
        HOME: userHome,
        SANDKING_CONTROLLER_ENDPOINT: endpoint,
        SANDKING_CONTROLLER_SESSION_ID: controllerSessionId,
        SANDKING_CONTROLLER_RETRY_DIRECTORY: retryDirectory,
        SANDKING_WORK_CONTEXT_ID: projectId,
      },
    });
    const launched = JSON.parse(stdout);
    assert.equal(launched.type, "harness.run.launch.result", JSON.stringify(launched));
    assert.deepEqual(launched.run.parameters, {
      issueNumber: 173,
      targetBranch: "sandcastle/issue-173",
    });
    const observed = await observeTerminal(fixture.manager, launched.run.harnessRunId);
    assert.equal(observed.run.status, "succeeded", JSON.stringify(observed));
    assert.equal(observed.run.adapterId, "sandcastle-harness-adapter-v1");
    assert.equal(observed.outcome.code, "harness_run_succeeded");
    assert.deepEqual(observed.outcome.result.selection, {
      issueNumber: 173,
      targetBranch: "sandcastle/issue-173",
    });
    assert.equal(observed.terminalEnvelopeValidation.exactlyOne, true);
    assert.deepEqual(requests.map(({ operation }) => operation), [
      "describe",
      "harness-run.launch",
    ]);
    assert.equal(requests[0].projectId, projectId);
    assert.equal(requests[1].controllerSessionId, controllerSessionId);
    assert.equal("plugin" in requests[1], false);
    assert.equal("expectedRevision" in requests[1], false);
  } finally {
    await fixture?.manager.waitForIdle().catch(() => undefined);
    await new Promise((resolve) => server?.close(resolve) ?? resolve());
    await rm(root, { recursive: true, force: true });
  }
});

test("controlled Worker outcomes, not exit or diagnostic text, determine one terminal result", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-outcomes-"));
  try {
    const fixture = await createProductionFixture(root, {
      schemaVersion: 1,
      provider: { kind: "controlled-worker-fixture", ready: true },
      scenario: "succeeded-nonzero",
    });
    const scenarios = [
      {
        scenario: "succeeded-nonzero",
        status: "succeeded",
        outcomeCode: "harness_run_succeeded",
        resultCode: "work_completed",
        diagnosticCode: null,
      },
      {
        scenario: "failed",
        status: "failed",
        outcomeCode: "harness_run_failed",
        resultCode: "work_failed",
        diagnosticCode: null,
      },
      {
        scenario: "malformed-output",
        status: "failed",
        outcomeCode: "harness_run_failed",
        resultCode: "worker_output_invalid",
        diagnosticCode: "sandcastle_worker_output_invalid",
      },
      {
        scenario: "nonzero-exit",
        status: "failed",
        outcomeCode: "harness_run_failed",
        resultCode: "worker_result_missing",
        diagnosticCode: "sandcastle_worker_result_missing",
      },
      {
        scenario: "zero-exit",
        status: "failed",
        outcomeCode: "harness_run_failed",
        resultCode: "worker_result_missing",
        diagnosticCode: "sandcastle_worker_result_missing",
      },
      {
        scenario: "duplicate-result",
        status: "failed",
        outcomeCode: "harness_run_failed",
        resultCode: "worker_result_ambiguous",
        diagnosticCode: "sandcastle_worker_result_ambiguous",
      },
      {
        scenario: "diagnostic-only",
        status: "failed",
        outcomeCode: "harness_run_failed",
        resultCode: "worker_result_missing",
        diagnosticCode: "sandcastle_worker_result_missing",
      },
    ];

    for (const [index, expected] of scenarios.entries()) {
      await writeControlledFixture(fixture.projectPath, {
        schemaVersion: 1,
        provider: { kind: "controlled-worker-fixture", ready: true },
        scenario: expected.scenario,
      });
      const request = launchRequest(fixture.project.project.projectId, {
        requestId: `launch-${expected.scenario}`,
        controllerSessionId: null,
        source: "cockpit",
        idempotencyKeyHash: `sha256:${index.toString(16).repeat(64)}`,
      });
      const launched = await fixture.manager.launch(request);
      assert.equal(launched.type, "harness.run.launch.result", expected.scenario);
      const observed = await observeTerminal(
        fixture.manager,
        launched.run.harnessRunId,
      );
      assert.equal(observed.run.status, expected.status, expected.scenario);
      assert.equal(observed.outcome.status, expected.status, expected.scenario);
      assert.equal(observed.outcome.code, expected.outcomeCode, expected.scenario);
      assert.equal(observed.outcome.result.code, expected.resultCode, expected.scenario);
      assert.equal(
        observed.terminalEnvelopeValidation.validTerminalEnvelopeCount,
        1,
        expected.scenario,
      );
      assert.equal(observed.terminalEnvelopeValidation.exactlyOne, true, expected.scenario);
      const diagnostic = await fixture.manager.readLogs({
        requestId: `diagnostics-${expected.scenario}`,
        harnessRunId: launched.run.harnessRunId,
        producer: "stderr",
        offset: 0,
        limit: 16_384,
      });
      const diagnosticText = diagnostic.data.toString("utf8");
      if (expected.diagnosticCode) {
        assert.match(diagnosticText, new RegExp(expected.diagnosticCode), expected.scenario);
      }
      if (expected.scenario === "malformed-output") {
        assert.doesNotMatch(diagnosticText, /malformed controlled Worker output/);
      }
      if (expected.scenario === "diagnostic-only") {
        assert.match(diagnosticText, /SUCCESS/);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider and execution readiness fail before work and recover through launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-readiness-"));
  let fixture;
  try {
    fixture = await createProductionFixture(root, {
      schemaVersion: 1,
      runtime: { ready: true },
      provider: { kind: "controlled-worker-fixture", ready: false },
      scenario: "succeeded",
    });
    const projectId = fixture.project.project.projectId;
    const unavailableProvider = await fixture.manager.launch(launchRequest(projectId, {
      requestId: "launch-without-worker-provider",
      idempotencyKeyHash: `sha256:${"a".repeat(64)}`,
    }));
    assert.equal(unavailableProvider.type, "harness.run.launch.failure");
    assert.equal(unavailableProvider.code, "harness_worker_provider_unavailable");
    assert.equal(unavailableProvider.retryable, true);
    assert.deepEqual(unavailableProvider.prohibitedSideEffects, {
      harnessRunCreated: false,
      adapterStarted: false,
      projectWrite: false,
    });

    await writeControlledFixture(fixture.projectPath, {
      schemaVersion: 1,
      runtime: { ready: false },
      provider: { kind: "controlled-worker-fixture", ready: true },
      scenario: "succeeded",
    });
    const unavailableRuntime = await fixture.manager.launch(launchRequest(projectId, {
      requestId: "launch-without-execution-runtime",
      idempotencyKeyHash: `sha256:${"b".repeat(64)}`,
    }));
    assert.equal(unavailableRuntime.type, "harness.run.launch.failure");
    assert.equal(unavailableRuntime.code, "harness_execution_runtime_unavailable");
    assert.equal(unavailableRuntime.retryable, true);
    assert.deepEqual(unavailableRuntime.prohibitedSideEffects, {
      harnessRunCreated: false,
      adapterStarted: false,
      projectWrite: false,
    });

    await writeControlledFixture(fixture.projectPath, {
      schemaVersion: 1,
      runtime: { ready: true },
      provider: { kind: "controlled-worker-fixture", ready: true },
      scenario: "succeeded",
    });
    const recovered = await fixture.manager.launch(launchRequest(projectId, {
      requestId: "retry-corrected-production-launch",
      idempotencyKeyHash: `sha256:${"c".repeat(64)}`,
    }));
    assert.equal(recovered.type, "harness.run.launch.result", JSON.stringify(recovered));
    const terminal = await observeTerminal(fixture.manager, recovered.run.harnessRunId);
    assert.equal(terminal.run.status, "succeeded");
    assert.equal(fixture.audits.filter(({ action }) =>
      action === "harness.adapter.start").length, 1);
    const retained = JSON.parse(await readFile(
      join(fixture.dataDir, "harness-runs.json"),
      "utf8",
    ));
    assert.equal(retained.runs.length, 1);
  } finally {
    await fixture?.manager.waitForIdle();
    await rm(root, { recursive: true, force: true });
  }
});

test("production cancellation and reconnection converge on the same canonical run", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-cancellation-"));
  let fixture;
  try {
    fixture = await createProductionFixture(root, {
      schemaVersion: 1,
      provider: { kind: "controlled-worker-fixture", ready: true },
      scenario: "cancellable",
    });
    const launched = await fixture.manager.launch(launchRequest(
      fixture.project.project.projectId,
      {
        requestId: "launch-cancellable-production-work",
        controllerSessionId: null,
        source: "cockpit",
        idempotencyKeyHash: `sha256:${"d".repeat(64)}`,
      },
    ));
    assert.equal(launched.type, "harness.run.launch.result");
    const running = await observeRunning(fixture.manager, launched.run.harnessRunId);
    assert.equal(running.events.some(({ type }) =>
      type === "harness_progress_published"), true);

    const cancellation = await fixture.manager.cancel({
      requestId: "cancel-production-work",
      harnessRunId: launched.run.harnessRunId,
      controllerId: `runtime-${"2".repeat(24)}`,
      controllerSessionId: null,
      source: "cockpit",
      authorizationClass: "harness_run_cancellation",
      idempotencyKeyHash: `sha256:${"e".repeat(64)}`,
    });
    assert.equal(cancellation.type, "harness.run.cancel.result");
    const terminal = await observeTerminal(fixture.manager, launched.run.harnessRunId);
    assert.equal(terminal.run.status, "cancelled", JSON.stringify(terminal));
    assert.equal(terminal.outcome.code, "harness_run_cancelled");
    assert.equal(terminal.outcome.incompleteResult, false);
    assert.equal(terminal.terminalEnvelopeValidation.validTerminalEnvelopeCount, 1);
    assert.equal(terminal.terminalEnvelopeValidation.exactlyOne, true);
    assert.ok(terminal.run.cancellation.terminationConfirmedAt);
    assert.equal(terminal.events.filter(({ type }) =>
      type === "harness_run_cancellation_accepted").length, 1);
    assert.equal(terminal.events.filter(({ type }) =>
      type === "harness_run_cancelled").length, 1);

    const reconnectedManager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId: `host-${"1".repeat(24)}`,
      recordAudit: async (_action, _outcome, _details, requestedAuditId) =>
        requestedAuditId ?? `audit-${"f".repeat(24)}`,
      loadLaunchContext: fixture.registry.loadLaunchContext,
    });
    const reconnected = await reconnectedManager.observe({
      requestId: "reconnect-cancelled-production-work",
      harnessRunId: launched.run.harnessRunId,
      afterSequence: 0,
    });
    assert.deepEqual(reconnected.run, terminal.run);
    assert.deepEqual(reconnected.events, terminal.events);
    assert.deepEqual(reconnected.outcome, terminal.outcome);
    assert.deepEqual(reconnected.logStreams, terminal.logStreams);
    assert.equal(fixture.audits.filter(({ action }) =>
      action === "harness.adapter.start").length, 1);
  } finally {
    await fixture?.manager.waitForIdle();
    await rm(root, { recursive: true, force: true });
  }
});
