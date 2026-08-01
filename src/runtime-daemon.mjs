#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  BROWSER_PROTOCOL_VERSION,
  BROWSER_SCHEMA_DIGEST,
  MAX_BROWSER_CONTROL_BYTES,
  MAX_BROWSER_OPAQUE_CHUNK_BYTES,
  BrowserProtocolError,
  browserCapabilities,
  decodeBrowserOpaqueFrame,
  parseBrowserControl,
  runtimeOptionalBrowserCapabilities,
  runtimeRequiredBrowserCapabilities,
  serializeRuntimeControl,
} from "./browser-protocol.mjs";
import {
  appendPrivateJsonLine,
  ensurePrivateDirectory,
  hasErrorCode,
  readJson,
  removePrivateFile,
  writePrivateJson,
} from "./private-state.mjs";
import {
  HOST_SCHEMA_DIGEST,
  MAX_BULK_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  ProtocolError,
  hostCapabilities,
  protocolVersion,
  readFrame,
  releaseVersion,
  writeFrame,
} from "./protocol.mjs";

/** @param {string[]} argv */
const parseArgs = (argv) => {
  /** @type {{dataDir?: string, hostMode?: string, expectedHostId?: string, lifecycleRevision?: number, startupId?: string}} */
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--data-dir") {
      result.dataDir = argv[index + 1];
      index += 1;
    } else if (current === "--host-mode") {
      result.hostMode = argv[index + 1];
      index += 1;
    } else if (current === "--expected-host-id") {
      result.expectedHostId = argv[index + 1];
      index += 1;
    } else if (current === "--lifecycle-revision") {
      result.lifecycleRevision = Number(argv[index + 1]);
      index += 1;
    } else if (current === "--startup-id") {
      result.startupId = argv[index + 1];
      index += 1;
    }
  }
  if (!result.dataDir) {
    throw new Error("runtime_data_dir_missing");
  }
  if (!result.expectedHostId || !/^host-[a-f0-9]{24}$/.test(result.expectedHostId)) {
    throw new Error("runtime_expected_host_id_missing");
  }
  if (!Number.isSafeInteger(result.lifecycleRevision) || Number(result.lifecycleRevision) < 1) {
    throw new Error("runtime_lifecycle_revision_missing");
  }
  if (!result.startupId || !/^[a-f0-9]{24}$/.test(result.startupId)) {
    throw new Error("runtime_startup_id_missing");
  }
  return /** @type {{dataDir: string, hostMode?: string, expectedHostId: string, lifecycleRevision: number, startupId: string}} */ (result);
};

const args = parseArgs(process.argv.slice(2));
const localHostPath = fileURLToPath(new URL("./local-host.mjs", import.meta.url));
const cockpitScriptPath = fileURLToPath(new URL("./cockpit.js", import.meta.url));
const statePath = join(args.dataDir, "runtime-state.json");
const tokenDirectory = join(args.dataDir, "bootstrap-tokens");
const startupErrorPath = join(args.dataDir, "startup-error.json");
const runtimeErrorPath = join(args.dataDir, "runtime-error.log");
const auditPath = join(args.dataDir, "audit.jsonl");
const sessionCookieName = "sandking_session";

/** @type {Map<string, {createdAt: number, runtimeId: string, csrfToken: string, auditId: string, revision: number}>} */
const sessions = new Map();
/** @type {Map<string, {createdAt: number, runtimeId: string, csrfToken: string, auditId: string, revision: number, termination: {idempotencyKeyHash: string, expectedRevision: number, auditId: string}}>} */
const endedSessions = new Map();
/** @type {Map<string, Set<WebSocket>>} */
const sessionSockets = new Map();
/** @type {Map<string, Promise<any>>} */
const sessionMutationQueues = new Map();
/** @type {Map<string, Promise<any>>} */
const bootstrapExchanges = new Map();
/** @type {import("node:child_process").ChildProcessWithoutNullStreams | undefined} */
let hostProcess;
/** @type {import("node:http").Server | undefined} */
let httpServer;
/** @type {WebSocketServer | undefined} */
let websocketServer;
/** @type {any} */
let state;
let shuttingDown = false;
let startupCommitted = false;

