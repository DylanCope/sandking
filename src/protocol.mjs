import { createHash } from "node:crypto";
import { z } from "zod";

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
]);
export const HOST_SCHEMA_DIGEST = `sha256:${createHash("sha256")
  .update("sandking-host-control-schema-v1")
  .digest("hex")}`;

const identifierSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const versionSchema = z.object({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
  patch: z.number().int().nonnegative(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
}).strict().refine(
  (version) => version.version === `${version.major}.${version.minor}.${version.patch}`,
  { message: "semantic version fields must agree" },
);

export const capabilitySetSchema = z.object({
  required: z.array(identifierSchema).max(32),
  optional: z.array(identifierSchema).max(32),
}).strict();

export const framingSchema = z.object({
  maxFrameBytes: z.number().int().min(256).max(MAX_FRAME_BYTES),
  maxBulkChunkBytes: z.number().int().min(1).max(MAX_BULK_CHUNK_BYTES),
}).strict();

const helloSchema = z.object({
  type: z.literal("hello"),
  protocol: versionSchema,
  release: z.string().min(1).max(64),
  identity: identifierSchema,
  expectedPeerIdentity: identifierSchema,
  capabilities: capabilitySetSchema,
  schemaDigest: digestSchema,
  framing: framingSchema,
  observationCursor: z.string().max(256).nullable(),
}).strict();

const helloAckSchema = z.object({
  type: z.literal("hello-ack"),
  protocol: versionSchema,
  release: z.string().min(1).max(64),
  identity: identifierSchema,
  peerIdentity: identifierSchema,
  capabilities: capabilitySetSchema,
  negotiatedCapabilities: z.array(identifierSchema).max(32),
  schemaDigest: digestSchema,
  framing: framingSchema,
  observationCursor: z.string().max(256).nullable(),
}).strict();

const protocolErrorSchema = z.object({
  type: z.literal("protocol-error"),
  code: identifierSchema,
  retryable: z.boolean(),
}).strict();

const pingSchema = z.object({
  type: z.literal("ping"),
  requestId: identifierSchema,
}).strict();

const pongSchema = z.object({
  type: z.literal("pong"),
  requestId: identifierSchema,
}).strict();

export const controlMessageSchema = z.discriminatedUnion("type", [
  helloSchema,
  helloAckSchema,
  protocolErrorSchema,
  pingSchema,
  pongSchema,
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
