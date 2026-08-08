import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { spawnPosixProcessTree } from "../src/posix-process-tree.mjs";

const processCanRun = (processId) => {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${processId}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2)[0];
      return !["X", "Z"].includes(state);
    } catch {
      return false;
    }
  }
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error
      && error.code === "ESRCH");
  }
};

test("POSIX cancellation retains a descendant that creates a new session", {
  skip: process.platform === "win32"
    ? "native Windows process trees use the Windows tracker"
    : false,
}, async () => {
  const adapterSource = String.raw`
    import { spawn } from "node:child_process";
    const descendant = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      "process.on('SIGTERM', () => undefined); process.stdout.write('ready\\n'); setInterval(() => undefined, 1000)",
    ], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    descendant.stdout.once("data", () => {
      descendant.stdout.destroy();
      descendant.unref();
      process.stdout.write(String(descendant.pid) + "\\n");
    });
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => undefined, 1000);
  `;
  const tree = spawnPosixProcessTree(process.execPath, [
    "--input-type=module",
    "--eval",
    adapterSource,
  ], {
    cwd: process.cwd(),
    env: { ...process.env },
  });
  let descendantPid = null;
  try {
    const [chunk] = await once(tree.child.stdout, "data");
    descendantPid = Number(/[0-9]+/.exec(String(chunk))?.[0]);
    assert.equal(Number.isSafeInteger(descendantPid), true);
    assert.equal(processCanRun(descendantPid), true);

    assert.equal(await tree.prepareCancellation(), true);
    assert.equal((await tree.signal("SIGTERM")).sent, true);
    await tree.adapterExit;

    assert.equal(processCanRun(descendantPid), true);
    assert.equal(await tree.processTreeAlive(), true);

    assert.equal((await tree.signal("SIGKILL")).sent, true);
    assert.equal(await tree.processTreeAlive(), false);
    assert.equal(processCanRun(descendantPid), false);
  } finally {
    if (descendantPid && processCanRun(descendantPid)) {
      process.kill(descendantPid, "SIGKILL");
    }
    if (tree.child.exitCode === null && tree.child.signalCode === null) {
      await tree.signal("SIGKILL");
    }
    await tree.release();
  }
});

test("Linux cancellation retains a daemon after its unobserved intermediate exits", {
  skip: process.platform !== "linux"
    ? "Linux subreaper ownership is exercised only on Linux"
    : false,
}, async () => {
  const daemonSource = String.raw`
    process.on("SIGTERM", () => undefined);
    process.stdout.write("ready\n");
    setInterval(() => undefined, 1000);
  `;
  const intermediateSource = `
    import { spawn } from "node:child_process";
    const daemon = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      ${JSON.stringify(daemonSource)},
    ], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    daemon.stdout.once("data", () => {
      daemon.stdout.destroy();
      daemon.unref();
      process.stdout.write(String(daemon.pid) + "\\n");
    });
  `;
  const adapterSource = `
    import { spawn } from "node:child_process";
    const intermediate = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      ${JSON.stringify(intermediateSource)},
    ], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let daemonPid = "";
    intermediate.stdout.on("data", (chunk) => { daemonPid += chunk; });
    intermediate.once("close", () => process.stdout.write(daemonPid));
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => undefined, 1000);
  `;
  const tree = spawnPosixProcessTree(process.execPath, [
    "--input-type=module",
    "--eval",
    adapterSource,
  ], {
    cwd: process.cwd(),
    env: { ...process.env },
  });
  let daemonPid = null;
  const nativeKill = process.kill;
  const directSignals = [];
  try {
    const [chunk] = await once(tree.child.stdout, "data");
    daemonPid = Number(/[0-9]+/.exec(String(chunk))?.[0]);
    assert.equal(Number.isSafeInteger(daemonPid), true);
    assert.equal(processCanRun(daemonPid), true);

    process.kill = (processId, signal) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        directSignals.push({ processId, signal });
      }
      return nativeKill(processId, signal);
    };
    assert.equal(await tree.prepareCancellation(), true);
    assert.equal((await tree.signal("SIGTERM")).sent, true);
    await tree.adapterExit;
    assert.equal(processCanRun(daemonPid), true);
    assert.equal(await tree.processTreeAlive(), true);

    assert.equal((await tree.signal("SIGKILL")).sent, true);
    assert.equal(await tree.processTreeAlive(), false);
    assert.equal(processCanRun(daemonPid), false);
    assert.equal(directSignals.some(({ processId }) => processId > 0), false);
  } finally {
    process.kill = nativeKill;
    if (daemonPid && processCanRun(daemonPid)) {
      process.kill(daemonPid, "SIGKILL");
    }
    if (tree.child.exitCode === null && tree.child.signalCode === null) {
      await tree.signal("SIGKILL");
    }
    await tree.release();
  }
});
