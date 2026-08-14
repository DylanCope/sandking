import { readFile } from "node:fs/promises";
import { z } from "zod";
import { digest } from "../../common/digest.mjs";
import { requestIdempotencyKeyHash } from "../fingerprints.mjs";
import { publicRun, stateSchema } from "../schemas.mjs";
import {
  logPath,
  retainedLaunchOutcome,
  retainedRecoveryMutation,
} from "../store.mjs";

/** @param {any} runtime */
export const createQueryOperations = (runtime) => {
  const { options } = runtime;

  /** @param {{requestId: string, harnessRunId: string | null, afterSequence: number}} request */
  const observe = async (request) => {
    const retained = /** @type {z.infer<typeof stateSchema>} */ (
      await runtime.readState()
    );
    const run = request.harnessRunId
      ? retained.runs.find((candidate) => candidate.harnessRunId === request.harnessRunId)
      : retained.runs.at(-1);
    if (!run) {
      return {
        type: "harness.run.observe.result",
        requestId: request.requestId,
        code: "harness_run_absent",
        mode: "snapshot",
        resynchronization: null,
        run: null,
        events: [],
        nextSequence: 0,
        outcome: null,
        logStreams: [],
        terminalEnvelopeValidation: null,
      };
    }
    const afterSequence = Number.isSafeInteger(request.afterSequence)
      && request.afterSequence >= 0
      ? request.afterSequence
      : 0;
    const maximumSequence = run.events.at(-1)?.sequence ?? 0;
    const availableFromSequence = run.events[0]?.sequence ?? 0;
    const laterEvents = run.events.filter((event) => event.sequence > afterSequence);
    const historyGap = afterSequence > 0
      && afterSequence < maximumSequence
      && laterEvents.length > 0
      && laterEvents[0].sequence !== afterSequence + 1;
    const cursorIncompatible = afterSequence > maximumSequence;
    const resynchronizationReason = cursorIncompatible
      ? "cursor_incompatible"
      : historyGap
        ? "history_gap"
        : null;
    const resynchronization = resynchronizationReason ? {
      code: "resync-required",
      reason: resynchronizationReason,
      requestedAfterSequence: afterSequence,
      availableFromSequence,
      canonicalSnapshot: true,
    } : null;
    return {
      type: "harness.run.observe.result",
      requestId: request.requestId,
      code: resynchronization ? "resync-required" : "harness_run_observed",
      mode: resynchronization
        ? "resync-required"
        : afterSequence === 0
          ? "snapshot"
          : "resume",
      resynchronization,
      run: publicRun(run),
      events: structuredClone(resynchronization
        ? run.events
        : laterEvents),
      nextSequence: maximumSequence,
      outcome: structuredClone(run.outcome),
      logStreams: structuredClone(run.logStreams),
      terminalEnvelopeValidation: structuredClone(run.terminalEnvelopeValidation),
    };
  };

  /** @param {{requestId: string, harnessRunId: string, producer: "stdout" | "stderr", offset: number, limit: number}} request */
  const readLogs = async (request) => {
    const retained = /** @type {z.infer<typeof stateSchema>} */ (
      await runtime.readState()
    );
    const run = retained.runs.find((candidate) =>
      candidate.harnessRunId === request.harnessRunId);
    if (!run) {
      throw new Error("harness_run_not_found");
    }
    const stream = run.logStreams.find((candidate) =>
      candidate.producer === request.producer);
    if (
      !stream
      || !Number.isSafeInteger(request.offset)
      || request.offset < 0
      || !Number.isSafeInteger(request.limit)
      || request.limit < 1
      || request.limit > 16_384
    ) {
      throw new Error("harness_log_range_invalid");
    }
    const available = await readFile(
      logPath(options.dataDir, run.harnessRunId, stream.producer),
    );
    // State is the diagnostic commit boundary. A Host can die after appending
    // bytes but before advancing availableEnd, so never expose that tail as
    // though reconciliation had retained it canonically.
    const durableAvailableEnd = Math.min(stream.availableEnd, available.byteLength);
    const start = Math.min(request.offset, durableAvailableEnd);
    const end = Math.min(start + request.limit, durableAvailableEnd);
    const data = available.subarray(start, end);
    return {
      response: {
        type: "harness.run.logs.result",
        requestId: request.requestId,
        code: "harness_log_range",
        harnessRunId: run.harnessRunId,
        producer: stream.producer,
        streamId: stream.streamId,
        range: {
          start,
          end,
          availableEnd: durableAvailableEnd,
          eof: end === durableAvailableEnd,
        },
        byteLength: data.byteLength,
        sha256: digest(data),
        insertedIntoControllerConversation: false,
      },
      data,
    };
  };

  /** @param {{requestId: string, idempotencyKeyHash?: string, idempotencyKey?: string}} request */
  const lookup = async (request) => {
    const retained = /** @type {z.infer<typeof stateSchema>} */ (
      await runtime.readState()
    );
    const idempotencyKeyHash = requestIdempotencyKeyHash(request);
    const existing = retainedLaunchOutcome(retained, idempotencyKeyHash);
    return {
      type: "harness.run.lookup.result",
      requestId: request.requestId,
      code: existing
        ? "harness_run_launch_outcome_found"
        : "harness_run_launch_outcome_absent",
      idempotencyKeyHash,
      found: Boolean(existing),
      launchOutcome: existing ? structuredClone(existing.response) : null,
    };
  };

  /** @param {{requestId: string, idempotencyKeyHash?: string, idempotencyKey?: string}} request */
  const lookupRecovery = async (request) => {
    const retained = /** @type {z.infer<typeof stateSchema>} */ (
      await runtime.readState()
    );
    const idempotencyKeyHash = requestIdempotencyKeyHash(request);
    const existing = retainedRecoveryMutation(retained, idempotencyKeyHash);
    return {
      type: "harness.run.recovery.lookup.result",
      requestId: request.requestId,
      code: existing
        ? "harness_recovery_outcome_found"
        : "harness_recovery_outcome_absent",
      idempotencyKeyHash,
      found: Boolean(existing?.response),
      pending: Boolean(existing && !existing.response),
      recoveryOutcome: existing?.response
        ? structuredClone(existing.response)
        : null,
    };
  };

  return { lookup, lookupRecovery, observe, readLogs };
};
