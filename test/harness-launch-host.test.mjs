import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  HOST_SCHEMA_DIGEST,
  MAX_BULK_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  hostCapabilities,
  protocolVersion,
  readFrame,
  releaseVersion,
  writeFrame,
} from "../src/protocol.mjs";

const execFileAsync = promisify(execFile);
const localHostPath = join(process.cwd(), "src", "local-host.mjs");

test("the framed Host launches a fresh Project with one revision-free message", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-launch-host-"));
  const dataDir = join(root, "host-state");
  const projectPath = join(root, "selected-project");
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
  await writeFile(join(projectPath, "README.md"), "ordinary Project content\n");
  const hostId = `host-${"1".repeat(24)}`;
  const controllerId = `runtime-${"2".repeat(24)}`;
  const controllerSessionId = `controller-session-${"3".repeat(24)}`;
  const child = spawn(process.execPath, [
    localHostPath,
    "--data-dir", dataDir,
    "--allow-host-identity-create",
  ], { stdio: ["pipe", "pipe", "pipe"], env: { LANG: "C.UTF-8" } });
  try {
    writeFrame(child.stdin, {
      type: "hello",
      protocol: protocolVersion,
      release: releaseVersion,
      identity: "controller-runtime",
      controllerId,
      expectedPeerIdentity: "local-host",
      expectedHostId: hostId,
      capabilities: { required: [...hostCapabilities], optional: [] },
      schemaDigest: HOST_SCHEMA_DIGEST,
      framing: { maxFrameBytes: MAX_FRAME_BYTES, maxBulkChunkBytes: MAX_BULK_CHUNK_BYTES },
      observationCursor: null,
    });
    assert.equal((await readFrame(child.stdout)).type, "hello-ack");
    writeFrame(child.stdin, {
      type: "host.identity.accept",
      requestId: "accept-launch-test-host",
      hostId,
      authorizationClass: "controller_host_identity_binding",
      idempotencyKey: "accept-launch-test-host",
      expectedRevision: 0,
    });
    assert.equal((await readFrame(child.stdout)).type, "host.identity.result");

    writeFrame(child.stdin, {
      type: "project.register",
      requestId: "register-launch-test-project",
      path: projectPath,
      configuration: {
        issueWorkflow: { provider: "github", kind: "issues" },
        checks: [
          { checkId: "typecheck", command: "npm run typecheck" },
          { checkId: "test", command: "npm run test" },
        ],
      },
      authorizationClass: "host_local_project_registration",
      idempotencyKey: "register-launch-test-project",
      expectedRevision: 0,
    });
    const registration = await readFrame(child.stdout);
    assert.equal(registration.type, "project.register.result");
    writeFrame(child.stdin, {
      type: "harness.conformance.register",
      requestId: "register-launch-test-harness",
      name: "Sand-King Conformance Harness",
      authorizationClass: "host_local_harness_registration",
      idempotencyKey: "register-launch-test-harness",
      expectedRevision: 0,
    });
    const harness = await readFrame(child.stdout);
    assert.equal(harness.type, "harness.conformance.register.result");
    writeFrame(child.stdin, {
      type: "project.harness.pin",
      requestId: "pin-launch-test-harness",
      projectId: registration.project.projectId,
      harnessId: harness.harness.harnessId,
      boundedConfiguration: { adapterProtocol: "1.0.0", launchProfile: "delegated-work" },
      authorizationClass: "host_local_project_configuration",
      idempotencyKey: "pin-launch-test-harness",
      expectedRevision: 1,
    });
    assert.equal((await readFrame(child.stdout)).type, "project.harness.pin.result");

    const launch = {
      type: "harness.run.launch",
      requestId: "launch-framed-harness",
      projectId: registration.project.projectId,
      parameters: { issueNumber: 152, targetBranch: "sandcastle/issue-152" },
      controllerId,
      controllerSessionId,
      source: "controller-cli",
      authorizationClass: "harness_run_launch",
      idempotencyKeyHash: `sha256:${"4".repeat(64)}`,
    };
    assert.equal("expectedRevision" in launch, false);
    writeFrame(child.stdin, launch);
    const created = await readFrame(child.stdout);
    assert.equal(created.type, "harness.run.launch.result", JSON.stringify(created));
    assert.equal(created.code, "harness_run_created");
    assert.equal(created.run.projectId, registration.project.projectId);
    assert.deepEqual(created.run.parameters, launch.parameters);
    assert.equal(created.run.source, "controller-cli");
    assert.equal("launchRequestId" in created.run, false);
    assert.equal(created.run.executionSnapshot.projectRegistration.revision, 2);
    assert.equal(created.run.executionSnapshot.harness.revision, 1);
    assert.deepEqual(created.run.executionSnapshot.credentialCapabilityReferences, [
      "github.issues.read",
      "project.git.read",
    ]);

    writeFrame(child.stdin, { ...launch, requestId: "launch-framed-harness-replay" });
    const replay = await readFrame(child.stdout);
    assert.equal(replay.code, "harness_run_created");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.run.harnessRunId, created.run.harnessRunId);

    const { parameters: omittedParameters, ...launchWithoutParameters } = launch;
    void omittedParameters;
    const parameterlessLaunch = {
      ...launchWithoutParameters,
      requestId: "launch-framed-harness-without-parameters",
      idempotencyKeyHash: `sha256:${"5".repeat(64)}`,
    };
    writeFrame(child.stdin, parameterlessLaunch);
    const parameterlessCreated = await readFrame(child.stdout);
    assert.equal(parameterlessCreated.type, "harness.run.launch.result");
    assert.deepEqual(parameterlessCreated.run.parameters, {});
    await assert.rejects(access(join(dataDir, "launch-requests.json")));
    const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(audits.some((audit) => audit.action === "harness.run.launch"
      && audit.outcome === "accepted"
      && audit.details.harnessRunId === created.run.harnessRunId));
    assert.equal(audits.some((audit) => /launch\.request|approve/.test(audit.action)), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("the framed Host explains how to recover from stale local Harness-run state", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-stale-launch-host-"));
  const statePath = join(dataDir, "harness-runs.json");
  const staleStateText = `${JSON.stringify({
    schemaVersion: 7,
    runs: [],
    launchOutcomes: [],
    cancellationOutcomes: [],
    legacyStartOutcomes: [],
  }, null, 2)}\n`;
  await writeFile(statePath, staleStateText);
  const child = spawn(process.execPath, [
    localHostPath,
    "--data-dir", dataDir,
    "--allow-host-identity-create",
  ], { stdio: ["pipe", "pipe", "pipe"], env: { LANG: "C.UTF-8" } });
  let diagnostic = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    diagnostic += chunk;
  });

  try {
    writeFrame(child.stdin, {
      type: "hello",
      protocol: protocolVersion,
      release: releaseVersion,
      identity: "controller-runtime",
      controllerId: `runtime-${"6".repeat(24)}`,
      expectedPeerIdentity: "local-host",
      expectedHostId: `host-${"7".repeat(24)}`,
      capabilities: { required: [...hostCapabilities], optional: [] },
      schemaDigest: HOST_SCHEMA_DIGEST,
      framing: { maxFrameBytes: MAX_FRAME_BYTES, maxBulkChunkBytes: MAX_BULK_CHUNK_BYTES },
      observationCursor: null,
    });
    assert.equal((await readFrame(child.stdout)).type, "hello-ack");
    writeFrame(child.stdin, {
      type: "host.identity.accept",
      requestId: "accept-stale-state-host",
      hostId: `host-${"7".repeat(24)}`,
      authorizationClass: "controller_host_identity_binding",
      idempotencyKey: "accept-stale-state-host",
      expectedRevision: 0,
    });
    assert.equal((await readFrame(child.stdout)).type, "host.identity.result");

    const exit = await new Promise((resolve) => child.once("close", (code, signal) => {
      resolve({ code, signal });
    }));
    assert.deepEqual(exit, { code: 1, signal: null });
    assert.match(diagnostic, /harness_run_state_schema_unsupported/);
    assert.match(diagnostic, /delete the Sand-King state directory/i);
    assert.match(diagnostic, new RegExp(dataDir.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(await readFile(statePath, "utf8"), staleStateText);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
