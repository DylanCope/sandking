import { createHarnessRunStore, HarnessRunStateError } from "./store.mjs";
import { SANDCASTLE_HARNESS_ADAPTER_ID } from "../harness-adapter-identity.mjs";
import { removeStaleProductionProviderManifest } from "../production-provider-preparation.mjs";
import {
  harnessRunCancellationSchema,
  harnessRunEventSchema,
  harnessRunExecutionSnapshotSchema,
  harnessRunOutcomeAdapterIdentityAgrees,
  harnessRunOutcomeSchema,
  harnessRunRecoveryActionSchema,
  harnessRunRecoveryProcessObservationSchema,
  harnessRunRecoverySchema,
  harnessRunSchema,
  hostIdSchema,
  requireHarnessRunOutcomeAdapterIdentityAgreement,
} from "./schemas.mjs";
import { scheduleCancellationEscalation } from "./cancellation-escalation.mjs";
import { createHarnessRunReconciliation } from "./reconciliation.mjs";
import { createRunSupervisor } from "./run-supervision.mjs";
import { createLaunchOperation } from "./operations/launch.mjs";
import { createCancelOperation } from "./operations/cancel.mjs";
import { createRecoverOperation } from "./operations/recover.mjs";
import { createQueryOperations } from "./operations/queries.mjs";

export {
  HarnessRunStateError,
  harnessRunCancellationSchema,
  harnessRunEventSchema,
  harnessRunExecutionSnapshotSchema,
  harnessRunOutcomeAdapterIdentityAgrees,
  harnessRunOutcomeSchema,
  harnessRunRecoveryActionSchema,
  harnessRunRecoveryProcessObservationSchema,
  harnessRunRecoverySchema,
  harnessRunSchema,
  requireHarnessRunOutcomeAdapterIdentityAgreement,
  scheduleCancellationEscalation,
};

/**
 * Wire persistence, reconciliation, supervision, and the four Harness-run
 * operation families behind the historical manager surface.
 * @param {any} options
 */
export const createHarnessRunManager = async (options) => {
  const parsedHostId = hostIdSchema.parse(options.hostId);
  const now = options.now ?? (() => new Date());
  const cancellationGraceMs = options.cancellationGraceMs ?? 250;
  if (!Number.isSafeInteger(cancellationGraceMs) || cancellationGraceMs < 10
    || cancellationGraceMs > 10_000) {
    throw new Error("harness_run_cancellation_deadline_invalid");
  }

  let mutationQueue = Promise.resolve();
  /** @template T @param {() => Promise<T>} operation */
  const withMutationLock = (operation) => {
    const current = mutationQueue.catch(() => undefined).then(operation);
    mutationQueue = current.then(() => undefined, () => undefined);
    return current;
  };

  const runtime = /** @type {any} */ ({
    options,
    parsedHostId,
    now,
    cancellationGraceMs,
    withMutationLock,
    /** @type {Map<string, {prepareCancellation: () => Promise<boolean>, requestCancellation: (cooperativeDeadlineAt: string) => Promise<{cooperativeSignalSentAt: string | null, forcedTerminationSentAt: string | null, terminationConfirmedAt: string | null}>, interrupt: () => Promise<void>, releaseProcessTree: () => Promise<void>}>} */
    activeSupervisions: new Map(),
    /** @type {Set<Promise<void>>} */
    supervisionOperations: new Set(),
    /** @type {Map<string, string>} */
    acceptedCancellations: new Map(),
    /** @type {Map<string, {count: number, rollback: () => Promise<void>, cleanupOperation: Promise<void> | null}>} */
    activeProductionProviderPreparations: new Map(),
  });

  Object.assign(runtime, createHarnessRunStore(options));
  Object.assign(runtime, createHarnessRunReconciliation(runtime));

  // Complete terminal-view repair and active-run reconciliation before
  // exposing observation or mutation methods to the framed Host loop.
  await runtime.reconcileInterruptedRuns();
  const reconciledState = await runtime.readState();
  const productionProjectIds = new Set(reconciledState.runs
    .filter((/** @type {any} */ run) =>
      run.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID)
    .map((/** @type {any} */ run) => run.projectId));
  for (const projectId of productionProjectIds) {
    try {
      const context = await options.loadLaunchContext(/** @type {string} */ (projectId));
      await removeStaleProductionProviderManifest({
        projectPath: context.project.canonicalPath,
      });
    } catch {
      // Missing or invalid retained Projects remain truthful in Host state;
      // cleanup is retried if that Project becomes launchable again.
    }
  }

  Object.assign(runtime, createRunSupervisor(runtime));
  Object.assign(runtime, createLaunchOperation(runtime));
  Object.assign(runtime, createCancelOperation(runtime));
  Object.assign(runtime, createRecoverOperation(runtime));
  Object.assign(runtime, createQueryOperations(runtime));

  // A retained intent is the post-commit side of a recovery boundary. Finish
  // it before any public method can accept a different lifecycle mutation.
  await withMutationLock(async () => {
    const retained = await runtime.readState();
    for (const mutation of retained.recoveryMutations) {
      if (!mutation.response) {
        await runtime.completeRecoveryMutation(retained, mutation);
      }
    }
  });

  const waitForIdle = async () => {
    while (runtime.supervisionOperations.size > 0) {
      await Promise.allSettled([...runtime.supervisionOperations]);
    }
  };

  return {
    launch: runtime.launch,
    cancel: runtime.cancel,
    recover: runtime.recover,
    lookup: runtime.lookup,
    lookupRecovery: runtime.lookupRecovery,
    observe: runtime.observe,
    readLogs: runtime.readLogs,
    waitForIdle,
  };
};
