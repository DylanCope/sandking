import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { SANDCASTLE_HARNESS_ADAPTER_ID } from "./harness-adapter-identity.mjs";
import { harnessCompatibilityManifestSchema } from "./harness-adapter-protocol.mjs";
import {
  productionHarnessProvenanceSchema,
  productionHarnessSeedManifestSchema,
  productionHarnessSkillLockSchema,
} from "./production-harness-seed.mjs";

const execFileAsync = promisify(execFile);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const harnessIdSchema = z.string().regex(/^harness-[a-f0-9]{24}$/);
const identitySchema = z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9.-]*$/);
const relativeProjectionPathSchema = z.string().min(1).max(512).refine((value) =>
  !value.startsWith("/")
  && !value.includes("\\")
  && !value.includes("\0")
  && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."));
const controlledWorkerRuntimePath = ".sandcastle/controlled-worker-fixture.mjs";

const productionHarnessProjectionManifestSchema = z.object({
  schemaVersion: z.literal(1),
  harness: z.object({
    adapterId: z.literal(SANDCASTLE_HARNESS_ADAPTER_ID),
    pinnedRevision: commitSchema,
  }).strict(),
  skillSetLockDigest: digestSchema,
  projectionDigest: digestSchema,
  files: z.array(z.object({
    path: relativeProjectionPathSchema,
    integrity: digestSchema,
  }).strict()).min(1).max(4_096),
}).strict().superRefine((manifest, context) => {
  if (new Set(manifest.files.map(({ path }) => path)).size !== manifest.files.length) {
    context.addIssue({
      code: "custom",
      message: "production Harness projection paths must be unique",
      path: ["files"],
    });
  }
});

export const productionHarnessPreparationSchema = z.object({
  status: z.literal("ready"),
  harness: z.object({
    harnessId: harnessIdSchema,
    adapterId: z.literal(SANDCASTLE_HARNESS_ADAPTER_ID),
    pinnedRevision: commitSchema,
  }).strict(),
  skillSetLockDigest: digestSchema,
  resolvedSkills: z.array(z.object({
    identity: identitySchema,
    revision: commitSchema,
    contentIntegrity: digestSchema,
  }).strict()).max(256),
  executionRuntimeInputs: productionHarnessSkillLockSchema.shape.executionRuntimeInputs,
  projection: z.object({
    path: relativeProjectionPathSchema,
    digest: digestSchema,
    ignored: z.literal(true),
    trackedContentPreserved: z.literal(true),
  }).strict(),
}).strict().superRefine((preparation, context) => {
  if (new Set(preparation.resolvedSkills.map(({ identity }) => identity)).size
      !== preparation.resolvedSkills.length) {
    context.addIssue({
      code: "custom",
      message: "resolved production skill identities must be unique",
      path: ["resolvedSkills"],
    });
  }
});

const preparationFailureCodes = Object.freeze([
  "harness_pin_unreadable",
  "harness_adapter_bytes_mismatch",
  "harness_compatibility_unsupported",
  "harness_skill_lock_missing",
  "harness_skill_lock_invalid",
  "harness_locked_skill_unavailable",
  "harness_skill_integrity_mismatch",
  "harness_projection_collision",
  "harness_projection_failed",
]);

export class ProductionHarnessPreparationError extends Error {
  /** @param {typeof preparationFailureCodes[number]} code */
  constructor(code) {
    super(code);
    this.name = "ProductionHarnessPreparationError";
    this.code = code;
  }
}

/** @param {Buffer | string} value */
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** @param {z.infer<typeof productionHarnessSeedManifestSchema>} manifest */
const seedSourceIntegrity = (manifest) => sha256(
  [...manifest.files]
    .filter(({ path }) => path !== "provenance.json" && path !== "skills.lock.json")
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map((file) => JSON.stringify({
      path: file.path,
      source: file.source,
      sourcePath: file.sourcePath ?? file.path,
      integrity: file.integrity,
      executable: file.executable,
    }))
    .join("\n") + "\n",
);

/** @param {string} workspacePath @param {string[]} args @param {number} [maxBuffer] */
const git = (workspacePath, args, maxBuffer = 4 * 1024 * 1024) => execFileAsync(
  "git",
  ["-C", workspacePath, ...args],
  {
    env: {
      LANG: "C.UTF-8",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    timeout: 5_000,
    maxBuffer,
  },
);

/** @param {string} workspacePath @param {string} revision @param {string} path */
const readPinnedFile = async (workspacePath, revision, path) => {
  try {
    return (await git(workspacePath, ["show", `${revision}:${path}`])).stdout;
  } catch {
    return null;
  }
};

/** @param {string} workspacePath @param {string} path */
const readWorkspaceFile = async (workspacePath, path) => {
  try {
    const absolutePath = join(workspacePath, ...path.split("/"));
    const details = await lstat(absolutePath);
    return details.isFile() && !details.isSymbolicLink()
      ? await readFile(absolutePath, "utf8")
      : null;
  } catch {
    return null;
  }
};

/**
 * @param {z.infer<typeof productionHarnessSkillLockSchema>} lock
 */
const validateCompleteSkillInventory = (lock) => {
  const skills = new Map(lock.skills.map((skill) => [skill.identity, skill]));
  const bundles = new Map(lock.bundles.map((bundle) => [bundle.identity, bundle]));
  const plugins = new Map(lock.plugins.map((plugin) => [plugin.identity, plugin]));
  if (
    skills.size !== lock.skills.length
    || bundles.size !== lock.bundles.length
    || plugins.size !== lock.plugins.length
  ) {
    throw new ProductionHarnessPreparationError("harness_skill_lock_invalid");
  }

  /** @param {string} identity @param {Set<string>} [visiting] */
  const expandBundle = (identity, visiting = new Set()) => {
    const bundle = bundles.get(identity);
    if (!bundle || visiting.has(identity)) {
      throw new ProductionHarnessPreparationError("harness_skill_lock_invalid");
    }
    const resolved = new Set(bundle.skills);
    const nestedVisiting = new Set(visiting).add(identity);
    for (const included of bundle.includes) {
      for (const skillIdentity of expandBundle(included, nestedVisiting)) {
        resolved.add(skillIdentity);
      }
    }
    if ([...resolved].some((skillIdentity) => !skills.has(skillIdentity))) {
      throw new ProductionHarnessPreparationError("harness_skill_lock_invalid");
    }
    return resolved;
  };

  for (const bundle of lock.bundles) expandBundle(bundle.identity);
  for (const plugin of lock.plugins) {
    if (plugin.skills.some((identity) => !skills.has(identity))) {
      throw new ProductionHarnessPreparationError("harness_skill_lock_invalid");
    }
  }
  for (const skill of lock.skills) {
    for (const provider of skill.providers) {
      if (provider.kind === "bundle"
        && !expandBundle(provider.identity).has(skill.identity)) {
        throw new ProductionHarnessPreparationError("harness_skill_lock_invalid");
      }
      if (provider.kind === "plugin"
        && !plugins.get(provider.identity)?.skills.includes(skill.identity)) {
        throw new ProductionHarnessPreparationError("harness_skill_lock_invalid");
      }
    }
  }
};

/** @param {string} root */
const listProjectionFiles = async (root) => {
  /** @type {string[]} */
  const files = [];
  /** @param {string} directory @param {string} prefix */
  const visit = async (directory, prefix) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new ProductionHarnessPreparationError("harness_projection_collision");
      }
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), path);
      } else if (entry.isFile()) {
        files.push(path);
      } else {
        throw new ProductionHarnessPreparationError("harness_projection_collision");
      }
    }
  };
  await visit(root, "");
  return files.sort();
};

