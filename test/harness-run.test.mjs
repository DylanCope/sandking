import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createHarnessRunManager } from "../src/harness-runs.mjs";
import {
  createLaunchRequestManager,
  prepareConformanceHarnessLaunch,
} from "../src/launch-requests.mjs";
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
    if (["succeeded", "failed", "cancelled"].includes(observation.run.status)) {
      return observation;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("harness_run_terminal_timeout");
};

test("an approved Launch request starts one asynchronous canonical conformance Harness run", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-harness-run-"));
  const dataDir = join(root, "host-state");
  const projectPath = join(root, "selected-project");
  const audits = [];
  const recordAudit = async (action, outcome, details) => {
    const auditId = `audit-${String(audits.length + 1).padStart(24, "0")}`;
    audits.push({ auditId, action, outcome, details });
    return auditId;
  };
  try {
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
    await writeFile(join(projectPath, "README.md"), "ordinary Project content\n");
    const projectFilesBefore = (await readdir(projectPath)).sort();
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
    const launchRequests = await createLaunchRequestManager({
      dataDir,
      hostId,
      recordAudit,
      loadLaunchContext: registry.loadLaunchContext,
      prepareHarness: prepareConformanceHarnessLaunch,
    });
    const prepared = await launchRequests.prepare({
      requestId: "prepare-run",
      projectId: registered.project.projectId,
      parameters: { issueNumber: 120, targetBranch: "sandcastle/issue-120" },
      controllerId,
      controllerSessionId,
      authorizationClass: "focused_controller_launch",
      idempotencyKey: "prepare-run",
      expectedRevision: 0,
      expiresInSeconds: 300,
    });
    let harnessManagerNow = new Date();
    const manager = await createHarnessRunManager({
      dataDir,
      hostId,
      recordAudit,
      launchRequests,
      loadLaunchContext: registry.loadLaunchContext,
      now: () => new Date(harnessManagerNow),
    });
    const unapprovedRequest = {
      requestId: "start-unapproved-run",
      launchRequestId: prepared.launchRequest.launchRequestId,
      controllerId,
      controllerSessionId,
      authorizationClass: "approved_launch_request_execution",
      idempotencyKey: "start-unapproved-secret-key",
      expectedRevision: prepared.revision,
    };
    const unapproved = await manager.start(unapprovedRequest);
    assert.equal(unapproved.type, "harness.run.start.failure");
    assert.equal(unapproved.code, "launch_request_unapproved");
    assert.equal(unapproved.prohibitedSideEffects.harnessRunStarted, false);
    const unapprovedReplay = await manager.start({
      ...unapprovedRequest,
      requestId: "start-unapproved-run-replay",
    });
    assert.equal(unapprovedReplay.idempotentReplay, true);
    assert.equal(unapprovedReplay.auditId, unapproved.auditId);

    const approved = await launchRequests.decide({
      requestId: "approve-run",
      launchRequestId: prepared.launchRequest.launchRequestId,
      decision: "approved",
      controllerId,
      controllerSessionId,
      authorizationClass: "focused_controller_launch",
      idempotencyKey: "approve-run",
      expectedRevision: 1,
    });

    const started = await manager.start({
      requestId: "start-approved-run",
      launchRequestId: prepared.launchRequest.launchRequestId,
      controllerId,
      controllerSessionId,
      authorizationClass: "approved_launch_request_execution",
      idempotencyKey: "start-approved-run-secret-key",
      expectedRevision: approved.revision,
    });
    assert.equal(started.type, "harness.run.start.result");
    assert.equal(started.code, "harness_run_created");
    assert.equal(started.idempotentReplay, false);
    assert.equal(started.run.status, "starting");
    assert.equal(started.run.completedAt, null);
    assert.equal(started.run.adapterEntryPoint, "adapters/conformance.mjs");
    assert.match(started.run.harnessRunId, /^harness-run-[a-f0-9]{24}$/);

    const replay = await manager.start({
      requestId: "start-approved-run-replay",
      launchRequestId: prepared.launchRequest.launchRequestId,
      controllerId,
      controllerSessionId,
      authorizationClass: "approved_launch_request_execution",
      idempotencyKey: "start-approved-run-secret-key",
      expectedRevision: approved.revision,
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.run.harnessRunId, started.run.harnessRunId);
    assert.equal(replay.auditId, started.auditId);
    const lookup = await manager.lookup({
      requestId: "lookup-ambiguous-start",
      idempotencyKey: "start-approved-run-secret-key",
    });
    assert.equal(lookup.found, true);
    assert.equal(lookup.startOutcome.run.harnessRunId, started.run.harnessRunId);
    const keyConflict = await manager.start({
      requestId: "start-approved-run-key-conflict",
      launchRequestId: prepared.launchRequest.launchRequestId,
      controllerId,
      controllerSessionId,
      authorizationClass: "approved_launch_request_execution",
      idempotencyKey: "start-approved-run-secret-key",
      expectedRevision: approved.revision + 1,
    });
    assert.equal(keyConflict.code, "idempotency_key_conflict");
    const found = await manager.start({
      requestId: "find-approved-run",
      launchRequestId: prepared.launchRequest.launchRequestId,
      controllerId,
      controllerSessionId,
      authorizationClass: "approved_launch_request_execution",
      idempotencyKey: "find-approved-run-secret-key",
      expectedRevision: approved.revision,
    });
    assert.equal(found.code, "harness_run_found");
    assert.equal(found.run.harnessRunId, started.run.harnessRunId);
    harnessManagerNow = new Date(Date.parse(prepared.launchRequest.expiresAt) + 1);
    const foundAfterApprovalExpiry = await manager.start({
      requestId: "find-started-run-after-approval-expiry",
      launchRequestId: prepared.launchRequest.launchRequestId,
      controllerId,
      controllerSessionId,
      authorizationClass: "approved_launch_request_execution",
      idempotencyKey: "find-started-run-after-approval-expiry",
      expectedRevision: approved.revision,
    });
    assert.equal(foundAfterApprovalExpiry.code, "harness_run_found");
    assert.equal(foundAfterApprovalExpiry.run.harnessRunId, started.run.harnessRunId);

    const observation = await waitForTerminal(manager, started.run.harnessRunId);
    assert.equal(observation.type, "harness.run.observe.result");
    assert.equal(observation.run.status, "succeeded");
    assert.equal(
      observation.launchRequest.launchRequestId,
      prepared.launchRequest.launchRequestId,
    );
    assert.equal(observation.launchRequest.execution.harnessRunId, started.run.harnessRunId);
    assert.deepEqual(observation.events.map((event) => event.type), [
      "harness_run_created",
      "harness_adapter_ready",
      "harness_progress_published",
      "harness_run_succeeded",
    ]);
    assert.equal(observation.outcome.status, "succeeded");
    assert.equal(observation.outcome.incompleteResult, false);
    assert.deepEqual(observation.terminalEnvelopeValidation, {
      adapterReadyObserved: true,
      validTerminalEnvelopeCount: 1,
      exactlyOne: true,
      adapterChannelClosedObserved: true,
      processExitObserved: true,
    });
    assert.deepEqual(observation.logStreams.map((stream) => stream.producer), [
      "stdout",
      "stderr",
    ]);

    const resumed = await manager.observe({
      requestId: "resume-run-after-two",
      harnessRunId: started.run.harnessRunId,
      afterSequence: 2,
    });
    assert.equal(resumed.code, "harness_run_observed");
    assert.equal(resumed.mode, "resume");
    assert.equal(resumed.resynchronization, null);
    assert.deepEqual(resumed.events.map((event) => event.sequence), [3, 4]);
    assert.equal(resumed.nextSequence, 4);
    assert.equal(resumed.launchRequest.launchRequestId, prepared.launchRequest.launchRequestId);

    const resynchronization = await manager.observe({
      requestId: "resynchronize-incompatible-run-cursor",
      harnessRunId: started.run.harnessRunId,
      afterSequence: resumed.nextSequence + 1,
    });
    assert.equal(resynchronization.code, "resync-required");
    assert.equal(resynchronization.mode, "resync-required");
    assert.deepEqual(resynchronization.resynchronization, {
      code: "resync-required",
      reason: "cursor_incompatible",
      requestedAfterSequence: 5,
      availableFromSequence: 1,
      canonicalSnapshot: true,
    });
    assert.deepEqual(resynchronization.events.map((event) => event.sequence), [1, 2, 3, 4]);
    assert.equal(
      resynchronization.launchRequest.launchRequestId,
      prepared.launchRequest.launchRequestId,
    );

    const stdout = await manager.readLogs({
      requestId: "read-run-stdout",
      harnessRunId: started.run.harnessRunId,
      producer: "stdout",
      offset: 0,
      limit: 16_384,
    });
    const stderr = await manager.readLogs({
      requestId: "read-run-stderr",
      harnessRunId: started.run.harnessRunId,
      producer: "stderr",
      offset: 0,
      limit: 16_384,
    });
    assert.match(stdout.data.toString("utf8"), /diagnostic stdout/);
    assert.match(stderr.data.toString("utf8"), /diagnostic stderr/);
    assert.equal(stdout.response.range.start, 0);
    assert.equal(stdout.response.range.end, stdout.data.byteLength);
    assert.equal(stderr.response.range.start, 0);
    assert.equal(stderr.response.range.end, stderr.data.byteLength);

    assert.deepEqual((await readdir(projectPath)).sort(), projectFilesBefore);
    assert.ok(audits.some((entry) =>
      entry.action === "harness.run.start"
      && entry.outcome === "accepted"
      && entry.details.harnessRunId === started.run.harnessRunId));
    const retained = JSON.parse(await readFile(join(dataDir, "harness-runs.json"), "utf8"));
    assert.equal(retained.runs.length, 1);
    assert.doesNotMatch(JSON.stringify(retained), /start-approved-run-secret-key/);
    if (process.env.SANDKING_ACCEPTANCE_RESULT_DIR) {
      await writeFile(
        join(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, "harness-run-success-contract.json"),
        `${JSON.stringify({
          kind: "harness_run_success_contract",
          start: {
            code: started.code,
            harnessRunId: started.run.harnessRunId,
            auditId: started.auditId,
            returnedStatus: started.run.status,
            completedAtOnReturn: started.run.completedAt,
          },
          idempotency: {
            replayCode: replay.code,
            replayIdempotent: replay.idempotentReplay,
            replayReturnedCanonicalRun: replay.run.harnessRunId === started.run.harnessRunId,
            replayReturnedOriginalAudit: replay.auditId === started.auditId,
            changedContentCode: keyConflict.code,
            lookupCode: lookup.code,
            lookupReturnedCanonicalRun:
              lookup.startOutcome.run.harnessRunId === started.run.harnessRunId,
            differentKeyFoundCode: found.code,
            differentKeyReturnedCanonicalRun:
              found.run.harnessRunId === started.run.harnessRunId,
            postExpiryFoundCode: foundAfterApprovalExpiry.code,
            postExpiryReturnedCanonicalRun:
              foundAfterApprovalExpiry.run.harnessRunId === started.run.harnessRunId,
          },
          unapproved: {
            code: unapproved.code,
            replayCode: unapprovedReplay.code,
            replayIdempotent: unapprovedReplay.idempotentReplay,
            noRunStarted: unapproved.prohibitedSideEffects.harnessRunStarted === false,
          },
          observation,
          logRanges: [stdout.response, stderr.response],
          auditReferences: audits.filter((entry) => entry.action.startsWith("harness.run")),
          canonicalRunCount: retained.runs.length,
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }

    retained.runs[0].events = retained.runs[0].events.filter((event) => event.sequence !== 2);
    await writeFile(
      join(dataDir, "harness-runs.json"),
      `${JSON.stringify(retained, null, 2)}\n`,
    );
    const historyGap = await manager.observe({
      requestId: "resynchronize-history-gap",
      harnessRunId: started.run.harnessRunId,
      afterSequence: 1,
    });
    assert.equal(historyGap.code, "resync-required");
    assert.equal(historyGap.mode, "resync-required");
    assert.equal(historyGap.resynchronization.reason, "history_gap");
    assert.equal(historyGap.resynchronization.canonicalSnapshot, true);
    assert.deepEqual(historyGap.events.map((event) => event.sequence), [1, 3, 4]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid adapter lifecycles fail truthfully without corrupting canonical run state", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-incomplete-harness-run-"));
  const dataDir = join(root, "host-state");
  const projectPath = join(root, "selected-project");
  const audits = [];
  const recordAudit = async (action, outcome, details) => {
    const auditId = `audit-${String(audits.length + 1).padStart(24, "0")}`;
    audits.push({ auditId, action, outcome, details });
    return auditId;
  };
  try {
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
    await writeFile(join(projectPath, "README.md"), "ordinary Project content\n");
    const registry = await createProjectRegistry({ dataDir, recordAudit });
    const registered = await registry.registerProject({
      requestId: "register-incomplete-project",
      path: projectPath,
      configuration: {
        issueWorkflow: { provider: "github", kind: "issues" },
        checks: [{ checkId: "test", command: "npm run test" }],
      },
      authorizationClass: "host_local_project_registration",
      idempotencyKey: "register-incomplete-project",
      expectedRevision: 0,
    });
    const harness = await registry.registerConformanceHarness({
      requestId: "register-incomplete-harness",
      name: "Sand-King Conformance Harness",
      authorizationClass: "host_local_harness_registration",
      idempotencyKey: "register-incomplete-harness",
      expectedRevision: 0,
    });
    await registry.pinConformanceHarness({
      requestId: "pin-incomplete-harness",
      projectId: registered.project.projectId,
      harnessId: harness.harness.harnessId,
      immutableRevision: harness.harness.immutableRevision,
      boundedConfiguration: {
        adapterProtocol: "1.0.0",
        launchProfile: "delegated-work",
      },
      authorizationClass: "host_local_project_configuration",
      idempotencyKey: "pin-incomplete-harness",
      expectedRevision: 1,
    });
    const launchRequests = await createLaunchRequestManager({
      dataDir,
      hostId,
      recordAudit,
      loadLaunchContext: registry.loadLaunchContext,
      prepareHarness: prepareConformanceHarnessLaunch,
    });
    const prepareAndDecide = async (issueNumber, decision = "approved") => {
      const prepared = await launchRequests.prepare({
        requestId: `prepare-${issueNumber}`,
        projectId: registered.project.projectId,
        parameters: {
          issueNumber,
          targetBranch: `sandcastle/issue-${issueNumber}`,
        },
        controllerId,
        controllerSessionId,
        authorizationClass: "focused_controller_launch",
        idempotencyKey: `prepare-${issueNumber}`,
        expectedRevision: 0,
        expiresInSeconds: 300,
      });
      const decided = await launchRequests.decide({
        requestId: `decide-${issueNumber}`,
        launchRequestId: prepared.launchRequest.launchRequestId,
        decision,
        controllerId,
        controllerSessionId,
        authorizationClass: "focused_controller_launch",
        idempotencyKey: `decide-${issueNumber}`,
        expectedRevision: 1,
      });
      return { prepared, decided };
    };

    const incompleteLaunch = await prepareAndDecide(999_999_999);
    const manager = await createHarnessRunManager({
      dataDir,
      hostId,
      recordAudit,
      launchRequests,
      loadLaunchContext: registry.loadLaunchContext,
    });
    const started = await manager.start({
      requestId: "start-incomplete-run",
      launchRequestId: incompleteLaunch.prepared.launchRequest.launchRequestId,
      controllerId,
      controllerSessionId,
      authorizationClass: "approved_launch_request_execution",
      idempotencyKey: "start-incomplete-run",
      expectedRevision: incompleteLaunch.decided.revision,
    });
    const observation = await waitForTerminal(manager, started.run.harnessRunId);
    assert.equal(observation.run.status, "failed");
    assert.equal(observation.outcome.code, "harness_result_incomplete");
    assert.equal(observation.outcome.incompleteResult, true);
    assert.equal(observation.terminalEnvelopeValidation.validTerminalEnvelopeCount, 0);
    assert.equal(observation.terminalEnvelopeValidation.exactlyOne, false);
    assert.equal(
      observation.terminalEnvelopeValidation.adapterChannelClosedObserved,
      true,
    );
    assert.equal(observation.terminalEnvelopeValidation.processExitObserved, true);
    assert.equal(observation.events.at(-1).type, "harness_run_failed");
    const misleadingLog = await manager.readLogs({
      requestId: "read-misleading-log",
      harnessRunId: started.run.harnessRunId,
      producer: "stdout",
      offset: 0,
      limit: 16_384,
    });
    assert.match(misleadingLog.data.toString("utf8"), /SUCCESS/);
    assert.equal(misleadingLog.response.insertedIntoControllerConversation, false);
    assert.deepEqual(observation.outcome.diagnosticReferences.map((reference) => ({
      producer: reference.producer,
      streamId: reference.streamId,
      start: reference.range.start,
      end: reference.range.end,
    })), observation.logStreams.map((stream) => ({
      producer: stream.producer,
      streamId: stream.streamId,
      start: stream.availableStart,
      end: stream.availableEnd,
    })));

    const duplicateTerminalLaunch = await prepareAndDecide(999_999_996);
    const duplicateTerminalStart = await manager.start({
      requestId: "start-duplicate-terminal-run",
      launchRequestId: duplicateTerminalLaunch.prepared.launchRequest.launchRequestId,
      controllerId,
      controllerSessionId,
      authorizationClass: "approved_launch_request_execution",
      idempotencyKey: "start-duplicate-terminal-run",
      expectedRevision: duplicateTerminalLaunch.decided.revision,
    });
    const duplicateTerminalObservation = await waitForTerminal(
      manager,
      duplicateTerminalStart.run.harnessRunId,
    );
    assert.equal(duplicateTerminalObservation.run.status, "failed");
    assert.equal(duplicateTerminalObservation.outcome.code, "harness_result_incomplete");
    assert.equal(duplicateTerminalObservation.outcome.incompleteResult, true);
    assert.equal(
      duplicateTerminalObservation.terminalEnvelopeValidation.validTerminalEnvelopeCount,
      2,
    );
    assert.equal(duplicateTerminalObservation.terminalEnvelopeValidation.exactlyOne, false);

    const invalidTerminalLaunch = await prepareAndDecide(999_999_995);
    const invalidTerminalStart = await manager.start({
      requestId: "start-invalid-terminal-run",
      launchRequestId: invalidTerminalLaunch.prepared.launchRequest.launchRequestId,
      controllerId,
      controllerSessionId,
      authorizationClass: "approved_launch_request_execution",
      idempotencyKey: "start-invalid-terminal-run",
      expectedRevision: invalidTerminalLaunch.decided.revision,
    });
    const invalidTerminalObservation = await waitForTerminal(
      manager,
      invalidTerminalStart.run.harnessRunId,
    );
    assert.equal(invalidTerminalObservation.run.status, "failed");
    assert.equal(
      invalidTerminalObservation.outcome.code,
      "harness_adapter_protocol_invalid",
    );
    assert.equal(invalidTerminalObservation.outcome.incompleteResult, true);
    assert.equal(
      invalidTerminalObservation.terminalEnvelopeValidation.validTerminalEnvelopeCount,
      0,
    );
    assert.equal(invalidTerminalObservation.terminalEnvelopeValidation.exactlyOne, false);
    assert.equal(
      invalidTerminalObservation.terminalEnvelopeValidation.processExitObserved,
      true,
    );

    const malformedProgressLaunch = await prepareAndDecide(999_999_998);
    const realSupervisorManager = await createHarnessRunManager({
      dataDir,
      hostId,
      recordAudit,
      launchRequests,
      loadLaunchContext: registry.loadLaunchContext,
    });
    const malformedProgressStart = await realSupervisorManager.start({
      requestId: "start-malformed-progress-run",
      launchRequestId: malformedProgressLaunch.prepared.launchRequest.launchRequestId,
      controllerId,
      controllerSessionId,
      authorizationClass: "approved_launch_request_execution",
      idempotencyKey: "start-malformed-progress-run",
      expectedRevision: malformedProgressLaunch.decided.revision,
    });
    const malformedProgressObservation = await waitForTerminal(
      realSupervisorManager,
      malformedProgressStart.run.harnessRunId,
    );
    assert.equal(malformedProgressObservation.run.status, "failed");
    assert.equal(
      malformedProgressObservation.outcome.code,
      "harness_adapter_protocol_invalid",
    );
    assert.equal(
      malformedProgressObservation.events.some((event) =>
        event.type === "harness_progress_published"),
      false,
    );

    const excessiveProgressLaunch = await prepareAndDecide(999_999_997);
    const excessiveProgressStart = await manager.start({
      requestId: "start-excessive-progress-run",
      launchRequestId: excessiveProgressLaunch.prepared.launchRequest.launchRequestId,
      controllerId,
      controllerSessionId,
      authorizationClass: "approved_launch_request_execution",
      idempotencyKey: "start-excessive-progress-run",
      expectedRevision: excessiveProgressLaunch.decided.revision,
    });
    const excessiveProgressObservation = await waitForTerminal(
      manager,
      excessiveProgressStart.run.harnessRunId,
    );
    assert.equal(excessiveProgressObservation.run.status, "failed");
    assert.equal(
      excessiveProgressObservation.outcome.code,
      "harness_adapter_protocol_invalid",
    );
    assert.equal(excessiveProgressObservation.events.length, 1_024);
    assert.equal(
      excessiveProgressObservation.events.filter((event) =>
        event.type === "harness_progress_published").length,
      1_021,
    );
    assert.deepEqual(
      excessiveProgressObservation.events.map((event) => event.sequence),
      Array.from({ length: 1_024 }, (_, index) => index + 1),
    );
    assert.equal(excessiveProgressObservation.events.at(-1).type, "harness_run_failed");
    const reloadedManager = await createHarnessRunManager({
      dataDir,
      hostId,
      recordAudit,
      launchRequests,
      loadLaunchContext: registry.loadLaunchContext,
    });
    const reloadedExcessiveProgress = await reloadedManager.observe({
      requestId: "observe-reloaded-excessive-progress-run",
      harnessRunId: excessiveProgressStart.run.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(reloadedExcessiveProgress.events.length, 1_024);
    assert.equal(reloadedExcessiveProgress.run.status, "failed");

    const rejectedLaunch = await prepareAndDecide(121, "rejected");
    const rejected = await manager.start({
      requestId: "start-rejected-run",
      launchRequestId: rejectedLaunch.prepared.launchRequest.launchRequestId,
      controllerId,
      controllerSessionId,
      authorizationClass: "approved_launch_request_execution",
      idempotencyKey: "start-rejected-run",
      expectedRevision: rejectedLaunch.decided.revision,
    });
    assert.equal(rejected.code, "launch_request_terminal");
    assert.equal(rejected.prohibitedSideEffects.harnessRunStarted, false);

    const expiredLaunch = await prepareAndDecide(122);
    const expiredManager = await createHarnessRunManager({
      dataDir,
      hostId,
      recordAudit,
      launchRequests,
      loadLaunchContext: registry.loadLaunchContext,
      now: () => new Date(Date.parse(expiredLaunch.prepared.launchRequest.expiresAt) + 1),
    });
    const expired = await expiredManager.start({
      requestId: "start-expired-run",
      launchRequestId: expiredLaunch.prepared.launchRequest.launchRequestId,
      controllerId,
      controllerSessionId,
      authorizationClass: "approved_launch_request_execution",
      idempotencyKey: "start-expired-run",
      expectedRevision: expiredLaunch.decided.revision,
    });
    assert.equal(expired.code, "launch_request_expired");
    const terminalizedExpiredLaunch = await launchRequests.get(
      expiredLaunch.prepared.launchRequest.launchRequestId,
    );
    assert.equal(terminalizedExpiredLaunch.status, "expired");
    assert.equal(terminalizedExpiredLaunch.revision, expiredLaunch.decided.revision + 1);

    const staleLaunch = await prepareAndDecide(123);
    const context = await registry.loadLaunchContext(registered.project.projectId);
    const staleManifestPath = join(context.harnessWorkspacePath, "harness.json");
    const approvedManifestSource = await readFile(staleManifestPath, "utf8");
    await writeFile(staleManifestPath, " \n", {
      flag: "a",
    });
    const stale = await manager.start({
      requestId: "start-stale-run",
      launchRequestId: staleLaunch.prepared.launchRequest.launchRequestId,
      controllerId,
      controllerSessionId,
      authorizationClass: "approved_launch_request_execution",
      idempotencyKey: "start-stale-run",
      expectedRevision: staleLaunch.decided.revision,
    });
    assert.equal(stale.code, "launch_request_stale");
    assert.equal(stale.prohibitedSideEffects.harnessRunStarted, false);
    const terminalizedStaleLaunch = await launchRequests.get(
      staleLaunch.prepared.launchRequest.launchRequestId,
    );
    assert.equal(terminalizedStaleLaunch.status, "expired");
    assert.equal(terminalizedStaleLaunch.revision, staleLaunch.decided.revision + 1);

    await writeFile(staleManifestPath, approvedManifestSource);
    const restoredRetry = await manager.start({
      requestId: "retry-restored-stale-run",
      launchRequestId: staleLaunch.prepared.launchRequest.launchRequestId,
      controllerId,
      controllerSessionId,
      authorizationClass: "approved_launch_request_execution",
      idempotencyKey: "retry-restored-stale-run",
      expectedRevision: staleLaunch.decided.revision,
    });
    assert.equal(restoredRetry.code, "launch_request_terminal");
    assert.equal(restoredRetry.prohibitedSideEffects.harnessRunStarted, false);

    const outcomeAuditDeadline = Date.now() + 5_000;
    while (!audits.some((entry) =>
      entry.action === "harness.run.outcome"
      && entry.details.harnessRunId === excessiveProgressStart.run.harnessRunId)) {
      if (Date.now() >= outcomeAuditDeadline) {
        throw new Error("harness_run_outcome_audit_timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const retained = JSON.parse(await readFile(join(dataDir, "harness-runs.json"), "utf8"));
    assert.equal(retained.runs.length, 5);
    assert.equal(retained.runs[0].status, "failed");
    if (process.env.SANDKING_ACCEPTANCE_RESULT_DIR) {
      await writeFile(
        join(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, "harness-run-failure-contract.json"),
        `${JSON.stringify({
          kind: "harness_run_failure_contract",
          incompleteResult: {
            harnessRunId: started.run.harnessRunId,
            status: observation.run.status,
            outcome: observation.outcome,
            terminalEnvelopeValidation: observation.terminalEnvelopeValidation,
            terminalEvent: observation.events.at(-1),
            successLookingDiagnosticRetained: misleadingLog.data.toString("utf8").includes("SUCCESS"),
            logInsertedIntoControllerConversation:
              misleadingLog.response.insertedIntoControllerConversation,
          },
          nonUniqueOrInvalidTerminal: {
            duplicate: {
              harnessRunId: duplicateTerminalStart.run.harnessRunId,
              status: duplicateTerminalObservation.run.status,
              outcome: duplicateTerminalObservation.outcome,
              terminalEnvelopeValidation:
                duplicateTerminalObservation.terminalEnvelopeValidation,
            },
            invalid: {
              harnessRunId: invalidTerminalStart.run.harnessRunId,
              status: invalidTerminalObservation.run.status,
              outcome: invalidTerminalObservation.outcome,
              terminalEnvelopeValidation:
                invalidTerminalObservation.terminalEnvelopeValidation,
            },
          },
          prohibitedStarts: {
            rejected: rejected.code,
            expired: expired.code,
            expiredCanonicalStatus: terminalizedExpiredLaunch.status,
            staleBoundary: "pinned_compatibility_manifest",
            stale: stale.code,
            staleCanonicalStatus: terminalizedStaleLaunch.status,
            restoredStaleRetry: restoredRetry.code,
          },
          malformedProgress: {
            harnessRunId: malformedProgressStart.run.harnessRunId,
            status: malformedProgressObservation.run.status,
            outcome: malformedProgressObservation.outcome,
            malformedRecordPublished: malformedProgressObservation.events.some((event) =>
              event.type === "harness_progress_published"),
          },
          excessiveProgress: {
            harnessRunId: excessiveProgressStart.run.harnessRunId,
            status: excessiveProgressObservation.run.status,
            outcome: excessiveProgressObservation.outcome,
            retainedEventCount: excessiveProgressObservation.events.length,
            retainedProgressCount: excessiveProgressObservation.events.filter((event) =>
              event.type === "harness_progress_published").length,
            terminalEvent: excessiveProgressObservation.events.at(-1),
            reloadObservable: reloadedExcessiveProgress.run.status === "failed",
          },
          canonicalRunCount: retained.runs.length,
          auditReferences: audits.filter((entry) => entry.action.startsWith("harness.run")),
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("distinct start outcomes remain durable and lookup-safe past 256 keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-harness-start-outcomes-"));
  const dataDir = join(root, "host-state");
  let auditSequence = 0;
  const recordAudit = async () => {
    auditSequence += 1;
    return `audit-${String(auditSequence).padStart(24, "0")}`;
  };
  try {
    const manager = await createHarnessRunManager({
      dataDir,
      hostId,
      recordAudit,
      launchRequests: {
        get: async () => null,
      },
      loadLaunchContext: async () => {
        throw new Error("launch_context_must_not_be_loaded");
      },
    });
    let firstOutcome;
    for (let index = 0; index < 257; index += 1) {
      const outcome = await manager.start({
        requestId: `missing-launch-request-${index}`,
        launchRequestId: `launch-request-${"4".repeat(24)}`,
        controllerId,
        controllerSessionId,
        authorizationClass: "approved_launch_request_execution",
        idempotencyKey: `missing-launch-request-key-${index}`,
        expectedRevision: 1,
      });
      assert.equal(outcome.code, "launch_request_not_found");
      firstOutcome ??= outcome;
    }

    const lookup = await manager.lookup({
      requestId: "lookup-first-of-257-start-outcomes",
      idempotencyKey: "missing-launch-request-key-0",
    });
    assert.equal(lookup.found, true);
    assert.equal(lookup.startOutcome.auditId, firstOutcome.auditId);
    const replay = await manager.start({
      requestId: "replay-first-of-257-start-outcomes",
      launchRequestId: `launch-request-${"4".repeat(24)}`,
      controllerId,
      controllerSessionId,
      authorizationClass: "approved_launch_request_execution",
      idempotencyKey: "missing-launch-request-key-0",
      expectedRevision: 1,
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.auditId, firstOutcome.auditId);
    const retained = JSON.parse(await readFile(join(dataDir, "harness-runs.json"), "utf8"));
    assert.equal(retained.startOutcomes.length, 257);
    if (process.env.SANDKING_ACCEPTANCE_RESULT_DIR) {
      await writeFile(
        join(
          process.env.SANDKING_ACCEPTANCE_RESULT_DIR,
          "harness-run-start-retention-contract.json",
        ),
        `${JSON.stringify({
          kind: "harness_run_start_retention_contract",
          distinctKeyCount: 257,
          retainedOutcomeCount: retained.startOutcomes.length,
          firstLookupCode: lookup.code,
          firstLookupFound: lookup.found,
          replayIdempotent: replay.idempotentReplay,
          replayReturnedOriginalAudit: replay.auditId === firstOutcome.auditId,
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
