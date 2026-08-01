import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  captureIssue119EvidenceSourceRevision,
  ISSUE_119_DEMONSTRATED_PATHS,
} from "./issue-119-evidence-source.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(
  new URL("../acceptance/issue-119.manifest.json", import.meta.url),
  "utf8",
));
const evidenceText = await readFile(
  new URL("../acceptance/evidence/issue-119.json", import.meta.url),
  "utf8",
);
const evidence = JSON.parse(evidenceText);

test("issue 119 evidence source revision requires clean demonstrated paths", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "sandking-issue-119-evidence-"));
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: fixtureRoot });
    await mkdir(join(fixtureRoot, "src"));
    await writeFile(join(fixtureRoot, "src", "launch.mjs"), "export const ready = false;\n");
    await execFileAsync("git", ["add", "src/launch.mjs"], { cwd: fixtureRoot });
    await execFileAsync("git", [
      "-c", "user.name=Sand-King Test",
      "-c", "user.email=sandking-test@example.invalid",
      "commit", "--quiet", "-m", "fixture",
    ], { cwd: fixtureRoot });
    assert.match(await captureIssue119EvidenceSourceRevision({
      repositoryRoot: fixtureRoot,
      demonstratedPaths: ["src"],
    }), /^[a-f0-9]{40}$/);
    await writeFile(join(fixtureRoot, "src", "launch.mjs"), "export const ready = true;\n");
    await assert.rejects(captureIssue119EvidenceSourceRevision({
      repositoryRoot: fixtureRoot,
      demonstratedPaths: ["src"],
    }), /issue_119_evidence_source_dirty: M src\/launch\.mjs/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("issue 119 manifest drives the focused immutable Launch approval scenario", () => {
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.issue, 119);
  assert.equal(manifest.parentPrd, 125);
  assert.deepEqual(manifest.sourceSpecification, {
    issue: 116,
    githubBodyUtf8Sha256: "34ebbde096564621b14a68d4bc64cdbd8ba9e448a42cb75c084d80c0e201308a",
    parentApprovedTextExportSha256:
      "bf695dc3483e1d8b2e6a67a011ac7c77bfae7f3d96d596598803862c1e496a23",
    parentApprovedHashBasis: "exact GitHub body UTF-8 plus one terminal LF",
  });
  assert.deepEqual(manifest.scenarios.map((scenario) => scenario.id), [
    "local-walking-skeleton/completes-approved-run",
  ]);
  assert.ok(manifest.scenarios[0].requirements.includes("#119 acceptance criteria"));
  assert.ok(manifest.scenarios[0].requirements.includes(
    "#8 focused in-conversation approval and audit boundaries",
  ));
  assert.ok(manifest.scenarios[0].requirements.includes(
    "#14 runtime-owned PTY and browser authorization boundary",
  ));
  assert.ok(manifest.scenarios[0].prohibitedSideEffects.includes(
    "browser approval assertion",
  ));
  assert.ok(manifest.verification.commands.flat().includes(
    "test/launch-request.browser.test.mjs",
  ));
  assert.ok(manifest.verification.typedDecisionFailures.includes(
    "launch_request_materially_changed",
  ));
  assert.ok(manifest.verification.typedControllerSessionFailures.includes(
    "mutation_revision_conflict",
  ));
  assert.ok(manifest.verification.typedControllerSessionFailures.includes(
    "provider_adapter_failed",
  ));
});

test("retained issue 119 evidence identifies the unchanged demonstrated revision", async () => {
  const { stdout: resolvedCommit } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", `${evidence.generatedFromCommit}^{commit}`],
    { cwd: repositoryRoot },
  );
  assert.equal(resolvedCommit.trim(), evidence.generatedFromCommit);
  await execFileAsync("git", [
    "merge-base", "--is-ancestor", evidence.generatedFromCommit, "HEAD",
  ], { cwd: repositoryRoot });
  const { stdout: demonstratedPathChanges } = await execFileAsync("git", [
    "diff", "--name-only", `${evidence.generatedFromCommit}..HEAD`, "--",
    ...ISSUE_119_DEMONSTRATED_PATHS,
  ], { cwd: repositoryRoot });
  assert.equal(demonstratedPathChanges.trim(), "",
    `retained evidence predates demonstrated product-path changes:\n${demonstratedPathChanges}`);
});

