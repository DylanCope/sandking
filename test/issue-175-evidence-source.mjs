import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ISSUE_175_DEMONSTRATED_PATHS = Object.freeze([
  "CONTEXT.md",
  "README.md",
  "package.json",
  "package-lock.json",
  "src",
  ".sandcastle/real-delegation-prompt.md",
  "acceptance/issue-152.manifest.json",
  "acceptance/issue-164.manifest.json",
  "acceptance/issue-174.manifest.json",
  "acceptance/issue-175.manifest.json",
  "acceptance/evidence/issue-152.json",
  "acceptance/evidence/issue-164.json",
  "acceptance/evidence/issue-174.real.json",
  "acceptance/evidence/issue-174.post-proof.json",
  "test",
]);

export const captureCleanIssue175EvidenceRevision = async ({
  repositoryRoot,
  demonstratedPaths = ISSUE_175_DEMONSTRATED_PATHS,
}) => {
  const { stdout: revision } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { cwd: repositoryRoot },
  );
  const { stdout: status } = await execFileAsync(
    "git",
    ["status", "--short", "--untracked-files=all", "--", ...demonstratedPaths],
    { cwd: repositoryRoot },
  );
  if (status.trim()) {
    throw new Error(`issue_175_evidence_source_dirty: ${status.trim()}`);
  }
  return revision.trim();
};

export const verifyIssue175EvidenceRevisionUnchanged = async ({
  repositoryRoot,
  expectedRevision,
}) => {
  const currentRevision = await captureCleanIssue175EvidenceRevision({ repositoryRoot });
  if (currentRevision !== expectedRevision) {
    throw new Error(
      `issue_175_evidence_source_changed: expected ${expectedRevision}, got ${currentRevision}`,
    );
  }
};

const prohibitedEvidenceKeys = new Set([
  "credentialValue",
  "rawIdempotencyKey",
  "providerTranscript",
  "unrestrictedLog",
  "environmentDump",
  "reusableSessionMaterial",
  "machineSpecificSecretPath",
  "fullSkillContent",
]);

export const assertIssue175EvidenceSanitized = (evidence) => {
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (prohibitedEvidenceKeys.has(key)) {
        throw new Error(`issue_175_evidence_prohibited_field:${key}`);
      }
      visit(nested);
    }
  };
  visit(evidence);
  const serialized = JSON.stringify(evidence);
  if (
    /(?:sk-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9]{12,}|bootstrap\?token=|sandking_session=)/i
      .test(serialized)
    || /(?:^|["\s])(?:\/home\/|\/Users\/|[A-Za-z]:\\\\Users\\\\)/.test(serialized)
  ) {
    throw new Error("issue_175_evidence_not_sanitized");
  }
};
