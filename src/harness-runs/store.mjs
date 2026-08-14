import { join } from "node:path";
import { z } from "zod";
import { readJson, writePrivateJson } from "../private-state.mjs";
import {
  initialState,
  stateSchema,
  storedRunSchema,
} from "./schemas.mjs";

/** @param {string} dataDir */
export const statePath = (dataDir) => join(dataDir, "harness-runs.json");

/** @param {string} dataDir @param {string} harnessRunId @param {"stdout" | "stderr"} producer */
export const logPath = (dataDir, harnessRunId, producer) =>
  join(dataDir, "harness-runs", harnessRunId, `${producer}.log`);

export class HarnessRunStateError extends Error {
  /** @param {string} stateDirectory */
  constructor(stateDirectory) {
    super(
      `harness_run_state_schema_unsupported: `
      + `Harness-run state is incompatible with this local build; `
      + `delete the Sand-King state directory at ${stateDirectory} and relaunch`,
    );
    this.name = "HarnessRunStateError";
    this.code = "harness_run_state_schema_unsupported";
    this.stateDirectory = stateDirectory;
  }
}

/** @param {z.infer<typeof stateSchema>} state @param {string | null} idempotencyKeyHash */
export const retainedLaunchOutcome = (state, idempotencyKeyHash) => idempotencyKeyHash
  ? state.launchOutcomes.find((outcome) =>
      outcome.idempotencyKeyHash === idempotencyKeyHash) ?? null
  : null;

/** @param {z.infer<typeof stateSchema>} state @param {string | null} idempotencyKeyHash */
export const retainedCancellationOutcome = (state, idempotencyKeyHash) => idempotencyKeyHash
  ? state.cancellationOutcomes.find((outcome) =>
      outcome.idempotencyKeyHash === idempotencyKeyHash) ?? null
  : null;

/** @param {z.infer<typeof stateSchema>} state @param {string | null} idempotencyKeyHash */
export const retainedRecoveryMutation = (state, idempotencyKeyHash) => idempotencyKeyHash
  ? state.recoveryMutations.find((mutation) =>
      mutation.idempotencyKeyHash === idempotencyKeyHash) ?? null
  : null;

/**
 * Own durable Harness-run state and idempotent audit publication.
 * @param {any} options
 */
