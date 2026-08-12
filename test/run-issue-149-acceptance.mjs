import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  captureCleanIssue149EvidenceRevision,
  ISSUE_149_DEMONSTRATED_PATHS,
  verifyIssue149EvidenceRevisionUnchanged,
} from "./issue-149-evidence-source.mjs";

const execFileAsync = promisify(execFile);
const updateEvidence = process.argv.includes("--update-evidence");
const manifestPath = resolve(
  process.argv.find((argument) => argument.endsWith(".json"))
    ?? "acceptance/issue-149.manifest.json",
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (
  manifest.schemaVersion !== 2
  || manifest.issue !== 149
  || manifest.parentPrd !== 125
  || manifest.scenarios?.[0]?.id
    !== "cockpit-workbench/operates-mobile-controller-terminal"
  || manifest.installedClaudeHumanAcceptance?.ownerIssue !== 126
  || manifest.installedClaudeHumanAcceptance?.workerMayApproveLaunchRequest !== false
  || !Array.isArray(manifest.verification?.commands)
) {
  throw new Error("issue_149_acceptance_manifest_invalid");
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const repositoryRoot = process.cwd();
const evidenceSourceRevision = updateEvidence
  ? await captureCleanIssue149EvidenceRevision({
      repositoryRoot,
      demonstratedPaths: ISSUE_149_DEMONSTRATED_PATHS,
    })
  : null;
const observationDirectory = await mkdtemp(join(tmpdir(), "sandking-mobile-evidence-"));
const observationPath = join(observationDirectory, "mobile-workbench-observation.json");

try {
  for (const [command, ...args] of manifest.verification.commands) {
    const result = await execFileAsync(command === "node" ? process.execPath : command, args, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ...(updateEvidence && args.includes("test/mobile-workbench-terminal.browser.test.mjs")
          ? { SANDKING_ACCEPTANCE_OBSERVATION_PATH: observationPath }
          : {}),
      },
      maxBuffer: 20 * 1024 * 1024,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }

  if (updateEvidence) {
    await verifyIssue149EvidenceRevisionUnchanged({
      repositoryRoot,
      demonstratedPaths: ISSUE_149_DEMONSTRATED_PATHS,
      expectedRevision: evidenceSourceRevision,
    });
    const observation = JSON.parse(await readFile(observationPath, "utf8"));
    if (observation.scenario
        !== "cockpit-workbench/operates-mobile-controller-terminal") {
      throw new Error("issue_149_browser_observation_invalid");
    }
    const { stdout: liveSpecificationOutput } = await execFileAsync(
      "gh",
      ["issue", "view", String(manifest.sourceSpecification.issue), "--json", "body"],
      { cwd: repositoryRoot },
    );
    const liveSpecificationBody = JSON.parse(liveSpecificationOutput).body;
    const sourceSpecification = {
      issue: manifest.sourceSpecification.issue,
      githubBodyUtf8Sha256: sha256(liveSpecificationBody),
      parentApprovedTextExportSha256: sha256(`${liveSpecificationBody}\n`),
      parentApprovedHashBasis: manifest.sourceSpecification.parentApprovedHashBasis,
      normalizationDifference: "one terminal LF",
      exactContentEquivalentAfterApprovedExportNormalization:
        sha256(`${liveSpecificationBody}\n`)
          === manifest.sourceSpecification.parentApprovedTextExportSha256,
    };
    if (
      sourceSpecification.githubBodyUtf8Sha256
        !== manifest.sourceSpecification.githubBodyUtf8Sha256
      || sourceSpecification.parentApprovedTextExportSha256
        !== manifest.sourceSpecification.parentApprovedTextExportSha256
    ) {
      throw new Error("issue_116_source_revision_mismatch");
    }
    const evidence = {
      schemaVersion: 2,
      issue: 149,
      parentPrd: 125,
      sourceSpecification,
      generatedFromCommit: evidenceSourceRevision,
      recordedAt: new Date().toISOString(),
      ...observation,
      inheritedAcceptance: {
        desktop1440Workbench: "passed",
        tablet700WorkbenchAndDrawers: "passed",
        terminalAttachmentAndResizeAuthority: "passed",
        projectPreparation: "passed",
        builtAreaNavigation: "passed",
        launchRequestInteraction: "passed",
        activeAndTerminalHarnessRunObservation: "passed",
        diagnosticsAndStructuredOutcome: "passed",
        truthfulFailure: "passed",
        canonicalReconnection: "passed",
        installedClaudeContractFixture: "passed",
      },
      installedClaudeHumanAcceptance: {
        ...manifest.installedClaudeHumanAcceptance,
        performedByThisDeterministicWorker: false,
      },
      verificationCommands: manifest.verification.commands,
    };
    const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
    if (
      /bootstrap\?token=|sandking_session=|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|recognizable-.*secret|mobile printable|scrollback-|ALT-SCREEN-DECOY|FINAL STATUS/i
        .test(evidenceText)
    ) {
      throw new Error("issue_149_evidence_not_sanitized");
    }
    const evidencePath = resolve(dirname(manifestPath), "evidence", "issue-149.json");
    await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
    await writeFile(evidencePath, evidenceText, { mode: 0o600 });
    process.stdout.write(`Retained sanitized evidence: ${evidencePath}\n`);
  }
} finally {
  await rm(observationDirectory, { recursive: true, force: true });
}
