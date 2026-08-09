import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ISSUE_164_DEMONSTRATED_PATHS = Object.freeze([
  "CONTEXT.md",
  "README.md",
  "package.json",
  "package-lock.json",
  "src",
  "acceptance/issue-164.manifest.json",
  "test",
]);

export const captureCleanIssue164EvidenceRevision = async ({ repositoryRoot }) => {
  const { stdout: revision } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { cwd: repositoryRoot },
  );
  const { stdout: status } = await execFileAsync(
    "git",
    ["status", "--short", "--untracked-files=all", "--", ...ISSUE_164_DEMONSTRATED_PATHS],
    { cwd: repositoryRoot },
  );
  if (status.trim()) {
    throw new Error(`issue_164_evidence_source_dirty: ${status.trim()}`);
  }
  return revision.trim();
};

export const verifyIssue164EvidenceRevisionUnchanged = async ({
  repositoryRoot,
  expectedRevision,
}) => {
  const currentRevision = await captureCleanIssue164EvidenceRevision({ repositoryRoot });
  if (currentRevision !== expectedRevision) {
    throw new Error(
      `issue_164_evidence_source_changed: expected ${expectedRevision}, got ${currentRevision}`,
    );
  }
};
