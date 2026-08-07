import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  captureCleanIssue146EvidenceRevision,
  ISSUE_146_DEMONSTRATED_PATHS,
} from "./issue-146-evidence-source.mjs";
import { verifyRetainedEvidenceCurrentOrSuperseded } from "./retained-evidence-supersession.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(
  new URL("../acceptance/issue-146.manifest.json", import.meta.url),
  "utf8",
));
const evidenceUrl = new URL("../acceptance/evidence/issue-146.json", import.meta.url);
const realEvidenceUrl = new URL("../acceptance/evidence/issue-146.real.json", import.meta.url);
const replacementRealEvidenceUrl = new URL(
  "../acceptance/evidence/issue-152.real.json",
  import.meta.url,
);
const evidenceExists = await access(evidenceUrl).then(() => true, () => false);
const realEvidenceExists = await access(realEvidenceUrl).then(() => true, () => false);
const replacementRealEvidenceExists = await access(replacementRealEvidenceUrl)
  .then(() => true, () => false);
const evidence = evidenceExists
  ? JSON.parse(await readFile(evidenceUrl, "utf8"))
  : null;
const realEvidence = realEvidenceExists
  ? JSON.parse(await readFile(realEvidenceUrl, "utf8"))
  : null;

test("issue 146 evidence source rejects dirty demonstrated paths", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "sandking-issue-146-evidence-"));
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: fixture });
    await mkdir(join(fixture, "src"));
    await writeFile(join(fixture, "src", "cockpit.js"), "export const ready = false;\n");
    await execFileAsync("git", ["add", "src/cockpit.js"], { cwd: fixture });
    await execFileAsync("git", [
      "-c", "user.name=Sand-King Test",
      "-c", "user.email=sandking-test@example.invalid",
      "commit", "--quiet", "-m", "fixture",
    ], { cwd: fixture });
    assert.match(await captureCleanIssue146EvidenceRevision({
      repositoryRoot: fixture,
      demonstratedPaths: ["src/cockpit.js"],
    }), /^[a-f0-9]{40}$/);
    await writeFile(join(fixture, "src", "cockpit.js"), "export const ready = true;\n");
    await assert.rejects(captureCleanIssue146EvidenceRevision({
      repositoryRoot: fixture,
      demonstratedPaths: ["src/cockpit.js"],
    }), /issue_146_evidence_source_dirty/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("real-provider supersession fails closed when replacement evidence is absent", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "sandking-real-evidence-supersession-"));
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: fixture });
    const demonstratedPath = join(fixture, "historical-public-seam.txt");
    await writeFile(demonstratedPath, "historical\n");
    await execFileAsync("git", ["add", "historical-public-seam.txt"], { cwd: fixture });
    await execFileAsync("git", [
      "-c", "user.name=Sand-King Test",
      "-c", "user.email=sandking-test@example.invalid",
      "commit", "--quiet", "-m", "historical evidence",
    ], { cwd: fixture });
    const historicalRevision = (await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: fixture },
    )).stdout.trim();

    await writeFile(demonstratedPath, "current\n");
    await execFileAsync("git", ["add", "historical-public-seam.txt"], { cwd: fixture });
    await execFileAsync("git", [
      "-c", "user.name=Sand-King Test",
      "-c", "user.email=sandking-test@example.invalid",
      "commit", "--quiet", "-m", "change public seam",
    ], { cwd: fixture });
    const replacementRevision = (await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: fixture },
    )).stdout.trim();

    await mkdir(join(fixture, "acceptance", "evidence"), { recursive: true });
    await writeFile(
      join(fixture, "acceptance", "evidence", "issue-152.json"),
      `${JSON.stringify({
        issue: 152,
        generatedFromCommit: replacementRevision,
        supersedesHistoricalFreshnessForIssues: [146],
        realProviderEvidence: {
          required: true,
          artifact: "acceptance/evidence/issue-152.real.json",
          fabricatedByDeterministicRun: false,
        },
      })}\n`,
    );

    await assert.rejects(verifyRetainedEvidenceCurrentOrSuperseded({
      repositoryRoot: fixture,
      issue: 146,
      evidence: { generatedFromCommit: historicalRevision },
      demonstratedPaths: ["historical-public-seam.txt"],
      requireRealProvider: true,
    }), (error) => {
      assert.equal(error.code, "ENOENT");
      assert.match(error.path, /issue-152\.real\.json$/);
      return true;
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("issue 146 manifest traces Workbench, terminal, preservation, and real-Claude contracts", () => {
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.issue, 146);
  assert.equal(manifest.parentPrd, 125);
  assert.equal(manifest.sourceSpecification.issue, 116);
  assert.deepEqual(manifest.visualPrimarySource, {
    decisionIssue: 145,
    variant: "A — Workbench",
    immutableCommit: "2467a8d",
  });
  assert.deepEqual(manifest.scenarios.map(({ id }) => id), [
    "cockpit-workbench/operates-interactive-controller-terminal",
    "cockpit-workbench/preserves-slice-1-public-journeys",
  ]);
  const terminalScenario = manifest.scenarios[0];
  for (const effect of [
    "browser approval assertion",
    "terminal transcript retention",
    "second writable attachment",
    "CDN executable or style asset",
    "prototype route, variant switcher, or fake product state",
  ]) {
    assert.ok(terminalScenario.prohibitedSideEffects.includes(effect), effect);
  }
  assert.equal(manifest.environmentGate.name, "SANDKING_REAL_CLAUDE_ACCEPTANCE");
  assert.equal(manifest.environmentGate.workerMayApproveLaunchRequest, false);
  assert.match(manifest.environmentGate.executionCommand,
    /SANDCASTLE_REAL_CLAUDE_ISSUES=146/);
});

test("issue 146 real-Claude acceptance fails closed without the explicit gate", async () => {
  await assert.rejects(execFileAsync(process.execPath, [
    fileURLToPath(new URL("./run-issue-146-real-claude.mjs", import.meta.url)),
    fileURLToPath(new URL("../acceptance/issue-146.manifest.json", import.meta.url)),
  ], {
    cwd: repositoryRoot,
    env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
  }), (error) => {
    assert.match(error.stderr, /issue_146_real_acceptance_gate_closed/);
    return true;
  });
});

test("retained issue 146 evidence proves the unchanged packaged public seam", {
  skip: evidenceExists ? false : "generated after the implementation commit",
}, async () => {
  assert.equal(evidence.issue, 146);
  assert.equal(evidence.scenario,
    "cockpit-workbench/operates-interactive-controller-terminal");
  assert.equal(evidence.visualPrimarySource.immutableCommit, "2467a8d");
  assert.equal(evidence.layout.referenceViewport.width, 1440);
  assert.equal(evidence.layout.referenceViewport.height, 1000);
  assert.equal(evidence.layout.regions.navigationWidth, "220px");
  assert.equal(evidence.layout.regions.contextWidth, "310px");
  assert.equal(evidence.layout.narrowViewport.horizontalPageOverflow, false);
  assert.ok(Object.values(evidence.workbenchChrome).every((value) => value === true));
  assert.equal(evidence.terminal.ansiVtFixture.intendedFinalScreen, true);
  assert.equal(evidence.terminal.ansiVtFixture.transcriptRetained, false);
  assert.equal(evidence.terminal.keyboard.exactBytesOnce, true);
  assert.equal(evidence.terminal.resize.providerObservedAcceptedDimensions, true);
  assert.deepEqual(evidence.terminal.attachmentAuthority, {
    writable: "accepted",
    competingWriter: "terminal_write_attachment_conflict",
    readOnlyInput: "terminal_write_attachment_required",
    invalidBounds: "browser_control_schema_invalid",
    wrongCorrelation: "controller_terminal_not_found",
    staleCorrelation: "terminal_resize_sequence_conflict",
  });
  assert.deepEqual(evidence.terminal.attachmentDelivery, {
    regression: "test/controller-terminal-attachment.test.mjs",
    publicBrowserRegression: "test/workbench-terminal.browser.test.mjs",
    acknowledgementBeforeOutput: true,
    replayBeforeLive: true,
    duplicateSequenceDelivery: false,
  });
  assert.ok(Object.values(evidence.inheritedBrowserScenarios).every((value) =>
    value === "passed"));
  assert.ok(Object.values(evidence.securityAssertions).every((value) => value === false));
  assert.equal(evidence.realClaudeExecution.launchApprovalPermittedForWorker, false);
  assert.doesNotMatch(JSON.stringify(evidence),
    /bootstrap\?token=|sandking_session=|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ALT-SCREEN-DECOY|FINAL STATUS/i);
  await verifyRetainedEvidenceCurrentOrSuperseded({
    repositoryRoot,
    issue: 146,
    evidence,
    demonstratedPaths: ISSUE_146_DEMONSTRATED_PATHS,
  });
});

test("retained issue 146 real-Claude evidence is structural and prohibits Launch effects", {
  skip: !realEvidenceExists
    ? "real installed-Claude environment evidence unavailable"
    : !replacementRealEvidenceExists
      ? "current real installed-Claude supersession is pending in issue 154"
      : false,
}, async () => {
  assert.equal(realEvidence.issue, 146);
  assert.equal(realEvidence.schemaVersion, 2);
  assert.equal(realEvidence.environment.provider, "claude-code");
  assert.equal(realEvidence.observations.productionPublicPath, true);
  assert.equal(realEvidence.observations.workbenchChromeCurrent, true);
  assert.equal(realEvidence.observations.ptyRuntimeOwned, true);
  assert.equal(realEvidence.observations.browserReconnection, true);
  assert.ok(Object.values(realEvidence.prohibitedEffects).every((value) => value === false));
  await verifyRetainedEvidenceCurrentOrSuperseded({
    repositoryRoot,
    issue: 146,
    evidence: realEvidence,
    demonstratedPaths: ISSUE_146_DEMONSTRATED_PATHS,
    requireRealProvider: true,
  });
  assert.doesNotMatch(JSON.stringify(realEvidence),
    /bootstrap\?token=|sandking_session=|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/);
});
