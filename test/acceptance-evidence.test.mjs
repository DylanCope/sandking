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

test("issue 117 acceptance manifest is executable and pinned to its approved PRD", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.issue, 117);
  assert.equal(manifest.parentPrd, 125);
  assert.deepEqual(manifest.approvedSpecification, {
    issue: 116,
    bodySha256: "bf695dc3483e1d8b2e6a67a011ac7c77bfae7f3d96d596598803862c1e496a23",
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
});

test("retained issue 117 evidence is sanitized and covers negotiation and prohibited effects", () => {
  assert.equal(evidence.issue, 117);
  assert.equal(evidence.parentPrd, 125);
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
  assert.deepEqual(evidence.typedMismatchEvidence.host, [
    "host_protocol_major_mismatch",
    "host_identity_mismatch",
    "host_capability_unsupported",
    "host_protocol_invalid_frame",
  ]);
  assert.deepEqual(evidence.typedMismatchEvidence.browser, [
    "browser_protocol_major_mismatch",
  ]);
  assert.equal(evidence.typedMismatchEvidence.acceptedStatePreserved, true);
  assert.equal(evidence.typedMismatchEvidence.mutationOccurred, false);
  assert.ok(evidence.auditReferences.length >= 5);
  assert.ok(evidence.auditReferences.every((entry) => /^audit-/.test(entry.auditId)));
  assert.ok(Object.values(evidence.securityAssertions).every(Boolean));
  assert.ok(Object.values(evidence.prohibitedSideEffectAssertions).every(
    (observed) => observed === false,
  ));
  assert.doesNotMatch(evidenceText, /bootstrap\?token=|sandking_session=|controller-secret/i);
});
