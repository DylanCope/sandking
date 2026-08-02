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

    const missingProjectPreparation = {
      type: "launch.request.prepare",
      requestId: "prepare-missing-project",
      projectId: `project-${"9".repeat(24)}`,
      parameters: { issueNumber: 119, targetBranch: "sandcastle/issue-119" },
      controllerId,
      controllerSessionId,
      authorizationClass: "focused_controller_launch",
      idempotencyKey: "prepare-missing-project",
      expectedRevision: 0,
      expiresInSeconds: 300,
    };
    writeFrame(child.stdin, missingProjectPreparation);
    const missingProject = await readFrame(child.stdout);
    assert.equal(missingProject.code, "project_not_found");
    assert.equal(missingProject.idempotentReplay, false);
    writeFrame(child.stdin, {
      ...missingProjectPreparation,
      requestId: "prepare-missing-project-replay",
    });
    const missingProjectReplay = await readFrame(child.stdout);
    assert.equal(missingProjectReplay.code, "project_not_found");
    assert.equal(missingProjectReplay.idempotentReplay, true);
    assert.equal(missingProjectReplay.auditId, missingProject.auditId);
    writeFrame(child.stdin, {
      ...missingProjectPreparation,
      requestId: "prepare-missing-project-conflict",
      projectId: `project-${"8".repeat(24)}`,
    });
    const missingProjectKeyConflict = await readFrame(child.stdout);
    assert.equal(missingProjectKeyConflict.code, "idempotency_key_conflict");

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
    const outOfRangePreparation = {
      ...prepareRequest,
      requestId: "prepare-framed-launch-out-of-range",
      parameters: {
        issueNumber: 1_000_000_000,
        targetBranch: "sandcastle/issue-1000000000",
      },
      idempotencyKey: "prepare-framed-launch-out-of-range",
    };
    writeFrame(child.stdin, outOfRangePreparation);
    const outOfRange = await readFrame(child.stdout);
    assert.equal(outOfRange.type, "launch.request.prepare.failure");
    assert.equal(outOfRange.code, "bounded_configuration_invalid");
    assert.equal(outOfRange.idempotentReplay, false);
    assert.equal(outOfRange.prohibitedSideEffects.delegatedWorkStarted, false);
    writeFrame(child.stdin, {
      ...outOfRangePreparation,
      requestId: "prepare-framed-launch-out-of-range-replay",
    });
    const outOfRangeReplay = await readFrame(child.stdout);
    assert.equal(outOfRangeReplay.code, "bounded_configuration_invalid");
    assert.equal(outOfRangeReplay.idempotentReplay, true);
    assert.equal(outOfRangeReplay.auditId, outOfRange.auditId);
    const retainedAfterOutOfRange = JSON.parse(
      await readFile(join(dataDir, "launch-requests.json"), "utf8"),
    );
    assert.equal(retainedAfterOutOfRange.launchRequests.length, 0);
    assert.equal(retainedAfterOutOfRange.preparationOutcomes.length, 2);
    assert.equal(retainedAfterOutOfRange.preparationOutcomes[1].response.code,
      "bounded_configuration_invalid");

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
    const staleDecisionRequest = {
      ...decisionRequest,
      requestId: "stale-framed-launch",
      idempotencyKey: "stale-framed-launch",
      expectedRevision: 0,
    };
    writeFrame(child.stdin, staleDecisionRequest);
    const stale = await readFrame(child.stdout);
    assert.equal(stale.type, "launch.request.decision.failure");
    assert.equal(stale.code, "mutation_revision_conflict");
    assert.equal(stale.actualRevision, 1);
    assert.equal(stale.current.revision, 1);
    assert.equal(stale.current.preview.secretFree, true);
    assert.equal(stale.idempotentReplay, false);

    writeFrame(child.stdin, {
      ...staleDecisionRequest,
      requestId: "stale-framed-launch-replay",
    });
    const staleReplay = await readFrame(child.stdout);
    assert.equal(staleReplay.code, "mutation_revision_conflict");
    assert.equal(staleReplay.idempotentReplay, true);
    assert.equal(staleReplay.auditId, stale.auditId);

    writeFrame(child.stdin, {
      ...staleDecisionRequest,
      requestId: "stale-framed-launch-conflict",
      expectedRevision: 1,
    });
    const staleKeyConflict = await readFrame(child.stdout);
    assert.equal(staleKeyConflict.code, "idempotency_key_conflict");
    assert.equal(staleKeyConflict.idempotentReplay, false);

    writeFrame(child.stdin, decisionRequest);
    const approved = await readFrame(child.stdout);
    assert.equal(approved.type, "launch.request.decision.result");
    assert.equal(approved.code, "launch_request_approved");
    assert.equal(approved.launchRequest.execution.status, "not_started");

    writeFrame(child.stdin, { ...decisionRequest, requestId: "approve-framed-launch-replay" });
    const replay = await readFrame(child.stdout);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.auditId, approved.auditId);

    writeFrame(child.stdin, {
      ...prepareRequest,
      requestId: "prepare-framed-launch-for-drift",
      idempotencyKey: "prepare-framed-launch-for-drift",
    });
    const preparedForDrift = await readFrame(child.stdout);
    assert.equal(preparedForDrift.type, "launch.request.prepare.result");
    const harnessState = JSON.parse(
      await readFile(join(dataDir, "harness-registry.json"), "utf8"),
    );
    const adapterPath = join(
      harnessState.harnesses[0].workspacePath,
      "adapters",
      "conformance.mjs",
    );
    const adapterSource = await readFile(adapterPath, "utf8");
    await execFileAsync("git", [
      "-C", harnessState.harnesses[0].workspacePath,
      "update-index", "--assume-unchanged", "--", "adapters/conformance.mjs",
    ]);
    await writeFile(adapterPath, `${adapterSource}\n// hidden material workspace drift\n`);
    assert.equal((await execFileAsync("git", [
      "-C", harnessState.harnesses[0].workspacePath,
      "status", "--porcelain",
    ])).stdout, "");
    writeFrame(child.stdin, {
      ...decisionRequest,
      requestId: "decide-framed-launch-after-drift",
      launchRequestId: preparedForDrift.launchRequest.launchRequestId,
      idempotencyKey: "decide-framed-launch-after-drift",
    });
    const changed = await readFrame(child.stdout);
    assert.equal(changed.type, "launch.request.decision.failure");
    assert.equal(changed.code, "launch_request_materially_changed");
    assert.equal(changed.current.status, "expired");
    assert.equal(changed.current.revision, 2);

    const retained = JSON.parse(await readFile(join(dataDir, "launch-requests.json"), "utf8"));
    assert.equal(retained.launchRequests.length, 2);
    assert.equal(retained.launchRequests[0].status, "approved");
    assert.equal(retained.launchRequests[0].revision, 2);
    assert.equal(retained.launchRequests[1].status, "expired");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
});
