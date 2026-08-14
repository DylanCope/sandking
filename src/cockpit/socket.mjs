import {
  hostIdPattern,
  projectIdPattern,
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

export const readPendingHarnessLaunch = (state) => {
  try {
    const launch = JSON.parse(sessionStorage.getItem(state.storageKeys.pendingHarnessLaunch) ?? "null");
    if (
      !projectIdPattern.test(launch?.projectId ?? "")
      || !/^sha256:[a-f0-9]{64}$/.test(launch?.idempotencyKeyHash ?? "")
      || !launch.parameters
      || typeof launch.parameters !== "object"
      || Array.isArray(launch.parameters)
      || (launch.reconnectHarnessRunId !== undefined
        && !/^harness-run-[a-f0-9]{24}$/.test(launch.reconnectHarnessRunId))
    ) {
      sessionStorage.removeItem(state.storageKeys.pendingHarnessLaunch);
      return null;
    }
    return launch;
  } catch {
    sessionStorage.removeItem(state.storageKeys.pendingHarnessLaunch);
    return null;
  }
};

export const retainedHarnessRunCursor = (state) => {
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

export const readPendingHarnessRunSelection = (state) => {
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

export const retainPendingHarnessRunSelection = (state, harnessRunId) => {
  sessionStorage.setItem(state.storageKeys.pendingHarnessRunSelection, harnessRunId);
  sessionStorage.setItem(state.storageKeys.harnessRunCursor, JSON.stringify({
    harnessRunId,
    sequence: 0,
  }));
};

export const readPendingHarnessCancellation = (state) => {
  try {
    const cancellation = JSON.parse(
      sessionStorage.getItem(state.storageKeys.pendingHarnessCancellation) ?? "null",
    );
    if (!/^harness-run-[a-f0-9]{24}$/.test(cancellation?.harnessRunId ?? "")
      || !/^sha256:[a-f0-9]{64}$/.test(cancellation?.idempotencyKeyHash ?? "")) {
      sessionStorage.removeItem(state.storageKeys.pendingHarnessCancellation);
      return null;
    }
    return cancellation;
  } catch {
    sessionStorage.removeItem(state.storageKeys.pendingHarnessCancellation);
    return null;
  }
};

export const readPendingHarnessRecovery = (state) => {
  try {
    const recovery = JSON.parse(
      sessionStorage.getItem(state.storageKeys.pendingHarnessRecovery) ?? "null",
    );
    if (!/^harness-run-[a-f0-9]{24}$/.test(recovery?.harnessRunId ?? "")
      || !["recheck", "terminate_confirmed_tree", "finalize"].includes(recovery?.action)
      || !/^sha256:[a-f0-9]{64}$/.test(recovery?.idempotencyKeyHash ?? "")) {
      sessionStorage.removeItem(state.storageKeys.pendingHarnessRecovery);
      return null;
    }
    return recovery;
  } catch {
    sessionStorage.removeItem(state.storageKeys.pendingHarnessRecovery);
    return null;
  }
};

export const sendPendingHarnessLaunch = (state, socket, pendingLaunch, requestLabel = null) => {
  retainPendingHarnessLaunch(state, pendingLaunch);
  state.pendingHarnessLaunchRequestId =
    `harness-launch${requestLabel ? `-${requestLabel}` : ""}-${state.harnessRequestSequence}`;
  state.harnessRequestSequence += 1;
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
    applyOpaqueFrame,
    applyTerminalAttached,
    applyTerminalResized,
    decodeOpaqueFrame,
    disposeAllTerminalSurfaces,
  } = terminalSurface;
  const {
    applyHarnessLaunchResult,
    applyHostConnectionState: applyProjectHostConnectionState,
    setHarnessLaunchFeedback,
  } = projectPreparation;
  const {
    applyDiagnosticFrame,
    applyHarnessRunObservation,
    applyHostConnectionState: applyHarnessHostConnectionState,
    beginDiagnosticStream,
    enableCancellation,
    enableRecovery,
    requestHarnessRunObservation,
    setCancellationFeedback,
    setRecoveryFeedback,
    stopObservation,
  } = harnessRunObservation;
  const {
    applyHostConnectionState: applyChromeHostConnectionState,
    renderWorkbench,
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
      if (opaque) {
        applyOpaqueFrame(opaque) || applyDiagnosticFrame(opaque);
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
      applyChromeHostConnectionState(message);
      applyProjectHostConnectionState(message);
      applyHarnessHostConnectionState(message);
      return;
    }

    if (message?.type === "runtime.terminal-attached") {
      if (!applyTerminalAttached(message)) {
        requireReload("runtime_terminal_attachment_mismatch");
      }
      return;
    }

    if (message?.type === "runtime.terminal-resized") {
      if (!applyTerminalResized(message)) {
        requireReload("runtime_terminal_resize_mismatch");
      }
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
        || message.requestId !== state.pendingHarnessLaunchRequestId
      ) {
        requireReload("runtime_harness_launch_result_mismatch");
        return;
      }
      if (message.outcome.type === "harness.run.launch.result") {
        // Transfer the durable mutation outcome to equally durable observation
        // selection before clearing the launch retry record. A reload in this
        // interval must resume the acknowledged run, never the prior cursor.
        retainPendingHarnessRunSelection(state, message.outcome.run.harnessRunId);
      }
      if (!applyHarnessLaunchResult(message)) {
        requireReload("runtime_harness_launch_result_mismatch");
        return;
      }
      if (message.outcome.type === "harness.run.launch.result") {
        requestHarnessRunObservation(message.outcome.run.harnessRunId);
      }
      return;
    }

    if (message?.type === "runtime.harness-run.cancel-result") {
      const pendingCancellation = readPendingHarnessCancellation(state);
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
        setCancellationFeedback(
          "Cancellation accepted; termination remains asynchronously observable.",
        );
        requestHarnessRunObservation();
      } else {
        setCancellationFeedback(`Cancellation was not accepted: ${message.outcome.code}.`);
        enableCancellation();
      }
      return;
    }

    if (message?.type === "runtime.harness-run.recover-result") {
      const pendingRecovery = readPendingHarnessRecovery(state);
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
        setRecoveryFeedback(message.outcome.action === "finalize"
          ? "The interrupted run was finalized from confirmed termination evidence."
          : "Recovery evidence was updated; refreshing the retained run.");
        requestHarnessRunObservation(pendingRecovery.harnessRunId);
      } else {
        setRecoveryFeedback(`Recovery was not changed: ${message.outcome.code}.`);
        enableRecovery();
      }
      return;
    }

    if (message?.type === "runtime.harness-run.logs.result") {
      if (!beginDiagnosticStream(message)) {
        requireReload("runtime_harness_log_stream_mismatch");
      }
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
    const pendingLaunch = readPendingHarnessLaunch(state);
    if (
      pendingLaunch
      && state.hostConnectionStatus === "connected"
      && (
        pendingLaunch.projectId === message.viewModel.projectPreparation.current?.projectId
        || pendingLaunch.projectId === message.viewModel.harnessRunObservation.run?.projectId
      )
    ) {
      sendPendingHarnessLaunch(state, socket, pendingLaunch, "retry");
      setHarnessLaunchFeedback("Reconnecting to the retained Harness launch outcome…");
    }
    const pendingCancellation = readPendingHarnessCancellation(state);
    if (
      pendingCancellation
      && state.hostConnectionStatus === "connected"
      && pendingCancellation.harnessRunId
        === message.viewModel.harnessRunObservation.run?.harnessRunId
    ) {
      state.pendingHarnessCancellationRequestId =
        `harness-cancel-retry-${state.harnessRequestSequence}`;
      state.harnessRequestSequence += 1;
      setCancellationFeedback("Reconnecting to the retained cancellation outcome…");
      socket.send(JSON.stringify({
        channel: "control",
        message: {
          type: "browser.harness-run.cancel",
          requestId: state.pendingHarnessCancellationRequestId,
          ...pendingCancellation,
        },
      }));
    }
    const pendingRecovery = readPendingHarnessRecovery(state);
    if (
      pendingRecovery
      && state.hostConnectionStatus === "connected"
      && pendingRecovery.harnessRunId
        === message.viewModel.harnessRunObservation.run?.harnessRunId
    ) {
      state.pendingHarnessRecoveryRequestId =
        `harness-recover-retry-${state.harnessRequestSequence}`;
      state.harnessRequestSequence += 1;
      setRecoveryFeedback("Reconnecting to the retained recovery outcome…");
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
    stopObservation();
    disposeAllTerminalSurfaces();
    if (!document.documentElement.dataset.protocolError && !event.wasClean) {
      app.textContent = "Controller runtime connection is stale. Retry by reloading the Cockpit.";
    }
  });

  return { requireReload };
};
