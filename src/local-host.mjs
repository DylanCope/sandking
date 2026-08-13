#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runtimeIdPattern } from "./common/identifiers.mjs";
import {
  HOST_SCHEMA_DIGEST,
  MAX_BULK_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  ProtocolError,
  hostCapabilities,
  protocolVersion,
  protocolErrorForCode,
  readFrame,
  readProtocolFrame,
  releaseVersion,
  writeBulkFrame,
  writeFrame,
} from "./protocol.mjs";
import { acceptHostIdentity, readHostIdentity } from "./host-identity.mjs";
import { appendPrivateJsonLine } from "./private-state.mjs";
import { createProjectRegistry } from "./project-registration.mjs";
import { createHarnessRunManager, HarnessRunStateError } from "./harness-runs.mjs";

/** @param {string[]} argv */
const parseArgs = (argv) => {
  let dataDir = process.cwd();
  let allowHostIdentityCreate = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--data-dir") {
      if (!argv[index + 1]) throw new Error("host_data_dir_missing");
      dataDir = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--allow-host-identity-create") {
      allowHostIdentityCreate = true;
    } else {
      throw new Error("host_option_unsupported");
    }
  }
  return { dataDir, allowHostIdentityCreate };
};

const { dataDir, allowHostIdentityCreate } = parseArgs(process.argv.slice(2));
const hostAuditPath = join(dataDir, "audit.jsonl");

/** @param {"accepted" | "rejected" | "observed"} outcome @param {Record<string, unknown>} details @param {string} [auditId] */
const recordHostIdentityAudit = async (outcome, details, auditId) => {
  const resolvedAuditId = auditId ?? `audit-${randomBytes(12).toString("hex")}`;
  await appendPrivateJsonLine(hostAuditPath, {
    auditId: resolvedAuditId,
    action: "host.identity.accept",
    outcome,
    details,
    recordedAt: new Date().toISOString(),
  });
  return resolvedAuditId;
};

const recordedProjectAudits = new Map();
let recordedProjectAuditIdsLoaded = false;
let projectAuditQueue = Promise.resolve();

