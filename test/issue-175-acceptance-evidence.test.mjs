import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertIssue175EvidenceSanitized,
  ISSUE_175_DEMONSTRATED_PATHS,
} from "./issue-175-evidence-source.mjs";

const manifestUrl = new URL("../acceptance/issue-175.manifest.json", import.meta.url);
const evidenceUrl = new URL("../acceptance/evidence/issue-175.json", import.meta.url);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);
const evidenceExists = await access(evidenceUrl).then(() => true, () => false);

test("issue 175 manifest is the complete production and conformance merge oracle", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));

  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.issue, 175);
  assert.equal(manifest.parentPrd, 169);
  assert.equal(manifest.sourceSpecification.issue, 168);
  assert.equal(
    manifest.sourceSpecification.githubBodyUtf8Sha256,
    manifest.sourceSpecification.parentApprovedBodySha256,
  );
  assert.deepEqual(manifest.scenarios.map(({ name }) => name), [
    "Production Sandcastle delegation",
    "Conformance acceptance oracle",
  ]);
  for (const scenario of manifest.scenarios) {
    for (const field of [
      "requirements",
      "environmentAndTransport",
      "initialState",
      "actionsAndFaultPoints",
      "expectedTypedResults",
      "canonicalInvariants",
      "prohibitedSideEffects",
      "retainedEvidence",
    ]) {
      assert.ok(scenario[field]?.length > 0, `${scenario.name}:${field}`);
    }
  }

  const production = manifest.scenarios[0];
  assert.deepEqual(production.consumedRealProviderEvidence, {
    issue: 174,
    manifest: "acceptance/issue-174.manifest.json",
    evidence: "acceptance/evidence/issue-174.real.json",
    repeatedByIssue175: false,
  });
  assert.match(JSON.stringify(production.expectedTypedResults), /real_work_committed/);
  assert.match(JSON.stringify(production.canonicalInvariants), /skill-set lock digest/);
  assert.match(JSON.stringify(production.canonicalInvariants), /ignored projection/);
  assert.match(JSON.stringify(production.canonicalInvariants), /disposable Project commit/);

  const conformance = manifest.scenarios[1];
  assert.equal(conformance.mandatory, true);
  assert.deepEqual(conformance.prerequisites, {
    modelOutput: false,
    productionCredentials: false,
    networkAccess: false,
  });
  assert.match(JSON.stringify(conformance.actionsAndFaultPoints), /ordinary public/);

  assert.deepEqual(
    manifest.qualification.preLaunch.map(({ boundary }) => boundary),
    [
      "invalid-or-incomplete-seed",
      "unresolvable-pin",
      "altered-pinned-adapter-bytes",
      "unsupported-or-mismatched-adapter-identity-or-protocol",
      "invalid-entry-point",
      "missing-or-unverifiable-locked-skills",
      "ambient-only-skill-availability",
      "unsafe-projection-collision",
      "unavailable-runtime-readiness",
      "unavailable-provider-readiness",
    ],
  );
  assert.ok(manifest.qualification.preLaunch.every(({ invariants }) =>
    invariants.includes("no Harness run")
    && invariants.includes("no Worker invocation")
    && invariants.includes("tracked Project state preserved")
    && invariants.includes("no fallback")));
  assert.deepEqual(
    manifest.qualification.postLaunch.map(({ boundary }) => boundary),
    [
      "worker-failure",
      "malformed-terminal-outcome",
      "missing-terminal-outcome",
      "non-zero-exit-without-required-result",
      "early-or-zero-exit-without-required-result",
      "observation-interruption-and-reconnect",
      "cancellation",
      "ambiguous-launch-retry",
    ],
  );
  assert.ok(manifest.qualification.postLaunch.every(({ invariants }) =>
    invariants.includes("one canonical Harness run")
    && invariants.includes("one truthful terminal or recovery outcome")
    && invariants.includes("bounded sanitized diagnostic references")
    && invariants.includes("process exit and logs are not completion evidence")));

  assert.deepEqual(
    manifest.sourceCoverageIndex.map(({ story }) => story),
    Array.from({ length: 45 }, (_, index) => index + 1),
  );
  assert.ok(manifest.sourceCoverageIndex.every(({ delivery, executableEvidence }) =>
    delivery >= 170
    && delivery <= 175
    && executableEvidence.length > 0));
  assert.deepEqual(manifest.acceptanceGraph.children.map(({ issue, state }) => ({ issue, state })), [
    { issue: 170, state: "closed" },
    { issue: 171, state: "closed" },
    { issue: 172, state: "closed" },
    { issue: 173, state: "closed" },
    { issue: 174, state: "closed" },
    { issue: 175, state: "open" },
  ]);
  assert.deepEqual(manifest.acceptanceGraph.dependencies, [
    [170, 171],
    [171, 172],
    [172, 173],
    [173, 174],
    [170, 175],
    [171, 175],
    [172, 175],
    [173, 175],
    [174, 175],
  ]);

  assert.deepEqual(
    manifest.verification.suiteCoverage.map(({ boundary }) => boundary),
    [
      "identity",
      "protocol",
      "registration",
      "seed",
      "pin",
      "skill-lock",
      "projection",
      "adapter",
      "Harness-run",
      "browser",
      "CLI",
      "installed-package",
      "Git-boundary",
      "security",
      "acceptance",
    ],
  );
  assert.ok(manifest.verification.suiteCoverage.every(({ executableEvidence }) =>
    executableEvidence.length > 0));
  assert.ok(manifest.verification.commands.length > 0);
});

