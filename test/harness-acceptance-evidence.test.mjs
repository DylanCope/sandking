import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  captureIssue120EvidenceSourceRevision,
  ISSUE_120_DEMONSTRATED_PATHS,
} from "./issue-120-evidence-source.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(
  new URL("../acceptance/issue-120.manifest.json", import.meta.url),
  "utf8",
));
const evidenceText = await readFile(
  new URL("../acceptance/evidence/issue-120.json", import.meta.url),
  "utf8",
);
const evidence = JSON.parse(evidenceText);

test("issue 120 evidence source revision requires clean demonstrated paths", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "sandking-issue-120-evidence-"));
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
    assert.match(await captureIssue120EvidenceSourceRevision({
      repositoryRoot: fixtureRoot,
      demonstratedPaths: ["src"],
    }), /^[a-f0-9]{40}$/);
    await writeFile(join(fixtureRoot, "src", "run.mjs"), "export const ready = true;\n");
    await assert.rejects(captureIssue120EvidenceSourceRevision({
      repositoryRoot: fixtureRoot,
      demonstratedPaths: ["src"],
    }), /issue_120_evidence_source_dirty: M src\/run\.mjs/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("issue 120 manifest traces the approved supervised Harness scenario", () => {
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.issue, 120);
  assert.equal(manifest.parentPrd, 125);
  assert.equal(manifest.sourceSpecification.issue, 116);
  assert.equal(
    manifest.sourceSpecification.parentApprovedTextExportSha256,
    "bf695dc3483e1d8b2e6a67a011ac7c77bfae7f3d96d596598803862c1e496a23",
  );
  assert.deepEqual(manifest.scenarios.map(({ id }) => id), [
    "local-walking-skeleton/completes-approved-run",
  ]);
  const scenario = manifest.scenarios[0];
  for (const requirement of [
    "#116 stories 17-21, 27, 35-36, and 41-44",
    "#120 acceptance criteria",
    "#9 versioned dedicated Harness-adapter channel, diagnostics, and truthful terminal outcome",
    "#17 cockpit-visible vertical-slice acceptance boundary",
  ]) {
    assert.ok(scenario.requirements.includes(requirement));
  }
  assert.ok(scenario.prohibitedSideEffects.includes("duplicate Harness run"));
  assert.ok(scenario.prohibitedSideEffects.includes("success inferred from process exit or log text"));
  assert.ok(scenario.actions.some((action) => action.includes("257 distinct keyed start outcomes")));
  assert.ok(manifest.verification.typedStartFailures.includes("launch_request_unapproved"));
  assert.ok(manifest.verification.typedStartFailures.includes("launch_request_stale"));
  assert.ok(manifest.verification.truthfulTerminalFailures.includes("harness_result_incomplete"));
});

test("retained issue 120 evidence identifies the unchanged demonstrated revision", async () => {
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
    ...ISSUE_120_DEMONSTRATED_PATHS,
  ], { cwd: repositoryRoot });
  assert.equal(changes.trim(), "", `retained evidence predates demonstrated changes:\n${changes}`);
});