/** @param {string} targetPath @param {Map<string, string>} expectedFiles */
const verifyExistingProjection = async (targetPath, expectedFiles) => {
  let details;
  try {
    details = await lstat(targetPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw new ProductionHarnessPreparationError("harness_projection_failed");
  }
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new ProductionHarnessPreparationError("harness_projection_collision");
  }
  const actualPaths = await listProjectionFiles(targetPath);
  const expectedPaths = [...expectedFiles.keys()].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new ProductionHarnessPreparationError("harness_projection_collision");
  }
  for (const [path, expected] of expectedFiles) {
    const actual = await readWorkspaceFile(targetPath, path);
    if (actual !== expected) {
      throw new ProductionHarnessPreparationError("harness_projection_collision");
    }
  }
  return true;
};

/** @param {string} root */
const makeExecutionTreeReadOnly = async (root) => {
  /** @param {string} directory */
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new ProductionHarnessPreparationError("harness_projection_failed");
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        await chmod(path, 0o400);
      } else {
        throw new ProductionHarnessPreparationError("harness_projection_failed");
      }
    }
    // Directories remain owner-traversable and removable with ordinary Host
    // state cleanup; the captured regular files themselves are read-only.
    await chmod(directory, 0o700);
  };
  await visit(root);
};

/** @param {string} root */
const makeExecutionTreeRemovable = async (root) => {
  /** @param {string} directory */
  const visit = async (directory) => {
    await chmod(directory, 0o700).catch(() => undefined);
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(path);
      } else {
        await chmod(path, 0o600).catch(() => undefined);
      }
    }
  };
  await visit(root);
};