test("issue 175 source and native graph verification fails closed on any coverage gap", async () => {
  const { assertIssue175SourceAndGraph } = await import(
    "./issue-175-source-verification.mjs"
  );
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  const valid = {
    manifest,
    sourceBodyHashes: {
      168: manifest.sourceSpecification.githubBodyUtf8Sha256,
      169: manifest.sourcePrd.githubBodyUtf8Sha256,
      175: manifest.sourceIssue.githubBodyUtf8Sha256,
    },
    specificationStories: Array.from({ length: 45 }, (_, index) => index + 1),
    children: manifest.acceptanceGraph.children,
    dependencies: manifest.acceptanceGraph.dependencies,
  };

  assert.deepEqual(assertIssue175SourceAndGraph(valid), {
    sourceIssues: [168, 169, 175],
    coveredStories: 45,
    childIssues: [170, 171, 172, 173, 174, 175],
    dependencyEdges: 9,
  });
  assert.throws(() => assertIssue175SourceAndGraph({
    ...valid,
    specificationStories: valid.specificationStories.slice(0, -1),
  }), /issue_175_specification_story_coverage_mismatch/);
  assert.throws(() => assertIssue175SourceAndGraph({
    ...valid,
    sourceBodyHashes: { ...valid.sourceBodyHashes, 168: "0".repeat(64) },
  }), /issue_175_source_revision_mismatch:168/);
  assert.throws(() => assertIssue175SourceAndGraph({
    ...valid,
    children: valid.children.slice(0, -1),
  }), /issue_175_child_graph_mismatch/);
  assert.throws(() => assertIssue175SourceAndGraph({
    ...valid,
    dependencies: valid.dependencies.slice(0, -1),
  }), /issue_175_dependency_graph_mismatch/);
});

