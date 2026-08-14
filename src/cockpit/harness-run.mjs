import { element } from "./dom.mjs";
import {
  harnessLaunchRetryHash,
  retainPendingHarnessLaunch,
} from "./socket.mjs";

export const createHarnessRunObservation = ({
  state,
  socket,
  updateWorkbenchChrome,
}) => {
  const retainedHarnessRunCursor = () => {
    try {
      const cursor = JSON.parse(sessionStorage.getItem(state.storageKeys.harnessRunCursor) ?? "null");
      return /^harness-run-[a-f0-9]{24}$/.test(cursor?.harnessRunId ?? "")
        && Number.isSafeInteger(cursor?.sequence)
        && cursor.sequence >= 0
        ? cursor
        : null;
    } catch {
      return null;
    }
  };

  const readPendingHarnessRunSelection = () => {
    try {
      const harnessRunId = sessionStorage.getItem(state.storageKeys.pendingHarnessRunSelection);
      if (!/^harness-run-[a-f0-9]{24}$/.test(harnessRunId ?? "")) {
        sessionStorage.removeItem(state.storageKeys.pendingHarnessRunSelection);
        return null;
      }
      return harnessRunId;
    } catch {
      sessionStorage.removeItem(state.storageKeys.pendingHarnessRunSelection);
      return null;
    }
  };

  const retainPendingHarnessRunSelection = (harnessRunId) => {
    sessionStorage.setItem(state.storageKeys.pendingHarnessRunSelection, harnessRunId);
    sessionStorage.setItem(state.storageKeys.harnessRunCursor, JSON.stringify({
      harnessRunId,
      sequence: 0,
    }));
  };

  const readPendingHarnessCancellation = () => {
    try {
      const cancellation = JSON.parse(
        sessionStorage.getItem(state.storageKeys.pendingHarnessCancellation) ?? "null",
      );
      if (
        !/^harness-run-[a-f0-9]{24}$/.test(cancellation?.harnessRunId ?? "")
        || !/^sha256:[a-f0-9]{64}$/.test(cancellation?.idempotencyKeyHash ?? "")
      ) {
        sessionStorage.removeItem(state.storageKeys.pendingHarnessCancellation);
        return null;
      }
      return cancellation;
    } catch {
      sessionStorage.removeItem(state.storageKeys.pendingHarnessCancellation);
      return null;
    }
  };

  const readPendingHarnessRecovery = () => {
    try {
      const recovery = JSON.parse(
        sessionStorage.getItem(state.storageKeys.pendingHarnessRecovery) ?? "null",
      );
      if (
        !/^harness-run-[a-f0-9]{24}$/.test(recovery?.harnessRunId ?? "")
        || !["recheck", "terminate_confirmed_tree", "finalize"].includes(recovery?.action)
        || !/^sha256:[a-f0-9]{64}$/.test(recovery?.idempotencyKeyHash ?? "")
      ) {
        sessionStorage.removeItem(state.storageKeys.pendingHarnessRecovery);
        return null;
      }
      return recovery;
    } catch {
      sessionStorage.removeItem(state.storageKeys.pendingHarnessRecovery);
      return null;
    }
  };

  const requestHarnessRunObservation = (selectedHarnessRunId = null) => {
    if (
      !state.runtimeNegotiated
      || state.hostConnectionStatus !== "connected"
      || socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    const cursor = retainedHarnessRunCursor();
    const pendingSelection = readPendingHarnessRunSelection();
    const harnessRunId = selectedHarnessRunId
      ?? pendingSelection
      ?? cursor?.harnessRunId
      ?? state.currentHarnessRunObservation?.run?.harnessRunId
      ?? null;
    socket.send(JSON.stringify({
      channel: "control",
      message: {
        type: "browser.harness-run.observe",
        requestId: `harness-observe-${state.harnessRequestSequence}`,
        harnessRunId,
        afterSequence: selectedHarnessRunId === null
          && pendingSelection === null
          && harnessRunId === cursor?.harnessRunId
          ? cursor.sequence
          : 0,
      },
    }));
    state.harnessRequestSequence += 1;
  };

  const requestHarnessRunCancellation = (run, button, feedback) => {
    if (
      !state.runtimeNegotiated
      || state.hostConnectionStatus !== "connected"
      || socket.readyState !== WebSocket.OPEN
      || state.pendingHarnessCancellationRequestId !== null
      || !["starting", "running"].includes(run.status)
    ) {
      feedback.textContent = "Cancellation was not requested: the selected run is not live.";
      return;
    }
    const pendingCancellation = {
      harnessRunId: run.harnessRunId,
      idempotencyKeyHash: harnessLaunchRetryHash(),
    };
    sessionStorage.setItem(
      state.storageKeys.pendingHarnessCancellation,
      JSON.stringify(pendingCancellation),
    );
    state.pendingHarnessCancellationRequestId = `harness-cancel-${state.harnessRequestSequence}`;
    state.harnessRequestSequence += 1;
    button.disabled = true;
    feedback.textContent = "Requesting cancellation…";
    socket.send(JSON.stringify({
      channel: "control",
      message: {
        type: "browser.harness-run.cancel",
        requestId: state.pendingHarnessCancellationRequestId,
        ...pendingCancellation,
      },
    }));
  };

  const requestHarnessRunRecovery = (run, action, button, feedback) => {
    if (
      !state.runtimeNegotiated
      || state.hostConnectionStatus !== "connected"
      || socket.readyState !== WebSocket.OPEN
      || state.pendingHarnessRecoveryRequestId !== null
      || run.status !== "recovery_required"
      || !run.recovery?.availableActions.includes(action)
    ) {
      feedback.textContent = "Recovery was not requested: that bounded action is unavailable.";
      return;
    }
    const pendingRecovery = {
      harnessRunId: run.harnessRunId,
      action,
      idempotencyKeyHash: harnessLaunchRetryHash(),
    };
    sessionStorage.setItem(
      state.storageKeys.pendingHarnessRecovery,
      JSON.stringify(pendingRecovery),
    );
    state.pendingHarnessRecoveryRequestId = `harness-recover-${state.harnessRequestSequence}`;
    state.harnessRequestSequence += 1;
    for (const recoveryButton of document.querySelectorAll("[data-harness-recovery-action]")) {
      recoveryButton.disabled = true;
    }
    button.disabled = true;
    feedback.textContent = action === "terminate_confirmed_tree"
      ? "Requesting termination of the retained, identity-confirmed process tree…"
      : action === "finalize"
        ? "Finalizing the interrupted run from confirmed termination evidence…"
        : "Rechecking retained process supervision evidence…";
    socket.send(JSON.stringify({
      channel: "control",
      message: {
        type: "browser.harness-run.recover",
        requestId: state.pendingHarnessRecoveryRequestId,
        ...pendingRecovery,
      },
    }));
  };

  const renderHarnessRun = (observation) => {
    const section = element("section", {
      id: "harness-run-observation",
      "data-observation-mode": observation.mode,
      "data-run-present": String(Boolean(observation.run)),
      "data-host-freshness": state.hostFreshness,
      "data-next-sequence": observation.nextSequence,
      "data-resynchronization-reason": observation.resynchronization?.reason ?? "",
    });
    section.append(
      element("h2", {}, "Harness run observation"),
      element("p", { "data-observation-independent": "true" },
        "Observation is independent of the browser and focused Controller session lifecycle."),
    );
    if (!observation.run) {
      section.append(element("p", { id: "harness-run-empty" },
        "No Harness run has launched."));
      return section;
    }
    const run = observation.run;
    section.dataset.runId = run.harnessRunId;
    section.dataset.runStatus = run.status;
    section.dataset.projectId = run.projectId;
    section.dataset.harnessPin = run.harnessPinnedRevision;
    section.dataset.controllerSessionId = run.controllerSessionId ?? "";
    const launchAuditId = run.launchAuditId;
    const launchSource = run.source;
    const snapshot = run.executionSnapshot;
    section.dataset.launchAuditId = launchAuditId;
    section.dataset.launchSource = launchSource;
    section.append(
      element("h3", {}, `Harness run ${run.harnessRunId}`),
      element("p", { "data-run-status": run.status }, `Lifecycle status: ${run.status}`),
      element("p", { "data-launch-source": launchSource }, `Launched from: ${launchSource}`),
      element("p", {}, `Project: ${run.projectId}`),
      element("p", {}, `Harness: ${run.harnessId} @ ${run.harnessPinnedRevision}`),
    );
    const cancellationFeedback = element("p", {
      id: "harness-run-cancellation-feedback",
      role: "status",
    }, run.cancellation
      ? run.status === "cancelling"
        ? `Cancellation accepted. Waiting until ${run.cancellation.cooperativeDeadlineAt} for termination.`
        : run.status === "cancelled"
          ? `Cancellation accepted. Termination was confirmed at ${run.cancellation.terminationConfirmedAt}.`
          : "Cancellation accepted. The Host could not prove termination; recovery is required."
      : "");
    if (["starting", "running"].includes(run.status)) {
      const cancelButton = element("button", {
        id: "cancel-harness-run",
        type: "button",
        disabled: state.hostConnectionStatus !== "connected"
          || state.pendingHarnessCancellationRequestId !== null,
      }, "Cancel run");
      cancelButton.addEventListener("click", () =>
        requestHarnessRunCancellation(run, cancelButton, cancellationFeedback));
      section.append(cancelButton, cancellationFeedback);
    } else if (run.cancellation) {
      section.append(element("p", {
        id: "harness-run-cancellation-progress",
        "data-cancellation-accepted": "true",
        "data-cooperative-deadline": run.cancellation.cooperativeDeadlineAt,
        "data-termination-confirmed": String(
          run.cancellation.terminationConfirmedAt !== null,
        ),
        "data-reconciled-result": run.status,
      }, run.status === "cancelling"
        ? "Cancellation accepted; termination remains asynchronously observable."
        : run.status === "cancelled"
          ? "Cancellation accepted; truthful terminal outcome: cancelled."
          : "Cancellation accepted; termination is unconfirmed and recovery is required."),
      cancellationFeedback);
    }
    if (observation.outcome?.code === "host_daemon_interrupted") {
      const interruption = observation.outcome.interruption;
      const interruptionPanel = element("section", {
        id: "harness-run-interruption",
        role: "alert",
        "data-interruption-code": observation.outcome.code,
        "data-previous-status": interruption?.previousStatus ?? "",
        "data-reconciliation-audit-id": interruption?.reconciliationAuditId ?? "",
        "data-outcome-audit-id": observation.outcome.outcomeAuditId ?? "",
        "data-next-action": "deliberate-new-run",
      });
      interruptionPanel.append(
        element("h3", {}, "Run interrupted by Host shutdown"),
        element("p", { id: "harness-run-interruption-reason" },
          "The Host ended before this run produced a valid terminal result. Startup reconciled "
          + "the retained run as failed with an incomplete result; the adapter was not relaunched."),
        element("p", { id: "harness-run-interruption-history" },
          "Earlier ordered events, immutable execution facts, and bounded diagnostic ranges remain "
          + "available below."),
        element("p", { id: "harness-run-interruption-guidance" },
          "Retrying the original launch reconnects to this same result. To try the work again, open "
          + "the Project and use Launch for a deliberate new run; this interrupted run will remain "
          + "unchanged."),
      );
      if (run.launchIdempotencyKeyHash) {
        const reconnectButton = element("button", {
          id: "reconnect-harness-launch",
          type: "button",
          "data-action": "reconnect-original-launch",
          disabled: state.hostConnectionStatus !== "connected",
        }, "Reconnect original launch");
        reconnectButton.addEventListener("click", () => {
          if (
            state.hostConnectionStatus !== "connected"
            || state.pendingHarnessLaunchRequestId !== null
            || !state.harnessLaunchFeedback
          ) {
            return;
          }
          const pendingLaunch = {
            projectId: run.projectId,
            parameters: snapshot.parameters ?? {},
            idempotencyKeyHash: run.launchIdempotencyKeyHash,
            reconnectHarnessRunId: run.harnessRunId,
          };
          retainPendingHarnessLaunch(state, pendingLaunch);
          state.pendingHarnessLaunchRequestId = `harness-launch-reconnect-${state.harnessRequestSequence}`;
          state.harnessRequestSequence += 1;
          reconnectButton.disabled = true;
          state.harnessLaunchFeedback.textContent =
            "Reconnecting to the retained Harness launch outcome…";
          socket.send(JSON.stringify({
            channel: "control",
            message: {
              type: "browser.harness-run.launch",
              requestId: state.pendingHarnessLaunchRequestId,
              projectId: pendingLaunch.projectId,
              ...(Object.keys(pendingLaunch.parameters).length === 0
                ? {}
                : { parameters: pendingLaunch.parameters }),
              idempotencyKeyHash: pendingLaunch.idempotencyKeyHash,
              reconnectHarnessRunId: pendingLaunch.reconnectHarnessRunId,
            },
          }));
        });
        interruptionPanel.append(reconnectButton);
      }
      section.append(interruptionPanel);
    }
    if (run.status === "recovery_required" && run.recovery) {
      const recovery = run.recovery;
      const processObservation = recovery.processObservation;
      const recoveryPanel = element("section", {
        id: "harness-run-recovery-required",
        role: "alert",
        "data-recovery-code": recovery.code,
        "data-termination-evidence": recovery.terminationEvidence,
        "data-related-process-state": processObservation.relatedProcessState,
        "data-identity-proof": processObservation.identityProof,
        "data-safe-to-terminate": processObservation.safeToTerminate,
        "data-process-count": processObservation.processCount ?? "",
        "data-process-identifiers-exposed": processObservation.processIdentifiersExposed,
        "data-unrestricted-process-handle-exposed":
          processObservation.unrestrictedProcessHandleExposed,
        "data-reconciliation-audit-id": recovery.reconciliationAuditId,
        "data-next-action": "recovery-required",
      });
      const processExplanation = processObservation.relatedProcessState === "running_confirmed"
        ? `The Host retained exact supervision identity for ${processObservation.processCount} `
          + "related process(es). Only that complete process tree can be terminated."
        : processObservation.relatedProcessState === "terminated_confirmed"
          ? "The Host proved that the retained complete process tree is empty."
          : "The Host cannot currently prove whether a related Harness process tree remains.";
      const recoveryFeedback = element("p", {
        id: "harness-run-recovery-feedback",
        role: "status",
      });
      recoveryPanel.append(
        element("h3", {}, "Run requires recovery"),
        element("p", { id: "harness-run-recovery-reason" },
          "The Host restarted without proof that supervision of this Harness run ended. "
          + "No terminal outcome has been invented."),
        element("p", { id: "harness-run-recovery-process-facts" },
          `${processExplanation} Process identifiers and unrestricted process handles are not exposed.`),
        element("p", { id: "harness-run-recovery-history" },
        "Earlier ordered events, immutable execution facts, and bounded diagnostic ranges remain "
          + "available below."),
        element("p", { id: "harness-run-recovery-guidance" },
          "You may deliberately launch a new run; this recovery record remains unchanged, and new "
          + "work could overlap if related process state is still unknown."),
      );
      const recoveryActions = element("div", {
        id: "harness-run-recovery-actions",
        "data-available-actions": recovery.availableActions.join(","),
      });
      const actionLabels = {
        recheck: "Recheck process evidence",
        terminate_confirmed_tree: "Terminate confirmed process tree",
        finalize: "Finalize interrupted run",
      };
      for (const action of recovery.availableActions) {
        const button = element("button", {
          id: `harness-recovery-${action.replaceAll("_", "-")}`,
          type: "button",
          "data-harness-recovery-action": action,
          disabled: state.hostConnectionStatus !== "connected"
            || state.pendingHarnessRecoveryRequestId !== null,
        }, actionLabels[action]);
        button.addEventListener("click", () =>
          requestHarnessRunRecovery(run, action, button, recoveryFeedback));
        recoveryActions.append(button);
      }
      recoveryPanel.append(recoveryActions, recoveryFeedback);
      section.append(recoveryPanel);
    }
    const executionFacts = element("section", {
      id: "harness-run-execution-snapshot",
      "data-snapshot-version": snapshot.schemaVersion,
      "data-snapshot-capture": snapshot.capture,
      "data-launch-time": snapshot.createdAt,
      "data-project-registration-revision": snapshot.projectRegistration.revision ?? "",
      "data-harness-registration-revision": snapshot.harness.revision ?? "",
      "data-adapter-id": snapshot.adapter.adapterId,
      "data-adapter-protocol": snapshot.adapter.protocol,
      "data-adapter-entry-point": snapshot.adapter.entryPoint,
      "data-production-skill-lock": snapshot.productionHarness?.skillSetLockDigest ?? "",
      "data-production-projection-digest": snapshot.productionHarness?.projectionDigest ?? "",
    });
    executionFacts.append(
      element("h3", {}, "Immutable execution facts"),
      element("p", { "data-execution-launch-time": snapshot.createdAt },
        `Launched at: ${snapshot.createdAt}`),
      element("p", { "data-execution-host-id": snapshot.hostId },
        `Host: ${snapshot.hostId}`),
      element("p", { "data-execution-project-id": snapshot.projectRegistration.projectId },
        `Project registration: ${snapshot.projectRegistration.displayName ?? "name not retained"} `
        + `(${snapshot.projectRegistration.projectId}), revision `
        + `${snapshot.projectRegistration.revision ?? "not retained"}`),
      element("p", { "data-execution-harness-id": snapshot.harness.harnessId },
        `Harness: ${snapshot.harness.name ?? "name not retained"} `
        + `(${snapshot.harness.harnessId}) @ ${snapshot.harness.pinnedRevision}, revision `
        + `${snapshot.harness.revision ?? "not retained"}`),
      element("p", { "data-execution-adapter-id": snapshot.adapter.adapterId },
        `Adapter: ${snapshot.adapter.adapterId} · protocol ${snapshot.adapter.protocol} · `
        + `${snapshot.adapter.entryPoint}`),
      element("pre", { id: "harness-run-launch-parameters" }, snapshot.parameters === null
        ? "Launch parameters were not retained by this historical schema."
        : JSON.stringify(snapshot.parameters, null, 2)),
      element("p", { "data-execution-launch-audit-id": snapshot.launchAuditId },
        `Launch audit: ${snapshot.launchAuditId}`),
    );
    if (snapshot.productionHarness) {
      executionFacts.append(
        element("p", {
          "data-execution-production-skill-lock": snapshot.productionHarness.skillSetLockDigest,
        }, `Locked production skills: ${snapshot.productionHarness.skillSetLockDigest}`),
        element("p", {
          "data-execution-production-resolved-skills": snapshot.productionHarness.resolvedSkills
            .map(({ identity, revision }) => `${identity}@${revision}`)
            .join(","),
        }, "Resolved production skills: " + snapshot.productionHarness.resolvedSkills
          .map(({ identity, revision }) => `${identity}@${revision}`)
          .join(", ")),
        element("p", {
          "data-execution-production-runtime-inputs": snapshot.productionHarness
            .executionRuntimeInputs
            .map(({ identity, version }) => `${identity}@${version}`)
            .join(","),
        }, "Production runtime inputs: " + snapshot.productionHarness.executionRuntimeInputs
          .map(({ identity, version }) => `${identity}@${version}`)
          .join(", ")),
        element("p", {
          "data-execution-production-projection": snapshot.productionHarness.projectionDigest,
        }, `Prepared projection: ${snapshot.productionHarness.projectionDigest}`),
      );
    }
    section.append(executionFacts);
    const events = element("ol", {
      id: "harness-run-events",
      "data-event-count": observation.events.length,
      "data-event-sequences": observation.events.map((event) => event.sequence).join(","),
    });
    for (const event of observation.events) {
      events.append(element("li", {
        "data-event-id": event.eventId,
        "data-event-sequence": event.sequence,
        "data-event-type": event.type,
      }, `${event.sequence}. ${event.type}${event.progressRecord
        ? ` — ${event.progressRecord.summary}`
        : ""}`));
    }
    section.append(element("h3", {}, "Ordered lifecycle events"), events);

    const logs = element("section", {
      id: "harness-run-diagnostics",
      "data-logs-separate": "true",
      "data-conversation-insertion": "false",
    });
    logs.append(element("p", {},
      "Diagnostic logs are explicitly ranged and are never inserted into a Controller conversation."));
    for (const producer of ["stdout", "stderr"]) {
      const stream = observation.logStreams.find((candidate) => candidate.producer === producer);
      logs.append(
        element("h4", {}, `${producer} diagnostics`),
        element("pre", {
          "data-log-producer": producer,
          "data-log-stream-id": stream?.streamId ?? "",
          "data-range-start": stream?.availableStart ?? 0,
          "data-range-end": stream?.availableEnd ?? 0,
          "data-explicit-retrieval": String(stream?.explicitRetrievalRequired ?? true),
          "data-conversation-inserted": String(stream?.insertedIntoControllerConversation ?? false),
        }),
      );
    }
    section.append(logs);
    const outcome = element("pre", {
      id: "harness-run-structured-outcome",
      "data-outcome-status": observation.outcome?.status ?? "pending",
      "data-incomplete-result": String(observation.outcome?.incompleteResult ?? false),
    }, observation.outcome ? JSON.stringify(observation.outcome, null, 2) : "Outcome pending");
    section.append(
      element("h3", {}, "Structured outcome"),
      outcome,
      element("p", {
        id: "harness-terminal-validation",
        "data-exactly-one-terminal": String(
          observation.terminalEnvelopeValidation?.exactlyOne ?? false,
        ),
        "data-process-exit-observed": String(
          observation.terminalEnvelopeValidation?.processExitObserved ?? false,
        ),
        "data-adapter-channel-closed-observed": String(
          observation.terminalEnvelopeValidation?.adapterChannelClosedObserved ?? false,
        ),
      }, observation.terminalEnvelopeValidation
        ? `Terminal envelopes: ${observation.terminalEnvelopeValidation.validTerminalEnvelopeCount}; adapter channel closed: ${observation.terminalEnvelopeValidation.adapterChannelClosedObserved}; process exit observed: ${observation.terminalEnvelopeValidation.processExitObserved}.`
        : "Terminal envelope validation pending."),
    );
    return section;
  };

  const applyHarnessRunObservation = (observation) => {
    const pendingSelection = readPendingHarnessRunSelection();
    if (pendingSelection && observation.run?.harnessRunId !== pendingSelection) {
      requestHarnessRunObservation(pendingSelection);
      return;
    }
    const sameRun = state.currentHarnessRunObservation?.run?.harnessRunId
      === observation.run?.harnessRunId;
    const visibleObservation = observation.mode === "resume" && sameRun
      ? {
          ...observation,
          events: [...new Map([
            ...state.currentHarnessRunObservation.events,
            ...observation.events,
          ].map((event) => [event.eventId, event])).values()]
            .sort((left, right) => left.sequence - right.sequence),
        }
      : observation;
    state.currentHarnessRunObservation = visibleObservation;
    updateWorkbenchChrome({ harnessRunObservation: visibleObservation });
    if (visibleObservation.run) {
      if (visibleObservation.run.harnessRunId === pendingSelection) {
        sessionStorage.removeItem(state.storageKeys.pendingHarnessRunSelection);
      }
      sessionStorage.setItem(state.storageKeys.harnessRunCursor, JSON.stringify({
        harnessRunId: visibleObservation.run.harnessRunId,
        sequence: visibleObservation.nextSequence,
      }));
    } else {
      sessionStorage.removeItem(state.storageKeys.harnessRunCursor);
    }
    const replacement = renderHarnessRun(visibleObservation);
    state.harnessRunSection?.replaceWith(replacement);
    state.harnessRunSection = replacement;
    state.diagnosticStreams.clear();
    if (visibleObservation.run) {
      for (const stream of visibleObservation.logStreams) {
        if (stream.availableEnd === 0) {
          continue;
        }
        socket.send(JSON.stringify({
          channel: "control",
          message: {
            type: "browser.harness-run.logs.get",
            requestId: `harness-logs-${stream.producer}-${state.harnessRequestSequence}`,
            harnessRunId: visibleObservation.run.harnessRunId,
            producer: stream.producer,
            offset: 0,
            limit: Math.min(16_384, Math.max(1, stream.availableEnd)),
          },
        }));
        state.harnessRequestSequence += 1;
      }
    }
    clearTimeout(state.harnessObservationTimer);
    if (
      !visibleObservation.run
      || !["succeeded", "failed", "cancelled", "recovery_required"]
        .includes(visibleObservation.run.status)
    ) {
      state.harnessObservationTimer = setTimeout(requestHarnessRunObservation, 75);
    }
  };

  return {
    applyHarnessRunObservation,
    readPendingHarnessCancellation,
    readPendingHarnessRecovery,
    renderHarnessRun,
    requestHarnessRunObservation,
    retainPendingHarnessRunSelection,
  };
};
