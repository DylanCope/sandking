import {
  hostIdPattern,
  runtimeIdPattern,
} from "/common/identifiers.mjs";

export const harnessLaunchRetryHash = () => {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `sha256:${Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0")).join("")}`;
};

export const retainPendingHarnessLaunch = (state, launch) => {
  sessionStorage.setItem(
    state.storageKeys.pendingHarnessLaunch,
    JSON.stringify(launch),
  );
};

export const createCockpitSocketConnection = () => {
  const websocketProtocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${websocketProtocol}://${location.host}/ws`);
  socket.binaryType = "arraybuffer";
  return socket;
};

export const createCockpitSocket = ({
  state,
  socket,
  browserProtocol,
  app,
  reload,
  terminalSurface,
  projectPreparation,
  harnessRunObservation,
  chrome,
}) => {
  const {
    decodeOpaqueFrame,
    disposeAllTerminalSurfaces,
    scheduleTerminalFit,
  } = terminalSurface;
  const {
    readPendingHarnessLaunch,
    selectedProjectLaunchReady,
  } = projectPreparation;
  const {
    applyHarnessRunObservation,
    readPendingHarnessCancellation,
    readPendingHarnessRecovery,
    requestHarnessRunObservation,
    retainPendingHarnessRunSelection,
  } = harnessRunObservation;
  const {
    renderWorkbench,
    updateWorkbenchChrome,
  } = chrome;

  const requireReload = (code) => {
    disposeAllTerminalSurfaces();
    document.documentElement.dataset.reloadRequired = "true";
    document.documentElement.dataset.protocolError = code;
    app.textContent = "Cockpit update required. Reload to reconnect safely.";
    reload.hidden = false;
  };

  reload.addEventListener("click", () => location.reload());

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      channel: "control",
      message: {
        type: "browser.hello",
        ...browserProtocol,
        observationCursor: sessionStorage.getItem("sandking.observationCursor"),
      },
    }));
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      // Opaque terminal streams are binary and never parsed as structured control.
      document.documentElement.dataset.opaqueStreamReceived = "true";
      const opaque = decodeOpaqueFrame(event.data);
      const terminal = opaque ? state.terminalStreams.get(opaque.streamId) : null;
      if (opaque && terminal) {
        if (opaque.sequence !== terminal.outputSequence) {
          requireReload("runtime_terminal_output_sequence_mismatch");
          return;
        }
        terminal.outputSequence += 1;
        if (opaque.data.byteLength > 0) {
          terminal.emulator.write(opaque.data);
        }
        terminal.output.dataset.outputSequence = String(opaque.sequence);
        if (opaque.eof) {
          terminal.panel.dataset.sessionState = "exited";
          terminal.emulator.options.disableStdin = true;
          terminal.attachmentStatus.textContent = "Exited · read-only";
          updateWorkbenchChrome({
            terminalAttachment: { sessionId: terminal.sessionId, mode: "exited" },
          });
        }
      } else if (opaque) {
        const diagnostic = state.diagnosticStreams.get(opaque.streamId);
        if (diagnostic) {
          diagnostic.output.textContent += diagnostic.decoder.decode(opaque.data, {
            stream: !opaque.eof,
          });
          diagnostic.output.dataset.outputSequence = String(opaque.sequence);
          diagnostic.output.dataset.rangeEof = String(opaque.eof);
        }
      }
      return;
    }

    let envelope;
    try {
      envelope = JSON.parse(event.data);
    } catch {
      requireReload("runtime_control_json_invalid");
      return;
    }

    const message = envelope?.channel === "control" ? envelope.message : null;
    if (message?.type === "runtime.protocol-error") {
      if (message.reloadRequired) {
        requireReload(message.code);
      } else {
        app.textContent = `Connection failed safely: ${message.code}`;
      }
      return;
    }

    if (message?.type === "runtime.connection-state") {
      if (!state.runtimeNegotiated || message.boundary !== "host") {
        requireReload("runtime_connection_state_before_negotiation");
        return;
      }
      state.hostConnectionStatus = message.status;
      state.hostFreshness = message.freshness;
      document.documentElement.dataset.hostConnectionStatus = message.status;
      const connectionStatus = document.getElementById("connection-status");
      if (connectionStatus) {
        connectionStatus.classList.remove(
          "workbench-status--connected",
          "workbench-status--disconnected",
        );
        connectionStatus.classList.add(`workbench-status--${message.status}`);
        connectionStatus.dataset.hostStatus = message.status;
        connectionStatus.dataset.failureCode = message.failure.code;
        connectionStatus.dataset.connectionAuditId = message.failure.auditId;
        connectionStatus.setAttribute("role", "alert");
        connectionStatus.textContent =
          `Host ${message.hostId} is disconnected. Project and Harness views are stale; `
          + "Controller sessions remain available.";
      }
      const projectPreparation = document.getElementById("project-preparation");
      if (projectPreparation) {
        projectPreparation.dataset.hostFreshness = message.freshness;
        for (const control of projectPreparation.querySelectorAll("[data-host-mutation]")) {
          control.disabled = true;
        }
      }
      if (state.harnessRunSection) {
        state.harnessRunSection.dataset.hostFreshness = message.freshness;
        const cancelButton = state.harnessRunSection.querySelector("#cancel-harness-run");
        if (cancelButton) cancelButton.disabled = true;
        for (const recoveryButton of state.harnessRunSection.querySelectorAll(
          "[data-harness-recovery-action]",
        )) {
          recoveryButton.disabled = true;
        }
      }
      clearTimeout(state.harnessObservationTimer);
      return;
    }

    if (message?.type === "runtime.terminal-attached") {
      const terminal = state.terminalStreams.get(message.streamId);
      if (
        !state.runtimeNegotiated
        || !terminal
        || terminal.attachmentId !== message.attachmentId
        || (terminal.requestedMode === "read-write"
          && (message.mode !== "read-write" || message.exclusive !== true))
        || (terminal.requestedMode === "read-write-if-available"
          && !["read-write", "read-only"].includes(message.mode))
      ) {
        requireReload("runtime_terminal_attachment_mismatch");
        return;
      }
      terminal.panel.dataset.terminalAttachment = message.mode;
      terminal.inputSequence = message.inputSequence;
      terminal.resizeSequence = message.resizeSequence;
      terminal.outputSequence = message.outputCursor;
      terminal.emulator.options.disableStdin = message.mode !== "read-write";
      terminal.attachmentStatus.textContent = message.mode === "read-write"
        ? `Connected · read-write${message.resynchronized ? " · retained tail" : ""}`
        : `Connected · read-only${message.resynchronized ? " · retained tail" : ""}`;
      terminal.panel.dataset.terminalOutputResynchronized = String(message.resynchronized);
      updateWorkbenchChrome({
        terminalAttachment: { sessionId: message.sessionId, mode: message.mode },
      });
      scheduleTerminalFit(terminal);
      return;
    }

    if (message?.type === "runtime.terminal-resized") {
      const terminal = state.terminalStreams.get(message.streamId);
      if (
        !state.runtimeNegotiated
        || !terminal
        || terminal.sessionId !== message.sessionId
        || terminal.attachmentId !== message.attachmentId
        || terminal.lastRequestedDimensions?.sequence !== message.sequence
        || terminal.lastRequestedDimensions.columns !== message.columns
        || terminal.lastRequestedDimensions.rows !== message.rows
      ) {
        requireReload("runtime_terminal_resize_mismatch");
        return;
      }
      terminal.panel.dataset.terminalColumns = String(message.columns);
      terminal.panel.dataset.terminalRows = String(message.rows);
      terminal.panel.dataset.terminalResizeSequence = String(message.sequence);
      return;
    }

    if (message?.type === "runtime.harness-run.observation") {
      if (!state.runtimeNegotiated) {
        requireReload("runtime_harness_observation_before_negotiation");
        return;
      }
      applyHarnessRunObservation(message.observation);
      return;
    }

    if (message?.type === "runtime.harness-run.launch-result") {
      if (
        !state.runtimeNegotiated
        || !state.harnessLaunchFeedback
        || message.requestId !== state.pendingHarnessLaunchRequestId
      ) {
        requireReload("runtime_harness_launch_result_mismatch");
        return;
      }
      if (message.outcome.type === "harness.run.launch.result") {
        // Transfer the durable mutation outcome to equally durable observation
        // selection before clearing the launch retry record. A reload in this
        // interval must resume the acknowledged run, never the prior cursor.
        retainPendingHarnessRunSelection(message.outcome.run.harnessRunId);
      }
      state.pendingHarnessLaunchRequestId = null;
      sessionStorage.removeItem(state.storageKeys.pendingHarnessLaunch);
      const launchButton = document.getElementById("launch-harness");
      if (launchButton) {
        launchButton.disabled = state.hostConnectionStatus !== "connected"
          || !selectedProjectLaunchReady();
      }
      if (message.outcome.type === "harness.run.launch.result") {
        state.harnessLaunchFeedback.textContent =
          `Harness run ${message.outcome.run.harnessRunId} launched.`;
        requestHarnessRunObservation(message.outcome.run.harnessRunId);
      } else {
        state.harnessLaunchFeedback.textContent =
          `Harness was not launched: ${message.outcome.code}.`;
      }
      return;
    }

    if (message?.type === "runtime.harness-run.cancel-result") {
      const pendingCancellation = readPendingHarnessCancellation();
      const feedback = document.getElementById("harness-run-cancellation-feedback");
      if (
        !state.runtimeNegotiated
        || !pendingCancellation
        || message.requestId !== state.pendingHarnessCancellationRequestId
        || message.outcome.harnessRunId !== pendingCancellation.harnessRunId
      ) {
        requireReload("runtime_harness_cancellation_result_mismatch");
        return;
      }
      state.pendingHarnessCancellationRequestId = null;
      sessionStorage.removeItem(state.storageKeys.pendingHarnessCancellation);
      if (message.outcome.type === "harness.run.cancel.result") {
        if (feedback) feedback.textContent =
          "Cancellation accepted; termination remains asynchronously observable.";
        requestHarnessRunObservation();
      } else {
        if (feedback) feedback.textContent =
          `Cancellation was not accepted: ${message.outcome.code}.`;
        const cancelButton = document.getElementById("cancel-harness-run");
        if (cancelButton) cancelButton.disabled = state.hostConnectionStatus !== "connected";
      }
      return;
    }

    if (message?.type === "runtime.harness-run.recover-result") {
      const pendingRecovery = readPendingHarnessRecovery();
      const feedback = document.getElementById("harness-run-recovery-feedback");
      if (
        !state.runtimeNegotiated
        || !pendingRecovery
        || message.requestId !== state.pendingHarnessRecoveryRequestId
        || message.outcome.harnessRunId !== pendingRecovery.harnessRunId
        || message.outcome.action !== pendingRecovery.action
      ) {
        requireReload("runtime_harness_recovery_result_mismatch");
        return;
      }
      state.pendingHarnessRecoveryRequestId = null;
      sessionStorage.removeItem(state.storageKeys.pendingHarnessRecovery);
      if (message.outcome.type === "harness.run.recover.result") {
        if (feedback) feedback.textContent = message.outcome.action === "finalize"
          ? "The interrupted run was finalized from confirmed termination evidence."
          : "Recovery evidence was updated; refreshing the retained run.";
        requestHarnessRunObservation(pendingRecovery.harnessRunId);
      } else {
        if (feedback) feedback.textContent =
          `Recovery was not changed: ${message.outcome.code}.`;
        for (const recoveryButton of document.querySelectorAll(
          "[data-harness-recovery-action]",
        )) {
          recoveryButton.disabled = state.hostConnectionStatus !== "connected";
        }
      }
      return;
    }

    if (message?.type === "runtime.harness-run.logs.result") {
      if (!state.runtimeNegotiated || !state.harnessRunSection) {
        requireReload("runtime_harness_logs_before_negotiation");
        return;
      }
      const output = state.harnessRunSection.querySelector(
        `[data-log-producer="${message.producer}"]`,
      );
      if (!output || output.dataset.logStreamId !== message.streamId) {
        requireReload("runtime_harness_log_stream_mismatch");
        return;
      }
      output.textContent = "";
      output.dataset.rangeStart = String(message.range.start);
      output.dataset.rangeEnd = String(message.range.end);
      state.diagnosticStreams.set(message.streamId, {
        output,
        decoder: new TextDecoder(),
      });
      return;
    }

    if (message?.type === "runtime.pong") {
      return;
    }

    const runtimeRequired = Array.isArray(message?.capabilities?.required)
      ? message.capabilities.required
      : [];
    const runtimeOptional = Array.isArray(message?.capabilities?.optional)
      ? message.capabilities.optional
      : [];
    const negotiated = Array.isArray(message?.negotiatedCapabilities)
      ? message.negotiatedCapabilities
      : [];
    const browserKnown = new Set([
      ...browserProtocol.capabilities.required,
      ...browserProtocol.capabilities.optional,
    ]);
    const runtimeAdvertised = new Set([...runtimeRequired, ...runtimeOptional]);
    const capabilitiesCompatible = runtimeRequired.every((capability) =>
      browserKnown.has(capability))
      && browserProtocol.capabilities.required.every((capability) =>
        negotiated.includes(capability))
      && negotiated.every((capability) =>
        browserKnown.has(capability) && runtimeAdvertised.has(capability));
    const framingCompatible = Number.isSafeInteger(message?.framing?.maxControlMessageBytes)
      && message.framing.maxControlMessageBytes > 0
      && message.framing.maxControlMessageBytes <= browserProtocol.framing.maxControlMessageBytes
      && Number.isSafeInteger(message?.framing?.maxOpaqueStreamChunkBytes)
      && message.framing.maxOpaqueStreamChunkBytes > 0
      && message.framing.maxOpaqueStreamChunkBytes
        <= browserProtocol.framing.maxOpaqueStreamChunkBytes;
    const durableIdentitiesCompatible = runtimeIdPattern
      .test(message?.viewModel?.runtime?.runtimeId ?? "")
      && hostIdPattern.test(message?.viewModel?.host?.hostId ?? "");
    const hostConnectionCompatible = ["connected", "disconnected"].includes(
      message?.viewModel?.host?.status,
    ) && ["current", "stale"].includes(message?.viewModel?.host?.freshness)
      && (message.viewModel.host.status === "connected"
        ? message.viewModel.host.failure === null
        : message.viewModel.host.failure?.code === "host_disconnected"
          || message.viewModel.host.failure?.code === "host_protocol_invalid"
          || message.viewModel.host.failure?.code
            === "host_observation_resynchronization_failed");
    const projectPreparationCompatible =
      message?.viewModel?.projectPreparation?.kind === "cockpit.project-preparation"
      && message.viewModel.projectPreparation.selection?.mode === "explicit-host-path"
      && message.viewModel.projectPreparation.selection?.directoryScanning === false
      && message.viewModel.projectPreparation.defaultHarnessAdapterId
        === "sandcastle-harness-adapter-v1"
      && message.viewModel.projectPreparation.productionHarness?.permittedTestDouble === false
      && message.viewModel.projectPreparation.conformanceHarness?.permittedTestDouble === true;
    const controllerProvidersCompatible =
      Array.isArray(message?.viewModel?.controllerProviders)
      && message.viewModel.controllerProviders.length === 2
      && message.viewModel.controllerProviders.some((provider) =>
        provider.providerId === "conformance-controller-v1" && provider.fixture === true)
      && message.viewModel.controllerProviders.some((provider) =>
        provider.providerId === "claude-code"
        && provider.fixture === false
        && ["available", "unavailable", "unauthenticated"].includes(
          provider.availability?.status,
        ));
    const focusedControllerSession = message?.viewModel?.focusedControllerSession;
    const focusedControllerSessionCompatible = focusedControllerSession === null
      || (
        /^controller-session-[a-f0-9]{24}$/.test(focusedControllerSession?.sessionId ?? "")
        && /^controller-terminal-[a-f0-9]{24}$/
          .test(focusedControllerSession?.terminal?.streamId ?? "")
        && /^terminal-attachment-[a-f0-9]{24}$/
          .test(focusedControllerSession?.terminal?.writableAttachment?.attachmentId ?? "")
        && focusedControllerSession?.terminal?.runtimeOwned === true
        && focusedControllerSession?.workContext?.workContextId
          === message?.viewModel?.projectPreparation?.current?.projectId
      );
    const harnessObservation = message?.viewModel?.harnessRunObservation;
    const resynchronizationConsistent = harnessObservation?.mode === "resync-required"
      ? harnessObservation?.code === "resync-required"
        && harnessObservation?.resynchronization?.canonicalSnapshot === true
      : harnessObservation?.code !== "resync-required"
        && harnessObservation?.resynchronization === null;
    const harnessObservationCompatible =
      harnessObservation?.type === "harness.run.observe.result"
      && resynchronizationConsistent;

    if (
      message?.type !== "runtime.hello-ack"
      || message.protocol?.major !== browserProtocol.protocol.major
      || message.identity !== browserProtocol.expectedPeerIdentity
      || message.peerIdentity !== browserProtocol.identity
      || message.schemaDigest !== browserProtocol.schemaDigest
      || !capabilitiesCompatible
      || !framingCompatible
      || !durableIdentitiesCompatible
      || !hostConnectionCompatible
      || !projectPreparationCompatible
      || !controllerProvidersCompatible
      || !focusedControllerSessionCompatible
      || !harnessObservationCompatible
      || message.viewModel?.kind !== "cockpit.connection"
    ) {
      requireReload("browser_runtime_handshake_mismatch");
      return;
    }

    sessionStorage.setItem("sandking.observationCursor", message.observation.cursor);
    state.runtimeNegotiated = true;
    state.hostConnectionStatus = message.viewModel.host.status;
    state.hostFreshness = message.viewModel.host.freshness;
    document.documentElement.dataset.observationMode = message.observation.mode;
    document.documentElement.dataset.protocolVersion = message.protocol.version;
    document.documentElement.dataset.hostConnectionStatus = state.hostConnectionStatus;
    state.currentHarnessRunObservation = message.viewModel.harnessRunObservation;
    app.textContent = "";
    app.append(renderWorkbench(message));
    state.harnessRunSection = document.getElementById("harness-run-observation");
    const pendingLaunch = readPendingHarnessLaunch();
    if (
      pendingLaunch
      && state.hostConnectionStatus === "connected"
      && (
        pendingLaunch.projectId === message.viewModel.projectPreparation.current?.projectId
        || pendingLaunch.projectId === message.viewModel.harnessRunObservation.run?.projectId
      )
    ) {
      state.pendingHarnessLaunchRequestId = `harness-launch-retry-${state.harnessRequestSequence}`;
      state.harnessRequestSequence += 1;
      if (state.harnessLaunchFeedback) {
        state.harnessLaunchFeedback.textContent = "Reconnecting to the retained Harness launch outcome…";
      }
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
          ...(pendingLaunch.reconnectHarnessRunId
            ? { reconnectHarnessRunId: pendingLaunch.reconnectHarnessRunId }
            : {}),
        },
      }));
    }
    const pendingCancellation = readPendingHarnessCancellation();
    if (
      pendingCancellation
      && state.hostConnectionStatus === "connected"
      && pendingCancellation.harnessRunId
        === message.viewModel.harnessRunObservation.run?.harnessRunId
    ) {
      state.pendingHarnessCancellationRequestId =
        `harness-cancel-retry-${state.harnessRequestSequence}`;
      state.harnessRequestSequence += 1;
      const feedback = document.getElementById("harness-run-cancellation-feedback");
      if (feedback) feedback.textContent =
        "Reconnecting to the retained cancellation outcome…";
      socket.send(JSON.stringify({
        channel: "control",
        message: {
          type: "browser.harness-run.cancel",
          requestId: state.pendingHarnessCancellationRequestId,
          ...pendingCancellation,
        },
      }));
    }
    const pendingRecovery = readPendingHarnessRecovery();
    if (
      pendingRecovery
      && state.hostConnectionStatus === "connected"
      && pendingRecovery.harnessRunId
        === message.viewModel.harnessRunObservation.run?.harnessRunId
    ) {
      state.pendingHarnessRecoveryRequestId =
        `harness-recover-retry-${state.harnessRequestSequence}`;
      state.harnessRequestSequence += 1;
      const feedback = document.getElementById("harness-run-recovery-feedback");
      if (feedback) feedback.textContent =
        "Reconnecting to the retained recovery outcome…";
      socket.send(JSON.stringify({
        channel: "control",
        message: {
          type: "browser.harness-run.recover",
          requestId: state.pendingHarnessRecoveryRequestId,
          ...pendingRecovery,
        },
      }));
    }
    requestHarnessRunObservation();
  });

  socket.addEventListener("close", (event) => {
    clearTimeout(state.harnessObservationTimer);
    disposeAllTerminalSurfaces();
    if (!document.documentElement.dataset.protocolError && !event.wasClean) {
      app.textContent = "Controller runtime connection is stale. Retry by reloading the Cockpit.";
    }
  });

  return { requireReload };
};
