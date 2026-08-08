import { FitAddon } from "/terminal/addon-fit.mjs";
import { Terminal } from "/terminal/xterm.mjs";
import {
  readHarnessLaunchParameters,
  renderHarnessLaunchParameterFields,
} from "/cockpit-launch-parameters.mjs";

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
      "cockpit.planning-spine.v1",
      "cockpit.controller-terminal.v1",
      "cockpit.controller-terminal-resize.v1",
      "cockpit.project-preparation.v1",
      "cockpit.harness-run-launch.v2",
      "cockpit.harness-run-observation.v2",
      "cockpit.harness-run-cancellation.v1",
    ],
    optional: [],
  },
  schemaDigest: "sha256:c45f5e50c1b13b445e41e4de7e4d1cc9664a8651feae11de8b6cf079fc168275",
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
const terminalStreams = new Map();
const diagnosticStreams = new Map();
let runtimeNegotiated = false;
let harnessRunSection;
let harnessObservationTimer;
let harnessRequestSequence = 0;
let currentHarnessRunObservation = null;
let harnessLaunchFeedback;
let pendingHarnessLaunchRequestId = null;
let pendingHarnessCancellationRequestId = null;
let hostConnectionStatus = "connecting";
let hostFreshness = "stale";
const harnessRunCursorStorageKey = "sandking.harnessRunCursor";
const pendingHarnessRunSelectionStorageKey = "sandking.pendingHarnessRunSelection";
const launchConfirmationStorageKey = "sandking.skipLaunchConfirmation";
const pendingHarnessLaunchStorageKey = "sandking.pendingHarnessLaunch";
const pendingHarnessCancellationStorageKey = "sandking.pendingHarnessCancellation";

const launchConfirmationSuppressed = () => {
  try {
    return localStorage.getItem(launchConfirmationStorageKey) === "true";
  } catch {
    return false;
  }
};

const suppressLaunchConfirmation = () => {
  try {
    localStorage.setItem(launchConfirmationStorageKey, "true");
  } catch {
    // Storage can be unavailable in privacy-restricted contexts. Launch still proceeds.
  }
};

const selectedProjectLaunchReady = () =>
  document.getElementById("project-readiness")?.dataset.harnessLaunchReady === "true";

const retainedHarnessRunCursor = () => {
  try {
    const cursor = JSON.parse(sessionStorage.getItem(harnessRunCursorStorageKey) ?? "null");
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
    const harnessRunId = sessionStorage.getItem(pendingHarnessRunSelectionStorageKey);
    if (!/^harness-run-[a-f0-9]{24}$/.test(harnessRunId ?? "")) {
      sessionStorage.removeItem(pendingHarnessRunSelectionStorageKey);
      return null;
    }
    return harnessRunId;
  } catch {
    sessionStorage.removeItem(pendingHarnessRunSelectionStorageKey);
    return null;
  }
};

const retainPendingHarnessRunSelection = (harnessRunId) => {
  sessionStorage.setItem(pendingHarnessRunSelectionStorageKey, harnessRunId);
  sessionStorage.setItem(harnessRunCursorStorageKey, JSON.stringify({
    harnessRunId,
    sequence: 0,
  }));
};

const encodeOpaqueFrame = (streamId, sequence, data) => {
  const id = new TextEncoder().encode(streamId);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const frame = new Uint8Array(6 + id.byteLength + bytes.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, id.byteLength);
  view.setUint32(1, sequence);
  view.setUint8(5, 0);
  frame.set(id, 6);
  frame.set(bytes, 6 + id.byteLength);
  return frame;
};