/**
 * Capture the verified Project projection into Host-private run state before
 * launch acceptance. Each source file is reduced to bytes authenticated by
 * the pinned projection manifest; later Project mutations therefore cannot
 * change the runtime consumed by supervision.
 *
 * @param {{
 *   sourcePath: string,
 *   destinationPath: string,
 *   projectPath: string,
 *   preparation: z.infer<typeof productionHarnessPreparationSchema>,
 * }} options
 */
export const materializeProductionHarnessExecutionSnapshot = async (options) => {
  const preparation = productionHarnessPreparationSchema.parse(options.preparation);
  const manifestSource = await readWorkspaceFile(
    options.sourcePath,
    "projection-manifest.json",
  );
  if (manifestSource === null) {
    throw new ProductionHarnessPreparationError("harness_projection_collision");
  }
  let manifestValue;
  try {
    manifestValue = JSON.parse(manifestSource);
  } catch {
    throw new ProductionHarnessPreparationError("harness_projection_collision");
  }
  const parsedManifest = productionHarnessProjectionManifestSchema.safeParse(manifestValue);
  if (!parsedManifest.success) {
    throw new ProductionHarnessPreparationError("harness_projection_collision");
  }
  const manifest = parsedManifest.data;
  if (
    manifest.harness.adapterId !== preparation.harness.adapterId
    || manifest.harness.pinnedRevision !== preparation.harness.pinnedRevision
    || manifest.skillSetLockDigest !== preparation.skillSetLockDigest
    || manifest.projectionDigest !== preparation.projection.digest
    || manifest.files.some(({ path }) => path === "projection-manifest.json")
  ) {
    throw new ProductionHarnessPreparationError("harness_projection_collision");
  }

  const expectedPaths = [
    ...manifest.files.map(({ path }) => path),
    "projection-manifest.json",
  ].sort();
  if (JSON.stringify(await listProjectionFiles(options.sourcePath))
      !== JSON.stringify(expectedPaths)) {
    throw new ProductionHarnessPreparationError("harness_projection_collision");
  }

  /** @type {Map<string, string>} */
  const snapshotFiles = new Map();
  for (const file of manifest.files) {
    const source = await readWorkspaceFile(options.sourcePath, file.path);
    if (source === null || sha256(source) !== file.integrity) {
      throw new ProductionHarnessPreparationError("harness_projection_collision");
    }
    snapshotFiles.set(file.path, source);
  }
  const projectionDigest = sha256([...snapshotFiles]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, source]) => `${JSON.stringify(path)}:${sha256(source)}`)
    .join("\n") + "\n");
  if (projectionDigest !== preparation.projection.digest) {
    throw new ProductionHarnessPreparationError("harness_projection_collision");
  }
  const runtimeEntryPointSource = snapshotFiles.get(controlledWorkerRuntimePath);
  if (typeof runtimeEntryPointSource !== "string") {
    throw new ProductionHarnessPreparationError("harness_projection_collision");
  }
  snapshotFiles.set("projection-manifest.json", manifestSource);

  const destinationPath = resolve(options.destinationPath);
  const destinationParent = dirname(destinationPath);
  if (destinationPath === resolve(options.sourcePath)) {
    throw new ProductionHarnessPreparationError("harness_projection_failed");
  }
  await mkdir(destinationParent, { recursive: true, mode: 0o700 });
  try {
    await lstat(destinationPath);
    throw new ProductionHarnessPreparationError("harness_projection_failed");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      if (error instanceof ProductionHarnessPreparationError) throw error;
      throw new ProductionHarnessPreparationError("harness_projection_failed");
    }
  }

  let stagingPath = null;
  let published = false;
  try {
    stagingPath = await mkdtemp(join(
      destinationParent,
      `.${basename(destinationPath)}-prepare-`,
    ));
    for (const [path, source] of [...snapshotFiles]
      .sort(([left], [right]) => left.localeCompare(right))) {
      const target = join(stagingPath, ...path.split("/"));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, source, { mode: 0o600 });
    }
    if (!await verifyExistingProjection(stagingPath, snapshotFiles)) {
      throw new ProductionHarnessPreparationError("harness_projection_failed");
    }
    const executionGitDirectory = join(stagingPath, ".git");
    await Promise.all([
      mkdir(join(executionGitDirectory, "objects"), { recursive: true, mode: 0o700 }),
      mkdir(join(executionGitDirectory, "refs", "heads"), {
        recursive: true,
        mode: 0o700,
      }),
    ]);
    await Promise.all([
      writeFile(
        join(executionGitDirectory, "HEAD"),
        "ref: refs/heads/sandking-execution\n",
        { mode: 0o600 },
      ),
      writeFile(
        join(executionGitDirectory, "config"),
        [
          "[core]",
          "\trepositoryformatversion = 0",
          "\tbare = false",
          `\tworktree = ${JSON.stringify(resolve(options.projectPath))}`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      ),
    ]);
    await rename(stagingPath, destinationPath);
    stagingPath = null;
    published = true;
    await makeExecutionTreeReadOnly(destinationPath);
    return {
      path: destinationPath,
      runtimeEntryPointSource,
      runtimeEntryPointIntegrity: sha256(runtimeEntryPointSource),
    };
  } catch (error) {
    if (stagingPath) {
      await makeExecutionTreeRemovable(stagingPath).catch(() => undefined);
      await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    }
    if (published) {
      await makeExecutionTreeRemovable(destinationPath).catch(() => undefined);
      await rm(destinationPath, { recursive: true, force: true }).catch(() => undefined);
    }
    if (error instanceof ProductionHarnessPreparationError) throw error;
    throw new ProductionHarnessPreparationError("harness_projection_failed");
  }
};

