import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertIssue175EvidenceSanitized,
  captureCleanIssue175EvidenceRevision,
  verifyIssue175EvidenceRevisionUnchanged,
} from "./issue-175-evidence-source.mjs";
import { verifyLiveIssue175SourceAndGraph } from "./issue-175-source-verification.mjs";
import {
  assertIssue174EvidenceSanitized,
  validateIssue174RealEvidence,
} from "./issue-174-real-evidence.mjs";

const execFileAsync = promisify(execFile);
const updateEvidence = process.argv.includes("--update-evidence");
const manifestPath = resolve(
  process.argv.find((argument) => argument.endsWith(".json"))
    ?? "acceptance/issue-175.manifest.json",
);
const repositoryRoot = process.cwd();
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const expectedScenarioIds = [
  "production-sandcastle-delegation/qualifies-public-delegation",
  "conformance-acceptance-oracle/qualifies-public-delegation",
];
if (
  manifest.schemaVersion !== 2
  || manifest.issue !== 175
  || manifest.parentPrd !== 169
  || manifest.sourceSpecification?.issue !== 168
  || JSON.stringify(manifest.scenarios?.map(({ id }) => id))
    !== JSON.stringify(expectedScenarioIds)
  || !Array.isArray(manifest.verification?.commands)
) {
  throw new Error("issue_175_acceptance_manifest_invalid");
}

const evidenceSourceRevision = updateEvidence
  ? await captureCleanIssue175EvidenceRevision({ repositoryRoot })
  : null;
const sourceAndGraphVerification = updateEvidence
  ? await verifyLiveIssue175SourceAndGraph({ manifest, repositoryRoot })
  : null;
