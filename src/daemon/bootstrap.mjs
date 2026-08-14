import { randomBytes } from "node:crypto";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { digest, digestHex } from "../common/digest.mjs";
import { hasErrorCode, readJson, removePrivateFile } from "../private-state.mjs";

/** @param {any} runtime */
export const createBootstrap = (runtime) => {
/** @type {Map<string, Promise<any>>} */
const bootstrapExchanges = new Map();
const { mutationFailure, recordAudit, registerBrowserSession } = runtime;

/** @param {{idempotencyKeyHash: string, expectedRevision: number}} contract */
const createSession = async (contract) => {
  const sessionId = randomBytes(32).toString("hex");
  const csrfToken = randomBytes(24).toString("hex");
  const expiresAt = Date.now() + runtime.args.browserSessionTtlMs;
  const auditId = await recordAudit("browser.session.create", "accepted", {
    runtimeId: runtime.state.runtimeId,
    authorizationClass: "bootstrap_token",
    idempotencyKeyHash: contract.idempotencyKeyHash,
    expectedRevision: contract.expectedRevision,
    actualRevision: 0,
    resultingRevision: 1,
  });
  registerBrowserSession(sessionId, {
    createdAt: Date.now(),
    expiresAt,
    runtimeId: runtime.state.runtimeId,
    csrfToken,
    auditId,
    revision: 1,
  });
  return { sessionId, csrfToken, auditId, revision: 1, expiresAt };
};

/** @param {string} token @param {string} idempotencyKey @param {number} expectedRevision */
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
        ? digest(idempotencyKey)
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
  const tokenId = digestHex(token);
  const idempotencyKeyHash = digest(idempotencyKey);
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
  const tokenPath = join(runtime.paths.tokenDirectory, `${tokenId}.json`);
  const claimPath = join(
    runtime.paths.tokenDirectory,
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
      || tokenState.runtimeId !== runtime.state.runtimeId
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

return { exchangeBootstrapToken };
};