/**
 * Re-authenticate the executable projection input at the last Host-controlled
 * boundary before the adapter process is created. The retained source was
 * captured before launch acceptance, so a later replacement cannot become an
 * accepted Worker runtime merely by restoring writable file permissions.
 *
 * @param {{
 *   executionPath: string,
 *   runtimeEntryPointSource: string,
 *   runtimeEntryPointIntegrity: string,
 * }} options
 */
export const verifyProductionHarnessRuntimeEntryPoint = async (options) => {
  const runtimePath = join(
    options.executionPath,
    ...controlledWorkerRuntimePath.split("/"),
  );
  try {
    const details = await lstat(runtimePath);
    const source = details.isFile() && !details.isSymbolicLink() && details.nlink === 1
      ? await readFile(runtimePath, "utf8")
      : null;
    if (
      source === null
      || source !== options.runtimeEntryPointSource
      || sha256(source) !== options.runtimeEntryPointIntegrity
    ) {
      throw new ProductionHarnessPreparationError("harness_projection_failed");
    }
  } catch (error) {
    if (error instanceof ProductionHarnessPreparationError) throw error;
    throw new ProductionHarnessPreparationError("harness_projection_failed");
  }
};

/** @param {string} path */
const readOptionalFile = async (path) => {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
      throw new ProductionHarnessPreparationError("harness_projection_collision");
    }
    return { exists: true, source: await readFile(path, "utf8") };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { exists: false, source: "" };
    }
    if (error instanceof ProductionHarnessPreparationError) throw error;
    throw new ProductionHarnessPreparationError("harness_projection_failed");
  }
};

/** @param {string} path @param {string} source */
const replaceFile = async (path, source) => {
  const temporaryPath = `${path}.sandking-${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  let temporaryCreated = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(source, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    temporaryCreated = false;
  } catch (error) {
    if (temporaryCreated) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
};

/** @param {string} path */
const assertSafeFileParent = async (path) => {
  const parent = dirname(path);
  try {
    const details = await lstat(parent);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new ProductionHarnessPreparationError("harness_projection_collision");
    }
  } catch (error) {
    if (error instanceof ProductionHarnessPreparationError) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      try {
        const parentDetails = await lstat(dirname(parent));
        if (!parentDetails.isDirectory() || parentDetails.isSymbolicLink()) {
          throw new ProductionHarnessPreparationError("harness_projection_collision");
        }
        return;
      } catch (parentError) {
        if (parentError instanceof ProductionHarnessPreparationError) throw parentError;
      }
    }
    throw new ProductionHarnessPreparationError("harness_projection_failed");
  }
};

/** @param {string} path @param {{exists: boolean, source: string}} original */
const restoreOptionalFile = async (path, original) => {
  if (original.exists) {
    await replaceFile(path, original.source);
  } else {
    await rm(path, { force: true });
  }
};

/** @param {string} root @param {string} child */
const isInside = (root, child) => {
  const fromRoot = relative(root, child);
  return fromRoot !== ""
    && fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`);
};

