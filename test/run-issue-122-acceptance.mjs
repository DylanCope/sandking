import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  captureIssue122EvidenceSourceRevision,
  ISSUE_122_DEMONSTRATED_PATHS,
  verifyIssue122EvidenceSourceRevisionUnchanged,
} from "./issue-122-evidence-source.mjs";

const execFileAsync = promisify(execFile);
const updateEvidence = process.argv.includes("--update-evidence");
const manifestPath = resolve(
  process.argv.find((argument) => argument.endsWith(".json"))
    ?? "acceptance/issue-122.manifest.json",
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (
  manifest.schemaVersion !== 2
  || manifest.issue !== 122
  || manifest.parentPrd !== 125
  || manifest.scenarios?.[0]?.id !== "local-walking-skeleton/shows-truthful-failure"
  || !Array.isArray(manifest.verification?.commands)
) {
  throw new Error("issue_122_acceptance_manifest_invalid");
}

const repositoryRoot = process.cwd();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const evidenceSourceRevision = updateEvidence
  ? await captureIssue122EvidenceSourceRevision({
      repositoryRoot,
      demonstratedPaths: ISSUE_122_DEMONSTRATED_PATHS,
    })
  : null;
const resultDirectory = await mkdtemp(join(tmpdir(), "sandking-truthful-failure-evidence-"));
const observationPath = join(resultDirectory, "truthful-failure-browser-observation.json");

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
      maxBuffer: 20 * 1024 * 1024,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }

  if (updateEvidence) {
    await verifyIssue122EvidenceSourceRevisionUnchanged({
      repositoryRoot,
      demonstratedPaths: ISSUE_122_DEMONSTRATED_PATHS,
      expectedRevision: evidenceSourceRevision,
    });
    const readResult = (file) => readFile(join(resultDirectory, file), "utf8")
      .then(JSON.parse);
    const [observation, harnessFailure, launchDecision, launchTerminal] = await Promise.all([
      readFile(observationPath, "utf8").then(JSON.parse),
      readResult("harness-run-failure-contract.json"),
      readResult("launch-decision-contract.json"),
      readResult("launch-terminal-contract.json"),
    ]);
    if (
      observation.scenario !== manifest.scenarios[0].id
      || observation.issue !== 122
      || observation.visibleFailure?.code !== "harness_result_incomplete"
      || observation.staleStateEvidence?.hostStatus !== "disconnected"
    ) {
      throw new Error("issue_122_browser_observation_invalid");
    }
    const resultFiles = await readdir(resultDirectory);
    const hostFailures = (await Promise.all(
      resultFiles
        .filter((file) => file.startsWith("host-") && file.endsWith(".json"))
        .map(readResult),
    )).filter((result) => result.kind === "host_negotiation_failure");
    const hostFailuresByCode = new Map(hostFailures.map((failure) => [
      failure.diagnosis.code,
      failure,
    ]));
    const protocolFailures = manifest.verification.typedProtocolFailures.map((code) => {
      const failure = hostFailuresByCode.get(code);
      if (!failure) {
        throw new Error(`issue_122_protocol_failure_evidence_missing:${code}`);
      }
      return failure;
    });
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
      issue: 122,
      parentPrd: 125,
      sourceSpecification,
      generatedFromCommit: evidenceSourceRevision,
      recordedAt: new Date().toISOString(),
      ...observation,
      contractEvidence: {
        protocolFailures,
        launchDecision,
        launchTerminal,
        harnessFailure,
      },
      verificationCommands: manifest.verification.commands,
    };
    const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
    if (
      /truthful-failure-(?:controller-secret|environment-dump-marker)|ghp_truthfulFailure|bootstrap\?token=|sandking_session=|x-sandking-idempotency-key|\bError: .+\n\s+at/is
        .test(evidenceText)
    ) {
      throw new Error("issue_122_evidence_not_sanitized");
    }
    const evidencePath = resolve(dirname(manifestPath), "evidence", "issue-122.json");
    await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
    await writeFile(evidencePath, evidenceText, { mode: 0o600 });
    process.stdout.write(`Retained sanitized evidence: ${evidencePath}\n`);
  }
} finally {
  await rm(resultDirectory, { recursive: true, force: true });
}
