import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const updateEvidence = process.argv.includes("--update-evidence");
const manifestPath = resolve(
  process.argv.find((argument) => argument.endsWith(".json"))
    ?? "acceptance/issue-123.manifest.json",
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

if (
  manifest.schemaVersion !== 2
  || manifest.issue !== 123
  || manifest.parentPrd !== 125
  || manifest.scenarios?.[0]?.id !== "planning-spine/projects-an-optional-journey"
  || !Array.isArray(manifest.verification?.commands)
) {
  throw new Error("issue_123_acceptance_manifest_invalid");
}

const observationDirectory = await mkdtemp(join(tmpdir(), "sandking-planning-evidence-"));
const observationPath = join(observationDirectory, "planning-observation.json");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

try {
  for (const [command, ...args] of manifest.verification.commands) {
    const executable = command === "node" ? process.execPath : command;
    const result = await execFileAsync(executable, args, {
      cwd: process.cwd(),
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

  if (updateEvidence) {
    const observation = JSON.parse(await readFile(observationPath, "utf8"));
    if (observation.scenario !== "planning-spine/projects-an-optional-journey") {
      throw new Error("issue_123_browser_observation_invalid");
    }
    const { stdout: liveSpecificationOutput } = await execFileAsync(
      "gh",
      ["issue", "view", String(manifest.sourceSpecification.issue), "--json", "body"],
      { cwd: process.cwd() },
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
    const { stdout: generatedFromCommitOutput } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: process.cwd() },
    );
    const evidence = {
      schemaVersion: 2,
      issue: 123,
      parentPrd: 125,
      sourceSpecification,
      generatedFromCommit: generatedFromCommitOutput.trim(),
      recordedAt: new Date().toISOString(),
      ...observation,
      verificationCommands: manifest.verification.commands,
    };
    const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
    if (/planning-browser-secret|bootstrap\?token=|sandking_session=/i.test(evidenceText)) {
      throw new Error("issue_123_evidence_not_sanitized");
    }
    const evidencePath = resolve(dirname(manifestPath), "evidence", "issue-123.json");
    await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
    await writeFile(evidencePath, evidenceText, { mode: 0o600 });
    process.stdout.write(`Retained sanitized evidence: ${evidencePath}\n`);
  }
} finally {
  await rm(observationDirectory, { recursive: true, force: true });
}
