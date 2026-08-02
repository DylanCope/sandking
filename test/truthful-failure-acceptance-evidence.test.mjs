import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  captureIssue122EvidenceSourceRevision,
  ISSUE_122_DEMONSTRATED_PATHS,
} from "./issue-122-evidence-source.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(
  new URL("../acceptance/issue-122.manifest.json", import.meta.url),
  "utf8",
));
const evidenceText = await readFile(
  new URL("../acceptance/evidence/issue-122.json", import.meta.url),
  "utf8",
);
const evidence = JSON.parse(evidenceText);

test("issue 122 evidence source requires clean demonstrated paths", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "sandking-issue-122-evidence-"));
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: fixtureRoot });
    await mkdir(join(fixtureRoot, "src"));
    await writeFile(join(fixtureRoot, "src", "failure.mjs"), "export const stale = false;\n");
    await execFileAsync("git", ["add", "src/failure.mjs"], { cwd: fixtureRoot });
    await execFileAsync("git", [
      "-c", "user.name=Sand-King Test",
      "-c", "user.email=sandking-test@example.invalid",
      "commit", "--quiet", "-m", "fixture",
    ], { cwd: fixtureRoot });
    assert.match(await captureIssue122EvidenceSourceRevision({
      repositoryRoot: fixtureRoot,
      demonstratedPaths: ["src"],
    }), /^[a-f0-9]{40}$/);
    await writeFile(join(fixtureRoot, "src", "failure.mjs"), "export const stale = true;\n");
    await assert.rejects(captureIssue122EvidenceSourceRevision({
      repositoryRoot: fixtureRoot,
      demonstratedPaths: ["src"],
    }), /issue_122_evidence_source_dirty: M src\/failure\.mjs/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("issue 122 manifest traces the complete truthful-failure slice", () => {
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.issue, 122);
  assert.equal(manifest.parentPrd, 125);
  assert.equal(manifest.sourceSpecification.issue, 116);
  assert.deepEqual(manifest.scenarios.map(({ id }) => id), [
    "local-walking-skeleton/shows-truthful-failure",
  ]);
  const scenario = manifest.scenarios[0];
  for (const requirement of [
    "#122 acceptance criteria",
    "#6 typed framing, capability, revision, idempotency, disconnection, and resynchronization outcomes",
    "#9 exactly one terminal Harness envelope, separate diagnostics, and truthful incomplete failure",
    "#14 Host-local stale views, GitHub-local stale projections, and an otherwise usable Cockpit",
    "#17 public Cockpit vertical-slice acceptance boundary",
  ]) {
    assert.ok(scenario.requirements.includes(requirement));
  }
  assert.ok(scenario.prohibitedSideEffects.includes("invented success"));
  assert.ok(scenario.prohibitedSideEffects.includes("queued or live GitHub write"));
  assert.deepEqual(manifest.verification.laterSliceExclusions, [
    "recovery-required state",
    "deterministic canonical-commit fault injection",
    "restart recovery",
    "cross-boundary recovery matrices",
  ]);
});

test("retained issue 122 evidence identifies the unchanged demonstrated revision", async () => {
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
    ...ISSUE_122_DEMONSTRATED_PATHS,
  ], { cwd: repositoryRoot });
  assert.equal(changes.trim(), "", `retained evidence predates demonstrated changes:\n${changes}`);
});

test("retained issue 122 evidence proves a truthful visible Harness failure", () => {
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.issue, 122);
  assert.equal(evidence.parentPrd, 125);
  assert.equal(evidence.scenario, "local-walking-skeleton/shows-truthful-failure");
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
    outcomeId: /^harness-outcome-[a-f0-9]{24}$/,
  })) {
    assert.match(evidence.identities[name], pattern);
  }
  assert.match(evidence.identities.harnessPin, /^[a-f0-9]{40}$/);
  assert.deepEqual({
    runStatus: evidence.visibleFailure.runStatus,
    code: evidence.visibleFailure.code,
    incompleteResult: evidence.visibleFailure.incompleteResult,
    exactlyOneTerminal: evidence.visibleFailure.exactlyOneTerminal,
    successLookingDiagnosticVisible: evidence.visibleFailure.successLookingDiagnosticVisible,
  }, {
    runStatus: "failed",
    code: "harness_result_incomplete",
    incompleteResult: true,
    exactlyOneTerminal: false,
    successLookingDiagnosticVisible: true,
  });
  assert.deepEqual(
    evidence.visibleFailure.diagnosticReferences.map((reference) => reference.producer),
    ["stdout", "stderr"],
  );
  for (const reference of evidence.visibleFailure.diagnosticReferences) {
    assert.match(reference.streamId, /^harness-log-[a-f0-9]{24}$/);
    assert.equal(reference.range.start, 0);
    assert.ok(reference.range.end > 0);
    assert.equal(reference.explicitRetrievalRequired, true);
    assert.equal(reference.insertedIntoControllerConversation, false);
  }
});