export const createHarnessRunStore = (options) => {
  /** @param {z.infer<typeof stateSchema>} state */
  const ensureAcceptedLaunchAudits = async (state) => {
    for (const outcome of state.launchOutcomes) {
      const response = /** @type {any} */ (outcome.response);
      const harnessRunId = response?.run?.harnessRunId;
      if (response?.type !== "harness.run.launch.result" || typeof harnessRunId !== "string") {
        continue;
      }
      const run = state.runs.find((candidate) =>
        candidate.harnessRunId === harnessRunId);
      if (!run || !("launchAuditId" in run)
        || response.auditId !== run.launchAuditId
        || run.executionSnapshot.launchAuditId !== run.launchAuditId) {
        throw new Error("harness_run_launch_audit_reference_invalid");
      }
      const snapshot = run.executionSnapshot;
      const auditId = await options.recordAudit("harness.run.launch", "accepted", {
        authorizationClass: "harness_run_launch",
        idempotencyKeyHash: outcome.idempotencyKeyHash,
        harnessRunId: run.harnessRunId,
        hostId: snapshot.hostId,
        projectId: snapshot.projectRegistration.projectId,
        harnessId: snapshot.harness.harnessId,
        harnessPinnedRevision: snapshot.harness.pinnedRevision,
        controllerId: snapshot.attribution.controllerId,
        controllerSessionId: snapshot.attribution.controllerSessionId,
        source: snapshot.source,
        parameters: structuredClone(snapshot.parameters),
        adapterId: snapshot.adapter.adapterId,
        adapterProtocol: snapshot.adapter.protocol,
        adapterEntryPoint: snapshot.adapter.entryPoint,
        returnedBeforeTerminal: true,
        projectWrite: false,
      }, run.launchAuditId);
      if (auditId !== run.launchAuditId) {
        throw new Error("harness_run_launch_audit_commit_invalid");
      }
    }
  };

  /** @param {z.infer<typeof stateSchema>} state */
  const ensureAcceptedCancellationAudits = async (state) => {
    for (const outcome of state.cancellationOutcomes) {
      const response = /** @type {any} */ (outcome.response);
      if (response?.type !== "harness.run.cancel.result") continue;
      const run = state.runs.find((candidate) =>
        candidate.harnessRunId === response.harnessRunId);
      if (!run?.cancellation || run.cancellation.auditId !== response.auditId
        || run.cancellation.idempotencyKeyHash !== outcome.idempotencyKeyHash) {
        throw new Error("harness_run_cancellation_audit_reference_invalid");
      }
      const auditId = await options.recordAudit("harness.run.cancel", "accepted", {
        code: response.code,
        authorizationClass: "harness_run_cancellation",
        idempotencyKeyHash: outcome.idempotencyKeyHash,
        harnessRunId: run.harnessRunId,
        projectId: run.projectId,
        acceptedAt: run.cancellation.acceptedAt,
        cooperativeDeadlineAt: run.cancellation.cooperativeDeadlineAt,
        returnedBeforeTerminal: true,
        projectWrite: false,
      }, run.cancellation.auditId);
      if (auditId !== run.cancellation.auditId) {
        throw new Error("harness_run_cancellation_audit_commit_invalid");
      }
    }
  };

  /** @param {z.infer<typeof stateSchema>} state */
  const ensureRecoveryAudits = async (state) => {
    for (const mutation of state.recoveryMutations) {
      const response = /** @type {any} */ (mutation.response);
      if (!response) continue;
      const accepted = response.type === "harness.run.recover.result";
      const observation = response.recovery?.processObservation ?? null;
      const auditId = await options.recordAudit(
        "harness.run.recover",
        accepted ? "accepted" : "rejected",
        {
          code: response.code,
          authorizationClass: "harness_run_recovery",
          idempotencyKeyHash: mutation.idempotencyKeyHash,
          harnessRunId: mutation.harnessRunId,
          action: mutation.action,
          resultingStatus: response.run?.status ?? null,
          processObservation: observation,
          availableRecoveryActions: response.recovery?.availableActions ?? [],
          processSignalRequested: accepted
            && mutation.action === "terminate_confirmed_tree",
          terminationConfirmed: observation?.terminationEvidence === "confirmed"
            || response.outcome !== null,
          terminalOutcomeCreated: response.outcome != null,
          replacementRunStarted: false,
          projectWrite: false,
          ...(accepted ? {} : { prohibitedSideEffects: response.prohibitedSideEffects }),
        },
        mutation.auditId,
      );
      if (auditId !== mutation.auditId) {
        throw new Error("harness_run_recovery_audit_commit_invalid");
      }
    }
  };

  /** @param {z.infer<typeof storedRunSchema>} run */
  const outcomeAuditDetails = (run) => {
    if (!run.outcome) throw new Error("harness_run_outcome_missing");
    return {
      harnessRunId: run.harnessRunId,
      projectId: run.projectId,
      outcomeReference: run.outcome.outcomeId,
      status: run.outcome.status,
      code: run.outcome.code,
      incompleteResult: run.outcome.incompleteResult,
      adapterReadyObserved: run.terminalEnvelopeValidation.adapterReadyObserved,
      validTerminalEnvelopeCount:
        run.terminalEnvelopeValidation.validTerminalEnvelopeCount,
      adapterChannelClosedObserved:
        run.terminalEnvelopeValidation.adapterChannelClosedObserved,
      processExitObserved: run.terminalEnvelopeValidation.processExitObserved,
      stdoutRange: run.logStreams[0].availableEnd,
      stderrRange: run.logStreams[1].availableEnd,
      interruptionCode: run.outcome.interruption?.code ?? null,
    };
  };

  /** @param {z.infer<typeof stateSchema>} state */
  const ensureOutcomeAudits = async (state) => {
    for (const run of state.runs) {
      if (!run.outcome?.outcomeAuditId) continue;
      const auditId = await options.recordAudit(
        "harness.run.outcome",
        "observed",
        outcomeAuditDetails(run),
        run.outcome.outcomeAuditId,
      );
      if (auditId !== run.outcome.outcomeAuditId) {
        throw new Error("harness_run_outcome_audit_commit_invalid");
      }
    }
  };

  /** @param {z.infer<typeof stateSchema>} state */
  const ensureReconciliationAudits = async (state) => {
    for (const run of state.runs) {
      const interruption = run.outcome?.interruption;
      const recovery = run.recovery;
      const cancellationReconciliation = run.cancellationReconciliation;
      if (!interruption && !recovery && !cancellationReconciliation) continue;
      const reconciliationAuditId = interruption?.reconciliationAuditId
        ?? recovery?.reconciliationAuditId
        ?? cancellationReconciliation?.reconciliationAuditId;
      const cancellationRestart = cancellationReconciliation !== null
        || recovery?.previousStatus === "cancelling";
      const recoveryDetection = recovery?.initialProcessObservation ?? null;
      const reconciliationDetails = {
        code: interruption?.code ?? recovery?.code
          ?? "harness_run_cancellation_reconciled",
        harnessRunId: run.harnessRunId,
        hostId: run.hostId,
        projectId: run.projectId,
        previousStatus: interruption?.previousStatus ?? recovery?.previousStatus
          ?? cancellationReconciliation?.previousStatus,
        status: recovery ? "recovery_required" : run.outcome?.status ?? run.status,
        ...(run.outcome ? {
          outcomeReference: run.outcome.outcomeId,
          incompleteResult: run.outcome.incompleteResult,
        } : {}),
        terminationEvidence: recovery
          ? "unconfirmed"
          : cancellationReconciliation?.terminationEvidence ?? "confirmed",
        platform: recoveryDetection?.platform ?? cancellationReconciliation?.platform
          ?? process.platform,
        ...(recovery?.evidenceSchemaVersion === 2
          ? {
              processObservation: structuredClone(recovery.initialProcessObservation),
              availableRecoveryActions: structuredClone(recovery.initialAvailableActions),
            }
          : {}),
        retainedEventCount: run.events.length,
        stdoutRange: run.logStreams[0].availableEnd,
        stderrRange: run.logStreams[1].availableEnd,
        adapterRelaunched: false,
        harnessRunCreated: false,
        projectWrite: false,
        ...(cancellationRestart
          ? {
              cancellationAccepted: true,
              cooperativeSignalSent: Boolean(
                run.cancellation?.cooperativeSignalSentAt,
              ),
              forcedTerminationSent: Boolean(
                run.cancellation?.forcedTerminationSentAt,
              ),
              terminationConfirmed: Boolean(
                run.cancellation?.terminationConfirmedAt,
              ),
            }
          : {}),
      };
      const auditId = await options.recordAudit(
        "harness.run.reconcile",
        "observed",
        reconciliationDetails,
        reconciliationAuditId,
      );
      if (auditId !== reconciliationAuditId) {
        throw new Error("harness_run_reconciliation_audit_commit_invalid");
      }
    }
  };

  const readState = async () => {
    const raw = await readJson(statePath(options.dataDir), initialState());
    const parsed = stateSchema.safeParse(raw);
    if (!parsed.success) throw new HarnessRunStateError(options.dataDir);
    const retained = parsed.data;
    await ensureAcceptedLaunchAudits(retained);
    await ensureAcceptedCancellationAudits(retained);
    await ensureOutcomeAudits(retained);
    await ensureReconciliationAudits(retained);
    await ensureRecoveryAudits(retained);
    return retained;
  };

  /** @param {z.infer<typeof stateSchema>} state */
  const persist = (state) => writePrivateJson(
    statePath(options.dataDir),
    stateSchema.parse(state),
  );

  return {
    ensureAcceptedCancellationAudits,
    ensureAcceptedLaunchAudits,
    ensureOutcomeAudits,
    ensureReconciliationAudits,
    ensureRecoveryAudits,
    outcomeAuditDetails,
    persist,
    readState,
  };
};
