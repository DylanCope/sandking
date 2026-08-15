import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  HarnessAdapterProtocolError,
  harnessTerminalEnvelopeSchema,
  loadPinnedHarnessAdapter,
  readHarnessAdapterFrame,
  writeHarnessAdapterFrame,
} from "../harness-adapter-protocol.mjs";
import { sendHarnessCancellationRequest } from "../harness-process-control.mjs";
import { verifyProductionHarnessRetainedInputs } from "../production-harness-preparation.mjs";
import { spawnPosixProcessTree } from "../posix-process-tree.mjs";
import { createDestinationWorkerEnvironment } from "../destination-worker-environment.mjs";
import {
  captureWindowsProcessTreeSnapshot,
  createNativeWindowsJobObject,
  createWindowsProcessTreeTracker,
} from "../windows-process-tree.mjs";
import {
  MAX_PROGRESS_RECORDS_PER_RUN,
  progressRecordSchema,
  storedRunSchema,
} from "./schemas.mjs";
import { scheduleCancellationEscalation } from "./cancellation-escalation.mjs";

const windowsProcessBarrierPath = fileURLToPath(
  new URL("../windows-process-barrier.cjs", import.meta.url),
);

/** @param {string} markerPath @param {"assigned" | "aborted"} decision */
const publishWindowsProcessBarrierDecision = async (markerPath, decision) => {
  const candidatePath = `${markerPath}.${decision}`;
  await writeFile(candidatePath, `${decision}\n`, { mode: 0o600 });
  await rename(candidatePath, markerPath);
};

/**
 * @param {z.infer<typeof storedRunSchema>} run
 * @param {any} context
 * @param {{onAdapterStarted: () => Promise<void>, onReady: (readyAt: string) => Promise<void>, onProgress: (record: z.infer<typeof progressRecordSchema>) => Promise<void>, onDiagnostic: (producer: "stdout" | "stderr", data: Buffer) => Promise<void>, beforeCancellationSignal: (kind: "cooperative" | "forced") => Promise<void>, onCancellationSignalPublished: (kind: "cooperative" | "forced", sentAt: string) => Promise<void>, onCancellationTerminationConfirmed: (confirmedAt: string) => Promise<void>, onSupervisorAvailable: (supervisor: {prepareCancellation: () => Promise<boolean>, requestCancellation: (cooperativeDeadlineAt: string) => Promise<{cooperativeSignalSentAt: string | null, forcedTerminationSentAt: string | null, terminationConfirmedAt: string | null}>, interrupt: () => Promise<void>, releaseProcessTree: () => Promise<void>}) => void}} observer
 */
