import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  prepareHostLossTerminationEvidence,
  waitForHostLossTerminationEvidence,
} from "../src/host-loss-termination-evidence.mjs";
import {
  captureWindowsProcessTreeSnapshot,
  createNativeWindowsJobObject,
  createNativeWindowsProcessInventory,
  createNativeWindowsProcessTerminator,
  createWindowsProcessTreeTracker,
} from "../src/windows-process-tree.mjs";

test("the Windows adapter barrier blocks pinned code until Job Object assignment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandking-windows-barrier-test-"));
  const marker = join(directory, "assigned");
  const child = spawn(process.execPath, [
    "--require",
    fileURLToPath(new URL("../src/windows-process-barrier.cjs", import.meta.url)),
    "--eval",
    "process.stdout.write('adapter-started')",
  ], {
    env: { ...process.env, SANDKING_WINDOWS_JOB_BARRIER: marker },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(stdout, "");
    await writeFile(marker, "assigned\n", { mode: 0o600 });
    const exit = await new Promise((resolve) => child.once("close", resolve));
    assert.equal(exit, 0);
    assert.equal(stdout, "adapter-started");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("the Windows adapter barrier exits without running pinned code when containment fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandking-windows-barrier-abort-test-"));
  const marker = join(directory, "assigned");
  await writeFile(marker, "aborted\n", { mode: 0o600 });
  const child = spawn(process.execPath, [
    "--require",
    fileURLToPath(new URL("../src/windows-process-barrier.cjs", import.meta.url)),
    "--eval",
    "process.stdout.write('adapter-started')",
  ], {
    env: { ...process.env, SANDKING_WINDOWS_JOB_BARRIER: marker },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  try {
    const exit = await new Promise((resolve) => child.once("close", resolve));
    assert.notEqual(exit, 0);
    assert.equal(stdout, "");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("the Windows launch barrier retains proof when pinned code is aborted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandking-windows-barrier-proof-test-"));
  const marker = join(directory, "assigned");
  const evidencePath = join(directory, "termination.json");
  prepareHostLossTerminationEvidence(evidencePath);
  await writeFile(marker, "aborted\n", { mode: 0o600 });
  const child = spawn(process.execPath, [
    "--require",
    fileURLToPath(new URL("../src/windows-process-barrier.cjs", import.meta.url)),
    "--eval",
    "process.stdout.write('adapter-started')",
  ], {
    env: {
      ...process.env,
      SANDKING_WINDOWS_JOB_BARRIER: marker,
      SANDKING_HOST_LOSS_TERMINATION_EVIDENCE: evidencePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  try {
    assert.notEqual(await new Promise((resolve) => child.once("close", resolve)), 0);
    assert.equal(stdout, "");
    const evidence = await waitForHostLossTerminationEvidence(evidencePath, {
      expectedPlatform: "win32",
      timeoutMs: 5_000,
    });
    assert.deepEqual(evidence, {
      schemaVersion: 2,
      platform: "win32",
      status: "termination_confirmed",
      terminationScope: "complete_process_tree",
      launchSettled: true,
      treeEmpty: true,
      terminationBoundary: "launch_barrier_exit",
      observedAt: evidence?.observedAt,
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows Job Object command adapter preserves containment operations", async () => {
  const commands = [];
  let activeProcesses = 2;
  const jobObject = createNativeWindowsJobObject({
    name: "Local\\SandKingHarnessRun-test",
    execute: (file, args, options, callback) => {
      const command = args.at(-1);
      commands.push(command);
      if (command.includes("::ActiveProcessCount")) {
        callback(null, String(activeProcesses), "");
        return;
      }
      if (command.includes("::Terminate")) activeProcesses = 0;
      callback(null, "", "");
    },
  });
  const snapshot = await captureWindowsProcessTreeSnapshot(100, {
    expectedCommandLineFragment: "harness-run-original",
    readProcessIdentity: async () => ({
      processId: 100,
      creationTime: "2026-08-07T10:00:00.0001000Z",
      commandLine: "node adapter.mjs harness-run-original",
    }),
    jobObject,
  });
  assert.ok(snapshot);
  const tracker = createWindowsProcessTreeTracker(snapshot);

  assert.equal(await tracker.prepareCancellation(), true);
  assert.equal(await tracker.processTreeAlive(), true);
  assert.equal(await tracker.forceTerminate(), true);
  assert.equal(await tracker.processTreeAlive(), false);
  assert.ok(commands.some((command) => command.includes("CreateJobObject")));
  assert.ok(commands.some((command) => command.includes("AssignProcessToJobObject")));
  assert.ok(commands.some((command) => command.includes("QueryInformationJobObject")));
  assert.ok(commands.some((command) => command.includes("TerminateJobObject")));
  assert.ok(commands.every((command) => !/taskkill(?:\.exe)?/i.test(command)));
});

test("native Windows Job Object contains and terminates a real detached process tree", {
  skip: process.platform !== "win32"
    ? "requires native Windows Job Object and PowerShell boundaries"
    : false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandking-real-windows-job-"));
  const marker = join(directory, "assigned");
  const token = `sandking-real-job-${randomBytes(12).toString("hex")}`;
  const jobObject = createNativeWindowsJobObject({
    name: `Local\\SandKingHarnessRun-${randomBytes(16).toString("hex")}`,
  });
  const daemonSource = "setInterval(() => undefined, 1000)";
  const intermediateSource = `
    const { spawn } = require("node:child_process");
    const daemon = spawn(process.execPath, [
      "--eval",
      ${JSON.stringify(daemonSource)},
    ], { detached: true, stdio: "ignore" });
    daemon.unref();
    process.stdout.write(String(daemon.pid) + "\\n");
  `;
  const rootSource = `
    const { spawn } = require("node:child_process");
    const intermediate = spawn(process.execPath, [
      "--eval",
      ${JSON.stringify(intermediateSource)},
    ], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let daemonPid = "";
    intermediate.stdout.on("data", (chunk) => { daemonPid += chunk; });
    intermediate.once("close", () => process.stdout.write(daemonPid));
    setInterval(() => undefined, 1000);
  `;
  const root = spawn(process.execPath, [
    "--require",
    fileURLToPath(new URL("../src/windows-process-barrier.cjs", import.meta.url)),
    "--eval",
    rootSource,
    token,
  ], {
    env: { ...process.env, SANDKING_WINDOWS_JOB_BARRIER: marker },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let descendantPid = null;
  const processExists = (processId) => {
    try {
      process.kill(processId, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    assert.equal(typeof root.pid, "number");
    const snapshot = await captureWindowsProcessTreeSnapshot(root.pid, {
      expectedCommandLineFragment: token,
      jobObject,
    });
    assert.ok(snapshot);
    await writeFile(marker, "assigned\n", { mode: 0o600 });
    const [chunk] = await new Promise((resolve, reject) => {
      root.stdout.once("data", (...args) => resolve(args));
      root.once("error", reject);
    });
    descendantPid = Number(String(chunk).trim());
    assert.equal(Number.isSafeInteger(descendantPid), true);
    assert.equal(processExists(descendantPid), true);

    const tracker = createWindowsProcessTreeTracker(snapshot);
    assert.equal(await tracker.prepareCancellation(), true);
    assert.equal(await tracker.processTreeAlive(), true);
    assert.equal(await tracker.forceTerminate(), true);
    for (let attempt = 0; attempt < 100
      && await tracker.processTreeAlive(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await tracker.processTreeAlive(), false);
    assert.equal(processExists(root.pid), false);
    assert.equal(processExists(descendantPid), false);
  } finally {
    await jobObject.terminate().catch(() => false);
    await jobObject.close();
    await writeFile(marker, "aborted\n", { mode: 0o600 }).catch(() => undefined);
    if (root.exitCode === null && root.signalCode === null) root.kill("SIGKILL");
    if (descendantPid && processExists(descendantPid)) process.kill(descendantPid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("native Windows Host death proves the assigned Job is empty", {
  skip: process.platform !== "win32"
    ? "requires native Windows Job Object and PowerShell boundaries"
    : false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandking-windows-host-loss-job-"));
  const marker = join(directory, "assigned");
  const evidencePath = join(directory, "termination.json");
  const modulePath = fileURLToPath(new URL("../src/windows-process-tree.mjs", import.meta.url));
  const barrierPath = fileURLToPath(new URL(
    "../src/windows-process-barrier.cjs",
    import.meta.url,
  ));
  const token = `sandking-host-loss-job-${randomBytes(12).toString("hex")}`;
  const adapterSource = `
    const { spawn } = require("node:child_process");
    const worker = spawn(process.execPath, [
      "--eval", "setInterval(() => undefined, 1000)",
    ], { detached: true, stdio: "ignore" });
    process.stdout.write(JSON.stringify({ adapterPid: process.pid, workerPid: worker.pid }) + "\\n");
    setInterval(() => undefined, 1000);
  `;
  const hostSource = `
    import { spawn } from "node:child_process";
    import { writeFile } from "node:fs/promises";
    import {
      captureWindowsProcessTreeSnapshot,
      createNativeWindowsJobObject,
    } from ${JSON.stringify(pathToFileURL(modulePath).href)};
    const jobObject = createNativeWindowsJobObject({
      name: ${JSON.stringify(`Local\\SandKingHarnessRun-${randomBytes(16).toString("hex")}`)},
      hostLossTerminationEvidencePath: ${JSON.stringify(evidencePath)},
      launchBarrierMarkerPath: ${JSON.stringify(marker)},
    });
    const child = spawn(process.execPath, [
      "--require", ${JSON.stringify(barrierPath)},
      "--eval", ${JSON.stringify(adapterSource)},
      ${JSON.stringify(token)},
    ], {
      env: {
        ...process.env,
        SANDKING_WINDOWS_JOB_BARRIER: ${JSON.stringify(marker)},
        SANDKING_HOST_LOSS_TERMINATION_EVIDENCE: ${JSON.stringify(evidencePath)},
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const snapshot = await captureWindowsProcessTreeSnapshot(child.pid, {
      expectedCommandLineFragment: ${JSON.stringify(token)},
      jobObject,
    });
    if (!snapshot) throw new Error("windows_job_assignment_failed");
    await writeFile(${JSON.stringify(marker)}, "assigned\\n", { mode: 0o600 });
    child.stdout.once("data", (chunk) => process.stdout.write(chunk));
    setInterval(() => undefined, 1000);
  `;
  const host = spawn(process.execPath, ["--input-type=module", "--eval", hostSource], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const processExists = (processId) => {
    try {
      process.kill(processId, 0);
      return true;
    } catch {
      return false;
    }
  };
  let adapterPid = null;
  let workerPid = null;
  try {
    const [chunk] = await new Promise((resolve, reject) => {
      host.stdout.once("data", (...args) => resolve(args));
      host.once("error", reject);
    });
    ({ adapterPid, workerPid } = JSON.parse(String(chunk).trim()));
    assert.equal(processExists(adapterPid), true);
    assert.equal(processExists(workerPid), true);
    process.kill(host.pid, "SIGKILL");
    await new Promise((resolve) => host.once("exit", resolve));
    const evidence = await waitForHostLossTerminationEvidence(evidencePath, {
      expectedPlatform: "win32",
      timeoutMs: 20_000,
    });
    assert.equal(evidence?.status, "termination_confirmed");
    assert.equal(evidence?.terminationBoundary, "job_active_processes_zero");
    assert.equal(processExists(adapterPid), false);
    assert.equal(processExists(workerPid), false);
  } finally {
    if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    for (const processId of [workerPid, adapterPid]) {
      if (processId && processExists(processId)) process.kill(processId, "SIGKILL");
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("native Windows Host death during the launch barrier cannot start pinned code", {
  skip: process.platform !== "win32"
    ? "requires the native Windows process launch boundary"
    : false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandking-windows-host-loss-barrier-"));
  const marker = join(directory, "assigned");
  const evidencePath = join(directory, "termination.json");
  const sideEffectPath = join(directory, "adapter-started");
  const barrierPath = fileURLToPath(new URL(
    "../src/windows-process-barrier.cjs",
    import.meta.url,
  ));
  const hostSource = `
    const { spawn } = require("node:child_process");
    require("node:fs").writeFileSync(${JSON.stringify(evidencePath)}, "", {
      flag: "wx", mode: 0o600,
    });
    const child = spawn(process.execPath, [
      "--require", ${JSON.stringify(barrierPath)},
      "--eval", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(sideEffectPath)}, "started")`)},
    ], {
      env: {
        ...process.env,
        SANDKING_WINDOWS_JOB_BARRIER: ${JSON.stringify(marker)},
        SANDKING_HOST_LOSS_TERMINATION_EVIDENCE: ${JSON.stringify(evidencePath)},
      },
      stdio: "ignore",
      windowsHide: true,
    });
    process.stdout.write(String(child.pid) + "\\n");
    setInterval(() => undefined, 1000);
  `;
  const host = spawn(process.execPath, ["--eval", hostSource], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let adapterPid = null;
  try {
    const [chunk] = await new Promise((resolve, reject) => {
      host.stdout.once("data", (...args) => resolve(args));
      host.once("error", reject);
    });
    adapterPid = Number(String(chunk).trim());
    process.kill(host.pid, "SIGKILL");
    await new Promise((resolve) => host.once("exit", resolve));
    const evidence = await waitForHostLossTerminationEvidence(evidencePath, {
      expectedPlatform: "win32",
      timeoutMs: 15_000,
    });
    assert.equal(evidence?.terminationBoundary, "launch_barrier_exit");
    await assert.rejects(readFile(sideEffectPath), (error) =>
      error && typeof error === "object" && "code" in error && error.code === "ENOENT");
    assert.throws(() => process.kill(adapterPid, 0));
  } finally {
    if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    try { if (adapterPid) process.kill(adapterPid, "SIGKILL"); } catch { /* exited */ }
    await rm(directory, { recursive: true, force: true });
  }
});

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

test("Windows cancellation remains uncertain when an unobserved creator already exited", async () => {
  let processes = [
    { processId: 100, parentProcessId: 10, creationTime: "2026-08-07T10:00:00.000Z" },
    { processId: 300, parentProcessId: 200, creationTime: "2026-08-07T10:00:02.000Z" },
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
      terminated.push(processIdentity);
      processes = processes.filter((process) =>
        process.processId !== processIdentity.processId);
      return true;
    },
  });

  assert.equal(await tracker.prepareCancellation(), false);
  processes = processes.filter((process) => process.processId !== 100);
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