const decodeOpaqueFrame = (value) => {
  const frame = new Uint8Array(value);
  if (frame.byteLength < 6) {
    return null;
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const idLength = view.getUint8(0);
  const dataOffset = 6 + idLength;
  if (dataOffset > frame.byteLength) {
    return null;
  }
  return {
    streamId: new TextDecoder().decode(frame.subarray(6, dataOffset)),
    sequence: view.getUint32(1),
    eof: Boolean(view.getUint8(5) & 1),
    data: frame.subarray(dataOffset),
  };
};

const element = (name, attributes = {}, text = "") => {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "hidden") {
      node.hidden = Boolean(value);
    } else if (key === "disabled") {
      node.disabled = Boolean(value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  node.textContent = text;
  return node;
};

const scheduleTerminalFit = (terminal) => {
  clearTimeout(terminal.fitTimer);
  terminal.fitTimer = setTimeout(() => {
    if (terminal.disposed || !terminal.output.isConnected) {
      return;
    }
    terminal.fitAddon.fit();
    const columns = terminal.emulator.cols;
    const rows = terminal.emulator.rows;
    terminal.dimensions.textContent = `${columns} × ${rows}`;
    if (
      socket.readyState !== WebSocket.OPEN
      || terminal.panel.dataset.terminalAttachment !== "read-write"
      || columns < 20
      || columns > 500
      || rows < 5
      || rows > 200
      || (terminal.lastRequestedDimensions?.columns === columns
        && terminal.lastRequestedDimensions?.rows === rows)
    ) {
      return;
    }
    const sequence = terminal.resizeSequence;
    terminal.resizeSequence += 1;
    terminal.lastRequestedDimensions = { columns, rows, sequence };
    socket.send(JSON.stringify({
      channel: "control",
      message: {
        type: "browser.terminal.resize",
        sessionId: terminal.sessionId,
        streamId: terminal.streamId,
        attachmentId: terminal.attachmentId,
        sequence,
        columns,
        rows,
      },
    }));
  }, 80);
};

const disposeTerminalSurface = (terminal) => {
  if (terminal.disposed) {
    return;
  }
  terminal.disposed = true;
  clearTimeout(terminal.fitTimer);
  terminal.resizeObserver?.disconnect();
  if (terminal.visualViewportResizeHandler) {
    globalThis.visualViewport?.removeEventListener(
      "resize",
      terminal.visualViewportResizeHandler,
    );
  }
  for (const disposable of terminal.disposables) {
    disposable.dispose();
  }
  terminal.emulator.dispose();
  if (terminalStreams.get(terminal.streamId) === terminal) {
    terminalStreams.delete(terminal.streamId);
  }
};

const disposeAllTerminalSurfaces = () => {
  for (const terminal of [...terminalStreams.values()]) {
    disposeTerminalSurface(terminal);
  }
};

const sendTerminalData = (terminal, data) => {
  if (
    socket.readyState !== WebSocket.OPEN
    || terminal.panel.dataset.terminalAttachment !== "read-write"
  ) {
    return false;
  }
  socket.send(encodeOpaqueFrame(
    terminal.streamId,
    terminal.inputSequence,
    new TextEncoder().encode(data),
  ));
  terminal.inputSequence += 1;
  return true;
};

const mobileTerminalKeys = Object.freeze([
  { key: "escape", label: "Send Escape", text: "Esc" },
  { key: "arrow-up", label: "Send Arrow Up", text: "↑" },
  { key: "arrow-down", label: "Send Arrow Down", text: "↓" },
  { key: "arrow-left", label: "Send Arrow Left", text: "←" },
  { key: "arrow-right", label: "Send Arrow Right", text: "→" },
  { key: "backspace", label: "Send Backspace", text: "⌫" },
  { key: "enter", label: "Send Enter", text: "Enter" },
]);

const mobileTerminalKeyData = (key, emulator) => {
  const applicationCursor = emulator.modes.applicationCursorKeysMode;
  return {
    escape: "\u001b",
    "arrow-up": applicationCursor ? "\u001bOA" : "\u001b[A",
    "arrow-down": applicationCursor ? "\u001bOB" : "\u001b[B",
    "arrow-left": applicationCursor ? "\u001bOD" : "\u001b[D",
    "arrow-right": applicationCursor ? "\u001bOC" : "\u001b[C",
    backspace: "\u007f",
    enter: "\r",
  }[key];
};

const attachTerminalSurface = ({
  focused,
  panel,
  outputId,
  accessibleLabel,
  requestedMode,
  description,
}) => {
  for (const terminal of [...terminalStreams.values()]) {
    if (terminal.panel === panel || terminal.streamId === focused.terminal.streamId) {
      disposeTerminalSurface(terminal);
    }
  }
  const terminalOutput = element("div", {
    id: outputId,
    class: "controller-terminal__output",
    "data-terminal-output": focused.terminal.streamId,
    role: "application",
    "aria-label": accessibleLabel,
  });
  const attachmentStatus = element("span", {
    class: "controller-terminal__attachment",
    role: "status",
  }, "Attaching…");
  const dimensions = element("span", {
    class: "controller-terminal__dimensions",
    "aria-label": "Terminal dimensions",
  }, "80 × 24");
  const terminalChrome = element("section", {
    class: "controller-terminal",
    "aria-label": `${accessibleLabel} surface`,
  });
  const header = element("header", { class: "controller-terminal__header" });
  header.append(
    element("strong", {}, focused.provider.providerId === "claude-code"
      ? "Claude Code Controller"
      : "Conformance Controller"),
    dimensions,
    attachmentStatus,
  );
  const footer = element("footer", { class: "controller-terminal__footer" });
  footer.append(
    element("span", {}, "Provider PTY · browser attached"),
    element("span", {}, "Terminal output is opaque product data"),
  );
  terminalChrome.append(header, terminalOutput, footer);
  panel.replaceChildren(...description, terminalChrome);

  const emulator = new Terminal({
    cols: 80,
    rows: 24,
    cursorBlink: true,
    cursorStyle: "block",
    disableStdin: true,
    screenReaderMode: true,
    scrollback: 1_000,
    fontFamily: '"Fira Code", monospace',
    fontSize: 13,
    fontWeight: "400",
    fontWeightBold: "600",
    lineHeight: 1.2,
    minimumContrastRatio: 1,
    theme: {
      background: "#05070c",
      foreground: "#d4d4d8",
      cursor: "#c084fc",
      cursorAccent: "#05070c",
      selectionBackground: "#6b21a866",
      black: "#18181b",
      red: "#fb7185",
      green: "#34d399",
      yellow: "#fbbf24",
      blue: "#60a5fa",
      magenta: "#c084fc",
      cyan: "#67e8f9",
      white: "#f4f4f5",
      brightBlack: "#71717a",
      brightRed: "#fda4af",
      brightGreen: "#6ee7b7",
      brightYellow: "#fde047",
      brightBlue: "#93c5fd",
      brightMagenta: "#d8b4fe",
      brightCyan: "#a5f3fc",
      brightWhite: "#ffffff",
    },
  });
  const fitAddon = new FitAddon();
  emulator.loadAddon(fitAddon);
  const terminalState = {
    sessionId: focused.sessionId,
    streamId: focused.terminal.streamId,
    attachmentId: focused.terminal.writableAttachment.attachmentId,
    inputSequence: 0,
    resizeSequence: 0,
    outputSequence: 0,
    requestedMode,
    emulator,
    fitAddon,
    output: terminalOutput,
    panel,
    attachmentStatus,
    dimensions,
    fitTimer: undefined,
    lastRequestedDimensions: null,
    lastEmulatorData: null,
    disposables: [],
    visualViewportResizeHandler: undefined,
    disposed: false,
  };
  const mobileKeys = element("div", {
    class: "controller-terminal__mobile-keys",
    role: "toolbar",
    "aria-label": "Terminal keys",
  });
  for (const key of mobileTerminalKeys) {
    const control = element("button", {
      type: "button",
      "data-terminal-key": key.key,
      "aria-label": key.label,
    }, key.text);
    const activate = () => {
      sendTerminalData(terminalState, mobileTerminalKeyData(key.key, emulator));
      emulator.focus();
    };
    control.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0) {
        return;
      }
      event.preventDefault();
      activate();
    });
    control.addEventListener("click", (event) => {
      if (event.detail !== 0) {
        return;
      }
      activate();
    });
    mobileKeys.append(control);
  }
  footer.before(mobileKeys);
  terminalStreams.set(focused.terminal.streamId, terminalState);
  queueMicrotask(() => {
    const openTerminal = async () => {
      if (terminalState.disposed) {
        return;
      }
      if (!terminalOutput.isConnected) {
        requireReload("runtime_terminal_container_unavailable");
        return;
      }
      await document.fonts?.load?.('13px "Fira Code"');
      await document.fonts?.ready;
      if (terminalState.disposed || !terminalOutput.isConnected) {
        return;
      }
      emulator.open(terminalOutput);
      const textarea = emulator.textarea;
      textarea?.setAttribute("inputmode", "text");
      textarea?.setAttribute("enterkeyhint", "send");
      textarea?.setAttribute("autocapitalize", "off");
      textarea?.setAttribute("autocomplete", "off");
      if (textarea) {
        textarea.spellcheck = false;
      }
      terminalOutput.addEventListener("click", () => emulator.focus());
      const updateTerminalScrollState = (position = emulator.buffer.active.viewportY) => {
        terminalOutput.dataset.terminalScrollLine = String(position);
        terminalOutput.dataset.terminalScrollbackLines = String(emulator.buffer.active.baseY);
      };
      terminalState.disposables.push(
        emulator.onScroll(updateTerminalScrollState),
        emulator.onWriteParsed(() => updateTerminalScrollState()),
      );
      updateTerminalScrollState();
      let terminalTouch;
      terminalOutput.addEventListener("touchstart", (event) => {
        if (event.touches.length !== 1) {
          terminalTouch = undefined;
          return;
        }
        const touch = event.touches[0];
        terminalTouch = {
          identifier: touch.identifier,
          lastY: touch.clientY,
          pendingPixels: 0,
        };
      }, { passive: true });
      terminalOutput.addEventListener("touchmove", (event) => {
        if (!terminalTouch) {
          return;
        }
        const touch = Array.from(event.touches).find((candidate) =>
          candidate.identifier === terminalTouch.identifier);
        if (!touch) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        terminalTouch.pendingPixels += touch.clientY - terminalTouch.lastY;
        terminalTouch.lastY = touch.clientY;
        const screenHeight = emulator.element?.querySelector(".xterm-screen")
          ?.getBoundingClientRect().height ?? 0;
        const cellHeight = screenHeight > 0 ? screenHeight / emulator.rows : 16;
        const lines = Math.trunc(terminalTouch.pendingPixels / Math.max(8, cellHeight));
        if (lines !== 0) {
          emulator.scrollLines(-lines);
          terminalTouch.pendingPixels -= lines * Math.max(8, cellHeight);
        }
      }, { passive: false });
      const endTerminalTouch = () => {
        terminalTouch = undefined;
      };
      terminalOutput.addEventListener("touchend", endTerminalTouch);
      terminalOutput.addEventListener("touchcancel", endTerminalTouch);
      terminalState.disposables.push(emulator.onData((data) => {
        terminalState.lastEmulatorData = { data, observedAt: performance.now() };
        sendTerminalData(terminalState, data);
      }));
      textarea?.addEventListener("beforeinput", (event) => {
        if (
          navigator.maxTouchPoints < 1
          || event.inputType !== "insertText"
          || typeof event.data !== "string"
          || event.data.length === 0
          || event.isComposing
        ) {
          return;
        }
        event.preventDefault();
        const alreadyEmitted = terminalState.lastEmulatorData?.data === event.data
          && performance.now() - terminalState.lastEmulatorData.observedAt < 50;
        if (!alreadyEmitted) {
          sendTerminalData(terminalState, event.data);
        }
        textarea.value = "";
      });
      terminalState.resizeObserver = new ResizeObserver(() =>
        scheduleTerminalFit(terminalState));
      terminalState.resizeObserver.observe(terminalOutput);
      terminalState.visualViewportResizeHandler = () =>
        scheduleTerminalFit(terminalState);
      globalThis.visualViewport?.addEventListener(
        "resize",
        terminalState.visualViewportResizeHandler,
      );
      socket.send(JSON.stringify({
        channel: "control",
        message: {
          type: "browser.terminal.attach",
          sessionId: focused.sessionId,
          streamId: focused.terminal.streamId,
          attachmentId: focused.terminal.writableAttachment.attachmentId,
          mode: requestedMode,
          outputCursor: 0,
        },
      }));
    };
    openTerminal().catch(() =>
      requireReload("runtime_terminal_surface_initialization_failed"));
  });
  return terminalState;
};

const mutationKey = () => globalThis.crypto?.randomUUID?.()
  ?? `planning-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const harnessLaunchRetryHash = () => {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `sha256:${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
};

const retainPendingHarnessLaunch = (launch) => {
  sessionStorage.setItem(pendingHarnessLaunchStorageKey, JSON.stringify(launch));
};

