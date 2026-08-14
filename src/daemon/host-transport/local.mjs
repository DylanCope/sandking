import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { digest } from "../../common/digest.mjs";
import { BrowserProtocolError, serializeRuntimeControl } from "../../browser-protocol.mjs";
import { ControllerSessionError } from "../../controller-sessions.mjs";
import { appendPrivateJsonLine, writePrivateJson } from "../../private-state.mjs";
import {
  MAX_BULK_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  ProtocolError,
  readFrame,
  readProtocolFrame,
  releaseVersion,
  writeFrame,
} from "../../protocol.mjs";

/**
 * Today's Host is local. This file is the transport seam where a future,
 * separately specified SSH implementation can sit without inventing it now.
 * @param {any} runtime
 */
export const createLocalHostTransport = (runtime) => {
/** @type {import("node:child_process").ChildProcessWithoutNullStreams | undefined} */
let hostProcess;
/** @type {Promise<void> | null} */
let hostDisconnectionPromise = null;
let hostOperationQueue = Promise.resolve();
const { recordAudit } = runtime;

const hostAffectedViews = Object.freeze([
  "project-preparation",
  "harness-run-observation",
]);
const hostUnaffectedViews = Object.freeze([
  "controller-sessions",
]);

const hostConnectionStateMessage = () => ({
  type: "runtime.connection-state",
  boundary: "host",
  hostId: runtime.state.host.hostId,
  status: "disconnected",
  freshness: "stale",
  failure: runtime.state.host.failure,
  affectedViews: [...hostAffectedViews],
  unaffectedViews: [...hostUnaffectedViews],
  retainedObservationCursor: runtime.state.host.observationCursor,
});

/** @param {any} observation */
const retainCanonicalHarnessRunObservation = (observation) => {
  if (!observation.run) {
    runtime.currentHarnessRunObservation = {
      ...structuredClone(observation),
      requestId: "harness-observe-cached",
      code: "harness_run_absent",
      mode: "snapshot",
      resynchronization: null,
    };
    return;
  }
  const sameRun = runtime.currentHarnessRunObservation.run?.harnessRunId
    === observation.run.harnessRunId;
  const retainedEvents = observation.mode === "resume" && sameRun
    ? [...runtime.currentHarnessRunObservation.events, ...observation.events]
    : observation.events;
  const eventsById = new Map(retainedEvents.map(
    (/** @type {any} */ event) => [event.eventId, event],
  ));
  runtime.currentHarnessRunObservation = {
    ...structuredClone(observation),
    requestId: "harness-observe-cached",
    code: "harness_run_observed",
    mode: "snapshot",
    resynchronization: null,
    events: [...eventsById.values()].sort(
      (/** @type {any} */ left, /** @type {any} */ right) => left.sequence - right.sequence,
    ),
  };
};

/** @param {"host_disconnected" | "host_protocol_invalid" | "host_observation_resynchronization_failed"} code */
const markHostDisconnected = async (code) => {
  if (!runtime.state) {
    return null;
  }
  if (runtime.state.host.status !== "disconnected" && !hostDisconnectionPromise) {
    hostDisconnectionPromise = (async () => {
      const observedAt = new Date().toISOString();
      const auditId = await recordAudit("host.connection", "observed", {
        code,
        hostId: runtime.state.host.hostId,
        controllerId: runtime.state.runtimeId,
        affectedViews: [...hostAffectedViews],
        unaffectedViews: [...hostUnaffectedViews],
        retainedObservationCursor: runtime.state.host.observationCursor,
        retainedProjectId: runtime.currentProjectPreparation.current?.projectId ?? null,
        retainedHarnessRunId: runtime.currentHarnessRunObservation.run?.harnessRunId ?? null,
        registrationCreated: false,
        harnessRunLaunched: false,
        privilegedMutation: false,
        inventedSuccess: false,
      });
      runtime.state.host.status = "disconnected";
      runtime.state.host.freshness = "stale";
      runtime.state.host.failure = { code, retryable: true, auditId, observedAt };
      await writePrivateJson(runtime.paths.state, runtime.state);
      const message = hostConnectionStateMessage();
      runtime.forEachNegotiatedBrowserSocket((/** @type {WebSocket} */ socket) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(serializeRuntimeControl(message));
        }
      });
    })();
  }
  await hostDisconnectionPromise;
  return hostConnectionStateMessage();
};

