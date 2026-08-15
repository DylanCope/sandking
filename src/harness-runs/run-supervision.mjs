import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { z } from "zod";
import { SANDCASTLE_HARNESS_ADAPTER_ID } from "../harness-adapter-identity.mjs";
import { PRIVATE_FILE_MODE } from "../private-state.mjs";
import { superviseHarnessAdapter } from "./adapter-supervision.mjs";
import {
  appendEvent,
  harnessRunOutcomeSchema,
  PROGRESS_PERSIST_BATCH_SIZE,
  progressRecordSchema,
  stateSchema,
  storedRunSchema,
} from "./schemas.mjs";
import { logPath } from "./store.mjs";

class InjectedSupervisionInterruption extends Error {
  /** @param {unknown} cause */
  constructor(cause) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "InjectedSupervisionInterruption";
  }
}

/** @param {any} runtime */
export const createRunSupervisor = (runtime) => {
  const { now, options } = runtime;

  /** @param {string} harnessRunId @param {(run: z.infer<typeof storedRunSchema>, state: z.infer<typeof stateSchema>) => Promise<void> | void} update */
  const updateRun = (harnessRunId, update) => runtime.withMutationLock(async () => {
    const retained = /** @type {z.infer<typeof stateSchema>} */ (
      await runtime.readState()
    );
    const run = retained.runs.find((candidate) => candidate.harnessRunId === harnessRunId);
    if (!run) {
      throw new Error("harness_run_not_found");
    }
    await update(run, retained);
    await runtime.persist(retained);
    return structuredClone(run);
  });

  /** @param {string} harnessRunId @param {"stdout" | "stderr"} producer @param {Buffer} data */
  const appendDiagnostic = async (harnessRunId, producer, data) => {
    if (data.byteLength === 0) return;
    await updateRun(harnessRunId, async (run) => {
      const stream = run.logStreams.find((candidate) => candidate.producer === producer);
      if (!stream) {
        throw new Error("harness_log_stream_invalid");
      }
      const remaining = Math.max(0, 65_536 - stream.availableEnd);
      const bounded = data.subarray(0, remaining);
      if (bounded.byteLength > 0) {
        await appendFile(logPath(options.dataDir, harnessRunId, producer), bounded, {
          mode: PRIVATE_FILE_MODE,
        });
        stream.availableEnd += bounded.byteLength;
      }
    });
  };

  /** @param {Parameters<NonNullable<typeof options.faultInjector>>[0]} point */
  const injectSupervisionFault = async (point) => {
    try {
      await options.faultInjector?.(point);
    } catch (error) {
      // A deterministic Host interruption is not an adapter observation. Keep
      // it distinguishable while it crosses the adapter-supervision callback
      // stack so the catch below cannot invent an adapter-start failure.
      throw new InjectedSupervisionInterruption(error);
    }
  };

  /** @param {z.infer<typeof storedRunSchema>} initialRun @param {any} context */
  const supervise = async (initialRun, context) => {
    let supervision;
    /** @type {{prepareCancellation: () => Promise<boolean>, requestCancellation: (cooperativeDeadlineAt: string) => Promise<{cooperativeSignalSentAt: string | null, forcedTerminationSentAt: string | null, terminationConfirmedAt: string | null}>, interrupt: () => Promise<void>, releaseProcessTree: () => Promise<void>} | null} */
    let cancellationSupervisor = null;
    /** @type {() => Promise<void>} */
    let releaseSupervisedProcessTree = async () => undefined;
    /** @type {Array<z.infer<typeof progressRecordSchema>>} */
    const pendingProgressRecords = [];
    let progressRecordCount = 0;
    const persistProgressRecords = async () => {
      if (pendingProgressRecords.length === 0) return;
      const records = pendingProgressRecords.slice();
      await updateRun(initialRun.harnessRunId, (run) => {
        // Cancellation acceptance is the canonical boundary after which no
        // Harness-defined work can enter history. A frame emitted earlier but
        // queued behind that durable mutation cannot overtake it.
        if (run.cancellation || run.outcome) return;
        for (const record of records) {
          run.revision += 1;
          appendEvent(run, "harness_progress_published", { progressRecord: record });
        }
      });
      pendingProgressRecords.splice(0, records.length);
    };
    try {
      supervision = await superviseHarnessAdapter(initialRun, context, {
        onAdapterStarted: async () => {
          await options.recordAudit("harness.adapter.start", "observed", {
            harnessRunId: initialRun.harnessRunId,
            hostId: initialRun.hostId,
            projectId: initialRun.projectId,
            adapterId: initialRun.adapterId,
            adapterProtocol: initialRun.adapterProtocol,
            projectWrite: false,
          });
        },
        onSupervisorAvailable: (supervisor) => {
          const faultAwareSupervisor = {
            ...supervisor,
            requestCancellation: async (
              /** @type {string} */ cooperativeDeadlineAt,
            ) => {
              try {
                return await supervisor.requestCancellation(cooperativeDeadlineAt);
              } catch (error) {
                if (error instanceof InjectedSupervisionInterruption) {
                  await supervisor.interrupt();
                }
                throw error;
              }
            },
          };
          cancellationSupervisor = faultAwareSupervisor;
          releaseSupervisedProcessTree = supervisor.releaseProcessTree;
          runtime.activeSupervisions.set(initialRun.harnessRunId, faultAwareSupervisor);
          const cooperativeDeadlineAt = runtime.acceptedCancellations.get(
            initialRun.harnessRunId,
          );
          if (cooperativeDeadlineAt) {
            void faultAwareSupervisor.requestCancellation(cooperativeDeadlineAt)
              .catch(() => undefined);
          }
        },
        onReady: async (readyAt) => {
          await injectSupervisionFault(
            "harness_run_lifecycle.adapter_ready.before_commit",
          );
          await updateRun(initialRun.harnessRunId, (run) => {
            if (run.status !== "starting" && run.status !== "cancelling") {
              throw new Error("harness_run_state_invalid");
            }
            if (run.status === "starting") run.status = "running";
            run.adapterReadyAt = readyAt;
            run.terminalEnvelopeValidation.adapterReadyObserved = true;
            run.revision += 1;
            appendEvent(run, "harness_adapter_ready");
          });
          await injectSupervisionFault(
            "harness_run_lifecycle.adapter_ready.after_state_commit",
          );
        },
        onProgress: async (record) => {
          progressRecordCount += 1;
          pendingProgressRecords.push(record);
          if (
            progressRecordCount === 1
            || pendingProgressRecords.length >= PROGRESS_PERSIST_BATCH_SIZE
          ) {
            await persistProgressRecords();
          }
        },
        onDiagnostic: (producer, data) =>
          appendDiagnostic(initialRun.harnessRunId, producer, data),
        beforeCancellationSignal: async (kind) => {
          await injectSupervisionFault(
            `harness_run_cancellation.${kind}_signal.before_dispatch`,
          );
        },
        onCancellationSignalPublished: async (kind, sentAt) => {
          await injectSupervisionFault(
            `harness_run_cancellation.${kind}_signal.after_dispatch`,
          );
          await updateRun(initialRun.harnessRunId, (run) => {
            if (!run.cancellation) {
              throw new Error("harness_run_cancellation_state_invalid");
            }
            const field = kind === "cooperative"
              ? "cooperativeSignalSentAt"
              : "forcedTerminationSentAt";
            if (run.cancellation[field] === null) {
              run.cancellation[field] = sentAt;
              run.revision += 1;
            }
          });
          await injectSupervisionFault(
            `harness_run_cancellation.${kind}_signal.after_state_commit`,
          );
        },
        onCancellationTerminationConfirmed: async (confirmedAt) => {
          await injectSupervisionFault(
            "harness_run_cancellation.termination_confirmation.before_commit",
          );
          await updateRun(initialRun.harnessRunId, (run) => {
            if (!run.cancellation) {
              throw new Error("harness_run_cancellation_state_invalid");
            }
            if (run.cancellation.terminationConfirmedAt === null) {
              run.cancellation.terminationConfirmedAt = confirmedAt;
              run.revision += 1;
            }
          });
          await injectSupervisionFault(
            "harness_run_cancellation.termination_confirmation.after_state_commit",
          );
        },
      });
    } catch (error) {
      if (error instanceof InjectedSupervisionInterruption) {
        const interruptedSupervisor = /** @type {any} */ (cancellationSupervisor);
        await interruptedSupervisor?.interrupt();
        await releaseSupervisedProcessTree();
        throw error;
      }
      supervision = {
        adapterReadyObserved: false,
        protocolInvalid: false,
        terminalEnvelopes: [],
        adapterChannelClosedObserved: false,
        exit: { code: null, signal: null, startFailed: true },
        cancellation: null,
      };
    } finally {
      runtime.activeSupervisions.delete(initialRun.harnessRunId);
    }
    try {
      await persistProgressRecords();
      const terminal = supervision.terminalEnvelopes.length === 1
        ? supervision.terminalEnvelopes[0]
        : null;
      const validTerminal = terminal && !supervision.protocolInvalid;
      let terminalOutcomeCommitted = false;
      let status = validTerminal ? terminal.status : "failed";
      let code = supervision.exit.startFailed
        ? "harness_adapter_start_failed"
        : supervision.protocolInvalid
          ? "harness_adapter_protocol_invalid"
          : validTerminal
            ? terminal.status === "succeeded"
              ? initialRun.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID
                ? "harness_run_succeeded"
                : "conformance_run_succeeded"
              : terminal.status === "failed"
                ? initialRun.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID
                  ? "harness_run_failed"
                  : "conformance_run_failed"
                : initialRun.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID
                  ? "harness_run_cancelled"
                  : "conformance_run_cancelled"
            : "harness_result_incomplete";
      let incompleteResult = !validTerminal;
      let acceptedTerminal = validTerminal ? terminal : null;
      const outcomeId = `harness-outcome-${randomBytes(12).toString("hex")}`;
      const outcomeAuditId = `audit-${randomBytes(12).toString("hex")}`;
      let completedAt = now().toISOString();
      /** @type {{cooperativeSignalSentAt: string | null, forcedTerminationSentAt: string | null, terminationConfirmedAt: string | null} | null} */
      let cancellationTermination = supervision.cancellation;
      /** @type {string | null} */
      let cancellationRequestDeadline = null;
      const terminalCancellationSupervisor = /** @type {any} */ (
        cancellationSupervisor
      );
      if (validTerminal) {
        await options.faultInjector?.("harness_run_terminal_envelope.before_commit");
      }
      await options.faultInjector?.("harness_run_outcome.before_commit");
      const commitTerminalOutcome = () => updateRun(initialRun.harnessRunId, (run) => {
        if (run.outcome) return;
        if (run.cancellation) {
          if (!cancellationTermination && run.cancellation.terminationConfirmedAt) {
            cancellationTermination = {
              cooperativeSignalSentAt: run.cancellation.cooperativeSignalSentAt,
              forcedTerminationSentAt: run.cancellation.forcedTerminationSentAt,
              terminationConfirmedAt: run.cancellation.terminationConfirmedAt,
            };
          }
          if (!cancellationTermination && terminalCancellationSupervisor) {
            // Preserve serialized terminal-order arbitration, then leave the
            // mutation lock before waiting for process-tree progress. Signal
            // and confirmation publication use the same lock independently.
            cancellationRequestDeadline = run.cancellation.cooperativeDeadlineAt;
            return;
          }
          if (!cancellationTermination) {
            cancellationTermination = {
              cooperativeSignalSentAt: null,
              forcedTerminationSentAt: null,
              // No supervisor means adapter setup failed before a process tree
              // became available. That start-failure boundary is the only late
              // cancellation case that can confirm no tree without a live tree.
              terminationConfirmedAt: supervision.exit.startFailed
                ? completedAt
                : null,
            };
          }
          run.cancellation.cooperativeSignalSentAt ??=
            cancellationTermination.cooperativeSignalSentAt;
          run.cancellation.forcedTerminationSentAt ??=
            cancellationTermination.forcedTerminationSentAt;
          run.cancellation.terminationConfirmedAt ??=
            cancellationTermination.terminationConfirmedAt;
          if (!run.cancellation.terminationConfirmedAt) return;
          completedAt = now().toISOString();
          const validCancellationTerminal = validTerminal
            && terminal.status === "cancelled";
          status = "cancelled";
          code = initialRun.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID
            ? "harness_run_cancelled"
            : "conformance_run_cancelled";
          incompleteResult = !validCancellationTerminal
            || cancellationTermination.forcedTerminationSentAt !== null;
          acceptedTerminal = validCancellationTerminal ? terminal : null;
        }
        run.status = status;
        run.completedAt = completedAt;
        run.revision += 1;
        run.terminalEnvelopeValidation = {
          adapterReadyObserved: supervision.adapterReadyObserved,
          validTerminalEnvelopeCount: supervision.terminalEnvelopes.length,
          exactlyOne: Boolean(validTerminal),
          adapterChannelClosedObserved: supervision.adapterChannelClosedObserved,
          processExitObserved: !supervision.exit.startFailed,
        };
        run.outcome = harnessRunOutcomeSchema.parse({
          outcomeId,
          status,
          code,
          completedAt,
          incompleteResult,
          result: acceptedTerminal ? acceptedTerminal.result : null,
          diagnosticReferences: run.logStreams.map((stream) => ({
            streamId: stream.streamId,
            producer: stream.producer,
            range: {
              start: stream.availableStart,
              end: stream.availableEnd,
            },
            explicitRetrievalRequired: stream.explicitRetrievalRequired,
            insertedIntoControllerConversation: stream.insertedIntoControllerConversation,
          })),
          terminalEnvelope: acceptedTerminal ? {
            terminalId: acceptedTerminal.terminalId,
            status: acceptedTerminal.status,
            adapterId: acceptedTerminal.adapterId,
            adapterProtocol: acceptedTerminal.adapterProtocol,
          } : null,
          outcomeAuditId,
          interruption: null,
        });
        appendEvent(
          run,
          status === "succeeded"
            ? "harness_run_succeeded"
            : status === "cancelled"
              ? "harness_run_cancelled"
              : "harness_run_failed",
          { outcomeReference: outcomeId },
        );
        terminalOutcomeCommitted = true;
      });
      let finalized = await commitTerminalOutcome();
      if (!terminalOutcomeCommitted && cancellationRequestDeadline
        && terminalCancellationSupervisor) {
        cancellationTermination = await terminalCancellationSupervisor.requestCancellation(
          cancellationRequestDeadline,
        );
        cancellationRequestDeadline = null;
        finalized = await commitTerminalOutcome();
      }
      if (!terminalOutcomeCommitted) return;
      if (validTerminal) {
        await options.faultInjector?.(
          "harness_run_terminal_envelope.after_state_commit",
        );
      }
      await options.faultInjector?.("harness_run_outcome.after_state_commit");
      runtime.acceptedCancellations.delete(initialRun.harnessRunId);
      const committedAuditId = await options.recordAudit(
        "harness.run.outcome",
        "observed",
        runtime.outcomeAuditDetails(finalized),
        outcomeAuditId,
      );
      if (committedAuditId !== outcomeAuditId) {
        throw new Error("harness_run_outcome_audit_commit_invalid");
      }
    } finally {
      await releaseSupervisedProcessTree();
    }
  };

  return { supervise };
};