test("retained issue 120 evidence proves one observable pinned successful run", () => {
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.issue, 120);
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
  }, { command: "sandking", installed: true, launchedOutsideCheckout: true });

  for (const [name, pattern] of Object.entries({
    hostId: /^host-[a-f0-9]{24}$/,
    projectId: /^project-[a-f0-9]{24}$/,
    harnessId: /^harness-[a-f0-9]{24}$/,
    launchRequestId: /^launch-request-[a-f0-9]{24}$/,
    harnessRunId: /^harness-run-[a-f0-9]{24}$/,
    controllerId: /^runtime-[a-f0-9]{24}$/,
    controllerSessionId: /^controller-session-[a-f0-9]{24}$/,
  })) {
    assert.match(evidence.identities[name], pattern);
  }
  assert.match(evidence.identities.harnessPin, /^[a-f0-9]{40}$/);

  const run = evidence.run;
  assert.equal(run.harnessRunId, evidence.identities.harnessRunId);
  assert.equal(run.status, "succeeded");
  assert.equal(run.launchRequestId, evidence.identities.launchRequestId);
  assert.equal(run.hostId, evidence.identities.hostId);
  assert.equal(run.projectId, evidence.identities.projectId);
  assert.equal(run.harnessId, evidence.identities.harnessId);
  assert.equal(run.harnessPinnedRevision, evidence.identities.harnessPin);
  assert.equal(run.adapterId, "conformance-harness-adapter-v1");
  assert.equal(run.adapterProtocol, "1.0.0");
  assert.equal(run.adapterEntryPoint, "adapters/conformance.mjs");
  assert.deepEqual(run.events.map(({ sequence, type }) => ({ sequence, type })), [
    { sequence: 1, type: "harness_run_created" },
    { sequence: 2, type: "harness_adapter_ready" },
    { sequence: 3, type: "harness_progress_published" },
    { sequence: 4, type: "harness_run_succeeded" },
  ]);
  assert.equal(run.outcome.status, "succeeded");
  assert.equal(run.outcome.incompleteResult, false);
  assert.equal(run.outcome.terminalEnvelope.status, "succeeded");
  assert.deepEqual(run.terminalEnvelopeValidation, {
    adapterReadyObserved: true,
    validTerminalEnvelopeCount: 1,
    exactlyOne: true,
    adapterChannelClosedObserved: true,
    processExitObserved: true,
  });
  assert.deepEqual(run.logStreams.map(({ producer }) => producer), ["stdout", "stderr"]);
  assert.ok(run.logStreams.every(({ explicitRetrievalRequired }) => explicitRetrievalRequired));
  assert.ok(run.logStreams.every(({ insertedIntoControllerConversation }) =>
    insertedIntoControllerConversation === false));

  assert.deepEqual(evidence.launchRequest.execution, {
    status: "succeeded",
    harnessRunId: run.harnessRunId,
    outcomeReference: run.outcome.outcomeId,
  });
  assert.equal(evidence.observation.orderedEventSequences, "1,2,3,4");
  assert.deepEqual(evidence.observation.separateLogProducers, ["stdout", "stderr"]);
  assert.equal(evidence.observation.reconnectAfterTabClosure, true);
  assert.equal(evidence.observation.controllerSessionSurvived, true);
  assert.deepEqual(evidence.auditReferences.map(({ action }) => action), [
    "harness.run.start",
    "harness.run.outcome",
  ]);
  assert.equal(evidence.auditReferences[0].details.returnedBeforeTerminal, true);
  assert.equal(
    evidence.auditReferences[0].details.adapterEntryPoint,
    "adapters/conformance.mjs",
  );
});

