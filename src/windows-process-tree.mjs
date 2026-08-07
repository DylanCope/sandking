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

/** @param {number} processId */
const readNativeWindowsProcessIdentity = (processId) => new Promise((resolve, reject) => {
  execFile("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$ErrorActionPreference='Stop'; $candidate = Get-CimInstance Win32_Process -Filter 'ProcessId = ${processId}'; if ($null -eq $candidate) { exit 3 }; $candidate | Select-Object ProcessId,CommandLine,@{Name='CreationTime';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress`,
  ], {
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 65_536,
  }, (error, stdout) => {
    if (error) {
      reject(error);
      return;
    }
    try {
      const row = JSON.parse(stdout);
      resolve({
        processId: Number(row.ProcessId),
        creationTime: new Date(row.CreationTime).toISOString(),
        commandLine: typeof row.CommandLine === "string" ? row.CommandLine : null,
      });
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
 * Capture the adapter's exact native identity and the process inventory that
 * established it while launch supervision is being installed. A later
 * cancellation must never infer that identity from a numeric PID that may
 * already have been reused.
 *
 * @param {number} rootPid
 * @param {{
 *   expectedCommandLineFragment?: string,
 *   readProcessIdentity?: (processId: number) => Promise<{processId: number, creationTime: string, commandLine: string | null} | null>,
 *   listProcesses?: () => Promise<Array<{processId: number, parentProcessId: number, creationTime: string}>>,
 * }} [options]
 */
export const captureWindowsProcessTreeSnapshot = async (rootPid, options = {}) => {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) {
    throw new Error("windows_process_tree_root_invalid");
  }
  let capturedRoot;
  try {
    capturedRoot = await (options.readProcessIdentity
      ?? readNativeWindowsProcessIdentity)(rootPid);
  } catch {
    return null;
  }
  const normalizedRoot = capturedRoot
    ? normalizeProcess({ ...capturedRoot, parentProcessId: 0 })
    : null;
  if (
    !normalizedRoot
    || normalizedRoot.processId !== rootPid
    || (options.expectedCommandLineFragment !== undefined
      && (!capturedRoot?.commandLine
        || !capturedRoot.commandLine.includes(options.expectedCommandLineFragment)))
  ) {
    return null;
  }
  /** @type {Array<{processId: number, parentProcessId: number, creationTime: string}>} */
  let listedProcesses;
  try {
    listedProcesses = await (options.listProcesses ?? listNativeWindowsProcesses)();
  } catch {
    return null;
  }
  const processes = listedProcesses.map(normalizeProcess);
  if (
    processes.some((process) => process === null)
    || new Set(processes.map((process) => process?.processId)).size !== processes.length
  ) {
    return null;
  }
  const initialProcesses = /** @type {Array<NonNullable<ReturnType<typeof normalizeProcess>>>} */ (
    processes
  );
  return {
    rootIdentity: {
      processId: normalizedRoot.processId,
      creationTime: normalizedRoot.creationTime,
    },
    initialProcesses,
  };
};

/**
 * Track Windows descendants before cooperative cancellation can let their
 * adapter parent exit. Retained PIDs remain supervised even if Windows
 * reparents them, and any inventory uncertainty prevents a false confirmation.
 *
 * @param {{
 *   rootIdentity: {processId: number, creationTime: string} | null,
 *   initialProcesses?: Array<{processId: number, parentProcessId: number, creationTime: string}>,
 *   listProcesses?: () => Promise<Array<{processId: number, parentProcessId: number, creationTime: string}>>,
 *   terminateProcessTree?: (processIdentity: {processId: number, creationTime: string}) => Promise<boolean>,
 * }} options
 */
export const createWindowsProcessTreeTracker = (options) => {
  const normalizedRoot = options.rootIdentity === null
    ? null
    : normalizeProcess({ ...options.rootIdentity, parentProcessId: 0 });
  if (options.rootIdentity !== null && normalizedRoot === null) {
    throw new Error("windows_process_tree_root_invalid");
  }
  const listProcesses = options.listProcesses ?? listNativeWindowsProcesses;
  const terminateProcessTree = options.terminateProcessTree
    ?? terminateNativeWindowsProcessTree;
  /** @type {Map<string, {processId: number, creationTime: string, parentIdentityKey: string | null}>} */
  const trackedIdentities = new Map();
  /** @type {Map<string, {processId: number, creationTime: string, parentIdentityKey: string | null}>} */
  let aliveIdentities = new Map();
  let trackingReliable = normalizedRoot !== null;
  let treeInventoryEstablished = false;
  const rootIdentityKey = normalizedRoot ? identityKey(normalizedRoot) : null;
  if (normalizedRoot && rootIdentityKey) {
    trackedIdentities.set(rootIdentityKey, {
      processId: normalizedRoot.processId,
      creationTime: normalizedRoot.creationTime,
      parentIdentityKey: null,
    });
  }

  /** @param {Array<{processId: number, parentProcessId: number, creationTime: string}>} listedProcesses */
  const applyInventory = (listedProcesses) => {
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
    if (
      rootIdentityKey !== null
      && currentByPid.get(normalizedRoot?.processId ?? -1)?.creationTime
        === normalizedRoot?.creationTime
    ) {
      treeInventoryEstablished = true;
    }
    let discovered = true;
    while (discovered) {
      discovered = false;
      for (const process of normalizedProcesses) {
        const processKey = identityKey(process);
        if (trackedIdentities.has(processKey)) continue;
        const currentParent = currentByPid.get(process.parentProcessId);
        const parent = currentParent
          ? trackedIdentities.get(identityKey(currentParent))
          : null;
        if (
          parent
          && Date.parse(parent.creationTime) <= Date.parse(process.creationTime)
        ) {
          trackedIdentities.set(processKey, {
            processId: process.processId,
            creationTime: process.creationTime,
            parentIdentityKey: identityKey(parent),
          });
          discovered = true;
        }
      }
    }
    for (const process of normalizedProcesses) {
      if (trackedIdentities.has(identityKey(process))) continue;
      const processCreatedAt = Date.parse(process.creationTime);
      const possibleTrackedParent = [...trackedIdentities.values()].find((identity) =>
        identity.processId === process.parentProcessId
        && Date.parse(identity.creationTime) <= processCreatedAt);
      if (!possibleTrackedParent) continue;
      const currentParent = currentByPid.get(process.parentProcessId);
      if (
        currentParent
        && identityKey(currentParent) !== identityKey(possibleTrackedParent)
        && Date.parse(currentParent.creationTime) <= processCreatedAt
      ) {
        // The candidate was created after the replacement parent, so it belongs
        // to that replacement rather than to the supervised identity.
        continue;
      }
      // Windows retains a creator PID after the creator exits. If a new child is
      // first visible only after its exact tracked parent disappeared, its
      // ancestry cannot be proven safely enough either to kill it or to confirm
      // that the supervised tree is gone.
      trackingReliable = false;
    }
    aliveIdentities = new Map([...trackedIdentities].filter(([, identity]) =>
      currentByPid.get(identity.processId)?.creationTime === identity.creationTime));
    if (!treeInventoryEstablished) trackingReliable = false;
    return true;
  };

  if (options.initialProcesses) applyInventory(options.initialProcesses);

  const refresh = async () => {
    /** @type {Array<{processId: number, parentProcessId: number, creationTime: string}>} */
    let listedProcesses;
    try {
      listedProcesses = await listProcesses();
    } catch {
      trackingReliable = false;
      return false;
    }
    return applyInventory(listedProcesses) && trackingReliable;
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
