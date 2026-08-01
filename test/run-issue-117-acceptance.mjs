import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const updateEvidence = process.argv.includes("--update-evidence");
const manifestPath = resolve(
  process.argv.find((argument) => argument.endsWith(".json"))
    ?? "acceptance/issue-117.manifest.json",
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

if (manifest.schemaVersion !== 2 || manifest.issue !== 117 || !Array.isArray(manifest.verification?.commands)) {
  throw new Error("issue_117_acceptance_manifest_invalid");
}

const observationDirectory = await mkdtemp(join(tmpdir(), "sandking-acceptance-observation-"));
const observationPath = join(observationDirectory, "browser-observation.json");
/** @param {Buffer | string} value */
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

try {
  for (const [command, ...args] of manifest.verification.commands) {
    const executable = command === "node" ? process.execPath : command;
    const result = await execFileAsync(executable, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(updateEvidence ? {
          SANDKING_ACCEPTANCE_OBSERVATION_PATH: observationPath,
          SANDKING_ACCEPTANCE_RESULT_DIR: observationDirectory,
        } : {}),
      },
      maxBuffer: 10 * 1024 * 1024,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }

  if (updateEvidence) {
    const observation = JSON.parse(await readFile(observationPath, "utf8"));
    const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
    const playwrightPackage = JSON.parse(await readFile(
      resolve("node_modules/playwright/package.json"),
      "utf8",
    ));
    const chromiumPackage = JSON.parse(await readFile(
      resolve("node_modules/@sparticuz/chromium/package.json"),
      "utf8",
    ));
    const resultFiles = await readdir(observationDirectory);
    /** @param {string} file */
    const readResult = async (file) => JSON.parse(
      await readFile(join(observationDirectory, file), "utf8"),
    );
    const hostResults = await Promise.all(
      resultFiles
        .filter((file) => file.startsWith("host-") && file.endsWith(".json"))
        .map(readResult),
    );
    const hostFailures = hostResults.filter((result) =>
      result.kind === "host_negotiation_failure");
    const hostCredentialBoundary = hostResults.find((result) =>
      result.kind === "host_credential_boundary");
    const cleanHostFailure = resultFiles.includes("clean-host-incompatible-major.json")
      ? await readResult("clean-host-incompatible-major.json")
      : null;
    const browserSessionExpiry = resultFiles.includes("browser-session-expiry.json")
      ? await readResult("browser-session-expiry.json")
      : null;
    const runtimeReuseFailures = await Promise.all([
      "runtime-live-incompatible.json",
      "runtime-live-not-ready.json",
    ].map(async (file) => resultFiles.includes(file) ? readResult(file) : null));
    const hostFailuresByCode = new Map(hostFailures.map((result) => [
      result.diagnosis.code,
      result,
    ]));
    const orderedHostFailures = manifest.verification.typedHostFailures.map((code) => {
      const observed = hostFailuresByCode.get(code);
      if (!observed) {
        throw new Error(`host_failure_evidence_missing:${code}`);
      }
      return observed;
    });
    const observedBrowserCodes = observation.browserMismatchEvidence.map((result) => result.code);
    if (JSON.stringify(observedBrowserCodes) !== JSON.stringify(manifest.verification.typedBrowserFailures)) {
      throw new Error("browser_failure_evidence_mismatch");
    }
    if (!hostCredentialBoundary || hostCredentialBoundary.controllerSecretForwarded) {
      throw new Error("host_credential_boundary_evidence_invalid");
    }
    if (
      !cleanHostFailure
      || cleanHostFailure.acceptedIdentityStateCreated
      || cleanHostFailure.presentFiles.length > 0
    ) {
      throw new Error("clean_host_failure_evidence_invalid");
    }
    if (
      !browserSessionExpiry
      || browserSessionExpiry.persistentCookieAttributesIssued
      || browserSessionExpiry.socketCloseReason !== "session_expired"
    ) {
      throw new Error("browser_session_expiry_evidence_invalid");
    }
    if (
      runtimeReuseFailures.some((result) => !result)
      || JSON.stringify(runtimeReuseFailures.map((result) => result.diagnosis.code))
        !== JSON.stringify(["runtime_incompatible", "runtime_not_ready"])
    ) {
      throw new Error("runtime_reuse_failure_evidence_invalid");
    }

    const { stdout: liveSpecificationOutput } = await execFileAsync(
      "gh",
      ["issue", "view", String(manifest.sourceSpecification.issue), "--json", "body"],
      { cwd: process.cwd() },
    );
    const liveSpecificationBody = JSON.parse(liveSpecificationOutput).body;
    const sourceRevision = {
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
      sourceRevision.githubBodyUtf8Sha256
        !== manifest.sourceSpecification.githubBodyUtf8Sha256
      || sourceRevision.parentApprovedTextExportSha256
        !== manifest.sourceSpecification.parentApprovedTextExportSha256
    ) {
      throw new Error("issue_116_source_revision_mismatch");
    }
    const { stdout: generatedFromCommitOutput } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: process.cwd() },
    );
    const evidencePath = resolve(dirname(manifestPath), "evidence", "issue-117.json");
    const evidence = {
      schemaVersion: 2,
      scenario: "local-walking-skeleton/completes-approved-run",
      issue: 117,
      parentPrd: 125,
      sourceSpecification: sourceRevision,
      generatedFromCommit: generatedFromCommitOutput.trim(),
      recordedAt: new Date().toISOString(),
      software: {
        sandking: packageJson.version,
        node: process.version,
        playwright: playwrightPackage.version,
        chromiumBundle: chromiumPackage.version,
        browser: observation.browserVersion,
        hostProtocol: observation.protocol.version,
      },
      ...observation,
      typedMismatchEvidence: {
        host: orderedHostFailures,
        browser: observation.browserMismatchEvidence,
        acceptedStatePreserved: orderedHostFailures.every((result) =>
          result.acceptedState.preserved),
        mutationOccurred: orderedHostFailures.some((result) => result.mutationOccurred),
      },
      preAcceptanceHostFailureEvidence: cleanHostFailure,
      runtimeReuseFailureEvidence: runtimeReuseFailures,
      browserSessionExpiryEvidence: browserSessionExpiry,
      hostCredentialBoundary,
      verificationCommands: manifest.verification.commands,
    };
    await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`Retained sanitized evidence: ${evidencePath}\n`);
  }
} finally {
  await rm(observationDirectory, { recursive: true, force: true });
}
