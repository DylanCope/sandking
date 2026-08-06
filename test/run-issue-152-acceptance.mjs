import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  captureCleanIssue152EvidenceRevision,
  verifyIssue152EvidenceRevisionUnchanged,
} from "./issue-152-evidence-source.mjs";

const execFileAsync = promisify(execFile);
const updateEvidence = process.argv.includes("--update-evidence");
const manifestPath = resolve(
  process.argv.find((argument) => argument.endsWith(".json"))
    ?? "acceptance/issue-152.manifest.json",
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (
  manifest.schemaVersion !== 1
  || manifest.issue !== 152
  || manifest.parentPrd !== null
  || manifest.scenarios?.[0]?.id
    !== "harness-launch/uses-one-action-from-cockpit-and-controller"
  || !Array.isArray(manifest.verification?.commands)
) {
  throw new Error("issue_152_acceptance_manifest_invalid");
}

const repositoryRoot = process.cwd();
const evidenceSourceRevision = updateEvidence
  ? await captureCleanIssue152EvidenceRevision({ repositoryRoot })
  : null;
if (updateEvidence) {
  const { stdout } = await execFileAsync(
    "gh",
    ["issue", "view", "152", "--json", "body"],
    { cwd: repositoryRoot },
  );
  const liveBodyHash = createHash("sha256")
    .update(JSON.parse(stdout).body)
    .digest("hex");
  if (liveBodyHash !== manifest.sourceIssue.githubBodyUtf8Sha256) {
    throw new Error("issue_152_source_revision_mismatch");
  }
}

for (const [command, ...args] of manifest.verification.commands) {
  const executable = command === "node" ? process.execPath : command;
  const result = await execFileAsync(executable, args, {
    cwd: repositoryRoot,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

if (await access(resolve(repositoryRoot, "src", "claude-controller-plugin"))
  .then(() => true, () => false)) {
  throw new Error("issue_152_retired_plugin_present");
}
if (updateEvidence) {
  await verifyIssue152EvidenceRevisionUnchanged({
    repositoryRoot,
    expectedRevision: evidenceSourceRevision,
  });
  const evidence = {
    schemaVersion: 1,
    issue: 152,
    parentPrd: null,
    sourceIssue: manifest.sourceIssue,
    generatedFromCommit: evidenceSourceRevision,
    recordedAt: new Date().toISOString(),
    scenario: manifest.scenarios[0].id,
    verificationCommands: manifest.verification.commands,
    assertions: {
      oneRevisionFreeHostLaunch: true,
      freshProjectLaunch: true,
      cockpitSinglePersistedConfirmation: true,
      ordinaryControllerCliDiscoverable: true,
      ordinaryControllerCliLaunch: true,
      claudePluginAbsent: true,
      revisionDriftFailureAbsent: true,
      mainEraHarnessRunsReadable: true,
      mainEraControllerSessionsReadable: true,
      typedClaudeStopFailuresPreserved: true,
      bootstrapSessionAuditTerminalProjectHostCoveragePassed: true,
    },
    supersedesHistoricalFreshnessForIssues: [118, 119, 120, 121, 122, 123, 124, 146, 149],
    realProviderEvidence: {
      required: true,
      artifact: "acceptance/evidence/issue-152.real.json",
      fabricatedByDeterministicRun: false,
    },
  };
  const evidencePath = resolve(dirname(manifestPath), "evidence", "issue-152.json");
  await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Retained sanitized evidence: ${evidencePath}\n`);
}