test("issue 175 evidence can bind only a clean demonstrated revision", async () => {
  const { captureCleanIssue175EvidenceRevision } = await import(
    "./issue-175-evidence-source.mjs"
  );
  const root = await mkdtemp(join(tmpdir(), "sandking-issue-175-source-"));
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "oracle.mjs"), "export const ready = true;\n");
    await execFileAsync("git", ["add", "src/oracle.mjs"], { cwd: root });
    await execFileAsync("git", [
      "-c", "user.name=Sand-King Test",
      "-c", "user.email=sandking-test@example.invalid",
      "commit", "--quiet", "-m", "fixture",
    ], { cwd: root });
    assert.match(await captureCleanIssue175EvidenceRevision({
      repositoryRoot: root,
      demonstratedPaths: ["src"],
    }), /^[a-f0-9]{40}$/);
    await writeFile(join(root, "src", "oracle.mjs"), "export const ready = false;\n");
    await assert.rejects(captureCleanIssue175EvidenceRevision({
      repositoryRoot: root,
      demonstratedPaths: ["src"],
    }), /issue_175_evidence_source_dirty/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 175 evidence sanitizer rejects every prohibited retained value class", () => {
  for (const prohibited of [
    { credentialValue: "secret" },
    { rawIdempotencyKey: "raw-key" },
    { providerTranscript: "provider output" },
    { unrestrictedLog: "all logs" },
    { environmentDump: "NAME=value" },
    { reusableSessionMaterial: "cookie" },
    { machineSpecificSecretPath: "/private/secret" },
    { fullSkillContent: "complete instructions" },
  ]) {
    assert.throws(() => assertIssue175EvidenceSanitized(prohibited),
      /issue_175_evidence_prohibited_field/);
  }
  assert.throws(() => assertIssue175EvidenceSanitized({ value: "/home/person/project" }),
    /issue_175_evidence_not_sanitized/);
});

