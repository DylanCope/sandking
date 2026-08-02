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
  encodeBrowserOpaqueFrame,
  parseBrowserControl,
  runtimeOptionalBrowserCapabilities,
  runtimeRequiredBrowserCapabilities,
  serializeRuntimeControl,
} from "./browser-protocol.mjs";
import { createControllerSessionManager, ControllerSessionError } from "./controller-sessions.mjs";
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
  projectPreparationProjection,
} from "./project-registration.mjs";
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
/** @type {Set<WebSocket>} */
const negotiatedBrowserSockets = new Set();
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
let currentProjectPreparation = projectPreparationProjection();
/** @type {string | null} */
let currentProjectPath = null;
/** @type {any[]} */
let controllerProviderProjection = [];
/** @type {Awaited<ReturnType<typeof createControllerSessionManager>> | undefined} */
let controllerSessions;
/** @type {any} */
let state;
/** @type {any} */
let currentHarnessRunObservation = {
  type: "harness.run.observe.result",
  requestId: "harness-observe-cached",
  code: "harness_run_absent",
  mode: "snapshot",
  run: null,
  events: [],
  nextSequence: 0,
  outcome: null,
  logStreams: [],
  terminalEnvelopeValidation: null,
};
let shuttingDown = false;
let startupCommitted = false;
/** @type {Promise<void> | null} */
let hostDisconnectionPromise = null;
let hostOperationQueue = Promise.resolve();
let projectPreparationQueue = Promise.resolve();
let projectSessionMutationQueue = Promise.resolve();
let hostMutationFailureQueue = Promise.resolve();
/** @type {Map<string, {fingerprint: string, status: number, response: any}>} */
const projectSessionOutcomes = new Map();
/** @type {Map<string, {fingerprint: string, status: number, response: any}>} */
const hostMutationFailureOutcomes = new Map();
/** @type {Map<string, {fingerprint: string, response: any}>} */
const focusedHostMutationOutcomes = new Map();

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

const hostAffectedViews = Object.freeze([
  "project-preparation",
  "harness-run-observation",
]);
const hostUnaffectedViews = Object.freeze([
  "planning-spine",
  "controller-sessions",
]);

const hostConnectionStateMessage = () => ({
  type: "runtime.connection-state",
  boundary: "host",
  hostId: state.host.hostId,
  status: "disconnected",
  freshness: "stale",
  failure: state.host.failure,
  affectedViews: [...hostAffectedViews],
  unaffectedViews: [...hostUnaffectedViews],
  retainedObservationCursor: state.host.observationCursor,
});

/** @param {"host_disconnected" | "host_protocol_invalid" | "host_observation_resynchronization_failed"} code */
const markHostDisconnected = async (code) => {
  if (!state) {
    return null;
  }
  if (state.host.status !== "disconnected" && !hostDisconnectionPromise) {
    hostDisconnectionPromise = (async () => {
      const observedAt = new Date().toISOString();
      const auditId = await recordAudit("host.connection", "observed", {
        code,
        hostId: state.host.hostId,
        controllerId: state.runtimeId,
        affectedViews: [...hostAffectedViews],
        unaffectedViews: [...hostUnaffectedViews],
        retainedObservationCursor: state.host.observationCursor,
        retainedProjectId: currentProjectPreparation.current?.projectId ?? null,
        retainedHarnessRunId: currentHarnessRunObservation.run?.harnessRunId ?? null,
        registrationCreated: false,
        approvalRecorded: false,
        harnessRunStarted: false,
        privilegedMutation: false,
        inventedSuccess: false,
      });
      state.host.status = "disconnected";
      state.host.freshness = "stale";
      state.host.failure = { code, retryable: true, auditId, observedAt };
      await writePrivateJson(statePath, state);
      const message = hostConnectionStateMessage();
      for (const socket of negotiatedBrowserSockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(serializeRuntimeControl(message));
        }
      }
    })();
  }
  await hostDisconnectionPromise;
  return hostConnectionStateMessage();
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

/** @param {unknown} value @returns {string} */
const canonicalJson = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/** @param {unknown} value */
const mutationRequestFingerprint = (value) => hashIdempotencyKey(canonicalJson(value));

/** @template T @param {() => Promise<T>} operation */
const withHostMutationFailureLock = (operation) => {
  const current = hostMutationFailureQueue.catch(() => undefined).then(operation);
  hostMutationFailureQueue = current.then(() => undefined, () => undefined);
  return current;
};

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

/**
 * @param {"host_disconnected" | "host_protocol_invalid"} failureCode
 * @param {string} action
 * @param {string} authorizationClass
 * @param {number} expectedRevision
 * @param {string | null} idempotencyKeyHash
 * @param {unknown} requestContent
 * @param {{project?: any, harness?: any, mutations?: any, effects?: Record<string, boolean>} | null} [acceptedState]
 */
