import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { ISSUE_152_DEMONSTRATED_PATHS } from "./issue-152-evidence-source.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(
  new URL("../acceptance/issue-152.manifest.json", import.meta.url),
  "utf8",
));
const evidenceUrl = new URL("../acceptance/evidence/issue-152.json", import.meta.url);
const realEvidenceUrl = new URL("../acceptance/evidence/issue-152.real.json", import.meta.url);
const evidenceExists = await access(evidenceUrl).then(() => true, () => false);
const realEvidenceExists = await access(realEvidenceUrl).then(() => true, () => false);
const evidence = evidenceExists ? JSON.parse(await readFile(evidenceUrl, "utf8")) : null;

test("issue 152 manifest names both deterministic and real installed-Claude seams", () => {
  assert.equal(manifest.issue, 152);
  assert.equal(manifest.parentPrd, null);
  assert.deepEqual(manifest.scenarios.map(({ id }) => id), [
    "harness-launch/uses-one-action-from-cockpit-and-controller",
    "harness-launch/uses-real-installed-claude-controller",
  ]);
  assert.equal(manifest.environmentGate.requiresInstalledAuthenticatedClaude, true);
  assert.match(manifest.environmentGate.executionCommand, /acceptance:issue-152:real/);
});

test("issue 152 real-Claude gate fails closed without explicit authorization", async () => {
  await assert.rejects(execFileAsync(process.execPath, [
    fileURLToPath(new URL("./run-installed-claude-acceptance.mjs", import.meta.url)),
    fileURLToPath(new URL("../acceptance/issue-152.manifest.json", import.meta.url)),
  ], {
    cwd: repositoryRoot,
    env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
  }), (error) => {
    assert.match(error.stderr, /issue_152_real_acceptance_gate_closed/);
    return true;
  });
});

test("retained issue 152 evidence identifies the unchanged complete public seam", {
  skip: evidenceExists ? false : "generated after the implementation commit",
}, async () => {
  assert.equal(evidence.issue, 152);
  assert.equal(evidence.scenario, manifest.scenarios[0].id);
  await execFileAsync("git", [
    "merge-base", "--is-ancestor", evidence.generatedFromCommit, "HEAD",
  ], { cwd: repositoryRoot });
  const { stdout: changes } = await execFileAsync("git", [
    "diff", "--name-only", `${evidence.generatedFromCommit}..HEAD`, "--",
    ...ISSUE_152_DEMONSTRATED_PATHS,
  ], { cwd: repositoryRoot });
  assert.equal(changes.trim(), "", `issue 152 evidence predates changes:\n${changes}`);
  assert.ok(Object.values(evidence.assertions).every(Boolean));
  assert.equal(evidence.realProviderEvidence.fabricatedByDeterministicRun, false);
});

test("retained issue 152 real evidence proves an installed Claude ordinary-CLI launch", {
  skip: realEvidenceExists ? false : "requires an installed authenticated Claude environment",
}, async () => {
  const realEvidence = JSON.parse(await readFile(realEvidenceUrl, "utf8"));
  assert.equal(realEvidence.issue, 152);
  assert.equal(realEvidence.scenario, manifest.scenarios[1].id);
  assert.equal(realEvidence.environment.pluginInstalled, false);
  assert.equal(realEvidence.observations.ordinaryCliDiscoveredByController, true);
  assert.ok(realEvidence.observations.acceptedCliDescriptionCount >= 1);
  assert.equal(realEvidence.observations.cliDiscoveryPrecededLaunch, true);
  assert.equal(realEvidence.observations.ordinaryCliLaunchObserved, true);
  assert.equal(realEvidence.observations.acceptedLaunchOperationCount, 1);
  assert.equal(realEvidence.observations.selectedLaunchIssueNumber, 152);
  assert.equal(realEvidence.observations.selectedTargetBranch, "sandcastle/issue-152");
  assert.equal(realEvidence.observations.retiredControllerCapabilitiesAbsent, true);
  assert.equal(realEvidence.observations.retiredLaunchLifecycleAuditsAbsent, true);
  assert.equal(realEvidence.observations.browserControllerReattachmentObserved, true);
  assert.ok(realEvidence.observations.acceptedControllerTerminalAttachmentCount >= 2);
  assert.equal(realEvidence.observations.launchRequestCreated, false);
  assert.equal(realEvidence.observations.approvalRecorded, false);
  assert.equal(realEvidence.observations.separateStartRequired, false);
  await execFileAsync("git", [
    "merge-base", "--is-ancestor", realEvidence.generatedFromCommit, "HEAD",
  ], { cwd: repositoryRoot });
  const { stdout: changes } = await execFileAsync("git", [
    "diff", "--name-only", `${realEvidence.generatedFromCommit}..HEAD`, "--",
    ...ISSUE_152_DEMONSTRATED_PATHS,
  ], { cwd: repositoryRoot });
  assert.equal(changes.trim(), "", `issue 152 real evidence predates changes:\n${changes}`);
});
