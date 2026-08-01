import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(await readFile(
  new URL("../acceptance/issue-123.manifest.json", import.meta.url),
  "utf8",
));
const evidenceText = await readFile(
  new URL("../acceptance/evidence/issue-123.json", import.meta.url),
  "utf8",
);
const evidence = JSON.parse(evidenceText);

test("issue 123 acceptance manifest drives the named packaged browser scenario", () => {
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.issue, 123);
  assert.equal(manifest.parentPrd, 125);
  assert.deepEqual(manifest.sourceSpecification, {
    issue: 116,
    githubBodyUtf8Sha256: "34ebbde096564621b14a68d4bc64cdbd8ba9e448a42cb75c084d80c0e201308a",
    parentApprovedTextExportSha256:
      "bf695dc3483e1d8b2e6a67a011ac7c77bfae7f3d96d596598803862c1e496a23",
    parentApprovedHashBasis: "exact GitHub body UTF-8 plus one terminal LF",
  });
  assert.deepEqual(manifest.scenarios.map((scenario) => scenario.id), [
    "planning-spine/projects-an-optional-journey",
  ]);
  assert.ok(manifest.scenarios[0].requirements.includes("#116 stories 37-44"));
  assert.ok(manifest.scenarios[0].prohibitedSideEffects.includes("live GitHub write"));
  assert.ok(manifest.verification.commands.flat().includes(
    "test/planning-spine.browser.test.mjs",
  ));
});

