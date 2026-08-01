import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("the framed Host durably prepares and decides one immutable Launch request", async () => {
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
      framing: {
        maxFrameBytes: MAX_FRAME_BYTES,
        maxBulkChunkBytes: MAX_BULK_CHUNK_BYTES,
      },
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
      immutableRevision: harness.harness.immutableRevision,
      boundedConfiguration: {
        adapterProtocol: "1.0.0",
        launchProfile: "delegated-work",
      },
      authorizationClass: "host_local_project_configuration",
      idempotencyKey: "pin-launch-test-harness",
      expectedRevision: 1,
    });
    assert.equal((await readFrame(child.stdout)).type, "project.harness.pin.result");

    const prepareRequest = {
      type: "launch.request.prepare",
      requestId: "prepare-framed-launch",
      projectId: registration.project.projectId,
      parameters: { issueNumber: 119, targetBranch: "sandcastle/issue-119" },
      controllerId,
      controllerSessionId,
      authorizationClass: "focused_controller_launch",
      idempotencyKey: "prepare-framed-launch",
      expectedRevision: 0,
      expiresInSeconds: 300,
    };
    writeFrame(child.stdin, prepareRequest);
    const prepared = await readFrame(child.stdout);
    assert.equal(prepared.type, "launch.request.prepare.result", JSON.stringify(prepared));
    assert.equal(prepared.launchRequest.owner.controllerSessionId, controllerSessionId);
    assert.equal(prepared.launchRequest.preview.secretFree, true);
    assert.equal(prepared.launchRequest.preview.delegatedWorkStarted, false);

    const decisionRequest = {
      type: "launch.request.decision",
      requestId: "approve-framed-launch",
      launchRequestId: prepared.launchRequest.launchRequestId,
      decision: "approved",
      controllerId,
      controllerSessionId,
      authorizationClass: "focused_controller_launch",
      idempotencyKey: "approve-framed-launch",
      expectedRevision: 1,
    };
    writeFrame(child.stdin, decisionRequest);
    const approved = await readFrame(child.stdout);
    assert.equal(approved.type, "launch.request.decision.result");
    assert.equal(approved.code, "launch_request_approved");
    assert.equal(approved.launchRequest.execution.status, "not_started");

    writeFrame(child.stdin, { ...decisionRequest, requestId: "approve-framed-launch-replay" });
    const replay = await readFrame(child.stdout);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.auditId, approved.auditId);

    const retained = JSON.parse(await readFile(join(dataDir, "launch-requests.json"), "utf8"));
    assert.equal(retained.launchRequests.length, 1);
    assert.equal(retained.launchRequests[0].status, "approved");
    assert.equal(retained.launchRequests[0].revision, 2);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
});
