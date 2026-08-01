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
import { createPlanningSpine } from "./planning-spine.mjs";
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
  /** @type {{dataDir?: string, hostMode?: string, expectedHostId?: string, allowHostIdentityCreate?: boolean, lifecycleRevision?: number, startupId?: string, browserSessionTtlMs?: number}} */
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
    } else if (current === "--allow-host-identity-create") {
      result.allowHostIdentityCreate = true;
    } else if (current === "--lifecycle-revision") {
      result.lifecycleRevision = Number(argv[index + 1]);
      index += 1;
    } else if (current === "--startup-id") {
      result.startupId = argv[index + 1];
      index += 1;
    } else if (current === "--browser-session-ttl-ms") {
      result.browserSessionTtlMs = Number(argv[index + 1]);
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
  if (
    !Number.isSafeInteger(result.browserSessionTtlMs)
    || Number(result.browserSessionTtlMs) < 1
    || Number(result.browserSessionTtlMs) > 15 * 60_000
  ) {
    throw new Error("runtime_browser_session_ttl_missing");
  }
  return /** @type {{dataDir: string, hostMode?: string, expectedHostId: string, allowHostIdentityCreate?: boolean, lifecycleRevision: number, startupId: string, browserSessionTtlMs: number}} */ (result);
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

/** @typedef {{createdAt: number, expiresAt: number, runtimeId: string, csrfToken: string, auditId: string, revision: number}} BrowserSession */
/** @type {Map<string, BrowserSession>} */
const sessions = new Map();
/** @type {Map<string, BrowserSession & {termination: {idempotencyKeyHash: string, expectedRevision: number, auditId: string}}>} */
const endedSessions = new Map();
/** @type {Map<string, BrowserSession>} */
const expiredSessions = new Map();
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const sessionExpiryTimers = new Map();
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
/** @type {Awaited<ReturnType<typeof createPlanningSpine>> | undefined} */
let planningSpine;
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

/** @param {string} code @param {string} authorizationClass @param {number} expectedRevision @param {number} actualRevision @param {string} auditId */
const mutationFailure = (code, authorizationClass, expectedRevision, actualRevision, auditId) => ({
  type: "mutation_failure",
  code,
  retryable: true,
  authorizationClass,
  expectedRevision,
  actualRevision,
  auditId,
});

/** @param {import("node:http").IncomingMessage} request */
const readMutationHeaders = (request) => {
  const rawIdempotencyKey = request.headers["x-sandking-idempotency-key"];
  const idempotencyKey = typeof rawIdempotencyKey === "string" ? rawIdempotencyKey : "";
  const expectedRevision = Number(request.headers["x-sandking-expected-revision"]);
  return {
    idempotencyKeyHash: idempotencyKey.length > 0 && idempotencyKey.length <= 256
      ? hashIdempotencyKey(idempotencyKey)
      : null,
    expectedRevision,
  };
};

/** @param {import("node:http").IncomingMessage} request */
const readJsonBody = async (request) => new Promise((resolve, reject) => {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  request.on("data", (chunk) => {
    if (tooLarge) {
      return;
    }
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 8_192) {
      tooLarge = true;
      return;
    }
    chunks.push(bytes);
  });
  request.once("end", () => {
    if (tooLarge) {
      resolve(null);
      return;
    }
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      resolve(null);
    }
  });
  request.once("error", reject);
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
    const auditId = await recordAudit("browser.session.create", "rejected", {
      code: "mutation_contract_invalid",
      authorizationClass: "bootstrap_token",
      idempotencyKeyHash: /^[a-f0-9]{64}$/.test(idempotencyKey)
        ? hashIdempotencyKey(idempotencyKey)
        : null,
      expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
      actualRevision: 0,
    });
    return {
      ok: false,
      status: 400,
      body: mutationFailure(
        "mutation_contract_invalid",
        "bootstrap_token",
        Number.isSafeInteger(expectedRevision) ? expectedRevision : -1,
        0,
        auditId,
      ),
    };
  }
  const tokenId = createHash("sha256").update(token).digest("hex");
  const idempotencyKeyHash = hashIdempotencyKey(idempotencyKey);
  const existingExchange = bootstrapExchanges.get(tokenId);
  if (existingExchange) {
    const existing = await existingExchange;
    if (existing.idempotencyKeyHash !== idempotencyKeyHash) {
      const auditId = await recordAudit("browser.session.create", "rejected", {
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
          "bootstrap_token",
          expectedRevision,
          existing.resultingRevision ?? 0,
          auditId,
        ),
      };
    }
    if (existing.expectedRevision !== expectedRevision) {
      const auditId = await recordAudit("browser.session.create", "rejected", {
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
          "bootstrap_token",
          expectedRevision,
          existing.resultingRevision ?? 0,
          auditId,
        ),
      };
    }
    if (existing.ok && Number(existing.expiresAt) <= Date.now()) {
      const auditId = await recordAudit("browser.session.create", "rejected", {
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
          "bootstrap_token",
          expectedRevision,
          existing.resultingRevision,
          auditId,
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
      const auditId = await recordAudit("browser.session.create", "rejected", {
        code: "bootstrap_token_invalid",
        authorizationClass: "bootstrap_token",
        idempotencyKeyHash,
        expectedRevision,
        actualRevision: 0,
      });
      const body = mutationFailure(
        "bootstrap_token_invalid",
        "bootstrap_token",
        expectedRevision,
        0,
        auditId,
      );
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
      const auditId = await recordAudit("browser.session.create", "rejected", {
        code: "bootstrap_token_invalid",
        authorizationClass: "bootstrap_token",
        idempotencyKeyHash,
        expectedRevision,
        actualRevision: 0,
      });
      const invalid = {
        ok: false,
        status: 410,
        body: mutationFailure(
          "bootstrap_token_invalid",
          "bootstrap_token",
          expectedRevision,
          0,
          auditId,
        ),
        idempotencyKeyHash,
        expectedRevision,
      };
      return invalid;
    }
    if (tokenState.idempotencyKeyHash !== idempotencyKeyHash) {
      const auditId = await recordAudit("browser.session.create", "rejected", {
        code: "idempotency_key_conflict",
        authorizationClass: "bootstrap_token",
        idempotencyKeyHash,
        expectedRevision,
        actualRevision: 0,
      });
      const body = mutationFailure(
        "idempotency_key_conflict",
        "bootstrap_token",
        expectedRevision,
        0,
        auditId,
      );
      return { ok: false, status: 409, body, idempotencyKeyHash, expectedRevision };
    }
    if (expectedRevision !== Number(tokenState.revision)) {
      const body = mutationFailure(
        "mutation_revision_conflict",
        "bootstrap_token",
        expectedRevision,
        Number(tokenState.revision),
        await recordAudit("browser.session.create", "rejected", {
          code: "mutation_revision_conflict",
          authorizationClass: "bootstrap_token",
          idempotencyKeyHash,
          expectedRevision,
          actualRevision: Number(tokenState.revision),
        }),
      );
      return { ok: false, status: 409, body, idempotencyKeyHash, expectedRevision };
    }
    if (Number(tokenState.expiresAt) <= Date.now()) {
      const auditId = await recordAudit("browser.session.create", "rejected", {
        code: "bootstrap_token_expired",
        authorizationClass: "bootstrap_token",
        idempotencyKeyHash,
        expectedRevision,
        actualRevision: 0,
      });
      const body = mutationFailure(
        "bootstrap_token_expired",
        "bootstrap_token",
        expectedRevision,
        0,
        auditId,
      );
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
  const expiresAt = Date.now() + args.browserSessionTtlMs;
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
    expiresAt,
    runtimeId: state.runtimeId,
    csrfToken,
    auditId,
    revision: 1,
  });
  scheduleBrowserSessionExpiry(sessionId, expiresAt);
  return { sessionId, csrfToken, auditId, revision: 1, expiresAt };
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
  for (const timer of sessionExpiryTimers.values()) {
    clearTimeout(timer);
  }
  sessionExpiryTimers.clear();
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
  if (args.allowHostIdentityCreate) {
    hostArgs.push("--allow-host-identity-create");
  }
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

    let hostIdentityOutcome = null;
    if (args.allowHostIdentityCreate) {
      const requestId = `host-identity-${randomBytes(8).toString("hex")}`;
      const idempotencyKey = `host-identity:${args.startupId}`;
      writeFrame(child.stdin, {
        type: "host.identity.accept",
        requestId,
        hostId: args.expectedHostId,
        authorizationClass: "controller_host_identity_binding",
        idempotencyKey,
        expectedRevision: 0,
      });
      const outcome = await readFrame(child.stdout);
      if (outcome.type === "host.identity.failure") {
        throw Object.assign(new Error("host_protocol_error"), {
          hostIdentityAuditId: outcome.auditId,
        });
      }
      if (
        outcome.type !== "host.identity.result"
        || outcome.requestId !== requestId
        || outcome.hostId !== args.expectedHostId
        || outcome.authorizationClass !== "controller_host_identity_binding"
        || outcome.expectedRevision !== 0
        || outcome.revision !== 1
      ) {
        throw new Error("host_protocol_error");
      }
      hostIdentityOutcome = outcome;
    } else {
      const requestId = `ping-${randomBytes(8).toString("hex")}`;
      writeFrame(child.stdin, { type: "ping", requestId });
      const pong = await readFrame(child.stdout);
      if (pong.type !== "pong" || pong.requestId !== requestId) {
        throw new Error("host_unavailable");
      }
    }

    return { host: response, hostIdentityOutcome };
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

/** @param {string} sessionId @param {string} reason */
const revokeBrowserSession = (sessionId, reason) => {
  for (const socket of sessionSockets.get(sessionId) ?? []) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(1008, reason);
    }
  }
};