export const superviseHarnessAdapter = async (run, context, observer) => {
  const pinnedAdapter = await loadPinnedHarnessAdapter({
    workspacePath: context.harnessWorkspacePath,
    pinnedRevision: run.harnessPinnedRevision,
  });
  if (
    pinnedAdapter.compatibility.adapterId !== run.adapterId
    || pinnedAdapter.compatibility.adapterProtocol !== run.adapterProtocol
    || pinnedAdapter.compatibility.entryPoint !== run.adapterEntryPoint
  ) {
    throw new Error("harness_adapter_protocol_invalid");
  }
  const harnessExecutionPath = typeof context.harnessExecutionPath === "string"
    ? context.harnessExecutionPath
    : null;
  const retainedHarnessExecutionInputs = Array.isArray(
    context.retainedHarnessExecutionInputs,
  ) ? context.retainedHarnessExecutionInputs : [];
  if (harnessExecutionPath === null && retainedHarnessExecutionInputs.length > 0) {
    throw new Error("harness_adapter_start_failed");
  }
  const encodedExecution = Buffer.from(JSON.stringify({
    harnessRunId: run.harnessRunId,
    parameters: context.parameters,
  }), "utf8").toString("base64url");
  const adapterWorkingDirectory = harnessExecutionPath ?? context.harnessWorkspacePath;
  const windowsBarrierDirectory = process.platform === "win32"
    ? await mkdtemp(join(tmpdir(), "sandking-harness-job-"))
    : null;
  const windowsBarrierMarker = windowsBarrierDirectory
    ? join(windowsBarrierDirectory, "assigned")
    : null;
  const windowsJobObject = windowsBarrierMarker
    ? createNativeWindowsJobObject({
        name: `Local\\SandKingHarnessRun-${randomBytes(16).toString("hex")}`,
        hostLossTerminationEvidencePath: context.hostLossTerminationEvidencePath,
        launchBarrierMarkerPath: windowsBarrierMarker,
      })
    : null;
  // Execute the exact bytes read from the immutable Git object. The worktree
  // comparison detects drift, while the inline source removes the check/use
  // window in which different adapter bytes could otherwise be launched.
  const adapterArgs = [
    ...(windowsBarrierMarker ? ["--require", windowsProcessBarrierPath] : []),
    "--input-type=module",
    "--eval", pinnedAdapter.pinnedEntryPointSource,
    pinnedAdapter.compatibility.entryPoint,
    "run",
    encodedExecution,
  ];
  if (harnessExecutionPath !== null) {
    await verifyProductionHarnessRetainedInputs({
      executionPath: harnessExecutionPath,
      retainedExecutionInputs: retainedHarnessExecutionInputs,
    });
  }
  const adapterEnvironment = createDestinationWorkerEnvironment();
  const posixProcessTree = process.platform === "win32"
    ? null
      : spawnPosixProcessTree(process.execPath, adapterArgs, {
          cwd: adapterWorkingDirectory,
          env: adapterEnvironment,
          hostLossTerminationEvidencePath: context.hostLossTerminationEvidencePath,
      });
  const child = posixProcessTree?.child ?? spawn(process.execPath, adapterArgs, {
    cwd: adapterWorkingDirectory,
    env: {
      ...adapterEnvironment,
      ...(windowsBarrierMarker
        ? {
            SANDKING_WINDOWS_JOB_BARRIER: windowsBarrierMarker,
            SANDKING_HOST_LOSS_TERMINATION_EVIDENCE:
              context.hostLossTerminationEvidencePath,
          }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe", "pipe", "ipc"],
  });
  const adapterStarted = posixProcessTree?.adapterStarted ?? new Promise((resolve) => {
    child.once("spawn", () => resolve(true));
    child.once("error", () => resolve(false));
  });
  const adapterStartObservation = adapterStarted.then((started) =>
    started ? observer.onAdapterStarted() : undefined);
  if (windowsBarrierDirectory) {
    child.once("close", () => {
      void rm(windowsBarrierDirectory, { recursive: true, force: true });
    });
  }
  const windowsProcessTreePromise = process.platform === "win32"
    && typeof child.pid === "number" && windowsJobObject
    ? captureWindowsProcessTreeSnapshot(child.pid, {
        // The encoded invocation contains this run's unique identity. It lets
        // the launch-time native query reject a different process that reused
        // the adapter PID before its creation time could be captured.
        expectedCommandLineFragment: encodedExecution,
        jobObject: windowsJobObject,
      }).then(async (snapshot) => {
        if (!snapshot || !windowsBarrierMarker) {
          // The adapter is still blocked in the preloaded barrier. Abort that
          // already-bound launch channel rather than signalling a numeric PID
          // which may now identify an unrelated replacement process.
          await windowsJobObject.terminate().catch(() => false);
          if (windowsBarrierMarker) {
            await publishWindowsProcessBarrierDecision(
              windowsBarrierMarker,
              "aborted",
            ).catch(() => undefined);
          }
          return createWindowsProcessTreeTracker({ rootIdentity: null });
        }
        await publishWindowsProcessBarrierDecision(
          windowsBarrierMarker,
          "assigned",
        );
        return createWindowsProcessTreeTracker(snapshot);
      }).catch(async () => {
        // Assignment may have completed before a native query or publication
        // failure became observable. Terminating the unguessable Job identity
        // is safe in either case; the abort marker handles an unassigned child.
        await windowsJobObject.terminate().catch(() => false);
        if (windowsBarrierMarker) {
          await publishWindowsProcessBarrierDecision(
            windowsBarrierMarker,
            "aborted",
          ).catch(() => undefined);
        }
        return createWindowsProcessTreeTracker({ rootIdentity: null });
      })
    : null;
  const terminateContainedAdapter = () => {
    if (posixProcessTree) {
      void posixProcessTree.signal("SIGKILL");
      return;
    }
    if (windowsProcessTreePromise) {
      void windowsProcessTreePromise.then((processTree) =>
        processTree.forceTerminate()).catch(() => undefined);
    }
  };
  const adapterChannel = /** @type {import("node:stream").Duplex | null | undefined} */ (
    posixProcessTree?.adapterChannel ?? child.stdio[3]
  );
  if (
    !adapterChannel
    || !child.stdout
    || !child.stderr
    || !("readable" in adapterChannel)
    || (retainedHarnessExecutionInputs.length > 0 && !("writable" in adapterChannel))
  ) {
    terminateContainedAdapter();
    await windowsJobObject?.close();
    throw new Error("harness_adapter_start_failed");
  }
  let diagnosticQueue = Promise.resolve();
  child.stdout.on("data", (chunk) => {
    diagnosticQueue = diagnosticQueue.then(() =>
      observer.onDiagnostic("stdout", Buffer.from(chunk)));
  });
  child.stderr.on("data", (chunk) => {
    diagnosticQueue = diagnosticQueue.then(() =>
      observer.onDiagnostic("stderr", Buffer.from(chunk)));
  });

  let adapterReadyObserved = false;
  let protocolInvalid = false;
  let adapterChannelClosedObserved = false;
  adapterChannel.once("close", () => {
    adapterChannelClosedObserved = true;
  });
  const terminateProtocolInvalidAdapter = () => {
    protocolInvalid = true;
    terminateContainedAdapter();
    adapterChannel.destroy();
  };
  const publishedProgressRecordIds = new Set();
  /** @type {Array<z.infer<typeof harnessTerminalEnvelopeSchema>>} */
  const terminalEnvelopes = [];
  const consumeFrames = async () => {
    while (true) {
      let message;
      try {
        message = await readHarnessAdapterFrame(adapterChannel);
      } catch (error) {
        if (
          error instanceof HarnessAdapterProtocolError
          && error.code === "harness_adapter_channel_closed"
        ) {
          adapterChannelClosedObserved = true;
          return;
        }
        terminateProtocolInvalidAdapter();
        return;
      }
      if (
        message.type === "harness.adapter.probe"
        || message.type === "harness.launch.prepared"
        || message.type === "harness.launch.failure"
      ) {
        terminateProtocolInvalidAdapter();
        continue;
      }
      if (
        message.harnessRunId !== run.harnessRunId
        || message.adapterId !== run.adapterId
        || message.adapterProtocol !== run.adapterProtocol
      ) {
        terminateProtocolInvalidAdapter();
        continue;
      }
      if (message.type === "harness.run.ready") {
        if (adapterReadyObserved) {
          terminateProtocolInvalidAdapter();
          continue;
        }
        adapterReadyObserved = true;
        await adapterStartObservation;
        await observer.onReady(message.readyAt);
        // Readiness is the first public point at which the adapter may already
        // have launched Workers. Retain their ancestry after publishing ready
        // so inventory cannot delay the selected run's cancellation action.
        if (posixProcessTree) void posixProcessTree.captureDescendants();
        continue;
      }
      if (message.type === "harness.run.progress") {
        if (
          !adapterReadyObserved
          || terminalEnvelopes.length > 0
          || publishedProgressRecordIds.size >= MAX_PROGRESS_RECORDS_PER_RUN
          || publishedProgressRecordIds.has(message.record.recordId)
          || (message.record.parentRecordId !== null
            && !publishedProgressRecordIds.has(message.record.parentRecordId))
        ) {
          terminateProtocolInvalidAdapter();
          continue;
        }
        publishedProgressRecordIds.add(message.record.recordId);
        await observer.onProgress(message.record);
        continue;
      }
      if (message.type === "harness.run.terminal") {
        if (!adapterReadyObserved) {
          protocolInvalid = true;
        }
        terminalEnvelopes.push(message);
        continue;
      }
      terminateProtocolInvalidAdapter();
    }
  };
  const exit = posixProcessTree?.adapterExit ?? new Promise((resolve) => {
    child.once("error", () => resolve({ code: null, signal: null, startFailed: true }));
    child.once("exit", (code, signal) => resolve({ code, signal, startFailed: false }));
  });
  /** @type {string | null} */
  let cooperativeSignalSentAt = null;
  /** @type {string | null} */
  let forcedTerminationSentAt = null;
  let retainedCooperativeDeadlineAt = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let forcedTerminationTimer;
  let forcedTerminationOperation = Promise.resolve();
  /** @type {Promise<{cooperativeSignalSentAt: string | null, forcedTerminationSentAt: string | null, terminationConfirmedAt: string | null}> | null} */
  let cancellationOperation = null;
  /** @type {Promise<boolean> | null} */
  let processTreePreparation = null;
  const processTreeAlive = async () => {
    if (typeof child.pid !== "number") return false;
    if (posixProcessTree) return posixProcessTree.processTreeAlive();
    if (process.platform === "win32") {
      // Missing or uncertain descendant tracking cannot prove tree termination.
      const windowsProcessTree = windowsProcessTreePromise
        ? await windowsProcessTreePromise
        : null;
      return windowsProcessTree ? windowsProcessTree.processTreeAlive() : true;
    }
    return true;
  };
  /** @param {NodeJS.Signals} signal */
  const signalProcessTree = async (signal) => {
    if (typeof child.pid !== "number") {
      return { sent: false, sentAt: null };
    }
    if (posixProcessTree && ["SIGTERM", "SIGKILL"].includes(signal)) {
      return posixProcessTree.signal(/** @type {"SIGTERM" | "SIGKILL"} */ (signal));
    }
    // Windows ChildProcess.kill maps every supported signal to abrupt
    // termination. Cooperative cancellation uses the adapter IPC request and
    // forced cancellation is bound to retained native process handles.
    return { sent: false, sentAt: null };
  };
  const prepareCancellation = () => {
    if (processTreePreparation) return processTreePreparation;
    processTreePreparation = (async () => {
      if (posixProcessTree) return posixProcessTree.prepareCancellation();
      const windowsProcessTree = windowsProcessTreePromise
        ? await windowsProcessTreePromise
        : null;
      return windowsProcessTree
        ? windowsProcessTree.prepareCancellation()
        : false;
    })();
    return processTreePreparation;
  };
  const completion = Promise.all([exit, consumeFrames(), adapterStartObservation]);
  if (retainedHarnessExecutionInputs.length > 0) {
    try {
      writeHarnessAdapterFrame(adapterChannel, {
        type: "harness.run.start",
        adapterProtocol: run.adapterProtocol,
        adapterId: run.adapterId,
        harnessRunId: run.harnessRunId,
        retainedExecutionInputs: retainedHarnessExecutionInputs,
      });
    } catch {
      terminateContainedAdapter();
      adapterChannel.destroy();
      await windowsJobObject?.close();
      throw new Error("harness_adapter_start_failed");
    }
  }
  /** @param {string} cooperativeDeadlineAt */
  const requestCancellation = (cooperativeDeadlineAt) => {
    if (cancellationOperation) return cancellationOperation;
    retainedCooperativeDeadlineAt = cooperativeDeadlineAt;
    // This may already be in flight from the read-only preparation started by
    // the mutation path before its durable commit. Reuse it so no second tree
    // inventory delays the post-commit cooperative signal.
    const cancellationPreparation = prepareCancellation();
    const scheduledEscalation = scheduleCancellationEscalation(
      cooperativeDeadlineAt,
      async () => {
        // A cooperative exit disarms escalation before any signal is sent.
        // The POSIX group guard remains alive through the terminal commit but
        // is not itself part of the supervised Harness process tree.
        if (
          posixProcessTree?.adapterExited()
          && !(await processTreeAlive())
        ) {
          return;
        }
        const windowsProcessTree = windowsProcessTreePromise
          ? await windowsProcessTreePromise
          : null;
        if (windowsProcessTree) {
          await observer.beforeCancellationSignal("forced");
          if (await windowsProcessTree.forceTerminate()) {
            forcedTerminationSentAt = new Date().toISOString();
            await observer.onCancellationSignalPublished(
              "forced",
              forcedTerminationSentAt,
            );
          }
          return;
        }
        await observer.beforeCancellationSignal("forced");
        const forcedTermination = await signalProcessTree("SIGKILL");
        if (forcedTermination.sent && forcedTermination.sentAt) {
          forcedTerminationSentAt = forcedTermination.sentAt;
          await observer.onCancellationSignalPublished(
            "forced",
            forcedTermination.sentAt,
          );
        }
      },
    );
    forcedTerminationTimer = scheduledEscalation.timer;
    forcedTerminationOperation = scheduledEscalation.operation;
    // The deadline can fault independently while the adapter-completion path
    // is still settling. Attach a handler immediately; the awaited operation
    // below still propagates the injected interruption to supervision.
    void forcedTerminationOperation.catch(() => undefined);
    cancellationOperation = (async () => {
      await cancellationPreparation;
      const windowsProcessTree = windowsProcessTreePromise
        ? await windowsProcessTreePromise
        : null;
      const posixTreeRequiresCooperativeSignal = posixProcessTree
        ? !posixProcessTree.adapterExited()
        : false;
      if (windowsProcessTree) {
        await observer.beforeCancellationSignal("cooperative");
        const cooperativeRequestSent = sendHarnessCancellationRequest(child, {
          type: "harness.run.cancel",
          adapterProtocol: run.adapterProtocol,
          adapterId: run.adapterId,
          harnessRunId: run.harnessRunId,
          cooperativeDeadlineAt,
        });
        if (cooperativeRequestSent) {
          cooperativeSignalSentAt = new Date().toISOString();
          await observer.onCancellationSignalPublished(
            "cooperative",
            cooperativeSignalSentAt,
          );
        }
      } else if (posixTreeRequiresCooperativeSignal) {
        await observer.beforeCancellationSignal("cooperative");
        const cooperativeSignal = await signalProcessTree("SIGTERM");
        if (cooperativeSignal.sent && cooperativeSignal.sentAt) {
          cooperativeSignalSentAt = cooperativeSignal.sentAt;
          await observer.onCancellationSignalPublished(
            "cooperative",
            cooperativeSignal.sentAt,
          );
        }
      }
      await completion;
      let terminationConfirmedAt = null;
      // The adapter may exit cooperatively while an inherited descendant
      // remains in its supervised process group. Keep the forced deadline
      // active until the entire group is gone, then confirm termination from
      // that boundary. This also handles cancellation accepted after the
      // adapter root exits but before its terminal outcome commits.
      const confirmationDeadline = Math.max(
        Date.now(),
        Date.parse(retainedCooperativeDeadlineAt ?? ""),
      ) + 1_000;
      while (
        forcedTerminationSentAt === null
        && await processTreeAlive()
        && Date.now() < confirmationDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!(await processTreeAlive())) scheduledEscalation.cancel();
      await forcedTerminationOperation;
      // A dispatched force signal is evidence of an attempt, not evidence that
      // every retained descendant terminated. Confirm the tree again before
      // allowing the cancellation terminal transition.
      if (!(await processTreeAlive())) {
        terminationConfirmedAt = new Date().toISOString();
        await observer.onCancellationTerminationConfirmed(terminationConfirmedAt);
      }
      clearTimeout(forcedTerminationTimer);
      return {
        cooperativeSignalSentAt,
        forcedTerminationSentAt,
        terminationConfirmedAt,
      };
    })();
    return cancellationOperation;
  };
  observer.onSupervisorAvailable({
    prepareCancellation,
    requestCancellation,
    interrupt: async () => {
      // Real Host loss is contained by the native process-tree guard. Mirror
      // that boundary for deterministic in-process interruptions so no old
      // adapter or diagnostic write can race the recreated manager.
      adapterChannel.destroy();
      if (posixProcessTree) {
        await posixProcessTree.signal("SIGKILL");
      } else if (windowsProcessTreePromise) {
        const processTree = await windowsProcessTreePromise.catch(() => null);
        await processTree?.forceTerminate();
      }
      await exit;
      await diagnosticQueue;
    },
    releaseProcessTree: posixProcessTree?.release ?? (async () => {
      await windowsProcessTreePromise?.catch(() => undefined);
      await windowsJobObject?.close();
    }),
  });
  const [exitResult] = await completion;
  const cancellation = cancellationOperation ? await cancellationOperation : null;
  await diagnosticQueue;
  return {
    adapterReadyObserved,
    protocolInvalid,
    terminalEnvelopes,
    adapterChannelClosedObserved,
    exit: exitResult,
    cancellation,
  };
};
