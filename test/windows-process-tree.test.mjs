import assert from "node:assert/strict";
import test from "node:test";
import { createWindowsProcessTreeTracker } from "../src/windows-process-tree.mjs";

test("Windows cancellation retains descendants after the adapter exits and confirms the whole tree", async () => {
  let processes = [
    { processId: 100, parentProcessId: 10, creationTime: "2026-08-07T10:00:00.000Z" },
    { processId: 200, parentProcessId: 100, creationTime: "2026-08-07T10:00:01.000Z" },
    { processId: 300, parentProcessId: 200, creationTime: "2026-08-07T10:00:02.000Z" },
  ];
  const terminated = [];
  const tracker = createWindowsProcessTreeTracker({
    rootPid: 100,
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
    rootPid: 400,
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
    rootPid: 500,
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
    rootPid: 700,
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

test("Windows cancellation rejects a stale parent PID whose replacement is newer than the child", async () => {
  let processes = [
    { processId: 900, parentProcessId: 10, creationTime: "2026-08-07T10:00:02.000Z" },
    { processId: 901, parentProcessId: 900, creationTime: "2026-08-07T10:00:01.000Z" },
  ];
  const terminated = [];
  const tracker = createWindowsProcessTreeTracker({
    rootPid: 900,
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
