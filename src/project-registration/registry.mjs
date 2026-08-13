import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { canonicalJson } from "../common/canonical-json.mjs";
import { digest } from "../common/digest.mjs";
import {
  harnessAdapterProbeSchema,
  invokePinnedHarnessAdapter,
  loadPinnedHarnessAdapter,
} from "../harness-adapter-protocol.mjs";
import {
  CONFORMANCE_HARNESS_ADAPTER_ID,
  SANDCASTLE_HARNESS_ADAPTER_ID,
  harnessAdapterIdSchema,
} from "../harness-adapter-identity.mjs";
import {
  ProductionHarnessSeedError,
  initializeProductionHarnessWorkspace,
} from "../production-harness-seed.mjs";
import {
  ProductionHarnessPreparationError,
  prepareProductionHarness,
  productionHarnessPreparationSchema,
} from "../production-harness-preparation.mjs";
import {
  boundedHarnessConfigurationSchema,
  commitSchema,
  harnessStateSchema,
  legacyProjectStateSchema,
  legacyStoredProjectSchema,
  projectConfigurationSchema,
  projectStateSchema,
  readinessWithHarness,
  readinessWithoutHarness,
  storedHarnessSchema,
  storedProjectSchema,
} from "./schemas.mjs";
import {
  harnessWorkspaceRoot,
  initializeConformanceWorkspace,
  publicHarness,
  publicProject,
  readHarnessState,
  readProjectState,
  refreshRetainedProjectReferences,
  writeHarnessState,
  writeProjectState,
} from "./state.mjs";
import {
  failureGuidance,
  operationFailure,
  resolveProjectLocation,
} from "./path-resolution.mjs";
import { forgetProjectRegistration as forgetRegistration } from "./registration-resolution.mjs";

const execFileAsync = promisify(execFile);

/** @param {unknown} value */
const fingerprint = (value) => digest(canonicalJson(value));
/** @param {string} key */
const idempotencyHash = (key) => digest(key);

/**
 * @param {{projectId: unknown, harnessId: unknown, boundedConfiguration: unknown, authorizationClass: unknown, expectedRevision: unknown}} request
 * @param {unknown} immutableRevision
 */
const pinRequestFingerprint = (request, immutableRevision) => fingerprint({
  projectId: request.projectId,
  harnessId: request.harnessId,
  immutableRevision,
  boundedConfiguration: request.boundedConfiguration,
  authorizationClass: request.authorizationClass,
  expectedRevision: request.expectedRevision,
});

/**
 * @param {{
 *   dataDir: string,
 *   recordAudit: (action: string, outcome: "accepted" | "rejected" | "observed", details?: Record<string, unknown>, auditId?: string) => Promise<string>,
 *   productionSeedRoot?: string,
 * }} options
 */
