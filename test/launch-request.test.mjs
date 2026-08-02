import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createLaunchRequestManager,
  prepareConformanceHarnessLaunch,
} from "../src/launch-requests.mjs";
import { createProjectRegistry } from "../src/project-registration.mjs";

const execFileAsync = promisify(execFile);

const hostId = `host-${"1".repeat(24)}`;
const projectId = `project-${"2".repeat(24)}`;
const harnessId = `harness-${"3".repeat(24)}`;
const pinnedRevision = "4".repeat(40);
const controllerId = `runtime-${"5".repeat(24)}`;
const controllerSessionId = `controller-session-${"6".repeat(24)}`;

const launchContext = {
  project: {
    projectId,
    revision: 2,
    displayName: "selected-project",
    harness: {
      harnessId,
      adapterId: "conformance-harness-adapter-v1",
      pinnedRevision,
      boundedConfiguration: {
        adapterProtocol: "1.0.0",
        launchProfile: "delegated-work",
      },
    },
  },
  harness: {
    harnessId,
    adapterId: "conformance-harness-adapter-v1",
    immutableRevision: pinnedRevision,
  },
};

test("preparation durably freezes a sanitized immutable Launch request without delegated work", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-launch-request-"));
  const audits = [];
  const recordAudit = async (action, outcome, details) => {
    const auditId = `audit-${String(audits.length + 1).padStart(24, "0")}`;
    audits.push({ auditId, action, outcome, details });
    return auditId;
  };
  let harnessPreparationCount = 0;
  try {
    const manager = await createLaunchRequestManager({
      dataDir,
      hostId,
      recordAudit,
      loadLaunchContext: async () => structuredClone(launchContext),
      prepareHarness: async (context, parameters) => {
        harnessPreparationCount += 1;
        assert.equal(context.project.projectId, projectId);
        return {
          adapterId: "conformance-harness-adapter-v1",
          adapterProtocol: "1.0.0",
          adapterEntryPoint: "adapter.mjs",
          negotiatedCapabilities: ["harness.launch.prepare.v1"],
          suppliedCapabilities: ["github.issues.read", "project.git.read"],
          sanitizedPreview: {
            summary: `Delegate issue #${parameters.issueNumber} on ${parameters.targetBranch}`,
            secretFree: true,
          },
          sideEffects: {
            delegatedWorkStarted: false,
            projectWrite: false,
            harnessWorkspaceWrite: false,
          },
        };
      },
    });

    const prepared = await manager.prepare({
      requestId: "prepare-launch-request-1",
      projectId,
      parameters: {
        issueNumber: 119,
        targetBranch: "sandcastle/issue-119",
      },
      controllerId,
      controllerSessionId,
      authorizationClass: "focused_controller_launch",
      idempotencyKey: "prepare-launch-idempotency-1",
      expectedRevision: 0,
      expiresInSeconds: 300,
    });

    assert.equal(prepared.type, "launch.request.prepare.result");
    assert.equal(prepared.code, "launch_request_prepared");
    assert.equal(prepared.revision, 1);
    assert.equal(prepared.idempotentReplay, false);
    assert.match(prepared.launchRequest.launchRequestId, /^launch-request-[a-f0-9]{24}$/);
    assert.deepEqual({
      status: prepared.launchRequest.status,
      singleUse: prepared.launchRequest.singleUse,
      hostId: prepared.launchRequest.host.hostId,
      projectId: prepared.launchRequest.project.projectId,
      projectRevision: prepared.launchRequest.project.revision,
      harnessId: prepared.launchRequest.harness.harnessId,
      harnessPin: prepared.launchRequest.harness.pinnedRevision,
      parameters: prepared.launchRequest.parameters,
      capabilities: prepared.launchRequest.suppliedCapabilities,
      authorizationClass: prepared.launchRequest.authorizationClass,
      owner: prepared.launchRequest.owner,
      revision: prepared.launchRequest.revision,
      decision: prepared.launchRequest.decision,
      execution: prepared.launchRequest.execution,
    }, {
      status: "pending",
      singleUse: true,
      hostId,
      projectId,
      projectRevision: 2,
      harnessId,
      harnessPin: pinnedRevision,
      parameters: { issueNumber: 119, targetBranch: "sandcastle/issue-119" },
      capabilities: ["github.issues.read", "project.git.read"],
      authorizationClass: "focused_controller_launch",
      owner: { controllerId, controllerSessionId },
      revision: 1,
      decision: null,
      execution: {
        status: "not_started",
        harnessRunId: null,
        outcomeReference: null,
      },
    });
    assert.equal(prepared.launchRequest.preview.secretFree, true);
    assert.equal(prepared.launchRequest.preview.delegatedWorkStarted, false);
    assert.equal(prepared.launchRequest.capturedPreconditions.projectRevision, 2);
    assert.equal(prepared.launchRequest.capturedPreconditions.harnessPinnedRevision,
      pinnedRevision);
    assert.match(prepared.launchRequest.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(harnessPreparationCount, 1);

    const retainedText = await readFile(join(dataDir, "launch-requests.json"), "utf8");
    const retained = JSON.parse(retainedText);
    assert.equal(retained.launchRequests.length, 1);
    assert.deepEqual(retained.launchRequests[0], prepared.launchRequest);
    assert.doesNotMatch(retainedText, /idempotency-1/);
    assert.ok(audits.some((entry) =>
      entry.action === "launch.request.prepare"
      && entry.outcome === "accepted"
      && entry.details.launchRequestId === prepared.launchRequest.launchRequestId
      && entry.details.delegatedWorkStarted === false));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("only the owning focused Controller decides the exact revision idempotently", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-launch-decision-"));
  const audits = [];
  const recordAudit = async (action, outcome, details) => {
    const auditId = `audit-${String(audits.length + 1).padStart(24, "0")}`;
    audits.push({ auditId, action, outcome, details });
    return auditId;
  };
  let currentContext = structuredClone(launchContext);
  try {
    const manager = await createLaunchRequestManager({
      dataDir,
      hostId,
      recordAudit,
      loadLaunchContext: async () => structuredClone(currentContext),
      prepareHarness: async () => ({
        adapterId: "conformance-harness-adapter-v1",
        adapterProtocol: "1.0.0",
        adapterEntryPoint: "adapter.mjs",
        negotiatedCapabilities: ["harness.launch.prepare.v1"],
        suppliedCapabilities: ["github.issues.read", "project.git.read"],
        sanitizedPreview: { summary: "Delegate issue #119", secretFree: true },
        sideEffects: {
          delegatedWorkStarted: false,
          projectWrite: false,
          harnessWorkspaceWrite: false,
        },
      }),
      now: () => new Date("2026-08-01T12:00:00.000Z"),
    });
    const prepared = await manager.prepare({
      requestId: "prepare-decision-request",
      projectId,
      parameters: { issueNumber: 119, targetBranch: "sandcastle/issue-119" },
      controllerId,
      controllerSessionId,
      authorizationClass: "focused_controller_launch",
      idempotencyKey: "prepare-decision-request",
      expectedRevision: 0,
      expiresInSeconds: 300,
    });
    const launchRequestId = prepared.launchRequest.launchRequestId;
    const decisionRequest = {
      requestId: "approve-launch-request",
      launchRequestId,
      decision: "approved",
      controllerId,
      controllerSessionId,
      authorizationClass: "focused_controller_launch",
      idempotencyKey: "approve-launch-request",
      expectedRevision: 1,
    };

    const unrelated = await manager.decide({
      ...decisionRequest,
      requestId: "unrelated-session-approval",
      idempotencyKey: "unrelated-session-approval",
      controllerSessionId: `controller-session-${"7".repeat(24)}`,
    });
    assert.equal(unrelated.type, "launch.request.decision.failure");
    assert.equal(unrelated.code, "authorization_failed");
    assert.equal(unrelated.current.revision, 1);
    assert.equal(unrelated.prohibitedSideEffects.harnessRunStarted, false);

    const staleRequest = {
      ...decisionRequest,
      requestId: "stale-session-approval",
      idempotencyKey: "stale-session-approval",
      expectedRevision: 0,
    };
    const stale = await manager.decide(staleRequest);
    assert.equal(stale.code, "mutation_revision_conflict");
    assert.equal(stale.actualRevision, 1);
    assert.equal(stale.current.preview.secretFree, true);
    assert.equal(stale.idempotentReplay, false);

    const staleReplay = await manager.decide({
      ...staleRequest,
      requestId: "stale-session-approval-replay",
    });
    assert.equal(staleReplay.code, "mutation_revision_conflict");
    assert.equal(staleReplay.idempotentReplay, true);
    assert.equal(staleReplay.auditId, stale.auditId);

    const staleKeyConflict = await manager.decide({
      ...staleRequest,
      requestId: "stale-session-approval-conflict",
      expectedRevision: 1,
    });
    assert.equal(staleKeyConflict.code, "idempotency_key_conflict");

    const approved = await manager.decide(decisionRequest);
    assert.equal(approved.type, "launch.request.decision.result");
    assert.equal(approved.code, "launch_request_approved");
    assert.equal(approved.revision, 2);
    assert.equal(approved.idempotentReplay, false);
    assert.deepEqual({
      status: approved.launchRequest.status,
      decision: approved.launchRequest.decision.decision,
      controllerId: approved.launchRequest.decision.controllerId,
      controllerSessionId: approved.launchRequest.decision.controllerSessionId,
      execution: approved.launchRequest.execution,
    }, {
      status: "approved",
      decision: "approved",
      controllerId,
      controllerSessionId,
      execution: {
        status: "not_started",
        harnessRunId: null,
        outcomeReference: null,
      },
    });

    const replay = await manager.decide({
      ...decisionRequest,
      requestId: "approve-launch-request-replay",
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.auditId, approved.auditId);
    assert.equal(replay.launchRequest.decision.decisionId,
      approved.launchRequest.decision.decisionId);

    const conflictingUse = await manager.decide({
      ...decisionRequest,
      requestId: "conflicting-decision-use",
      decision: "rejected",
    });
    assert.equal(conflictingUse.code, "idempotency_key_conflict");
    assert.equal(conflictingUse.actualRevision, 2);

    const laterDecision = await manager.decide({
      ...decisionRequest,
      requestId: "later-decision",
      idempotencyKey: "later-decision",
      expectedRevision: 2,
    });
    assert.equal(laterDecision.code, "launch_request_terminal");
    assert.equal(laterDecision.current.status, "approved");
    assert.equal(laterDecision.prohibitedSideEffects.harnessRunStarted, false);

    const retained = JSON.parse(await readFile(join(dataDir, "launch-requests.json"), "utf8"));
    assert.equal(retained.launchRequests[0].status, "approved");
    assert.equal(retained.launchRequests[0].revision, 2);
    assert.equal(retained.launchRequests[0].execution.status, "not_started");
    const approvalAudit = audits.find((entry) => entry.auditId === approved.auditId);
    assert.deepEqual({
      action: approvalAudit.action,
      outcome: approvalAudit.outcome,
      request: approvalAudit.details.launchRequestId,
      host: approvalAudit.details.hostId,
      project: approvalAudit.details.projectId,
      harness: approvalAudit.details.harnessId,
      controller: approvalAudit.details.controllerId,
      session: approvalAudit.details.controllerSessionId,
      expectedRevision: approvalAudit.details.expectedRevision,
      resultingRevision: approvalAudit.details.resultingRevision,
      parameters: approvalAudit.details.parameters,
      decision: approvalAudit.details.decision,
      executionOutcome: approvalAudit.details.executionOutcome,
      outcomeReference: approvalAudit.details.outcomeReference,
    }, {
      action: "launch.request.decision",
      outcome: "accepted",
      request: launchRequestId,
      host: hostId,
      project: projectId,
      harness: harnessId,
      controller: controllerId,
      session: controllerSessionId,
      expectedRevision: 1,
      resultingRevision: 2,
      parameters: { issueNumber: 119, targetBranch: "sandcastle/issue-119" },
      decision: "approved",
      executionOutcome: "not_started",
      outcomeReference: null,
    });
    if (process.env.SANDKING_ACCEPTANCE_RESULT_DIR) {
      await writeFile(
        join(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, "launch-decision-contract.json"),
        `${JSON.stringify({
          kind: "launch_decision_contract",
          launchRequestId,
          owner: { controllerId, controllerSessionId },
          approved: {
            code: approved.code,
            expectedRevision: approved.expectedRevision,
            revision: approved.revision,
            auditId: approved.auditId,
            decisionId: approved.launchRequest.decision.decisionId,
            execution: approved.launchRequest.execution,
          },
          idempotency: {
            replayCode: replay.code,
            replayIdempotent: replay.idempotentReplay,
            replayReturnedOriginalAudit: replay.auditId === approved.auditId,
            replayReturnedOriginalDecision:
              replay.launchRequest.decision.decisionId
                === approved.launchRequest.decision.decisionId,
            changedContentCode: conflictingUse.code,
            failedReplayCode: staleReplay.code,
            failedReplayIdempotent: staleReplay.idempotentReplay,
            failedReplayReturnedOriginalAudit: staleReplay.auditId === stale.auditId,
            failedChangedContentCode: staleKeyConflict.code,
          },
          failures: {
            unrelatedSession: unrelated.code,
            staleRevision: {
              code: stale.code,
              actualRevision: stale.actualRevision,
              sanitizedSummary: stale.current.preview,
            },
            laterDecision: {
              code: laterDecision.code,
              status: laterDecision.current.status,
            },
          },
          auditReferences: audits,
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the pinned conformance Harness negotiates a side-effect-free preparation subprocess", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-harness-preparation-"));
  const dataDir = join(root, "host-state");
  const projectPath = join(root, "selected-project");
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
  await writeFile(join(projectPath, "README.md"), "ordinary Project content\n");
  const projectFilesBefore = (await readdir(projectPath)).sort();
  const audits = [];
  const recordAudit = async (action, outcome, details) => {
    const auditId = `audit-${String(audits.length + 1).padStart(24, "0")}`;
    audits.push({ auditId, action, outcome, details });
    return auditId;
  };
  try {
    const registry = await createProjectRegistry({ dataDir, recordAudit });
    const registration = await registry.registerProject({
      requestId: "register-project-for-launch",
      path: projectPath,
      configuration: {
        issueWorkflow: { provider: "github", kind: "issues" },
        checks: [
          { checkId: "typecheck", command: "npm run typecheck" },
          { checkId: "test", command: "npm run test" },
        ],
      },
      authorizationClass: "host_local_project_registration",
      idempotencyKey: "register-project-for-launch",
      expectedRevision: 0,
    });
    const harness = await registry.registerConformanceHarness({
      requestId: "register-harness-for-launch",
      name: "Sand-King Conformance Harness",
      authorizationClass: "host_local_harness_registration",
      idempotencyKey: "register-harness-for-launch",
      expectedRevision: 0,
    });
    const pinned = await registry.pinConformanceHarness({
      requestId: "pin-harness-for-launch",
      projectId: registration.project.projectId,
      harnessId: harness.harness.harnessId,
      immutableRevision: harness.harness.immutableRevision,
      boundedConfiguration: {
        adapterProtocol: "1.0.0",
        launchProfile: "delegated-work",
      },
      authorizationClass: "host_local_project_configuration",
      idempotencyKey: "pin-harness-for-launch",
      expectedRevision: 1,
    });
    const context = await registry.loadLaunchContext(pinned.project.projectId);
    const harnessWorkspaceBefore = (await readdir(context.harnessWorkspacePath)).sort();
    const result = await prepareConformanceHarnessLaunch(context, {
      issueNumber: 119,
      targetBranch: "sandcastle/issue-119",
    });

    assert.deepEqual(result, {
      adapterId: "conformance-harness-adapter-v1",
      adapterProtocol: "1.0.0",
      adapterEntryPoint: "adapter.mjs",
      negotiatedCapabilities: ["harness.launch.prepare.v1"],
      suppliedCapabilities: ["github.issues.read", "project.git.read"],
      sanitizedPreview: {
        summary: "Delegate GitHub issue #119 on sandcastle/issue-119 using the pinned conformance Harness.",
        secretFree: true,
      },
      sideEffects: {
        delegatedWorkStarted: false,
        projectWrite: false,
        harnessWorkspaceWrite: false,
      },
    });
    assert.deepEqual((await readdir(projectPath)).sort(), projectFilesBefore);
    assert.deepEqual((await readdir(context.harnessWorkspacePath)).sort(),
      harnessWorkspaceBefore);
    assert.equal((await execFileAsync("git", [
      "-C", context.harnessWorkspacePath, "status", "--porcelain",
    ])).stdout, "");

    const manager = await createLaunchRequestManager({
      dataDir,
      hostId,
      recordAudit,
      loadLaunchContext: registry.loadLaunchContext,
      prepareHarness: prepareConformanceHarnessLaunch,
      now: () => new Date("2026-08-01T12:00:00.000Z"),
    });
    const prepared = await manager.prepare({
      requestId: "prepare-launch-before-hidden-workspace-drift",
      projectId: pinned.project.projectId,
      parameters: { issueNumber: 119, targetBranch: "sandcastle/issue-119" },
      controllerId,
      controllerSessionId,
      authorizationClass: "focused_controller_launch",
      idempotencyKey: "prepare-launch-before-hidden-workspace-drift",
      expectedRevision: 0,
      expiresInSeconds: 300,
    });
    const adapterPath = join(context.harnessWorkspacePath, "adapter.mjs");
    const adapterSource = await readFile(adapterPath, "utf8");
    await execFileAsync("git", [
      "-C", context.harnessWorkspacePath,
      "update-index", "--assume-unchanged", "--", "adapter.mjs",
    ]);
    await writeFile(adapterPath, `${adapterSource}\n// hidden material adapter drift\n`);
    assert.equal((await execFileAsync("git", [
      "-C", context.harnessWorkspacePath, "status", "--porcelain",
    ])).stdout, "");

    const hiddenDriftDecision = await manager.decide({
      requestId: "decide-launch-after-hidden-workspace-drift",
      launchRequestId: prepared.launchRequest.launchRequestId,
      decision: "approved",
      controllerId,
      controllerSessionId,
      authorizationClass: "focused_controller_launch",
      idempotencyKey: "decide-launch-after-hidden-workspace-drift",
      expectedRevision: 1,
    });
    assert.equal(hiddenDriftDecision.code, "launch_request_materially_changed");
    assert.equal(hiddenDriftDecision.current.status, "expired");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expiry, rejection, and material change are terminal and require a new Launch request", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-launch-terminal-"));
  const audits = [];
  let observedNow = new Date("2026-08-01T12:00:00.000Z");
  let currentContext = structuredClone(launchContext);
  let currentSuppliedCapabilities = ["github.issues.read", "project.git.read"];
  const recordAudit = async (action, outcome, details) => {
    const auditId = `audit-${String(audits.length + 1).padStart(24, "0")}`;
    audits.push({ auditId, action, outcome, details });
    return auditId;
  };
  try {
    const manager = await createLaunchRequestManager({
      dataDir,
      hostId,
      recordAudit,
      loadLaunchContext: async () => structuredClone(currentContext),
      prepareHarness: async () => ({
        adapterId: "conformance-harness-adapter-v1",
        adapterProtocol: "1.0.0",
        adapterEntryPoint: "adapter.mjs",
        negotiatedCapabilities: ["harness.launch.prepare.v1"],
        suppliedCapabilities: structuredClone(currentSuppliedCapabilities),
        sanitizedPreview: { summary: "Sanitized conformance preview", secretFree: true },
        sideEffects: {
          delegatedWorkStarted: false,
          projectWrite: false,
          harnessWorkspaceWrite: false,
        },
      }),
      now: () => new Date(observedNow),
    });
    let preparationSequence = 0;
    const prepare = async (expiresInSeconds = 300) => {
      preparationSequence += 1;
      return manager.prepare({
        requestId: `prepare-terminal-${preparationSequence}`,
        projectId,
        parameters: { issueNumber: 119, targetBranch: "sandcastle/issue-119" },
        controllerId,
        controllerSessionId,
        authorizationClass: "focused_controller_launch",
        idempotencyKey: `prepare-terminal-${preparationSequence}`,
        expectedRevision: 0,
        expiresInSeconds,
      });
    };
    let decisionSequence = 0;
    const decide = async (launchRequest, decision = "approved") => {
      decisionSequence += 1;
      return manager.decide({
        requestId: `terminal-decision-${decisionSequence}`,
        launchRequestId: launchRequest.launchRequestId,
        decision,
        controllerId,
        controllerSessionId,
        authorizationClass: "focused_controller_launch",
        idempotencyKey: `terminal-decision-${decisionSequence}`,
        expectedRevision: launchRequest.revision,
      });
    };

    const expiring = (await prepare(1)).launchRequest;
    observedNow = new Date("2026-08-01T12:00:02.000Z");
    const expired = await decide(expiring);
    assert.equal(expired.code, "launch_request_expired");
    assert.deepEqual({ status: expired.current.status, revision: expired.current.revision }, {
      status: "expired",
      revision: 2,
    });

    observedNow = new Date("2026-08-01T12:01:00.000Z");
    const changed = (await prepare()).launchRequest;
    currentContext.project.revision = 3;
    const materiallyChanged = await decide(changed);
    assert.equal(materiallyChanged.code, "launch_request_materially_changed");
    assert.equal(materiallyChanged.current.status, "expired");

    currentContext = structuredClone(launchContext);
    const changedCapabilities = (await prepare()).launchRequest;
    currentSuppliedCapabilities = ["github.issues.read"];
    const capabilitiesMateriallyChanged = await decide(changedCapabilities);
    assert.equal(capabilitiesMateriallyChanged.code, "launch_request_materially_changed");
    assert.equal(capabilitiesMateriallyChanged.current.status, "expired");

    currentSuppliedCapabilities = ["github.issues.read", "project.git.read"];
    const rejectable = (await prepare()).launchRequest;
    const rejected = await decide(rejectable, "rejected");
    assert.equal(rejected.code, "launch_request_rejected");
    assert.equal(rejected.launchRequest.status, "rejected");
    const afterRejection = await decide(rejected.launchRequest, "approved");
    assert.equal(afterRejection.code, "launch_request_terminal");
    assert.equal(afterRejection.current.status, "rejected");

    const replacement = (await prepare()).launchRequest;
    assert.notEqual(replacement.launchRequestId, rejectable.launchRequestId);
    assert.equal(replacement.status, "pending");
    assert.equal(replacement.revision, 1);
    assert.ok(audits.some((entry) =>
      entry.action === "launch.request.expire"
      && entry.details.launchRequestId === expiring.launchRequestId
      && JSON.stringify(entry.details.parameters)
        === JSON.stringify(expiring.parameters)
      && entry.details.executionOutcome === "not_started"));
    assert.ok(audits.some((entry) =>
      entry.action === "launch.request.expire"
      && entry.details.code === "launch_request_materially_changed"
      && JSON.stringify(entry.details.parameters)
        === JSON.stringify(changed.parameters)));
    assert.ok(audits.some((entry) =>
      entry.action === "launch.request.decision"
      && entry.outcome === "accepted"
      && entry.details.decision === "rejected"
      && JSON.stringify(entry.details.parameters)
        === JSON.stringify(rejectable.parameters)));
    if (process.env.SANDKING_ACCEPTANCE_RESULT_DIR) {
      await writeFile(
        join(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, "launch-terminal-contract.json"),
        `${JSON.stringify({
          kind: "launch_terminal_contract",
          expiry: {
            launchRequestId: expiring.launchRequestId,
            code: expired.code,
            status: expired.current.status,
            revision: expired.current.revision,
          },
          materialChange: {
            launchRequestId: changed.launchRequestId,
            code: materiallyChanged.code,
            status: materiallyChanged.current.status,
          },
          rejection: {
            launchRequestId: rejectable.launchRequestId,
            code: rejected.code,
            status: rejected.launchRequest.status,
            laterDecisionCode: afterRejection.code,
          },
          replacement: {
            launchRequestId: replacement.launchRequestId,
            differsFromRejected: replacement.launchRequestId
              !== rejectable.launchRequestId,
            status: replacement.status,
            revision: replacement.revision,
          },
          auditReferences: audits,
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("durable Launch requests and preparation outcomes are never silently evicted", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-launch-durability-"));
  let auditSequence = 0;
  const recordAudit = async () => {
    auditSequence += 1;
    return `audit-${String(auditSequence).padStart(24, "0")}`;
  };
  const managerOptions = {
    dataDir,
    hostId,
    recordAudit,
    loadLaunchContext: async () => structuredClone(launchContext),
    prepareHarness: async (_context, parameters) => ({
      adapterId: "conformance-harness-adapter-v1",
      adapterProtocol: "1.0.0",
      adapterEntryPoint: "adapter.mjs",
      negotiatedCapabilities: ["harness.launch.prepare.v1"],
      suppliedCapabilities: ["github.issues.read", "project.git.read"],
      sanitizedPreview: {
        summary: `Delegate issue #${parameters.issueNumber}`,
        secretFree: true,
      },
      sideEffects: {
        delegatedWorkStarted: false,
        projectWrite: false,
        harnessWorkspaceWrite: false,
      },
    }),
    now: () => new Date("2026-08-01T12:00:00.000Z"),
  };
  try {
    const manager = await createLaunchRequestManager(managerOptions);
    let firstRequest;
    let firstOutcome;
    for (let index = 1; index <= 257; index += 1) {
      const request = {
        requestId: `prepare-durable-launch-${index}`,
        projectId,
        parameters: {
          issueNumber: index,
          targetBranch: `sandcastle/issue-${index}`,
        },
        controllerId,
        controllerSessionId,
        authorizationClass: "focused_controller_launch",
        idempotencyKey: `prepare-durable-launch-${index}`,
        expectedRevision: 0,
        expiresInSeconds: 300,
      };
      const outcome = await manager.prepare(request);
      if (index === 1) {
        firstRequest = request;
        firstOutcome = outcome;
      }
    }

    const retained = JSON.parse(await readFile(join(dataDir, "launch-requests.json"), "utf8"));
    assert.equal(retained.launchRequests.length, 257);
    assert.equal(retained.preparationOutcomes.length, 257);
    assert.equal(retained.launchRequests[0].launchRequestId,
      firstOutcome.launchRequest.launchRequestId);

    const reloadedManager = await createLaunchRequestManager(managerOptions);
    const replay = await reloadedManager.prepare({
      ...firstRequest,
      requestId: "prepare-durable-launch-1-replay",
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.launchRequest.launchRequestId,
      firstOutcome.launchRequest.launchRequestId);

    const changedKeyUse = await reloadedManager.prepare({
      ...firstRequest,
      requestId: "prepare-durable-launch-1-conflict",
      parameters: { issueNumber: 999, targetBranch: "sandcastle/issue-999" },
    });
    assert.equal(changedKeyUse.code, "idempotency_key_conflict");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
