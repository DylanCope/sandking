import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { SANDCASTLE_HARNESS_ADAPTER_ID } from "./harness-adapter-identity.mjs";
import { harnessCompatibilityManifestSchema } from "./harness-adapter-protocol.mjs";

const execFileAsync = promisify(execFile);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const integritySchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const packageIntegritySchema = z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
const identitySchema = z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9.-]*$/);
const exactVersionSchema = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/);
const relativeFileSchema = z.string().min(1).max(512).refine((value) =>
  !isAbsolute(value)
  && !value.includes("\\")
  && !value.includes("\0")
  && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."));
const sourceUrlSchema = z.url().refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
});

const SAND_KING_REPOSITORY = "https://github.com/DylanCope/sandking.git";
const SAND_KING_SEED_REVISION = "0a602896e4063dce7b390b3a514e34cfe36b46c1";
const SAND_KING_SEED_SOURCE_INTEGRITY =
  "sha256:aa935016db68d05f4273f21ab42eb5a2ba2a966cea4a75ae1b7c589d589a7451";
const SANDCASTLE_REPOSITORY = "https://github.com/mattpocock/sandcastle.git";
const SANDCASTLE_REVISION = "e99f832f26dc9d245c019a9ddd19fa5dee792427";
const SANDCASTLE_VERSION = "0.12.0";
const SANDCASTLE_RESOLVED =
  "https://registry.npmjs.org/@ai-hero/sandcastle/-/sandcastle-0.12.0.tgz";
const SANDCASTLE_INTEGRITY =
  "sha512-kdQ414rM8t1QiWeqZ3Klz4KSd0PqQG4bRVuqGpRDUomWhojSZkEAc1tbcEcThVmBEaHkCt8LmYR49vqEPNIoYQ==";
const SANDCASTLE_DEPENDENCY_LOCK_INTEGRITY =
  "sha256:f23f864604dd2901d314afdb5ee819c2ca91fccd3c16807a8c5441d818e5b4c1";
const CODEX_VERSION = "0.146.0";
const CODEX_RESOLVED =
  "https://registry.npmjs.org/@openai/codex/-/codex-0.146.0.tgz";
const CODEX_INTEGRITY =
  "sha512-yG3sPWNda/2YAIQIDq9MrrjoCTIQ7rxYM5IasrG3VBcuhCLTkgeg/JzqmJq1V98RE4MJ5jCxDXXQlOjrditFRw==";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
export const bundledProductionHarnessSeedRoot = fileURLToPath(
  new URL("./bundled-production-harness/", import.meta.url),
);

const seedManifestSchema = z.object({
  schemaVersion: z.literal(1),
  seedIdentity: z.literal("sandking.sandcastle-harness"),
  files: z.array(z.object({
    path: relativeFileSchema,
    sourcePath: relativeFileSchema.optional(),
    source: z.enum(["seed", "sandking-package"]),
    integrity: integritySchema,
    executable: z.boolean(),
  }).strict()).min(1).max(128),
}).strict();

export const productionHarnessProvenanceSchema = z.object({
  schemaVersion: z.literal(1),
  seedVersion: z.literal("sandking-sandcastle-harness-v1"),
  sandKing: z.object({
    repository: z.literal(SAND_KING_REPOSITORY),
    revision: z.literal(SAND_KING_SEED_REVISION),
    seedSourceIntegrity: z.literal(SAND_KING_SEED_SOURCE_INTEGRITY),
  }).strict(),
  sandcastle: z.object({
    repository: z.literal(SANDCASTLE_REPOSITORY),
    revision: z.literal(SANDCASTLE_REVISION),
    package: z.literal("@ai-hero/sandcastle"),
    version: z.literal(SANDCASTLE_VERSION),
  }).strict(),
  artifacts: z.object({
    dependencyLock: z.object({
      path: z.literal("package-lock.json"),
      integrity: z.literal(SANDCASTLE_DEPENDENCY_LOCK_INTEGRITY),
    }).strict(),
    skillSetLock: z.object({
      path: z.literal("skills.lock.json"),
      integrity: integritySchema,
    }).strict(),
  }).strict(),
}).strict();

const skillProviderSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct") }).strict(),
  z.object({ kind: z.literal("bundle"), identity: identitySchema }).strict(),
  z.object({ kind: z.literal("plugin"), identity: identitySchema }).strict(),
]);

export const productionHarnessSkillLockSchema = z.object({
  schemaVersion: z.literal(1),
  policy: z.object({
    ambientDiscovery: z.literal("disabled"),
    unlistedSkills: z.literal("reject"),
  }).strict(),
  skills: z.array(z.object({
    identity: identitySchema,
    source: z.object({
      kind: z.literal("git"),
      repository: sourceUrlSchema,
      revision: commitSchema,
      path: relativeFileSchema,
    }).strict(),
    contentIntegrity: integritySchema,
    providers: z.array(skillProviderSchema).min(1).max(16),
  }).strict()).max(256),
  bundles: z.array(z.object({
    identity: identitySchema,
    includes: z.array(identitySchema).max(64),
    skills: z.array(identitySchema).max(256),
  }).strict()).max(64),
  plugins: z.array(z.object({
    identity: identitySchema,
    package: z.string().min(1).max(214),
    version: exactVersionSchema,
    resolved: sourceUrlSchema,
    integrity: packageIntegritySchema,
    skills: z.array(identitySchema).max(256),
  }).strict()).max(64),
  executionRuntimeInputs: z.array(z.object({
    identity: identitySchema,
    package: z.string().min(1).max(214),
    version: exactVersionSchema,
    resolved: sourceUrlSchema,
    integrity: packageIntegritySchema,
    skillExposure: z.literal("versioned-with-runtime-package"),
  }).strict()).min(1).max(16),
}).strict();

const productionSeedFileContract = Object.freeze([
  { path: ".gitignore", sourcePath: "gitignore", source: "seed", executable: false },
  ...[
    "README.md",
    "adapters/sandcastle.mjs",
    "harness.json",
    "package-lock.json",
    "package.json",
    "provenance.json",
    "skills.lock.json",
  ].map((path) => ({ path, sourcePath: undefined, source: "seed", executable: false })),
  ...[
    ".sandcastle/CODING_STANDARDS.md",
    ".sandcastle/Dockerfile",
    ".sandcastle/delivery-adapters.mjs",
    ".sandcastle/implement-prompt.md",
    ".sandcastle/issue-delivery.mjs",
    ".sandcastle/list-planner-candidates.mjs",
    ".sandcastle/main.mts",
    ".sandcastle/plan-prompt.md",
    ".sandcastle/pr-review-prompt.md",
    ".sandcastle/pr-review-runner.mjs",
    ".sandcastle/resilience.mjs",
    ".sandcastle/run-scope.mjs",
    ".sandcastle/sandbox-settings.mjs",
  ].map((path) => ({
    path,
    sourcePath: undefined,
    source: "sandking-package",
    executable: false,
  })),
  {
    path: ".sandcastle/install-codex-auth.sh",
    sourcePath: undefined,
    source: "sandking-package",
    executable: true,
  },
]);

const workerVisibleSkillContract = Object.freeze([
  {
    identity: "sandking.issue-implementation",
    path: ".sandcastle/implement-prompt.md",
  },
  {
    identity: "sandking.issue-planning",
    path: ".sandcastle/plan-prompt.md",
  },
  {
    identity: "sandking.pull-request-review",
    path: ".sandcastle/pr-review-prompt.md",
  },
]);
const PRODUCTION_WORKER_SKILL_BUNDLE = "sandking.production-worker-skills";

/** @param {Buffer | string} value */
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

/**
 * @param {{path: string}} left
 * @param {{path: string}} right
 */
const compareSeedPaths = (left, right) => left.path < right.path
  ? -1
  : left.path > right.path
    ? 1
    : 0;

