import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  darwinAdapterSpawnOptions,
  spawnDarwinProcessTree,
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

test("the Darwin adapter stays in the launchd-owned process group", () => {
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
    : "launchd process containment is available only on Darwin",
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
