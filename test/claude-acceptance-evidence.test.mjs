import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  captureCleanIssue124EvidenceRevision,
  ISSUE_124_DEMONSTRATED_PATHS,
} from "./issue-124-evidence-source.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(
  new URL("../acceptance/issue-124.manifest.json", import.meta.url),
  "utf8",
));
const evidenceUrl = new URL("../acceptance/evidence/issue-124.json", import.meta.url);
const evidenceExists = await access(evidenceUrl).then(() => true, () => false);
const evidence = evidenceExists
  ? JSON.parse(await readFile(evidenceUrl, "utf8"))
  : null;

test("issue 124 evidence source requires clean demonstrated paths", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "sandking-issue-124-evidence-"));
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: fixtureRoot });
    await mkdir(join(fixtureRoot, "src"));
    await writeFile(join(fixtureRoot, "src", "adapter.mjs"), "export const ready = false;\n");
    await execFileAsync("git", ["add", "src/adapter.mjs"], { cwd: fixtureRoot });
    await execFileAsync("git", [
      "-c", "user.name=Sand-King Test",
      "-c", "user.email=sandking-test@example.invalid",
      "commit", "--quiet", "-m", "fixture",
    ], { cwd: fixtureRoot });
    assert.match(await captureCleanIssue124EvidenceRevision({
      repositoryRoot: fixtureRoot,
      demonstratedPaths: ["src"],
    }), /^[a-f0-9]{40}$/);
    await writeFile(join(fixtureRoot, "src", "adapter.mjs"), "export const ready = true;\n");
    await assert.rejects(captureCleanIssue124EvidenceRevision({
      repositoryRoot: fixtureRoot,
      demonstratedPaths: ["src"],
    }), /issue_124_evidence_source_dirty: M src\/adapter\.mjs/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("issue 124 manifest traces the installed Claude Controller slice", () => {
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.issue, 124);
  assert.equal(manifest.parentPrd, 125);
  assert.equal(manifest.sourceSpecification.issue, 116);
  assert.deepEqual(manifest.scenarios.map(({ id }) => id), [
    "local-walking-skeleton/operates-installed-claude-controller",
  ]);
  const scenario = manifest.scenarios[0];
  for (const requirement of [
    "#116 stories 31-36 and 41-44",
    "#124 acceptance criteria",
    "#8 exact focused in-conversation approval, audit, and secret boundaries",
    "#14 provider adapter, runtime-owned PTY, one-writer attachment, and browser boundaries",
    "#17 vertical-slice acceptance and real production-boundary decisions",
    "#22 stable named manifest and retained sanitized evidence decisions",
    "#23 coherent fail-closed implementation boundary",
  ]) {
    assert.ok(scenario.requirements.includes(requirement), requirement);
  }
  assert.equal(manifest.environmentGate.name, "SANDKING_REAL_CLAUDE_ACCEPTANCE");
  assert.equal(manifest.environmentGate.enabledValue, "1");
  assert.equal(
    manifest.environmentGate.deterministicMergeOracleRequiresAuthenticatedExecution,
    false,
  );
  assert.equal(manifest.environmentGate.finalAcceptanceChildRequiresAuthenticatedExecution, true);
  assert.match(manifest.environmentGate.executionCommand,
    /SANDKING_REAL_CLAUDE_PROJECT=\/absolute\/path npm run acceptance:issue-124:real/);
  assert.ok(scenario.prohibitedSideEffects.includes("browser approval assertion"));
  assert.ok(scenario.prohibitedSideEffects.includes("credential copy or transfer"));
  assert.ok(scenario.prohibitedSideEffects.includes("dangerous mode"));
  assert.deepEqual(manifest.verification.typedProviderOutcomes, [
    "provider_cli_unavailable",
    "provider_authentication_missing",
    "provider_authentication_failed",
    "provider_network_unavailable",
    "provider_outage",
    "provider_quota_unavailable",
    "provider_model_behavior_unconfirmed",
    "provider_adapter_failed",
  ]);
});

