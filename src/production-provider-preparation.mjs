import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  appendProjectGitExcludeRules,
  captureProjectPreparationFile,
  createProjectPreparationFile,
  ProjectPreparationFileError,
  readProjectPreparationFile,
  removeProjectGitExcludeRules,
  removeProjectPreparationTemporaryFile,
  resolveProjectGitExcludePath,
} from "./project-git-exclusion.mjs";
import { ensureProductionProviderRuntime } from "./production-provider-runtime.mjs";

const execFileAsync = promisify(execFile);
const controlledManifestName = "sandcastle.worker-fixture.json";
export const REAL_PROVIDER_MANIFEST_NAME = "sandcastle.real-provider.json";
export const REAL_PROVIDER_GIT_EXCLUDE_RULE = `/${REAL_PROVIDER_MANIFEST_NAME}`;
export const REAL_PROVIDER_MANIFEST_SOURCE = `${JSON.stringify({
  schemaVersion: 1,
  provider: { kind: "openai-codex", ready: true },
  scenario: "project-commit",
}, null, 2)}\n`;

/** @param {string} preparationId */
export const productionProviderGitExcludeMarker = (preparationId) =>
  `# Sand-King temporary production provider ${preparationId}`;

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
 * Remove only the exact untracked selector written by Host preparation. A
 * different or tracked file remains Project-owned and is handled as a launch
 * collision rather than being deleted.
 *
 * @param {{projectPath: string}} options
 */
export const removeStaleProductionProviderManifest = async (options) => {
  const projectRoot = resolve(options.projectPath);
  const manifestPath = join(projectRoot, REAL_PROVIDER_MANIFEST_NAME);
  /** @type {Awaited<ReturnType<typeof captureProjectPreparationFile>> | null} */
  let captured = null;
  try {
    const manifest = await readProjectPreparationFile(manifestPath);
    if (!manifest.exists || manifest.source !== REAL_PROVIDER_MANIFEST_SOURCE) {
      return { removed: false };
    }
    const excludePath = await resolveProjectGitExcludePath(projectRoot);
    captured = await captureProjectPreparationFile(manifestPath, {
      directory: dirname(excludePath),
    });
    if (!captured.exists) return { removed: false };
    if (captured.source !== REAL_PROVIDER_MANIFEST_SOURCE) {
      await captured.restore();
      captured = null;
      return { removed: false };
    }
    const { stdout: trackedInventory } = await git(
      projectRoot,
      ["ls-files", "--stage", "-z"],
    );
    const trackedPaths = trackedInventory.split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(entry.indexOf("\t") + 1));
    if (trackedPaths.includes(REAL_PROVIDER_MANIFEST_NAME)) {
      await captured.restore();
      captured = null;
      return { removed: false };
    }
    await captured.remove();
    captured = null;
    return { removed: true };
  } catch (error) {
    await captured?.restore().catch(() => undefined);
    if (error instanceof ProjectPreparationFileError) {
      throw new ProductionProviderPreparationError(error.code);
    }
    throw new ProductionProviderPreparationError("harness_projection_failed");
  }
};

/**
 * Reconcile one durably owned provider preparation. The manifest removal is
 * content- and Git-ownership-aware, while the marker identifies only the
 * temporary exclusion block written by this preparation.
 *
 * @param {{projectPath: string, preparationId: string, ownershipMarker: string}} options
 */
export const cleanupProductionProviderPreparation = async (options) => {
  const manifestPath = join(
    resolve(options.projectPath),
    REAL_PROVIDER_MANIFEST_NAME,
  );
  try {
    await removeProjectPreparationTemporaryFile(
      manifestPath,
      options.preparationId,
    );
  } catch (error) {
    if (error instanceof ProjectPreparationFileError) {
      throw new ProductionProviderPreparationError(error.code);
    }
    throw new ProductionProviderPreparationError("harness_projection_failed");
  }
  await removeStaleProductionProviderManifest({ projectPath: options.projectPath });
  try {
    await removeProjectGitExcludeRules({
      projectPath: options.projectPath,
      rules: [REAL_PROVIDER_GIT_EXCLUDE_RULE],
      ownershipMarker: options.ownershipMarker,
      temporaryId: options.preparationId,
    });
  } catch (error) {
    if (error instanceof ProjectPreparationFileError) {
      throw new ProductionProviderPreparationError(error.code);
    }
    throw new ProductionProviderPreparationError("harness_projection_failed");
  }
};

/**
 * Atomically prepare the Project-owned selector after real-provider runtime
 * readiness has been established. Kept separate so filesystem invariants can
 * be tested without replacing the live provider/process checks.
 *
 * @param {{projectPath: string, preparationId?: string, ownershipMarker?: string}} options
 */
export const prepareProductionProviderManifest = async (options) => {
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

  if (controlled.exists) {
    throw new ProductionProviderPreparationError("harness_projection_collision");
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
    throw new ProductionProviderPreparationError("harness_projection_collision");
  }

  /** @type {Awaited<ReturnType<typeof appendProjectGitExcludeRules>> | null} */
  let gitExclusion = null;
  let manifestWritten = false;
  const rollback = async () => {
    if (manifestWritten) {
      await removeStaleProductionProviderManifest({ projectPath: projectRoot });
      manifestWritten = false;
    }
    await gitExclusion?.rollback();
  };
  try {
    gitExclusion = await appendProjectGitExcludeRules({
      projectPath: projectRoot,
      rules: [REAL_PROVIDER_GIT_EXCLUDE_RULE],
      ownershipMarker: options.ownershipMarker,
      temporaryId: options.preparationId,
    });
    if (!originalManifest.exists) {
      await createProjectPreparationFile(manifestPath, REAL_PROVIDER_MANIFEST_SOURCE, {
        temporaryId: options.preparationId,
      });
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

/**
 * Establish the real runtime and prepare its selector at the final
 * Host-controlled boundary before adapter preflight. The returned rollback
 * remains active until the adapter has inspected the selector.
 *
 * @param {{
 *   projectPath: string,
 *   projectionPath: string,
 *   productionPreparation: unknown,
 *   preserveExistingManifest?: boolean,
 *   preparationId?: string,
 *   ownershipMarker?: string,
 *   beforeProjectMutation?: () => Promise<void>,
 * }} options
 */
export const prepareProductionProviderLaunch = async (options) => {
  if (!options.preserveExistingManifest) {
    await removeStaleProductionProviderManifest({ projectPath: options.projectPath });
  }
  const runtime = await ensureProductionProviderRuntime({
    projectionPath: options.projectionPath,
    productionPreparation: options.productionPreparation,
  });
  if (!runtime.ready) {
    throw new ProductionProviderPreparationError("harness_worker_provider_unavailable");
  }
  await options.beforeProjectMutation?.();
  return prepareProductionProviderManifest({
    projectPath: options.projectPath,
    preparationId: options.preparationId,
    ownershipMarker: options.ownershipMarker,
  });
};