/**
 * Bind the immutable seed implementation to the recorded Sand-King revision.
 * Every source artifact except the self-referential provenance and independently
 * digested skill lock must originate at the recorded Sand-King revision.
 * @param {z.infer<typeof seedManifestSchema>} manifest
 */
const seedSourceIntegrity = (manifest) => sha256(
  [...manifest.files]
    .filter(({ path }) => path !== "provenance.json" && path !== "skills.lock.json")
    .sort(compareSeedPaths)
    .map((file) => JSON.stringify({
      path: file.path,
      source: file.source,
      sourcePath: file.sourcePath ?? file.path,
      integrity: file.integrity,
      executable: file.executable,
    }))
    .join("\n") + "\n",
);

export class ProductionHarnessSeedError extends Error {
  /** @param {"harness_seed_missing" | "harness_seed_provenance_invalid" | "harness_dependency_lock_invalid" | "harness_skill_lock_invalid"} code */
  constructor(code) {
    super(code);
    this.name = "ProductionHarnessSeedError";
    this.code = code;
  }
}

/** @param {string} path */
const invalidSeedCodeForPath = (path) => {
  if (path === "provenance.json") return "harness_seed_provenance_invalid";
  if (path === "package.json" || path === "package-lock.json") {
    return "harness_dependency_lock_invalid";
  }
  if (path === "skills.lock.json" || path.startsWith("skills/")) {
    return "harness_skill_lock_invalid";
  }
  return "harness_seed_missing";
};

/** @param {string} path @param {"harness_seed_missing" | "harness_seed_provenance_invalid" | "harness_dependency_lock_invalid" | "harness_skill_lock_invalid"} code */
const parseJson = (path, code) => {
  try {
    return JSON.parse(path);
  } catch {
    throw new ProductionHarnessSeedError(code);
  }
};

/** @param {Map<string, Buffer>} files */
const validateRuntimeModuleClosure = (files) => {
  const moduleSpecifierPatterns = [
    /\b(?:import|export)\s+(?:[^;"']*?\s+from\s+)?(["'])([^"']+)\1/g,
    /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g,
  ];
  for (const [path, source] of files) {
    if (!/\.[cm]?[jt]s$/.test(path)) continue;
    const text = source.toString("utf8");
    for (const pattern of moduleSpecifierPatterns) {
      for (const match of text.matchAll(pattern)) {
        const specifier = match[2];
        if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
        const resolved = posix.normalize(posix.join(posix.dirname(path), specifier));
        if (!relativeFileSchema.safeParse(resolved).success || !files.has(resolved)) {
          throw new ProductionHarnessSeedError("harness_seed_missing");
        }
      }
    }
  }
};

