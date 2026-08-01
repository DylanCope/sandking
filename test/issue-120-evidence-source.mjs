import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ISSUE_120_DEMONSTRATED_PATHS = Object.freeze([
  "README.md",
  "package.json",
  "package-lock.json",
  "src",
  "acceptance/issue-120.manifest.json",
  "test/browser-launch.mjs",
  "test/browser-protocol.test.mjs",
  "test/controller-launch-session.test.mjs",
  "test/harness-run.browser.test.mjs",
  "test/harness-run.test.mjs",
  "test/installed-package.mjs",
  "test/launch-request.test.mjs",
  "test/protocol.test.mjs",
  "test/run-issue-120-acceptance.mjs",
  "test/issue-120-evidence-source.mjs"
]);

export const captureIssue120EvidenceSourceRevision = async ({
  repositoryRoot,
  demonstratedPaths,
}) => {
  if (demonstratedPaths.length === 0) {
    throw new Error("issue_120_evidence_source_paths_missing");
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
  const dirtyPaths = statusOutput.trim();
  if (dirtyPaths.length > 0) {
    throw new Error(`issue_120_evidence_source_dirty: ${dirtyPaths}`);
  }
  return revisionOutput.trim();
};

export const verifyIssue120EvidenceSourceRevisionUnchanged = async ({
  repositoryRoot,
  demonstratedPaths,
  expectedRevision,
}) => {
  const currentRevision = await captureIssue120EvidenceSourceRevision({
    repositoryRoot,
    demonstratedPaths,
  });
  if (currentRevision !== expectedRevision) {
    throw new Error(
      `issue_120_evidence_source_changed: expected ${expectedRevision}, got ${currentRevision}`,
    );
  }
};
