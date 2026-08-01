#!/usr/bin/env node

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
  writeFrame,
} from "./protocol.mjs";
import { acceptHostIdentity, readHostIdentity } from "./host-identity.mjs";

/** @param {string[]} argv */
const parseArgs = (argv) => {
  let mode = "normal";
  let dataDir = process.cwd();
  let allowHostIdentityCreate = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--mode") {
      mode = argv[index + 1] ?? mode;
      index += 1;
    } else if (argv[index] === "--data-dir") {
      dataDir = argv[index + 1] ?? dataDir;
      index += 1;
    } else if (argv[index] === "--allow-host-identity-create") {
      allowHostIdentityCreate = true;
    }
  }
  return { mode, dataDir, allowHostIdentityCreate };
};

const { mode, dataDir, allowHostIdentityCreate } = parseArgs(process.argv.slice(2));

const writeMalformedFrame = () => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
  process.stdout.write(header);
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

const main = async () => {
  if (mode === "exit-before-ack") {
    process.exitCode = 12;
    return;
  }

  const hello = await readFrame(process.stdin);
  if (hello.type !== "hello") {
    rejectHandshake("host_protocol_unexpected_message");
    return;
  }

  if (mode === "hang-before-ack") {
    await new Promise(() => {});
    return;
  }
  if (mode === "delayed-ack") {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (
    hello.identity !== "controller-runtime"
    || !/^runtime-[a-f0-9]{24}$/.test(hello.controllerId)
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

  if (mode === "malformed-frame") {
    writeMalformedFrame();
    return;
  }

  const major = mode === "incompatible-major"
    ? protocolVersion.major + 1
    : protocolVersion.major;
  const identity = "local-host";
  const hostId = mode === "unexpected-identity"
    ? `host-${"0".repeat(24)}`
    : negotiatedHostId;
  const requiredCapabilities = mode === "unknown-required-capability"
    ? ["sandking.control.slice-1", "sandking.future-required"]
    : ["sandking.control.slice-1"];

  // A test mode makes an inherited Controller secret observable only as a typed
  // identity failure. The Controller never supplies such environment entries.
  const secretLeaked = mode === "secret-probe"
    && typeof process.env.SANDKING_CONTROLLER_SECRET === "string";

  writeFrame(process.stdout, {
    type: "hello-ack",
    protocol: {
      major,
      minor: protocolVersion.minor,
      patch: protocolVersion.patch,
      version: `${major}.${protocolVersion.minor}.${protocolVersion.patch}`,
    },
    release: releaseVersion,
    identity: secretLeaked ? "controller-secret-leaked" : identity,
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

  // The Host is a durable process boundary. It remains available after
  // negotiation and keeps control and opaque bulk frames structurally distinct.
  while (true) {
    const frame = await readProtocolFrame(process.stdin);
    if (frame.channel === "bulk") {
      continue;
    }
    if (frame.message.type === "ping") {
      if (!persistedHostIdentity) {
        await acceptHostIdentity(dataDir, negotiatedHostId);
      }
      writeFrame(process.stdout, {
        type: "pong",
        requestId: frame.message.requestId,
      });
      continue;
    }
    rejectHandshake("host_protocol_unexpected_message");
  }
};

main().catch((error) => {
  const code = error instanceof ProtocolError ? error.code : "host_internal_error";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
