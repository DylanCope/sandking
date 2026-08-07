import { spawn } from "node:child_process";
import { closeSync, writeSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const supervisorPath = fileURLToPath(import.meta.url);

/** @typedef {{code: number | null, signal: string | null, startFailed: boolean}} AdapterExitResult */
/** @typedef {{code: number | null, signal: NodeJS.Signals | null}} WrapperExitResult */
/** @typedef {{sent: boolean, sentAt: string | null}} SignalResult */
/** @typedef {{signal: "SIGTERM" | "SIGKILL", dispatching: boolean, sentAt: string | null, resolve: (result: SignalResult) => void}} PendingSignal */

/** @param {number} descriptor */
const closeDescriptor = (descriptor) => {
  try {
    closeSync(descriptor);
  } catch {
    // The descriptor was already closed while the supervised adapter exited.
  }
};

/** @param {Record<string, unknown>} message */
const writeSupervisorStatus = (message) => {
  try {
    writeSync(4, `${JSON.stringify(message)}\n`);
  } catch {
    // A Host exit closes the private status pipe. The group guard still waits
    // for the adapter so it cannot orphan a newly reusable process-group id.
  }
};

const runSupervisor = () => {
  const [executable, ...args] = process.argv.slice(3);
  if (!executable) process.exit(1);

  let adapterExited = false;
  let releaseRequested = false;
  let exitReported = false;
  /** @param {Record<string, unknown>} message */
  const finishAdapter = (message) => {
    if (exitReported) return;
    exitReported = true;
    adapterExited = true;
    writeSupervisorStatus(message);
    if (releaseRequested) process.exit(0);
  };

  // Cooperative cancellation targets the complete group. The Host-owned
  // leader deliberately survives SIGTERM so the numeric group identity stays
  // bound until the Host commits the one terminal outcome.
  process.on("SIGTERM", () => undefined);
  /** @param {any} message */
  const handleSupervisorMessage = (message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "posix-process-tree.release") {
      releaseRequested = true;
      if (adapterExited) process.exit(0);
      return;
    }
    if (
      message.type !== "posix-process-tree.signal"
      || typeof message.requestId !== "number"
      || !["SIGTERM", "SIGKILL"].includes(message.signal)
    ) {
      return;
    }
    if (message.signal === "SIGKILL") {
      // This synchronous status record proves the command reached the live
      // group leader. The leader then signals its own group, so a stale numeric
      // pid can never select a replacement process group.
      writeSupervisorStatus({
        type: "posix-process-tree.signal-dispatching",
        requestId: message.requestId,
        signal: message.signal,
        sentAt: new Date().toISOString(),
      });
    }
    try {
      process.kill(-process.pid, message.signal);
      if (message.signal === "SIGTERM") {
        writeSupervisorStatus({
          type: "posix-process-tree.signal-result",
          requestId: message.requestId,
          signal: message.signal,
          sent: true,
          sentAt: new Date().toISOString(),
        });
      }
    } catch {
      writeSupervisorStatus({
        type: "posix-process-tree.signal-result",
        requestId: message.requestId,
        signal: message.signal,
        sent: false,
        sentAt: null,
      });
    }
  };
  process.on("message", handleSupervisorMessage);
  process.on("disconnect", () => {
    releaseRequested = true;
    if (adapterExited) process.exit(0);
  });

  let adapter;
  try {
    adapter = spawn(executable, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", 1, 2, 3],
    });
  } catch {
    writeSupervisorStatus({ type: "posix-process-tree.adapter-error" });
    process.exit(1);
  }
  writeSupervisorStatus({
    type: "posix-process-tree.adapter-spawned",
    pid: adapter.pid ?? null,
  });
  // Only the adapter retains these pipe writers. Their closure therefore
  // remains the ordinary stdout/stderr/protocol completion boundary even
  // while this group leader stays alive through the terminal commit.
  closeDescriptor(1);
  closeDescriptor(2);
  closeDescriptor(3);
  adapter.once("error", () => finishAdapter({
    type: "posix-process-tree.adapter-error",
  }));
  adapter.once("exit", (code, signal) => finishAdapter({
    type: "posix-process-tree.adapter-exit",
    code,
    signal,
  }));
};

