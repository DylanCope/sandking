import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import WebSocket from "ws";
import {
  BROWSER_PROTOCOL_VERSION,
  BROWSER_SCHEMA_DIGEST,
  MAX_BROWSER_OPAQUE_CHUNK_BYTES,
  BrowserProtocolError,
  browserCapabilities,
  decodeBrowserOpaqueFrame,
  encodeBrowserOpaqueFrame,
  runtimeControlEnvelopeSchema,
} from "../src/browser-protocol.mjs";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "src", "cli.mjs");

/** @param {string} dataDir @param {NodeJS.ProcessEnv} [env] */
const launch = async (dataDir, env = process.env) => {
  const { stdout } = await execFileAsync(process.execPath, [
    cliPath, "launch", "--data-dir", dataDir, "--json", "--no-open",
  ], { cwd: tmpdir(), env });
  return JSON.parse(stdout);
};

/** @param {string} bootstrapUrl */
const exchangeBootstrap = async (bootstrapUrl) => {
  const response = await fetch(bootstrapUrl, { redirect: "manual" });
  assert.equal(response.status, 302);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return cookie;
};

/** @param {number} port @param {string} cookie */
const connect = async (port, cookie) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: {
      cookie,
      origin: `http://127.0.0.1:${port}`,
    },
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
};

/** @param {{major?: number, cursor?: string | null, required?: string[]}} [overrides] */
const browserHello = (overrides = {}) => ({
  channel: "control",
  message: {
    type: "browser.hello",
    protocol: {
      ...BROWSER_PROTOCOL_VERSION,
      major: overrides.major ?? BROWSER_PROTOCOL_VERSION.major,
      version: `${overrides.major ?? BROWSER_PROTOCOL_VERSION.major}.0.0`,
    },
    release: "0.1.0",
    identity: "cockpit",
    expectedPeerIdentity: "controller-runtime",
    capabilities: {
      required: overrides.required ?? [...browserCapabilities],
      optional: [],
    },
    schemaDigest: BROWSER_SCHEMA_DIGEST,
    framing: {
      maxControlMessageBytes: 32_768,
      maxOpaqueStreamChunkBytes: MAX_BROWSER_OPAQUE_CHUNK_BYTES,
    },
    observationCursor: overrides.cursor ?? null,
  },
});

/** @param {WebSocket} socket */
const nextControl = async (socket) => {
  const data = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      reject(new Error("runtime_control_timeout"));
    }, 2_000);
    const onMessage = (message) => {
      clearTimeout(timeout);
      socket.off("error", onError);
      resolve(message);
    };
    const onError = (error) => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      reject(error);
    };
    socket.once("message", onMessage);
    socket.once("error", onError);
  });
  const parsed = runtimeControlEnvelopeSchema.parse(JSON.parse(data.toString()));
  return parsed.message;
};