test("retained issue 119 evidence proves the immutable request and focused approval", () => {
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.issue, 119);
  assert.equal(evidence.parentPrd, 125);
  assert.equal(evidence.scenario, "local-walking-skeleton/completes-approved-run");
  assert.deepEqual(evidence.sourceSpecification, {
    ...manifest.sourceSpecification,
    normalizationDifference: "one terminal LF",
    exactContentEquivalentAfterApprovedExportNormalization: true,
  });
  assert.deepEqual({
    command: evidence.packagedPublicSeam.command,
    installed: evidence.packagedPublicSeam.installed,
    launchedOutsideCheckout: evidence.packagedPublicSeam.launchedOutsideCheckout,
  }, {
    command: "sandking",
    installed: true,
    launchedOutsideCheckout: true,
  });
  assert.match(evidence.packagedPublicSeam.tarballSha256, /^[a-f0-9]{64}$/);
  for (const [name, pattern] of Object.entries({
    hostId: /^host-[a-f0-9]{24}$/,
    projectId: /^project-[a-f0-9]{24}$/,
    harnessId: /^harness-[a-f0-9]{24}$/,
    launchRequestId: /^launch-request-[a-f0-9]{24}$/,
    controllerId: /^runtime-[a-f0-9]{24}$/,
    controllerSessionId: /^controller-session-[a-f0-9]{24}$/,
    providerSessionId: /^conformance-provider-session-[a-f0-9]{24}$/,
  })) {
    assert.match(evidence.identities[name], pattern);
  }

  const request = evidence.launchRequest;
  assert.equal(request.launchRequestId, evidence.identities.launchRequestId);
  assert.equal(request.status, "approved");
  assert.equal(request.revision, 2);
  assert.equal(request.singleUse, true);
  assert.equal(request.host.hostId, evidence.identities.hostId);
  assert.deepEqual(request.project, {
    projectId: evidence.identities.projectId,
    revision: 2,
    displayName: "selected-project",
  });
  assert.equal(request.harness.harnessId, evidence.identities.harnessId);
  assert.match(request.harness.pinnedRevision, /^[a-f0-9]{40}$/);
  assert.deepEqual(request.parameters, {
    issueNumber: 119,
    targetBranch: "sandcastle/issue-119",
  });
  assert.deepEqual(request.suppliedCapabilities, [
    "github.issues.read",
    "project.git.read",
  ]);
  assert.equal(request.authorizationClass, "focused_controller_launch");
  assert.deepEqual(request.owner, {
    controllerId: evidence.identities.controllerId,
    controllerSessionId: evidence.identities.controllerSessionId,
  });
  assert.equal(request.capturedPreconditions.hostId, evidence.identities.hostId);
  assert.equal(request.capturedPreconditions.projectRevision, 2);
  assert.equal(request.capturedPreconditions.harnessId, evidence.identities.harnessId);
  assert.equal(request.capturedPreconditions.harnessPinnedRevision,
    request.harness.pinnedRevision);
  assert.match(request.capturedPreconditions.boundedConfigurationDigest,
    /^sha256:[a-f0-9]{64}$/);
  assert.match(request.capturedPreconditions.suppliedCapabilitiesDigest,
    /^sha256:[a-f0-9]{64}$/);
  assert.equal(request.preview.revision, 1);
  assert.equal(request.preview.secretFree, true);
  assert.equal(request.preview.delegatedWorkStarted, false);
  assert.equal(request.decision.decision, "approved");
  assert.equal(request.decision.expectedRevision, 1);
  assert.equal(request.decision.controllerSessionId, evidence.identities.controllerSessionId);
  assert.deepEqual(request.execution, {
    status: "not_started",
    harnessRunId: null,
    outcomeReference: null,
  });
  assert.deepEqual(evidence.decision.browserApproval, {
    status: 404,
    body: { code: "not_found" },
  });
  assert.deepEqual(evidence.decision.staleRevision, {
    code: "mutation_revision_conflict",
    actualRevision: 1,
  });
});

