import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ISSUE_122_DEMONSTRATED_PATHS = Object.freeze([
  "README.md",
  "package.json",
  "package-lock.json",
  "src",
  "acceptance/issue-122.manifest.json",
  "test/browser-launch.mjs",
  "test/browser-protocol.test.mjs",
  "test/harness-run.test.mjs",
  "test/host-negotiation.test.mjs",
  "test/installed-package.mjs",
  "test/issue-122-evidence-source.mjs",
  "test/launch-request.test.mjs",
  "test/protocol.test.mjs",
  "test/run-issue-122-acceptance.mjs",
  "test/truthful-failure.browser.test.mjs",
]);

export const captureIssue122EvidenceSourceRevision = async ({
  repositoryRoot,
  demonstratedPaths,
}) => {
  if (demonstratedPaths.length === 0) {
    throw new Error("issue_122_evidence_source_paths_missing");
  }
  const { stdout: revisionOutput } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { cwd: repositoryRoot },
  );
  const { stdout: statusOutput } = await execFileAsync(
    "git",
    ["status", "--short", "--untracked-files=all", "--", ...demonstratedPaths],
    { cwd: repositoryRoot },
  );
  if (statusOutput.trim()) {
    throw new Error(`issue_122_evidence_source_dirty: ${statusOutput.trim()}`);
  }
  return revisionOutput.trim();
};

export const verifyIssue122EvidenceSourceRevisionUnchanged = async ({
  repositoryRoot,
  demonstratedPaths,
  expectedRevision,
}) => {
  const actualRevision = await captureIssue122EvidenceSourceRevision({
    repositoryRoot,
    demonstratedPaths,
  });
  if (actualRevision !== expectedRevision) {
    throw new Error(
      `issue_122_evidence_source_changed: expected ${expectedRevision}, got ${actualRevision}`,
    );
  }
};
