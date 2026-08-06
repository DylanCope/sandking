import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ISSUE_152_DEMONSTRATED_PATHS } from "./issue-152-evidence-source.mjs";

const execFileAsync = promisify(execFile);

const verifyCommitAndChanges = async ({ repositoryRoot, revision, demonstratedPaths }) => {
  const { stdout: resolved } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", `${revision}^{commit}`],
    { cwd: repositoryRoot },
  );
  if (resolved.trim() !== revision) throw new Error("retained_evidence_revision_invalid");
  await execFileAsync("git", ["merge-base", "--is-ancestor", revision, "HEAD"], {
    cwd: repositoryRoot,
  });
  const { stdout: changes } = await execFileAsync("git", [
    "diff", "--name-only", `${revision}..HEAD`, "--", ...demonstratedPaths,
  ], { cwd: repositoryRoot });
  return changes.trim().split("\n").filter(Boolean);
};

/**
 * Closed slice evidence remains historical when #152 intentionally retires
 * its launch ceremony. Current claims come from #152's complete replacement
 * matrix; old artifacts are never relabelled as newly executed evidence.
 */
export const verifyRetainedEvidenceCurrentOrSuperseded = async ({
  repositoryRoot,
  issue,
  evidence,
  demonstratedPaths,
  requireRealProvider = false,
}) => {
  const historicalChanges = await verifyCommitAndChanges({
    repositoryRoot,
    revision: evidence.generatedFromCommit,
    demonstratedPaths,
  });
  if (historicalChanges.length === 0) return { superseded: false };

  const issue152Evidence = JSON.parse(await readFile(
    join(repositoryRoot, "acceptance", "evidence", "issue-152.json"),
    "utf8",
  ));
  if (
    issue152Evidence.issue !== 152
    || !issue152Evidence.supersedesHistoricalFreshnessForIssues?.includes(issue)
    || issue152Evidence.realProviderEvidence?.fabricatedByDeterministicRun !== false
  ) {
    throw new Error(`issue_${issue}_retained_evidence_supersession_invalid`);
  }
  const currentChanges = await verifyCommitAndChanges({
    repositoryRoot,
    revision: issue152Evidence.generatedFromCommit,
    demonstratedPaths: ISSUE_152_DEMONSTRATED_PATHS,
  });
  if (currentChanges.length > 0) {
    throw new Error(`issue_152_evidence_predates_changes:${currentChanges.join(",")}`);
  }

  if (requireRealProvider) {
    const realEvidence = JSON.parse(await readFile(
      join(repositoryRoot, "acceptance", "evidence", "issue-152.real.json"),
      "utf8",
    ));
    if (
      realEvidence.issue !== 152
      || realEvidence.scenario !== "harness-launch/uses-real-installed-claude-controller"
      || realEvidence.environment?.pluginInstalled !== false
      || realEvidence.observations?.ordinaryCliDiscoveredByController !== true
      || !(realEvidence.observations?.acceptedCliDescriptionCount >= 1)
      || realEvidence.observations?.cliDiscoveryPrecededLaunch !== true
      || realEvidence.observations?.ordinaryCliLaunchObserved !== true
      || realEvidence.observations?.acceptedLaunchOperationCount !== 1
      || realEvidence.observations?.browserControllerReattachmentObserved !== true
      || !(realEvidence.observations?.acceptedControllerTerminalAttachmentCount >= 2)
    ) {
      throw new Error("issue_152_real_evidence_invalid");
    }
    const realChanges = await verifyCommitAndChanges({
      repositoryRoot,
      revision: realEvidence.generatedFromCommit,
      demonstratedPaths: ISSUE_152_DEMONSTRATED_PATHS,
    });
    if (realChanges.length > 0) {
      throw new Error(`issue_152_real_evidence_predates_changes:${realChanges.join(",")}`);
    }
  }
  return { superseded: true, historicalChanges };
};