const hostMutationFailure = async (
  failureCode,
  action,
  authorizationClass,
  expectedRevision,
  idempotencyKeyHash,
  requestContent,
  acceptedState = null,
) => withHostMutationFailureLock(async () => {
  const actualRevision = currentProjectPreparation.current?.revision ?? 0;
  const prohibitedSideEffects = {
    projectRegistrationCreated: acceptedState?.effects?.projectRegistrationCreated ?? false,
    harnessRegistrationCreated: acceptedState?.effects?.harnessRegistrationCreated ?? false,
    harnessPinChanged: acceptedState?.effects?.harnessPinChanged ?? false,
    launchRequestPrepared: false,
    approvalRecorded: false,
    harnessRunStarted: false,
    projectFileWrite: false,
    privilegedMutation: false,
  };
  const acceptedReferences = acceptedState ? {
    projectId: acceptedState.project?.projectId ?? null,
    harnessId: acceptedState.harness?.harnessId
      ?? acceptedState.project?.harness?.harnessId
      ?? null,
    projectRegistrationAuditId:
      acceptedState.mutations?.projectRegistration?.auditId ?? null,
    harnessRegistrationAuditId:
      acceptedState.mutations?.harnessRegistration?.auditId ?? null,
    harnessPinAuditId: acceptedState.mutations?.harnessPin?.auditId ?? null,
  } : {};
  const acceptedOutcome = acceptedState ? {
    project: acceptedState.project ?? null,
    harness: acceptedState.harness ?? null,
    mutations: acceptedState.mutations ?? null,
  } : {};
  if (
    !idempotencyKeyHash
    || !Number.isSafeInteger(expectedRevision)
    || expectedRevision < 0
  ) {
    const auditId = await recordAudit(action, "rejected", {
      code: "mutation_contract_invalid",
      hostId: state.host.hostId,
      authorizationClass,
      idempotencyKeyHash,
      expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
      actualRevision,
      ...acceptedReferences,
      ...prohibitedSideEffects,
    });
    return {
      status: 400,
      body: {
        ...mutationFailure(
          "mutation_contract_invalid",
          authorizationClass,
          Number.isSafeInteger(expectedRevision) ? expectedRevision : -1,
          actualRevision,
          auditId,
        ),
        retryable: false,
        idempotentReplay: false,
        hostId: state.host.hostId,
        freshness: "stale",
        ...acceptedOutcome,
        prohibitedSideEffects,
      },
    };
  }
  const fingerprint = mutationRequestFingerprint({
    expectedRevision,
    requestContent,
  });
  const outcomeKey = `${action}\0${idempotencyKeyHash}`;
  const existing = hostMutationFailureOutcomes.get(outcomeKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      const auditId = await recordAudit(action, "rejected", {
        code: "idempotency_key_conflict",
        hostId: state.host.hostId,
        authorizationClass,
        idempotencyKeyHash,
        expectedRevision,
        actualRevision,
        ...prohibitedSideEffects,
      });
      return {
        status: 409,
        body: {
          ...mutationFailure(
            "idempotency_key_conflict",
            authorizationClass,
            expectedRevision,
            actualRevision,
            auditId,
          ),
          retryable: false,
          idempotentReplay: false,
          hostId: state.host.hostId,
          freshness: "stale",
          prohibitedSideEffects,
        },
      };
    }
    await recordAudit(action, "observed", {
      code: existing.response.code,
      hostId: state.host.hostId,
      authorizationClass,
      idempotencyKeyHash,
      expectedRevision,
      actualRevision,
      idempotentReplay: true,
      originalAuditId: existing.response.auditId,
      projectId: existing.response.project?.projectId ?? null,
      harnessId: existing.response.harness?.harnessId
        ?? existing.response.project?.harness?.harnessId
        ?? null,
      projectRegistrationAuditId:
        existing.response.mutations?.projectRegistration?.auditId ?? null,
      harnessRegistrationAuditId:
        existing.response.mutations?.harnessRegistration?.auditId ?? null,
      harnessPinAuditId: existing.response.mutations?.harnessPin?.auditId ?? null,
      ...existing.response.prohibitedSideEffects,
    });
    return {
      status: existing.status,
      body: { ...structuredClone(existing.response), idempotentReplay: true },
    };
  }
  const auditId = await recordAudit(action, "rejected", {
    code: failureCode,
    hostId: state.host.hostId,
    authorizationClass,
    idempotencyKeyHash,
    expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
    actualRevision,
    ...acceptedReferences,
    ...prohibitedSideEffects,
  });
  const body = {
    type: "mutation_failure",
    code: failureCode,
    retryable: true,
    authorizationClass,
    expectedRevision,
    actualRevision,
    auditId,
    idempotentReplay: false,
    hostId: state.host.hostId,
    freshness: "stale",
    ...acceptedOutcome,
    prohibitedSideEffects,
  };
  const outcome = {
    status: 503,
    body,
  };
  hostMutationFailureOutcomes.set(outcomeKey, {
    fingerprint,
    status: outcome.status,
    response: structuredClone(body),
  });
  return outcome;
});

