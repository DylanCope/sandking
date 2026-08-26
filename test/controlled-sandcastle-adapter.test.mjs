import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readHarnessAdapterFrame,
  writeHarnessAdapterFrame,
} from "../src/harness-adapter-protocol.mjs";

const adapterPath = new URL(
  "../src/production-sandcastle-adapter/sandcastle-v4.mjs",
  import.meta.url,
);
const workerPath = new URL(
  "../src/production-sandcastle-adapter/controlled-worker-fixture.mjs",
  import.meta.url,
);
const githubCredentialContractPath = new URL(
  "../src/github-credential-contract.mjs",
  import.meta.url,
);
const realDelegationProtocolPath = new URL(
  "../src/real-delegation-protocol.mjs",
  import.meta.url,
);
const adapterId = "sandcastle-harness-adapter-v1";
const adapterProtocol = "1.0.0";
const retainedWorkerPath = ".sandcastle/controlled-worker-fixture.mjs";
const workerSource = await readFile(workerPath, "utf8");
const githubCredentialContractSource = await readFile(githubCredentialContractPath, "utf8");
const realDelegationProtocolSource = await readFile(realDelegationProtocolPath, "utf8");
const workerIntegrity = `sha256:${createHash("sha256")
  .update(workerSource)
  .digest("hex")}`;

const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const writeControlledManifest = (projectPath, value) => writeFile(
  join(projectPath, "sandcastle.worker-fixture.json"),
  `${JSON.stringify(value, null, 2)}\n`,
);

const createFixture = async (manifest) => {
  const root = await mkdtemp(join(tmpdir(), "sandking-controlled-adapter-"));
  const projectPath = join(root, "project");
  const executionPath = join(projectPath, ".sandking", "projection");
  await mkdir(executionPath, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("git_init_failed")));
  });
  await Promise.all([
    writeControlledManifest(projectPath, manifest),
    writeFile(
      join(executionPath, "github-credential-contract.mjs"),
      githubCredentialContractSource,
    ),
    writeFile(
      join(executionPath, "real-delegation-protocol.mjs"),
      realDelegationProtocolSource,
    ),
    writeFile(join(executionPath, "worker-environment.json"), `${JSON.stringify({
      schemaVersion: 1,
      harness: { adapterId },
      skillSetLockDigest: `sha256:${"1".repeat(64)}`,
      skillDiscovery: { ambient: "disabled", roots: ["worker-skills"], unlisted: "reject" },
      skills: [{ identity: "sandking.issue-implementation" }],
      executionRuntimeInputs: [{ identity: "openai.codex-cli", version: "0.146.0" }],
    })}\n`),
  ]);
  return { root, projectPath, executionPath };
};

const invoke = async ({ command, encoded = encode({}), executionPath }) => {
  const source = await readFile(adapterPath, "utf8");
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval", source,
    "adapters/sandcastle.mjs",
    command,
    encoded,
  ], {
    cwd: executionPath,
    env: { LANG: "C.UTF-8", PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe", "pipe", "ipc"],
  });
  let diagnostic = "";
  child.stderr.on("data", (chunk) => {
    diagnostic += Buffer.from(chunk).toString("utf8");
  });
  return { child, channel: child.stdio[3], diagnostic: () => diagnostic };
};

const waitForExit = (child) => new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

const startRun = async (fixture, parameters = {}, runSuffix = "2") => {
  const harnessRunId = `harness-run-${runSuffix.repeat(24)}`;
  const invocation = await invoke({
    command: "run",
    encoded: encode({ harnessRunId, parameters }),
    executionPath: fixture.executionPath,
  });
  writeHarnessAdapterFrame(invocation.channel, {
    type: "harness.run.start",
    adapterProtocol,
    adapterId,
    harnessRunId,
    retainedExecutionInputs: [{
      path: retainedWorkerPath,
      integrity: workerIntegrity,
      source: workerSource,
    }],
  });
  return { ...invocation, harnessRunId };
};

const readToTerminal = async (invocation) => {
  const frames = [];
  while (!frames.some(({ type }) => type === "harness.run.terminal")) {
    frames.push(await readHarnessAdapterFrame(invocation.channel));
  }
  assert.deepEqual(await waitForExit(invocation.child), { code: 0, signal: null });
  return frames;
};

