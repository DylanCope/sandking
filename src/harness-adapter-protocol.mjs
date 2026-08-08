import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const FRAME_HEADER_BYTES = 4;
export const MAX_HARNESS_ADAPTER_FRAME_BYTES = 32_768;

const harnessRunIdSchema = z.string().regex(/^harness-run-[a-f0-9]{24}$/);
const adapterProtocolSchema = z.literal("1.0.0");
const adapterIdSchema = z.literal("conformance-harness-adapter-v1");
export const harnessAdapterEntryPointSchema = z.string().min(1).max(256)
  .regex(/^[a-zA-Z0-9._/-]+\.mjs$/)
  .refine((value) =>
    !value.startsWith("/")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."));
export const harnessCompatibilityManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1).max(120),
  compatibility: z.object({
    adapterId: adapterIdSchema,
    adapterProtocol: adapterProtocolSchema,
    entryPoint: harnessAdapterEntryPointSchema,
  }).strict(),
}).strict();
const capabilitySchema = z.enum([
  "harness.launch.prepare.v1",
  "harness.run.v1",
]);

const launchParameterNameSchema = z.string().min(1).max(64)
  .regex(/^[a-z][a-zA-Z0-9]*$/);
const launchParameterBase = {
  name: launchParameterNameSchema,
  label: z.string().min(1).max(80),
  description: z.string().min(1).max(240).optional(),
  cliFlag: z.string().min(3).max(66).regex(/^--[a-z][a-z0-9-]*$/).optional(),
  required: z.boolean(),
};
export const harnessLaunchParameterFieldSchema = z.discriminatedUnion("valueType", [
  z.object({
    ...launchParameterBase,
    valueType: z.literal("integer"),
    minimum: z.number().int().safe(),
    maximum: z.number().int().safe(),
  }).strict().refine((field) => field.minimum <= field.maximum),
  z.object({
    ...launchParameterBase,
    valueType: z.literal("string"),
    minLength: z.number().int().nonnegative().max(4_096),
    maxLength: z.number().int().positive().max(4_096),
  }).strict().refine((field) => field.minLength <= field.maxLength),
  z.object({
    ...launchParameterBase,
    valueType: z.literal("boolean"),
  }).strict(),
]);
export const harnessLaunchParametersDeclarationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({
    kind: z.literal("fields"),
    fields: z.array(harnessLaunchParameterFieldSchema).max(16),
  }).strict().superRefine((declaration, context) => {
    const names = new Set();
    const cliFlags = new Set();
    for (const [index, field] of declaration.fields.entries()) {
      if (names.has(field.name)) {
        context.addIssue({
          code: "custom",
          message: "launch parameter names must be unique",
          path: ["fields", index, "name"],
        });
      }
      names.add(field.name);
      if (field.cliFlag && cliFlags.has(field.cliFlag)) {
        context.addIssue({
          code: "custom",
          message: "launch parameter CLI flags must be unique",
          path: ["fields", index, "cliFlag"],
        });
      }
      if (field.cliFlag) cliFlags.add(field.cliFlag);
    }
  }),
]);

// Current conformance probes explicitly widen both historical parameters to
// optional. This declaration is adapter-owned and is not used as the fallback
// for immutable probes created before declarations existed.
export const conformanceHarnessLaunchParametersDeclaration =
  harnessLaunchParametersDeclarationSchema.parse({
    kind: "fields",
    fields: [
      {
        name: "issueNumber",
        label: "Issue number",
        description: "Optional GitHub issue identifier for the conformance run.",
        cliFlag: "--issue",
        valueType: "integer",
        required: false,
        minimum: 1,
        maximum: 999_999_999,
      },
      {
        name: "targetBranch",
        label: "Target branch",
        description: "Optional sandcastle branch associated with the issue.",
        cliFlag: "--target-branch",
        valueType: "string",
        required: false,
        minLength: 1,
        maxLength: 128,
      },
    ],
  });
if (conformanceHarnessLaunchParametersDeclaration.kind !== "fields") {
  throw new Error("conformance_launch_parameters_invalid");
}

// Adapter protocol 1.0.0 originally required this conformance-only shape in
// the adapter implementation even though its probe did not declare it. Keep
// that exact contract when interpreting immutable legacy bytes: presenting the
// new optional declaration would allow a launch that the pinned adapter must
// reject. Fresh probes above explicitly advertise the widened contract.
export const legacyConformanceHarnessLaunchParametersDeclaration =
  harnessLaunchParametersDeclarationSchema.parse({
    kind: "fields",
    fields: conformanceHarnessLaunchParametersDeclaration.fields.map((field) => ({
      ...field,
      description: field.name === "issueNumber"
        ? "GitHub issue identifier required by this retained conformance Harness."
        : "Sandcastle branch required by this retained conformance Harness.",
      required: true,
    })),
  });

