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
import { dirname, join } from "node:path";
import {
  projectPreparationFileIdentity,
  projectPreparationFileIdentityMatches,
  ProjectPreparationOwnershipError,
  waitForProjectPreparationOwnershipRelease,
} from "./project-preparation-ownership.mjs";

export {
  projectPreparationFileIdentity,
  projectPreparationFileIdentityMatches,
} from "./project-preparation-ownership.mjs";

export class ProjectPreparationFileError extends Error {
  /** @param {"harness_projection_collision" | "harness_projection_failed"} code */
  constructor(code) {
    super(code);
    this.name = "ProjectPreparationFileError";
    this.code = code;
  }
}

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
export const projectPreparationTemporaryPath = (path, temporaryId) => {
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
export const assertSafeFileParent = async (path) => {
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
export const hasFileErrorCode = (error, code) =>
  Boolean(error && typeof error === "object" && "code" in error && error.code === code);

/** @param {string} captureId */
const assertProjectPreparationCaptureId = (captureId) => {
  if (!/^[a-z0-9-]{1,192}$/.test(captureId)) {
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
};

/** @param {string} capturePath */
const projectPreparationReleasedCapturePath = (capturePath) =>
  `${capturePath}.released`;

/** @param {string} releasedCapturePath */
const finishReleasedProjectPreparationCapture = async (releasedCapturePath) => {
  try {
    const [details, entries] = await Promise.all([
      lstat(releasedCapturePath),
      readdir(releasedCapturePath),
    ]);
    if (
      !details.isDirectory()
      || details.isSymbolicLink()
      || (
        entries.length !== 0
        && (entries.length !== 1 || entries[0] !== "release")
      )
    ) {
      throw new ProjectPreparationFileError("harness_projection_collision");
    }
    if (entries.length === 0) {
      await rmdir(releasedCapturePath);
      return;
    }
    const releasePath = join(releasedCapturePath, "release");
    const release = await readProjectPreparationFile(releasePath, {
      maximumLinks: 2,
    });
    if (!release.exists) {
      throw new ProjectPreparationFileError("harness_projection_collision");
    }
    await rm(releasePath);
    await rmdir(releasedCapturePath);
  } catch (error) {
    if (error instanceof ProjectPreparationFileError) throw error;
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
};

/** @param {string} capturePath */
export const finishReleasedProjectPreparationCaptureIfPresent = async (capturePath) => {
  const releasedCapturePath = projectPreparationReleasedCapturePath(capturePath);
  const [captureExists, releasedCaptureExists] = await Promise.all([
    lstat(capturePath).then(
      () => true,
      (error) => hasFileErrorCode(error, "ENOENT") ? false : Promise.reject(error),
    ),
    lstat(releasedCapturePath).then(
      () => true,
      (error) => hasFileErrorCode(error, "ENOENT") ? false : Promise.reject(error),
    ),
  ]);
  if (!releasedCaptureExists) return false;
  if (captureExists) {
    throw new ProjectPreparationFileError("harness_projection_collision");
  }
  await finishReleasedProjectPreparationCapture(releasedCapturePath);
  return true;
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
  if (await finishReleasedProjectPreparationCaptureIfPresent(capturePath)) {
    return { path: capturePath, recovered: true, released: true };
  }
  try {
    await mkdir(capturePath, { mode: 0o700 });
    return { path: capturePath, recovered: false, released: false };
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
        || entries.some((entry) => !["captured", "release"].includes(entry))
      ) {
        throw new ProjectPreparationFileError("harness_projection_collision");
      }
      return { path: capturePath, recovered: true, released: false };
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
  const releasePath = join(captureDirectory, "release");
  if (capture.released) {
    return {
      exists: false,
      identity: undefined,
      source: "",
      refresh: async () => ({ exists: false, identity: undefined, source: "" }),
      remove: async () => true,
      restore: async () => undefined,
    };
  }
  if (capture.recovered) {
    const [capturedExists, releaseExists] = await Promise.all([
      lstat(capturedPath).then(
        () => true,
        (error) => hasFileErrorCode(error, "ENOENT") ? false : Promise.reject(error),
      ),
      lstat(releasePath).then(
        () => true,
        (error) => hasFileErrorCode(error, "ENOENT") ? false : Promise.reject(error),
      ),
    ]);
    if (releaseExists) {
      if (capturedExists) {
        const [captured, release] = await Promise.all([
          readProjectPreparationFile(capturedPath, { maximumLinks: 2 }),
          readProjectPreparationFile(releasePath, { maximumLinks: 2 }),
        ]);
        if (!projectPreparationFileIdentityMatches(
          captured.identity,
          release.identity,
        )) {
          throw new ProjectPreparationFileError("harness_projection_collision");
        }
        await rm(releasePath);
      } else {
        await rename(releasePath, capturedPath);
      }
    }
  }
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
          remove: async () => true,
          restore: async () => undefined,
        };
      }
      throw new ProjectPreparationFileError("harness_projection_failed");
    }
  }

  /** @type {{exists: boolean, identity: {birthtimeNanoseconds: string, device: string, inode: string}, source: string}} */
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
    const captured = await readProjectPreparationFile(capturedPath, {
      maximumLinks: options.maximumLinks,
    });
    if (!captured.exists || !captured.identity) {
      throw new ProjectPreparationFileError("harness_projection_failed");
    }
    current = {
      exists: true,
      identity: captured.identity,
      source: captured.source,
    };
  } catch (error) {
    await restoreCapturedPath().catch(() => undefined);
    if (error instanceof ProjectPreparationFileError) throw error;
    throw new ProjectPreparationFileError("harness_projection_failed");
  }
  let active = true;
  const restoreReleasePath = async () => {
    const [capturedExists, releaseExists] = await Promise.all([
      lstat(capturedPath).then(
        () => true,
        (error) => hasFileErrorCode(error, "ENOENT") ? false : Promise.reject(error),
      ),
      lstat(releasePath).then(
        () => true,
        (error) => hasFileErrorCode(error, "ENOENT") ? false : Promise.reject(error),
      ),
    ]);
    if (!releaseExists) return;
    if (capturedExists) {
      const [captured, release] = await Promise.all([
        readProjectPreparationFile(capturedPath, { maximumLinks: 2 }),
        readProjectPreparationFile(releasePath, { maximumLinks: 2 }),
      ]);
      if (!projectPreparationFileIdentityMatches(captured.identity, release.identity)) {
        throw new ProjectPreparationFileError("harness_projection_collision");
      }
      await rm(releasePath);
      return;
    }
    await rename(releasePath, capturedPath);
  };
  return {
    ...current,
    refresh: () => readProjectPreparationFile(capturedPath, {
      maximumLinks: options.maximumLinks,
    }),
    remove: async () => {
      if (!active) return true;
      try {
        await link(capturedPath, releasePath);
        await rm(capturedPath);
        await waitForProjectPreparationOwnershipRelease(
          releasePath,
          current.identity,
        );
        const released = await readProjectPreparationFile(releasePath, {
          maximumLinks: options.maximumLinks,
        });
        if (!released.exists || !released.identity) {
          throw new ProjectPreparationFileError("harness_projection_failed");
        }
        if (
          released.source !== current.source
          || !projectPreparationFileIdentityMatches(released.identity, current.identity)
        ) {
          await link(releasePath, capturedPath);
          await rm(releasePath);
          current = released;
          return false;
        }
        const releasedCapturePath = projectPreparationReleasedCapturePath(
          captureDirectory,
        );
        await rename(captureDirectory, releasedCapturePath);
        active = false;
        await finishReleasedProjectPreparationCapture(releasedCapturePath);
        return true;
      } catch (error) {
        await restoreReleasePath().catch(() => undefined);
        if (error instanceof ProjectPreparationFileError) throw error;
        if (error instanceof ProjectPreparationOwnershipError) {
          throw new ProjectPreparationFileError("harness_projection_failed");
        }
        if (hasFileErrorCode(error, "EEXIST")) {
          throw new ProjectPreparationFileError("harness_projection_collision");
        }
        throw new ProjectPreparationFileError("harness_projection_failed");
      }
    },
    restore: async () => {
      if (!active) return;
      await restoreCapturedPath();
      active = false;
    },
  };
};