const loadRecordedProjectAuditIds = async () => {
  if (recordedProjectAuditIdsLoaded) return;
  const source = await readFile(hostAuditPath, "utf8").catch((error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  for (const line of source.split("\n")) {
    if (!line) continue;
    try {
      const audit = JSON.parse(line);
      if (typeof audit?.auditId === "string") recordedProjectAudits.set(audit.auditId, audit);
    } catch {
      // A malformed historical line is not a match for a reserved audit ID.
    }
  }
  recordedProjectAuditIdsLoaded = true;
};

/** @param {string} action @param {"accepted" | "rejected" | "observed"} outcome @param {Record<string, unknown>} details @param {string} [auditId] */
const recordProjectAudit = (action, outcome, details = {}, auditId) => {
  const operation = projectAuditQueue.catch(() => undefined).then(async () => {
    if (auditId) {
      await loadRecordedProjectAuditIds();
      const existing = recordedProjectAudits.get(auditId);
      if (existing) {
        if (!isDeepStrictEqual({
          action: existing.action,
          outcome: existing.outcome,
          details: existing.details,
        }, { action, outcome, details })) {
          throw new Error("audit_id_conflict");
        }
        return auditId;
      }
    }
    const resolvedAuditId = auditId ?? `audit-${randomBytes(12).toString("hex")}`;
    await appendPrivateJsonLine(hostAuditPath, {
      auditId: resolvedAuditId,
      action,
      outcome,
      details,
      recordedAt: new Date().toISOString(),
    });
    recordedProjectAudits.set(resolvedAuditId, {
      auditId: resolvedAuditId,
      action,
      outcome,
      details,
    });
    return resolvedAuditId;
  });
  projectAuditQueue = operation.then(() => undefined, () => undefined);
  return operation;
};

/**
 * @param {
 *   | "controller_identity_invalid"
 *   | "controller_host_identity_mismatch"
 *   | "controller_protocol_major_mismatch"
 *   | "controller_capability_unsupported"
 *   | "controller_schema_mismatch"
 *   | "host_protocol_unexpected_message"
 * } code
 */
const rejectHandshake = (code) => {
  writeFrame(process.stdout, protocolErrorForCode(code));
};

/** @param {Extract<import("zod").infer<typeof import("./protocol.mjs").controlMessageSchema>, {type: "host.identity.accept"}>} identityRequest @param {string} negotiatedHostId */
const handleHostIdentityAcceptance = async (identityRequest, negotiatedHostId) => {
  const idempotencyKeyHash = `sha256:${createHash("sha256")
    .update(identityRequest.idempotencyKey)
    .digest("hex")}`;
  const latestIdentity = await readHostIdentity(dataDir);
  const actualRevision = latestIdentity && "revision" in latestIdentity
    ? latestIdentity.revision
    : latestIdentity
      ? 1
      : 0;
  const auditDetails = {
    authorizationClass: identityRequest.authorizationClass,
    idempotencyKeyHash,
    expectedRevision: identityRequest.expectedRevision,
    actualRevision,
    hostId: identityRequest.hostId,
  };

  if (identityRequest.hostId !== negotiatedHostId) {
    const auditId = await recordHostIdentityAudit("rejected", {
      ...auditDetails,
      code: "host_identity_mismatch",
    });
    writeFrame(process.stdout, {
      type: "host.identity.failure",
      requestId: identityRequest.requestId,
      code: "host_identity_mismatch",
      retryable: true,
      authorizationClass: identityRequest.authorizationClass,
      idempotencyKeyHash,
      expectedRevision: identityRequest.expectedRevision,
      actualRevision,
      auditId,
    });
    return;
  }

  if (
    latestIdentity
    && "idempotencyKeyHash" in latestIdentity
    && latestIdentity.idempotencyKeyHash === idempotencyKeyHash
    && "expectedRevision" in latestIdentity
    && latestIdentity.expectedRevision === identityRequest.expectedRevision
    && "revision" in latestIdentity
    && "auditId" in latestIdentity
  ) {
    await recordHostIdentityAudit("observed", {
      ...auditDetails,
      resultingRevision: latestIdentity.revision,
      idempotentReplay: true,
      originalAuditId: latestIdentity.auditId,
    });
    writeFrame(process.stdout, {
      type: "host.identity.result",
      requestId: identityRequest.requestId,
      code: "host_identity_accepted",
      authorizationClass: identityRequest.authorizationClass,
      idempotencyKeyHash,
      expectedRevision: identityRequest.expectedRevision,
      revision: latestIdentity.revision,
      idempotentReplay: true,
      hostId: latestIdentity.hostId,
      auditId: latestIdentity.auditId,
    });
    return;
  }

  if (latestIdentity) {
    const code = "idempotencyKeyHash" in latestIdentity
      && latestIdentity.idempotencyKeyHash !== idempotencyKeyHash
      ? "idempotency_key_conflict"
      : "mutation_revision_conflict";
    const auditId = await recordHostIdentityAudit("rejected", { ...auditDetails, code });
    writeFrame(process.stdout, {
      type: "host.identity.failure",
      requestId: identityRequest.requestId,
      code,
      retryable: true,
      authorizationClass: identityRequest.authorizationClass,
      idempotencyKeyHash,
      expectedRevision: identityRequest.expectedRevision,
      actualRevision,
      auditId,
    });
    return;
  }

  if (identityRequest.expectedRevision !== actualRevision) {
    const auditId = await recordHostIdentityAudit("rejected", {
      ...auditDetails,
      code: "mutation_revision_conflict",
    });
    writeFrame(process.stdout, {
      type: "host.identity.failure",
      requestId: identityRequest.requestId,
      code: "mutation_revision_conflict",
      retryable: true,
      authorizationClass: identityRequest.authorizationClass,
      idempotencyKeyHash,
      expectedRevision: identityRequest.expectedRevision,
      actualRevision,
      auditId,
    });
    return;
  }

  const auditId = `audit-${randomBytes(12).toString("hex")}`;
  const acceptedIdentity = await acceptHostIdentity(dataDir, negotiatedHostId, {
    authorizationClass: identityRequest.authorizationClass,
    idempotencyKeyHash,
    expectedRevision: 0,
    revision: 1,
    auditId,
  });
  await recordHostIdentityAudit("accepted", {
    ...auditDetails,
    resultingRevision: 1,
  }, auditId);
  writeFrame(process.stdout, {
    type: "host.identity.result",
    requestId: identityRequest.requestId,
    code: "host_identity_accepted",
    authorizationClass: identityRequest.authorizationClass,
    idempotencyKeyHash,
    expectedRevision: identityRequest.expectedRevision,
    revision: 1,
    idempotentReplay: false,
    hostId: acceptedIdentity.hostId,
    auditId,
  });
};

const main = async () => {
  const hello = await readFrame(process.stdin);
  if (hello.type !== "hello") {
    rejectHandshake("host_protocol_unexpected_message");
    return;
  }

  if (
    hello.identity !== "controller-runtime"
    || !runtimeIdPattern.test(hello.controllerId)
    || hello.expectedPeerIdentity !== "local-host"
  ) {
    rejectHandshake("controller_identity_invalid");
    return;
  }
  const persistedHostIdentity = await readHostIdentity(dataDir);
  if (!persistedHostIdentity && !allowHostIdentityCreate) {
    rejectHandshake("controller_host_identity_mismatch");
    return;
  }
  const negotiatedHostId = persistedHostIdentity?.hostId ?? hello.expectedHostId;
  if (hello.expectedHostId !== negotiatedHostId) {
    rejectHandshake("controller_host_identity_mismatch");
    return;
  }
  if (hello.protocol.major !== protocolVersion.major) {
    rejectHandshake("controller_protocol_major_mismatch");
    return;
  }
  if (hello.schemaDigest !== HOST_SCHEMA_DIGEST) {
    rejectHandshake("controller_schema_mismatch");
    return;
  }

  const unsupported = hello.capabilities.required.filter(
    (capability) => !hostCapabilities.includes(capability),
  );
  if (unsupported.length > 0) {
    rejectHandshake("controller_capability_unsupported");
    return;
  }

  const major = protocolVersion.major;
  const identity = "local-host";
  const hostId = negotiatedHostId;
  const requiredCapabilities = ["sandking.control.slice-1"];

  writeFrame(process.stdout, {
    type: "hello-ack",
    protocol: {
      major,
      minor: protocolVersion.minor,
      patch: protocolVersion.patch,
      version: `${major}.${protocolVersion.minor}.${protocolVersion.patch}`,
    },
    release: releaseVersion,
    identity,
    hostId,
    peerIdentity: "controller-runtime",
    peerControllerId: hello.controllerId,
    capabilities: {
      required: requiredCapabilities,
      optional: ["sandking.bulk-stream.v1"],
    },
    negotiatedCapabilities: hostCapabilities.filter((capability) =>
      [...hello.capabilities.required, ...hello.capabilities.optional].includes(capability)),
    schemaDigest: HOST_SCHEMA_DIGEST,
    framing: {
      maxFrameBytes: MAX_FRAME_BYTES,
      maxBulkChunkBytes: MAX_BULK_CHUNK_BYTES,
    },
    observationCursor: "host:origin",
  });

  if (!persistedHostIdentity) {
    const identityFrame = await readProtocolFrame(process.stdin);
    if (identityFrame.channel !== "control" || identityFrame.message.type !== "host.identity.accept") {
      rejectHandshake("host_protocol_unexpected_message");
      return;
    }
    await handleHostIdentityAcceptance(identityFrame.message, negotiatedHostId);
  }

  const projectRegistry = await createProjectRegistry({
    dataDir,
    recordAudit: recordProjectAudit,
  });
  const harnessRuns = await createHarnessRunManager({
    dataDir,
    hostId: negotiatedHostId,
    recordAudit: recordProjectAudit,
    loadLaunchContext: projectRegistry.loadLaunchContext,
  });
  // The Host is a durable process boundary. It remains available after
  // negotiation and keeps control and opaque bulk frames structurally distinct.
  while (true) {
    const frame = await readProtocolFrame(process.stdin);
    if (frame.channel === "bulk") {
      continue;
    }
    if (frame.message.type === "ping") {
      writeFrame(process.stdout, {
        type: "pong",
        requestId: frame.message.requestId,
      });
      continue;
    }
    if (frame.message.type === "host.identity.accept") {
      await handleHostIdentityAcceptance(frame.message, negotiatedHostId);
      continue;
    }
    if (frame.message.type === "project.inspect") {
      writeFrame(process.stdout, await projectRegistry.inspectProject(frame.message));
      continue;
    }
    if (frame.message.type === "project.register") {
      const outcome = await projectRegistry.registerProject(frame.message);
      writeFrame(process.stdout, outcome);
      continue;
    }
    if (frame.message.type === "harness.conformance.inspect") {
      writeFrame(process.stdout, await projectRegistry.inspectConformanceHarness(frame.message));
      continue;
    }
    if (frame.message.type === "harness.conformance.register") {
      writeFrame(
        process.stdout,
        await projectRegistry.registerConformanceHarness(frame.message),
      );
      continue;
    }
    if (frame.message.type === "harness.sandcastle.inspect") {
      writeFrame(process.stdout, await projectRegistry.inspectSandcastleHarness(frame.message));
      continue;
    }
    if (frame.message.type === "harness.sandcastle.register") {
      writeFrame(
        process.stdout,
        await projectRegistry.registerSandcastleHarness(frame.message),
      );
      continue;
    }
    if (frame.message.type === "project.harness.pin") {
      writeFrame(process.stdout, await projectRegistry.pinHarness(frame.message));
      continue;
    }
    if (frame.message.type === "harness.run.launch") {
      const outcome = await harnessRuns.launch(frame.message);
      writeFrame(process.stdout, outcome);
      continue;
    }
    if (frame.message.type === "harness.run.cancel") {
      writeFrame(process.stdout, await harnessRuns.cancel(frame.message));
      continue;
    }
    if (frame.message.type === "harness.run.recover") {
      writeFrame(process.stdout, await harnessRuns.recover(frame.message));
      continue;
    }
    if (frame.message.type === "harness.run.recovery.lookup") {
      writeFrame(process.stdout, await harnessRuns.lookupRecovery(frame.message));
      continue;
    }
    if (frame.message.type === "harness.run.lookup") {
      writeFrame(process.stdout, await harnessRuns.lookup(frame.message));
      continue;
    }
    if (frame.message.type === "harness.run.observe") {
      writeFrame(process.stdout, await harnessRuns.observe(frame.message));
      continue;
    }
    if (frame.message.type === "harness.run.logs.get") {
      try {
        const logRange = await harnessRuns.readLogs(frame.message);
        writeFrame(process.stdout, logRange.response);
        writeBulkFrame(process.stdout, {
          streamId: logRange.response.streamId,
          sequence: logRange.response.range.start,
          eof: logRange.response.range.eof,
          data: logRange.data,
        });
      } catch (error) {
        const code = error instanceof Error && error.message === "harness_log_range_invalid"
          ? "harness_log_range_invalid"
          : "harness_run_not_found";
        writeFrame(process.stdout, {
          type: "harness.run.operation.failure",
          requestId: frame.message.requestId,
          operation: frame.message.type,
          code,
          retryable: code === "harness_run_not_found",
        });
      }
      continue;
    }
    rejectHandshake("host_protocol_unexpected_message");
  }
};

main().catch((error) => {
  const diagnostic = error instanceof HarnessRunStateError
    ? error.message
    : error instanceof ProtocolError
      ? error.code
      : "host_internal_error";
  if (error instanceof HarnessRunStateError) {
    process.stderr.write(`${diagnostic}\n`, () => {
      process.exitCode = 1;
      process.stdin.destroy();
    });
    return;
  }
  process.stderr.write(`${diagnostic}\n`);
  process.exitCode = 1;
});