/** @param {Map<string, Buffer>} files */
const findWorkerVisibleSkillPaths = (files) => {
  const paths = new Set();
  for (const [path, source] of files) {
    if (!/^\.sandcastle\/.*\.m[jt]s$/.test(path)) continue;
    const text = source.toString("utf8");
    const promptFileProperties = [...text.matchAll(/\bpromptFile\s*:/g)];
    const staticPromptFiles = [...text.matchAll(
      /\bpromptFile\s*:\s*(["'])(\.\/[^"']+)\1/g,
    )];
    if (promptFileProperties.length !== staticPromptFiles.length) {
      throw new ProductionHarnessSeedError("harness_skill_lock_invalid");
    }
    for (const match of staticPromptFiles) {
      const promptPath = posix.normalize(match[2].slice(2));
      if (!relativeFileSchema.safeParse(promptPath).success) {
        throw new ProductionHarnessSeedError("harness_skill_lock_invalid");
      }
      paths.add(promptPath);
    }
  }
  return paths;
};

/**
 * @param {Map<string, Buffer>} files
 * @param {z.infer<typeof productionHarnessSkillLockSchema>} lock
 * @param {z.infer<typeof productionHarnessProvenanceSchema>} provenance
 */
const validateSkillInventory = (files, lock, provenance) => {
  const skills = new Map(lock.skills.map((skill) => [skill.identity, skill]));
  const skillsByPath = new Map(lock.skills.map((skill) => [skill.source.path, skill]));
  const bundles = new Map(lock.bundles.map((bundle) => [bundle.identity, bundle]));
  const plugins = new Map(lock.plugins.map((plugin) => [plugin.identity, plugin]));
  if (
    skills.size !== lock.skills.length
    || skillsByPath.size !== lock.skills.length
    || bundles.size !== lock.bundles.length
    || plugins.size !== lock.plugins.length
  ) {
    throw new ProductionHarnessSeedError("harness_skill_lock_invalid");
  }

  /** @param {string} bundleId @param {Set<string>} visiting */
  const expandedBundleSkills = (bundleId, visiting = new Set()) => {
    const bundle = bundles.get(bundleId);
    if (!bundle || visiting.has(bundleId)) {
      throw new ProductionHarnessSeedError("harness_skill_lock_invalid");
    }
    const nextVisiting = new Set(visiting).add(bundleId);
    const resolved = new Set(bundle.skills);
    for (const included of bundle.includes) {
      for (const skillId of expandedBundleSkills(included, nextVisiting)) resolved.add(skillId);
    }
    return resolved;
  };

  for (const bundle of lock.bundles) {
    for (const skillId of expandedBundleSkills(bundle.identity)) {
      if (!skills.has(skillId)) {
        throw new ProductionHarnessSeedError("harness_skill_lock_invalid");
      }
    }
  }
  for (const plugin of lock.plugins) {
    if (plugin.skills.some((skillId) => !skills.has(skillId))) {
      throw new ProductionHarnessSeedError("harness_skill_lock_invalid");
    }
  }
  for (const skill of lock.skills) {
    const source = files.get(skill.source.path);
    if (
      !source
      || sha256(source) !== skill.contentIntegrity
      || (skill.source.repository === provenance.sandKing.repository
        && skill.source.revision !== provenance.sandKing.revision)
    ) {
      throw new ProductionHarnessSeedError("harness_skill_lock_invalid");
    }
    for (const provider of skill.providers) {
      if (provider.kind === "bundle"
        && !expandedBundleSkills(provider.identity).has(skill.identity)) {
        throw new ProductionHarnessSeedError("harness_skill_lock_invalid");
      }
      if (provider.kind === "plugin"
        && !plugins.get(provider.identity)?.skills.includes(skill.identity)) {
        throw new ProductionHarnessSeedError("harness_skill_lock_invalid");
      }
    }
  }
  const workerVisiblePaths = findWorkerVisibleSkillPaths(files);
  if ([...workerVisiblePaths].some((path) => !skillsByPath.has(path))) {
    throw new ProductionHarnessSeedError("harness_skill_lock_invalid");
  }
  const productionBundleSkills = expandedBundleSkills(PRODUCTION_WORKER_SKILL_BUNDLE);
  for (const expected of workerVisibleSkillContract) {
    const skill = skills.get(expected.identity);
    if (
      !skill
      || skill.source.path !== expected.path
      || !workerVisiblePaths.has(expected.path)
      || !productionBundleSkills.has(expected.identity)
    ) {
      throw new ProductionHarnessSeedError("harness_skill_lock_invalid");
    }
  }
  const codexRuntime = lock.executionRuntimeInputs.find((input) =>
    input.identity === "openai.codex-cli");
  if (
    !codexRuntime
    || codexRuntime.package !== "@openai/codex"
    || codexRuntime.version !== CODEX_VERSION
    || codexRuntime.resolved !== CODEX_RESOLVED
    || codexRuntime.integrity !== CODEX_INTEGRITY
  ) {
    throw new ProductionHarnessSeedError("harness_skill_lock_invalid");
  }
};

/** @param {Record<string, unknown>} packages @param {string} packagePath @param {string} name */
const resolveLockedDependency = (packages, packagePath, name) => {
  let current = packagePath;
  while (current) {
    const nested = `${current}/node_modules/${name}`;
    if (Object.hasOwn(packages, nested)) return nested;
    const parentMarker = current.lastIndexOf("/node_modules/");
    current = parentMarker < 0 ? "" : current.slice(0, parentMarker);
  }
  const topLevel = `node_modules/${name}`;
  return Object.hasOwn(packages, topLevel) ? topLevel : null;
};

/** @param {Record<string, any>} lock @param {Record<string, string>} dependencies */
const validateDependencyLock = (lock, dependencies) => {
  if (
    lock?.lockfileVersion !== 3
    || lock?.requires !== true
    || !lock.packages
    || typeof lock.packages !== "object"
    || Array.isArray(lock.packages)
    || lock?.packages?.[""]?.dependencies == null
    || JSON.stringify(lock.packages[""].dependencies) !== JSON.stringify(dependencies)
  ) {
    throw new ProductionHarnessSeedError("harness_dependency_lock_invalid");
  }
  const dependencyGraph = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || (path !== "" && !path.startsWith("node_modules/"))
      || (path !== "" && !exactVersionSchema.safeParse(entry.version).success)
      || (path !== "" && !sourceUrlSchema.safeParse(entry.resolved).success)
      || (path !== "" && !packageIntegritySchema.safeParse(entry.integrity).success)
    ) {
      throw new ProductionHarnessSeedError("harness_dependency_lock_invalid");
    }
    const resolvedDependencies = new Set();
    for (const field of ["dependencies", "optionalDependencies"]) {
      const declared = entry[field] ?? {};
      if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
        throw new ProductionHarnessSeedError("harness_dependency_lock_invalid");
      }
      for (const [name, requested] of Object.entries(declared)) {
        const resolved = typeof requested === "string"
          ? resolveLockedDependency(lock.packages, path, name)
          : null;
        if (!resolved) {
          throw new ProductionHarnessSeedError("harness_dependency_lock_invalid");
        }
        resolvedDependencies.add(resolved);
      }
    }
    const peers = entry.peerDependencies ?? {};
    if (!peers || typeof peers !== "object" || Array.isArray(peers)) {
      throw new ProductionHarnessSeedError("harness_dependency_lock_invalid");
    }
    for (const [name, requested] of Object.entries(peers)) {
      if (entry.peerDependenciesMeta?.[name]?.optional === true) continue;
      const resolved = typeof requested === "string"
        ? resolveLockedDependency(lock.packages, path, name)
        : null;
      if (!resolved) {
        throw new ProductionHarnessSeedError("harness_dependency_lock_invalid");
      }
      resolvedDependencies.add(resolved);
    }
    dependencyGraph.set(path, resolvedDependencies);
  }
  const reachable = new Set([""]);
  const pending = [""];
  while (pending.length > 0) {
    for (const path of dependencyGraph.get(pending.shift()) ?? []) {
      if (reachable.has(path)) continue;
      reachable.add(path);
      pending.push(path);
    }
  }
  if (reachable.size !== Object.keys(lock.packages).length) {
    throw new ProductionHarnessSeedError("harness_dependency_lock_invalid");
  }
  const sandcastle = lock.packages["node_modules/@ai-hero/sandcastle"];
  if (
    sandcastle?.version !== SANDCASTLE_VERSION
    || sandcastle?.resolved !== SANDCASTLE_RESOLVED
    || sandcastle?.integrity !== SANDCASTLE_INTEGRITY
  ) {
    throw new ProductionHarnessSeedError("harness_dependency_lock_invalid");
  }
};

