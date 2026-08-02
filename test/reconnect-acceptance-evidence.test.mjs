import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  captureIssue121EvidenceSourceRevision,
  ISSUE_121_DEMONSTRATED_PATHS,
} from "./issue-121-evidence-source.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(
  new URL("../acceptance/issue-121.manifest.json", import.meta.url),
  "utf8",
));
const evidenceText = await readFile(
  new URL("../acceptance/evidence/issue-121.json", import.meta.url),
  "utf8",
);
const evidence = JSON.parse(evidenceText);

test("issue 121 evidence source requires clean demonstrated paths", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "sandking-issue-121-evidence-"));
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: fixtureRoot });
    await mkdir(join(fixtureRoot, "src"));
    await writeFile(join(fixtureRoot, "src", "run.mjs"), "export const ready = false;\n");
    await execFileAsync("git", ["add", "src/run.mjs"], { cwd: fixtureRoot });
    await execFileAsync("git", [
      "-c", "user.name=Sand-King Test",
      "-c", "user.email=sandking-test@example.invalid",
      "commit", "--quiet", "-m", "fixture",
    ], { cwd: fixtureRoot });
    assert.match(await captureIssue121EvidenceSourceRevision({
      repositoryRoot: fixtureRoot,
      demonstratedPaths: ["src"],
    }), /^[a-f0-9]{40}$/);
    await writeFile(join(fixtureRoot, "src", "run.mjs"), "export const ready = true;\n");
    await assert.rejects(captureIssue121EvidenceSourceRevision({
      repositoryRoot: fixtureRoot,
      demonstratedPaths: ["src"],
    }), /issue_121_evidence_source_dirty: M src\/run\.mjs/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("issue 121 manifest traces the complete canonical reconnect slice", () => {
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.issue, 121);
  assert.equal(manifest.parentPrd, 125);
  assert.equal(manifest.sourceSpecification.issue, 116);
  assert.equal(
    manifest.sourceSpecification.parentApprovedTextExportSha256,
    "bf695dc3483e1d8b2e6a67a011ac7c77bfae7f3d96d596598803862c1e496a23",
  );
  assert.deepEqual(manifest.scenarios.map(({ id }) => id), [
    "local-walking-skeleton/reconnects-to-canonical-state",
  ]);
  const scenario = manifest.scenarios[0];
  for (const requirement of [
    "#116 stories 21-24 and 41-44",
    "#121 acceptance criteria",
    "#6 acknowledged cursor resume, explicit history gaps, mutation lookup, ranged logs, and idempotent canonical outcomes",
    "#11 invariant-based reconnect verification and retained sanitized evidence",
    "#14 one reusable runtime, resumable browser events, and runtime-owned provider PTY reconnection",
    "#17 cockpit-visible vertical-slice acceptance boundary",
  ]) {
    assert.ok(scenario.requirements.includes(requirement));
  }
  assert.deepEqual(manifest.verification.typedResynchronization, {
    code: "resync-required",
    reasons: ["cursor_incompatible", "history_gap"],
    canonicalSnapshot: true,
  });
  assert.deepEqual(manifest.verification.laterSliceExclusions, [
    "daemon-restart supervision",
    "cross-Controller ownership",
    "complete projection rebuilding",
    "recovery-required workflows",
  ]);
  for (const effect of [
    "duplicate Controller runtime",
    "duplicate provider session",
    "duplicate Project registration",
    "duplicate Launch request or Launch decision",
    "duplicate Harness run",
    "invented gap-free continuity",
    "new mutation identity after ambiguous response",
  ]) {
    assert.ok(scenario.prohibitedSideEffects.includes(effect));
  }
});

test("retained issue 121 evidence identifies the unchanged demonstrated revision", async () => {
  const { stdout: resolvedCommit } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", `${evidence.generatedFromCommit}^{commit}`],
    { cwd: repositoryRoot },
  );
  assert.equal(resolvedCommit.trim(), evidence.generatedFromCommit);
  await execFileAsync("git", [
    "merge-base", "--is-ancestor", evidence.generatedFromCommit, "HEAD",
  ], { cwd: repositoryRoot });
  const { stdout: changes } = await execFileAsync("git", [
    "diff", "--name-only", `${evidence.generatedFromCommit}..HEAD`, "--",
    ...ISSUE_121_DEMONSTRATED_PATHS,
  ], { cwd: repositoryRoot });
  assert.equal(changes.trim(), "", `retained evidence predates demonstrated changes:\n${changes}`);
});