const cockpitCsp = [
  "default-src 'self'",
  "connect-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

const securityHeaders = Object.freeze({
  "content-security-policy": cockpitCsp,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
});

/** @param {string} action @param {"accepted" | "rejected" | "observed"} outcome @param {Record<string, unknown>} [details] */
const recordAudit = async (action, outcome, details = {}) => {
  const auditId = `audit-${randomBytes(12).toString("hex")}`;
  await appendPrivateJsonLine(auditPath, {
    auditId,
    action,
    outcome,
    details,
    recordedAt: new Date().toISOString(),
  });
  return auditId;
};

/** @param {string | undefined} header */
const parseCookies = (header) => {
  if (!header) {
    return {};
  }
  return Object.fromEntries(
    header.split(";").map((part) => {
      const [name, ...rest] = part.trim().split("=");
      return [name, rest.join("=")];
    }),
  );
};

/** @param {import("node:http").IncomingMessage} request */
const exactHostAccepted = (request) => request.headers.host === `127.0.0.1:${state.port}`;
/** @param {import("node:http").IncomingMessage} request */
const exactOriginAccepted = (request) =>
  request.headers.origin === `http://127.0.0.1:${state.port}`;

/** @param {import("node:http").ServerResponse} response @param {number} status @param {unknown} body */
const sendJson = (response, status, body) => {
  response.writeHead(status, {
    ...securityHeaders,
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
};

/** @param {string} key */
const hashIdempotencyKey = (key) => `sha256:${createHash("sha256").update(key).digest("hex")}`;

/** @param {string} code @param {number} expectedRevision @param {number} actualRevision */
const mutationFailure = (code, expectedRevision, actualRevision) => ({
  type: "mutation_failure",
  code,
  retryable: true,
  expectedRevision,
  actualRevision,
});

/**
 * Serialize mutations for one browser session. The queue entry is installed
 * synchronously before the first mutation awaits audit I/O.
 * @template T
 * @param {string} sessionId
 * @param {() => Promise<T>} operation
 */
const withSessionMutationLock = async (sessionId, operation) => {
  const previous = sessionMutationQueues.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  sessionMutationQueues.set(sessionId, current);
  try {
    return await current;
  } finally {
    if (sessionMutationQueues.get(sessionId) === current) {
      sessionMutationQueues.delete(sessionId);
    }
  }
};

/**
 * @param {string} token
 * @param {string} idempotencyKey
 * @param {number} expectedRevision
 */
const exchangeBootstrapToken = async (token, idempotencyKey, expectedRevision) => {
  if (
    !/^[a-f0-9]{64}$/.test(token)
    || !/^[a-f0-9]{64}$/.test(idempotencyKey)
    || !Number.isSafeInteger(expectedRevision)
    || expectedRevision < 0
  ) {
    return {
      ok: false,
      status: 400,
      body: mutationFailure("mutation_contract_invalid", expectedRevision, 0),
    };
  }
  const tokenId = createHash("sha256").update(token).digest("hex");
  const idempotencyKeyHash = hashIdempotencyKey(idempotencyKey);
  const existingExchange = bootstrapExchanges.get(tokenId);
  if (existingExchange) {
    const existing = await existingExchange;
    if (existing.idempotencyKeyHash !== idempotencyKeyHash) {
      await recordAudit("browser.session.create", "rejected", {
        code: "idempotency_key_conflict",
        authorizationClass: "bootstrap_token",
        idempotencyKeyHash,
        expectedRevision,
        actualRevision: existing.resultingRevision ?? 0,
      });
      return {
        ok: false,
        status: 409,
        body: mutationFailure(
          "idempotency_key_conflict",
          expectedRevision,
          existing.resultingRevision ?? 0,
        ),
      };
    }
    if (existing.expectedRevision !== expectedRevision) {
      await recordAudit("browser.session.create", "rejected", {
        code: "mutation_revision_conflict",
        authorizationClass: "bootstrap_token",
        idempotencyKeyHash,
        expectedRevision,
        actualRevision: existing.resultingRevision ?? 0,
      });
      return {
        ok: false,
        status: 409,
        body: mutationFailure(
          "mutation_revision_conflict",
          expectedRevision,
          existing.resultingRevision ?? 0,
        ),
      };
    }
    if (existing.ok && Number(existing.expiresAt) <= Date.now()) {
      await recordAudit("browser.session.create", "rejected", {
        code: "bootstrap_token_expired",
        authorizationClass: "bootstrap_token",
        idempotencyKeyHash,
        expectedRevision,
        actualRevision: existing.resultingRevision,
      });
      return {
        ok: false,
        status: 410,
        body: mutationFailure(
          "bootstrap_token_expired",
          expectedRevision,
          existing.resultingRevision,
        ),
      };
    }
    if (existing.ok) {
      await recordAudit("browser.session.create", "observed", {
        authorizationClass: "bootstrap_token",
        idempotencyKeyHash,
        expectedRevision,
        actualRevision: 0,
        resultingRevision: 1,
        idempotentReplay: true,
        originalAuditId: existing.session.auditId,
      });
      return { ...existing, idempotentReplay: true };
    }
    return existing;
  }

  const exchange = (async () => {
  const tokenPath = join(tokenDirectory, `${tokenId}.json`);
  const claimPath = join(
    tokenDirectory,
    `${tokenId}.${randomBytes(8).toString("hex")}.claim`,
  );
  try {
    // Renaming the token itself is the atomic compare-and-consume operation.
    // Concurrent or fabricated claims have no source file to rename and leave
    // no durable marker behind.
    await rename(tokenPath, claimPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      const body = mutationFailure("bootstrap_token_invalid", expectedRevision, 0);
      await recordAudit("browser.session.create", "rejected", {
        code: body.code,
        authorizationClass: "bootstrap_token",
        idempotencyKeyHash,
        expectedRevision,
        actualRevision: 0,
      });
      return { ok: false, status: 410, body, idempotencyKeyHash, expectedRevision };
    }
    throw error;
  }

  try {
    const tokenState = await readJson(claimPath, null);
    if (
      !tokenState
      || typeof tokenState !== "object"
      || tokenState.runtimeId !== state.runtimeId
      || !/^sha256:[a-f0-9]{64}$/.test(String(tokenState.idempotencyKeyHash))
      || !Number.isSafeInteger(tokenState.revision)
      || tokenState.revision < 0
      || !Number.isSafeInteger(tokenState.expiresAt)
    ) {
      const invalid = {
        ok: false,
        status: 410,
        body: mutationFailure("bootstrap_token_invalid", expectedRevision, 0),
        idempotencyKeyHash,
        expectedRevision,
      };
      await recordAudit("browser.session.create", "rejected", {
        code: invalid.body.code,
        authorizationClass: "bootstrap_token",
        idempotencyKeyHash,
        expectedRevision,
        actualRevision: 0,
      });
      return invalid;
    }
    if (tokenState.idempotencyKeyHash !== idempotencyKeyHash) {
      const body = mutationFailure("idempotency_key_conflict", expectedRevision, 0);
      await recordAudit("browser.session.create", "rejected", {
        code: body.code,
        authorizationClass: "bootstrap_token",
        idempotencyKeyHash,
        expectedRevision,
        actualRevision: 0,
      });
      return { ok: false, status: 409, body, idempotencyKeyHash, expectedRevision };
    }
    if (expectedRevision !== Number(tokenState.revision)) {
      const body = mutationFailure(
        "mutation_revision_conflict",
        expectedRevision,
        Number(tokenState.revision),
      );
      await recordAudit("browser.session.create", "rejected", {
        code: body.code,
        authorizationClass: "bootstrap_token",
        idempotencyKeyHash,
        expectedRevision,
        actualRevision: Number(tokenState.revision),
      });
      return { ok: false, status: 409, body, idempotencyKeyHash, expectedRevision };
    }
    if (Number(tokenState.expiresAt) <= Date.now()) {
      const body = mutationFailure("bootstrap_token_expired", expectedRevision, 0);
      await recordAudit("browser.session.create", "rejected", {
        code: body.code,
        authorizationClass: "bootstrap_token",
        idempotencyKeyHash,
        expectedRevision,
        actualRevision: 0,
      });
      return { ok: false, status: 410, body, idempotencyKeyHash, expectedRevision };
    }
    const session = await createSession({ idempotencyKeyHash, expectedRevision });
    return {
      ok: true,
      session,
      idempotencyKeyHash,
      expectedRevision,
      resultingRevision: 1,
      idempotentReplay: false,
      expiresAt: Number(tokenState.expiresAt),
    };
  } finally {
    await removePrivateFile(claimPath);
  }
  })();
  bootstrapExchanges.set(tokenId, exchange);
  const result = await exchange;
  if (!result.ok) {
    bootstrapExchanges.delete(tokenId);
  }
  return result;
};

/** @param {{idempotencyKeyHash: string, expectedRevision: number}} contract */
const createSession = async (contract) => {
  const sessionId = randomBytes(32).toString("hex");
  const csrfToken = randomBytes(24).toString("hex");
  const auditId = await recordAudit("browser.session.create", "accepted", {
    runtimeId: state.runtimeId,
    authorizationClass: "bootstrap_token",
    idempotencyKeyHash: contract.idempotencyKeyHash,
    expectedRevision: contract.expectedRevision,
    actualRevision: 0,
    resultingRevision: 1,
  });
  sessions.set(sessionId, {
    createdAt: Date.now(),
    runtimeId: state.runtimeId,
    csrfToken,
    auditId,
    revision: 1,
  });
  return { sessionId, csrfToken, auditId, revision: 1 };
};

/** @param {unknown} error */
const sanitizedRuntimeCode = (error) => {
  if (error instanceof ProtocolError) {
    return "host_protocol_invalid_frame";
  }
  if (error instanceof BrowserProtocolError) {
    return error.code;
  }
  if (error instanceof Error) {
    const allowed = new Set([
      "host_protocol_error",
      "host_protocol_major_mismatch",
      "host_identity_mismatch",
      "host_capability_unsupported",
      "host_schema_mismatch",
      "host_framing_invalid",
      "host_unavailable",
      "controller_identity_invalid",
      "controller_host_identity_mismatch",
      "controller_protocol_major_mismatch",
      "controller_capability_unsupported",
      "controller_schema_mismatch",
    ]);
    return allowed.has(error.message) ? error.message : "runtime_start_failed";
  }
  return "runtime_start_failed";
};

/** @param {unknown} error */
const logSanitizedRuntimeError = async (error) => {
  await appendPrivateJsonLine(runtimeErrorPath, {
    code: sanitizedRuntimeCode(error),
    recordedAt: new Date().toISOString(),
  });
};

/** @param {import("node:child_process").ChildProcess} child */
const stopChild = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 500);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(undefined);
    });
  });
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
};