test("retained issue 119 evidence proves authorization, idempotency, and terminality", () => {
  assert.deepEqual({
    concurrentStatuses: evidence.sessionCreation.concurrentStatuses,
    freshOutcomes: evidence.sessionCreation.freshOutcomes,
    replayOutcomes: evidence.sessionCreation.replayOutcomes,
    oneOriginalAudit: evidence.sessionCreation.oneOriginalAudit,
  }, {
    concurrentStatuses: [200, 201],
    freshOutcomes: 1,
    replayOutcomes: 1,
    oneOriginalAudit: true,
  });
  assert.match(evidence.sessionCreation.canonicalSessionId,
    /^controller-session-[a-f0-9]{24}$/);
  assert.deepEqual({
    code: evidence.sessionCreation.failedAttempt.code,
    replayCode: evidence.sessionCreation.failedAttempt.replayCode,
    replayIdempotent: evidence.sessionCreation.failedAttempt.replayIdempotent,
    replayReturnedOriginalAudit:
      evidence.sessionCreation.failedAttempt.replayReturnedOriginalAudit,
    changedContentCode: evidence.sessionCreation.failedAttempt.changedContentCode,
    noSessionCreated: evidence.sessionCreation.failedAttempt.noSessionCreated,
  }, {
    code: "mutation_revision_conflict",
    replayCode: "mutation_revision_conflict",
    replayIdempotent: true,
    replayReturnedOriginalAudit: true,
    changedContentCode: "idempotency_key_conflict",
    noSessionCreated: true,
  });
  assert.match(evidence.sessionCreation.failedAttempt.auditId, /^audit-[a-f0-9]{24}$/);
  assert.match(evidence.sessionCreation.failedAttempt.replayAuditId, /^audit-[a-f0-9]{24}$/);
  assert.deepEqual({
    code: evidence.sessionCreation.providerStartFailure.code,
    replayCode: evidence.sessionCreation.providerStartFailure.replayCode,
    replayIdempotent: evidence.sessionCreation.providerStartFailure.replayIdempotent,
    replayReturnedOriginalAudit:
      evidence.sessionCreation.providerStartFailure.replayReturnedOriginalAudit,
    changedContentCode: evidence.sessionCreation.providerStartFailure.changedContentCode,
    noSessionCreated: evidence.sessionCreation.providerStartFailure.noSessionCreated,
  }, {
    code: "provider_adapter_failed",
    replayCode: "provider_adapter_failed",
    replayIdempotent: true,
    replayReturnedOriginalAudit: true,
    changedContentCode: "idempotency_key_conflict",
    noSessionCreated: true,
  });
  assert.match(evidence.sessionCreation.providerStartFailure.auditId,
    /^audit-[a-f0-9]{24}$/);
  assert.match(evidence.sessionCreation.providerStartFailure.replayAuditId,
    /^audit-[a-f0-9]{24}$/);
  assert.deepEqual({
    code: evidence.invalidPreparation.code,
    issueNumber: evidence.invalidPreparation.issueNumber,
    retainedHostOutcome: evidence.invalidPreparation.retainedHostOutcome,
    replayIdempotent: evidence.invalidPreparation.replayIdempotent,
    replayReturnedOriginalAudit: evidence.invalidPreparation.replayReturnedOriginalAudit,
    delegatedWorkStarted: evidence.invalidPreparation.delegatedWorkStarted,
  }, {
    code: "bounded_configuration_invalid",
    issueNumber: 1_000_000_000,
    retainedHostOutcome: true,
    replayIdempotent: true,
    replayReturnedOriginalAudit: true,
    delegatedWorkStarted: false,
  });
  assert.match(evidence.invalidPreparation.auditId, /^audit-[a-f0-9]{24}$/);
  assert.match(evidence.invalidPreparation.replayAuditId, /^audit-[a-f0-9]{24}$/);
  assert.deepEqual({
    code: evidence.overlongPreparation.code,
    issueDigitCount: evidence.overlongPreparation.issueDigitCount,
    branchLength: evidence.overlongPreparation.branchLength,
    retainedHostOutcome: evidence.overlongPreparation.retainedHostOutcome,
    replayIdempotent: evidence.overlongPreparation.replayIdempotent,
    replayReturnedOriginalAudit: evidence.overlongPreparation.replayReturnedOriginalAudit,
    delegatedWorkStarted: evidence.overlongPreparation.delegatedWorkStarted,
  }, {
    code: "bounded_configuration_invalid",
    issueDigitCount: 400,
    branchLength: 417,
    retainedHostOutcome: true,
    replayIdempotent: true,
    replayReturnedOriginalAudit: true,
    delegatedWorkStarted: false,
  });
  assert.match(evidence.overlongPreparation.auditId, /^audit-[a-f0-9]{24}$/);
  assert.match(evidence.overlongPreparation.replayAuditId, /^audit-[a-f0-9]{24}$/);
  assert.deepEqual({
    kind: evidence.materialDeviation.kind,
    code: evidence.materialDeviation.code,
    status: evidence.materialDeviation.status,
    revision: evidence.materialDeviation.revision,
  }, {
    kind: "project_path_replaced",
    code: "launch_request_materially_changed",
    status: "expired",
    revision: 2,
  });
  assert.match(evidence.materialDeviation.auditId, /^audit-[a-f0-9]{24}$/);

  const decision = evidence.contractEvidence.decision;
  assert.equal(decision.kind, "launch_decision_contract");
  assert.deepEqual(decision.approved.execution, {
    status: "not_started",
    harnessRunId: null,
    outcomeReference: null,
  });
  assert.deepEqual(decision.idempotency, {
    replayCode: "launch_request_approved",
    replayIdempotent: true,
    replayReturnedOriginalAudit: true,
    replayReturnedOriginalDecision: true,
    changedContentCode: "idempotency_key_conflict",
    failedReplayCode: "mutation_revision_conflict",
    failedReplayIdempotent: true,
    failedReplayReturnedOriginalAudit: true,
    failedChangedContentCode: "idempotency_key_conflict",
  });
  assert.equal(decision.failures.unrelatedSession, "authorization_failed");
  assert.equal(decision.failures.staleRevision.code, "mutation_revision_conflict");
  assert.equal(decision.failures.staleRevision.actualRevision, 1);
  assert.equal(decision.failures.staleRevision.sanitizedSummary.secretFree, true);
  assert.deepEqual(decision.failures.laterDecision, {
    code: "launch_request_terminal",
    status: "approved",
  });

  const terminal = evidence.contractEvidence.terminal;
  assert.equal(terminal.kind, "launch_terminal_contract");
  assert.deepEqual({
    code: terminal.expiry.code,
    status: terminal.expiry.status,
    revision: terminal.expiry.revision,
  }, {
    code: "launch_request_expired",
    status: "expired",
    revision: 2,
  });
  assert.deepEqual({
    code: terminal.materialChange.code,
    status: terminal.materialChange.status,
  }, {
    code: "launch_request_materially_changed",
    status: "expired",
  });
  assert.deepEqual({
    code: terminal.rejection.code,
    status: terminal.rejection.status,
    laterDecisionCode: terminal.rejection.laterDecisionCode,
  }, {
    code: "launch_request_rejected",
    status: "rejected",
    laterDecisionCode: "launch_request_terminal",
  });
  assert.equal(terminal.replacement.differsFromRejected, true);
  assert.equal(terminal.replacement.status, "pending");
  assert.equal(terminal.replacement.revision, 1);
});

