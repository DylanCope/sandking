import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ISSUE_146_DEMONSTRATED_PATHS = Object.freeze([
  "package.json",
  "package-lock.json",
  "src/browser-protocol.mjs",
  "src/cockpit.css",
  "src/cockpit.js",
  "src/conformance-provider-adapter.mjs",
  "src/controller-sessions.mjs",
  "src/runtime-daemon.mjs",
  "acceptance/issue-146.manifest.json",
  "test/browser-protocol.test.mjs",
  "test/controller-launch-session.test.mjs",
  "test/security-boundary.test.mjs",
  "test/workbench-terminal.browser.test.mjs",
  "test/project-preparation.browser.test.mjs",
  "test/planning-spine.browser.test.mjs",
  "test/launch-request.browser.test.mjs",
  "test/harness-run.browser.test.mjs",
  "test/reconnect-canonical.browser.test.mjs",
  "test/truthful-failure.browser.test.mjs",
  "test/claude-controller.browser.test.mjs",
  "test/local-walking-skeleton.browser.test.mjs",
  "test/run-issue-146-acceptance.mjs",
  "test/run-issue-146-real-claude.mjs",
  "test/issue-146-evidence-source.mjs",
  "test/workbench-acceptance-evidence.test.mjs"
]);

export const captureCleanIssue146EvidenceRevision = async ({
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
    throw new Error(`issue_146_evidence_source_dirty: ${statusOutput.trim()}`);
  }
  return revisionOutput.trim();
};

export const verifyIssue146EvidenceRevisionUnchanged = async ({
  repositoryRoot,
  demonstratedPaths,
  expectedRevision,
}) => {
  const current = await captureCleanIssue146EvidenceRevision({
    repositoryRoot,
    demonstratedPaths,
  });
  if (current !== expectedRevision) {
    throw new Error(`issue_146_evidence_source_changed:${expectedRevision}:${current}`);
  }
};