/** @param {string} projectRoot @param {string} projectionRelativePath */
const assertSafeProjectionAncestors = async (projectRoot, projectionRelativePath) => {
  let current = projectRoot;
  for (const segment of projectionRelativePath.split("/").slice(0, -1)) {
    current = join(current, segment);
    try {
      const details = await lstat(current);
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new ProductionHarnessPreparationError("harness_projection_collision");
      }
      const ancestorRepositoryRoot = (await git(current, [
        "rev-parse", "--show-toplevel",
      ])).stdout.trim();
      if (resolve(ancestorRepositoryRoot) !== projectRoot) {
        throw new ProductionHarnessPreparationError("harness_projection_collision");
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }
      if (error instanceof ProductionHarnessPreparationError) throw error;
      throw new ProductionHarnessPreparationError("harness_projection_failed");
    }
  }
};

/**
 * Resolve and project the exact runtime inputs selected by a production Harness
 * registration. No ambient source is consulted by this operation.
 * @param {{
 *   projectPath: string,
 *   harnessId: string,
 *   workspacePath: string,
 *   pinnedRevision: string,
 * }} options
 */
export const prepareProductionHarness = async (options) => {
  if (
    !harnessIdSchema.safeParse(options.harnessId).success
    || !commitSchema.safeParse(options.pinnedRevision).success
  ) {
    throw new ProductionHarnessPreparationError("harness_pin_unreadable");
  }
  try {
    await git(options.workspacePath, ["cat-file", "-e", `${options.pinnedRevision}^{commit}`]);
    const head = (await git(options.workspacePath, ["rev-parse", "HEAD"])).stdout.trim();
    if (head !== options.pinnedRevision) {
      throw new ProductionHarnessPreparationError("harness_pin_unreadable");
    }
  } catch (error) {
    if (error instanceof ProductionHarnessPreparationError) throw error;
    throw new ProductionHarnessPreparationError("harness_pin_unreadable");
  }

  const pinnedManifestSource = await readPinnedFile(
    options.workspacePath,
    options.pinnedRevision,
    "harness.json",
  );
  if (pinnedManifestSource === null) {
    throw new ProductionHarnessPreparationError("harness_compatibility_unsupported");
  }
  const workspaceManifestSource = await readWorkspaceFile(options.workspacePath, "harness.json");
  if (workspaceManifestSource !== pinnedManifestSource) {
    throw new ProductionHarnessPreparationError("harness_adapter_bytes_mismatch");
  }
  const parsedManifest = harnessCompatibilityManifestSchema.safeParse(
    (() => {
      try {
        return JSON.parse(pinnedManifestSource);
      } catch {
        return null;
      }
    })(),
  );
  if (
    !parsedManifest.success
    || parsedManifest.data.compatibility.adapterId !== SANDCASTLE_HARNESS_ADAPTER_ID
    || parsedManifest.data.compatibility.adapterProtocol !== "1.0.0"
  ) {
    throw new ProductionHarnessPreparationError("harness_compatibility_unsupported");
  }
  const adapterPath = parsedManifest.data.compatibility.entryPoint;
  const pinnedAdapterSource = await readPinnedFile(
    options.workspacePath,
    options.pinnedRevision,
    adapterPath,
  );
  if (pinnedAdapterSource === null) {
    throw new ProductionHarnessPreparationError("harness_compatibility_unsupported");
  }
  if (await readWorkspaceFile(options.workspacePath, adapterPath) !== pinnedAdapterSource) {
    throw new ProductionHarnessPreparationError("harness_adapter_bytes_mismatch");
  }

  const pinnedSkillLockSource = await readPinnedFile(
    options.workspacePath,
    options.pinnedRevision,
    "skills.lock.json",
  );
  if (pinnedSkillLockSource === null) {
    throw new ProductionHarnessPreparationError("harness_skill_lock_missing");
  }
  if (await readWorkspaceFile(options.workspacePath, "skills.lock.json")
      !== pinnedSkillLockSource) {
    throw new ProductionHarnessPreparationError("harness_skill_lock_invalid");
  }
  let skillLockValue;
  try {
    skillLockValue = JSON.parse(pinnedSkillLockSource);
  } catch {
    throw new ProductionHarnessPreparationError("harness_skill_lock_invalid");
  }
  const parsedSkillLock = productionHarnessSkillLockSchema.safeParse(skillLockValue);
  if (!parsedSkillLock.success) {
    throw new ProductionHarnessPreparationError("harness_skill_lock_invalid");
  }
  const skillLock = parsedSkillLock.data;
  validateCompleteSkillInventory(skillLock);

  const pinnedProvenanceSource = await readPinnedFile(
    options.workspacePath,
    options.pinnedRevision,
    "provenance.json",
  );
  const workspaceProvenanceSource = await readWorkspaceFile(
    options.workspacePath,
    "provenance.json",
  );
  let provenanceValue;
  try {
    provenanceValue = JSON.parse(pinnedProvenanceSource ?? "");
  } catch {
    throw new ProductionHarnessPreparationError("harness_skill_lock_invalid");
  }
  const parsedProvenance = productionHarnessProvenanceSchema.safeParse(provenanceValue);
  if (
    !parsedProvenance.success
    || workspaceProvenanceSource !== pinnedProvenanceSource
    || parsedProvenance.data.artifacts.skillSetLock.integrity !== sha256(pinnedSkillLockSource)
  ) {
    throw new ProductionHarnessPreparationError("harness_skill_lock_invalid");
  }
  const provenance = parsedProvenance.data;

  const pinnedSeedManifestSource = await readPinnedFile(
    options.workspacePath,
    options.pinnedRevision,
    "seed-manifest.json",
  );
  let seedManifestValue;
  try {
    seedManifestValue = JSON.parse(pinnedSeedManifestSource ?? "");
  } catch {
    throw new ProductionHarnessPreparationError("harness_projection_failed");
  }
  const parsedSeedManifest = productionHarnessSeedManifestSchema.safeParse(seedManifestValue);
  if (
    !parsedSeedManifest.success
    || await readWorkspaceFile(options.workspacePath, "seed-manifest.json")
      !== pinnedSeedManifestSource
  ) {
    throw new ProductionHarnessPreparationError("harness_projection_failed");
  }
  const seedManifest = parsedSeedManifest.data;
  const seedFiles = new Map(seedManifest.files.map((file) => [file.path, file]));
  if (
    seedFiles.size !== seedManifest.files.length
    || seedFiles.get("harness.json")?.integrity !== sha256(pinnedManifestSource)
    || seedFiles.get(adapterPath)?.integrity !== sha256(pinnedAdapterSource)
    || seedFiles.get("skills.lock.json")?.integrity !== sha256(pinnedSkillLockSource)
  ) {
    throw new ProductionHarnessPreparationError("harness_projection_failed");
  }

  /** @type {Map<string, string>} */
  const pinnedRuntimeFiles = new Map([
    ["harness.json", pinnedManifestSource],
    [adapterPath, pinnedAdapterSource],
    ["skills.lock.json", pinnedSkillLockSource],
  ]);
  let committedPaths;
  try {
    committedPaths = (await git(options.workspacePath, [
      "ls-tree", "-r", "--name-only", options.pinnedRevision,
    ])).stdout.split("\n").filter(Boolean);
  } catch {
    throw new ProductionHarnessPreparationError("harness_pin_unreadable");
  }
  const committedRuntimePaths = committedPaths.filter((path) =>
    path.startsWith(".sandcastle/")
    || path === "package.json"
    || path === "package-lock.json").sort();
  const runtimePaths = seedManifest.files.map(({ path }) => path).filter((path) =>
    path.startsWith(".sandcastle/")
    || path === "package.json"
    || path === "package-lock.json").sort();
  const lockedSkillPaths = new Set(skillLock.skills.map((skill) => skill.source.path));
  if (
    committedRuntimePaths.some((path) => !runtimePaths.includes(path))
    || runtimePaths.some((path) =>
      !committedRuntimePaths.includes(path) && !lockedSkillPaths.has(path))
  ) {
    throw new ProductionHarnessPreparationError("harness_projection_failed");
  }
  const runtimeIntegrityMismatches = new Set();
  for (const path of runtimePaths) {
    const source = await readPinnedFile(options.workspacePath, options.pinnedRevision, path);
    if (source === null && lockedSkillPaths.has(path)) continue;
    if (source === null) {
      throw new ProductionHarnessPreparationError("harness_pin_unreadable");
    }
    if (seedFiles.get(path)?.integrity !== sha256(source)) {
      runtimeIntegrityMismatches.add(path);
    }
    if (await readWorkspaceFile(options.workspacePath, path) !== source) {
      if (lockedSkillPaths.has(path)) continue;
      throw new ProductionHarnessPreparationError(
        path === adapterPath
          ? "harness_adapter_bytes_mismatch"
          : "harness_projection_failed",
      );
    }
    pinnedRuntimeFiles.set(path, source);
  }

  for (const [path, source] of pinnedRuntimeFiles) {
    if (!/^\.sandcastle\/.*\.m[jt]s$/.test(path)) continue;
    const promptProperties = [...source.matchAll(/\bpromptFile\s*:/g)];
    const staticPromptFiles = [...source.matchAll(
      /\bpromptFile\s*:\s*(["'])(\.\/[^"']+)\1/g,
    )];
    if (promptProperties.length !== staticPromptFiles.length) {
      throw new ProductionHarnessPreparationError("harness_skill_lock_invalid");
    }
    for (const match of staticPromptFiles) {
      const promptPath = posix.normalize(match[2].slice(2));
      if (!lockedSkillPaths.has(promptPath)) {
        throw new ProductionHarnessPreparationError("harness_skill_lock_invalid");
      }
    }
  }
  if ([...runtimeIntegrityMismatches].some((path) => !lockedSkillPaths.has(path))) {
    throw new ProductionHarnessPreparationError("harness_pin_unreadable");
  }
  const dependencyLockSource = pinnedRuntimeFiles.get("package-lock.json");
  if (
    !dependencyLockSource
    || sha256(dependencyLockSource) !== provenance.artifacts.dependencyLock.integrity
  ) {
    throw new ProductionHarnessPreparationError("harness_projection_failed");
  }

  const resolvedSkills = [];
  /** @type {Map<string, string>} */
  const projectedFiles = new Map(pinnedRuntimeFiles);
  for (const skill of skillLock.skills) {
    if (
      skill.source.repository !== provenance.sandKing.repository
      || skill.source.revision !== provenance.sandKing.revision
      || seedFiles.get(skill.source.path)?.integrity !== skill.contentIntegrity
    ) {
      throw new ProductionHarnessPreparationError("harness_skill_lock_invalid");
    }
    const pinnedSkillSource = await readPinnedFile(
      options.workspacePath,
      options.pinnedRevision,
      skill.source.path,
    );
    if (pinnedSkillSource === null
      || await readWorkspaceFile(options.workspacePath, skill.source.path) === null) {
      throw new ProductionHarnessPreparationError("harness_locked_skill_unavailable");
    }
    if (
      sha256(pinnedSkillSource) !== skill.contentIntegrity
      || await readWorkspaceFile(options.workspacePath, skill.source.path) !== pinnedSkillSource
    ) {
      throw new ProductionHarnessPreparationError("harness_skill_integrity_mismatch");
    }
    resolvedSkills.push({
      identity: skill.identity,
      revision: skill.source.revision,
      contentIntegrity: skill.contentIntegrity,
    });
    projectedFiles.set(`worker-skills/${skill.identity}/SKILL.md`, pinnedSkillSource);
  }
  if (seedSourceIntegrity(seedManifest) !== provenance.sandKing.seedSourceIntegrity) {
    throw new ProductionHarnessPreparationError("harness_projection_failed");
  }

  const workerEnvironment = {
    schemaVersion: 1,
    harness: {
      adapterId: SANDCASTLE_HARNESS_ADAPTER_ID,
      pinnedRevision: options.pinnedRevision,
    },
    skillSetLockDigest: sha256(pinnedSkillLockSource),
    skillDiscovery: {
      ambient: "disabled",
      roots: ["worker-skills"],
      unlisted: "reject",
    },
    skills: resolvedSkills.map((skill) => ({
      ...skill,
      path: `worker-skills/${skill.identity}/SKILL.md`,
    })),
    executionRuntimeInputs: skillLock.executionRuntimeInputs,
  };
  projectedFiles.set(
    "worker-environment.json",
    `${JSON.stringify(workerEnvironment, null, 2)}\n`,
  );
  const projectionDigest = sha256([...projectedFiles]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, source]) => `${JSON.stringify(path)}:${sha256(source)}`)
    .join("\n") + "\n");
  projectedFiles.set("projection-manifest.json", `${JSON.stringify({
    schemaVersion: 1,
    harness: workerEnvironment.harness,
    skillSetLockDigest: workerEnvironment.skillSetLockDigest,
    projectionDigest,
    files: [...projectedFiles]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, source]) => ({ path, integrity: sha256(source) })),
  }, null, 2)}\n`);

  const projectRoot = resolve(options.projectPath);
  const projectionRelativePath = `.sandking/harnesses/${options.harnessId}`;
  const projectionPath = resolve(projectRoot, ...projectionRelativePath.split("/"));
  if (!isInside(projectRoot, projectionPath)) {
    throw new ProductionHarnessPreparationError("harness_projection_collision");
  }
  let repositoryRoot;
  try {
    repositoryRoot = (await git(projectRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();
  } catch {
    throw new ProductionHarnessPreparationError("harness_projection_failed");
  }
  if (resolve(repositoryRoot) !== projectRoot) {
    throw new ProductionHarnessPreparationError("harness_projection_failed");
  }
  await assertSafeProjectionAncestors(projectRoot, projectionRelativePath);

  const workingTreeStateBefore = (await git(projectRoot, [
    "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none",
  ])).stdout;
  const trackedInventoryBefore = (await git(projectRoot, [
    "ls-files", "--stage", "-z",
  ])).stdout;
  const trackedPaths = trackedInventoryBefore.split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
  if (trackedPaths.some((trackedPath) =>
    trackedPath === projectionRelativePath
    || trackedPath.startsWith(`${projectionRelativePath}/`)
    || projectionRelativePath.startsWith(`${trackedPath}/`))) {
    throw new ProductionHarnessPreparationError("harness_projection_collision");
  }

  const gitExcludePathValue = (await git(projectRoot, [
    "rev-parse", "--git-path", "info/exclude",
  ])).stdout.trim();
  const gitExcludePath = resolve(projectRoot, gitExcludePathValue);
  await assertSafeFileParent(gitExcludePath);
  const originalExclude = await readOptionalFile(gitExcludePath);
  const projectionIgnoreRule = `/${projectionRelativePath}/`;
  const stagingIgnoreRule = `/.sandking/harnesses/.prepare-${options.harnessId}-*/`;
  const existingRules = new Set(originalExclude.source.split("\n"));
  const addedRules = [projectionIgnoreRule, stagingIgnoreRule]
    .filter((rule) => !existingRules.has(rule));
  const nextExclude = addedRules.length === 0
    ? originalExclude.source
    : `${originalExclude.source}${originalExclude.source.endsWith("\n")
      || originalExclude.source.length === 0 ? "" : "\n"}${addedRules.join("\n")}\n`;
  let stagingPath = null;
  let projectionCreated = false;
  try {
    await mkdir(dirname(gitExcludePath), { recursive: true, mode: 0o700 });
    if (nextExclude !== originalExclude.source) {
      await replaceFile(gitExcludePath, nextExclude);
    }
    await mkdir(dirname(projectionPath), { recursive: true, mode: 0o700 });
    const existingProjection = await verifyExistingProjection(projectionPath, projectedFiles);
    if (!existingProjection) {
      stagingPath = await mkdtemp(join(
        dirname(projectionPath),
        `.prepare-${options.harnessId}-`,
      ));
      for (const [path, source] of [...projectedFiles]
        .sort(([left], [right]) => left.localeCompare(right))) {
        const destination = join(stagingPath, ...path.split("/"));
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, source, { mode: 0o600 });
      }
      await rename(stagingPath, projectionPath);
      stagingPath = null;
      projectionCreated = true;
    }
    const ignoreProbe = join(projectionPath, "worker-environment.json");
    try {
      await git(projectRoot, ["check-ignore", "--no-index", "--quiet", ignoreProbe]);
    } catch {
      throw new ProductionHarnessPreparationError("harness_projection_failed");
    }
    if (
      (await git(projectRoot, [
        "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none",
      ])).stdout !== workingTreeStateBefore
      || (await git(projectRoot, ["ls-files", "--stage", "-z"])).stdout
        !== trackedInventoryBefore
    ) {
      throw new ProductionHarnessPreparationError("harness_projection_failed");
    }
  } catch (error) {
    if (stagingPath) await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    if (projectionCreated) {
      await rm(projectionPath, { recursive: true, force: true }).catch(() => undefined);
    }
    await restoreOptionalFile(gitExcludePath, originalExclude).catch(() => undefined);
    if (error instanceof ProductionHarnessPreparationError) throw error;
    throw new ProductionHarnessPreparationError("harness_projection_failed");
  }

  return productionHarnessPreparationSchema.parse({
    status: "ready",
    harness: {
      harnessId: options.harnessId,
      adapterId: SANDCASTLE_HARNESS_ADAPTER_ID,
      pinnedRevision: options.pinnedRevision,
    },
    skillSetLockDigest: sha256(pinnedSkillLockSource),
    resolvedSkills,
    executionRuntimeInputs: skillLock.executionRuntimeInputs,
    projection: {
      path: projectionRelativePath,
      digest: projectionDigest,
      ignored: true,
      trackedContentPreserved: true,
    },
  });
};
