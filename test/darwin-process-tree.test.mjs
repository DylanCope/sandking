import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  createDarwinSupervisorSignalController,
  darwinAdapterSpawnOptions,
  darwinSupervisorSpawnOptions,
  readDarwinHostLossTerminationEvidence,
  spawnDarwinProcessTree,
  terminateDarwinCoalitionAfterHostLoss,
} from "../src/darwin-process-tree.mjs";

const execFileAsync = promisify(execFile);
const containmentPreloadPath = fileURLToPath(
  new URL("../src/darwin-process-containment.cjs", import.meta.url),
);

const processCanRun = (processId) => {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error
      && error.code === "ESRCH");
  }
};

const waitUntil = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("darwin_process_tree_condition_timeout");
};

const readJsonLine = async (stream) => {
  let buffered = "";
  while (!buffered.includes("\n")) {
    const [chunk] = await once(stream, "data");
    buffered += String(chunk);
  }
  return JSON.parse(buffered.slice(0, buffered.indexOf("\n")));
};

test("the Darwin adapter inherits the retained supervisor process group", () => {
  assert.deepEqual(darwinSupervisorSpawnOptions(), {
    detached: true,
    stdio: "ignore",
  });
  const stdio = ["ignore", "pipe", "pipe", "pipe"];
  assert.deepEqual(darwinAdapterSpawnOptions({
    cwd: "/private/tmp/project",
    env: { LANG: "C.UTF-8" },
    stdio,
  }), {
    cwd: "/private/tmp/project",
    env: { LANG: "C.UTF-8" },
    detached: false,
    stdio,
  });
});

test("the Darwin supervisor revokes queued cooperative signals after adapter exit", () => {
  const dispatchedSignals = [];
  let adapterExited = false;
  const controller = createDarwinSupervisorSignalController({
    groupLeaderPid: 8_051,
    kill: (processId, signal) => {
      dispatchedSignals.push({ processId, signal, adapterExited });
      return true;
    },
    now: () => new Date("2026-08-08T15:00:00.000Z"),
  });
  const activeResult = controller.handleRequest({
    type: "darwin-process-tree.signal",
    requestId: 40,
    signal: "SIGTERM",
  });
  assert.deepEqual(activeResult, {
    type: "darwin-process-tree.signal-result",
    requestId: 40,
    sent: true,
    sentAt: "2026-08-08T15:00:00.000Z",
  });
  assert.deepEqual(dispatchedSignals, [{
    processId: -8_051,
    signal: "SIGTERM",
    adapterExited: false,
  }]);

  controller.recordAdapterExit();
  adapterExited = true;
  const result = controller.handleRequest({
    type: "darwin-process-tree.signal",
    requestId: 41,
    signal: "SIGTERM",
  });

  assert.deepEqual(result, {
    type: "darwin-process-tree.signal-result",
    requestId: 41,
    sent: false,
    sentAt: null,
  });
  assert.deepEqual(dispatchedSignals, [{
    processId: -8_051,
    signal: "SIGTERM",
    adapterExited: false,
  }]);
  assert.equal(controller.handleRequest({
    type: "darwin-process-tree.signal",
    requestId: 42,
    signal: "SIGKILL",
  }), null);
});

