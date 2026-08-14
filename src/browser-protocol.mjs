import { createHash } from "node:crypto";
import { z } from "zod";
import { identifierSchemas } from "./common/identifiers.mjs";
import { projectPreparationProjectionSchema } from "./project-registration.mjs";
import {
  harnessRunEventSchema,
  harnessRunOutcomeSchema,
  harnessRunSchema,
  requireHarnessRunOutcomeAdapterIdentityAgreement,
} from "./harness-runs.mjs";
import { launchParametersSchema } from "./harness-launch.mjs";
import {
  harnessRunCancelOutcomeSchema,
  harnessRunLaunchOutcomeSchema,
  harnessRunRecoverOutcomeSchema,
  protocolVersion,
  releaseVersion,
  versionSchema,
} from "./protocol.mjs";

const {
  auditIdSchema,
  hostIdSchema,
  projectIdSchema,
  runtimeIdSchema,
} = identifierSchemas(z);

export const BROWSER_PROTOCOL_VERSION = protocolVersion;
export const MAX_BROWSER_CONTROL_BYTES = 32_768;
export const MAX_BROWSER_OPAQUE_CHUNK_BYTES = 16_384;
export const MIN_TERMINAL_COLUMNS = 20;
export const MAX_TERMINAL_COLUMNS = 500;
export const MIN_TERMINAL_ROWS = 5;
export const MAX_TERMINAL_ROWS = 200;
export const browserCapabilities = Object.freeze([
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
]);
export const runtimeRequiredBrowserCapabilities = Object.freeze([
  "cockpit.structured-control.v1",
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
]);
export const runtimeOptionalBrowserCapabilities = Object.freeze([
  "cockpit.opaque-stream.v1",
]);
export const BROWSER_SCHEMA_DIGEST = `sha256:${createHash("sha256")
  .update("sandking-browser-runtime-schema-v1-with-project-registration-resolution")
  .digest("hex")}`;

const identifierSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const capabilitySetSchema = z.object({
  required: z.array(identifierSchema).max(32),
  optional: z.array(identifierSchema).max(32),
}).strict();
const browserFramingSchema = z.object({
  maxControlMessageBytes: z.number().int().positive().max(MAX_BROWSER_CONTROL_BYTES),
  maxOpaqueStreamChunkBytes: z.number().int().positive().max(MAX_BROWSER_OPAQUE_CHUNK_BYTES),
}).strict();

const hostConnectionFailureSchema = z.object({
  code: z.enum([
    "host_disconnected",
    "host_protocol_invalid",
    "host_observation_resynchronization_failed",
  ]),
  retryable: z.literal(true),
  auditId: auditIdSchema,
  observedAt: z.string().datetime(),
}).strict();

const focusedControllerSessionProjectionSchema = z.object({
  sessionId: z.string().regex(/^controller-session-[a-f0-9]{24}$/),
  focused: z.literal(true),
  provider: z.object({
    providerId: z.enum(["conformance-controller-v1", "claude-code"]),
    kind: z.enum(["conformance", "production"]),
    fixture: z.boolean(),
    adapterId: z.enum([
      "conformance-controller-adapter-v1",
      "claude-code-controller-adapter-v1",
    ]),
    adapterProtocol: z.string().regex(/^1\.[0-9]+\.[0-9]+$/),
    capabilities: z.array(identifierSchema).max(9),
    providerSessionId: z.union([
      z.string().regex(/^conformance-provider-session-[a-f0-9]{24}$/),
      z.string().uuid(),
    ]),
    readiness: z.object({
      controlProtocol: z.string().regex(/^1\.[0-9]+\.[0-9]+$/),
      signal: z.literal("provider.session.ready"),
      providerObservedTty: z.literal(true),
    }).strict(),
  }).strip(),
  terminal: z.object({
    streamId: z.string().regex(/^controller-terminal-[a-f0-9]{24}$/),
    kind: z.literal("pty"),
    runtimeOwned: z.literal(true),
    state: z.enum(["running", "exited"]),
    writableAttachment: z.object({
      attachmentId: z.string().regex(/^terminal-attachment-[a-f0-9]{24}$/),
      mode: z.literal("exclusive"),
    }).strict(),
  }).strict(),
  workContext: z.object({
    workContextId: projectIdSchema,
    kind: z.literal("project"),
    canonicalReference: z.string().regex(/^sandking:project:project-[a-f0-9]{24}$/),
  }).strict(),
}).strict();

