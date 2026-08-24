import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createDestinationWorkerEnvironment } from "./destination-worker-environment.mjs";
import {
  appendProjectGitExcludeRules,
  ProjectPreparationFileError,
  readProjectPreparationFile,
  replaceProjectPreparationFile,
  restoreProjectPreparationFile,
} from "./project-git-exclusion.mjs";

const execFileAsync = promisify(execFile);
const realProviderContractUrl = new URL(
  "./production-sandcastle-adapter/sandcastle-v4.mjs",
  import.meta.url,
);
/**
 * Load the exact executable adapter module without making its deliberately
 * self-contained eval source part of the Host TypeScript compilation graph.
 * @returns {Promise<{
 *   probeRealProviderReadiness: (options?: {environment?: NodeJS.ProcessEnv}) => boolean,
 *   REAL_PROVIDER_CODEX_VERSION: string,
 *   REAL_PROVIDER_SKILL_IDENTITIES: readonly string[],
 * }>}
 */
const loadRealProviderContract = () => import(realProviderContractUrl.href);
const controlledManifestName = "sandcastle.worker-fixture.json";
export const REAL_PROVIDER_MANIFEST_NAME = "sandcastle.real-provider.json";
export const REAL_PROVIDER_MANIFEST_SOURCE = `${JSON.stringify({
  schemaVersion: 1,
  provider: { kind: "openai-codex", ready: true },
  scenario: "project-commit",
}, null, 2)}\n`;

export class ProductionProviderPreparationError extends Error {
  /** @param {"harness_worker_provider_unavailable" | "harness_projection_collision" | "harness_projection_failed"} code */
  constructor(code) {
    super(code);
    this.name = "ProductionProviderPreparationError";
    this.code = code;
  }
}

/** @param {string} projectPath @param {string[]} args */
const git = (projectPath, args) => execFileAsync("git", ["-C", projectPath, ...args], {
  env: {
    LANG: "C.UTF-8",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  },
  timeout: 5_000,
  maxBuffer: 4 * 1024 * 1024,
});

/**
 * @param {unknown} preparation
 * @param {string} codexVersion
 * @param {readonly string[]} skillIdentities
 */
const pinnedRealProviderInputsReady = (preparation, codexVersion, skillIdentities) => {
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

/**
 * Prepare the Project-owned real-provider selector at the last Host-controlled
 * boundary before adapter preflight. The returned rollback remains active until
 * the launch operation reaches its durable acceptance boundary.
 *
 * @param {{
 *   projectPath: string,
 *   productionPreparation: unknown,
 *   probeRealProviderReadiness?: () => boolean | Promise<boolean>,
 * }} options
 */
export const prepareProductionProviderLaunch = async (options) => {
  const projectRoot = resolve(options.projectPath);
  const controlledPath = join(projectRoot, controlledManifestName);
  const manifestPath = join(projectRoot, REAL_PROVIDER_MANIFEST_NAME);
  let controlled;
  let originalManifest;
  try {
    [controlled, originalManifest] = await Promise.all([
      readProjectPreparationFile(controlledPath),
      readProjectPreparationFile(manifestPath),
    ]);
  } catch (error) {
    if (error instanceof ProjectPreparationFileError) {
      throw new ProductionProviderPreparationError(error.code);
    }
    throw new ProductionProviderPreparationError("harness_projection_failed");
  }

  // A controlled manifest is an explicit conformance fixture selection. Never
  // mask it by manufacturing a second provider or silently falling back to it.
  if (controlled.exists) {
    return {
      providerKind: "controlled-worker-fixture",
      manifestWritten: false,
      rollback: async () => undefined,
    };
  }

  const realProviderContract = await loadRealProviderContract();
  const probe = options.probeRealProviderReadiness
    ?? (() => realProviderContract.probeRealProviderReadiness({
      environment: createDestinationWorkerEnvironment(),
    }));
  if (
    !pinnedRealProviderInputsReady(
      options.productionPreparation,
      realProviderContract.REAL_PROVIDER_CODEX_VERSION,
      realProviderContract.REAL_PROVIDER_SKILL_IDENTITIES,
    )
    || !await probe()
  ) {
    throw new ProductionProviderPreparationError("harness_worker_provider_unavailable");
  }

  let workingTreeStateBefore;
  let trackedInventoryBefore;
  try {
    [workingTreeStateBefore, trackedInventoryBefore] = await Promise.all([
      git(projectRoot, [
        "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none",
      ]).then(({ stdout }) => stdout),
      git(projectRoot, ["ls-files", "--stage", "-z"]).then(({ stdout }) => stdout),
    ]);
  } catch {
    throw new ProductionProviderPreparationError("harness_projection_failed");
  }
  const trackedPaths = trackedInventoryBefore.split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
  const manifestTracked = trackedPaths.includes(REAL_PROVIDER_MANIFEST_NAME);
  if (originalManifest.exists && originalManifest.source !== REAL_PROVIDER_MANIFEST_SOURCE) {
    throw new ProductionProviderPreparationError("harness_projection_collision");
  }
  if (manifestTracked) {
    if (!originalManifest.exists) {
      throw new ProductionProviderPreparationError("harness_projection_collision");
    }
    return {
      providerKind: "openai-codex",
      manifestWritten: false,
      rollback: async () => undefined,
    };
  }

  /** @type {Awaited<ReturnType<typeof appendProjectGitExcludeRules>> | null} */
  let gitExclusion = null;
  let manifestWritten = false;
  const rollback = async () => {
    if (manifestWritten) {
      await restoreProjectPreparationFile(manifestPath, originalManifest);
      manifestWritten = false;
    }
    await gitExclusion?.rollback();
  };
  try {
    gitExclusion = await appendProjectGitExcludeRules({
      projectPath: projectRoot,
      rules: [`/${REAL_PROVIDER_MANIFEST_NAME}`],
    });
    if (!originalManifest.exists) {
      await replaceProjectPreparationFile(manifestPath, REAL_PROVIDER_MANIFEST_SOURCE);
      manifestWritten = true;
    }
    await git(projectRoot, ["check-ignore", "--no-index", "--quiet", manifestPath]);
    const [workingTreeStateAfter, trackedInventoryAfter] = await Promise.all([
      git(projectRoot, [
        "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none",
      ]).then(({ stdout }) => stdout),
      git(projectRoot, ["ls-files", "--stage", "-z"]).then(({ stdout }) => stdout),
    ]);
    if (
      workingTreeStateAfter !== workingTreeStateBefore
      || trackedInventoryAfter !== trackedInventoryBefore
    ) {
      throw new ProjectPreparationFileError("harness_projection_failed");
    }
  } catch (error) {
    await rollback().catch(() => undefined);
    if (error instanceof ProjectPreparationFileError) {
      throw new ProductionProviderPreparationError(error.code);
    }
    throw new ProductionProviderPreparationError("harness_projection_failed");
  }

  return { providerKind: "openai-codex", manifestWritten, rollback };
};
