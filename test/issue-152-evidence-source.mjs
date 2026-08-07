import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ISSUE_152_DEMONSTRATED_PATHS = Object.freeze([
  "CONTEXT.md",
  "README.md",
  "package.json",
  "package-lock.json",
  "src",
  "acceptance/issue-152.manifest.json",
  "test",
]);

export const captureCleanIssue152EvidenceRevision = async ({ repositoryRoot }) => {
  const { stdout: revision } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { cwd: repositoryRoot },
  );
  const { stdout: status } = await execFileAsync(
    "git",
    ["status", "--short", "--untracked-files=all", "--", ...ISSUE_152_DEMONSTRATED_PATHS],
    { cwd: repositoryRoot },
  );
  if (status.trim()) {
    throw new Error(`issue_152_evidence_source_dirty: ${status.trim()}`);
  }
  return revision.trim();
};

export const verifyIssue152EvidenceRevisionUnchanged = async ({
  repositoryRoot,
  expectedRevision,
}) => {
  const currentRevision = await captureCleanIssue152EvidenceRevision({ repositoryRoot });
  if (currentRevision !== expectedRevision) {
    throw new Error(
      `issue_152_evidence_source_changed: expected ${expectedRevision}, got ${currentRevision}`,
    );
  }
};