const readPendingHarnessLaunch = () => {
  try {
    const launch = JSON.parse(sessionStorage.getItem(pendingHarnessLaunchStorageKey) ?? "null");
    if (
      !/^project-[a-f0-9]{24}$/.test(launch?.projectId ?? "")
      || !/^sha256:[a-f0-9]{64}$/.test(launch?.idempotencyKeyHash ?? "")
      || !launch.parameters
      || typeof launch.parameters !== "object"
      || Array.isArray(launch.parameters)
    ) {
      sessionStorage.removeItem(pendingHarnessLaunchStorageKey);
      return null;
    }
    return launch;
  } catch {
    sessionStorage.removeItem(pendingHarnessLaunchStorageKey);
    return null;
  }
};

const readPendingHarnessCancellation = () => {
  try {
    const cancellation = JSON.parse(
      sessionStorage.getItem(pendingHarnessCancellationStorageKey) ?? "null",
    );
    if (
      !/^harness-run-[a-f0-9]{24}$/.test(cancellation?.harnessRunId ?? "")
      || !/^sha256:[a-f0-9]{64}$/.test(cancellation?.idempotencyKeyHash ?? "")
    ) {
      sessionStorage.removeItem(pendingHarnessCancellationStorageKey);
      return null;
    }
    return cancellation;
  } catch {
    sessionStorage.removeItem(pendingHarnessCancellationStorageKey);
    return null;
  }
};

