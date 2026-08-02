import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  parseBrowserControl,
  runtimeControlEnvelopeSchema,
  serializeRuntimeControl,
} from "../src/browser-protocol.mjs";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "src", "cli.mjs");

/** @param {string} dataDir @param {NodeJS.ProcessEnv} [env] */
const launch = async (dataDir, env = process.env) => {
  const { stdout } = await execFileAsync(process.execPath, [
    cliPath, "launch", "--data-dir", dataDir, "--json", "--no-open",
  ], {
    cwd: tmpdir(),
    env: {
      ...env,
      SANDKING_CLAUDE_EXECUTABLE: join(dataDir, "claude-not-installed"),
    },
  });
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
    assert.equal(ack.viewModel.host.hostId, runtime.host.hostId);
    assert.deepEqual({
      status: ack.viewModel.host.status,
      freshness: ack.viewModel.host.freshness,
      failure: ack.viewModel.host.failure,
    }, { status: "connected", freshness: "current", failure: null });
    assert.deepEqual(Object.keys(ack.viewModel).sort(), [
      "controllerProviders", "focusedControllerSession", "harnessRunObservation", "host", "kind",
      "negotiation", "planning", "projectPreparation", "runtime",
    ]);
    assert.equal(ack.viewModel.focusedControllerSession, null);
    assert.deepEqual(ack.viewModel.harnessRunObservation, {
      type: "harness.run.observe.result",
      requestId: "harness-observe-cached",
      code: "harness_run_absent",
      mode: "snapshot",
      resynchronization: null,
      launchRequest: null,
      run: null,
      events: [],
      nextSequence: 0,
      outcome: null,
      logStreams: [],
      terminalEnvelopeValidation: null,
    });
    assert.deepEqual(ack.viewModel.controllerProviders.map((provider) => ({
      providerId: provider.providerId,
      fixture: provider.fixture,
      status: provider.availability.status,
      ptyRuntimeOwned: provider.terminal.runtimeOwnershipRequired,
    })), [
      {
        providerId: "conformance-controller-v1",
        fixture: true,
        status: "available",
        ptyRuntimeOwned: true,
      },
      {
        providerId: "claude-code",
        fixture: false,
        status: "unavailable",
        ptyRuntimeOwned: true,
      },
    ]);
    assert.equal(
      ack.viewModel.controllerProviders[1].availability.failureCode,
      "provider_cli_unavailable",
    );
    assert.deepEqual(ack.viewModel.projectPreparation.selection, {
      mode: "explicit-host-path",
      directoryScanning: false,
    });
    assert.equal(ack.viewModel.projectPreparation.current, null);
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

test("session termination declares authorization, idempotency, revision, audit, and stale outcomes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-session-mutation-"));

  try {
    const runtime = await launch(dataDir);
    const cookie = await exchangeBootstrap(runtime.bootstrapUrl);
    const socket = await connect(runtime.runtime.port, cookie);
    socket.send(JSON.stringify(browserHello()));
    const acknowledgement = await nextControl(socket);
    assert.equal(acknowledgement.type, "runtime.hello-ack");
    assert.equal(acknowledgement.session.revision, 1);
    const url = `http://127.0.0.1:${runtime.runtime.port}/session/end`;
    const idempotencyKey = "session-end-idempotency-key-1";
    const mutationHeaders = {
      cookie,
      origin: `http://127.0.0.1:${runtime.runtime.port}`,
      "x-sandking-csrf": acknowledgement.session.csrfToken,
      "x-sandking-idempotency-key": idempotencyKey,
      "x-sandking-expected-revision": "1",
    };
    const socketClosed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("session_socket_not_revoked")), 2_000);
      socket.once("close", (code, reason) => {
        clearTimeout(timeout);
        resolve({ code, reason: reason.toString() });
      });
    });
    const postTerminationMessages = [];
    socket.on("message", (message) => postTerminationMessages.push(message.toString()));

    const concurrentResponses = await Promise.all(Array.from(
      { length: 8 },
      () => fetch(url, { method: "POST", headers: mutationHeaders }),
    ));
    assert.deepEqual(concurrentResponses.map((response) => response.status), Array(8).fill(200));
    const concurrentOutcomes = await Promise.all(
      concurrentResponses.map((response) => response.json()),
    );
    const freshOutcomes = concurrentOutcomes.filter((outcome) => !outcome.idempotentReplay);
    assert.equal(freshOutcomes.length, 1);
    assert.equal(new Set(concurrentOutcomes.map((outcome) => outcome.auditId)).size, 1);
    assert.equal(concurrentOutcomes.filter((outcome) => outcome.idempotentReplay).length, 7);
    const firstOutcome = freshOutcomes[0];
    assert.deepEqual(firstOutcome, {
      type: "mutation_result",
      code: "session_ended",
      authorizationClass: "runtime_browser_session",
      revision: 2,
      idempotentReplay: false,
      auditId: firstOutcome.auditId,
    });
    assert.match(firstOutcome.auditId, /^audit-/);
    socket.send(JSON.stringify({
      channel: "control",
      message: { type: "browser.ping", requestId: "ping-after-session-end" },
    }));
    assert.deepEqual(await socketClosed, { code: 1008, reason: "session_ended" });
    assert.equal(
      postTerminationMessages.some((message) => message.includes("ping-after-session-end")),
      false,
    );

    const replay = await fetch(url, { method: "POST", headers: mutationHeaders });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), {
      ...firstOutcome,
      idempotentReplay: true,
    });

    const stale = await fetch(url, {
      method: "POST",
      headers: {
        ...mutationHeaders,
        "x-sandking-idempotency-key": "session-end-idempotency-key-2",
      },
    });
    assert.equal(stale.status, 409);
    const staleOutcome = await stale.json();
    assert.deepEqual(staleOutcome, {
      type: "mutation_failure",
      code: "mutation_revision_conflict",
      retryable: true,
      authorizationClass: "runtime_browser_session",
      expectedRevision: 1,
      actualRevision: 2,
      auditId: staleOutcome.auditId,
    });
    assert.match(staleOutcome.auditId, /^audit-/);

    const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const accepted = audits.find((entry) => entry.auditId === firstOutcome.auditId);
    assert.deepEqual({
      authorizationClass: accepted.details.authorizationClass,
      expectedRevision: accepted.details.expectedRevision,
      actualRevision: accepted.details.actualRevision,
      resultingRevision: accepted.details.resultingRevision,
    }, {
      authorizationClass: "runtime_browser_session",
      expectedRevision: 1,
      actualRevision: 1,
      resultingRevision: 2,
    });
    assert.match(accepted.details.idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
  } finally {
    await execFileAsync(process.execPath, [cliPath, "stop", "--data-dir", dataDir, "--json"], {
      cwd: tmpdir(),
      env: process.env,
    }).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("browser credentials are non-persistent and expire in the runtime", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-session-expiry-"));

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      "launch",
      "--data-dir",
      dataDir,
      "--browser-session-ttl-ms",
      "250",
      "--json",
      "--no-open",
    ], { cwd: tmpdir(), env: process.env });
    const runtime = JSON.parse(stdout);
    const bootstrap = await fetch(runtime.bootstrapUrl, { redirect: "manual" });
    assert.equal(bootstrap.status, 302);
    const setCookie = bootstrap.headers.get("set-cookie");
    assert.ok(setCookie);
    assert.doesNotMatch(setCookie, /(?:max-age|expires)=/i);
    const cookie = setCookie.split(";")[0];

    const socket = await connect(runtime.runtime.port, cookie);
    socket.send(JSON.stringify(browserHello()));
    assert.equal((await nextControl(socket)).type, "runtime.hello-ack");
    const socketClosed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("session_expiry_not_enforced")), 2_000);
      socket.once("close", (code, reason) => {
        clearTimeout(timeout);
        resolve({ code, reason: reason.toString() });
      });
    });
    assert.deepEqual(await socketClosed, { code: 1008, reason: "session_expired" });

    const expiredRequest = await fetch(`http://127.0.0.1:${runtime.runtime.port}/`, {
      headers: { cookie },
    });
    assert.equal(expiredRequest.status, 401);
    assert.deepEqual(await expiredRequest.json(), { code: "session_expired" });
    const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const expiryAudit = audits.find((entry) => entry.action === "browser.session.expire");
    assert.equal(expiryAudit.outcome, "observed");
    assert.equal(expiryAudit.details.authorizationClass, "runtime_browser_session");
    assert.match(expiryAudit.details.sessionAuditId, /^audit-/);
    if (process.env.SANDKING_ACCEPTANCE_RESULT_DIR) {
      await mkdir(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, "browser-session-expiry.json"),
        `${JSON.stringify({
          kind: "browser_session_expiry",
          ttlMs: 250,
          persistentCookieAttributesIssued: /(?:max-age|expires)=/i.test(setCookie),
          socketCloseCode: 1008,
          socketCloseReason: "session_expired",
          expiredHttpStatus: expiredRequest.status,
          expiredHttpCode: "session_expired",
          expiryAudit: {
            auditId: expiryAudit.auditId,
            action: expiryAudit.action,
            outcome: expiryAudit.outcome,
            details: expiryAudit.details,
          },
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

test("terminal resize control is bounded and correlated through the negotiated schema", () => {
  assert.ok(browserCapabilities.includes("cockpit.controller-terminal-resize.v1"));
  const resize = {
    channel: "control",
    message: {
      type: "browser.terminal.resize",
      sessionId: `controller-session-${"1".repeat(24)}`,
      streamId: `controller-terminal-${"2".repeat(24)}`,
      attachmentId: `terminal-attachment-${"3".repeat(24)}`,
      sequence: 4,
      columns: 120,
      rows: 40,
    },
  };
  assert.deepEqual(parseBrowserControl(resize), resize.message);
  assert.throws(
    () => parseBrowserControl({
      ...resize,
      message: { ...resize.message, columns: 19 },
    }),
    (error) => error instanceof BrowserProtocolError
      && error.code === "browser_control_schema_invalid",
  );
  assert.throws(
    () => parseBrowserControl({
      ...resize,
      message: { ...resize.message, rows: 201 },
    }),
    (error) => error instanceof BrowserProtocolError
      && error.code === "browser_control_schema_invalid",
  );
  assert.deepEqual(JSON.parse(serializeRuntimeControl({
    type: "runtime.terminal-resized",
    sessionId: resize.message.sessionId,
    streamId: resize.message.streamId,
    attachmentId: resize.message.attachmentId,
    sequence: resize.message.sequence,
    columns: resize.message.columns,
    rows: resize.message.rows,
  })).message, {
    type: "runtime.terminal-resized",
    sessionId: resize.message.sessionId,
    streamId: resize.message.streamId,
    attachmentId: resize.message.attachmentId,
    sequence: 4,
    columns: 120,
    rows: 40,
  });
});