/**
 * @param {number} processGroupId
 * @returns {Promise<Array<{pid: number, state: string}> | null>}
 */
const readProcessGroupMembers = async (processGroupId) => {
  if (process.platform === "linux") {
    try {
      const entries = await readdir("/proc", { withFileTypes: true });
      const members = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[0-9]+$/.test(entry.name)) continue;
        try {
          const stat = await readFile(`/proc/${entry.name}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          const [state, , processGroup] = fields;
          if (Number(processGroup) === processGroupId) {
            members.push({ pid: Number(entry.name), state });
          }
        } catch {
          // A process can disappear between the directory and stat reads.
        }
      }
      return members;
    } catch {
      return null;
    }
  }

  return new Promise((resolve) => {
    const child = spawn("ps", ["-axo", "pid=,pgid=,stat="], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", () => resolve(null));
    child.once("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(output.split("\n").flatMap((line) => {
        const match = /^\s*([0-9]+)\s+([0-9]+)\s+(\S+)/.exec(line);
        if (!match || Number(match[2]) !== processGroupId) return [];
        return [{ pid: Number(match[1]), state: match[3] }];
      }));
    });
  });
};

/**
 * Spawn a Host-owned POSIX process-group leader which launches the adapter and
 * remains alive until the Host releases it after terminal-state publication.
 * Signals are requested over the leader's private IPC channel; the Host never
 * signals a retained numeric pid or process-group id.
 *
 * @param {string} executable
 * @param {string[]} args
 * @param {{cwd: string, env: NodeJS.ProcessEnv}} options
 */
export const spawnPosixProcessTree = (executable, args, options) => {
  const child = spawn(process.execPath, [
    supervisorPath,
    "supervise",
    executable,
    ...args,
  ], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "ipc"],
  });
  const adapterChannel = child.stdio[3];
  const statusChannel = child.stdio[4];
  if (
    typeof child.pid !== "number"
    || !adapterChannel
    || !("readable" in adapterChannel)
    || !statusChannel
    || !("readable" in statusChannel)
  ) {
    throw new Error("harness_adapter_start_failed");
  }

  let adapterSpawned = false;
  /** @type {AdapterExitResult | null} */
  let adapterExitResult = null;
  /** @type {(result: AdapterExitResult) => void} */
  let resolveAdapterExit = () => {};
  /** @type {Promise<AdapterExitResult>} */
  const adapterExit = new Promise((resolve) => {
    resolveAdapterExit = resolve;
  });
  /** @type {WrapperExitResult | null} */
  let wrapperExitResult = null;
  /** @type {(result: WrapperExitResult) => void} */
  let resolveWrapperClosed = () => {};
  /** @type {Promise<WrapperExitResult>} */
  const wrapperClosed = new Promise((resolve) => {
    resolveWrapperClosed = resolve;
  });
  let nextSignalRequestId = 1;
  /** @type {Map<number, PendingSignal>} */
  const pendingSignals = new Map();
  let statusBuffer = "";

  /** @param {AdapterExitResult} result */
  const settleAdapterExit = (result) => {
    if (adapterExitResult) return;
    adapterExitResult = result;
    resolveAdapterExit(result);
  };
  /** @param {number} requestId @param {boolean} sent @param {string | null} sentAt */
  const settleSignal = (requestId, sent, sentAt) => {
    const pending = pendingSignals.get(requestId);
    if (!pending) return;
    pendingSignals.delete(requestId);
    pending.resolve({ sent, sentAt });
  };
  /** @param {any} message */
  const consumeStatus = (message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "posix-process-tree.adapter-spawned") {
      adapterSpawned = true;
      return;
    }
    if (message.type === "posix-process-tree.adapter-error") {
      settleAdapterExit({ code: null, signal: null, startFailed: true });
      return;
    }
    if (message.type === "posix-process-tree.adapter-exit") {
      settleAdapterExit({
        code: typeof message.code === "number" ? message.code : null,
        signal: typeof message.signal === "string" ? message.signal : null,
        startFailed: false,
      });
      return;
    }
    if (
      message.type === "posix-process-tree.signal-dispatching"
      && message.signal === "SIGKILL"
    ) {
      const pending = pendingSignals.get(message.requestId);
      if (pending) {
        pending.dispatching = true;
        pending.sentAt = typeof message.sentAt === "string" ? message.sentAt : null;
      }
      return;
    }
    if (message.type === "posix-process-tree.signal-result") {
      settleSignal(
        message.requestId,
        message.sent === true,
        typeof message.sentAt === "string" ? message.sentAt : null,
      );
    }
  };

  statusChannel.setEncoding("utf8");
  statusChannel.on("data", (chunk) => {
    statusBuffer += chunk;
    while (statusBuffer.includes("\n")) {
      const newline = statusBuffer.indexOf("\n");
      const line = statusBuffer.slice(0, newline);
      statusBuffer = statusBuffer.slice(newline + 1);
      try {
        consumeStatus(JSON.parse(line));
      } catch {
        // Invalid private status is treated as supervision uncertainty.
      }
    }
  });
  child.once("error", () => {
    settleAdapterExit({ code: null, signal: null, startFailed: true });
  });
  child.once("exit", (code, signal) => {
    wrapperExitResult = { code, signal };
  });
  child.once("close", (code, signal) => {
    wrapperExitResult ??= { code, signal };
    if (!adapterExitResult) {
      settleAdapterExit({
        code: typeof code === "number" ? code : null,
        signal: typeof signal === "string" ? signal : null,
        startFailed: false,
      });
    }
    for (const [requestId, pending] of pendingSignals) {
      const sent = pending.signal === "SIGKILL"
        && pending.dispatching === true
        && wrapperExitResult.signal === "SIGKILL";
      settleSignal(requestId, sent, sent ? pending.sentAt : null);
    }
    resolveWrapperClosed(wrapperExitResult);
  });

  /** @param {"SIGTERM" | "SIGKILL"} signal */
  const signal = (signal) => {
    if (wrapperExitResult || child.connected !== true) {
      return Promise.resolve({ sent: false, sentAt: null });
    }
    const requestId = nextSignalRequestId;
    nextSignalRequestId += 1;
    return new Promise((resolve) => {
      pendingSignals.set(requestId, {
        signal,
        dispatching: false,
        sentAt: null,
        resolve,
      });
      child.send({
        type: "posix-process-tree.signal",
        requestId,
        signal,
      }, (error) => {
        if (error) settleSignal(requestId, false, null);
      });
    });
  };

  const processTreeAlive = async () => {
    if (wrapperExitResult || typeof child.pid !== "number") return true;
    if (!adapterSpawned && !adapterExitResult) return true;
    const members = await readProcessGroupMembers(child.pid);
    if (!members) return true;
    return members.some((member) => member.pid !== child.pid
      && !["X", "Z"].includes(member.state[0]));
  };

  const release = async () => {
    if (wrapperExitResult) {
      await wrapperClosed;
      return;
    }
    if (child.connected === true) {
      child.send({ type: "posix-process-tree.release" }, () => undefined);
    }
    await wrapperClosed;
  };

  return {
    child,
    adapterChannel,
    adapterExit,
    adapterExited: () => adapterExitResult !== null,
    processTreeAlive,
    signal,
    release,
  };
};

if (process.argv[1] === supervisorPath && process.argv[2] === "supervise") {
  runSupervisor();
}