const submitPlanningMutation = async (path, body, expectedRevision, csrfToken) => {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sandking-csrf": csrfToken,
      "x-sandking-idempotency-key": mutationKey(),
      "x-sandking-expected-revision": String(expectedRevision),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

const renderPreparedProject = (current) => {
  if (!current) {
    return element(
      "p",
      { id: "project-not-selected", "data-project-selected": "false" },
      "No Project path has been selected.",
    );
  }
  const card = element("article", {
    id: "project-readiness",
    "data-project-selected": "true",
    "data-project-id": current.projectId,
    "data-project-revision": current.revision,
    "data-harness-id": current.harness?.harnessId ?? "",
    "data-harness-pin": current.harness?.pinnedRevision ?? "",
    "data-checks-readiness": current.readiness.checks,
    "data-configuration-readiness": current.readiness.configuration,
    "data-harness-launch-ready": String(current.canPrepareLaunchRequest),
  });
  card.append(
    element("h3", {}, current.displayName),
    element("p", {}, `Project identity: ${current.projectId} (revision ${current.revision})`),
    element("p", {},
      `Issue workflow: GitHub Issues — ${current.issueWorkflow.readiness}`),
    element("p", {},
      `Checks: ${current.checks.map((check) => `${check.checkId} (${check.readiness})`).join(", ")}`),
    element("p", {}, current.harness
      ? `Harness identity: ${current.harness.harnessId} — ${current.harness.name}`
      : "Harness: missing"),
    element("p", {}, current.harness
      ? `Pinned immutable revision: ${current.harness.pinnedRevision}`
      : "Pinned immutable revision: missing"),
    element("p", { "data-launch-guidance": current.readiness.launchRequest },
      current.canPrepareLaunchRequest
        ? "The pinned Harness is ready to launch."
        : `Harness launch is unavailable: ${current.readiness.diagnostics.join(", ")}`),
  );
  return card;
};

const renderProjectPreparation = (
  preparation,
  session,
  controllerProviders,
  focusedControllerSession,
) => {
  const section = element("section", {
    id: "project-preparation",
    "data-explicit-path-only": "true",
    "data-directory-scanning": String(preparation.selection.directoryScanning),
    "data-host-freshness": hostFreshness,
  });
  section.append(
    element("h2", {}, "Open and prepare a local Project"),
    element("p", {},
      "Choose one explicit Host-native path. Sand-King does not scan other directories."),
    element("p", {},
      "Host-local Project registration requires no separate Sand-King approval."),
  );
  const pathLabel = element("label", { for: "project-path" }, "Project path");
  const pathInput = element("input", {
    id: "project-path",
    name: "projectPath",
    type: "text",
    autocomplete: "off",
    placeholder: "/absolute/path/to/project",
  });
  const typecheckLabel = element(
    "label",
    { for: "project-typecheck-command" },
    "Typecheck command",
  );
  const typecheckInput = element("input", {
    id: "project-typecheck-command",
    type: "text",
    value: "npm run typecheck",
  });
  const testLabel = element("label", { for: "project-test-command" }, "Test command");
  const testInput = element("input", {
    id: "project-test-command",
    type: "text",
    value: "npm run test",
  });
  const openButton = element("button", {
    id: "open-project",
    type: "button",
    "data-action": "open-project",
    "data-host-mutation": "true",
    disabled: hostConnectionStatus !== "connected",
  }, "Open and prepare Project");
  const feedback = element("p", { id: "project-feedback", role: "status" });
  let currentNode = renderPreparedProject(preparation.current);
  let currentProject = preparation.current;
  let expectedRevision = preparation.current?.revision ?? 0;
  const openController = element("button", {
    id: "open-project-controller",
    type: "button",
    "data-action": "open-project-controller",
    "data-host-mutation": "true",
    disabled: hostConnectionStatus !== "connected"
      || !preparation.current?.canPrepareLaunchRequest,
  }, "Open focused Controller for Launch");
  let launchParameterDeclaration = preparation.current?.harness?.launchParameters
    ?? { kind: "none" };
  let launchParameterFields = renderHarnessLaunchParameterFields(
    document,
    launchParameterDeclaration,
  );
  const updateLaunchParameterFields = () => {
    launchParameterDeclaration = currentProject?.harness?.launchParameters
      ?? { kind: "none" };
    const replacement = renderHarnessLaunchParameterFields(
      document,
      launchParameterDeclaration,
    );
    launchParameterFields.replaceWith(replacement);
    launchParameterFields = replacement;
  };
  const launchButton = element("button", {
    id: "launch-harness",
    type: "button",
    "data-action": "launch-harness",
    "data-host-mutation": "true",
    disabled: hostConnectionStatus !== "connected"
      || !preparation.current?.canPrepareLaunchRequest,
  }, "Launch");
  harnessLaunchFeedback = element("p", { id: "harness-launch-feedback", role: "status" });
  const confirmation = element("dialog", {
    id: "harness-launch-confirmation",
    "aria-labelledby": "harness-launch-confirmation-title",
  });
  const confirmationTitle = element(
    "h3",
    { id: "harness-launch-confirmation-title" },
    "You’re about to launch the Harness — continue?",
  );
  const confirmationDetail = element("p", {},
    "This immediately starts delegated Harness work for the selected Project.");
  const skipConfirmation = element("input", {
    id: "harness-launch-confirmation-skip",
    type: "checkbox",
  });
  const skipConfirmationLabel = element(
    "label",
    { for: "harness-launch-confirmation-skip" },
    "Don’t show again",
  );
  const confirmYes = element("button", {
    id: "harness-launch-confirmation-yes",
    type: "button",
    value: "yes",
  }, "Yes");
  const confirmNo = element("button", {
    id: "harness-launch-confirmation-no",
    type: "button",
    value: "no",
  }, "No");
  confirmation.append(
    confirmationTitle,
    confirmationDetail,
    skipConfirmation,
    skipConfirmationLabel,
    element("div", { class: "harness-launch-confirmation__actions" }),
  );
  confirmation.lastElementChild.append(confirmYes, confirmNo);

  const launch = () => {
    if (
      !currentProject
      || currentProject.canPrepareLaunchRequest !== true
      || !selectedProjectLaunchReady()
      || hostConnectionStatus !== "connected"
      || pendingHarnessLaunchRequestId !== null
    ) {
      harnessLaunchFeedback.textContent =
        "Harness was not launched: the selected Project is not launch-ready.";
      updateProjectActionAvailability();
      return false;
    }
    const parsedParameters = readHarnessLaunchParameters(
      launchParameterFields,
      launchParameterDeclaration,
    );
    if (!parsedParameters.ok) {
      harnessLaunchFeedback.textContent =
        `Harness was not launched: ${parsedParameters.error}.`;
      return false;
    }
    pendingHarnessLaunchRequestId = `harness-launch-${harnessRequestSequence}`;
    harnessRequestSequence += 1;
    launchButton.disabled = true;
    harnessLaunchFeedback.textContent = "Launching the Harness run…";
    const pendingLaunch = {
      projectId: currentProject.projectId,
      parameters: parsedParameters.parameters,
      idempotencyKeyHash: harnessLaunchRetryHash(),
    };
    retainPendingHarnessLaunch(pendingLaunch);
    socket.send(JSON.stringify({
      channel: "control",
      message: {
        type: "browser.harness-run.launch",
        requestId: pendingHarnessLaunchRequestId,
        projectId: pendingLaunch.projectId,
        ...(Object.keys(pendingLaunch.parameters).length === 0
          ? {}
          : { parameters: pendingLaunch.parameters }),
        idempotencyKeyHash: pendingLaunch.idempotencyKeyHash,
      },
    }));
    return true;
  };
  launchButton.addEventListener("click", () => {
    if (launchConfirmationSuppressed()) {
      launch();
    } else {
      skipConfirmation.checked = false;
      confirmation.showModal();
    }
  });
  confirmYes.addEventListener("click", () => {
    confirmation.close("yes");
    if (launch() && skipConfirmation.checked) suppressLaunchConfirmation();
  });
  confirmNo.addEventListener("click", () => confirmation.close("no"));
  const claudeProvider = controllerProviders.find((provider) =>
    provider.providerId === "claude-code");
  const claudeAvailable = claudeProvider?.availability.status === "available";
  const openClaudeController = element("button", {
    id: "open-project-claude-controller",
    type: "button",
    "data-action": "open-project-claude-controller",
    "data-host-mutation": "true",
    "data-provider-availability": claudeProvider?.availability.status ?? "unavailable",
    disabled: hostConnectionStatus !== "connected"
      || !preparation.current?.canPrepareLaunchRequest
      || !claudeAvailable,
  }, "Open installed Claude Controller");
  const claudeProviderStatus = element("p", {
    id: "claude-provider-status",
    "data-provider-id": "claude-code",
    "data-availability": claudeProvider?.availability.status ?? "unavailable",
    "data-authentication": claudeProvider?.availability.authentication ?? "unknown",
    "data-failure-code": claudeProvider?.availability.failureCode ?? "",
  }, claudeAvailable
    ? `Claude Code ${claudeProvider.availability.version} is available with destination-local authentication.`
    : `Claude Controller unavailable: ${claudeProvider?.availability.failureCode ?? "provider_cli_unavailable"}.`);
  const controllerFeedback = element("p", {
    id: "project-controller-feedback",
    role: "status",
  });
  const controllerPanel = element("section", {
    id: "project-focused-controller-session",
    "data-session-state": "closed",
    hidden: true,
  });
  const updateProjectActionAvailability = () => {
    const launchReady = currentProject?.canPrepareLaunchRequest === true
      && selectedProjectLaunchReady();
    launchButton.disabled = hostConnectionStatus !== "connected"
      || !launchReady
      || pendingHarnessLaunchRequestId !== null;
    openController.disabled = hostConnectionStatus !== "connected" || !launchReady;
    openClaudeController.disabled = hostConnectionStatus !== "connected"
      || !launchReady
      || !claudeAvailable;
  };

  openButton.addEventListener("click", async () => {
    openButton.disabled = true;
    feedback.textContent = "Opening the selected Project path…";
    const response = await fetch("/projects/open", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sandking-csrf": session.csrfToken,
        "x-sandking-idempotency-key": mutationKey(),
        "x-sandking-expected-revision": String(expectedRevision),
      },
      body: JSON.stringify({
        path: pathInput.value,
        configuration: {
          issueWorkflow: { provider: "github", kind: "issues" },
          checks: [
            { checkId: "typecheck", command: typecheckInput.value },
            { checkId: "test", command: testInput.value },
          ],
        },
      }),
    });
    const outcome = await response.json();
    if (!response.ok) {
      if (outcome.project) {
        expectedRevision = outcome.project.revision;
        currentProject = outcome.project;
        updateLaunchParameterFields();
        const replacement = renderPreparedProject(outcome.project);
        currentNode.replaceWith(replacement);
        currentNode = replacement;
        updateWorkbenchChrome({ currentProject: outcome.project });
      }
      if (
        outcome.code === "mutation_revision_conflict"
        && Number.isSafeInteger(outcome.actualRevision)
      ) {
        expectedRevision = outcome.actualRevision;
      }
      feedback.textContent = outcome.project
        ? `Project ${outcome.project.projectId} was accepted, but preparation stopped: ${
            outcome.code}. Its retained readiness is shown above.`
        : `Project was not changed: ${outcome.code}. ${
            outcome.resolution?.actions?.join(", ") ?? "Review the typed guidance."}`;
      updateProjectActionAvailability();
      openButton.disabled = hostConnectionStatus !== "connected";
      return;
    }
    expectedRevision = outcome.project.revision;
    currentProject = outcome.project;
    updateLaunchParameterFields();
    const replacement = renderPreparedProject(outcome.project);
    currentNode.replaceWith(replacement);
    currentNode = replacement;
    updateWorkbenchChrome({ currentProject: outcome.project });
    feedback.textContent = "Project and conformance Harness are ready to launch.";
    updateProjectActionAvailability();
    openButton.disabled = hostConnectionStatus !== "connected";
  });

  const attachFocusedController = (focused, reconnected) => {
    updateWorkbenchChrome({ focusedControllerSession: focused });
    controllerPanel.hidden = false;
    controllerPanel.dataset.sessionState = "open";
    controllerPanel.dataset.reconnected = String(reconnected);
    controllerPanel.dataset.sessionId = focused.sessionId;
    controllerPanel.dataset.workContextId = focused.workContext.workContextId;
    controllerPanel.dataset.providerId = focused.provider.providerId;
    controllerPanel.dataset.providerAdapterId = focused.provider.adapterId;
    controllerPanel.dataset.providerSessionId = focused.provider.providerSessionId;
    controllerPanel.dataset.providerControlProtocol =
      focused.provider.readiness.controlProtocol;
    controllerPanel.dataset.providerReadySignal = focused.provider.readiness.signal;
    controllerPanel.dataset.providerObservedTty = String(
      focused.provider.readiness.providerObservedTty,
    );
    controllerPanel.dataset.terminalStreamId = focused.terminal.streamId;
    controllerPanel.dataset.terminalAttachmentId =
      focused.terminal.writableAttachment.attachmentId;
    controllerPanel.dataset.ptyRuntimeOwned = String(focused.terminal.runtimeOwned);
    controllerPanel.dataset.terminalAttachment = "attaching";
    attachTerminalSurface({
      focused,
      panel: controllerPanel,
      outputId: "project-controller-terminal-output",
      accessibleLabel: "Project Controller terminal",
      requestedMode: reconnected ? "read-write-if-available" : "read-write",
      description: [
        element("p", {}, `Focused Controller session ${focused.sessionId} can launch the Harness for ${focused.workContext.workContextId} with the ordinary sandking CLI.`),
      ],
    });
    controllerFeedback.textContent = reconnected
      ? "Reconnected to the existing focused Controller and retained terminal output."
      : "Use the focused Controller conversation for project work or launch with sandking.";
  };

  const openFocusedController = async (providerId, sourceButton) => {
    if (!currentProject) {
      return;
    }
    sourceButton.disabled = true;
    controllerFeedback.textContent = "Opening the owning focused Controller session…";
    const response = await fetch("/projects/sessions/open", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sandking-csrf": session.csrfToken,
        "x-sandking-idempotency-key": mutationKey(),
        "x-sandking-expected-revision": String(currentProject.revision),
      },
      body: JSON.stringify({ projectId: currentProject.projectId, providerId }),
    });
    const outcome = await response.json();
    if (!response.ok || outcome.type !== "mutation_result") {
      controllerFeedback.textContent = `Focused Controller failed safely: ${outcome.code}.`;
      sourceButton.disabled = hostConnectionStatus !== "connected"
        || (providerId === "claude-code" ? !claudeAvailable : false);
      return;
    }
    attachFocusedController(outcome.session, false);
  };
  openController.addEventListener("click", () =>
    openFocusedController("conformance-controller-v1", openController));
  openClaudeController.addEventListener("click", () =>
    openFocusedController("claude-code", openClaudeController));
  if (focusedControllerSession) {
    attachFocusedController(focusedControllerSession, true);
  }

  section.append(
    element("h3", {}, "Bounded Project configuration"),
    element("p", {}, "Issue workflow: GitHub Issues"),
    pathLabel,
    pathInput,
    typecheckLabel,
    typecheckInput,
    testLabel,
    testInput,
    openButton,
    feedback,
    currentNode,
    element("h3", {}, "Launch Harness"),
    launchParameterFields,
    launchButton,
    harnessLaunchFeedback,
    confirmation,
    openController,
    openClaudeController,
    claudeProviderStatus,
    controllerFeedback,
    controllerPanel,
    element("p", { "data-project-scope": "registration-only" },
      "This slice does not project a Harness into the Project or provide import, update, rollback, switching, or drift recovery."),
  );
  return section;
};

