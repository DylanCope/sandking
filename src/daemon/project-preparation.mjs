import { randomBytes } from "node:crypto";
import { projectIdPattern } from "../common/identifiers.mjs";
import { ControllerSessionError } from "../controller-sessions.mjs";
import {
  CONFORMANCE_HARNESS_ADAPTER_ID,
  SANDCASTLE_HARNESS_ADAPTER_ID,
} from "../harness-adapter-identity.mjs";
import { projectPreparationProjection } from "../project-registration.mjs";

/** @param {any} runtime */
export const createProjectPreparation = (runtime) => {
let projectPreparationQueue = Promise.resolve();
const {
  derivedHostIdempotencyKey,
  hostMutationFailure,
  projectFailureStatus,
  projectMutationSummary,
  recordAudit,
  replayHostMutationOutcome,
  requestHostOperation,
  retainHostMutationOutcome,
} = runtime;

/** @template T @param {() => Promise<T>} operation */
const withProjectPreparationLock = (operation) => {
  const current = projectPreparationQueue.catch(() => undefined).then(operation);
  projectPreparationQueue = current.then(() => undefined, () => undefined);
  return current;
};

const clearCurrentProjectPreparation = () => {
  runtime.currentProjectPreparation = projectPreparationProjection();
  runtime.currentProjectPath = null;
};

/** @param {any} failure */
const projectFailureInvalidatesCurrentPreparation = (failure) =>
  failure?.code === "project_path_conflict"
  || failure?.registrations?.some((/** @type {any} */ registration) =>
    registration.projectId === runtime.currentProjectPreparation.current?.projectId) === true;

/**
 * @param {string} code
 * @param {number} expectedRevision
 * @param {number} actualRevision
 * @param {string | null} idempotencyKeyHash
 * @param {string[]} actions
 * @param {{action?: string, authorizationClass?: string}} [context]
 */
const runtimeProjectFailure = async (
  code,
  expectedRevision,
  actualRevision,
  idempotencyKeyHash,
  actions,
  context = {},
) => {
  const action = context.action ?? "project.prepare";
  const authorizationClass = context.authorizationClass
    ?? "host_local_project_preparation";
  const auditId = await recordAudit(action, "rejected", {
    code,
    authorizationClass,
    idempotencyKeyHash,
    expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
    actualRevision,
    directoryScanPerformed: false,
    projectFileWrite: false,
    harnessWorkspaceWrite: false,
  });
  return {
    type: "project_preparation_failure",
    code,
    retryable: code !== "bounded_configuration_invalid"
      && code !== "project_configuration_conflict",
    authorizationClass,
    expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
    actualRevision,
    auditId,
    resolution: { summary: code, actions },
    prohibitedSideEffects: {
      directoryScan: false,
      projectFileWrite: false,
      harnessPinWrite: false,
      approvalRequest: false,
    },
  };
};

/**
 * @param {{path: unknown, configuration: unknown, harnessAdapterId?: unknown, resolutionAction?: unknown, idempotencyKey: string, idempotencyKeyHash: string | null, expectedRevision: number}} request
 */
const prepareExplicitProject = (request) => withProjectPreparationLock(async () => {
  const mutationContractValid = !(
    typeof request.idempotencyKey !== "string"
    || request.idempotencyKey.length === 0
    || request.idempotencyKey.length > 256
    || !Number.isSafeInteger(request.expectedRevision)
    || request.expectedRevision < 0
    || (request.harnessAdapterId !== undefined
      && request.harnessAdapterId !== CONFORMANCE_HARNESS_ADAPTER_ID
      && request.harnessAdapterId !== SANDCASTLE_HARNESS_ADAPTER_ID)
    || (request.resolutionAction !== undefined
      && request.resolutionAction !== "register_as_new")
  );

  const requestContent = {
    path: request.path,
    configuration: request.configuration,
    harnessAdapterId: request.harnessAdapterId,
    resolutionAction: request.resolutionAction,
  };
  const prohibitedSideEffects = {
    directoryScan: false,
    projectFileWrite: false,
    trackedSandKingFileWrite: false,
    approvalRequest: false,
  };
  if (mutationContractValid) {
    const retained = await replayHostMutationOutcome(
      "project.prepare",
      "host_local_project_preparation",
      request.expectedRevision,
      /** @type {string} */ (request.idempotencyKeyHash),
      requestContent,
      runtime.currentProjectPreparation.current?.revision ?? 0,
      prohibitedSideEffects,
    );
    if (retained) {
      if (projectFailureInvalidatesCurrentPreparation(retained.body)) {
        clearCurrentProjectPreparation();
      }
      return retained;
    }
  }
  if (runtime.state.host.status === "disconnected") {
    return hostMutationFailure(
      "host_disconnected",
      "project.prepare",
      "host_local_project_preparation",
      request.expectedRevision,
      request.idempotencyKeyHash,
      requestContent,
    );
  }
  if (!mutationContractValid) {
    return {
      status: 400,
      body: await runtimeProjectFailure(
        "mutation_contract_invalid",
        request.expectedRevision,
        0,
        request.idempotencyKeyHash,
        ["retry_with_valid_mutation_contract"],
      ),
    };
  }
  /** @param {{status: number, body: any}} outcome */
  const retainProjectPreparation = (outcome) => {
    retainHostMutationOutcome(
      "project.prepare",
      /** @type {string} */ (request.idempotencyKeyHash),
      request.expectedRevision,
      requestContent,
      outcome,
    );
    return outcome;
  };

  /** @param {string} label */
  const requestId = (label) => `${label}-${randomBytes(8).toString("hex")}`;
  const inspection = await requestHostOperation({
    type: "project.inspect",
    requestId: requestId("project-inspect"),
    path: typeof request.path === "string" ? request.path : "",
  });
  const registeringSelectedPathAsNew = inspection.type === "project.operation.failure"
    && [
      "project_path_moved",
      "project_path_replaced",
      "project_path_tombstoned",
    ].includes(inspection.code)
    && request.resolutionAction === "register_as_new";
  if (inspection.type === "project.operation.failure" && !registeringSelectedPathAsNew) {
    if (projectFailureInvalidatesCurrentPreparation(inspection)) {
      clearCurrentProjectPreparation();
    }
    return retainProjectPreparation({
      status: projectFailureStatus[inspection.code] ?? 409,
      body: inspection,
    });
  }
  if (inspection.type !== "project.inspect.result" && !registeringSelectedPathAsNew) {
    throw new Error("host_protocol_error");
  }

  const inspectedProject = inspection.type === "project.inspect.result"
    ? inspection.project
    : null;
  const selectedHarnessAdapterId = request.harnessAdapterId
    ?? inspectedProject?.harness?.adapterId
    ?? SANDCASTLE_HARNESS_ADAPTER_ID;
  if (
    inspectedProject?.harness
    && inspectedProject.harness.adapterId !== selectedHarnessAdapterId
  ) {
    return retainProjectPreparation({
      status: 400,
      body: await runtimeProjectFailure(
        "bounded_configuration_invalid",
        request.expectedRevision,
        inspectedProject.revision,
        request.idempotencyKeyHash,
        ["keep_existing_harness_or_open_another_project"],
      ),
    });
  }
  const productionSelected = selectedHarnessAdapterId === SANDCASTLE_HARNESS_ADAPTER_ID;
  const harnessProtocol = productionSelected ? {
    inspectType: "harness.sandcastle.inspect",
    inspectResultType: "harness.sandcastle.inspect.result",
    registerType: "harness.sandcastle.register",
    registerResultType: "harness.sandcastle.register.result",
    registeredCode: "sandcastle_harness_registered",
    name: "Sand-King Sandcastle Harness",
  } : {
    inspectType: "harness.conformance.inspect",
    inspectResultType: "harness.conformance.inspect.result",
    registerType: "harness.conformance.register",
    registerResultType: "harness.conformance.register.result",
    registeredCode: "conformance_harness_registered",
    name: "Sand-King Conformance Harness",
  };

  const ensureHarness = async () => {
    const harnessInspection = /** @type {any} */ (await requestHostOperation({
      type: harnessProtocol.inspectType,
      requestId: requestId("harness-inspect"),
    }));
    if (harnessInspection.type !== harnessProtocol.inspectResultType) {
      throw new Error("host_protocol_error");
    }
    if (harnessInspection.harness) {
      return { harness: harnessInspection.harness, registration: null, failure: null };
    }
    const registration = /** @type {any} */ (await requestHostOperation({
      type: harnessProtocol.registerType,
      requestId: requestId("harness-register"),
      name: harnessProtocol.name,
      authorizationClass: "host_local_harness_registration",
      idempotencyKey: derivedHostIdempotencyKey(
        request.idempotencyKey,
        harnessProtocol.registerType,
      ),
      expectedRevision: 0,
    }));
    if (registration.type === "project.operation.failure") {
      return { harness: null, registration, failure: registration };
    }
    if (registration.type !== harnessProtocol.registerResultType) {
      throw new Error("host_protocol_error");
    }
    return { harness: registration.harness, registration, failure: null };
  };

  /** @type {any} */
  let harness = null;
  /** @type {any} */
  let harnessRegistration = null;
  let pin = null;
  // Validate and materialize the production seed before tracking a fresh
  // Project. A rejected seed must leave neither half of the composite ready.
  if (productionSelected) {
    try {
      const ensured = await ensureHarness();
      if (ensured.failure) {
        return retainProjectPreparation({
          status: projectFailureStatus[
            /** @type {keyof typeof projectFailureStatus} */ (ensured.failure.code)
          ] ?? 409,
          body: ensured.failure,
        });
      }
      harness = ensured.harness;
      harnessRegistration = ensured.registration;
    } catch (error) {
      if (
        error instanceof ControllerSessionError
        && (error.code === "host_disconnected" || error.code === "host_protocol_invalid")
      ) {
        return hostMutationFailure(
          error.code,
          "project.prepare",
          "host_local_project_preparation",
          request.expectedRevision,
          request.idempotencyKeyHash,
          requestContent,
          {
            project: runtime.currentProjectPreparation.current,
            harness,
            mutations: {
              projectRegistration: null,
              harnessRegistration: projectMutationSummary(harnessRegistration),
              harnessPin: null,
            },
            effects: {
              projectRegistrationCreated: false,
              harnessRegistrationCreated:
                harnessRegistration?.code === harnessProtocol.registeredCode,
              harnessPinChanged: false,
            },
          },
        );
      }
      throw error;
    }
  }

  const projectRegistration = await requestHostOperation({
    type: "project.register",
    requestId: requestId("project-register"),
    path: typeof request.path === "string" ? request.path : "",
    configuration: request.configuration,
    ...(request.resolutionAction === "register_as_new"
      ? { resolutionAction: request.resolutionAction }
      : {}),
    authorizationClass: "host_local_project_registration",
    idempotencyKey: derivedHostIdempotencyKey(
      request.idempotencyKey,
      "project.register",
    ),
    // A fresh Runtime has no Project revision to expose in its bootstrap
    // document. Let an ordinary open adopt the revision discovered by the
    // immediately preceding inspection, while preserving the caller's CAS
    // whenever this Runtime has already observed a Project.
    expectedRevision: runtime.currentProjectPreparation.current === null && inspectedProject
      ? inspectedProject.revision
      : request.expectedRevision,
  });
  if (projectRegistration.type === "project.operation.failure") {
    if (projectFailureInvalidatesCurrentPreparation(projectRegistration)) {
      clearCurrentProjectPreparation();
    }
    return retainProjectPreparation({
      status: projectFailureStatus[projectRegistration.code] ?? 409,
      body: projectRegistration,
    });
  }
  if (projectRegistration.type !== "project.register.result") {
    throw new Error("host_protocol_error");
  }
  if (request.resolutionAction === "register_as_new") {
    const resolutionInspection = await requestHostOperation({
      type: "project.inspect",
      requestId: requestId("project-resolution-inspect"),
      path: typeof request.path === "string" ? request.path : "",
    });
    if (resolutionInspection.type === "project.operation.failure") {
      clearCurrentProjectPreparation();
      return retainProjectPreparation({
        status: projectFailureStatus[resolutionInspection.code] ?? 409,
        body: resolutionInspection,
      });
    }
    if (resolutionInspection.type !== "project.inspect.result") {
      throw new Error("host_protocol_error");
    }
  }
  // An idempotent registration replay returns its original revisioned outcome;
  // the preceding inspection remains the current canonical Project snapshot.
  let project = inspectedProject ?? projectRegistration.project;
  runtime.currentProjectPreparation = projectPreparationProjection(project, harness);
  runtime.currentProjectPath = project.canonicalPath;

  try {
    if (!harness) {
      const ensured = await ensureHarness();
      if (ensured.failure) {
        return retainProjectPreparation({
          status: projectFailureStatus[
            /** @type {keyof typeof projectFailureStatus} */ (ensured.failure.code)
          ] ?? 409,
          body: ensured.failure,
        });
      }
      harness = ensured.harness;
      harnessRegistration = ensured.registration;
    }

    if (
      !project.harness
      || project.harness.harnessId !== harness.harnessId
      || project.harness.pinnedRevision !== harness.immutableRevision
    ) {
      pin = await requestHostOperation({
        type: "project.harness.pin",
        requestId: requestId("project-pin"),
        projectId: project.projectId,
        harnessId: harness.harnessId,
        boundedConfiguration: {
          adapterProtocol: "1.0.0",
          launchProfile: "delegated-work",
        },
        authorizationClass: "host_local_project_configuration",
        idempotencyKey: derivedHostIdempotencyKey(
          request.idempotencyKey,
          "project.harness.pin",
        ),
        expectedRevision: project.revision,
      });
      if (pin.type === "project.operation.failure") {
        return retainProjectPreparation({
          status: projectFailureStatus[pin.code] ?? 409,
          body: pin,
        });
      }
      if (pin.type !== "project.harness.pin.result") {
        throw new Error("host_protocol_error");
      }
      project = pin.project;
      runtime.currentProjectPreparation = projectPreparationProjection(project, harness);
    }
  } catch (error) {
    if (
      error instanceof ControllerSessionError
      && (error.code === "host_disconnected" || error.code === "host_protocol_invalid")
    ) {
      const mutations = {
        projectRegistration: projectMutationSummary(projectRegistration),
        harnessRegistration: projectMutationSummary(harnessRegistration),
        harnessPin: projectMutationSummary(pin),
      };
      return hostMutationFailure(
        error.code,
        "project.prepare",
        "host_local_project_preparation",
        request.expectedRevision,
        request.idempotencyKeyHash,
        requestContent,
        {
          project: runtime.currentProjectPreparation.current,
          harness,
          mutations,
          effects: {
            projectRegistrationCreated: projectRegistration.code === "project_registered",
            harnessRegistrationCreated:
              mutations.harnessRegistration?.code === harnessProtocol.registeredCode,
            harnessPinChanged: mutations.harnessPin?.code === "project_harness_pinned",
          },
        },
      );
    }
    throw error;
  }

  runtime.currentProjectPreparation = projectPreparationProjection(project, harness);
  runtime.currentProjectPath = project.canonicalPath;
  const preparationAuditId = await recordAudit("project.prepare", "observed", {
    authorizationClass: "host_local_project_preparation",
    idempotencyKeyHash: request.idempotencyKeyHash,
    expectedRevision: request.expectedRevision,
    resultingRevision: project.revision,
    projectId: project.projectId,
    harnessId: project.harness?.harnessId ?? null,
    harnessAdapterId: project.harness?.adapterId ?? null,
    pinnedRevision: project.harness?.pinnedRevision ?? null,
    checksReady: project.readiness.checks === "ready",
    configurationReady: project.readiness.configuration === "ready",
    launchRequestReady: project.readiness.launchRequest === "ready",
    directoryScanPerformed: false,
    projectFileWrite: false,
    separateApprovalRequired: false,
  });
  return retainProjectPreparation({
    status: 200,
    body: {
      type: "project_preparation_result",
      code: "project_ready",
      authorizationClass: "host_local_project_preparation",
      expectedRevision: request.expectedRevision,
      revision: project.revision,
      auditId: preparationAuditId,
      idempotentReplay: false,
      project: runtime.currentProjectPreparation.current,
      mutations: {
        projectRegistration: projectMutationSummary(projectRegistration),
        harnessRegistration: projectMutationSummary(harnessRegistration),
        harnessPin: projectMutationSummary(pin),
      },
      prohibitedSideEffects: {
        directoryScan: false,
        projectFileWrite: false,
        trackedSandKingFileWrite: false,
        approvalRequest: false,
      },
    },
  });
});

/**
 * @param {{action: unknown, projectId: unknown, path: unknown, idempotencyKey: string, idempotencyKeyHash: string | null, expectedRevision: number}} request
 */
const resolveExplicitProjectRegistration = (request) =>
  withProjectPreparationLock(async () => {
    const requestContent = {
      action: request.action,
      projectId: request.projectId,
      path: request.path,
    };
    const mutationContractValid = typeof request.idempotencyKey === "string"
      && request.idempotencyKey.length > 0
      && request.idempotencyKey.length <= 256
      && typeof request.projectId === "string"
      && projectIdPattern.test(request.projectId)
      && ["forget", "restore", "resolve_conflict"].includes(String(request.action))
      && (request.action === "forget"
        || (typeof request.path === "string" && request.path.length > 0))
      && Number.isSafeInteger(request.expectedRevision)
      && request.expectedRevision >= 0;
    if (runtime.state.host.status === "disconnected") {
      return hostMutationFailure(
        "host_disconnected",
        "project.registration.resolve",
        "host_local_project_registration",
        request.expectedRevision,
        request.idempotencyKeyHash,
        requestContent,
      );
    }
    if (!mutationContractValid) {
      return {
        status: 400,
        body: await runtimeProjectFailure(
          "mutation_contract_invalid",
          request.expectedRevision,
          0,
          request.idempotencyKeyHash,
          ["retry_with_valid_mutation_contract"],
          {
            action: "project.registration.resolve",
            authorizationClass: "host_local_project_registration",
          },
        ),
      };
    }
    const outcome = await requestHostOperation({
      type: "project.registration.resolve",
      requestId: `project-registration-resolution-${randomBytes(8).toString("hex")}`,
      action: request.action,
      projectId: request.projectId,
      ...(typeof request.path === "string" ? { path: request.path } : {}),
      authorizationClass: "host_local_project_registration",
      idempotencyKey: derivedHostIdempotencyKey(
        request.idempotencyKey,
        "project.registration.resolve",
      ),
      expectedRevision: request.expectedRevision,
    });
    if (outcome.type === "project.operation.failure") {
      if (projectFailureInvalidatesCurrentPreparation(outcome)) {
        clearCurrentProjectPreparation();
      }
      return {
        status: projectFailureStatus[outcome.code] ?? 409,
        body: outcome,
      };
    }
    if (outcome.type !== "project.registration.resolve.result") {
      throw new Error("host_protocol_error");
    }
    clearCurrentProjectPreparation();
    return { status: 200, body: outcome };
  });

return {
  clearCurrentProjectPreparation,
  prepareExplicitProject,
  resolveExplicitProjectRegistration,
  runtimeProjectFailure,
};
};