const harnessRunObservationProjectionSchema = z.object({
  type: z.literal("harness.run.observe.result"),
  requestId: identifierSchema,
  code: z.enum(["harness_run_absent", "harness_run_observed", "resync-required"]),
  mode: z.enum(["snapshot", "resume", "resync-required"]),
  resynchronization: z.object({
    code: z.literal("resync-required"),
    reason: z.enum(["cursor_incompatible", "history_gap"]),
    requestedAfterSequence: z.number().int().nonnegative(),
    availableFromSequence: z.number().int().nonnegative(),
    canonicalSnapshot: z.literal(true),
  }).strict().nullable(),
  run: harnessRunSchema.nullable(),
  events: z.array(harnessRunEventSchema).max(1_026),
  nextSequence: z.number().int().nonnegative(),
  outcome: harnessRunOutcomeSchema.nullable(),
  logStreams: z.array(z.object({
    streamId: z.string().regex(/^harness-log-[a-f0-9]{24}$/),
    producer: z.enum(["stdout", "stderr"]),
    availableStart: z.literal(0),
    availableEnd: z.number().int().nonnegative(),
    explicitRetrievalRequired: z.literal(true),
    insertedIntoControllerConversation: z.literal(false),
  }).strict()).max(2),
  terminalEnvelopeValidation: z.object({
    adapterReadyObserved: z.boolean(),
    validTerminalEnvelopeCount: z.number().int().nonnegative(),
    exactlyOne: z.boolean(),
    adapterChannelClosedObserved: z.boolean(),
    processExitObserved: z.boolean(),
  }).strict().nullable(),
}).strict().superRefine(requireHarnessRunOutcomeAdapterIdentityAgreement);

export const browserHelloSchema = z.object({
  type: z.literal("browser.hello"),
  protocol: versionSchema,
  release: z.string().min(1).max(64),
  identity: z.literal("cockpit"),
  expectedPeerIdentity: z.literal("controller-runtime"),
  capabilities: capabilitySetSchema,
  schemaDigest: digestSchema,
  framing: browserFramingSchema,
  observationCursor: z.string().max(256).nullable(),
}).strict();

const browserPingSchema = z.object({
  type: z.literal("browser.ping"),
  requestId: identifierSchema,
}).strict();

const browserTerminalAttachSchema = z.object({
  type: z.literal("browser.terminal.attach"),
  sessionId: z.string().regex(/^controller-session-[a-f0-9]{24}$/),
  streamId: z.string().regex(/^controller-terminal-[a-f0-9]{24}$/),
  attachmentId: z.string().regex(/^terminal-attachment-[a-f0-9]{24}$/),
  mode: z.enum(["read-write", "read-only", "read-write-if-available"]),
  outputCursor: z.number().int().nonnegative(),
}).strict();

const browserTerminalResizeSchema = z.object({
  type: z.literal("browser.terminal.resize"),
  sessionId: z.string().regex(/^controller-session-[a-f0-9]{24}$/),
  streamId: z.string().regex(/^controller-terminal-[a-f0-9]{24}$/),
  attachmentId: z.string().regex(/^terminal-attachment-[a-f0-9]{24}$/),
  sequence: z.number().int().nonnegative(),
  columns: z.number().int().min(MIN_TERMINAL_COLUMNS).max(MAX_TERMINAL_COLUMNS),
  rows: z.number().int().min(MIN_TERMINAL_ROWS).max(MAX_TERMINAL_ROWS),
}).strict();

const browserHarnessRunObserveSchema = z.object({
  type: z.literal("browser.harness-run.observe"),
  requestId: identifierSchema,
  harnessRunId: z.string().regex(/^harness-run-[a-f0-9]{24}$/).nullable(),
  afterSequence: z.number().int().nonnegative(),
}).strict();