/** @param {import("node:http").IncomingMessage} request */
const readMutationHeaders = (request) => {
  const rawIdempotencyKey = request.headers["x-sandking-idempotency-key"];
  const idempotencyKey = typeof rawIdempotencyKey === "string" ? rawIdempotencyKey : "";
  const expectedRevision = Number(request.headers["x-sandking-expected-revision"]);
  return {
    idempotencyKey,
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
      "host_disconnected",
      "host_protocol_invalid",
      "host_observation_resynchronization_failed",
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
  await controllerSessions?.shutdown();
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

/** @template T @param {() => Promise<T>} operation */
const withProjectPreparationLock = (operation) => {
  const current = projectPreparationQueue.catch(() => undefined).then(operation);
  projectPreparationQueue = current.then(() => undefined, () => undefined);
  return current;
};

/** @template T @param {() => Promise<T>} operation */
const withProjectSessionMutationLock = (operation) => {
  const current = projectSessionMutationQueue.catch(() => undefined).then(operation);
  projectSessionMutationQueue = current.then(() => undefined, () => undefined);
  return current;
};

/** @param {any} message */
const requestHostOperation = (message) => {
  const current = hostOperationQueue.catch(() => undefined).then(async () => {
    if (
      state?.host?.status === "disconnected"
      || !hostProcess
      || !hostProcess.stdin.writable
      || !hostProcess.stdout.readable
    ) {
      await markHostDisconnected("host_disconnected");
      throw new ControllerSessionError("host_disconnected");
    }
    try {
      writeFrame(hostProcess.stdin, message);
      const frame = await readProtocolFrame(hostProcess.stdout);
      if (frame.channel !== "control") {
        throw new Error("host_protocol_error");
      }
      const response = frame.message;
      if (!("requestId" in response) || response.requestId !== message.requestId) {
        throw new Error("host_protocol_error");
      }
      if (response.type === "harness.run.logs.result") {
        const bulk = await readProtocolFrame(hostProcess.stdout);
        if (
          bulk.channel !== "bulk"
          || bulk.streamId !== response.streamId
          || bulk.sequence !== response.range.start
          || bulk.eof !== response.range.eof
          || bulk.data.byteLength !== response.byteLength
          || `sha256:${createHash("sha256").update(bulk.data).digest("hex")}` !== response.sha256
        ) {
          throw new Error("host_protocol_error");
        }
        return { ...response, data: bulk.data };
      }
      return response;
    } catch (error) {
      const code = error instanceof ProtocolError
        ? error.code === "frame_truncated"
          ? "host_disconnected"
          : "host_protocol_invalid"
        : error instanceof Error && error.message === "host_protocol_error"
          ? "host_protocol_invalid"
          : "host_disconnected";
      await markHostDisconnected(code);
      throw new ControllerSessionError(code);
    }
  });
  hostOperationQueue = current.then(() => undefined, () => undefined);
  return current;
};

/**
 * @param {string} action
 * @param {any} message
 * @param {unknown} requestContent
 */
const requestFocusedHostMutation = async (action, message, requestContent) => {
  const idempotencyKeyHash = typeof message.idempotencyKey === "string"
    && message.idempotencyKey.length > 0
    && message.idempotencyKey.length <= 256
    ? hashIdempotencyKey(message.idempotencyKey)
    : null;
  const fingerprint = mutationRequestFingerprint({
    expectedRevision: message.expectedRevision,
    requestContent,
  });
  const outcomeKey = idempotencyKeyHash ? `${action}\0${idempotencyKeyHash}` : null;
  const existing = outcomeKey ? focusedHostMutationOutcomes.get(outcomeKey) : null;
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      const actualRevision = Number.isSafeInteger(existing.response.revision)
        ? existing.response.revision
        : Number.isSafeInteger(existing.response.actualRevision)
          ? existing.response.actualRevision
          : message.expectedRevision;
      const auditId = await recordAudit(action, "rejected", {
        code: "idempotency_key_conflict",
        authorizationClass: message.authorizationClass,
        idempotencyKeyHash,
        expectedRevision: message.expectedRevision,
        actualRevision,
        originalAuditId: existing.response.auditId,
        launchRequestPrepared: false,
        approvalRecorded: false,
        harnessRunStarted: false,
        privilegedMutation: false,
      });
      throw new ControllerSessionError("idempotency_key_conflict", {
        ...mutationFailure(
          "idempotency_key_conflict",
          message.authorizationClass,
          message.expectedRevision,
          actualRevision,
          auditId,
        ),
        retryable: false,
        idempotentReplay: false,
        prohibitedSideEffects: {
          launchRequestPrepared: false,
          approvalRecorded: false,
          harnessRunStarted: false,
          privilegedMutation: false,
        },
      });
    }
    await recordAudit(action, "observed", {
      code: existing.response.code,
      authorizationClass: message.authorizationClass,
      idempotencyKeyHash,
      expectedRevision: message.expectedRevision,
      idempotentReplay: true,
      originalAuditId: existing.response.auditId,
      launchRequestId: existing.response.launchRequest?.launchRequestId
        ?? existing.response.run?.launchRequestId
        ?? null,
      harnessRunId: existing.response.run?.harnessRunId ?? null,
    });
    return {
      ...structuredClone(existing.response),
      requestId: message.requestId,
      idempotentReplay: true,
    };
  }
  try {
    const outcome = /** @type {any} */ (await requestHostOperation(message));
    if (
      outcomeKey
      && outcome
      && typeof outcome === "object"
      && typeof outcome.auditId === "string"
      && outcome.code !== "idempotency_key_conflict"
    ) {
      focusedHostMutationOutcomes.set(outcomeKey, {
        fingerprint,
        response: structuredClone(outcome),
      });
    }
    return outcome;
  } catch (error) {
    const failureCode = error instanceof ControllerSessionError
      && (error.code === "host_disconnected" || error.code === "host_protocol_invalid")
      ? error.code
      : null;
    if (!failureCode) {
      throw error;
    }
    const failure = await hostMutationFailure(
      failureCode,
      action,
      message.authorizationClass,
      message.expectedRevision,
      idempotencyKeyHash,
      requestContent,
    );
    throw new ControllerSessionError(failure.body.code, failure.body);
  }
};

/** @param {string} key @param {string} operation */
const derivedHostIdempotencyKey = (key, operation) => createHash("sha256")
  .update(`${operation}\0${key}`)
  .digest("hex");

/** @param {any} outcome */
const projectMutationSummary = (outcome) => outcome ? {
  code: outcome.code,
  authorizationClass: outcome.authorizationClass,
  expectedRevision: outcome.expectedRevision,
  revision: outcome.revision,
  idempotentReplay: outcome.idempotentReplay,
  auditId: outcome.auditId,
} : null;

const projectFailureStatus = Object.freeze({
  project_path_invalid: 400,
  bounded_configuration_invalid: 400,
  mutation_contract_invalid: 400,
  project_not_found: 404,
  harness_not_found: 404,
  project_path_missing: 409,
  project_path_moved: 409,
  project_path_replaced: 409,
  project_path_conflict: 409,
  project_path_tombstoned: 409,
  project_configuration_conflict: 409,
  harness_pin_missing: 409,
  harness_pin_invalid: 409,
  harness_workspace_invalid: 409,
  idempotency_key_conflict: 409,
  mutation_revision_conflict: 409,
});

