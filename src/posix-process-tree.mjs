import { spawn } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  readFileSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnDarwinProcessTree } from "./darwin-process-tree.mjs";

const supervisorPath = fileURLToPath(import.meta.url);
/** @type {Record<string, string>} */
const packagedLinuxHelpers = {
  x64: fileURLToPath(new URL("./native/linux-x64/posix-process-tree-helper", import.meta.url)),
  arm64: fileURLToPath(new URL("./native/linux-arm64/posix-process-tree-helper", import.meta.url)),
};
/** @type {string | null} */
let retainedLinuxHelperPath = null;

const ensureLinuxProcessTreeHelper = () => {
  if (retainedLinuxHelperPath) return retainedLinuxHelperPath;
  const helperPath = packagedLinuxHelpers[process.arch];
  if (!helperPath) throw new Error("posix_process_tree_helper_unsupported_architecture");
  const helperStat = lstatSync(helperPath);
  if (!helperStat.isFile() || helperStat.isSymbolicLink()) {
    throw new Error("posix_process_tree_helper_invalid");
  }
  accessSync(helperPath, constants.X_OK);
  retainedLinuxHelperPath = helperPath;
  return helperPath;
};

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
  const processGroupId = process.ppid;
  if (!executable || !Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
    process.exit(1);
  }

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
      // supervisor while its retained native parent still owns the group. The
      // supervisor then signals that live group, so a stale numeric id can
      // never select a replacement process group.
      writeSupervisorStatus({
        type: "posix-process-tree.signal-dispatching",
        requestId: message.requestId,
        signal: message.signal,
        sentAt: new Date().toISOString(),
      });
    }
    try {
      process.kill(-processGroupId, message.signal);
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
    supervisorPid: process.pid,
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
 * @typedef {{pid: number, parentPid: number, processGroupId: number, state: string, startedAt: string}} PosixProcess
 */

/** @param {number} pid @param {string} stat */
const parseLinuxProcessStat = (pid, stat) => {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return null;
  const fields = stat.slice(commandEnd + 2).split(" ");
  const state = fields[0];
  const parentPid = Number(fields[1]);
  const processGroupId = Number(fields[2]);
  const startTime = fields[19];
  if (
    !Number.isSafeInteger(pid)
    || pid <= 0
    || !Number.isSafeInteger(parentPid)
    || parentPid < 0
    || !Number.isSafeInteger(processGroupId)
    || processGroupId <= 0
    || typeof state !== "string"
    || state.length === 0
    || !/^[0-9]+$/.test(startTime ?? "")
  ) {
    return null;
  }
  return {
    pid,
    parentPid,
    processGroupId,
    state,
    startedAt: `linux:${startTime}`,
  };
};

/** @returns {Promise<PosixProcess[] | null>} */
const readPosixProcesses = async () => {
  if (process.platform === "linux") {
    try {
      const entries = await readdir("/proc", { withFileTypes: true });
      const processEntries = entries.filter((entry) =>
        entry.isDirectory() && /^[0-9]+$/.test(entry.name));
      const processes = await Promise.all(processEntries.map(async (entry) => {
        try {
          const stat = await readFile(`/proc/${entry.name}/stat`, "utf8");
          const processEntry = parseLinuxProcessStat(Number(entry.name), stat);
          return processEntry ?? false;
        } catch {
          // A process can disappear between the directory and stat reads.
          return undefined;
        }
      }));
      if (processes.includes(false)) return null;
      return /** @type {PosixProcess[]} */ (
        processes.filter((processEntry) => processEntry !== undefined)
      );
    } catch {
      return null;
    }
  }

  return new Promise((resolve) => {
    const child = spawn("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], {
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
      const processes = [];
      for (const line of output.split("\n")) {
        if (line.trim() === "") continue;
        const match = /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
        const startedAt = match ? Date.parse(match[5]) : Number.NaN;
        if (!match || !Number.isFinite(startedAt)) {
          resolve(null);
          return;
        }
        processes.push({
          pid: Number(match[1]),
          parentPid: Number(match[2]),
          processGroupId: Number(match[3]),
          state: match[4],
          startedAt: `posix:${startedAt}`,
        });
      }
      resolve(processes);
    });
  });
};

