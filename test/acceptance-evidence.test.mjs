import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(await readFile(
  new URL("../acceptance/issue-117.manifest.json", import.meta.url),
  "utf8",
));
const evidenceText = await readFile(
  new URL("../acceptance/evidence/issue-117.json", import.meta.url),
  "utf8",
);
const evidence = JSON.parse(evidenceText);

test("issue 117 acceptance manifest is executable and traces the live specification normalization", () => {
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.issue, 117);
  assert.equal(manifest.parentPrd, 125);
  assert.deepEqual(manifest.sourceSpecification, {
    issue: 116,
    githubBodyUtf8Sha256: "34ebbde096564621b14a68d4bc64cdbd8ba9e448a42cb75c084d80c0e201308a",
    parentApprovedTextExportSha256: "bf695dc3483e1d8b2e6a67a011ac7c77bfae7f3d96d596598803862c1e496a23",
    parentApprovedHashBasis: "exact GitHub body UTF-8 plus one terminal LF",
  });
  assert.deepEqual(manifest.scenarios.map((scenario) => scenario.id), [
    "local-walking-skeleton/completes-approved-run",
    "local-walking-skeleton/shows-truthful-failure",
  ]);
  assert.ok(manifest.verification.commands.every(
    (command) => command[0] === "node" && command[1] === "--test",
  ));
  assert.ok(manifest.verification.commands.flat().includes(
    "test/local-walking-skeleton.browser.test.mjs",
  ));
  assert.ok(manifest.verification.commands.flat().includes("test/package-command.test.mjs"));
  assert.ok(manifest.scenarios[0].actions.includes("launch installed sandking outside checkout"));
});

test("retained issue 117 evidence is sanitized and covers negotiation and prohibited effects", () => {
  assert.equal(evidence.issue, 117);
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.parentPrd, 125);
  assert.deepEqual(evidence.sourceSpecification, {
    issue: 116,
    githubBodyUtf8Sha256: manifest.sourceSpecification.githubBodyUtf8Sha256,
    parentApprovedTextExportSha256:
      manifest.sourceSpecification.parentApprovedTextExportSha256,
    parentApprovedHashBasis: manifest.sourceSpecification.parentApprovedHashBasis,
    normalizationDifference: "one terminal LF",
    exactContentEquivalentAfterApprovedExportNormalization: true,
  });
  assert.match(evidence.generatedFromCommit, /^[a-f0-9]{40}$/);
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
  assert.equal(evidence.listener.class, "loopback");
  assert.equal(evidence.listener.address, "127.0.0.1");
  assert.equal(evidence.runtime.identity, "controller-runtime");
  assert.match(evidence.runtime.reference, /^runtime-/);
  assert.equal(evidence.host.identity, "local-host");
  assert.deepEqual(evidence.host.negotiatedCapabilities, [
    "sandking.control.slice-1",
    "sandking.bulk-stream.v1",
  ]);
  assert.match(evidence.host.schemaDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(evidence.host.framing, {
    maxFrameBytes: 65_536,
    maxBulkChunkBytes: 16_384,
  });
  assert.equal(evidence.browserNegotiation.identity, "cockpit");
  assert.equal(evidence.browserNegotiation.runtimeIdentity, "controller-runtime");
  assert.equal(evidence.browserNegotiation.mismatchReloadRequired, true);
  assert.equal(evidence.browserNegotiation.capabilityMismatchReloadRequired, true);
  assert.deepEqual(evidence.typedMismatchEvidence.host.map((result) => result.diagnosis.code), [
    "controller_protocol_major_mismatch",
    "controller_capability_unsupported",
    "controller_schema_mismatch",
    "host_protocol_major_mismatch",
    "host_identity_mismatch",
    "host_capability_unsupported",
    "host_protocol_invalid_frame",
  ]);
  assert.deepEqual(evidence.typedMismatchEvidence.browser.map((result) => result.code), [
    "browser_protocol_major_mismatch",
    "browser_capability_unsupported",
    "browser_runtime_handshake_mismatch",
    "browser_opaque_frame_invalid",
  ]);
  assert.equal(evidence.typedMismatchEvidence.acceptedStatePreserved, true);
  assert.equal(evidence.typedMismatchEvidence.mutationOccurred, false);
  assert.ok(evidence.typedMismatchEvidence.host.every((result) =>
    result.acceptedState.beforeSha256 === result.acceptedState.afterSha256
    && result.runtimeStatePresent === false
    && result.auditReferences.some((entry) =>
      entry.auditId === result.diagnosis.auditId
      && entry.action === "host.negotiate"
      && entry.outcome === "rejected")));
  assert.deepEqual(evidence.bootstrapMutationEvidence, {
    ttlMs: 25,
    expiredStatus: 410,
    expiredCode: "bootstrap_token_expired",
    replayStatus: 302,
    replayReturnedSameSession: true,
    staleStatus: 409,
    staleCode: "mutation_revision_conflict",
  });
  assert.equal(evidence.sessionMutationEvidence.authorizationClass, "runtime_browser_session");
  assert.equal(evidence.sessionMutationEvidence.initialRevision, 1);
  assert.equal(evidence.sessionMutationEvidence.resultingRevision, 2);
  assert.equal(evidence.sessionMutationEvidence.replayReturnedSameAudit, true);
  assert.equal(evidence.sessionMutationEvidence.staleCode, "mutation_revision_conflict");
  assert.ok(evidence.auditReferences.length >= 5);
  assert.ok(evidence.auditReferences.every((entry) => /^audit-/.test(entry.auditId)));
  const mutationAudits = evidence.auditReferences.filter((entry) =>
    entry.action === "browser.session.create" || entry.action === "browser.session.end");
  assert.ok(mutationAudits.some((entry) =>
    entry.details.authorizationClass === "bootstrap_token"
    && /^sha256:[a-f0-9]{64}$/.test(entry.details.idempotencyKeyHash)
    && Number.isSafeInteger(entry.details.expectedRevision)));
  assert.ok(mutationAudits.some((entry) =>
    entry.details.authorizationClass === "runtime_browser_session"
    && Number.isSafeInteger(entry.details.resultingRevision)));
  assert.ok(Object.values(evidence.securityAssertions).every(Boolean));
  assert.ok(Object.values(evidence.prohibitedSideEffectAssertions).every(
    (observed) => observed === false,
  ));
  assert.deepEqual(evidence.prohibitedSideEffectObservations.remoteListener.acceptedAddresses, []);
  assert.deepEqual(
    evidence.prohibitedSideEffectObservations.commandInterception.invokedCommands,
    [],
  );
  assert.deepEqual(
    evidence.prohibitedSideEffectObservations.protectedConfiguration.beforeSha256,
    evidence.prohibitedSideEffectObservations.protectedConfiguration.afterSha256,
  );
  assert.deepEqual(
    evidence.prohibitedSideEffectObservations.protectedFixture.beforeSha256,
    evidence.prohibitedSideEffectObservations.protectedFixture.afterSha256,
  );
  assert.equal(evidence.hostCredentialBoundary.controllerSecretForwarded, false);
  assert.doesNotMatch(evidenceText, /bootstrap\?token=|sandking_session=|controller-secret/i);
});
