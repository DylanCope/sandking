import { execFile } from "node:child_process";

const WINDOWS_EPOCH_FILE_TIME = 116_444_736_000_000_000n;
const WINDOWS_CREATION_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?Z$/;

/** @param {unknown} value */
const normalizeWindowsCreationTime = (value) => {
  if (typeof value !== "string") return null;
  const match = WINDOWS_CREATION_TIME_PATTERN.exec(value);
  if (!match) return null;
  const second = match[1];
  const secondUnixMilliseconds = Date.parse(`${second}.000Z`);
  if (
    !Number.isFinite(secondUnixMilliseconds)
    || new Date(secondUnixMilliseconds).toISOString() !== `${second}.000Z`
  ) {
    return null;
  }
  const fractionalFileTime = (match[2] ?? "").padEnd(7, "0");
  const fileTime = BigInt(secondUnixMilliseconds) * 10_000n
    + WINDOWS_EPOCH_FILE_TIME
    + BigInt(fractionalFileTime || "0");
  if (fileTime < 0n) return null;
  return {
    creationTime: `${second}.${fractionalFileTime}Z`,
    fileTime,
  };
};

/**
 * @param {string} left
 * @param {string} right
 */
const creationTimeIsNoLaterThan = (left, right) => {
  const leftFileTime = normalizeWindowsCreationTime(left)?.fileTime;
  const rightFileTime = normalizeWindowsCreationTime(right)?.fileTime;
  return leftFileTime !== undefined
    && rightFileTime !== undefined
    && leftFileTime <= rightFileTime;
};

/**
 * CIM_DATETIME can retain only microseconds, so it is safe as a consistency
 * guard only after both values are compared at that documented precision.
 * The native FILETIME remains the process identity carried by the tracker.
 *
 * @param {string} nativeCreationTime
 * @param {string} cimCreationTime
 */
const creationTimeMatchesCimPrecision = (nativeCreationTime, cimCreationTime) => {
  const nativeFileTime = normalizeWindowsCreationTime(nativeCreationTime)?.fileTime;
  const cimFileTime = normalizeWindowsCreationTime(cimCreationTime)?.fileTime;
  return nativeFileTime !== undefined
    && cimFileTime !== undefined
    && nativeFileTime / 10n === cimFileTime / 10n;
};

/** @param {typeof execFile} execute */
const listNativeWindowsProcesses = (execute = execFile) => new Promise((resolve, reject) => {
  const command = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${exactWindowsProcessSource}
'@
@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name='CimCreationTime';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},@{Name='CreationTime';Expression={[SandKingExactProcess]::ReadCreationTime([uint32]$_.ProcessId)}}) | ConvertTo-Json -Compress`;
  execute("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
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
      resolve(rows.map((row) => {
        const normalizedCreationTime = normalizeWindowsCreationTime(row.CreationTime);
        const cimCreationTime = normalizeWindowsCreationTime(row.CimCreationTime);
        return {
          processId: Number(row.ProcessId),
          parentProcessId: Number(row.ParentProcessId),
          creationTime: normalizedCreationTime && cimCreationTime
            && creationTimeMatchesCimPrecision(
              normalizedCreationTime.creationTime,
              cimCreationTime.creationTime,
            )
            ? normalizedCreationTime.creationTime
            : null,
        };
      }).filter((row) => Number.isSafeInteger(row.processId)
        && row.processId > 0
        && Number.isSafeInteger(row.parentProcessId)
        && row.parentProcessId >= 0
        && row.creationTime !== null));
    } catch (parseError) {
      reject(parseError);
    }
  });
});

/** @param {number} processId @param {typeof execFile} execute */
const readNativeWindowsProcessIdentity = (processId, execute = execFile) => new Promise(
  (resolve, reject) => {
    const command = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${exactWindowsProcessSource}
'@
$candidate = Get-CimInstance Win32_Process -Filter 'ProcessId = ${processId}'
if ($null -eq $candidate) { exit 3 }
$candidate | Select-Object ProcessId,CommandLine,@{Name='CimCreationTime';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},@{Name='CreationTime';Expression={[SandKingExactProcess]::ReadCreationTime([uint32]$_.ProcessId)}} | ConvertTo-Json -Compress`;
    execute("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
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
        const normalizedCreationTime = normalizeWindowsCreationTime(row.CreationTime);
        const cimCreationTime = normalizeWindowsCreationTime(row.CimCreationTime);
        if (
          !normalizedCreationTime
          || !cimCreationTime
          || !creationTimeMatchesCimPrecision(
            normalizedCreationTime.creationTime,
            cimCreationTime.creationTime,
          )
        ) {
          reject(new Error("windows_process_creation_time_invalid"));
          return;
        }
        resolve({
          processId: Number(row.ProcessId),
          creationTime: normalizedCreationTime.creationTime,
          commandLine: typeof row.CommandLine === "string" ? row.CommandLine : null,
        });
      } catch (parseError) {
        reject(parseError);
      }
    });
  },
);

