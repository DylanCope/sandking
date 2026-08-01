import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  ensurePrivateDirectory,
  hasErrorCode,
  PRIVATE_FILE_MODE,
  readJson,
  removePrivateFile,
  writePrivateJson,
} from "./private-state.mjs";
import { capabilitySetSchema, framingSchema, releaseVersion, versionSchema } from "./protocol.mjs";

const COMPATIBILITY_KEY = "runtime-v1";
const BOOTSTRAP_TTL_MS = 60_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;
const daemonPath = fileURLToPath(new URL("./runtime-daemon.mjs", import.meta.url));

const runtimeStateSchema = z.object({
  pid: z.number().int().positive(),
  runtimeId: z.string().min(1).max(128),
  port: z.number().int().min(1).max(65_535),
  readinessToken: z.string().regex(/^[a-f0-9]{48}$/),
  compatibilityKey: z.string().min(1).max(128),
  version: z.string().min(1),
  identity: z.literal("controller-runtime"),
  host: z.object({
    identity: z.string().min(1).max(128),
    capabilities: capabilitySetSchema,
    negotiatedCapabilities: z.array(z.string()).max(32),
    schemaDigest: z.string(),
    framing: framingSchema,
    observationCursor: z.string().nullable(),
    release: z.string(),
  }).strict(),
  protocol: versionSchema,
  listener: z.object({
    address: z.literal("127.0.0.1"),
    class: z.literal("loopback"),
  }).strict(),
  negotiationAuditId: z.string().min(1).max(128),
  startedAt: z.string(),
}).strict();

/** @param {number} pid */
export const pidIsRunning = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      try {
        const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ");
        if (fields[2] === "Z") {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
};

const defaultDataDir = () => join(homedir(), ".sandking");

/** @param {string} lockPath */
const inspectLaunchLock = async (lockPath) => {
  try {
    return {
      owner: await readJson(lockPath, null),
      recentlyIncomplete: false,
    };
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    const lockStat = await stat(lockPath).catch(() => null);
    return {
      owner: null,
      recentlyIncomplete: Boolean(lockStat && Date.now() - lockStat.mtimeMs < 1_000),
    };
  }
};

/** @param {string} lockPath @param {string} lockId */
const releaseOwnedLock = async (lockPath, lockId) => {
  const { owner: current } = await inspectLaunchLock(lockPath);
  if (current && typeof current === "object" && current.lockId === lockId) {
    await removePrivateFile(lockPath);
  }
};

/**
 * @template T
 * @param {string} dataDir
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
const withLaunchLock = async (dataDir, operation) => {
  const lockPath = join(dataDir, "runtime.lock");
  const recoveryPath = join(dataDir, "runtime.lock.recovery");
  const lockId = randomBytes(12).toString("hex");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

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
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }

      const inspectedOwner = await inspectLaunchLock(lockPath);
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
          const confirmedInspection = await inspectLaunchLock(lockPath);
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
          if (!hasErrorCode(recoveryError, "EEXIST")) {
            throw recoveryError;
          }
        } finally {
          await recoveryHandle?.close();
          if (recoveryHandle) {
            await removePrivateFile(recoveryPath);
          }
        }
        continue;
      }
      await delay(50);
    }
  }

  throw new Error("runtime_lock_timeout");
};

/** @param {string} dataDir @param {z.infer<typeof runtimeStateSchema>} state */
const createBootstrapUrl = async (dataDir, state) => {
  const tokenDirectory = join(dataDir, "bootstrap-tokens");
  await ensurePrivateDirectory(tokenDirectory);
  const token = randomBytes(32).toString("hex");
  const tokenId = createHash("sha256").update(token).digest("hex");
  await writePrivateJson(join(tokenDirectory, `${tokenId}.json`), {
    expiresAt: Date.now() + BOOTSTRAP_TTL_MS,
    runtimeId: state.runtimeId,
  });
  return `http://127.0.0.1:${state.port}/bootstrap?token=${token}`;
};

/** @param {z.infer<typeof runtimeStateSchema>} state */
const probeRuntime = async (state) => {
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, {
      headers: {
        host: `127.0.0.1:${state.port}`,
        "x-sandking-readiness": state.readinessToken,
      },
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) {
      return false;
    }
    const health = await response.json();
    return health?.ready === true
      && health.runtimeId === state.runtimeId
      && health.identity === "controller-runtime"
      && health.version === releaseVersion;
  } catch {
    return false;
  }
};

/** @param {number} pid @param {NodeJS.Signals} signal */
const signalProcessTree = (pid, signal) => {
  if (!pidIsRunning(pid)) {
    return;
  }
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
    } else {
      process.kill(pid, signal);
    }
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process exited between the liveness probe and signal.
    }
  }
};

/** @param {number} pid */
const terminateProcessTree = async (pid) => {
  signalProcessTree(pid, "SIGTERM");
  for (let attempt = 0; attempt < 20 && pidIsRunning(pid); attempt += 1) {
    await delay(25);
  }
  if (pidIsRunning(pid)) {
    signalProcessTree(pid, "SIGKILL");
  }
};

