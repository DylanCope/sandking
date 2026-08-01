import { createHash } from "node:crypto";
import { z } from "zod";
import { protocolVersion, releaseVersion, versionSchema } from "./protocol.mjs";

export const BROWSER_PROTOCOL_VERSION = protocolVersion;
export const MAX_BROWSER_CONTROL_BYTES = 32_768;
export const MAX_BROWSER_OPAQUE_CHUNK_BYTES = 16_384;
export const browserCapabilities = Object.freeze([
  "cockpit.structured-control.v1",
  "cockpit.opaque-stream.v1",
  "cockpit.resynchronization.v1",
]);
export const runtimeRequiredBrowserCapabilities = Object.freeze([
  "cockpit.structured-control.v1",
  "cockpit.resynchronization.v1",
]);
export const runtimeOptionalBrowserCapabilities = Object.freeze([
  "cockpit.opaque-stream.v1",
]);
export const BROWSER_SCHEMA_DIGEST = `sha256:${createHash("sha256")
  .update("sandking-browser-runtime-schema-v1-with-durable-host-identity")
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

const browserControlEnvelopeSchema = z.object({
  channel: z.literal("control"),
  message: z.discriminatedUnion("type", [browserHelloSchema, browserPingSchema]),
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
    mode: z.enum(["snapshot", "resume", "resynchronize"]),
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
      runtimeId: z.string().regex(/^runtime-[a-f0-9]{24}$/),
      release: z.string().min(1).max(64),
    }).strict(),
    host: z.object({
      identity: identifierSchema,
      hostId: z.string().regex(/^host-[a-f0-9]{24}$/),
      release: z.string().min(1).max(64),
      status: z.literal("connected"),
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

export const runtimeControlEnvelopeSchema = z.object({
  channel: z.literal("control"),
  message: z.discriminatedUnion("type", [
    runtimeHelloAckSchema,
    browserProtocolErrorSchema,
    runtimePongSchema,
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
