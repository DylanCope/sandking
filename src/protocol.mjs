import { createHash } from "node:crypto";
import { z } from "zod";
import {
  harnessRegistrationSchema,
  projectRegistrationSchema,
} from "./project-registration.mjs";
import {
  harnessRunEventSchema,
  harnessRunOutcomeSchema,
  harnessRunSchema,
  retainedLegacyHarnessRunSchema,
} from "./harness-runs.mjs";

const FRAME_HEADER_BYTES = 4;
const CONTROL_CHANNEL = 1;
const BULK_CHANNEL = 2;
const BULK_METADATA_BYTES = 7;

export const MAX_FRAME_BYTES = 65_536;
export const MAX_BULK_CHUNK_BYTES = 16_384;

export const protocolVersion = Object.freeze({
  major: 1,
  minor: 0,
  patch: 0,
  version: "1.0.0",
});

export const releaseVersion = "0.1.0";
export const hostCapabilities = Object.freeze([
  "sandking.control.slice-1",
  "sandking.bulk-stream.v1",
  "sandking.project-registration.v1",
  "sandking.conformance-harness-registration.v1",
  "sandking.harness-run.launch.v2",
  "sandking.harness-run.v2",
]);
export const HOST_SCHEMA_DIGEST = `sha256:${createHash("sha256")
  .update("sandking-host-control-schema-v1-with-immutable-execution-snapshots")
  .digest("hex")}`;

const protocolErrorDetails = Object.freeze({
  controller_identity_invalid: {
    explanation: "The Host rejected the Controller identity.",
    retryGuidance: "Verify the Controller and Host installation identities, then retry.",
  },
  controller_host_identity_mismatch: {
    explanation: "The Host rejected the Controller's expected durable Host identity.",
    retryGuidance: "Verify or explicitly adopt the intended Host identity, then retry.",
  },
  controller_protocol_major_mismatch: {
    explanation: "The Host rejected an incompatible Controller protocol major version.",
    retryGuidance: "Install matching Sand-King Controller and Host releases, then retry.",
  },
  controller_capability_unsupported: {
    explanation: "The Host rejected a required Controller capability.",
    retryGuidance: "Install compatible Sand-King Controller and Host releases, then retry.",
  },
  controller_schema_mismatch: {
    explanation: "The Host rejected an incompatible Controller control schema.",
    retryGuidance: "Install matching Sand-King Controller and Host releases, then retry.",
  },
  host_protocol_unexpected_message: {
    explanation: "The Host received an unexpected framed control message.",
    retryGuidance: "Restart both components with compatible releases, then retry.",
  },
});

/** @param {keyof typeof protocolErrorDetails} code */
export const protocolErrorForCode = (code) => ({
  type: "protocol-error",
  code,
  retryable: true,
  ...protocolErrorDetails[code],
});

const identifierSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/);
const runtimeIdSchema = z.string().regex(/^runtime-[a-f0-9]{24}$/);
const hostIdSchema = z.string().regex(/^host-[a-f0-9]{24}$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

// Known fields remain validated, while additive same-major fields are ignored
// until a negotiated capability makes them part of this implementation.
export const versionSchema = z.object({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
  patch: z.number().int().nonnegative(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
}).strip().refine(
  (version) => version.version === `${version.major}.${version.minor}.${version.patch}`,
  { message: "semantic version fields must agree" },
);

export const capabilitySetSchema = z.object({
  required: z.array(identifierSchema).max(32),
  optional: z.array(identifierSchema).max(32),
}).strip();

export const framingSchema = z.object({
  maxFrameBytes: z.number().int().min(256).max(MAX_FRAME_BYTES),
  maxBulkChunkBytes: z.number().int().min(1).max(MAX_BULK_CHUNK_BYTES),
}).strip();

const helloSchema = z.object({
  type: z.literal("hello"),
  protocol: versionSchema,
  release: z.string().min(1).max(64),
  identity: identifierSchema,
  controllerId: runtimeIdSchema,
  expectedPeerIdentity: identifierSchema,
  expectedHostId: hostIdSchema,
  capabilities: capabilitySetSchema,
  schemaDigest: digestSchema,
  framing: framingSchema,
  observationCursor: z.string().max(256).nullable(),
}).strip();

const helloAckSchema = z.object({
  type: z.literal("hello-ack"),
  protocol: versionSchema,
  release: z.string().min(1).max(64),
  identity: identifierSchema,
  hostId: hostIdSchema,
  peerIdentity: identifierSchema,
  peerControllerId: runtimeIdSchema,
  capabilities: capabilitySetSchema,
  negotiatedCapabilities: z.array(identifierSchema).max(32),
  schemaDigest: digestSchema,
  framing: framingSchema,
  observationCursor: z.string().max(256).nullable(),
}).strip();

const protocolErrorSchema = z.object({
  type: z.literal("protocol-error"),
  code: identifierSchema,
  retryable: z.boolean(),
  explanation: z.string().min(1).max(512),
  retryGuidance: z.string().min(1).max(512),
}).strip();

const pingSchema = z.object({
  type: z.literal("ping"),
  requestId: identifierSchema,
}).strip();

const pongSchema = z.object({
  type: z.literal("pong"),
  requestId: identifierSchema,
}).strip();

const hostIdentityAuthorizationClass = z.literal("controller_host_identity_binding");
const hostIdentityAcceptSchema = z.object({
  type: z.literal("host.identity.accept"),
  requestId: identifierSchema,
  hostId: hostIdSchema,
  authorizationClass: hostIdentityAuthorizationClass,
  idempotencyKey: z.string().min(1).max(256),
  expectedRevision: z.number().int().nonnegative(),
}).strip();

const hostIdentityResultSchema = z.object({
  type: z.literal("host.identity.result"),
  requestId: identifierSchema,
  code: z.literal("host_identity_accepted"),
  authorizationClass: hostIdentityAuthorizationClass,
  idempotencyKeyHash: digestSchema,
  expectedRevision: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  idempotentReplay: z.boolean(),
  hostId: hostIdSchema,
  auditId: z.string().regex(/^audit-[a-f0-9]{24}$/),
}).strip();

const hostIdentityFailureSchema = z.object({
  type: z.literal("host.identity.failure"),
  requestId: identifierSchema,
  code: z.enum([
    "host_identity_mismatch",
    "idempotency_key_conflict",
    "mutation_revision_conflict",
  ]),
  retryable: z.boolean(),
  authorizationClass: hostIdentityAuthorizationClass,
  idempotencyKeyHash: digestSchema,
  expectedRevision: z.number().int().nonnegative(),
  actualRevision: z.number().int().nonnegative(),
  auditId: z.string().regex(/^audit-[a-f0-9]{24}$/),
}).strip();

const projectPathSchema = z.string().max(4_096);
const projectInspectSchema = z.object({
  type: z.literal("project.inspect"),
  requestId: identifierSchema,
  path: projectPathSchema,
}).strip();
const projectInspectResultSchema = z.object({
  type: z.literal("project.inspect.result"),
  requestId: identifierSchema,
  code: z.enum(["project_unregistered", "project_registered"]),
  actualRevision: z.number().int().nonnegative(),
  project: projectRegistrationSchema.nullable(),
}).strip();
const projectRegisterSchema = z.object({
  type: z.literal("project.register"),
  requestId: identifierSchema,
  path: projectPathSchema,
  configuration: z.unknown(),
  authorizationClass: z.literal("host_local_project_registration"),
  idempotencyKey: z.string().max(256),
  expectedRevision: z.number().int().nonnegative(),
}).strip();
const projectRegisterResultSchema = z.object({
  type: z.literal("project.register.result"),
  requestId: identifierSchema,
  code: z.enum(["project_registered", "project_registration_reused"]),
  authorizationClass: z.literal("host_local_project_registration"),
  idempotencyKeyHash: digestSchema,
  expectedRevision: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  idempotentReplay: z.boolean(),
  auditId: z.string().regex(/^audit-[a-f0-9]{24}$/),
  project: projectRegistrationSchema,
}).strip();
const harnessConformanceInspectSchema = z.object({
  type: z.literal("harness.conformance.inspect"),
  requestId: identifierSchema,
}).strip();
const harnessConformanceInspectResultSchema = z.object({
  type: z.literal("harness.conformance.inspect.result"),
  requestId: identifierSchema,
  code: z.enum([
    "conformance_harness_unregistered",
    "conformance_harness_registered",
  ]),
  actualRevision: z.number().int().nonnegative(),
  harness: harnessRegistrationSchema.nullable(),
}).strip();
const harnessConformanceRegisterSchema = z.object({
  type: z.literal("harness.conformance.register"),
  requestId: identifierSchema,
  name: z.string().max(120),
  authorizationClass: z.literal("host_local_harness_registration"),
  idempotencyKey: z.string().max(256),
  expectedRevision: z.number().int().nonnegative(),
}).strip();
const harnessConformanceRegisterResultSchema = z.object({
  type: z.literal("harness.conformance.register.result"),
  requestId: identifierSchema,
  code: z.enum([
    "conformance_harness_registered",
    "conformance_harness_registration_reused",
  ]),
  authorizationClass: z.literal("host_local_harness_registration"),
  idempotencyKeyHash: digestSchema,
  expectedRevision: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  idempotentReplay: z.boolean(),
  auditId: z.string().regex(/^audit-[a-f0-9]{24}$/),
  harness: harnessRegistrationSchema,
}).strip();
const projectHarnessPinSchema = z.object({
  type: z.literal("project.harness.pin"),
  requestId: identifierSchema,
  projectId: z.string().regex(/^project-[a-f0-9]{24}$/),
  harnessId: z.string().regex(/^harness-[a-f0-9]{24}$/),
  immutableRevision: z.string().max(64),
  boundedConfiguration: z.unknown(),
  authorizationClass: z.literal("host_local_project_configuration"),
  idempotencyKey: z.string().max(256),
  expectedRevision: z.number().int().nonnegative(),
}).strip();
const projectHarnessPinResultSchema = z.object({
  type: z.literal("project.harness.pin.result"),
  requestId: identifierSchema,
  code: z.enum(["project_harness_pinned", "project_harness_pin_reused"]),
  authorizationClass: z.literal("host_local_project_configuration"),
  idempotencyKeyHash: digestSchema,
  expectedRevision: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  idempotentReplay: z.boolean(),
  auditId: z.string().regex(/^audit-[a-f0-9]{24}$/),
  project: projectRegistrationSchema,
  harness: harnessRegistrationSchema,
}).strip();
const projectOperationFailureSchema = z.object({
  type: z.literal("project.operation.failure"),
  requestId: identifierSchema,
  operation: z.enum([
    "project.inspect",
    "project.register",
    "harness.conformance.register",
    "project.harness.pin",
  ]),
  code: z.enum([
    "mutation_contract_invalid",
    "idempotency_key_conflict",
    "mutation_revision_conflict",
    "bounded_configuration_invalid",
    "project_configuration_conflict",
    "project_path_invalid",
    "project_path_missing",
    "project_path_moved",
    "project_path_replaced",
    "project_path_conflict",
    "project_path_tombstoned",
    "project_not_found",
    "harness_not_found",
    "harness_pin_missing",
    "harness_pin_invalid",
    "harness_workspace_invalid",
  ]),
  retryable: z.boolean(),
  authorizationClass: z.enum([
    "host_local_project_registration",
    "host_local_harness_registration",
    "host_local_project_configuration",
  ]).nullable(),
  idempotencyKeyHash: digestSchema.nullable(),
  expectedRevision: z.number().int().nonnegative().nullable(),
  actualRevision: z.number().int().nonnegative(),
  auditId: z.string().regex(/^audit-[a-f0-9]{24}$/),
  resolution: z.object({
    summary: identifierSchema,
    actions: z.array(identifierSchema).min(1).max(4),
  }).strip(),
  prohibitedSideEffects: z.object({
    directoryScan: z.literal(false),
    projectFileWrite: z.literal(false),
    harnessWorkspaceWrite: z.literal(false),
    harnessPinWrite: z.literal(false),
    approvalRequest: z.literal(false),
  }).strip(),
}).strip();

const harnessRunAuthorizationClassSchema = z.literal("harness_run_launch");
const harnessRunLaunchSourceSchema = z.enum(["controller-cli", "cockpit"]);
const harnessRunLaunchSchema = z.object({
  type: z.literal("harness.run.launch"),
  requestId: identifierSchema,
  projectId: z.string().regex(/^project-[a-f0-9]{24}$/),
  parameters: z.unknown().optional(),
  controllerId: runtimeIdSchema,
  controllerSessionId: z.string()
    .regex(/^controller-session-[a-f0-9]{24}$/)
    .nullable(),
  source: harnessRunLaunchSourceSchema,
  authorizationClass: harnessRunAuthorizationClassSchema,
  idempotencyKeyHash: digestSchema,
}).strip();
export const harnessRunLaunchResultSchema = z.object({
  type: z.literal("harness.run.launch.result"),
  requestId: identifierSchema,
  code: z.enum(["harness_run_created", "harness_run_found"]),
  authorizationClass: harnessRunAuthorizationClassSchema,
  idempotencyKeyHash: digestSchema,
  revision: z.number().int().positive(),
  idempotentReplay: z.boolean(),
  auditId: z.string().regex(/^audit-[a-f0-9]{24}$/),
  run: harnessRunSchema,
}).strip();
export const harnessRunLaunchFailureSchema = z.object({
  type: z.literal("harness.run.launch.failure"),
  requestId: identifierSchema,
  code: z.enum([
    "mutation_contract_invalid",
    "idempotency_key_conflict",
    "bounded_configuration_invalid",
    "project_not_found",
    "harness_not_found",
    "harness_pin_missing",
    "harness_pin_invalid",
    "harness_workspace_invalid",
    "harness_capability_unsupported",
    "harness_adapter_protocol_invalid",
    "harness_preparation_side_effect_detected",
  ]),
  retryable: z.boolean(),
  authorizationClass: harnessRunAuthorizationClassSchema,
  idempotencyKeyHash: digestSchema.nullable(),
  idempotentReplay: z.boolean(),
  auditId: z.string().regex(/^audit-[a-f0-9]{24}$/),
  prohibitedSideEffects: z.object({
    harnessRunCreated: z.literal(false),
    projectWrite: z.literal(false),
  }).strict(),
}).strip();
export const harnessRunLaunchOutcomeSchema = z.union([
  harnessRunLaunchResultSchema,
  harnessRunLaunchFailureSchema,
]);
// Retained v1 mutation outcomes remain lookup-readable after the command that
// created them is retired. These schemas are nested historical data only;
// `harness.run.start` is not restored as an accepted top-level operation.
const legacyHarnessRunStartAuthorizationClassSchema = z.literal(
  "approved_launch_request_execution",
);
const legacyHarnessRunStartResultSchema = z.object({
  type: z.literal("harness.run.start.result"),
  requestId: identifierSchema,
  code: z.enum(["harness_run_created", "harness_run_found"]),
  authorizationClass: legacyHarnessRunStartAuthorizationClassSchema,
  idempotencyKeyHash: digestSchema,
  expectedRevision: z.number().int().positive(),
  launchRequestRevision: z.number().int().positive(),
  revision: z.number().int().positive(),
  idempotentReplay: z.boolean(),
  auditId: z.string().regex(/^audit-[a-f0-9]{24}$/),
  run: retainedLegacyHarnessRunSchema,
}).strip();
const legacyHarnessRunStartFailureSchema = z.object({
  type: z.literal("harness.run.start.failure"),
  requestId: identifierSchema,
  code: z.enum([
    "mutation_contract_invalid",
    "idempotency_key_conflict",
    "mutation_revision_conflict",
    "authorization_failed",
    "launch_request_not_found",
    "launch_request_unapproved",
    "launch_request_terminal",
    "launch_request_expired",
    "launch_request_stale",
    "launch_request_already_started",
  ]),
  retryable: z.boolean(),
  authorizationClass: legacyHarnessRunStartAuthorizationClassSchema,
  idempotencyKeyHash: digestSchema.nullable(),
  expectedRevision: z.number().int().nonnegative().nullable(),
  actualRevision: z.number().int().nonnegative(),
  idempotentReplay: z.boolean(),
  auditId: z.string().regex(/^audit-[a-f0-9]{24}$/),
  current: z.object({}).passthrough().nullable(),
  prohibitedSideEffects: z.object({
    harnessRunStarted: z.literal(false),
    projectWrite: z.literal(false),
  }).strict(),
}).strip();
const retainedHarnessRunMutationOutcomeSchema = z.union([
  harnessRunLaunchOutcomeSchema,
  legacyHarnessRunStartResultSchema,
  legacyHarnessRunStartFailureSchema,
]);
const harnessRunLookupSchema = z.object({
  type: z.literal("harness.run.lookup"),
  requestId: identifierSchema,
  idempotencyKeyHash: digestSchema,
}).strip();
const harnessRunLookupResultSchema = z.object({
  type: z.literal("harness.run.lookup.result"),
  requestId: identifierSchema,
  code: z.enum([
    "harness_run_launch_outcome_found",
    "harness_run_launch_outcome_absent",
  ]),
  idempotencyKeyHash: digestSchema.nullable(),
  found: z.boolean(),
  launchOutcome: retainedHarnessRunMutationOutcomeSchema.nullable(),
}).strip();
const harnessRunObserveSchema = z.object({
  type: z.literal("harness.run.observe"),
  requestId: identifierSchema,
  harnessRunId: z.string().regex(/^harness-run-[a-f0-9]{24}$/).nullable(),
  afterSequence: z.number().int().nonnegative(),
}).strip();
const harnessLogStreamProjectionSchema = z.object({
  streamId: z.string().regex(/^harness-log-[a-f0-9]{24}$/),
  producer: z.enum(["stdout", "stderr"]),
  availableStart: z.literal(0),
  availableEnd: z.number().int().nonnegative(),
  explicitRetrievalRequired: z.literal(true),
  insertedIntoControllerConversation: z.literal(false),
}).strict();
const terminalEnvelopeValidationSchema = z.object({
  adapterReadyObserved: z.boolean(),
  validTerminalEnvelopeCount: z.number().int().nonnegative(),
  exactlyOne: z.boolean(),
  adapterChannelClosedObserved: z.boolean(),
  processExitObserved: z.boolean(),
}).strict();
const harnessRunObserveResultSchema = z.object({
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
  events: z.array(harnessRunEventSchema).max(1_024),
  nextSequence: z.number().int().nonnegative(),
  outcome: harnessRunOutcomeSchema.nullable(),
  logStreams: z.array(harnessLogStreamProjectionSchema).max(2),
  terminalEnvelopeValidation: terminalEnvelopeValidationSchema.nullable(),
}).strip();
const harnessRunLogsGetSchema = z.object({
  type: z.literal("harness.run.logs.get"),
  requestId: identifierSchema,
  harnessRunId: z.string().regex(/^harness-run-[a-f0-9]{24}$/),
  producer: z.enum(["stdout", "stderr"]),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(MAX_BULK_CHUNK_BYTES),
}).strip();
const harnessRunLogsResultSchema = z.object({
  type: z.literal("harness.run.logs.result"),
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
  byteLength: z.number().int().nonnegative().max(MAX_BULK_CHUNK_BYTES),
  sha256: digestSchema,
  insertedIntoControllerConversation: z.literal(false),
}).strip();
const harnessRunOperationFailureSchema = z.object({
  type: z.literal("harness.run.operation.failure"),
  requestId: identifierSchema,
  operation: z.enum(["harness.run.observe", "harness.run.logs.get"]),
  code: z.enum(["harness_run_not_found", "harness_log_range_invalid"]),
  retryable: z.boolean(),
}).strip();

export const controlMessageSchema = z.discriminatedUnion("type", [
  helloSchema,
  helloAckSchema,
  protocolErrorSchema,
  pingSchema,
  pongSchema,
  hostIdentityAcceptSchema,
  hostIdentityResultSchema,
  hostIdentityFailureSchema,
  projectInspectSchema,
  projectInspectResultSchema,
  projectRegisterSchema,
  projectRegisterResultSchema,
  harnessConformanceInspectSchema,
  harnessConformanceInspectResultSchema,
  harnessConformanceRegisterSchema,
  harnessConformanceRegisterResultSchema,
  projectHarnessPinSchema,
  projectHarnessPinResultSchema,
  projectOperationFailureSchema,
  harnessRunLaunchSchema,
  harnessRunLaunchResultSchema,
  harnessRunLaunchFailureSchema,
  harnessRunLookupSchema,
  harnessRunLookupResultSchema,
  harnessRunObserveSchema,
  harnessRunObserveResultSchema,
  harnessRunLogsGetSchema,
  harnessRunLogsResultSchema,
  harnessRunOperationFailureSchema,
]);

export class ProtocolError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]
   */
  constructor(code, message = code) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

/** @type {WeakMap<import("node:stream").Readable, {buffer: Buffer, iterator: AsyncIterator<unknown>}>} */
const readerStates = new WeakMap();

/**
 * @param {import("node:stream").Readable} stream
 */
const readerStateFor = (stream) => {
  let state = readerStates.get(stream);
  if (!state) {
    state = {
      buffer: Buffer.alloc(0),
      iterator: stream[Symbol.asyncIterator](),
    };
    readerStates.set(stream, state);
  }
  return state;
};

/**
 * @param {{buffer: Buffer, iterator: AsyncIterator<unknown>}} state
 * @param {number} byteCount
 */
const fillBuffer = async (state, byteCount) => {
  while (state.buffer.length < byteCount) {
    const next = await state.iterator.next();
    if (next.done) {
      throw new ProtocolError(
        "frame_truncated",
        "Protocol stream ended before a complete frame arrived.",
      );
    }
    const chunk = Buffer.isBuffer(next.value)
      ? next.value
      : Buffer.from(/** @type {string | Uint8Array} */ (next.value));
    state.buffer = Buffer.concat([state.buffer, chunk]);
  }
};

/**
 * @param {import("node:stream").Writable} stream
 * @param {number} channel
 * @param {Buffer} body
 */
const writeWireFrame = (stream, channel, body) => {
  const frameLength = body.length + 1;
  if (frameLength > MAX_FRAME_BYTES) {
    throw new ProtocolError("frame_size_invalid");
  }
  const header = Buffer.alloc(FRAME_HEADER_BYTES + 1);
  header.writeUInt32BE(frameLength, 0);
  header.writeUInt8(channel, FRAME_HEADER_BYTES);
  stream.write(Buffer.concat([header, body]));
};

/**
 * Write a validated structured-control frame.
 * @param {import("node:stream").Writable} stream
 * @param {unknown} payload
 */
export const writeFrame = (stream, payload) => {
  const parsed = controlMessageSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProtocolError("frame_schema_invalid");
  }
  writeWireFrame(stream, CONTROL_CHANNEL, Buffer.from(JSON.stringify(parsed.data), "utf8"));
};