test("retained issue 175 evidence qualifies the unchanged complete acceptance graph", {
  skip: evidenceExists || process.env.SANDKING_ISSUE_175_EVIDENCE_UPDATE === "1"
    ? false
    : "generated after the implementation commit",
}, async (context) => {
  if (process.env.SANDKING_ISSUE_175_EVIDENCE_UPDATE === "1") {
    context.skip("the runner is replacing retained issue 175 evidence");
    return;
  }
  const [manifest, evidenceText] = await Promise.all([
    readFile(manifestUrl, "utf8").then(JSON.parse),
    readFile(evidenceUrl, "utf8"),
  ]);
  const evidence = JSON.parse(evidenceText);
  assertIssue175EvidenceSanitized(evidence);
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.issue, 175);
  assert.equal(evidence.parentPrd, 169);
  assert.equal(evidence.scenarioVersion, manifest.scenarioVersion);
  assert.deepEqual(evidence.scenarioResults.map(({ id, name, passed }) => ({
    id,
    name,
    passed,
  })), manifest.scenarios.map(({ id, name }) => ({ id, name, passed: true })));
  await execFileAsync("git", [
    "merge-base", "--is-ancestor", evidence.generatedFromCommit, "HEAD",
  ], { cwd: repositoryRoot });
  const { stdout: changes } = await execFileAsync("git", [
    "diff", "--name-only", `${evidence.generatedFromCommit}..HEAD`, "--",
    ...ISSUE_175_DEMONSTRATED_PATHS,
  ], { cwd: repositoryRoot });
  assert.equal(changes.trim(), "", `issue 175 evidence predates changes:\n${changes}`);

  assert.deepEqual(evidence.sourceAndGraphVerification.sourceIssues, [168, 169, 175]);
  assert.equal(evidence.sourceAndGraphVerification.coveredStories, 45);
  assert.deepEqual(evidence.sourceAndGraphVerification.childIssues, [170, 171, 172, 173, 174, 175]);
  assert.equal(evidence.sourceAndGraphVerification.dependencyEdges, 9);
  assert.deepEqual(
    evidence.sourceAndGraphVerification.sourceBodyHashes,
    {
      168: manifest.sourceSpecification.githubBodyUtf8Sha256,
      169: manifest.sourcePrd.githubBodyUtf8Sha256,
      175: manifest.sourceIssue.githubBodyUtf8Sha256,
    },
  );
  assert.equal(evidence.sourceAndGraphVerification.parentState, "open");
  assert.equal(evidence.sourceAndGraphVerification.qualificationIssueState, "open");

  const production = evidence.scenarioResults[0];
  assert.equal(production.deterministicPublicSurfaces.cockpit.operation, "harness-run.launch");
  assert.equal(production.deterministicPublicSurfaces.cliAndApi.operation, "harness-run.launch");
  assert.equal(production.deterministicPublicSurfaces.sameHostOperationAndAdapterSelection, true);
  assert.equal(production.realProviderProof.sourceIssue, 174);
  assert.equal(production.realProviderProof.repeatedByIssue175, false);
  assert.equal(production.realProviderProof.adapter.identity, "sandcastle-harness-adapter-v1");
  assert.match(production.realProviderProof.adapter.contentIntegrity, /^sha256:[a-f0-9]{64}$/);
  assert.match(production.realProviderProof.harness.pinnedRevision, /^[a-f0-9]{40}$/);
  assert.match(production.realProviderProof.harness.dependencyLock.integrity,
    /^sha256:[a-f0-9]{64}$/);
  assert.match(production.realProviderProof.harness.skillSetLock.integrity,
    /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(
    production.realProviderProof.harness.skillSetLock.resolvedSkills.map(({ identity }) => identity),
    [
      "sandking.issue-implementation",
      "sandking.issue-planning",
      "sandking.pull-request-review",
      "sandking.real-delegation",
    ],
  );
  assert.equal(production.realProviderProof.structuredOutcome.status, "succeeded");
  assert.equal(production.realProviderProof.structuredOutcome.code, "real_work_committed");
  assert.equal(production.realProviderProof.structuredOutcome.commit,
    production.realProviderProof.project.afterCommit);
  assert.ok(Object.values(production.realProviderProof.project.invariants).every(Boolean));
  assert.equal(production.realProviderProof.diagnostics.bounded, true);
  assert.equal(production.realProviderProof.diagnostics.contentRetained, false);
  assert.ok(production.realProviderProof.diagnostics.references.every(({ producer }) =>
    producer === "stdout" || producer === "stderr"));
  assert.ok(production.preLaunchResults.every(({ passed, prohibitedSideEffectsPreserved,
    fallbackObserved }) => passed && prohibitedSideEffectsPreserved && !fallbackObserved));
  assert.ok(production.postLaunchResults.every(({ passed, canonicalRunCount,
    terminalOrRecoveryOutcomeCount, duplicateWorkerInvocation, duplicateProjectCommit }) =>
    passed
    && canonicalRunCount === 1
    && terminalOrRecoveryOutcomeCount === 1
    && !duplicateWorkerInvocation
    && !duplicateProjectCommit));

  const conformance = evidence.scenarioResults[1];
  assert.equal(conformance.mandatory, true);
  assert.deepEqual(conformance.prerequisites, {
    modelOutput: false,
    productionCredentials: false,
    networkAccess: false,
  });
  assert.equal(conformance.packagedPublicSeam.operation, "harness-run.launch");
  assert.equal(conformance.adapter.identity, "conformance-harness-adapter-v1");
  assert.equal(conformance.observation.status, "succeeded");
  assert.equal(conformance.observation.exactlyOneTerminalEnvelope, true);
  assert.equal(conformance.observation.reconnectReturnsCanonicalRun, true);
  assert.equal(conformance.observation.ambiguousRetryReturnsCanonicalRun, true);
  assert.equal(conformance.observation.duplicateRunCount, 0);
  assert.equal(conformance.productionProviderInvoked, false);

  assert.ok(evidence.verificationCommands.every(({ passed, outputIntegrity, testSummary }) =>
    passed
    && /^sha256:[a-f0-9]{64}$/.test(outputIntegrity)
    && (!testSummary || testSummary.failed === 0)));
  assert.ok(Object.values(evidence.securityAssertions.surfaces).every(Boolean));
  assert.ok(Object.values(evidence.securityAssertions.exclusions).every(Boolean));
  assert.ok(Object.values(evidence.securityAssertions.inheritedDurabilityAssertions).every(Boolean));
  assert.doesNotMatch(evidenceText,
    /(?:sk-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9]{12,}|bootstrap\?token=|sandking_session=)/i);
});
