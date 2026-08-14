import { FitAddon } from "/terminal/addon-fit.mjs";
import { Terminal } from "/terminal/xterm.mjs";
import { element } from "./dom.mjs";

export const createTerminalSurface = ({
  state,
  socket,
  requireReload,
  updateWorkbenchChrome,
}) => {
  const terminalStreams = new Map();

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

  const applyOpaqueFrame = (opaque) => {
    const terminal = terminalStreams.get(opaque.streamId);
    if (!terminal) {
      return false;
    }
    if (opaque.sequence !== terminal.outputSequence) {
      requireReload("runtime_terminal_output_sequence_mismatch");
      return true;
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
    return true;
  };

  const applyTerminalAttached = (message) => {
    const terminal = terminalStreams.get(message.streamId);
    if (
      !state.runtimeNegotiated
      || !terminal
      || terminal.attachmentId !== message.attachmentId
      || (terminal.requestedMode === "read-write"
        && (message.mode !== "read-write" || message.exclusive !== true))
      || (terminal.requestedMode === "read-write-if-available"
        && !["read-write", "read-only"].includes(message.mode))
    ) {
      return false;
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
    return true;
  };

  const applyTerminalResized = (message) => {
    const terminal = terminalStreams.get(message.streamId);
    if (
      !state.runtimeNegotiated
      || !terminal
      || terminal.sessionId !== message.sessionId
      || terminal.attachmentId !== message.attachmentId
      || terminal.lastRequestedDimensions?.sequence !== message.sequence
      || terminal.lastRequestedDimensions.columns !== message.columns
      || terminal.lastRequestedDimensions.rows !== message.rows
    ) {
      return false;
    }
    terminal.panel.dataset.terminalColumns = String(message.columns);
    terminal.panel.dataset.terminalRows = String(message.rows);
    terminal.panel.dataset.terminalResizeSequence = String(message.sequence);
    return true;
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

  return {
    applyOpaqueFrame,
    applyTerminalAttached,
    applyTerminalResized,
    attachTerminalSurface,
    decodeOpaqueFrame,
    disposeAllTerminalSurfaces,
  };
};