/**
 * @param {string} dataDir
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} startupTimeoutMs
 */
const waitForStartup = async (dataDir, child, startupTimeoutMs) => {
  const statePath = join(dataDir, "runtime-state.json");
  const errorPath = join(dataDir, "startup-error.json");
  const deadline = Date.now() + startupTimeoutMs;
  let exitCode = null;
  child.once("exit", (code) => {
    exitCode = code ?? 1;
  });

  while (Date.now() < deadline) {
    const errorState = await readJson(errorPath, null);
    if (errorState && typeof errorState === "object" && "code" in errorState) {
      throw new Error(String(errorState.code));
    }

    const rawState = await readJson(statePath, null);
    const parsedState = runtimeStateSchema.safeParse(rawState);
    if (parsedState.success && parsedState.data.pid === child.pid) {
      if (await probeRuntime(parsedState.data)) {
        return parsedState.data;
      }
    }

    if (exitCode !== null) {
      await delay(25);
      const finalError = await readJson(errorPath, null);
      throw new Error(
        finalError && typeof finalError === "object" && "code" in finalError
          ? String(finalError.code)
          : "runtime_start_failed",
      );
    }
    await delay(50);
  }

  throw new Error("runtime_start_timeout");
};

/**
 * @param {string} dataDir
 * @param {{hostMode?: string, startupTimeoutMs?: number}} options
 */
const spawnRuntime = async (dataDir, options) => {
  const statePath = join(dataDir, "runtime-state.json");
  const errorPath = join(dataDir, "startup-error.json");
  await Promise.all([removePrivateFile(statePath), removePrivateFile(errorPath)]);

  const daemonArgs = [daemonPath, "--data-dir", dataDir];
  if (options.hostMode) {
    daemonArgs.push("--host-mode", options.hostMode);
  }
  const child = spawn(process.execPath, daemonArgs, {
    cwd: dataDir,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });

  try {
    const runtimeState = await waitForStartup(
      dataDir,
      child,
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    );
    child.unref();
    await removePrivateFile(errorPath);
    return runtimeState;
  } catch (error) {
    if (typeof child.pid === "number") {
      await terminateProcessTree(child.pid);
    }
    await writePrivateJson(join(dataDir, "last-startup-error.json"), {
      code: error instanceof Error ? error.message : "runtime_start_failed",
      recordedAt: new Date().toISOString(),
    });
    await removePrivateFile(statePath);
    await removePrivateFile(errorPath);
    throw error;
  }
};

/** @param {string | undefined} provided */
export const resolveDataDir = (provided) => resolve(provided ?? defaultDataDir());

/**
 * @param {{dataDir?: string, hostMode?: string, startupTimeoutMs?: number}} options
 */
export const launchRuntime = async (options = {}) => {
  const resolvedDataDir = resolveDataDir(options.dataDir);
  await ensurePrivateDirectory(resolvedDataDir);

  return withLaunchLock(resolvedDataDir, async () => {
    const statePath = join(resolvedDataDir, "runtime-state.json");
    const rawExisting = await readJson(statePath, null);
    const rawPid = rawExisting && typeof rawExisting === "object" && "pid" in rawExisting
      ? Number(rawExisting.pid)
      : Number.NaN;
    const existing = runtimeStateSchema.safeParse(rawExisting);

    let runtimeState;
    let reused = false;
    if (pidIsRunning(rawPid)) {
      if (!existing.success) {
        throw new Error("runtime_state_invalid");
      }
      if (
        existing.data.compatibilityKey !== COMPATIBILITY_KEY
        || existing.data.version !== releaseVersion
      ) {
        throw new Error("runtime_incompatible");
      }
      if (!(await probeRuntime(existing.data))) {
        throw new Error("runtime_not_ready");
      }
      runtimeState = existing.data;
      reused = true;
    } else {
      await removePrivateFile(statePath);
      runtimeState = await spawnRuntime(resolvedDataDir, options);
    }

    const bootstrapUrl = await createBootstrapUrl(resolvedDataDir, runtimeState);
    return {
      runtime: {
        identity: runtimeState.identity,
        runtimeId: runtimeState.runtimeId,
        reused,
        pid: runtimeState.pid,
        port: runtimeState.port,
        listener: runtimeState.listener,
      },
      host: runtimeState.host,
      protocol: runtimeState.protocol,
      audit: { negotiationId: runtimeState.negotiationAuditId },
      bootstrapUrl,
    };
  });
};

/** @param {{dataDir?: string}} options */
export const stopRuntime = async (options = {}) => {
  const resolvedDataDir = resolveDataDir(options.dataDir);
  const statePath = join(resolvedDataDir, "runtime-state.json");
  const parsed = runtimeStateSchema.safeParse(await readJson(statePath, null));
  if (!parsed.success || !pidIsRunning(parsed.data.pid)) {
    await removePrivateFile(statePath);
    return { stopped: false };
  }
  if (!(await probeRuntime(parsed.data))) {
    return { stopped: false, code: "runtime_not_ready" };
  }

  await terminateProcessTree(parsed.data.pid);
  await removePrivateFile(statePath);
  return { stopped: true };
};