/** @param {number} rootPid @returns {PosixProcess[] | null} */
const readLinuxProcessTree = (rootPid) => {
  /** @type {Array<{pid: number, expectedParentPid: number | null}>} */
  const pending = [{ pid: rootPid, expectedParentPid: null }];
  const seen = new Set();
  /** @type {PosixProcess[]} */
  const processes = [];
  while (pending.length > 0) {
    const candidate = pending.shift();
    if (!candidate || seen.has(candidate.pid)) continue;
    const processId = candidate.pid;
    seen.add(processId);
    try {
      const stat = readFileSync(`/proc/${processId}/stat`, "utf8");
      const processEntry = parseLinuxProcessStat(processId, stat);
      if (!processEntry
        || (candidate.expectedParentPid !== null
          && processEntry.parentPid !== candidate.expectedParentPid)) {
        return null;
      }
      processes.push(processEntry);
      const taskIds = readdirSync(`/proc/${processId}/task`)
        .filter((value) => /^[0-9]+$/.test(value));
      const childIds = new Set(taskIds.flatMap((taskId) =>
        readFileSync(`/proc/${processId}/task/${taskId}/children`, "utf8")
          .trim().split(/\s+/).flatMap((value) =>
            /^[0-9]+$/.test(value) ? [Number(value)] : [])));
      pending.push(...[...childIds].map((pid) => ({
        pid,
        expectedParentPid: processId,
      })));
    } catch {
      // A listed descendant can exit and reparent its own children before it
      // is read. That race loses provable ancestry, so retain uncertainty.
      return null;
    }
  }
  return processes;
};

/** @param {{pid: number, startedAt: string}} identity */
const identityKey = (identity) => `${identity.pid}@${identity.startedAt}`;

/** @param {string} left @param {string} right */
const startedNoLaterThan = (left, right) => {
  const [leftKind, leftValue] = left.split(":");
  const [rightKind, rightValue] = right.split(":");
  if (leftKind !== rightKind || !/^[0-9]+$/.test(leftValue ?? "")
    || !/^[0-9]+$/.test(rightValue ?? "")) {
    return false;
  }
  return BigInt(leftValue) <= BigInt(rightValue);
};

/**
 * Spawn a Host-owned POSIX process-group leader which launches the adapter and
 * remains alive until the Host releases it after terminal-state publication.
 * Group signals are requested over the leader's private IPC channel, so the
 * Host never targets a retained numeric process-group id. Descendants which
 * leave that group are retained by creation identity and revalidated against
 * the live process inventory immediately before an individual signal.
 *
 * @param {string} executable
 * @param {string[]} args
 * @param {{cwd: string, env: NodeJS.ProcessEnv}} options
 */
