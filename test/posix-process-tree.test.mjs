import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { once } from "node:events";
import { readFileSync, readlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { spawnPosixProcessTree } from "../src/posix-process-tree.mjs";

const execFileAsync = promisify(execFile);

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

test("a cold Linux process-tree launch needs no compiler or warmed cache", {
  skip: process.platform !== "linux"
    ? "the packaged Linux helper is selected only on Linux"
    : false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandking-cold-process-tree-"));
  const modulePath = fileURLToPath(new URL("../src/posix-process-tree.mjs", import.meta.url));
  const source = `
    import { spawnPosixProcessTree } from ${JSON.stringify(modulePath)};
    const tree = spawnPosixProcessTree(process.execPath, [
      "--input-type=module",
      "--eval",
      "process.exit(0)",
    ], { cwd: process.cwd(), env: { LANG: "C.UTF-8" } });
    const exit = await tree.adapterExit;
    await tree.release();
    process.stdout.write(JSON.stringify(exit));
  `;
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      source,
    ], {
      cwd: process.cwd(),
      env: {
        LANG: "C.UTF-8",
        PATH: directory,
        TMPDIR: directory,
      },
    });
    assert.deepEqual(JSON.parse(stdout), {
      code: 0,
      signal: null,
      startFailed: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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

test("Linux cancellation terminates an escaped descendant without pidfds", {
  skip: process.platform !== "linux"
    ? "the legacy exact-signalling fallback is Linux-specific"
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
      process.stdout.write(JSON.stringify({
        descendantPid: descendant.pid,
        legacyFaultLeaked: process.env.SANDKING_TEST_PIDFD_UNAVAILABLE ?? null,
      }));
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
    env: {
      ...process.env,
      SANDKING_TEST_PIDFD_UNAVAILABLE: "1",
    },
  });
  let descendantPid = null;
  try {
    const [chunk] = await once(tree.child.stdout, "data");
    const ready = JSON.parse(String(chunk));
    descendantPid = ready.descendantPid;
    assert.equal(Number.isSafeInteger(descendantPid), true);
    assert.equal(ready.legacyFaultLeaked, null);
    assert.equal(processCanRun(descendantPid), true);

    const helperPath = fileURLToPath(new URL(
      `../src/native/linux-${process.arch}/posix-process-tree-helper`,
      import.meta.url,
    ));
    assert.equal(readlinkSync(`/proc/${tree.child.pid}/exe`), helperPath);

    assert.equal(await tree.prepareCancellation(), true);
    assert.equal((await tree.signal("SIGTERM")).sent, true);
    await tree.adapterExit;
    assert.equal(processCanRun(descendantPid), true);

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

test("POSIX cancellation retains a daemon after its unobserved intermediate exits", {
  skip: process.platform === "win32"
    ? "native Windows process trees use Job Object containment"
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