/**
 * @param {string} code
 * @param {number} expectedRevision
 * @param {number} actualRevision
 * @param {string | null} idempotencyKeyHash
 * @param {string[]} actions
 */
const runtimeProjectFailure = async (
  code,
  expectedRevision,
  actualRevision,
  idempotencyKeyHash,
  actions,
) => {
  const auditId = await recordAudit("project.prepare", "rejected", {
    code,
    authorizationClass: "host_local_project_preparation",
    idempotencyKeyHash,
    expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
    actualRevision,
    directoryScanPerformed: false,
    projectFileWrite: false,
    harnessWorkspaceWrite: false,
  });
  return {
    type: "project_preparation_failure",
    code,
    retryable: code !== "bounded_configuration_invalid"
      && code !== "project_configuration_conflict",
    authorizationClass: "host_local_project_preparation",
    expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
    actualRevision,
    auditId,
    resolution: { summary: code, actions },
    prohibitedSideEffects: {
      directoryScan: false,
      projectFileWrite: false,
      harnessPinWrite: false,
      approvalRequest: false,
    },
  };
};

/**
 * @param {{path: unknown, configuration: unknown, idempotencyKey: string, idempotencyKeyHash: string | null, expectedRevision: number}} request
 */
const prepareExplicitProject = (request) => withProjectPreparationLock(async () => {
  if (
    typeof request.idempotencyKey !== "string"
    || request.idempotencyKey.length === 0
    || request.idempotencyKey.length > 256
    || !Number.isSafeInteger(request.expectedRevision)
    || request.expectedRevision < 0
  ) {
    return {
      status: 400,
      body: await runtimeProjectFailure(
        "mutation_contract_invalid",
        request.expectedRevision,
        0,
        request.idempotencyKeyHash,
        ["retry_with_valid_mutation_contract"],
      ),
    };
  }

  /** @param {string} label */
  const requestId = (label) => `${label}-${randomBytes(8).toString("hex")}`;
  const inspection = await requestHostOperation({
    type: "project.inspect",
    requestId: requestId("project-inspect"),
    path: typeof request.path === "string" ? request.path : "",
  });
  if (inspection.type === "project.operation.failure") {
    return {
      status: projectFailureStatus[inspection.code] ?? 409,
      body: inspection,
    };
  }
  if (inspection.type !== "project.inspect.result") {
    throw new Error("host_protocol_error");
  }

  const inspectedProject = inspection.project;
  const projectRegistration = await requestHostOperation({
    type: "project.register",
    requestId: requestId("project-register"),
    path: typeof request.path === "string" ? request.path : "",
    configuration: request.configuration,
    authorizationClass: "host_local_project_registration",
    idempotencyKey: derivedHostIdempotencyKey(
      request.idempotencyKey,
      "project.register",
    ),
    expectedRevision: request.expectedRevision,
  });
  if (projectRegistration.type === "project.operation.failure") {
    return {
      status: projectFailureStatus[projectRegistration.code] ?? 409,
      body: projectRegistration,
    };
  }
  if (projectRegistration.type !== "project.register.result") {
    throw new Error("host_protocol_error");
  }
  // An idempotent registration replay returns its original revisioned outcome;
  // the preceding inspection remains the current canonical Project snapshot.
  let project = inspectedProject ?? projectRegistration.project;
  currentProjectPreparation = projectPreparationProjection(project);
  currentProjectPath = project.canonicalPath;

  let harness = null;
  let harnessRegistration = null;
  let pin = null;
  try {
    const harnessInspection = await requestHostOperation({
      type: "harness.conformance.inspect",
      requestId: requestId("harness-inspect"),
    });
    if (harnessInspection.type !== "harness.conformance.inspect.result") {
      throw new Error("host_protocol_error");
    }
    harness = harnessInspection.harness;
    if (!harness) {
      harnessRegistration = await requestHostOperation({
        type: "harness.conformance.register",
        requestId: requestId("harness-register"),
        name: "Sand-King Conformance Harness",
        authorizationClass: "host_local_harness_registration",
        idempotencyKey: derivedHostIdempotencyKey(
          request.idempotencyKey,
          "harness.conformance.register",
        ),
        expectedRevision: 0,
      });
      if (harnessRegistration.type === "project.operation.failure") {
        return {
          status: projectFailureStatus[harnessRegistration.code] ?? 409,
          body: harnessRegistration,
        };
      }
      if (harnessRegistration.type !== "harness.conformance.register.result") {
        throw new Error("host_protocol_error");
      }
      harness = harnessRegistration.harness;
    }

    if (
      !project.harness
      || project.harness.harnessId !== harness.harnessId
      || project.harness.pinnedRevision !== harness.immutableRevision
    ) {
      pin = await requestHostOperation({
        type: "project.harness.pin",
        requestId: requestId("project-pin"),
        projectId: project.projectId,
        harnessId: harness.harnessId,
        immutableRevision: harness.immutableRevision,
        boundedConfiguration: {
          adapterProtocol: "1.0.0",
          launchProfile: "delegated-work",
        },
        authorizationClass: "host_local_project_configuration",
        idempotencyKey: derivedHostIdempotencyKey(
          request.idempotencyKey,
          "project.harness.pin",
        ),
        expectedRevision: project.revision,
      });
      if (pin.type === "project.operation.failure") {
        return { status: projectFailureStatus[pin.code] ?? 409, body: pin };
      }
      if (pin.type !== "project.harness.pin.result") {
        throw new Error("host_protocol_error");
      }
      project = pin.project;
      currentProjectPreparation = projectPreparationProjection(project);
    }
  } catch (error) {
    if (
      error instanceof ControllerSessionError
      && (error.code === "host_disconnected" || error.code === "host_protocol_invalid")
    ) {
      const mutations = {
        projectRegistration: projectMutationSummary(projectRegistration),
        harnessRegistration: projectMutationSummary(harnessRegistration),
        harnessPin: projectMutationSummary(pin),
      };
      throw new ControllerSessionError(error.code, {
        project: currentProjectPreparation.current,
        harness,
        mutations,
        effects: {
          projectRegistrationCreated: projectRegistration.code === "project_registered",
          harnessRegistrationCreated:
            mutations.harnessRegistration?.code === "conformance_harness_registered",
          harnessPinChanged: mutations.harnessPin?.code === "project_harness_pinned",
        },
      });
    }
    throw error;
  }

  currentProjectPreparation = projectPreparationProjection(project);
  currentProjectPath = project.canonicalPath;
  const preparationAuditId = await recordAudit("project.prepare", "observed", {
    authorizationClass: "host_local_project_preparation",
    idempotencyKeyHash: request.idempotencyKeyHash,
    expectedRevision: request.expectedRevision,
    resultingRevision: project.revision,
    projectId: project.projectId,
    harnessId: project.harness?.harnessId ?? null,
    pinnedRevision: project.harness?.pinnedRevision ?? null,
    checksReady: project.readiness.checks === "ready",
    configurationReady: project.readiness.configuration === "ready",
    launchRequestReady: project.readiness.launchRequest === "ready",
    directoryScanPerformed: false,
    projectFileWrite: false,
    separateApprovalRequired: false,
  });
  return {
    status: 200,
    body: {
      type: "project_preparation_result",
      code: "project_ready",
      authorizationClass: "host_local_project_preparation",
      expectedRevision: request.expectedRevision,
      revision: project.revision,
      auditId: preparationAuditId,
      project: currentProjectPreparation.current,
      mutations: {
        projectRegistration: projectMutationSummary(projectRegistration),
        harnessRegistration: projectMutationSummary(harnessRegistration),
        harnessPin: projectMutationSummary(pin),
      },
      prohibitedSideEffects: {
        directoryScan: false,
        projectFileWrite: false,
        trackedSandKingFileWrite: false,
        approvalRequest: false,
      },
    },
  };
});