test("retained issue 123 evidence proves the optional Planning path and mutation invariants", () => {
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.issue, 123);
  assert.equal(evidence.parentPrd, 125);
  assert.equal(evidence.scenario, "planning-spine/projects-an-optional-journey");
  assert.match(evidence.generatedFromCommit, /^[a-f0-9]{40}$/);
  assert.deepEqual(evidence.sourceSpecification, {
    issue: 116,
    githubBodyUtf8Sha256: manifest.sourceSpecification.githubBodyUtf8Sha256,
    parentApprovedTextExportSha256:
      manifest.sourceSpecification.parentApprovedTextExportSha256,
    parentApprovedHashBasis: manifest.sourceSpecification.parentApprovedHashBasis,
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
  assert.match(evidence.runtime.runtimeId, /^runtime-[a-f0-9]{24}$/);
  assert.match(evidence.runtime.hostId, /^host-[a-f0-9]{24}$/);

  assert.deepEqual(evidence.builtInStages, ["wayfinding", "speccing", "ticketing"]);
  assert.deepEqual(evidence.projectionProvenance.adapter, {
    adapterId: "github-conformance-fixture-v1",
    authority: "github",
    fixture: true,
    label: "Conformance fixture data — not live GitHub",
  });
  assert.equal(evidence.projectionProvenance.fresh.freshness, "fresh");
  assert.equal(evidence.projectionProvenance.fresh.mutationsEnabled, true);
  assert.match(evidence.projectionProvenance.fresh.projectionDigest,
    /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(evidence.projectionProvenance.stale.refreshFailure, {
    code: "github_projection_unavailable",
    retryable: true,
  });
  assert.equal(evidence.projectionProvenance.stale.mutationsEnabled, false);
  assert.deepEqual(evidence.visibleStaleState, {
    freshnessAttribute: "stale",
    warningShown: true,
    allMutationControlsDisabled: true,
  });

  assert.match(evidence.focusedSession.sessionId,
    /^controller-session-[a-f0-9]{24}$/);
  assert.equal(
    evidence.focusedSession.workContextId,
    "work-context-speccing-optional-planning",
  );
  assert.notEqual(evidence.focusedSession.sessionId, evidence.focusedSession.workContextId);
  assert.equal(evidence.focusedSession.canonicalReference, "github:fixture:issue:116");
  assert.equal(evidence.focusedSession.providerId, "conformance-controller-v1");

  assert.deepEqual({
    authorizationClass: evidence.notUsedMutation.authorizationClass,
    expectedRevision: evidence.notUsedMutation.expectedRevision,
    resultingRevision: evidence.notUsedMutation.resultingRevision,
    replayReturnedSameAudit: evidence.notUsedMutation.replayReturnedSameAudit,
    replayIdempotent: evidence.notUsedMutation.replayIdempotent,
    ordinaryWorkBlocked: evidence.notUsedMutation.ordinaryWorkBlocked,
  }, {
    authorizationClass: "planning_stage_status",
    expectedRevision: 1,
    resultingRevision: 2,
    replayReturnedSameAudit: true,
    replayIdempotent: true,
    ordinaryWorkBlocked: false,
  });
  assert.match(evidence.notUsedMutation.auditId, /^audit-[a-f0-9]{24}$/);
  assert.deepEqual(evidence.failureOutcomes, {
    changedUse: { status: 409, code: "idempotency_key_conflict" },
    staleRevision: {
      status: 409,
      code: "mutation_revision_conflict",
      actualRevision: 2,
    },
    unavailableProjection: {
      status: 409,
      code: "projection_stale",
      queuedWrite: false,
    },
    unauthorized: { status: 403, code: "authorization_failed" },
  });

  const acceptedSession = evidence.auditReferences.find((entry) =>
    entry.action === "planning.session.open" && entry.outcome === "accepted");
  assert.equal(acceptedSession.details.authorizationClass, "planning_focused_session");
  assert.equal(acceptedSession.details.workContextId, evidence.focusedSession.workContextId);
  assert.equal(acceptedSession.details.sessionId, evidence.focusedSession.sessionId);
  const acceptedNotUsed = evidence.auditReferences.find((entry) =>
    entry.auditId === evidence.notUsedMutation.auditId);
  assert.equal(acceptedNotUsed.action, "planning.stage.not-used");
  assert.equal(acceptedNotUsed.outcome, "accepted");
  assert.deepEqual({
    expectedRevision: acceptedNotUsed.details.expectedRevision,
    actualRevision: acceptedNotUsed.details.actualRevision,
    resultingRevision: acceptedNotUsed.details.resultingRevision,
    fixtureProjectionWrite: acceptedNotUsed.details.fixtureProjectionWrite,
  }, {
    expectedRevision: 1,
    actualRevision: 1,
    resultingRevision: 2,
    fixtureProjectionWrite: true,
  });
  assert.match(acceptedNotUsed.details.idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(evidence.auditReferences.some((entry) =>
    entry.action === "planning.stage.not-used"
    && entry.outcome === "observed"
    && entry.details.idempotentReplay
    && entry.details.originalAuditId === evidence.notUsedMutation.auditId));
  for (const code of [
    "idempotency_key_conflict",
    "mutation_revision_conflict",
    "projection_stale",
    "authorization_failed",
  ]) {
    assert.ok(evidence.auditReferences.some((entry) =>
      entry.outcome === "rejected" && entry.details.code === code));
  }
  assert.ok(evidence.auditReferences.every((entry) =>
    entry.details.githubWrite === false
    && entry.details.queuedWrite === false
    && entry.details.skillInvocation === false
    && entry.details.projectFileWrite === false));

  assert.deepEqual(evidence.scopeExclusions, [
    "skill-owned-reasoning",
    "private-specifications",
    "ticket-set-publication",
    "complete-optional-or-out-of-order-planning",
    "downstream-needs-review",
  ]);
  assert.ok(Object.values(evidence.securityAssertions).every(Boolean));
  assert.ok(Object.values(evidence.prohibitedSideEffectAssertions).every(
    (observed) => observed === false,
  ));
  assert.equal(evidence.software.sandking, "0.1.0");
  assert.equal(evidence.software.browserProtocol, "1.0.0");
  assert.deepEqual(evidence.verificationCommands, manifest.verification.commands);
  assert.doesNotMatch(
    evidenceText,
    /planning-browser-secret|bootstrap\?token=|sandking_session=|x-sandking-idempotency-key/i,
  );
});