export const createProjectRegistry = async (options) => {
  let mutationQueue = Promise.resolve();
  /** @template T @param {() => Promise<T>} operation */
  const withMutationLock = (operation) => {
    const current = mutationQueue.catch(() => undefined).then(operation);
    mutationQueue = current.then(() => undefined, () => undefined);
    return current;
  };

  /** @param {unknown} error */
  const preparationFailureCode = (error) => {
    if (error instanceof ProductionHarnessPreparationError) return error.code;
    if (error instanceof Error && error.message in failureGuidance) return error.message;
    return "harness_projection_failed";
  };

  /**
   * Re-resolve a retained Project before any operation can prepare or pin it.
   * The canonical path is only a lookup key; the retained filesystem identity
   * remains the authority for whether that path is still the same Project.
   * @param {z.infer<typeof projectStateSchema> | z.infer<typeof legacyProjectStateSchema>} projectState
   * @param {z.infer<typeof legacyStoredProjectSchema>} project
   */
  const requireRegisteredProjectLocation = async (projectState, project) => {
    const location = await resolveProjectLocation(
      projectState,
      project.canonicalPath,
      options.dataDir,
    );
    if (location.kind === "failure") throw new Error(location.code);
    if (
      location.kind !== "registered"
      || !location.project
      || location.project.projectId !== project.projectId
    ) {
      throw new Error("project_path_conflict");
    }
    return location;
  };

  /**
   * Lazily upgrade only the selected schema-v1 production Project. A broken
   * retained registration therefore cannot make unrelated registrations
   * unavailable, while every public success still carries verified readiness.
   * @param {z.infer<typeof projectStateSchema> | z.infer<typeof legacyProjectStateSchema>} projectState
   * @param {z.infer<typeof harnessStateSchema>} harnessState
   * @param {z.infer<typeof legacyStoredProjectSchema>} project
   */
  const prepareRetainedProductionProject = async (projectState, harnessState, project) => {
    if (project.harness?.adapterId !== SANDCASTLE_HARNESS_ADAPTER_ID) {
      return project;
    }
    await requireRegisteredProjectLocation(projectState, project);
    const harness = harnessState.harnesses.find((candidate) =>
      candidate.harnessId === project.harness?.harnessId);
    if (!harness) throw new Error("harness_not_found");
    if (
      harness.adapterId !== SANDCASTLE_HARNESS_ADAPTER_ID
      || harness.immutableRevision !== project.harness.pinnedRevision
    ) {
      throw new Error("harness_pin_invalid");
    }
    const preparation = await prepareProductionHarness({
      projectPath: project.canonicalPath,
      harnessId: harness.harnessId,
      workspacePath: harness.workspacePath,
      pinnedRevision: harness.immutableRevision,
    });
    if (project.harness.preparation) {
      if (JSON.stringify(project.harness.preparation) !== JSON.stringify(preparation)) {
        throw new Error("harness_pin_invalid");
      }
      return project;
    }
    project.harness = {
      ...project.harness,
      preparation: productionHarnessPreparationSchema.parse(preparation),
    };
    refreshRetainedProjectReferences(projectState, project);
    await writeProjectState(options.dataDir, projectState);
    return project;
  };

  /** @param {{requestId: string, path: string}} request */
  const inspectProject = (request) => withMutationLock(async () => {
    const state = await readProjectState(options.dataDir);
    const location = await resolveProjectLocation(state, request.path, options.dataDir);
    if (location.kind === "failure") {
      const auditId = await options.recordAudit("project.inspect", "rejected", {
        code: location.code,
        selectedPathHash: digest(typeof request.path === "string" ? request.path : ""),
        actualRevision: location.actualRevision,
        directoryScanPerformed: false,
      });
      return operationFailure({
        requestId: request.requestId,
        operation: "project.inspect",
        code: /** @type {keyof typeof failureGuidance} */ (location.code),
        actualRevision: location.actualRevision,
        auditId,
      });
    }
    if (
      location.kind === "registered"
      && location.project?.harness?.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID
    ) {
      try {
        await prepareRetainedProductionProject(
          state,
          await readHarnessState(options.dataDir),
          location.project,
        );
      } catch (error) {
        const code = preparationFailureCode(error);
        const auditId = await options.recordAudit("project.inspect", "rejected", {
          code,
          actualRevision: location.actualRevision,
          projectId: location.project.projectId,
          harnessId: location.project.harness.harnessId,
          directoryScanPerformed: false,
          projectFileWrite: false,
          pinWrite: false,
          harnessRunCreated: false,
          adapterStarted: false,
        });
        return operationFailure({
          requestId: request.requestId,
          operation: "project.inspect",
          code: /** @type {keyof typeof failureGuidance} */ (code),
          actualRevision: location.actualRevision,
          auditId,
        });
      }
    }
    return {
      type: "project.inspect.result",
      requestId: request.requestId,
      code: location.kind === "registered" ? "project_registered" : "project_unregistered",
      actualRevision: location.actualRevision,
      project: location.kind === "registered"
        ? publicProject(location.project)
        : null,
    };
  });

  /** @param {{requestId: string, path: string, configuration: unknown, resolutionAction?: string, authorizationClass: string, idempotencyKey: string, expectedRevision: number}} request */
  const registerProject = (request) => withMutationLock(async () => {
    const action = "project.register";
    const authorizationClass = "host_local_project_registration";
    const state = await readProjectState(options.dataDir);
    const keyValid = typeof request.idempotencyKey === "string"
      && request.idempotencyKey.length > 0
      && request.idempotencyKey.length <= 256;
    const keyHash = keyValid ? idempotencyHash(request.idempotencyKey) : null;
    const requestFingerprint = fingerprint({
      path: request.path,
      configuration: request.configuration,
      ...(request.resolutionAction === undefined
        ? {}
        : { resolutionAction: request.resolutionAction }),
      authorizationClass: request.authorizationClass,
      expectedRevision: request.expectedRevision,
    });
    /** @param {unknown} error @param {z.infer<typeof legacyStoredProjectSchema>} project */
    const rejectPreparation = async (error, project) => {
      const code = preparationFailureCode(error);
      const auditId = await options.recordAudit(action, "rejected", {
        code,
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: project.revision,
        projectId: project.projectId,
        harnessId: project.harness?.harnessId ?? null,
        directoryScanPerformed: false,
        projectFileWrite: false,
        pinWrite: false,
        harnessRunCreated: false,
        adapterStarted: false,
      });
      return operationFailure({
        requestId: request.requestId,
        operation: action,
        code: /** @type {keyof typeof failureGuidance} */ (code),
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: project.revision,
        auditId,
      });
    };
    const existing = keyHash
      ? state.registrationOutcomes.find((outcome) => outcome.idempotencyKeyHash === keyHash)
      : null;
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        const auditId = await options.recordAudit(action, "rejected", {
          code: "idempotency_key_conflict",
          authorizationClass,
          idempotencyKeyHash: keyHash,
          expectedRevision: Number.isSafeInteger(request.expectedRevision)
            ? request.expectedRevision
            : null,
          actualRevision: Number(existing.response.revision ?? 0),
          directoryScanPerformed: false,
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
      const existingResponse = /** @type {any} */ (existing.response);
      const retainedProjectId = existingResponse.project?.projectId;
      const retainedProject = typeof retainedProjectId === "string"
        ? state.projects.find((project) => project.projectId === retainedProjectId)
        : null;
      if (retainedProject?.harness?.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID) {
        try {
          await prepareRetainedProductionProject(
            state,
            await readHarnessState(options.dataDir),
            retainedProject,
          );
        } catch (error) {
          return rejectPreparation(error, retainedProject);
        }
        await writeProjectState(options.dataDir, state);
      }
      await options.recordAudit(action, "observed", {
        authorizationClass,
        idempotencyKeyHash: keyHash,
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

    const configuration = projectConfigurationSchema.safeParse(request.configuration);
    if (
      request.authorizationClass !== authorizationClass
      || !keyHash
      || !Number.isSafeInteger(request.expectedRevision)
      || request.expectedRevision < 0
      || (request.resolutionAction !== undefined
        && request.resolutionAction !== "register_as_new")
      || !configuration.success
    ) {
      const code = configuration.success
        ? "mutation_contract_invalid"
        : "bounded_configuration_invalid";
      const auditId = await options.recordAudit(action, "rejected", {
        code,
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: Number.isSafeInteger(request.expectedRevision)
          ? request.expectedRevision
          : null,
        actualRevision: 0,
        selectedPathHash: digest(typeof request.path === "string" ? request.path : ""),
        directoryScanPerformed: false,
        projectFileWrite: false,
      });
      return operationFailure({
        requestId: request.requestId,
        operation: action,
        code,
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: 0,
        auditId,
        retryable: false,
      });
    }

    let location = await resolveProjectLocation(state, request.path, options.dataDir);
    const registrationCandidate = location.kind === "failure"
      && location.code === "project_path_moved"
      ? location.registrationCandidate
      : null;
    const registerMovedAsNew = request.resolutionAction === "register_as_new"
      && typeof registrationCandidate?.canonicalPath === "string"
      && typeof registrationCandidate.identityDigest === "string"
      && typeof registrationCandidate.displayName === "string"
      && registrationCandidate.versionControl !== undefined;
    if (location.kind === "failure" && !registerMovedAsNew) {
      const auditId = await options.recordAudit(action, "rejected", {
        code: location.code,
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: location.actualRevision,
        selectedPathHash: digest(request.path),
        directoryScanPerformed: false,
        projectFileWrite: false,
      });
      return operationFailure({
        requestId: request.requestId,
        operation: action,
        code: /** @type {keyof typeof failureGuidance} */ (location.code),
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: location.actualRevision,
        auditId,
      });
    }
    if (registerMovedAsNew) {
      location = {
        kind: "unregistered",
        canonicalPath: registrationCandidate.canonicalPath,
        identityDigest: registrationCandidate.identityDigest,
        displayName: registrationCandidate.displayName,
        versionControl: registrationCandidate.versionControl,
        actualRevision: location.actualRevision,
      };
    } else if (request.resolutionAction !== undefined) {
      const auditId = await options.recordAudit(action, "rejected", {
        code: "mutation_contract_invalid",
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: location.actualRevision,
        selectedPathHash: digest(request.path),
        directoryScanPerformed: false,
        projectFileWrite: false,
      });
      return operationFailure({
        requestId: request.requestId,
        operation: action,
        code: "mutation_contract_invalid",
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: location.actualRevision,
        auditId,
        retryable: false,
      });
    }

    if (request.expectedRevision !== location.actualRevision) {
      const auditId = await options.recordAudit(action, "rejected", {
        code: "mutation_revision_conflict",
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: location.actualRevision,
        directoryScanPerformed: false,
        projectFileWrite: false,
      });
      return operationFailure({
        requestId: request.requestId,
        operation: action,
        code: "mutation_revision_conflict",
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: location.actualRevision,
        auditId,
      });
    }

    if (location.kind === "registered" && location.project) {
      if (JSON.stringify(location.project.configuration) !== JSON.stringify(configuration.data)) {
        const auditId = await options.recordAudit(action, "rejected", {
          code: "project_configuration_conflict",
          authorizationClass,
          idempotencyKeyHash: keyHash,
          expectedRevision: request.expectedRevision,
          actualRevision: location.actualRevision,
          projectId: location.project.projectId,
          directoryScanPerformed: false,
          projectFileWrite: false,
        });
        return operationFailure({
          requestId: request.requestId,
          operation: action,
          code: "project_configuration_conflict",
          authorizationClass,
          idempotencyKeyHash: keyHash,
          expectedRevision: request.expectedRevision,
          actualRevision: location.actualRevision,
          auditId,
          retryable: false,
        });
      }
      if (location.project.harness?.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID) {
        try {
          await prepareRetainedProductionProject(
            state,
            await readHarnessState(options.dataDir),
            location.project,
          );
        } catch (error) {
          return rejectPreparation(error, location.project);
        }
      }
      const auditId = await options.recordAudit(action, "observed", {
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: location.actualRevision,
        resultingRevision: location.actualRevision,
        projectId: location.project.projectId,
        registrationReused: true,
        directoryScanPerformed: false,
        projectFileWrite: false,
      });
      const response = {
        type: "project.register.result",
        requestId: request.requestId,
        code: "project_registration_reused",
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        revision: location.actualRevision,
        idempotentReplay: false,
        auditId,
        project: publicProject(location.project),
      };
      state.registrationOutcomes.push({
        idempotencyKeyHash: keyHash,
        requestFingerprint,
        response,
      });
      state.registrationOutcomes = state.registrationOutcomes.slice(-256);
      await writeProjectState(options.dataDir, state);
      return response;
    }

    const now = new Date().toISOString();
    const project = storedProjectSchema.parse({
      projectId: `project-${randomBytes(12).toString("hex")}`,
      revision: 1,
      displayName: location.displayName,
      canonicalPath: location.canonicalPath,
      filesystemIdentityDigest: location.identityDigest,
      status: "active",
      versionControl: location.versionControl,
      configuration: configuration.data,
      harness: null,
      readiness: readinessWithoutHarness(),
      createdAt: now,
      updatedAt: now,
    });
    const auditId = await options.recordAudit(action, "accepted", {
      authorizationClass,
      idempotencyKeyHash: keyHash,
      expectedRevision: request.expectedRevision,
      actualRevision: location.actualRevision,
      resultingRevision: 1,
      projectId: project.projectId,
      versionControlDetected: project.versionControl.detected,
      issueWorkflowReady: true,
      checkCount: project.configuration.checks.length,
      directoryScanPerformed: false,
      projectFileWrite: false,
      separateApprovalRequired: false,
    });
    const response = {
      type: "project.register.result",
      requestId: request.requestId,
      code: "project_registered",
      authorizationClass,
      idempotencyKeyHash: keyHash,
      expectedRevision: request.expectedRevision,
      revision: 1,
      idempotentReplay: false,
      auditId,
      project: publicProject(project),
    };
    state.projects.push(project);
    state.registrationOutcomes.push({
      idempotencyKeyHash: keyHash,
      requestFingerprint,
      response,
    });
    state.registrationOutcomes = state.registrationOutcomes.slice(-256);
    await writeProjectState(options.dataDir, state);
    return response;
  });

  /** @param {{requestId: string, projectId: string, authorizationClass: string, idempotencyKey: string, expectedRevision: number}} request */
  const forgetProjectRegistration = (request) =>
    withMutationLock(() => forgetRegistration(options, request));

  /** @param {z.infer<typeof harnessAdapterIdSchema>} adapterId */
  const readRegisteredHarness = async (adapterId) => {
    const state = await readHarnessState(options.dataDir);
    return state.harnesses.find((candidate) => candidate.adapterId === adapterId) ?? null;
  };

  /** @param {{requestId: string}} request */
  const inspectConformanceHarness = async (request) => {
    const harness = await readRegisteredHarness(CONFORMANCE_HARNESS_ADAPTER_ID);
    return {
      type: "harness.conformance.inspect.result",
      requestId: request.requestId,
      code: harness ? "conformance_harness_registered" : "conformance_harness_unregistered",
      actualRevision: harness?.revision ?? 0,
      harness: harness ? publicHarness(harness) : null,
    };
  };

  /** @param {{requestId: string}} request */
  const inspectSandcastleHarness = async (request) => {
    const harness = await readRegisteredHarness(SANDCASTLE_HARNESS_ADAPTER_ID);
    return {
      type: "harness.sandcastle.inspect.result",
      requestId: request.requestId,
      code: harness ? "sandcastle_harness_registered" : "sandcastle_harness_unregistered",
      actualRevision: harness?.revision ?? 0,
      harness: harness ? publicHarness(harness) : null,
    };
  };

  /**
   * @param {{requestId: string, name: string, authorizationClass: string, idempotencyKey: string, expectedRevision: number}} request
   * @param {{
   *   action: "harness.conformance.register" | "harness.sandcastle.register",
   *   adapterId: z.infer<typeof harnessAdapterIdSchema>,
   *   name: string,
   *   kind: "conformance" | "production",
   *   responseType: "harness.conformance.register.result" | "harness.sandcastle.register.result",
   *   registeredCode: "conformance_harness_registered" | "sandcastle_harness_registered",
   *   reusedCode: "conformance_harness_registration_reused" | "sandcastle_harness_registration_reused",
   * }} descriptor
   */
  const registerBundledHarness = (request, descriptor) => withMutationLock(async () => {
    const action = descriptor.action;
    const authorizationClass = "host_local_harness_registration";
    const state = await readHarnessState(options.dataDir);
    const keyValid = typeof request.idempotencyKey === "string"
      && request.idempotencyKey.length > 0
      && request.idempotencyKey.length <= 256;
    const keyHash = keyValid ? idempotencyHash(request.idempotencyKey) : null;
    const requestFingerprint = fingerprint({
      name: request.name,
      adapterId: descriptor.adapterId,
      authorizationClass: request.authorizationClass,
      expectedRevision: request.expectedRevision,
    });
    const existingOutcome = keyHash
      ? state.registrationOutcomes.find((outcome) => outcome.idempotencyKeyHash === keyHash)
      : null;
    if (existingOutcome) {
      if (existingOutcome.requestFingerprint !== requestFingerprint) {
        const auditId = await options.recordAudit(action, "rejected", {
          code: "idempotency_key_conflict",
          authorizationClass,
          idempotencyKeyHash: keyHash,
          expectedRevision: request.expectedRevision,
          actualRevision: Number(existingOutcome.response.revision ?? 0),
          projectFileWrite: false,
          workspaceWrite: false,
        });
        return operationFailure({
          requestId: request.requestId,
          operation: action,
          code: "idempotency_key_conflict",
          authorizationClass,
          idempotencyKeyHash: keyHash,
          expectedRevision: request.expectedRevision,
          actualRevision: Number(existingOutcome.response.revision ?? 0),
          auditId,
          retryable: false,
        });
      }
      await options.recordAudit(action, "observed", {
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        idempotentReplay: true,
        originalAuditId: existingOutcome.response.auditId,
        projectFileWrite: false,
        workspaceWrite: false,
      });
      return {
        ...structuredClone(existingOutcome.response),
        requestId: request.requestId,
        idempotentReplay: true,
      };
    }
    const registeredHarness = state.harnesses.find((candidate) =>
      candidate.adapterId === descriptor.adapterId);
    const actualRevision = registeredHarness?.revision ?? 0;
    if (
      request.authorizationClass !== authorizationClass
      || !keyHash
      || !Number.isSafeInteger(request.expectedRevision)
      || request.expectedRevision < 0
      || request.name !== descriptor.name
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
        workspaceWrite: false,
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
    if (request.expectedRevision !== actualRevision) {
      const auditId = await options.recordAudit(action, "rejected", {
        code: "mutation_revision_conflict",
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision,
        projectFileWrite: false,
        workspaceWrite: false,
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

    let harness;
    /** @type {"accepted" | "observed"} */
    let outcome = "accepted";
    /** @type {string} */
    let code = descriptor.registeredCode;
    if (registeredHarness) {
      harness = registeredHarness;
      outcome = "observed";
      code = descriptor.reusedCode;
    } else {
      const harnessId = `harness-${randomBytes(12).toString("hex")}`;
      const workspacePath = join(
        harnessWorkspaceRoot(options.dataDir),
        harnessId,
      );
      try {
        const immutableRevision = descriptor.kind === "conformance"
          ? await initializeConformanceWorkspace(workspacePath)
          : (await initializeProductionHarnessWorkspace(workspacePath, {
              sourceRoot: options.productionSeedRoot,
            })).revision;
        const pinnedAdapter = await loadPinnedHarnessAdapter({
          workspacePath,
          pinnedRevision: immutableRevision,
        });
        const probed = await invokePinnedHarnessAdapter(pinnedAdapter, ["probe"]);
        const probe = harnessAdapterProbeSchema.safeParse(probed.message);
        if (
          !probe.success
          || probe.data.adapterId !== descriptor.adapterId
          || probe.data.adapterId !== pinnedAdapter.compatibility.adapterId
          || probe.data.adapterProtocol !== pinnedAdapter.compatibility.adapterProtocol
        ) {
          throw new Error("harness_adapter_protocol_invalid");
        }
        harness = storedHarnessSchema.parse({
          harnessId,
          revision: 1,
          name: request.name,
          adapterId: descriptor.adapterId,
          kind: descriptor.kind,
          immutableRevision,
          launchParameters: probe.data.launchParameters,
          workspace: {
            kind: "harness-workspace",
            versionControl: "git",
            independent: true,
            headRevision: immutableRevision,
          },
          workspacePath,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        await rm(workspacePath, { recursive: true, force: true });
        const seedError = error instanceof ProductionHarnessSeedError
          ? error
          : descriptor.kind === "production"
            ? new ProductionHarnessSeedError("harness_seed_missing")
            : null;
        if (seedError) {
          const auditId = await options.recordAudit(action, "rejected", {
            code: seedError.code,
            authorizationClass,
            idempotencyKeyHash: keyHash,
            expectedRevision: request.expectedRevision,
            actualRevision,
            projectFileWrite: false,
            workspaceWrite: false,
            falselyReadyHarnessRetained: false,
          });
          return operationFailure({
            requestId: request.requestId,
            operation: action,
            code: seedError.code,
            authorizationClass,
            idempotencyKeyHash: keyHash,
            expectedRevision: request.expectedRevision,
            actualRevision,
            auditId,
            retryable: false,
          });
        }
        throw error;
      }
    }
    const auditId = await options.recordAudit(action, outcome, {
      authorizationClass,
      idempotencyKeyHash: keyHash,
      expectedRevision: request.expectedRevision,
      actualRevision,
      resultingRevision: harness.revision,
      harnessId: harness.harnessId,
      immutableRevision: harness.immutableRevision,
      independentWorkspace: true,
      workspaceOutsideProject: true,
      executionStateOutsideWorkspace: true,
    });
    const response = {
      type: descriptor.responseType,
      requestId: request.requestId,
      code,
      authorizationClass,
      idempotencyKeyHash: keyHash,
      expectedRevision: request.expectedRevision,
      revision: harness.revision,
      idempotentReplay: false,
      auditId,
      harness: publicHarness(harness),
    };
    if (!registeredHarness) {
      state.harnesses.push(harness);
    }
    state.registrationOutcomes.push({
      idempotencyKeyHash: keyHash,
      requestFingerprint,
      response,
    });
    state.registrationOutcomes = state.registrationOutcomes.slice(-256);
    await writeHarnessState(options.dataDir, state);
    return response;
  });

  /** @param {{requestId: string, name: string, authorizationClass: string, idempotencyKey: string, expectedRevision: number}} request */
  const registerConformanceHarness = (request) => registerBundledHarness(request, {
    action: "harness.conformance.register",
    adapterId: CONFORMANCE_HARNESS_ADAPTER_ID,
    name: "Sand-King Conformance Harness",
    kind: "conformance",
    responseType: "harness.conformance.register.result",
    registeredCode: "conformance_harness_registered",
    reusedCode: "conformance_harness_registration_reused",
  });

  /** @param {{requestId: string, name: string, authorizationClass: string, idempotencyKey: string, expectedRevision: number}} request */
  const registerSandcastleHarness = (request) => registerBundledHarness(request, {
    action: "harness.sandcastle.register",
    adapterId: SANDCASTLE_HARNESS_ADAPTER_ID,
    name: "Sand-King Sandcastle Harness",
    kind: "production",
    responseType: "harness.sandcastle.register.result",
    registeredCode: "sandcastle_harness_registered",
    reusedCode: "sandcastle_harness_registration_reused",
  });

  /** @param {{requestId: string, projectId: string, harnessId: string, boundedConfiguration: unknown, authorizationClass: string, idempotencyKey: string, expectedRevision: number}} request */
  const pinConformanceHarness = (request) => withMutationLock(async () => {
    const action = "project.harness.pin";
    const authorizationClass = "host_local_project_configuration";
    const projectState = await readProjectState(options.dataDir);
    const harnessState = await readHarnessState(options.dataDir);
    const project = projectState.projects.find((candidate) =>
      candidate.projectId === request.projectId);
    const harness = harnessState.harnesses.find((candidate) =>
      candidate.harnessId === request.harnessId);
    const actualRevision = project?.revision ?? 0;
    const keyValid = typeof request.idempotencyKey === "string"
      && request.idempotencyKey.length > 0
      && request.idempotencyKey.length <= 256;
    const keyHash = keyValid ? idempotencyHash(request.idempotencyKey) : null;
    const existing = keyHash
      ? projectState.pinOutcomes.find((outcome) => outcome.idempotencyKeyHash === keyHash)
      : null;
    const existingResponse = existing
      ? /** @type {any} */ (existing.response)
      : null;
    const retainedImmutableRevision = commitSchema.safeParse(
      existingResponse?.harness?.immutableRevision,
    ).success
      ? existingResponse.harness.immutableRevision
      : project?.harness?.pinnedRevision;
    const requestFingerprint = pinRequestFingerprint(
      request,
      retainedImmutableRevision ?? harness?.immutableRevision,
    );
    /** @param {unknown} error */
    const rejectPreparation = async (error) => {
      const code = preparationFailureCode(error);
      const auditId = await options.recordAudit(action, "rejected", {
        code,
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision,
        projectId: project?.projectId ?? null,
        harnessId: harness?.harnessId ?? null,
        immutableRevision: harness?.immutableRevision ?? null,
        projectFileWrite: false,
        pinWrite: false,
        harnessRunCreated: false,
        adapterStarted: false,
      });
      return operationFailure({
        requestId: request.requestId,
        operation: action,
        code: /** @type {keyof typeof failureGuidance} */ (code),
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision,
        auditId,
      });
    };
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        const auditId = await options.recordAudit(action, "rejected", {
          code: "idempotency_key_conflict",
          authorizationClass,
          idempotencyKeyHash: keyHash,
          expectedRevision: request.expectedRevision,
          actualRevision,
          projectFileWrite: false,
          pinWrite: false,
        });
        return operationFailure({
          requestId: request.requestId,
          operation: action,
          code: "idempotency_key_conflict",
          authorizationClass,
          idempotencyKeyHash: keyHash,
          expectedRevision: request.expectedRevision,
          actualRevision,
          auditId,
          retryable: false,
        });
      }
      try {
        if (project) await requireRegisteredProjectLocation(projectState, project);
        if (project?.harness?.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID) {
          await prepareRetainedProductionProject(projectState, harnessState, project);
        }
      } catch (error) {
        return rejectPreparation(error);
      }
      existing.requestFingerprint = requestFingerprint;
      await writeProjectState(options.dataDir, projectState);
      await options.recordAudit(action, "observed", {
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        idempotentReplay: true,
        originalAuditId: existing.response.auditId,
        projectFileWrite: false,
        pinWrite: false,
      });
      return {
        ...structuredClone(existing.response),
        requestId: request.requestId,
        idempotentReplay: true,
      };
    }

    const boundedConfiguration = boundedHarnessConfigurationSchema.safeParse(
      request.boundedConfiguration,
    );
    let code = null;
    if (
      request.authorizationClass !== authorizationClass
      || !keyHash
      || !Number.isSafeInteger(request.expectedRevision)
      || request.expectedRevision < 0
    ) {
      code = "mutation_contract_invalid";
    } else if (!project) {
      code = "project_not_found";
    } else if (!harness) {
      code = "harness_not_found";
    } else if (!boundedConfiguration.success) {
      code = "bounded_configuration_invalid";
    }
    if (code) {
      const auditId = await options.recordAudit(action, "rejected", {
        code,
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: Number.isSafeInteger(request.expectedRevision)
          ? request.expectedRevision
          : null,
        actualRevision,
        projectId: project?.projectId ?? null,
        harnessId: harness?.harnessId ?? null,
        projectFileWrite: false,
        pinWrite: false,
      });
      return operationFailure({
        requestId: request.requestId,
        operation: action,
        code: /** @type {keyof typeof failureGuidance} */ (code),
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision,
        auditId,
        retryable: code !== "bounded_configuration_invalid",
      });
    }
    if (!project || !harness || !boundedConfiguration.success || !keyHash) {
      throw new Error("project_harness_pin_validation_invariant_failed");
    }
    if (request.expectedRevision !== actualRevision) {
      const auditId = await options.recordAudit(action, "rejected", {
        code: "mutation_revision_conflict",
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision,
        projectId: project.projectId,
        harnessId: harness.harnessId,
        projectFileWrite: false,
        pinWrite: false,
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

    try {
      await requireRegisteredProjectLocation(projectState, project);
    } catch (error) {
      return rejectPreparation(error);
    }

    let productionPreparation = null;
    if (harness.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID) {
      try {
        await prepareRetainedProductionProject(projectState, harnessState, project);
        productionPreparation = await prepareProductionHarness({
          projectPath: project.canonicalPath,
          harnessId: harness.harnessId,
          workspacePath: harness.workspacePath,
          pinnedRevision: harness.immutableRevision,
        });
      } catch (error) {
        return rejectPreparation(error);
      }
    } else {
      const observedHead = await execFileAsync(
        "git",
        ["-C", harness.workspacePath, "rev-parse", "HEAD"],
      ).then(({ stdout }) => stdout.trim(), () => null);
      if (observedHead !== harness.immutableRevision) {
        const auditId = await options.recordAudit(action, "rejected", {
          code: "harness_workspace_invalid",
          authorizationClass,
          idempotencyKeyHash: keyHash,
          expectedRevision: request.expectedRevision,
          actualRevision,
          projectId: project.projectId,
          harnessId: harness.harnessId,
          projectFileWrite: false,
          pinWrite: false,
        });
        return operationFailure({
          requestId: request.requestId,
          operation: action,
          code: "harness_workspace_invalid",
          authorizationClass,
          idempotencyKeyHash: keyHash,
          expectedRevision: request.expectedRevision,
          actualRevision,
          auditId,
        });
      }
    }
    if (
      harness.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID
      && !productionPreparation
    ) {
      throw new Error("production_harness_preparation_invariant_failed");
    }

    const alreadyPinned = project.harness?.harnessId === harness.harnessId
      && project.harness.pinnedRevision === harness.immutableRevision
      && JSON.stringify(project.harness.boundedConfiguration)
        === JSON.stringify(boundedConfiguration.data)
      && (harness.adapterId !== SANDCASTLE_HARNESS_ADAPTER_ID
        || (project.harness.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID
          && JSON.stringify(project.harness.preparation)
            === JSON.stringify(productionPreparation)));
    const resultingRevision = alreadyPinned ? actualRevision : actualRevision + 1;
    const auditId = await options.recordAudit(
      action,
      alreadyPinned ? "observed" : "accepted",
      {
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision,
        resultingRevision,
        projectId: project.projectId,
        harnessId: harness.harnessId,
        immutableRevision: harness.immutableRevision,
        projectFileWrite: false,
        pinWrite: !alreadyPinned,
        launchRequestReady: true,
        productionPreparation,
      },
    );
    if (!alreadyPinned) {
      project.revision = resultingRevision;
      if (harness.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID) {
        project.harness = {
          harnessId: harness.harnessId,
          name: harness.name,
          adapterId: harness.adapterId,
          pinnedRevision: harness.immutableRevision,
          boundedConfiguration: boundedConfiguration.data,
          preparation: productionHarnessPreparationSchema.parse(productionPreparation),
        };
      } else {
        project.harness = {
          harnessId: harness.harnessId,
          name: harness.name,
          adapterId: harness.adapterId,
          pinnedRevision: harness.immutableRevision,
          boundedConfiguration: boundedConfiguration.data,
        };
      }
      project.readiness = readinessWithHarness();
      project.updatedAt = new Date().toISOString();
    }
    const response = {
      type: "project.harness.pin.result",
      requestId: request.requestId,
      code: alreadyPinned ? "project_harness_pin_reused" : "project_harness_pinned",
      authorizationClass,
      idempotencyKeyHash: keyHash,
      expectedRevision: request.expectedRevision,
      revision: resultingRevision,
      idempotentReplay: false,
      auditId,
      project: publicProject(project),
      harness: publicHarness(harness),
    };
    projectState.pinOutcomes.push({
      idempotencyKeyHash: keyHash,
      requestFingerprint,
      response,
    });
    projectState.pinOutcomes = projectState.pinOutcomes.slice(-256);
    await writeProjectState(options.dataDir, projectState);
    return response;
  });

  /** @param {string} projectId */
  const loadLaunchContext = (projectId) => withMutationLock(async () => {
    const projectState = await readProjectState(options.dataDir);
    const harnessState = await readHarnessState(options.dataDir);
    const project = projectState.projects.find((candidate) =>
      candidate.projectId === projectId && candidate.status === "active");
    if (!project) {
      throw new Error("project_not_found");
    }
    const location = await resolveProjectLocation(
      projectState,
      project.canonicalPath,
      options.dataDir,
    );
    if (location.kind !== "registered") {
      throw new Error(location.kind === "failure" ? location.code : "launch_precondition_invalid");
    }
    if (!location.project || location.project.projectId !== project.projectId) {
      throw new Error("launch_precondition_invalid");
    }
    if (!project.harness) {
      throw new Error("harness_pin_missing");
    }
    const harness = harnessState.harnesses.find((candidate) =>
      candidate.harnessId === project.harness?.harnessId);
    if (!harness) {
      throw new Error("harness_not_found");
    }
    if (harness.immutableRevision !== project.harness.pinnedRevision) {
      throw new Error("harness_pin_invalid");
    }
    let productionHarnessProjectionPath = null;
    if (harness.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID) {
      let preparation;
      try {
        await prepareRetainedProductionProject(projectState, harnessState, project);
        preparation = await prepareProductionHarness({
          projectPath: project.canonicalPath,
          harnessId: harness.harnessId,
          workspacePath: harness.workspacePath,
          pinnedRevision: harness.immutableRevision,
        });
      } catch (error) {
        if (error instanceof ProductionHarnessPreparationError) {
          throw new Error(error.code);
        }
        throw error;
      }
      if (
        project.harness.adapterId !== SANDCASTLE_HARNESS_ADAPTER_ID
        || JSON.stringify(project.harness.preparation) !== JSON.stringify(preparation)
      ) {
        throw new Error("harness_pin_invalid");
      }
      productionHarnessProjectionPath = join(
        project.canonicalPath,
        ...preparation.projection.path.split("/"),
      );
    }
    return {
      project: publicProject(project),
      harness: publicHarness(harness),
      harnessWorkspacePath: harness.workspacePath,
      productionHarnessProjectionPath,
    };
  });

  return {
    inspectProject,
    registerProject,
    forgetProjectRegistration,
    inspectConformanceHarness,
    registerConformanceHarness,
    inspectSandcastleHarness,
    registerSandcastleHarness,
    pinHarness: pinConformanceHarness,
    pinConformanceHarness,
    loadLaunchContext,
  };
};
