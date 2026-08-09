import { execFile, spawn } from "node:child_process";
import { prepareHostLossTerminationEvidence } from "./host-loss-termination-evidence.mjs";

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
@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name='CimCreationTime';Expression={if ($null -eq $_.CreationDate) { $null } else { $_.CreationDate.ToUniversalTime().ToString('o') }}},@{Name='CreationTime';Expression={[SandKingExactProcess]::ReadCreationTime([uint32]$_.ProcessId)}}) | ConvertTo-Json -Compress`;
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
      const inventory = rows.map((row) => {
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
      });
      if (inventory.some((row) => !Number.isSafeInteger(row.processId)
        || row.processId < 0
        || !Number.isSafeInteger(row.parentProcessId)
        || row.parentProcessId < 0)) {
        reject(new Error("windows_process_inventory_invalid"));
        return;
      }
      const queryableInventory = inventory.filter((row) => row.processId !== 0);
      // A CIM row proves that a PID is still present even when OpenProcess or
      // GetProcessTimes cannot establish its exact creation identity. Preserve
      // that row so the tracker cannot mistake unreadability for termination.
      // PID 0 is the documented System Idle Process pseudo-entry and cannot be
      // opened or participate in a supervised adapter ancestry, so omit it.
      resolve(queryableInventory);
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

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicAccountingInformation
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenJobObject(
        uint desiredAccess,
        bool inheritHandle,
        string name
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(
        IntPtr jobHandle,
        IntPtr processHandle
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr jobHandle,
        int informationClass,
        out BasicAccountingInformation information,
        uint informationLength,
        IntPtr returnLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr jobHandle,
        int informationClass,
        ref ExtendedLimitInformation information,
        uint informationLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr jobHandle, uint exitCode);

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

    public static int AssignExactToJob(
        uint processId,
        long expectedCreationFileTime,
        string jobName
    )
    {
        IntPtr jobHandle = CreateJobObject(IntPtr.Zero, jobName);
        if (jobHandle == IntPtr.Zero) return 4;
        if (Marshal.GetLastWin32Error() == 183)
        {
            CloseHandle(jobHandle);
            return 4;
        }
        IntPtr processHandle = OpenProcess(
            ProcessTerminate | ProcessQueryLimitedInformation | 0x0100,
            false,
            processId
        );
        if (processHandle == IntPtr.Zero)
        {
            CloseHandle(jobHandle);
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
            )) return 4;
            if (creationTime.ToInt64() != expectedCreationFileTime) return 3;
            return AssignProcessToJobObject(jobHandle, processHandle) ? 0 : 4;
        }
        finally
        {
            CloseHandle(processHandle);
            CloseHandle(jobHandle);
        }
    }

    public static IntPtr CreateOwnedJob(string jobName)
    {
        IntPtr jobHandle = CreateJobObject(IntPtr.Zero, jobName);
        if (jobHandle == IntPtr.Zero) return IntPtr.Zero;
        if (Marshal.GetLastWin32Error() == 183)
        {
            CloseHandle(jobHandle);
            return IntPtr.Zero;
        }
        ExtendedLimitInformation information = new ExtendedLimitInformation();
        information.BasicLimitInformation.LimitFlags = 0x00002000;
        if (!SetInformationJobObject(
            jobHandle,
            9,
            ref information,
            (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation))
        ))
        {
            CloseHandle(jobHandle);
            return IntPtr.Zero;
        }
        return jobHandle;
    }

    public static int AssignExactToOwnedJob(
        IntPtr jobHandle,
        uint processId,
        long expectedCreationFileTime
    )
    {
        if (jobHandle == IntPtr.Zero) return 4;
        IntPtr processHandle = OpenProcess(
            ProcessTerminate | ProcessQueryLimitedInformation | 0x0100,
            false,
            processId
        );
        if (processHandle == IntPtr.Zero) return 3;
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
            )) return 4;
            if (creationTime.ToInt64() != expectedCreationFileTime) return 3;
            return AssignProcessToJobObject(jobHandle, processHandle) ? 0 : 4;
        }
        finally
        {
            CloseHandle(processHandle);
        }
    }

    public static long ActiveOwnedProcessCount(IntPtr jobHandle)
    {
        if (jobHandle == IntPtr.Zero) return -1;
        BasicAccountingInformation information;
        if (!QueryInformationJobObject(
            jobHandle,
            1,
            out information,
            (uint)Marshal.SizeOf(typeof(BasicAccountingInformation)),
            IntPtr.Zero
        )) return -1;
        return information.ActiveProcesses;
    }

    public static int TerminateOwnedJob(IntPtr jobHandle)
    {
        if (jobHandle == IntPtr.Zero) return 4;
        return TerminateJobObject(jobHandle, 1) ? 0 : 4;
    }

    public static void CloseOwnedJob(IntPtr jobHandle)
    {
        if (jobHandle != IntPtr.Zero) CloseHandle(jobHandle);
    }

    public static long ActiveProcessCount(string jobName)
    {
        IntPtr jobHandle = OpenJobObject(0x0004, false, jobName);
        if (jobHandle == IntPtr.Zero)
        {
            return Marshal.GetLastWin32Error() == 2 ? 0 : -1;
        }
        try
        {
            BasicAccountingInformation information;
            if (!QueryInformationJobObject(
                jobHandle,
                1,
                out information,
                (uint)Marshal.SizeOf(typeof(BasicAccountingInformation)),
                IntPtr.Zero
            )) return -1;
            return information.ActiveProcesses;
        }
        finally
        {
            CloseHandle(jobHandle);
        }
    }

    public static int Terminate(string jobName)
    {
        IntPtr jobHandle = OpenJobObject(0x0008, false, jobName);
        if (jobHandle == IntPtr.Zero)
        {
            return Marshal.GetLastWin32Error() == 2 ? 3 : 4;
        }
        try
        {
            return TerminateJobObject(jobHandle, 1) ? 0 : 4;
        }
        finally
        {
            CloseHandle(jobHandle);
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

/**
 * Create a named, non-breakaway Windows Job Object controller. The adapter is
 * assigned through a creation-time-checked process handle before its pinned
 * entry point is released; Windows then associates every descendant with the
 * same job even after intermediate creators exit.
 *
 * @param {{name: string, execute?: typeof execFile, hostLossTerminationEvidencePath?: string, launchBarrierMarkerPath?: string}} options
 */
export const createNativeWindowsJobObject = (options) => {
  if (!/^Local\\SandKingHarnessRun-[A-Za-z0-9-]{1,96}$/.test(options.name)) {
    throw new Error("windows_job_object_name_invalid");
  }
  const escapedName = options.name.replaceAll("'", "''");
  const hasHostLossEvidence = typeof options.hostLossTerminationEvidencePath === "string"
    && options.hostLossTerminationEvidencePath.length > 0;
  const hasLaunchBarrier = typeof options.launchBarrierMarkerPath === "string"
    && options.launchBarrierMarkerPath.length > 0;
  if (hasHostLossEvidence !== hasLaunchBarrier) {
    throw new Error("windows_job_object_host_loss_configuration_invalid");
  }
  if (hasHostLossEvidence) {
    prepareHostLossTerminationEvidence(
      /** @type {string} */ (options.hostLossTerminationEvidencePath),
    );
  }
  if (options.execute) {
    const execute = options.execute;
    /** @param {string} invocation @param {(error: any, stdout: string) => unknown} consume */
    const invoke = (invocation, consume) => new Promise((resolve) => {
      const command = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${exactWindowsProcessSource}
'@
${invocation}`;
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
      }, (error, stdout) => resolve(consume(error, stdout)));
    });
    return {
      name: options.name,
      /** @param {{processId: number, creationTime: string}} identity */
      assignProcess: (identity) => {
        const expectedCreationFileTime = normalizeWindowsCreationTime(
          identity.creationTime,
        )?.fileTime;
        if (
          !Number.isSafeInteger(identity.processId)
          || identity.processId <= 0
          || identity.processId > 0xffff_ffff
          || expectedCreationFileTime === undefined
        ) {
          return Promise.resolve(false);
        }
        return invoke(
          `exit [SandKingExactProcess]::AssignExactToJob([uint32]${identity.processId}, [int64]${expectedCreationFileTime}, '${escapedName}')`,
          (error) => error === null,
        );
      },
      activeProcessCount: () => invoke(
        `$count = [SandKingExactProcess]::ActiveProcessCount('${escapedName}')
if ($count -lt 0) { exit 4 }
Write-Output $count`,
        (error, stdout) => {
          if (error) return null;
          const count = Number(stdout.trim());
          return Number.isSafeInteger(count) && count >= 0 ? count : null;
        },
      ),
      terminate: () => invoke(
        `exit [SandKingExactProcess]::Terminate('${escapedName}')`,
        (error) => error === null,
      ),
      close: async () => undefined,
    };
  }

  const escapedEvidencePath = (options.hostLossTerminationEvidencePath ?? "")
    .replaceAll("'", "''");
  const escapedBarrierPath = (options.launchBarrierMarkerPath ?? "")
    .replaceAll("'", "''");
  const brokerCommand = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${exactWindowsProcessSource}
