import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createHash as createHandshakeHash } from "node:crypto";
import { join } from "node:path";
import { protocolVersion, releaseVersion, readFrame, writeFrame } from "./protocol.mjs";

const parseArgs = (argv) => {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--data-dir") {
      result.dataDir = argv[index + 1];
      index += 1;
    }
  }
  if (!result.dataDir) {
    throw new Error("Missing required --data-dir argument.");
  }
  return result;
};

const args = parseArgs(process.argv.slice(2));
const statePath = join(args.dataDir, "runtime-state.json");
const tokenPath = join(args.dataDir, "bootstrap-tokens.json");
const startupErrorPath = join(args.dataDir, "startup-error.json");
const runtimeErrorPath = join(args.dataDir, "runtime-error.log");

const sessions = new Map();
let hostProcess;
let state;

const cockpitCsp =
  "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'";

const readJson = async (filePath, fallback) => {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
};

const consumeBootstrapToken = async (token) => {
  const now = Date.now();
  const tokens = await readJson(tokenPath, []);
  const validToken = tokens.find((entry) => entry.token === token && !entry.usedAt && entry.expiresAt > now);
  if (!validToken) {
    return null;
  }

  const updated = tokens.map((entry) =>
    entry.token === token ? { ...entry, usedAt: now } : entry);
  await writeFile(tokenPath, `${JSON.stringify(updated, null, 2)}\n`);
  return validToken;
};

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

const ensureLoopbackHeaders = (request, port) => {
  const expectedHost = `127.0.0.1:${port}`;
  if (request.headers.host !== expectedHost) {
    return { ok: false, statusCode: 403, body: "host_mismatch" };
  }
  return { ok: true };
};

const createSession = () => {
  const sessionId = randomBytes(24).toString("hex");
  sessions.set(sessionId, {
    createdAt: Date.now(),
    runtimeId: state.runtimeId,
  });
  return sessionId;
};

const websocketAccept = (key) =>
  createHandshakeHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

const sendWebSocketJson = (socket, payload) => {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = body.length < 126
    ? Buffer.from([0x81, body.length])
    : Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]);
  socket.write(Buffer.concat([header, body]));
};

const persistState = async () => {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
};

const logRuntimeError = async (error) => {
  const message = error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`;
  await writeFile(runtimeErrorPath, message);
};

const shutdown = async () => {
  if (hostProcess && !hostProcess.killed) {
    hostProcess.kill("SIGTERM");
  }
  await rm(statePath, { force: true });
};

const launchHost = async () => {
  const child = spawn(process.execPath, [join(process.cwd(), "src", "local-host.mjs")], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "ignore"],
    env: process.env,
  });

  writeFrame(child.stdin, {
    type: "hello",
    protocol: protocolVersion,
    release: releaseVersion,
    identity: "controller-runtime",
    capabilities: ["slice-1"],
    schemaDigest: createHash("sha256").update("slice-1").digest("hex"),
  });

  const response = await readFrame(child.stdout);
  if (response.type !== "hello-ack") {
    throw new Error("host_protocol_error");
  }
  if (response.protocol.major !== protocolVersion.major) {
    throw new Error("host_protocol_major_mismatch");
  }
  if (response.identity !== "local-host") {
    throw new Error("host_identity_mismatch");
  }
  if (!response.capabilities.includes("slice-1")) {
    throw new Error("host_capability_missing");
  }

  hostProcess = child;
  return response;
};

const main = async () => {
  try {
    const host = await launchHost();
    const server = createServer(async (request, response) => {
      try {
        const headerCheck = ensureLoopbackHeaders(request, state.port);
        if (!headerCheck.ok) {
          response.writeHead(headerCheck.statusCode, { "content-type": "text/plain" });
          response.end(headerCheck.body);
          return;
        }

        if (request.method === "GET" && request.url === "/health") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            runtimeId: state.runtimeId,
            host: state.host,
            protocol: state.protocol,
          }));
          return;
        }

        if (request.method === "GET" && request.url?.startsWith("/bootstrap?token=")) {
          const token = new URL(request.url, `http://127.0.0.1:${state.port}`).searchParams.get("token");
          const tokenState = token ? await consumeBootstrapToken(token) : null;
          if (!tokenState) {
            response.writeHead(410, { "content-type": "application/json" });
            response.end(JSON.stringify({ code: "bootstrap_token_invalid" }));
            return;
          }

          const sessionId = createSession();
          response.writeHead(302, {
            location: "/",
            "set-cookie": `__Host-sandking_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
            "content-security-policy": cockpitCsp,
          });
          response.end();
          return;
        }

        if (request.method === "GET" && request.url === "/") {
          const cookies = parseCookies(request.headers.cookie);
          const session = sessions.get(cookies["__Host-sandking_session"]);
          if (!session) {
            response.writeHead(401, {
              "content-type": "application/json",
              "content-security-policy": cockpitCsp,
            });
            response.end(JSON.stringify({ code: "session_required" }));
            return;
          }

          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": cockpitCsp,
          });
          response.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Sand-King Cockpit</title></head>
  <body>
    <main id="app">Connecting to local Host…</main>
    <script type="module">
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(protocol + "://" + location.host + "/ws");
      socket.addEventListener("message", (event) => {
        const payload = JSON.parse(event.data);
        document.getElementById("app").textContent =
          "Connected to " + payload.host.identity + " with protocol " + payload.protocol.version;
      });
    </script>
  </body>
</html>`);
          return;
        }

        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "not_found" }));
      } catch (error) {
        await logRuntimeError(error);
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "internal_error" }));
      }
    });

    server.on("upgrade", (request, socket) => {
      const headerCheck = ensureLoopbackHeaders(request, state.port);
      if (!headerCheck.ok) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      if (request.url !== "/ws") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      const expectedOrigin = `http://127.0.0.1:${state.port}`;
      if (request.headers.origin !== expectedOrigin) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      const cookies = parseCookies(request.headers.cookie);
      if (!sessions.has(cookies["__Host-sandking_session"])) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const accept = websocketAccept(request.headers["sec-websocket-key"]);
      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"));
      sendWebSocketJson(socket, {
        runtime: {
          runtimeId: state.runtimeId,
        },
        host: {
          identity: state.host.identity,
          capabilities: state.host.capabilities,
        },
        protocol: {
          version: state.protocol.version,
        },
      });
    });

    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    state = {
      pid: process.pid,
      runtimeId: randomBytes(12).toString("hex"),
      port: address.port,
      compatibilityKey: "runtime-v1",
      version: releaseVersion,
      host: {
        identity: host.identity,
        capabilities: host.capabilities,
        schemaDigest: host.schemaDigest,
        framing: host.framing,
        observationCursor: host.observationCursor,
        release: host.release,
      },
      protocol: host.protocol,
      listener: { address: "127.0.0.1" },
      startedAt: new Date().toISOString(),
    };
    await persistState();

    process.on("SIGTERM", async () => {
      server.close();
      await shutdown();
      process.exit(0);
    });
    process.on("SIGINT", async () => {
      server.close();
      await shutdown();
      process.exit(0);
    });
  } catch (error) {
    await writeFile(startupErrorPath, `${JSON.stringify({
      code: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
    process.exit(1);
  }
};

process.on("uncaughtException", async (error) => {
  await logRuntimeError(error);
});

process.on("unhandledRejection", async (error) => {
  await logRuntimeError(error);
});

main();
