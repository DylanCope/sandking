import assert from "node:assert/strict";
import test from "node:test";
import {
  captureWindowsProcessTreeSnapshot,
  createNativeWindowsProcessTerminator,
  createWindowsProcessTreeTracker,
} from "../src/windows-process-tree.mjs";

test("native Windows force termination checks and kills through one retained process handle", async () => {
  const invocations = [];
  const terminate = createNativeWindowsProcessTerminator((file, args, options, callback) => {
    invocations.push({ file, args, options });
    callback(null);
  });

  assert.equal(await terminate({
    processId: 42,
    creationTime: "2026-08-07T10:00:00.0001000Z",
  }), true);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].file, "powershell.exe");
  const command = invocations[0].args.at(-1);
  assert.match(command, /OpenProcess/);
  assert.match(command, /GetProcessTimes\(\s*processHandle,/);
  assert.match(command, /TerminateProcess\(processHandle,/);
  assert.match(command, /CloseHandle\(processHandle\)/);
  const expectedCreationFileTime = BigInt(Date.parse("2026-08-07T10:00:00.000Z"))
    * 10_000n + 116_444_736_000_000_000n + 1_000n;
  assert.ok(command.includes(`[int64]${expectedCreationFileTime}`));
  assert.doesNotMatch(command, /creationUnixMilliseconds|\/ 10000L/);
  assert.doesNotMatch(command, /Get-CimInstance|taskkill(?:\.exe)?/i);
});

test("Windows cancellation retains descendants after the adapter exits and confirms the whole tree", async () => {
  let processes = [
    { processId: 100, parentProcessId: 10, creationTime: "2026-08-07T10:00:00.000Z" },
    { processId: 200, parentProcessId: 100, creationTime: "2026-08-07T10:00:01.000Z" },
    { processId: 300, parentProcessId: 200, creationTime: "2026-08-07T10:00:02.000Z" },
  ];
  const terminated = [];
  const tracker = createWindowsProcessTreeTracker({
    rootIdentity: {
      processId: 100,
      creationTime: "2026-08-07T10:00:00.000Z",
    },
    listProcesses: async () => processes,
    terminateProcessTree: async (processIdentity) => {
      terminated.push(processIdentity.processId);
      processes = processes.filter((process) =>
        process.processId !== processIdentity.processId);
      return true;
    },
  });

  assert.equal(await tracker.prepareCancellation(), true);
  processes = [
    { processId: 200, parentProcessId: 10, creationTime: "2026-08-07T10:00:01.000Z" },
    { processId: 300, parentProcessId: 200, creationTime: "2026-08-07T10:00:02.000Z" },
  ];
  assert.equal(await tracker.processTreeAlive(), true);
  assert.equal(await tracker.forceTerminate(), true);
  assert.deepEqual(terminated, [300, 200]);
  assert.equal(await tracker.processTreeAlive(), false);
});

test("Windows cancellation never confirms termination after descendant tracking is uncertain", async () => {
  let terminationAttempts = 0;
  const tracker = createWindowsProcessTreeTracker({
    rootIdentity: {
      processId: 400,
      creationTime: "2026-08-07T10:00:00.000Z",
    },
    listProcesses: async () => {
      throw new Error("windows_process_inventory_unavailable");
    },
    terminateProcessTree: async () => {
      terminationAttempts += 1;
      return true;
    },
  });

  assert.equal(await tracker.prepareCancellation(), false);
  assert.equal(await tracker.forceTerminate(), false);
  assert.equal(terminationAttempts, 0);
  assert.equal(await tracker.processTreeAlive(), true);
});

test("Windows cancellation preserves uncertainty when its first inventory follows root exit", async () => {
  const terminated = [];
  const tracker = createWindowsProcessTreeTracker({
    rootIdentity: {
      processId: 500,
      creationTime: "2026-08-07T10:00:00.000Z",
    },
    listProcesses: async () => [
      {
        processId: 600,
        parentProcessId: 10,
        creationTime: "2026-08-07T10:00:01.000Z",
      },
    ],
    terminateProcessTree: async (processIdentity) => {
      terminated.push(processIdentity.processId);
      return true;
    },
  });

  assert.equal(await tracker.prepareCancellation(), false);
  assert.equal(await tracker.forceTerminate(), false);
  assert.deepEqual(terminated, []);
  assert.equal(await tracker.processTreeAlive(), true);
});

test("Windows cancellation never targets a tracked PID after that PID is reused", async () => {
  let processes = [
    { processId: 700, parentProcessId: 10, creationTime: "2026-08-07T10:00:00.000Z" },
    { processId: 800, parentProcessId: 700, creationTime: "2026-08-07T10:00:01.000Z" },
  ];
  const terminated = [];
  const tracker = createWindowsProcessTreeTracker({
    rootIdentity: {
      processId: 700,
      creationTime: "2026-08-07T10:00:00.000Z",
    },
    listProcesses: async () => processes,
    terminateProcessTree: async (processIdentity) => {
      terminated.push(processIdentity);
      return true;
    },
  });

  assert.equal(await tracker.prepareCancellation(), true);
  processes = [
    { processId: 700, parentProcessId: 10, creationTime: "2026-08-07T11:00:00.000Z" },
    { processId: 800, parentProcessId: 700, creationTime: "2026-08-07T11:00:01.000Z" },
  ];
  assert.equal(await tracker.forceTerminate(), false);
  assert.deepEqual(terminated, []);
  assert.equal(await tracker.processTreeAlive(), false);
});

