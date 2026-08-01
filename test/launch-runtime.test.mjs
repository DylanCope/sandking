import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
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

const matchingProcesses = async (dataDir) => {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="]);
  return stdout.trim().split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match || !match[2].includes(dataDir)) {
      return [];
    }
    if (!match[2].includes("runtime-daemon.mjs") && !match[2].includes("local-host.mjs")) {
      return [];
    }
    return [{ pid: Number(match[1]), command: match[2] }];
  });
};

const waitForProcessCount = async (dataDir, expected, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const processes = await matchingProcesses(dataDir);
    if (processes.length === expected) {
      return processes;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const processes = await matchingProcesses(dataDir);
  assert.equal(processes.length, expected, JSON.stringify(processes));
  return processes;
};

const terminateMatchingProcesses = async (dataDir) => {
  const processes = await matchingProcesses(dataDir);
  for (const processEntry of processes.filter((entry) => entry.command.includes("runtime-daemon.mjs"))) {
    try {
      process.kill(process.platform === "win32" ? processEntry.pid : -processEntry.pid, "SIGKILL");
    } catch {
      // The scoped test process exited before cleanup.
    }
  }
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
    assert.equal(first.runtime.revision, 1);
    assert.equal(first.host.identity, "local-host");
    assert.match(first.host.hostId, /^host-[a-f0-9]{24}$/);
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
    assert.equal(state.host.hostId, first.host.hostId);
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

test("Host negotiation binds an ephemeral runtime ID to one persisted Host ID", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-durable-host-identity-"));

  try {
    const first = await runCli(["launch", "--data-dir", dataDir, "--json", "--no-open"]);
    const persistedIdentity = JSON.parse(
      await readFile(join(dataDir, "host-identity.json"), "utf8"),
    );
    const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const negotiation = audits.find((entry) =>
      entry.action === "host.negotiate" && entry.outcome === "accepted");

    assert.match(first.runtime.runtimeId, /^runtime-[a-f0-9]{24}$/);
    assert.match(first.host.hostId, /^host-[a-f0-9]{24}$/);
    assert.equal(persistedIdentity.hostId, first.host.hostId);
    const controllerBinding = JSON.parse(
      await readFile(join(dataDir, "controller-host-binding.json"), "utf8"),
    );
    assert.equal(controllerBinding.hostId, first.host.hostId);
    assert.equal(negotiation.details.controllerId, first.runtime.runtimeId);
    assert.equal(negotiation.details.expectedHostId, first.host.hostId);
    assert.equal(negotiation.details.hostId, first.host.hostId);

    const stopped = await runCli(["stop", "--data-dir", dataDir, "--json"]);
    assert.equal(stopped.stopped, true);
    const second = await runCli(["launch", "--data-dir", dataDir, "--json", "--no-open"]);
    assert.notEqual(second.runtime.runtimeId, first.runtime.runtimeId);
    assert.equal(second.host.hostId, first.host.hostId);
  } finally {
    await stopAndRemove(dataDir);
  }
});

test("a previously accepted Host identity replacement fails closed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-host-identity-replacement-"));

  try {
    const accepted = await runCli(["launch", "--data-dir", dataDir, "--json", "--no-open"]);
    await runCli(["stop", "--data-dir", dataDir, "--json"]);
    const bindingBefore = await readFile(join(dataDir, "controller-host-binding.json"), "utf8");
    const lifecycleBefore = await readFile(join(dataDir, "runtime-lifecycle.json"), "utf8");
    const replacementHostId = `host-${"f".repeat(24)}`;
    assert.notEqual(replacementHostId, accepted.host.hostId);
    await writeFile(join(dataDir, "host-identity.json"), `${JSON.stringify({
      hostId: replacementHostId,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });

    const failure = await runFailingCli([
      "launch",
      "--data-dir",
      dataDir,
      "--idempotency-key",
      "host-replacement-launch",
      "--expected-revision",
      "2",
      "--json",
      "--no-open",
    ]);
    const outcome = JSON.parse(failure.stdout);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.diagnosis.code, "controller_host_identity_mismatch");
    assert.equal(
      JSON.parse(await readFile(join(dataDir, "controller-host-binding.json"), "utf8")).hostId,
      accepted.host.hostId,
    );
    assert.equal(await readFile(join(dataDir, "controller-host-binding.json"), "utf8"), bindingBefore);
    assert.equal(await readFile(join(dataDir, "runtime-lifecycle.json"), "utf8"), lifecycleBefore);
    await assert.rejects(readFile(join(dataDir, "runtime-state.json"), "utf8"));
  } finally {
    await stopAndRemove(dataDir);
  }
});

test("runtime launch is revisioned, idempotent, and accepted in the audit", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-runtime-launch-contract-"));
  const launchArgs = [
    "launch",
    "--data-dir",
    dataDir,
    "--idempotency-key",
    "runtime-launch-success-1",
    "--expected-revision",
    "0",
    "--json",
    "--no-open",
  ];

  try {
    const first = await runCli(launchArgs);
    assert.deepEqual(first.mutation, {
      type: "mutation_result",
      code: "runtime_started",
      authorizationClass: "user_runtime_lifecycle",
      expectedRevision: 0,
      revision: 1,
      idempotentReplay: false,
      auditId: first.mutation.auditId,
    });
    assert.match(first.mutation.auditId, /^audit-/);

    const replay = await runCli(launchArgs);
    assert.equal(replay.runtime.runtimeId, first.runtime.runtimeId);
    assert.equal(replay.bootstrapUrl, first.bootstrapUrl);
    assert.deepEqual(replay.mutation, { ...first.mutation, idempotentReplay: true });

    const stale = await runCli([
      "launch",
      "--data-dir",
      dataDir,
      "--idempotency-key",
      "runtime-launch-stale-1",
      "--expected-revision",
      "0",
      "--json",
      "--no-open",
    ]);
    assert.deepEqual(stale, {
      type: "mutation_failure",
      code: "mutation_revision_conflict",
      retryable: true,
      started: false,
      expectedRevision: 0,
      actualRevision: 1,
      auditId: stale.auditId,
    });

    const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const acceptedAudit = audits.find((entry) => entry.auditId === first.mutation.auditId);
    assert.equal(acceptedAudit.action, "runtime.start");
    assert.equal(acceptedAudit.outcome, "accepted");
    assert.deepEqual({
      authorizationClass: acceptedAudit.details.authorizationClass,
      expectedRevision: acceptedAudit.details.expectedRevision,
      actualRevision: acceptedAudit.details.actualRevision,
      resultingRevision: acceptedAudit.details.resultingRevision,
      runtimeId: acceptedAudit.details.runtimeId,
      reused: acceptedAudit.details.reused,
    }, {
      authorizationClass: "user_runtime_lifecycle",
      expectedRevision: 0,
      actualRevision: 0,
      resultingRevision: 1,
      runtimeId: first.runtime.runtimeId,
      reused: false,
    });
    assert.match(acceptedAudit.details.idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
  } finally {
    await stopAndRemove(dataDir);
  }
});

test("a stop queued behind startup uses the runtime lock and stops the launched runtime", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-runtime-stop-race-"));

  try {
    const launchPromise = runCli([
      "launch",
      "--data-dir",
      dataDir,
      "--host-mode",
      "delayed-ack",
      "--json",
      "--no-open",
    ]);
    const lockPath = join(dataDir, "runtime.lock");
    const lockDeadline = Date.now() + 2_000;
    while (Date.now() < lockDeadline) {
      if (await readFile(lockPath, "utf8").then(() => true, () => false)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(await readFile(lockPath, "utf8").then(() => true, () => false), true);

    const stopPromise = runCli(["stop", "--data-dir", dataDir, "--json"]);
    const [launch, stopped] = await Promise.all([launchPromise, stopPromise]);

    assert.equal(launch.runtime.reused, false);
    assert.equal(stopped.stopped, true);
    await assert.rejects(fetch(`http://127.0.0.1:${launch.runtime.port}/health`));
  } finally {
    await stopAndRemove(dataDir);
  }
});

