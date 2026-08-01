import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  captureIssue118EvidenceSourceRevision,
  ISSUE_118_DEMONSTRATED_PATHS,
} from "./issue-118-evidence-source.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(
  new URL("../acceptance/issue-118.manifest.json", import.meta.url),
  "utf8",
));
const evidenceText = await readFile(
  new URL("../acceptance/evidence/issue-118.json", import.meta.url),
  "utf8",
);
const evidence = JSON.parse(evidenceText);

test("issue 118 evidence source revision requires clean demonstrated paths", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "sandking-issue-118-evidence-"));
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: fixtureRoot });
    await mkdir(join(fixtureRoot, "src"));
    await writeFile(join(fixtureRoot, "src", "project.mjs"), "export const ready = false;\n");
    await execFileAsync("git", ["add", "src/project.mjs"], { cwd: fixtureRoot });
    await execFileAsync(
      "git",
      [
        "-c", "user.name=Sand-King Test",
        "-c", "user.email=sandking-test@example.invalid",
        "commit", "--quiet", "-m", "fixture",
      ],
      { cwd: fixtureRoot },
    );

    const committedRevision = await captureIssue118EvidenceSourceRevision({
      repositoryRoot: fixtureRoot,
      demonstratedPaths: ["src"],
    });
    assert.match(committedRevision, /^[a-f0-9]{40}$/);

    await writeFile(join(fixtureRoot, "src", "project.mjs"), "export const ready = true;\n");
    await assert.rejects(
      captureIssue118EvidenceSourceRevision({
        repositoryRoot: fixtureRoot,
        demonstratedPaths: ["src"],
      }),
      /issue_118_evidence_source_dirty: M src\/project\.mjs/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("issue 118 manifest drives the named packaged Project preparation scenario", () => {
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.issue, 118);
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
  assert.ok(manifest.scenarios[0].requirements.includes("#118 acceptance criteria"));
  assert.ok(manifest.scenarios[0].requirements.includes("#4 Project and Harness contract"));
  assert.ok(manifest.scenarios[0].requirements.includes("#8 authorization and audit boundaries"));
  assert.ok(manifest.scenarios[0].prohibitedSideEffects.includes("directory scan"));
  assert.ok(manifest.scenarios[0].prohibitedSideEffects.includes("Project file mutation"));
  assert.ok(manifest.verification.commands.flat().includes(
    "test/project-preparation.browser.test.mjs",
  ));
  assert.deepEqual(manifest.verification.typedPathFailures, [
    "project_path_invalid",
    "project_path_missing",
    "project_path_moved",
    "project_path_replaced",
    "project_path_conflict",
    "project_path_tombstoned",
  ]);
  assert.deepEqual(manifest.verification.typedMutationFailures, [
    "idempotency_key_conflict",
    "mutation_revision_conflict",
    "bounded_configuration_invalid",
    "harness_pin_missing",
    "harness_pin_invalid",
  ]);
});

test("retained issue 118 evidence identifies the unchanged demonstrated revision", async () => {
  const { stdout: resolvedCommit } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", `${evidence.generatedFromCommit}^{commit}`],
    { cwd: repositoryRoot },
  );
  assert.equal(resolvedCommit.trim(), evidence.generatedFromCommit);

  await execFileAsync(
    "git",
    ["merge-base", "--is-ancestor", evidence.generatedFromCommit, "HEAD"],
    { cwd: repositoryRoot },
  );

  const { stdout: demonstratedPathChanges } = await execFileAsync(
    "git",
    [
      "diff",
      "--name-only",
      `${evidence.generatedFromCommit}..HEAD`,
      "--",
      ...ISSUE_118_DEMONSTRATED_PATHS,
    ],
    { cwd: repositoryRoot },
  );
  assert.equal(
    demonstratedPathChanges.trim(),
    "",
    `retained evidence predates demonstrated product-path changes:\n${demonstratedPathChanges}`,
  );
});