/** @param {string} sessionId @param {number} expiresAt */
const scheduleBrowserSessionExpiry = (sessionId, expiresAt) => {
  const timer = setTimeout(() => {
    sessionExpiryTimers.delete(sessionId);
    expireBrowserSessionIfDue(sessionId).catch(logSanitizedRuntimeError);
  }, Math.max(1, expiresAt - Date.now()));
  timer.unref();
  sessionExpiryTimers.set(sessionId, timer);
};

/** @param {string} sessionId */
const expireBrowserSessionIfDue = async (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) {
    return session;
  }
  if (session.expiresAt > Date.now()) {
    if (!sessionExpiryTimers.has(sessionId)) {
      scheduleBrowserSessionExpiry(sessionId, session.expiresAt);
    }
    return session;
  }
  sessions.delete(sessionId);
  const timer = sessionExpiryTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    sessionExpiryTimers.delete(sessionId);
  }
  expiredSessions.set(sessionId, session);
  if (expiredSessions.size > 128) {
    const oldestSessionId = expiredSessions.keys().next().value;
    if (oldestSessionId) {
      expiredSessions.delete(oldestSessionId);
    }
  }
  try {
    await recordAudit("browser.session.expire", "observed", {
      code: "session_expired",
      authorizationClass: "runtime_browser_session",
      sessionAuditId: session.auditId,
      revision: session.revision,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  } finally {
    revokeBrowserSession(sessionId, "session_expired");
  }
  return undefined;
};

/**
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {string} sessionId
 */
const endBrowserSession = async (request, response, sessionId) => {
  const activeSession = await expireBrowserSessionIfDue(sessionId);
  const endedSession = endedSessions.get(sessionId);
  const expiredSession = expiredSessions.get(sessionId);
  const session = activeSession ?? endedSession ?? expiredSession;
  const { idempotencyKeyHash, expectedRevision } = readMutationHeaders(request);
  if (!session) {
    const auditId = await recordAudit("browser.session.end", "rejected", {
      code: "session_required",
      authorizationClass: "runtime_browser_session",
      idempotencyKeyHash,
      expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
      actualRevision: 0,
    });
    sendJson(response, 401, mutationFailure(
      "session_required",
      "runtime_browser_session",
      Number.isSafeInteger(expectedRevision) ? expectedRevision : -1,
      0,
      auditId,
    ));
    return;
  }

  if (expiredSession) {
    const auditId = await recordAudit("browser.session.end", "rejected", {
      code: "session_expired",
      authorizationClass: "runtime_browser_session",
      idempotencyKeyHash,
      expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
      actualRevision: expiredSession.revision,
    });
    sendJson(response, 401, mutationFailure(
      "session_expired",
      "runtime_browser_session",
      Number.isSafeInteger(expectedRevision) ? expectedRevision : -1,
      expiredSession.revision,
      auditId,
    ));
    return;
  }
  if (!exactOriginAccepted(request) || request.headers["x-sandking-csrf"] !== session.csrfToken) {
    const auditId = await recordAudit("browser.session.end", "rejected", {
      code: "csrf_rejected",
      authorizationClass: "runtime_browser_session",
      idempotencyKeyHash,
      expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
      actualRevision: session.revision,
    });
    sendJson(response, 403, mutationFailure(
      "csrf_rejected",
      "runtime_browser_session",
      Number.isSafeInteger(expectedRevision) ? expectedRevision : -1,
      session.revision,
      auditId,
    ));
    return;
  }
  if (!idempotencyKeyHash || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    const auditId = await recordAudit("browser.session.end", "rejected", {
      code: "mutation_contract_invalid",
      authorizationClass: "runtime_browser_session",
      idempotencyKeyHash,
      expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
      actualRevision: session.revision,
    });
    sendJson(response, 400, mutationFailure(
      "mutation_contract_invalid",
      "runtime_browser_session",
      Number.isSafeInteger(expectedRevision) ? expectedRevision : -1,
      session.revision,
      auditId,
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
      authorizationClass: "runtime_browser_session",
      revision: endedSession.revision,
      idempotentReplay: true,
      auditId: endedSession.termination.auditId,
    });
    return;
  }
  if (!activeSession || expectedRevision !== activeSession.revision) {
    const auditId = await recordAudit("browser.session.end", "rejected", {
      code: "mutation_revision_conflict",
      authorizationClass: "runtime_browser_session",
      idempotencyKeyHash,
      expectedRevision,
      actualRevision: session.revision,
    });
    sendJson(response, 409, mutationFailure(
      "mutation_revision_conflict",
      "runtime_browser_session",
      expectedRevision,
      session.revision,
      auditId,
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
  const expiryTimer = sessionExpiryTimers.get(sessionId);
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    sessionExpiryTimers.delete(sessionId);
  }
  endedSessions.set(sessionId, {
    ...activeSession,
    revision: resultingRevision,
    termination: { idempotencyKeyHash, expectedRevision, auditId },
  });
  revokeBrowserSession(sessionId, "session_ended");
  sendJson(response, 200, {
    type: "mutation_result",
    code: "session_ended",
    authorizationClass: "runtime_browser_session",
    revision: resultingRevision,
    idempotentReplay: false,
    auditId,
  });
};

/**
 * @param {WebSocket} socket
 * @param {string} sessionId
 * @param {BrowserSession} session
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
    await expireBrowserSessionIfDue(sessionId);
    if (sessions.get(sessionId) !== session) {
      phase = "rejected";
      clearTimeout(handshakeTimeout);
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1008, expiredSessions.has(sessionId) ? "session_expired" : "session_ended");
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
          planning: await planningSpine?.project(),
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
    const negotiation = await launchHost(runtimeId);
    const host = negotiation.host;
    planningSpine = await createPlanningSpine({
      dataDir: args.dataDir,
      recordAudit,
    });
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
      hostIdentityMutation: negotiation.hostIdentityOutcome
        ? {
            authorizationClass: negotiation.hostIdentityOutcome.authorizationClass,
            expectedRevision: negotiation.hostIdentityOutcome.expectedRevision,
            revision: negotiation.hostIdentityOutcome.revision,
            idempotentReplay: negotiation.hostIdentityOutcome.idempotentReplay,
            auditId: negotiation.hostIdentityOutcome.auditId,
          }
        : null,
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

        if (
          request.method === "GET"
          && (request.url === "/bootstrap" || request.url?.startsWith("/bootstrap?"))
        ) {
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
            "set-cookie": `${sessionCookieName}=${exchange.session.sessionId}; HttpOnly; SameSite=Strict; Path=/`,
          });
          response.end();
          return;
        }

        const cookies = parseCookies(request.headers.cookie);
        const sessionId = cookies[sessionCookieName];
        if (request.method === "POST" && request.url === "/session/end") {
          if (!sessionId) {
            const { idempotencyKeyHash, expectedRevision } = readMutationHeaders(request);
            const auditId = await recordAudit("browser.session.end", "rejected", {
              code: "session_required",
              authorizationClass: "runtime_browser_session",
              idempotencyKeyHash,
              expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
              actualRevision: 0,
            });
            sendJson(response, 401, mutationFailure(
              "session_required",
              "runtime_browser_session",
              Number.isSafeInteger(expectedRevision) ? expectedRevision : -1,
              0,
              auditId,
            ));
            return;
          }
          await withSessionMutationLock(
            sessionId,
            () => endBrowserSession(request, response, sessionId),
          );
          return;
        }

        const activeSession = sessionId
          ? await expireBrowserSessionIfDue(sessionId)
          : undefined;
        if (!activeSession) {
          if (sessionId && expiredSessions.has(sessionId)) {
            sendJson(response, 401, { code: "session_expired" });
            return;
          }
          if (sessionId && endedSessions.has(sessionId)) {
            sendJson(response, 401, { code: "session_ended" });
            return;
          }
          sendJson(response, 401, { code: "session_required" });
          return;
        }

        if (
          request.method === "POST"
          && (
            request.url === "/planning/sessions/open"
            || request.url === "/planning/stages/not-used"
          )
        ) {
          const body = await readJsonBody(request);
          const record = body && typeof body === "object" ? body : {};
          const { idempotencyKeyHash, expectedRevision } = readMutationHeaders(request);
          const authorizationAccepted = exactOriginAccepted(request)
            && request.headers["x-sandking-csrf"] === activeSession.csrfToken;
          const outcome = request.url === "/planning/sessions/open"
            ? await planningSpine?.openFocusedSession({
                authorizationAccepted,
                idempotencyKeyHash,
                expectedRevision,
                workContextId: "workContextId" in record
                  ? String(record.workContextId)
                  : "",
              })
            : await planningSpine?.markStageNotUsed({
                authorizationAccepted,
                idempotencyKeyHash,
                expectedRevision,
                journeyId: "journeyId" in record ? String(record.journeyId) : "",
                stageId: "stageId" in record ? String(record.stageId) : "",
              });
          if (!outcome) {
            throw new Error("planning_spine_unavailable");
          }
          sendJson(response, outcome.status, outcome.body);
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
      const sessionId = cookies[sessionCookieName];
      const session = sessionId
        ? await expireBrowserSessionIfDue(sessionId)
        : undefined;
      if (!session) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      websocketServer?.handleUpgrade(request, socket, head, (websocket) => {
        handleBrowserConnection(websocket, sessionId, session);
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
      compatibilityKey: "runtime-v2-planning-spine",
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
      hostIdentityAuditId: negotiation.hostIdentityOutcome?.auditId ?? null,
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
