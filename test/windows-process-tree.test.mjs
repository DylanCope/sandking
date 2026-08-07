import assert from "node:assert/strict";
import test from "node:test";
import { createWindowsProcessTreeTracker } from "../src/windows-process-tree.mjs";

test("Windows cancellation retains descendants after the adapter exits and confirms the whole tree", async () => {
  let processes = [
    { processId: 100, parentProcessId: 10 },
    { processId: 200, parentProcessId: 100 },
    { processId: 300, parentProcessId: 200 },
  ];
  const terminated = [];
  const tracker = createWindowsProcessTreeTracker({
    rootPid: 100,
    listProcesses: async () => processes,
    terminateProcessTree: async (processId) => {
      terminated.push(processId);
      const terminatedIds = processId === 200 ? new Set([200, 300]) : new Set([processId]);
      processes = processes.filter((process) => !terminatedIds.has(process.processId));
      return true;
    },
  });

  assert.equal(await tracker.prepareCancellation(), true);
  processes = [
    { processId: 200, parentProcessId: 10 },
    { processId: 300, parentProcessId: 200 },
  ];
  assert.equal(await tracker.processTreeAlive(), true);
  assert.equal(await tracker.forceTerminate(), true);
  assert.deepEqual(terminated, [200, 300]);
  assert.equal(await tracker.processTreeAlive(), false);
});

test("Windows cancellation never confirms termination after descendant tracking is uncertain", async () => {
  const tracker = createWindowsProcessTreeTracker({
    rootPid: 400,
    listProcesses: async () => {
      throw new Error("windows_process_inventory_unavailable");
    },
    terminateProcessTree: async () => true,
  });

  assert.equal(await tracker.prepareCancellation(), false);
  assert.equal(await tracker.forceTerminate(), true);
  assert.equal(await tracker.processTreeAlive(), true);
});

test("Windows cancellation preserves uncertainty when its first inventory follows root exit", async () => {
  const terminated = [];
  const tracker = createWindowsProcessTreeTracker({
    rootPid: 500,
    listProcesses: async () => [
      { processId: 600, parentProcessId: 10 },
    ],
    terminateProcessTree: async (processId) => {
      terminated.push(processId);
      return true;
    },
  });

  assert.equal(await tracker.prepareCancellation(), false);
  assert.equal(await tracker.forceTerminate(), false);
  assert.deepEqual(terminated, []);
  assert.equal(await tracker.processTreeAlive(), true);
});
