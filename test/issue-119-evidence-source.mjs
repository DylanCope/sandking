import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ISSUE_119_DEMONSTRATED_PATHS = Object.freeze([
  "README.md",
  "package.json",
  "package-lock.json",
  "src",
  "acceptance/issue-119.manifest.json",
  "test/browser-launch.mjs",
  "test/browser-protocol.test.mjs",
  "test/controller-launch-session.test.mjs",
  "test/installed-package.mjs",
  "test/launch-request-host.test.mjs",
  "test/launch-request.browser.test.mjs",
  "test/launch-request.test.mjs",
  "test/protocol.test.mjs",
  "test/run-issue-119-acceptance.mjs",
  "test/issue-119-evidence-source.mjs"
]);

/**
 * @param {{repositoryRoot: string, demonstratedPaths: readonly string[]}} options
 */
export const captureIssue119EvidenceSourceRevision = async ({
  repositoryRoot,
  demonstratedPaths,
}) => {
  if (demonstratedPaths.length === 0) {
    throw new Error("issue_119_evidence_source_paths_missing");
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
    throw new Error(`issue_119_evidence_source_dirty: ${dirtyPaths}`);
  }
  return revisionOutput.trim();
};

/**
 * @param {{repositoryRoot: string, demonstratedPaths: readonly string[], expectedRevision: string}} options
 */
export const verifyIssue119EvidenceSourceRevisionUnchanged = async ({
  repositoryRoot,
  demonstratedPaths,
  expectedRevision,
}) => {
  const currentRevision = await captureIssue119EvidenceSourceRevision({
    repositoryRoot,
    demonstratedPaths,
  });
  if (currentRevision !== expectedRevision) {
    throw new Error(
      `issue_119_evidence_source_changed: expected ${expectedRevision}, got ${currentRevision}`,
    );
  }
};
