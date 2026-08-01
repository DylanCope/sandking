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
  assert.ok(manifest.scenarios[0].actions.includes(
    "launch installed sandking outside checkout with lifecycle mutation contract",
  ));
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
  assert.equal(evidence.runtime.revision, 1);
  assert.equal(evidence.host.identity, "local-host");
  assert.match(evidence.host.reference, /^host-[a-f0-9]{24}$/);
  assert.deepEqual(evidence.host.negotiatedCapabilities, [
    "sandking.control.slice-1",
    "sandking.bulk-stream.v1",
  ]);
  assert.match(evidence.host.schemaDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(evidence.host.framing, {
    maxFrameBytes: 65_536,
    maxBulkChunkBytes: 16_384,
  });
  assert.deepEqual({
    authorizationClass: evidence.hostIdentityMutationEvidence.authorizationClass,
    expectedRevision: evidence.hostIdentityMutationEvidence.expectedRevision,
    actualRevision: evidence.hostIdentityMutationEvidence.actualRevision,
    resultingRevision: evidence.hostIdentityMutationEvidence.resultingRevision,
    launchOutcomeReferencesSameAudit:
      evidence.hostIdentityMutationEvidence.launchOutcomeReferencesSameAudit,
  }, {
    authorizationClass: "controller_host_identity_binding",
    expectedRevision: 0,
    actualRevision: 0,
    resultingRevision: 1,
    launchOutcomeReferencesSameAudit: true,
  });
  assert.match(evidence.hostIdentityMutationEvidence.auditId, /^audit-/);
  assert.equal(evidence.browserNegotiation.identity, "cockpit");
  assert.equal(evidence.browserNegotiation.runtimeIdentity, "controller-runtime");
  assert.equal(evidence.browserNegotiation.mismatchReloadRequired, true);
  assert.equal(evidence.browserNegotiation.capabilityMismatchReloadRequired, true);
  assert.deepEqual(evidence.typedMismatchEvidence.host.map((result) => result.diagnosis.code), [
    "controller_protocol_major_mismatch",
    "controller_capability_unsupported",
    "controller_schema_mismatch",
    "controller_host_identity_mismatch",
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
  assert.equal(
    evidence.preAcceptanceHostFailureEvidence.diagnosis.code,
    "host_protocol_major_mismatch",
  );
  assert.equal(
    evidence.preAcceptanceHostFailureEvidence.acceptedIdentityStateCreated,
    false,
  );
  assert.deepEqual(evidence.preAcceptanceHostFailureEvidence.presentFiles, []);
  assert.ok(evidence.preAcceptanceHostFailureEvidence.auditReferences.some((entry) =>
    entry.auditId === evidence.preAcceptanceHostFailureEvidence.diagnosis.auditId
    && entry.action === "host.negotiate"
    && entry.outcome === "rejected"));
  assert.ok(evidence.typedMismatchEvidence.host.every((result) =>
    result.acceptedState.beforeSha256 === result.acceptedState.afterSha256
    && result.acceptedState.files.includes("controller-host-binding.json")
    && result.acceptedState.files.includes("host-identity.json")
    && result.acceptedState.files.includes("runtime-lifecycle.json")
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
  assert.equal(evidence.sessionMutationEvidence.socketRevoked, true);
  assert.equal(evidence.sessionMutationEvidence.socketCloseCode, 1008);
  assert.equal(evidence.sessionMutationEvidence.socketCloseReason, "session_ended");
  assert.equal(evidence.sessionMutationEvidence.postEndPong, false);
  assert.equal(evidence.sessionMutationEvidence.concurrentRequestCount, 8);
  assert.equal(evidence.sessionMutationEvidence.acceptedOutcomeCount, 1);
  assert.equal(evidence.sessionMutationEvidence.replayOutcomeCount, 7);
  assert.equal(evidence.sessionMutationEvidence.concurrentSameAudit, true);
  assert.deepEqual(evidence.browserCredentialEvidence, {
    browserCookieExpires: -1,
    persistentCookieAttributesIssued: false,
  });
  assert.deepEqual({
    ttlMs: evidence.browserSessionExpiryEvidence.ttlMs,
    persistentCookieAttributesIssued:
      evidence.browserSessionExpiryEvidence.persistentCookieAttributesIssued,
    socketCloseCode: evidence.browserSessionExpiryEvidence.socketCloseCode,
    socketCloseReason: evidence.browserSessionExpiryEvidence.socketCloseReason,
    expiredHttpStatus: evidence.browserSessionExpiryEvidence.expiredHttpStatus,
    expiredHttpCode: evidence.browserSessionExpiryEvidence.expiredHttpCode,
  }, {
    ttlMs: 250,
    persistentCookieAttributesIssued: false,
    socketCloseCode: 1008,
    socketCloseReason: "session_expired",
    expiredHttpStatus: 401,
    expiredHttpCode: "session_expired",
  });
  assert.equal(evidence.browserSessionExpiryEvidence.expiryAudit.action, "browser.session.expire");
  assert.equal(evidence.browserSessionExpiryEvidence.expiryAudit.outcome, "observed");
  assert.deepEqual(
    evidence.runtimeReuseFailureEvidence.map((result) => result.diagnosis.code),
    ["runtime_incompatible", "runtime_not_ready"],
  );
  assert.ok(evidence.runtimeReuseFailureEvidence.every((result) =>
    result.mutationOutcome.failure.code === result.diagnosis.code
    && result.mutationOutcome.failure.auditId === result.diagnosis.auditId
    && result.lifecycleAudit.auditId === result.diagnosis.auditId
    && result.lifecycleAudit.action === "runtime.start"
    && result.lifecycleAudit.outcome === "rejected"
    && result.competingRuntimeSpawned === false));
  assert.deepEqual({
    authorizationClass: evidence.runtimeStartEvidence.authorizationClass,
    initialRevision: evidence.runtimeStartEvidence.initialRevision,
    resultingRevision: evidence.runtimeStartEvidence.resultingRevision,
    code: evidence.runtimeStartEvidence.code,
    idempotentReplay: evidence.runtimeStartEvidence.idempotentReplay,
  }, {
    authorizationClass: "user_runtime_lifecycle",
    initialRevision: 0,
    resultingRevision: 1,
    code: "runtime_started",
    idempotentReplay: false,
  });
  assert.deepEqual({
    authorizationClass: evidence.runtimeStopEvidence.authorizationClass,
    initialRevision: evidence.runtimeStopEvidence.initialRevision,
    resultingRevision: evidence.runtimeStopEvidence.resultingRevision,
    stoppedRuntimeId: evidence.runtimeStopEvidence.stoppedRuntimeId,
    replayReturnedSameAudit: evidence.runtimeStopEvidence.replayReturnedSameAudit,
    lifecycleStatus: evidence.runtimeStopEvidence.lifecycleStatus,
  }, {
    authorizationClass: "user_runtime_lifecycle",
    initialRevision: 1,
    resultingRevision: 2,
    stoppedRuntimeId: evidence.runtime.reference,
    replayReturnedSameAudit: true,
    lifecycleStatus: "stopped",
  });
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
  const acceptedHostNegotiation = evidence.auditReferences.find((entry) =>
    entry.action === "host.negotiate" && entry.outcome === "accepted");
  assert.deepEqual({
    controllerId: acceptedHostNegotiation.details.controllerId,
    expectedHostId: acceptedHostNegotiation.details.expectedHostId,
    hostId: acceptedHostNegotiation.details.hostId,
  }, {
    controllerId: evidence.runtime.reference,
    expectedHostId: evidence.host.reference,
    hostId: evidence.host.reference,
  });
  const acceptedHostIdentity = evidence.auditReferences.find((entry) =>
    entry.auditId === evidence.hostIdentityMutationEvidence.auditId);
  assert.equal(acceptedHostIdentity.action, "host.identity.accept");
  assert.equal(acceptedHostIdentity.outcome, "accepted");
  assert.equal(
    acceptedHostIdentity.details.authorizationClass,
    "controller_host_identity_binding",
  );
  assert.match(acceptedHostIdentity.details.idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
  const acceptedRuntimeStop = evidence.auditReferences.find((entry) =>
    entry.auditId === evidence.runtimeStopEvidence.auditId);
  assert.equal(acceptedRuntimeStop.action, "runtime.stop");
  assert.equal(acceptedRuntimeStop.outcome, "accepted");
  assert.match(acceptedRuntimeStop.details.idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual({
    authorizationClass: acceptedRuntimeStop.details.authorizationClass,
    expectedRevision: acceptedRuntimeStop.details.expectedRevision,
    actualRevision: acceptedRuntimeStop.details.actualRevision,
    resultingRevision: acceptedRuntimeStop.details.resultingRevision,
  }, {
    authorizationClass: "user_runtime_lifecycle",
    expectedRevision: 1,
    actualRevision: 1,
    resultingRevision: 2,
  });
  const acceptedRuntimeStart = evidence.auditReferences.find((entry) =>
    entry.auditId === evidence.runtimeStartEvidence.auditId);
  assert.equal(acceptedRuntimeStart.action, "runtime.start");
  assert.equal(acceptedRuntimeStart.outcome, "accepted");
  assert.match(acceptedRuntimeStart.details.idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual({
    authorizationClass: acceptedRuntimeStart.details.authorizationClass,
    expectedRevision: acceptedRuntimeStart.details.expectedRevision,
    actualRevision: acceptedRuntimeStart.details.actualRevision,
    resultingRevision: acceptedRuntimeStart.details.resultingRevision,
  }, {
    authorizationClass: "user_runtime_lifecycle",
    expectedRevision: 0,
    actualRevision: 0,
    resultingRevision: 1,
  });
  const durableIdentityMismatch = evidence.typedMismatchEvidence.host.find((result) =>
    result.diagnosis.code === "host_identity_mismatch");
  const mismatchAudit = durableIdentityMismatch.auditReferences.find((entry) =>
    entry.auditId === durableIdentityMismatch.diagnosis.auditId);
  assert.equal(mismatchAudit.details.expectedHostIdentity, "local-host");
  assert.match(mismatchAudit.details.controllerId, /^runtime-[a-f0-9]{24}$/);
  assert.match(mismatchAudit.details.expectedHostId, /^host-[a-f0-9]{24}$/);
  assert.match(mismatchAudit.details.observedHostId, /^host-[a-f0-9]{24}$/);
  assert.notEqual(mismatchAudit.details.expectedHostId, mismatchAudit.details.observedHostId);
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