export const spawnPosixProcessTree = (executable, args, options) => {
  if (process.platform === "darwin") {
    return spawnDarwinProcessTree(executable, args, options);
  }
  if (process.platform !== "linux") {
    throw new Error("posix_process_tree_platform_unsupported");
  }
  const linuxHelperPath = process.platform === "linux"
    ? ensureLinuxProcessTreeHelper()
    : null;
  const child = spawn(linuxHelperPath ?? process.execPath, linuxHelperPath
    ? [
        "subreaper",
        process.execPath,
        supervisorPath,
        "supervise",
        executable,
        ...args,
      ]
    : [
        supervisorPath,
        "supervise",
        executable,
        ...args,
      ], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "ipc", "pipe", "pipe"],
  });
  const adapterChannel = child.stdio[3];
  const statusChannel = child.stdio[4];
  const exactSignalCommandChannel = /** @type {import("node:stream").Writable | null} */ (
    child.stdio.at(6) ?? null
  );
  const exactSignalResultChannel = /** @type {import("node:stream").Readable | null} */ (
    child.stdio.at(7) ?? null
  );
  if (
    typeof child.pid !== "number"
    || !adapterChannel
    || !("readable" in adapterChannel)
    || !statusChannel
    || !("readable" in statusChannel)
    || !exactSignalCommandChannel
    || !("writable" in exactSignalCommandChannel)
    || !exactSignalResultChannel
    || !("readable" in exactSignalResultChannel)
  ) {
    throw new Error("harness_adapter_start_failed");
  }
  const wrapperPid = child.pid;

  let adapterSpawned = false;
  /** @type {number | null} */
  let internalSupervisorPid = null;
  /** @type {number | null} */
  let adapterPid = null;
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
  let nextExactSignalRequestId = 1;
  /** @type {Map<number, (result: boolean | null) => void>} */
  const pendingExactSignals = new Map();
  let exactSignalResultBuffer = "";
  /** @type {Map<string, {pid: number, startedAt: string, processGroupId: number, parentIdentityKey: string | null}>} */
  const trackedIdentities = new Map();
  /** @type {Map<string, {pid: number, startedAt: string, processGroupId: number, parentIdentityKey: string | null}>} */
  let aliveIdentities = new Map();
  let trackingReliable = true;
  let treeInventoryEstablished = false;
  /** @type {Promise<boolean> | null} */
  let refreshOperation = null;

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
  /** @param {boolean | null} result */
  const settleAllExactSignals = (result) => {
    for (const [requestId, resolve] of pendingExactSignals) {
      pendingExactSignals.delete(requestId);
      resolve(result);
    }
  };

  /**
   * The retained native ancestor uses pidfds when the kernel provides them. On
   * Linux 4.18-5.2 it instead seizes the descendant, rechecks its /proc creation
   * identity while it cannot exit or be replaced, and only then delivers the
   * signal. Both paths therefore preserve exact identity across PID reuse.
   *
   * @param {{pid: number, startedAt: string}} identity
   * @param {"SIGTERM" | "SIGKILL"} signal
   * @returns {Promise<boolean | null>}
   */
  const signalExactLinuxIdentity = (identity, signal) => new Promise((resolve) => {
    const startTime = /^linux:([0-9]+)$/.exec(identity.startedAt)?.[1];
    if (!startTime || exactSignalCommandChannel.destroyed
        || exactSignalCommandChannel.writableEnded) {
      resolve(null);
      return;
    }
    const requestId = nextExactSignalRequestId;
    nextExactSignalRequestId += 1;
    pendingExactSignals.set(requestId, resolve);
    exactSignalCommandChannel.write(
      `signal ${requestId} ${identity.pid} ${startTime} ${signal}\n`,
      (/** @type {Error | null | undefined} */ error) => {
        if (!error) return;
        const pending = pendingExactSignals.get(requestId);
        if (!pending) return;
        pendingExactSignals.delete(requestId);
        pending(null);
      },
    );
  });

  /** @param {PosixProcess[]} processes */
  const applyInventory = (processes) => {
    if (
      new Set(processes.map((processEntry) => processEntry.pid)).size
        !== processes.length
    ) {
      trackingReliable = false;
      return false;
    }
    const currentByPid = new Map(processes.map((processEntry) => [
      processEntry.pid,
      processEntry,
    ]));
    const wrapper = currentByPid.get(wrapperPid);
    if (
      process.platform === "linux"
      && ((wrapper && wrapper.processGroupId !== wrapperPid)
        || (!wrapper && wrapperExitResult === null))
    ) {
      trackingReliable = false;
      return false;
    }
    if (adapterPid !== null) {
      const adapter = currentByPid.get(adapterPid);
      const alreadyTrackedAdapter = [...trackedIdentities.values()].find(
        (identity) => identity.pid === adapterPid && identity.parentIdentityKey === null,
      );
      if (adapter && !alreadyTrackedAdapter) {
        const adapterKey = identityKey(adapter);
        trackedIdentities.set(adapterKey, {
          pid: adapter.pid,
          startedAt: adapter.startedAt,
          processGroupId: adapter.processGroupId,
          parentIdentityKey: null,
        });
        treeInventoryEstablished = true;
      }
    }

    // The live wrapper owns this group identity. Members can therefore be
    // retained safely even if their adapter ancestor exited before an
    // inventory read; an unrelated process cannot reuse the group while the
    // wrapper remains its leader.
    for (const processEntry of processes) {
      if (
        processEntry.pid === wrapperPid
        || processEntry.pid === internalSupervisorPid
        || processEntry.processGroupId !== wrapperPid
        || ["X", "Z"].includes(processEntry.state[0])
      ) {
        continue;
      }
      const processKey = identityKey(processEntry);
      if (!trackedIdentities.has(processKey)) {
        trackedIdentities.set(processKey, {
          pid: processEntry.pid,
          startedAt: processEntry.startedAt,
          processGroupId: processEntry.processGroupId,
          parentIdentityKey: null,
        });
      }
      treeInventoryEstablished = true;
    }

    // On Linux the live wrapper is established as a child subreaper before the
    // adapter starts. A daemon whose short-lived creator has already exited is
    // reparented here, preserving kernel-proven ownership even though the
    // original ancestry chain has disappeared.
    if (process.platform === "linux") {
      for (const processEntry of processes) {
        if (
          processEntry.pid === wrapperPid
          || processEntry.pid === internalSupervisorPid
          || processEntry.parentPid !== wrapperPid
          || ["X", "Z"].includes(processEntry.state[0])
        ) {
          continue;
        }
        const processKey = identityKey(processEntry);
        if (!trackedIdentities.has(processKey)) {
          trackedIdentities.set(processKey, {
            pid: processEntry.pid,
            startedAt: processEntry.startedAt,
            processGroupId: processEntry.processGroupId,
            parentIdentityKey: null,
          });
        }
        treeInventoryEstablished = true;
      }
    }

    let discovered = true;
    while (discovered) {
      discovered = false;
      for (const processEntry of processes) {
        if (["X", "Z"].includes(processEntry.state[0])) continue;
        const processKey = identityKey(processEntry);
        if (trackedIdentities.has(processKey)) continue;
        const currentParent = currentByPid.get(processEntry.parentPid);
        const parent = currentParent
          ? trackedIdentities.get(identityKey(currentParent))
          : null;
        if (
          parent
          && startedNoLaterThan(parent.startedAt, processEntry.startedAt)
        ) {
          trackedIdentities.set(processKey, {
            pid: processEntry.pid,
            startedAt: processEntry.startedAt,
            processGroupId: processEntry.processGroupId,
            parentIdentityKey: identityKey(parent),
          });
          discovered = true;
        }
      }
    }

    for (const processEntry of processes) {
      if (trackedIdentities.has(identityKey(processEntry))) continue;
      const possibleTrackedParent = [...trackedIdentities.values()].find(
        (identity) => identity.pid === processEntry.parentPid
          && startedNoLaterThan(identity.startedAt, processEntry.startedAt),
      );
      if (!possibleTrackedParent) continue;
      const currentParent = currentByPid.get(processEntry.parentPid);
      if (
        currentParent
        && identityKey(currentParent) !== identityKey(possibleTrackedParent)
        && startedNoLaterThan(currentParent.startedAt, processEntry.startedAt)
      ) {
        // The candidate belongs to a replacement parent, not the retained
        // supervised identity whose numeric PID was reused.
        continue;
      }
      // Once a parent identity disappears, ancestry of a newly observed child
      // can no longer be proven. Preserve uncertainty instead of targeting it
      // or claiming the supervised tree is gone.
      trackingReliable = false;
    }

    aliveIdentities = new Map([...trackedIdentities].filter(([, identity]) => {
      const current = currentByPid.get(identity.pid);
      return current?.startedAt === identity.startedAt
        && !["X", "Z"].includes(current.state[0]);
    }));
    return true;
  };

  const refresh = () => {
    if (refreshOperation) return refreshOperation;
    refreshOperation = (async () => {
      const processes = await readPosixProcesses();
      if (!processes) {
        trackingReliable = false;
        return false;
      }
      return applyInventory(processes) && trackingReliable
        && treeInventoryEstablished;
    })();
    void refreshOperation.then(() => {
      refreshOperation = null;
    }, () => {
      trackingReliable = false;
      refreshOperation = null;
    });
    return refreshOperation;
  };

  const captureDescendants = async () => {
    if (adapterPid === null) return false;
    if (process.platform !== "linux") return refresh();
    let processes = null;
    for (let attempt = 0; processes === null && attempt < 8; attempt += 1) {
      processes = readLinuxProcessTree(wrapperPid);
    }
    if (!processes) {
      trackingReliable = false;
      return false;
    }
    return applyInventory(processes) && trackingReliable
      && treeInventoryEstablished;
  };

  /** @param {any} message */
  const consumeStatus = (message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "posix-process-tree.adapter-spawned") {
      adapterSpawned = true;
      internalSupervisorPid = Number.isSafeInteger(message.supervisorPid)
        && message.supervisorPid > 0
        && message.supervisorPid !== wrapperPid
        ? message.supervisorPid
        : null;
      adapterPid = Number.isSafeInteger(message.pid) && message.pid > 0
        ? message.pid
        : null;
      if (internalSupervisorPid === null || adapterPid === null) {
        trackingReliable = false;
      }
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
        trackingReliable = false;
      }
    }
  });
  exactSignalResultChannel.setEncoding("utf8");
  exactSignalResultChannel.on("data", (/** @type {string} */ chunk) => {
    exactSignalResultBuffer += chunk;
    while (exactSignalResultBuffer.includes("\n")) {
      const newline = exactSignalResultBuffer.indexOf("\n");
      const line = exactSignalResultBuffer.slice(0, newline);
      exactSignalResultBuffer = exactSignalResultBuffer.slice(newline + 1);
      const result = /^([0-9]+) ([0345])$/.exec(line);
      const requestId = result ? Number(result[1]) : Number.NaN;
      const pending = pendingExactSignals.get(requestId);
      if (!result || !pending) {
        trackingReliable = false;
        continue;
      }
      pendingExactSignals.delete(requestId);
      // Status 5 means the identity-pinned signal was delivered while the
      // helper's later cleanup/exit observation remains separate from complete
      // tree confirmation. Delivery remains certain; processTreeAlive()
      // independently confirms the tree before the run can become cancelled.
      pending(["0", "5"].includes(result[2])
        ? true
        : result[2] === "3" ? false : null);
    }
  });
  exactSignalCommandChannel.once("error", () => settleAllExactSignals(null));
  exactSignalResultChannel.once("error", () => settleAllExactSignals(null));
  exactSignalResultChannel.once("close", () => settleAllExactSignals(null));
  child.once("error", () => {
    settleAdapterExit({ code: null, signal: null, startFailed: true });
    settleAllExactSignals(null);
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
    settleAllExactSignals(null);
    resolveWrapperClosed(wrapperExitResult);
  });

  /** @param {"SIGTERM" | "SIGKILL"} signal */
  const signalProcessGroup = (signal) => {
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
    if (!adapterSpawned && !adapterExitResult) return true;
    const refreshed = await refresh();
    return !refreshed || !trackingReliable || aliveIdentities.size > 0;
  };

  /** @param {{pid: number, startedAt: string}} identity @param {"SIGTERM" | "SIGKILL"} signal */
  const signalExactIdentity = async (identity, signal) => {
    const refreshed = process.platform === "linux"
      ? await captureDescendants()
      : await refresh();
    if (!refreshed || !trackingReliable) return null;
    if (!aliveIdentities.has(identityKey(identity))) return false;
    if (process.platform !== "linux") {
      // POSIX platforms without pidfds cannot close the check/signal PID-reuse
      // race for a process which left the retained group. Preserve uncertainty
      // and never send a numeric-PID signal outside the supervised group.
      trackingReliable = false;
      return null;
    }
    const sent = await signalExactLinuxIdentity(identity, signal);
    if (sent === null) trackingReliable = false;
    return sent;
  };

  /** @param {"SIGTERM" | "SIGKILL"} signal */
  const signal = async (signal) => {
    // Cooperative group dispatch uses the retained live wrapper immediately.
    // The read-only cancellation preparation has already retained detached
    // identities; refresh and signal those while the group request is in
    // flight. Forced termination still kills detached leaves before the group.
    const groupSignalOperation = signal === "SIGTERM"
      ? signalProcessGroup(signal)
      : null;
    if (signal === "SIGTERM" || adapterExitResult) {
      if (process.platform === "linux") {
        await captureDescendants();
      } else {
        await refresh();
      }
    } else {
      // The cancellation preparation already retained the system-wide tree.
      // Refresh only the still-live adapter ancestry at the forced deadline so
      // a redundant global scan cannot delay the actual escalation dispatch.
      await captureDescendants();
    }
    let sent = false;
    /** @type {string | null} */
    let sentAt = null;
    const candidates = () => [...aliveIdentities.values()]
      .filter((identity) => identity.processGroupId !== wrapperPid)
      .sort((left, right) => right.pid - left.pid);
    if (signal === "SIGTERM") {
      for (const identity of candidates()) {
        const identitySignalled = await signalExactIdentity(identity, signal);
        if (identitySignalled) {
          sent = true;
          sentAt ??= new Date().toISOString();
        }
      }
    } else {
      for (let attempt = 0; candidates().length > 0 && attempt < 4_096; attempt += 1) {
        const detached = candidates();
        const identity = detached.find((candidate) => !detached.some(
          (possibleChild) => possibleChild.parentIdentityKey === identityKey(candidate),
        ));
        if (!identity) {
          trackingReliable = false;
          break;
        }
        const identitySignalled = await signalExactIdentity(identity, signal);
        if (identitySignalled === null) break;
        if (identitySignalled) {
          sent = true;
          sentAt ??= new Date().toISOString();
        }
        if (process.platform === "linux") {
          await captureDescendants();
        } else {
          await refresh();
        }
        if (!identitySignalled && aliveIdentities.has(identityKey(identity))) {
          trackingReliable = false;
          break;
        }
      }
    }
    const groupSignal = await (groupSignalOperation ?? signalProcessGroup(signal));
    if (groupSignal.sent) {
      sent = true;
      sentAt ??= groupSignal.sentAt;
    }
    if (signal === "SIGKILL") await refresh();
    return { sent, sentAt };
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
    captureDescendants,
    prepareCancellation: process.platform === "linux" ? captureDescendants : refresh,
    processTreeAlive,
    signal,
    release,
  };
};

if (process.argv[1] === supervisorPath && process.argv[2] === "supervise") {
  runSupervisor();
}