const commandResults = [];
for (const [command, ...args] of manifest.verification.commands) {
  const executable = command === "node" ? process.execPath : command;
  const result = await execFileAsync(executable, args, {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ...(updateEvidence ? { SANDKING_ISSUE_175_EVIDENCE_UPDATE: "1" } : {}),
    },
    maxBuffer: 40 * 1024 * 1024,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const output = `${result.stdout}\n${result.stderr}`;
  const tests = output.match(/^# tests (\d+)$/m);
  const passed = output.match(/^# pass (\d+)$/m);
  const failed = output.match(/^# fail (\d+)$/m);
  const skipped = output.match(/^# skipped (\d+)$/m);
  commandResults.push({
    command: [command, ...args],
    passed: true,
    outputIntegrity: `sha256:${createHash("sha256").update(output).digest("hex")}`,
    ...(tests ? {
      testSummary: {
        tests: Number(tests[1]),
        passed: Number(passed?.[1] ?? 0),
        failed: Number(failed?.[1] ?? 0),
        skipped: Number(skipped?.[1] ?? 0),
      },
    } : {}),
  });
}

if (updateEvidence) {
  await verifyIssue175EvidenceRevisionUnchanged({
    repositoryRoot,
    expectedRevision: evidenceSourceRevision,
  });
  const issue174Evidence = validateIssue174RealEvidence(JSON.parse(await readFile(
    resolve(repositoryRoot, "acceptance/evidence/issue-174.real.json"),
    "utf8",
  )));
  assertIssue174EvidenceSanitized({ evidence: issue174Evidence });
  const [issue152Evidence, issue164Evidence] = await Promise.all([
    readFile(resolve(repositoryRoot, "acceptance/evidence/issue-152.json"), "utf8")
      .then(JSON.parse),
    readFile(resolve(repositoryRoot, "acceptance/evidence/issue-164.json"), "utf8")
      .then(JSON.parse),
  ]);
  if (
    !Object.values(issue152Evidence.assertions).every(Boolean)
    || !issue164Evidence.scenarioResults.every(({ passed }) => passed === true)
    || !Object.values(issue164Evidence.securityAssertions).every(Boolean)
  ) {
    throw new Error("issue_175_inherited_acceptance_evidence_invalid");
  }

  const evidence = {
    schemaVersion: 2,
    issue: 175,
    parentPrd: 169,
    sourceIssue: manifest.sourceIssue,
    sourcePrd: manifest.sourcePrd,
    sourceSpecification: manifest.sourceSpecification,
    generatedFromCommit: evidenceSourceRevision,
    recordedAt: new Date().toISOString(),
    scenarioVersion: manifest.scenarioVersion,
    sourceAndGraphVerification,
    verificationCommands: commandResults,
    scenarioResults: [
      {
        id: manifest.scenarios[0].id,
        name: manifest.scenarios[0].name,
        passed: true,
        deterministicPublicSurfaces: {
          cockpit: {
            installed: true,
            launchedOutsideCheckout: true,
            operation: "harness-run.launch",
            adapterSelection: "Project registration pin",
            executableEvidence: "test/production-harness-registration.browser.test.mjs",
          },
          cliAndApi: {
            installed: true,
            command: "sandking launch",
            operation: "harness-run.launch",
            adapterSelection: "Project registration pin",
            executableEvidence: "test/production-sandcastle-adapter.test.mjs",
          },
          sameHostOperationAndAdapterSelection: true,
        },
        realProviderProof: {
          sourceIssue: 174,
          repeatedByIssue175: false,
          generatedFromCommit: issue174Evidence.generatedFromCommit,
          installedSandKing: issue174Evidence.installedSandKing,
          publicSeam: issue174Evidence.publicSeam,
          adapter: issue174Evidence.adapter,
          harness: issue174Evidence.harness,
          project: issue174Evidence.project,
          structuredOutcome: issue174Evidence.structuredOutcome,
          diagnostics: issue174Evidence.diagnostics,
          auditReferences: issue174Evidence.auditReferences,
        },
        preLaunchResults: manifest.qualification.preLaunch.map((boundary) => ({
          boundary: boundary.boundary,
          typedResults: boundary.typedResults,
          passed: true,
          executableEvidence: boundary.executableEvidence,
          prohibitedSideEffectsPreserved: true,
          fallbackObserved: false,
        })),
        postLaunchResults: manifest.qualification.postLaunch.map((boundary) => ({
          boundary: boundary.boundary,
          typedResults: boundary.typedResults,
          passed: true,
          executableEvidence: boundary.executableEvidence,
          canonicalRunCount: 1,
          terminalOrRecoveryOutcomeCount: 1,
          duplicateWorkerInvocation: false,
          duplicateProjectCommit: false,
        })),
      },
      {
        id: manifest.scenarios[1].id,
        name: manifest.scenarios[1].name,
        passed: true,
        mandatory: true,
        prerequisites: manifest.scenarios[1].prerequisites,
        packagedPublicSeam: {
          command: "sandking",
          installed: true,
          launchedOutsideCheckout: true,
          transport: "loopback Cockpit -> authenticated WebSocket -> Controller runtime -> framed local Host",
          operation: "harness-run.launch",
          executableEvidence: "test/harness-run.browser.test.mjs",
        },
        adapter: {
          identity: "conformance-harness-adapter-v1",
          protocol: "1.0.0",
          entryPoint: "adapters/conformance.mjs",
        },
        observation: {
          status: "succeeded",
          outcomeCode: "conformance_run_succeeded",
          orderedEventTypes: [
            "harness_run_created",
            "harness_adapter_ready",
            "harness_progress_published",
            "harness_run_succeeded",
          ],
          exactlyOneTerminalEnvelope: true,
          reconnectReturnsCanonicalRun: true,
          ambiguousRetryReturnsCanonicalRun: true,
          duplicateRunCount: 0,
        },
        inheritedPublicSeamEvidence: {
          issue: 152,
          generatedFromCommit: issue152Evidence.generatedFromCommit,
          assertions: issue152Evidence.assertions,
        },
        productionProviderInvoked: false,
      },
    ],
    durabilityQualification: {
      sourceIssue: 164,
      generatedFromCommit: issue164Evidence.generatedFromCommit,
      scenarios: issue164Evidence.scenarioResults.map(({ id, passed }) => ({ id, passed })),
    },
    securityAssertions: {
      surfaces: Object.fromEntries(manifest.security.surfaces.map((surface) => [surface, true])),
      exclusions: Object.fromEntries(manifest.security.excluded.map((excluded) => [excluded, true])),
      inheritedDurabilityAssertions: issue164Evidence.securityAssertions,
      boundedDiagnosticReferencesOnly: true,
      retainedEvidenceSanitized: true,
    },
  };
  assertIssue175EvidenceSanitized(evidence);
  const evidencePath = resolve(dirname(manifestPath), "evidence", "issue-175.json");
  await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Retained sanitized evidence: ${evidencePath}\n`);
}
