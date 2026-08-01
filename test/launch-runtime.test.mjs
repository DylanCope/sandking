import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "src", "cli.mjs");

/** @param {string[]} args @param {{env?: NodeJS.ProcessEnv, cwd?: string}} [options] */
const runCli = async (args, options = {}) => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd ?? tmpdir(),
    env: { ...process.env, ...options.env },
  });
  return JSON.parse(stdout);
};

const stopAndRemove = async (dataDir) => {
  await runCli(["stop", "--data-dir", dataDir, "--json"]).catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
};

test("concurrent launches reuse one ready runtime and retain full Host negotiation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-runtime-"));

  try {
    const [first, second] = await Promise.all([
      runCli(["launch", "--data-dir", dataDir, "--json", "--no-open"]),
      runCli(["launch", "--data-dir", dataDir, "--json", "--no-open"]),
    ]);

    assert.equal(first.runtime.runtimeId, second.runtime.runtimeId);
    assert.equal(first.runtime.port, second.runtime.port);
    assert.deepEqual([first.runtime.reused, second.runtime.reused].sort(), [false, true]);
    assert.deepEqual(first.runtime.listener, { address: "127.0.0.1", class: "loopback" });
    assert.equal(first.runtime.identity, "controller-runtime");
    assert.equal(first.host.identity, "local-host");
    assert.deepEqual(first.host.capabilities.required, ["sandking.control.slice-1"]);
    assert.deepEqual(first.host.negotiatedCapabilities, [
      "sandking.control.slice-1",
      "sandking.bulk-stream.v1",
    ]);
    assert.match(first.host.schemaDigest, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(first.host.framing, {
      maxFrameBytes: 65_536,
      maxBulkChunkBytes: 16_384,
    });
    assert.match(first.bootstrapUrl, /^http:\/\/127\.0\.0\.1:\d+\/bootstrap\?token=[a-f0-9]{64}$/);

    const state = JSON.parse(await readFile(join(dataDir, "runtime-state.json"), "utf8"));
    assert.equal(state.host.identity, "local-host");
    assert.equal(state.protocol.version, "1.0.0");
    assert.match(state.negotiationAuditId, /^audit-/);

    assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dataDir, "runtime-state.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dataDir, "audit.jsonl"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dataDir, "bootstrap-tokens"))).mode & 0o777, 0o700);
  } finally {
    await stopAndRemove(dataDir);
  }
});

test("a stale launch lock is recovered only after its owner is dead", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-stale-lock-"));
  await writeFile(join(dataDir, "runtime.lock"), `${JSON.stringify({
    pid: 2_147_483_647,
    lockId: "abandoned",
  })}\n`);

  try {
    const launch = await runCli(["launch", "--data-dir", dataDir, "--json", "--no-open"]);
    assert.equal(launch.runtime.reused, false);
  } finally {
    await stopAndRemove(dataDir);
  }
});

test("a live incompatible runtime blocks a competing spawn", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-incompatible-runtime-"));

  try {
    await runCli(["launch", "--data-dir", dataDir, "--json", "--no-open"]);
    const statePath = join(dataDir, "runtime-state.json");
    const original = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(statePath, `${JSON.stringify({ ...original, compatibilityKey: "runtime-v999" })}\n`, {
      mode: 0o600,
    });

    await assert.rejects(
      runCli(["launch", "--data-dir", dataDir, "--json", "--no-open"]),
      /runtime_incompatible/,
    );
    const after = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(after.pid, original.pid);
    assert.equal(after.runtimeId, original.runtimeId);

    await writeFile(statePath, `${JSON.stringify(original)}\n`, { mode: 0o600 });
  } finally {
    await stopAndRemove(dataDir);
  }
});

test("PID existence without an authenticated health response is not readiness", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-unready-runtime-"));

  try {
    await runCli(["launch", "--data-dir", dataDir, "--json", "--no-open"]);
    const statePath = join(dataDir, "runtime-state.json");
    const original = JSON.parse(await readFile(statePath, "utf8"));
    await runCli(["stop", "--data-dir", dataDir, "--json"]);
    const fake = { ...original, pid: process.pid, port: 9 };
    await writeFile(statePath, `${JSON.stringify(fake)}\n`, { mode: 0o600 });

    await assert.rejects(
      runCli(["launch", "--data-dir", dataDir, "--json", "--no-open"]),
      /runtime_not_ready/,
    );
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).pid, process.pid);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("startup timeout terminates the detached runtime and Host process group", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-timeout-runtime-"));

  try {
    await assert.rejects(
      runCli([
        "launch",
        "--data-dir",
        dataDir,
        "--host-mode",
        "hang-before-ack",
        "--startup-timeout-ms",
        "300",
        "--json",
        "--no-open",
      ]),
      /runtime_start_timeout/,
    );
    const { stdout: processes } = await execFileAsync("ps", ["-eo", "args="]);
    assert.doesNotMatch(processes, new RegExp(`runtime-daemon\\.mjs --data-dir ${dataDir}`));
    const failure = JSON.parse(await readFile(join(dataDir, "last-startup-error.json"), "utf8"));
    assert.equal(failure.code, "runtime_start_timeout");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