const shutdown = async () => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const client of websocketServer?.clients ?? []) {
    client.close(1001, "runtime_shutdown");
  }
  await new Promise((resolve) => {
    if (!httpServer?.listening) {
      resolve(undefined);
      return;
    }
    httpServer.close(() => resolve(undefined));
  });
  if (hostProcess) {
    await stopChild(hostProcess);
  }
  const recorded = await readJson(statePath, null);
  if (recorded && typeof recorded === "object" && recorded.pid === process.pid) {
    await removePrivateFile(statePath);
  }
};

/** @param {string} runtimeId */
const launchHost = async (runtimeId) => {
  const hostArgs = [localHostPath, "--data-dir", args.dataDir];
  if (args.hostMode) {
    hostArgs.push("--mode", args.hostMode);
  }

  // This explicit environment is the credential boundary. Controller-side
  // environment variables, provider credentials, and NODE_OPTIONS do not cross it.
  const hostEnvironment = process.platform === "win32" && process.env.SystemRoot
    ? { SystemRoot: process.env.SystemRoot }
    : { LANG: "C.UTF-8" };
  const child = spawn(process.execPath, hostArgs, {
    cwd: args.dataDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: hostEnvironment,
  });
  hostProcess = child;
  let hostDiagnostic = "";
  child.stderr.on("data", (chunk) => {
    if (hostDiagnostic.length < 1_024) {
      hostDiagnostic += Buffer.from(chunk).toString("utf8").slice(0, 1_024);
    }
  });

  try {
    const controllerProtocol = args.hostMode === "controller-incompatible-major"
      ? {
          ...protocolVersion,
          major: protocolVersion.major + 1,
          version: `${protocolVersion.major + 1}.${protocolVersion.minor}.${protocolVersion.patch}`,
        }
      : protocolVersion;
    const controllerRequiredCapabilities = args.hostMode === "controller-unknown-required-capability"
      ? [...hostCapabilities, "sandking.controller.future-required"]
      : [...hostCapabilities];
    const controllerSchemaDigest = args.hostMode === "controller-schema-mismatch"
      ? `sha256:${"0".repeat(64)}`
      : HOST_SCHEMA_DIGEST;

    writeFrame(child.stdin, {
      type: "hello",
      protocol: controllerProtocol,
      release: releaseVersion,
      identity: "controller-runtime",
      controllerId: runtimeId,
      expectedPeerIdentity: "local-host",
      expectedHostId: args.expectedHostId,
      capabilities: {
        required: controllerRequiredCapabilities,
        optional: [],
      },
      schemaDigest: controllerSchemaDigest,
      framing: {
        maxFrameBytes: MAX_FRAME_BYTES,
        maxBulkChunkBytes: MAX_BULK_CHUNK_BYTES,
      },
      observationCursor: null,
    });

    const response = await readFrame(child.stdout);
    if (response.type === "protocol-error") {
      throw new Error(response.code);
    }
    if (response.type !== "hello-ack") {
      throw new Error("host_protocol_error");
    }
    if (response.protocol.major !== protocolVersion.major) {
      throw new Error("host_protocol_major_mismatch");
    }
    if (
      response.identity !== "local-host"
      || response.hostId !== args.expectedHostId
      || response.peerIdentity !== "controller-runtime"
      || response.peerControllerId !== runtimeId
    ) {
      throw Object.assign(new Error("host_identity_mismatch"), {
        expectedHostId: args.expectedHostId,
        observedHostId: response.hostId,
        controllerId: runtimeId,
        observedControllerId: response.peerControllerId,
      });
    }
    const unknownRequired = response.capabilities.required.filter(
      (capability) => !hostCapabilities.includes(capability),
    );
    const missingNegotiated = hostCapabilities.filter(
      (capability) => !response.negotiatedCapabilities.includes(capability),
    );
    if (unknownRequired.length > 0 || missingNegotiated.length > 0) {
      throw new Error("host_capability_unsupported");
    }
    if (response.schemaDigest !== HOST_SCHEMA_DIGEST) {
      throw new Error("host_schema_mismatch");
    }
    if (
      response.framing.maxFrameBytes > MAX_FRAME_BYTES
      || response.framing.maxBulkChunkBytes > MAX_BULK_CHUNK_BYTES
    ) {
      throw new Error("host_framing_invalid");
    }

    const requestId = `ping-${randomBytes(8).toString("hex")}`;
    writeFrame(child.stdin, { type: "ping", requestId });
    const pong = await readFrame(child.stdout);
    if (pong.type !== "pong" || pong.requestId !== requestId) {
      throw new Error("host_unavailable");
    }

    return response;
  } catch (error) {
    await stopChild(child);
    if (
      error instanceof ProtocolError
      && error.code === "frame_truncated"
      && hostDiagnostic.trim() === "host_internal_error"
    ) {
      throw new Error("host_unavailable");
    }
    throw error;
  }
};