const exactWindowsProcessSource = String.raw`
using System;
using System.Globalization;
using System.Runtime.InteropServices;

public static class SandKingExactProcess
{
    private const uint ProcessTerminate = 0x0001;
    private const uint ProcessQueryLimitedInformation = 0x1000;
    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint Low;
        public uint High;

        public long ToInt64()
        {
            return ((long)High << 32) | Low;
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(
        uint desiredAccess,
        bool inheritHandle,
        uint processId
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(
        IntPtr processHandle,
        out FileTime creationTime,
        out FileTime exitTime,
        out FileTime kernelTime,
        out FileTime userTime
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr processHandle, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr processHandle);

    public static string ReadCreationTime(uint processId)
    {
        IntPtr processHandle = OpenProcess(
            ProcessQueryLimitedInformation,
            false,
            processId
        );
        if (processHandle == IntPtr.Zero)
        {
            return null;
        }

        try
        {
            FileTime creationTime;
            FileTime exitTime;
            FileTime kernelTime;
            FileTime userTime;
            if (!GetProcessTimes(
                processHandle,
                out creationTime,
                out exitTime,
                out kernelTime,
                out userTime
            ))
            {
                return null;
            }
            return DateTime.FromFileTimeUtc(creationTime.ToInt64())
                .ToString("o", CultureInfo.InvariantCulture);
        }
        finally
        {
            CloseHandle(processHandle);
        }
    }

    public static int TerminateExact(uint processId, long expectedCreationFileTime)
    {
        IntPtr processHandle = OpenProcess(
            ProcessTerminate | ProcessQueryLimitedInformation,
            false,
            processId
        );
        if (processHandle == IntPtr.Zero)
        {
            return 3;
        }

        try
        {
            FileTime creationTime;
            FileTime exitTime;
            FileTime kernelTime;
            FileTime userTime;
            if (!GetProcessTimes(
                processHandle,
                out creationTime,
                out exitTime,
                out kernelTime,
                out userTime
            ))
            {
                return 4;
            }
            if (creationTime.ToInt64() != expectedCreationFileTime)
            {
                return 3;
            }
            return TerminateProcess(processHandle, 1) ? 0 : 4;
        }
        finally
        {
            CloseHandle(processHandle);
        }
    }
}
`;

/**
 * Build an injectable native inventory boundary. WMI supplies parent and
 * command-line metadata, while creation identity comes from GetProcessTimes so
 * it has the same 100-nanosecond precision used by force termination.
 *
 * @param {typeof execFile} [execute]
 */
export const createNativeWindowsProcessInventory = (execute = execFile) => ({
  listProcesses: () => listNativeWindowsProcesses(execute),
  /** @param {number} processId */
  readProcessIdentity: (processId) =>
    readNativeWindowsProcessIdentity(processId, execute),
});

/**
 * Build the native Windows force-termination boundary. Creation identity and
 * termination are both checked through one retained kernel handle: if the PID
 * was reused before OpenProcess, GetProcessTimes rejects the replacement; if
 * the original exits afterward, the handle cannot retarget the replacement.
 *
 * @param {typeof execFile} [execute]
 */
export const createNativeWindowsProcessTerminator = (execute = execFile) =>
  /** @param {{processId: number, creationTime: string}} processIdentity */
  (processIdentity) => new Promise((resolve) => {
    const expectedCreationFileTime = normalizeWindowsCreationTime(
      processIdentity.creationTime,
    )?.fileTime;
    if (
      !Number.isSafeInteger(processIdentity.processId)
      || processIdentity.processId <= 0
      || processIdentity.processId > 0xffff_ffff
      || expectedCreationFileTime === undefined
    ) {
      resolve(false);
      return;
    }
    const command = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${exactWindowsProcessSource}
'@
exit [SandKingExactProcess]::TerminateExact([uint32]${processIdentity.processId}, [int64]${expectedCreationFileTime})`;
    execute("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ], {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 65_536,
    }, (error) => resolve(error === null));
  });

const terminateNativeWindowsProcessTree = createNativeWindowsProcessTerminator();

/** @param {unknown} value */
const normalizeProcess = (value) => {
  if (!value || typeof value !== "object") return null;
  const process = /** @type {Record<string, unknown>} */ (value);
  const processId = Number(process.processId);
  const parentProcessId = Number(process.parentProcessId);
  const normalizedCreationTime = normalizeWindowsCreationTime(process.creationTime);
  if (
    !Number.isSafeInteger(processId)
    || processId <= 0
    || !Number.isSafeInteger(parentProcessId)
    || parentProcessId < 0
    || normalizedCreationTime === null
  ) {
    return null;
  }
  return {
    processId,
    parentProcessId,
    creationTime: normalizedCreationTime.creationTime,
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
          && creationTimeIsNoLaterThan(parent.creationTime, process.creationTime)
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
      const possibleTrackedParent = [...trackedIdentities.values()].find((identity) =>
        identity.processId === process.parentProcessId
        && creationTimeIsNoLaterThan(identity.creationTime, process.creationTime));
      if (!possibleTrackedParent) continue;
      const currentParent = currentByPid.get(process.parentProcessId);
      if (
        currentParent
        && identityKey(currentParent) !== identityKey(possibleTrackedParent)
        && creationTimeIsNoLaterThan(currentParent.creationTime, process.creationTime)
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