/**
 * Write an opaque bulk-stream frame. Bulk bytes never enter the JSON control schema.
 * @param {import("node:stream").Writable} stream
 * @param {{streamId: string, sequence: number, eof: boolean, data: Buffer | Uint8Array}} frame
 */
export const writeBulkFrame = (stream, frame) => {
  const streamId = identifierSchema.safeParse(frame.streamId);
  if (!streamId.success || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0) {
    throw new ProtocolError("bulk_metadata_invalid");
  }
  const data = Buffer.from(frame.data);
  if (data.length > MAX_BULK_CHUNK_BYTES) {
    throw new ProtocolError("bulk_chunk_too_large");
  }
  const streamIdBytes = Buffer.from(streamId.data, "utf8");
  if (streamIdBytes.length > 255) {
    throw new ProtocolError("bulk_metadata_invalid");
  }

  const metadata = Buffer.alloc(BULK_METADATA_BYTES);
  metadata.writeUInt8(frame.eof ? 1 : 0, 0);
  metadata.writeUInt16BE(streamIdBytes.length, 1);
  metadata.writeUInt32BE(frame.sequence, 3);
  writeWireFrame(
    stream,
    BULK_CHANNEL,
    Buffer.concat([metadata, streamIdBytes, data]),
  );
};

/**
 * @param {import("node:stream").Readable} stream
 * @returns {Promise<
 *   | {channel: "control", message: z.infer<typeof controlMessageSchema>}
 *   | {channel: "bulk", streamId: string, sequence: number, eof: boolean, data: Buffer}
 * >}
 */
