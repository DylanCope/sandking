import { z } from "zod";

const FRAME_HEADER_BYTES = 4;
export const MAX_HARNESS_ADAPTER_FRAME_BYTES = 32_768;

const harnessRunIdSchema = z.string().regex(/^harness-run-[a-f0-9]{24}$/);
const adapterProtocolSchema = z.literal("1.0.0");
const adapterIdSchema = z.literal("conformance-harness-adapter-v1");
const capabilitySchema = z.enum([
  "harness.launch.prepare.v1",
  "harness.run.v1",
]);

export const harnessAdapterProbeSchema = z.object({
  type: z.literal("harness.adapter.probe"),
  adapterProtocol: adapterProtocolSchema,
  adapterId: adapterIdSchema,
  capabilities: z.array(capabilitySchema).min(2).max(2),
}).strict().refine((probe) =>
  probe.capabilities.includes("harness.launch.prepare.v1")
  && probe.capabilities.includes("harness.run.v1"));

export const harnessPreparedEnvelopeSchema = z.object({
  type: z.literal("harness.launch.prepared"),
  adapterProtocol: adapterProtocolSchema,
  adapterId: adapterIdSchema,
  negotiatedCapabilities: z.array(z.literal("harness.launch.prepare.v1")).length(1),
  suppliedCapabilities: z.array(z.enum([
    "github.issues.read",
    "project.git.read",
  ])).min(1).max(8),
  sanitizedPreview: z.object({
    summary: z.string().min(1).max(512),
    secretFree: z.literal(true),
  }).strict(),
  sideEffects: z.object({
    delegatedWorkStarted: z.literal(false),
    projectWrite: z.literal(false),
    harnessWorkspaceWrite: z.literal(false),
  }).strict(),
}).strict();

export const harnessReadyEnvelopeSchema = z.object({
  type: z.literal("harness.run.ready"),
  adapterProtocol: adapterProtocolSchema,
  adapterId: adapterIdSchema,
  harnessRunId: harnessRunIdSchema,
  capabilities: z.array(z.literal("harness.run.v1")).length(1),
  readyAt: z.string().datetime(),
}).strict();

export const harnessProgressEnvelopeSchema = z.object({
  type: z.literal("harness.run.progress"),
  adapterProtocol: adapterProtocolSchema,
  adapterId: adapterIdSchema,
  harnessRunId: harnessRunIdSchema,
  record: z.object({
    recordId: z.string().regex(/^progress-[a-f0-9]{24}$/),
    schemaVersion: z.literal("1.0.0"),
    type: z.string().min(1).max(128),
    parentRecordId: z.string().regex(/^progress-[a-f0-9]{24}$/).nullable(),
    label: z.string().min(1).max(160),
    summary: z.string().min(1).max(512),
    status: z.string().min(1).max(64),
    timestamp: z.string().datetime(),
    payload: z.record(z.string(), z.unknown()),
  }).strict(),
}).strict();

export const harnessTerminalEnvelopeSchema = z.object({
  type: z.literal("harness.run.terminal"),
  adapterProtocol: adapterProtocolSchema,
  adapterId: adapterIdSchema,
  harnessRunId: harnessRunIdSchema,
  terminalId: z.string().regex(/^harness-terminal-[a-f0-9]{24}$/),
  status: z.enum(["succeeded", "failed", "cancelled"]),
  completedAt: z.string().datetime(),
  result: z.record(z.string(), z.unknown()).nullable(),
}).strict();

export const harnessAdapterMessageSchema = z.discriminatedUnion("type", [
  harnessAdapterProbeSchema,
  harnessPreparedEnvelopeSchema,
  harnessReadyEnvelopeSchema,
  harnessProgressEnvelopeSchema,
  harnessTerminalEnvelopeSchema,
]);

export class HarnessAdapterProtocolError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = "HarnessAdapterProtocolError";
    this.code = code;
  }
}

/** @type {WeakMap<import("node:stream").Readable, {buffer: Buffer, iterator: AsyncIterator<unknown>}>} */
const readerStates = new WeakMap();

/** @param {import("node:stream").Readable} stream */
const stateFor = (stream) => {
  let state = readerStates.get(stream);
  if (!state) {
    state = { buffer: Buffer.alloc(0), iterator: stream[Symbol.asyncIterator]() };
    readerStates.set(stream, state);
  }
  return state;
};

/** @param {{buffer: Buffer, iterator: AsyncIterator<unknown>}} state @param {number} count */
const fill = async (state, count) => {
  while (state.buffer.byteLength < count) {
    const next = await state.iterator.next();
    if (next.done) {
      throw new HarnessAdapterProtocolError(state.buffer.byteLength === 0
        ? "harness_adapter_channel_closed"
        : "harness_adapter_frame_truncated");
    }
    if (
      !Buffer.isBuffer(next.value)
      && typeof next.value !== "string"
      && !(next.value instanceof Uint8Array)
    ) {
      throw new HarnessAdapterProtocolError("harness_adapter_frame_invalid");
    }
    state.buffer = Buffer.concat([state.buffer, Buffer.from(next.value)]);
  }
};

/** @param {import("node:stream").Readable} stream */
export const readHarnessAdapterFrame = async (stream) => {
  const state = stateFor(stream);
  await fill(state, FRAME_HEADER_BYTES);
  const length = state.buffer.readUInt32BE(0);
  if (length < 1 || length > MAX_HARNESS_ADAPTER_FRAME_BYTES) {
    throw new HarnessAdapterProtocolError("harness_adapter_frame_size_invalid");
  }
  await fill(state, FRAME_HEADER_BYTES + length);
  const body = state.buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length);
  state.buffer = state.buffer.subarray(FRAME_HEADER_BYTES + length);
  let value;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new HarnessAdapterProtocolError("harness_adapter_frame_json_invalid");
  }
  const parsed = harnessAdapterMessageSchema.safeParse(value);
  if (!parsed.success) {
    throw new HarnessAdapterProtocolError("harness_adapter_frame_schema_invalid");
  }
  return parsed.data;
};

/** @param {import("node:stream").Writable} stream @param {unknown} message */
export const writeHarnessAdapterFrame = (stream, message) => {
  const parsed = harnessAdapterMessageSchema.safeParse(message);
  if (!parsed.success) {
    throw new HarnessAdapterProtocolError("harness_adapter_frame_schema_invalid");
  }
  const body = Buffer.from(JSON.stringify(parsed.data), "utf8");
  if (body.byteLength > MAX_HARNESS_ADAPTER_FRAME_BYTES) {
    throw new HarnessAdapterProtocolError("harness_adapter_frame_size_invalid");
  }
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(body.byteLength, 0);
  stream.write(Buffer.concat([header, body]));
};
