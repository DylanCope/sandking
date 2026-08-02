import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ISSUE_124_DEMONSTRATED_PATHS = Object.freeze([
  "README.md",
  "package.json",
  "package-lock.json",
  "src/browser-protocol.mjs",
  "src/claude-controller-plugin",
  "src/claude-provider-adapter.mjs",
  "src/cockpit.js",
  "src/controller-sessions.mjs",
  "src/runtime-daemon.mjs",
  "acceptance/issue-124.manifest.json",
  "test/browser-protocol.test.mjs",
  "test/claude-controller-plugin.test.mjs",
  "test/claude-controller-session.test.mjs",
  "test/claude-controller.browser.test.mjs",
  "test/claude-provider-adapter.test.mjs",
  "test/claude-acceptance-evidence.test.mjs",
  "test/issue-124-evidence-source.mjs",
  "test/installed-claude-acceptance-audits.mjs",
  "test/installed-claude-acceptance-audits.test.mjs",
  "test/run-installed-claude-acceptance.mjs",
  "test/run-issue-124-acceptance.mjs"
]);

export const captureCleanIssue124EvidenceRevision = async ({
  repositoryRoot,
  demonstratedPaths,
}) => {
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
    throw new Error(`issue_124_evidence_source_dirty: ${statusOutput.trim()}`);
  }
  return revisionOutput.trim();
};

export const verifyIssue124EvidenceRevisionUnchanged = async ({
  repositoryRoot,
  demonstratedPaths,
  expectedRevision,
}) => {
  const actualRevision = await captureCleanIssue124EvidenceRevision({
    repositoryRoot,
    demonstratedPaths,
  });
  if (actualRevision !== expectedRevision) {
    throw new Error(
      `issue_124_evidence_source_changed: expected ${expectedRevision}, got ${actualRevision}`,
    );
  }
};
