import { WebSocket } from "ws";

/**
 * Every piece of state keyed by a browser session lives in this one record.
 * Lifecycle transitions therefore cannot leave timers, sockets, negotiation,
 * or mutation queues behind in a parallel registry.
 *
 * @typedef {{createdAt: number, expiresAt: number, runtimeId: string, csrfToken: string, auditId: string, revision: number}} BrowserSession
 * @typedef {{
 *   session: BrowserSession | null,
 *   status: "active" | "ended" | "expired" | "unknown",
 *   termination?: {idempotencyKeyHash: string, expectedRevision: number, auditId: string},
 *   expiryTimer: ReturnType<typeof setTimeout> | null,
 *   sockets: Map<WebSocket, {negotiated: boolean}>,
 *   mutationQueue: Promise<any> | null,
 * }} BrowserSessionRecord
 */

/** @param {any} runtime */
export const createBrowserSessionRegistry = (runtime) => {
  /** @type {Map<string, BrowserSessionRecord>} */
  const records = new Map();

  /** @param {string} sessionId @param {BrowserSessionRecord} record */
  const moveToNewest = (sessionId, record) => {
    records.delete(sessionId);
    records.set(sessionId, record);
  };

  const pruneExpired = () => {
    const expiredIds = [...records]
      .filter(([, record]) => record.status === "expired")
      .map(([sessionId]) => sessionId);
    if (expiredIds.length > 128) records.delete(expiredIds[0]);
  };

  /** @param {string} sessionId @param {string} reason */
  const revokeBrowserSession = (sessionId, reason) => {
    const record = records.get(sessionId);
    for (const socket of record?.sockets.keys() ?? []) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1008, reason);
      }
    }
  };

  /** @param {string} sessionId @param {number} expiresAt */
  const scheduleBrowserSessionExpiry = (sessionId, expiresAt) => {
    const record = records.get(sessionId);
    if (!record || record.status !== "active") return;
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    const timer = setTimeout(() => {
      if (record.expiryTimer === timer) record.expiryTimer = null;
      expireBrowserSessionIfDue(sessionId).catch(runtime.logSanitizedRuntimeError);
    }, Math.max(1, expiresAt - Date.now()));
    timer.unref();
    record.expiryTimer = timer;
  };

  /** @param {string} sessionId */
  const expireBrowserSessionIfDue = async (sessionId) => {
    const record = records.get(sessionId);
    if (!record || record.status !== "active" || !record.session) return undefined;
    const session = record.session;
    if (session.expiresAt > Date.now()) {
      if (!record.expiryTimer) scheduleBrowserSessionExpiry(sessionId, session.expiresAt);
      return session;
    }
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    record.expiryTimer = null;
    record.status = "expired";
    moveToNewest(sessionId, record);
    pruneExpired();
    try {
      await runtime.recordAudit("browser.session.expire", "observed", {
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

  /** @param {string} sessionId @param {BrowserSession} session */
  const registerBrowserSession = (sessionId, session) => {
    records.set(sessionId, {
      session,
      status: "active",
      expiryTimer: null,
      sockets: new Map(),
      mutationQueue: null,
    });
    scheduleBrowserSessionExpiry(sessionId, session.expiresAt);
  };

  /**
   * Serialize mutations through the same record that owns the session.
   * @template T
   * @param {string} sessionId
   * @param {() => Promise<T>} operation
   */
  const withSessionMutationLock = async (sessionId, operation) => {
    let record = records.get(sessionId);
    if (!record) {
      record = {
        session: null,
        status: "unknown",
        expiryTimer: null,
        sockets: new Map(),
        mutationQueue: null,
      };
      records.set(sessionId, record);
    }
    const previous = record.mutationQueue ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    record.mutationQueue = current;
    try {
      return await current;
    } finally {
      if (record.mutationQueue === current) record.mutationQueue = null;
      if (
        record.status === "unknown"
        && record.sockets.size === 0
        && record.mutationQueue === null
      ) records.delete(sessionId);
    }
  };

  /**
   * @param {import("node:http").IncomingMessage} request
   * @param {import("node:http").ServerResponse} response
   * @param {string} sessionId
   */
  const endBrowserSession = async (request, response, sessionId) => {
    const activeSession = await expireBrowserSessionIfDue(sessionId);
    const record = records.get(sessionId);
    const endedSession = record?.status === "ended" ? record.session : undefined;
    const expiredSession = record?.status === "expired" ? record.session : undefined;
    const session = activeSession ?? endedSession ?? expiredSession;
    const { idempotencyKeyHash, expectedRevision } = runtime.readMutationHeaders(request);
    if (!session) {
      const auditId = await runtime.recordAudit("browser.session.end", "rejected", {
        code: "session_required",
        authorizationClass: "runtime_browser_session",
        idempotencyKeyHash,
        expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
        actualRevision: 0,
      });
      runtime.sendJson(response, 401, runtime.mutationFailure(
        "session_required", "runtime_browser_session",
        Number.isSafeInteger(expectedRevision) ? expectedRevision : -1, 0, auditId,
      ));
      return;
    }
    if (expiredSession) {
      const auditId = await runtime.recordAudit("browser.session.end", "rejected", {
        code: "session_expired",
        authorizationClass: "runtime_browser_session",
        idempotencyKeyHash,
        expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
        actualRevision: expiredSession.revision,
      });
      runtime.sendJson(response, 401, runtime.mutationFailure(
        "session_expired", "runtime_browser_session",
        Number.isSafeInteger(expectedRevision) ? expectedRevision : -1,
        expiredSession.revision, auditId,
      ));
      return;
    }
    if (!runtime.exactOriginAccepted(request)
      || request.headers["x-sandking-csrf"] !== session.csrfToken) {
      const auditId = await runtime.recordAudit("browser.session.end", "rejected", {
        code: "csrf_rejected",
        authorizationClass: "runtime_browser_session",
        idempotencyKeyHash,
        expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
        actualRevision: session.revision,
      });
      runtime.sendJson(response, 403, runtime.mutationFailure(
        "csrf_rejected", "runtime_browser_session",
        Number.isSafeInteger(expectedRevision) ? expectedRevision : -1,
        session.revision, auditId,
      ));
      return;
    }
    if (!idempotencyKeyHash || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      const auditId = await runtime.recordAudit("browser.session.end", "rejected", {
        code: "mutation_contract_invalid",
        authorizationClass: "runtime_browser_session",
        idempotencyKeyHash,
        expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
        actualRevision: session.revision,
      });
      runtime.sendJson(response, 400, runtime.mutationFailure(
        "mutation_contract_invalid", "runtime_browser_session",
        Number.isSafeInteger(expectedRevision) ? expectedRevision : -1,
        session.revision, auditId,
      ));
      return;
    }
    if (endedSession && record?.termination
      && record.termination.idempotencyKeyHash === idempotencyKeyHash
      && record.termination.expectedRevision === expectedRevision) {
      await runtime.recordAudit("browser.session.end", "observed", {
        authorizationClass: "runtime_browser_session",
        idempotencyKeyHash,
        expectedRevision,
        actualRevision: endedSession.revision,
        resultingRevision: endedSession.revision,
        idempotentReplay: true,
        originalAuditId: record.termination.auditId,
      });
      runtime.sendJson(response, 200, {
        type: "mutation_result",
        code: "session_ended",
        authorizationClass: "runtime_browser_session",
        revision: endedSession.revision,
        idempotentReplay: true,
        auditId: record.termination.auditId,
      });
      return;
    }
    if (!activeSession || expectedRevision !== activeSession.revision) {
      const auditId = await runtime.recordAudit("browser.session.end", "rejected", {
        code: "mutation_revision_conflict",
        authorizationClass: "runtime_browser_session",
        idempotencyKeyHash,
        expectedRevision,
        actualRevision: session.revision,
      });
      runtime.sendJson(response, 409, runtime.mutationFailure(
        "mutation_revision_conflict", "runtime_browser_session",
        expectedRevision, session.revision, auditId,
      ));
      return;
    }
    const resultingRevision = activeSession.revision + 1;
    const auditId = await runtime.recordAudit("browser.session.end", "accepted", {
      sessionAuditId: activeSession.auditId,
      authorizationClass: "runtime_browser_session",
      idempotencyKeyHash,
      expectedRevision,
      actualRevision: activeSession.revision,
      resultingRevision,
    });
    if (record?.expiryTimer) clearTimeout(record.expiryTimer);
    if (record) {
      record.expiryTimer = null;
      record.status = "ended";
      record.session = { ...activeSession, revision: resultingRevision };
      record.termination = { idempotencyKeyHash, expectedRevision, auditId };
      moveToNewest(sessionId, record);
    }
    revokeBrowserSession(sessionId, "session_ended");
    runtime.sendJson(response, 200, {
      type: "mutation_result",
      code: "session_ended",
      authorizationClass: "runtime_browser_session",
      revision: resultingRevision,
      idempotentReplay: false,
      auditId,
    });
  };

  /** @param {string} sessionId @param {WebSocket} socket */
  const attachBrowserSocket = (sessionId, socket) => {
    records.get(sessionId)?.sockets.set(socket, { negotiated: false });
  };
  /** @param {string} sessionId @param {WebSocket} socket */
  const detachBrowserSocket = (sessionId, socket) => {
    records.get(sessionId)?.sockets.delete(socket);
  };
  /** @param {string} sessionId @param {WebSocket} socket */
  const markBrowserSocketNegotiated = (sessionId, socket) => {
    const socketState = records.get(sessionId)?.sockets.get(socket);
    if (socketState) socketState.negotiated = true;
  };
  /** @param {(socket: WebSocket) => void} visit */
  const forEachNegotiatedBrowserSocket = (visit) => {
    for (const record of records.values()) {
      for (const [socket, socketState] of record.sockets) {
        if (socketState.negotiated) visit(socket);
      }
    }
  };
  /** @param {string} sessionId */
  const getActiveBrowserSession = (sessionId) => {
    const record = records.get(sessionId);
    return record?.status === "active" ? record.session ?? undefined : undefined;
  };
  /** @param {string} sessionId */
  const getBrowserSessionStatus = (sessionId) => records.get(sessionId)?.status;
  const shutdownBrowserSessions = () => {
    for (const record of records.values()) {
      if (record.expiryTimer) clearTimeout(record.expiryTimer);
      record.expiryTimer = null;
    }
  };

  return {
    attachBrowserSocket,
    detachBrowserSocket,
    endBrowserSession,
    expireBrowserSessionIfDue,
    forEachNegotiatedBrowserSocket,
    getActiveBrowserSession,
    getBrowserSessionStatus,
    markBrowserSocketNegotiated,
    registerBrowserSession,
    shutdownBrowserSessions,
    withSessionMutationLock,
  };
};
