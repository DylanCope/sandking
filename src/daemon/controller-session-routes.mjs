import { randomBytes } from "node:crypto";
import { digest } from "../common/digest.mjs";
import { ControllerSessionError } from "../controller-sessions.mjs";

/** @param {any} runtime */
export const createControllerSessionRoutes = (runtime) => {
let projectSessionMutationQueue = Promise.resolve();
/** @type {Map<string, {fingerprint: string, status: number, response: any}>} */
const projectSessionOutcomes = new Map();
const {
  hostMutationFailure,
  mutationFailure,
  recordAudit,
  requestFocusedHostMutation,
  requestHostOperation,
} = runtime;

/** @template T @param {() => Promise<T>} operation */
const withProjectSessionMutationLock = (operation) => {
  const current = projectSessionMutationQueue.catch(() => undefined).then(operation);
  projectSessionMutationQueue = current.then(() => undefined, () => undefined);
  return current;
};

/** @param {any} request */
const handleProviderOperation = async (request) => {
  const input = request.input && typeof request.input === "object"
    ? request.input
    : {};
  if (request.operation === "work-context.inspect") {
    const project = runtime.currentProjectPreparation.current;
    if (!project || project.projectId !== request.workContext.workContextId || !project.harness) {
      throw new ControllerSessionError("project_work_context_unavailable");
    }
    return {
      type: "project.work-context",
      projectId: project.projectId,
      revision: project.revision,
      displayName: project.displayName,
      harnessId: project.harness.harnessId,
      pinnedRevision: project.harness.pinnedRevision,
    };
  }
  if (request.operation === "controller-cli.describe") {
    const project = runtime.currentProjectPreparation.current;
    if (!project?.harness || project.projectId !== request.workContext.workContextId) {
      throw new ControllerSessionError("project_work_context_unavailable");
    }
    return {
      type: "controller.cli.description",
      protocol: "1.0.0",
      command: "sandking launch",
      focusedProjectId: request.workContext.workContextId,
      projectArgumentOptional: true,
      pluginRequired: false,
      launchParameters: project.harness.launchParameters,
    };
  }
  if (request.operation === "harness-run.launch") {
    const message = {
      type: "harness.run.launch",
      requestId: `harness-run-launch-${randomBytes(8).toString("hex")}`,
      projectId: request.workContext.workContextId,
      ...("parameters" in input ? { parameters: input.parameters } : {}),
      controllerId: runtime.state.runtimeId,
      controllerSessionId: request.sessionId,
      source: "controller-cli",
      authorizationClass: "harness_run_launch",
      idempotencyKeyHash: "idempotencyKeyHash" in input
        ? String(input.idempotencyKeyHash)
        : "",
    };
    return requestFocusedHostMutation("harness.run.launch", message, {
      projectId: message.projectId,
      parameters: message.parameters,
      controllerId: message.controllerId,
      controllerSessionId: message.controllerSessionId,
      source: message.source,
      authorizationClass: message.authorizationClass,
    });
  }
  if (request.operation === "harness-run.cancel") {
    return requestHostOperation({
      type: "harness.run.cancel",
      requestId: `harness-run-cancel-${randomBytes(8).toString("hex")}`,
      harnessRunId: "harnessRunId" in input ? String(input.harnessRunId) : "",
      controllerId: runtime.state.runtimeId,
      controllerSessionId: request.sessionId,
      source: "controller-cli",
      authorizationClass: "harness_run_cancellation",
      idempotencyKeyHash: "idempotencyKeyHash" in input
        ? String(input.idempotencyKeyHash)
        : "",
    });
  }
  if (request.operation === "harness-run.recover") {
    return requestHostOperation({
      type: "harness.run.recover",
      requestId: `harness-run-recover-${randomBytes(8).toString("hex")}`,
      harnessRunId: "harnessRunId" in input ? String(input.harnessRunId) : "",
      action: "action" in input ? String(input.action) : "",
      controllerId: runtime.state.runtimeId,
      controllerSessionId: request.sessionId,
      source: "controller-cli",
      authorizationClass: "harness_run_recovery",
      idempotencyKeyHash: "idempotencyKeyHash" in input
        ? String(input.idempotencyKeyHash)
        : "",
    });
  }
  if (request.operation === "harness-run.lookup") {
    return requestHostOperation({
      type: "harness.run.lookup",
      requestId: `harness-run-lookup-${randomBytes(8).toString("hex")}`,
      idempotencyKeyHash: "idempotencyKeyHash" in input
        ? String(input.idempotencyKeyHash)
        : "",
    });
  }
  throw new ControllerSessionError("provider_operation_unsupported");
};

/**
 * @param {{authorizationAccepted: boolean, idempotencyKey: string, idempotencyKeyHash: string | null, expectedRevision: number, projectId: string, providerId: string}} request
 */
const openProjectControllerSession = (request) => withProjectSessionMutationLock(async () => {
  const authorizationClass = "project_focused_session";
  const project = runtime.currentProjectPreparation.current;
  const selectedProviderId = request.providerId === "conformance-controller-v1"
    || request.providerId === "claude-code"
    ? request.providerId
    : null;
  const fingerprint = digest(JSON.stringify({
    projectId: request.projectId,
    providerId: request.providerId,
    expectedRevision: request.expectedRevision,
  }));
  const existing = request.idempotencyKeyHash
    ? projectSessionOutcomes.get(request.idempotencyKeyHash)
    : null;
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      const auditId = await recordAudit("project.session.open", "rejected", {
        code: "idempotency_key_conflict",
        authorizationClass,
        idempotencyKeyHash: request.idempotencyKeyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: project?.revision ?? 0,
      });
      return {
        status: 409,
        body: {
          ...mutationFailure(
            "idempotency_key_conflict",
            authorizationClass,
            request.expectedRevision,
            project?.revision ?? 0,
            auditId,
          ),
          idempotentReplay: false,
        },
      };
    }
    await recordAudit("project.session.open", "observed", {
      authorizationClass,
      idempotencyKeyHash: request.idempotencyKeyHash,
      idempotentReplay: true,
      originalAuditId: existing.response.auditId,
      code: existing.response.code,
      ...(existing.response.session
        ? { sessionId: existing.response.session.sessionId }
        : {}),
    });
    return {
      status: existing.response.type === "mutation_result" ? 200 : existing.status,
      body: { ...structuredClone(existing.response), idempotentReplay: true },
    };
  }
  if (request.authorizationAccepted && runtime.state.host.status === "disconnected") {
    return hostMutationFailure(
      "host_disconnected",
      "project.session.open",
      authorizationClass,
      request.expectedRevision,
      request.idempotencyKeyHash,
      {
        projectId: request.projectId,
        providerId: request.providerId,
      },
    );
  }
  if (
    !request.authorizationAccepted
    || !request.idempotencyKeyHash
    || request.idempotencyKey.length === 0
    || request.idempotencyKey.length > 256
    || !selectedProviderId
    || !project
    || project.projectId !== request.projectId
  ) {
    const code = !request.authorizationAccepted
      ? "authorization_failed"
      : !project || project.projectId !== request.projectId
        ? "project_not_found"
        : "mutation_contract_invalid";
    const auditId = await recordAudit("project.session.open", "rejected", {
      code,
      authorizationClass,
      idempotencyKeyHash: request.idempotencyKeyHash,
      expectedRevision: Number.isSafeInteger(request.expectedRevision)
        ? request.expectedRevision
        : null,
      actualRevision: project?.revision ?? 0,
    });
    const status = code === "authorization_failed"
      ? 403
      : code === "project_not_found"
        ? 404
        : 400;
    const body = {
      ...mutationFailure(
        code,
        authorizationClass,
        Number.isSafeInteger(request.expectedRevision) ? request.expectedRevision : -1,
        project?.revision ?? 0,
        auditId,
      ),
      idempotentReplay: false,
    };
    if (request.idempotencyKeyHash) {
      projectSessionOutcomes.set(request.idempotencyKeyHash, {
        fingerprint,
        status,
        response: body,
      });
    }
    return { status, body };
  }
  if (request.expectedRevision !== project.revision) {
    const auditId = await recordAudit("project.session.open", "rejected", {
      code: "mutation_revision_conflict",
      authorizationClass,
      idempotencyKeyHash: request.idempotencyKeyHash,
      expectedRevision: request.expectedRevision,
      actualRevision: project.revision,
      projectId: project.projectId,
    });
    const status = 409;
    const body = {
      ...mutationFailure(
        "mutation_revision_conflict",
        authorizationClass,
        request.expectedRevision,
        project.revision,
        auditId,
      ),
      idempotentReplay: false,
    };
    projectSessionOutcomes.set(request.idempotencyKeyHash, {
      fingerprint,
      status,
      response: body,
    });
    return { status, body };
  }
  let session;
  try {
    session = await runtime.controllerSessions?.start({
      workContextId: project.projectId,
      kind: "project",
      canonicalReference: `sandking:project:${project.projectId}`,
    }, {
      providerId: selectedProviderId,
      workingDirectory: selectedProviderId === "claude-code"
        ? runtime.currentProjectPath ?? ""
        : runtime.args.dataDir,
    });
    if (!session) {
      throw new ControllerSessionError("controller_session_unavailable");
    }
  } catch (error) {
    const code = error instanceof ControllerSessionError
      ? error.code
      : "controller_session_start_failed";
    const auditId = await recordAudit("project.session.open", "rejected", {
      code,
      authorizationClass,
      idempotencyKeyHash: request.idempotencyKeyHash,
      expectedRevision: request.expectedRevision,
      actualRevision: project.revision,
      projectId: project.projectId,
      providerId: request.providerId,
      controllerSessionCreated: false,
      harnessRunLaunched: false,
      projectFileWrite: false,
    });
    const status = 503;
    const body = {
      ...mutationFailure(
        code,
        authorizationClass,
        request.expectedRevision,
        project.revision,
        auditId,
      ),
      idempotentReplay: false,
      prohibitedSideEffects: {
        controllerSessionCreated: false,
        harnessRunLaunched: false,
        projectFileWrite: false,
      },
    };
    projectSessionOutcomes.set(request.idempotencyKeyHash, {
      fingerprint,
      status,
      response: body,
    });
    return { status, body };
  }
  const auditId = await recordAudit("project.session.open", "accepted", {
    authorizationClass,
    idempotencyKeyHash: request.idempotencyKeyHash,
    expectedRevision: request.expectedRevision,
    resultingRevision: project.revision,
    projectId: project.projectId,
    providerId: request.providerId,
    sessionId: session.sessionId,
    providerSessionId: session.provider.providerSessionId,
    providerAdapterId: session.provider.adapterId,
    ptyRuntimeOwned: session.terminal.runtimeOwned,
  });
  const response = {
    type: "mutation_result",
    code: "project_focused_controller_session_opened",
    authorizationClass,
    expectedRevision: request.expectedRevision,
    revision: project.revision,
    idempotentReplay: false,
    auditId,
    session,
    prohibitedSideEffects: {
      harnessRunLaunched: false,
      projectFileWrite: false,
    },
  };
  runtime.currentProjectControllerSession = structuredClone(session);
  projectSessionOutcomes.set(request.idempotencyKeyHash, {
    fingerprint,
    status: 201,
    response,
  });
  return { status: 201, body: response };
});

return { handleProviderOperation, openProjectControllerSession };
};