test("Windows cancellation distinguishes PID reuse within one millisecond", async () => {
  let processes = [
    { processId: 700, parentProcessId: 10, creationTime: "2026-08-07T10:00:00.0001000Z" },
  ];
  const terminated = [];
  const tracker = createWindowsProcessTreeTracker({
    rootIdentity: {
      processId: 700,
      creationTime: "2026-08-07T10:00:00.0001000Z",
    },
    listProcesses: async () => processes,
    terminateProcessTree: async (processIdentity) => {
      terminated.push(processIdentity);
      processes = processes.filter((process) =>
        process.processId !== processIdentity.processId);
      return true;
    },
  });

  assert.equal(await tracker.prepareCancellation(), true);
  processes = [
    { processId: 700, parentProcessId: 10, creationTime: "2026-08-07T10:00:00.0009000Z" },
  ];
  assert.equal(await tracker.forceTerminate(), false);
  assert.deepEqual(terminated, []);
  assert.equal(await tracker.processTreeAlive(), false);
});

test("Windows cancellation pins the adapter identity before a late cancellation observes PID reuse", async () => {
  let processes = [
    { processId: 700, parentProcessId: 10, creationTime: "2026-08-07T10:00:00.000Z" },
  ];
  const snapshot = await captureWindowsProcessTreeSnapshot(700, {
    expectedCommandLineFragment: "harness-run-original",
    readProcessIdentity: async () => ({
      processId: 700,
      creationTime: "2026-08-07T10:00:00.000Z",
      commandLine: "node adapter.mjs harness-run-original",
    }),
    listProcesses: async () => processes,
  });
  assert.ok(snapshot);
  processes = [
    { processId: 700, parentProcessId: 10, creationTime: "2026-08-07T11:00:00.000Z" },
    { processId: 800, parentProcessId: 700, creationTime: "2026-08-07T11:00:01.000Z" },
  ];
  const terminated = [];
  const tracker = createWindowsProcessTreeTracker({
    ...snapshot,
    listProcesses: async () => processes,
    terminateProcessTree: async (processIdentity) => {
      terminated.push(processIdentity);
      return true;
    },
  });

  assert.equal(await tracker.prepareCancellation(), true);
  assert.equal(await tracker.forceTerminate(), false);
  assert.deepEqual(terminated, []);
  assert.equal(await tracker.processTreeAlive(), false);
});

test("Windows cancellation does not capture a reused adapter PID as its launch identity", async () => {
  const replacement = {
    processId: 700,
    parentProcessId: 10,
    creationTime: "2026-08-07T11:00:00.000Z",
  };
  const snapshot = await captureWindowsProcessTreeSnapshot(700, {
    expectedCommandLineFragment: "harness-run-original",
    readProcessIdentity: async () => ({
      ...replacement,
      commandLine: "node unrelated-work.mjs",
    }),
    listProcesses: async () => [replacement],
  });

  assert.equal(snapshot, null);
  const terminated = [];
  const tracker = createWindowsProcessTreeTracker({
    rootIdentity: null,
    listProcesses: async () => [replacement],
    terminateProcessTree: async (processIdentity) => {
      terminated.push(processIdentity);
      return true;
    },
  });
  assert.equal(await tracker.prepareCancellation(), false);
  assert.equal(await tracker.forceTerminate(), false);
  assert.deepEqual(terminated, []);
  assert.equal(await tracker.processTreeAlive(), true);
});

test("Windows cancellation never confirms a child first observed after its tracked parent exits", async () => {
  let processes = [
    { processId: 100, parentProcessId: 10, creationTime: "2026-08-07T10:00:00.000Z" },
  ];
  const terminated = [];
  const tracker = createWindowsProcessTreeTracker({
    rootIdentity: {
      processId: 100,
      creationTime: "2026-08-07T10:00:00.000Z",
    },
    listProcesses: async () => processes,
    terminateProcessTree: async (processIdentity) => {
      terminated.push(processIdentity);
      return true;
    },
  });

  assert.equal(await tracker.prepareCancellation(), true);
  processes = [
    { processId: 200, parentProcessId: 100, creationTime: "2026-08-07T10:00:01.000Z" },
  ];
  assert.equal(await tracker.processTreeAlive(), true);
  assert.equal(await tracker.forceTerminate(), false);
  assert.deepEqual(terminated, []);
  assert.equal(await tracker.processTreeAlive(), true);
});

test("Windows cancellation rejects a stale parent PID whose replacement is newer than the child", async () => {
  let processes = [
    { processId: 900, parentProcessId: 10, creationTime: "2026-08-07T10:00:02.000Z" },
    { processId: 901, parentProcessId: 900, creationTime: "2026-08-07T10:00:01.000Z" },
  ];
  const terminated = [];
  const tracker = createWindowsProcessTreeTracker({
    rootIdentity: {
      processId: 900,
      creationTime: "2026-08-07T10:00:02.000Z",
    },
    listProcesses: async () => processes,
    terminateProcessTree: async (processIdentity) => {
      terminated.push(processIdentity.processId);
      processes = processes.filter((process) => process.processId !== processIdentity.processId);
      return true;
    },
  });

  assert.equal(await tracker.prepareCancellation(), true);
  assert.equal(await tracker.forceTerminate(), true);
  assert.deepEqual(terminated, [900]);
  assert.deepEqual(processes, [
    { processId: 901, parentProcessId: 900, creationTime: "2026-08-07T10:00:01.000Z" },
  ]);
  assert.equal(await tracker.processTreeAlive(), false);
});
