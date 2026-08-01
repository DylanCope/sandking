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

/** @param {string[]} argv */
const parseArgs = (argv) => {
  let mode = "normal";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--mode") {
      mode = argv[index + 1] ?? mode;
      index += 1;
    }
  }
  return { mode };
};

const { mode } = parseArgs(process.argv.slice(2));

const writeMalformedFrame = () => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
  process.stdout.write(header);
};

/**
 * @param {
 *   | "controller_identity_invalid"
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

  if (hello.identity !== "controller-runtime" || hello.expectedPeerIdentity !== "local-host") {
    rejectHandshake("controller_identity_invalid");
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
  const identity = mode === "unexpected-identity" ? "unexpected-host" : "local-host";
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
    peerIdentity: "controller-runtime",
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
