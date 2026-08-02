import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  captureCleanIssue124EvidenceRevision,
  ISSUE_124_DEMONSTRATED_PATHS,
  verifyIssue124EvidenceRevisionUnchanged,
} from "./issue-124-evidence-source.mjs";

const execFileAsync = promisify(execFile);
const updateEvidence = process.argv.includes("--update-evidence");
const manifestPath = resolve(
  process.argv.find((argument) => argument.endsWith(".json"))
    ?? "acceptance/issue-124.manifest.json",
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (
  manifest.schemaVersion !== 2
  || manifest.issue !== 124
  || manifest.parentPrd !== 125
  || manifest.scenarios?.[0]?.id
    !== "local-walking-skeleton/operates-installed-claude-controller"
  || manifest.environmentGate?.name !== "SANDKING_REAL_CLAUDE_ACCEPTANCE"
  || !Array.isArray(manifest.verification?.commands)
) {
  throw new Error("issue_124_acceptance_manifest_invalid");
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const repositoryRoot = process.cwd();
const adapterPath = fileURLToPath(new URL("../src/claude-provider-adapter.mjs", import.meta.url));
const evidenceSourceRevision = updateEvidence
  ? await captureCleanIssue124EvidenceRevision({
      repositoryRoot,
      demonstratedPaths: ISSUE_124_DEMONSTRATED_PATHS,
    })
  : null;
const observationDirectory = await mkdtemp(join(tmpdir(), "sandking-claude-evidence-"));
const observationPath = join(observationDirectory, "claude-contract-observation.json");

try {
  for (const [command, ...args] of manifest.verification.commands) {
    const executable = command === "node" ? process.execPath : command;
    const result = await execFileAsync(executable, args, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ...(updateEvidence
          ? { SANDKING_ACCEPTANCE_OBSERVATION_PATH: observationPath }
          : {}),
      },
      maxBuffer: 10 * 1024 * 1024,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }

  const gateEnvironment = Object.fromEntries([
    "HOME",
    "PATH",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "SANDKING_CLAUDE_EXECUTABLE",
  ].flatMap((name) => typeof process.env[name] === "string"
    ? [[name, process.env[name]]]
    : []));
  const gateProbe = JSON.parse((await execFileAsync(
    process.execPath,
    [adapterPath, "probe"],
    { cwd: repositoryRoot, env: gateEnvironment },
  )).stdout);
  process.stdout.write(
    `Claude environment gate: ${gateProbe.availability.status}`
      + `${gateProbe.availability.failure?.code
        ? ` (${gateProbe.availability.failure.code})`
        : ` (version ${gateProbe.availability.version})`}\n`,
  );

  if (updateEvidence) {
    await verifyIssue124EvidenceRevisionUnchanged({
      repositoryRoot,
      demonstratedPaths: ISSUE_124_DEMONSTRATED_PATHS,
      expectedRevision: evidenceSourceRevision,
    });
    const observation = JSON.parse(await readFile(observationPath, "utf8"));
    if (observation.scenario
        !== "local-walking-skeleton/operates-installed-claude-controller") {
      throw new Error("issue_124_browser_observation_invalid");
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
      issue: 124,
      parentPrd: 125,
      sourceSpecification,
      generatedFromCommit: evidenceSourceRevision,
      recordedAt: new Date().toISOString(),
      ...observation,
      environmentGateDiagnostic: {
        status: gateProbe.availability.status,
        version: gateProbe.availability.version,
        authentication: gateProbe.availability.authentication.status,
        authenticationSource: gateProbe.availability.authentication.source,
        failureCode: gateProbe.availability.failure?.code ?? null,
        capabilities: gateProbe.capabilities,
        modelInvoked: false,
        credentialsTransferred: false,
      },
      realClaudeExecution: {
        status: "reserved-for-final-human-environment-acceptance-child",
        deterministicMergeOracle: false,
        executionCommand: manifest.environmentGate.executionCommand,
      },
      verificationCommands: manifest.verification.commands,
    };
    const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
    if (
      /claude-browser-secret|manager-secret|oauth-secret|ANTHROPIC_API_KEY\s*[=:]\s*[^\s",}]+|bootstrap\?token=|sandking_session=/i
        .test(evidenceText)
    ) {
      throw new Error("issue_124_evidence_not_sanitized");
    }
    const evidencePath = resolve(dirname(manifestPath), "evidence", "issue-124.json");
    await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
    await writeFile(evidencePath, evidenceText, { mode: 0o600 });
    process.stdout.write(`Retained sanitized evidence: ${evidencePath}\n`);
  }
} finally {
  await rm(observationDirectory, { recursive: true, force: true });
}
