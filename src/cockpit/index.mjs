import { createCockpitChrome } from "/cockpit/chrome.mjs";
import { createHarnessRunObservation } from "/cockpit/harness-run.mjs";
import { createProjectPreparation } from "/cockpit/project-preparation.mjs";
import {
  createCockpitSocket,
  createCockpitSocketConnection,
} from "/cockpit/socket.mjs";
import { createTerminalSurface } from "/cockpit/terminal.mjs";

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
      "cockpit.controller-terminal.v1",
      "cockpit.controller-terminal-resize.v1",
      "cockpit.project-preparation.v1",
      "cockpit.project-registration-resolution.v1",
      "cockpit.harness-run-launch.v2",
      "cockpit.harness-run-observation.v2",
      "cockpit.harness-run-reconciliation.v1",
      "cockpit.harness-run-cancellation.v1",
      "cockpit.harness-run-recovery.v1",
    ],
    optional: [],
  },
  schemaDigest: "sha256:61c6a0fe586a23f10c27f47d7e1d607bf385b96fa740dc8f204c26a332d8876a",
  framing: {
    maxControlMessageBytes: 32_768,
    maxOpaqueStreamChunkBytes: 16_384,
  },
});

const app = document.getElementById("app");
const reload = document.getElementById("reload-cockpit");
const socket = createCockpitSocketConnection();

const state = {
  terminalStreams: new Map(),
  diagnosticStreams: new Map(),
  runtimeNegotiated: false,
  harnessRunSection: null,
  harnessObservationTimer: undefined,
  harnessRequestSequence: 0,
  currentHarnessRunObservation: null,
  harnessLaunchFeedback: null,
  pendingHarnessLaunchRequestId: null,
  pendingHarnessCancellationRequestId: null,
  pendingHarnessRecoveryRequestId: null,
  hostConnectionStatus: "connecting",
  hostFreshness: "stale",
  chrome: {
    currentProject: null,
    focusedControllerSession: null,
    harnessRunObservation: null,
    terminalAttachment: { sessionId: null, mode: "none" },
  },
  storageKeys: Object.freeze({
    harnessRunCursor: "sandking.harnessRunCursor",
    pendingHarnessRunSelection: "sandking.pendingHarnessRunSelection",
    launchConfirmation: "sandking.skipLaunchConfirmation",
    pendingHarnessLaunch: "sandking.pendingHarnessLaunch",
    pendingHarnessCancellation: "sandking.pendingHarnessCancellation",
    pendingHarnessRecovery: "sandking.pendingHarnessRecovery",
  }),
};

const projectPreparation = createProjectPreparation({
  state,
  socket,
  attachTerminalSurface: (parameters) =>
    terminalSurface.attachTerminalSurface(parameters),
  updateWorkbenchChrome: (patch) => chrome.updateWorkbenchChrome(patch),
});
const harnessRunObservation = createHarnessRunObservation({
  state,
  socket,
  updateWorkbenchChrome: (patch) => chrome.updateWorkbenchChrome(patch),
});
const chrome = createCockpitChrome({
  state,
  renderHarnessRun: harnessRunObservation.renderHarnessRun,
  renderProjectPreparation: projectPreparation.renderProjectPreparation,
});
const terminalSurface = createTerminalSurface({
  state,
  socket,
  requireReload: (code) => cockpitSocket.requireReload(code),
});
const cockpitSocket = createCockpitSocket({
  state,
  socket,
  browserProtocol,
  app,
  reload,
  terminalSurface,
  projectPreparation,
  harnessRunObservation,
  chrome,
});
