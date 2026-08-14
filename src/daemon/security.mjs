import { randomBytes } from "node:crypto";
import { digest } from "../common/digest.mjs";
import { appendPrivateJsonLine } from "../private-state.mjs";

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

export const securityHeaders = Object.freeze({
  "content-security-policy": cockpitCsp,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
});

/** @param {any} runtime */
export const createSecurity = (runtime) => {
  /** @param {string} sessionId */
  const createSessionCookie = (sessionId) =>
    `${runtime.sessionCookieName}=${sessionId}; HttpOnly; SameSite=Strict; Path=/${
      runtime.publicOrigin ? "; Secure" : ""
    }`;

  /** @param {string} action @param {"accepted" | "rejected" | "observed"} outcome @param {Record<string, unknown>} [details] */
  const recordAudit = async (action, outcome, details = {}) => {
    const auditId = `audit-${randomBytes(12).toString("hex")}`;
    await appendPrivateJsonLine(runtime.paths.audit, {
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
    if (!header) return {};
    return Object.fromEntries(header.split(";").map((part) => {
      const [name, ...rest] = part.trim().split("=");
      return [name, rest.join("=")];
    }));
  };

  /** @param {import("node:http").IncomingMessage} request */
  const exactHostAccepted = (request) =>
    request.headers.host === `127.0.0.1:${runtime.state.port}`
    || (runtime.publicOrigin !== null && request.headers.host === runtime.publicOrigin.host);

  /** @param {import("node:http").IncomingMessage} request */
  const exactOriginAccepted = (request) =>
    request.headers.origin === `http://127.0.0.1:${runtime.state.port}`
    || (runtime.publicOrigin !== null && request.headers.origin === runtime.publicOrigin.origin);

  /** @param {import("node:http").ServerResponse} response @param {number} status @param {unknown} body */
  const sendJson = (response, status, body) => {
    response.writeHead(status, {
      ...securityHeaders,
      "content-type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify(body));
  };

  /** @param {import("node:http").IncomingMessage} request */
  const readMutationHeaders = (request) => {
    const rawIdempotencyKey = request.headers["x-sandking-idempotency-key"];
    const idempotencyKey = typeof rawIdempotencyKey === "string" ? rawIdempotencyKey : "";
    const expectedRevision = Number(request.headers["x-sandking-expected-revision"]);
    return {
      idempotencyKey,
      idempotencyKeyHash: idempotencyKey.length > 0 && idempotencyKey.length <= 256
        ? digest(idempotencyKey)
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
      if (tooLarge) return;
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

  return {
    createSessionCookie,
    exactHostAccepted,
    exactOriginAccepted,
    parseCookies,
    readJsonBody,
    readMutationHeaders,
    recordAudit,
    sendJson,
  };
};
