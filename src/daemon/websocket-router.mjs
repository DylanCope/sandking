import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { canonicalJson } from "../common/canonical-json.mjs";
import {
  BROWSER_PROTOCOL_VERSION,
  BROWSER_SCHEMA_DIGEST,
  MAX_BROWSER_CONTROL_BYTES,
  MAX_BROWSER_OPAQUE_CHUNK_BYTES,
  BrowserProtocolError,
  browserCapabilities,
  decodeBrowserOpaqueFrame,
  encodeBrowserOpaqueFrame,
  parseBrowserControl,
  runtimeOptionalBrowserCapabilities,
  runtimeRequiredBrowserCapabilities,
  serializeRuntimeControl,
} from "../browser-protocol.mjs";
import { ControllerSessionError } from "../controller-sessions.mjs";
import { releaseVersion } from "../protocol.mjs";

/** @param {any} runtime */
export const createWebSocketRouter = (runtime) => {
const {
  attachBrowserSocket,
  detachBrowserSocket,
  expireBrowserSessionIfDue,
  getActiveBrowserSession,
  getBrowserSessionStatus,
  markBrowserSocketNegotiated,
  markHostDisconnected,
  recordAudit,
  requestFocusedHostMutation,
  requestHostOperation,
  retainCanonicalHarnessRunObservation,
} = runtime;

/** @param {WebSocket} socket @param {string} code @param {boolean} reloadRequired */
const rejectBrowserProtocol = (socket, code, reloadRequired) => {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(serializeRuntimeControl({
    type: "runtime.protocol-error",
    code,
    retryable: true,
    reloadRequired,
  }), () => socket.close(1002, "protocol_mismatch"));
};

/** @param {WebSocket} socket @param {string} sessionId @param {any} session */
const handleBrowserConnection = (socket, sessionId, session) => {
  attachBrowserSocket(sessionId, socket);
  socket.once("close", () => {
    runtime.controllerSessions?.detach(socket);
    detachBrowserSocket(sessionId, socket);
  });
  /** @type {"awaiting-hello" | "negotiated" | "rejected"} */
  let phase = "awaiting-hello";
  const handshakeTimeout = setTimeout(() => {
    phase = "rejected";
    rejectBrowserProtocol(socket, "browser_hello_timeout", true);
  }, 3_000);

  /** @param {import("ws").RawData} data */
  const toBuffer = (data) => Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(new Uint8Array(data));

  /** @param {import("ws").RawData} data */
  const parseControlFrame = (data) => {
    const controlData = toBuffer(data);
    if (controlData.byteLength > MAX_BROWSER_CONTROL_BYTES) {
      throw new BrowserProtocolError("browser_control_frame_invalid");
    }
    let json;
    try {
      json = JSON.parse(controlData.toString());
    } catch {
      throw new BrowserProtocolError("browser_control_json_invalid");
    }
    return parseBrowserControl(json);
  };

  /** @param {import("ws").RawData} data @param {boolean} isBinary */
  const processMessage = async (data, isBinary) => {
    if (phase === "rejected") {
      return;
    }
    await expireBrowserSessionIfDue(sessionId);
    if (getActiveBrowserSession(sessionId) !== session) {
      phase = "rejected";
      clearTimeout(handshakeTimeout);
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1008,
          getBrowserSessionStatus(sessionId) === "expired" ? "session_expired" : "session_ended");
      }
      return;
    }
    const wasAwaitingHello = phase === "awaiting-hello";
    if (wasAwaitingHello) {
      clearTimeout(handshakeTimeout);
    }

    try {
      if (phase === "negotiated") {
        if (isBinary) {
          const opaque = decodeBrowserOpaqueFrame(toBuffer(data));
          try {
            await runtime.controllerSessions?.write({
              socket,
              streamId: opaque.streamId,
              sequence: opaque.sequence,
              eof: opaque.eof,
              data: opaque.data,
            });
          } catch (error) {
            throw new BrowserProtocolError(error instanceof ControllerSessionError
              ? error.code
              : "controller_terminal_input_failed");
          }
          await recordAudit("browser.opaque.receive", "observed", {
            streamId: opaque.streamId,
            sequence: opaque.sequence,
            eof: opaque.eof,
            byteLength: opaque.data.byteLength,
          });
          return;
        }
        const control = parseControlFrame(data);
        if (control.type === "browser.ping") {
          socket.send(serializeRuntimeControl({
            type: "runtime.pong",
            requestId: control.requestId,
          }));
          return;
        }
        if (control.type === "browser.terminal.attach") {
          try {
            const attached = await runtime.controllerSessions?.attach({
              socket,
              sessionId: control.sessionId,
              streamId: control.streamId,
              attachmentId: control.attachmentId,
              mode: control.mode,
              outputCursor: control.outputCursor,
              onAttached: (/** @type {any} */ attachment) => {
                socket.send(serializeRuntimeControl({
                  type: "runtime.terminal-attached",
                  sessionId: control.sessionId,
                  streamId: control.streamId,
                  attachmentId: control.attachmentId,
                  mode: attachment.mode,
                  exclusive: attachment.exclusive,
                  requestedOutputCursor: control.outputCursor,
                  outputCursor: attachment.outputCursor,
                  resynchronized: attachment.resynchronized,
                  inputSequence: attachment.inputSequence,
                  resizeSequence: attachment.resizeSequence,
                }));
              },
              onOutput: (/** @type {WebSocket} */ target, /** @type {any} */ frame) => {
                if (target.readyState === WebSocket.OPEN) {
                  target.send(encodeBrowserOpaqueFrame(frame), { binary: true });
                }
              },
            });
            if (!attached) {
              throw new ControllerSessionError("controller_terminal_unavailable");
            }
            if (!attached.activate()) {
              throw new ControllerSessionError("controller_terminal_attachment_superseded");
            }
            return;
          } catch (error) {
            throw new BrowserProtocolError(error instanceof ControllerSessionError
              ? error.code
              : "controller_terminal_attach_failed");
          }
        }
        if (control.type === "browser.terminal.resize") {
          try {
            const resized = await runtime.controllerSessions?.resize({
              socket,
              sessionId: control.sessionId,
              streamId: control.streamId,
              attachmentId: control.attachmentId,
              sequence: control.sequence,
              columns: control.columns,
              rows: control.rows,
            });
            if (!resized) {
              throw new ControllerSessionError("controller_terminal_unavailable");
            }
            socket.send(serializeRuntimeControl({
              type: "runtime.terminal-resized",
              ...resized,
            }));
            return;
          } catch (error) {
            throw new BrowserProtocolError(error instanceof ControllerSessionError
              ? error.code
              : "controller_terminal_resize_failed");
          }
        }
        if (control.type === "browser.harness-run.launch") {
          let originalRun = null;
          if (control.reconnectHarnessRunId) {
            const lookup = await requestHostOperation({
              type: "harness.run.lookup",
              requestId: `harness-run-reconnect-lookup-${randomBytes(8).toString("hex")}`,
              idempotencyKeyHash: control.idempotencyKeyHash,
            });
            const candidateRun = lookup.type === "harness.run.lookup.result"
              && lookup.found === true
              && lookup.launchOutcome?.type === "harness.run.launch.result"
              && lookup.launchOutcome.run?.harnessRunId === control.reconnectHarnessRunId
              ? lookup.launchOutcome.run
              : null;
            originalRun = candidateRun
              && "source" in candidateRun
              && "parameters" in candidateRun
              ? candidateRun
              : null;
            if (
              !originalRun
              || originalRun.projectId !== control.projectId
              || canonicalJson(originalRun.parameters ?? {})
                !== canonicalJson(control.parameters ?? {})
              || !["controller-cli", "cockpit"].includes(originalRun.source)
              || (originalRun.source === "controller-cli"
                && !/^controller-session-[a-f0-9]{24}$/.test(
                  originalRun.controllerSessionId ?? "",
                ))
              || (originalRun.source === "cockpit"
                && originalRun.controllerSessionId !== null)
            ) {
              throw new BrowserProtocolError("harness_run_launch_reconnect_invalid");
            }
          }
          const message = {
            type: "harness.run.launch",
            requestId: `harness-run-launch-${randomBytes(8).toString("hex")}`,
            projectId: control.projectId,
            parameters: control.parameters,
            controllerId: runtime.state.runtimeId,
            controllerSessionId: originalRun?.controllerSessionId ?? null,
            source: originalRun?.source ?? "cockpit",
            authorizationClass: "harness_run_launch",
            idempotencyKeyHash: control.idempotencyKeyHash,
          };
          const outcome = await requestFocusedHostMutation("harness.run.launch", message, {
            projectId: message.projectId,
            parameters: message.parameters,
            controllerId: message.controllerId,
            controllerSessionId: message.controllerSessionId,
            source: message.source,
            authorizationClass: message.authorizationClass,
          });
          socket.send(serializeRuntimeControl({
            type: "runtime.harness-run.launch-result",
            requestId: control.requestId,
            outcome,
          }));
          return;
        }
        if (control.type === "browser.harness-run.cancel") {
          const outcome = await requestHostOperation({
            type: "harness.run.cancel",
            requestId: `harness-run-cancel-${randomBytes(8).toString("hex")}`,
            harnessRunId: control.harnessRunId,
            controllerId: runtime.state.runtimeId,
            controllerSessionId: null,
            source: "cockpit",
            authorizationClass: "harness_run_cancellation",
            idempotencyKeyHash: control.idempotencyKeyHash,
          });
          socket.send(serializeRuntimeControl({
            type: "runtime.harness-run.cancel-result",
            requestId: control.requestId,
            outcome,
          }));
          return;
        }
        if (control.type === "browser.harness-run.recover") {
          const outcome = await requestHostOperation({
            type: "harness.run.recover",
            requestId: `harness-run-recover-${randomBytes(8).toString("hex")}`,
            harnessRunId: control.harnessRunId,
            action: control.action,
            controllerId: runtime.state.runtimeId,
            controllerSessionId: null,
            source: "cockpit",
            authorizationClass: "harness_run_recovery",
            idempotencyKeyHash: control.idempotencyKeyHash,
          });
          socket.send(serializeRuntimeControl({
            type: "runtime.harness-run.recover-result",
            requestId: control.requestId,
            outcome,
          }));
          return;
        }
        if (control.type === "browser.harness-run.observe") {
          const observation = await requestHostOperation({
            type: "harness.run.observe",
            requestId: `harness-observe-${randomBytes(8).toString("hex")}`,
            harnessRunId: control.harnessRunId,
            afterSequence: control.afterSequence,
          });
          if (observation.type !== "harness.run.observe.result") {
            throw new BrowserProtocolError("harness_run_observation_failed");
          }
          retainCanonicalHarnessRunObservation(observation);
          socket.send(serializeRuntimeControl({
            type: "runtime.harness-run.observation",
            requestId: control.requestId,
            observation,
          }));
          return;
        }
        if (control.type === "browser.harness-run.logs.get") {
          const result = await requestHostOperation({
            type: "harness.run.logs.get",
            requestId: `harness-logs-${randomBytes(8).toString("hex")}`,
            harnessRunId: control.harnessRunId,
            producer: control.producer,
            offset: control.offset,
            limit: control.limit,
          });
          if (result.type !== "harness.run.logs.result" || !Buffer.isBuffer(result.data)) {
            throw new BrowserProtocolError("harness_run_logs_failed");
          }
          const { data: logBytes, ...metadata } = result;
          socket.send(serializeRuntimeControl({
            ...metadata,
            type: "runtime.harness-run.logs.result",
            requestId: control.requestId,
          }));
          socket.send(encodeBrowserOpaqueFrame({
            streamId: result.streamId,
            sequence: result.range.start,
            eof: result.range.eof,
            data: logBytes,
          }), { binary: true });
          await recordAudit("browser.harness-run.logs", "observed", {
            harnessRunId: result.harnessRunId,
            producer: result.producer,
            range: result.range,
            byteLength: result.byteLength,
            insertedIntoControllerConversation: false,
          });
          return;
        }
        throw new BrowserProtocolError("browser_control_unexpected_message");
      }

      if (isBinary) {
        throw new BrowserProtocolError("browser_control_frame_invalid");
      }
      const hello = parseControlFrame(data);
      if (hello.type !== "browser.hello") {
        throw new BrowserProtocolError("browser_hello_required");
      }
      if (hello.protocol.major !== BROWSER_PROTOCOL_VERSION.major) {
        throw new BrowserProtocolError("browser_protocol_major_mismatch");
      }
      if (hello.schemaDigest !== BROWSER_SCHEMA_DIGEST) {
        throw new BrowserProtocolError("browser_schema_mismatch");
      }
      const unsupported = hello.capabilities.required.filter(
        (capability) => !browserCapabilities.includes(capability),
      );
      const browserOffered = new Set([
        ...hello.capabilities.required,
        ...hello.capabilities.optional,
      ]);
      const missingRuntimeRequired = runtimeRequiredBrowserCapabilities.filter(
        (capability) => !browserOffered.has(capability),
      );
      if (unsupported.length > 0 || missingRuntimeRequired.length > 0) {
        throw new BrowserProtocolError("browser_capability_unsupported");
      }

      const currentCursor = runtime.state.host.observationCursor ?? "host:origin";
      const observation = runtime.state.host.status === "disconnected"
        && hello.observationCursor !== null
        && hello.observationCursor !== currentCursor
        ? {
            mode: "resynchronization-failed",
            cursor: currentCursor,
            reason: "host_observation_resynchronization_failed",
          }
        : hello.observationCursor === null
          ? { mode: "snapshot", cursor: currentCursor }
          : hello.observationCursor === currentCursor
            ? { mode: "resume", cursor: currentCursor }
            : { mode: "resynchronize", cursor: currentCursor, reason: "cursor_unavailable" };
      const negotiatedCapabilities = browserCapabilities.filter((capability) =>
        [...hello.capabilities.required, ...hello.capabilities.optional].includes(capability));

      const acknowledgement = serializeRuntimeControl({
        type: "runtime.hello-ack",
        protocol: BROWSER_PROTOCOL_VERSION,
        release: releaseVersion,
        identity: "controller-runtime",
        peerIdentity: "cockpit",
        capabilities: {
          required: [...runtimeRequiredBrowserCapabilities],
          optional: [...runtimeOptionalBrowserCapabilities],
        },
        negotiatedCapabilities,
        schemaDigest: BROWSER_SCHEMA_DIGEST,
        framing: {
          maxControlMessageBytes: Math.min(
            MAX_BROWSER_CONTROL_BYTES,
            hello.framing.maxControlMessageBytes,
          ),
          maxOpaqueStreamChunkBytes: Math.min(
            MAX_BROWSER_OPAQUE_CHUNK_BYTES,
            hello.framing.maxOpaqueStreamChunkBytes,
          ),
        },
        observation,
        session: { csrfToken: session.csrfToken, revision: session.revision },
        viewModel: {
          kind: "cockpit.connection",
          runtime: {
            identity: "controller-runtime",
            runtimeId: runtime.state.runtimeId,
            release: releaseVersion,
          },
          host: {
            identity: runtime.state.host.identity,
            hostId: runtime.state.host.hostId,
            release: runtime.state.host.release,
            status: runtime.state.host.status,
            freshness: runtime.state.host.freshness,
            failure: runtime.state.host.failure,
          },
          negotiation: {
            protocol: runtime.state.protocol,
            capabilities: runtime.state.host.negotiatedCapabilities,
            schemaDigest: runtime.state.host.schemaDigest,
            framing: runtime.state.host.framing,
            observationCursor: runtime.state.host.observationCursor,
          },
          projectPreparation: runtime.currentProjectPreparation,
          focusedControllerSession: runtime.currentProjectControllerSession,
          controllerProviders: runtime.controllerProviderProjection,
          harnessRunObservation: runtime.currentHarnessRunObservation,
        },
      });
      await recordAudit("browser.negotiate", "accepted", {
        runtimeId: runtime.state.runtimeId,
        hostIdentity: runtime.state.host.identity,
        hostId: runtime.state.host.hostId,
        observationMode: observation.mode,
        sessionAuditId: session.auditId,
      });
      phase = "negotiated";
      markBrowserSocketNegotiated(sessionId, socket);
      socket.send(acknowledgement);
    } catch (error) {
      const hostFailureCode = error instanceof ControllerSessionError
        && (error.code === "host_disconnected" || error.code === "host_protocol_invalid")
        ? error.code
        : null;
      if (hostFailureCode) {
        await markHostDisconnected(hostFailureCode);
        return;
      }
      const code = error instanceof BrowserProtocolError
        ? error.code
        : "browser_protocol_invalid";
      phase = "rejected";
      rejectBrowserProtocol(socket, code, wasAwaitingHello);
      await recordAudit(
        wasAwaitingHello ? "browser.negotiate" : "browser.frame",
        "rejected",
        { code },
      );
    }
  };

  let processing = Promise.resolve();
  socket.on("message", (data, isBinary) => {
    processing = processing.then(() => processMessage(data, isBinary));
  });
};

return { handleBrowserConnection, rejectBrowserProtocol };
};
