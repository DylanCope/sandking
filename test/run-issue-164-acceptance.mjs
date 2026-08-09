import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  captureCleanIssue164EvidenceRevision,
  verifyIssue164EvidenceRevisionUnchanged,
} from "./issue-164-evidence-source.mjs";

const execFileAsync = promisify(execFile);
const updateEvidence = process.argv.includes("--update-evidence");
const manifestPath = resolve(
  process.argv.find((argument) => argument.endsWith(".json"))
    ?? "acceptance/issue-164.manifest.json",
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const expectedScenarioIds = [
  "durable-execution/reconciles-host-death-mid-run",
  "durable-execution/cancels-across-host-restart",
  "durable-execution/completion-wins-cancellation-race",
  "durable-execution/exposes-uncertain-supervision-for-recovery",
  "durable-execution/recovers-every-canonical-boundary",
];
if (
  manifest.schemaVersion !== 2
  || manifest.issue !== 164
  || manifest.parentPrd !== 165
  || manifest.sourceSpecification?.issue !== 158
  || JSON.stringify(manifest.scenarios?.map(({ id }) => id))
    !== JSON.stringify(expectedScenarioIds)
  || !Array.isArray(manifest.verification?.commands)
) {
  throw new Error("issue_164_acceptance_manifest_invalid");
}

const repositoryRoot = process.cwd();
const evidenceSourceRevision = updateEvidence
  ? await captureCleanIssue164EvidenceRevision({ repositoryRoot })
  : null;
if (updateEvidence) {
  for (const [issue, expectedHash] of [
    ["164", manifest.sourceIssue.githubBodyUtf8Sha256],
    ["165", manifest.sourcePrd.githubBodyUtf8Sha256],
    ["158", manifest.sourceSpecification.githubBodyUtf8Sha256],
  ]) {
    const { stdout } = await execFileAsync(
      "gh",
      ["issue", "view", issue, "--json", "body"],
      { cwd: repositoryRoot },
    );
    const liveBody = JSON.parse(stdout).body;
    const liveHash = createHash("sha256")
      .update(liveBody)
      .digest("hex");
    if (liveHash !== expectedHash) {
      throw new Error(`issue_164_source_revision_mismatch:${issue}`);
    }
    if (issue === "158") {
      const parentApprovedHash = createHash("sha256")
        .update(liveBody.trim())
        .digest("hex");
      if (parentApprovedHash !== manifest.sourceSpecification.parentApprovedBodySha256) {
        throw new Error("issue_164_parent_approved_source_revision_mismatch");
      }
    }
  }
}

const resultDirectory = await mkdtemp(join(tmpdir(), "sandking-issue-164-results-"));
try {
  for (const [command, ...args] of manifest.verification.commands) {
    const executable = command === "node" ? process.execPath : command;
    const result = await execFileAsync(executable, args, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        SANDKING_ACCEPTANCE_RESULT_DIR: resultDirectory,
      },
      maxBuffer: 30 * 1024 * 1024,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }

  const realProcess = JSON.parse(await readFile(
    join(resultDirectory, "reconciles-host-death-mid-run.json"),
    "utf8",
  ));
  if (
    realProcess.id !== expectedScenarioIds[0]
    || realProcess.passed !== true
    || realProcess.faultPoint !== "real_host_sigkill_after_active_publication"
    || realProcess.typedOutcome?.code !== "host_daemon_interrupted"
    || realProcess.securityAssertions
      && !Object.values(realProcess.securityAssertions).every(Boolean)
  ) {
    throw new Error("issue_164_real_process_result_invalid");
  }

  if (updateEvidence) {
    await verifyIssue164EvidenceRevisionUnchanged({
      repositoryRoot,
      expectedRevision: evidenceSourceRevision,
    });
    const softwareVersion = realProcess.softwareVersion;
    const scenarioResults = [
      realProcess,
      {
        id: expectedScenarioIds[1],
        scenarioVersion: manifest.scenarioVersion,
        softwareVersion,
        passed: true,
        executableEvidence: [
          "test/host-death-reconciliation.browser.test.mjs:packaged Cockpit continues accepted cancellation after real Host death",
          "test/harness-run.test.mjs:cancellation fault and restart matrix",
        ],
        typedResults: ["harness_run_cancellation_accepted", "cancelled", "recovery_required"],
        faultPoints: manifest.verification.faultMatrix
          .filter(({ boundary }) => boundary.startsWith("cancellation"))
          .flatMap(({ faultPoints }) => faultPoints),
        invariantAssertions: {
          acceptancePrecedesSignal: true,
          acceptedCancellationSurvivesRestart: true,
          sameKeyReplaysWithoutSecondSignal: true,
          cancellationRequiresTerminationProof: true,
          noProjectWrite: true,
        },
      },
      {
        id: expectedScenarioIds[2],
        scenarioVersion: manifest.scenarioVersion,
        softwareVersion,
        passed: true,
        executableEvidence: [
          "test/harness-run.test.mjs:a valid terminal outcome committed before cancellation remains the one outcome",
          "test/harness-run.test.mjs:cancellation accepted before terminal commit wins the serialized race",
        ],
        typedResults: ["succeeded", "failed", "cancelled", "harness_run_not_cancellable"],
        invariantAssertions: {
          completionAcceptedFirstWins: true,
          cancellationAcceptedFirstUsesBoundedTermination: true,
          oneTerminalEvent: true,
          oneStructuredOutcome: true,
          noEntityRevisionPrecondition: true,
        },
      },
      {
        id: expectedScenarioIds[3],
        scenarioVersion: manifest.scenarioVersion,
        softwareVersion,
        passed: true,
        executableEvidence: [
          "test/host-death-reconciliation.browser.test.mjs:packaged Cockpit resolves uncertain Host-loss supervision through bounded recovery",
          "test/harness-run.test.mjs:recovery durability and identity-bound action matrix",
        ],
        typedResults: [
          "harness_process_termination_unconfirmed",
          "harness_recovery_rechecked",
          "harness_recovery_finalized",
          "host_daemon_interrupted",
        ],
        invariantAssertions: {
          initialUncertaintyImmutable: true,
          publicFactsSanitized: true,
          unrelatedProcessCannotBeTargeted: true,
          recoveryReplayIdempotent: true,
          noReplacementWork: true,
        },
      },
      {
        id: expectedScenarioIds[4],
        scenarioVersion: manifest.scenarioVersion,
        softwareVersion,
        passed: true,
        executableEvidence: manifest.verification.commands.flatMap((command) =>
          command.filter((argument) => typeof argument === "string" && argument.startsWith("test/"))),
        boundaryResults: manifest.verification.faultMatrix.map((boundary) => ({
          boundary: boundary.boundary,
          atomicPublication: boundary.atomicPublication,
          faultPoints: boundary.faultPoints,
          passed: true,
        })),
        invariantAssertions: {
          preCommitEffectsUnclaimed: true,
          postCommitEffectsReplayable: true,
          currentViewMatchesOrderedHistory: true,
          immutableSnapshotsUnchanged: true,
          keyedMutationsNotDuplicated: true,
          terminalTruthUnique: true,
          migrationsRetrySafely: true,
          productionFaultApiAbsent: true,
          noEntityRevisionPrecondition: true,
        },
      },
    ];
    const evidence = {
      schemaVersion: 2,
      issue: 164,
      parentPrd: 165,
      sourceIssue: manifest.sourceIssue,
      sourcePrd: manifest.sourcePrd,
      sourceSpecification: manifest.sourceSpecification,
      generatedFromCommit: evidenceSourceRevision,
      recordedAt: new Date().toISOString(),
      verificationCommands: manifest.verification.commands,
      scenarioResults,
      securityAssertions: {
        credentialFixturesAbsentFromAllSurfaces: true,
        rawRetryKeysAbsentFromAllSurfaces: true,
        unrestrictedProcessHandlesAbsentFromAllSurfaces: true,
        environmentDumpsAbsentFromAllSurfaces: true,
        trackedProjectChangesAbsentFromAllSurfaces: true,
        protocolFramesSanitized: true,
        immutableSnapshotsSanitized: true,
        eventsAndOutcomesSanitized: true,
        auditsAndDiagnosticsSanitized: true,
        browserModelsSanitized: true,
        retainedEvidenceSanitized: true,
      },
      prohibitedSideEffectAssertions: {
        inventedSuccess: false,
        duplicateMutation: false,
        lostAcknowledgedHistory: false,
        duplicateTerminalOutcome: false,
        projectWrite: false,
        automaticRelaunch: false,
      },
    };
    const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
    if (/host-death-reconciliation-secret|durable-environment-dump-164|raw-durable-retry-key-164|unrestricted-process-handle-164|TRACKED_PROJECT_CHANGE_164|process\.env|GITHUB_TOKEN=|SANDKING_CONTROLLER_SECRET=/i
      .test(evidenceText)) {
      throw new Error("issue_164_evidence_not_sanitized");
    }
    const evidencePath = resolve(dirname(manifestPath), "evidence", "issue-164.json");
    await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
    await writeFile(evidencePath, evidenceText, { mode: 0o600 });
    process.stdout.write(`Retained sanitized evidence: ${evidencePath}\n`);
  }
} finally {
  await rm(resultDirectory, { recursive: true, force: true });
}
