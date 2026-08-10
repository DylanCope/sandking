import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  harnessAdapterEntryPointSchema,
  harnessAdapterProbeSchema,
  harnessLaunchParametersDeclarationSchema,
  harnessPreparedEnvelopeSchema,
  invokePinnedHarnessAdapter,
  loadPinnedHarnessAdapter,
} from "./harness-adapter-protocol.mjs";
import { harnessAdapterIdSchema } from "./harness-adapter-identity.mjs";

const execFileAsync = promisify(execFile);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const capabilitySchema = z.enum(["github.issues.read", "project.git.read"]);

const launchParameterNameSchema = z.string().min(1).max(64)
  .regex(/^[a-z][a-zA-Z0-9]*$/);
export const launchParametersSchema = z.record(launchParameterNameSchema, z.unknown())
  .superRefine((parameters, context) => {
    if (Object.keys(parameters).length > 16) {
      context.addIssue({ code: "custom", message: "too many launch parameters" });
    }
    try {
      if (Buffer.byteLength(JSON.stringify(parameters), "utf8") > 8_192) {
        context.addIssue({ code: "custom", message: "launch parameters are too large" });
      }
    } catch {
      context.addIssue({ code: "custom", message: "launch parameters are not serializable" });
    }
  }).default({});

/**
 * Validate a generic launch bag from the pinned adapter's declaration.
 * Adapter-specific relationships remain the adapter prepare command's concern.
 * @param {unknown} declaration
 * @param {unknown} parameters
 */
export const validateDeclaredLaunchParameters = (declaration, parameters) => {
  const parsedDeclaration = harnessLaunchParametersDeclarationSchema.safeParse(declaration);
  const parsedParameters = launchParametersSchema.safeParse(parameters);
  if (!parsedDeclaration.success || !parsedParameters.success) {
    throw new Error("bounded_configuration_invalid");
  }
  const fields = parsedDeclaration.data.kind === "fields"
    ? new Map(parsedDeclaration.data.fields.map((field) => [field.name, field]))
    : new Map();
  if (Object.keys(parsedParameters.data).some((name) => !fields.has(name))) {
    throw new Error("bounded_configuration_invalid");
  }
  for (const field of fields.values()) {
    const value = parsedParameters.data[field.name];
    if (value === undefined) {
      if (field.required) throw new Error("bounded_configuration_invalid");
      continue;
    }
    if (
      (field.valueType === "integer"
        && (typeof value !== "number"
          || !Number.isSafeInteger(value)
          || value < field.minimum
          || value > field.maximum))
      || (field.valueType === "string"
        && (typeof value !== "string"
          || value.length < field.minLength
          || value.length > field.maxLength))
      || (field.valueType === "boolean" && typeof value !== "boolean")
    ) {
      throw new Error("bounded_configuration_invalid");
    }
  }
  return parsedParameters.data;
};