export const readProtocolFrame = async (stream) => {
  const state = readerStateFor(stream);
  await fillBuffer(state, FRAME_HEADER_BYTES);
  const frameLength = state.buffer.readUInt32BE(0);
  if (frameLength < 1 || frameLength > MAX_FRAME_BYTES) {
    throw new ProtocolError("frame_size_invalid");
  }

  await fillBuffer(state, FRAME_HEADER_BYTES + frameLength);
  const frame = state.buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + frameLength);
  state.buffer = state.buffer.subarray(FRAME_HEADER_BYTES + frameLength);

  const channel = frame.readUInt8(0);
  const body = frame.subarray(1);
  if (channel === CONTROL_CHANNEL) {
    let json;
    try {
      json = JSON.parse(body.toString("utf8"));
    } catch {
      throw new ProtocolError("frame_json_invalid");
    }
    const parsed = controlMessageSchema.safeParse(json);
    if (!parsed.success) {
      throw new ProtocolError("frame_schema_invalid");
    }
    return { channel: "control", message: parsed.data };
  }

  if (channel === BULK_CHANNEL) {
    if (body.length < BULK_METADATA_BYTES) {
      throw new ProtocolError("bulk_metadata_invalid");
    }
    const flags = body.readUInt8(0);
    const streamIdLength = body.readUInt16BE(1);
    const sequence = body.readUInt32BE(3);
    const dataOffset = BULK_METADATA_BYTES + streamIdLength;
    if ((flags & ~1) !== 0 || dataOffset > body.length) {
      throw new ProtocolError("bulk_metadata_invalid");
    }
    const streamId = body.subarray(BULK_METADATA_BYTES, dataOffset).toString("utf8");
    if (!identifierSchema.safeParse(streamId).success) {
      throw new ProtocolError("bulk_metadata_invalid");
    }
    const data = body.subarray(dataOffset);
    if (data.length > MAX_BULK_CHUNK_BYTES) {
      throw new ProtocolError("bulk_chunk_too_large");
    }
    return { channel: "bulk", streamId, sequence, eof: Boolean(flags & 1), data };
  }

  throw new ProtocolError("frame_channel_invalid");
};

/**
 * Read one structured-control message.
 * @param {import("node:stream").Readable} stream
 */
export const readFrame = async (stream) => {
  const frame = await readProtocolFrame(stream);
  if (frame.channel !== "control") {
    throw new ProtocolError("unexpected_bulk_frame");
  }
  return frame.message;
};
