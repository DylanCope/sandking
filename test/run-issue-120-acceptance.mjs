import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  captureIssue120EvidenceSourceRevision,
  ISSUE_120_DEMONSTRATED_PATHS,
  verifyIssue120EvidenceSourceRevisionUnchanged,
} from "./issue-120-evidence-source.mjs";

const execFileAsync = promisify(execFile);
const updateEvidence = process.argv.includes("--update-evidence");
const manifestPath = resolve(
  process.argv.find((argument) => argument.endsWith(".json"))
    ?? "acceptance/issue-120.manifest.json",
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (
  manifest.schemaVersion !== 2
  || manifest.issue !== 120
  || manifest.parentPrd !== 125
  || manifest.scenarios?.[0]?.id !== "local-walking-skeleton/completes-approved-run"
  || !Array.isArray(manifest.verification?.commands)
) {
  throw new Error("issue_120_acceptance_manifest_invalid");
}

const repositoryRoot = process.cwd();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const evidenceSourceRevision = updateEvidence
  ? await captureIssue120EvidenceSourceRevision({
      repositoryRoot,
      demonstratedPaths: ISSUE_120_DEMONSTRATED_PATHS,
    })
  : null;
const resultDirectory = await mkdtemp(join(tmpdir(), "sandking-harness-run-evidence-"));
const observationPath = join(resultDirectory, "harness-run-browser-observation.json");

try {
  for (const [command, ...args] of manifest.verification.commands) {
    const executable = command === "node" ? process.execPath : command;
    const result = await execFileAsync(executable, args, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ...(updateEvidence ? {
          SANDKING_ACCEPTANCE_OBSERVATION_PATH: observationPath,
          SANDKING_ACCEPTANCE_RESULT_DIR: resultDirectory,
        } : {}),
      },
      maxBuffer: 10 * 1024 * 1024,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }

  if (updateEvidence) {
    await verifyIssue120EvidenceSourceRevisionUnchanged({
      repositoryRoot,
      demonstratedPaths: ISSUE_120_DEMONSTRATED_PATHS,
      expectedRevision: evidenceSourceRevision,
    });
    const [observation, successContract, failureContract] = await Promise.all([
      readFile(observationPath, "utf8").then(JSON.parse),
      readFile(join(resultDirectory, "harness-run-success-contract.json"), "utf8")
        .then(JSON.parse),
      readFile(join(resultDirectory, "harness-run-failure-contract.json"), "utf8")
        .then(JSON.parse),
    ]);
    if (observation.scenario !== manifest.scenarios[0].id || observation.issue !== 120) {
      throw new Error("issue_120_browser_observation_invalid");
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
      issue: 120,
      parentPrd: 125,
      sourceSpecification,
      generatedFromCommit: evidenceSourceRevision,
      recordedAt: new Date().toISOString(),
      ...observation,
      contractEvidence: {
        success: successContract,
        truthfulFailure: failureContract,
      },
      verificationCommands: manifest.verification.commands,
    };
    const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
    if (
      /harness-run-browser-secret|bootstrap\?token=|sandking_session=|provider:controller-session/i
        .test(evidenceText)
    ) {
      throw new Error("issue_120_evidence_not_sanitized");
    }
    const evidencePath = resolve(dirname(manifestPath), "evidence", "issue-120.json");
    await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
    await writeFile(evidencePath, evidenceText, { mode: 0o600 });
    process.stdout.write(`Retained sanitized evidence: ${evidencePath}\n`);
  }
} finally {
  await rm(resultDirectory, { recursive: true, force: true });
}
