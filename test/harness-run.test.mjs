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

const execFileAsync = promisify(execFile);
const hostId = `host-${"1".repeat(24)}`;
const controllerId = `runtime-${"2".repeat(24)}`;
const controllerSessionId = `controller-session-${"3".repeat(24)}`;

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

test("accepted cancellation terminates once and replays without another lifecycle transition", async () => {
  const fixture = await createFixture("sandking-harness-run-cancellation-");
  const projectFilesBefore = (await readdir(fixture.projectPath)).sort();
  const rawRetryKey = "recognizable-raw-cancellation-retry-key";
  try {
    const launched = await fixture.manager.launch(launchRequest(
      fixture.registered.project.projectId,
      161,
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
    assert.deepEqual(terminal.events.map((event) => event.type), [
      "harness_run_created",
      "harness_adapter_ready",
      "harness_run_cancellation_accepted",
      "harness_run_cancelled",
    ]);

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

test("uncertain termination confirmation never invents a cancelled outcome", async () => {
  const fixture = await createFixture("sandking-harness-run-cancel-uncertain-");
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
        if (point === "harness_run_cancellation.before_termination_confirmation_commit") {
          reportConfirmationAttempt();
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
    await confirmationAttempted;

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
    await outcomeCommitReached;
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
    await outcomeCommitReached;
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
    await stateCommitReached;

    const committed = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    assert.equal(committed.schemaVersion, 5);
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
    const statePath = join(fixture.dataDir, "harness-runs.json");
    const retained = JSON.parse(await readFile(statePath, "utf8"));
    const run = retained.runs[0];
    const recordedAt = new Date().toISOString();
    for (let index = 0; index < 1_021; index += 1) {
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
    });
    const postReplay = await postRestarted.launch({
      ...postRequest,
      requestId: "replay-complete-post-commit-launch",
    });
    assert.equal(postReplay.idempotentReplay, true);
    assert.equal(postReplay.run.harnessRunId, postState.runs[0].harnessRunId);
    assert.equal(postCommit.audits.filter((audit) =>
      audit.action === "harness.run.launch" && audit.outcome === "accepted").length, 1);

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
    assert.equal(reachedReconciliationCommit, true);
    let startupResolved = false;
    void startup.then(() => {
      startupResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(startupResolved, false);
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

test("reconciliation commit boundaries converge idempotently after repeated startup", async () => {
  const preCommit = await createFixture("sandking-harness-reconcile-pre-commit-");
  const stateCommit = await createFixture("sandking-harness-reconcile-state-commit-");
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
  } finally {
    await Promise.all([
      rm(preCommit.root, { recursive: true, force: true }),
      rm(stateCommit.root, { recursive: true, force: true }),
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
    assert.equal(retained.schemaVersion, 5);
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
    for (const run of v2.runs) {
      delete run.executionSnapshot;
      delete run.cancellation;
      delete run.launchIdempotencyKeyHash;
    }
    for (const outcome of [...v2.launchOutcomes, ...v2.legacyStartOutcomes]) {
      if (outcome.response?.run) {
        delete outcome.response.run.executionSnapshot;
        delete outcome.response.run.cancellation;
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
    assert.equal(migrated.schemaVersion, 5);
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
    for (const run of v3.runs) {
      delete run.cancellation;
      delete run.launchIdempotencyKeyHash;
    }
    for (const outcome of [...v3.launchOutcomes, ...v3.legacyStartOutcomes]) {
      if (outcome.response?.run) {
        delete outcome.response.run.cancellation;
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
    assert.equal(migrated.schemaVersion, 5);
    assert.deepEqual(migrated.cancellationOutcomes, []);
    assert.equal(migrated.runs[0].cancellation, null);
    const {
      cancellation,
      launchIdempotencyKeyHash,
      ...migratedHistory
    } = migrated.runs[0];
    void cancellation;
    assert.deepEqual(migratedHistory, v3.runs[0]);
    assert.equal(launchIdempotencyKeyHash, v3.launchOutcomes[0].idempotencyKeyHash);
    assert.equal(migrated.launchOutcomes[0].response.run.cancellation, null);
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
    const launched = await fixture.manager.launch(launchRequest(
      fixture.registered.project.projectId,
      160,
    ));
    await waitForTerminal(fixture.manager, launched.run.harnessRunId);
    const current = JSON.parse(
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
    );
    const v4 = structuredClone(current);
    v4.schemaVersion = 4;
    delete v4.runs[0].outcome.outcomeAuditId;
    delete v4.runs[0].outcome.interruption;
    delete v4.runs[0].launchIdempotencyKeyHash;
    delete v4.launchOutcomes[0].response.run.launchIdempotencyKeyHash;
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
    assert.equal(migrated.schemaVersion, 5);
    assert.equal(migrated.runs[0].outcome.outcomeAuditId, null);
    assert.equal(migrated.runs[0].outcome.interruption, null);
    assert.equal(
      migrated.runs[0].launchIdempotencyKeyHash,
      v4.launchOutcomes[0].idempotencyKeyHash,
    );
    const migratedWithoutMetadata = structuredClone(migrated);
    migratedWithoutMetadata.schemaVersion = 4;
    delete migratedWithoutMetadata.runs[0].outcome.outcomeAuditId;
    delete migratedWithoutMetadata.runs[0].outcome.interruption;
    delete migratedWithoutMetadata.runs[0].launchIdempotencyKeyHash;
    delete migratedWithoutMetadata.launchOutcomes[0].response.run.launchIdempotencyKeyHash;
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
    assert.equal(initialized.schemaVersion, 5);
    const [{ executionSnapshot, cancellation, ...migratedLegacyRun }] = initialized.runs;
    assert.deepEqual(migratedLegacyRun, legacyRun);
    assert.equal(cancellation, null);
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
    assert.equal(migrated.schemaVersion, 5);
    assert.deepEqual(migrated.runs, initialized.runs);
    assert.deepEqual(migrated.launchOutcomes, []);
    assert.deepEqual(migrated.cancellationOutcomes, []);
    assert.deepEqual(migrated.legacyStartOutcomes, initialized.legacyStartOutcomes);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