const harnessLaunchValidationSchema = z.object({
  adapterId: harnessAdapterIdSchema,
  adapterProtocol: z.literal("1.0.0"),
  adapterEntryPoint: harnessAdapterEntryPointSchema,
  negotiatedCapabilities: z.array(z.literal("harness.launch.prepare.v1")).length(1),
  suppliedCapabilities: z.array(capabilitySchema).min(1).max(8),
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

/**
 * Validate one launch against the Project's currently pinned Harness revision.
 * This happens inside the launch action; it creates no proposal or intermediate state.
 * @param {any} context
 * @param {unknown} parameters
 */
export const validateHarnessLaunch = async (context, parameters) => {
  const launchParameters = launchParametersSchema.parse(parameters);
  const workspacePath = typeof context?.harnessWorkspacePath === "string"
    ? context.harnessWorkspacePath
    : "";
  const pinnedRevision = context?.project?.harness?.pinnedRevision;
  if (!workspacePath || !commitSchema.safeParse(pinnedRevision).success) {
    throw new Error("harness_workspace_invalid");
  }

  const environment = { LANG: "C.UTF-8" };
  /** @param {...string} args */
  const git = async (...args) => (await execFileAsync("git", ["-C", workspacePath, ...args], {
    env: environment,
    timeout: 3_000,
    maxBuffer: 32_768,
  })).stdout.trim();
  const [statusBefore, pinnedAdapter] = await Promise.all([
    git("status", "--porcelain"),
    loadPinnedHarnessAdapter({ workspacePath, pinnedRevision }),
  ]);
  if (statusBefore !== "") {
    throw new Error("harness_workspace_invalid");
  }
  if (
    pinnedAdapter.compatibility.adapterId !== context.harness.adapterId
    || context.project.harness.adapterId !== context.harness.adapterId
    || pinnedAdapter.compatibility.adapterProtocol
      !== context.project.harness.boundedConfiguration.adapterProtocol
  ) {
    throw new Error("harness_adapter_protocol_invalid");
  }
  const probedInvocation = await invokePinnedHarnessAdapter(pinnedAdapter, ["probe"]);
  const parsedProbe = harnessAdapterProbeSchema.safeParse(probedInvocation.message);
  if (!parsedProbe.success) {
    throw new Error("harness_adapter_protocol_invalid");
  }
  const probe = parsedProbe.data;
  if (
    probe.adapterId !== probedInvocation.compatibility.adapterId
    || probe.adapterProtocol !== probedInvocation.compatibility.adapterProtocol
    || JSON.stringify(probe.launchParameters)
      !== JSON.stringify(context.harness.launchParameters)
  ) {
    throw new Error("harness_adapter_protocol_invalid");
  }
  const parsedParameters = validateDeclaredLaunchParameters(
    probe.launchParameters,
    launchParameters,
  );
  const encodedParameters = Buffer.from(JSON.stringify(parsedParameters), "utf8")
    .toString("base64url");
  const preparedInvocation = await invokePinnedHarnessAdapter(
    pinnedAdapter,
    ["prepare", encodedParameters],
  );
  if (
    preparedInvocation.message
    && typeof preparedInvocation.message === "object"
    && "type" in preparedInvocation.message
    && preparedInvocation.message.type === "harness.launch.prepared"
    && "negotiatedCapabilities" in preparedInvocation.message
    && Array.isArray(preparedInvocation.message.negotiatedCapabilities)
    && !preparedInvocation.message.negotiatedCapabilities.includes("harness.launch.prepare.v1")
  ) {
    throw new Error("harness_capability_unsupported");
  }
  const parsedPrepared = harnessPreparedEnvelopeSchema.safeParse(preparedInvocation.message);
  if (!parsedPrepared.success) {
    throw new Error("harness_adapter_protocol_invalid");
  }
  const prepared = parsedPrepared.data;
  if (
    prepared.adapterId !== preparedInvocation.compatibility.adapterId
    || prepared.adapterProtocol !== preparedInvocation.compatibility.adapterProtocol
  ) {
    throw new Error("harness_adapter_protocol_invalid");
  }
  const [statusAfter, finalAdapter] = await Promise.all([
    git("status", "--porcelain"),
    loadPinnedHarnessAdapter({ workspacePath, pinnedRevision }),
  ]);
  if (statusAfter !== statusBefore) {
    throw new Error("harness_preparation_side_effect_detected");
  }
  if (finalAdapter.compatibility.entryPoint !== preparedInvocation.compatibility.entryPoint) {
    throw new Error("harness_workspace_invalid");
  }
  const { type, ...result } = prepared;
  void type;
  return harnessLaunchValidationSchema.parse({
    ...result,
    adapterEntryPoint: finalAdapter.compatibility.entryPoint,
  });
};

// Retain the established import while callers move to the adapter-neutral
// name. Both identities cross the same validation seam.
export const validateConformanceHarnessLaunch = validateHarnessLaunch;
