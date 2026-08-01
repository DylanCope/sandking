import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ISSUE_118_DEMONSTRATED_PATHS = Object.freeze([
  "README.md",
  "package.json",
  "package-lock.json",
  "src",
  "acceptance/issue-118.manifest.json",
  "test/browser-protocol.test.mjs",
  "test/browser-launch.mjs",
  "test/installed-package.mjs",
  "test/launch-runtime.test.mjs",
  "test/local-walking-skeleton.browser.test.mjs",
  "test/project-registration.test.mjs",
  "test/project-preparation.browser.test.mjs",
  "test/run-issue-118-acceptance.mjs",
  "test/issue-118-evidence-source.mjs"
]);

/**
 * @param {{repositoryRoot: string, demonstratedPaths: readonly string[]}} options
 */
export const captureIssue118EvidenceSourceRevision = async ({
  repositoryRoot,
  demonstratedPaths,
}) => {
  if (demonstratedPaths.length === 0) {
    throw new Error("issue_118_evidence_source_paths_missing");
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
    throw new Error(`issue_118_evidence_source_dirty: ${dirtyPaths}`);
  }
  return revisionOutput.trim();
};

/**
 * @param {{repositoryRoot: string, demonstratedPaths: readonly string[], expectedRevision: string}} options
 */
export const verifyIssue118EvidenceSourceRevisionUnchanged = async ({
  repositoryRoot,
  demonstratedPaths,
  expectedRevision,
}) => {
  const currentRevision = await captureIssue118EvidenceSourceRevision({
    repositoryRoot,
    demonstratedPaths,
  });
  if (currentRevision !== expectedRevision) {
    throw new Error(
      `issue_118_evidence_source_changed: expected ${expectedRevision}, got ${currentRevision}`,
    );
  }
};
