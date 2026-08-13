import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  HOST_SCHEMA_DIGEST,
  MAX_BULK_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  ProtocolError,
  hostCapabilities,
  protocolVersion,
  readFrame,
  readProtocolFrame,
  releaseVersion,
  writeBulkFrame,
  writeFrame,
} from "../src/protocol.mjs";

/** @param {unknown} payload */
const encodeControlFrame = (payload) => {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(5);
  header.writeUInt32BE(body.length + 1, 0);
  header.writeUInt8(1, 4);
  return Buffer.concat([header, body]);
};

test("framed control reads preserve following frames and validate their schema", async () => {
  const stream = new PassThrough();
  writeFrame(stream, { type: "ping", requestId: "request-1" });
  writeFrame(stream, { type: "ping", requestId: "request-2" });

  assert.deepEqual(await readFrame(stream), { type: "ping", requestId: "request-1" });
  assert.deepEqual(await readFrame(stream), { type: "ping", requestId: "request-2" });

  assert.throws(
    () => writeFrame(stream, { type: "not-a-protocol-message" }),
    (error) => error instanceof ProtocolError && error.code === "frame_schema_invalid",
  );
});

test("Host identity acceptance is an explicit revisioned and idempotent mutation outcome", async () => {
  const stream = new PassThrough();
  const hostId = `host-${"1".repeat(24)}`;
  const request = {
    type: "host.identity.accept",
    requestId: "host-identity-request-1",
    hostId,
    authorizationClass: "controller_host_identity_binding",
    idempotencyKey: "host-identity-idempotency-key-1",
    expectedRevision: 0,
  };
  const outcome = {
    type: "host.identity.result",
    requestId: request.requestId,
    code: "host_identity_accepted",
    authorizationClass: request.authorizationClass,
    idempotencyKeyHash: `sha256:${"2".repeat(64)}`,
    expectedRevision: 0,
    revision: 1,
    idempotentReplay: false,
    hostId,
    auditId: `audit-${"3".repeat(24)}`,
  };

  writeFrame(stream, request);
  writeFrame(stream, outcome);
  assert.deepEqual(await readFrame(stream), request);
  assert.deepEqual(await readFrame(stream), outcome);
  assert.throws(
    () => writeFrame(stream, { type: "host.identity.accept", requestId: "missing-contract" }),
    (error) => error instanceof ProtocolError && error.code === "frame_schema_invalid",
  );
});

test("Harness launch is one capability-negotiated revision-free Host operation", async () => {
  assert.ok(hostCapabilities.includes("sandking.harness-run.launch.v2"));
  assert.ok(!hostCapabilities.includes("sandking.launch-request.v1"));
  const stream = new PassThrough();
  const launch = {
    type: "harness.run.launch",
    requestId: "launch-harness-run-protocol-request",
    projectId: `project-${"2".repeat(24)}`,
    parameters: {
      issueNumber: 152,
      targetBranch: "sandcastle/issue-152",
    },
    controllerId: `runtime-${"3".repeat(24)}`,
    controllerSessionId: `controller-session-${"4".repeat(24)}`,
    source: "controller-cli",
    authorizationClass: "harness_run_launch",
    idempotencyKeyHash: `sha256:${"5".repeat(64)}`,
  };

  writeFrame(stream, launch);
  assert.deepEqual(await readFrame(stream), launch);
  const { parameters: omittedParameters, ...parameterlessLaunch } = launch;
  void omittedParameters;
  writeFrame(stream, parameterlessLaunch);
  assert.deepEqual(await readFrame(stream), parameterlessLaunch);
  assert.equal("expectedRevision" in launch, false);
  assert.throws(
    () => writeFrame(stream, {
      ...launch,
      idempotencyKeyHash: undefined,
      idempotencyKey: "recognizable-raw-launch-retry-key",
    }),
    (error) => error instanceof ProtocolError && error.code === "frame_schema_invalid",
  );
  assert.throws(
    () => writeFrame(stream, {
      ...launch,
      type: "launch.request.prepare",
    }),
    (error) => error instanceof ProtocolError && error.code === "frame_schema_invalid",
  );
  assert.throws(
    () => writeFrame(stream, { ...launch, type: "launch.request.decision" }),
    (error) => error instanceof ProtocolError && error.code === "frame_schema_invalid",
  );
  assert.throws(
    () => writeFrame(stream, { ...launch, type: "harness.run.start" }),
    (error) => error instanceof ProtocolError && error.code === "frame_schema_invalid",
  );
});

