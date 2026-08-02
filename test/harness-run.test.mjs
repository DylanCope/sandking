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
  const deadline = Date.now() + 3_000;
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
    const manager = await createHarnessRunManager({
      dataDir,
      hostId,
      recordAudit,
      launchRequests,
      loadLaunchContext: registry.loadLaunchContext,
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
    assert.equal(started.run.adapterEntryPoint, "adapter.mjs");
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

    const observation = await waitForTerminal(manager, started.run.harnessRunId);
    assert.equal(observation.type, "harness.run.observe.result");
    assert.equal(observation.run.status, "succeeded");
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process exit and success-looking diagnostics cannot replace one valid terminal envelope", async () => {
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
    const staleAdapterPath = join(context.harnessWorkspacePath, "adapter.mjs");
    const approvedAdapterSource = await readFile(staleAdapterPath, "utf8");
    await writeFile(staleAdapterPath, "// changed after approval\n", {
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

    await writeFile(staleAdapterPath, approvedAdapterSource);
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

    const retained = JSON.parse(await readFile(join(dataDir, "harness-runs.json"), "utf8"));
    assert.equal(retained.runs.length, 2);
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
          prohibitedStarts: {
            rejected: rejected.code,
            expired: expired.code,
            expiredCanonicalStatus: terminalizedExpiredLaunch.status,
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
