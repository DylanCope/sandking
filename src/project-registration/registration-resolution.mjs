import { z } from "zod";
import { canonicalJson } from "../common/canonical-json.mjs";
import { digest } from "../common/digest.mjs";
import { identifierSchemas } from "../common/identifiers.mjs";
import {
  operationFailure,
  projectResolutionRegistration,
  resolveProjectLocation,
} from "./path-resolution.mjs";
import {
  publicProject,
  readProjectState,
  writeProjectState,
} from "./state.mjs";

const { projectIdSchema } = identifierSchemas(z);
const authorizationClass = "host_local_project_registration";
const resolutionActions = new Set(["forget", "restore", "resolve_conflict"]);

/**
 * Apply one explicit lifecycle decision to retained Project registrations.
 * Filesystem validation remains owned by path-resolution, and the registry
 * serializes this operation with registration, pinning, and inspection.
 * @param {{
 *   dataDir: string,
 *   recordAudit: (action: string, outcome: "accepted" | "rejected" | "observed", details?: Record<string, unknown>, auditId?: string) => Promise<string>,
 * }} options
 * @param {{
 *   requestId: string,
 *   action: unknown,
 *   projectId: unknown,
 *   path?: unknown,
 *   authorizationClass: unknown,
 *   idempotencyKey: unknown,
 *   expectedRevision: unknown,
 * }} request
 */