test("Project registration resolution is explicit, revisioned, and capability-negotiated", async () => {
  assert.ok(hostCapabilities.includes("sandking.project-registration-resolution.v1"));
  const stream = new PassThrough();
  const registerAsNew = {
    type: "project.register",
    requestId: "register-moved-project-as-new",
    path: "/projects/moved-project",
    configuration: {
      issueWorkflow: { provider: "github", kind: "issues" },
      checks: [{ checkId: "test", command: "npm test" }],
    },
    resolutionAction: "register_as_new",
    authorizationClass: "host_local_project_registration",
    idempotencyKey: "register-moved-project-as-new",
    expectedRevision: 2,
  };
  const forget = {
    type: "project.registration.forget",
    requestId: "forget-project-registration",
    projectId: `project-${"2".repeat(24)}`,
    authorizationClass: "host_local_project_registration",
    idempotencyKey: "forget-project-registration",
    expectedRevision: 2,
  };
  writeFrame(stream, registerAsNew);
  writeFrame(stream, forget);
  assert.deepEqual(await readFrame(stream), registerAsNew);
  assert.deepEqual(await readFrame(stream), forget);
  assert.throws(
    () => writeFrame(stream, { ...registerAsNew, resolutionAction: "infer_moved_project" }),
    (error) => error instanceof ProtocolError && error.code === "frame_schema_invalid",
  );
});

test("Harness cancellation is a capability-negotiated revision-free Host operation", async () => {
  assert.ok(hostCapabilities.includes("sandking.harness-run.cancel.v1"));
  const stream = new PassThrough();
  const harnessRunId = `harness-run-${"6".repeat(24)}`;
  const cancellation = {
    type: "harness.run.cancel",
    requestId: "cancel-harness-run-protocol-request",
    harnessRunId,
    controllerId: `runtime-${"3".repeat(24)}`,
    controllerSessionId: `controller-session-${"4".repeat(24)}`,
    source: "controller-cli",
    authorizationClass: "harness_run_cancellation",
    idempotencyKeyHash: `sha256:${"5".repeat(64)}`,
  };
  const accepted = {
    type: "harness.run.cancel.result",
    requestId: cancellation.requestId,
    code: "harness_run_cancellation_accepted",
    authorizationClass: cancellation.authorizationClass,
    idempotencyKeyHash: cancellation.idempotencyKeyHash,
    idempotentReplay: false,
    auditId: `audit-${"7".repeat(24)}`,
    harnessRunId,
    acceptedAt: "2026-08-07T10:00:00.000Z",
    cooperativeDeadlineAt: "2026-08-07T10:00:01.000Z",
  };
  const rejected = {
    type: "harness.run.cancel.failure",
    requestId: "cancel-harness-run-terminal",
    code: "harness_run_not_cancellable",
    retryable: false,
    authorizationClass: cancellation.authorizationClass,
    idempotencyKeyHash: `sha256:${"8".repeat(64)}`,
    idempotentReplay: false,
    auditId: `audit-${"9".repeat(24)}`,
    harnessRunId,
    prohibitedSideEffects: {
      cancellationAccepted: false,
      cooperativeSignalSent: false,
      forcedTerminationSent: false,
      projectWrite: false,
    },
  };

  for (const message of [cancellation, accepted, rejected]) {
    writeFrame(stream, message);
    assert.deepEqual(await readFrame(stream), message);
  }
  assert.equal("expectedRevision" in cancellation, false);
  assert.throws(
    () => writeFrame(stream, {
      ...cancellation,
      idempotencyKeyHash: undefined,
      idempotencyKey: "recognizable-raw-cancellation-retry-key",
    }),
    (error) => error instanceof ProtocolError && error.code === "frame_schema_invalid",
  );
});