/**
 * Load and validate every byte before creating a Harness workspace.
 * A custom root is a fully materialized seed and is used by failure-contract tests.
 * @param {{sourceRoot?: string}} [options]
 */
export const loadProductionHarnessSeed = async (options = {}) => {
  const customSource = typeof options.sourceRoot === "string";
  const seedRoot = options.sourceRoot ?? bundledProductionHarnessSeedRoot;
  let manifestSource;
  let manifest;
  try {
    manifestSource = await readFile(join(seedRoot, "seed-manifest.json"));
    manifest = seedManifestSchema.parse(JSON.parse(manifestSource.toString("utf8")));
  } catch {
    throw new ProductionHarnessSeedError("harness_seed_missing");
  }
  const manifestFiles = new Map(manifest.files.map((file) => [file.path, file]));
  if (
    manifestFiles.size !== manifest.files.length
    || manifestFiles.size !== productionSeedFileContract.length
    || productionSeedFileContract.some((expected) => {
      const actual = manifestFiles.get(expected.path);
      return !actual
        || actual.source !== expected.source
        || actual.sourcePath !== expected.sourcePath
        || actual.executable !== expected.executable;
    })
  ) {
    throw new ProductionHarnessSeedError("harness_seed_missing");
  }

  const files = new Map();
  let totalBytes = manifestSource.byteLength;
  for (const file of manifest.files) {
    const sourcePath = customSource
      ? join(seedRoot, ...file.path.split("/"))
      : file.source === "seed"
        ? join(seedRoot, ...(file.sourcePath ?? file.path).split("/"))
        : join(packageRoot, ...(file.sourcePath ?? file.path).split("/"));
    let source;
    try {
      const details = await stat(sourcePath);
      if (!details.isFile()) throw new Error("not_regular");
      source = await readFile(sourcePath);
    } catch {
      throw new ProductionHarnessSeedError(invalidSeedCodeForPath(file.path));
    }
    totalBytes += source.byteLength;
    if (totalBytes > 4 * 1024 * 1024 || sha256(source) !== file.integrity) {
      throw new ProductionHarnessSeedError(invalidSeedCodeForPath(file.path));
    }
    files.set(file.path, source);
  }
  validateRuntimeModuleClosure(files);

  let compatibility;
  try {
    compatibility = harnessCompatibilityManifestSchema.parse(parseJson(
      files.get("harness.json").toString("utf8"),
      "harness_seed_missing",
    ));
  } catch (error) {
    if (error instanceof ProductionHarnessSeedError) throw error;
    throw new ProductionHarnessSeedError("harness_seed_missing");
  }
  if (compatibility.compatibility.adapterId !== SANDCASTLE_HARNESS_ADAPTER_ID) {
    throw new ProductionHarnessSeedError("harness_seed_missing");
  }

  let provenance;
  try {
    provenance = productionHarnessProvenanceSchema.parse(parseJson(
      files.get("provenance.json").toString("utf8"),
      "harness_seed_provenance_invalid",
    ));
  } catch (error) {
    if (error instanceof ProductionHarnessSeedError) throw error;
    throw new ProductionHarnessSeedError("harness_seed_provenance_invalid");
  }

  let packageManifest;
  let dependencyLock;
  try {
    packageManifest = JSON.parse(files.get("package.json").toString("utf8"));
    dependencyLock = JSON.parse(files.get("package-lock.json").toString("utf8"));
  } catch {
    throw new ProductionHarnessSeedError("harness_dependency_lock_invalid");
  }
  const expectedDependencies = {
    "@ai-hero/sandcastle": SANDCASTLE_VERSION,
    tsx: "4.23.1",
    zod: "4.4.3",
  };
  if (
    packageManifest?.private !== true
    || packageManifest?.type !== "module"
    || JSON.stringify(packageManifest.dependencies) !== JSON.stringify(expectedDependencies)
  ) {
    throw new ProductionHarnessSeedError("harness_dependency_lock_invalid");
  }
  validateDependencyLock(dependencyLock, expectedDependencies);
  if (sha256(files.get("package-lock.json"))
    !== provenance.artifacts.dependencyLock.integrity) {
    throw new ProductionHarnessSeedError("harness_dependency_lock_invalid");
  }

  let skillLock;
  try {
    skillLock = productionHarnessSkillLockSchema.parse(JSON.parse(
      files.get("skills.lock.json").toString("utf8"),
    ));
  } catch {
    throw new ProductionHarnessSeedError("harness_skill_lock_invalid");
  }
  validateSkillInventory(files, skillLock, provenance);
  if (sha256(files.get("skills.lock.json"))
    !== provenance.artifacts.skillSetLock.integrity) {
    throw new ProductionHarnessSeedError("harness_skill_lock_invalid");
  }
  if (seedSourceIntegrity(manifest) !== provenance.sandKing.seedSourceIntegrity) {
    throw new ProductionHarnessSeedError("harness_seed_provenance_invalid");
  }

  return {
    manifest,
    manifestSource,
    files,
    provenance,
    skillLock,
    dependencyLock,
  };
};