export const resolveProjectRegistration = async (options, request) => {
  const operation = "project.registration.resolve";
  const state = await readProjectState(options.dataDir);
  const keyValid = typeof request.idempotencyKey === "string"
    && request.idempotencyKey.length > 0
    && request.idempotencyKey.length <= 256;
  const idempotencyKeyHash = keyValid
    ? digest(/** @type {string} */ (request.idempotencyKey))
    : null;
  const requestFingerprint = digest(canonicalJson({
    operation,
    action: request.action,
    projectId: request.projectId,
    path: request.path ?? null,
    authorizationClass: request.authorizationClass,
    expectedRevision: request.expectedRevision,
  }));
  const existing = idempotencyKeyHash
    ? state.registrationOutcomes.find((outcome) =>
      outcome.idempotencyKeyHash === idempotencyKeyHash)
    : null;

  /**
   * @param {keyof typeof import("./path-resolution.mjs").failureGuidance} code
   * @param {{
   *   actualRevision?: number,
   *   registrations?: ReturnType<typeof projectResolutionRegistration>[],
   *   retryable?: boolean,
   * }} [detail]
   */
  const reject = async (code, detail = {}) => {
    const actualRevision = detail.actualRevision ?? 0;
    const auditId = await options.recordAudit(operation, "rejected", {
      code,
      action: typeof request.action === "string" ? request.action : null,
      authorizationClass,
      idempotencyKeyHash,
      expectedRevision: Number.isSafeInteger(request.expectedRevision)
        ? request.expectedRevision
        : null,
      actualRevision,
      projectId: projectIdSchema.safeParse(request.projectId).success
        ? request.projectId
        : null,
      candidateProjectIds: detail.registrations?.map(({ projectId }) => projectId) ?? [],
      directoryScanPerformed: false,
      projectFileWrite: false,
    });
    return operationFailure({
      requestId: request.requestId,
      operation,
      code,
      authorizationClass,
      idempotencyKeyHash,
      expectedRevision: Number.isSafeInteger(request.expectedRevision)
        ? Number(request.expectedRevision)
        : null,
      actualRevision,
      auditId,
      registrations: detail.registrations,
      retryable: detail.retryable,
    });
  };

  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) {
      return reject("idempotency_key_conflict", {
        actualRevision: Number(existing.response.revision ?? 0),
        retryable: false,
      });
    }
    await options.recordAudit(operation, "observed", {
      action: request.action,
      authorizationClass,
      idempotencyKeyHash,
      expectedRevision: request.expectedRevision,
      idempotentReplay: true,
      originalAuditId: existing.response.auditId,
      directoryScanPerformed: false,
      projectFileWrite: false,
    });
    return {
      ...structuredClone(existing.response),
      requestId: request.requestId,
      idempotentReplay: true,
    };
  }

  if (
    request.authorizationClass !== authorizationClass
    || !idempotencyKeyHash
    || !resolutionActions.has(String(request.action))
    || !projectIdSchema.safeParse(request.projectId).success
    || (request.action !== "forget"
      && (typeof request.path !== "string" || request.path.length === 0))
    || !Number.isSafeInteger(request.expectedRevision)
    || Number(request.expectedRevision) < 0
  ) {
    return reject("mutation_contract_invalid", { retryable: false });
  }

  const project = state.projects.find((candidate) => candidate.projectId === request.projectId);
  if (!project) {
    return reject("project_not_found");
  }
  if (request.expectedRevision !== project.revision) {
    return reject("mutation_revision_conflict", { actualRevision: project.revision });
  }

  /** @type {typeof state.projects} */
  let affectedProjects;
  /** @type {"project_registration_forgotten" | "project_registration_restored" | "project_registration_conflict_resolved"} */
  let code;
  if (request.action === "forget") {
    if (project.status === "tombstoned") {
      return reject("project_path_tombstoned", {
        actualRevision: project.revision,
        registrations: [projectResolutionRegistration(project)],
        retryable: false,
      });
    }
    project.status = "tombstoned";
    affectedProjects = [project];
    code = "project_registration_forgotten";
  } else if (request.action === "restore") {
    if (project.status !== "tombstoned") {
      return reject("mutation_contract_invalid", {
        actualRevision: project.revision,
        retryable: false,
      });
    }
    const candidateState = structuredClone(state);
    const candidate = candidateState.projects.find(({ projectId }) =>
      projectId === project.projectId);
    if (!candidate) {
      throw new Error("project_registration_state_invalid");
    }
    candidate.status = "active";
    let location = /** @type {any} */ (await resolveProjectLocation(
      candidateState,
      /** @type {string} */ (request.path),
      options.dataDir,
    ));
    if (
      location.kind === "failure"
      && location.code === "project_path_moved"
      && location.registrationCandidate
    ) {
      candidate.canonicalPath = location.registrationCandidate.canonicalPath;
      location = /** @type {any} */ (await resolveProjectLocation(
        candidateState,
        /** @type {string} */ (request.path),
        options.dataDir,
      ));
    }
    if (
      location.kind === "failure"
      || location.kind !== "registered"
      || location.project?.projectId !== candidate.projectId
    ) {
      const failureCode = location.kind === "failure"
        ? location.code
        : "project_path_conflict";
      return reject(failureCode, {
        actualRevision: location.actualRevision,
        registrations: "registrations" in location
          ? location.registrations
          : [projectResolutionRegistration(project)],
      });
    }
    project.status = "active";
    project.canonicalPath = candidate.canonicalPath;
    affectedProjects = [project];
    code = "project_registration_restored";
  } else {
    if (project.status !== "active") {
      return reject("project_path_tombstoned", {
        actualRevision: project.revision,
        registrations: [projectResolutionRegistration(project)],
        retryable: false,
      });
    }
    const location = /** @type {any} */ (await resolveProjectLocation(
      state,
      /** @type {string} */ (request.path),
      options.dataDir,
    ));
    if (location.kind !== "failure" || location.code !== "project_path_conflict") {
      return reject("mutation_contract_invalid", {
        actualRevision: location.actualRevision,
        retryable: false,
      });
    }
    const conflictingIds = new Set(location.registrations.map(
      (/** @type {{projectId: string}} */ { projectId }) => projectId,
    ));
    if (!conflictingIds.has(project.projectId)) {
      return reject("project_path_conflict", {
        actualRevision: location.actualRevision,
        registrations: location.registrations,
      });
    }
    affectedProjects = state.projects.filter(({ projectId }) => conflictingIds.has(projectId));
    const candidateState = structuredClone(state);
    for (const candidate of candidateState.projects) {
      if (conflictingIds.has(candidate.projectId) && candidate.projectId !== project.projectId) {
        candidate.status = "tombstoned";
      }
    }
    const selectedCandidate = candidateState.projects.find(({ projectId }) =>
      projectId === project.projectId);
    if (!selectedCandidate || typeof location.selectedCanonicalPath !== "string") {
      return reject("project_path_conflict", {
        actualRevision: location.actualRevision,
        registrations: location.registrations,
      });
    }
    selectedCandidate.canonicalPath = location.selectedCanonicalPath;
    const resolved = /** @type {any} */ (await resolveProjectLocation(
      candidateState,
      /** @type {string} */ (request.path),
      options.dataDir,
    ));
    if (
      resolved.kind !== "registered"
      || resolved.project?.projectId !== project.projectId
    ) {
      return reject("project_path_conflict", {
        actualRevision: location.actualRevision,
        registrations: location.registrations,
      });
    }
    for (const candidate of affectedProjects) {
      candidate.status = candidate.projectId === project.projectId ? "active" : "tombstoned";
    }
    project.canonicalPath = selectedCandidate.canonicalPath;
    code = "project_registration_conflict_resolved";
  }

  const updatedAt = new Date().toISOString();
  for (const candidate of affectedProjects) {
    candidate.revision += 1;
    candidate.updatedAt = updatedAt;
  }
  const auditId = await options.recordAudit(operation, "accepted", {
    action: request.action,
    authorizationClass,
    idempotencyKeyHash,
    expectedRevision: request.expectedRevision,
    actualRevision: request.expectedRevision,
    resultingRevision: project.revision,
    projectId: project.projectId,
    affectedProjectIds: affectedProjects.map(({ projectId }) => projectId),
    resultingStatuses: affectedProjects.map(({ projectId, status }) => ({ projectId, status })),
    directoryScanPerformed: false,
    projectFileWrite: false,
  });
  const response = {
    type: "project.registration.resolve.result",
    requestId: request.requestId,
    code,
    action: request.action,
    authorizationClass,
    idempotencyKeyHash,
    expectedRevision: request.expectedRevision,
    revision: project.revision,
    idempotentReplay: false,
    auditId,
    project: publicProject(project),
  };
  state.registrationOutcomes.push({
    idempotencyKeyHash,
    requestFingerprint,
    response,
  });
  state.registrationOutcomes = state.registrationOutcomes.slice(-256);
  await writeProjectState(options.dataDir, state);
  return response;
};
