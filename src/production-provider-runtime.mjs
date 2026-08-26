import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { digest as sha256 } from "./common/digest.mjs";
import { createDestinationWorkerEnvironment } from "./destination-worker-environment.mjs";
import { isDockerEndpoint } from "./real-delegation-protocol.mjs";

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
const SANDBOX_AGENT_UID_LABEL = "org.sandking.production-sandbox.agent-uid";
const SANDBOX_AGENT_GID_LABEL = "org.sandking.production-sandbox.agent-gid";

/** @type {Map<string, Promise<{ready: boolean, imageBuilt: boolean, dockerEndpoint?: string, sandboxImageId?: string}>>} */
const activeSandboxPreparations = new Map();

/**
 * Resolve the endpoint selected by the same Docker CLI configuration used for
 * readiness. Subsequent operations bind that endpoint explicitly so a later
 * context selection cannot redirect the image verification or execution.
 *
 * @param {{execute: typeof execFileAsync, environment: NodeJS.ProcessEnv}} options
 */
const resolveDockerEndpoint = async ({ execute, environment }) => {
  const configuredEndpoint = environment.DOCKER_HOST;
  if (isDockerEndpoint(configuredEndpoint)) {
    return configuredEndpoint;
  }
  const context = environment.DOCKER_CONTEXT;
  const { stdout } = await execute("docker", [
    "context", "inspect",
    ...(context ? [context] : []),
    "--format={{json .Endpoints.docker.Host}}",
  ], {
    env: environment,
    timeout: 10_000,
    maxBuffer: 64_000,
  });
  const endpoint = JSON.parse(stdout);
  if (!isDockerEndpoint(endpoint)) {
    throw new Error("production_docker_endpoint_invalid");
  }
  return endpoint;
};

/**
 * @param {{
 *   execute: typeof execFileAsync,
 *   environment: NodeJS.ProcessEnv,
 *   imageName: string,
 *   configurationIntegrity: string,
 *   agentUid: number,
 *   agentGid: number,
 * }} options
 */
const inspectRetainedImage = async ({
  execute,
  environment,
  imageName,
  configurationIntegrity,
  agentUid,
  agentGid,
}) => {
  try {
    const { stdout } = await execute("docker", [
      "image", "inspect", imageName,
      "--format={{json .}}",
    ], {
      env: environment,
      timeout: 10_000,
      maxBuffer: 64_000,
    });
    const image = JSON.parse(stdout);
    const configuration = image?.Config;
    return /^sha256:[a-f0-9]{64}$/.test(image?.Id ?? "")
      && configuration?.Labels?.[SANDBOX_CONFIGURATION_INTEGRITY_LABEL]
        === configurationIntegrity
      && configuration.Labels[SANDBOX_AGENT_UID_LABEL] === String(agentUid)
      && configuration.Labels[SANDBOX_AGENT_GID_LABEL] === String(agentGid)
      && configuration.User === `${agentUid}:${agentGid}`
      ? image.Id
      : null;
  } catch {
    return null;
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
  ) {
    return { ready: false, imageBuilt: false };
  }

  const execute = options.executeFile ?? execFileAsync;
  let dockerEndpoint;
  try {
    dockerEndpoint = await resolveDockerEndpoint({ execute, environment });
  } catch {
    return { ready: false, imageBuilt: false };
  }
  const boundEnvironment = /** @type {NodeJS.ProcessEnv} */ ({
    ...environment,
    DOCKER_HOST: dockerEndpoint,
  });
  delete boundEnvironment.DOCKER_CONTEXT;
  if (!contract.realSandboxEngineAvailable({ environment: boundEnvironment })) {
    return { ready: false, imageBuilt: false };
  }
  const agentUid = process.getuid?.() ?? 1000;
  const agentGid = process.getgid?.() ?? 1000;
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
  const inspectImage = () => inspectRetainedImage({
    execute,
    environment: boundEnvironment,
    imageName: contract.REAL_PROVIDER_SANDBOX_IMAGE,
    configurationIntegrity,
    agentUid,
    agentGid,
  });
  const retainedImageId = await inspectImage();
  if (retainedImageId) {
    return {
      ready: true,
      imageBuilt: false,
      dockerEndpoint,
      sandboxImageId: retainedImageId,
    };
  }

  const preparationKey = [
    dockerEndpoint,
    contract.REAL_PROVIDER_SANDBOX_IMAGE,
    configurationIntegrity,
    String(agentUid),
    String(agentGid),
  ].join("\0");
  const activePreparation = activeSandboxPreparations.get(preparationKey);
  if (activePreparation) return activePreparation;

  const preparation = (async () => {
    try {
      await execute("docker", [
        "build",
        "--build-arg", `AGENT_UID=${agentUid}`,
        "--build-arg", `AGENT_GID=${agentGid}`,
        "--label", `${SANDBOX_CONFIGURATION_INTEGRITY_LABEL}=${configurationIntegrity}`,
        "--label", `${SANDBOX_AGENT_UID_LABEL}=${agentUid}`,
        "--label", `${SANDBOX_AGENT_GID_LABEL}=${agentGid}`,
        "--tag", contract.REAL_PROVIDER_SANDBOX_IMAGE,
        "--file", configurationPath,
        projectionRoot,
      ], {
        cwd: projectionRoot,
        env: boundEnvironment,
        timeout: 20 * 60_000,
        maxBuffer: 1024 * 1024,
      });
      const sandboxImageId = await inspectImage();
      return sandboxImageId
        ? {
            ready: true,
            imageBuilt: true,
            dockerEndpoint,
            sandboxImageId,
          }
        : { ready: false, imageBuilt: true };
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
