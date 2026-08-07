import { spawn } from "node:child_process";
import { closeSync, readFileSync, writeSync } from "node:fs";
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
  /** @type {number[]} */
  const pending = [rootPid];
  const seen = new Set();
  /** @type {PosixProcess[]} */
  const processes = [];
  while (pending.length > 0) {
    const processId = pending.shift();
    if (!processId || seen.has(processId)) continue;
    seen.add(processId);
    try {
      const stat = readFileSync(`/proc/${processId}/stat`, "utf8");
      const children = readFileSync(
        `/proc/${processId}/task/${processId}/children`,
        "utf8",
      );
      const processEntry = parseLinuxProcessStat(processId, stat);
      if (!processEntry) return null;
      processes.push(processEntry);
      pending.push(...children.trim().split(/\s+/).flatMap((value) =>
        /^[0-9]+$/.test(value) ? [Number(value)] : []));
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
        processEntry.pid === child.pid
        || processEntry.processGroupId !== child.pid
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
    const processes = readLinuxProcessTree(adapterPid);
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
      adapterPid = Number.isSafeInteger(message.pid) && message.pid > 0
        ? message.pid
        : null;
      if (adapterPid === null) trackingReliable = false;
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
    if (typeof child.pid !== "number") return true;
    if (!adapterSpawned && !adapterExitResult) return true;
    const refreshed = await refresh();
    return !refreshed || !trackingReliable || aliveIdentities.size > 0;
  };

  /** @param {{pid: number, startedAt: string}} identity @param {"SIGTERM" | "SIGKILL"} signal */
  const signalExactIdentity = async (identity, signal) => {
    if (!(await refresh()) || !trackingReliable) return null;
    if (!aliveIdentities.has(identityKey(identity))) return false;
    try {
      process.kill(identity.pid, signal);
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error
        && error.code === "ESRCH") {
        await refresh();
        return false;
      }
      trackingReliable = false;
      return null;
    }
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
      await refresh();
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
      .filter((identity) => identity.processGroupId !== child.pid)
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
        await refresh();
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
    prepareCancellation: refresh,
    processTreeAlive,
    signal,
    release,
  };
};

if (process.argv[1] === supervisorPath && process.argv[2] === "supervise") {
  runSupervisor();
}
