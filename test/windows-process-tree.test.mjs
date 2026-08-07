import assert from "node:assert/strict";
import test from "node:test";
import {
  captureWindowsProcessTreeSnapshot,
  createNativeWindowsProcessInventory,
  createNativeWindowsProcessTerminator,
  createWindowsProcessTreeTracker,
} from "../src/windows-process-tree.mjs";

test("Windows force termination preserves native creation ticks across process inventory", async () => {
  const cimCreationTime = "2026-08-07T10:00:00.0001000Z";
  const creationTime = "2026-08-07T10:00:00.0001001Z";
  const expectedCreationFileTime = BigInt(Date.parse("2026-08-07T10:00:00.000Z"))
    * 10_000n + 116_444_736_000_000_000n + 1_001n;
  const commands = [];
  let processAlive = true;
  let terminationAttempts = 0;
  const execute = (file, args, options, callback) => {
    const command = args.at(-1);
    commands.push(command);
    if (command.includes("::TerminateExact")) {
      terminationAttempts += 1;
      if (command.includes(`[int64]${expectedCreationFileTime}`)) {
        processAlive = false;
        callback(null, "", "");
      } else {
        callback(new Error("windows_process_creation_time_mismatch"), "", "");
      }
      return;
    }
    if (command.includes("ProcessId,CommandLine")) {
      callback(null, JSON.stringify({
        ProcessId: 42,
        CommandLine: "node adapter.mjs harness-run-original",
        CimCreationTime: cimCreationTime,
        CreationTime: creationTime,
      }), "");
      return;
    }
    callback(null, JSON.stringify(processAlive ? [{
      ProcessId: 42,
      ParentProcessId: 1,
      CimCreationTime: cimCreationTime,
      CreationTime: creationTime,
    }] : []), "");
  };
  const inventory = createNativeWindowsProcessInventory(execute);
  const snapshot = await captureWindowsProcessTreeSnapshot(42, {
    expectedCommandLineFragment: "harness-run-original",
    ...inventory,
  });
  assert.ok(snapshot);
  const tracker = createWindowsProcessTreeTracker({
    ...snapshot,
    listProcesses: inventory.listProcesses,
    terminateProcessTree: createNativeWindowsProcessTerminator(execute),
  });

  assert.equal(await tracker.prepareCancellation(), true);
  assert.equal(await tracker.forceTerminate(), true);
  assert.equal(terminationAttempts, 1);
  assert.equal(await tracker.processTreeAlive(), false);
  assert.ok(commands.filter((command) => command.includes("Get-CimInstance"))
    .every((command) => command.includes("GetProcessTimes")
      && command.includes("CimCreationTime")));

  const mismatchedInventory = createNativeWindowsProcessInventory(
    (file, args, options, callback) => {
      const command = args.at(-1);
      const identity = {
        ProcessId: 42,
        CommandLine: "node adapter.mjs harness-run-original",
        CimCreationTime: cimCreationTime,
        CreationTime: "2026-08-07T11:00:00.0001001Z",
      };
      callback(null, JSON.stringify(command.includes("ProcessId,CommandLine")
        ? identity
        : [{ ...identity, ParentProcessId: 1 }]), "");
    },
  );
  await assert.rejects(
    mismatchedInventory.readProcessIdentity(42),
    /windows_process_creation_time_invalid/,
  );
  assert.deepEqual(await mismatchedInventory.listProcesses(), [{
    processId: 42,
    parentProcessId: 1,
    creationTime: null,
  }]);
});

test("native Windows launch identity tolerates ordinary unreadable system inventory rows", async () => {
  const rootCreationTime = "2026-08-07T10:00:00.0001000Z";
  const inventory = createNativeWindowsProcessInventory(
    (file, args, options, callback) => {
      const command = args.at(-1);
      if (command.includes("ProcessId,CommandLine")) {
        callback(null, JSON.stringify({
          ProcessId: 100,
          CommandLine: "node adapter.mjs harness-run-original",
          CimCreationTime: rootCreationTime,
          CreationTime: rootCreationTime,
        }), "");
        return;
      }
      callback(null, JSON.stringify([
        {
          ProcessId: 0,
          ParentProcessId: 0,
          CimCreationTime: null,
          CreationTime: null,
        },
        {
          ProcessId: 4,
          ParentProcessId: 0,
          CimCreationTime: "2026-08-07T09:00:00.0000000Z",
          CreationTime: null,
        },
        {
          ProcessId: 100,
          ParentProcessId: 10,
          CimCreationTime: rootCreationTime,
          CreationTime: rootCreationTime,
        },
      ]), "");
    },
  );

  assert.deepEqual(await inventory.listProcesses(), [
    { processId: 4, parentProcessId: 0, creationTime: null },
    { processId: 100, parentProcessId: 10, creationTime: rootCreationTime },
  ]);
  const snapshot = await captureWindowsProcessTreeSnapshot(100, {
    expectedCommandLineFragment: "harness-run-original",
    ...inventory,
  });
  assert.ok(snapshot);
  const tracker = createWindowsProcessTreeTracker({
    ...snapshot,
    listProcesses: inventory.listProcesses,
    terminateProcessTree: async () => true,
  });
  assert.equal(await tracker.prepareCancellation(), true);
});

