import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ISSUE_123_DEMONSTRATED_PATHS = Object.freeze([
  "README.md",
  "package.json",
  "package-lock.json",
  "src",
  "acceptance/issue-123.manifest.json",
  "test/browser-protocol.test.mjs",
  "test/planning-spine.test.mjs",
  "test/planning-spine.browser.test.mjs",
  "test/run-issue-123-acceptance.mjs",
  "test/issue-123-evidence-source.mjs",
]);

/**
 * @param {{repositoryRoot: string, demonstratedPaths: readonly string[]}} options
 */
export const captureCleanEvidenceSourceRevision = async ({
  repositoryRoot,
  demonstratedPaths,
}) => {
  if (demonstratedPaths.length === 0) {
    throw new Error("issue_123_evidence_source_paths_missing");
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
    throw new Error(`issue_123_evidence_source_dirty: ${dirtyPaths}`);
  }
  return revisionOutput.trim();
};

/**
 * @param {{
 *   repositoryRoot: string,
 *   demonstratedPaths: readonly string[],
 *   expectedRevision: string,
 * }} options
 */
export const verifyEvidenceSourceRevisionUnchanged = async ({
  repositoryRoot,
  demonstratedPaths,
  expectedRevision,
}) => {
  const currentRevision = await captureCleanEvidenceSourceRevision({
    repositoryRoot,
    demonstratedPaths,
  });
  if (currentRevision !== expectedRevision) {
    throw new Error(
      `issue_123_evidence_source_changed: expected ${expectedRevision}, got ${currentRevision}`,
    );
  }
};