const browserHarnessRunLaunchSchema = z.object({
  type: z.literal("browser.harness-run.launch"),
  requestId: identifierSchema,
  projectId: projectIdSchema,
  parameters: launchParametersSchema.optional(),
  idempotencyKeyHash: digestSchema,
  reconnectHarnessRunId: z.string().regex(/^harness-run-[a-f0-9]{24}$/).optional(),
}).strict();

const browserHarnessRunCancelSchema = z.object({
  type: z.literal("browser.harness-run.cancel"),
  requestId: identifierSchema,
  harnessRunId: z.string().regex(/^harness-run-[a-f0-9]{24}$/),
  idempotencyKeyHash: digestSchema,
}).strict();

const browserHarnessRunRecoverSchema = z.object({
  type: z.literal("browser.harness-run.recover"),
  requestId: identifierSchema,
  harnessRunId: z.string().regex(/^harness-run-[a-f0-9]{24}$/),
  action: z.enum(["recheck", "terminate_confirmed_tree", "finalize"]),
  idempotencyKeyHash: digestSchema,
}).strict();

const browserHarnessRunLogsGetSchema = z.object({
  type: z.literal("browser.harness-run.logs.get"),
  requestId: identifierSchema,
  harnessRunId: z.string().regex(/^harness-run-[a-f0-9]{24}$/),
  producer: z.enum(["stdout", "stderr"]),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(MAX_BROWSER_OPAQUE_CHUNK_BYTES),
}).strict();

const browserControlEnvelopeSchema = z.object({
  channel: z.literal("control"),
  message: z.discriminatedUnion("type", [
    browserHelloSchema,
    browserPingSchema,
    browserTerminalAttachSchema,
    browserTerminalResizeSchema,
    browserHarnessRunLaunchSchema,
    browserHarnessRunCancelSchema,
    browserHarnessRunRecoverSchema,
    browserHarnessRunObserveSchema,
    browserHarnessRunLogsGetSchema,
  ]),
}).strict();

export const runtimeHelloAckSchema = z.object({
  type: z.literal("runtime.hello-ack"),
  protocol: versionSchema,
  release: z.string().min(1).max(64),
  identity: z.literal("controller-runtime"),
  peerIdentity: z.literal("cockpit"),
  capabilities: capabilitySetSchema,
  negotiatedCapabilities: z.array(identifierSchema).max(32),
  schemaDigest: digestSchema,
  framing: browserFramingSchema,
  observation: z.object({
    mode: z.enum(["snapshot", "resume", "resynchronize", "resynchronization-failed"]),
    cursor: z.string().min(1).max(256),
    reason: identifierSchema.optional(),
  }).strict(),
  session: z.object({
    csrfToken: z.string().regex(/^[a-f0-9]{48}$/),
    revision: z.number().int().nonnegative(),
  }).strict(),
  viewModel: z.object({
    kind: z.literal("cockpit.connection"),
    runtime: z.object({
      identity: z.literal("controller-runtime"),
      runtimeId: runtimeIdSchema,
      release: z.string().min(1).max(64),
    }).strict(),
    host: z.object({
      identity: identifierSchema,
      hostId: hostIdSchema,
      release: z.string().min(1).max(64),
      status: z.enum(["connected", "disconnected"]),
      freshness: z.enum(["current", "stale"]),
      failure: hostConnectionFailureSchema.nullable(),
    }).strict(),
    negotiation: z.object({
      protocol: versionSchema,
      capabilities: z.array(identifierSchema).max(32),
      schemaDigest: digestSchema,
      framing: z.object({
        maxFrameBytes: z.number().int().positive(),
        maxBulkChunkBytes: z.number().int().positive(),
      }).strict(),
      observationCursor: z.string().max(256).nullable(),
    }).strict(),
    projectPreparation: projectPreparationProjectionSchema,
    focusedControllerSession: focusedControllerSessionProjectionSchema.nullable(),
    controllerProviders: z.array(z.object({
      providerId: z.enum(["conformance-controller-v1", "claude-code"]),
      kind: z.enum(["conformance", "production"]),
      fixture: z.boolean(),
      adapterId: z.enum([
        "conformance-controller-adapter-v1",
        "claude-code-controller-adapter-v1",
      ]),
      adapterProtocol: z.string().regex(/^1\.[0-9]+\.[0-9]+$/),
      capabilities: z.array(identifierSchema).max(8),
      availability: z.object({
        status: z.enum(["available", "unavailable", "unauthenticated"]),
        version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/).nullable(),
        authentication: z.enum(["authenticated", "missing", "unknown", "not-applicable"]),
        source: z.enum(["destination-local", "packaged-conformance"]),
        failureCode: identifierSchema.nullable(),
      }).strict(),
      terminal: z.object({
        ptyRequired: z.literal(true),
        runtimeOwnershipRequired: z.literal(true),
      }).strict(),
    }).strict()).length(2),
    harnessRunObservation: harnessRunObservationProjectionSchema,
  }).strict(),
}).strict();