test("Harness recovery is capability-negotiated, bounded, keyed, and revision-free", async () => {
  assert.ok(hostCapabilities.includes("sandking.harness-run.recovery.v1"));
  const stream = new PassThrough();
  const harnessRunId = `harness-run-${"6".repeat(24)}`;
  const recovery = {
    type: "harness.run.recover",
    requestId: "recover-harness-run-protocol-request",
    harnessRunId,
    action: "recheck",
    controllerId: `runtime-${"3".repeat(24)}`,
    controllerSessionId: `controller-session-${"4".repeat(24)}`,
    source: "controller-cli",
    authorizationClass: "harness_run_recovery",
    idempotencyKeyHash: `sha256:${"5".repeat(64)}`,
  };
  const rejected = {
    type: "harness.run.recover.failure",
    requestId: "recover-harness-run-unavailable-action",
    code: "harness_recovery_action_not_available",
    retryable: false,
    authorizationClass: recovery.authorizationClass,
    idempotencyKeyHash: recovery.idempotencyKeyHash,
    idempotentReplay: false,
    auditId: `audit-${"7".repeat(24)}`,
    harnessRunId,
    action: "terminate_confirmed_tree",
    prohibitedSideEffects: {
      recoveryChanged: false,
      processSignalRequested: false,
      terminalOutcomeCreated: false,
      replacementRunStarted: false,
      projectWrite: false,
    },
  };
  const lookup = {
    type: "harness.run.recovery.lookup",
    requestId: "lookup-harness-run-recovery-protocol",
    idempotencyKeyHash: recovery.idempotencyKeyHash,
  };
  const absent = {
    type: "harness.run.recovery.lookup.result",
    requestId: lookup.requestId,
    code: "harness_recovery_outcome_absent",
    idempotencyKeyHash: lookup.idempotencyKeyHash,
    found: false,
    pending: false,
    recoveryOutcome: null,
  };

  for (const message of [recovery, rejected, lookup, absent]) {
    writeFrame(stream, message);
    assert.deepEqual(await readFrame(stream), message);
  }
  assert.equal("expectedRevision" in recovery, false);
  assert.throws(
    () => writeFrame(stream, {
      ...recovery,
      action: "signal-pid",
    }),
    (error) => error instanceof ProtocolError && error.code === "frame_schema_invalid",
  );
  assert.throws(
    () => writeFrame(stream, {
      ...recovery,
      idempotencyKeyHash: undefined,
      idempotencyKey: "recognizable-raw-recovery-key",
    }),
    (error) => error instanceof ProtocolError && error.code === "frame_schema_invalid",
  );
});

test("Harness-run lookup, cursor observation, and ranged logs are typed Host operations", async () => {
  assert.ok(hostCapabilities.includes("sandking.harness-run.v2"));
  assert.ok(hostCapabilities.includes("sandking.harness-run-reconciliation.v1"));
  const stream = new PassThrough();
  const harnessRunId = `harness-run-${"1".repeat(24)}`;
  const lookup = {
    type: "harness.run.lookup",
    requestId: "lookup-harness-run-protocol",
    idempotencyKeyHash: `sha256:${"2".repeat(64)}`,
  };
  const observe = {
    type: "harness.run.observe",
    requestId: "observe-harness-run-protocol",
    harnessRunId,
    afterSequence: 3,
  };
  const logs = {
    type: "harness.run.logs.get",
    requestId: "read-harness-run-logs-protocol",
    harnessRunId,
    producer: "stderr",
    offset: 12,
    limit: 1_024,
  };
  for (const message of [lookup, observe, logs]) {
    writeFrame(stream, message);
  }
  assert.deepEqual(await readFrame(stream), lookup);
  assert.deepEqual(await readFrame(stream), observe);
  assert.deepEqual(await readFrame(stream), logs);
  assert.throws(
    () => writeFrame(stream, { ...logs, limit: MAX_BULK_CHUNK_BYTES + 1 }),
    (error) => error instanceof ProtocolError && error.code === "frame_schema_invalid",
  );
});

test("wire-level protocol errors include sanitized explanations and retry guidance", async () => {
  const stream = new PassThrough();
  const diagnosis = {
    type: "protocol-error",
    code: "controller_protocol_major_mismatch",
    retryable: true,
    explanation: "The Host rejected an incompatible Controller protocol major version.",
    retryGuidance: "Install matching Sand-King Controller and Host releases, then retry.",
  };

  writeFrame(stream, diagnosis);
  assert.deepEqual(await readFrame(stream), diagnosis);
  assert.throws(
    () => writeFrame(stream, {
      type: "protocol-error",
      code: diagnosis.code,
      retryable: true,
    }),
    (error) => error instanceof ProtocolError && error.code === "frame_schema_invalid",
  );
});