test("retained issue 122 evidence scopes Host loss and preserves canonical identities", () => {
  const stale = evidence.staleStateEvidence;
  assert.equal(stale.hostStatus, "disconnected");
  assert.deepEqual(stale.affectedViews, [
    "project-preparation",
    "harness-run-observation",
  ]);
  assert.equal(stale.retainedHarnessRunVisible, true);
  assert.equal(stale.planningHostImpact, "unaffected");
  assert.equal(stale.freshPlanningMutationSucceeded, true);
  assert.equal(stale.githubProjectionFreshness, "stale");
  assert.equal(stale.stalePlanningMutationsDisabled, true);
  assert.deepEqual(stale.resynchronizationFailure, {
    mode: "resynchronization-failed",
    cursor: "host:origin",
    reason: "host_observation_resynchronization_failed",
  });
  assert.equal(stale.typedHostMutationFailure.status, 503);
  assert.equal(stale.typedHostMutationFailure.body.code, "host_disconnected");
  assert.equal(stale.typedHostMutationFailure.body.retryable, true);
  assert.equal(stale.typedHostMutationFailure.body.idempotentReplay, false);
  assert.ok(Object.values(
    stale.typedHostMutationFailure.body.prohibitedSideEffects,
  ).every((observed) => observed === false));
  assert.deepEqual(stale.disconnectedMutationIdempotency, {
    replayStatus: 503,
    replayCode: "host_disconnected",
    replayIdempotent: true,
    replayReturnedOriginalAudit: true,
    changedContentStatus: 409,
    changedContentCode: "idempotency_key_conflict",
  });
  assert.equal(stale.typedControllerHostFailure.operation, "launch-request.prepare");
  assert.equal(stale.typedControllerHostFailure.code, "host_disconnected");
  assert.match(stale.typedControllerHostFailure.auditId, /^audit-[a-f0-9]{24}$/);

  assert.equal(evidence.canonicalStateBefore.runCount, 1);
  assert.deepEqual(evidence.canonicalStateAfter, {
    runCount: 1,
    harnessRunId: evidence.canonicalStateBefore.harnessRunId,
    outcomeId: evidence.canonicalStateBefore.outcomeId,
    eventIds: evidence.canonicalStateBefore.eventIds,
    retainedAuditIds: evidence.canonicalStateBefore.auditIds,
    launchExecution: {
      status: "failed",
      harnessRunId: evidence.canonicalStateBefore.harnessRunId,
      outcomeReference: evidence.canonicalStateBefore.outcomeId,
    },
  });
  assert.ok(evidence.canonicalStateBefore.eventIds.length >= 3);
  assert.ok(evidence.canonicalStateBefore.eventIds.every((eventId) =>
    /^harness-event-[a-f0-9]{24}$/.test(eventId)));
  assert.ok(evidence.canonicalStateBefore.auditIds.length >= 3);
  assert.ok(evidence.canonicalStateBefore.auditIds.every((auditId) =>
    /^audit-[a-f0-9]{24}$/.test(auditId)));
  assert.deepEqual(evidence.auditReferences.map(({ action, outcome }) => ({ action, outcome })), [
    { action: "harness.run.outcome", outcome: "observed" },
    { action: "host.connection", outcome: "observed" },
    { action: "project.prepare", outcome: "rejected" },
    { action: "controller.provider.operation", outcome: "rejected" },
  ]);
});