export const harnessAdapterProbeSchema = z.object({
  type: z.literal("harness.adapter.probe"),
  adapterProtocol: adapterProtocolSchema,
  adapterId: adapterIdSchema,
  capabilities: z.array(capabilitySchema).min(2).max(2),
  launchParameters: harnessLaunchParametersDeclarationSchema
    .default(legacyConformanceHarnessLaunchParametersDeclaration),
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

export const harnessCancellationRequestSchema = z.object({
  type: z.literal("harness.run.cancel"),
  adapterProtocol: adapterProtocolSchema,
  adapterId: adapterIdSchema,
  harnessRunId: harnessRunIdSchema,
  cooperativeDeadlineAt: z.string().datetime(),
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

/**
 * Resolve the adapter only from the pinned Harness revision's declared
 * compatibility envelope, while requiring the checked-out workspace to still
 * contain those exact committed bytes.
 * @param {{workspacePath: string, pinnedRevision: string}} options
 */
export const loadPinnedHarnessAdapter = async ({ workspacePath, pinnedRevision }) => {
  const environment = { LANG: "C.UTF-8" };
  let pinnedManifestSource;
  let workspaceManifestSource;
  let observedHead;
  try {
    [{ stdout: pinnedManifestSource }, workspaceManifestSource, { stdout: observedHead }] =
      await Promise.all([
        execFileAsync("git", [
          "-C", workspacePath,
          "show", `${pinnedRevision}:harness.json`,
        ], { env: environment, timeout: 3_000, maxBuffer: 32_768 }),
        readFile(join(workspacePath, "harness.json"), "utf8"),
        execFileAsync("git", ["-C", workspacePath, "rev-parse", "HEAD"], {
          env: environment,
          timeout: 3_000,
          maxBuffer: 32_768,
        }),
      ]);
  } catch {
    throw new Error("harness_workspace_invalid");
  }
  if (
    workspaceManifestSource !== pinnedManifestSource
    || observedHead.trim() !== pinnedRevision
  ) {
    throw new Error("harness_workspace_invalid");
  }

  let manifest;
  try {
    manifest = harnessCompatibilityManifestSchema.parse(JSON.parse(pinnedManifestSource));
  } catch {
    throw new Error("harness_adapter_protocol_invalid");
  }
  const entryPointPath = join(workspacePath, ...manifest.compatibility.entryPoint.split("/"));
  let pinnedEntryPointSource;
  try {
    ({ stdout: pinnedEntryPointSource } = await execFileAsync("git", [
      "-C", workspacePath,
      "show", `${pinnedRevision}:${manifest.compatibility.entryPoint}`,
    ], { env: environment, timeout: 3_000, maxBuffer: 256_000 }));
  } catch {
    throw new Error("harness_adapter_protocol_invalid");
  }
  let workspaceEntryPointSource;
  try {
    workspaceEntryPointSource = await readFile(entryPointPath, "utf8");
  } catch {
    throw new Error("harness_workspace_invalid");
  }
  if (workspaceEntryPointSource !== pinnedEntryPointSource) {
    throw new Error("harness_workspace_invalid");
  }
  return {
    compatibility: manifest.compatibility,
    entryPointPath,
    pinnedEntryPointSource,
    workspacePath,
  };
};

/**
 * Invoke the exact pinned adapter bytes across the framed protocol channel.
 * @param {Awaited<ReturnType<typeof loadPinnedHarnessAdapter>>} pinnedAdapter
 * @param {string[]} invocationArgs
 */
export const invokePinnedHarnessAdapter = async (pinnedAdapter, invocationArgs) => {
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval", pinnedAdapter.pinnedEntryPointSource,
    pinnedAdapter.compatibility.entryPoint,
    ...invocationArgs,
  ], {
    cwd: pinnedAdapter.workspacePath,
    env: { LANG: "C.UTF-8" },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const adapterChannel = child.stdio[3];
  if (!adapterChannel || !("readable" in adapterChannel)) {
    child.kill("SIGKILL");
    throw new Error("harness_adapter_protocol_invalid");
  }
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3_000);
  try {
    const [message, exit] = await Promise.all([
      readHarnessAdapterFrame(adapterChannel),
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }),
    ]);
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error("harness_adapter_protocol_invalid");
    }
    return { message, compatibility: pinnedAdapter.compatibility };
  } catch {
    throw new Error("harness_adapter_protocol_invalid");
  } finally {
    clearTimeout(timeout);
  }
};

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
