import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_FILENAME = "runtime-state.json";
const AUDIT_FILENAME = "audit.log";

type RuntimeSession = {
  id: string;
  projectRegistration: string;
  provider: string;
  runtime: "local";
  createdAt: string;
};

type StartSessionResponse = {
  controllerSession: RuntimeSession;
  revision: number;
  idempotentReplay: boolean;
};

type StartSessionRequest = {
  projectRegistration: string;
  provider: string;
};

type IdempotencyRecord = StartSessionRequest &
  Omit<StartSessionResponse, "idempotentReplay">;

type PersistedState = {
  runtimeId: string;
  revision: number;
  controllerSessions: RuntimeSession[];
  idempotency: Record<string, IdempotencyRecord>;
};

type AuditEntry = {
  type: "runtime_launched" | "controller_session_started" | "runtime_recovered";
  recordedAt: string;
  revision: number;
};

type LaunchOptions = {
  host?: string;
  port?: number;
  runtimeRoot?: string;
};

const defaultRuntimeRoot = () => join(homedir(), ".sandking", "runtime", "local");

export async function launchSandKing({
  host = "127.0.0.1",
  port = 0,
  runtimeRoot = defaultRuntimeRoot(),
}: LaunchOptions = {}) {
  if (host !== "127.0.0.1") {
    throw new Error(`Sand-King only supports loopback launch on 127.0.0.1; received ${host}.`);
  }

  const runtime = await createPersistentRuntime(runtimeRoot);
  const sessionToken = randomUUID();
  const server = createServer((request, response) =>
    handleRequest({
      request,
      response,
      runtime,
      runtimeRoot,
      host,
      sessionToken,
    }),
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Sand-King failed to bind its loopback cockpit.");
  }

  const cockpitUrl = `http://${host}:${address.port}/`;

  return {
    cockpitUrl,
    sessionToken,
    runtimeRoot,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function createPersistentRuntime(runtimeRoot: string) {
  await mkdir(runtimeRoot, { recursive: true });

  const statePath = join(runtimeRoot, STATE_FILENAME);
  const auditPath = join(runtimeRoot, AUDIT_FILENAME);
  const state = await readState(statePath);
  const recovered = state !== null;
  const persistedState = state ?? {
    runtimeId: randomUUID(),
    revision: 0,
    controllerSessions: [],
    idempotency: {},
  };

  if (recovered) {
    await appendAuditEntry(auditPath, {
      type: "runtime_recovered",
      recordedAt: new Date().toISOString(),
      revision: persistedState.revision,
    });
  } else {
    await writeState(statePath, persistedState);
    await appendAuditEntry(auditPath, {
      type: "runtime_launched",
      recordedAt: new Date().toISOString(),
      revision: persistedState.revision,
    });
  }

  return {
    statePath,
    auditPath,
    async snapshot() {
      return {
        runtime: {
          id: persistedState.runtimeId,
          root: runtimeRoot,
          listenAddress: "127.0.0.1",
          loopbackOnly: true,
          revision: persistedState.revision,
        },
        controller: {
          sessions: persistedState.controllerSessions,
        },
        audit: await readAuditEntries(auditPath),
      };
    },
    async startControllerSession({
      projectRegistration,
      provider,
      idempotencyKey,
      expectedRevision,
    }: {
      projectRegistration: string;
      provider: string;
      idempotencyKey: string;
      expectedRevision: number;
    }) {
      const replay = persistedState.idempotency[idempotencyKey];
      if (replay) {
        if (
          replay.projectRegistration !== projectRegistration ||
          replay.provider !== provider
        ) {
          return {
            status: 409,
            body: {
              error: "idempotency_conflict",
              message: "Reusing an idempotency-key requires the same controller-session start request.",
              revision: persistedState.revision,
            },
          };
        }

        return {
          status: 200,
          body: {
            controllerSession: replay.controllerSession,
            revision: replay.revision,
            idempotentReplay: true,
          },
        };
      }

      if (expectedRevision !== persistedState.revision) {
        return {
          status: 409,
          body: {
            error: "revision_conflict",
            message: "Refresh the runtime snapshot and retry with the current revision.",
            revision: persistedState.revision,
          },
        };
      }

      const controllerSession: RuntimeSession = {
        id: `controller-${persistedState.controllerSessions.length + 1}`,
        projectRegistration,
        provider,
        runtime: "local",
        createdAt: new Date().toISOString(),
      };
      persistedState.controllerSessions.push(controllerSession);
      persistedState.revision += 1;
      const body = {
        controllerSession,
        revision: persistedState.revision,
        idempotentReplay: false,
      } satisfies StartSessionResponse;
      persistedState.idempotency[idempotencyKey] = {
        controllerSession,
        projectRegistration,
        provider,
        revision: persistedState.revision,
      };
      await writeState(statePath, persistedState);
      await appendAuditEntry(auditPath, {
        type: "controller_session_started",
        recordedAt: new Date().toISOString(),
        revision: persistedState.revision,
      });

      return { status: 201, body };
    },
  };
}

async function handleRequest({
  request,
  response,
  runtime,
  runtimeRoot,
  host,
  sessionToken,
}: {
  request: IncomingMessage;
  response: ServerResponse;
  runtime: Awaited<ReturnType<typeof createPersistentRuntime>>;
  runtimeRoot: string;
  host: string;
  sessionToken: string;
}) {
  const url = new URL(request.url ?? "/", `http://${host}`);

  if (request.method === "GET" && url.pathname === "/") {
    sendHtml(
      response,
      renderCockpit({
        sessionToken,
        runtimeRoot,
      }),
    );
    return;
  }

  if (!isAuthorized(request, sessionToken)) {
    sendJson(response, 401, {
      error: "controller_session_required",
      message: "Provide the local Controller session token from the Cockpit.",
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/runtime") {
    sendJson(response, 200, await runtime.snapshot());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/controller-sessions") {
    const idempotencyKey = request.headers["idempotency-key"];
    const expectedRevision = request.headers["if-match"];
    if (typeof idempotencyKey !== "string" || typeof expectedRevision !== "string") {
      sendJson(response, 400, {
        error: "invalid_request",
        message: "idempotency-key and if-match headers are required.",
      });
      return;
    }

    const parsedRevision = Number.parseInt(expectedRevision, 10);
    if (!Number.isInteger(parsedRevision) || parsedRevision < 0) {
      sendJson(response, 400, {
        error: "invalid_request",
        message: "if-match must be a non-negative integer revision.",
      });
      return;
    }

    const body = await readJsonBody(request);
    const result = await runtime.startControllerSession({
      projectRegistration: body.projectRegistration,
      provider: body.provider,
      idempotencyKey,
      expectedRevision: parsedRevision,
    });
    sendJson(response, result.status, result.body);
    return;
  }

  sendJson(response, 404, {
    error: "not_found",
    message: "The requested Sand-King resource does not exist.",
  });
}

function renderCockpit({
  sessionToken,
  runtimeRoot,
}: {
  sessionToken: string;
  runtimeRoot: string;
}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="sandking-session" content="${sessionToken}" />
    <title>Sand-King Cockpit</title>
  </head>
  <body>
    <main>
      <h1>Sand-King Cockpit</h1>
      <p>Controller runtime: local loopback</p>
      <p>Runtime root: ${escapeHtml(runtimeRoot)}</p>
      <p id="runtime-status">Loading runtime snapshot...</p>
      <button id="refresh-runtime" type="button">Refresh runtime</button>
      <pre id="runtime-snapshot" aria-live="polite"></pre>
      <form id="controller-session-form">
        <label>
          Project registration
          <input id="project-registration" name="projectRegistration" value="local-sandbox" />
        </label>
        <label>
          Provider
          <input id="provider" name="provider" value="claude-code" />
        </label>
        <button id="start-controller-session" type="submit">Start controller session</button>
      </form>
      <p id="controller-session-status"></p>
      <pre id="controller-session-result" aria-live="polite"></pre>
    </main>
    <script type="module">
      const sessionToken = document.querySelector('meta[name="sandking-session"]')?.getAttribute('content');
      const runtimeStatus = document.getElementById('runtime-status');
      const runtimeSnapshot = document.getElementById('runtime-snapshot');
      const refreshRuntimeButton = document.getElementById('refresh-runtime');
      const sessionForm = document.getElementById('controller-session-form');
      const projectRegistrationInput = document.getElementById('project-registration');
      const providerInput = document.getElementById('provider');
      const sessionStatus = document.getElementById('controller-session-status');
      const sessionResult = document.getElementById('controller-session-result');
      const state = {
        revision: null,
        startAttempts: 0,
      };

      async function loadRuntimeSnapshot() {
        runtimeStatus.textContent = 'Loading runtime snapshot...';
        const response = await fetch('/api/runtime', {
          headers: {
            authorization: 'Bearer ' + sessionToken,
          },
        });
        const snapshot = await response.json();
        runtimeSnapshot.textContent = JSON.stringify(snapshot, null, 2);
        if (!response.ok) {
          runtimeStatus.textContent = snapshot.message ?? 'Failed to load runtime snapshot.';
          return;
        }
        state.revision = snapshot.runtime.revision;
        runtimeStatus.textContent = 'Runtime revision ' + snapshot.runtime.revision;
      }

      async function startControllerSession(event) {
        event.preventDefault();
        if (state.revision === null) {
          await loadRuntimeSnapshot();
        }

        sessionStatus.textContent = 'Starting controller session...';
        state.startAttempts += 1;
        const response = await fetch('/api/controller-sessions', {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + sessionToken,
            'content-type': 'application/json',
            'idempotency-key': 'cockpit-start-' + state.startAttempts,
            'if-match': String(state.revision),
          },
          body: JSON.stringify({
            projectRegistration: projectRegistrationInput.value,
            provider: providerInput.value,
          }),
        });
        const result = await response.json();
        sessionResult.textContent = JSON.stringify(result, null, 2);
        sessionStatus.textContent = response.ok
          ? 'Controller session ready.'
          : result.message ?? 'Failed to start controller session.';
        if (response.ok && typeof result.revision === 'number') {
          state.revision = result.revision;
          await loadRuntimeSnapshot();
        }
      }

      refreshRuntimeButton.addEventListener('click', loadRuntimeSnapshot);
      sessionForm.addEventListener('submit', startControllerSession);
      void loadRuntimeSnapshot();
    </script>
  </body>
</html>`;
}

async function readState(statePath: string): Promise<PersistedState | null> {
  try {
    const raw = await readFile(statePath, "utf8");
    return normalizePersistedState(JSON.parse(raw) as PersistedState);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function normalizePersistedState(state: PersistedState): PersistedState {
  const idempotency = Object.fromEntries(
    Object.entries(state.idempotency).map(([key, value]) => [
      key,
      {
        ...value,
        projectRegistration:
          value.projectRegistration ?? value.controllerSession.projectRegistration,
        provider: value.provider ?? value.controllerSession.provider,
      },
    ]),
  );

  return {
    ...state,
    idempotency,
  };
}

async function writeState(statePath: string, state: PersistedState) {
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

async function appendAuditEntry(auditPath: string, entry: AuditEntry) {
  await appendFile(auditPath, `${JSON.stringify(entry)}\n`);
}

async function readAuditEntries(auditPath: string) {
  try {
    const raw = await readFile(auditPath, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function isAuthorized(request: IncomingMessage, sessionToken: string) {
  const authorization = request.headers.authorization;
  return authorization === `Bearer ${sessionToken}`;
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendHtml(response: ServerResponse, body: string) {
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(body);
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
