import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class ProjectPreparationFileError extends Error {
  /** @param {"harness_projection_collision" | "harness_projection_failed"} code */
  constructor(code) {
    super(code);
    this.name = "ProjectPreparationFileError";
    this.code = code;
  }
}

/** @param {string} path */
export const readProjectPreparationFile = async (path) => {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
      throw new ProjectPreparationFileError("harness_projection_collision");
    }
    return { exists: true, source: await readFile(path, "utf8") };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { exists: false, source: "" };
    }
    if (error instanceof ProjectPreparationFileError) throw error;
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
};

/** @param {string} path @param {string} temporaryId */
const projectPreparationTemporaryPath = (path, temporaryId) => {
  if (!/^[a-z0-9-]{1,128}$/.test(temporaryId)) {
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
  return `${path}.sandking-${temporaryId}.tmp`;
};

/** @param {string} path */
const assertSafeFileParent = async (path) => {
  const parent = dirname(path);
  try {
    const details = await lstat(parent);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new ProjectPreparationFileError("harness_projection_collision");
    }
  } catch (error) {
    if (error instanceof ProjectPreparationFileError) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      try {
        const parentDetails = await lstat(dirname(parent));
        if (!parentDetails.isDirectory() || parentDetails.isSymbolicLink()) {
          throw new ProjectPreparationFileError("harness_projection_collision");
        }
        return;
      } catch (parentError) {
        if (parentError instanceof ProjectPreparationFileError) throw parentError;
      }
    }
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
};

/** @param {unknown} error @param {string} code */
const hasFileErrorCode = (error, code) =>
  Boolean(error && typeof error === "object" && "code" in error && error.code === code);

/**
 * Atomically move the current path into a private capture directory before
 * inspecting or removing it. A file created at the public path after this
 * claim is a distinct Project mutation and is never overwritten or deleted.
 *
 * @param {string} path
 * @param {{directory?: string}} [options]
 */