test("native Windows inventory cannot confirm an unreadable tracked descendant exited", async () => {
  const rootCreationTime = "2026-08-07T10:00:00.0001000Z";
  const childCreationTime = "2026-08-07T10:00:01.0001000Z";
  let childIdentityReadable = true;
  const inventory = createNativeWindowsProcessInventory(
    (file, args, options, callback) => {
      const command = args.at(-1);
      if (command.includes("ProcessId,CommandLine")) {
        callback(null, JSON.stringify({
          ProcessId: 100,
          CommandLine: "node adapter.mjs harness-run-original",
          CimCreationTime: rootCreationTime,
          CreationTime: rootCreationTime,
        }), "");
        return;
      }
      callback(null, JSON.stringify([
        {
          ProcessId: 100,
          ParentProcessId: 10,
          CimCreationTime: rootCreationTime,
          CreationTime: rootCreationTime,
        },
        {
          ProcessId: 200,
          ParentProcessId: 100,
          CimCreationTime: childCreationTime,
          CreationTime: childIdentityReadable ? childCreationTime : null,
        },
      ]), "");
    },
  );
  const snapshot = await captureWindowsProcessTreeSnapshot(100, {
    expectedCommandLineFragment: "harness-run-original",
    ...inventory,
  });
  assert.ok(snapshot);
  const tracker = createWindowsProcessTreeTracker({
    ...snapshot,
    listProcesses: inventory.listProcesses,
    terminateProcessTree: async () => true,
  });
  assert.equal(await tracker.prepareCancellation(), true);

  childIdentityReadable = false;
  assert.deepEqual(await inventory.listProcesses(), [
    {
      processId: 100,
      parentProcessId: 10,
      creationTime: rootCreationTime,
    },
    {
      processId: 200,
      parentProcessId: 100,
      creationTime: null,
    },
  ]);
  assert.equal(await tracker.processTreeAlive(), true);
});

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

test("Windows force termination reports failure when any retained descendant survives", async () => {
  let processes = [
    { processId: 100, parentProcessId: 10, creationTime: "2026-08-07T10:00:00.000Z" },
    { processId: 200, parentProcessId: 100, creationTime: "2026-08-07T10:00:01.000Z" },
    { processId: 300, parentProcessId: 100, creationTime: "2026-08-07T10:00:02.000Z" },
  ];
  const terminated = [];
  const tracker = createWindowsProcessTreeTracker({
    rootIdentity: {
      processId: 100,
      creationTime: "2026-08-07T10:00:00.000Z",
    },
    initialProcesses: processes,
    listProcesses: async () => processes,
    terminateProcessTree: async (processIdentity) => {
      terminated.push(processIdentity.processId);
      if (processIdentity.processId === 200) return false;
      processes = processes.filter((process) =>
        process.processId !== processIdentity.processId);
      return true;
    },
  });
  assert.equal(await tracker.prepareCancellation(), true);
  processes = processes.filter((process) => process.processId !== 100)
    .map((process) => ({ ...process, parentProcessId: 10 }));

  assert.equal(await tracker.forceTerminate(), false);
  assert.deepEqual(terminated, [300, 200]);
  assert.deepEqual(processes.map((process) => process.processId), [200]);
  assert.equal(await tracker.processTreeAlive(), true);
});

test("Windows deadline escalation joins cancellation inventory already in flight", async () => {
  let processes = [
    { processId: 100, parentProcessId: 10, creationTime: "2026-08-07T10:00:00.000Z" },
  ];
  let inventoryCalls = 0;
  let releaseFirstInventory;
  let reportFirstInventory;
  const firstInventoryStarted = new Promise((resolve) => {
    reportFirstInventory = resolve;
  });
  const firstInventoryRelease = new Promise((resolve) => {
    releaseFirstInventory = resolve;
  });
  const tracker = createWindowsProcessTreeTracker({
    rootIdentity: {
      processId: 100,
      creationTime: "2026-08-07T10:00:00.000Z",
    },
    initialProcesses: processes,
    listProcesses: async () => {
      inventoryCalls += 1;
      if (inventoryCalls === 1) {
        reportFirstInventory?.();
        await firstInventoryRelease;
      }
      return processes;
    },
    terminateProcessTree: async (processIdentity) => {
      processes = processes.filter((process) =>
        process.processId !== processIdentity.processId);
      return true;
    },
  });

  const preparation = tracker.prepareCancellation();
  await firstInventoryStarted;
  const escalation = tracker.forceTerminate();
  assert.equal(inventoryCalls, 1);
  releaseFirstInventory?.();
  assert.equal(await preparation, true);
  assert.equal(await escalation, true);
  assert.equal(inventoryCalls, 2);
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