test("browser/runtime WebSocket negotiation is versioned, typed, sanitized, and resynchronizable", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-browser-protocol-"));
  const secret = "recognizable-controller-secret-fixture";

  try {
    const runtime = await launch(dataDir, {
      ...process.env,
      SANDKING_CONTROLLER_SECRET: secret,
    });
    const cookie = await exchangeBootstrap(runtime.bootstrapUrl);
    const socket = await connect(runtime.runtime.port, cookie);
    socket.send(JSON.stringify(browserHello()));
    const ack = await nextControl(socket);

    assert.equal(ack.type, "runtime.hello-ack");
    assert.equal(ack.identity, "controller-runtime");
    assert.equal(ack.peerIdentity, "cockpit");
    assert.equal(ack.protocol.version, "1.0.0");
    assert.deepEqual(ack.negotiatedCapabilities, browserCapabilities);
    assert.equal(ack.observation.mode, "snapshot");
    assert.equal(ack.viewModel.host.identity, "local-host");
    assert.deepEqual(Object.keys(ack.viewModel).sort(), ["host", "kind", "negotiation", "runtime"]);
    assert.doesNotMatch(JSON.stringify(ack), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(ack), /bootstrap|credential|filesystem|dataDir|process\.env/i);
    socket.close();

    const reconnect = await connect(runtime.runtime.port, cookie);
    reconnect.send(JSON.stringify(browserHello({ cursor: "unknown:cursor" })));
    const resync = await nextControl(reconnect);
    assert.equal(resync.type, "runtime.hello-ack");
    assert.deepEqual(resync.observation, {
      mode: "resynchronize",
      cursor: "host:origin",
      reason: "cursor_unavailable",
    });
    reconnect.close();
  } finally {
    await execFileAsync(process.execPath, [cliPath, "stop", "--data-dir", dataDir, "--json"], {
      cwd: tmpdir(),
      env: process.env,
    }).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("negotiated WebSockets enforce typed control separately from bounded opaque frames", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-browser-channels-"));

  try {
    const runtime = await launch(dataDir);
    const cookie = await exchangeBootstrap(runtime.bootstrapUrl);
    const socket = await connect(runtime.runtime.port, cookie);
    socket.send(JSON.stringify(browserHello()));
    assert.equal((await nextControl(socket)).type, "runtime.hello-ack");

    socket.send(encodeBrowserOpaqueFrame({
      streamId: "terminal-1",
      sequence: 0,
      eof: false,
      data: Buffer.from([0, 255, 17]),
    }));
    socket.send(JSON.stringify({
      channel: "control",
      message: { type: "browser.ping", requestId: "browser-request-1" },
    }));
    assert.deepEqual(await nextControl(socket), {
      type: "runtime.pong",
      requestId: "browser-request-1",
    });

    const oversizedOpaqueFrame = Buffer.concat([
      Buffer.from([1, 0, 0, 0, 1, 0]),
      Buffer.from("x"),
      Buffer.alloc(MAX_BROWSER_OPAQUE_CHUNK_BYTES + 1),
    ]);
    socket.send(oversizedOpaqueFrame);
    assert.deepEqual(await nextControl(socket), {
      type: "runtime.protocol-error",
      code: "browser_opaque_frame_invalid",
      retryable: true,
      reloadRequired: false,
    });
    socket.close();
  } finally {
    await execFileAsync(process.execPath, [cliPath, "stop", "--data-dir", dataDir, "--json"], {
      cwd: tmpdir(),
      env: process.env,
    }).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("browser/runtime version and required-capability mismatches require an explicit reload", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-browser-mismatch-"));

  try {
    const runtime = await launch(dataDir);
    const cookie = await exchangeBootstrap(runtime.bootstrapUrl);
    const socket = await connect(runtime.runtime.port, cookie);
    socket.send(JSON.stringify(browserHello({ major: 2 })));
    const mismatch = await nextControl(socket);
    assert.deepEqual(mismatch, {
      type: "runtime.protocol-error",
      code: "browser_protocol_major_mismatch",
      retryable: true,
      reloadRequired: true,
    });
    socket.close();

    const capabilitySocket = await connect(runtime.runtime.port, cookie);
    capabilitySocket.send(JSON.stringify(browserHello({
      required: [...browserCapabilities, "cockpit.future-required"],
    })));
    assert.deepEqual(await nextControl(capabilitySocket), {
      type: "runtime.protocol-error",
      code: "browser_capability_unsupported",
      retryable: true,
      reloadRequired: true,
    });
    capabilitySocket.close();

    const missingRuntimeCapabilitySocket = await connect(runtime.runtime.port, cookie);
    missingRuntimeCapabilitySocket.send(JSON.stringify(browserHello({
      required: ["cockpit.structured-control.v1"],
    })));
    assert.deepEqual(await nextControl(missingRuntimeCapabilitySocket), {
      type: "runtime.protocol-error",
      code: "browser_capability_unsupported",
      retryable: true,
      reloadRequired: true,
    });
    missingRuntimeCapabilitySocket.close();
  } finally {
    await execFileAsync(process.execPath, [cliPath, "stop", "--data-dir", dataDir, "--json"], {
      cwd: tmpdir(),
      env: process.env,
    }).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("browser opaque streams are binary, bounded, and distinct from control JSON", () => {
  const data = Buffer.from([0, 255, 1, 2, 3]);
  const encoded = encodeBrowserOpaqueFrame({
    streamId: "terminal-1",
    sequence: 4,
    eof: true,
    data,
  });
  assert.deepEqual(decodeBrowserOpaqueFrame(encoded), {
    streamId: "terminal-1",
    sequence: 4,
    eof: true,
    data,
  });
  assert.throws(
    () => decodeBrowserOpaqueFrame(Buffer.alloc(5)),
    (error) => error instanceof BrowserProtocolError
      && error.code === "browser_opaque_metadata_invalid",
  );
});