test("runtime stop is revisioned, idempotent, and audited", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-runtime-stop-contract-"));

  try {
    const launch = await runCli(["launch", "--data-dir", dataDir, "--json", "--no-open"]);
    assert.equal(launch.runtime.revision, 1);

    const staleArgs = [
      "stop",
      "--data-dir",
      dataDir,
      "--idempotency-key",
      "runtime-stop-stale-1",
      "--expected-revision",
      "0",
      "--json",
    ];
    const stale = await runCli(staleArgs);
    assert.deepEqual(stale, {
      type: "mutation_failure",
      code: "mutation_revision_conflict",
      retryable: true,
      stopped: false,
      expectedRevision: 0,
      actualRevision: 1,
      auditId: stale.auditId,
    });
    assert.match(stale.auditId, /^audit-/);
    assert.equal(
      (await runCli(["launch", "--data-dir", dataDir, "--json", "--no-open"])).runtime.reused,
      true,
    );

    const stopArgs = [
      "stop",
      "--data-dir",
      dataDir,
      "--idempotency-key",
      "runtime-stop-success-1",
      "--expected-revision",
      "1",
      "--json",
    ];
    const first = await runCli(stopArgs);
    assert.deepEqual(first, {
      type: "mutation_result",
      code: "runtime_stopped",
      stopped: true,
      runtimeId: launch.runtime.runtimeId,
      revision: 2,
      idempotentReplay: false,
      auditId: first.auditId,
    });
    assert.match(first.auditId, /^audit-/);
    assert.deepEqual(await runCli(stopArgs), { ...first, idempotentReplay: true });
    assert.deepEqual(await runCli(staleArgs), { ...stale, idempotentReplay: true });

    const lifecycle = JSON.parse(
      await readFile(join(dataDir, "runtime-lifecycle.json"), "utf8"),
    );
    assert.deepEqual(lifecycle, {
      revision: 2,
      status: "stopped",
      runtimeId: launch.runtime.runtimeId,
    });
    const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const accepted = audits.find((entry) => entry.auditId === first.auditId);
    assert.equal(accepted.action, "runtime.stop");
    assert.equal(accepted.outcome, "accepted");
    assert.deepEqual({
      authorizationClass: accepted.details.authorizationClass,
      expectedRevision: accepted.details.expectedRevision,
      actualRevision: accepted.details.actualRevision,
      resultingRevision: accepted.details.resultingRevision,
      runtimeId: accepted.details.runtimeId,
    }, {
      authorizationClass: "user_runtime_lifecycle",
      expectedRevision: 1,
      actualRevision: 1,
      resultingRevision: 2,
      runtimeId: launch.runtime.runtimeId,
    });
    assert.match(accepted.details.idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
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

test("killing launch before readiness cannot orphan its runtime and Host", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-killed-launch-"));
  const launcher = spawn(process.execPath, [
    cliPath,
    "launch",
    "--data-dir",
    dataDir,
    "--host-mode",
    "hang-before-ack",
    "--startup-timeout-ms",
    "10000",
    "--json",
    "--no-open",
  ], {
    cwd: tmpdir(),
    env: process.env,
    stdio: "ignore",
  });

  try {
    const startupProcesses = await waitForProcessCount(dataDir, 2);
    assert.equal(startupProcesses.filter((entry) => entry.command.includes("runtime-daemon.mjs")).length, 1);
    assert.equal(startupProcesses.filter((entry) => entry.command.includes("local-host.mjs")).length, 1);
    launcher.kill("SIGKILL");
    await new Promise((resolve) => launcher.once("close", resolve));

    const recovered = await runCli(["launch", "--data-dir", dataDir, "--json", "--no-open"]);
    assert.equal(recovered.runtime.reused, false);
    const recoveredProcesses = await waitForProcessCount(dataDir, 2);
    assert.equal(recoveredProcesses.filter((entry) => entry.command.includes("runtime-daemon.mjs")).length, 1);
    assert.equal(recoveredProcesses.filter((entry) => entry.command.includes("local-host.mjs")).length, 1);
    assert.deepEqual(
      recoveredProcesses.filter((entry) =>
        startupProcesses.some((startupProcess) => startupProcess.pid === entry.pid)),
      [],
    );
  } finally {
    if (launcher.exitCode === null && launcher.signalCode === null) {
      launcher.kill("SIGKILL");
    }
    await runCli(["stop", "--data-dir", dataDir, "--json"]).catch(() => undefined);
    await terminateMatchingProcesses(dataDir);
    await rm(dataDir, { recursive: true, force: true });
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