test("retained issue 121 evidence proves one reattached canonical completed run", () => {
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.issue, 121);
  assert.equal(evidence.parentPrd, 125);
  assert.equal(evidence.scenario, "local-walking-skeleton/reconnects-to-canonical-state");
  assert.deepEqual(evidence.sourceSpecification, {
    ...manifest.sourceSpecification,
    normalizationDifference: "one terminal LF",
    exactContentEquivalentAfterApprovedExportNormalization: true,
  });
  assert.deepEqual({
    command: evidence.packagedPublicSeam.command,
    installed: evidence.packagedPublicSeam.installed,
    launchedOutsideCheckout: evidence.packagedPublicSeam.launchedOutsideCheckout,
  }, { command: "sandking", installed: true, launchedOutsideCheckout: true });

  for (const [name, pattern] of Object.entries({
    runtimeId: /^runtime-[a-f0-9]{24}$/,
    hostId: /^host-[a-f0-9]{24}$/,
    projectId: /^project-[a-f0-9]{24}$/,
    harnessId: /^harness-[a-f0-9]{24}$/,
    launchRequestId: /^launch-request-[a-f0-9]{24}$/,
    harnessRunId: /^harness-run-[a-f0-9]{24}$/,
    controllerSessionId: /^controller-session-[a-f0-9]{24}$/,
    providerSessionId: /^conformance-provider-session-[a-f0-9]{24}$/,
  })) {
    assert.match(evidence.identities[name], pattern);
  }
  assert.match(evidence.identities.harnessPin, /^[a-f0-9]{40}$/);

  const { project, launchRequest, harnessRun, runtime } = evidence.canonicalState;
  assert.equal(runtime.runtimeId, evidence.identities.runtimeId);
  assert.ok(Number.isSafeInteger(runtime.pid) && runtime.pid > 0);
  assert.equal(project.projectId, evidence.identities.projectId);
  assert.equal(project.harness.harnessId, evidence.identities.harnessId);
  assert.equal(project.harness.pinnedRevision, evidence.identities.harnessPin);
  assert.equal(launchRequest.launchRequestId, evidence.identities.launchRequestId);
  assert.equal(launchRequest.project.projectId, project.projectId);
  assert.equal(launchRequest.owner.controllerId, runtime.runtimeId);
  assert.equal(
    launchRequest.owner.controllerSessionId,
    evidence.identities.controllerSessionId,
  );
  assert.equal(launchRequest.status, "approved");
  assert.equal(launchRequest.execution.status, "succeeded");
  assert.equal(launchRequest.execution.harnessRunId, harnessRun.harnessRunId);
  assert.equal(harnessRun.harnessRunId, evidence.identities.harnessRunId);
  assert.equal(harnessRun.projectId, project.projectId);
  assert.equal(harnessRun.launchRequestId, launchRequest.launchRequestId);
  assert.equal(harnessRun.controllerSessionId, evidence.identities.controllerSessionId);
  assert.deepEqual(harnessRun.events.map(({ sequence, type }) => ({ sequence, type })), [
    { sequence: 1, type: "harness_run_created" },
    { sequence: 2, type: "harness_adapter_ready" },
    { sequence: 3, type: "harness_progress_published" },
    { sequence: 4, type: "harness_run_succeeded" },
  ]);
  assert.deepEqual(harnessRun.logStreams.map(({ producer }) => producer), ["stdout", "stderr"]);
  assert.ok(harnessRun.logStreams.every(({ explicitRetrievalRequired }) =>
    explicitRetrievalRequired));
  assert.ok(harnessRun.logStreams.every(({ insertedIntoControllerConversation }) =>
    insertedIntoControllerConversation === false));
  assert.equal(harnessRun.outcome.status, "succeeded");
  assert.equal(harnessRun.outcome.incompleteResult, false);
  assert.equal(
    launchRequest.execution.outcomeReference,
    harnessRun.outcome.outcomeId,
  );
  assert.equal(evidence.observation.controllerSessionReattached, true);
  assert.deepEqual(evidence.observation.orderedEventSequences, [1, 2, 3, 4]);
  assert.deepEqual(evidence.observation.separateLogProducers, ["stdout", "stderr"]);
  assert.equal(evidence.observation.structuredOutcome.outcomeId, harnessRun.outcome.outcomeId);

  assert.equal(evidence.auditReferences.approval.action, "launch.request.decision");
  assert.equal(evidence.auditReferences.approval.outcome, "accepted");
  assert.equal(
    evidence.auditReferences.approval.auditId,
    launchRequest.decision.auditId,
  );
  assert.equal(evidence.auditReferences.start.action, "harness.run.start");
  assert.equal(evidence.auditReferences.start.outcome, "accepted");
  assert.equal(evidence.auditReferences.start.auditId, harnessRun.startAuditId);
  assert.equal(evidence.auditReferences.outcome.action, "harness.run.outcome");
  assert.equal(
    evidence.auditReferences.outcome.details.outcomeReference,
    harnessRun.outcome.outcomeId,
  );
});

