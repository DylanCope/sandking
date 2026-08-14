import { canonicalJson } from "../common/canonical-json.mjs";
import { digest, digestHex } from "../common/digest.mjs";

/** @param {any} runtime */
export const createHostMutations = (runtime) => {
let hostMutationFailureQueue = Promise.resolve();
/** @type {Map<string, {fingerprint: string, status: number, response: any}>} */
const hostMutationOutcomes = new Map();
/** @type {Map<string, {fingerprint: string, response: any}>} */
const focusedHostMutationOutcomes = new Map();
const { recordAudit } = runtime;

/** @param {unknown} value */
const mutationRequestFingerprint = (value) => digest(canonicalJson(value));

/**
 * Normalize optional Project-open content at its retained fingerprint boundary.
 * @param {{path: unknown, configuration: unknown, harnessAdapterId?: unknown, resolutionAction?: unknown}} request
 */
const normalizeProjectPreparationRequestContent = (request) => ({
  path: request.path,
  configuration: request.configuration,
  harnessAdapterId: request.harnessAdapterId ?? null,
  resolutionAction: request.resolutionAction ?? null,
});

/**
 * @param {string} action
 * @param {number} expectedRevision
 * @param {unknown} requestContent
 */
const hostMutationRequestFingerprint = (action, expectedRevision, requestContent) =>
  mutationRequestFingerprint({
    expectedRevision,
    requestContent: action === "project.prepare"
      ? normalizeProjectPreparationRequestContent(
        /** @type {{path: unknown, configuration: unknown, harnessAdapterId?: unknown, resolutionAction?: unknown}} */ (
          requestContent
        ),
      )
      : requestContent,
  });

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
 * @param {string} action
 * @param {string} authorizationClass
 * @param {number} expectedRevision
 * @param {string} idempotencyKeyHash
 * @param {unknown} requestContent
 * @param {number} actualRevision
 * @param {Record<string, boolean>} prohibitedSideEffects
 */
const replayHostMutationOutcome = async (
  action,
  authorizationClass,
  expectedRevision,
  idempotencyKeyHash,
  requestContent,
  actualRevision,
  prohibitedSideEffects,
) => {
  const fingerprint = hostMutationRequestFingerprint(action, expectedRevision, requestContent);
  const outcomeKey = `${action}\0${idempotencyKeyHash}`;
  const existing = hostMutationOutcomes.get(outcomeKey);
  if (!existing) {
    return null;
  }
  if (existing.fingerprint !== fingerprint) {
    const auditId = await recordAudit(action, "rejected", {
      code: "idempotency_key_conflict",
      hostId: runtime.state.host.hostId,
      authorizationClass,
      idempotencyKeyHash,
      expectedRevision,
      actualRevision,
      originalAuditId: existing.response.auditId,
      projectId: existing.response.project?.projectId ?? null,
      harnessId: existing.response.harness?.harnessId
        ?? existing.response.project?.harness?.harnessId
        ?? null,
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
        ...(runtime.state.host.status === "disconnected" ? {
          hostId: runtime.state.host.hostId,
          freshness: "stale",
        } : {}),
        prohibitedSideEffects,
      },
    };
  }
  await recordAudit(action, "observed", {
    code: existing.response.code,
    hostId: runtime.state.host.hostId,
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
};

/**
 * @param {string} action
 * @param {string} idempotencyKeyHash
 * @param {number} expectedRevision
 * @param {unknown} requestContent
 * @param {{status: number, body: any}} outcome
 */
const retainHostMutationOutcome = (
  action,
  idempotencyKeyHash,
  expectedRevision,
  requestContent,
  outcome,
) => {
  hostMutationOutcomes.set(`${action}\0${idempotencyKeyHash}`, {
    fingerprint: hostMutationRequestFingerprint(action, expectedRevision, requestContent),
    status: outcome.status,
    response: structuredClone(outcome.body),
  });
};

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
  const actualRevision = runtime.currentProjectPreparation.current?.revision ?? 0;
  const prohibitedSideEffects = {
    projectRegistrationCreated: acceptedState?.effects?.projectRegistrationCreated ?? false,
    harnessRegistrationCreated: acceptedState?.effects?.harnessRegistrationCreated ?? false,
    harnessPinChanged: acceptedState?.effects?.harnessPinChanged ?? false,
    harnessRunLaunched: false,
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
      hostId: runtime.state.host.hostId,
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
        hostId: runtime.state.host.hostId,
        freshness: "stale",
        ...acceptedOutcome,
        prohibitedSideEffects,
      },
    };
  }
  const retained = await replayHostMutationOutcome(
    action,
    authorizationClass,
    expectedRevision,
    idempotencyKeyHash,
    requestContent,
    actualRevision,
    prohibitedSideEffects,
  );
  if (retained) {
    return retained;
  }
  const auditId = await recordAudit(action, "rejected", {
    code: failureCode,
    hostId: runtime.state.host.hostId,
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
    hostId: runtime.state.host.hostId,
    freshness: "stale",
    ...acceptedOutcome,
    prohibitedSideEffects,
  };
  const outcome = {
    status: 503,
    body,
  };
  retainHostMutationOutcome(
    action,
    idempotencyKeyHash,
    expectedRevision,
    requestContent,
    outcome,
  );
  return outcome;
});