test("retained issue 119 evidence proves PTY ownership, audit linkage, and secret safety", () => {
  assert.deepEqual(evidence.terminal, {
    streamId: evidence.terminal.streamId,
    runtimeOwned: true,
    survivesBrowserDisconnection: true,
    writableAttachment: "exclusive",
    competingWritableRejectedAs: "terminal_write_attachment_conflict",
    secondaryView: { mode: "read-only", exclusive: false },
  });
  assert.match(evidence.terminal.streamId, /^controller-terminal-[a-f0-9]{24}$/);
  assert.ok(evidence.auditReferences.some((entry) =>
    entry.action === "controller.provider.operation"
    && entry.outcome === "accepted"
    && entry.details.operation === "launch-request.decide"));
  const approval = evidence.auditReferences.find((entry) =>
    entry.auditId === evidence.decision.auditId);
  assert.equal(approval.action, "launch.request.decision");
  assert.equal(approval.outcome, "accepted");
  assert.equal(approval.details.launchRequestId, evidence.identities.launchRequestId);
  assert.equal(approval.details.hostId, evidence.identities.hostId);
  assert.equal(approval.details.projectId, evidence.identities.projectId);
  assert.equal(approval.details.harnessId, evidence.identities.harnessId);
  assert.equal(approval.details.controllerId, evidence.identities.controllerId);
  assert.equal(approval.details.controllerSessionId, evidence.identities.controllerSessionId);
  assert.equal(approval.details.expectedRevision, 1);
  assert.equal(approval.details.resultingRevision, 2);
  assert.deepEqual(approval.details.parameters, evidence.launchRequest.parameters);
  assert.equal(approval.details.decision, "approved");
  assert.equal(approval.details.executionOutcome, "not_started");
  assert.equal(approval.details.outcomeReference, null);
  const terminalRequestAudits = evidence.contractEvidence.terminal.auditReferences.filter((entry) =>
    entry.action === "launch.request.expire"
    || (entry.action === "launch.request.decision"
      && entry.outcome === "accepted"
      && entry.details.decision === "rejected"));
  assert.ok(terminalRequestAudits.length >= 3);
  assert.ok(terminalRequestAudits.every((entry) =>
    JSON.stringify(entry.details.parameters)
      === JSON.stringify(evidence.launchRequest.parameters)));
  assert.ok(Object.values(evidence.securityAssertions).every(Boolean));
  assert.ok(Object.values(evidence.prohibitedSideEffectAssertions).every(
    (observed) => observed === false,
  ));
  assert.doesNotMatch(evidenceText,
    /launch-browser-secret|bootstrap\?token=|sandking_session=|provider:controller-session/i);
});
