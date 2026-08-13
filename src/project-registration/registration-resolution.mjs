import { canonicalJson } from "../common/canonical-json.mjs";
import { digest } from "../common/digest.mjs";
import { operationFailure } from "./path-resolution.mjs";
import {
  publicProject,
  readProjectState,
  writeProjectState,
} from "./state.mjs";

/**
 * Tombstone one explicitly identified Project registration without reading or
 * writing the Project itself. The registry serializes this with every other
 * Project mutation.
 * @param {{
 *   dataDir: string,
 *   recordAudit: (action: string, outcome: "accepted" | "rejected" | "observed", details?: Record<string, unknown>, auditId?: string) => Promise<string>,
 * }} options
 * @param {{requestId: string, projectId: string, authorizationClass: string, idempotencyKey: string, expectedRevision: number}} request
 */
export const forgetProjectRegistration = async (options, request) => {
  const action = "project.registration.forget";
  const authorizationClass = "host_local_project_registration";
  const state = await readProjectState(options.dataDir);
  const keyValid = typeof request.idempotencyKey === "string"
    && request.idempotencyKey.length > 0
    && request.idempotencyKey.length <= 256;
  const keyHash = keyValid ? digest(request.idempotencyKey) : null;
  const requestFingerprint = digest(canonicalJson({
    action,
    projectId: request.projectId,
    authorizationClass: request.authorizationClass,
    expectedRevision: request.expectedRevision,
  }));
  const existing = keyHash
    ? state.registrationOutcomes.find((outcome) => outcome.idempotencyKeyHash === keyHash)
    : null;
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) {
      const auditId = await options.recordAudit(action, "rejected", {
        code: "idempotency_key_conflict",
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: Number(existing.response.revision ?? 0),
        projectFileWrite: false,
      });
      return operationFailure({
        requestId: request.requestId,
        operation: action,
        code: "idempotency_key_conflict",
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: Number(existing.response.revision ?? 0),
        auditId,
        retryable: false,
      });
    }
    await options.recordAudit(action, "observed", {
      authorizationClass,
      idempotencyKeyHash: keyHash,
      expectedRevision: request.expectedRevision,
      idempotentReplay: true,
      originalAuditId: existing.response.auditId,
      projectFileWrite: false,
    });
    return {
      ...structuredClone(existing.response),
      requestId: request.requestId,
      idempotentReplay: true,
    };
  }

  const project = state.projects.find((candidate) => candidate.projectId === request.projectId);
  const actualRevision = project?.revision ?? 0;
  if (
    request.authorizationClass !== authorizationClass
    || !keyHash
    || !Number.isSafeInteger(request.expectedRevision)
    || request.expectedRevision < 0
  ) {
    const auditId = await options.recordAudit(action, "rejected", {
      code: "mutation_contract_invalid",
      authorizationClass,
      idempotencyKeyHash: keyHash,
      expectedRevision: Number.isSafeInteger(request.expectedRevision)
        ? request.expectedRevision
        : null,
      actualRevision,
      projectFileWrite: false,
    });
    return operationFailure({
      requestId: request.requestId,
      operation: action,
      code: "mutation_contract_invalid",
      authorizationClass,
      idempotencyKeyHash: keyHash,
      expectedRevision: request.expectedRevision,
      actualRevision,
      auditId,
      retryable: false,
    });
  }
  if (!project) {
    const auditId = await options.recordAudit(action, "rejected", {
      code: "project_not_found",
      authorizationClass,
      idempotencyKeyHash: keyHash,
      expectedRevision: request.expectedRevision,
      actualRevision,
      projectFileWrite: false,
    });
    return operationFailure({
      requestId: request.requestId,
      operation: action,
      code: "project_not_found",
      authorizationClass,
      idempotencyKeyHash: keyHash,
      expectedRevision: request.expectedRevision,
      actualRevision,
      auditId,
    });
  }
  if (request.expectedRevision !== actualRevision) {
    const auditId = await options.recordAudit(action, "rejected", {
      code: "mutation_revision_conflict",
      authorizationClass,
      idempotencyKeyHash: keyHash,
      expectedRevision: request.expectedRevision,
      actualRevision,
      projectId: project.projectId,
      projectFileWrite: false,
    });
    return operationFailure({
      requestId: request.requestId,
      operation: action,
      code: "mutation_revision_conflict",
      authorizationClass,
      idempotencyKeyHash: keyHash,
      expectedRevision: request.expectedRevision,
      actualRevision,
      auditId,
    });
  }
  if (project.status === "tombstoned") {
    const auditId = await options.recordAudit(action, "rejected", {
      code: "project_path_tombstoned",
      authorizationClass,
      idempotencyKeyHash: keyHash,
      expectedRevision: request.expectedRevision,
      actualRevision,
      projectId: project.projectId,
      projectFileWrite: false,
    });
    return operationFailure({
      requestId: request.requestId,
      operation: action,
      code: "project_path_tombstoned",
      authorizationClass,
      idempotencyKeyHash: keyHash,
      expectedRevision: request.expectedRevision,
      actualRevision,
      auditId,
      retryable: false,
    });
  }

  project.status = "tombstoned";
  project.revision += 1;
  project.updatedAt = new Date().toISOString();
  const auditId = await options.recordAudit(action, "accepted", {
    authorizationClass,
    idempotencyKeyHash: keyHash,
    expectedRevision: request.expectedRevision,
    actualRevision,
    resultingRevision: project.revision,
    projectId: project.projectId,
    projectFileWrite: false,
  });
  const response = {
    type: "project.registration.forget.result",
    requestId: request.requestId,
    code: "project_registration_forgotten",
    authorizationClass,
    idempotencyKeyHash: keyHash,
    expectedRevision: request.expectedRevision,
    revision: project.revision,
    idempotentReplay: false,
    auditId,
    project: publicProject(project),
  };
  state.registrationOutcomes.push({
    idempotencyKeyHash: keyHash,
    requestFingerprint,
    response,
  });
  state.registrationOutcomes = state.registrationOutcomes.slice(-256);
  await writeProjectState(options.dataDir, state);
  return response;
};