test("the controlled production-adapter protocol delegates one deterministic Worker result", async () => {
  const fixture = await createFixture({
    schemaVersion: 1,
    provider: { kind: "controlled-worker-fixture", ready: true },
    scenario: "succeeded",
    artifact: {
      path: "controlled-delegation.txt",
      content: "controlled delegated work\n",
    },
  });
  try {
    const invocation = await startRun(fixture, {
      issueNumber: 173,
      targetBranch: "sandcastle/issue-173",
    });
    const frames = await readToTerminal(invocation);
    assert.equal(frames[0].type, "harness.run.ready");
    assert.equal(frames.filter(({ type }) => type === "harness.run.progress").length, 1);
    const [terminal] = frames.filter(({ type }) => type === "harness.run.terminal");
    assert.equal(terminal.status, "succeeded");
    assert.deepEqual(terminal.result, {
      schemaVersion: 1,
      kind: "sandcastle.delegation",
      code: "work_completed",
      selection: {
        issueNumber: 173,
        targetBranch: "sandcastle/issue-173",
      },
      artifact: "controlled-delegation.txt",
    });
    assert.equal(
      await readFile(join(fixture.projectPath, "controlled-delegation.txt"), "utf8"),
      "controlled delegated work\n",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("controlled Worker outcomes, not exit or diagnostic text, determine one terminal result", async () => {
  const fixture = await createFixture({
    schemaVersion: 1,
    provider: { kind: "controlled-worker-fixture", ready: true },
    scenario: "succeeded-nonzero",
  });
  const scenarios = [
    ["succeeded-nonzero", "succeeded", "work_completed", null],
    ["failed", "failed", "work_failed", null],
    ["malformed-output", "failed", "worker_output_invalid", "sandcastle_worker_output_invalid"],
    ["nonzero-exit", "failed", "worker_result_missing", "sandcastle_worker_result_missing"],
    ["zero-exit", "failed", "worker_result_missing", "sandcastle_worker_result_missing"],
    ["duplicate-result", "failed", "worker_result_ambiguous", "sandcastle_worker_result_ambiguous"],
    ["diagnostic-only", "failed", "worker_result_missing", "sandcastle_worker_result_missing"],
  ];
  try {
    for (const [index, [scenario, status, code, diagnosticCode]] of scenarios.entries()) {
      await writeControlledManifest(fixture.projectPath, {
        schemaVersion: 1,
        provider: { kind: "controlled-worker-fixture", ready: true },
        scenario,
      });
      const invocation = await startRun(fixture, {}, (index + 2).toString(16));
      const frames = await readToTerminal(invocation);
      const terminals = frames.filter(({ type }) => type === "harness.run.terminal");
      assert.equal(terminals.length, 1, scenario);
      assert.equal(terminals[0].status, status, scenario);
      assert.equal(terminals[0].result.code, code, scenario);
      if (diagnosticCode) {
        assert.match(invocation.diagnostic(), new RegExp(diagnosticCode), scenario);
      }
      if (scenario === "malformed-output") {
        assert.doesNotMatch(invocation.diagnostic(), /malformed controlled Worker output/);
      }
      if (scenario === "diagnostic-only") {
        assert.match(invocation.diagnostic(), /SUCCESS/);
      }
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("controlled provider and execution readiness fail before work and recover", async () => {
  const fixture = await createFixture({
    schemaVersion: 1,
    runtime: { ready: true },
    provider: { kind: "controlled-worker-fixture", ready: false },
    scenario: "succeeded",
  });
  try {
    for (const [manifest, expectedType, expectedCode] of [
      [{
        schemaVersion: 1,
        runtime: { ready: true },
        provider: { kind: "controlled-worker-fixture", ready: false },
        scenario: "succeeded",
      }, "harness.launch.failure", "harness_worker_provider_unavailable"],
      [{
        schemaVersion: 1,
        runtime: { ready: false },
        provider: { kind: "controlled-worker-fixture", ready: true },
        scenario: "succeeded",
      }, "harness.launch.failure", "harness_execution_runtime_unavailable"],
      [{
        schemaVersion: 1,
        runtime: { ready: true },
        provider: { kind: "controlled-worker-fixture", ready: true },
        scenario: "succeeded",
      }, "harness.launch.prepared", null],
    ]) {
      await writeControlledManifest(fixture.projectPath, manifest);
      const invocation = await invoke({
        command: "prepare",
        executionPath: fixture.executionPath,
      });
      const frame = await readHarnessAdapterFrame(invocation.channel);
      assert.equal(frame.type, expectedType);
      if (expectedCode) {
        assert.equal(frame.code, expectedCode);
        assert.deepEqual(frame.sideEffects, {
          delegatedWorkStarted: false,
          projectWrite: false,
          harnessWorkspaceWrite: false,
        });
      } else {
        assert.deepEqual(frame.retainedExecutionInputs, [retainedWorkerPath]);
      }
      assert.deepEqual(await waitForExit(invocation.child), { code: 0, signal: null });
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("controlled adapter cancellation yields one canonical terminal envelope", async () => {
  const fixture = await createFixture({
    schemaVersion: 1,
    provider: { kind: "controlled-worker-fixture", ready: true },
    scenario: "cancellable",
  });
  try {
    const invocation = await startRun(fixture);
    const frames = [];
    while (!frames.some(({ type }) => type === "harness.run.progress")) {
      frames.push(await readHarnessAdapterFrame(invocation.channel));
    }
    invocation.child.send({
      type: "harness.run.cancel",
      adapterProtocol,
      adapterId,
      harnessRunId: invocation.harnessRunId,
      cooperativeDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
    });
    while (!frames.some(({ type }) => type === "harness.run.terminal")) {
      frames.push(await readHarnessAdapterFrame(invocation.channel));
    }
    assert.deepEqual(await waitForExit(invocation.child), { code: 0, signal: null });
    const terminals = frames.filter(({ type }) => type === "harness.run.terminal");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].status, "cancelled");
    assert.equal(terminals[0].result.code, "cancelled");
    await assert.rejects(access(join(fixture.projectPath, "controlled-delegation.txt")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