/** @param {WebSocket} socket @param {string} code @param {boolean} reloadRequired */
const rejectBrowserProtocol = (socket, code, reloadRequired) => {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(serializeRuntimeControl({
    type: "runtime.protocol-error",
    code,
    retryable: true,
    reloadRequired,
  }), () => socket.close(1002, "protocol_mismatch"));
};

/** @param {string} sessionId */
const revokeBrowserSession = (sessionId) => {
  for (const socket of sessionSockets.get(sessionId) ?? []) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(1008, "session_ended");
    }
  }
};

/**
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {string} sessionId
 */
const endBrowserSession = async (request, response, sessionId) => {
  const activeSession = sessions.get(sessionId);
  const endedSession = endedSessions.get(sessionId);
  const session = activeSession ?? endedSession;
  if (!session) {
    sendJson(response, 401, { code: "session_required" });
    return;
  }

  const rawIdempotencyKey = request.headers["x-sandking-idempotency-key"];
  const idempotencyKey = typeof rawIdempotencyKey === "string" ? rawIdempotencyKey : "";
  const expectedRevision = Number(request.headers["x-sandking-expected-revision"]);
  const idempotencyKeyHash = idempotencyKey.length > 0 && idempotencyKey.length <= 256
    ? hashIdempotencyKey(idempotencyKey)
    : null;
  if (!exactOriginAccepted(request) || request.headers["x-sandking-csrf"] !== session.csrfToken) {
    await recordAudit("browser.session.end", "rejected", {
      code: "csrf_rejected",
      authorizationClass: "runtime_browser_session",
      idempotencyKeyHash,
      expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
      actualRevision: session.revision,
    });
    sendJson(response, 403, { code: "csrf_rejected" });
    return;
  }
  if (!idempotencyKeyHash || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    await recordAudit("browser.session.end", "rejected", {
      code: "mutation_contract_invalid",
      authorizationClass: "runtime_browser_session",
      idempotencyKeyHash,
      expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
      actualRevision: session.revision,
    });
    sendJson(response, 400, mutationFailure(
      "mutation_contract_invalid",
      Number.isSafeInteger(expectedRevision) ? expectedRevision : -1,
      session.revision,
    ));
    return;
  }
  if (
    endedSession
    && endedSession.termination.idempotencyKeyHash === idempotencyKeyHash
    && endedSession.termination.expectedRevision === expectedRevision
  ) {
    await recordAudit("browser.session.end", "observed", {
      authorizationClass: "runtime_browser_session",
      idempotencyKeyHash,
      expectedRevision,
      actualRevision: endedSession.revision,
      resultingRevision: endedSession.revision,
      idempotentReplay: true,
      originalAuditId: endedSession.termination.auditId,
    });
    sendJson(response, 200, {
      type: "mutation_result",
      code: "session_ended",
      revision: endedSession.revision,
      idempotentReplay: true,
      auditId: endedSession.termination.auditId,
    });
    return;
  }
  if (!activeSession || expectedRevision !== activeSession.revision) {
    await recordAudit("browser.session.end", "rejected", {
      code: "mutation_revision_conflict",
      authorizationClass: "runtime_browser_session",
      idempotencyKeyHash,
      expectedRevision,
      actualRevision: session.revision,
    });
    sendJson(response, 409, mutationFailure(
      "mutation_revision_conflict",
      expectedRevision,
      session.revision,
    ));
    return;
  }
  const resultingRevision = activeSession.revision + 1;
  const auditId = await recordAudit("browser.session.end", "accepted", {
    sessionAuditId: activeSession.auditId,
    authorizationClass: "runtime_browser_session",
    idempotencyKeyHash,
    expectedRevision,
    actualRevision: activeSession.revision,
    resultingRevision,
  });
  sessions.delete(sessionId);
  endedSessions.set(sessionId, {
    ...activeSession,
    revision: resultingRevision,
    termination: { idempotencyKeyHash, expectedRevision, auditId },
  });
  revokeBrowserSession(sessionId);
  sendJson(response, 200, {
    type: "mutation_result",
    code: "session_ended",
    revision: resultingRevision,
    idempotentReplay: false,
    auditId,
  });
};

