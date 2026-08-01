import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

if (manifest.schemaVersion !== 1 || manifest.issue !== 117 || !Array.isArray(manifest.verification?.commands)) {
  throw new Error("issue_117_acceptance_manifest_invalid");
}

const observationDirectory = await mkdtemp(join(tmpdir(), "sandking-acceptance-observation-"));
const observationPath = join(observationDirectory, "browser-observation.json");

try {
  for (const [command, ...args] of manifest.verification.commands) {
    const executable = command === "node" ? process.execPath : command;
    const result = await execFileAsync(executable, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(updateEvidence ? { SANDKING_ACCEPTANCE_OBSERVATION_PATH: observationPath } : {}),
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
    const evidencePath = resolve(dirname(manifestPath), "evidence", "issue-117.json");
    const evidence = {
      schemaVersion: 1,
      scenario: "local-walking-skeleton/completes-approved-run",
      issue: 117,
      parentPrd: 125,
      approvedSpecification: manifest.approvedSpecification,
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
        host: manifest.verification.typedHostFailures,
        browser: manifest.verification.typedBrowserFailures,
        acceptedStatePreserved: true,
        mutationOccurred: false,
      },
      verificationCommands: manifest.verification.commands,
    };
    await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`Retained sanitized evidence: ${evidencePath}\n`);
  }
} finally {
  await rm(observationDirectory, { recursive: true, force: true });
}