const requestHarnessRunObservation = (selectedHarnessRunId = null) => {
  if (
    !runtimeNegotiated
    || hostConnectionStatus !== "connected"
    || socket.readyState !== WebSocket.OPEN
  ) {
    return;
  }
  const cursor = retainedHarnessRunCursor();
  const pendingSelection = readPendingHarnessRunSelection();
  const harnessRunId = selectedHarnessRunId
    ?? pendingSelection
    ?? cursor?.harnessRunId
    ?? currentHarnessRunObservation?.run?.harnessRunId
    ?? null;
  socket.send(JSON.stringify({
    channel: "control",
    message: {
      type: "browser.harness-run.observe",
      requestId: `harness-observe-${harnessRequestSequence}`,
      harnessRunId,
      afterSequence: selectedHarnessRunId === null
        && pendingSelection === null
        && harnessRunId === cursor?.harnessRunId
        ? cursor.sequence
        : 0,
    },
  }));
  harnessRequestSequence += 1;
};

const requestHarnessRunCancellation = (run, button, feedback) => {
  if (
    !runtimeNegotiated
    || hostConnectionStatus !== "connected"
    || socket.readyState !== WebSocket.OPEN
    || pendingHarnessCancellationRequestId !== null
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
    pendingHarnessCancellationStorageKey,
    JSON.stringify(pendingCancellation),
  );
  pendingHarnessCancellationRequestId = `harness-cancel-${harnessRequestSequence}`;
  harnessRequestSequence += 1;
  button.disabled = true;
  feedback.textContent = "Requesting cancellation…";
  socket.send(JSON.stringify({
    channel: "control",
    message: {
      type: "browser.harness-run.cancel",
      requestId: pendingHarnessCancellationRequestId,
      ...pendingCancellation,
    },
  }));
};