/**
 * @param {WebSocket} socket
 * @param {string} sessionId
 * @param {{csrfToken: string, auditId: string, revision: number}} session
 */
const handleBrowserConnection = (socket, sessionId, session) => {
  const authenticatedSockets = sessionSockets.get(sessionId) ?? new Set();
  authenticatedSockets.add(socket);
  sessionSockets.set(sessionId, authenticatedSockets);
  socket.once("close", () => {
    authenticatedSockets.delete(socket);
    if (authenticatedSockets.size === 0) {
      sessionSockets.delete(sessionId);
    }
  });
  /** @type {"awaiting-hello" | "negotiated" | "rejected"} */
  let phase = "awaiting-hello";
  const handshakeTimeout = setTimeout(() => {
    phase = "rejected";
    rejectBrowserProtocol(socket, "browser_hello_timeout", true);
  }, 3_000);

  /** @param {import("ws").RawData} data */
  const toBuffer = (data) => Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(new Uint8Array(data));

  /** @param {import("ws").RawData} data */
  const parseControlFrame = (data) => {
    const controlData = toBuffer(data);
    if (controlData.byteLength > MAX_BROWSER_CONTROL_BYTES) {
      throw new BrowserProtocolError("browser_control_frame_invalid");
    }
    let json;
    try {
      json = JSON.parse(controlData.toString());
    } catch {
      throw new BrowserProtocolError("browser_control_json_invalid");
    }
    return parseBrowserControl(json);
  };

  /** @param {import("ws").RawData} data @param {boolean} isBinary */
  const processMessage = async (data, isBinary) => {
    if (phase === "rejected") {
      return;
    }
    if (sessions.get(sessionId) !== session) {
      phase = "rejected";
      clearTimeout(handshakeTimeout);
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1008, "session_ended");
      }
      return;
    }
    const wasAwaitingHello = phase === "awaiting-hello";
    if (wasAwaitingHello) {
      clearTimeout(handshakeTimeout);
    }

    try {
      if (phase === "negotiated") {
        if (isBinary) {
          const opaque = decodeBrowserOpaqueFrame(toBuffer(data));
          await recordAudit("browser.opaque.receive", "observed", {
            streamId: opaque.streamId,
            sequence: opaque.sequence,
            eof: opaque.eof,
            byteLength: opaque.data.byteLength,
          });
          return;
        }
        const control = parseControlFrame(data);
        if (control.type !== "browser.ping") {
          throw new BrowserProtocolError("browser_control_unexpected_message");
        }
        socket.send(serializeRuntimeControl({
          type: "runtime.pong",
          requestId: control.requestId,
        }));
        return;
      }

      if (isBinary) {
        throw new BrowserProtocolError("browser_control_frame_invalid");
      }
      const hello = parseControlFrame(data);
      if (hello.type !== "browser.hello") {
        throw new BrowserProtocolError("browser_hello_required");
      }
      if (hello.protocol.major !== BROWSER_PROTOCOL_VERSION.major) {
        throw new BrowserProtocolError("browser_protocol_major_mismatch");
      }
      if (hello.schemaDigest !== BROWSER_SCHEMA_DIGEST) {
        throw new BrowserProtocolError("browser_schema_mismatch");
      }
      const unsupported = hello.capabilities.required.filter(
        (capability) => !browserCapabilities.includes(capability),
      );
      const browserOffered = new Set([
        ...hello.capabilities.required,
        ...hello.capabilities.optional,
      ]);
      const missingRuntimeRequired = runtimeRequiredBrowserCapabilities.filter(
        (capability) => !browserOffered.has(capability),
      );
      if (unsupported.length > 0 || missingRuntimeRequired.length > 0) {
        throw new BrowserProtocolError("browser_capability_unsupported");
      }

      const currentCursor = state.host.observationCursor ?? "host:origin";
      const observation = hello.observationCursor === null
        ? { mode: "snapshot", cursor: currentCursor }
        : hello.observationCursor === currentCursor
          ? { mode: "resume", cursor: currentCursor }
          : { mode: "resynchronize", cursor: currentCursor, reason: "cursor_unavailable" };
      const negotiatedCapabilities = browserCapabilities.filter((capability) =>
        [...hello.capabilities.required, ...hello.capabilities.optional].includes(capability));

      const acknowledgement = serializeRuntimeControl({
        type: "runtime.hello-ack",
        protocol: BROWSER_PROTOCOL_VERSION,
        release: releaseVersion,
        identity: "controller-runtime",
        peerIdentity: "cockpit",
        capabilities: {
          required: [...runtimeRequiredBrowserCapabilities],
          optional: [...runtimeOptionalBrowserCapabilities],
        },
        negotiatedCapabilities,
        schemaDigest: BROWSER_SCHEMA_DIGEST,
        framing: {
          maxControlMessageBytes: Math.min(
            MAX_BROWSER_CONTROL_BYTES,
            hello.framing.maxControlMessageBytes,
          ),
          maxOpaqueStreamChunkBytes: Math.min(
            MAX_BROWSER_OPAQUE_CHUNK_BYTES,
            hello.framing.maxOpaqueStreamChunkBytes,
          ),
        },
        observation,
        session: { csrfToken: session.csrfToken, revision: session.revision },
        viewModel: {
          kind: "cockpit.connection",
          runtime: {
            identity: "controller-runtime",
            runtimeId: state.runtimeId,
            release: releaseVersion,
          },
          host: {
            identity: state.host.identity,
            hostId: state.host.hostId,
            release: state.host.release,
            status: "connected",
          },
          negotiation: {
            protocol: state.protocol,
            capabilities: state.host.negotiatedCapabilities,
            schemaDigest: state.host.schemaDigest,
            framing: state.host.framing,
            observationCursor: state.host.observationCursor,
          },
        },
      });
      await recordAudit("browser.negotiate", "accepted", {
        runtimeId: state.runtimeId,
        hostIdentity: state.host.identity,
        hostId: state.host.hostId,
        observationMode: observation.mode,
        sessionAuditId: session.auditId,
      });
      phase = "negotiated";
      socket.send(acknowledgement);
    } catch (error) {
      const code = error instanceof BrowserProtocolError
        ? error.code
        : "browser_protocol_invalid";
      phase = "rejected";
      rejectBrowserProtocol(socket, code, wasAwaitingHello);
      await recordAudit(
        wasAwaitingHello ? "browser.negotiate" : "browser.frame",
        "rejected",
        { code },
      );
    }
  };

  let processing = Promise.resolve();
  socket.on("message", (data, isBinary) => {
    processing = processing.then(() => processMessage(data, isBinary));
  });
};

