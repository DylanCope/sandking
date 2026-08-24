import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createDestinationWorkerEnvironment } from "./destination-worker-environment.mjs";

const execFileAsync = promisify(execFile);
const realProviderContractUrl = new URL(
  "./production-sandcastle-adapter/sandcastle-v4.mjs",
  import.meta.url,
);

/**
 * @typedef {{
 *   REAL_PROVIDER_CODEX_VERSION: string,
 *   REAL_PROVIDER_SANDBOX_CONFIGURATION: string,
 *   REAL_PROVIDER_SANDBOX_IMAGE: string,
 *   REAL_PROVIDER_SKILL_IDENTITIES: readonly string[],
 *   realProviderAvailable: (options?: {environment?: NodeJS.ProcessEnv}) => boolean,
 *   realSandboxEngineAvailable: (options?: {environment?: NodeJS.ProcessEnv}) => boolean,
 *   realSandboxImageAvailable: (options?: {environment?: NodeJS.ProcessEnv}) => boolean,
 * }} RealProviderContract
 */

/** @returns {Promise<RealProviderContract>} */
export const loadRealProviderContract = () => import(realProviderContractUrl.href);

/**
 * @param {unknown} preparation
 * @param {string} codexVersion
 * @param {readonly string[]} skillIdentities
 */
export const pinnedRealProviderInputsReady = (
  preparation,
  codexVersion,
  skillIdentities,
) => {
  if (!preparation || typeof preparation !== "object") return false;
  const value = /** @type {any} */ (preparation);
  const codexRuntime = Array.isArray(value.executionRuntimeInputs)
    ? value.executionRuntimeInputs.find(
        (/** @type {{identity?: unknown}} */ { identity }) => identity === "openai.codex-cli",
      )
    : null;
  return codexRuntime?.version === codexVersion
    && Array.isArray(value.resolvedSkills)
    && JSON.stringify(value.resolvedSkills.map(
      (/** @type {{identity?: unknown}} */ { identity }) => identity,
    )) === JSON.stringify(skillIdentities);
};

/** @type {Promise<{ready: boolean, imageBuilt: boolean}> | null} */
let activeSandboxPreparation = null;

/**
 * Establish the pinned Docker image required by the production adapter. The
 * adapter remains the authority for every readiness predicate; this Host-side
 * operation only supplies the missing image when all other live gates pass.
 *
 * @param {{
 *   projectionPath: string,
 *   productionPreparation: unknown,
 *   environment?: NodeJS.ProcessEnv,
 *   executeFile?: typeof execFileAsync,
 *   realProviderContract?: RealProviderContract,
 * }} options
 */
export const ensureProductionProviderRuntime = async (options) => {
  const contract = options.realProviderContract ?? await loadRealProviderContract();
  const environment = options.environment ?? createDestinationWorkerEnvironment();
  const readinessOptions = { environment };
  if (
    !pinnedRealProviderInputsReady(
      options.productionPreparation,
      contract.REAL_PROVIDER_CODEX_VERSION,
      contract.REAL_PROVIDER_SKILL_IDENTITIES,
    )
    || !contract.realProviderAvailable(readinessOptions)
    || !contract.realSandboxEngineAvailable(readinessOptions)
  ) {
    return { ready: false, imageBuilt: false };
  }
  if (contract.realSandboxImageAvailable(readinessOptions)) {
    return { ready: true, imageBuilt: false };
  }
  if (activeSandboxPreparation) return activeSandboxPreparation;

  const execute = options.executeFile ?? execFileAsync;
  const projectionRoot = resolve(options.projectionPath);
  const configurationPath = join(
    projectionRoot,
    ...contract.REAL_PROVIDER_SANDBOX_CONFIGURATION.split("/"),
  );
  activeSandboxPreparation = (async () => {
    try {
      if (contract.realSandboxImageAvailable(readinessOptions)) {
        return { ready: true, imageBuilt: false };
      }
      const configuration = await lstat(configurationPath);
      if (!configuration.isFile() || configuration.isSymbolicLink()) {
        return { ready: false, imageBuilt: false };
      }
      await execute("docker", [
        "build",
        "--build-arg", `AGENT_UID=${process.getuid?.() ?? 1000}`,
        "--build-arg", `AGENT_GID=${process.getgid?.() ?? 1000}`,
        "--tag", contract.REAL_PROVIDER_SANDBOX_IMAGE,
        "--file", configurationPath,
        projectionRoot,
      ], {
        cwd: projectionRoot,
        env: environment,
        timeout: 20 * 60_000,
        maxBuffer: 1024 * 1024,
      });
      return {
        ready: contract.realSandboxImageAvailable(readinessOptions),
        imageBuilt: true,
      };
    } catch {
      return { ready: false, imageBuilt: false };
    }
  })();
  try {
    return await activeSandboxPreparation;
  } finally {
    activeSandboxPreparation = null;
  }
};