test("issue 124 real-Claude acceptance fails closed unless its human gate is explicit", async () => {
  await assert.rejects(execFileAsync(process.execPath, [
    fileURLToPath(new URL("./run-installed-claude-acceptance.mjs", import.meta.url)),
    fileURLToPath(new URL("../acceptance/issue-124.manifest.json", import.meta.url)),
  ], {
    cwd: repositoryRoot,
    env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
  }), (error) => {
    assert.match(error.stderr, /issue_124_real_acceptance_gate_closed/);
    return true;
  });
});

test("retained issue 124 evidence identifies the unchanged demonstrated revision", {
  skip: evidenceExists ? false : "generated after the implementation commit",
}, async () => {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", `${evidence.generatedFromCommit}^{commit}`],
    { cwd: repositoryRoot },
  );
  assert.equal(stdout.trim(), evidence.generatedFromCommit);
  await execFileAsync("git", [
    "merge-base", "--is-ancestor", evidence.generatedFromCommit, "HEAD",
  ], { cwd: repositoryRoot });
  const { stdout: changes } = await execFileAsync("git", [
    "diff", "--name-only", `${evidence.generatedFromCommit}..HEAD`, "--",
    ...ISSUE_124_DEMONSTRATED_PATHS,
  ], { cwd: repositoryRoot });
  assert.equal(changes.trim(), "", `retained evidence predates demonstrated changes:\n${changes}`);
});

test("retained issue 124 evidence proves the provider-neutral installed-CLI contract", {
  skip: evidenceExists ? false : "generated after the implementation commit",
}, () => {
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.issue, 124);
  assert.equal(evidence.parentPrd, 125);
  assert.equal(evidence.scenario,
    "local-walking-skeleton/operates-installed-claude-controller");
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
  assert.deepEqual(evidence.automatedClaudeContract, {
    executable: "no-model contract fixture",
    authenticatedInteractionFabricated: false,
    providerId: "claude-code",
    providerAdapterId: "claude-code-controller-adapter-v1",
    adapterProtocol: "1.0.0",
    reportedVersion: "2.1.141",
    destinationLocalAuthentication: true,
    pluginId: "sandking-controller",
    pluginVersion: "1.0.0",
    pluginScope: "user",
  });
  assert.match(evidence.focusedSession.sessionId, /^controller-session-[a-f0-9]{24}$/);
  assert.match(evidence.focusedSession.providerSessionId,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(evidence.focusedSession.stableProviderSessionIdentity, true);
  assert.equal(evidence.focusedSession.ptyRuntimeOwned, true);
  assert.equal(evidence.focusedSession.survivedBrowserDisconnection, true);
  assert.equal(evidence.focusedSession.oneWritableAttachmentContractTested, true);
  assert.equal(evidence.focusedSession.readOnlyObserverContractTested, true);
  assert.deepEqual(evidence.sharedInterfaces, [
    "cockpit.project-focused-session",
    "controller-runtime.provider-session",
    "controller.work-context.inspect",
    "controller.launch-request.prepare",
    "controller.launch-request.decide",
    "controller.harness-run.start",
    "cockpit.harness-run.observe",
  ]);
  assert.deepEqual(evidence.typedProviderOutcomesTested,
    manifest.verification.typedProviderOutcomes);
  assert.ok(Object.values(evidence.securityAssertions).every(Boolean));
  assert.ok(Object.values(evidence.prohibitedSideEffectAssertions).every((value) =>
    value === false));
  assert.equal(evidence.environmentGateDiagnostic.modelInvoked, false);
  assert.equal(evidence.environmentGateDiagnostic.credentialsTransferred, false);
  assert.ok(["available", "unavailable", "unauthenticated"].includes(
    evidence.environmentGateDiagnostic.status,
  ));
  assert.deepEqual(evidence.realClaudeExecution, {
    status: "reserved-for-final-human-environment-acceptance-child",
    deterministicMergeOracle: false,
    executionCommand: manifest.environmentGate.executionCommand,
  });
  assert.doesNotMatch(JSON.stringify(evidence),
    /ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|bootstrap\?token=|sandking_session=/i);
});