/** @param {{sessionId: string, providerSessionId: string, workContext: any, operation: string, input: unknown}} request */
const handleProviderOperation = async (request) => {
  const input = request.input && typeof request.input === "object"
    ? request.input
    : {};
  if (request.operation === "work-context.inspect") {
    if (request.workContext.kind === "project") {
      const project = currentProjectPreparation.current;
      if (!project || project.projectId !== request.workContext.workContextId || !project.harness) {
        throw new ControllerSessionError("project_work_context_unavailable");
      }
      return {
        type: "project.work-context",
        projectId: project.projectId,
        revision: project.revision,
        displayName: project.displayName,
        harnessId: project.harness.harnessId,
        pinnedRevision: project.harness.pinnedRevision,
      };
    }
    return {
      type: "planning.work-context",
      workContextId: request.workContext.workContextId,
      canonicalReference: request.workContext.canonicalReference,
    };
  }
  if (request.workContext.kind !== "project") {
    throw new ControllerSessionError("provider_operation_unsupported");
  }
  if (request.operation === "launch-request.prepare") {
    const message = {
      type: "launch.request.prepare",
      requestId: `launch-prepare-${randomBytes(8).toString("hex")}`,
      projectId: request.workContext.workContextId,
      parameters: "parameters" in input ? input.parameters : null,
      controllerId: state.runtimeId,
      controllerSessionId: request.sessionId,
      authorizationClass: "focused_controller_launch",
      idempotencyKey: "idempotencyKey" in input ? String(input.idempotencyKey) : "",
      expectedRevision: 0,
      expiresInSeconds: "expiresInSeconds" in input ? Number(input.expiresInSeconds) : 0,
    };
    return requestFocusedHostMutation("launch.request.prepare", message, {
      projectId: message.projectId,
      parameters: message.parameters,
      controllerId: message.controllerId,
      controllerSessionId: message.controllerSessionId,
      authorizationClass: message.authorizationClass,
      expiresInSeconds: message.expiresInSeconds,
    });
  }
  if (request.operation === "launch-request.decide") {
    const message = {
      type: "launch.request.decision",
      requestId: `launch-decision-${randomBytes(8).toString("hex")}`,
      launchRequestId: "launchRequestId" in input ? String(input.launchRequestId) : "",
      decision: "decision" in input ? String(input.decision) : "",
      controllerId: state.runtimeId,
      controllerSessionId: request.sessionId,
      authorizationClass: "focused_controller_launch",
      idempotencyKey: "idempotencyKey" in input ? String(input.idempotencyKey) : "",
      expectedRevision: "expectedRevision" in input ? Number(input.expectedRevision) : -1,
    };
    return requestFocusedHostMutation("launch.request.decision", message, {
      launchRequestId: message.launchRequestId,
      decision: message.decision,
      controllerId: message.controllerId,
      controllerSessionId: message.controllerSessionId,
      authorizationClass: message.authorizationClass,
    });
  }
  if (request.operation === "harness-run.start") {
    const message = {
      type: "harness.run.start",
      requestId: `harness-run-start-${randomBytes(8).toString("hex")}`,
      launchRequestId: "launchRequestId" in input ? String(input.launchRequestId) : "",
      controllerId: state.runtimeId,
      controllerSessionId: request.sessionId,
      authorizationClass: "approved_launch_request_execution",
      idempotencyKey: "idempotencyKey" in input ? String(input.idempotencyKey) : "",
      expectedRevision: "expectedRevision" in input ? Number(input.expectedRevision) : -1,
    };
    return requestFocusedHostMutation("harness.run.start", message, {
      launchRequestId: message.launchRequestId,
      controllerId: message.controllerId,
      controllerSessionId: message.controllerSessionId,
      authorizationClass: message.authorizationClass,
    });
  }
  if (request.operation === "harness-run.lookup") {
    return requestHostOperation({
      type: "harness.run.lookup",
      requestId: `harness-run-lookup-${randomBytes(8).toString("hex")}`,
      idempotencyKey: "idempotencyKey" in input ? String(input.idempotencyKey) : "",
    });
  }
  throw new ControllerSessionError("provider_operation_unsupported");
};