const renderHarnessRun = (observation) => {
  const section = element("section", {
    id: "harness-run-observation",
    "data-observation-mode": observation.mode,
    "data-run-present": String(Boolean(observation.run)),
    "data-host-freshness": hostFreshness,
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
  const launchAuditId = run.launchAuditId ?? run.startAuditId;
  const launchSource = run.source ?? "legacy-approved-launch";
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
      : `Cancellation accepted. Termination was confirmed at ${run.cancellation.terminationConfirmedAt}.`
    : "");
  if (["starting", "running"].includes(run.status)) {
    const cancelButton = element("button", {
      id: "cancel-harness-run",
      type: "button",
      disabled: hostConnectionStatus !== "connected"
        || pendingHarnessCancellationRequestId !== null,
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
    }, run.status === "cancelling"
      ? "Cancellation accepted; termination remains asynchronously observable."
      : `Cancellation accepted; truthful terminal outcome: ${run.status}.`),
    cancellationFeedback);
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
  const sameRun = currentHarnessRunObservation?.run?.harnessRunId
    === observation.run?.harnessRunId;
  const visibleObservation = observation.mode === "resume" && sameRun
    ? {
        ...observation,
        events: [...new Map([
          ...currentHarnessRunObservation.events,
          ...observation.events,
        ].map((event) => [event.eventId, event])).values()]
          .sort((left, right) => left.sequence - right.sequence),
      }
    : observation;
  currentHarnessRunObservation = visibleObservation;
  updateWorkbenchChrome({ harnessRunObservation: visibleObservation });
  if (visibleObservation.run) {
    if (visibleObservation.run.harnessRunId === pendingSelection) {
      sessionStorage.removeItem(pendingHarnessRunSelectionStorageKey);
    }
    sessionStorage.setItem(harnessRunCursorStorageKey, JSON.stringify({
      harnessRunId: visibleObservation.run.harnessRunId,
      sequence: visibleObservation.nextSequence,
    }));
  } else {
    sessionStorage.removeItem(harnessRunCursorStorageKey);
  }
  const replacement = renderHarnessRun(visibleObservation);
  harnessRunSection?.replaceWith(replacement);
  harnessRunSection = replacement;
  diagnosticStreams.clear();
  if (visibleObservation.run) {
    for (const stream of visibleObservation.logStreams) {
      if (stream.availableEnd === 0) {
        continue;
      }
      socket.send(JSON.stringify({
        channel: "control",
        message: {
          type: "browser.harness-run.logs.get",
          requestId: `harness-logs-${stream.producer}-${harnessRequestSequence}`,
          harnessRunId: visibleObservation.run.harnessRunId,
          producer: stream.producer,
          offset: 0,
          limit: Math.min(16_384, Math.max(1, stream.availableEnd)),
        },
      }));
      harnessRequestSequence += 1;
    }
  }
  clearTimeout(harnessObservationTimer);
  if (
    !visibleObservation.run
    || !["succeeded", "failed", "cancelled"].includes(visibleObservation.run.status)
  ) {
    harnessObservationTimer = setTimeout(requestHarnessRunObservation, 75);
  }
};

const renderPlanning = (planning, session) => {
  const section = element("section", {
    id: "planning-spine",
    "data-planning-ready": "true",
    "data-adapter-fixture": String(planning.adapter.fixture),
    "data-host-impact": "unaffected",
  });
  section.append(
    element("h2", {}, "Planning Journey Rail"),
    element("p", { "data-projection-provenance": planning.adapter.adapterId },
      planning.adapter.label),
  );

  const feedback = element("p", { id: "planning-feedback", role: "status" });
  const sessionPanel = element("section", {
    id: "focused-controller-session",
    "data-session-state": "closed",
    hidden: true,
  });

  for (const journey of planning.journeys) {
    const journeyNode = element("article", {
      "data-journey-id": journey.journeyId,
      "data-freshness": journey.projection.freshness,
      "data-projection-id": journey.projection.projectionId,
      "data-projection-digest": journey.projection.projectionDigest,
      "data-ordinary-work-blocked": String(journey.ordinaryWork.blocked),
    });
    journeyNode.append(element("h3", {}, journey.title));
    if (journey.projection.freshness === "stale") {
      journeyNode.append(element(
        "p",
        { role: "alert", "data-stale-code": journey.projection.refreshFailure?.code ?? "stale" },
        "GitHub canonical projection is visibly stale; mutation is disabled and no write is queued.",
      ));
    }
    journeyNode.append(element(
      "p",
      { "data-ordinary-work-status": journey.ordinaryWork.status },
      "Ordinary work remains available; Planning is optional.",
    ));
    const rail = element("ol", { "data-journey-rail": "built-in" });
    for (const stage of journey.stages) {
      const stageNode = element("li", {
        "data-stage-id": stage.stageId,
        "data-stage-status": stage.status,
        "data-stage-revision": String(stage.revision),
        "data-work-context-id": stage.workContext.workContextId,
      });
      const status = element("span", { "data-stage-status-label": "true" }, stage.status);
      stageNode.append(
        element("strong", {}, stage.label),
        document.createTextNode(" — "),
        status,
        element("p", {}, `Fixture artifact: ${stage.artifact.title}`),
      );
      const mutationEnabled = journey.projection.mutationsEnabled && stage.mutation.enabled;
      const openSession = element("button", {
        type: "button",
        "data-action": "open-session",
        "data-planning-mutation": "true",
        disabled: !mutationEnabled,
      }, "Open focused session");
      openSession.addEventListener("click", async () => {
        openSession.disabled = true;
        const outcome = await submitPlanningMutation(
          "/planning/sessions/open",
          { workContextId: stage.workContext.workContextId },
          0,
          session.csrfToken,
        );
        if (outcome.body.type !== "mutation_result") {
          feedback.textContent = `Focused session failed safely: ${outcome.body.code}`;
          openSession.disabled = !mutationEnabled;
          return;
        }
        sessionPanel.hidden = false;
        sessionPanel.dataset.sessionState = "open";
        sessionPanel.dataset.sessionId = outcome.body.session.sessionId;
        sessionPanel.dataset.workContextId = outcome.body.session.workContext.workContextId;
        sessionPanel.dataset.providerId = outcome.body.session.provider.providerId;
        sessionPanel.dataset.providerAdapterId = outcome.body.session.provider.adapterId;
        sessionPanel.dataset.providerSessionId = outcome.body.session.provider.providerSessionId;
        sessionPanel.dataset.providerControlProtocol =
          outcome.body.session.provider.readiness.controlProtocol;
        sessionPanel.dataset.providerReadySignal =
          outcome.body.session.provider.readiness.signal;
        sessionPanel.dataset.providerObservedTty = String(
          outcome.body.session.provider.readiness.providerObservedTty,
        );
        sessionPanel.dataset.terminalStreamId = outcome.body.session.terminal.streamId;
        sessionPanel.dataset.terminalAttachmentId =
          outcome.body.session.terminal.writableAttachment.attachmentId;
        sessionPanel.dataset.ptyRuntimeOwned = String(
          outcome.body.session.terminal.runtimeOwned,
        );
        sessionPanel.dataset.terminalAttachment = "attaching";
        updateWorkbenchChrome({ focusedControllerSession: outcome.body.session });
        attachTerminalSurface({
          focused: outcome.body.session,
          panel: sessionPanel,
          outputId: "controller-terminal-output",
          accessibleLabel: "Planning Controller terminal",
          requestedMode: "read-write",
          description: [
            element("p", {}, "Focused conformance Controller session opened for "
              + `${outcome.body.session.workContext.workContextId} `
              + `(${outcome.body.session.sessionId}).`),
          ],
        });
        feedback.textContent = "Selected Planning work opened in an independently identified session.";
      });
      const notUsed = element("button", {
        type: "button",
        "data-action": "not-used",
        "data-planning-mutation": "true",
        disabled: !mutationEnabled || !stage.optional,
      }, "Mark Not used");
      notUsed.addEventListener("click", async () => {
        notUsed.disabled = true;
        const outcome = await submitPlanningMutation(
          "/planning/stages/not-used",
          { journeyId: journey.journeyId, stageId: stage.stageId },
          stage.revision,
          session.csrfToken,
        );
        if (outcome.body.type !== "mutation_result") {
          feedback.textContent = `Not used failed safely: ${outcome.body.code}`;
          notUsed.disabled = !mutationEnabled;
          return;
        }
        stage.status = outcome.body.stage.status;
        stage.revision = outcome.body.stage.revision;
        stageNode.dataset.stageStatus = outcome.body.stage.status;
        stageNode.dataset.stageRevision = String(outcome.body.stage.revision);
        status.textContent = outcome.body.stage.status;
        for (const button of stageNode.querySelectorAll("button[data-planning-mutation]")) {
          button.disabled = true;
        }
        journeyNode.dataset.ordinaryWorkBlocked = String(outcome.body.ordinaryWorkBlocked);
        feedback.textContent = "Stage marked Not used. Ordinary work remains available.";
      });
      stageNode.append(openSession, notUsed);
      rail.append(stageNode);
    }
    journeyNode.append(rail);
    section.append(journeyNode);
  }
  section.append(
    sessionPanel,
    feedback,
    element(
      "p",
      { "data-planning-scope": "thin-spine" },
      "This thin Planning spine does not include skill-owned reasoning, private Specifications, "
        + "Ticket-set publication, complete optional or out-of-order behavior, or downstream Needs review.",
    ),
  );
  return section;
};

const workbenchLink = (label, destination, active = false, attributes = {}) => element("a", {
  ...attributes,
  class: `workbench-nav__link${active ? " is-active" : ""}`,
  href: destination,
  ...(active ? { "aria-current": "page" } : {}),
}, label);

const workbenchChromeState = {
  currentProject: null,
  focusedControllerSession: null,
  harnessRunObservation: null,
  terminalAttachment: { sessionId: null, mode: "none" },
};

const setWorkbenchDestinationActive = (destination, active) => {
  destination.classList.toggle("is-active", active);
  if (active) {
    destination.setAttribute("aria-current", "page");
  } else {
    destination.removeAttribute("aria-current");
  }
};

const synchronizeWorkbenchChrome = () => {
  const currentProject = workbenchChromeState.currentProject;
  const focused = workbenchChromeState.focusedControllerSession;
  const focusedContextId = focused?.workContext?.workContextId ?? "";
  const selectedProject = document.getElementById("workbench-selected-project");
  if (selectedProject) {
    selectedProject.dataset.projectId = currentProject?.projectId ?? "";
    selectedProject.textContent = currentProject?.displayName ?? "No Project selected";
  }
  const breadcrumb = document.getElementById("workbench-project-breadcrumb");
  if (breadcrumb) {
    breadcrumb.textContent = `Projects / ${currentProject?.displayName ?? "Select a Project"}`;
  }
  const focusedWorkContext = document.getElementById("workbench-focused-work-context");
  if (focusedWorkContext) {
    focusedWorkContext.dataset.workContextId = focusedContextId;
    focusedWorkContext.textContent = focusedContextId || "No focused work context";
    setWorkbenchDestinationActive(focusedWorkContext, Boolean(focused));
  }
  for (const destination of document.querySelectorAll(
    "[data-workbench-controller-destination]",
  )) {
    setWorkbenchDestinationActive(destination, Boolean(focused));
  }
  const focusedController = document.getElementById("workbench-focused-controller");
  if (focusedController) {
    focusedController.dataset.workContextId = focusedContextId;
    const title = focusedController.querySelector("h1");
    if (title) {
      title.textContent = focused
        ? `Work context ${focusedContextId}`
        : "Open a Project and focused Controller";
    }
  }
  const focusedContext = document.getElementById("workbench-focused-context");
  if (focusedContext) {
    focusedContext.dataset.workContextId = focusedContextId;
    const title = focusedContext.querySelector("h2");
    if (title) {
      title.textContent = focusedContextId || "No focused context";
    }
  }
  const attachment = document.getElementById("workbench-attachment-status");
  if (attachment) {
    const attachmentMode = focused
      && workbenchChromeState.terminalAttachment.sessionId === focused.sessionId
      ? workbenchChromeState.terminalAttachment.mode
      : focused ? "attaching" : "none";
    attachment.dataset.provider = focused?.provider?.providerId ?? "none";
    attachment.dataset.sessionId = focused?.sessionId ?? "";
    attachment.dataset.attachment = attachmentMode;
    const status = attachment.querySelector("p");
    if (status) {
      status.textContent = focused
        ? `${focused.provider.providerId} · runtime-owned PTY · ${
            attachmentMode === "attaching"
              ? "attachment negotiating"
              : attachmentMode === "exited" ? "exited · read-only" : attachmentMode
          }`
        : "No Controller provider is attached.";
    }
  }
  const personAction = document.getElementById("workbench-person-action");
  if (personAction) {
    personAction.classList.remove("is-pending");
    personAction.dataset.personAction = "none";
    const eyebrow = personAction.querySelector(".workbench-eyebrow");
    const title = personAction.querySelector("h3");
    const description = personAction.querySelector("h3 + p");
    if (eyebrow) {
      eyebrow.textContent = "Person action";
    }
    if (title) {
      title.textContent = "No pending person action";
    }
    if (description) {
      description.textContent = "Launch uses its own optional confirmation preference.";
    }
  }
};

const updateWorkbenchChrome = (patch) => {
  if (Object.hasOwn(patch, "currentProject")) {
    workbenchChromeState.currentProject = patch.currentProject;
  }
  if (Object.hasOwn(patch, "focusedControllerSession")) {
    const previousSessionId = workbenchChromeState.focusedControllerSession?.sessionId ?? null;
    workbenchChromeState.focusedControllerSession = patch.focusedControllerSession;
    const nextSessionId = patch.focusedControllerSession?.sessionId ?? null;
    if (nextSessionId !== previousSessionId) {
      workbenchChromeState.terminalAttachment = {
        sessionId: nextSessionId,
        mode: nextSessionId ? "attaching" : "none",
      };
    }
  }
  if (Object.hasOwn(patch, "harnessRunObservation")) {
    workbenchChromeState.harnessRunObservation = patch.harnessRunObservation;
  }
  if (Object.hasOwn(patch, "terminalAttachment")) {
    const terminalAttachment = patch.terminalAttachment;
    if (terminalAttachment.sessionId
      === workbenchChromeState.focusedControllerSession?.sessionId) {
      workbenchChromeState.terminalAttachment = terminalAttachment;
    }
  }
  synchronizeWorkbenchChrome();
};

const renderWorkbench = (message) => {
  const viewModel = message.viewModel;
  const focused = viewModel.focusedControllerSession;
  const currentProject = viewModel.projectPreparation.current;
  const observation = viewModel.harnessRunObservation;
  updateWorkbenchChrome({
    currentProject,
    focusedControllerSession: focused,
    harnessRunObservation: observation,
  });
  const project = renderProjectPreparation(
    viewModel.projectPreparation,
    message.session,
    viewModel.controllerProviders,
    focused,
  );
  const planning = renderPlanning(viewModel.planning, message.session);
  const harnessRun = renderHarnessRun(observation);
  const shell = element("div", {
    id: "workbench-shell",
    class: "workbench-shell",
    "data-layout": "workbench",
  });
  const navigation = element("aside", {
    id: "workbench-navigation",
    class: "workbench-navigation",
    "aria-label": "Product and work context navigation",
  });
  const brand = element("a", {
    class: "workbench-brand",
    href: "#workbench-main",
    "aria-label": "Sand-King Cockpit home",
  }, "SAND—KING");
  const productNavigation = element("nav", {
    class: "workbench-nav",
    "aria-label": "Product destinations",
  });
  productNavigation.append(
    workbenchLink("Home", "#workbench-main"),
    workbenchLink("Projects", "#project-preparation", true),
    workbenchLink("Harnesses", "#harness-run-observation"),
    workbenchLink("Hosts", "#connection-status"),
  );
  const projectNavigation = element("nav", {
    class: "workbench-nav workbench-nav--project",
    "aria-label": "Project workspace destinations",
  });
  projectNavigation.append(
    element("p", { class: "workbench-eyebrow" }, "Selected Project"),
    workbenchLink(
      currentProject?.displayName ?? "No Project selected",
      "#project-preparation",
      true,
      {
        id: "workbench-selected-project",
        "data-project-id": currentProject?.projectId ?? "",
      },
    ),
    element("p", { class: "workbench-eyebrow" }, "Project workspace"),
    workbenchLink(
      "Controller",
      "#project-focused-controller-session",
      Boolean(focused),
      { "data-workbench-controller-destination": "true" },
    ),
    workbenchLink("Planning", "#planning-spine"),
    workbenchLink("Runs", "#harness-run-observation"),
    workbenchLink("Project", "#project-readiness"),
    element("p", { class: "workbench-eyebrow" }, "Work contexts"),
    workbenchLink(
      focused?.workContext?.workContextId ?? "No focused work context",
      "#project-focused-controller-session",
      Boolean(focused),
      {
        id: "workbench-focused-work-context",
        "data-work-context-id": focused?.workContext?.workContextId ?? "",
      },
    ),
  );
  navigation.append(brand, productNavigation, projectNavigation);

  const main = element("main", { id: "workbench-main", class: "workbench-main" });
  const topbar = element("header", { class: "workbench-topbar" });
  const navigationToggle = element("button", {
    id: "workbench-navigation-toggle",
    class: "workbench-drawer-toggle workbench-drawer-toggle--navigation",
    type: "button",
    "aria-controls": "workbench-navigation",
    "aria-expanded": "false",
    "aria-label": "Open product navigation",
  }, "Menu");
  const connectionStatus = element(
    "p",
    {
      id: "connection-status",
      class: `workbench-status workbench-status--${hostConnectionStatus}`,
      "data-host-status": hostConnectionStatus,
      "data-failure-code": viewModel.host.failure?.code ?? "",
      "data-connection-audit-id": viewModel.host.failure?.auditId ?? "",
      ...(hostConnectionStatus === "disconnected" ? { role: "alert" } : { role: "status" }),
    },
    hostConnectionStatus === "connected"
      ? `Connected to ${viewModel.host.identity} with protocol ${message.protocol.version}`
      : `Disconnected · Host ${viewModel.host.hostId}; Project and Harness state is stale`,
  );
  const externalProviderFeedback = element("span", {
    id: "external-provider-feedback",
    class: "workbench-visually-hidden",
    role: "status",
  });
  const externalProvider = element("button", {
    id: "external-provider-escape",
    class: "workbench-button workbench-button--secondary",
    type: "button",
    "aria-describedby": "external-provider-feedback",
  }, "Provider CLI escape hatch");
  externalProvider.addEventListener("click", () => {
    externalProviderFeedback.textContent =
      "Use the destination-local provider CLI directly. Sand-King did not copy credentials or mutate the Controller session.";
  });
  const contextToggle = element("button", {
    id: "workbench-context-toggle",
    class: "workbench-drawer-toggle workbench-drawer-toggle--context",
    type: "button",
    "aria-controls": "workbench-context",
    "aria-expanded": "false",
    "aria-label": "Open current context",
  }, "Context");
  topbar.append(
    navigationToggle,
    element("div", {
      id: "workbench-project-breadcrumb",
      class: "workbench-breadcrumbs",
    },
      `Projects / ${currentProject?.displayName ?? "Select a Project"}`),
    connectionStatus,
    externalProvider,
    externalProviderFeedback,
    contextToggle,
  );

  const stage = element("div", { class: "workbench-stage" });
  const stageHeader = element("header", { class: "workbench-stage__header" });
  const title = element("div", {
    id: "workbench-focused-controller",
    "data-work-context-id": focused?.workContext?.workContextId ?? "",
  });
  title.append(
    element("p", { class: "workbench-eyebrow" }, "Focused Controller"),
    element("h1", {}, focused
      ? `Work context ${focused.workContext.workContextId}`
      : "Open a Project and focused Controller"),
  );
  const workspaceDestinations = element("nav", {
    class: "workbench-tabs",
    "aria-label": "Project workspace",
  });
  workspaceDestinations.append(
    workbenchLink(
      "Controller",
      "#project-focused-controller-session",
      Boolean(focused),
      { "data-workbench-controller-destination": "true" },
    ),
    workbenchLink("Planning", "#planning-spine"),
    workbenchLink("Runs", "#harness-run-observation"),
    workbenchLink("Project", "#project-readiness"),
  );
  stageHeader.append(title, workspaceDestinations);
  stage.append(stageHeader, project);
  main.append(topbar, stage);

  const context = element("aside", {
    id: "workbench-context",
    class: "workbench-context",
    "aria-label": "Current work context and operational status",
  });
  const contextHeader = element("header", {
    id: "workbench-focused-context",
    class: "workbench-context__header",
    "data-work-context-id": focused?.workContext?.workContextId ?? "",
  });
  contextHeader.append(
    element("p", { class: "workbench-eyebrow" }, "Current work context"),
    element("h2", {}, focused?.workContext?.workContextId ?? "No focused context"),
  );
  const attachment = element("section", {
    class: "workbench-context__section",
    id: "workbench-attachment-status",
    "data-provider": focused?.provider?.providerId ?? "none",
    "data-attachment": focused ? "attaching" : "none",
  });
  attachment.append(
    element("h3", {}, "Provider and attachment"),
    element("p", {}, focused
      ? `${focused.provider.providerId} · runtime-owned PTY · attachment negotiating`
      : "No Controller provider is attached."),
  );
  const personAction = element("section", {
    id: "workbench-person-action",
    class: "workbench-context__section workbench-person-action",
    "data-person-action": "none",
  });
  personAction.append(
    element("p", { class: "workbench-eyebrow" }, "Person action"),
    element("h3", {}, "No pending person action"),
    element("p", {}, "Launch uses its own optional confirmation preference."),
  );
  context.append(contextHeader, attachment, personAction, planning, harnessRun);
  shell.append(navigation, main, context);
  queueMicrotask(synchronizeWorkbenchChrome);

  const setDrawer = (drawer, open) => {
    shell.classList.toggle(`is-${drawer}-open`, open);
    const toggle = drawer === "navigation" ? navigationToggle : contextToggle;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", `${open ? "Close" : "Open"} ${
      drawer === "navigation" ? "product navigation" : "current context"}`);
  };
  navigationToggle.addEventListener("click", () =>
    setDrawer("navigation", navigationToggle.getAttribute("aria-expanded") !== "true"));
  contextToggle.addEventListener("click", () =>
    setDrawer("context", contextToggle.getAttribute("aria-expanded") !== "true"));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setDrawer("navigation", false);
      setDrawer("context", false);
    }
  });
  return shell;
};

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
    const terminal = opaque ? terminalStreams.get(opaque.streamId) : null;
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
      const diagnostic = diagnosticStreams.get(opaque.streamId);
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
    if (!runtimeNegotiated || message.boundary !== "host") {
      requireReload("runtime_connection_state_before_negotiation");
      return;
    }
    hostConnectionStatus = message.status;
    hostFreshness = message.freshness;
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
        + "unaffected Controller and Planning views remain available.";
    }
    const projectPreparation = document.getElementById("project-preparation");
    if (projectPreparation) {
      projectPreparation.dataset.hostFreshness = message.freshness;
      for (const control of projectPreparation.querySelectorAll("[data-host-mutation]")) {
        control.disabled = true;
      }
    }
    if (harnessRunSection) {
      harnessRunSection.dataset.hostFreshness = message.freshness;
      const cancelButton = harnessRunSection.querySelector("#cancel-harness-run");
      if (cancelButton) cancelButton.disabled = true;
    }
    const planning = document.getElementById("planning-spine");
    if (planning) {
      planning.dataset.hostImpact = "unaffected";
    }
    clearTimeout(harnessObservationTimer);
    return;
  }

  if (message?.type === "runtime.terminal-attached") {
    const terminal = terminalStreams.get(message.streamId);
    if (
      !runtimeNegotiated
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
    const terminal = terminalStreams.get(message.streamId);
    if (
      !runtimeNegotiated
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
    if (!runtimeNegotiated) {
      requireReload("runtime_harness_observation_before_negotiation");
      return;
    }
    applyHarnessRunObservation(message.observation);
    return;
  }

  if (message?.type === "runtime.harness-run.launch-result") {
    if (
      !runtimeNegotiated
      || !harnessLaunchFeedback
      || message.requestId !== pendingHarnessLaunchRequestId
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
    pendingHarnessLaunchRequestId = null;
    sessionStorage.removeItem(pendingHarnessLaunchStorageKey);
    const launchButton = document.getElementById("launch-harness");
    if (launchButton) {
      launchButton.disabled = hostConnectionStatus !== "connected"
        || !selectedProjectLaunchReady();
    }
    if (message.outcome.type === "harness.run.launch.result") {
      harnessLaunchFeedback.textContent =
        `Harness run ${message.outcome.run.harnessRunId} launched.`;
      requestHarnessRunObservation(message.outcome.run.harnessRunId);
    } else {
      harnessLaunchFeedback.textContent =
        `Harness was not launched: ${message.outcome.code}.`;
    }
    return;
  }

  if (message?.type === "runtime.harness-run.cancel-result") {
    const pendingCancellation = readPendingHarnessCancellation();
    const feedback = document.getElementById("harness-run-cancellation-feedback");
    if (
      !runtimeNegotiated
      || !pendingCancellation
      || message.requestId !== pendingHarnessCancellationRequestId
      || message.outcome.harnessRunId !== pendingCancellation.harnessRunId
    ) {
      requireReload("runtime_harness_cancellation_result_mismatch");
      return;
    }
    pendingHarnessCancellationRequestId = null;
    sessionStorage.removeItem(pendingHarnessCancellationStorageKey);
    if (message.outcome.type === "harness.run.cancel.result") {
      if (feedback) feedback.textContent =
        "Cancellation accepted; termination remains asynchronously observable.";
      requestHarnessRunObservation();
    } else {
      if (feedback) feedback.textContent =
        `Cancellation was not accepted: ${message.outcome.code}.`;
      const cancelButton = document.getElementById("cancel-harness-run");
      if (cancelButton) cancelButton.disabled = hostConnectionStatus !== "connected";
    }
    return;
  }

  if (message?.type === "runtime.harness-run.logs.result") {
    if (!runtimeNegotiated || !harnessRunSection) {
      requireReload("runtime_harness_logs_before_negotiation");
      return;
    }
    const output = harnessRunSection.querySelector(
      `[data-log-producer="${message.producer}"]`,
    );
    if (!output || output.dataset.logStreamId !== message.streamId) {
      requireReload("runtime_harness_log_stream_mismatch");
      return;
    }
    output.textContent = "";
    output.dataset.rangeStart = String(message.range.start);
    output.dataset.rangeEnd = String(message.range.end);
    diagnosticStreams.set(message.streamId, {
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
  const durableIdentitiesCompatible = /^runtime-[a-f0-9]{24}$/
    .test(message?.viewModel?.runtime?.runtimeId ?? "")
    && /^host-[a-f0-9]{24}$/.test(message?.viewModel?.host?.hostId ?? "");
  const hostConnectionCompatible = ["connected", "disconnected"].includes(
    message?.viewModel?.host?.status,
  ) && ["current", "stale"].includes(message?.viewModel?.host?.freshness)
    && (message.viewModel.host.status === "connected"
      ? message.viewModel.host.failure === null
      : message.viewModel.host.failure?.code === "host_disconnected"
        || message.viewModel.host.failure?.code === "host_protocol_invalid"
        || message.viewModel.host.failure?.code
          === "host_observation_resynchronization_failed");
  const planningCompatible = message?.viewModel?.planning?.kind === "cockpit.planning-spine"
    && message.viewModel.planning.adapter?.fixture === true
    && JSON.stringify(message.viewModel.planning.builtInStages)
      === JSON.stringify(["wayfinding", "speccing", "ticketing"]);
  const projectPreparationCompatible =
    message?.viewModel?.projectPreparation?.kind === "cockpit.project-preparation"
    && message.viewModel.projectPreparation.selection?.mode === "explicit-host-path"
    && message.viewModel.projectPreparation.selection?.directoryScanning === false
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
    && resynchronizationConsistent
    && (harnessObservation.run === null
      || harnessObservation.run.projectId
        === message?.viewModel?.projectPreparation?.current?.projectId);

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
    || !planningCompatible
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
  runtimeNegotiated = true;
  hostConnectionStatus = message.viewModel.host.status;
  hostFreshness = message.viewModel.host.freshness;
  document.documentElement.dataset.observationMode = message.observation.mode;
  document.documentElement.dataset.protocolVersion = message.protocol.version;
  document.documentElement.dataset.hostConnectionStatus = hostConnectionStatus;
  app.textContent = "";
  app.append(renderWorkbench(message));
  currentHarnessRunObservation = message.viewModel.harnessRunObservation;
  harnessRunSection = document.getElementById("harness-run-observation");
  const pendingLaunch = readPendingHarnessLaunch();
  if (
    pendingLaunch
    && hostConnectionStatus === "connected"
    && pendingLaunch.projectId === message.viewModel.projectPreparation.current?.projectId
  ) {
    pendingHarnessLaunchRequestId = `harness-launch-retry-${harnessRequestSequence}`;
    harnessRequestSequence += 1;
    if (harnessLaunchFeedback) {
      harnessLaunchFeedback.textContent = "Reconnecting to the retained Harness launch outcome…";
    }
    socket.send(JSON.stringify({
      channel: "control",
      message: {
        type: "browser.harness-run.launch",
        requestId: pendingHarnessLaunchRequestId,
        projectId: pendingLaunch.projectId,
        ...(Object.keys(pendingLaunch.parameters).length === 0
          ? {}
          : { parameters: pendingLaunch.parameters }),
        idempotencyKeyHash: pendingLaunch.idempotencyKeyHash,
      },
    }));
  }
  const pendingCancellation = readPendingHarnessCancellation();
  if (
    pendingCancellation
    && hostConnectionStatus === "connected"
    && pendingCancellation.harnessRunId
      === message.viewModel.harnessRunObservation.run?.harnessRunId
  ) {
    pendingHarnessCancellationRequestId =
      `harness-cancel-retry-${harnessRequestSequence}`;
    harnessRequestSequence += 1;
    const feedback = document.getElementById("harness-run-cancellation-feedback");
    if (feedback) feedback.textContent =
      "Reconnecting to the retained cancellation outcome…";
    socket.send(JSON.stringify({
      channel: "control",
      message: {
        type: "browser.harness-run.cancel",
        requestId: pendingHarnessCancellationRequestId,
        ...pendingCancellation,
      },
    }));
  }
  requestHarnessRunObservation();
});

socket.addEventListener("close", (event) => {
  clearTimeout(harnessObservationTimer);
  disposeAllTerminalSurfaces();
  if (!document.documentElement.dataset.protocolError && !event.wasClean) {
    app.textContent = "Controller runtime connection is stale. Retry by reloading the Cockpit.";
  }
});
