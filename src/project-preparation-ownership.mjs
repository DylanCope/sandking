import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureLinuxNativeHelper } from "./linux-native-helper.mjs";

const execFileAsync = promisify(execFile);
const OPEN_DESCRIPTOR_POLL_INTERVAL_MS = 10;
const OPEN_DESCRIPTOR_RELEASE_TIMEOUT_MS = 5_000;

export class ProjectPreparationOwnershipError extends Error {
  constructor() {
    super("project_preparation_ownership_unavailable");
    this.name = "ProjectPreparationOwnershipError";
  }
}

/** @param {import("node:fs").BigIntStats} details */
export const projectPreparationFileIdentity = (details) => ({
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

/**
 * @param {string} path
 * @param {{device: string, inode: string}} identity
 */
const linuxFileHasOpenDescriptor = async (path, identity) => {
  try {
    await execFileAsync(ensureLinuxNativeHelper(), [
      "ownership-release",
      path,
      identity.device,
      identity.inode,
    ], {
      timeout: 2_000,
      maxBuffer: 32_768,
    });
    return false;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 6) {
      return true;
    }
    throw new ProjectPreparationOwnershipError();
  }
};

/** @param {string} path */
const darwinFileHasOpenDescriptor = async (path) => {
  try {
    const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-t", "--", path], {
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim().length > 0;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 1) {
      return false;
    }
    throw new ProjectPreparationOwnershipError();
  }
};

const windowsExclusiveOpenProbe = [
  "$stream = $null",
  "try {",
  "  $stream = [System.IO.File]::Open($env:SANDKING_PREPARATION_RELEASE_PATH, 'Open', 'Read', 'None')",
  "  exit 0",
  "} catch [System.IO.IOException] {",
  "  exit 2",
  "} catch {",
  "  exit 3",
  "} finally {",
  "  if ($null -ne $stream) { $stream.Dispose() }",
  "}",
].join("\n");

/** @param {string} path */
const windowsFileHasOpenDescriptor = async (path) => {
  try {
    await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      windowsExclusiveOpenProbe,
    ], {
      env: {
        ...process.env,
        SANDKING_PREPARATION_RELEASE_PATH: path,
      },
      timeout: 2_000,
      windowsHide: true,
      maxBuffer: 32_768,
    });
    return false;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 2) {
      return true;
    }
    throw new ProjectPreparationOwnershipError();
  }
};

/**
 * Wait until an inode captured under a Host-private name has no remaining
 * pre-capture descriptors. No ordinary process can newly open that generation
 * once its public name has been removed.
 *
 * @param {string} path
 * @param {{birthtimeNanoseconds: string, device: string, inode: string}} identity
 */
export const waitForProjectPreparationOwnershipRelease = async (path, identity) => {
  const deadline = Date.now() + OPEN_DESCRIPTOR_RELEASE_TIMEOUT_MS;
  while (true) {
    let hasOpenDescriptor;
    if (process.platform === "linux") {
      hasOpenDescriptor = await linuxFileHasOpenDescriptor(path, identity);
    } else if (process.platform === "darwin") {
      hasOpenDescriptor = await darwinFileHasOpenDescriptor(path);
    } else if (process.platform === "win32") {
      hasOpenDescriptor = await windowsFileHasOpenDescriptor(path);
    } else {
      throw new ProjectPreparationOwnershipError();
    }
    if (!hasOpenDescriptor) return;
    if (Date.now() >= deadline) throw new ProjectPreparationOwnershipError();
    await new Promise((resolve) => setTimeout(resolve, OPEN_DESCRIPTOR_POLL_INTERVAL_MS));
  }
};
