import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  captureCleanIssue149EvidenceRevision,
  ISSUE_149_DEMONSTRATED_PATHS,
} from "./issue-149-evidence-source.mjs";
import { verifyRetainedEvidenceCurrentOrSuperseded } from "./retained-evidence-supersession.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(
  new URL("../acceptance/issue-149.manifest.json", import.meta.url),
  "utf8",
));
const evidenceUrl = new URL("../acceptance/evidence/issue-149.json", import.meta.url);
const evidenceExists = await access(evidenceUrl).then(() => true, () => false);
const evidence = evidenceExists
  ? JSON.parse(await readFile(evidenceUrl, "utf8"))
  : null;

test("issue 149 evidence source rejects dirty demonstrated paths", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "sandking-issue-149-evidence-"));
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
    assert.match(await captureCleanIssue149EvidenceRevision({
      repositoryRoot: fixture,
      demonstratedPaths: ["src/cockpit.js"],
    }), /^[a-f0-9]{40}$/);
    await writeFile(join(fixture, "src", "cockpit.js"), "export const ready = true;\n");
    await assert.rejects(captureCleanIssue149EvidenceRevision({
      repositoryRoot: fixture,
      demonstratedPaths: ["src/cockpit.js"],
    }), /issue_149_evidence_source_dirty/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("issue 149 manifest traces phone usability and inherited Workbench contracts", () => {
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.issue, 149);
  assert.equal(manifest.parentPrd, 125);
  assert.equal(manifest.sourceSpecification.issue, 116);
  assert.deepEqual(manifest.scenarios.map(({ id }) => id), [
    "cockpit-workbench/operates-mobile-controller-terminal",
    "cockpit-workbench/preserves-desktop-tablet-and-slice-1-journeys",
  ]);
  const mobileScenario = manifest.scenarios[0];
  for (const effect of [
    "horizontal page overflow at phone width",
    "duplicate or dropped mobile PTY input",
    "browser approval assertion",
    "terminal transcript retention or terminal-output parsing",
    "second writable attachment or changed terminal protocol",
  ]) {
    assert.ok(mobileScenario.prohibitedSideEffects.includes(effect), effect);
  }
  assert.equal(manifest.installedClaudeHumanAcceptance.ownerIssue, 126);
  assert.equal(manifest.installedClaudeHumanAcceptance.actualMobileBrowserRequired, true);
  assert.equal(manifest.installedClaudeHumanAcceptance.workerMayApproveLaunchRequest, false);
  const verifiedTests = manifest.verification.commands.flat().filter((entry) =>
    entry.endsWith?.(".test.mjs"));
  assert.ok(verifiedTests.includes("test/workbench-terminal.browser.test.mjs"));
  assert.ok(verifiedTests.includes("test/mobile-workbench-terminal.browser.test.mjs"));
});

test("retained issue 149 evidence proves the unchanged packaged mobile seam", {
  skip: evidenceExists ? false : "generated after the implementation commit",
}, async () => {
  assert.equal(evidence.issue, 149);
  assert.equal(evidence.scenario,
    "cockpit-workbench/operates-mobile-controller-terminal");
  assert.deepEqual(evidence.layout.phoneViewport, { width: 390, height: 844 });
  assert.equal(evidence.layout.horizontalPageOverflow, false);
  assert.equal(evidence.layout.navigationDrawer, true);
  assert.equal(evidence.layout.contextDrawer, true);
  assert.equal(evidence.terminal.ansiVtFixture.sameIntendedFinalScreenAsDesktop, true);
  assert.equal(evidence.terminal.ansiVtFixture.transcriptRetained, false);
  assert.ok(Object.entries(evidence.terminal.mobileInput)
    .filter(([key]) => key !== "observedInputAuditCount")
    .every(([, value]) => value === true));
  assert.deepEqual(evidence.terminal.touchIsolation, {
    terminalScrollbackMoved: true,
    pageDidNotScroll: true,
    stageDidNotScroll: true,
    drawersDidNotToggle: true,
    unintendedSelection: false,
    drawerGestureChangedTerminalScroll: false,
    drawerGestureSentTerminalInput: false,
  });
  assert.ok(Object.values(evidence.inheritedAcceptance).every((value) =>
    value === "passed"));
  assert.ok(Object.values(evidence.securityAssertions).every((value) => value === false));
  assert.equal(evidence.installedClaudeHumanAcceptance.ownerIssue, 126);
  assert.equal(
    evidence.installedClaudeHumanAcceptance.performedByThisDeterministicWorker,
    false,
  );
  assert.doesNotMatch(JSON.stringify(evidence),
    /bootstrap\?token=|sandking_session=|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|mobile printable|scrollback-|ALT-SCREEN-DECOY|FINAL STATUS/i);
  await verifyRetainedEvidenceCurrentOrSuperseded({
    repositoryRoot,
    issue: 149,
    evidence,
    demonstratedPaths: ISSUE_149_DEMONSTRATED_PATHS,
  });
});