/**
 * @param {string} workspacePath
 * @param {{sourceRoot?: string}} [options]
 */
export const initializeProductionHarnessWorkspace = async (workspacePath, options = {}) => {
  const seed = await loadProductionHarnessSeed(options);
  const gitEnvironment = {
    ...process.env,
    LANG: "C.UTF-8",
    TZ: "UTC",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Sand-King Production Seed",
    GIT_AUTHOR_EMAIL: "production-seed@sandking.invalid",
    GIT_COMMITTER_NAME: "Sand-King Production Seed",
    GIT_COMMITTER_EMAIL: "production-seed@sandking.invalid",
    GIT_AUTHOR_DATE: "2026-08-10T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-10T00:00:00Z",
  };
  await mkdir(workspacePath, { recursive: true, mode: 0o700 });
  for (const file of [...seed.manifest.files].sort((left, right) =>
    left.path.localeCompare(right.path))) {
    const destination = join(workspacePath, ...file.path.split("/"));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, seed.files.get(file.path), {
      mode: file.executable ? 0o700 : 0o600,
    });
  }
  await writeFile(join(workspacePath, "seed-manifest.json"), seed.manifestSource, {
    mode: 0o600,
  });
  await execFileAsync("git", [
    "init", "--quiet", "--initial-branch=main", "--object-format=sha1", workspacePath,
  ], { env: gitEnvironment });
  await execFileAsync("git", ["-C", workspacePath, "add", "--all"], {
    env: gitEnvironment,
  });
  const dependencyLockIntegrity = sha256(seed.files.get("package-lock.json"));
  const skillLockIntegrity = sha256(seed.files.get("skills.lock.json"));
  await execFileAsync("git", [
    "-C", workspacePath,
    "-c", "user.name=Sand-King Production Seed",
    "-c", "user.email=production-seed@sandking.invalid",
    "-c", "commit.gpgSign=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "commit.cleanup=verbatim",
    "commit", "--quiet",
    "-m", "Initialize Sand-King Sandcastle Harness",
    "-m", [
      `Sand-King-Seed: ${seed.provenance.sandKing.repository}@${seed.provenance.sandKing.revision}`,
      `Sand-King-Seed-Source: ${seed.provenance.sandKing.seedSourceIntegrity}`,
      `Upstream-Sandcastle: ${seed.provenance.sandcastle.repository}@${seed.provenance.sandcastle.revision}`,
      `Sandcastle-Package: ${seed.provenance.sandcastle.package}@${seed.provenance.sandcastle.version}`,
      `Dependency-Lock: ${dependencyLockIntegrity}`,
      `Skill-Set-Lock: ${skillLockIntegrity}`,
    ].join("\n"),
  ], {
    env: gitEnvironment,
  });
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workspacePath, "rev-parse", "HEAD"],
    { env: gitEnvironment },
  );
  const revision = stdout.trim();
  if (!commitSchema.safeParse(revision).success) {
    throw new ProductionHarnessSeedError("harness_seed_missing");
  }
  return { revision, seed };
};
