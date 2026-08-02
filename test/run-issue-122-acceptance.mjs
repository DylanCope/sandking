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
    const [
      observation,
      activeHostLoss,
      acceptedProjectOpenReplay,
      acceptedProjectHostLoss,
      postNegotiationHostProtocol,
      harnessFailure,
      launchDecision,
      launchTerminal,
    ] = await Promise.all([
      readFile(observationPath, "utf8").then(JSON.parse),
      readResult("active-host-loss-contract.json"),
      readResult("accepted-project-open-replay-contract.json"),
      readResult("accepted-project-host-loss-contract.json"),
      readResult("post-negotiation-host-protocol-contract.json"),
      readResult("harness-run-failure-contract.json"),
      readResult("launch-decision-contract.json"),
      readResult("launch-terminal-contract.json"),
    ]);
    if (
      observation.scenario !== manifest.scenarios[0].id
      || observation.issue !== 122
      || observation.visibleFailure?.code !== "harness_result_incomplete"
      || observation.staleStateEvidence?.hostStatus !== "disconnected"
      || activeHostLoss.kind !== "active_host_loss_contract"
      || activeHostLoss.typedFailure?.body?.code !== "host_disconnected"
      || activeHostLoss.idempotency?.replayReturnedOriginalAudit !== true
      || activeHostLoss.idempotency?.changedContentCode !== "idempotency_key_conflict"
      || acceptedProjectOpenReplay.kind !== "accepted_project_open_replay_contract"
      || acceptedProjectOpenReplay.accepted?.status !== 200
      || acceptedProjectOpenReplay.accepted?.body?.code !== "project_ready"
      || acceptedProjectOpenReplay.accepted?.body?.idempotentReplay !== false
      || acceptedProjectOpenReplay.replay?.status !== 200
      || acceptedProjectOpenReplay.replay?.body?.code !== "project_ready"
      || acceptedProjectOpenReplay.replay?.body?.idempotentReplay !== true
      || acceptedProjectOpenReplay.replay?.body?.auditId
        !== acceptedProjectOpenReplay.accepted?.body?.auditId
      || acceptedProjectOpenReplay.replay?.body?.project?.projectId
        !== acceptedProjectOpenReplay.accepted?.body?.project?.projectId
      || acceptedProjectOpenReplay.replay?.body?.project?.harness?.harnessId
        !== acceptedProjectOpenReplay.accepted?.body?.project?.harness?.harnessId
      || acceptedProjectOpenReplay.changedUse?.body?.code !== "idempotency_key_conflict"
      || acceptedProjectHostLoss.kind !== "accepted_project_host_loss_contract"
      || acceptedProjectHostLoss.typedFailure?.body?.code !== "host_disconnected"
      || acceptedProjectHostLoss.typedFailure?.body?.project?.projectId
        !== acceptedProjectHostLoss.acceptedProject?.projectId
      || acceptedProjectHostLoss.typedFailure?.body?.prohibitedSideEffects
        ?.projectRegistrationCreated !== true
      || acceptedProjectHostLoss.queuedReplay?.status
        !== acceptedProjectHostLoss.typedFailure?.status
      || acceptedProjectHostLoss.queuedReplay?.body?.code !== "host_disconnected"
      || acceptedProjectHostLoss.queuedReplay?.body?.idempotentReplay !== true
      || acceptedProjectHostLoss.queuedReplay?.body?.auditId
        !== acceptedProjectHostLoss.typedFailure?.body?.auditId
      || acceptedProjectHostLoss.queuedReplay?.body?.project?.projectId
        !== acceptedProjectHostLoss.acceptedProject?.projectId
      || acceptedProjectHostLoss.audit?.replay?.details?.originalAuditId
        !== acceptedProjectHostLoss.typedFailure?.body?.auditId
      || acceptedProjectHostLoss.canonicalState?.registrationAuditRetained !== true
      || postNegotiationHostProtocol.kind
        !== "post_negotiation_host_protocol_contract"
      || postNegotiationHostProtocol.typedConnectionFailure?.failure?.code
        !== "host_protocol_invalid"
      || postNegotiationHostProtocol.browserProtocolFailureMisattributed !== false
      || postNegotiationHostProtocol.browserSocketRetained !== true
      || postNegotiationHostProtocol.cockpit?.controllerSessionOpened !== true
      || postNegotiationHostProtocol.cockpit?.planningMutationSucceeded !== true
      || observation.staleStateEvidence?.acceptedProjectSessionIdempotency
        ?.replayReturnedOriginalAudit !== true
      || observation.staleStateEvidence?.acceptedProjectSessionIdempotency
        ?.replayReturnedOriginalSession !== true
      || observation.staleStateEvidence?.acceptedProjectSessionIdempotency
        ?.changedContentCode !== "idempotency_key_conflict"
      || observation.staleStateEvidence?.focusedControllerMutationIdempotency
        ?.acceptedOutcomeReplayLinkedToOriginalAudit !== true
      || observation.staleStateEvidence?.focusedControllerMutationIdempotency
        ?.replayIdempotent !== true
      || observation.staleStateEvidence?.focusedControllerMutationIdempotency
        ?.replayLinkedToOriginalAudit !== true
      || observation.staleStateEvidence?.focusedControllerMutationIdempotency
        ?.replayReturnedOriginalOutcomeAudit !== true
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
        activeHostLoss,
        acceptedProjectOpenReplay,
        acceptedProjectHostLoss,
        postNegotiationHostProtocol,
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