test("same-major control frames ignore additive optional fields", async () => {
  const stream = new PassThrough();
  const futureSameMajorProtocol = {
    major: protocolVersion.major,
    minor: protocolVersion.minor + 1,
    patch: 0,
    version: `${protocolVersion.major}.${protocolVersion.minor + 1}.0`,
  };
  const acknowledgement = {
    type: "hello-ack",
    protocol: { ...futureSameMajorProtocol, optionalRevisionLabel: "future-compatible" },
    release: releaseVersion,
    identity: "local-host",
    hostId: `host-${"1".repeat(24)}`,
    peerIdentity: "controller-runtime",
    peerControllerId: `runtime-${"2".repeat(24)}`,
    capabilities: {
      required: ["sandking.control.slice-1"],
      optional: ["sandking.bulk-stream.v1"],
      optionalCapabilityMetadata: "future-compatible",
    },
    negotiatedCapabilities: [...hostCapabilities],
    schemaDigest: HOST_SCHEMA_DIGEST,
    framing: {
      maxFrameBytes: MAX_FRAME_BYTES,
      maxBulkChunkBytes: MAX_BULK_CHUNK_BYTES,
      optionalWindowBytes: 4_096,
    },
    observationCursor: "host:origin",
    optionalHostMetadata: { build: "future-compatible" },
  };
  stream.end(encodeControlFrame(acknowledgement));

  assert.deepEqual(await readFrame(stream), {
    type: "hello-ack",
    protocol: futureSameMajorProtocol,
    release: releaseVersion,
    identity: "local-host",
    hostId: `host-${"1".repeat(24)}`,
    peerIdentity: "controller-runtime",
    peerControllerId: `runtime-${"2".repeat(24)}`,
    capabilities: {
      required: ["sandking.control.slice-1"],
      optional: ["sandking.bulk-stream.v1"],
    },
    negotiatedCapabilities: [...hostCapabilities],
    schemaDigest: HOST_SCHEMA_DIGEST,
    framing: {
      maxFrameBytes: MAX_FRAME_BYTES,
      maxBulkChunkBytes: MAX_BULK_CHUNK_BYTES,
    },
    observationCursor: "host:origin",
  });
});

test("framing rejects oversized and malformed frames before buffering their bodies", async () => {
  const oversized = new PassThrough();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME_BYTES + 1);
  oversized.end(header);

  await assert.rejects(
    readProtocolFrame(oversized),
    (error) => error instanceof ProtocolError && error.code === "frame_size_invalid",
  );

  const malformed = new PassThrough();
  const malformedBody = Buffer.from([1, ...Buffer.from("{not-json", "utf8")]);
  const malformedHeader = Buffer.alloc(4);
  malformedHeader.writeUInt32BE(malformedBody.length);
  malformed.end(Buffer.concat([malformedHeader, malformedBody]));

  await assert.rejects(
    readProtocolFrame(malformed),
    (error) => error instanceof ProtocolError && error.code === "frame_json_invalid",
  );
});

test("opaque bulk frames use a distinct bounded binary channel", async () => {
  const stream = new PassThrough();
  const opaque = Buffer.from([0, 255, 17, 42]);
  writeBulkFrame(stream, {
    streamId: "terminal-1",
    sequence: 7,
    eof: false,
    data: opaque,
  });

  const frame = await readProtocolFrame(stream);
  assert.equal(frame.channel, "bulk");
  assert.equal(frame.streamId, "terminal-1");
  assert.equal(frame.sequence, 7);
  assert.equal(frame.eof, false);
  assert.deepEqual(frame.data, opaque);

  assert.throws(
    () => writeBulkFrame(stream, {
      streamId: "terminal-1",
      sequence: 8,
      eof: true,
      data: Buffer.alloc(MAX_BULK_CHUNK_BYTES + 1),
    }),
    (error) => error instanceof ProtocolError && error.code === "bulk_chunk_too_large",
  );
});