const main = async () => {
  await ensurePrivateDirectory(args.dataDir);
  await ensurePrivateDirectory(tokenDirectory);
  const cockpitScript = await readFile(cockpitScriptPath, "utf8");

  try {
    const runtimeId = `runtime-${randomBytes(12).toString("hex")}`;
    const host = await launchHost(runtimeId);
    const negotiationAuditId = await recordAudit("host.negotiate", "accepted", {
      controllerIdentity: "controller-runtime",
      controllerId: runtimeId,
      expectedHostId: args.expectedHostId,
      hostIdentity: host.identity,
      hostId: host.hostId,
      protocolVersion: host.protocol.version,
      capabilities: host.negotiatedCapabilities,
      schemaDigest: host.schemaDigest,
      framing: host.framing,
    });

    httpServer = createServer(async (request, response) => {
      try {
        if (!exactHostAccepted(request)) {
          await recordAudit("http.request", "rejected", { code: "host_mismatch" });
          sendJson(response, 403, { code: "host_mismatch" });
          return;
        }

        if (request.method === "GET" && request.url === "/health") {
          if (request.headers["x-sandking-readiness"] !== state.readinessToken) {
            sendJson(response, 404, { code: "not_found" });
            return;
          }
          sendJson(response, 200, {
            ready: true,
            identity: state.identity,
            runtimeId: state.runtimeId,
            version: state.version,
          });
          return;
        }

        if (request.method === "GET" && request.url?.startsWith("/bootstrap?token=")) {
          const bootstrapRequest = new URL(request.url, `http://127.0.0.1:${state.port}`);
          const token = bootstrapRequest.searchParams.get("token") ?? "";
          const idempotencyKey = bootstrapRequest.searchParams.get("idempotencyKey") ?? "";
          const expectedRevision = Number(bootstrapRequest.searchParams.get("expectedRevision"));
          const exchange = await exchangeBootstrapToken(token, idempotencyKey, expectedRevision);
          if (!exchange.ok) {
            sendJson(response, exchange.status, exchange.body);
            return;
          }
          response.writeHead(302, {
            ...securityHeaders,
            location: "/",
            "set-cookie": `${sessionCookieName}=${exchange.session.sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
          });
          response.end();
          return;
        }

        const cookies = parseCookies(request.headers.cookie);
        const sessionId = cookies[sessionCookieName];
        if (request.method === "POST" && request.url === "/session/end") {
          if (!sessionId) {
            sendJson(response, 401, { code: "session_required" });
            return;
          }
          await withSessionMutationLock(
            sessionId,
            () => endBrowserSession(request, response, sessionId),
          );
          return;
        }

        const activeSession = sessionId ? sessions.get(sessionId) : undefined;
        if (!activeSession) {
          if (sessionId && endedSessions.has(sessionId)) {
            sendJson(response, 401, { code: "session_ended" });
            return;
          }
          sendJson(response, 401, { code: "session_required" });
          return;
        }

        if (request.method === "GET" && request.url === "/") {
          response.writeHead(200, {
            ...securityHeaders,
            "content-type": "text/html; charset=utf-8",
          });
          response.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Sand-King Cockpit</title></head>
  <body>
    <main id="app">Connecting to local Host…</main>
    <button id="reload-cockpit" type="button" hidden>Reload Cockpit</button>
    <script type="module" src="/cockpit.js"></script>
  </body>
</html>`);
          return;
        }

        if (request.method === "GET" && request.url === "/cockpit.js") {
          response.writeHead(200, {
            ...securityHeaders,
            "content-type": "text/javascript; charset=utf-8",
          });
          response.end(cockpitScript);
          return;
        }

        sendJson(response, 404, { code: "not_found" });
      } catch (error) {
        await logSanitizedRuntimeError(error);
        sendJson(response, 500, { code: "internal_error" });
      }
    });

    websocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_BROWSER_CONTROL_BYTES,
    });
    httpServer.on("upgrade", async (request, socket, head) => {
      if (!exactHostAccepted(request)) {
        await recordAudit("websocket.upgrade", "rejected", { code: "host_mismatch" });
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      if (request.url !== "/ws") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!exactOriginAccepted(request)) {
        await recordAudit("websocket.upgrade", "rejected", { code: "origin_mismatch" });
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      const cookies = parseCookies(request.headers.cookie);
      const session = sessions.get(cookies[sessionCookieName]);
      if (!session) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      websocketServer?.handleUpgrade(request, socket, head, (websocket) => {
        handleBrowserConnection(websocket, cookies[sessionCookieName], session);
      });
    });

    await new Promise((resolve, reject) => {
      httpServer?.once("error", reject);
      httpServer?.listen(0, "127.0.0.1", () => resolve(undefined));
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("runtime_listener_invalid");
    }

    state = {
      pid: process.pid,
      runtimeId,
      revision: args.lifecycleRevision,
      port: address.port,
      readinessToken: randomBytes(24).toString("hex"),
      compatibilityKey: "runtime-v1",
      version: releaseVersion,
      identity: "controller-runtime",
      host: {
        identity: host.identity,
        hostId: host.hostId,
        capabilities: host.capabilities,
        negotiatedCapabilities: host.negotiatedCapabilities,
        schemaDigest: host.schemaDigest,
        framing: host.framing,
        observationCursor: host.observationCursor,
        release: host.release,
      },
      protocol: host.protocol,
      listener: { address: "127.0.0.1", class: "loopback" },
      negotiationAuditId,
      startedAt: new Date().toISOString(),
    };
    await writePrivateJson(statePath, state);

    hostProcess?.once("exit", async () => {
      if (!shuttingDown) {
        await logSanitizedRuntimeError(new Error("host_unavailable"));
        await shutdown();
        process.exit(1);
      }
    });
  } catch (error) {
    const code = sanitizedRuntimeCode(error);
    const negotiationAuditId = await recordAudit("host.negotiate", "rejected", {
      code,
      controllerIdentity: "controller-runtime",
      expectedHostIdentity: "local-host",
      expectedHostId: args.expectedHostId,
      ...(error instanceof Error && "controllerId" in error
        ? { controllerId: error.controllerId }
        : {}),
      ...(error instanceof Error && "observedHostId" in error
        ? { observedHostId: error.observedHostId }
        : {}),
    });
    await writePrivateJson(startupErrorPath, { code, auditId: negotiationAuditId });
    if (hostProcess) {
      await stopChild(hostProcess);
    }
    await rm(statePath, { force: true });
    process.exit(1);
  }
};

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.on("message", (/** @type {unknown} */ message) => {
  if (
    !message
    || typeof message !== "object"
    || !("type" in message)
    || !("startupId" in message)
    || message.type !== "runtime.start.commit"
    || message.startupId !== args.startupId
    || startupCommitted
  ) {
    return;
  }
  startupCommitted = true;
  process.send?.({ type: "runtime.start.committed", startupId: args.startupId });
});
process.on("disconnect", async () => {
  if (startupCommitted) {
    return;
  }
  await shutdown();
  process.exit(1);
});
process.on("uncaughtException", async (error) => {
  await logSanitizedRuntimeError(error);
  await shutdown();
  process.exit(1);
});
process.on("unhandledRejection", async (error) => {
  await logSanitizedRuntimeError(error);
  await shutdown();
  process.exit(1);
});

main();