/**
 * @param {{authorizationAccepted: boolean, idempotencyKey: string, idempotencyKeyHash: string | null, expectedRevision: number, projectId: string, providerId: string}} request
 */
const openProjectControllerSession = (request) => withProjectSessionMutationLock(async () => {
  const authorizationClass = "project_focused_session";
  const project = currentProjectPreparation.current;
  const selectedProviderId = request.providerId === "conformance-controller-v1"
    || request.providerId === "claude-code"
    ? request.providerId
    : null;
  const fingerprint = hashIdempotencyKey(JSON.stringify({
    projectId: request.projectId,
    providerId: request.providerId,
    expectedRevision: request.expectedRevision,
  }));
  const existing = request.idempotencyKeyHash
    ? projectSessionOutcomes.get(request.idempotencyKeyHash)
    : null;
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      const auditId = await recordAudit("project.session.open", "rejected", {
        code: "idempotency_key_conflict",
        authorizationClass,
        idempotencyKeyHash: request.idempotencyKeyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: project?.revision ?? 0,
      });
      return {
        status: 409,
        body: {
          ...mutationFailure(
            "idempotency_key_conflict",
            authorizationClass,
            request.expectedRevision,
            project?.revision ?? 0,
            auditId,
          ),
          idempotentReplay: false,
        },
      };
    }
    await recordAudit("project.session.open", "observed", {
      authorizationClass,
      idempotencyKeyHash: request.idempotencyKeyHash,
      idempotentReplay: true,
      originalAuditId: existing.response.auditId,
      code: existing.response.code,
      ...(existing.response.session
        ? { sessionId: existing.response.session.sessionId }
        : {}),
    });
    return {
      status: existing.response.type === "mutation_result" ? 200 : existing.status,
      body: { ...structuredClone(existing.response), idempotentReplay: true },
    };
  }
  if (request.authorizationAccepted && state.host.status === "disconnected") {
    return hostMutationFailure(
      "host_disconnected",
      "project.session.open",
      authorizationClass,
      request.expectedRevision,
      request.idempotencyKeyHash,
      {
        projectId: request.projectId,
        providerId: request.providerId,
      },
    );
  }
  if (
    !request.authorizationAccepted
    || !request.idempotencyKeyHash
    || request.idempotencyKey.length === 0
    || request.idempotencyKey.length > 256
    || !selectedProviderId
    || !project
    || project.projectId !== request.projectId
  ) {
    const code = !request.authorizationAccepted
      ? "authorization_failed"
      : !project || project.projectId !== request.projectId
        ? "project_not_found"
        : "mutation_contract_invalid";
    const auditId = await recordAudit("project.session.open", "rejected", {
      code,
      authorizationClass,
      idempotencyKeyHash: request.idempotencyKeyHash,
      expectedRevision: Number.isSafeInteger(request.expectedRevision)
        ? request.expectedRevision
        : null,
      actualRevision: project?.revision ?? 0,
    });
    const status = code === "authorization_failed"
      ? 403
      : code === "project_not_found"
        ? 404
        : 400;
    const body = {
      ...mutationFailure(
        code,
        authorizationClass,
        Number.isSafeInteger(request.expectedRevision) ? request.expectedRevision : -1,
        project?.revision ?? 0,
        auditId,
      ),
      idempotentReplay: false,
    };
    if (request.idempotencyKeyHash) {
      projectSessionOutcomes.set(request.idempotencyKeyHash, {
        fingerprint,
        status,
        response: body,
      });
    }
    return { status, body };
  }
  if (request.expectedRevision !== project.revision) {
    const auditId = await recordAudit("project.session.open", "rejected", {
      code: "mutation_revision_conflict",
      authorizationClass,
      idempotencyKeyHash: request.idempotencyKeyHash,
      expectedRevision: request.expectedRevision,
      actualRevision: project.revision,
      projectId: project.projectId,
    });
    const status = 409;
    const body = {
      ...mutationFailure(
        "mutation_revision_conflict",
        authorizationClass,
        request.expectedRevision,
        project.revision,
        auditId,
      ),
      idempotentReplay: false,
    };
    projectSessionOutcomes.set(request.idempotencyKeyHash, {
      fingerprint,
      status,
      response: body,
    });
    return { status, body };
  }
  let session;
  try {
    session = await controllerSessions?.start({
      workContextId: project.projectId,
      kind: "project",
      canonicalReference: `sandking:project:${project.projectId}`,
    }, {
      providerId: selectedProviderId,
      workingDirectory: selectedProviderId === "claude-code"
        ? currentProjectPath ?? ""
        : args.dataDir,
    });
    if (!session) {
      throw new ControllerSessionError("controller_session_unavailable");
    }
  } catch (error) {
    const code = error instanceof ControllerSessionError
      ? error.code
      : "controller_session_start_failed";
    const auditId = await recordAudit("project.session.open", "rejected", {
      code,
      authorizationClass,
      idempotencyKeyHash: request.idempotencyKeyHash,
      expectedRevision: request.expectedRevision,
      actualRevision: project.revision,
      projectId: project.projectId,
      providerId: request.providerId,
      controllerSessionCreated: false,
      launchRequestPrepared: false,
      approvalRecorded: false,
      harnessRunStarted: false,
      projectFileWrite: false,
    });
    const status = 503;
    const body = {
      ...mutationFailure(
        code,
        authorizationClass,
        request.expectedRevision,
        project.revision,
        auditId,
      ),
      idempotentReplay: false,
      prohibitedSideEffects: {
        controllerSessionCreated: false,
        launchRequestPrepared: false,
        approvalRecorded: false,
        harnessRunStarted: false,
        projectFileWrite: false,
      },
    };
    projectSessionOutcomes.set(request.idempotencyKeyHash, {
      fingerprint,
      status,
      response: body,
    });
    return { status, body };
  }
  const auditId = await recordAudit("project.session.open", "accepted", {
    authorizationClass,
    idempotencyKeyHash: request.idempotencyKeyHash,
    expectedRevision: request.expectedRevision,
    resultingRevision: project.revision,
    projectId: project.projectId,
    providerId: request.providerId,
    sessionId: session.sessionId,
    providerSessionId: session.provider.providerSessionId,
    providerAdapterId: session.provider.adapterId,
    ptyRuntimeOwned: session.terminal.runtimeOwned,
  });
  const response = {
    type: "mutation_result",
    code: "project_focused_controller_session_opened",
    authorizationClass,
    expectedRevision: request.expectedRevision,
    revision: project.revision,
    idempotentReplay: false,
    auditId,
    session,
    prohibitedSideEffects: {
      launchRequestPrepared: false,
      approvalRecorded: false,
      harnessRunStarted: false,
      projectFileWrite: false,
    },
  };
  projectSessionOutcomes.set(request.idempotencyKeyHash, {
    fingerprint,
    status: 201,
    response,
  });
  return { status: 201, body: response };
});

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
    controllerSessions?.detach(socket);
    negotiatedBrowserSockets.delete(socket);
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
          try {
            await controllerSessions?.write({
              socket,
              streamId: opaque.streamId,
              sequence: opaque.sequence,
              eof: opaque.eof,
              data: opaque.data,
            });
          } catch (error) {
            throw new BrowserProtocolError(error instanceof ControllerSessionError
              ? error.code
              : "controller_terminal_input_failed");
          }
          await recordAudit("browser.opaque.receive", "observed", {
            streamId: opaque.streamId,
            sequence: opaque.sequence,
            eof: opaque.eof,
            byteLength: opaque.data.byteLength,
          });
          return;
        }
        const control = parseControlFrame(data);
        if (control.type === "browser.ping") {
          socket.send(serializeRuntimeControl({
            type: "runtime.pong",
            requestId: control.requestId,
          }));
          return;
        }
        if (control.type === "browser.terminal.attach") {
          try {
            const attached = await controllerSessions?.attach({
              socket,
              sessionId: control.sessionId,
              streamId: control.streamId,
              attachmentId: control.attachmentId,
              mode: control.mode,
              outputCursor: control.outputCursor,
              onOutput: (target, frame) => {
                if (target.readyState === WebSocket.OPEN) {
                  target.send(encodeBrowserOpaqueFrame(frame), { binary: true });
                }
              },
            });
            if (!attached) {
              throw new ControllerSessionError("controller_terminal_unavailable");
            }
            socket.send(serializeRuntimeControl({
              type: "runtime.terminal-attached",
              sessionId: control.sessionId,
              streamId: control.streamId,
              attachmentId: control.attachmentId,
              mode: attached.mode,
              exclusive: attached.exclusive,
              outputCursor: control.outputCursor,
            }));
            for (const frame of attached.frames) {
              socket.send(encodeBrowserOpaqueFrame(frame), { binary: true });
            }
            return;
          } catch (error) {
            throw new BrowserProtocolError(error instanceof ControllerSessionError
              ? error.code
              : "controller_terminal_attach_failed");
          }
        }
        if (control.type === "browser.harness-run.observe") {
          const observation = await requestHostOperation({
            type: "harness.run.observe",
            requestId: `harness-observe-${randomBytes(8).toString("hex")}`,
            harnessRunId: control.harnessRunId,
            afterSequence: control.afterSequence,
          });
          if (observation.type !== "harness.run.observe.result") {
            throw new BrowserProtocolError("harness_run_observation_failed");
          }
          currentHarnessRunObservation = structuredClone(observation);
          socket.send(serializeRuntimeControl({
            type: "runtime.harness-run.observation",
            requestId: control.requestId,
            observation,
          }));
          return;
        }
        if (control.type === "browser.harness-run.logs.get") {
          const result = await requestHostOperation({
            type: "harness.run.logs.get",
            requestId: `harness-logs-${randomBytes(8).toString("hex")}`,
            harnessRunId: control.harnessRunId,
            producer: control.producer,
            offset: control.offset,
            limit: control.limit,
          });
          if (result.type !== "harness.run.logs.result" || !Buffer.isBuffer(result.data)) {
            throw new BrowserProtocolError("harness_run_logs_failed");
          }
          const { data: logBytes, ...metadata } = result;
          socket.send(serializeRuntimeControl({
            ...metadata,
            type: "runtime.harness-run.logs.result",
            requestId: control.requestId,
          }));
          socket.send(encodeBrowserOpaqueFrame({
            streamId: result.streamId,
            sequence: result.range.start,
            eof: result.range.eof,
            data: logBytes,
          }), { binary: true });
          await recordAudit("browser.harness-run.logs", "observed", {
            harnessRunId: result.harnessRunId,
            producer: result.producer,
            range: result.range,
            byteLength: result.byteLength,
            insertedIntoControllerConversation: false,
          });
          return;
        }
        throw new BrowserProtocolError("browser_control_unexpected_message");
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
      const observation = state.host.status === "disconnected"
        && hello.observationCursor !== null
        && hello.observationCursor !== currentCursor
        ? {
            mode: "resynchronization-failed",
            cursor: currentCursor,
            reason: "host_observation_resynchronization_failed",
          }
        : hello.observationCursor === null
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
            status: state.host.status,
            freshness: state.host.freshness,
            failure: state.host.failure,
          },
          negotiation: {
            protocol: state.protocol,
            capabilities: state.host.negotiatedCapabilities,
            schemaDigest: state.host.schemaDigest,
            framing: state.host.framing,
            observationCursor: state.host.observationCursor,
          },
          projectPreparation: currentProjectPreparation,
          controllerProviders: controllerProviderProjection,
          planning: await planningSpine?.project(),
          harnessRunObservation: currentHarnessRunObservation,
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
      negotiatedBrowserSockets.add(socket);
      socket.send(acknowledgement);
    } catch (error) {
      const hostFailureCode = error instanceof ControllerSessionError
        && (error.code === "host_disconnected" || error.code === "host_protocol_invalid")
        ? error.code
        : null;
      if (hostFailureCode) {
        await markHostDisconnected(hostFailureCode);
        return;
      }
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
    controllerSessions = await createControllerSessionManager({
      dataDir: args.dataDir,
      recordAudit,
      handleProviderOperation,
    });
    const [conformanceProvider, claudeProvider] = await Promise.all([
      controllerSessions.probeProvider("conformance-controller-v1"),
      controllerSessions.probeProvider("claude-code"),
    ]);
    if (!conformanceProvider || !claudeProvider) {
      throw new Error("controller_provider_probe_invalid");
    }
    controllerProviderProjection = [conformanceProvider, claudeProvider].map((probe) => ({
      ...probe.provider,
      adapterId: probe.adapterId,
      adapterProtocol: probe.adapterProtocol.version,
      capabilities: probe.capabilities,
      availability: probe.availability ? {
        status: probe.availability.status,
        version: probe.availability.version,
        authentication: probe.availability.authentication.status,
        source: probe.availability.authentication.source,
        failureCode: probe.availability.failure?.code ?? null,
      } : {
        status: "available",
        version: probe.adapterProtocol.version,
        authentication: "not-applicable",
        source: "packaged-conformance",
        failureCode: null,
      },
      terminal: probe.terminal,
    }));
    planningSpine = await createPlanningSpine({
      dataDir: args.dataDir,
      recordAudit,
      startControllerSession: controllerSessions.start,
      terminateControllerSession: controllerSessions.terminate,
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

        if (request.method === "POST" && request.url === "/projects/open") {
          const body = await readJsonBody(request);
          const record = body && typeof body === "object" ? body : {};
          const {
            idempotencyKey,
            idempotencyKeyHash,
            expectedRevision,
          } = readMutationHeaders(request);
          const authorizationAccepted = exactOriginAccepted(request)
            && request.headers["x-sandking-csrf"] === activeSession.csrfToken;
          if (!authorizationAccepted) {
            const failure = await runtimeProjectFailure(
              "authorization_failed",
              expectedRevision,
              0,
              idempotencyKeyHash,
              ["retry_from_authenticated_cockpit"],
            );
            sendJson(response, 403, failure);
            return;
          }
          const requestContent = {
            path: "path" in record ? record.path : null,
            configuration: "configuration" in record ? record.configuration : null,
          };
          if (state.host.status === "disconnected") {
            const failure = await hostMutationFailure(
              "host_disconnected",
              "project.prepare",
              "host_local_project_preparation",
              expectedRevision,
              idempotencyKeyHash,
              requestContent,
            );
            sendJson(response, failure.status, failure.body);
            return;
          }
          let outcome;
          try {
            outcome = await prepareExplicitProject({
              ...requestContent,
              idempotencyKey,
              idempotencyKeyHash,
              expectedRevision,
            });
          } catch (error) {
            const hostFailureCode = error instanceof ControllerSessionError
              ? error.code
              : null;
            if (
              hostFailureCode === "host_disconnected"
              || hostFailureCode === "host_protocol_invalid"
            ) {
              outcome = await hostMutationFailure(
                hostFailureCode,
                "project.prepare",
                "host_local_project_preparation",
                expectedRevision,
                idempotencyKeyHash,
                requestContent,
                error instanceof ControllerSessionError ? error.retainedOutcome : null,
              );
            } else {
              throw error;
            }
          }
          sendJson(response, outcome.status, outcome.body);
          return;
        }

        if (request.method === "POST" && request.url === "/projects/sessions/open") {
          const body = await readJsonBody(request);
          const record = body && typeof body === "object" ? body : {};
          const {
            idempotencyKey,
            idempotencyKeyHash,
            expectedRevision,
          } = readMutationHeaders(request);
          const authorizationAccepted = exactOriginAccepted(request)
            && request.headers["x-sandking-csrf"] === activeSession.csrfToken;
          const outcome = await openProjectControllerSession({
            authorizationAccepted,
            idempotencyKey,
            idempotencyKeyHash,
            expectedRevision,
            projectId: "projectId" in record ? String(record.projectId) : "",
            providerId: "providerId" in record
              ? String(record.providerId)
              : "conformance-controller-v1",
          });
          sendJson(response, outcome.status, outcome.body);
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
      compatibilityKey: "runtime-v3-controller-terminal",
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
        status: "connected",
        freshness: "current",
        failure: null,
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
        await logSanitizedRuntimeError(new Error("host_disconnected"));
        await markHostDisconnected("host_disconnected");
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