/** @param {string} action @param {any} message @param {unknown} requestContent */
const requestFocusedHostMutation = async (action, message, requestContent) => {
  const idempotencyKeyHash = /^sha256:[a-f0-9]{64}$/.test(
    String(message.idempotencyKeyHash ?? ""),
  ) ? message.idempotencyKeyHash : null;
  const fingerprint = mutationRequestFingerprint(requestContent);
  const outcomeKey = idempotencyKeyHash ? `${action}\0${idempotencyKeyHash}` : null;
  const existing = outcomeKey ? focusedHostMutationOutcomes.get(outcomeKey) : null;
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      const auditId = await recordAudit(action, "rejected", {
        code: "idempotency_key_conflict",
        authorizationClass: message.authorizationClass,
        idempotencyKeyHash,
        originalAuditId: existing.response.auditId,
        harnessRunCreated: false,
      });
      return {
        type: "harness.run.launch.failure",
        requestId: message.requestId,
        code: "idempotency_key_conflict",
        retryable: false,
        authorizationClass: message.authorizationClass,
        idempotencyKeyHash,
        idempotentReplay: false,
        auditId,
        prohibitedSideEffects: {
          harnessRunCreated: false,
          projectWrite: false,
        },
      };
    }
    await recordAudit(action, "observed", {
      code: existing.response.code,
      authorizationClass: message.authorizationClass,
      idempotencyKeyHash,
      idempotentReplay: true,
      originalAuditId: existing.response.auditId,
      harnessRunId: existing.response.run?.harnessRunId ?? null,
    });
    return {
      ...structuredClone(existing.response),
      requestId: message.requestId,
      idempotentReplay: true,
    };
  }
  const outcome = /** @type {any} */ (await runtime.requestHostOperation(message));
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
};

/** @param {string} key @param {string} operation */
const derivedHostIdempotencyKey = (key, operation) => digestHex(`${operation}\0${key}`);

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
  harness_pin_unreadable: 409,
  harness_adapter_bytes_mismatch: 409,
  harness_compatibility_unsupported: 409,
  harness_skill_lock_missing: 409,
  harness_locked_skill_unavailable: 409,
  harness_skill_integrity_mismatch: 409,
  harness_projection_collision: 409,
  harness_projection_failed: 409,
  harness_seed_missing: 409,
  harness_seed_provenance_invalid: 409,
  harness_dependency_lock_invalid: 409,
  harness_skill_lock_invalid: 409,
  idempotency_key_conflict: 409,
  mutation_revision_conflict: 409,
});

return {
  derivedHostIdempotencyKey,
  hostMutationFailure,
  mutationFailure,
  mutationRequestFingerprint,
  projectFailureStatus,
  projectMutationSummary,
  replayHostMutationOutcome,
  requestFocusedHostMutation,
  retainHostMutationOutcome,
};
};