export const browserProtocolErrorSchema = z.object({
  type: z.literal("runtime.protocol-error"),
  code: identifierSchema,
  retryable: z.boolean(),
  reloadRequired: z.boolean(),
}).strict();

const runtimePongSchema = z.object({
  type: z.literal("runtime.pong"),
  requestId: identifierSchema,
}).strict();

const runtimeTerminalAttachedSchema = z.object({
  type: z.literal("runtime.terminal-attached"),
  sessionId: z.string().regex(/^controller-session-[a-f0-9]{24}$/),
  streamId: z.string().regex(/^controller-terminal-[a-f0-9]{24}$/),
  attachmentId: z.string().regex(/^terminal-attachment-[a-f0-9]{24}$/),
  mode: z.enum(["read-write", "read-only"]),
  exclusive: z.boolean(),
  requestedOutputCursor: z.number().int().nonnegative(),
  outputCursor: z.number().int().nonnegative(),
  resynchronized: z.boolean(),
  inputSequence: z.number().int().nonnegative(),
  resizeSequence: z.number().int().nonnegative(),
}).strict();

const runtimeTerminalResizedSchema = z.object({
  type: z.literal("runtime.terminal-resized"),
  sessionId: z.string().regex(/^controller-session-[a-f0-9]{24}$/),
  streamId: z.string().regex(/^controller-terminal-[a-f0-9]{24}$/),
  attachmentId: z.string().regex(/^terminal-attachment-[a-f0-9]{24}$/),
  sequence: z.number().int().nonnegative(),
  columns: z.number().int().min(MIN_TERMINAL_COLUMNS).max(MAX_TERMINAL_COLUMNS),
  rows: z.number().int().min(MIN_TERMINAL_ROWS).max(MAX_TERMINAL_ROWS),
}).strict();

const runtimeHarnessRunObservationSchema = z.object({
  type: z.literal("runtime.harness-run.observation"),
  requestId: identifierSchema,
  observation: harnessRunObservationProjectionSchema,
}).strict();

const runtimeHarnessRunLaunchResultSchema = z.object({
  type: z.literal("runtime.harness-run.launch-result"),
  requestId: identifierSchema,
  outcome: harnessRunLaunchOutcomeSchema,
}).strict();

const runtimeHarnessRunCancelResultSchema = z.object({
  type: z.literal("runtime.harness-run.cancel-result"),
  requestId: identifierSchema,
  outcome: harnessRunCancelOutcomeSchema,
}).strict();

const runtimeHarnessRunRecoverResultSchema = z.object({
  type: z.literal("runtime.harness-run.recover-result"),
  requestId: identifierSchema,
  outcome: harnessRunRecoverOutcomeSchema,
}).strict();

export const runtimeConnectionStateSchema = z.object({
  type: z.literal("runtime.connection-state"),
  boundary: z.literal("host"),
  hostId: hostIdSchema,
  status: z.literal("disconnected"),
  freshness: z.literal("stale"),
  failure: hostConnectionFailureSchema,
  affectedViews: z.tuple([
    z.literal("project-preparation"),
    z.literal("harness-run-observation"),
  ]),
  unaffectedViews: z.tuple([z.literal("controller-sessions")]),
  retainedObservationCursor: z.string().max(256).nullable(),
}).strict();

