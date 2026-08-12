import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  createHarnessRunManager,
  scheduleCancellationEscalation,
} from "../src/harness-runs.mjs";
import { createProjectRegistry } from "../src/project-registration.mjs";
import {
  qualifyIssue164FaultPoint,
  retainIssue164FaultPointResults,
} from "./issue-164-fault-results.mjs";
import { waitForTestCheckpoint } from "./test-checkpoint.mjs";

const execFileAsync = promisify(execFile);
const hostId = `host-${"1".repeat(24)}`;
const controllerId = `runtime-${"2".repeat(24)}`;
const controllerSessionId = `controller-session-${"3".repeat(24)}`;
const localFaultCheckpointTimeoutMs = 10_000;
const supervisionQuiescenceTimeoutMs = 60_000;

const waitForTerminal = async (manager, harnessRunId) => {
  const deadline = Date.now() + 60_000;
  let lastObservation = null;
  while (Date.now() < deadline) {
    const observation = await manager.observe({
      requestId: "observe-run",
      harnessRunId,
      afterSequence: 0,
    });
    lastObservation = observation;
    if (["succeeded", "failed", "cancelled"].includes(observation.run?.status)) {
      return observation;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`harness_run_terminal_timeout: ${JSON.stringify(lastObservation)}`);
};

const waitForRunStatus = async (manager, harnessRunId, expectedStatus) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const observation = await manager.observe({
      requestId: `observe-${expectedStatus}`,
      harnessRunId,
      afterSequence: 0,
    });
    if (observation.run?.status === expectedStatus) {
      return observation;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`harness_run_${expectedStatus}_timeout`);
};

const waitForDiagnosticCommits = async (manager, harnessRunId) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const observation = await manager.observe({
      requestId: "observe-diagnostic-commits",
      harnessRunId,
      afterSequence: 0,
    });
    if (observation.logStreams.every((stream) => stream.availableEnd > 0)) {
      return observation;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("harness_run_diagnostic_commit_timeout");
};