export const captureProjectPreparationFile = async (path, options = {}) => {
  await assertSafeFileParent(path);
  let captureDirectory;
  try {
    captureDirectory = await mkdtemp(options.directory
      ? join(options.directory, ".sandking-capture-")
      : `${path}.sandking-capture-`);
  } catch {
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
  const capturedPath = join(captureDirectory, "captured");
  try {
    await rename(path, capturedPath);
  } catch (error) {
    await rmdir(captureDirectory).catch(() => undefined);
    if (hasFileErrorCode(error, "ENOENT")) {
      return {
        exists: false,
        source: "",
        remove: async () => undefined,
        restore: async () => undefined,
      };
    }
    throw new ProjectPreparationFileError("harness_projection_failed");
  }

  let current;
  const closeCaptureDirectory = () => rmdir(captureDirectory)
    .catch((error) => {
      throw new ProjectPreparationFileError("harness_projection_failed");
    });
  const restoreCapturedPath = async () => {
    try {
      await link(capturedPath, path);
      await rm(capturedPath);
    } catch (error) {
      if (hasFileErrorCode(error, "EEXIST")) {
        throw new ProjectPreparationFileError("harness_projection_collision");
      }
      const destinationExists = await lstat(path).then(
        () => true,
        (candidate) => hasFileErrorCode(candidate, "ENOENT") ? false : Promise.reject(candidate),
      );
      if (destinationExists) {
        throw new ProjectPreparationFileError("harness_projection_collision");
      }
      try {
        await rename(capturedPath, path);
      } catch {
        throw new ProjectPreparationFileError("harness_projection_collision");
      }
    }
    await closeCaptureDirectory();
  };
  try {
    current = await readProjectPreparationFile(capturedPath);
  } catch (error) {
    await restoreCapturedPath().catch(() => undefined);
    if (error instanceof ProjectPreparationFileError) throw error;
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
  let active = true;
  return {
    ...current,
    remove: async () => {
      if (!active) return;
      await rm(capturedPath);
      active = false;
      await closeCaptureDirectory();
    },
    restore: async () => {
      if (!active) return;
      await restoreCapturedPath();
      active = false;
    },
  };
};

/** @param {string} path @param {string} source @param {string} temporaryId */
const writeProjectPreparationTemporaryFile = async (path, source, temporaryId) => {
  const temporaryPath = projectPreparationTemporaryPath(path, temporaryId);
  let created = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(source, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return temporaryPath;
  } catch (error) {
    if (created) await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (hasFileErrorCode(error, "EEXIST")) {
      throw new ProjectPreparationFileError("harness_projection_collision");
    }
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
};

/** @param {string} path @param {string} source @param {{temporaryId?: string}} [options] */
const replaceProjectPreparationFile = async (path, source, options = {}) => {
  const temporaryId = options.temporaryId
    ?? `${process.pid}-${randomBytes(6).toString("hex")}`;
  let temporaryPath;
  try {
    temporaryPath = await writeProjectPreparationTemporaryFile(
      path,
      source,
      temporaryId,
    );
    await rename(temporaryPath, path);
    temporaryPath = undefined;
  } catch (error) {
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof ProjectPreparationFileError) throw error;
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
};

/** @param {string} path @param {string} source @param {{temporaryId?: string}} [options] */
export const createProjectPreparationFile = async (path, source, options = {}) => {
  const temporaryId = options.temporaryId
    ?? `${process.pid}-${randomBytes(6).toString("hex")}`;
  let temporaryPath;
  try {
    temporaryPath = await writeProjectPreparationTemporaryFile(
      path,
      source,
      temporaryId,
    );
    await link(temporaryPath, path);
    await rm(temporaryPath);
    temporaryPath = undefined;
  } catch (error) {
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof ProjectPreparationFileError) throw error;
    if (hasFileErrorCode(error, "EEXIST")) {
      throw new ProjectPreparationFileError("harness_projection_collision");
    }
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
};

/** @param {string} path @param {string} temporaryId */
export const removeProjectPreparationTemporaryFile = async (path, temporaryId) => {
  await assertSafeFileParent(path);
  const temporaryPath = projectPreparationTemporaryPath(path, temporaryId);
  const temporary = await readProjectPreparationFile(temporaryPath);
  if (!temporary.exists) return { removed: false };
  await rm(temporaryPath);
  return { removed: true };
};

/** @param {string} projectRoot */
export const resolveProjectGitExcludePath = async (projectRoot) => {
  try {
    const { stdout: repositoryRoot } = await execFileAsync("git", [
      "-C", projectRoot, "rev-parse", "--show-toplevel",
    ], {
      env: {
        LANG: "C.UTF-8",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      timeout: 5_000,
      maxBuffer: 32_768,
    });
    if (resolve(repositoryRoot.trim()) !== projectRoot) {
      throw new ProjectPreparationFileError("harness_projection_failed");
    }
    const { stdout: excludePathValue } = await execFileAsync("git", [
      "-C", projectRoot, "rev-parse", "--git-path", "info/exclude",
    ], {
      env: {
        LANG: "C.UTF-8",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      timeout: 5_000,
      maxBuffer: 32_768,
    });
    return resolve(projectRoot, excludePathValue.trim());
  } catch (error) {
    if (error instanceof ProjectPreparationFileError) throw error;
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
};

/**
 * Remove only rules owned by one preparation. A marker makes temporary rules
 * unambiguous across Host restart; unmarked callers remove one occurrence of
 * each rule they appended and retain every other line.
 *
 * @param {{
 *   path: string,
 *   rules: string[],
 *   ownershipMarker?: string,
 *   removeFileWhenEmpty?: boolean,
 *   temporaryId?: string,
 * }} options
 */
const removeProjectGitExcludeRulesAtPath = async (options) => {
  await assertSafeFileParent(options.path);
  if (options.temporaryId) {
    await removeProjectPreparationTemporaryFile(options.path, options.temporaryId);
  }
  const current = await readProjectPreparationFile(options.path);
  if (!current.exists) return { changed: false };
  const lines = current.source.split("\n");
  if (options.ownershipMarker) {
    const markerIndexes = lines.flatMap((line, index) =>
      line === options.ownershipMarker ? [index] : []);
    if (markerIndexes.length === 0) return { changed: false };
    if (
      markerIndexes.length !== 1
      || options.rules.some((rule, offset) =>
        lines[markerIndexes[0] + offset + 1] !== rule)
    ) {
      throw new ProjectPreparationFileError("harness_projection_collision");
    }
    lines.splice(markerIndexes[0], options.rules.length + 1);
  } else {
    for (const rule of options.rules) {
      const index = lines.indexOf(rule);
      if (index !== -1) lines.splice(index, 1);
    }
  }
  const nextSource = lines.join("\n");
  if (nextSource === current.source) return { changed: false };
  if (options.removeFileWhenEmpty && nextSource.length === 0) {
    await rm(options.path, { force: true });
  } else {
    await replaceProjectPreparationFile(options.path, nextSource, {
      temporaryId: options.temporaryId,
    });
  }
  return { changed: true };
};

/**
 * Remove Host-owned local ignore rules without restoring an earlier snapshot
 * over edits made while preparation was active.
 *
 * @param {{projectPath: string, rules: string[], ownershipMarker?: string, temporaryId?: string}} options
 */
export const removeProjectGitExcludeRules = async (options) => {
  const projectRoot = resolve(options.projectPath);
  const excludePath = await resolveProjectGitExcludePath(projectRoot);
  return removeProjectGitExcludeRulesAtPath({
    path: excludePath,
    rules: options.rules,
    ownershipMarker: options.ownershipMarker,
    temporaryId: options.temporaryId,
  });
};

/**
 * Append local-only ignore rules with the same alias rejection and atomic
 * replacement used by every Project preparation write.
 *
 * @param {{projectPath: string, rules: string[], ownershipMarker?: string, temporaryId?: string}} options
 */
export const appendProjectGitExcludeRules = async (options) => {
  if (
    options.rules.length === 0
    || new Set(options.rules).size !== options.rules.length
    || options.rules.some((rule) => !rule.startsWith("/") || rule.includes("\0"))
    || (options.ownershipMarker !== undefined && (
      !options.ownershipMarker.startsWith("# ")
      || options.ownershipMarker.includes("\n")
      || options.ownershipMarker.includes("\0")
    ))
  ) {
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
  const projectRoot = resolve(options.projectPath);
  const excludePath = await resolveProjectGitExcludePath(projectRoot);

  await assertSafeFileParent(excludePath);
  const original = await readProjectPreparationFile(excludePath);
  const existingRules = new Set(original.source.split("\n"));
  const addedRules = options.rules.filter((rule) => !existingRules.has(rule));
  if (addedRules.length === 0) {
    return { path: excludePath, changed: false, rollback: async () => undefined };
  }
  const appendedLines = options.ownershipMarker
    ? [options.ownershipMarker, ...addedRules]
    : addedRules;
  const nextSource = `${original.source}${original.source.endsWith("\n")
    || original.source.length === 0 ? "" : "\n"}${appendedLines.join("\n")}\n`;
  try {
    await mkdir(dirname(excludePath), { recursive: true, mode: 0o700 });
    await replaceProjectPreparationFile(excludePath, nextSource, {
      temporaryId: options.temporaryId,
    });
  } catch (error) {
    if (error instanceof ProjectPreparationFileError) throw error;
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
  let active = true;
  return {
    path: excludePath,
    changed: true,
    rollback: async () => {
      if (!active) return;
      await removeProjectGitExcludeRulesAtPath({
        path: excludePath,
        rules: addedRules,
        ownershipMarker: options.ownershipMarker,
        removeFileWhenEmpty: !original.exists,
        temporaryId: options.temporaryId,
      });
      active = false;
    },
  };
};
