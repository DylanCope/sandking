import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  harnessAdapterEntryPointSchema,
  harnessPreparedEnvelopeSchema,
  loadPinnedHarnessAdapter,
  readHarnessAdapterFrame,
} from "./harness-adapter-protocol.mjs";

const execFileAsync = promisify(execFile);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const capabilitySchema = z.enum(["github.issues.read", "project.git.read"]);

export const boundedLaunchParametersSchema = z.object({
  issueNumber: z.number().int().positive().max(999_999_999),
  targetBranch: z.string().min(1).max(128).regex(/^sandcastle\/issue-[1-9][0-9]*$/),
}).strict();

export const launchParametersSchema = boundedLaunchParametersSchema.refine(
  (parameters) => parameters.targetBranch === `sandcastle/issue-${parameters.issueNumber}`,
  { message: "the conformance branch must bind the selected issue" },
);

const harnessLaunchValidationSchema = z.object({
  adapterId: z.literal("conformance-harness-adapter-v1"),
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
 * @param {import("zod").infer<typeof launchParametersSchema>} parameters
 */
export const validateConformanceHarnessLaunch = async (context, parameters) => {
  const parsedParameters = launchParametersSchema.parse(parameters);
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
  /**
   * @param {Awaited<ReturnType<typeof loadPinnedHarnessAdapter>>} pinnedAdapter
   * @param {string[]} invocationArgs
   */
  const invoke = async (pinnedAdapter, invocationArgs) => {
    if (
      pinnedAdapter.compatibility.adapterId !== context.harness.adapterId
      || pinnedAdapter.compatibility.adapterProtocol
        !== context.project.harness.boundedConfiguration.adapterProtocol
    ) {
      throw new Error("harness_adapter_protocol_invalid");
    }
    const child = spawn(process.execPath, [
      "--input-type=module",
      "--eval", pinnedAdapter.pinnedEntryPointSource,
      pinnedAdapter.compatibility.entryPoint,
      ...invocationArgs,
    ], {
      cwd: workspacePath,
      env: environment,
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

  const [statusBefore, pinnedAdapter] = await Promise.all([
    git("status", "--porcelain"),
    loadPinnedHarnessAdapter({ workspacePath, pinnedRevision }),
  ]);
  if (statusBefore !== "") {
    throw new Error("harness_workspace_invalid");
  }
  const encodedParameters = Buffer.from(JSON.stringify(parsedParameters), "utf8")
    .toString("base64url");
  const preparedInvocation = await invoke(pinnedAdapter, ["prepare", encodedParameters]);
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
  const prepared = harnessPreparedEnvelopeSchema.parse(preparedInvocation.message);
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