/** @param {unknown} error */
const sanitizedRuntimeCode = (error) => {
  if (error instanceof ProtocolError) {
    return "host_protocol_invalid_frame";
  }
  if (error instanceof BrowserProtocolError) {
    return error.code;
  }
  if (error instanceof Error) {
    const allowed = new Set([
      "host_protocol_error",
      "host_protocol_major_mismatch",
      "host_identity_mismatch",
      "host_capability_unsupported",
      "host_schema_mismatch",
      "host_framing_invalid",
      "host_unavailable",
      "host_disconnected",
      "host_protocol_invalid",
      "host_observation_resynchronization_failed",
      "harness_run_state_schema_unsupported",
      "controller_identity_invalid",
      "controller_host_identity_mismatch",
      "controller_protocol_major_mismatch",
      "controller_capability_unsupported",
      "controller_schema_mismatch",
    ]);
    return allowed.has(error.message) ? error.message : "runtime_start_failed";
  }
  return "runtime_start_failed";
};

/** @param {unknown} error */
const logSanitizedRuntimeError = async (error) => {
  await appendPrivateJsonLine(runtime.paths.runtimeError, {
    code: sanitizedRuntimeCode(error),
    recordedAt: new Date().toISOString(),
  });
};

/** @param {import("node:child_process").ChildProcess} child */
const stopChild = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 500);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(undefined);
    });
  });
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
};

/** @param {string} runtimeId */
const launchHost = async (runtimeId) => {
  const hostArgs = [...runtime.hostArgs];

  // This explicit environment is the credential boundary. Controller-side
  // environment variables, provider credentials, and NODE_OPTIONS do not cross it.
  const hostEnvironment = process.platform === "win32" && process.env.SystemRoot
    ? { SystemRoot: process.env.SystemRoot }
    : { LANG: "C.UTF-8" };
  const child = spawn(process.execPath, hostArgs, {
    cwd: runtime.args.dataDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: hostEnvironment,
  });
  hostProcess = child;
  let hostDiagnostic = "";
  child.stderr.on("data", (chunk) => {
    if (hostDiagnostic.length < 1_024) {
      hostDiagnostic += Buffer.from(chunk).toString("utf8").slice(0, 1_024);
    }
  });

  try {
    const controllerProtocol = runtime.controllerProtocol;
    const controllerRequiredCapabilities = runtime.controllerRequiredCapabilities;
    const controllerSchemaDigest = runtime.controllerSchemaDigest;

    writeFrame(child.stdin, {
      type: "hello",
      protocol: controllerProtocol,
      release: releaseVersion,
      identity: "controller-runtime",
      controllerId: runtimeId,
      expectedPeerIdentity: "local-host",
      expectedHostId: runtime.args.expectedHostId,
      capabilities: {
        required: controllerRequiredCapabilities,
        optional: [],
      },
      schemaDigest: controllerSchemaDigest,
      framing: {
        maxFrameBytes: MAX_FRAME_BYTES,
        maxBulkChunkBytes: MAX_BULK_CHUNK_BYTES,
      },
      observationCursor: null,
    });

    const response = await readFrame(child.stdout);
    if (response.type === "protocol-error") {
      throw new Error(response.code);
    }
    if (response.type !== "hello-ack") {
      throw new Error("host_protocol_error");
    }
    if (response.protocol.major !== runtime.protocolVersion.major) {
      throw new Error("host_protocol_major_mismatch");
    }
    if (
      response.identity !== "local-host"
      || response.hostId !== runtime.args.expectedHostId
      || response.peerIdentity !== "controller-runtime"
      || response.peerControllerId !== runtimeId
    ) {
      throw Object.assign(new Error("host_identity_mismatch"), {
        expectedHostId: runtime.args.expectedHostId,
        observedHostId: response.hostId,
        controllerId: runtimeId,
        observedControllerId: response.peerControllerId,
      });
    }
    const unknownRequired = response.capabilities.required.filter(
      (/** @type {string} */ capability) => !runtime.hostCapabilities.includes(capability),
    );
    const missingNegotiated = runtime.hostCapabilities.filter(
      (/** @type {string} */ capability) => !response.negotiatedCapabilities.includes(capability),
    );
    if (unknownRequired.length > 0 || missingNegotiated.length > 0) {
      throw new Error("host_capability_unsupported");
    }
    if (response.schemaDigest !== runtime.hostSchemaDigest) {
      throw new Error("host_schema_mismatch");
    }
    if (
      response.framing.maxFrameBytes > MAX_FRAME_BYTES
      || response.framing.maxBulkChunkBytes > MAX_BULK_CHUNK_BYTES
    ) {
      throw new Error("host_framing_invalid");
    }

    let hostIdentityOutcome = null;
    if (runtime.args.allowHostIdentityCreate) {
      const requestId = `host-identity-${randomBytes(8).toString("hex")}`;
      const idempotencyKey = `host-identity:${runtime.args.startupId}`;
      writeFrame(child.stdin, {
        type: "host.identity.accept",
        requestId,
        hostId: runtime.args.expectedHostId,
        authorizationClass: "controller_host_identity_binding",
        idempotencyKey,
        expectedRevision: 0,
      });
      const outcome = await readFrame(child.stdout);
      if (outcome.type === "host.identity.failure") {
        throw Object.assign(new Error("host_protocol_error"), {
          hostIdentityAuditId: outcome.auditId,
        });
      }
      if (
        outcome.type !== "host.identity.result"
        || outcome.requestId !== requestId
        || outcome.hostId !== runtime.args.expectedHostId
        || outcome.authorizationClass !== "controller_host_identity_binding"
        || outcome.expectedRevision !== 0
        || outcome.revision !== 1
      ) {
        throw new Error("host_protocol_error");
      }
      hostIdentityOutcome = outcome;
    }

    const readinessRequestId = `ping-${randomBytes(8).toString("hex")}`;
    writeFrame(child.stdin, { type: "ping", requestId: readinessRequestId });
    const pong = await readFrame(child.stdout);
    if (pong.type !== "pong" || pong.requestId !== readinessRequestId) {
      throw new Error("host_unavailable");
    }

    return { host: response, hostIdentityOutcome };
  } catch (error) {
    await stopChild(child);
    if (error instanceof ProtocolError && error.code === "frame_truncated") {
      const diagnosticCode = hostDiagnostic.trim().split(":", 1)[0];
      if (diagnosticCode === "harness_run_state_schema_unsupported") {
        throw new Error(diagnosticCode);
      }
      if (diagnosticCode === "host_internal_error") {
        throw new Error("host_unavailable");
      }
    }
    throw error;
  }
};