test("Darwin Host-loss termination is durable only after coalition absence is observed", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "sandking-darwin-host-loss-evidence-"));
  const evidencePath = join(fixture, "termination.json");
  const calls = [];
  try {
    const evidence = await terminateDarwinCoalitionAfterHostLoss({
      applicationSpecifier: "dev.sandking.harness.1234567890abcdef",
      terminationEvidencePath: evidencePath,
    }, {
      now: () => new Date("2026-08-09T18:00:00.000Z"),
      maxObservationAttempts: 2,
      delay: async () => undefined,
      runLsappinfo: async (arguments_) => {
        calls.push(arguments_);
        if (arguments_[0] === "kill") return { ok: false, stdout: "" };
        return calls.filter(([operation]) => operation === "find").length === 1
          ? { ok: true, stdout: "ASN:0x0-0x1234: bundleid=dev.sandking.harness\n" }
          : { ok: true, stdout: "" };
      },
    });

    assert.equal(evidence.status, "termination_confirmed");
    assert.equal(evidence.killAccepted, false);
    assert.equal(evidence.coalitionAbsent, true);
    assert.deepEqual(await readDarwinHostLossTerminationEvidence(evidencePath), evidence);
    assert.deepEqual(calls.map(([operation]) => operation), ["kill", "find", "find"]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Darwin Host-loss termination retains uncertainty when LaunchServices cannot prove absence", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "sandking-darwin-host-loss-uncertain-"));
  const evidencePath = join(fixture, "termination.json");
  try {
    const evidence = await terminateDarwinCoalitionAfterHostLoss({
      applicationSpecifier: "dev.sandking.harness.fedcba0987654321",
      terminationEvidencePath: evidencePath,
    }, {
      now: () => new Date("2026-08-09T18:05:00.000Z"),
      maxObservationAttempts: 2,
      delay: async () => undefined,
      runLsappinfo: async () => ({ ok: false, stdout: "" }),
    });

    assert.equal(evidence.status, "termination_unconfirmed");
    assert.equal(evidence.coalitionAbsent, false);
    assert.deepEqual(await readDarwinHostLossTerminationEvidence(evidencePath), evidence);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("the Darwin Node preload keeps detached Workers in the inherited group", async () => {
  const source = String.raw`
    const { spawn } = require("node:child_process");
    const worker = spawn(process.execPath, [
      "--eval",
      "process.send?.({ contained: process.env.NODE_OPTIONS?.includes('darwin-process-containment.cjs') }); setInterval(() => undefined, 1000)",
    ], {
      detached: true,
      env: { LANG: "C.UTF-8" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    worker.once("message", async (workerState) => {
      worker.disconnect();
      const inventory = spawn("/bin/ps", [
        "-o", "pid=,pgid=", "-p", process.pid + "," + worker.pid,
      ]);
      let output = "";
      inventory.stdout.on("data", (chunk) => { output += chunk; });
      inventory.once("close", () => {
        worker.kill("SIGKILL");
        process.stdout.write(JSON.stringify({ output, workerState }));
      });
    });
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--eval", source], {
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${JSON.stringify(containmentPreloadPath)}`,
    },
  });
  const { output, workerState } = JSON.parse(stdout);
  const processGroups = output.trim().split("\n").map((line) =>
    line.trim().split(/\s+/).map(Number));
  assert.equal(processGroups.length, 2, JSON.stringify(processGroups));
  assert.equal(processGroups[0][1], processGroups[1][1]);
  assert.equal(workerState.contained, true);
});

test("Darwin force cancellation terminates the real adapter process group", {
  skip: process.platform === "darwin"
    ? false
    : "LaunchServices process-coalition containment is available only on Darwin",
}, async () => {
  const adapterSource = String.raw`
    import { spawn } from "node:child_process";
    const worker = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      "process.on('SIGTERM', () => undefined); process.send?.('ready'); setInterval(() => undefined, 1000)",
    ], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    worker.disconnect();
    process.stdout.write(JSON.stringify({ adapterPid: process.pid, workerPid: worker.pid }) + "\\n");
    process.on("SIGTERM", () => undefined);
    setInterval(() => undefined, 1000);
  `;
  const tree = spawnDarwinProcessTree(process.execPath, [
    "--input-type=module",
    "--eval",
    adapterSource,
  ], {
    cwd: process.cwd(),
    env: { ...process.env },
  });
  let adapterPid = null;
  let workerPid = null;
  try {
    ({ adapterPid, workerPid } = await readJsonLine(tree.child.stdout));
    assert.equal(processCanRun(adapterPid), true);
    assert.equal(processCanRun(workerPid), true);
    await waitUntil(() => tree.prepareCancellation());

    assert.equal((await tree.signal("SIGTERM")).sent, true);
    assert.equal(processCanRun(adapterPid), true);
    assert.equal(processCanRun(workerPid), true);

    assert.equal((await tree.signal("SIGKILL")).sent, true);
    await waitUntil(async () => !(await tree.processTreeAlive()));
    await waitUntil(() => !processCanRun(adapterPid) && !processCanRun(workerPid));
  } finally {
    for (const processId of [workerPid, adapterPid]) {
      if (processId && processCanRun(processId)) {
        process.kill(processId, "SIGKILL");
      }
    }
    await tree.release();
  }
});

