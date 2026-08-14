import { z } from "zod";
import { canonicalJson } from "../common/canonical-json.mjs";
import { digest } from "../common/digest.mjs";
import { identifierSchemas } from "../common/identifiers.mjs";

const { projectIdSchema } = identifierSchemas(z);
const authorizationClass = "host_local_project_registration";
const resolutionActions = new Set(["forget", "restore", "resolve_conflict"]);

/** @param {any} project */
export const projectResolutionRegistration = (project) => ({
  projectId: project.projectId,
  revision: project.revision,
  displayName: project.displayName,
  canonicalPath: project.canonicalPath,
  status: project.status,
});

/**
 * Apply one explicit lifecycle decision to retained Project registrations.
 * Filesystem validation remains owned by the registry's path resolver, and
 * the registry serializes this with registration, pinning, and inspection.
 * @param {{
 *   state: any,
 *   dataDir: string,
 *   recordAudit: (action: string, outcome: "accepted" | "rejected" | "observed", details?: Record<string, unknown>, auditId?: string) => Promise<string>,
 *   resolveProjectLocation: (state: any, path: unknown, dataDir: string) => Promise<any>,
 *   operationFailure: (input: any) => any,
 *   publicProject: (project: any) => any,
 *   writeProjectState: (dataDir: string, state: any) => Promise<void>,
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
export const applyProjectRegistrationResolution = async (options, request) => {
  const operation = "project.registration.resolve";
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
    ? options.state.registrationOutcomes.find((/** @type {any} */ outcome) =>
      outcome.idempotencyKeyHash === idempotencyKeyHash)
    : null;

  /**
   * @param {string} code
   * @param {{actualRevision?: number, registrations?: any[], retryable?: boolean}} [detail]
   */
  const reject = async (code, detail = {}) => {
    const actualRevision = detail.actualRevision ?? 0;
    const registrations = code === "project_path_conflict"
      ? detail.registrations
      : detail.registrations?.map((registration) => {
        const retained = options.state.projects.find((/** @type {any} */ candidate) =>
          candidate.projectId === registration.projectId);
        return retained ? projectResolutionRegistration(retained) : registration;
      });
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
      candidateProjectIds: registrations?.map(({ projectId }) => projectId) ?? [],
      directoryScanPerformed: false,
      projectFileWrite: false,
    });
    return options.operationFailure({
      requestId: request.requestId,
      operation,
      code,
      authorizationClass,
      idempotencyKeyHash,
      expectedRevision: Number.isSafeInteger(request.expectedRevision)
        ? request.expectedRevision
        : null,
      actualRevision,
      auditId,
      registrations,
      retryable: detail.retryable,
    });
  };

  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) {
      return reject("idempotency_key_conflict", {
        actualRevision: Number(
          existing.response.revision ?? existing.response.actualRevision ?? 0,
        ),
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
    const response = {
      ...structuredClone(existing.response),
      requestId: request.requestId,
    };
    if ("idempotentReplay" in existing.response) response.idempotentReplay = true;
    return response;
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

  const project = options.state.projects.find((/** @type {any} */ candidate) =>
    candidate.projectId === request.projectId);
  if (!project) return reject("project_not_found");
  if (request.expectedRevision !== project.revision) {
    return reject("mutation_revision_conflict", { actualRevision: project.revision });
  }

  let affectedProjects;
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
    const candidateState = structuredClone(options.state);
    const candidate = candidateState.projects.find((/** @type {any} */ retained) =>
      retained.projectId === project.projectId);
    if (!candidate) throw new Error("project_registration_state_invalid");
    candidate.status = "active";
    let location = await options.resolveProjectLocation(
      candidateState,
      request.path,
      options.dataDir,
    );
    if (
      location.kind === "failure"
      && location.code === "project_path_moved"
      && location.registrationCandidate
    ) {
      candidate.canonicalPath = location.registrationCandidate.canonicalPath;
      location = await options.resolveProjectLocation(
        candidateState,
        request.path,
        options.dataDir,
      );
    }
    if (
      location.kind !== "registered"
      || location.project?.projectId !== candidate.projectId
    ) {
      if (location.kind === "failure" && location.code === "project_path_conflict") {
        const updatedAt = new Date().toISOString();
        candidate.revision += 1;
        candidate.updatedAt = updatedAt;
        location = await options.resolveProjectLocation(
          candidateState,
          request.path,
          options.dataDir,
        );
        if (
          location.kind !== "failure"
          || location.code !== "project_path_conflict"
          || !location.registrations.some((/** @type {any} */ registration) =>
            registration.projectId === candidate.projectId)
        ) {
          throw new Error("project_registration_state_invalid");
        }
        const auditId = await options.recordAudit(operation, "accepted", {
          code: location.code,
          action: request.action,
          authorizationClass,
          idempotencyKeyHash,
          expectedRevision: request.expectedRevision,
          actualRevision: request.expectedRevision,
          resultingRevision: candidate.revision,
          projectId: candidate.projectId,
          affectedProjectIds: [candidate.projectId],
          resultingStatuses: [{
            projectId: candidate.projectId,
            status: candidate.status,
          }],
          candidateProjectIds: location.registrations.map(
            (/** @type {any} */ registration) => registration.projectId,
          ),
          conflictResolutionRequired: true,
          directoryScanPerformed: false,
          projectFileWrite: false,
        });
        const response = options.operationFailure({
          requestId: request.requestId,
          operation,
          code: location.code,
          authorizationClass,
          idempotencyKeyHash,
          expectedRevision: request.expectedRevision,
          actualRevision: location.actualRevision,
          auditId,
          registrations: location.registrations,
        });
        candidateState.registrationOutcomes.push({
          idempotencyKeyHash,
          requestFingerprint,
          response,
        });
        candidateState.registrationOutcomes = candidateState.registrationOutcomes.slice(-256);
        await options.writeProjectState(options.dataDir, candidateState);
        return response;
      }
      return reject("project_path_tombstoned", {
        actualRevision: project.revision,
        registrations: [projectResolutionRegistration(project)],
      });
    }
    project.status = "active";
    project.canonicalPath = candidate.canonicalPath;
    affectedProjects = [project];
    code = "project_registration_restored";
  } else {
    let candidateState = structuredClone(options.state);
    let location = await options.resolveProjectLocation(
      candidateState,
      request.path,
      options.dataDir,
    );
    if (location.kind !== "failure" || location.code !== "project_path_conflict") {
      const tombstonedProjectIds = project.status === "tombstoned"
        ? [project.projectId]
        : options.state.projects
          .filter((/** @type {any} */ candidate) => candidate.status === "tombstoned")
          .map((/** @type {any} */ candidate) => candidate.projectId);
      for (const tombstonedProjectId of tombstonedProjectIds) {
        const restoredState = structuredClone(options.state);
        const restored = restoredState.projects.find((/** @type {any} */ candidate) =>
          candidate.projectId === tombstonedProjectId);
        if (!restored) continue;
        restored.status = "active";
        const restoredLocation = await options.resolveProjectLocation(
          restoredState,
          request.path,
          options.dataDir,
        );
        if (
          restoredLocation.kind === "failure"
          && restoredLocation.code === "project_path_conflict"
          && restoredLocation.registrations.some((/** @type {any} */ registration) =>
            registration.projectId === project.projectId)
        ) {
          candidateState = restoredState;
          location = restoredLocation;
          break;
        }
      }
    }
    if (location.kind !== "failure" || location.code !== "project_path_conflict") {
      return reject("mutation_contract_invalid", {
        actualRevision: location.actualRevision,
        retryable: false,
      });
    }
    const conflictingIds = new Set(location.registrations.map(
      (/** @type {any} */ registration) => registration.projectId,
    ));
    if (!conflictingIds.has(project.projectId)) {
      return reject("project_path_conflict", {
        actualRevision: location.actualRevision,
        registrations: location.registrations,
      });
    }
    affectedProjects = options.state.projects.filter((/** @type {any} */ candidate) =>
      conflictingIds.has(candidate.projectId));
    for (const candidate of candidateState.projects) {
      if (conflictingIds.has(candidate.projectId) && candidate.projectId !== project.projectId) {
        candidate.status = "tombstoned";
      }
    }
    const selected = candidateState.projects.find((/** @type {any} */ candidate) =>
      candidate.projectId === project.projectId);
    if (!selected || typeof location.selectedCanonicalPath !== "string") {
      return reject("project_path_conflict", {
        actualRevision: location.actualRevision,
        registrations: location.registrations,
      });
    }
    selected.status = "active";
    selected.canonicalPath = location.selectedCanonicalPath;
    const resolved = await options.resolveProjectLocation(
      candidateState,
      request.path,
      options.dataDir,
    );
    const selectedRegistrationMissing = resolved.kind === "failure"
      && resolved.code === "project_path_missing"
      && resolved.registrations?.length === 1
      && resolved.registrations[0].projectId === project.projectId;
    if (
      !selectedRegistrationMissing
      && (resolved.kind !== "registered" || resolved.project?.projectId !== project.projectId)
    ) {
      return reject("project_path_conflict", {
        actualRevision: location.actualRevision,
        registrations: location.registrations,
      });
    }
    for (const candidate of affectedProjects) {
      candidate.status = candidate.projectId === project.projectId ? "active" : "tombstoned";
    }
    project.canonicalPath = selected.canonicalPath;
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
    affectedProjectIds: affectedProjects.map(
      (/** @type {any} */ candidate) => candidate.projectId,
    ),
    resultingStatuses: affectedProjects.map((/** @type {any} */ candidate) => ({
      projectId: candidate.projectId,
      status: candidate.status,
    })),
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
    project: options.publicProject(project),
  };
  options.state.registrationOutcomes.push({
    idempotencyKeyHash,
    requestFingerprint,
    response,
  });
  options.state.registrationOutcomes = options.state.registrationOutcomes.slice(-256);
  await options.writeProjectState(options.dataDir, options.state);
  return response;
};