const runtimeHarnessRunLogsResultSchema = z.object({
  type: z.literal("runtime.harness-run.logs.result"),
  requestId: identifierSchema,
  code: z.literal("harness_log_range"),
  harnessRunId: z.string().regex(/^harness-run-[a-f0-9]{24}$/),
  producer: z.enum(["stdout", "stderr"]),
  streamId: z.string().regex(/^harness-log-[a-f0-9]{24}$/),
  range: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    availableEnd: z.number().int().nonnegative(),
    eof: z.boolean(),
  }).strict(),
  byteLength: z.number().int().nonnegative().max(MAX_BROWSER_OPAQUE_CHUNK_BYTES),
  sha256: digestSchema,
  insertedIntoControllerConversation: z.literal(false),
}).strict();

export const runtimeControlEnvelopeSchema = z.object({
  channel: z.literal("control"),
  message: z.discriminatedUnion("type", [
    runtimeHelloAckSchema,
    browserProtocolErrorSchema,
    runtimePongSchema,
    runtimeTerminalAttachedSchema,
    runtimeTerminalResizedSchema,
    runtimeHarnessRunLaunchResultSchema,
    runtimeHarnessRunCancelResultSchema,
    runtimeHarnessRunRecoverResultSchema,
    runtimeHarnessRunObservationSchema,
    runtimeHarnessRunLogsResultSchema,
    runtimeConnectionStateSchema,
  ]),
}).strict();

export class BrowserProtocolError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = "BrowserProtocolError";
    this.code = code;
  }
}

/** @param {unknown} input */
export const parseBrowserControl = (input) => {
  const parsed = browserControlEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new BrowserProtocolError("browser_control_schema_invalid");
  }
  return parsed.data.message;
};

/** @param {unknown} message */
export const serializeRuntimeControl = (message) => {
  const parsed = runtimeControlEnvelopeSchema.safeParse({ channel: "control", message });
  if (!parsed.success) {
    throw new BrowserProtocolError("runtime_control_schema_invalid");
  }
  return JSON.stringify(parsed.data);
};

/**
 * WebSocket text frames carry structured control. Binary frames carry this
 * compact opaque stream envelope: id length, id, sequence, EOF flag, bytes.
 * @param {{streamId: string, sequence: number, eof: boolean, data: Buffer | Uint8Array}} frame
 */
export const encodeBrowserOpaqueFrame = (frame) => {
  const id = identifierSchema.safeParse(frame.streamId);
  if (!id.success || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0) {
    throw new BrowserProtocolError("browser_opaque_metadata_invalid");
  }
  const idBytes = Buffer.from(id.data, "utf8");
  const data = Buffer.from(frame.data);
  if (idBytes.length > 255 || data.length > MAX_BROWSER_OPAQUE_CHUNK_BYTES) {
    throw new BrowserProtocolError("browser_opaque_frame_too_large");
  }
  const header = Buffer.alloc(6);
  header.writeUInt8(idBytes.length, 0);
  header.writeUInt32BE(frame.sequence, 1);
  header.writeUInt8(frame.eof ? 1 : 0, 5);
  return Buffer.concat([header, idBytes, data]);
};

/** @param {Buffer | Uint8Array} input */
export const decodeBrowserOpaqueFrame = (input) => {
  const frame = Buffer.from(input);
  if (frame.length < 6) {
    throw new BrowserProtocolError("browser_opaque_metadata_invalid");
  }
  const idLength = frame.readUInt8(0);
  const sequence = frame.readUInt32BE(1);
  const flags = frame.readUInt8(5);
  const dataOffset = 6 + idLength;
  if (dataOffset > frame.length || (flags & ~1) !== 0) {
    throw new BrowserProtocolError("browser_opaque_metadata_invalid");
  }
  const streamId = frame.subarray(6, dataOffset).toString("utf8");
  const data = frame.subarray(dataOffset);
  if (!identifierSchema.safeParse(streamId).success || data.length > MAX_BROWSER_OPAQUE_CHUNK_BYTES) {
    throw new BrowserProtocolError("browser_opaque_frame_invalid");
  }
  return { streamId, sequence, eof: Boolean(flags & 1), data };
};

export const browserProtocolMetadata = Object.freeze({
  protocol: BROWSER_PROTOCOL_VERSION,
  release: releaseVersion,
  capabilities: browserCapabilities,
  schemaDigest: BROWSER_SCHEMA_DIGEST,
});
