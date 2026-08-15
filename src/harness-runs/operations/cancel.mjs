import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  cancellationRequestFingerprint,
  requestIdempotencyKeyHash,
} from "../fingerprints.mjs";
import {
  appendEvent,
  controllerIdSchema,
  controllerSessionIdSchema,
  harnessRunCancellationSchema,
  harnessRunIdSchema,
  stateSchema,
} from "../schemas.mjs";
import { retainedCancellationOutcome } from "../store.mjs";

/** @param {any} runtime */
export const createCancelOperation = (runtime) => {
  const { cancellationGraceMs, now, options } = runtime;

  /** @param {any} request */
  const cancel = (request) => runtime.withMutationLock(async () => {
    const authorizationClass = "harness_run_cancellation";
    const idempotencyKeyHash = requestIdempotencyKeyHash(request);
    const requestFingerprint = cancellationRequestFingerprint(request);
    const retained = /** @type {z.infer<typeof stateSchema>} */ (
      await runtime.readState()
    );
    const existing = retainedCancellationOutcome(retained, idempotencyKeyHash);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        const auditId = await options.recordAudit("harness.run.cancel", "rejected", {
          code: "idempotency_key_conflict",
          authorizationClass,
          idempotencyKeyHash,
          harnessRunId: harnessRunIdSchema.safeParse(request.harnessRunId).success
            ? request.harnessRunId
            : null,
          cancellationAccepted: false,
          cooperativeSignalSent: false,
          forcedTerminationSent: false,
          projectWrite: false,
        });
        return {
          type: "harness.run.cancel.failure",
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
          prohibitedSideEffects: {
            cancellationAccepted: false,
            cooperativeSignalSent: false,
            forcedTerminationSent: false,
            projectWrite: false,
          },
        };
      }
      await options.recordAudit("harness.run.cancel", "observed", {
        code: /** @type {any} */ (existing.response).code,
        authorizationClass,
        idempotencyKeyHash,
        idempotentReplay: true,
        originalAuditId: /** @type {any} */ (existing.response).auditId,
        harnessRunId: /** @type {any} */ (existing.response).harnessRunId,
      });
      if ((/** @type {any} */ (existing.response)).type === "harness.run.cancel.result") {
        const harnessRunId = /** @type {any} */ (existing.response).harnessRunId;
        const cooperativeDeadlineAt = /** @type {any} */ (
          existing.response
        ).cooperativeDeadlineAt;
        const replayedRun = retained.runs.find((candidate) =>
          candidate.harnessRunId === harnessRunId);
        const activeSupervision = runtime.activeSupervisions.get(harnessRunId);
        if (replayedRun?.status === "cancelling" && !replayedRun.outcome
          && activeSupervision) {
          runtime.acceptedCancellations.set(harnessRunId, cooperativeDeadlineAt);
          setImmediate(() => {
            void activeSupervision.requestCancellation(
              cooperativeDeadlineAt,
            ).catch(() => undefined);
          });
        }
      }
      return {
        ...structuredClone(existing.response),
        requestId: request.requestId,
        idempotentReplay: true,
      };
    }

    let failureCode = null;
    if (
      request.authorizationClass !== authorizationClass
      || !idempotencyKeyHash
      || !harnessRunIdSchema.safeParse(request.harnessRunId).success
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
      && (run.outcome !== null || run.cancellation !== null
        || ["recovery_required", "succeeded", "failed", "cancelled"]
          .includes(run.status))) {
      failureCode = "harness_run_not_cancellable";
    }

    if (failureCode || !run || !idempotencyKeyHash) {
      const auditId = await options.recordAudit("harness.run.cancel", "rejected", {
        code: failureCode ?? "mutation_contract_invalid",
        authorizationClass,
        idempotencyKeyHash,
        harnessRunId: harnessRunIdSchema.safeParse(request.harnessRunId).success
          ? request.harnessRunId
          : null,
        cancellationAccepted: false,
        cooperativeSignalSent: false,
        forcedTerminationSent: false,
        projectWrite: false,
      });
      const response = {
        type: "harness.run.cancel.failure",
        requestId: typeof request.requestId === "string"
          ? request.requestId
          : "invalid-request",
        code: failureCode ?? "mutation_contract_invalid",
        retryable: failureCode === "harness_run_not_found",
        authorizationClass,
        idempotencyKeyHash,
        idempotentReplay: false,
        auditId,
        harnessRunId: harnessRunIdSchema.safeParse(request.harnessRunId).success
          ? request.harnessRunId
          : null,
        prohibitedSideEffects: {
          cancellationAccepted: false,
          cooperativeSignalSent: false,
          forcedTerminationSent: false,
          projectWrite: false,
        },
      };
      if (idempotencyKeyHash) {
        retained.cancellationOutcomes.push({
          idempotencyKeyHash,
          requestFingerprint,
          response,
        });
        await runtime.persist(retained);
      }
      return response;
    }

    // Tree inventory is read-only and may safely overlap the durable mutation.
    // Starting it here captures descendants while the adapter is live without
    // moving any signal or accepted lifecycle effect before the commit.
    void runtime.activeSupervisions.get(run.harnessRunId)?.prepareCancellation();
    const acceptedDate = now();
    const acceptedAt = acceptedDate.toISOString();
    const cooperativeDeadlineAt = new Date(
      acceptedDate.getTime() + cancellationGraceMs,
    ).toISOString();
    const auditId = `audit-${randomBytes(12).toString("hex")}`;
    run.status = "cancelling";
    run.revision += 1;
    run.cancellation = harnessRunCancellationSchema.parse({
      acceptedAt,
      cooperativeDeadlineAt,
      auditId,
      idempotencyKeyHash,
      cooperativeSignalSentAt: null,
      forcedTerminationSentAt: null,
      terminationConfirmedAt: null,
    });
    appendEvent(run, "harness_run_cancellation_accepted");
    const response = {
      type: "harness.run.cancel.result",
      requestId: request.requestId,
      code: "harness_run_cancellation_accepted",
      authorizationClass,
      idempotencyKeyHash,
      idempotentReplay: false,
      auditId,
      harnessRunId: run.harnessRunId,
      acceptedAt,
      cooperativeDeadlineAt,
    };
    retained.cancellationOutcomes.push({
      idempotencyKeyHash,
      requestFingerprint,
      response,
    });
    await options.faultInjector?.("harness_run_cancellation.before_commit");
    await runtime.persist(retained);
    await options.faultInjector?.("harness_run_cancellation.after_state_commit");
    runtime.acceptedCancellations.set(run.harnessRunId, cooperativeDeadlineAt);
    const activeSupervision = runtime.activeSupervisions.get(run.harnessRunId);
    if (activeSupervision) {
      void activeSupervision.requestCancellation(cooperativeDeadlineAt)
        .catch(() => undefined);
    }
    await runtime.ensureAcceptedCancellationAudits(retained);
    await options.faultInjector?.("harness_run_cancellation.after_commit");
    return response;
  });

  return { cancel };
};
