import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  readHostLossTerminationEvidence,
  waitForHostLossTerminationEvidence,
} from "../host-loss-termination-evidence.mjs";
import {
  adapterReadinessWasDurablyObserved,
  appendEvent,
  availableRecoveryActions,
  harnessRunCancellationReconciliationSchema,
  harnessRunOutcomeSchema,
  harnessRunRecoverySchema,
  harnessRunSchema,
  optionalBoolean,
  publicRun,
  recoveryProcessObservation,
  stateSchema,
  storedRunSchema,
} from "./schemas.mjs";

/** @param {any} runtime */
export const createHarnessRunReconciliation = (runtime) => {
  const { now, options } = runtime;

  /** @param {z.infer<typeof harnessRunSchema>} run @param {boolean} wait */
  const inspectInterruptedTermination = async (run, wait) => {
    if (options.inspectInterruptedRunTermination) {
      return options.inspectInterruptedRunTermination(run);
    }
    if (!["linux", "win32", "darwin"].includes(process.platform)) {
      throw new Error("harness_run_reconciliation_platform_unsupported");
    }
    const platform = /** @type {"linux" | "win32" | "darwin"} */ (process.platform);
    const evidencePath = join(
      options.dataDir,
      "harness-runs",
      run.harnessRunId,
      "host-loss-termination.json",
    );
    const evidence = wait
      ? await waitForHostLossTerminationEvidence(
          evidencePath,
          { expectedPlatform: platform, timeoutMs: 20_000 },
        )
      : await readHostLossTerminationEvidence(evidencePath);
    return {
      platform,
      status: evidence?.status === "termination_confirmed" ? "confirmed" : "unconfirmed",
      launchSettled: optionalBoolean(evidence?.launchSettled),
      treeEmpty: optionalBoolean(evidence?.treeEmpty),
    };
  };

  const terminalEventTypes = new Set([
    "harness_run_succeeded",
    "harness_run_failed",
    "harness_run_cancelled",
  ]);

  /** @param {z.infer<typeof storedRunSchema>} run */
  const repairAcceptedTerminalOutcome = (run) => {
    if (!run.outcome) return false;
    const expectedEventType = run.outcome.status === "succeeded"
      ? "harness_run_succeeded"
      : run.outcome.status === "cancelled"
        ? "harness_run_cancelled"
        : "harness_run_failed";
    const terminalEvents = run.events.filter((event) => terminalEventTypes.has(event.type));
    if (terminalEvents.length > 1) {
      throw new Error("harness_run_terminal_history_invalid");
    }
    if (terminalEvents.length === 1 && (
      terminalEvents[0].type !== expectedEventType
      || terminalEvents[0].outcomeReference !== run.outcome.outcomeId
    )) {
      throw new Error("harness_run_terminal_history_invalid");
    }
    let repaired = false;
    if (terminalEvents.length === 0) {
      appendEvent(run, expectedEventType, { outcomeReference: run.outcome.outcomeId });
      repaired = true;
    }
    if (run.status !== run.outcome.status || run.completedAt !== run.outcome.completedAt) {
      run.status = run.outcome.status;
      run.completedAt = run.outcome.completedAt;
      repaired = true;
    }
    if (repaired) run.revision += 1;
    return repaired;
  };

  /** @param {z.infer<typeof storedRunSchema>} run */
  const diagnosticReferencesFor = (run) => run.logStreams.map((stream) => ({
    streamId: stream.streamId,
    producer: stream.producer,
    range: {
      start: stream.availableStart,
      end: stream.availableEnd,
    },
    explicitRetrievalRequired: stream.explicitRetrievalRequired,
    insertedIntoControllerConversation: stream.insertedIntoControllerConversation,
  }));

  /**
   * @param {z.infer<typeof storedRunSchema>} run
   * @param {{previousStatus: "starting" | "running" | "cancelling", completedAt: string, platform: "linux" | "win32" | "darwin"}} recovery
   */
  const finalizeInterruptedRun = (run, recovery) => {
    if (run.outcome) return;
    const outcomeId = `harness-outcome-${randomBytes(12).toString("hex")}`;
    run.completedAt = recovery.completedAt;
    run.recovery = null;
    run.revision += 1;
    run.terminalEnvelopeValidation = {
      adapterReadyObserved: adapterReadinessWasDurablyObserved(run),
      validTerminalEnvelopeCount: 0,
      exactlyOne: false,
      adapterChannelClosedObserved: false,
      processExitObserved: false,
    };
    if (recovery.previousStatus === "cancelling" && run.cancellation) {
      run.status = "cancelled";
      run.cancellation.terminationConfirmedAt ??= recovery.completedAt;
      run.cancellationReconciliation =
        harnessRunCancellationReconciliationSchema.parse({
          previousStatus: "cancelling",
          reconciledAt: recovery.completedAt,
          platform: recovery.platform,
          terminationEvidence: "confirmed",
          reconciliationAuditId: `audit-${randomBytes(12).toString("hex")}`,
        });
      run.outcome = harnessRunOutcomeSchema.parse({
        outcomeId,
        status: "cancelled",
        code: "conformance_run_cancelled",
        completedAt: recovery.completedAt,
        incompleteResult: true,
        result: null,
        diagnosticReferences: diagnosticReferencesFor(run),
        terminalEnvelope: null,
        outcomeAuditId: `audit-${randomBytes(12).toString("hex")}`,
        interruption: null,
      });
      appendEvent(run, "harness_run_cancelled", { outcomeReference: outcomeId });
      return;
    }
    run.status = "failed";
    run.outcome = harnessRunOutcomeSchema.parse({
      outcomeId,
      status: "failed",
      code: "host_daemon_interrupted",
      completedAt: recovery.completedAt,
      incompleteResult: true,
      result: null,
      diagnosticReferences: diagnosticReferencesFor(run),
      terminalEnvelope: null,
      outcomeAuditId: `audit-${randomBytes(12).toString("hex")}`,
      interruption: {
        code: "host_daemon_interrupted",
        previousStatus: recovery.previousStatus,
        reconciledAt: recovery.completedAt,
        reconciliationAuditId: `audit-${randomBytes(12).toString("hex")}`,
      },
    });
    appendEvent(run, "harness_run_failed", { outcomeReference: outcomeId });
  };

  const reconcileInterruptedRuns = async () => {
    const retained = /** @type {z.infer<typeof stateSchema>} */ (
      await runtime.readState()
    );
    let changed = false;
    for (const run of retained.runs) {
      if (run.outcome) {
        changed = repairAcceptedTerminalOutcome(run) || changed;
        continue;
      }
      if (!["starting", "running", "cancelling"].includes(run.status)) continue;
      const acceptedCancellation = run.status === "cancelling"
        && run.cancellation !== null;
      if (acceptedCancellation !== (run.cancellation !== null)) {
        throw new Error("harness_run_reconciliation_state_invalid");
      }
      if (run.events.some((event) => terminalEventTypes.has(event.type))) {
        throw new Error("harness_run_terminal_history_invalid");
      }
      if (
        run.terminalEnvelopeValidation.validTerminalEnvelopeCount !== 0
        || run.terminalEnvelopeValidation.exactlyOne
      ) {
        throw new Error("harness_run_terminal_outcome_missing");
      }
      const previousStatus = /** @type {"starting" | "running" | "cancelling"} */ (
        run.status
      );
      const reconciledAt = now().toISOString();
      const termination = acceptedCancellation
        && run.cancellation?.terminationConfirmedAt !== null
        ? {
            platform: /** @type {"linux" | "win32" | "darwin"} */ (process.platform),
            status: "confirmed",
          }
        : await inspectInterruptedTermination(publicRun(run), true);
      if (termination.status !== "confirmed") {
        const processObservation = recoveryProcessObservation(
          termination,
          reconciledAt,
          Boolean(options.terminateConfirmedInterruptedRun),
        );
        run.status = "recovery_required";
        run.revision += 1;
        run.recovery = harnessRunRecoverySchema.parse({
          code: "harness_process_termination_unconfirmed",
          previousStatus,
          detectedAt: reconciledAt,
          platform: termination.platform,
          terminationEvidence: "unconfirmed",
          reconciliationAuditId: `audit-${randomBytes(12).toString("hex")}`,
          evidenceSchemaVersion: 2,
          initialProcessObservation: processObservation,
          initialAvailableActions: availableRecoveryActions(processObservation),
          processObservation,
          availableActions: availableRecoveryActions(processObservation),
        });
        appendEvent(run, "harness_run_recovery_required");
        changed = true;
        continue;
      }
      finalizeInterruptedRun(run, {
        previousStatus,
        completedAt: reconciledAt,
        platform: termination.platform,
      });
      changed = true;
    }
    if (!changed) return;
    await options.faultInjector?.("harness_run_reconciliation.before_commit");
    await runtime.persist(retained);
    await options.faultInjector?.("harness_run_reconciliation.after_state_commit");
    await runtime.ensureOutcomeAudits(retained);
    await runtime.ensureReconciliationAudits(retained);
    await runtime.ensureRecoveryAudits(retained);
    await options.faultInjector?.("harness_run_reconciliation.after_commit");
  };

  return {
    finalizeInterruptedRun,
    inspectInterruptedTermination,
    reconcileInterruptedRuns,
  };
};
