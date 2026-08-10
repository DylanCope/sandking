import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const cliPath = join(process.cwd(), "src", "cli.mjs");
const hostModeCliPath = join(process.cwd(), "test", "host-mode-cli.mjs");
const localHostPath = join(process.cwd(), "src", "local-host.mjs");
/** @param {Buffer | string} value */
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const acceptedStateFiles = [
  "bootstrap-derivation-key",
  "controller-host-binding.json",
  "host-identity.json",
  "runtime-lifecycle.json",
];

/** @param {string} dataDir */
const readAcceptedProductState = async (dataDir) => {
  const files = Object.fromEntries(await Promise.all(acceptedStateFiles.map(async (file) => [
    file,
    await readFile(join(dataDir, file), "utf8"),
  ])));
  return {
    files,
    sha256: sha256(acceptedStateFiles.map((file) => `${file}\0${files[file]}`).join("\0")),
  };
};

test("the local Host replays the first identity mutation outcome for the same idempotency key", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-host-identity-mutation-"));
  const hostId = `host-${"1".repeat(24)}`;
  const controllerId = `runtime-${"2".repeat(24)}`;
  const child = spawn(process.execPath, [
    localHostPath,
    "--data-dir",
    dataDir,
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
    const acknowledgement = await readFrame(child.stdout);
    assert.equal(acknowledgement.type, "hello-ack");

    const mutation = {
      type: "host.identity.accept",
      requestId: "host-identity-first",
      hostId,
      authorizationClass: "controller_host_identity_binding",
      idempotencyKey: "host-identity-replay-key",
      expectedRevision: 0,
    };
    writeFrame(child.stdin, mutation);
    const first = await readFrame(child.stdout);
    assert.equal(first.type, "host.identity.result");
    assert.equal(first.idempotentReplay, false);
    assert.match(first.auditId, /^audit-/);

    writeFrame(child.stdin, { ...mutation, requestId: "host-identity-replay" });
    const replay = await readFrame(child.stdout);
    assert.deepEqual(replay, {
      ...first,
      requestId: "host-identity-replay",
      idempotentReplay: true,
    });

    writeFrame(child.stdin, {
      ...mutation,
      requestId: "host-identity-conflict",
      idempotencyKey: "host-identity-conflicting-key",
    });
    const conflict = await readFrame(child.stdout);
    assert.deepEqual(conflict, {
      type: "host.identity.failure",
      requestId: "host-identity-conflict",
      code: "idempotency_key_conflict",
      retryable: true,
      authorizationClass: "controller_host_identity_binding",
      idempotencyKeyHash: conflict.idempotencyKeyHash,
      expectedRevision: 0,
      actualRevision: 1,
      auditId: conflict.auditId,
    });
    assert.match(conflict.idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
    assert.match(conflict.auditId, /^audit-/);

    const identity = JSON.parse(await readFile(join(dataDir, "host-identity.json"), "utf8"));
    assert.equal(identity.hostId, hostId);
    assert.equal(identity.revision, 1);
    assert.equal(identity.auditId, first.auditId);
    const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(audits.filter((entry) => entry.action === "host.identity.accept").length, 3);
    assert.equal(audits[0].outcome, "accepted");
    assert.equal(audits[1].outcome, "observed");
    assert.equal(audits[1].details.originalAuditId, first.auditId);
    assert.equal(audits[2].auditId, conflict.auditId);
    assert.equal(audits[2].outcome, "rejected");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("malformed cancellation input is audited without disconnecting a healthy Host", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-host-cancellation-rejection-"));
  const hostId = `host-${"3".repeat(24)}`;
  const controllerId = `runtime-${"4".repeat(24)}`;
  const child = spawn(process.execPath, [
    localHostPath,
    "--data-dir",
    dataDir,
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
      requestId: "host-identity-for-cancellation-rejection",
      hostId,
      authorizationClass: "controller_host_identity_binding",
      idempotencyKey: "host-identity-for-cancellation-rejection",
      expectedRevision: 0,
    });
    assert.equal((await readFrame(child.stdout)).type, "host.identity.result");

    writeFrame(child.stdin, {
      type: "harness.run.cancel",
      requestId: "malformed-provider-cancellation",
      harnessRunId: "",
      controllerId,
      controllerSessionId: `controller-session-${"5".repeat(24)}`,
      source: "controller-cli",
      authorizationClass: "harness_run_cancellation",
      idempotencyKeyHash: "",
    });
    const rejected = await readFrame(child.stdout);
    assert.deepEqual(rejected, {
      type: "harness.run.cancel.failure",
      requestId: "malformed-provider-cancellation",
      code: "mutation_contract_invalid",
      retryable: false,
      authorizationClass: "harness_run_cancellation",
      idempotencyKeyHash: null,
      idempotentReplay: false,
      auditId: rejected.auditId,
      harnessRunId: null,
      prohibitedSideEffects: {
        cancellationAccepted: false,
        cooperativeSignalSent: false,
        forcedTerminationSent: false,
        projectWrite: false,
      },
    });
    assert.match(rejected.auditId, /^audit-[a-f0-9]{24}$/);

    writeFrame(child.stdin, { type: "ping", requestId: "host-still-connected" });
    assert.deepEqual(await readFrame(child.stdout), {
      type: "pong",
      requestId: "host-still-connected",
    });
    const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const rejectionAudit = audits.find((entry) => entry.auditId === rejected.auditId);
    assert.equal(rejectionAudit.action, "harness.run.cancel");
    assert.equal(rejectionAudit.outcome, "rejected");
    assert.equal(rejectionAudit.details.code, "mutation_contract_invalid");
    assert.deepEqual({
      cancellationAccepted: rejectionAudit.details.cancellationAccepted,
      cooperativeSignalSent: rejectionAudit.details.cooperativeSignalSent,
      forcedTerminationSent: rejectionAudit.details.forcedTerminationSent,
      projectWrite: rejectionAudit.details.projectWrite,
    }, rejected.prohibitedSideEffects);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

/** @param {string[]} args */
const runFailingCli = async (args) => {
  const boundedArgs = args[0] === "launch" && !args.includes("--startup-timeout-ms")
    ? [args[0], "--startup-timeout-ms", "60000", ...args.slice(1)]
    : args;
  try {
    const commandPath = args.includes("--host-mode") ? hostModeCliPath : cliPath;
    await execFileAsync(process.execPath, [commandPath, ...boundedArgs], {
      cwd: tmpdir(),
      env: process.env,
    });
    assert.fail("expected the command to fail");
  } catch (error) {
    assert.ok(error && typeof error === "object");
    return /** @type {{stdout: string, stderr: string}} */ (error);
  }
};

const failureCases = [
  ["controller-incompatible-major", {
    type: "host_negotiation_failure",
    code: "controller_protocol_major_mismatch",
    retryable: true,
    explanation: "The local Host rejected the Controller protocol major version as incompatible.",
    retryGuidance: "Install matching Sand-King Controller and Host releases, then retry the launch.",
  }],
  ["controller-unknown-required-capability", {
    type: "host_negotiation_failure",
    code: "controller_capability_unsupported",
    retryable: true,
    explanation: "The local Host rejected a required Controller capability.",
    retryGuidance: "Install compatible Sand-King Controller and Host releases, then retry the launch.",
  }],
  ["controller-schema-mismatch", {
    type: "host_negotiation_failure",
    code: "controller_schema_mismatch",
    retryable: true,
    explanation: "The local Host rejected the Controller control schema as incompatible.",
    retryGuidance: "Install matching Sand-King Controller and Host releases, then retry the launch.",
  }],
  ["incompatible-major", {
    type: "host_negotiation_failure",
    code: "host_protocol_major_mismatch",
    retryable: true,
    explanation: "The Controller and local Host use incompatible protocol major versions.",
    retryGuidance: "Install matching Sand-King Controller and Host releases, then retry the launch.",
  }],
  ["unexpected-identity", {
    type: "host_negotiation_failure",
    code: "host_identity_mismatch",
    retryable: true,
    explanation: "The local Host reported an unexpected identity.",
    retryGuidance: "Verify the local Host installation and expected identity, then retry the launch.",
  }],
  ["unknown-required-capability", {
    type: "host_negotiation_failure",
    code: "host_capability_unsupported",
    retryable: true,
    explanation: "The Controller and local Host could not agree on required capabilities.",
    retryGuidance: "Install compatible Sand-King Controller and Host releases, then retry the launch.",
  }],
  ["malformed-frame", {
    type: "host_negotiation_failure",
    code: "host_protocol_invalid_frame",
    retryable: true,
    explanation: "The local Host sent malformed framed protocol data during negotiation.",
    retryGuidance: "Restart or update the local Host, then retry the launch.",
  }],
];

test("a clean incompatible Host launch does not accept either durable identity", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-clean-host-failure-"));

  try {
    const commandFailure = await runFailingCli([
      "launch",
      "--data-dir",
      dataDir,
      "--host-mode",
      "incompatible-major",
      "--idempotency-key",
      "clean-incompatible-host",
      "--expected-revision",
      "0",
      "--json",
      "--no-open",
    ]);
    const publicOutcome = JSON.parse(commandFailure.stdout);

    assert.equal(publicOutcome.diagnosis.code, "host_protocol_major_mismatch");
    await assert.rejects(access(join(dataDir, "host-identity.json")));
    await assert.rejects(access(join(dataDir, "controller-host-binding.json")));
    await assert.rejects(access(join(dataDir, "runtime-lifecycle.json")));
    await assert.rejects(access(join(dataDir, "runtime-state.json")));
    if (process.env.SANDKING_ACCEPTANCE_RESULT_DIR) {
      const productStateFiles = [
        "host-identity.json",
        "controller-host-binding.json",
        "runtime-lifecycle.json",
        "runtime-state.json",
      ];
      const presentFiles = (await Promise.all(productStateFiles.map(async (file) => [
        file,
        await access(join(dataDir, file)).then(() => true, () => false),
      ]))).filter(([, present]) => present).map(([file]) => file);
      const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      await mkdir(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, "clean-host-incompatible-major.json"),
        `${JSON.stringify({
          kind: "clean_host_negotiation_failure",
          mode: "incompatible-major",
          diagnosis: publicOutcome.diagnosis,
          productStateFiles,
          presentFiles,
          acceptedIdentityStateCreated: presentFiles.length > 0,
          auditReferences: audits.map((entry) => ({
            auditId: entry.auditId,
            action: entry.action,
            outcome: entry.outcome,
            details: entry.details,
          })),
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

for (const [mode, expectedDiagnosis] of failureCases) {
  test(`${mode} Host negotiation returns a typed diagnosis before readiness`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sandking-host-failure-"));

    try {
      const acceptedLaunch = JSON.parse((await execFileAsync(process.execPath, [
        cliPath,
        "launch",
        "--startup-timeout-ms", "60000",
        "--data-dir",
        dataDir,
        "--json",
        "--no-open",
      ], { cwd: tmpdir(), env: process.env })).stdout);
      await execFileAsync(process.execPath, [cliPath, "stop", "--data-dir", dataDir, "--json"], {
        cwd: tmpdir(),
        env: process.env,
      });
      const acceptedStateBefore = await readAcceptedProductState(dataDir);

      const commandFailure = await runFailingCli([
        "launch",
        "--data-dir",
        dataDir,
        "--host-mode",
        mode,
        "--idempotency-key",
        `mismatch-${mode}`,
        "--expected-revision",
        "2",
        "--json",
        "--no-open",
      ]);
      assert.equal(commandFailure.stderr, "");
      const publicOutcome = JSON.parse(commandFailure.stdout);
      assert.equal(publicOutcome.ok, false);
      assert.match(publicOutcome.diagnosis.auditId, /^audit-/);
      assert.deepEqual(
        { ...publicOutcome.diagnosis, auditId: "<audit-id>" },
        { ...expectedDiagnosis, auditId: "<audit-id>" },
      );

      const acceptedStateAfter = await readAcceptedProductState(dataDir);
      assert.deepEqual(acceptedStateAfter.files, acceptedStateBefore.files);
      assert.equal(acceptedStateAfter.sha256, acceptedStateBefore.sha256);
      assert.equal(
        JSON.parse(acceptedStateAfter.files["host-identity.json"]).hostId,
        acceptedLaunch.host.hostId,
      );
      await assert.rejects(access(join(dataDir, "runtime-state.json")));
      const retained = JSON.parse(
        await readFile(join(dataDir, "last-startup-error.json"), "utf8"),
      );
      assert.deepEqual(
        { ...retained, recordedAt: "<timestamp>" },
        { ...publicOutcome.diagnosis, recordedAt: "<timestamp>" },
      );
      assert.match(retained.recordedAt, /^\d{4}-\d{2}-\d{2}T/);
      const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      const negotiationAudit = audits.find((entry) =>
        entry.auditId === publicOutcome.diagnosis.auditId);
      assert.equal(negotiationAudit.auditId, publicOutcome.diagnosis.auditId);
      assert.equal(negotiationAudit.details.code, expectedDiagnosis.code);
      if (mode === "unexpected-identity") {
        assert.equal(negotiationAudit.details.expectedHostIdentity, "local-host");
        assert.match(negotiationAudit.details.expectedHostId, /^host-[a-f0-9]{24}$/);
        assert.equal(negotiationAudit.details.observedHostId, `host-${"0".repeat(24)}`);
        assert.notEqual(
          negotiationAudit.details.observedHostId,
          negotiationAudit.details.expectedHostId,
        );
      }
      if (process.env.SANDKING_ACCEPTANCE_RESULT_DIR) {
        const runtimeStatePresent = await access(join(dataDir, "runtime-state.json"))
          .then(() => true, () => false);
        const acceptedStatePreserved = acceptedStateBefore.sha256 === acceptedStateAfter.sha256;
        await mkdir(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(
          join(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, `host-${mode}.json`),
          `${JSON.stringify({
            kind: "host_negotiation_failure",
            mode,
            diagnosis: publicOutcome.diagnosis,
            acceptedState: {
              files: acceptedStateFiles,
              beforeSha256: acceptedStateBefore.sha256,
              afterSha256: acceptedStateAfter.sha256,
              preserved: acceptedStatePreserved,
            },
            runtimeStatePresent,
            mutationOccurred: !acceptedStatePreserved || runtimeStatePresent,
            auditReferences: audits.map((entry) => ({
              auditId: entry.auditId,
              action: entry.action,
              outcome: entry.outcome,
              details: entry.details,
            })),
          }, null, 2)}\n`,
          { mode: 0o600 },
        );
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}

test("replacing an accepted Host identity produces a typed hard stop without rewriting the binding", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-host-binding-failure-"));

  try {
    const acceptedLaunch = JSON.parse((await execFileAsync(process.execPath, [
      cliPath,
      "launch",
      "--startup-timeout-ms", "60000",
      "--data-dir",
      dataDir,
      "--json",
      "--no-open",
    ], { cwd: tmpdir(), env: process.env })).stdout);
    await execFileAsync(process.execPath, [cliPath, "stop", "--data-dir", dataDir, "--json"], {
      cwd: tmpdir(),
      env: process.env,
    });
    const replacementHostId = `host-${"f".repeat(24)}`;
    assert.notEqual(replacementHostId, acceptedLaunch.host.hostId);
    await writeFile(join(dataDir, "host-identity.json"), `${JSON.stringify({
      hostId: replacementHostId,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    const acceptedStateBefore = await readAcceptedProductState(dataDir);

    const commandFailure = await runFailingCli([
      "launch",
      "--data-dir",
      dataDir,
      "--idempotency-key",
      "replaced-host-identity-failure",
      "--expected-revision",
      "2",
      "--json",
      "--no-open",
    ]);
    const publicOutcome = JSON.parse(commandFailure.stdout);
    assert.equal(publicOutcome.diagnosis.code, "controller_host_identity_mismatch");
    const acceptedStateAfter = await readAcceptedProductState(dataDir);
    assert.deepEqual(acceptedStateAfter.files, acceptedStateBefore.files);
    assert.equal(acceptedStateAfter.sha256, acceptedStateBefore.sha256);
    assert.equal(
      JSON.parse(acceptedStateAfter.files["controller-host-binding.json"]).hostId,
      acceptedLaunch.host.hostId,
    );
    await assert.rejects(access(join(dataDir, "runtime-state.json")));

    if (process.env.SANDKING_ACCEPTANCE_RESULT_DIR) {
      const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      await mkdir(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, "host-controller-host-identity-replacement.json"),
        `${JSON.stringify({
          kind: "host_negotiation_failure",
          mode: "accepted-host-identity-replacement",
          diagnosis: publicOutcome.diagnosis,
          acceptedState: {
            files: acceptedStateFiles,
            beforeSha256: acceptedStateBefore.sha256,
            afterSha256: acceptedStateAfter.sha256,
            preserved: acceptedStateBefore.sha256 === acceptedStateAfter.sha256,
          },
          runtimeStatePresent: false,
          mutationOccurred: acceptedStateBefore.sha256 !== acceptedStateAfter.sha256,
          auditReferences: audits.map((entry) => ({
            auditId: entry.auditId,
            action: entry.action,
            outcome: entry.outcome,
            details: entry.details,
          })),
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Controller credentials are not inherited by the local Host process", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-host-env-"));
  const secret = "controller-secret-must-not-cross-host-boundary";

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      hostModeCliPath,
      "launch",
      "--startup-timeout-ms", "60000",
      "--data-dir",
      dataDir,
      "--host-mode",
      "secret-probe",
      "--json",
      "--no-open",
    ], {
      cwd: tmpdir(),
      env: { ...process.env, SANDKING_CONTROLLER_SECRET: secret },
    });
    const launch = JSON.parse(stdout);
    assert.equal(launch.host.identity, "local-host");
    assert.match(launch.host.hostId, /^host-[a-f0-9]{24}$/);
    assert.doesNotMatch(stdout, new RegExp(secret));
    if (process.env.SANDKING_ACCEPTANCE_RESULT_DIR) {
      await mkdir(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, { recursive: true, mode: 0o700 });
      await writeFile(
        join(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, "host-credential-boundary.json"),
        `${JSON.stringify({
          kind: "host_credential_boundary",
          mode: "secret-probe",
          observedHostIdentity: launch.host.identity,
          controllerSecretForwarded: launch.host.identity === "controller-secret-leaked",
          negotiationAuditId: launch.audit.negotiationId,
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  } finally {
    await execFileAsync(process.execPath, [cliPath, "stop", "--data-dir", dataDir, "--json"], {
      cwd: tmpdir(),
      env: process.env,
    }).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});
