import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
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

/** @param {string[]} args */
const runFailingCli = async (args) => {
  try {
    await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: tmpdir(),
      env: process.env,
    });
    assert.fail("expected the command to fail");
  } catch (error) {
    assert.ok(error && typeof error === "object");
    return /** @type {{stdout: string, stderr: string}} */ (error);
  }
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
    assert.match(
      first.bootstrapUrl,
      /^http:\/\/127\.0\.0\.1:\d+\/bootstrap\?token=[a-f0-9]{64}&idempotencyKey=[a-f0-9]{64}&expectedRevision=0$/,
    );
    assert.deepEqual(first.bootstrap, {
      ttlMs: 60_000,
      expectedRevision: 0,
      expiresAt: first.bootstrap.expiresAt,
    });
    assert.match(first.bootstrap.expiresAt, /^\d{4}-\d{2}-\d{2}T/);

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

test("a partial stale launch lock left before its owner was recorded is recovered", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-partial-lock-"));
  const lockPath = join(dataDir, "runtime.lock");
  await writeFile(lockPath, "{\"pid\":", { mode: 0o600 });
  const staleTimestamp = new Date(Date.now() - 5_000);
  await utimes(lockPath, staleTimestamp, staleTimestamp);

  try {
    const launch = await runCli(["launch", "--data-dir", dataDir, "--json", "--no-open"]);
    assert.equal(launch.runtime.reused, false);
    assert.equal(launch.runtime.identity, "controller-runtime");
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
    const failure = await runFailingCli([
      "launch",
      "--data-dir",
      dataDir,
      "--host-mode",
      "hang-before-ack",
      "--startup-timeout-ms",
      "300",
      "--json",
      "--no-open",
    ]);
    assert.equal(failure.stderr, "");
    const publicOutcome = JSON.parse(failure.stdout);
    assert.deepEqual(publicOutcome, {
      ok: false,
      diagnosis: {
        type: "runtime_startup_failure",
        code: "runtime_start_timeout",
        retryable: true,
        explanation: "The Controller runtime did not become ready before the startup deadline.",
        retryGuidance: "Check the local Host installation and retry the launch.",
      },
    });
    const { stdout: processes } = await execFileAsync("ps", ["-eo", "args="]);
    assert.doesNotMatch(processes, new RegExp(`runtime-daemon\\.mjs --data-dir ${dataDir}`));
    const retained = JSON.parse(
      await readFile(join(dataDir, "last-startup-error.json"), "utf8"),
    );
    assert.deepEqual(
      { ...retained, recordedAt: "<timestamp>" },
      { ...publicOutcome.diagnosis, recordedAt: "<timestamp>" },
    );
    assert.match(retained.recordedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