test("retained issue 122 evidence covers protocol and mutation failures", () => {
  assert.deepEqual(
    evidence.contractEvidence.protocolFailures.map(({ diagnosis }) => diagnosis.code),
    manifest.verification.typedProtocolFailures,
  );
  const launch = evidence.contractEvidence.launchDecision;
  assert.equal(launch.failures.unrelatedSession, "authorization_failed");
  assert.equal(launch.failures.staleRevision.code, "mutation_revision_conflict");
  assert.equal(launch.idempotency.replayIdempotent, true);
  assert.equal(launch.idempotency.replayReturnedOriginalAudit, true);
  assert.equal(launch.idempotency.changedContentCode, "idempotency_key_conflict");
  const activeHostLoss = evidence.contractEvidence.activeHostLoss;
  assert.equal(activeHostLoss.kind, "active_host_loss_contract");
  assert.deepEqual({
    command: activeHostLoss.packagedPublicSeam.command,
    installed: activeHostLoss.packagedPublicSeam.installed,
    launchedOutsideCheckout: activeHostLoss.packagedPublicSeam.launchedOutsideCheckout,
  }, { command: "sandking", installed: true, launchedOutsideCheckout: true });
  assert.equal(activeHostLoss.typedFailure.status, 503);
  assert.equal(activeHostLoss.typedFailure.body.code, "host_disconnected");
  assert.equal(activeHostLoss.typedFailure.body.idempotentReplay, false);
  assert.deepEqual(activeHostLoss.idempotency, {
    replayStatus: 503,
    replayCode: "host_disconnected",
    replayIdempotent: true,
    replayReturnedOriginalAudit: true,
    changedContentStatus: 409,
    changedContentCode: "idempotency_key_conflict",
  });
  assert.equal(activeHostLoss.audit.failure.auditId, activeHostLoss.typedFailure.body.auditId);
  assert.deepEqual(
    [
      activeHostLoss.audit.failure,
      activeHostLoss.audit.replay,
      activeHostLoss.audit.conflict,
    ].map(({ action, outcome, details }) => ({ action, outcome, code: details.code })),
    [
      { action: "project.prepare", outcome: "rejected", code: "host_disconnected" },
      { action: "project.prepare", outcome: "observed", code: "host_disconnected" },
      {
        action: "project.prepare",
        outcome: "rejected",
        code: "idempotency_key_conflict",
      },
    ],
  );
  const terminal = evidence.contractEvidence.launchTerminal;
  assert.equal(terminal.expiry.code, "launch_request_expired");
  assert.equal(terminal.materialChange.code, "launch_request_materially_changed");

  const failure = evidence.contractEvidence.harnessFailure;
  assert.equal(failure.incompleteResult.status, "failed");
  assert.equal(failure.incompleteResult.outcome.code, "harness_result_incomplete");
  assert.equal(failure.incompleteResult.terminalEnvelopeValidation.exactlyOne, false);
  assert.equal(
    failure.nonUniqueOrInvalidTerminal.duplicate
      .terminalEnvelopeValidation.validTerminalEnvelopeCount,
    2,
  );
  assert.equal(failure.nonUniqueOrInvalidTerminal.duplicate.status, "failed");
  assert.equal(
    failure.nonUniqueOrInvalidTerminal.invalid
      .terminalEnvelopeValidation.validTerminalEnvelopeCount,
    0,
  );
  assert.equal(
    failure.nonUniqueOrInvalidTerminal.invalid.outcome.code,
    "harness_adapter_protocol_invalid",
  );
});

test("retained issue 122 evidence is sanitized and excludes prohibited effects", () => {
  assert.ok(Object.values(evidence.prohibitedSideEffectAssertions).every(
    (observed) => observed === false,
  ));
  assert.ok(Object.values(evidence.securityAssertions).every(Boolean));
  assert.doesNotMatch(
    evidenceText,
    /truthful-failure-(?:controller-secret|environment-dump-marker)|ghp_truthfulFailure|bootstrap\?token=|sandking_session=|-----BEGIN [A-Z ]+PRIVATE KEY-----|\bError: .+\n\s+at|process\.env|SANDKING_CONTROLLER_SECRET=|GITHUB_TOKEN=/is,
  );
});