test("Darwin force cancellation terminates a native descendant that creates a new session", {
  skip: process.platform === "darwin"
    ? false
    : "LaunchServices process-coalition containment is available only on Darwin",
}, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "sandking-darwin-native-session-"));
  const sourcePath = join(fixture, "native-session-adapter.c");
  const executablePath = join(fixture, "native-session-adapter");
  await writeFile(sourcePath, String.raw`
#include <signal.h>
#include <stdio.h>
#include <unistd.h>

int main(void) {
  if (setsid() < 0) return 2;
  signal(SIGTERM, SIG_IGN);
  printf("{\"nativePid\":%d}\n", getpid());
  fflush(stdout);
  for (;;) pause();
}
`);
  await execFileAsync("cc", ["-O2", "-o", executablePath, sourcePath]);

  const adapterSource = String.raw`
    import { spawn } from "node:child_process";
    const native = spawn(${JSON.stringify(executablePath)}, [], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    native.stdout.setEncoding("utf8");
    native.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes("\\n")) return;
      const { nativePid } = JSON.parse(output.slice(0, output.indexOf("\\n")));
      process.stdout.write(JSON.stringify({ adapterPid: process.pid, nativePid }) + "\\n");
    });
    process.on("SIGTERM", () => undefined);
    setInterval(() => undefined, 1000);
  `;
  const tree = spawnDarwinProcessTree(process.execPath, [
    "--input-type=module",
    "--eval",
    adapterSource,
  ], {
    cwd: process.cwd(),
    env: { ...process.env },
  });
  let adapterPid = null;
  let nativePid = null;
  try {
    ({ adapterPid, nativePid } = await readJsonLine(tree.child.stdout));
    assert.equal(processCanRun(adapterPid), true);
    assert.equal(processCanRun(nativePid), true);
    await waitUntil(() => tree.prepareCancellation());

    assert.equal((await tree.signal("SIGTERM")).sent, true);
    assert.equal(processCanRun(adapterPid), true);
    assert.equal(processCanRun(nativePid), true);

    assert.equal((await tree.signal("SIGKILL")).sent, true);
    await waitUntil(async () => !(await tree.processTreeAlive()), 15_000);
    await waitUntil(() => !processCanRun(adapterPid) && !processCanRun(nativePid));
  } finally {
    for (const processId of [nativePid, adapterPid]) {
      if (processId && processCanRun(processId)) process.kill(processId, "SIGKILL");
    }
    await tree.release();
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Darwin Host death terminates the real adapter coalition before retaining proof", {
  skip: process.platform === "darwin"
    ? false
    : "LaunchServices process-coalition containment is available only on Darwin",
}, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "sandking-darwin-real-host-loss-"));
  const evidencePath = join(fixture, "termination.json");
  const modulePath = fileURLToPath(new URL("../src/darwin-process-tree.mjs", import.meta.url));
  const hostSource = String.raw`
    import { spawnDarwinProcessTree } from ${JSON.stringify(pathToFileURL(modulePath).href)};
    const adapterSource = String.raw\`
      import { spawn } from "node:child_process";
      const worker = spawn(process.execPath, [
        "--input-type=module", "--eval", "setInterval(() => undefined, 1000)",
      ], { detached: true, stdio: "ignore" });
      process.stdout.write(JSON.stringify({ adapterPid: process.pid, workerPid: worker.pid }) + "\\n");
      setInterval(() => undefined, 1000);
    \`;
    const tree = spawnDarwinProcessTree(process.execPath, [
      "--input-type=module", "--eval", adapterSource,
    ], {
      cwd: process.cwd(),
      env: { ...process.env },
      hostLossTerminationEvidencePath: ${JSON.stringify(evidencePath)},
    });
    let output = "";
    tree.child.stdout.setEncoding("utf8");
    tree.child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes("\\n")) return;
      process.stdout.write(output.slice(0, output.indexOf("\\n") + 1));
    });
    setInterval(() => undefined, 1000);
  `;
  const host = spawn(process.execPath, ["--input-type=module", "--eval", hostSource], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let adapterPid = null;
  let workerPid = null;
  try {
    ({ adapterPid, workerPid } = await readJsonLine(host.stdout));
    assert.equal(processCanRun(adapterPid), true);
    assert.equal(processCanRun(workerPid), true);
    process.kill(host.pid, "SIGKILL");
    await once(host, "exit");

    await waitUntil(async () =>
      (await readDarwinHostLossTerminationEvidence(evidencePath))?.status
        === "termination_confirmed", 20_000);
    await waitUntil(() => !processCanRun(adapterPid) && !processCanRun(workerPid), 20_000);
  } finally {
    if (processCanRun(host.pid)) process.kill(host.pid, "SIGKILL");
    for (const processId of [workerPid, adapterPid]) {
      if (processId && processCanRun(processId)) process.kill(processId, "SIGKILL");
    }
    await rm(fixture, { recursive: true, force: true });
  }
});
