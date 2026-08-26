import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { digest as sha256 } from "./common/digest.mjs";
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

const SANDBOX_CONFIGURATION_INTEGRITY_LABEL =
  "org.sandking.production-sandbox.configuration-integrity";

/** @type {Map<string, Promise<{ready: boolean, imageBuilt: boolean}>>} */
const activeSandboxPreparations = new Map();

/**
 * @param {{
 *   execute: typeof execFileAsync,
 *   environment: NodeJS.ProcessEnv,
 *   imageName: string,
 *   configurationIntegrity: string,
 * }} options
 */
const retainedImageMatchesConfiguration = async ({
  execute,
  environment,
  imageName,
  configurationIntegrity,
}) => {
  try {
    const { stdout } = await execute("docker", [
      "image", "inspect", imageName,
      `--format={{ index .Config.Labels "${SANDBOX_CONFIGURATION_INTEGRITY_LABEL}" }}`,
    ], {
      env: environment,
      timeout: 10_000,
      maxBuffer: 64_000,
    });
    return stdout.trim() === configurationIntegrity;
  } catch {
    return false;
  }
};

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

  const execute = options.executeFile ?? execFileAsync;
  const projectionRoot = resolve(options.projectionPath);
  const configurationPath = join(
    projectionRoot,
    ...contract.REAL_PROVIDER_SANDBOX_CONFIGURATION.split("/"),
  );
  let configurationIntegrity;
  try {
    const configuration = await lstat(configurationPath);
    if (!configuration.isFile() || configuration.isSymbolicLink()) {
      return { ready: false, imageBuilt: false };
    }
    configurationIntegrity = sha256(await readFile(configurationPath));
  } catch {
    return { ready: false, imageBuilt: false };
  }
  const imageMatches = () => retainedImageMatchesConfiguration({
    execute,
    environment,
    imageName: contract.REAL_PROVIDER_SANDBOX_IMAGE,
    configurationIntegrity,
  });
  if (await imageMatches()) return { ready: true, imageBuilt: false };

  const preparationKey = [
    contract.REAL_PROVIDER_SANDBOX_IMAGE,
    configurationIntegrity,
  ].join("\0");
  const activePreparation = activeSandboxPreparations.get(preparationKey);
  if (activePreparation) return activePreparation;

  const preparation = (async () => {
    try {
      await execute("docker", [
        "build",
        "--build-arg", `AGENT_UID=${process.getuid?.() ?? 1000}`,
        "--build-arg", `AGENT_GID=${process.getgid?.() ?? 1000}`,
        "--label", `${SANDBOX_CONFIGURATION_INTEGRITY_LABEL}=${configurationIntegrity}`,
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
        ready: await imageMatches(),
        imageBuilt: true,
      };
    } catch {
      return { ready: false, imageBuilt: false };
    }
  })();
  activeSandboxPreparations.set(preparationKey, preparation);
  try {
    return await preparation;
  } finally {
    if (activeSandboxPreparations.get(preparationKey) === preparation) {
      activeSandboxPreparations.delete(preparationKey);
    }
  }
};
