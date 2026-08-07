import { execFile } from "node:child_process";

const listNativeWindowsProcesses = () => new Promise((resolve, reject) => {
  execFile("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name='CreationTime';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress",
  ], {
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 1_048_576,
  }, (error, stdout) => {
    if (error) {
      reject(error);
      return;
    }
    try {
      const parsed = stdout.trim() === "" ? [] : JSON.parse(stdout);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      resolve(rows.map((row) => ({
        processId: Number(row.ProcessId),
        parentProcessId: Number(row.ParentProcessId),
        creationTime: new Date(row.CreationTime).toISOString(),
      })).filter((row) => Number.isSafeInteger(row.processId)
        && row.processId > 0
        && Number.isSafeInteger(row.parentProcessId)
        && row.parentProcessId >= 0
        && Number.isFinite(Date.parse(row.creationTime))));
    } catch (parseError) {
      reject(parseError);
    }
  });
});

/** @param {{processId: number, creationTime: string}} processIdentity */
const terminateNativeWindowsProcessTree = (processIdentity) => new Promise((resolve) => {
  // Recheck the exact CIM identity in the same native operation immediately
  // before taskkill. A reused numeric PID is never accepted as the retained
  // Harness process merely because its number matches. Descendants are
  // terminated individually from the creation-time-checked tracker; /T would
  // reintroduce unsafe parent-PID inference inside taskkill.
  execFile("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$ErrorActionPreference='Stop'; $candidate = Get-CimInstance Win32_Process -Filter 'ProcessId = ${processIdentity.processId}'; if ($null -eq $candidate -or $candidate.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') -ne '${processIdentity.creationTime}') { exit 3 }; & taskkill.exe /PID ${processIdentity.processId} /F; exit $LASTEXITCODE`,
  ], {
    windowsHide: true,
    timeout: 5_000,
  }, (error) => resolve(error === null));
});

/** @param {unknown} value */
const normalizeProcess = (value) => {
  if (!value || typeof value !== "object") return null;
  const process = /** @type {Record<string, unknown>} */ (value);
  const processId = Number(process.processId);
  const parentProcessId = Number(process.parentProcessId);
  const timestamp = typeof process.creationTime === "string"
    ? Date.parse(process.creationTime)
    : Number.NaN;
  if (
    !Number.isSafeInteger(processId)
    || processId <= 0
    || !Number.isSafeInteger(parentProcessId)
    || parentProcessId < 0
    || !Number.isFinite(timestamp)
  ) {
    return null;
  }
  return {
    processId,
    parentProcessId,
    creationTime: new Date(timestamp).toISOString(),
  };
};

/** @param {{processId: number, creationTime: string}} identity */
const identityKey = (identity) => `${identity.processId}@${identity.creationTime}`;

/**
 * Track Windows descendants before cooperative cancellation can let their
 * adapter parent exit. Retained PIDs remain supervised even if Windows
 * reparents them, and any inventory uncertainty prevents a false confirmation.
 *
 * @param {{
 *   rootPid: number,
 *   listProcesses?: () => Promise<Array<{processId: number, parentProcessId: number, creationTime: string}>>,
 *   terminateProcessTree?: (processIdentity: {processId: number, creationTime: string}) => Promise<boolean>,
 * }} options
 */
export const createWindowsProcessTreeTracker = (options) => {
  if (!Number.isSafeInteger(options.rootPid) || options.rootPid <= 0) {
    throw new Error("windows_process_tree_root_invalid");
  }
  const listProcesses = options.listProcesses ?? listNativeWindowsProcesses;
  const terminateProcessTree = options.terminateProcessTree
    ?? terminateNativeWindowsProcessTree;
  /** @type {Map<string, {processId: number, creationTime: string, parentIdentityKey: string | null}>} */
  const trackedIdentities = new Map();
  /** @type {Map<string, {processId: number, creationTime: string, parentIdentityKey: string | null}>} */
  let aliveIdentities = new Map();
  let trackingReliable = true;
  /** @type {string | null} */
  let rootIdentityKey = null;

  const refresh = async () => {
    /** @type {Array<{processId: number, parentProcessId: number, creationTime: string}>} */
    let listedProcesses;
    try {
      listedProcesses = await listProcesses();
    } catch {
      trackingReliable = false;
      return false;
    }
    const processes = listedProcesses.map(normalizeProcess);
    if (
      processes.some((process) => process === null)
      || new Set(processes.map((process) => process?.processId)).size !== processes.length
    ) {
      trackingReliable = false;
      return false;
    }
    const normalizedProcesses = /** @type {Array<NonNullable<ReturnType<typeof normalizeProcess>>>} */ (
      processes
    );
    const currentByPid = new Map(normalizedProcesses.map((process) => [
      process.processId,
      process,
    ]));
    if (rootIdentityKey === null) {
      const root = currentByPid.get(options.rootPid);
      if (root) {
        rootIdentityKey = identityKey(root);
        trackedIdentities.set(rootIdentityKey, {
          processId: root.processId,
          creationTime: root.creationTime,
          parentIdentityKey: null,
        });
      } else {
        // A first inventory after the adapter root exited cannot discover
        // descendants that Windows has already reparented. Preserve uncertainty
        // instead of treating an empty tracked identity set as termination proof.
        trackingReliable = false;
        aliveIdentities = new Map();
        return false;
      }
    }
    let discovered = true;
    while (discovered) {
      discovered = false;
      for (const process of normalizedProcesses) {
        const processKey = identityKey(process);
        if (trackedIdentities.has(processKey)) continue;
        const parent = [...trackedIdentities.entries()].find(([, identity]) =>
          identity.processId === process.parentProcessId
          && currentByPid.get(identity.processId)?.creationTime === identity.creationTime);
        if (
          parent
          && Date.parse(parent[1].creationTime) <= Date.parse(process.creationTime)
        ) {
          trackedIdentities.set(processKey, {
            processId: process.processId,
            creationTime: process.creationTime,
            parentIdentityKey: parent[0],
          });
          discovered = true;
        }
      }
    }
    aliveIdentities = new Map([...trackedIdentities].filter(([, identity]) =>
      currentByPid.get(identity.processId)?.creationTime === identity.creationTime));
    return true;
  };

  return {
    prepareCancellation: refresh,
    processTreeAlive: async () => {
      const refreshed = await refresh();
      return !refreshed || !trackingReliable || aliveIdentities.size > 0;
    },
    forceTerminate: async () => {
      if (!(await refresh()) || !trackingReliable) return false;
      let signalSent = false;
      for (let attempt = 0; aliveIdentities.size > 0 && attempt < 4_096; attempt += 1) {
        // Kill exact tracked leaves before their parents. Refresh after every
        // action so descendants created during escalation are captured while
        // their creation-time-checked parent is still alive.
        const identity = [...aliveIdentities.values()]
          .filter((candidate) => ![...aliveIdentities.values()].some((possibleChild) =>
            possibleChild.parentIdentityKey === identityKey(candidate)))
          .sort((left, right) => right.processId - left.processId)[0];
        if (!identity) {
          trackingReliable = false;
          return signalSent;
        }
        const sent = await terminateProcessTree({
          processId: identity.processId,
          creationTime: identity.creationTime,
        });
        signalSent = sent || signalSent;
        if (!(await refresh())) return signalSent;
        if (!sent && aliveIdentities.has(identityKey(identity))) {
          trackingReliable = false;
          return signalSent;
        }
      }
      if (aliveIdentities.size > 0) {
        trackingReliable = false;
      }
      return signalSent;
    },
  };
};