'@
$hostLossEvidencePath = '${escapedEvidencePath}'
$launchBarrierMarkerPath = '${escapedBarrierPath}'
function Publish-HostLossTerminationEvidence {
  param([string]$EvidencePath)
  if ([string]::IsNullOrEmpty($EvidencePath) -or -not [IO.File]::Exists($EvidencePath)) {
    return
  }
  $payload = @{
    schemaVersion = 2
    platform = 'win32'
    status = 'termination_confirmed'
    terminationScope = 'complete_process_tree'
    launchSettled = $true
    treeEmpty = $true
    terminationBoundary = 'job_active_processes_zero'
    observedAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json -Compress
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes("$payload\`n")
  $stream = [IO.FileStream]::new(
    $EvidencePath,
    [IO.FileMode]::Truncate,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None,
    4096,
    [IO.FileOptions]::WriteThrough
  )
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
}
$jobHandle = [SandKingExactProcess]::CreateOwnedJob('${escapedName}')
if ($jobHandle -eq [IntPtr]::Zero) { exit 4 }
$hostLossDetected = $true
try {
  [Console]::Out.WriteLine('{"type":"ready"}')
  while (($line = [Console]::In.ReadLine()) -ne $null) {
    $request = $line | ConvertFrom-Json
    $closing = $false
    if ($request.operation -eq 'assign') {
      $result = [SandKingExactProcess]::AssignExactToOwnedJob(
        $jobHandle,
        [uint32]$request.processId,
        [int64]$request.expectedCreationFileTime
      ) -eq 0
    } elseif ($request.operation -eq 'count') {
      $result = [SandKingExactProcess]::ActiveOwnedProcessCount($jobHandle)
    } elseif ($request.operation -eq 'terminate') {
      $result = [SandKingExactProcess]::TerminateOwnedJob($jobHandle) -eq 0
    } elseif ($request.operation -eq 'close') {
      $result = $true
      $closing = $true
      $hostLossDetected = $false
    } else {
      $result = $null
    }
    [Console]::Out.WriteLine((@{ id = $request.id; result = $result } | ConvertTo-Json -Compress))
    if ($closing) { break }
  }
} finally {
  if ($hostLossDetected
      -and -not [string]::IsNullOrEmpty($hostLossEvidencePath)
      -and [IO.File]::Exists($launchBarrierMarkerPath)
      -and [IO.File]::ReadAllText($launchBarrierMarkerPath) -eq "assigned\`n") {
    [void][SandKingExactProcess]::TerminateOwnedJob($jobHandle)
    $terminationDeadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
      $activeProcessCount = [SandKingExactProcess]::ActiveOwnedProcessCount($jobHandle)
      if ($activeProcessCount -eq 0) { break }
      Start-Sleep -Milliseconds 10
    } while ([DateTime]::UtcNow -lt $terminationDeadline)
    if ($activeProcessCount -eq 0) {
      Publish-HostLossTerminationEvidence $hostLossEvidencePath
    }
  }
  [SandKingExactProcess]::CloseOwnedJob($jobHandle)
}`;
  const broker = spawn("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    brokerCommand,
  ], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  let brokerReady = false;
  let brokerFailed = false;
  /** @type {(value: boolean) => void} */
  let resolveReady = () => {};
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  /** @type {() => void} */
  let resolveClosed = () => {};
  const closed = new Promise((resolve) => { resolveClosed = () => resolve(undefined); });
  let nextRequestId = 1;
  /** @type {Map<number, {resolve: (value: any) => void, fallback: any, timer: ReturnType<typeof setTimeout>}>} */
  const pending = new Map();
  let output = "";
  broker.stdout?.setEncoding("utf8");
  broker.stdout?.on("data", (chunk) => {
    output += chunk;
    while (output.includes("\n")) {
      const newline = output.indexOf("\n");
      const line = output.slice(0, newline).trim();
      output = output.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        brokerFailed = true;
        resolveReady(false);
        continue;
      }
      if (message.type === "ready") {
        brokerReady = true;
        resolveReady(true);
        continue;
      }
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      clearTimeout(request.timer);
      request.resolve(message.result);
    }
  });
  const failBroker = () => {
    brokerFailed = true;
    resolveReady(false);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.resolve(request.fallback);
    }
    pending.clear();
  };
  broker.once("error", failBroker);
  broker.once("close", () => {
    failBroker();
    resolveClosed();
  });

  /** @param {string} operation @param {Record<string, unknown>} payload @param {any} fallback */
  const invoke = async (operation, payload, fallback) => {
    if (!(await ready) || !brokerReady || brokerFailed || !broker.stdin) return fallback;
    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const request = pending.get(id);
        pending.delete(id);
        request?.resolve(fallback);
      }, 5_000);
      timer.unref();
      pending.set(id, { resolve, fallback, timer });
      broker.stdin.write(`${JSON.stringify({ id, operation, ...payload })}\n`, (error) => {
        if (!error) return;
        const request = pending.get(id);
        pending.delete(id);
        clearTimeout(request?.timer);
        request?.resolve(fallback);
      });
    });
  };
  /** @type {Promise<void> | null} */
  let closeOperation = null;
  return {
    name: options.name,
    /** @param {{processId: number, creationTime: string}} identity */
    assignProcess: (identity) => {
      const expectedCreationFileTime = normalizeWindowsCreationTime(
        identity.creationTime,
      )?.fileTime;
      if (
        !Number.isSafeInteger(identity.processId)
        || identity.processId <= 0
        || identity.processId > 0xffff_ffff
        || expectedCreationFileTime === undefined
      ) {
        return Promise.resolve(false);
      }
      return invoke("assign", {
        processId: identity.processId,
        expectedCreationFileTime: String(expectedCreationFileTime),
      }, false).then((result) => result === true);
    },
    activeProcessCount: () => invoke("count", {}, null).then((result) =>
      Number.isSafeInteger(result) && result >= 0 ? result : null),
    terminate: () => invoke("terminate", {}, false).then((result) => result === true),
    close: () => {
      if (closeOperation) return closeOperation;
      closeOperation = (async () => {
        await invoke("close", {}, false);
        broker.stdin?.end();
        await closed;
      })();
      return closeOperation;
    },
  };
};

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

/** @param {unknown} value */
const normalizeProcessInventoryEntry = (value) => {
  const process = normalizeProcess(value);
  if (process) return process;
  if (!value || typeof value !== "object") return null;
  const candidate = /** @type {Record<string, unknown>} */ (value);
  const processId = Number(candidate.processId);
  const parentProcessId = Number(candidate.parentProcessId);
  if (
    candidate.creationTime !== null
    || !Number.isSafeInteger(processId)
    || processId <= 0
    || !Number.isSafeInteger(parentProcessId)
    || parentProcessId < 0
  ) {
    return null;
  }
  return { processId, parentProcessId, creationTime: null };
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
 *   listProcesses?: () => Promise<Array<{processId: number, parentProcessId: number, creationTime: string | null}>>,
 *   jobObject?: {name: string, assignProcess: (identity: {processId: number, creationTime: string}) => Promise<boolean>, activeProcessCount: () => Promise<number | null>, terminate: () => Promise<boolean>, close?: () => Promise<void>},
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
  const rootIdentity = {
    processId: normalizedRoot.processId,
    creationTime: normalizedRoot.creationTime,
  };
  if (options.jobObject) {
    if (!(await options.jobObject.assignProcess(rootIdentity))) return null;
    return {
      rootIdentity,
      initialProcesses: [],
      jobObject: options.jobObject,
    };
  }
  /** @type {Array<{processId: number, parentProcessId: number, creationTime: string | null}>} */
  let listedProcesses;
  try {
    listedProcesses = await (options.listProcesses ?? listNativeWindowsProcesses)();
  } catch {
    return null;
  }
  const processes = listedProcesses.map(normalizeProcessInventoryEntry);
  if (
    processes.some((process) => process === null)
    || new Set(processes.map((process) => process?.processId)).size !== processes.length
  ) {
    return null;
  }
  const initialProcesses = /** @type {Array<NonNullable<ReturnType<typeof normalizeProcessInventoryEntry>>>} */ (
    processes
  );
  return {
    rootIdentity,
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
 *   initialProcesses?: Array<{processId: number, parentProcessId: number, creationTime: string | null}>,
 *   listProcesses?: () => Promise<Array<{processId: number, parentProcessId: number, creationTime: string}>>,
 *   terminateProcessTree?: (processIdentity: {processId: number, creationTime: string}) => Promise<boolean>,
 *   jobObject?: {name: string, activeProcessCount: () => Promise<number | null>, terminate: () => Promise<boolean>, close?: () => Promise<void>},
 * }} options
 */
export const createWindowsProcessTreeTracker = (options) => {
  const normalizedRoot = options.rootIdentity === null
    ? null
    : normalizeProcess({ ...options.rootIdentity, parentProcessId: 0 });
  if (options.rootIdentity !== null && normalizedRoot === null) {
    throw new Error("windows_process_tree_root_invalid");
  }
  if (options.jobObject) {
    const jobObject = options.jobObject;
    let jobReliable = normalizedRoot !== null;
    /** @type {number | null} */
    let lastActiveProcessCount = null;
    const refreshJob = async () => {
      if (!jobReliable) return false;
      const activeProcessCount = await jobObject.activeProcessCount();
      if (activeProcessCount === null
        || !Number.isSafeInteger(activeProcessCount) || activeProcessCount < 0) {
        jobReliable = false;
        return false;
      }
      lastActiveProcessCount = activeProcessCount;
      return true;
    };
    return {
      prepareCancellation: refreshJob,
      processTreeAlive: async () =>
        !(await refreshJob()) || (lastActiveProcessCount ?? 1) > 0,
      forceTerminate: async () => {
        if (!(await refreshJob()) || lastActiveProcessCount === 0) return false;
        // TerminateJobObject dispatches against the retained job identity. The
        // caller records that attempt separately and confirms ActiveProcesses
        // reaches zero through processTreeAlive before committing cancelled.
        return jobObject.terminate();
      },
    };
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

  /** @param {Array<{processId: number, parentProcessId: number, creationTime: string | null}>} listedProcesses */
  const applyInventory = (listedProcesses) => {
    const processes = listedProcesses.map(normalizeProcessInventoryEntry);
    if (
      processes.some((process) => process === null)
      || new Set(processes.map((process) => process?.processId)).size !== processes.length
    ) {
      trackingReliable = false;
      return false;
    }
    const normalizedInventory = /** @type {Array<NonNullable<ReturnType<typeof normalizeProcessInventoryEntry>>>} */ (
      processes
    );
    const normalizedProcesses = /** @type {Array<NonNullable<ReturnType<typeof normalizeProcess>>>} */ (
      normalizedInventory.filter((process) => process.creationTime !== null)
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
    if (normalizedRoot && normalizedProcesses.some((process) =>
      process.processId !== normalizedRoot.processId
      && process.parentProcessId !== 0
      && !currentByPid.has(process.parentProcessId)
      && !trackedIdentities.has(identityKey(process))
      && creationTimeIsNoLaterThan(
        normalizedRoot.creationTime,
        process.creationTime,
      ))) {
      // A live process created after the supervised root whose creator is
      // already absent may sit behind a short-lived, never-sampled intermediate.
      // Sampled ancestry cannot prove either ownership or non-ownership, so a
      // legacy inventory tracker must never report the tree terminated.
      trackingReliable = false;
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
    const possiblySupervisedPids = new Set(
      [...trackedIdentities.values()].map((identity) => identity.processId),
    );
    let possibleDescendantDiscovered = true;
    while (possibleDescendantDiscovered) {
      possibleDescendantDiscovered = false;
      for (const process of normalizedInventory) {
        if (
          !possiblySupervisedPids.has(process.processId)
          && possiblySupervisedPids.has(process.parentProcessId)
        ) {
          possiblySupervisedPids.add(process.processId);
          possibleDescendantDiscovered = true;
        }
      }
    }
    if (normalizedInventory.some((process) =>
      process.creationTime === null && possiblySupervisedPids.has(process.processId))) {
      trackingReliable = false;
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

  /** @type {Promise<boolean> | null} */
  let refreshOperation = null;
  const refresh = () => {
    if (refreshOperation) return refreshOperation;
    refreshOperation = (async () => {
      /** @type {Array<{processId: number, parentProcessId: number, creationTime: string | null}>} */
      let listedProcesses;
      try {
        listedProcesses = await listProcesses();
      } catch {
        trackingReliable = false;
        return false;
      }
      return applyInventory(listedProcesses) && trackingReliable;
    })();
    void refreshOperation.then(() => {
      refreshOperation = null;
    }, () => {
      refreshOperation = null;
    });
    return refreshOperation;
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
          return false;
        }
        const sent = await terminateProcessTree({
          processId: identity.processId,
          creationTime: identity.creationTime,
        });
        signalSent = sent || signalSent;
        if (!(await refresh())) return false;
        if (!sent && aliveIdentities.has(identityKey(identity))) {
          trackingReliable = false;
          return false;
        }
      }
      if (aliveIdentities.size > 0) {
        trackingReliable = false;
      }
      return trackingReliable && aliveIdentities.size === 0 && signalSent;
    },
  };
};
