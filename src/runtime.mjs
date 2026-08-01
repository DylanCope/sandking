import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { releaseVersion } from "./protocol.mjs";

const COMPATIBILITY_KEY = "runtime-v1";
const BOOTSTRAP_TTL_MS = 60_000;

const readJson = async (filePath, fallback) => {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
};

const pidIsRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const defaultDataDir = () => join(homedir(), ".sandking");

const withLaunchLock = async (dataDir, operation) => {
  const lockPath = join(dataDir, "runtime.lock");

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { flag: "wx" });
      try {
        return await operation();
      } finally {
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "EEXIST")) {
        throw error;
      }
      await delay(100);
    }
  }

  throw new Error("runtime_lock_timeout");
};

const createBootstrapUrl = async (dataDir, state) => {
  const tokenPath = join(dataDir, "bootstrap-tokens.json");
  const tokens = await readJson(tokenPath, []);
  const token = randomBytes(24).toString("hex");
  tokens.push({
    token,
    expiresAt: Date.now() + BOOTSTRAP_TTL_MS,
    usedAt: null,
  });
  await writeFile(tokenPath, `${JSON.stringify(tokens, null, 2)}\n`);
  return `http://127.0.0.1:${state.port}/bootstrap?token=${token}`;
};

const waitForStartup = async (dataDir) => {
  const statePath = join(dataDir, "runtime-state.json");
  const errorPath = join(dataDir, "startup-error.json");

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await readJson(statePath, null);
    if (state?.pid && pidIsRunning(state.pid)) {
      return state;
    }

    const errorState = await readJson(errorPath, null);
    if (errorState) {
      await rm(errorPath, { force: true });
      throw new Error(errorState.code);
    }

    await delay(100);
  }

  throw new Error("runtime_start_timeout");
};

const spawnRuntime = async (dataDir) => {
  const daemonPath = join(process.cwd(), "src", "runtime-daemon.mjs");
  const child = spawn(process.execPath, [daemonPath, "--data-dir", dataDir], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return waitForStartup(dataDir);
};

export const resolveDataDir = (provided) => resolve(provided ?? defaultDataDir());

export const launchRuntime = async ({ dataDir }) => {
  const resolvedDataDir = resolveDataDir(dataDir);
  await mkdir(resolvedDataDir, { recursive: true });

  return withLaunchLock(resolvedDataDir, async () => {
    const statePath = join(resolvedDataDir, "runtime-state.json");
    const existing = await readJson(statePath, null);

    let runtimeState;
    let reused = false;
    if (
      existing?.pid
      && existing.compatibilityKey === COMPATIBILITY_KEY
      && existing.version === releaseVersion
      && pidIsRunning(existing.pid)
    ) {
      runtimeState = existing;
      reused = true;
    } else {
      runtimeState = await spawnRuntime(resolvedDataDir);
    }

    const bootstrapUrl = await createBootstrapUrl(resolvedDataDir, runtimeState);
    return {
      runtime: {
        runtimeId: runtimeState.runtimeId,
        reused,
        pid: runtimeState.pid,
        port: runtimeState.port,
        listener: runtimeState.listener,
      },
      host: runtimeState.host,
      protocol: runtimeState.protocol,
      bootstrapUrl,
    };
  });
};

export const stopRuntime = async ({ dataDir }) => {
  const resolvedDataDir = resolveDataDir(dataDir);
  const statePath = join(resolvedDataDir, "runtime-state.json");
  const state = await readJson(statePath, null);
  if (!state?.pid) {
    return { stopped: false };
  }

  if (pidIsRunning(state.pid)) {
    process.kill(state.pid, "SIGTERM");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!pidIsRunning(state.pid)) {
        break;
      }
      await delay(50);
    }
  }

  await rm(statePath, { force: true });
  return { stopped: true };
};