test("retained issue 118 evidence proves Project and independent Harness readiness", () => {
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.issue, 118);
  assert.equal(evidence.parentPrd, 125);
  assert.equal(evidence.scenario, "local-walking-skeleton/completes-approved-run");
  assert.match(evidence.generatedFromCommit, /^[a-f0-9]{40}$/);
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

  assert.match(evidence.identities.hostId, /^host-[a-f0-9]{24}$/);
  assert.match(evidence.identities.projectId, /^project-[a-f0-9]{24}$/);
  assert.match(evidence.identities.harnessId, /^harness-[a-f0-9]{24}$/);
  assert.notEqual(evidence.identities.projectId, evidence.identities.harnessId);
  assert.match(evidence.pinnedCommit, /^[a-f0-9]{40}$/);
  assert.deepEqual(evidence.revisions, {
    projectRegistrationExpected: 0,
    projectRegistrationResult: 1,
    projectHarnessPinExpected: 1,
    projectHarnessPinResult: 2,
  });
  assert.deepEqual(evidence.readiness, {
    issueWorkflow: "ready",
    checks: "ready",
    configuration: "ready",
    harness: "ready",
    pin: "ready",
    launchRequest: "ready",
    diagnostics: [],
  });
  assert.deepEqual(evidence.storageBoundaries, {
    registrationOutsideProject: true,
    harnessWorkspaceOutsideProject: true,
    executionStateOutsideHarnessWorkspace: true,
  });

  const harnessRegistration = evidence.auditReferences.find((entry) =>
    entry.auditId === evidence.idempotency.harnessRegistrationAuditId);
  assert.equal(harnessRegistration.action, "harness.conformance.register");
  assert.equal(harnessRegistration.outcome, "accepted");
  assert.equal(harnessRegistration.details.harnessId, evidence.identities.harnessId);
  assert.equal(harnessRegistration.details.immutableRevision, evidence.pinnedCommit);
  assert.equal(harnessRegistration.details.independentWorkspace, true);
  assert.equal(harnessRegistration.details.workspaceOutsideProject, true);
  assert.equal(harnessRegistration.details.executionStateOutsideWorkspace, true);

  const pin = evidence.auditReferences.find((entry) =>
    entry.auditId === evidence.idempotency.pinAuditId);
  assert.equal(pin.action, "project.harness.pin");
  assert.equal(pin.outcome, "accepted");
  assert.equal(pin.details.projectId, evidence.identities.projectId);
  assert.equal(pin.details.harnessId, evidence.identities.harnessId);
  assert.equal(pin.details.immutableRevision, evidence.pinnedCommit);
  assert.equal(pin.details.resultingRevision, 2);
  assert.equal(pin.details.launchRequestReady, true);
});

