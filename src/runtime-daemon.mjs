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
  /** @type {{dataDir?: string, hostMode?: string}} */
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--data-dir") {
      result.dataDir = argv[index + 1];
      index += 1;
    } else if (current === "--host-mode") {
      result.hostMode = argv[index + 1];
      index += 1;
    }
  }
  if (!result.dataDir) {
    throw new Error("runtime_data_dir_missing");
  }
  return /** @type {{dataDir: string, hostMode?: string}} */ (result);
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

/** @type {Map<string, {createdAt: number, runtimeId: string, csrfToken: string, auditId: string}>} */
const sessions = new Map();
/** @type {import("node:child_process").ChildProcessWithoutNullStreams | undefined} */
let hostProcess;
/** @type {import("node:http").Server | undefined} */
let httpServer;
/** @type {WebSocketServer | undefined} */
let websocketServer;
/** @type {any} */
let state;
let shuttingDown = false;

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

/** @param {string} token */
const consumeBootstrapToken = async (token) => {
  if (!/^[a-f0-9]{64}$/.test(token)) {
    return null;
  }
  const tokenId = createHash("sha256").update(token).digest("hex");
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
      return null;
    }
    throw error;
  }

  try {
    const tokenState = await readJson(claimPath, null);
    if (
      !tokenState
      || typeof tokenState !== "object"
      || tokenState.runtimeId !== state.runtimeId
      || Number(tokenState.expiresAt) <= Date.now()
    ) {
      return null;
    }
    return tokenState;
  } finally {
    await removePrivateFile(claimPath);
  }
};

const createSession = async () => {
  const sessionId = randomBytes(32).toString("hex");
  const csrfToken = randomBytes(24).toString("hex");
  const auditId = await recordAudit("browser.session.create", "accepted", {
    runtimeId: state.runtimeId,
  });
  sessions.set(sessionId, {
    createdAt: Date.now(),
    runtimeId: state.runtimeId,
    csrfToken,
    auditId,
  });
  return { sessionId, csrfToken, auditId };
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

const launchHost = async () => {
  const hostArgs = [localHostPath];
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
    writeFrame(child.stdin, {
      type: "hello",
      protocol: protocolVersion,
      release: releaseVersion,
      identity: "controller-runtime",
      expectedPeerIdentity: "local-host",
      capabilities: {
        required: [...hostCapabilities],
        optional: [],
      },
      schemaDigest: HOST_SCHEMA_DIGEST,
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
    if (response.identity !== "local-host" || response.peerIdentity !== "controller-runtime") {
      throw new Error("host_identity_mismatch");
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

/** @param {WebSocket} socket @param {{csrfToken: string, auditId: string}} session */
const handleBrowserConnection = (socket, session) => {
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
        session: { csrfToken: session.csrfToken },
        viewModel: {
          kind: "cockpit.connection",
          runtime: {
            identity: "controller-runtime",
            runtimeId: state.runtimeId,
            release: releaseVersion,
          },
          host: {
            identity: state.host.identity,
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
    const host = await launchHost();
    const negotiationAuditId = await recordAudit("host.negotiate", "accepted", {
      controllerIdentity: "controller-runtime",
      hostIdentity: host.identity,
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
          const token = new URL(request.url, `http://127.0.0.1:${state.port}`)
            .searchParams.get("token");
          const tokenState = token ? await consumeBootstrapToken(token) : null;
          if (!tokenState) {
            sendJson(response, 410, { code: "bootstrap_token_invalid" });
            return;
          }
          const session = await createSession();
          response.writeHead(302, {
            ...securityHeaders,
            location: "/",
            "set-cookie": `${sessionCookieName}=${session.sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
          });
          response.end();
          return;
        }

        const cookies = parseCookies(request.headers.cookie);
        const sessionId = cookies[sessionCookieName];
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (!session) {
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

        if (request.method === "POST" && request.url === "/session/end") {
          if (!exactOriginAccepted(request) || request.headers["x-sandking-csrf"] !== session.csrfToken) {
            await recordAudit("browser.session.end", "rejected", { code: "csrf_rejected" });
            sendJson(response, 403, { code: "csrf_rejected" });
            return;
          }
          sessions.delete(sessionId);
          await recordAudit("browser.session.end", "accepted", {
            sessionAuditId: session.auditId,
          });
          response.writeHead(204, securityHeaders);
          response.end();
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
        handleBrowserConnection(websocket, session);
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
      runtimeId: `runtime-${randomBytes(12).toString("hex")}`,
      port: address.port,
      readinessToken: randomBytes(24).toString("hex"),
      compatibilityKey: "runtime-v1",
      version: releaseVersion,
      identity: "controller-runtime",
      host: {
        identity: host.identity,
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
    await recordAudit("runtime.start", "rejected", { code });
    await writePrivateJson(startupErrorPath, { code });
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