test("retained issue 121 evidence proves cursor truth and no duplicate keyed work", () => {
  const runId = evidence.identities.harnessRunId;
  assert.equal(evidence.cursors.beforeRefresh.harnessRunId, runId);
  assert.ok(evidence.cursors.beforeRefresh.sequence >= 1);
  assert.equal(evidence.cursors.afterResume.harnessRunId, runId);
  assert.equal(evidence.cursors.afterResume.sequence, 4);
  assert.equal(evidence.cursors.incompatible.harnessRunId, runId);
  assert.deepEqual(evidence.cursors.resynchronization, {
    code: "resync-required",
    reason: "cursor_incompatible",
    canonicalSnapshot: true,
    orderedEventSequences: [1, 2, 3, 4],
  });

  const continuity = evidence.contractEvidence.harnessRun.continuity;
  assert.deepEqual(continuity.resume, {
    mode: "resume",
    acknowledgedSequence: 2,
    returnedEventSequences: [3, 4],
    nextSequence: 4,
  });
  assert.deepEqual({
    code: continuity.incompatibleCursor.code,
    mode: continuity.incompatibleCursor.mode,
    reason: continuity.incompatibleCursor.resynchronization.reason,
    canonicalSnapshot: continuity.incompatibleCursor.resynchronization.canonicalSnapshot,
    returnedEventSequences: continuity.incompatibleCursor.returnedEventSequences,
  }, {
    code: "resync-required",
    mode: "resync-required",
    reason: "cursor_incompatible",
    canonicalSnapshot: true,
    returnedEventSequences: [1, 2, 3, 4],
  });
  assert.deepEqual({
    code: continuity.historyGap.code,
    mode: continuity.historyGap.mode,
    reason: continuity.historyGap.resynchronization.reason,
    canonicalSnapshot: continuity.historyGap.resynchronization.canonicalSnapshot,
  }, {
    code: "resync-required",
    mode: "resync-required",
    reason: "history_gap",
    canonicalSnapshot: true,
  });

  assert.deepEqual(evidence.contractEvidence.launchDecision.idempotency, {
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
  assert.deepEqual(evidence.contractEvidence.harnessRun.idempotency, {
    replayCode: "harness_run_created",
    replayIdempotent: true,
    replayReturnedCanonicalRun: true,
    replayReturnedOriginalAudit: true,
    changedContentCode: "idempotency_key_conflict",
    lookupCode: "harness_run_start_outcome_found",
    lookupReturnedCanonicalRun: true,
    differentKeyFoundCode: "harness_run_found",
    differentKeyReturnedCanonicalRun: true,
    postExpiryFoundCode: "harness_run_found",
    postExpiryReturnedCanonicalRun: true,
  });
  const ambiguousRecovery = evidence.contractEvidence.ambiguousMutationLookup;
  assert.equal(ambiguousRecovery.kind, "ambiguous_mutation_lookup_contract");
  assert.equal(ambiguousRecovery.operation, "harness-run.start");
  assert.equal(
    ambiguousRecovery.publicSeam,
    "packaged Cockpit -> runtime-owned provider PTY -> Controller runtime -> framed local Host",
  );
  assert.deepEqual(ambiguousRecovery.ambiguousResponse, {
    code: "provider_operation_timeout",
    providerDeadlineMs: 3_000,
    acceptedHostResponseDelayMs: 3_250,
  });
  assert.equal(ambiguousRecovery.lookupOperation, "harness-run.lookup");
  assert.match(ambiguousRecovery.lookupOperationAuditId, /^audit-[a-f0-9]{24}$/);
  assert.match(ambiguousRecovery.idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    ambiguousRecovery.idempotencyKeyHash,
    evidence.auditReferences.start.details.idempotencyKeyHash,
  );
  assert.equal(ambiguousRecovery.lookupUsedSameIdempotencyKey, true);
  assert.equal(
    ambiguousRecovery.lookupReturnedExistingHarnessRunId,
    evidence.identities.harnessRunId,
  );
  assert.equal(ambiguousRecovery.canonicalStartAuditId, evidence.auditReferences.start.auditId);
  assert.equal(ambiguousRecovery.startRequestsBeforeRecoveryReturned, 1);
  assert.equal(ambiguousRecovery.canonicalStartEffectsBeforeRecoveryReturned, 1);
  assert.equal(ambiguousRecovery.canonicalRunCountBeforeRecoveryReturned, 1);
  assert.equal(ambiguousRecovery.canonicalStartOutcomeCountBeforeRecoveryReturned, 1);
  assert.equal(ambiguousRecovery.duplicateStartRequestedDuringRecovery, false);
  assert.equal(ambiguousRecovery.visibleCanonicalRecovery, true);
  assert.deepEqual(evidence.duplicateEffectAssertions, {
    runtimeCount: 1,
    providerSessionCount: 1,
    projectRegistrationCount: 1,
    launchRequestCount: 1,
    launchDecisionCount: 1,
    harnessRunCount: 1,
    startOutcomeCount: 1,
  });
  assert.ok(Object.values(evidence.prohibitedSideEffectAssertions).every((value) =>
    value === false));
  assert.doesNotMatch(
    evidenceText,
    /canonical-reconnect-browser-secret|bootstrap\?token=|sandking_session=|provider:controller-session/i,
  );
});
