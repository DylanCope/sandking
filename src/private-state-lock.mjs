import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  ensurePrivateDirectory,
  hasErrorCode,
  PRIVATE_FILE_MODE,
  readJson,
  removePrivateFile,
} from "./private-state.mjs";

/** @param {number} pid */
export const pidIsRunning = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      try {
        const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ");
        if (fields[2] === "Z") return false;
      } catch {
        return false;
      }
    }
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
};

/** @param {string} lockPath */
const inspectLock = async (lockPath) => {
  try {
    return { owner: await readJson(lockPath, null), recentlyIncomplete: false };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const lockStat = await stat(lockPath).catch(() => null);
    return {
      owner: null,
      recentlyIncomplete: Boolean(lockStat && Date.now() - lockStat.mtimeMs < 1_000),
    };
  }
};

/** @param {string} lockPath @param {string} lockId */
const releaseOwnedLock = async (lockPath, lockId) => {
  const { owner } = await inspectLock(lockPath);
  if (owner && typeof owner === "object" && owner.lockId === lockId) {
    await removePrivateFile(lockPath);
  }
};

/**
 * Serialize Host-private state across independent processes and recover only
 * locks whose recorded owner is no longer running.
 *
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} operation
 * @param {{timeoutMs: number, timeoutCode: string}} options
 * @returns {Promise<T>}
 */
export const withPrivateStateLock = async (lockPath, operation, options) => {
  await ensurePrivateDirectory(dirname(lockPath));
  const recoveryPath = `${lockPath}.recovery`;
  const lockId = randomBytes(12).toString("hex");
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    const recoveryText = await readFile(recoveryPath, "utf8").catch(() => null);
    if (recoveryText !== null) {
      let recoveryPid = Number.NaN;
      try {
        recoveryPid = Number(JSON.parse(recoveryText).pid);
      } catch {
        const recoveryStat = await stat(recoveryPath).catch(() => null);
        if (recoveryStat && Date.now() - recoveryStat.mtimeMs < 1_000) {
          await delay(25);
          continue;
        }
      }
      if (pidIsRunning(recoveryPid)) {
        await delay(25);
        continue;
      }
      await removePrivateFile(recoveryPath);
      continue;
    }
    try {
      const handle = await open(lockPath, "wx", PRIVATE_FILE_MODE);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, lockId })}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(lockPath, PRIVATE_FILE_MODE);

      try {
        return await operation();
      } finally {
        await releaseOwnedLock(lockPath, lockId);
      }
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;

      const inspectedOwner = await inspectLock(lockPath);
      if (inspectedOwner.recentlyIncomplete) {
        await delay(25);
        continue;
      }
      const owner = inspectedOwner.owner;
      const ownerPid = owner && typeof owner === "object" && "pid" in owner
        ? Number(owner.pid)
        : Number.NaN;
      if (!pidIsRunning(ownerPid)) {
        let recoveryHandle;
        try {
          recoveryHandle = await open(recoveryPath, "wx", PRIVATE_FILE_MODE);
          await recoveryHandle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`, "utf8");
          await recoveryHandle.sync();
          const confirmedInspection = await inspectLock(lockPath);
          const confirmedOwner = confirmedInspection.owner;
          const confirmedPid = confirmedOwner
            && typeof confirmedOwner === "object"
            && "pid" in confirmedOwner
            ? Number(confirmedOwner.pid)
            : Number.NaN;
          if (!confirmedInspection.recentlyIncomplete && !pidIsRunning(confirmedPid)) {
            await removePrivateFile(lockPath);
          }
        } catch (recoveryError) {
          if (!hasErrorCode(recoveryError, "EEXIST")) throw recoveryError;
        } finally {
          await recoveryHandle?.close();
          if (recoveryHandle) await removePrivateFile(recoveryPath);
        }
        continue;
      }
      await delay(50);
    }
  }

  throw new Error(options.timeoutCode);
};
