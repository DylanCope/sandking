import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { MAX_BROWSER_CONTROL_BYTES } from "../../browser-protocol.mjs";
import { ControllerSessionError } from "../../controller-sessions.mjs";
import { securityHeaders } from "../security.mjs";

/** @typedef {"public" | "session-id" | "active-session"} RouteAuthorization */
/**
 * @typedef {{
 *   method: string,
 *   matches: (url: string) => boolean,
 *   authorization: RouteAuthorization,
 *   handle: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, context: {sessionId?: string, session?: any}) => Promise<void> | void,
 * }} HttpRoute
 */

/** @param {any} runtime @param {Map<string, {contentType: string, body: string | Uint8Array}>} assets */
export const createHttpService = (runtime, assets) => {
  /** @type {import("node:http").Server | undefined} */
  let httpServer;
  /** @type {WebSocketServer | undefined} */
  let websocketServer;

  /** @param {string} path @returns {(url: string) => boolean} */
  const exactPath = (path) => (url) => url === path;

  /** @type {HttpRoute[]} */
  const routes = [
    {
      method: "GET",
      matches: exactPath("/health"),
      authorization: "public",
      handle: (request, response) => {
        if (request.headers["x-sandking-readiness"] !== runtime.state.readinessToken) {
          runtime.sendJson(response, 404, { code: "not_found" });
          return;
        }
        runtime.sendJson(response, 200, {
          ready: true,
          identity: runtime.state.identity,
          runtimeId: runtime.state.runtimeId,
          version: runtime.state.version,
        });
      },
    },
    {
      method: "GET",
      matches: (url) => url === "/bootstrap" || url.startsWith("/bootstrap?"),
      authorization: "public",
      handle: async (request, response) => {
        const bootstrapRequest = new URL(request.url ?? "", `http://127.0.0.1:${runtime.state.port}`);
        const exchange = await runtime.exchangeBootstrapToken(
          bootstrapRequest.searchParams.get("token") ?? "",
          bootstrapRequest.searchParams.get("idempotencyKey") ?? "",
          Number(bootstrapRequest.searchParams.get("expectedRevision")),
        );
        if (!exchange.ok) {
          runtime.sendJson(response, exchange.status, exchange.body);
          return;
        }
        response.writeHead(302, {
          ...securityHeaders,
          location: "/",
          "set-cookie": runtime.createSessionCookie(exchange.session.sessionId),
        });
        response.end();
      },
    },
    {
      method: "POST",
      matches: exactPath("/session/end"),
      authorization: "session-id",
      handle: async (request, response, { sessionId }) => {
        if (!sessionId) {
          const { idempotencyKeyHash, expectedRevision } = runtime.readMutationHeaders(request);
          const auditId = await runtime.recordAudit("browser.session.end", "rejected", {
            code: "session_required",
            authorizationClass: "runtime_browser_session",
            idempotencyKeyHash,
            expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
            actualRevision: 0,
          });
          runtime.sendJson(response, 401, runtime.mutationFailure(
            "session_required",
            "runtime_browser_session",
            Number.isSafeInteger(expectedRevision) ? expectedRevision : -1,
            0,
            auditId,
          ));
          return;
        }
        await runtime.withSessionMutationLock(
          sessionId,
          () => runtime.endBrowserSession(request, response, sessionId),
        );
      },
    },
    {
      method: "POST",
      matches: exactPath("/projects/open"),
      authorization: "active-session",
      handle: async (request, response, { session }) => {
        const body = await runtime.readJsonBody(request);
        const record = body && typeof body === "object" ? body : {};
        const mutation = runtime.readMutationHeaders(request);
        const authorizationAccepted = runtime.exactOriginAccepted(request)
          && request.headers["x-sandking-csrf"] === session.csrfToken;
        if (!authorizationAccepted) {
          const failure = await runtime.runtimeProjectFailure(
            "authorization_failed",
            mutation.expectedRevision,
            0,
            mutation.idempotencyKeyHash,
            ["retry_from_authenticated_cockpit"],
          );
          runtime.sendJson(response, 403, failure);
          return;
        }
        const requestContent = {
          path: "path" in record ? record.path : null,
          configuration: "configuration" in record ? record.configuration : null,
          harnessAdapterId: "harnessAdapterId" in record ? record.harnessAdapterId : undefined,
          resolutionAction: "resolutionAction" in record ? record.resolutionAction : undefined,
        };
        let outcome;
        try {
          outcome = await runtime.prepareExplicitProject({ ...requestContent, ...mutation });
        } catch (error) {
          const hostFailureCode = error instanceof ControllerSessionError ? error.code : null;
          if (hostFailureCode === "host_disconnected" || hostFailureCode === "host_protocol_invalid") {
            outcome = await runtime.hostMutationFailure(
              hostFailureCode,
              "project.prepare",
              "host_local_project_preparation",
              mutation.expectedRevision,
              mutation.idempotencyKeyHash,
              requestContent,
              error instanceof ControllerSessionError ? error.retainedOutcome : null,
            );
          } else {
            throw error;
          }
        }
        runtime.sendJson(response, outcome.status, outcome.body);
      },
    },
    {
      method: "POST",
      matches: exactPath("/projects/registration/resolve"),
      authorization: "active-session",
      handle: async (request, response, { session }) => {
        const body = await runtime.readJsonBody(request);
        const record = body && typeof body === "object" ? body : {};
        const mutation = runtime.readMutationHeaders(request);
        const authorizationAccepted = runtime.exactOriginAccepted(request)
          && request.headers["x-sandking-csrf"] === session.csrfToken;
        if (!authorizationAccepted) {
          const failure = await runtime.runtimeProjectFailure(
            "authorization_failed",
            mutation.expectedRevision,
            0,
            mutation.idempotencyKeyHash,
            ["retry_from_authenticated_cockpit"],
            {
              action: "project.registration.resolve",
              authorizationClass: "host_local_project_registration",
            },
          );
          runtime.sendJson(response, 403, failure);
          return;
        }
        const requestContent = {
          action: "action" in record ? record.action : null,
          projectId: "projectId" in record ? record.projectId : null,
          path: "path" in record ? record.path : null,
        };
        let outcome;
        try {
          outcome = await runtime.resolveExplicitProjectRegistration({
            ...requestContent,
            ...mutation,
          });
        } catch (error) {
          const hostFailureCode = error instanceof ControllerSessionError ? error.code : null;
          if (hostFailureCode === "host_disconnected" || hostFailureCode === "host_protocol_invalid") {
            outcome = await runtime.hostMutationFailure(
              hostFailureCode,
              "project.registration.resolve",
              "host_local_project_registration",
              mutation.expectedRevision,
              mutation.idempotencyKeyHash,
              requestContent,
            );
          } else {
            throw error;
          }
        }
        runtime.sendJson(response, outcome.status, outcome.body);
      },
    },
    {
      method: "POST",
      matches: exactPath("/projects/sessions/open"),
      authorization: "active-session",
      handle: async (request, response, { session }) => {
        const body = await runtime.readJsonBody(request);
        const record = body && typeof body === "object" ? body : {};
        const mutation = runtime.readMutationHeaders(request);
        const outcome = await runtime.openProjectControllerSession({
          authorizationAccepted: runtime.exactOriginAccepted(request)
            && request.headers["x-sandking-csrf"] === session.csrfToken,
          ...mutation,
          projectId: "projectId" in record ? String(record.projectId) : "",
          providerId: "providerId" in record
            ? String(record.providerId)
            : "conformance-controller-v1",
        });
        runtime.sendJson(response, outcome.status, outcome.body);
      },
    },
    ...[...assets].map(([path, asset]) => ({
      method: "GET",
      matches: exactPath(path),
      authorization: /** @type {const} */ ("active-session"),
      handle: (/** @type {import("node:http").IncomingMessage} */ _request,
        /** @type {import("node:http").ServerResponse} */ response) => {
        response.writeHead(200, {
          ...securityHeaders,
          "content-type": asset.contentType,
        });
        response.end(asset.body);
      },
    })),
  ];

  /** @param {import("node:http").IncomingMessage} request @param {import("node:http").ServerResponse} response */
  const dispatch = async (request, response) => {
    if (!runtime.exactHostAccepted(request)) {
      await runtime.recordAudit("http.request", "rejected", { code: "host_mismatch" });
      runtime.sendJson(response, 403, { code: "host_mismatch" });
      return;
    }
    const url = request.url ?? "";
    const route = routes.find((candidate) =>
      candidate.method === request.method && candidate.matches(url));
    const authorization = route?.authorization ?? "active-session";
    if (authorization === "public") {
      await route?.handle(request, response, {});
      return;
    }
    const cookies = runtime.parseCookies(request.headers.cookie);
    const sessionId = cookies[runtime.sessionCookieName];
    if (authorization === "session-id") {
      await route?.handle(request, response, { sessionId });
      return;
    }
    const session = sessionId
      ? await runtime.expireBrowserSessionIfDue(sessionId)
      : undefined;
    if (!session) {
      const status = sessionId ? runtime.getBrowserSessionStatus(sessionId) : undefined;
      runtime.sendJson(response, 401, {
        code: status === "expired"
          ? "session_expired"
          : status === "ended"
            ? "session_ended"
            : "session_required",
      });
      return;
    }
    if (!route) {
      runtime.sendJson(response, 404, { code: "not_found" });
      return;
    }
    await route.handle(request, response, { sessionId, session });
  };

  const startHttpServer = async () => {
    httpServer = createServer((request, response) => {
      dispatch(request, response).catch(async (error) => {
        await runtime.logSanitizedRuntimeError(error);
        runtime.sendJson(response, 500, { code: "internal_error" });
      });
    });
    websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_BROWSER_CONTROL_BYTES });
    httpServer.on("upgrade", async (request, socket, head) => {
      if (!runtime.exactHostAccepted(request)) {
        await runtime.recordAudit("websocket.upgrade", "rejected", { code: "host_mismatch" });
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      if (request.url !== "/ws") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!runtime.exactOriginAccepted(request)) {
        await runtime.recordAudit("websocket.upgrade", "rejected", { code: "origin_mismatch" });
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      const sessionId = runtime.parseCookies(request.headers.cookie)[runtime.sessionCookieName];
      const session = sessionId
        ? await runtime.expireBrowserSessionIfDue(sessionId)
        : undefined;
      if (!session) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      websocketServer?.handleUpgrade(request, socket, head, (websocket) => {
        runtime.handleBrowserConnection(websocket, sessionId, session);
      });
    });
    const bindAddress = runtime.publicOrigin ? "0.0.0.0" : "127.0.0.1";
    const requestedPort = runtime.publicOrigin && process.env.SANDKING_PORT
      ? Number(process.env.SANDKING_PORT)
      : 0;
    await new Promise((resolve, reject) => {
      httpServer?.once("error", reject);
      httpServer?.listen(requestedPort, bindAddress, () => resolve(undefined));
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("runtime_listener_invalid");
    return address;
  };

  const stopHttpServer = async () => {
    for (const client of websocketServer?.clients ?? []) client.close(1001, "runtime_shutdown");
    await new Promise((resolve) => {
      if (!httpServer?.listening) {
        resolve(undefined);
        return;
      }
      httpServer.close(() => resolve(undefined));
    });
  };

  return { routes, startHttpServer, stopHttpServer };
};