/** @param {any} message */
const requestHostOperation = (message) => {
  const current = hostOperationQueue.catch(() => undefined).then(async () => {
    if (
      runtime.state?.host?.status === "disconnected"
      || !hostProcess
      || !hostProcess.stdin.writable
      || !hostProcess.stdout.readable
    ) {
      await markHostDisconnected("host_disconnected");
      throw new ControllerSessionError("host_disconnected");
    }
    try {
      writeFrame(hostProcess.stdin, message);
      const frame = await readProtocolFrame(hostProcess.stdout);
      if (frame.channel !== "control") {
        throw new Error("host_protocol_error");
      }
      const response = frame.message;
      if (!("requestId" in response) || response.requestId !== message.requestId) {
        throw new Error("host_protocol_error");
      }
      if (response.type === "harness.run.logs.result") {
        const bulk = await readProtocolFrame(hostProcess.stdout);
        if (
          bulk.channel !== "bulk"
          || bulk.streamId !== response.streamId
          || bulk.sequence !== response.range.start
          || bulk.eof !== response.range.eof
          || bulk.data.byteLength !== response.byteLength
          || digest(bulk.data) !== response.sha256
        ) {
          throw new Error("host_protocol_error");
        }
        return { ...response, data: bulk.data };
      }
      return response;
    } catch (error) {
      const code = error instanceof ProtocolError
        ? error.code === "frame_truncated"
          ? "host_disconnected"
          : "host_protocol_invalid"
        : error instanceof Error && error.message === "host_protocol_error"
          ? "host_protocol_invalid"
          : "host_disconnected";
      await markHostDisconnected(code);
      throw new ControllerSessionError(code);
    }
  });
  hostOperationQueue = current.then(() => undefined, () => undefined);
  return current;
};

const stopHost = async () => {
  if (hostProcess) await stopChild(hostProcess);
};

return {
  getHostProcess: () => hostProcess,
  hostConnectionStateMessage,
  launchHost,
  logSanitizedRuntimeError,
  markHostDisconnected,
  requestHostOperation,
  retainCanonicalHarnessRunObservation,
  sanitizedRuntimeCode,
  stopHost,
};
};
