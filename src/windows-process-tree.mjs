import { execFile } from "node:child_process";

const listNativeWindowsProcesses = () => new Promise((resolve, reject) => {
  execFile("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId) | ConvertTo-Json -Compress",
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
      })).filter((row) => Number.isSafeInteger(row.processId)
        && row.processId > 0
        && Number.isSafeInteger(row.parentProcessId)
        && row.parentProcessId >= 0));
    } catch (parseError) {
      reject(parseError);
    }
  });
});

/** @param {number} processId */
const terminateNativeWindowsProcessTree = (processId) => new Promise((resolve) => {
  execFile("taskkill.exe", ["/PID", String(processId), "/T", "/F"], {
    windowsHide: true,
    timeout: 5_000,
  }, (error) => resolve(error === null));
});

/**
 * Track Windows descendants before cooperative cancellation can let their
 * adapter parent exit. Retained PIDs remain supervised even if Windows
 * reparents them, and any inventory uncertainty prevents a false confirmation.
 *
 * @param {{
 *   rootPid: number,
 *   listProcesses?: () => Promise<Array<{processId: number, parentProcessId: number}>>,
 *   terminateProcessTree?: (processId: number) => Promise<boolean>,
 * }} options
 */
export const createWindowsProcessTreeTracker = (options) => {
  if (!Number.isSafeInteger(options.rootPid) || options.rootPid <= 0) {
    throw new Error("windows_process_tree_root_invalid");
  }
  const listProcesses = options.listProcesses ?? listNativeWindowsProcesses;
  const terminateProcessTree = options.terminateProcessTree
    ?? terminateNativeWindowsProcessTree;
  const trackedProcessIds = new Set([options.rootPid]);
  let aliveProcessIds = new Set([options.rootPid]);
  let trackingReliable = true;
  let rootObserved = false;
  let terminationTargetsReliable = true;

  const refresh = async () => {
    if (!terminationTargetsReliable) return false;
    /** @type {Array<{processId: number, parentProcessId: number}>} */
    let processes;
    try {
      processes = await listProcesses();
    } catch {
      trackingReliable = false;
      return false;
    }
    if (processes.some((process) => process.processId === options.rootPid)) {
      rootObserved = true;
    } else if (!rootObserved) {
      // A first inventory after the adapter root exited cannot discover
      // descendants that Windows has already reparented. Preserve uncertainty
      // instead of treating an empty tracked PID set as termination proof.
      trackingReliable = false;
      terminationTargetsReliable = false;
      aliveProcessIds = new Set();
      return false;
    }
    let discovered = true;
    while (discovered) {
      discovered = false;
      for (const process of processes) {
        if (
          trackedProcessIds.has(process.parentProcessId)
          && !trackedProcessIds.has(process.processId)
        ) {
          trackedProcessIds.add(process.processId);
          discovered = true;
        }
      }
    }
    aliveProcessIds = new Set(processes
      .filter((process) => trackedProcessIds.has(process.processId))
      .map((process) => process.processId));
    return true;
  };

  return {
    prepareCancellation: refresh,
    processTreeAlive: async () => {
      const refreshed = await refresh();
      return !refreshed || !trackingReliable || aliveProcessIds.size > 0;
    },
    forceTerminate: async () => {
      await refresh();
      if (!terminationTargetsReliable) return false;
      let signalSent = false;
      for (const processId of [...aliveProcessIds].sort((left, right) => left - right)) {
        signalSent = await terminateProcessTree(processId) || signalSent;
      }
      return signalSent;
    },
  };
};