test("retained issue 120 evidence proves idempotency and truthful incomplete failure", () => {
  const success = evidence.contractEvidence.success;
  assert.equal(success.start.returnedStatus, "starting");
  assert.equal(success.start.completedAtOnReturn, null);
  assert.deepEqual(success.idempotency, {
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
  assert.deepEqual(success.unapproved, {
    code: "launch_request_unapproved",
    replayCode: "launch_request_unapproved",
    replayIdempotent: true,
    noRunStarted: true,
  });
  assert.equal(success.canonicalRunCount, 1);
  assert.deepEqual(success.logRanges.map(({ producer, insertedIntoControllerConversation }) => ({
    producer,
    insertedIntoControllerConversation,
  })), [
    { producer: "stdout", insertedIntoControllerConversation: false },
    { producer: "stderr", insertedIntoControllerConversation: false },
  ]);
  for (const range of success.logRanges) {
    assert.match(range.sha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(range.range.end - range.range.start, range.byteLength);
  }

  const failure = evidence.contractEvidence.truthfulFailure;
  assert.equal(failure.canonicalRunCount, 5);
  assert.equal(failure.incompleteResult.status, "failed");
  assert.equal(failure.incompleteResult.outcome.code, "harness_result_incomplete");
  assert.equal(failure.incompleteResult.outcome.incompleteResult, true);
  assert.equal(failure.incompleteResult.outcome.terminalEnvelope, null);
  assert.deepEqual(failure.incompleteResult.terminalEnvelopeValidation, {
    adapterReadyObserved: true,
    validTerminalEnvelopeCount: 0,
    exactlyOne: false,
    adapterChannelClosedObserved: true,
    processExitObserved: true,
  });
  assert.equal(failure.incompleteResult.successLookingDiagnosticRetained, true);
  assert.equal(failure.incompleteResult.logInsertedIntoControllerConversation, false);
  assert.equal(failure.nonUniqueOrInvalidTerminal.duplicate.status, "failed");
  assert.equal(
    failure.nonUniqueOrInvalidTerminal.duplicate
      .terminalEnvelopeValidation.validTerminalEnvelopeCount,
    2,
  );
  assert.equal(failure.nonUniqueOrInvalidTerminal.invalid.status, "failed");
  assert.equal(
    failure.nonUniqueOrInvalidTerminal.invalid.outcome.code,
    "harness_adapter_protocol_invalid",
  );
  const incompleteOutcomeAudit = failure.auditReferences.find((entry) =>
    entry.action === "harness.run.outcome"
    && entry.details.code === "harness_result_incomplete");
  assert.equal(incompleteOutcomeAudit.details.adapterChannelClosedObserved, true);
  assert.equal(incompleteOutcomeAudit.details.processExitObserved, true);
  assert.deepEqual(failure.prohibitedStarts, {
    rejected: "launch_request_terminal",
    expired: "launch_request_expired",
    expiredCanonicalStatus: "expired",
    staleBoundary: "pinned_compatibility_manifest",
    stale: "launch_request_stale",
    staleCanonicalStatus: "expired",
    restoredStaleRetry: "launch_request_terminal",
  });
  assert.equal(failure.malformedProgress.status, "failed");
  assert.equal(
    failure.malformedProgress.outcome.code,
    "harness_adapter_protocol_invalid",
  );
  assert.equal(failure.malformedProgress.malformedRecordPublished, false);
  assert.equal(failure.excessiveProgress.status, "failed");
  assert.equal(
    failure.excessiveProgress.outcome.code,
    "harness_adapter_protocol_invalid",
  );
  assert.equal(failure.excessiveProgress.retainedEventCount, 1_024);
  assert.equal(failure.excessiveProgress.retainedProgressCount, 1_021);
  assert.equal(failure.excessiveProgress.terminalEvent.sequence, 1_024);
  assert.equal(failure.excessiveProgress.terminalEvent.type, "harness_run_failed");
  assert.equal(failure.excessiveProgress.reloadObservable, true);

  assert.deepEqual(evidence.contractEvidence.startOutcomeRetention, {
    kind: "harness_run_start_retention_contract",
    distinctKeyCount: 257,
    retainedOutcomeCount: 257,
    firstLookupCode: "harness_run_start_outcome_found",
    firstLookupFound: true,
    replayIdempotent: true,
    replayReturnedOriginalAudit: true,
  });
});

test("retained issue 120 evidence is sanitized and excludes prohibited effects", () => {
  assert.deepEqual(evidence.prohibitedSideEffectAssertions, {
    projectFileWrite: false,
    logInsertedIntoControllerConversation: false,
    browserDisconnectCancellation: false,
    controllerSessionTermination: false,
    sudo: false,
    systemPackageInstall: false,
    shellProfileMutation: false,
    serviceConfiguration: false,
  });
  assert.deepEqual(evidence.securityAssertions, {
    secretAbsentFromPage: true,
    secretAbsentFromRetainedState: true,
  });
  assert.doesNotMatch(
    evidenceText,
    /harness-run-browser-secret|bootstrap\?token=|sandking_session=|provider:controller-session/i,
  );
});
