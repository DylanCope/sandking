import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  recoveryRequestFingerprint,
  requestIdempotencyKeyHash,
} from "../fingerprints.mjs";
import {
  availableRecoveryActions,
  controllerIdSchema,
  controllerSessionIdSchema,
  harnessRunIdSchema,
  harnessRunRecoveryActionSchema,
  harnessRunRecoverySchema,
  publicRun,
  recoveryProcessObservation,
  retainedRecoveryMutationSchema,
  stateSchema,
} from "../schemas.mjs";
import { retainedRecoveryMutation } from "../store.mjs";

/** @param {any} runtime */
export const createRecoverOperation = (runtime) => {
  const { now, options } = runtime;

  /**
   * Complete a durably retained recovery intent. A destructive implementation
   * receives only the canonical run projection plus the stable hashed action
   * identity; no unrestricted process handle can cross this boundary.
   * @param {z.infer<typeof stateSchema>} retained
   * @param {z.infer<typeof retainedRecoveryMutationSchema>} mutation
   */
  const completeRecoveryMutation = async (retained, mutation) => {
    if (mutation.response) return structuredClone(mutation.response);
    if (!mutation.harnessRunId || !mutation.action) {
      throw new Error("harness_run_recovery_intent_invalid");
    }
    const run = retained.runs.find((candidate) =>
      candidate.harnessRunId === mutation.harnessRunId);
    if (!run || run.status !== "recovery_required" || !run.recovery) {
      const response = {
        type: "harness.run.recover.failure",
        requestId: "recovered-pending-mutation",
        code: "harness_run_not_recoverable",
        retryable: false,
        authorizationClass: "harness_run_recovery",
        idempotencyKeyHash: mutation.idempotencyKeyHash,
        idempotentReplay: false,
        auditId: mutation.auditId,
        harnessRunId: mutation.harnessRunId,
        action: mutation.action,
        prohibitedSideEffects: {
          recoveryChanged: false,
          processSignalRequested: false,
          terminalOutcomeCreated: false,
          replacementRunStarted: false,
          projectWrite: false,
        },
      };
      mutation.response = response;
      await runtime.persist(retained);
      await runtime.ensureRecoveryAudits(retained);
      return structuredClone(response);
    }

    await options.faultInjector?.("harness_run_recovery.before_action");
    let inspection = null;
    let code;
    if (mutation.action === "recheck") {
      try {
        inspection = await runtime.inspectInterruptedTermination(publicRun(run), false);
        code = "harness_recovery_rechecked";
      } catch {
        code = "harness_recovery_inspection_unavailable";
      }
    } else if (mutation.action === "terminate_confirmed_tree") {
      try {
        inspection = options.terminateConfirmedInterruptedRun
          ? await options.terminateConfirmedInterruptedRun(publicRun(run), {
              auditId: mutation.auditId,
              idempotencyKeyHash: mutation.idempotencyKeyHash,
            })
          : null;
        code = inspection?.status === "confirmed"
          ? "harness_recovery_termination_confirmed"
          : "harness_recovery_termination_unconfirmed";
      } catch {
        code = "harness_recovery_termination_unconfirmed";
      }
    } else {
      code = "harness_recovery_finalized";
    }
    await options.faultInjector?.("harness_run_recovery.after_action");

    if (inspection) {
      const observedAt = now().toISOString();
      const processObservation = recoveryProcessObservation(
        inspection,
        observedAt,
        Boolean(options.terminateConfirmedInterruptedRun),
      );
      run.recovery = harnessRunRecoverySchema.parse({
        ...structuredClone(run.recovery),
        evidenceSchemaVersion: 2,
        platform: processObservation.platform,
        terminationEvidence: processObservation.terminationEvidence,
        processObservation,
        availableActions: availableRecoveryActions(processObservation),
      });
      run.revision += 1;
    } else if (mutation.action === "finalize") {
      const recovery = structuredClone(run.recovery);
      runtime.finalizeInterruptedRun(run, {
        previousStatus: recovery.previousStatus,
        completedAt: now().toISOString(),
        platform: recovery.platform,
      });
    }

    const response = {
      type: "harness.run.recover.result",
      requestId: "recovered-pending-mutation",
      code,
      authorizationClass: "harness_run_recovery",
      idempotencyKeyHash: mutation.idempotencyKeyHash,
      idempotentReplay: false,
      auditId: mutation.auditId,
      harnessRunId: mutation.harnessRunId,
      action: mutation.action,
      run: publicRun(run),
      recovery: structuredClone(run.recovery),
      outcome: structuredClone(run.outcome),
    };
    mutation.response = response;
    await options.faultInjector?.("harness_run_recovery.before_result_commit");
    await runtime.persist(retained);
    await options.faultInjector?.("harness_run_recovery.after_state_commit");
    await runtime.ensureOutcomeAudits(retained);
    await runtime.ensureReconciliationAudits(retained);
    await runtime.ensureRecoveryAudits(retained);
    await options.faultInjector?.("harness_run_recovery.after_commit");
    return structuredClone(response);
  };

  /** @param {any} request */
  const recover = (request) => runtime.withMutationLock(async () => {
    const authorizationClass = "harness_run_recovery";
    const idempotencyKeyHash = requestIdempotencyKeyHash(request);
    const requestFingerprint = recoveryRequestFingerprint(request);
    const retained = /** @type {z.infer<typeof stateSchema>} */ (
      await runtime.readState()
    );
    const existing = retainedRecoveryMutation(retained, idempotencyKeyHash);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        const auditId = await options.recordAudit("harness.run.recover", "rejected", {
          code: "idempotency_key_conflict",
          authorizationClass,
          idempotencyKeyHash,
          harnessRunId: harnessRunIdSchema.safeParse(request.harnessRunId).success
            ? request.harnessRunId
            : null,
          action: harnessRunRecoveryActionSchema.safeParse(request.action).success
            ? request.action
            : null,
          recoveryChanged: false,
          processSignalRequested: false,
          terminalOutcomeCreated: false,
          replacementRunStarted: false,
          projectWrite: false,
        });
        return {
          type: "harness.run.recover.failure",
          requestId: request.requestId,
          code: "idempotency_key_conflict",
          retryable: false,
          authorizationClass,
          idempotencyKeyHash,
          idempotentReplay: false,
          auditId,
          harnessRunId: harnessRunIdSchema.safeParse(request.harnessRunId).success
            ? request.harnessRunId
            : null,
          action: harnessRunRecoveryActionSchema.safeParse(request.action).success
            ? request.action
            : null,
          prohibitedSideEffects: {
            recoveryChanged: false,
            processSignalRequested: false,
            terminalOutcomeCreated: false,
            replacementRunStarted: false,
            projectWrite: false,
          },
        };
      }
      const response = existing.response
        ? structuredClone(existing.response)
        : await completeRecoveryMutation(retained, existing);
      await options.recordAudit("harness.run.recover", "observed", {
        code: /** @type {any} */ (response).code,
        authorizationClass,
        idempotencyKeyHash,
        idempotentReplay: true,
        originalAuditId: existing.auditId,
        harnessRunId: existing.harnessRunId,
        action: existing.action,
      });
      return {
        ...response,
        requestId: request.requestId,
        idempotentReplay: true,
      };
    }

    const parsedRunId = harnessRunIdSchema.safeParse(request.harnessRunId);
    const parsedAction = harnessRunRecoveryActionSchema.safeParse(request.action);
    let failureCode = null;
    if (
      request.authorizationClass !== authorizationClass
      || !idempotencyKeyHash
      || !parsedRunId.success
      || !parsedAction.success
      || !controllerIdSchema.safeParse(request.controllerId).success
      || !["controller-cli", "cockpit"].includes(request.source)
      || (request.source === "controller-cli"
        ? !controllerSessionIdSchema.safeParse(request.controllerSessionId).success
        : request.controllerSessionId !== null)
    ) {
      failureCode = "mutation_contract_invalid";
    }
    const run = failureCode ? null : retained.runs.find((candidate) =>
      candidate.harnessRunId === request.harnessRunId);
    if (!failureCode && !run) failureCode = "harness_run_not_found";
    if (!failureCode && run
      && (run.status !== "recovery_required" || run.recovery === null)) {
      failureCode = "harness_run_not_recoverable";
    }
    if (!failureCode && run?.recovery && parsedAction.success
      && !run.recovery.availableActions.includes(parsedAction.data)) {
      failureCode = "harness_recovery_action_not_available";
    }
    if (!failureCode && run?.recovery && parsedAction.data === "terminate_confirmed_tree"
      && (!options.terminateConfirmedInterruptedRun
        || !run.recovery.processObservation.safeToTerminate)) {
      failureCode = "harness_recovery_action_not_available";
    }

    if (failureCode || !idempotencyKeyHash || !parsedRunId.success || !parsedAction.success) {
      const auditId = `audit-${randomBytes(12).toString("hex")}`;
      const response = {
        type: "harness.run.recover.failure",
        requestId: typeof request.requestId === "string"
          ? request.requestId
          : "invalid-request",
        code: failureCode ?? "mutation_contract_invalid",
        retryable: failureCode === "harness_run_not_found",
        authorizationClass,
        idempotencyKeyHash,
        idempotentReplay: false,
        auditId,
        harnessRunId: parsedRunId.success ? parsedRunId.data : null,
        action: parsedAction.success ? parsedAction.data : null,
        prohibitedSideEffects: {
          recoveryChanged: false,
          processSignalRequested: false,
          terminalOutcomeCreated: false,
          replacementRunStarted: false,
          projectWrite: false,
        },
      };
      if (idempotencyKeyHash && parsedRunId.success && parsedAction.success) {
        retained.recoveryMutations.push(retainedRecoveryMutationSchema.parse({
          idempotencyKeyHash,
          requestFingerprint,
          harnessRunId: parsedRunId.data,
          action: parsedAction.data,
          acceptedAt: now().toISOString(),
          auditId,
          response,
        }));
        await runtime.persist(retained);
        await runtime.ensureRecoveryAudits(retained);
      } else {
        await options.recordAudit("harness.run.recover", "rejected", {
          code: response.code,
          authorizationClass,
          idempotencyKeyHash,
          harnessRunId: response.harnessRunId,
          action: response.action,
          prohibitedSideEffects: response.prohibitedSideEffects,
        }, auditId);
      }
      return response;
    }

    const mutation = retainedRecoveryMutationSchema.parse({
      idempotencyKeyHash,
      requestFingerprint,
      harnessRunId: parsedRunId.data,
      action: parsedAction.data,
      acceptedAt: now().toISOString(),
      auditId: `audit-${randomBytes(12).toString("hex")}`,
      response: null,
    });
    retained.recoveryMutations.push(mutation);
    await options.faultInjector?.("harness_run_recovery.before_intent_commit");
    await runtime.persist(retained);
    await options.faultInjector?.("harness_run_recovery.after_intent_commit");
    const response = await completeRecoveryMutation(retained, mutation);
    return { ...response, requestId: request.requestId };
  });

  return { completeRecoveryMutation, recover };
};