const createFixture = async (prefix, managerOptions = {}) => {
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
    ...managerOptions,
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

const canonicalJson = (value) => {
  if (value === undefined) return '"<undefined>"';
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
};

const schemaV4LaunchRequestFingerprint = (request) =>
  `sha256:${createHash("sha256").update(canonicalJson({
    projectId: request.projectId,
    parameters: request.parameters === undefined ? {} : request.parameters,
    controllerId: request.controllerId,
    controllerSessionId: request.controllerSessionId,
    source: request.source,
    authorizationClass: request.authorizationClass,
  })).digest("hex")}`;

const schemaV6CancellationRequestFingerprint = (request) =>
  `sha256:${createHash("sha256").update(canonicalJson({
    harnessRunId: request.harnessRunId,
    controllerId: request.controllerId,
    controllerSessionId: request.controllerSessionId,
    source: request.source,
    authorizationClass: request.authorizationClass,
  })).digest("hex")}`;

const cancellationRequest = (harnessRunId, overrides = {}) => ({
  requestId: "cancel-harness-run",
  harnessRunId,
  controllerId,
  controllerSessionId,
  source: "controller-cli",
  authorizationClass: "harness_run_cancellation",
  idempotencyKey: "cancel-harness-run-once",
  ...overrides,
});

const recoveryRequest = (harnessRunId, action, overrides = {}) => ({
  requestId: `recover-harness-run-${action}`,
  harnessRunId,
  action,
  controllerId,
  controllerSessionId,
  source: "controller-cli",
  authorizationClass: "harness_run_recovery",
  idempotencyKey: `recover-harness-run-${action}-once`,
  ...overrides,
});

test("accepted cancellation terminates once and replays without another lifecycle transition", async () => {
  const fixture = await createFixture("sandking-harness-run-cancellation-", {
    cancellationGraceMs: 10_000,
  });
  const projectFilesBefore = (await readdir(fixture.projectPath)).sort();
  const rawRetryKey = "recognizable-raw-cancellation-retry-key";
  try {
    const launched = await fixture.manager.launch(launchRequest(
      fixture.registered.project.projectId,
      999_999_993,
    ));
    await waitForRunStatus(fixture.manager, launched.run.harnessRunId, "running");

    const request = cancellationRequest(launched.run.harnessRunId, {
      idempotencyKey: rawRetryKey,
    });
    const accepted = await fixture.manager.cancel(request);
    assert.equal(accepted.type, "harness.run.cancel.result");
    assert.equal(accepted.code, "harness_run_cancellation_accepted");
    assert.equal(accepted.idempotentReplay, false);
    assert.equal(accepted.harnessRunId, launched.run.harnessRunId);
    assert.match(accepted.idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal("expectedRevision" in accepted, false);

    const terminal = await waitForTerminal(fixture.manager, launched.run.harnessRunId);
    assert.equal(terminal.run.status, "cancelled");
    assert.equal(terminal.outcome.status, "cancelled");
    assert.equal(terminal.outcome.code, "conformance_run_cancelled");
    assert.equal(terminal.outcome.incompleteResult, false, JSON.stringify({
      outcome: terminal.outcome,
      validation: terminal.terminalEnvelopeValidation,
      cancellation: terminal.run.cancellation,
    }));
    assert.equal(terminal.terminalEnvelopeValidation.exactlyOne, true);
    assert.equal(terminal.terminalEnvelopeValidation.processExitObserved, true);
    const terminalEventTypes = terminal.events.map((event) => event.type);
    assert.deepEqual(terminalEventTypes.filter((type) =>
      type !== "harness_progress_published"), [
      "harness_run_created",
      "harness_adapter_ready",
      "harness_run_cancellation_accepted",
      "harness_run_cancelled",
    ]);
    assert.ok(terminalEventTypes.lastIndexOf("harness_progress_published")
      < terminalEventTypes.indexOf("harness_run_cancellation_accepted"));

    const replay = await fixture.manager.cancel({
      ...request,
      requestId: "cancel-harness-run-replay",
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.auditId, accepted.auditId);
    const afterReplay = await fixture.manager.observe({
      requestId: "observe-after-cancel-replay",
      harnessRunId: launched.run.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(afterReplay.events.length, terminal.events.length);

    const conflict = await fixture.manager.cancel({
      ...request,
      requestId: "cancel-harness-run-conflict",
      source: "cockpit",
      controllerSessionId: null,
    });
    assert.equal(conflict.type, "harness.run.cancel.failure");
    assert.equal(conflict.code, "idempotency_key_conflict");
    assert.deepEqual(conflict.prohibitedSideEffects, {
      cancellationAccepted: false,
      cooperativeSignalSent: false,
      forcedTerminationSent: false,
      projectWrite: false,
    });
    assert.deepEqual((await readdir(fixture.projectPath)).sort(), projectFilesBefore);

    const retained = JSON.stringify({
      state: JSON.parse(await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8")),
      audits: fixture.audits,
    });
    assert.doesNotMatch(retained, new RegExp(rawRetryKey));
    const acceptedCancellationAudit = fixture.audits.find((audit) =>
      audit.action === "harness.run.cancel"
      && audit.outcome === "accepted"
      && audit.details.harnessRunId === launched.run.harnessRunId);
    assert.ok(acceptedCancellationAudit);
    assert.equal(Object.keys(acceptedCancellationAudit.details).some((key) =>
      /(?:credential|environment|processId|pid|rawRetryKey)/i.test(key)), false);
    assert.ok(fixture.audits.some((audit) =>
      audit.action === "harness.run.cancel"
      && audit.outcome === "rejected"
      && audit.details.code === "idempotency_key_conflict"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cancellation forces an uncooperative supervised process after the bounded deadline", async () => {
  const fixture = await createFixture("sandking-harness-run-forced-cancellation-");
  try {
    const manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      cancellationGraceMs: 50,
    });
    const launched = await manager.launch(launchRequest(
      fixture.registered.project.projectId,
      999_999_994,
    ));
    await waitForRunStatus(manager, launched.run.harnessRunId, "running");
    await manager.cancel(cancellationRequest(launched.run.harnessRunId, {
      idempotencyKey: "force-uncooperative-adapter-once",
    }));

    const terminal = await waitForTerminal(manager, launched.run.harnessRunId);
    assert.equal(terminal.run.status, "cancelled");
    assert.equal(terminal.outcome.code, "conformance_run_cancelled");
    assert.equal(terminal.outcome.incompleteResult, true);
    assert.equal(terminal.outcome.terminalEnvelope, null);
    assert.equal(terminal.outcome.diagnosticReferences.length, 2);
    assert.ok(terminal.outcome.diagnosticReferences.every((reference) =>
      reference.explicitRetrievalRequired
      && reference.insertedIntoControllerConversation === false));
    assert.equal(terminal.terminalEnvelopeValidation.validTerminalEnvelopeCount, 0);
    assert.equal(terminal.terminalEnvelopeValidation.exactlyOne, false);
    assert.equal(terminal.terminalEnvelopeValidation.processExitObserved, true);
    assert.match(terminal.run.cancellation.cooperativeSignalSentAt,
      /^2026-|^20[0-9]{2}-/);
    assert.match(terminal.run.cancellation.forcedTerminationSentAt,
      /^2026-|^20[0-9]{2}-/);
    assert.match(terminal.run.cancellation.terminationConfirmedAt,
      /^2026-|^20[0-9]{2}-/);
    assert.equal(terminal.events.filter((event) =>
      event.type === "harness_run_cancelled").length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("forced termination remains anchored to the durably accepted cooperative deadline", async () => {
  const fixture = await createFixture("sandking-harness-run-retained-deadline-");
  const cancellationGraceMs = 50;
  try {
    const manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      cancellationGraceMs,
      faultInjector: async (point) => {
        if (point === "harness_run_cancellation.after_state_commit") {
          await new Promise((resolve) => setTimeout(resolve, 75));
        }
      },
    });
    const launched = await manager.launch(launchRequest(
      fixture.registered.project.projectId,
      999_999_994,
    ));
    await waitForRunStatus(manager, launched.run.harnessRunId, "running");
    const accepted = await manager.cancel(cancellationRequest(launched.run.harnessRunId, {
      idempotencyKey: "retained-cooperative-deadline",
    }));

    const terminal = await waitForTerminal(manager, launched.run.harnessRunId);
    const cooperativeSignalAt = Date.parse(
      terminal.run.cancellation.cooperativeSignalSentAt,
    );
    const forcedTerminationAt = Date.parse(
      terminal.run.cancellation.forcedTerminationSentAt,
    );
    assert.ok(cooperativeSignalAt >= Date.parse(accepted.cooperativeDeadlineAt));
    assert.ok(
      forcedTerminationAt - cooperativeSignalAt < cancellationGraceMs / 2,
      JSON.stringify({
        cooperativeDeadlineAt: accepted.cooperativeDeadlineAt,
        cooperativeSignalSentAt: terminal.run.cancellation.cooperativeSignalSentAt,
        forcedTerminationSentAt: terminal.run.cancellation.forcedTerminationSentAt,
      }),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cancellation escalation is due at the absolute deadline while preparation is pending", async () => {
  const acceptedAt = Date.parse("2026-08-07T10:00:00.000Z");
  const cooperativeDeadlineAt = new Date(acceptedAt + 250).toISOString();
  let releasePreparation;
  const preparation = new Promise((resolve) => {
    releasePreparation = resolve;
  });
  let escalationDue = false;
  let scheduledDelay = null;
  let runScheduledEscalation;
  let currentTime = acceptedAt;
  const scheduled = scheduleCancellationEscalation(
    cooperativeDeadlineAt,
    async () => {
      escalationDue = true;
      await preparation;
    },
    {
      now: () => currentTime,
      setTimer: (callback, delay) => {
        scheduledDelay = delay;
        runScheduledEscalation = callback;
        return /** @type {any} */ ({});
      },
    },
  );

  try {
    assert.equal(scheduledDelay, 250);
    assert.equal(escalationDue, false);
    currentTime = Date.parse(cooperativeDeadlineAt);
    runScheduledEscalation?.();
    await scheduled.deadlineReached;
    assert.equal(escalationDue, true);
  } finally {
    releasePreparation?.();
    await scheduled.operation;
  }
});

test("cancellation forces an uncooperative descendant and marks the result incomplete", async () => {
  const fixture = await createFixture("sandking-harness-run-tree-cancellation-");
  try {
    const manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      cancellationGraceMs: 50,
    });
    const launched = await manager.launch(launchRequest(
      fixture.registered.project.projectId,
      999_999_992,
    ));
    await waitForRunStatus(manager, launched.run.harnessRunId, "running");
    await manager.cancel(cancellationRequest(launched.run.harnessRunId, {
      idempotencyKey: "force-uncooperative-descendant-once",
    }));

    const terminal = await waitForTerminal(manager, launched.run.harnessRunId);
    assert.equal(terminal.run.status, "cancelled");
    assert.equal(terminal.outcome.code, "conformance_run_cancelled");
    assert.equal(terminal.outcome.incompleteResult, true);
    if (terminal.outcome.terminalEnvelope !== null) {
      assert.equal(terminal.outcome.terminalEnvelope.status, "cancelled");
    }
    assert.ok(terminal.terminalEnvelopeValidation.validTerminalEnvelopeCount <= 1);
    assert.equal(terminal.terminalEnvelopeValidation.processExitObserved, true);
    assert.match(terminal.run.cancellation.forcedTerminationSentAt,
      /^2026-|^20[0-9]{2}-/);
    assert.match(terminal.run.cancellation.terminationConfirmedAt,
      /^2026-|^20[0-9]{2}-/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a durable cancellation replay resumes signalling after an ambiguous response", async () => {
  const fixture = await createFixture("sandking-harness-run-cancel-replay-");
  let interruptOnce = true;
  try {
    const manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      faultInjector: (point) => {
        if (point === "harness_run_cancellation.after_state_commit" && interruptOnce) {
          interruptOnce = false;
          throw new Error("simulated_ambiguous_cancellation_response");
        }
      },
    });
    const launched = await manager.launch(launchRequest(
      fixture.registered.project.projectId,
      999_999_993,
    ));
    await waitForRunStatus(manager, launched.run.harnessRunId, "running");
    const request = cancellationRequest(launched.run.harnessRunId, {
      idempotencyKey: "ambiguous-cancellation-retry-key",
    });
    await assert.rejects(manager.cancel(request), /simulated_ambiguous_cancellation_response/);
    const acceptedState = await waitForRunStatus(
      manager,
      launched.run.harnessRunId,
      "cancelling",
    );
    assert.equal(acceptedState.run.cancellation.cooperativeSignalSentAt, null);

    const replay = await manager.cancel({
      ...request,
      requestId: "cancel-after-ambiguous-response",
    });
    assert.equal(replay.idempotentReplay, true);
    const terminal = await waitForTerminal(manager, launched.run.harnessRunId);
    assert.equal(terminal.run.status, "cancelled");
    assert.equal(terminal.events.filter((event) =>
      event.type === "harness_run_cancellation_accepted").length, 1);
    assert.equal(terminal.events.filter((event) =>
      event.type === "harness_run_cancelled").length, 1);
    assert.equal(fixture.audits.filter((audit) =>
      audit.action === "harness.run.cancel" && audit.outcome === "accepted").length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("startup completes a cancellation accepted before signalling without relaunching work", async () => {
  const fixture = await createFixture("sandking-harness-run-cancel-restart-before-signal-");
  const projectFilesBefore = (await readdir(fixture.projectPath)).sort();
  const requestKey = "restart-cancellation-before-signal";
  let interruptLaunchOnce = true;
  try {
    const interruptedManager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      faultInjector: (point) => {
        if (point === "harness_run_launch.after_state_commit" && interruptLaunchOnce) {
          interruptLaunchOnce = false;
          throw new Error("injected_response_loss_before_supervision_start");
        }
        if (point === "harness_run_cancellation.after_state_commit") {
          throw new Error("injected_host_death_before_cancellation_signal");
        }
      },
    });
    await assert.rejects(interruptedManager.launch(launchRequest(
      fixture.registered.project.projectId, 999_999_993,
    )), /injected_response_loss_before_supervision_start/);
    const launchedState = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    const launchedRun = launchedState.runs[0];
    const request = cancellationRequest(launchedRun.harnessRunId, {
      idempotencyKey: requestKey,
    });
    await assert.rejects(
      interruptedManager.cancel(request),
      /injected_host_death_before_cancellation_signal/,
    );

    const acceptedState = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    const acceptedRun = structuredClone(acceptedState.runs[0]);
    assert.equal(acceptedRun.status, "cancelling");
    assert.equal(acceptedRun.cancellation.cooperativeSignalSentAt, null);
    assert.equal(acceptedRun.cancellation.terminationConfirmedAt, null);

    let mutableContextResolved = false;
    let terminationInspections = 0;
    const restarted = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        mutableContextResolved = true;
        throw new Error("accepted_cancellation_restart_must_not_resolve_launch_context");
      },
      inspectInterruptedRunTermination: async (run) => {
        terminationInspections += 1;
        assert.equal(run.harnessRunId, launchedRun.harnessRunId);
        assert.deepEqual(run.executionSnapshot, acceptedRun.executionSnapshot);
        return { platform: process.platform, status: "confirmed" };
      },
    });

    const observation = await restarted.observe({
      requestId: "observe-reconciled-cancellation-before-signal",
      harnessRunId: launchedRun.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(mutableContextResolved, false);
    assert.equal(terminationInspections, 1);
    assert.equal(observation.run.status, "cancelled");
    assert.equal(observation.outcome.status, "cancelled");
    assert.equal(observation.outcome.code, "conformance_run_cancelled");
    assert.equal(observation.outcome.incompleteResult, true);
    assert.equal(observation.outcome.terminalEnvelope, null);
    assert.equal(observation.run.cancellation.cooperativeSignalSentAt, null);
    assert.match(observation.run.cancellation.terminationConfirmedAt,
      /^2026-|^20[0-9]{2}-/);
    assert.deepEqual(observation.run.executionSnapshot, acceptedRun.executionSnapshot);
    assert.deepEqual(observation.events.slice(0, acceptedRun.events.length), acceptedRun.events);
    assert.equal(observation.events.filter((event) =>
      event.type === "harness_run_cancellation_accepted").length, 1);
    assert.equal(observation.events.filter((event) =>
      event.type === "harness_run_cancelled").length, 1);
    assert.equal(fixture.audits.filter((audit) =>
      audit.action === "harness.adapter.start"
      && audit.details.harnessRunId === launchedRun.harnessRunId).length, 0);

    const replay = await restarted.cancel({
      ...request,
      requestId: "replay-reconciled-cancellation-before-signal",
    });
    assert.equal(replay.code, "harness_run_cancellation_accepted");
    assert.equal(replay.idempotentReplay, true);
    const repeatedStartup = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("repeated_cancellation_restart_must_not_resolve_launch_context");
      },
      inspectInterruptedRunTermination: async () => {
        throw new Error("terminal_cancellation_must_not_be_reinspected");
      },
    });
    const repeated = await repeatedStartup.observe({
      requestId: "observe-repeated-reconciled-cancellation",
      harnessRunId: launchedRun.harnessRunId,
      afterSequence: 0,
    });
    assert.deepEqual(repeated.events, observation.events);
    assert.deepEqual(repeated.outcome, observation.outcome);
    assert.deepEqual((await readdir(fixture.projectPath)).sort(), projectFilesBefore);
    qualifyIssue164FaultPoint(
      "harness_run_cancellation.after_state_commit",
      "startup completes a cancellation accepted before signalling without relaunching work",
    );

  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cancellation interrupted after its complete commit replays once after restart", async () => {
  const fixture = await createFixture("sandking-harness-cancellation-after-commit-");
  const projectFilesBefore = (await readdir(fixture.projectPath)).sort();
  let interruptLaunch = true;
  try {
    const manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      faultInjector: (point) => {
        if (point === "harness_run_launch.after_state_commit" && interruptLaunch) {
          interruptLaunch = false;
          throw new Error("seed_cancellation_after_commit_without_supervision");
        }
        if (point === "harness_run_cancellation.after_commit") {
          throw new Error("injected_cancellation_after_complete_commit");
        }
      },
    });
    await assert.rejects(manager.launch(launchRequest(
      fixture.registered.project.projectId,
      999_999_993,
      { idempotencyKey: "cancellation-after-commit-launch" },
    )), /seed_cancellation_after_commit_without_supervision/);
    const launchedState = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    const run = launchedState.runs[0];
    const request = cancellationRequest(run.harnessRunId, {
      idempotencyKey: "cancellation-after-complete-commit",
    });
    await assert.rejects(
      manager.cancel(request),
      /injected_cancellation_after_complete_commit/,
    );
    const committed = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(committed.runs[0].status, "cancelling");
    assert.equal(committed.cancellationOutcomes.length, 1);
    assert.equal(fixture.audits.filter((audit) =>
      audit.action === "harness.run.cancel" && audit.outcome === "accepted").length, 1);

    const restarted = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("committed_cancellation_restart_must_not_resolve_launch_context");
      },
      inspectInterruptedRunTermination: async () => ({
        platform: process.platform,
        status: "confirmed",
      }),
    });
    const converged = await restarted.observe({
      requestId: "observe-cancellation-after-commit-restart",
      harnessRunId: run.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(converged.run.status, "cancelled");
    assert.equal(converged.events.filter((event) =>
      event.type === "harness_run_cancellation_accepted").length, 1);
    assert.equal(converged.events.filter((event) =>
      event.type === "harness_run_cancelled").length, 1);
    const replay = await restarted.cancel({
      ...request,
      requestId: "replay-cancellation-after-commit-restart",
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(fixture.audits.filter((audit) =>
      audit.action === "harness.run.cancel" && audit.outcome === "accepted").length, 1);
    assert.deepEqual((await readdir(fixture.projectPath)).sort(), projectFilesBefore);
    qualifyIssue164FaultPoint(
      "harness_run_cancellation.after_commit",
      "cancellation interrupted after its complete commit replays once after restart",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("restart does not invent cancellation when interruption precedes its acceptance commit", async () => {
  const fixture = await createFixture("sandking-harness-run-cancel-restart-before-acceptance-");
  let interruptLaunchOnce = true;
  try {
    const interruptedManager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      faultInjector: (point) => {
        if (point === "harness_run_launch.after_state_commit" && interruptLaunchOnce) {
          interruptLaunchOnce = false;
          throw new Error("injected_launch_response_loss_before_cancel_acceptance");
        }
        if (point === "harness_run_cancellation.before_commit") {
          throw new Error("injected_host_death_before_cancellation_acceptance");
        }
      },
    });
    await assert.rejects(interruptedManager.launch(launchRequest(
      fixture.registered.project.projectId, 999_999_993,
    )), /injected_launch_response_loss_before_cancel_acceptance/);
    const launchedState = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    const launchedRun = launchedState.runs[0];
    const request = cancellationRequest(launchedRun.harnessRunId, {
      idempotencyKey: "interrupted-before-cancellation-acceptance",
    });
    await assert.rejects(
      interruptedManager.cancel(request),
      /injected_host_death_before_cancellation_acceptance/,
    );
    const preAcceptance = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(preAcceptance.runs[0].status, "starting");
    assert.equal(preAcceptance.runs[0].cancellation, null);
    assert.equal(preAcceptance.cancellationOutcomes.length, 0);
    assert.equal(preAcceptance.runs[0].events.some((event) =>
      event.type === "harness_run_cancellation_accepted"), false);

    const restarted = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("preacceptance_restart_must_not_resolve_launch_context");
      },
      inspectInterruptedRunTermination: async () => ({
        platform: process.platform,
        status: "confirmed",
      }),
    });
    const observation = await restarted.observe({
      requestId: "observe-interrupted-before-cancellation-acceptance",
      harnessRunId: launchedRun.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(observation.run.status, "failed");
    assert.equal(observation.outcome.code, "host_daemon_interrupted");
    assert.equal(observation.events.some((event) =>
      event.type === "harness_run_cancellation_accepted"), false);
    assert.equal(observation.events.filter((event) =>
      event.type === "harness_run_failed").length, 1);
    const retry = await restarted.cancel({
      ...request,
      requestId: "retry-unaccepted-cancellation-after-restart",
    });
    assert.equal(retry.code, "harness_run_not_cancellable");
    assert.equal(retry.idempotentReplay, false);
    qualifyIssue164FaultPoint(
      "harness_run_cancellation.before_commit",
      "restart does not invent cancellation when interruption precedes its acceptance commit",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("startup retains recovery-required truth when accepted cancellation termination is unprovable", async () => {
  const fixture = await createFixture("sandking-harness-run-cancel-restart-unconfirmed-");
  const rawRetryKey = "recognizable-restart-cancellation-key";
  let interruptLaunchOnce = true;
  try {
    const interruptedManager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      faultInjector: (point) => {
        if (point === "harness_run_launch.after_state_commit" && interruptLaunchOnce) {
          interruptLaunchOnce = false;
          throw new Error("injected_launch_response_loss_before_unconfirmed_cancel");
        }
        if (point === "harness_run_cancellation.after_state_commit") {
          throw new Error("injected_host_death_with_unconfirmed_cancellation");
        }
      },
    });
    await assert.rejects(interruptedManager.launch(launchRequest(
      fixture.registered.project.projectId, 999_999_993,
    )), /injected_launch_response_loss_before_unconfirmed_cancel/);
    const launchedState = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    const launchedRun = launchedState.runs[0];
    const request = cancellationRequest(launchedRun.harnessRunId, {
      idempotencyKey: rawRetryKey,
    });
    await assert.rejects(
      interruptedManager.cancel(request),
      /injected_host_death_with_unconfirmed_cancellation/,
    );
    const acceptedState = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );

    let terminationInspections = 0;
    let launchContextLoads = 0;
    const restarted = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async (projectId) => {
        launchContextLoads += 1;
        return fixture.registry.loadLaunchContext(projectId);
      },
      inspectInterruptedRunTermination: async () => {
        terminationInspections += 1;
        return { platform: process.platform, status: "unconfirmed" };
      },
    });
    assert.equal(launchContextLoads, 0);
    const observation = await restarted.observe({
      requestId: "observe-unconfirmed-reconciled-cancellation",
      harnessRunId: launchedRun.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(terminationInspections, 1);
    assert.equal(observation.run.status, "recovery_required");
    assert.equal(observation.run.completedAt, null);
    assert.equal(observation.outcome, null);
    assert.equal(observation.run.cancellation.terminationConfirmedAt, null);
    const initialProcessObservation = {
      schemaVersion: 1,
      observedAt: observation.run.recovery.detectedAt,
      platform: process.platform,
      terminationEvidence: "unconfirmed",
      relatedProcessState: "unknown",
      identityProof: "unavailable",
      terminationScope: "complete_process_tree",
      processCount: null,
      launchSettled: null,
      treeEmpty: null,
      safeToTerminate: false,
      processIdentifiersExposed: false,
      unrestrictedProcessHandleExposed: false,
    };
    assert.deepEqual(observation.run.recovery, {
      code: "harness_process_termination_unconfirmed",
      previousStatus: "cancelling",
      detectedAt: observation.run.recovery.detectedAt,
      platform: process.platform,
      terminationEvidence: "unconfirmed",
      reconciliationAuditId: observation.run.recovery.reconciliationAuditId,
      evidenceSchemaVersion: 2,
      initialProcessObservation,
      initialAvailableActions: ["recheck"],
      processObservation: initialProcessObservation,
      availableActions: ["recheck"],
    });
    assert.equal(observation.events.filter((event) =>
      event.type === "harness_run_cancellation_accepted").length, 1);
    assert.equal(observation.events.filter((event) =>
      event.type === "harness_run_recovery_required").length, 1);
    assert.equal(observation.events.some((event) =>
      ["harness_run_succeeded", "harness_run_failed", "harness_run_cancelled"]
        .includes(event.type)), false);
    assert.deepEqual(observation.run.executionSnapshot,
      acceptedState.runs[0].executionSnapshot);

    const replay = await restarted.cancel({
      ...request,
      requestId: "replay-unconfirmed-cancellation-after-controller-restart",
      controllerId: `runtime-${"9".repeat(24)}`,
    });
    assert.equal(replay.code, "harness_run_cancellation_accepted");
    assert.equal(replay.idempotentReplay, true);
    const deliberateNewRun = await restarted.launch(hashedLaunchRequest(launchRequest(
      fixture.registered.project.projectId,
      163,
      { idempotencyKey: "deliberate-new-run-after-cancellation-recovery" },
    )));
    assert.equal(deliberateNewRun.type, "harness.run.launch.result");
    assert.notEqual(deliberateNewRun.run.harnessRunId, launchedRun.harnessRunId);
    assert.equal(launchContextLoads, 1);
    await waitForTerminal(restarted, deliberateNewRun.run.harnessRunId);
    const originalAfterDeliberateLaunch = await restarted.observe({
      requestId: "observe-original-cancellation-recovery-after-deliberate-launch",
      harnessRunId: launchedRun.harnessRunId,
      afterSequence: 0,
    });
    assert.deepEqual(originalAfterDeliberateLaunch.run, observation.run);
    assert.deepEqual(originalAfterDeliberateLaunch.events, observation.events);

    const repeated = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("repeated_unconfirmed_cancellation_must_not_resolve_context");
      },
      inspectInterruptedRunTermination: async () => {
        throw new Error("recovery_required_cancellation_must_not_be_reinspected");
      },
    });
    const repeatedObservation = await repeated.observe({
      requestId: "observe-repeated-unconfirmed-cancellation",
      harnessRunId: launchedRun.harnessRunId,
      afterSequence: 0,
    });
    assert.deepEqual(repeatedObservation.events, observation.events);
    assert.equal(fixture.audits.filter((audit) =>
      audit.action === "harness.run.reconcile"
      && audit.details.harnessRunId === launchedRun.harnessRunId).length, 1);
    const resolving = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      inspectInterruptedRunTermination: async () => ({
        platform: process.platform,
        status: "confirmed",
      }),
    });
    const rechecked = await resolving.recover(recoveryRequest(
      launchedRun.harnessRunId,
      "recheck",
      { idempotencyKey: "recheck-restarted-cancellation-termination" },
    ));
    assert.deepEqual(rechecked.run.recovery.availableActions, ["finalize"]);
    const finalized = await resolving.recover(recoveryRequest(
      launchedRun.harnessRunId,
      "finalize",
      { idempotencyKey: "finalize-restarted-cancellation-termination" },
    ));
    assert.equal(finalized.run.status, "cancelled");
    assert.equal(finalized.outcome.status, "cancelled");
    assert.equal(finalized.outcome.incompleteResult, true);
    assert.match(finalized.run.cancellation.terminationConfirmedAt,
      /^\d{4}-\d{2}-\d{2}T/);
    const finalizedObservation = await resolving.observe({
      requestId: "observe-finalized-cancellation-recovery",
      harnessRunId: launchedRun.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(finalizedObservation.events.filter((event) =>
      event.type === "harness_run_cancelled").length, 1);
    assert.doesNotMatch(JSON.stringify({
      state: JSON.parse(await readFile(
        join(fixture.dataDir, "harness-runs.json"), "utf8",
      )),
      audits: fixture.audits,
    }), new RegExp(rawRetryKey));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("restart arbitrates a signal dispatched before its durable publication", async () => {
  const fixture = await createFixture("sandking-harness-run-cancel-after-signal-dispatch-");
  let manager;
  let reportSignalDispatched;
  let releaseSignalDispatch;
  const signalDispatched = new Promise((resolve) => {
    reportSignalDispatched = resolve;
  });
  const signalDispatchRelease = new Promise((resolve) => {
    releaseSignalDispatch = resolve;
  });
  let signalDispatchCount = 0;
  try {
    manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      cancellationGraceMs: 50,
      faultInjector: async (point) => {
        if (point === "harness_run_cancellation.cooperative_signal.after_dispatch") {
          signalDispatchCount += 1;
          reportSignalDispatched?.();
          await signalDispatchRelease;
          throw new Error("injected_host_death_after_cancellation_signal_dispatch");
        }
      },
    });
    const launched = await manager.launch(launchRequest(
      fixture.registered.project.projectId,
      999_999_994,
    ));
    await waitForRunStatus(manager, launched.run.harnessRunId, "running");
    const request = cancellationRequest(launched.run.harnessRunId, {
      idempotencyKey: "restart-after-cooperative-signal-dispatch",
    });
    const accepted = await manager.cancel(request);
    assert.equal(accepted.code, "harness_run_cancellation_accepted");
    await waitForTestCheckpoint(
      signalDispatched,
      "cooperative_signal_dispatch_not_observed",
      localFaultCheckpointTimeoutMs,
    );

    const ambiguousState = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    const ambiguousRun = ambiguousState.runs[0];
    assert.equal(ambiguousRun.status, "cancelling");
    assert.equal(ambiguousRun.cancellation.cooperativeSignalSentAt, null);
    assert.equal(ambiguousRun.cancellation.forcedTerminationSentAt, null);
    assert.equal(ambiguousRun.cancellation.terminationConfirmedAt, null);
    assert.equal(ambiguousRun.outcome, null);

    releaseSignalDispatch();
    await waitForTestCheckpoint(
      manager.waitForIdle(),
      "cooperative_signal_manager_idle",
      supervisionQuiescenceTimeoutMs,
    );
    manager = null;
    const restarted = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("signal_dispatch_restart_must_not_resolve_launch_context");
      },
      inspectInterruptedRunTermination: async () => ({
        platform: process.platform,
        status: "confirmed",
      }),
    });
    const reconciled = await restarted.observe({
      requestId: "observe-restart-after-ambiguous-signal-dispatch",
      harnessRunId: launched.run.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(reconciled.run.status, "cancelled");
    assert.equal(reconciled.run.cancellation.cooperativeSignalSentAt, null);
    assert.match(reconciled.run.cancellation.terminationConfirmedAt,
      /^2026-|^20[0-9]{2}-/);
    assert.equal(reconciled.events.filter((event) =>
      event.type === "harness_run_cancelled").length, 1);
    const replay = await restarted.cancel({
      ...request,
      requestId: "replay-after-ambiguous-signal-dispatch",
      controllerId: `runtime-${"8".repeat(24)}`,
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(signalDispatchCount, 1);
    qualifyIssue164FaultPoint(
      "harness_run_cancellation.cooperative_signal.after_dispatch",
      "restart arbitrates a signal dispatched before its durable publication",
    );
  } finally {
    releaseSignalDispatch?.();
    if (manager) {
      await waitForTestCheckpoint(
        manager.waitForIdle(),
        "cooperative_signal_manager_idle",
        supervisionQuiescenceTimeoutMs,
      );
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cooperative signal publication is durable before restart terminal arbitration", async () => {
  const fixture = await createFixture("sandking-harness-run-cancel-signal-publication-");
  let manager;
  let reportSignalPublication;
  let releaseSignalPublication;
  const signalPublished = new Promise((resolve) => {
    reportSignalPublication = resolve;
  });
  const signalPublicationRelease = new Promise((resolve) => {
    releaseSignalPublication = resolve;
  });
  let signalPublicationCount = 0;
  try {
    manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      cancellationGraceMs: 2_000,
      faultInjector: async (point) => {
        if (point === "harness_run_cancellation.cooperative_signal.after_state_commit") {
          signalPublicationCount += 1;
          reportSignalPublication?.();
          await signalPublicationRelease;
          throw new Error("injected_host_death_after_cancellation_signal_publication");
        }
      },
    });
    const launched = await manager.launch(launchRequest(
      fixture.registered.project.projectId,
      999_999_994,
    ));
    await waitForRunStatus(manager, launched.run.harnessRunId, "running");
    const request = cancellationRequest(launched.run.harnessRunId, {
      idempotencyKey: "restart-after-cooperative-signal-publication",
    });
    const accepted = await manager.cancel(request);
    assert.equal(accepted.code, "harness_run_cancellation_accepted");
    await waitForTestCheckpoint(
      signalPublished,
      "cooperative_signal_publication_not_observed",
      2_000,
    );

    const signalledState = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    const signalledRun = signalledState.runs[0];
    assert.equal(signalledRun.status, "cancelling");
    assert.match(signalledRun.cancellation.cooperativeSignalSentAt,
      /^2026-|^20[0-9]{2}-/);
    assert.equal(signalledRun.cancellation.forcedTerminationSentAt, null);
    assert.equal(signalledRun.cancellation.terminationConfirmedAt, null);
    assert.equal(signalledRun.outcome, null);

    releaseSignalPublication();
    await waitForTestCheckpoint(
      manager.waitForIdle(),
      "signal_publication_manager_idle",
      supervisionQuiescenceTimeoutMs,
    );
    manager = null;
    const restarted = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("signal_restart_must_not_resolve_mutable_launch_context");
      },
      inspectInterruptedRunTermination: async () => ({
        platform: process.platform,
        status: "confirmed",
      }),
    });
    const reconciled = await restarted.observe({
      requestId: "observe-restart-after-cooperative-signal",
      harnessRunId: launched.run.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(reconciled.run.status, "cancelled");
    assert.equal(reconciled.run.cancellation.cooperativeSignalSentAt,
      signalledRun.cancellation.cooperativeSignalSentAt);
    assert.match(reconciled.run.cancellation.terminationConfirmedAt,
      /^2026-|^20[0-9]{2}-/);
    assert.equal(reconciled.events.filter((event) =>
      event.type === "harness_run_cancelled").length, 1);

    const replay = await restarted.cancel({
      ...request,
      requestId: "replay-after-cooperative-signal-restart",
      controllerId: `runtime-${"8".repeat(24)}`,
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(signalPublicationCount, 1);
    qualifyIssue164FaultPoint(
      "harness_run_cancellation.cooperative_signal.after_state_commit",
      "cooperative signal publication is durable before restart terminal arbitration",
    );
  } finally {
    releaseSignalPublication?.();
    if (manager) {
      await waitForTestCheckpoint(
        manager.waitForIdle(),
        "signal_publication_manager_idle",
        supervisionQuiescenceTimeoutMs,
      );
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("retained termination confirmation finalizes accepted cancellation exactly once after restart", async () => {
  const fixture = await createFixture("sandking-harness-run-cancel-confirmation-restart-");
  let manager;
  let reportConfirmationCommit;
  let releaseConfirmationCommit;
  const confirmationCommitted = new Promise((resolve) => {
    reportConfirmationCommit = resolve;
  });
  const confirmationCommitRelease = new Promise((resolve) => {
    releaseConfirmationCommit = resolve;
  });
  try {
    manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      faultInjector: async (point) => {
        if (point
          === "harness_run_cancellation.termination_confirmation.after_state_commit") {
          reportConfirmationCommit?.();
          await confirmationCommitRelease;
          throw new Error("injected_host_death_after_termination_confirmation");
        }
      },
    });
    const launched = await manager.launch(launchRequest(
      fixture.registered.project.projectId,
      999_999_993,
    ));
    await waitForRunStatus(manager, launched.run.harnessRunId, "running");
    const request = cancellationRequest(launched.run.harnessRunId, {
      idempotencyKey: "restart-after-cancellation-termination-confirmation",
    });
    await manager.cancel(request);
    await waitForTestCheckpoint(
      confirmationCommitted,
      "cancellation_confirmation_commit_not_observed",
      2_000,
    );

    const confirmedState = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    const confirmedRun = confirmedState.runs[0];
    assert.equal(confirmedRun.status, "cancelling");
    assert.match(confirmedRun.cancellation.terminationConfirmedAt,
      /^2026-|^20[0-9]{2}-/);
    assert.equal(confirmedRun.outcome, null);

    releaseConfirmationCommit();
    await waitForTestCheckpoint(
      manager.waitForIdle(),
      "termination_confirmation_manager_idle",
      supervisionQuiescenceTimeoutMs,
    );
    manager = null;
    const restarted = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("confirmed_cancellation_must_not_resolve_launch_context");
      },
      inspectInterruptedRunTermination: async () => {
        throw new Error("durable_termination_confirmation_must_not_be_reinspected");
      },
    });
    const reconciled = await restarted.observe({
      requestId: "observe-reconciled-confirmed-cancellation",
      harnessRunId: launched.run.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(reconciled.run.status, "cancelled");
    assert.equal(reconciled.run.cancellation.terminationConfirmedAt,
      confirmedRun.cancellation.terminationConfirmedAt);
    assert.equal(reconciled.outcome.status, "cancelled");
    assert.equal(reconciled.outcome.incompleteResult, true);
    assert.equal(reconciled.events.filter((event) =>
      event.type === "harness_run_cancelled").length, 1);
    const replay = await restarted.cancel({
      ...request,
      requestId: "replay-after-confirmed-cancellation-restart",
    });
    assert.equal(replay.idempotentReplay, true);
    qualifyIssue164FaultPoint(
      "harness_run_cancellation.termination_confirmation.after_state_commit",
      "retained termination confirmation finalizes accepted cancellation exactly once after restart",
    );
  } finally {
    releaseConfirmationCommit?.();
    if (manager) {
      await waitForTestCheckpoint(
        manager.waitForIdle(),
        "termination_confirmation_manager_idle",
        supervisionQuiescenceTimeoutMs,
      );
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("forced signal publication survives restart without a second escalation", async () => {
  const fixture = await createFixture("sandking-harness-run-cancel-forced-signal-restart-");
  let manager;
  let reportForcedSignalCommit;
  let releaseForcedSignalCommit;
  const forcedSignalCommitted = new Promise((resolve) => {
    reportForcedSignalCommit = resolve;
  });
  const forcedSignalCommitRelease = new Promise((resolve) => {
    releaseForcedSignalCommit = resolve;
  });
  let forcedSignalPublicationCount = 0;
  try {
    manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      cancellationGraceMs: 50,
      faultInjector: async (point) => {
        if (point === "harness_run_cancellation.forced_signal.after_state_commit") {
          forcedSignalPublicationCount += 1;
          reportForcedSignalCommit?.();
          await forcedSignalCommitRelease;
          throw new Error("injected_host_death_after_forced_signal_publication");
        }
      },
    });
    const launched = await manager.launch(launchRequest(
      fixture.registered.project.projectId,
      999_999_992,
    ));
    await waitForRunStatus(manager, launched.run.harnessRunId, "running");
    const request = cancellationRequest(launched.run.harnessRunId, {
      idempotencyKey: "restart-after-forced-cancellation-signal",
    });
    await manager.cancel(request);
    await waitForTestCheckpoint(
      forcedSignalCommitted,
      "forced_signal_commit_not_observed",
      2_000,
    );

    const forcedState = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    const forcedRun = forcedState.runs[0];
    assert.equal(forcedRun.status, "cancelling");
    assert.match(forcedRun.cancellation.forcedTerminationSentAt,
      /^2026-|^20[0-9]{2}-/);
    assert.equal(forcedRun.cancellation.terminationConfirmedAt, null);
    assert.equal(forcedRun.outcome, null);

    releaseForcedSignalCommit();
    await waitForTestCheckpoint(
      manager.waitForIdle(),
      "forced_signal_manager_idle",
      supervisionQuiescenceTimeoutMs,
    );
    manager = null;
    const restarted = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("forced_signal_restart_must_not_resolve_launch_context");
      },
      inspectInterruptedRunTermination: async () => ({
        platform: process.platform,
        status: "confirmed",
      }),
    });
    const reconciled = await restarted.observe({
      requestId: "observe-reconciled-forced-signal-cancellation",
      harnessRunId: launched.run.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(reconciled.run.status, "cancelled");
    assert.equal(reconciled.run.cancellation.forcedTerminationSentAt,
      forcedRun.cancellation.forcedTerminationSentAt);
    assert.equal(reconciled.outcome.incompleteResult, true);
    const replay = await restarted.cancel({
      ...request,
      requestId: "replay-reconciled-forced-signal-cancellation",
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(forcedSignalPublicationCount, 1);
    qualifyIssue164FaultPoint(
      "harness_run_cancellation.forced_signal.after_state_commit",
      "forced signal publication survives restart without a second escalation",
    );
  } finally {
    releaseForcedSignalCommit?.();
    if (manager) {
      await waitForTestCheckpoint(
        manager.waitForIdle(),
        "forced_signal_manager_idle",
        supervisionQuiescenceTimeoutMs,
      );
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("pre-publication cancellation signal and termination faults converge after restart", async () => {
  const cases = [
    {
      point: "harness_run_cancellation.cooperative_signal.before_dispatch",
      issueNumber: 999_999_994,
      cooperativePublished: false,
      forcedPublished: false,
    },
    {
      point: "harness_run_cancellation.forced_signal.before_dispatch",
      issueNumber: 999_999_992,
      forcedPublished: false,
    },
    {
      point: "harness_run_cancellation.forced_signal.after_dispatch",
      issueNumber: 999_999_992,
      forcedPublished: false,
    },
    {
      point: "harness_run_cancellation.termination_confirmation.before_commit",
      issueNumber: 999_999_993,
      someSignalPublished: true,
    },
  ];

  for (const [index, boundary] of cases.entries()) {
    const fixture = await createFixture(`sandking-cancellation-signal-boundary-${index}-`);
    const projectFilesBefore = (await readdir(fixture.projectPath)).sort();
    let reportFault;
    const faultReached = new Promise((resolve) => { reportFault = resolve; });
    let injections = 0;
    try {
      const manager = await createHarnessRunManager({
        dataDir: fixture.dataDir,
        hostId,
        recordAudit: fixture.recordAudit,
        loadLaunchContext: fixture.registry.loadLaunchContext,
        cancellationGraceMs: 50,
        faultInjector: (point) => {
          if (point !== boundary.point || injections > 0) return;
          injections += 1;
          reportFault();
          throw new Error(`injected_cancellation_signal_boundary_${index}`);
        },
      });
      const launched = await manager.launch(launchRequest(
        fixture.registered.project.projectId,
        boundary.issueNumber,
        { idempotencyKey: `cancellation-signal-boundary-launch-${index}` },
      ));
      await waitForRunStatus(manager, launched.run.harnessRunId, "running");
      const request = cancellationRequest(launched.run.harnessRunId, {
        idempotencyKey: `cancellation-signal-boundary-cancel-${index}`,
      });
      const accepted = await manager.cancel(request);
      assert.equal(accepted.code, "harness_run_cancellation_accepted");
      await waitForTestCheckpoint(
        faultReached,
        `cancellation_signal_boundary_not_reached:${boundary.point}`,
        5_000,
      );
      await waitForTestCheckpoint(
        manager.waitForIdle(),
        `cancellation_signal_boundary_manager_idle:${boundary.point}`,
        supervisionQuiescenceTimeoutMs,
      );

      const interrupted = JSON.parse(
        await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
      ).runs[0];
      assert.equal(interrupted.status, "cancelling", boundary.point);
      assert.equal(interrupted.outcome, null, boundary.point);
      if (boundary.cooperativePublished !== undefined) {
        assert.equal(
          interrupted.cancellation.cooperativeSignalSentAt !== null,
          boundary.cooperativePublished,
          boundary.point,
        );
      }
      if (boundary.forcedPublished !== undefined) {
        assert.equal(
          interrupted.cancellation.forcedTerminationSentAt !== null,
          boundary.forcedPublished,
          boundary.point,
        );
      }
      if (boundary.someSignalPublished) {
        assert.ok(
          interrupted.cancellation.cooperativeSignalSentAt !== null
            || interrupted.cancellation.forcedTerminationSentAt !== null,
          boundary.point,
        );
      }
      assert.equal(interrupted.cancellation.terminationConfirmedAt, null, boundary.point);

      let inspections = 0;
      const restarted = await createHarnessRunManager({
        dataDir: fixture.dataDir,
        hostId,
        recordAudit: fixture.recordAudit,
        loadLaunchContext: async () => {
          throw new Error("signal_boundary_restart_must_not_resolve_launch_context");
        },
        inspectInterruptedRunTermination: async () => {
          inspections += 1;
          return { platform: process.platform, status: "confirmed" };
        },
      });
      const converged = await restarted.observe({
        requestId: `observe-cancellation-signal-boundary-${index}`,
        harnessRunId: launched.run.harnessRunId,
        afterSequence: 0,
      });
      assert.equal(inspections, 1, boundary.point);
      assert.equal(converged.run.status, "cancelled", boundary.point);
      assert.equal(converged.outcome.incompleteResult, true, boundary.point);
      assert.equal(converged.events.filter((event) =>
        event.type === "harness_run_cancellation_accepted").length, 1, boundary.point);
      assert.equal(converged.events.filter((event) =>
        event.type === "harness_run_cancelled").length, 1, boundary.point);
      const replay = await restarted.cancel({
        ...request,
        requestId: `replay-cancellation-signal-boundary-${index}`,
      });
      assert.equal(replay.idempotentReplay, true, boundary.point);
      assert.equal(injections, 1, boundary.point);

      const repeated = await createHarnessRunManager({
        dataDir: fixture.dataDir,
        hostId,
        recordAudit: fixture.recordAudit,
        loadLaunchContext: async () => {
          throw new Error("signal_boundary_terminal_restart_must_not_relaunch");
        },
        inspectInterruptedRunTermination: async () => {
          throw new Error("signal_boundary_terminal_restart_must_not_reinspect");
        },
      });
      const repeatedObservation = await repeated.observe({
        requestId: `observe-repeated-cancellation-signal-boundary-${index}`,
        harnessRunId: launched.run.harnessRunId,
        afterSequence: 0,
      });
      assert.deepEqual(repeatedObservation.events, converged.events, boundary.point);
      assert.deepEqual(repeatedObservation.outcome, converged.outcome, boundary.point);
      assert.deepEqual((await readdir(fixture.projectPath)).sort(), projectFilesBefore);
      qualifyIssue164FaultPoint(
        boundary.point,
        "pre-publication cancellation signal and termination faults converge after restart",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("restart repairs a cancellation terminal outcome interrupted after state publication", async () => {
  const fixture = await createFixture("sandking-harness-run-cancel-outcome-publication-");
  let reportOutcomeStateCommit;
  const outcomeStateCommitted = new Promise((resolve) => {
    reportOutcomeStateCommit = resolve;
  });
  let interruptCancellationOutcome = false;
  try {
    const manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      faultInjector: (point) => {
        if (point === "harness_run_outcome.after_state_commit"
          && interruptCancellationOutcome) {
          interruptCancellationOutcome = false;
          reportOutcomeStateCommit?.();
          throw new Error("injected_host_death_after_cancellation_outcome_commit");
        }
      },
    });
    const launched = await manager.launch(launchRequest(
      fixture.registered.project.projectId,
      999_999_993,
    ));
    await waitForRunStatus(manager, launched.run.harnessRunId, "running");
    interruptCancellationOutcome = true;
    const request = cancellationRequest(launched.run.harnessRunId, {
      idempotencyKey: "restart-after-cancelled-outcome-publication",
    });
    await manager.cancel(request);
    await waitForTestCheckpoint(
      outcomeStateCommitted,
      "cancellation_outcome_state_commit_not_observed",
      2_000,
    );

    const committed = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    ).runs[0];
    assert.equal(committed.status, "cancelled");
    assert.equal(committed.outcome.status, "cancelled");
    assert.equal(committed.events.filter((event) =>
      event.type === "harness_run_cancelled").length, 1);
    assert.equal(fixture.audits.some((audit) =>
      audit.auditId === committed.outcome.outcomeAuditId), false);

    const restarted = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("accepted_terminal_restart_must_not_resolve_launch_context");
      },
      inspectInterruptedRunTermination: async () => {
        throw new Error("accepted_terminal_restart_must_not_reinspect_termination");
      },
    });
    const repaired = await restarted.observe({
      requestId: "observe-repaired-cancellation-outcome-publication",
      harnessRunId: launched.run.harnessRunId,
      afterSequence: 0,
    });
    assert.deepEqual(repaired.outcome, committed.outcome);
    assert.deepEqual(repaired.events, committed.events);
    assert.equal(fixture.audits.filter((audit) =>
      audit.auditId === committed.outcome.outcomeAuditId).length, 1);
    const replay = await restarted.cancel({
      ...request,
      requestId: "replay-repaired-cancellation-outcome",
    });
    assert.equal(replay.idempotentReplay, true);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("uncertain termination confirmation never invents a cancelled outcome", async () => {
  const fixture = await createFixture("sandking-harness-run-cancel-uncertain-");
  // The nested cascade regression deliberately withholds only this checkpoint.
  // Ordinary Harness-run execution always takes the real confirmation path.
  const stallConfirmationCheckpoint =
    process.env.SANDKING_TEST_STALL_CANCELLATION_CONFIRMATION === "1";
  let reportConfirmationAttempt;
  const confirmationAttempted = new Promise((resolve) => {
    reportConfirmationAttempt = resolve;
  });
  try {
    const manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      faultInjector: (point) => {
        if (point === "harness_run_cancellation.termination_confirmation.before_commit") {
          if (!stallConfirmationCheckpoint) reportConfirmationAttempt();
          throw new Error("simulated_termination_confirmation_uncertainty");
        }
      },
    });
    const launched = await manager.launch(launchRequest(
      fixture.registered.project.projectId,
      999_999_993,
    ));
    await waitForRunStatus(manager, launched.run.harnessRunId, "running");
    await manager.cancel(cancellationRequest(launched.run.harnessRunId, {
      idempotencyKey: "uncertain-termination-confirmation-key",
    }));
    await waitForTestCheckpoint(
      confirmationAttempted,
      "cancellation_termination_confirmation_not_attempted",
      stallConfirmationCheckpoint ? 25 : localFaultCheckpointTimeoutMs,
    );
    await waitForTestCheckpoint(
      manager.waitForIdle(),
      "uncertain_termination_manager_idle",
      supervisionQuiescenceTimeoutMs,
    );

    const observation = await manager.observe({
      requestId: "observe-uncertain-cancellation",
      harnessRunId: launched.run.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(observation.run.status, "cancelling");
    assert.equal(observation.run.completedAt, null);
    assert.equal(observation.run.cancellation.terminationConfirmedAt, null);
    assert.equal(observation.outcome, null);
    assert.equal(observation.events.some((event) =>
      ["harness_run_succeeded", "harness_run_failed", "harness_run_cancelled"]
        .includes(event.type)), false);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a valid terminal outcome committed before cancellation remains the one outcome", async () => {
  const fixture = await createFixture("sandking-harness-run-completion-wins-");
  try {
    const launched = await fixture.manager.launch(launchRequest(
      fixture.registered.project.projectId,
      161,
    ));
    const completed = await waitForTerminal(fixture.manager, launched.run.harnessRunId);
    assert.equal(completed.run.status, "succeeded");
    assert.equal(completed.outcome.code, "conformance_run_succeeded");

    const request = cancellationRequest(launched.run.harnessRunId, {
      idempotencyKey: "completion-wins-cancellation-key",
    });
    const rejected = await fixture.manager.cancel(request);
    assert.equal(rejected.type, "harness.run.cancel.failure");
    assert.equal(rejected.code, "harness_run_not_cancellable");
    const replay = await fixture.manager.cancel({
      ...request,
      requestId: "completion-wins-cancellation-replay",
    });
    assert.equal(replay.code, "harness_run_not_cancellable");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.auditId, rejected.auditId);

    const after = await fixture.manager.observe({
      requestId: "observe-completion-wins",
      harnessRunId: launched.run.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(after.run.status, "succeeded");
    assert.deepEqual(after.outcome, completed.outcome);
    assert.equal(after.events.filter((event) =>
      ["harness_run_succeeded", "harness_run_failed", "harness_run_cancelled"]
        .includes(event.type)).length, 1);
    assert.equal(after.events.some((event) =>
      event.type === "harness_run_cancellation_accepted"), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cancellation accepted before terminal commit wins the serialized race", async () => {
  const fixture = await createFixture("sandking-harness-run-cancel-wins-race-");
  let releaseOutcomeCommit;
  let reportOutcomeCommit;
  let pauseOutcome = true;
  const outcomeCommitReached = new Promise((resolve) => {
    reportOutcomeCommit = resolve;
  });
  const outcomeCommitRelease = new Promise((resolve) => {
    releaseOutcomeCommit = resolve;
  });
  const originalProcessKill = process.kill;
  const staleGroupSignals = [];
  try {
    const manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      faultInjector: async (point) => {
        if (point === "harness_run_outcome.before_commit" && pauseOutcome) {
          pauseOutcome = false;
          reportOutcomeCommit();
          await outcomeCommitRelease;
        }
      },
    });
    const launched = await manager.launch(launchRequest(
      fixture.registered.project.projectId,
      161,
    ));
    await waitForTestCheckpoint(
      outcomeCommitReached,
      "completed_outcome_commit_not_reached",
      localFaultCheckpointTimeoutMs,
    );
    process.kill = (pid, signal) => {
      if (pid < 0 && signal !== 0) staleGroupSignals.push({ pid, signal });
      return originalProcessKill(pid, signal);
    };
    const accepted = await manager.cancel(cancellationRequest(
      launched.run.harnessRunId,
      { idempotencyKey: "cancel-before-terminal-commit" },
    ));
    assert.equal(accepted.code, "harness_run_cancellation_accepted");
    releaseOutcomeCommit();

    const terminal = await waitForTerminal(manager, launched.run.harnessRunId);
    assert.equal(terminal.run.status, "cancelled");
    assert.equal(terminal.outcome.status, "cancelled");
    assert.equal(terminal.outcome.incompleteResult, true);
    assert.equal(terminal.outcome.terminalEnvelope, null);
    assert.equal(terminal.terminalEnvelopeValidation.exactlyOne, true);
    assert.equal(terminal.run.cancellation.cooperativeSignalSentAt, null);
    assert.equal(terminal.run.cancellation.forcedTerminationSentAt, null);
    assert.match(terminal.run.cancellation.terminationConfirmedAt,
      /^2026-|^20[0-9]{2}-/);
    assert.equal(terminal.events.filter((event) =>
      ["harness_run_succeeded", "harness_run_failed", "harness_run_cancelled"]
        .includes(event.type)).length, 1);
    assert.deepEqual(staleGroupSignals, []);
  } finally {
    process.kill = originalProcessKill;
    releaseOutcomeCommit?.();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("late cancellation confirms the complete process tree before recording cancelled", {
  skip: process.platform === "win32"
    ? "native Windows process-tree races are covered by the tracker contract"
    : false,
}, async () => {
  const fixture = await createFixture("sandking-harness-run-late-tree-cancellation-");
  let releaseOutcomeCommit;
  let reportOutcomeCommit;
  let pauseOutcome = true;
  const outcomeCommitReached = new Promise((resolve) => {
    reportOutcomeCommit = resolve;
  });
  const outcomeCommitRelease = new Promise((resolve) => {
    releaseOutcomeCommit = resolve;
  });
  const originalProcessKill = process.kill;
  const unboundGroupSignals = [];
  try {
    const manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      cancellationGraceMs: 50,
      faultInjector: async (point) => {
        if (point === "harness_run_outcome.before_commit" && pauseOutcome) {
          pauseOutcome = false;
          reportOutcomeCommit();
          await outcomeCommitRelease;
        }
      },
    });
    const launched = await manager.launch(launchRequest(
      fixture.registered.project.projectId,
      999_999_992,
    ));
    await waitForTestCheckpoint(
      outcomeCommitReached,
      "late_outcome_commit_not_reached",
      localFaultCheckpointTimeoutMs,
    );
    process.kill = (pid, signal) => {
      if (pid < 0 && signal !== 0) {
        unboundGroupSignals.push({ pid, signal });
      }
      return originalProcessKill(pid, signal);
    };
    const accepted = await manager.cancel(cancellationRequest(
      launched.run.harnessRunId,
      { idempotencyKey: "cancel-after-adapter-exit-with-live-descendant" },
    ));
    releaseOutcomeCommit();

    const terminal = await waitForTerminal(manager, launched.run.harnessRunId);
    assert.equal(terminal.run.status, "cancelled");
    assert.equal(terminal.outcome.status, "cancelled");
    assert.equal(terminal.outcome.incompleteResult, true);
    assert.equal(terminal.outcome.terminalEnvelope, null);
    assert.match(terminal.run.cancellation.forcedTerminationSentAt,
      /^2026-|^20[0-9]{2}-/);
    assert.match(terminal.run.cancellation.terminationConfirmedAt,
      /^2026-|^20[0-9]{2}-/);
    assert.ok(Date.parse(terminal.run.cancellation.forcedTerminationSentAt)
      >= Date.parse(accepted.cooperativeDeadlineAt));
    assert.ok(Date.parse(terminal.run.completedAt)
      >= Date.parse(terminal.run.cancellation.terminationConfirmedAt));
    assert.deepEqual(unboundGroupSignals, []);
  } finally {
    process.kill = originalProcessKill;
    releaseOutcomeCommit?.();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cancellation acceptance commits before the cooperative signal is dispatched", async () => {
  const fixture = await createFixture("sandking-harness-run-cancel-commit-order-");
  let releaseStateCommit;
  let reportStateCommit;
  const stateCommitReached = new Promise((resolve) => {
    reportStateCommit = resolve;
  });
  const stateCommitRelease = new Promise((resolve) => {
    releaseStateCommit = resolve;
  });
  try {
    const manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      faultInjector: async (point) => {
        if (point === "harness_run_cancellation.after_state_commit") {
          reportStateCommit();
          await stateCommitRelease;
        }
      },
    });
    const launched = await manager.launch(launchRequest(
      fixture.registered.project.projectId,
      999_999_993,
    ));
    await waitForRunStatus(manager, launched.run.harnessRunId, "running");
    const cancellation = manager.cancel(cancellationRequest(
      launched.run.harnessRunId,
      { idempotencyKey: "cancel-commit-order-key" },
    ));
    await waitForTestCheckpoint(
      stateCommitReached,
      "cancellation_state_commit_not_reached",
      localFaultCheckpointTimeoutMs,
    );

    const committed = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(committed.schemaVersion, 8);
    assert.equal(committed.runs[0].status, "cancelling");
    assert.match(committed.runs[0].cancellation.auditId, /^audit-[a-f0-9]{24}$/);
    assert.equal(committed.runs[0].cancellation.cooperativeSignalSentAt, null);
    assert.equal(committed.runs[0].cancellation.forcedTerminationSentAt, null);
    assert.equal(committed.runs[0].cancellation.terminationConfirmedAt, null);
    assert.equal(committed.cancellationOutcomes.length, 1);
    assert.equal(fixture.audits.some((audit) =>
      audit.action === "harness.run.cancel" && audit.outcome === "accepted"), false);

    releaseStateCommit();
    const accepted = await cancellation;
    assert.equal(accepted.code, "harness_run_cancellation_accepted");
    const terminal = await waitForTerminal(manager, launched.run.harnessRunId);
    assert.equal(terminal.run.status, "cancelled");
    assert.equal(terminal.outcome.incompleteResult, false);
  } finally {
    releaseStateCommit?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cancellation acceptance remains in canonical history at progress capacity", async () => {
  const fixture = await createFixture("sandking-harness-run-cancel-event-capacity-");
  try {
    const launched = await fixture.manager.launch(launchRequest(
      fixture.registered.project.projectId,
      999_999_993,
    ));
    await waitForRunStatus(fixture.manager, launched.run.harnessRunId, "running");
    // The fixture publishes diagnostics on separate streams before readiness,
    // but their Host-private writes can commit just after the ready event. Wait
    // for both so this direct capacity fixture cannot race a queued log update.
    await waitForDiagnosticCommits(fixture.manager, launched.run.harnessRunId);
    const progressDeadline = Date.now() + 2_000;
    while (Date.now() < progressDeadline) {
      const observation = await fixture.manager.observe({
        requestId: "observe-progress-before-capacity-fixture",
        harnessRunId: launched.run.harnessRunId,
        afterSequence: 0,
      });
      if (observation.events.some((event) =>
        event.type === "harness_progress_published")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const statePath = join(fixture.dataDir, "harness-runs.json");
    const retained = JSON.parse(await readFile(statePath, "utf8"));
    const run = retained.runs[0];
    const retainedProgressCount = run.events.filter((event) =>
      event.type === "harness_progress_published").length;
    assert.ok(retainedProgressCount >= 1);
    const recordedAt = new Date().toISOString();
    for (let index = 0; index < 1_021 - retainedProgressCount; index += 1) {
      const suffix = (index + 100).toString(16).padStart(24, "0");
      run.events.push({
        eventId: `harness-event-${suffix}`,
        harnessRunId: run.harnessRunId,
        sequence: run.events.length + 1,
        type: "harness_progress_published",
        recordedAt,
        progressRecord: {
          recordId: `progress-${suffix}`,
          schemaVersion: "1.0.0",
          type: "conformance.capacity",
          parentRecordId: null,
          label: "Exercise retained event capacity",
          summary: "Retain every accepted lifecycle transition at the bounded capacity.",
          status: "complete",
          timestamp: recordedAt,
          payload: { index },
        },
        outcomeReference: null,
      });
    }
    await writeFile(statePath, `${JSON.stringify(retained, null, 2)}\n`);

    await fixture.manager.cancel(cancellationRequest(run.harnessRunId, {
      idempotencyKey: "cancel-at-retained-event-capacity",
    }));
    const terminal = await waitForTerminal(fixture.manager, run.harnessRunId);
    assert.equal(terminal.run.status, "cancelled");
    assert.equal(terminal.events.filter((event) =>
      event.type === "harness_run_cancellation_accepted").length, 1);
    assert.equal(terminal.events.at(-2).type, "harness_run_cancellation_accepted");
    assert.equal(terminal.events.at(-1).type, "harness_run_cancelled");
    assert.equal(terminal.events.at(-1).sequence, terminal.events.length);
    const incremental = await fixture.manager.observe({
      requestId: "observe-capacity-cancellation-tail",
      harnessRunId: run.harnessRunId,
      afterSequence: 1_023,
    });
    assert.deepEqual(incremental.events.map((event) => event.type), [
      "harness_run_cancellation_accepted",
      "harness_run_cancelled",
    ]);
    assert.equal(incremental.nextSequence, 1_025);
    assert.equal(incremental.run.status, "cancelled");
    assert.equal(incremental.outcome.status, "cancelled");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
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
      productionHarness: null,
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
  const stateCommit = await createFixture("sandking-harness-launch-state-commit-");
  const postCommit = await createFixture("sandking-harness-launch-post-commit-");
  const auditCommit = await createFixture("sandking-harness-launch-audit-commit-");
  const rawRetryKey = "recognizable-raw-launch-retry-key";
  const pointBeforeCommit = "harness_run_launch.before_commit";
  const pointAfterStateCommit = "harness_run_launch.after_state_commit";
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
    const preRestarted = await createHarnessRunManager({
      dataDir: preCommit.dataDir,
      hostId,
      recordAudit: preCommit.recordAudit,
      loadLaunchContext: preCommit.registry.loadLaunchContext,
    });
    const preRestartObservation = await preRestarted.observe({
      requestId: "observe-pre-commit-launch-after-restart",
      harnessRunId: null,
      afterSequence: 0,
    });
    assert.equal(preRestartObservation.run, null);
    const retriedPreCommit = await preRestarted.launch({
      ...preRequest,
      requestId: "retry-pre-commit-launch-after-restart",
    });
    assert.equal(retriedPreCommit.idempotentReplay, false);
    await waitForTerminal(preRestarted, retriedPreCommit.run.harnessRunId);
    assert.equal(JSON.parse(
      await readFile(join(preCommit.dataDir, "harness-runs.json"), "utf8"),
    ).runs.length, 1);
    qualifyIssue164FaultPoint(
      pointBeforeCommit,
      "launch commit interruptions leave pre-commit work unclaimed and replay post-commit work",
    );

    const projectFilesBefore = (await readdir(stateCommit.projectPath)).sort();
    const stateFaults = [];
    const stateManager = await createHarnessRunManager({
      dataDir: stateCommit.dataDir,
      hostId,
      recordAudit: stateCommit.recordAudit,
      loadLaunchContext: stateCommit.registry.loadLaunchContext,
      faultInjector: async (point) => {
        stateFaults.push(point);
        if (point === pointAfterStateCommit) {
          throw new Error("injected_state_commit_interrupt");
        }
      },
    });
    const stateRequest = hashedLaunchRequest(launchRequest(
      stateCommit.registered.project.projectId,
      159,
      { idempotencyKey: rawRetryKey },
    ));
    await assert.rejects(stateManager.launch(stateRequest), /injected_state_commit_interrupt/);
    assert.deepEqual(stateFaults, [pointBeforeCommit, pointAfterStateCommit]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const committed = JSON.parse(
      await readFile(join(stateCommit.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(committed.runs.length, 1);
    assert.equal(committed.launchOutcomes.length, 1);
    assert.equal(committed.runs[0].status, "starting");
    assert.deepEqual(committed.runs[0].events.map((event) => event.type), [
      "harness_run_created",
    ]);
    assert.equal(stateCommit.audits.some((audit) =>
      audit.action === "harness.run.launch" && audit.outcome === "accepted"), false);
    assert.doesNotMatch(JSON.stringify({ committed, audits: stateCommit.audits }),
      new RegExp(rawRetryKey));

    const restarted = await createHarnessRunManager({
      dataDir: stateCommit.dataDir,
      hostId,
      recordAudit: stateCommit.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("mutable_launch_context_must_not_be_resolved_for_replay");
      },
      inspectInterruptedRunTermination: async () => ({
        platform: process.platform,
        status: "confirmed",
      }),
    });
    const lookup = await restarted.lookup({
      requestId: "lookup-post-commit-launch",
      idempotencyKeyHash: stateRequest.idempotencyKeyHash,
    });
    assert.equal(lookup.found, true);
    const repairedLaunchAudits = stateCommit.audits.filter((audit) =>
      audit.action === "harness.run.launch" && audit.outcome === "accepted");
    assert.equal(repairedLaunchAudits.length, 1);
    assert.equal(repairedLaunchAudits[0].auditId, committed.runs[0].launchAuditId);
    assert.equal(repairedLaunchAudits[0].details.harnessRunId,
      committed.runs[0].harnessRunId);
    const replay = await restarted.launch({
      ...stateRequest,
      requestId: "replay-post-commit-launch",
      parameters: {
        targetBranch: "sandcastle/issue-159",
        issueNumber: 159,
      },
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.run.harnessRunId, lookup.launchOutcome.run.harnessRunId);

    const conflict = await restarted.launch({
      ...stateRequest,
      requestId: "conflict-post-commit-launch",
      parameters: { issueNumber: 160, targetBranch: "sandcastle/issue-160" },
    });
    assert.equal(conflict.code, "idempotency_key_conflict");
    assert.deepEqual(conflict.prohibitedSideEffects, {
      harnessRunCreated: false,
      adapterStarted: false,
      projectWrite: false,
    });
    const afterReplay = JSON.parse(
      await readFile(join(stateCommit.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(afterReplay.runs.length, 1);
    assert.equal(afterReplay.launchOutcomes.length, 1);
    assert.equal(afterReplay.runs[0].events.length, 2);
    assert.equal(afterReplay.runs[0].events.at(-1).type, "harness_run_failed");
    assert.equal(afterReplay.runs[0].outcome.code, "host_daemon_interrupted");
    assert.deepEqual((await readdir(stateCommit.projectPath)).sort(), projectFilesBefore);
    qualifyIssue164FaultPoint(
      pointAfterStateCommit,
      "launch commit interruptions leave pre-commit work unclaimed and replay post-commit work",
    );

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
      { idempotencyKey: "post-commit-retry-key" },
    ));
    await assert.rejects(postManager.launch(postRequest), /injected_post_commit_interrupt/);
    assert.deepEqual(postFaults, [
      pointBeforeCommit,
      pointAfterStateCommit,
      pointAfterCommit,
    ]);
    const postState = JSON.parse(
      await readFile(join(postCommit.dataDir, "harness-runs.json"), "utf8"),
    );
    const postAudits = postCommit.audits.filter((audit) =>
      audit.action === "harness.run.launch" && audit.outcome === "accepted");
    assert.equal(postState.runs.length, 1);
    assert.equal(postState.launchOutcomes.length, 1);
    assert.equal(postAudits.length, 1);
    assert.equal(postAudits[0].auditId, postState.runs[0].launchAuditId);
    const postRestarted = await createHarnessRunManager({
      dataDir: postCommit.dataDir,
      hostId,
      recordAudit: postCommit.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("mutable_launch_context_must_not_be_resolved_for_replay");
      },
      inspectInterruptedRunTermination: async () => ({
        platform: process.platform,
        status: "confirmed",
      }),
    });
    const postReplay = await postRestarted.launch({
      ...postRequest,
      requestId: "replay-complete-post-commit-launch",
    });
    assert.equal(postReplay.idempotentReplay, true);
    assert.equal(postReplay.run.harnessRunId, postState.runs[0].harnessRunId);
    assert.equal(postCommit.audits.filter((audit) =>
      audit.action === "harness.run.launch" && audit.outcome === "accepted").length, 1);
    qualifyIssue164FaultPoint(
      pointAfterCommit,
      "launch commit interruptions leave pre-commit work unclaimed and replay post-commit work",
    );

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
      rm(stateCommit.root, { recursive: true, force: true }),
      rm(postCommit.root, { recursive: true, force: true }),
      rm(auditCommit.root, { recursive: true, force: true }),
    ]);
  }
});

test("readiness and terminal-envelope interruptions converge from exact pre/post history", async () => {
  const boundaries = [
    {
      point: "harness_run_lifecycle.adapter_ready.before_commit",
      retainedStatus: "starting",
      retainedEvents: ["harness_run_created"],
      retainedOutcome: false,
    },
    {
      point: "harness_run_lifecycle.adapter_ready.after_state_commit",
      retainedStatus: "running",
      retainedEvents: ["harness_run_created", "harness_adapter_ready"],
      retainedOutcome: false,
    },
    {
      point: "harness_run_terminal_envelope.before_commit",
      retainedStatus: "running",
      retainedEvents: [
        "harness_run_created",
        "harness_adapter_ready",
        "harness_progress_published",
      ],
      retainedOutcome: false,
    },
    {
      point: "harness_run_outcome.before_commit",
      retainedStatus: "running",
      retainedEvents: [
        "harness_run_created",
        "harness_adapter_ready",
        "harness_progress_published",
      ],
      retainedOutcome: false,
    },
    {
      point: "harness_run_terminal_envelope.after_state_commit",
      retainedStatus: "succeeded",
      retainedEvents: [
        "harness_run_created",
        "harness_adapter_ready",
        "harness_progress_published",
        "harness_run_succeeded",
      ],
      retainedOutcome: true,
    },
    {
      point: "harness_run_outcome.after_state_commit",
      retainedStatus: "succeeded",
      retainedEvents: [
        "harness_run_created",
        "harness_adapter_ready",
        "harness_progress_published",
        "harness_run_succeeded",
      ],
      retainedOutcome: true,
    },
  ];

  for (const [index, boundary] of boundaries.entries()) {
    const fixture = await createFixture(`sandking-harness-lifecycle-boundary-${index}-`);
    const projectFilesBefore = (await readdir(fixture.projectPath)).sort();
    let faultReached;
    const reachedFault = new Promise((resolve) => { faultReached = resolve; });
    let injected = false;
    try {
      const manager = await createHarnessRunManager({
        dataDir: fixture.dataDir,
        hostId,
        recordAudit: fixture.recordAudit,
        loadLaunchContext: fixture.registry.loadLaunchContext,
        faultInjector: (point) => {
          if (point !== boundary.point || injected) return;
          injected = true;
          faultReached();
          throw new Error(`injected_lifecycle_boundary_${index}`);
        },
      });
      const launched = await manager.launch(launchRequest(
        fixture.registered.project.projectId,
        164,
        { idempotencyKey: `lifecycle-boundary-launch-${index}` },
      ));
      await waitForTestCheckpoint(
        reachedFault,
        `lifecycle_boundary_not_reached:${boundary.point}`,
        localFaultCheckpointTimeoutMs,
      );
      // Restart only after the original Host-owned supervision operation has
      // actually unwound from the injected interruption. A timing delay would
      // leave this canonical recovery proof vulnerable to a cross-manager
      // write race.
      await waitForTestCheckpoint(
        manager.waitForIdle(),
        `launch_fault_manager_idle:${boundary.point}`,
        supervisionQuiescenceTimeoutMs,
      );

      const stateAfterFault = JSON.parse(
        await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
      );
      const retainedRun = stateAfterFault.runs[0];
      assert.equal(retainedRun.harnessRunId, launched.run.harnessRunId);
      assert.equal(retainedRun.status, boundary.retainedStatus, boundary.point);
      assert.deepEqual(
        retainedRun.events.map((event) => event.type),
        boundary.retainedEvents,
        boundary.point,
      );
      assert.equal(retainedRun.outcome !== null, boundary.retainedOutcome, boundary.point);
      assert.notEqual(retainedRun.outcome?.code, "harness_adapter_start_failed");
      const immutableSnapshot = structuredClone(retainedRun.executionSnapshot);
      const retainedHistory = structuredClone(retainedRun.events);
      const retainedOutcome = structuredClone(retainedRun.outcome);
      let terminationInspections = 0;

      const restarted = await createHarnessRunManager({
        dataDir: fixture.dataDir,
        hostId,
        recordAudit: fixture.recordAudit,
        loadLaunchContext: async () => {
          throw new Error("lifecycle_restart_must_not_resolve_mutable_launch_context");
        },
        inspectInterruptedRunTermination: async () => {
          terminationInspections += 1;
          return { platform: process.platform, status: "confirmed" };
        },
      });
      const converged = await restarted.observe({
        requestId: `observe-lifecycle-boundary-${index}-after-restart`,
        harnessRunId: launched.run.harnessRunId,
        afterSequence: 0,
      });
      assert.deepEqual(converged.run.executionSnapshot, immutableSnapshot, boundary.point);
      assert.deepEqual(
        converged.events.slice(0, retainedHistory.length),
        retainedHistory,
        boundary.point,
      );
      assert.equal(converged.events.filter((event) => [
        "harness_run_succeeded",
        "harness_run_failed",
        "harness_run_cancelled",
      ].includes(event.type)).length, 1, boundary.point);

      if (boundary.retainedOutcome) {
        assert.equal(terminationInspections, 0, boundary.point);
        assert.equal(converged.run.status, "succeeded", boundary.point);
        assert.deepEqual(converged.outcome, retainedOutcome, boundary.point);
      } else {
        assert.equal(terminationInspections, 1, boundary.point);
        assert.equal(converged.run.status, "failed", boundary.point);
        assert.equal(converged.outcome.code, "host_daemon_interrupted", boundary.point);
        assert.equal(converged.outcome.incompleteResult, true, boundary.point);
        assert.equal(converged.outcome.terminalEnvelope, null, boundary.point);
      }

      const repeated = await createHarnessRunManager({
        dataDir: fixture.dataDir,
        hostId,
        recordAudit: fixture.recordAudit,
        loadLaunchContext: async () => {
          throw new Error("terminal_lifecycle_history_must_not_relaunch");
        },
        inspectInterruptedRunTermination: async () => {
          throw new Error("terminal_lifecycle_history_must_not_be_reinspected");
        },
      });
      const repeatedObservation = await repeated.observe({
        requestId: `observe-lifecycle-boundary-${index}-after-second-restart`,
        harnessRunId: launched.run.harnessRunId,
        afterSequence: 0,
      });
      assert.deepEqual(repeatedObservation.events, converged.events, boundary.point);
      assert.deepEqual(repeatedObservation.outcome, converged.outcome, boundary.point);
      assert.deepEqual((await readdir(fixture.projectPath)).sort(), projectFilesBefore);
      qualifyIssue164FaultPoint(
        boundary.point,
        "readiness and terminal-envelope interruptions converge from exact pre/post history",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("a Cockpit launch retry survives Controller runtime replacement", async () => {
  const fixture = await createFixture("sandking-harness-controller-retry-");
  try {
    const request = hashedLaunchRequest(launchRequest(
      fixture.registered.project.projectId,
      160,
      {
        source: "cockpit",
        controllerSessionId: null,
        idempotencyKey: "cockpit-launch-before-controller-restart",
      },
    ));
    const original = await fixture.manager.launch(request);
    assert.equal(original.type, "harness.run.launch.result");
    assert.equal(original.run.launchIdempotencyKeyHash, request.idempotencyKeyHash);

    const replacementControllerId = `runtime-${"8".repeat(24)}`;
    const replay = await fixture.manager.launch({
      ...request,
      requestId: "harness-launch-after-controller-restart",
      controllerId: replacementControllerId,
    });
    assert.equal(replay.type, "harness.run.launch.result");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.run.harnessRunId, original.run.harnessRunId);
    assert.equal(replay.run.controllerId, controllerId);
    assert.equal(
      replay.run.executionSnapshot.attribution.controllerId,
      controllerId,
    );

    const state = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(state.runs.length, 1);
    assert.equal(state.launchOutcomes.length, 1);
    await waitForTerminal(fixture.manager, original.run.harnessRunId);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("startup reconciles a durably launched run before exposing manager operations", async () => {
  const fixture = await createFixture("sandking-harness-reconcile-startup-");
  const projectFilesBefore = (await readdir(fixture.projectPath)).sort();
  const request = hashedLaunchRequest(launchRequest(
    fixture.registered.project.projectId,
    160,
    { idempotencyKey: "reconcile-interrupted-launch" },
  ));
  try {
    const interruptedManager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      faultInjector: (point) => {
        if (point === "harness_run_launch.after_state_commit") {
          throw new Error("injected_host_death_after_launch_commit");
        }
      },
    });
    await assert.rejects(
      interruptedManager.launch(request),
      /injected_host_death_after_launch_commit/,
    );
    const interruptedState = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    const interruptedRun = structuredClone(interruptedState.runs[0]);
    assert.equal(interruptedRun.status, "starting");
    assert.equal(interruptedRun.outcome, null);
    assert.deepEqual(interruptedRun.events.map((event) => event.type), [
      "harness_run_created",
    ]);
    await appendFile(join(
      fixture.dataDir,
      "harness-runs",
      interruptedRun.harnessRunId,
      "stdout.log",
    ), "uncommitted diagnostic tail");

    let releaseReconciliation;
    const reconciliationBlocked = new Promise((resolve) => {
      releaseReconciliation = resolve;
    });
    let reachedReconciliationCommit = false;
    const startup = createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("reconciliation_must_not_resolve_mutable_launch_context");
      },
      faultInjector: async (point) => {
        if (point === "harness_run_reconciliation.before_commit") {
          reachedReconciliationCommit = true;
          await reconciliationBlocked;
        }
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(reachedReconciliationCommit, false);
    let startupResolved = false;
    void startup.then(() => {
      startupResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(startupResolved, false);
    await writeFile(join(
      fixture.dataDir,
      "harness-runs",
      interruptedRun.harnessRunId,
      "host-loss-termination.json",
    ), `${JSON.stringify({
      schemaVersion: 2,
      platform: process.platform,
      status: "termination_confirmed",
      terminationScope: "complete_process_tree",
      launchSettled: true,
      treeEmpty: true,
      observedAt: "2026-08-09T16:00:00.000Z",
    })}\n`);
    for (let attempt = 0; !reachedReconciliationCommit && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(reachedReconciliationCommit, true);
    releaseReconciliation?.();
    const restarted = await startup;

    const observation = await restarted.observe({
      requestId: "observe-reconciled-run",
      harnessRunId: interruptedRun.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(observation.run.harnessRunId, interruptedRun.harnessRunId);
    assert.equal(observation.run.status, "failed");
    assert.equal(observation.outcome.status, "failed");
    assert.equal(observation.outcome.code, "host_daemon_interrupted");
    assert.equal(observation.outcome.incompleteResult, true);
    assert.equal(observation.outcome.result, null);
    assert.equal(observation.outcome.terminalEnvelope, null);
    assert.match(observation.outcome.outcomeAuditId, /^audit-[a-f0-9]{24}$/);
    assert.deepEqual(observation.outcome.interruption, {
      code: "host_daemon_interrupted",
      previousStatus: "starting",
      reconciledAt: observation.outcome.completedAt,
      reconciliationAuditId: observation.outcome.interruption.reconciliationAuditId,
    });
    assert.match(
      observation.outcome.interruption.reconciliationAuditId,
      /^audit-[a-f0-9]{24}$/,
    );
    assert.deepEqual(observation.events.slice(0, -1), interruptedRun.events);
    assert.equal(observation.events.at(-1).type, "harness_run_failed");
    assert.equal(observation.events.at(-1).sequence, interruptedRun.events.length + 1);
    assert.equal(
      observation.events.at(-1).outcomeReference,
      observation.outcome.outcomeId,
    );
    assert.deepEqual(observation.run.executionSnapshot, interruptedRun.executionSnapshot);
    assert.deepEqual(observation.logStreams, interruptedRun.logStreams);
    assert.deepEqual(
      observation.outcome.diagnosticReferences.map(({ streamId, producer, range }) => ({
        streamId,
        producer,
        range,
      })),
      interruptedRun.logStreams.map((stream) => ({
        streamId: stream.streamId,
        producer: stream.producer,
        range: { start: stream.availableStart, end: stream.availableEnd },
      })),
    );
    assert.equal(observation.terminalEnvelopeValidation.exactlyOne, false);
    assert.equal(observation.terminalEnvelopeValidation.processExitObserved, false);
    const retainedLog = await restarted.readLogs({
      requestId: "read-canonical-interrupted-log-range",
      harnessRunId: interruptedRun.harnessRunId,
      producer: "stdout",
      offset: 0,
      limit: 16_384,
    });
    assert.equal(retainedLog.response.range.availableEnd, 0);
    assert.equal(retainedLog.response.range.end, 0);
    assert.equal(retainedLog.response.range.eof, true);
    assert.equal(retainedLog.data.byteLength, 0);

    const lookup = await restarted.lookup({
      requestId: "lookup-reconciled-launch",
      idempotencyKeyHash: request.idempotencyKeyHash,
    });
    assert.equal(lookup.found, true);
    assert.equal(lookup.launchOutcome.run.harnessRunId, interruptedRun.harnessRunId);
    assert.equal(lookup.launchOutcome.run.status, "starting");
    const replay = await restarted.launch({
      ...request,
      requestId: "replay-reconciled-launch",
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.run.harnessRunId, interruptedRun.harnessRunId);
    assert.equal(replay.run.status, "starting");

    const afterReplay = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(afterReplay.runs.length, 1);
    assert.equal(afterReplay.launchOutcomes.length, 1);
    assert.equal(afterReplay.runs[0].events.length, interruptedRun.events.length + 1);
    assert.equal(afterReplay.runs[0].outcome.outcomeId, observation.outcome.outcomeId);
    assert.equal(fixture.audits.filter((audit) =>
      audit.action === "harness.run.reconcile"
      && audit.details.harnessRunId === interruptedRun.harnessRunId).length, 1);
    assert.equal(fixture.audits.filter((audit) =>
      audit.action === "harness.run.outcome"
      && audit.details.harnessRunId === interruptedRun.harnessRunId).length, 1);
    assert.deepEqual((await readdir(fixture.projectPath)).sort(), projectFilesBefore);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("startup retains recovery-required truth when Host-loss termination is unconfirmed", async () => {
  const fixture = await createFixture("sandking-harness-reconcile-uncertain-");
  const request = hashedLaunchRequest(launchRequest(
    fixture.registered.project.projectId,
    160,
    { idempotencyKey: "reconcile-uncertain-termination" },
  ));
  try {
    const interruptedManager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      faultInjector: (point) => {
        if (point === "harness_run_launch.after_state_commit") {
          throw new Error("injected_host_death_before_supervision");
        }
      },
    });
    await assert.rejects(
      interruptedManager.launch(request),
      /injected_host_death_before_supervision/,
    );
    const interruptedState = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    const interruptedRun = structuredClone(interruptedState.runs[0]);

    let launchContextLoads = 0;
    const restarted = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async (projectId) => {
        launchContextLoads += 1;
        return fixture.registry.loadLaunchContext(projectId);
      },
      now: () => new Date("2026-08-09T17:00:00.000Z"),
      inspectInterruptedRunTermination: async (run) => {
        assert.equal(run.harnessRunId, interruptedRun.harnessRunId);
        return { platform: process.platform, status: "unconfirmed" };
      },
    });
    assert.equal(launchContextLoads, 0);
    const observation = await restarted.observe({
      requestId: "observe-recovery-required-run",
      harnessRunId: interruptedRun.harnessRunId,
      afterSequence: 0,
    });

    assert.equal(observation.run.status, "recovery_required");
    assert.equal(observation.outcome, null);
    const initialProcessObservation = {
      schemaVersion: 1,
      observedAt: "2026-08-09T17:00:00.000Z",
      platform: process.platform,
      terminationEvidence: "unconfirmed",
      relatedProcessState: "unknown",
      identityProof: "unavailable",
      terminationScope: "complete_process_tree",
      processCount: null,
      launchSettled: null,
      treeEmpty: null,
      safeToTerminate: false,
      processIdentifiersExposed: false,
      unrestrictedProcessHandleExposed: false,
    };
    assert.deepEqual(observation.run.recovery, {
      code: "harness_process_termination_unconfirmed",
      previousStatus: "starting",
      detectedAt: "2026-08-09T17:00:00.000Z",
      platform: process.platform,
      terminationEvidence: "unconfirmed",
      reconciliationAuditId: observation.run.recovery.reconciliationAuditId,
      evidenceSchemaVersion: 2,
      initialProcessObservation,
      initialAvailableActions: ["recheck"],
      processObservation: initialProcessObservation,
      availableActions: ["recheck"],
    });
    assert.match(observation.run.recovery.reconciliationAuditId,
      /^audit-[a-f0-9]{24}$/);
    assert.deepEqual(observation.events.slice(0, -1), interruptedRun.events);
    assert.equal(observation.events.at(-1).type, "harness_run_recovery_required");
    assert.equal(observation.events.at(-1).outcomeReference, null);

    const deliberateNewRun = await restarted.launch(hashedLaunchRequest(launchRequest(
      fixture.registered.project.projectId,
      16_000,
      { idempotencyKey: "deliberate-new-run-while-recovery-required" },
    )));
    assert.equal(deliberateNewRun.type, "harness.run.launch.result");
    assert.notEqual(deliberateNewRun.run.harnessRunId, interruptedRun.harnessRunId);
    assert.equal(launchContextLoads, 1);
    await waitForTerminal(restarted, deliberateNewRun.run.harnessRunId);
    const originalAfterDeliberateLaunch = await restarted.observe({
      requestId: "observe-original-recovery-after-deliberate-launch",
      harnessRunId: interruptedRun.harnessRunId,
      afterSequence: 0,
    });
    assert.deepEqual(originalAfterDeliberateLaunch.run, observation.run);
    assert.deepEqual(originalAfterDeliberateLaunch.events, observation.events);
    const blockedCancellation = await restarted.cancel(cancellationRequest(
      interruptedRun.harnessRunId,
      { idempotencyKey: "cancel-recovery-required-run" },
    ));
    assert.equal(blockedCancellation.type, "harness.run.cancel.failure");
    assert.equal(blockedCancellation.code, "harness_run_not_cancellable");
    assert.equal(blockedCancellation.prohibitedSideEffects.cancellationAccepted, false);

    const repeated = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      inspectInterruptedRunTermination: async () => {
        throw new Error("settled_recovery_state_must_not_be_reclassified");
      },
    });
    const repeatedObservation = await repeated.observe({
      requestId: "observe-repeated-recovery-required-run",
      harnessRunId: interruptedRun.harnessRunId,
      afterSequence: 0,
    });
    assert.deepEqual(repeatedObservation.run, observation.run);
    assert.deepEqual(repeatedObservation.events, observation.events);
    assert.equal(fixture.audits.filter((audit) =>
      audit.action === "harness.run.reconcile"
      && audit.details.harnessRunId === interruptedRun.harnessRunId).length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("schema-v7 recovery history migrates without inventing process identity", async () => {
  const fixture = await createFixture("sandking-harness-recovery-v7-migration-");
  try {
    const interrupted = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      faultInjector: (point) => {
        if (point === "harness_run_launch.after_state_commit") {
          throw new Error("seed_v7_recovery");
        }
      },
    });
    await assert.rejects(interrupted.launch(hashedLaunchRequest(launchRequest(
      fixture.registered.project.projectId,
      162,
      { idempotencyKey: "schema-v7-recovery-seed" },
    ))), /seed_v7_recovery/);
    const reconciled = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      inspectInterruptedRunTermination: async () => ({
        platform: process.platform,
        status: "unconfirmed",
      }),
    });
    const before = await reconciled.observe({
      requestId: "observe-before-v7-recovery-migration",
      harnessRunId: null,
      afterSequence: 0,
    });
    const statePath = join(fixture.dataDir, "harness-runs.json");
    const retained = JSON.parse(await readFile(statePath, "utf8"));
    retained.schemaVersion = 7;
    delete retained.recoveryMutations;
    retained.runs[0].recovery = {
      code: retained.runs[0].recovery.code,
      previousStatus: retained.runs[0].recovery.previousStatus,
      detectedAt: retained.runs[0].recovery.detectedAt,
      platform: retained.runs[0].recovery.platform,
      terminationEvidence: "unconfirmed",
      reconciliationAuditId: retained.runs[0].recovery.reconciliationAuditId,
    };
    await writeFile(statePath, `${JSON.stringify(retained, null, 2)}\n`);

    const migrated = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      inspectInterruptedRunTermination: async () => {
        throw new Error("migrated_recovery_must_not_invent_new_evidence");
      },
    });
    const after = await migrated.observe({
      requestId: "observe-after-v7-recovery-migration",
      harnessRunId: before.run.harnessRunId,
      afterSequence: 0,
    });
    assert.deepEqual(after.events, before.events);
    assert.equal(after.run.status, "recovery_required");
    assert.equal(after.run.recovery.evidenceSchemaVersion, 1);
    assert.equal(after.run.recovery.processObservation.relatedProcessState, "unknown");
    assert.equal(after.run.recovery.processObservation.identityProof, "unavailable");
    assert.equal(after.run.recovery.processObservation.safeToTerminate, false);
    assert.deepEqual(after.run.recovery.availableActions, ["recheck"]);
    const migratedState = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(migratedState.schemaVersion, 8);
    assert.deepEqual(migratedState.recoveryMutations, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("recovery recheck and finalization are durable, idempotent, and never invent success", async () => {
  const fixture = await createFixture("sandking-harness-recovery-finalize-");
  const projectFilesBefore = (await readdir(fixture.projectPath)).sort();
  try {
    const interruptedManager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      faultInjector: (point) => {
        if (point === "harness_run_launch.after_state_commit") {
          throw new Error("injected_host_death_for_recovery_finalization");
        }
      },
    });
    await assert.rejects(interruptedManager.launch(hashedLaunchRequest(launchRequest(
      fixture.registered.project.projectId,
      162,
      { idempotencyKey: "recovery-finalization-interrupted-launch" },
    ))), /injected_host_death_for_recovery_finalization/);
    const interruptedState = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    const interruptedRun = structuredClone(interruptedState.runs[0]);
    let inspections = 0;
    const manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      inspectInterruptedRunTermination: async () => {
        inspections += 1;
        return inspections === 1
          ? { platform: process.platform, status: "unconfirmed" }
          : { platform: process.platform, status: "confirmed" };
      },
    });
    const uncertain = await manager.observe({
      requestId: "observe-before-recovery-recheck",
      harnessRunId: interruptedRun.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(uncertain.run.status, "recovery_required");
    assert.deepEqual(uncertain.run.recovery.availableActions, ["recheck"]);
    assert.equal(uncertain.run.recovery.processObservation.relatedProcessState, "unknown");
    assert.equal(uncertain.run.recovery.processObservation.processIdentifiersExposed, false);

    const unsafeTermination = await manager.recover(recoveryRequest(
      interruptedRun.harnessRunId,
      "terminate_confirmed_tree",
      { idempotencyKey: "unsafe-unrelated-process-recovery-target" },
    ));
    assert.equal(unsafeTermination.type, "harness.run.recover.failure");
    assert.equal(unsafeTermination.code, "harness_recovery_action_not_available");
    assert.deepEqual(unsafeTermination.prohibitedSideEffects, {
      recoveryChanged: false,
      processSignalRequested: false,
      terminalOutcomeCreated: false,
      replacementRunStarted: false,
      projectWrite: false,
    });

    const recheckRequest = recoveryRequest(interruptedRun.harnessRunId, "recheck", {
      idempotencyKey: "recognizable-raw-recovery-recheck-key",
    });
    const rechecked = await manager.recover(recheckRequest);
    assert.equal(rechecked.type, "harness.run.recover.result");
    assert.equal(rechecked.code, "harness_recovery_rechecked");
    assert.equal(rechecked.run.status, "recovery_required");
    assert.deepEqual(rechecked.run.recovery.availableActions, ["finalize"]);
    assert.equal(
      rechecked.run.recovery.processObservation.relatedProcessState,
      "terminated_confirmed",
    );
    assert.equal(inspections, 2);

    const replay = await manager.recover({
      ...recheckRequest,
      requestId: "replay-recovery-recheck-after-response-loss",
      controllerId: `runtime-${"9".repeat(24)}`,
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.auditId, rechecked.auditId);
    assert.deepEqual(replay.run, rechecked.run);
    assert.equal(inspections, 2);

    const conflict = await manager.recover(recoveryRequest(
      interruptedRun.harnessRunId,
      "finalize",
      {
        requestId: "conflicting-recovery-action",
        idempotencyKey: "recognizable-raw-recovery-recheck-key",
      },
    ));
    assert.equal(conflict.type, "harness.run.recover.failure");
    assert.equal(conflict.code, "idempotency_key_conflict");
    assert.equal(conflict.prohibitedSideEffects.terminalOutcomeCreated, false);

    const finalized = await manager.recover(recoveryRequest(
      interruptedRun.harnessRunId,
      "finalize",
      { idempotencyKey: "recognizable-raw-recovery-finalize-key" },
    ));
    assert.equal(finalized.type, "harness.run.recover.result");
    assert.equal(finalized.code, "harness_recovery_finalized");
    assert.equal(finalized.run.status, "failed");
    assert.equal(finalized.run.recovery, null);
    assert.equal(finalized.outcome.status, "failed");
    assert.equal(finalized.outcome.code, "host_daemon_interrupted");
    assert.equal(finalized.outcome.incompleteResult, true);
    assert.equal(finalized.outcome.result, null);

    const terminal = await manager.observe({
      requestId: "observe-finalized-recovery",
      harnessRunId: interruptedRun.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(terminal.events.filter((event) =>
      event.type === "harness_run_failed").length, 1);
    assert.deepEqual(terminal.run.executionSnapshot, interruptedRun.executionSnapshot);
    assert.deepEqual(terminal.events.slice(0, -2), interruptedRun.events);
    assert.deepEqual((await readdir(fixture.projectPath)).sort(), projectFilesBefore);
    const retainedText = await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8");
    assert.doesNotMatch(retainedText, /recognizable-raw-recovery/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("every recovery publication fault resumes one hashed mutation without canonical duplication", async () => {
  const fixture = await createFixture("sandking-harness-recovery-boundary-seed-");
  const roots = [];
  try {
    const interruptedManager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      faultInjector: (point) => {
        if (point === "harness_run_launch.after_state_commit") {
          throw new Error("seed_recovery_boundary_state");
        }
      },
    });
    await assert.rejects(interruptedManager.launch(hashedLaunchRequest(launchRequest(
      fixture.registered.project.projectId,
      164,
      { idempotencyKey: "recovery-boundary-seed" },
    ))), /seed_recovery_boundary_state/);
    const seededManager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      inspectInterruptedRunTermination: async () => ({
        platform: process.platform,
        status: "unconfirmed",
      }),
    });
    const seeded = await seededManager.observe({
      requestId: "observe-recovery-boundary-seed",
      harnessRunId: null,
      afterSequence: 0,
    });
    assert.equal(seeded.run.status, "recovery_required");
    const seededStateText = await readFile(
      join(fixture.dataDir, "harness-runs.json"),
      "utf8",
    );
    const faultPoints = [
      "harness_run_recovery.before_intent_commit",
      "harness_run_recovery.after_intent_commit",
      "harness_run_recovery.before_action",
      "harness_run_recovery.after_action",
      "harness_run_recovery.before_result_commit",
      "harness_run_recovery.after_state_commit",
      "harness_run_recovery.after_commit",
    ];

    for (const [index, faultPoint] of faultPoints.entries()) {
      const dataDir = await mkdtemp(join(tmpdir(), `sandking-recovery-boundary-${index}-`));
      roots.push(dataDir);
      await writeFile(join(dataDir, "harness-runs.json"), seededStateText);
      const audits = [];
      const recordAudit = async (action, outcome, details = {}, requestedAuditId) => {
        if (requestedAuditId) {
          const existing = audits.find((audit) => audit.auditId === requestedAuditId);
          if (existing) return requestedAuditId;
        }
        const auditId = requestedAuditId
          ?? `audit-${String(audits.length + 1).padStart(24, "0")}`;
        audits.push({ auditId, action, outcome, details });
        return auditId;
      };
      let interrupt = true;
      let inspections = 0;
      const managerOptions = (faultInjector) => ({
        dataDir,
        hostId,
        recordAudit,
        loadLaunchContext: async () => {
          throw new Error("recovery_resume_must_not_resolve_mutable_launch_context");
        },
        inspectInterruptedRunTermination: async () => {
          inspections += 1;
          return { platform: process.platform, status: "confirmed" };
        },
        ...(faultInjector ? { faultInjector } : {}),
      });
      const manager = await createHarnessRunManager(managerOptions((point) => {
        if (point === faultPoint && interrupt) {
          interrupt = false;
          throw new Error(`injected_${index}_recovery_boundary`);
        }
      }));
      const rawRetryKey = `recognizable-raw-recovery-boundary-${index}`;
      const request = recoveryRequest(seeded.run.harnessRunId, "recheck", {
        requestId: `recover-boundary-${index}`,
        idempotencyKey: rawRetryKey,
      });
      await assert.rejects(manager.recover(request),
        new RegExp(`injected_${index}_recovery_boundary`));
      const afterFault = JSON.parse(
        await readFile(join(dataDir, "harness-runs.json"), "utf8"),
      );
      assert.equal(afterFault.runs.length, 1);
      assert.equal(afterFault.runs[0].events.filter((event) =>
        event.type === "harness_run_recovery_required").length, 1);
      assert.equal(afterFault.runs[0].events.some((event) =>
        ["harness_run_succeeded", "harness_run_failed", "harness_run_cancelled"]
          .includes(event.type)), false);

      const restarted = await createHarnessRunManager(managerOptions());
      const replay = await restarted.recover({
        ...request,
        requestId: `replay-recovery-boundary-${index}`,
      });
      assert.equal(replay.type, "harness.run.recover.result");
      assert.equal(replay.code, "harness_recovery_rechecked");
      assert.equal(replay.run.status, "recovery_required");
      assert.deepEqual(replay.recovery.availableActions, ["finalize"]);
      assert.ok(inspections <= 2);
      const converged = JSON.parse(
        await readFile(join(dataDir, "harness-runs.json"), "utf8"),
      );
      assert.equal(converged.recoveryMutations.length, 1);
      assert.notEqual(converged.recoveryMutations[0].response, null);
      assert.equal(converged.runs[0].events.filter((event) =>
        event.type === "harness_run_recovery_required").length, 1);
      assert.equal(audits.filter((audit) =>
        audit.action === "harness.run.recover"
        && audit.outcome === "accepted").length, 1);
      assert.doesNotMatch(JSON.stringify({ converged, audits }), new RegExp(rawRetryKey));
      qualifyIssue164FaultPoint(
        faultPoint,
        "every recovery publication fault resumes one hashed mutation without canonical duplication",
      );
    }
  } finally {
    await Promise.all([
      rm(fixture.root, { recursive: true, force: true }),
      ...roots.map((root) => rm(root, { recursive: true, force: true })),
    ]);
  }
});

test("recovery termination resumes one identity-bound action without exposing a process target", async () => {
  const fixture = await createFixture("sandking-harness-recovery-termination-");
  try {
    const interruptedManager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      faultInjector: (point) => {
        if (point === "harness_run_launch.after_state_commit") {
          throw new Error("injected_host_death_for_recovery_termination");
        }
      },
    });
    await assert.rejects(interruptedManager.launch(hashedLaunchRequest(launchRequest(
      fixture.registered.project.projectId,
      162_001,
      { idempotencyKey: "recovery-termination-interrupted-launch" },
    ))), /injected_host_death_for_recovery_termination/);
    const interruptedState = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    const harnessRunId = interruptedState.runs[0].harnessRunId;
    const invokedActionIdentities = [];
    const appliedActionIdentities = new Set();
    let processSignals = 0;
    const terminate = async (run, actionIdentity) => {
      assert.equal(run.harnessRunId, harnessRunId);
      assert.equal("pid" in run, false);
      assert.equal("processHandle" in run, false);
      assert.match(actionIdentity.auditId, /^audit-[a-f0-9]{24}$/);
      assert.match(actionIdentity.idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
      const identity = JSON.stringify(actionIdentity);
      invokedActionIdentities.push(identity);
      if (!appliedActionIdentities.has(identity)) {
        appliedActionIdentities.add(identity);
        processSignals += 1;
      }
      return { platform: process.platform, status: "confirmed" };
    };
    let interruptAfterAction = true;
    const manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      inspectInterruptedRunTermination: async () => ({
        platform: process.platform,
        status: "unconfirmed",
        relatedProcessState: "running_confirmed",
        identityProof: "retained_supervision_identity",
        processCount: 3,
        launchSettled: true,
        treeEmpty: false,
        safeToTerminate: true,
      }),
      terminateConfirmedInterruptedRun: terminate,
      faultInjector: (point) => {
        if (point === "harness_run_recovery.after_action" && interruptAfterAction) {
          interruptAfterAction = false;
          throw new Error("injected_recovery_response_loss_after_process_action");
        }
      },
    });
    const before = await manager.observe({
      requestId: "observe-identity-bound-recovery",
      harnessRunId,
      afterSequence: 0,
    });
    assert.deepEqual(before.run.recovery.availableActions, [
      "recheck",
      "terminate_confirmed_tree",
    ]);
    assert.deepEqual({
      relatedProcessState: before.run.recovery.processObservation.relatedProcessState,
      identityProof: before.run.recovery.processObservation.identityProof,
      processCount: before.run.recovery.processObservation.processCount,
      safeToTerminate: before.run.recovery.processObservation.safeToTerminate,
    }, {
      relatedProcessState: "running_confirmed",
      identityProof: "retained_supervision_identity",
      processCount: 3,
      safeToTerminate: true,
    });

    const request = recoveryRequest(harnessRunId, "terminate_confirmed_tree", {
      idempotencyKey: "recognizable-raw-recovery-termination-key",
    });
    await assert.rejects(
      manager.recover(request),
      /injected_recovery_response_loss_after_process_action/,
    );
    const pending = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    ).recoveryMutations[0];
    assert.equal(pending.response, null);
    assert.equal(processSignals, 1);

    const restarted = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      inspectInterruptedRunTermination: async () => {
        throw new Error("pending_termination_must_resume_without_reinspection");
      },
      terminateConfirmedInterruptedRun: terminate,
    });
    assert.equal(invokedActionIdentities.length, 2);
    assert.equal(invokedActionIdentities[0], invokedActionIdentities[1]);
    assert.equal(processSignals, 1);
    const replay = await restarted.recover({
      ...request,
      requestId: "replay-resumed-recovery-termination",
      controllerId: `runtime-${"8".repeat(24)}`,
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.code, "harness_recovery_termination_confirmed");
    assert.deepEqual(replay.run.recovery.availableActions, ["finalize"]);
    assert.equal(invokedActionIdentities.length, 2);
    const lookup = await restarted.lookupRecovery({
      requestId: "lookup-resumed-recovery-termination",
      idempotencyKey: "recognizable-raw-recovery-termination-key",
    });
    assert.equal(lookup.found, true);
    assert.equal(lookup.pending, false);
    assert.equal(lookup.recoveryOutcome.auditId, replay.auditId);
    const retainedText = await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8");
    assert.doesNotMatch(retainedText, /recognizable-raw-recovery-termination-key/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("reconciliation commit boundaries converge idempotently after repeated startup", async () => {
  const preCommit = await createFixture("sandking-harness-reconcile-pre-commit-");
  const stateCommit = await createFixture("sandking-harness-reconcile-state-commit-");
  const postCommit = await createFixture("sandking-harness-reconcile-post-commit-");
  const seedInterruptedLaunch = async (fixture, key) => {
    const manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      faultInjector: (point) => {
        if (point === "harness_run_launch.after_state_commit") {
          throw new Error(`injected_${key}_launch_interrupt`);
        }
      },
    });
    const request = hashedLaunchRequest(launchRequest(
      fixture.registered.project.projectId,
      160,
      { idempotencyKey: key },
    ));
    await assert.rejects(manager.launch(request), new RegExp(`injected_${key}`));
    return request;
  };
  const restartOptions = (fixture, faultInjector) => ({
    dataDir: fixture.dataDir,
    hostId,
    recordAudit: fixture.recordAudit,
    loadLaunchContext: async () => {
      throw new Error("startup_reconciliation_must_not_launch_an_adapter");
    },
    inspectInterruptedRunTermination: async () => ({
      platform: process.platform,
      status: "confirmed",
    }),
    ...(faultInjector ? { faultInjector } : {}),
  });
  try {
    await seedInterruptedLaunch(preCommit, "reconcile-pre-commit");
    await assert.rejects(createHarnessRunManager(restartOptions(
      preCommit,
      (point) => {
        if (point === "harness_run_reconciliation.before_commit") {
          throw new Error("injected_reconciliation_pre_commit_interrupt");
        }
      },
    )), /injected_reconciliation_pre_commit_interrupt/);
    const preFaultState = JSON.parse(
      await readFile(join(preCommit.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(preFaultState.runs[0].status, "starting");
    assert.equal(preFaultState.runs[0].outcome, null);
    assert.equal(preCommit.audits.some((audit) =>
      audit.action === "harness.run.reconcile"), false);
    await createHarnessRunManager(restartOptions(preCommit));
    const preRecoveredState = JSON.parse(
      await readFile(join(preCommit.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(preRecoveredState.runs[0].status, "failed");
    await createHarnessRunManager(restartOptions(preCommit));
    assert.deepEqual(JSON.parse(
      await readFile(join(preCommit.dataDir, "harness-runs.json"), "utf8"),
    ), preRecoveredState);
    assert.equal(preCommit.audits.filter((audit) =>
      audit.action === "harness.run.reconcile").length, 1);
    qualifyIssue164FaultPoint(
      "harness_run_reconciliation.before_commit",
      "reconciliation commit boundaries converge idempotently after repeated startup",
    );

    await seedInterruptedLaunch(stateCommit, "reconcile-state-commit");
    await assert.rejects(createHarnessRunManager(restartOptions(
      stateCommit,
      (point) => {
        if (point === "harness_run_reconciliation.after_state_commit") {
          throw new Error("injected_reconciliation_state_commit_interrupt");
        }
      },
    )), /injected_reconciliation_state_commit_interrupt/);
    const committed = JSON.parse(
      await readFile(join(stateCommit.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(committed.runs[0].status, "failed");
    assert.equal(committed.runs[0].outcome.code, "host_daemon_interrupted");
    assert.equal(stateCommit.audits.some((audit) =>
      audit.action === "harness.run.reconcile"), false);
    assert.equal(stateCommit.audits.some((audit) =>
      audit.action === "harness.run.outcome"), false);

    await createHarnessRunManager(restartOptions(stateCommit));
    const repaired = JSON.parse(
      await readFile(join(stateCommit.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.deepEqual(repaired, committed);
    await createHarnessRunManager(restartOptions(stateCommit));
    const repeated = JSON.parse(
      await readFile(join(stateCommit.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.deepEqual(repeated, committed);
    assert.equal(stateCommit.audits.filter((audit) =>
      audit.action === "harness.run.reconcile").length, 1);
    assert.equal(stateCommit.audits.filter((audit) =>
      audit.action === "harness.run.outcome").length, 1);
    assert.equal(repeated.runs[0].events.filter((event) =>
      event.type === "harness_run_failed").length, 1);
    qualifyIssue164FaultPoint(
      "harness_run_reconciliation.after_state_commit",
      "reconciliation commit boundaries converge idempotently after repeated startup",
    );

    await seedInterruptedLaunch(postCommit, "reconcile-post-commit");
    await assert.rejects(createHarnessRunManager(restartOptions(
      postCommit,
      (point) => {
        if (point === "harness_run_reconciliation.after_commit") {
          throw new Error("injected_reconciliation_post_commit_interrupt");
        }
      },
    )), /injected_reconciliation_post_commit_interrupt/);
    const fullyCommitted = JSON.parse(
      await readFile(join(postCommit.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(fullyCommitted.runs[0].status, "failed");
    assert.equal(fullyCommitted.runs[0].outcome.code, "host_daemon_interrupted");
    assert.equal(postCommit.audits.filter((audit) =>
      audit.action === "harness.run.reconcile").length, 1);
    assert.equal(postCommit.audits.filter((audit) =>
      audit.action === "harness.run.outcome").length, 1);
    await createHarnessRunManager(restartOptions(postCommit));
    await createHarnessRunManager(restartOptions(postCommit));
    assert.deepEqual(JSON.parse(
      await readFile(join(postCommit.dataDir, "harness-runs.json"), "utf8"),
    ), fullyCommitted);
    assert.equal(postCommit.audits.filter((audit) =>
      audit.action === "harness.run.reconcile").length, 1);
    assert.equal(postCommit.audits.filter((audit) =>
      audit.action === "harness.run.outcome").length, 1);
    qualifyIssue164FaultPoint(
      "harness_run_reconciliation.after_commit",
      "reconciliation commit boundaries converge idempotently after repeated startup",
    );
  } finally {
    await Promise.all([
      rm(preCommit.root, { recursive: true, force: true }),
      rm(stateCommit.root, { recursive: true, force: true }),
      rm(postCommit.root, { recursive: true, force: true }),
    ]);
  }
});

test("startup repairs the view around a previously accepted terminal envelope", async () => {
  const fixture = await createFixture("sandking-harness-reconcile-terminal-wins-");
  try {
    const launched = await fixture.manager.launch(launchRequest(
      fixture.registered.project.projectId,
      160,
    ));
    const terminal = await waitForTerminal(fixture.manager, launched.run.harnessRunId);
    assert.equal(terminal.run.status, "succeeded");
    assert.equal(terminal.terminalEnvelopeValidation.exactlyOne, true);
    const statePath = join(fixture.dataDir, "harness-runs.json");
    const accepted = JSON.parse(await readFile(statePath, "utf8"));
    const acceptedOutcome = structuredClone(accepted.runs[0].outcome);
    const acceptedEvents = structuredClone(accepted.runs[0].events);
    accepted.runs[0].status = "running";
    accepted.runs[0].completedAt = null;
    await writeFile(statePath, `${JSON.stringify(accepted, null, 2)}\n`);

    const restarted = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("accepted_terminal_repair_must_not_resolve_launch_context");
      },
    });
    const repaired = await restarted.observe({
      requestId: "observe-repaired-terminal-view",
      harnessRunId: launched.run.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(repaired.run.status, "succeeded");
    assert.equal(repaired.run.completedAt, acceptedOutcome.completedAt);
    assert.deepEqual(repaired.outcome, acceptedOutcome);
    assert.deepEqual(repaired.events, acceptedEvents);
    assert.equal(repaired.events.filter((event) =>
      event.type === "harness_run_succeeded").length, 1);
    assert.equal(fixture.audits.some((audit) =>
      audit.action === "harness.run.reconcile"), false);

    const repairedState = JSON.parse(await readFile(statePath, "utf8"));
    await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("repeated_terminal_repair_must_not_resolve_launch_context");
      },
    });
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), repairedState);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
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
    assert.equal(retained.schemaVersion, 8);
    assert.equal(retained.launchOutcomes.length, 257);
    assert.deepEqual(retained.cancellationOutcomes, []);
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

    const v4 = JSON.parse(await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"));
    const acceptedLaunchOutcome = structuredClone(v4.launchOutcomes[0].response);
    const v2 = structuredClone(v4);
    v2.schemaVersion = 2;
    delete v2.cancellationOutcomes;
    delete v2.recoveryMutations;
    for (const run of v2.runs) {
      delete run.executionSnapshot;
      delete run.cancellation;
      delete run.recovery;
      delete run.cancellationReconciliation;
      delete run.launchIdempotencyKeyHash;
    }
    for (const outcome of [...v2.launchOutcomes, ...v2.legacyStartOutcomes]) {
      if (outcome.response?.run) {
        delete outcome.response.run.executionSnapshot;
        delete outcome.response.run.cancellation;
        delete outcome.response.run.recovery;
        delete outcome.response.run.launchIdempotencyKeyHash;
      }
    }
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
    assert.equal(migrated.schemaVersion, 8);
    const { executionSnapshot: migratedSnapshot, ...migratedHistory } = migrated.runs[0];
    const { executionSnapshot: originalSnapshot, ...originalHistory } = v4.runs[0];
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
      productionHarness: null,
      launchAuditId: originalHistory.launchAuditId,
    });
    assert.deepEqual(migrated.runs[0].events, v4.runs[0].events);
    assert.deepEqual(migrated.runs[0].outcome, v4.runs[0].outcome);
    assert.deepEqual(migrated.runs[0].logStreams, v4.runs[0].logStreams);
    assert.deepEqual(migrated.cancellationOutcomes, []);
    const migratedLaunchOutcome = migrated.launchOutcomes[0].response;
    const { executionSnapshot: retainedOutcomeSnapshot, ...retainedOutcomeRun } =
      migratedLaunchOutcome.run;
    const { executionSnapshot: acceptedOutcomeSnapshot, ...acceptedOutcomeRun } =
      acceptedLaunchOutcome.run;
    void acceptedOutcomeSnapshot;
    assert.deepEqual(retainedOutcomeRun, acceptedOutcomeRun);
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

test("migration commit interruptions retry without losing or duplicating canonical history", async () => {
  const fixture = await createFixture("sandking-harness-migration-boundaries-seed-");
  const roots = [];
  try {
    const launched = await fixture.manager.launch(launchRequest(
      fixture.registered.project.projectId,
      164,
      { idempotencyKey: "migration-boundary-launch" },
    ));
    await waitForTerminal(fixture.manager, launched.run.harnessRunId);
    const current = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    const legacy = structuredClone(current);
    legacy.schemaVersion = 2;
    delete legacy.cancellationOutcomes;
    delete legacy.recoveryMutations;
    for (const run of legacy.runs) {
      delete run.executionSnapshot;
      delete run.cancellation;
      delete run.recovery;
      delete run.cancellationReconciliation;
      delete run.launchIdempotencyKeyHash;
    }
    for (const outcome of [...legacy.launchOutcomes, ...legacy.legacyStartOutcomes]) {
      if (!outcome.response?.run) continue;
      delete outcome.response.run.executionSnapshot;
      delete outcome.response.run.cancellation;
      delete outcome.response.run.recovery;
      delete outcome.response.run.launchIdempotencyKeyHash;
    }
    const legacyText = `${JSON.stringify(legacy, null, 2)}\n`;
    const makeBoundary = async (name) => {
      const dataDir = await mkdtemp(join(tmpdir(), `sandking-migration-${name}-`));
      roots.push(dataDir);
      await writeFile(join(dataDir, "harness-runs.json"), legacyText);
      const audits = [];
      return {
        dataDir,
        audits,
        recordAudit: async (action, outcome, details, auditId) => {
          if (!audits.some((audit) => audit.auditId === auditId)) {
            audits.push({ action, outcome, details, auditId });
          }
          return auditId;
        },
      };
    };
    const optionsFor = (boundary, faultInjector) => ({
      dataDir: boundary.dataDir,
      hostId,
      recordAudit: boundary.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("migration_must_not_resolve_mutable_launch_context");
      },
      ...(faultInjector ? { faultInjector } : {}),
    });

    const before = await makeBoundary("before-commit");
    const beforePoints = [];
    await assert.rejects(createHarnessRunManager(optionsFor(before, (point) => {
      beforePoints.push(point);
      if (point === "harness_run_migration.before_commit") {
        throw new Error("injected_migration_before_commit");
      }
    })), /injected_migration_before_commit/);
    assert.deepEqual(beforePoints, ["harness_run_migration.before_commit"]);
    assert.equal(await readFile(join(before.dataDir, "harness-runs.json"), "utf8"), legacyText);
    await createHarnessRunManager(optionsFor(before));
    const retriedBefore = JSON.parse(
      await readFile(join(before.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(retriedBefore.schemaVersion, 8);
    qualifyIssue164FaultPoint(
      "harness_run_migration.before_commit",
      "migration commit interruptions retry without losing or duplicating canonical history",
    );

    const afterState = await makeBoundary("after-state-commit");
    const statePoints = [];
    await assert.rejects(createHarnessRunManager(optionsFor(afterState, (point) => {
      statePoints.push(point);
      if (point === "harness_run_migration.after_state_commit") {
        throw new Error("injected_migration_after_state_commit");
      }
    })), /injected_migration_after_state_commit/);
    assert.deepEqual(statePoints, [
      "harness_run_migration.before_commit",
      "harness_run_migration.after_state_commit",
    ]);
    const committed = JSON.parse(
      await readFile(join(afterState.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(committed.schemaVersion, 8);
    assert.equal(committed.runs.length, 1);
    assert.equal(committed.runs[0].status, "succeeded");
    assert.equal(committed.runs[0].events.filter((event) =>
      event.type === "harness_run_succeeded").length, 1);
    assert.equal(afterState.audits.length, 0);
    await createHarnessRunManager(optionsFor(afterState));
    assert.deepEqual(
      JSON.parse(await readFile(join(afterState.dataDir, "harness-runs.json"), "utf8")),
      committed,
    );
    assert.ok(afterState.audits.some((audit) => audit.action === "harness.run.launch"));
    assert.ok(afterState.audits.some((audit) => audit.action === "harness.run.outcome"));
    qualifyIssue164FaultPoint(
      "harness_run_migration.after_state_commit",
      "migration commit interruptions retry without losing or duplicating canonical history",
    );

    const afterCommit = await makeBoundary("after-commit");
    const commitPoints = [];
    await assert.rejects(createHarnessRunManager(optionsFor(afterCommit, (point) => {
      commitPoints.push(point);
      if (point === "harness_run_migration.after_commit") {
        throw new Error("injected_migration_after_commit");
      }
    })), /injected_migration_after_commit/);
    assert.deepEqual(commitPoints, [
      "harness_run_migration.before_commit",
      "harness_run_migration.after_state_commit",
      "harness_run_migration.after_commit",
    ]);
    const fullyCommitted = JSON.parse(
      await readFile(join(afterCommit.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.deepEqual(fullyCommitted, committed);
    const auditCount = afterCommit.audits.length;
    await createHarnessRunManager(optionsFor(afterCommit));
    assert.equal(afterCommit.audits.length, auditCount);
    assert.deepEqual(
      JSON.parse(await readFile(join(afterCommit.dataDir, "harness-runs.json"), "utf8")),
      fullyCommitted,
    );
    qualifyIssue164FaultPoint(
      "harness_run_migration.after_commit",
      "migration commit interruptions retry without losing or duplicating canonical history",
    );
  } finally {
    await Promise.all([
      rm(fixture.root, { recursive: true, force: true }),
      ...roots.map((root) => rm(root, { recursive: true, force: true })),
    ]);
  }
});

test("schema-v3 immutable execution history gains cancellation state without rewriting history", async () => {
  const fixture = await createFixture("sandking-harness-v3-upgrade-");
  try {
    const request = launchRequest(fixture.registered.project.projectId, 159);
    const launched = await fixture.manager.launch(request);
    await waitForTerminal(fixture.manager, launched.run.harnessRunId);
    const current = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    const v3 = structuredClone(current);
    v3.schemaVersion = 3;
    delete v3.cancellationOutcomes;
    delete v3.recoveryMutations;
    for (const run of v3.runs) {
      delete run.cancellation;
      delete run.recovery;
      delete run.cancellationReconciliation;
      delete run.launchIdempotencyKeyHash;
    }
    for (const outcome of [...v3.launchOutcomes, ...v3.legacyStartOutcomes]) {
      if (outcome.response?.run) {
        delete outcome.response.run.cancellation;
        delete outcome.response.run.recovery;
        delete outcome.response.run.launchIdempotencyKeyHash;
      }
    }
    await writeFile(join(fixture.dataDir, "harness-runs.json"), `${JSON.stringify(v3)}\n`);

    const manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
    });
    const migrated = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(migrated.schemaVersion, 8);
    assert.deepEqual(migrated.cancellationOutcomes, []);
    assert.equal(migrated.runs[0].cancellation, null);
    const {
      cancellation,
      recovery,
      cancellationReconciliation,
      launchIdempotencyKeyHash,
      ...migratedHistory
    } = migrated.runs[0];
    void cancellation;
    assert.equal(recovery, null);
    assert.equal(cancellationReconciliation, null);
    assert.deepEqual(migratedHistory, v3.runs[0]);
    assert.equal(launchIdempotencyKeyHash, v3.launchOutcomes[0].idempotencyKeyHash);
    assert.equal(migrated.launchOutcomes[0].response.run.cancellation, null);
    assert.equal(migrated.launchOutcomes[0].response.run.recovery, null);
    assert.equal(
      migrated.launchOutcomes[0].response.run.launchIdempotencyKeyHash,
      v3.launchOutcomes[0].idempotencyKeyHash,
    );
    const observation = await manager.observe({
      requestId: "observe-migrated-v3-run",
      harnessRunId: launched.run.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(observation.run.cancellation, null);
    assert.deepEqual(observation.outcome, current.runs[0].outcome);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("schema-v4 terminal history gains reconciliation metadata without changing its truth", async () => {
  const fixture = await createFixture("sandking-harness-v4-upgrade-");
  try {
    const request = hashedLaunchRequest(launchRequest(
      fixture.registered.project.projectId,
      160,
      {
        source: "cockpit",
        controllerSessionId: null,
        idempotencyKey: "schema-v4-cockpit-launch",
      },
    ));
    const launched = await fixture.manager.launch(request);
    await waitForTerminal(fixture.manager, launched.run.harnessRunId);
    const current = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    const v4 = structuredClone(current);
    v4.schemaVersion = 4;
    delete v4.recoveryMutations;
    delete v4.runs[0].recovery;
    delete v4.runs[0].cancellationReconciliation;
    delete v4.launchOutcomes[0].response.run.recovery;
    delete v4.runs[0].outcome.outcomeAuditId;
    delete v4.runs[0].outcome.interruption;
    delete v4.runs[0].launchIdempotencyKeyHash;
    delete v4.launchOutcomes[0].response.run.launchIdempotencyKeyHash;
    v4.launchOutcomes[0].requestFingerprint = schemaV4LaunchRequestFingerprint(request);
    await writeFile(join(fixture.dataDir, "harness-runs.json"), `${JSON.stringify(v4)}\n`);

    const manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("terminal_migration_must_not_resolve_mutable_launch_context");
      },
    });
    const migrated = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(migrated.schemaVersion, 8);
    assert.equal(migrated.runs[0].outcome.outcomeAuditId, null);
    assert.equal(migrated.runs[0].outcome.interruption, null);
    assert.equal(
      migrated.runs[0].launchIdempotencyKeyHash,
      v4.launchOutcomes[0].idempotencyKeyHash,
    );
    const migratedWithoutMetadata = structuredClone(migrated);
    migratedWithoutMetadata.schemaVersion = 4;
    delete migratedWithoutMetadata.recoveryMutations;
    delete migratedWithoutMetadata.runs[0].recovery;
    delete migratedWithoutMetadata.runs[0].cancellationReconciliation;
    delete migratedWithoutMetadata.launchOutcomes[0].response.run.recovery;
    delete migratedWithoutMetadata.runs[0].outcome.outcomeAuditId;
    delete migratedWithoutMetadata.runs[0].outcome.interruption;
    delete migratedWithoutMetadata.runs[0].launchIdempotencyKeyHash;
    delete migratedWithoutMetadata.launchOutcomes[0].response.run.launchIdempotencyKeyHash;
    assert.notEqual(
      migratedWithoutMetadata.launchOutcomes[0].requestFingerprint,
      v4.launchOutcomes[0].requestFingerprint,
    );
    migratedWithoutMetadata.launchOutcomes[0].requestFingerprint =
      v4.launchOutcomes[0].requestFingerprint;
    assert.deepEqual(migratedWithoutMetadata, v4);

    const observation = await manager.observe({
      requestId: "observe-migrated-v4-terminal-run",
      harnessRunId: launched.run.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(observation.run.status, current.runs[0].status);
    assert.equal(observation.outcome.outcomeId, current.runs[0].outcome.outcomeId);
    assert.deepEqual(observation.events, current.runs[0].events);
    assert.equal(fixture.audits.some((audit) =>
      audit.action === "harness.run.reconcile"
      && audit.details.harnessRunId === launched.run.harnessRunId), false);

    const replay = await manager.launch({
      ...request,
      requestId: "reconnect-schema-v4-cockpit-launch",
      controllerId: `runtime-${"8".repeat(24)}`,
    });
    assert.equal(replay.type, "harness.run.launch.result");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.run.harnessRunId, launched.run.harnessRunId);
    assert.equal(replay.run.controllerId, controllerId);
    const afterReplay = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(afterReplay.runs.length, 1);
    assert.equal(afterReplay.launchOutcomes.length, 1);
    assert.deepEqual(afterReplay.runs[0].events, migrated.runs[0].events);
    assert.deepEqual(afterReplay.runs[0].outcome, migrated.runs[0].outcome);

    await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("terminal_restart_must_not_resolve_mutable_launch_context");
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

test("startup repairs launch fingerprints retained by the initial schema-v5 migration", async () => {
  const fixture = await createFixture("sandking-harness-v5-launch-fingerprint-repair-");
  try {
    const request = hashedLaunchRequest(launchRequest(
      fixture.registered.project.projectId,
      160,
      {
        source: "cockpit",
        controllerSessionId: null,
        idempotencyKey: "initial-schema-v5-cockpit-launch",
      },
    ));
    const launched = await fixture.manager.launch(request);
    await waitForTerminal(fixture.manager, launched.run.harnessRunId);

    const staleV5 = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    staleV5.schemaVersion = 5;
    delete staleV5.recoveryMutations;
    for (const run of staleV5.runs) {
      delete run.recovery;
      delete run.cancellationReconciliation;
    }
    for (const outcome of [...staleV5.launchOutcomes, ...staleV5.legacyStartOutcomes]) {
      if (outcome.response?.run) delete outcome.response.run.recovery;
    }
    const staleFingerprint = schemaV4LaunchRequestFingerprint(request);
    staleV5.launchOutcomes[0].requestFingerprint = staleFingerprint;
    await writeFile(
      join(fixture.dataDir, "harness-runs.json"),
      `${JSON.stringify(staleV5)}\n`,
    );

    const repairedManager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("retained_launch_repair_must_not_resolve_mutable_launch_context");
      },
    });
    const repaired = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.notEqual(repaired.launchOutcomes[0].requestFingerprint, staleFingerprint);

    const replay = await repairedManager.launch({
      ...request,
      requestId: "reconnect-initial-schema-v5-cockpit-launch",
      controllerId: `runtime-${"8".repeat(24)}`,
    });
    assert.equal(replay.type, "harness.run.launch.result");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.run.harnessRunId, launched.run.harnessRunId);

    const conflict = await repairedManager.launch({
      ...request,
      requestId: "conflict-initial-schema-v5-cockpit-launch",
      controllerId: `runtime-${"8".repeat(24)}`,
      parameters: { issueNumber: 161, targetBranch: "sandcastle/issue-161" },
    });
    assert.equal(conflict.code, "idempotency_key_conflict");
    assert.equal(conflict.prohibitedSideEffects.harnessRunCreated, false);

    await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("retained_launch_restart_must_not_resolve_mutable_launch_context");
      },
    });
    assert.deepEqual(
      JSON.parse(await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8")),
      repaired,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("schema-v6 accepted cancellation migrates and replays across Controller replacement", async () => {
  const fixture = await createFixture("sandking-harness-v6-cancellation-upgrade-");
  let interruptLaunchOnce = true;
  try {
    const interrupted = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      faultInjector: (point) => {
        if (point === "harness_run_launch.after_state_commit" && interruptLaunchOnce) {
          interruptLaunchOnce = false;
          throw new Error("create_schema_v6_cancellation_without_supervision");
        }
        if (point === "harness_run_cancellation.after_state_commit") {
          throw new Error("retain_schema_v6_accepted_cancellation");
        }
      },
    });
    await assert.rejects(interrupted.launch(launchRequest(
      fixture.registered.project.projectId,
      999_999_993,
    )), /create_schema_v6_cancellation_without_supervision/);
    const launchedState = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    const request = cancellationRequest(launchedState.runs[0].harnessRunId, {
      idempotencyKey: "schema-v6-accepted-cancellation-key",
    });
    await assert.rejects(
      interrupted.cancel(request),
      /retain_schema_v6_accepted_cancellation/,
    );

    const v6 = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    v6.schemaVersion = 6;
    delete v6.recoveryMutations;
    for (const run of v6.runs) delete run.cancellationReconciliation;
    v6.cancellationOutcomes[0].requestFingerprint =
      schemaV6CancellationRequestFingerprint(request);
    await writeFile(
      join(fixture.dataDir, "harness-runs.json"),
      `${JSON.stringify(v6, null, 2)}\n`,
    );
    await writeFile(join(fixture.dataDir, "audit.jsonl"), `${JSON.stringify({
      auditId: `audit-${"7".repeat(24)}`,
      action: "host.negotiate",
      outcome: "accepted",
      details: { controllerId },
      recordedAt: "2026-08-09T18:00:00.000Z",
    })}\n`);

    const migratedManager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("schema_v6_cancellation_must_not_resolve_launch_context");
      },
      inspectInterruptedRunTermination: async () => ({
        platform: process.platform,
        status: "confirmed",
      }),
    });
    const migrated = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(migrated.schemaVersion, 8);
    assert.equal(migrated.runs[0].status, "cancelled");
    assert.equal(migrated.runs[0].cancellationReconciliation.previousStatus,
      "cancelling");
    assert.equal(migrated.runs[0].events.filter((event) =>
      event.type === "harness_run_cancelled").length, 1);

    const replay = await migratedManager.cancel({
      ...request,
      requestId: "replay-schema-v6-cancellation-after-controller-replacement",
      controllerId: `runtime-${"8".repeat(24)}`,
    });
    assert.equal(replay.code, "harness_run_cancellation_accepted");
    assert.equal(replay.idempotentReplay, true);
    const conflict = await migratedManager.cancel({
      ...request,
      requestId: "conflict-schema-v6-cancellation-after-migration",
      controllerId: `runtime-${"8".repeat(24)}`,
      source: "cockpit",
      controllerSessionId: null,
    });
    assert.equal(conflict.code, "idempotency_key_conflict");
    assert.equal(conflict.prohibitedSideEffects.cooperativeSignalSent, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("schema-v4 rejected launch outcomes replay under their original fingerprint", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-harness-v4-rejection-upgrade-"));
  let auditSequence = 0;
  const options = {
    dataDir,
    hostId,
    recordAudit: async () => {
      auditSequence += 1;
      return `audit-${String(auditSequence).padStart(24, "0")}`;
    },
    loadLaunchContext: async () => {
      throw new Error("project_not_found");
    },
  };
  try {
    const request = hashedLaunchRequest(launchRequest(
      `project-${"7".repeat(24)}`,
      160,
      {
        source: "cockpit",
        controllerSessionId: null,
        idempotencyKey: "schema-v4-rejected-cockpit-launch",
      },
    ));
    const originalManager = await createHarnessRunManager(options);
    const original = await originalManager.launch(request);
    assert.equal(original.code, "project_not_found");

    const v4 = JSON.parse(await readFile(join(dataDir, "harness-runs.json"), "utf8"));
    v4.schemaVersion = 4;
    delete v4.recoveryMutations;
    v4.launchOutcomes[0].requestFingerprint = schemaV4LaunchRequestFingerprint(request);
    await writeFile(join(dataDir, "harness-runs.json"), `${JSON.stringify(v4)}\n`);
    await writeFile(join(dataDir, "audit.jsonl"), `${JSON.stringify({
      auditId: `audit-${"9".repeat(24)}`,
      action: "host.negotiate",
      outcome: "accepted",
      details: { controllerId },
      recordedAt: "2026-08-09T12:00:00.000Z",
    })}\n`);

    const migratedManager = await createHarnessRunManager(options);
    const replacementControllerId = `runtime-${"8".repeat(24)}`;
    const legacyConflict = await migratedManager.launch({
      ...request,
      requestId: "conflict-before-schema-v4-rejected-replay",
      controllerId: replacementControllerId,
      parameters: { issueNumber: 161, targetBranch: "sandcastle/issue-161" },
    });
    assert.equal(legacyConflict.code, "idempotency_key_conflict");
    assert.equal(legacyConflict.prohibitedSideEffects.harnessRunCreated, false);
    const replay = await migratedManager.launch({
      ...request,
      requestId: "replay-schema-v4-rejected-cockpit-launch",
      controllerId: replacementControllerId,
    });
    assert.equal(replay.type, "harness.run.launch.failure");
    assert.equal(replay.code, "project_not_found");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.auditId, original.auditId);

    const normalized = JSON.parse(await readFile(join(dataDir, "harness-runs.json"), "utf8"));
    assert.notEqual(
      normalized.launchOutcomes[0].requestFingerprint,
      v4.launchOutcomes[0].requestFingerprint,
    );
    await rm(join(dataDir, "audit.jsonl"));
    const restartedManager = await createHarnessRunManager(options);
    const repeatedReplay = await restartedManager.launch({
      ...request,
      requestId: "repeat-schema-v4-rejected-cockpit-launch",
      controllerId: `runtime-${"6".repeat(24)}`,
    });
    assert.equal(repeatedReplay.code, "project_not_found");
    assert.equal(repeatedReplay.idempotentReplay, true);

    const conflict = await restartedManager.launch({
      ...request,
      requestId: "conflict-schema-v4-rejected-cockpit-launch",
      controllerId: replacementControllerId,
      parameters: { issueNumber: 161, targetBranch: "sandcastle/issue-161" },
    });
    assert.equal(conflict.code, "idempotency_key_conflict");
    assert.equal(conflict.prohibitedSideEffects.harnessRunCreated, false);
    const retained = JSON.parse(await readFile(join(dataDir, "harness-runs.json"), "utf8"));
    assert.equal(retained.schemaVersion, 8);
    assert.equal(retained.runs.length, 0);
    assert.equal(retained.launchOutcomes.length, 1);
    assert.equal(
      retained.launchOutcomes[0].requestFingerprint,
      normalized.launchOutcomes[0].requestFingerprint,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("reconciliation retains adapter readiness from durable running history", async () => {
  const fixture = await createFixture("sandking-harness-running-readiness-repair-");
  try {
    const launched = await fixture.manager.launch(launchRequest(
      fixture.registered.project.projectId,
      160,
    ));
    await waitForTerminal(fixture.manager, launched.run.harnessRunId);
    const retainedPath = join(fixture.dataDir, "harness-runs.json");
    const interrupted = JSON.parse(await readFile(retainedPath, "utf8"));
    const run = interrupted.runs[0];
    run.status = "running";
    run.completedAt = null;
    run.outcome = null;
    run.events = run.events.filter((event) => event.type !== "harness_run_succeeded");
    run.terminalEnvelopeValidation = {
      adapterReadyObserved: false,
      validTerminalEnvelopeCount: 0,
      exactlyOne: false,
      adapterChannelClosedObserved: false,
      processExitObserved: false,
    };
    assert.ok(run.adapterReadyAt);
    assert.equal(run.events.some((event) => event.type === "harness_adapter_ready"), true);
    await writeFile(retainedPath, `${JSON.stringify(interrupted)}\n`);

    const restarted = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => {
        throw new Error("running_reconciliation_must_not_resolve_launch_context");
      },
      inspectInterruptedRunTermination: async () => ({
        platform: process.platform,
        status: "confirmed",
      }),
    });
    const observation = await restarted.observe({
      requestId: "observe-reconciled-running-readiness",
      harnessRunId: run.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(observation.outcome.interruption.previousStatus, "running");
    assert.equal(observation.terminalEnvelopeValidation.adapterReadyObserved, true);
    const outcomeAudit = fixture.audits.find((audit) =>
      audit.auditId === observation.outcome.outcomeAuditId);
    assert.equal(outcomeAudit?.details.adapterReadyObserved, true);
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
    assert.equal(initialized.schemaVersion, 8);
    const [{
      executionSnapshot,
      cancellation,
      recovery,
      cancellationReconciliation,
      ...migratedLegacyRun
    }] =
      initialized.runs;
    assert.deepEqual(migratedLegacyRun, legacyRun);
    assert.equal(cancellation, null);
    assert.equal(recovery, null);
    assert.equal(cancellationReconciliation, null);
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
      productionHarness: null,
    });
    assert.deepEqual(initialized.launchOutcomes, []);
    assert.deepEqual(initialized.cancellationOutcomes, []);
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
      cancellation: null,
      recovery: null,
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
    assert.equal(migrated.schemaVersion, 8);
    assert.deepEqual(migrated.runs, initialized.runs);
    assert.deepEqual(migrated.launchOutcomes, []);
    assert.deepEqual(migrated.cancellationOutcomes, []);
    assert.deepEqual(migrated.legacyStartOutcomes, initialized.legacyStartOutcomes);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("issue 164 retains one executed restart result for every declared fault point", async () => {
  const results = await retainIssue164FaultPointResults();
  assert.ok(results.every((result) => result.passed));
});