test("retained issue 118 evidence proves path, mutation, and atomic-failure contracts", () => {
  assert.deepEqual(evidence.failureOutcomes, {
    invalidPath: "project_path_invalid",
    staleRevision: {
      code: "mutation_revision_conflict",
      actualRevision: 2,
    },
    missingPath: {
      code: "project_path_missing",
      guidance: ["update_registration", "forget_registration"],
    },
  });
  assert.deepEqual({
    mismatchedPayloadCode: evidence.idempotency.mismatchedPayloadCode,
    replayCode: evidence.idempotency.replayCode,
    replayReturnsOriginalAudit: evidence.idempotency.replayReturnsOriginalAudit,
    replayIdempotent: evidence.idempotency.replayIdempotent,
  }, {
    mismatchedPayloadCode: "idempotency_key_conflict",
    replayCode: "project_registered",
    replayReturnsOriginalAudit: true,
    replayIdempotent: true,
  });

  const pathResolution = evidence.contractEvidence.pathResolution;
  assert.equal(pathResolution.kind, "project_path_resolution");
  assert.deepEqual(Object.fromEntries(Object.entries(pathResolution.outcomes).map(
    ([name, outcome]) => [name, outcome.code],
  )), {
    missing: "project_path_missing",
    moved: "project_path_moved",
    replaced: "project_path_replaced",
    tombstoned: "project_path_tombstoned",
    conflict: "project_path_conflict",
  });
  for (const outcome of Object.values(pathResolution.outcomes)) {
    assert.ok(outcome.guidance.length > 0);
  }
  assert.equal(pathResolution.silentlyReattached, false);
  assert.equal(pathResolution.directoryScanPerformed, false);
  assert.equal(pathResolution.secretFixtureRetained, false);

  const mutation = evidence.contractEvidence.mutationContract;
  assert.equal(mutation.kind, "project_mutation_contract");
  assert.equal(mutation.registration.expectedRevision, 0);
  assert.equal(mutation.registration.revision, 1);
  assert.deepEqual(mutation.idempotency, {
    changedRequestCode: "idempotency_key_conflict",
    changedRequestRetryable: false,
    replayCode: "project_harness_pinned",
    replayAuditId: mutation.pin.auditId,
    replayIdempotent: true,
    replayReturnedOriginalAudit: true,
  });
  assert.deepEqual(mutation.staleRevision, {
    code: "mutation_revision_conflict",
    actualRevision: 1,
  });
  assert.deepEqual(mutation.invalidFailures, {
    path: "project_path_invalid",
    configuration: "bounded_configuration_invalid",
    missingPin: "harness_pin_missing",
    invalidPin: "harness_pin_invalid",
    invalidPinConfiguration: "bounded_configuration_invalid",
    preservedUnpinnedState: true,
  });
  assert.deepEqual(mutation.pin, {
    expectedRevision: 1,
    revision: 2,
    auditId: mutation.idempotency.replayAuditId,
  });
});

test("retained issue 118 evidence proves no Project footprint or prohibited side effect", () => {
  assert.deepEqual(evidence.projectFootprint.before, [
    ".git",
    "README.md",
    "secret.fixture",
  ]);
  assert.deepEqual(evidence.projectFootprint.after, evidence.projectFootprint.before);
  assert.deepEqual(evidence.projectFootprint.trackedSandKingFiles, []);
  assert.equal(evidence.projectFootprint.projectContentPreserved, true);
  assert.deepEqual(evidence.prohibitedSideEffectAssertions, {
    directoryScan: false,
    projectFileWrite: false,
    trackedSandKingFileWrite: false,
    approvalRequest: false,
    sudo: false,
    systemPackageInstall: false,
    shellProfileMutation: false,
    serviceConfiguration: false,
  });
  assert.deepEqual(evidence.securityAssertions, {
    projectSecretAbsent: true,
    rawIdempotencyKeyAbsent: true,
    unrelatedDirectoryPreserved: true,
  });
  assert.deepEqual(evidence.scopeExclusions, [
    "full-harness-projection",
    "production-harness-lifecycle",
    "harness-import-update-rollback-switching",
    "drift-recovery",
  ]);

  for (const entry of [
    ...evidence.auditReferences,
    ...evidence.contractEvidence.pathResolution.auditReferences,
    ...evidence.contractEvidence.mutationContract.auditReferences,
  ]) {
    assert.match(entry.auditId, /^audit-[a-f0-9]{24}$/);
    if ("directoryScanPerformed" in entry.details) {
      assert.equal(entry.details.directoryScanPerformed, false);
    }
    if ("projectFileWrite" in entry.details) {
      assert.equal(entry.details.projectFileWrite, false);
    }
    if ("idempotencyKeyHash" in entry.details) {
      assert.match(entry.details.idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
    }
  }
  assert.doesNotMatch(evidenceText, /project-browser-secret-must-not-appear/);
  assert.doesNotMatch(evidenceText, /controller-secret-must-not-reach-host/);
  assert.doesNotMatch(evidenceText, /project-browser-stale-registration/);
  assert.doesNotMatch(evidenceText, /project-browser-missing-path/);
});
