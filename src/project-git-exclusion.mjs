import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { digestHex } from "./common/digest.mjs";

const execFileAsync = promisify(execFile);
const MAX_PROJECT_PREPARATION_COMMIT_ATTEMPTS = 8;
const MAX_PROJECT_PREPARATION_RECONCILIATION_DEPTH = 8;

export class ProjectPreparationFileError extends Error {
  /** @param {"harness_projection_collision" | "harness_projection_failed"} code */
  constructor(code) {
    super(code);
    this.name = "ProjectPreparationFileError";
    this.code = code;
  }
}

/** @param {import("node:fs").BigIntStats} details */
const projectPreparationFileIdentity = (details) => ({
  birthtimeNanoseconds: details.birthtimeNs.toString(),
  device: details.dev.toString(),
  inode: details.ino.toString(),
});

/**
 * @param {{birthtimeNanoseconds: string, device: string, inode: string} | undefined} left
 * @param {{birthtimeNanoseconds: string, device: string, inode: string} | undefined} right
 */
export const projectPreparationFileIdentityMatches = (left, right) =>
  Boolean(
    left
    && right
    && left.birthtimeNanoseconds === right.birthtimeNanoseconds
    && left.device === right.device
    && left.inode === right.inode,
  );

/** @param {string} path @param {{maximumLinks?: number}} [options] */
export const readProjectPreparationFile = async (path, options = {}) => {
  /** @type {import("node:fs/promises").FileHandle | undefined} */
  let handle;
  try {
    const pathDetails = await lstat(path, { bigint: true });
    if (!pathDetails.isFile() || pathDetails.isSymbolicLink()) {
      throw new ProjectPreparationFileError("harness_projection_collision");
    }
    handle = await open(path, "r");
    const details = await handle.stat({ bigint: true });
    const maximumLinks = BigInt(options.maximumLinks ?? 1);
    if (
      !details.isFile()
      || details.nlink < 1n
      || details.nlink > maximumLinks
      || !projectPreparationFileIdentityMatches(
        projectPreparationFileIdentity(pathDetails),
        projectPreparationFileIdentity(details),
      )
    ) {
      throw new ProjectPreparationFileError("harness_projection_collision");
    }
    const source = await handle.readFile("utf8");
    const currentPathDetails = await lstat(path, { bigint: true });
    if (
      currentPathDetails.isSymbolicLink()
      || !projectPreparationFileIdentityMatches(
        projectPreparationFileIdentity(currentPathDetails),
        projectPreparationFileIdentity(details),
      )
    ) {
      throw new ProjectPreparationFileError("harness_projection_collision");
    }
    return {
      exists: true,
      identity: projectPreparationFileIdentity(details),
      source,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { exists: false, identity: undefined, source: "" };
    }
    if (error instanceof ProjectPreparationFileError) throw error;
    throw new ProjectPreparationFileError("harness_projection_failed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

/** @param {string} path @param {string} temporaryId */
const projectPreparationTemporaryPath = (path, temporaryId) => {
  if (!/^[a-z0-9-]{1,128}$/.test(temporaryId)) {
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
  return `${path}.sandking-${temporaryId}.tmp`;
};

/** @param {string} path @param {string} temporaryId */
export const readProjectPreparationTemporaryFile = (path, temporaryId) =>
  readProjectPreparationFile(projectPreparationTemporaryPath(path, temporaryId), {
    maximumLinks: 2,
  });

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

/** @param {string} captureId */
const assertProjectPreparationCaptureId = (captureId) => {
  if (!/^[a-z0-9-]{1,192}$/.test(captureId)) {
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
};

/**
 * @param {string} path
 * @param {{captureId?: string, directory?: string}} options
 */
const openProjectPreparationCaptureDirectory = async (path, options) => {
  const prefix = options.directory
    ? join(options.directory, ".sandking-capture-")
    : `${path}.sandking-capture-`;
  if (!options.captureId) {
    try {
      return { path: await mkdtemp(prefix), recovered: false };
    } catch {
      throw new ProjectPreparationFileError("harness_projection_failed");
    }
  }
  assertProjectPreparationCaptureId(options.captureId);
  const capturePath = `${prefix}${options.captureId}`;
  try {
    await mkdir(capturePath, { mode: 0o700 });
    return { path: capturePath, recovered: false };
  } catch (error) {
    if (!hasFileErrorCode(error, "EEXIST")) {
      throw new ProjectPreparationFileError("harness_projection_failed");
    }
    try {
      const details = await lstat(capturePath);
      const entries = await readdir(capturePath);
      if (
        !details.isDirectory()
        || details.isSymbolicLink()
        || entries.some((entry) => entry !== "captured")
      ) {
        throw new ProjectPreparationFileError("harness_projection_collision");
      }
      return { path: capturePath, recovered: true };
    } catch (recoveryError) {
      if (recoveryError instanceof ProjectPreparationFileError) throw recoveryError;
      throw new ProjectPreparationFileError("harness_projection_failed");
    }
  }
};

/**
 * Atomically move the current path into a private capture directory before
 * inspecting or removing it. A file created at the public path after this
 * claim is a distinct Project mutation and is never overwritten or deleted.
 *
 * @param {string} path
 * A caller with durable cleanup ownership supplies a stable capture ID. A
 * restart then resumes the same capture instead of treating the missing public
 * path as a completed removal.
 *
 * @param {{captureId?: string, directory?: string, maximumLinks?: number}} [options]
 */
export const captureProjectPreparationFile = async (path, options = {}) => {
  await assertSafeFileParent(path);
  const capture = await openProjectPreparationCaptureDirectory(path, options);
  const captureDirectory = capture.path;
  const capturedPath = join(captureDirectory, "captured");
  if (!capture.recovered || !(await lstat(capturedPath).then(
    () => true,
    (error) => hasFileErrorCode(error, "ENOENT") ? false : Promise.reject(error),
  ))) {
    try {
      await rename(path, capturedPath);
    } catch (error) {
      await rmdir(captureDirectory).catch(() => undefined);
      if (hasFileErrorCode(error, "ENOENT")) {
        return {
          exists: false,
          identity: undefined,
          source: "",
          refresh: async () => ({ exists: false, identity: undefined, source: "" }),
          remove: async () => undefined,
          restore: async () => undefined,
        };
      }
      throw new ProjectPreparationFileError("harness_projection_failed");
    }
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
        const [captured, destination] = await Promise.all([
          readProjectPreparationFile(capturedPath, { maximumLinks: 2 }),
          readProjectPreparationFile(path, { maximumLinks: 2 }),
        ]);
        if (!projectPreparationFileIdentityMatches(
          captured.identity,
          destination.identity,
        )) {
          throw new ProjectPreparationFileError("harness_projection_collision");
        }
        await rm(capturedPath);
        await closeCaptureDirectory();
        return;
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
    current = await readProjectPreparationFile(capturedPath, {
      maximumLinks: options.maximumLinks,
    });
  } catch (error) {
    await restoreCapturedPath().catch(() => undefined);
    if (error instanceof ProjectPreparationFileError) throw error;
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
  let active = true;
  return {
    ...current,
    refresh: () => readProjectPreparationFile(capturedPath, {
      maximumLinks: options.maximumLinks,
    }),
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

/** @param {string} temporaryId */
const projectPreparationReplacementCaptureId = (temporaryId) =>
  `replace-${temporaryId}`;

/** @param {string} temporaryId */
const projectPreparationRollbackCaptureId = (temporaryId) =>
  `rollback-${temporaryId}`;

/** @param {string} temporaryId */
const projectPreparationReconciliationTemporaryId = (temporaryId) =>
  `reconcile-${digestHex(temporaryId).slice(0, 32)}`;

/** @param {string} source @param {string} candidate */
const projectGitExcludeSourceIsPreserved = (source, candidate) => {
  if (source.length === 0) return true;
  const requiredLines = source.split("\n");
  const candidateLines = candidate.split("\n");
  let requiredIndex = 0;
  for (const line of candidateLines) {
    if (line === requiredLines[requiredIndex]) requiredIndex += 1;
    if (requiredIndex === requiredLines.length) return true;
  }
  return false;
};

/** @param {string[]} sources */
const concatenateProjectGitExcludeSources = (sources) =>
  sources.filter((source) => source.length > 0).reduce((result, source) =>
    `${result}${result.length > 0 && !result.endsWith("\n") ? "\n" : ""}${source}`, "");

/**
 * Preserve each observed Git-exclude generation as an ordered sequence,
 * including duplicate rules, while keeping the newest public generation
 * authoritative. Missing generations are followed by the current generation
 * again so older rules cannot reverse a concurrent ignore or unignore choice.
 * Publication captures and compares the generation after the final read;
 * direct append cannot close that same-inode edit boundary.
 *
 * @param {string} path
 * @param {string} capturedPath
 * @param {string[]} observedSources
 * @param {{recoveryDepth: number, temporaryId: string}} publication
 */
const mergeCapturedProjectGitExcludeLines = async (
  path,
  capturedPath,
  observedSources,
  publication,
) => {
  /** @type {string[]} */
  const requiredSources = [];
  for (const source of observedSources) {
    if (!requiredSources.includes(source)) requiredSources.push(source);
  }
  for (let attempt = 0; attempt < MAX_PROJECT_PREPARATION_COMMIT_ATTEMPTS; attempt += 1) {
    let current = await readProjectPreparationFile(path, { maximumLinks: 2 });
    if (!current.exists) {
      try {
        await link(capturedPath, path);
      } catch (error) {
        if (hasFileErrorCode(error, "EEXIST")) continue;
        throw new ProjectPreparationFileError("harness_projection_failed");
      }
      current = await readProjectPreparationFile(path, { maximumLinks: 2 });
    }
    if (!requiredSources.includes(current.source)) requiredSources.push(current.source);
    const missingSources = requiredSources.filter((source) =>
      !projectGitExcludeSourceIsPreserved(source, current.source));
    if (missingSources.length === 0) return;

    /** @type {import("node:fs/promises").FileHandle | undefined} */
    let handle;
    try {
      handle = await open(path, "a+");
      const details = await handle.stat({ bigint: true });
      if (!projectPreparationFileIdentityMatches(
        current.identity,
        projectPreparationFileIdentity(details),
      )) continue;
      const sourceBeforePublication = await handle.readFile("utf8");
      if (sourceBeforePublication !== current.source) continue;
    } catch (error) {
      if (error instanceof ProjectPreparationFileError) throw error;
      throw new ProjectPreparationFileError("harness_projection_failed");
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const nextSource = concatenateProjectGitExcludeSources([
      current.source,
      ...missingSources,
      current.source,
    ]);
    const replacement = await replaceProjectPreparationFile(
      path,
      current,
      nextSource,
      {
        recoveryDepth: publication.recoveryDepth,
        temporaryId: publication.temporaryId,
      },
    );
    if (!replacement.committed) continue;
    const merged = await readProjectPreparationFile(path, { maximumLinks: 2 });
    if (requiredSources.every((source) =>
      projectGitExcludeSourceIsPreserved(source, merged.source))) return;
  }
  throw new ProjectPreparationFileError("harness_projection_collision");
};

/**
 * Finish rolling an already-published Host candidate back after the captured
 * generation changed through an older file descriptor. Both inodes remain in
 * named captures until the changed generation is public again, so restart can
 * resume every boundary without discarding either set of bytes.
 *
 * @param {string} path
 * @param {string} temporaryId
 */
const recoverProjectPreparationFileRollback = async (path, temporaryId) => {
  const rollbackCaptureId = projectPreparationRollbackCaptureId(temporaryId);
  const rollbackDirectory = `${path}.sandking-capture-${rollbackCaptureId}`;
  const rollbackExists = await lstat(rollbackDirectory).then(
    () => true,
    (error) => hasFileErrorCode(error, "ENOENT") ? false : Promise.reject(error),
  );
  if (!rollbackExists) return;

  const rollback = await captureProjectPreparationFile(path, {
    captureId: rollbackCaptureId,
    maximumLinks: 2,
  });
  const temporary = await readProjectPreparationTemporaryFile(path, temporaryId);
  if (
    !rollback.exists
    || !temporary.exists
    || !projectPreparationFileIdentityMatches(rollback.identity, temporary.identity)
  ) {
    const destination = await readProjectPreparationFile(path, { maximumLinks: 2 });
    if (!destination.exists) await rollback.restore();
    throw new ProjectPreparationFileError("harness_projection_collision");
  }

  const replacementCaptureId = projectPreparationReplacementCaptureId(temporaryId);
  const replacementDirectory = `${path}.sandking-capture-${replacementCaptureId}`;
  const replacementExists = await lstat(replacementDirectory).then(
    () => true,
    (error) => hasFileErrorCode(error, "ENOENT") ? false : Promise.reject(error),
  );
  if (replacementExists) {
    const changed = await captureProjectPreparationFile(path, {
      captureId: replacementCaptureId,
      maximumLinks: 2,
    });
    const destination = await readProjectPreparationFile(path, { maximumLinks: 2 });
    if (
      !changed.exists
      || (destination.exists && !projectPreparationFileIdentityMatches(
        destination.identity,
        changed.identity,
      ))
    ) {
      throw new ProjectPreparationFileError("harness_projection_collision");
    }
    await changed.restore();
  }

  const destination = await readProjectPreparationFile(path, { maximumLinks: 2 });
  if (!destination.exists || projectPreparationFileIdentityMatches(
    destination.identity,
    rollback.identity,
  )) {
    await rollback.restore();
  } else {
    await rollback.remove();
  }
};

/**
 * Finish a replacement interrupted after its old public generation was
 * captured. A published candidate is identified by its retained temporary
 * hard link; otherwise the captured user-owned generation returns to its
 * public name before another mutation attempt.
 *
 * @param {string} path
 * @param {string | undefined} temporaryId
 * @param {number} [recoveryDepth]
 */
const recoverProjectPreparationFileReplacement = async (
  path,
  temporaryId,
  recoveryDepth = 0,
) => {
  if (!temporaryId) return;
  await recoverProjectPreparationFileRollback(path, temporaryId);
  const captureId = projectPreparationReplacementCaptureId(temporaryId);
  const captureDirectory = `${path}.sandking-capture-${captureId}`;
  const captureExists = await lstat(captureDirectory).then(
    () => true,
    (error) => hasFileErrorCode(error, "ENOENT") ? false : Promise.reject(error),
  );
  if (!captureExists) return;
  if (recoveryDepth >= MAX_PROJECT_PREPARATION_RECONCILIATION_DEPTH) {
    throw new ProjectPreparationFileError("harness_projection_collision");
  }
  const reconciliationTemporaryId = projectPreparationReconciliationTemporaryId(
    temporaryId,
  );
  await recoverProjectPreparationFileReplacement(
    path,
    reconciliationTemporaryId,
    recoveryDepth + 1,
  );
  await removeProjectPreparationTemporaryFile(path, reconciliationTemporaryId);
  const captured = await captureProjectPreparationFile(path, {
    captureId,
    maximumLinks: 2,
  });
  if (!captured.exists) {
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
  const [candidate, destination] = await Promise.all([
    readProjectPreparationTemporaryFile(path, temporaryId),
    readProjectPreparationFile(path, { maximumLinks: 2 }),
  ]);
  if (
    candidate.exists
    && destination.exists
    && projectPreparationFileIdentityMatches(candidate.identity, destination.identity)
  ) {
    await captured.remove();
    return;
  }
  if (
    destination.exists
    && projectPreparationFileIdentityMatches(captured.identity, destination.identity)
  ) {
    await captured.restore();
    return;
  }
  if (!destination.exists) {
    await captured.restore();
    return;
  }
  await mergeCapturedProjectGitExcludeLines(
    path,
    join(captureDirectory, "captured"),
    [captured.source, destination.source],
    {
      recoveryDepth: recoveryDepth + 1,
      temporaryId: reconciliationTemporaryId,
    },
  );
  await captured.remove();
};

/**
 * Commit only over the file generation that was read. The old public path is
 * durably captured before publication, so a concurrent edit causes a rebase
 * instead of being overwritten by the candidate rename.
 *
 * @param {string} path
 * @param {{exists: boolean, identity: {birthtimeNanoseconds: string, device: string, inode: string} | undefined, source: string}} expected
 * @param {string | null} source
 * @param {{recoveryDepth?: number, temporaryId?: string}} [options]
 */
const replaceProjectPreparationFile = async (path, expected, source, options = {}) => {
  const temporaryId = options.temporaryId
    ?? `${process.pid}-${randomBytes(6).toString("hex")}`;
  /** @type {string | undefined} */
  let temporaryPath;
  /** @type {Awaited<ReturnType<typeof captureProjectPreparationFile>> | null} */
  let captured = null;
  /** @type {Awaited<ReturnType<typeof captureProjectPreparationFile>> | null} */
  let rollback = null;
  let candidatePublished = false;
  try {
    temporaryPath = await writeProjectPreparationTemporaryFile(
      path,
      source ?? "",
      temporaryId,
    );
    captured = await captureProjectPreparationFile(path, {
      captureId: projectPreparationReplacementCaptureId(temporaryId),
    });
    if (
      captured.exists !== expected.exists
      || captured.source !== expected.source
      || (captured.exists && !projectPreparationFileIdentityMatches(
        captured.identity,
        expected.identity,
      ))
    ) {
      await captured.restore();
      captured = null;
      await rm(temporaryPath);
      temporaryPath = undefined;
      return { committed: false };
    }
    if (source === null) {
      await rm(temporaryPath);
      temporaryPath = undefined;
    } else {
      await link(temporaryPath, path);
      candidatePublished = true;
    }
    const capturedAfterPublication = await captured.refresh();
    if (
      capturedAfterPublication.source !== captured.source
      || !projectPreparationFileIdentityMatches(
        capturedAfterPublication.identity,
        captured.identity,
      )
    ) {
      if (source === null) {
        await captured.restore();
        captured = null;
        return { committed: false };
      }
      if (!temporaryPath) {
        throw new ProjectPreparationFileError("harness_projection_failed");
      }
      const temporary = await readProjectPreparationTemporaryFile(path, temporaryId);
      rollback = await captureProjectPreparationFile(path, {
        captureId: projectPreparationRollbackCaptureId(temporaryId),
        maximumLinks: 2,
      });
      if (
        !temporary.exists
        || !rollback.exists
        || !projectPreparationFileIdentityMatches(temporary.identity, rollback.identity)
      ) {
        await rollback.restore();
        rollback = null;
        throw new ProjectPreparationFileError("harness_projection_collision");
      }
      await captured.restore();
      captured = null;
      await rollback.remove();
      rollback = null;
      candidatePublished = false;
      await rm(temporaryPath);
      temporaryPath = undefined;
      return { committed: false };
    }
    await captured.remove();
    captured = null;
    if (temporaryPath) {
      await rm(temporaryPath);
      temporaryPath = undefined;
    }
    return { committed: true };
  } catch (error) {
    if (rollback) {
      await recoverProjectPreparationFileRollback(path, temporaryId).catch(() => undefined);
      rollback = null;
    }
    if (!candidatePublished) {
      let recoveryRetained = false;
      try {
        await captured?.restore();
        captured = null;
      } catch {
        recoveryRetained = true;
      }
      if (recoveryRetained && temporaryPath) {
        try {
          await recoverProjectPreparationFileReplacement(
            path,
            temporaryId,
            options.recoveryDepth,
          );
          await removeProjectPreparationTemporaryFile(path, temporaryId);
          temporaryPath = undefined;
          recoveryRetained = false;
        } catch {
          // Keep both generations and the candidate for a durably owned retry.
        }
      }
      if (!recoveryRetained && temporaryPath) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    }
    if (error instanceof ProjectPreparationFileError) throw error;
    if (hasFileErrorCode(error, "EEXIST")) {
      throw new ProjectPreparationFileError("harness_projection_collision");
    }
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
};

/** @param {string} path @param {string} source @param {{temporaryId?: string}} [options] */
export const createProjectPreparationFile = async (path, source, options = {}) => {
  const temporaryId = options.temporaryId
    ?? `${process.pid}-${randomBytes(6).toString("hex")}`;
  /** @type {string | undefined} */
  let temporaryPath;
  try {
    temporaryPath = await writeProjectPreparationTemporaryFile(
      path,
      source,
      temporaryId,
    );
    const temporary = await readProjectPreparationFile(temporaryPath);
    if (!temporary.exists || !temporary.identity) {
      throw new ProjectPreparationFileError("harness_projection_failed");
    }
    await link(temporaryPath, path);
    const ownershipPath = temporaryPath;
    let active = true;
    return {
      identity: temporary.identity,
      finalize: async () => {
        if (!active) return;
        const captured = await captureProjectPreparationFile(ownershipPath, {
          captureId: temporaryId,
          maximumLinks: 2,
        });
        if (
          !captured.exists
          || !projectPreparationFileIdentityMatches(
            captured.identity,
            temporary.identity,
          )
        ) {
          await captured.restore();
          throw new ProjectPreparationFileError("harness_projection_collision");
        }
        await captured.remove();
        active = false;
      },
    };
  } catch (error) {
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof ProjectPreparationFileError) throw error;
    if (hasFileErrorCode(error, "EEXIST")) {
      throw new ProjectPreparationFileError("harness_projection_collision");
    }
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
};

/**
 * @param {string} path
 * @param {string} temporaryId
 * @param {{birthtimeNanoseconds: string, device: string, inode: string} | undefined} [expectedIdentity]
 */
export const removeProjectPreparationTemporaryFile = async (
  path,
  temporaryId,
  expectedIdentity,
) => {
  await assertSafeFileParent(path);
  const temporaryPath = projectPreparationTemporaryPath(path, temporaryId);
  const captured = await captureProjectPreparationFile(temporaryPath, {
    captureId: temporaryId,
    maximumLinks: 2,
  });
  if (!captured.exists) return { removed: false };
  if (expectedIdentity && !projectPreparationFileIdentityMatches(
    captured.identity,
    expectedIdentity,
  )) {
    await captured.restore();
    return { removed: false };
  }
  await captured.remove();
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
    await recoverProjectPreparationFileReplacement(
      options.path,
      options.temporaryId,
    );
    await removeProjectPreparationTemporaryFile(options.path, options.temporaryId);
  }
  for (let attempt = 0; attempt < MAX_PROJECT_PREPARATION_COMMIT_ATTEMPTS; attempt += 1) {
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
    const replacement = await replaceProjectPreparationFile(
      options.path,
      current,
      options.removeFileWhenEmpty && nextSource.length === 0 ? null : nextSource,
      {
        temporaryId: options.temporaryId,
      },
    );
    if (replacement.committed) return { changed: true };
  }
  throw new ProjectPreparationFileError("harness_projection_collision");
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
  if (options.temporaryId) {
    await recoverProjectPreparationFileReplacement(excludePath, options.temporaryId);
    await removeProjectPreparationTemporaryFile(excludePath, options.temporaryId);
  }
  await mkdir(dirname(excludePath), { recursive: true, mode: 0o700 });
  let original;
  let addedRules;
  let replacementCommitted = false;
  for (let attempt = 0; attempt < MAX_PROJECT_PREPARATION_COMMIT_ATTEMPTS; attempt += 1) {
    original = await readProjectPreparationFile(excludePath);
    const existingRules = new Set(original.source.split("\n"));
    addedRules = options.rules.filter((rule) => !existingRules.has(rule));
    if (addedRules.length === 0) {
      return { path: excludePath, changed: false, rollback: async () => undefined };
    }
    const appendedLines = options.ownershipMarker
      ? [options.ownershipMarker, ...addedRules]
      : addedRules;
    const nextSource = `${original.source}${original.source.endsWith("\n")
      || original.source.length === 0 ? "" : "\n"}${appendedLines.join("\n")}\n`;
    const replacement = await replaceProjectPreparationFile(
      excludePath,
      original,
      nextSource,
      { temporaryId: options.temporaryId },
    );
    if (replacement.committed) {
      replacementCommitted = true;
      break;
    }
  }
  if (!replacementCommitted || !original || !addedRules) {
    throw new ProjectPreparationFileError("harness_projection_collision");
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
