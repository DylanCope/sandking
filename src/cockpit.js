const browserProtocol = Object.freeze({
  protocol: { major: 1, minor: 0, patch: 0, version: "1.0.0" },
  release: "0.1.0",
  identity: "cockpit",
  expectedPeerIdentity: "controller-runtime",
  capabilities: {
    required: [
      "cockpit.structured-control.v1",
      "cockpit.opaque-stream.v1",
      "cockpit.resynchronization.v1",
    ],
    optional: [],
  },
  schemaDigest: "sha256:adbdc80471c8b7d79d1a4d04ace4ed935e31cc7ed07f5e1b7b4ab53b8a98b0b7",
  framing: {
    maxControlMessageBytes: 32_768,
    maxOpaqueStreamChunkBytes: 16_384,
  },
});

const app = document.getElementById("app");
const reload = document.getElementById("reload-cockpit");
const websocketProtocol = location.protocol === "https:" ? "wss" : "ws";
const socket = new WebSocket(`${websocketProtocol}://${location.host}/ws`);
socket.binaryType = "arraybuffer";

const requireReload = (code) => {
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

  if (
    message?.type !== "runtime.hello-ack"
    || message.protocol?.major !== browserProtocol.protocol.major
    || message.identity !== browserProtocol.expectedPeerIdentity
    || message.peerIdentity !== browserProtocol.identity
    || message.schemaDigest !== browserProtocol.schemaDigest
    || !capabilitiesCompatible
    || !framingCompatible
    || message.viewModel?.kind !== "cockpit.connection"
  ) {
    requireReload("browser_runtime_handshake_mismatch");
    return;
  }

  sessionStorage.setItem("sandking.observationCursor", message.observation.cursor);
  document.documentElement.dataset.observationMode = message.observation.mode;
  document.documentElement.dataset.protocolVersion = message.protocol.version;
  app.textContent =
    `Connected to ${message.viewModel.host.identity} with protocol ${message.protocol.version}`;
});

socket.addEventListener("close", (event) => {
  if (!document.documentElement.dataset.protocolError && !event.wasClean) {
    app.textContent = "Host connection is stale. Retry by reloading the Cockpit.";
  }
});
