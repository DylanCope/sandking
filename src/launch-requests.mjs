import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { readJson, writePrivateJson } from "./private-state.mjs";

const execFileAsync = promisify(execFile);

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const auditIdSchema = z.string().regex(/^audit-[a-f0-9]{24}$/);
const hostIdSchema = z.string().regex(/^host-[a-f0-9]{24}$/);
const projectIdSchema = z.string().regex(/^project-[a-f0-9]{24}$/);
const harnessIdSchema = z.string().regex(/^harness-[a-f0-9]{24}$/);
const controllerIdSchema = z.string().regex(/^runtime-[a-f0-9]{24}$/);
const controllerSessionIdSchema = z.string().regex(/^controller-session-[a-f0-9]{24}$/);
const launchRequestIdSchema = z.string().regex(/^launch-request-[a-f0-9]{24}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const capabilitySchema = z.enum(["github.issues.read", "project.git.read"]);

export const launchParametersSchema = z.object({
  issueNumber: z.number().int().positive().max(999_999_999),
  targetBranch: z.string().min(1).max(128).regex(/^sandcastle\/issue-[1-9][0-9]*$/),
}).strict().refine(
  (parameters) => parameters.targetBranch === `sandcastle/issue-${parameters.issueNumber}`,
  { message: "the conformance branch must bind the selected issue" },
);

const ownerSchema = z.object({
  controllerId: controllerIdSchema,
  controllerSessionId: controllerSessionIdSchema,
}).strict();

const launchPreviewSchema = z.object({
  kind: z.literal("sanitized-launch-preview"),
  launchRequestId: launchRequestIdSchema,
  revision: z.literal(1),
  hostId: hostIdSchema,
  projectId: projectIdSchema,
  harnessId: harnessIdSchema,
  harnessPinnedRevision: commitSchema,
  parameters: launchParametersSchema,
  suppliedCapabilities: z.array(capabilitySchema).min(1).max(8),
  authorizationClass: z.literal("focused_controller_launch"),
  expiresAt: z.string().datetime(),
  summary: z.string().min(1).max(512),
  secretFree: z.literal(true),
  delegatedWorkStarted: z.literal(false),
}).strict();

const decisionSchema = z.object({
  decisionId: z.string().regex(/^launch-decision-[a-f0-9]{24}$/),
  decision: z.enum(["approved", "rejected"]),
  decidedAt: z.string().datetime(),
  controllerId: controllerIdSchema,
  controllerSessionId: controllerSessionIdSchema,
  expectedRevision: z.number().int().positive(),
  auditId: auditIdSchema,
}).strict();

export const launchRequestSchema = z.object({
  launchRequestId: launchRequestIdSchema,
  revision: z.number().int().positive(),
  status: z.enum(["pending", "approved", "rejected", "expired"]),
  singleUse: z.literal(true),
  host: z.object({ hostId: hostIdSchema }).strict(),
  project: z.object({
    projectId: projectIdSchema,
    revision: z.number().int().positive(),
    displayName: z.string().min(1).max(255),
  }).strict(),
  harness: z.object({
    harnessId: harnessIdSchema,
    adapterId: z.literal("conformance-harness-adapter-v1"),
    pinnedRevision: commitSchema,
  }).strict(),
  parameters: launchParametersSchema,
  suppliedCapabilities: z.array(capabilitySchema).min(1).max(8),
  authorizationClass: z.literal("focused_controller_launch"),
  owner: ownerSchema,
  preparedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  capturedPreconditions: z.object({
    hostId: hostIdSchema,
    projectRevision: z.number().int().positive(),
    harnessId: harnessIdSchema,
    harnessPinnedRevision: commitSchema,
    boundedConfigurationDigest: digestSchema,
    suppliedCapabilitiesDigest: digestSchema,
  }).strict(),
  preview: launchPreviewSchema,
  decision: decisionSchema.nullable(),
  execution: z.object({
    status: z.literal("not_started"),
    harnessRunId: z.null(),
    outcomeReference: z.null(),
  }).strict(),
}).strict();

const launchContextSchema = z.object({
  project: z.object({
    projectId: projectIdSchema,
    revision: z.number().int().positive(),
    displayName: z.string().min(1).max(255),
    harness: z.object({
      harnessId: harnessIdSchema,
      adapterId: z.literal("conformance-harness-adapter-v1"),
      pinnedRevision: commitSchema,
      boundedConfiguration: z.object({
        adapterProtocol: z.literal("1.0.0"),
        launchProfile: z.literal("delegated-work"),
      }).strict(),
    }).passthrough(),
  }).passthrough(),
  harness: z.object({
    harnessId: harnessIdSchema,
    adapterId: z.literal("conformance-harness-adapter-v1"),
    immutableRevision: commitSchema,
  }).passthrough(),
  harnessWorkspacePath: z.string().min(1).max(4_096).optional(),
}).strict();

const harnessPreparationSchema = z.object({
  adapterId: z.literal("conformance-harness-adapter-v1"),
  adapterProtocol: z.literal("1.0.0"),
  negotiatedCapabilities: z.array(z.literal("harness.launch.prepare.v1")).length(1),
  suppliedCapabilities: z.array(capabilitySchema).min(1).max(8),
  sanitizedPreview: z.object({
    summary: z.string().min(1).max(512),
    secretFree: z.literal(true),
  }).strict(),
  sideEffects: z.object({
    delegatedWorkStarted: z.literal(false),
    projectWrite: z.literal(false),
    harnessWorkspaceWrite: z.literal(false),
  }).strict(),
}).strict();

const harnessProbeSchema = z.object({
  type: z.literal("harness.adapter.probe"),
  adapterProtocol: z.literal("1.0.0"),
  adapterId: z.literal("conformance-harness-adapter-v1"),
  capabilities: z.tuple([z.literal("harness.launch.prepare.v1")]),
}).strict();
const harnessPreparedEnvelopeSchema = harnessPreparationSchema.extend({
  type: z.literal("harness.launch.prepared"),
}).strict();

const retainedOutcomeSchema = z.object({
  idempotencyKeyHash: digestSchema,
  requestFingerprint: digestSchema,
  response: z.object({}).passthrough(),
}).strict();
const retainedStateSchema = z.object({
  schemaVersion: z.literal(1),
  launchRequests: z.array(launchRequestSchema),
  preparationOutcomes: z.array(retainedOutcomeSchema),
  decisionOutcomes: z.array(retainedOutcomeSchema),
}).strict();

const initialState = () => ({
  schemaVersion: 1,
  launchRequests: [],
  preparationOutcomes: [],
  decisionOutcomes: [],
});

/** @param {unknown} value @returns {string} */
const canonicalJson = (value) => {
  if (value === undefined) {
    return '"<undefined>"';
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};
/** @param {unknown} value */
const digest = (value) => `sha256:${createHash("sha256")
  .update(typeof value === "string" ? value : canonicalJson(value))
  .digest("hex")}`;
/** @param {string} dataDir */
const statePath = (dataDir) => join(dataDir, "launch-requests.json");

/**
 * Invoke preparation from the exact committed conformance Harness revision.
 * The adapter receives only its bounded secret-free parameters and never the
 * Project path, so it cannot perform delegated Project work during preparation.
 * @param {any} context
 * @param {import("zod").infer<typeof launchParametersSchema>} parameters
 */
export const prepareConformanceHarnessLaunch = async (context, parameters) => {
  const parsedParameters = launchParametersSchema.parse(parameters);
  const workspacePath = typeof context?.harnessWorkspacePath === "string"
    ? context.harnessWorkspacePath
    : "";
  const pinnedRevision = context?.project?.harness?.pinnedRevision;
  if (!workspacePath || !commitSchema.safeParse(pinnedRevision).success) {
    throw new Error("harness_workspace_invalid");
  }
  const adapterPath = join(workspacePath, "run.mjs");
  const environment = { LANG: "C.UTF-8" };
  /** @param {...string} args */
  const git = async (...args) => (await execFileAsync("git", ["-C", workspacePath, ...args], {
    env: environment,
    timeout: 3_000,
    maxBuffer: 32_768,
  })).stdout.trim();
  const assertPinnedAdapterBytes = async () => {
    const [{ stdout: pinnedAdapterSource }, workspaceAdapterSource] = await Promise.all([
      execFileAsync("git", [
        "-C", workspacePath,
        "show", `${pinnedRevision}:run.mjs`,
      ], {
        env: environment,
        timeout: 3_000,
        maxBuffer: 32_768,
      }),
      readFile(adapterPath, "utf8"),
    ]);
    if (workspaceAdapterSource !== pinnedAdapterSource) {
      throw new Error("harness_workspace_invalid");
    }
  };
  /** @param {string[]} args */
  const invoke = async (args) => {
    await assertPinnedAdapterBytes();
    const { stdout } = await execFileAsync(process.execPath, [adapterPath, ...args], {
      cwd: workspacePath,
      env: environment,
      timeout: 3_000,
      maxBuffer: 32_768,
    });
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error("harness_adapter_protocol_invalid");
    }
  };
  const observedRevision = await git("rev-parse", "HEAD");
  const statusBefore = await git("status", "--porcelain");
  if (observedRevision !== pinnedRevision || statusBefore !== "") {
    throw new Error("harness_workspace_invalid");
  }
  const probe = harnessProbeSchema.parse(await invoke(["probe"]));
  if (!probe.capabilities.includes("harness.launch.prepare.v1")) {
    throw new Error("harness_capability_unsupported");
  }
  const encodedParameters = Buffer.from(JSON.stringify(parsedParameters), "utf8")
    .toString("base64url");
  const prepared = harnessPreparedEnvelopeSchema.parse(
    await invoke(["prepare", encodedParameters]),
  );
  const statusAfter = await git("status", "--porcelain");
  if (statusAfter !== statusBefore) {
    throw new Error("harness_preparation_side_effect_detected");
  }
  await assertPinnedAdapterBytes();
  const { type, ...result } = prepared;
  void type;
  return harnessPreparationSchema.parse(result);
};

/**
 * @param {{
 *   dataDir: string,
 *   hostId: string,
 *   recordAudit: (action: string, outcome: "accepted" | "rejected" | "observed", details?: Record<string, unknown>) => Promise<string>,
 *   loadLaunchContext: (projectId: string) => Promise<unknown>,
 *   prepareHarness: (context: any, parameters: import("zod").infer<typeof launchParametersSchema>) => Promise<unknown>,
 *   now?: () => Date,
 * }} options
 */
export const createLaunchRequestManager = async (options) => {
  const parsedHostId = hostIdSchema.parse(options.hostId);
  const now = options.now ?? (() => new Date());
  let mutationQueue = Promise.resolve();
  /** @template T @param {() => Promise<T>} operation */
  const withMutationLock = (operation) => {
    const current = mutationQueue.catch(() => undefined).then(operation);
    mutationQueue = current.then(() => undefined, () => undefined);
    return current;
  };
  const readState = async () => retainedStateSchema.parse(
    await readJson(statePath(options.dataDir), initialState()),
  );

  /**
   * @param {string} code
   * @param {any} request
   * @param {string | null} idempotencyKeyHash
   * @param {boolean} [retryable]
   * @param {{state: any, requestFingerprint: string} | null} [retention]
   */
  const preparationFailure = async (
    code,
    request,
    idempotencyKeyHash,
    retryable = true,
    retention = null,
  ) => {
    const authorizationClass = "focused_controller_launch";
    const auditId = await options.recordAudit("launch.request.prepare", "rejected", {
      code,
      authorizationClass,
      idempotencyKeyHash,
      expectedRevision: Number.isSafeInteger(request.expectedRevision)
        ? request.expectedRevision
        : null,
      actualRevision: 0,
      projectId: typeof request.projectId === "string" ? request.projectId : null,
      controllerId: typeof request.controllerId === "string" ? request.controllerId : null,
      controllerSessionId: typeof request.controllerSessionId === "string"
        ? request.controllerSessionId
        : null,
      previewCreated: false,
      delegatedWorkStarted: false,
      projectWrite: false,
      harnessWorkspaceWrite: false,
      outcomeReference: null,
    });
    const response = {
      type: "launch.request.prepare.failure",
      requestId: typeof request.requestId === "string" ? request.requestId : "invalid-request",
      code,
      retryable,
      authorizationClass,
      idempotencyKeyHash,
      expectedRevision: Number.isSafeInteger(request.expectedRevision)
        ? request.expectedRevision
        : null,
      actualRevision: 0,
      idempotentReplay: false,
      auditId,
      prohibitedSideEffects: {
        delegatedWorkStarted: false,
        projectWrite: false,
        harnessWorkspaceWrite: false,
        approvalRecorded: false,
      },
    };
    if (retention && idempotencyKeyHash) {
      retention.state.preparationOutcomes.push({
        idempotencyKeyHash,
        requestFingerprint: retention.requestFingerprint,
        response,
      });
      await writePrivateJson(statePath(options.dataDir), retention.state);
    }
    return response;
  };

  /** @param {any} request */
  const prepare = (request) => withMutationLock(async () => {
    const authorizationClass = "focused_controller_launch";
    const keyValid = typeof request.idempotencyKey === "string"
      && request.idempotencyKey.length > 0
      && request.idempotencyKey.length <= 256;
    const idempotencyKeyHash = keyValid ? digest(request.idempotencyKey) : null;
    const requestFingerprint = digest({
      projectId: request.projectId,
      parameters: request.parameters,
      controllerId: request.controllerId,
      controllerSessionId: request.controllerSessionId,
      authorizationClass: request.authorizationClass,
      expectedRevision: request.expectedRevision,
      expiresInSeconds: request.expiresInSeconds,
    });
    const state = await readState();
    const existing = idempotencyKeyHash
      ? state.preparationOutcomes.find((outcome) =>
          outcome.idempotencyKeyHash === idempotencyKeyHash)
      : null;
    if (existing && existing.requestFingerprint === requestFingerprint) {
      await options.recordAudit("launch.request.prepare", "observed", {
        authorizationClass,
        idempotencyKeyHash,
        idempotentReplay: true,
        originalAuditId: existing.response.auditId,
        delegatedWorkStarted: false,
      });
      return {
        ...structuredClone(existing.response),
        requestId: request.requestId,
        idempotentReplay: true,
      };
    }
    if (existing || !idempotencyKeyHash) {
      return preparationFailure(
        existing ? "idempotency_key_conflict" : "mutation_contract_invalid",
        request,
        idempotencyKeyHash,
        false,
      );
    }
    const parameters = launchParametersSchema.safeParse(request.parameters);
    const owner = ownerSchema.safeParse({
      controllerId: request.controllerId,
      controllerSessionId: request.controllerSessionId,
    });
    if (
      request.authorizationClass !== authorizationClass
      || request.expectedRevision !== 0
      || !Number.isSafeInteger(request.expiresInSeconds)
      || request.expiresInSeconds < 1
      || request.expiresInSeconds > 900
      || !parameters.success
      || !owner.success
    ) {
      return preparationFailure(
        parameters.success ? "mutation_contract_invalid" : "bounded_configuration_invalid",
        request,
        idempotencyKeyHash,
        false,
        { state, requestFingerprint },
      );
    }

    let context;
    try {
      context = launchContextSchema.parse(await options.loadLaunchContext(request.projectId));
    } catch (error) {
      const observedCode = error instanceof Error ? error.message : "";
      const code = [
        "project_not_found",
        "harness_not_found",
        "harness_pin_missing",
        "harness_pin_invalid",
      ].includes(observedCode) ? observedCode : "launch_precondition_invalid";
      return preparationFailure(
        code,
        request,
        idempotencyKeyHash,
        true,
        { state, requestFingerprint },
      );
    }
    if (
      context.project.projectId !== request.projectId
      || context.project.harness.harnessId !== context.harness.harnessId
      || context.project.harness.pinnedRevision !== context.harness.immutableRevision
    ) {
      return preparationFailure(
        "launch_precondition_invalid",
        request,
        idempotencyKeyHash,
        true,
        { state, requestFingerprint },
      );
    }
    let harnessPreparation;
    try {
      harnessPreparation = harnessPreparationSchema.parse(
        await options.prepareHarness(context, parameters.data),
      );
    } catch (error) {
      const observedCode = error instanceof Error ? error.message : "";
      const code = [
        "harness_workspace_invalid",
        "harness_capability_unsupported",
        "harness_adapter_protocol_invalid",
        "harness_preparation_side_effect_detected",
      ].includes(observedCode) ? observedCode : "harness_adapter_protocol_invalid";
      return preparationFailure(
        code,
        request,
        idempotencyKeyHash,
        false,
        { state, requestFingerprint },
      );
    }
    const launchRequestId = `launch-request-${randomBytes(12).toString("hex")}`;
    const preparedAtDate = now();
    const preparedAt = preparedAtDate.toISOString();
    const expiresAt = new Date(
      preparedAtDate.getTime() + request.expiresInSeconds * 1_000,
    ).toISOString();
    const launchRequest = launchRequestSchema.parse({
      launchRequestId,
      revision: 1,
      status: "pending",
      singleUse: true,
      host: { hostId: parsedHostId },
      project: {
        projectId: context.project.projectId,
        revision: context.project.revision,
        displayName: context.project.displayName,
      },
      harness: {
        harnessId: context.harness.harnessId,
        adapterId: context.harness.adapterId,
        pinnedRevision: context.harness.immutableRevision,
      },
      parameters: parameters.data,
      suppliedCapabilities: harnessPreparation.suppliedCapabilities,
      authorizationClass,
      owner: owner.data,
      preparedAt,
      expiresAt,
      capturedPreconditions: {
        hostId: parsedHostId,
        projectRevision: context.project.revision,
        harnessId: context.harness.harnessId,
        harnessPinnedRevision: context.harness.immutableRevision,
        boundedConfigurationDigest: digest(context.project.harness.boundedConfiguration),
        suppliedCapabilitiesDigest: digest(harnessPreparation.suppliedCapabilities),
      },
      preview: {
        kind: "sanitized-launch-preview",
        launchRequestId,
        revision: 1,
        hostId: parsedHostId,
        projectId: context.project.projectId,
        harnessId: context.harness.harnessId,
        harnessPinnedRevision: context.harness.immutableRevision,
        parameters: parameters.data,
        suppliedCapabilities: harnessPreparation.suppliedCapabilities,
        authorizationClass,
        expiresAt,
        summary: harnessPreparation.sanitizedPreview.summary,
        secretFree: true,
        delegatedWorkStarted: false,
      },
      decision: null,
      execution: {
        status: "not_started",
        harnessRunId: null,
        outcomeReference: null,
      },
    });
    const auditId = await options.recordAudit("launch.request.prepare", "accepted", {
      authorizationClass,
      idempotencyKeyHash,
      expectedRevision: 0,
      resultingRevision: 1,
      launchRequestId,
      hostId: parsedHostId,
      projectId: context.project.projectId,
      projectRevision: context.project.revision,
      harnessId: context.harness.harnessId,
      harnessPinnedRevision: context.harness.immutableRevision,
      controllerId: owner.data.controllerId,
      controllerSessionId: owner.data.controllerSessionId,
      adapterId: harnessPreparation.adapterId,
      adapterProtocol: harnessPreparation.adapterProtocol,
      negotiatedCapabilities: harnessPreparation.negotiatedCapabilities,
      suppliedCapabilities: harnessPreparation.suppliedCapabilities,
      expiresAt,
      previewSecretFree: true,
      delegatedWorkStarted: false,
      projectWrite: false,
      harnessWorkspaceWrite: false,
      outcomeReference: null,
    });
    const response = {
      type: "launch.request.prepare.result",
      requestId: request.requestId,
      code: "launch_request_prepared",
      authorizationClass,
      idempotencyKeyHash,
      expectedRevision: 0,
      revision: 1,
      idempotentReplay: false,
      auditId,
      launchRequest,
    };
    state.launchRequests.push(launchRequest);
    state.preparationOutcomes.push({
      idempotencyKeyHash,
      requestFingerprint,
      response,
    });
    await writePrivateJson(statePath(options.dataDir), state);
    return response;
  });

  /** @param {import("zod").infer<typeof launchRequestSchema> | undefined} launchRequest */
  const currentSummary = (launchRequest) => launchRequest ? {
    launchRequestId: launchRequest.launchRequestId,
    revision: launchRequest.revision,
    status: launchRequest.status,
    preview: structuredClone(launchRequest.preview),
  } : null;

  /**
   * @param {string} code
   * @param {any} request
   * @param {import("zod").infer<typeof launchRequestSchema> | undefined} launchRequest
   * @param {string | null} idempotencyKeyHash
   * @param {boolean} [retryable]
   * @param {{state: any, requestFingerprint: string} | null} [retention]
   */
  const decisionFailure = async (
    code,
    request,
    launchRequest,
    idempotencyKeyHash,
    retryable = true,
    retention = null,
  ) => {
    const authorizationClass = "focused_controller_launch";
    const expectedRevision = Number.isSafeInteger(request.expectedRevision)
      ? request.expectedRevision
      : null;
    const actualRevision = launchRequest?.revision ?? 0;
    const auditId = await options.recordAudit("launch.request.decision", "rejected", {
      code,
      authorizationClass,
      idempotencyKeyHash,
      expectedRevision,
      actualRevision,
      launchRequestId: launchRequest?.launchRequestId ?? null,
      hostId: launchRequest?.host.hostId ?? parsedHostId,
      projectId: launchRequest?.project.projectId ?? null,
      harnessId: launchRequest?.harness.harnessId ?? null,
      controllerId: typeof request.controllerId === "string" ? request.controllerId : null,
      controllerSessionId: typeof request.controllerSessionId === "string"
        ? request.controllerSessionId
        : null,
      decision: request.decision === "approved" || request.decision === "rejected"
        ? request.decision
        : null,
      currentStatus: launchRequest?.status ?? null,
      sanitizedSummary: launchRequest ? launchRequest.preview.summary : null,
      harnessRunStarted: false,
      browserApprovalAccepted: false,
      executionOutcome: "not_started",
      outcomeReference: null,
    });
    const response = {
      type: "launch.request.decision.failure",
      requestId: typeof request.requestId === "string" ? request.requestId : "invalid-request",
      code,
      retryable,
      authorizationClass,
      idempotencyKeyHash,
      expectedRevision,
      actualRevision,
      idempotentReplay: false,
      auditId,
      current: currentSummary(launchRequest),
      prohibitedSideEffects: {
        harnessRunStarted: false,
        browserApprovalAccepted: false,
      },
    };
    if (retention && idempotencyKeyHash) {
      retention.state.decisionOutcomes.push({
        idempotencyKeyHash,
        requestFingerprint: retention.requestFingerprint,
        response,
      });
      await writePrivateJson(statePath(options.dataDir), retention.state);
    }
    return response;
  };

  /** @param {any} request */
  const decide = (request) => withMutationLock(async () => {
    const authorizationClass = "focused_controller_launch";
    const keyValid = typeof request.idempotencyKey === "string"
      && request.idempotencyKey.length > 0
      && request.idempotencyKey.length <= 256;
    const idempotencyKeyHash = keyValid ? digest(request.idempotencyKey) : null;
    const requestFingerprint = digest({
      launchRequestId: request.launchRequestId,
      decision: request.decision,
      controllerId: request.controllerId,
      controllerSessionId: request.controllerSessionId,
      authorizationClass: request.authorizationClass,
      expectedRevision: request.expectedRevision,
    });
    const state = await readState();
    const launchRequest = state.launchRequests.find((candidate) =>
      candidate.launchRequestId === request.launchRequestId);
    const existing = idempotencyKeyHash
      ? state.decisionOutcomes.find((outcome) =>
          outcome.idempotencyKeyHash === idempotencyKeyHash)
      : null;
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        return decisionFailure(
          "idempotency_key_conflict",
          request,
          launchRequest,
          idempotencyKeyHash,
          false,
        );
      }
      await options.recordAudit("launch.request.decision", "observed", {
        authorizationClass,
        idempotencyKeyHash,
        expectedRevision: request.expectedRevision,
        idempotentReplay: true,
        originalAuditId: existing.response.auditId,
        launchRequestId: request.launchRequestId,
        controllerId: request.controllerId,
        controllerSessionId: request.controllerSessionId,
        decision: request.decision,
        harnessRunStarted: false,
        executionOutcome: "not_started",
        outcomeReference: null,
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
      || !launchRequestIdSchema.safeParse(request.launchRequestId).success
      || (request.decision !== "approved" && request.decision !== "rejected")
      || !ownerSchema.safeParse({
        controllerId: request.controllerId,
        controllerSessionId: request.controllerSessionId,
      }).success
      || !Number.isSafeInteger(request.expectedRevision)
      || request.expectedRevision < 0
    ) {
      return decisionFailure(
        "mutation_contract_invalid",
        request,
        launchRequest,
        idempotencyKeyHash,
        false,
        { state, requestFingerprint },
      );
    }
    if (!launchRequest) {
      return decisionFailure(
        "launch_request_not_found",
        request,
        undefined,
        idempotencyKeyHash,
        true,
        { state, requestFingerprint },
      );
    }
    if (
      launchRequest.owner.controllerId !== request.controllerId
      || launchRequest.owner.controllerSessionId !== request.controllerSessionId
    ) {
      return decisionFailure(
        "authorization_failed",
        request,
        launchRequest,
        idempotencyKeyHash,
        false,
        { state, requestFingerprint },
      );
    }
    if (request.expectedRevision !== launchRequest.revision) {
      return decisionFailure(
        "mutation_revision_conflict",
        request,
        launchRequest,
        idempotencyKeyHash,
        true,
        { state, requestFingerprint },
      );
    }
    if (launchRequest.status !== "pending") {
      return decisionFailure(
        "launch_request_terminal",
        request,
        launchRequest,
        idempotencyKeyHash,
        false,
        { state, requestFingerprint },
      );
    }

    const decidedAt = now().toISOString();
    if (Date.parse(decidedAt) >= Date.parse(launchRequest.expiresAt)) {
      launchRequest.status = "expired";
      launchRequest.revision += 1;
      await options.recordAudit("launch.request.expire", "observed", {
        launchRequestId: launchRequest.launchRequestId,
        hostId: launchRequest.host.hostId,
        projectId: launchRequest.project.projectId,
        harnessId: launchRequest.harness.harnessId,
        controllerId: launchRequest.owner.controllerId,
        controllerSessionId: launchRequest.owner.controllerSessionId,
        expectedRevision: request.expectedRevision,
        resultingRevision: launchRequest.revision,
        expiredAt: decidedAt,
        expiresAt: launchRequest.expiresAt,
        decision: "expired",
        executionOutcome: "not_started",
        outcomeReference: null,
      });
      return decisionFailure(
        "launch_request_expired",
        request,
        launchRequest,
        idempotencyKeyHash,
        false,
        { state, requestFingerprint },
      );
    }

    let currentContext;
    let currentHarnessPreparation;
    try {
      currentContext = launchContextSchema.parse(
        await options.loadLaunchContext(launchRequest.project.projectId),
      );
      currentHarnessPreparation = harnessPreparationSchema.parse(
        await options.prepareHarness(currentContext, launchRequest.parameters),
      );
    } catch {
      currentContext = null;
      currentHarnessPreparation = null;
    }
    const preconditionsHold = currentContext
      && currentHarnessPreparation
      && currentContext.project.revision === launchRequest.capturedPreconditions.projectRevision
      && currentContext.project.harness.harnessId
        === launchRequest.capturedPreconditions.harnessId
      && currentContext.project.harness.pinnedRevision
        === launchRequest.capturedPreconditions.harnessPinnedRevision
      && currentContext.harness.immutableRevision
        === launchRequest.capturedPreconditions.harnessPinnedRevision
      && digest(currentContext.project.harness.boundedConfiguration)
        === launchRequest.capturedPreconditions.boundedConfigurationDigest
      && digest(currentHarnessPreparation.suppliedCapabilities)
        === launchRequest.capturedPreconditions.suppliedCapabilitiesDigest
      && currentHarnessPreparation.sanitizedPreview.summary
        === launchRequest.preview.summary;
    if (!preconditionsHold) {
      launchRequest.status = "expired";
      launchRequest.revision += 1;
      await options.recordAudit("launch.request.expire", "observed", {
        code: "launch_request_materially_changed",
        launchRequestId: launchRequest.launchRequestId,
        hostId: launchRequest.host.hostId,
        projectId: launchRequest.project.projectId,
        harnessId: launchRequest.harness.harnessId,
        controllerId: launchRequest.owner.controllerId,
        controllerSessionId: launchRequest.owner.controllerSessionId,
        expectedRevision: request.expectedRevision,
        resultingRevision: launchRequest.revision,
        expiredAt: decidedAt,
        decision: "expired",
        executionOutcome: "not_started",
        outcomeReference: null,
      });
      return decisionFailure(
        "launch_request_materially_changed",
        request,
        launchRequest,
        idempotencyKeyHash,
        false,
        { state, requestFingerprint },
      );
    }

    const resultingRevision = launchRequest.revision + 1;
    const decisionId = `launch-decision-${randomBytes(12).toString("hex")}`;
    const auditId = await options.recordAudit("launch.request.decision", "accepted", {
      authorizationClass,
      idempotencyKeyHash,
      launchRequestId: launchRequest.launchRequestId,
      hostId: launchRequest.host.hostId,
      projectId: launchRequest.project.projectId,
      projectRevision: launchRequest.project.revision,
      harnessId: launchRequest.harness.harnessId,
      harnessPinnedRevision: launchRequest.harness.pinnedRevision,
      controllerId: request.controllerId,
      controllerSessionId: request.controllerSessionId,
      expectedRevision: request.expectedRevision,
      resultingRevision,
      preparedAt: launchRequest.preparedAt,
      expiresAt: launchRequest.expiresAt,
      decidedAt,
      decision: request.decision,
      decisionId,
      dangerousMode: false,
      harnessRunStarted: false,
      executionOutcome: "not_started",
      outcomeReference: null,
    });
    launchRequest.revision = resultingRevision;
    launchRequest.status = request.decision;
    launchRequest.decision = {
      decisionId,
      decision: request.decision,
      decidedAt,
      controllerId: request.controllerId,
      controllerSessionId: request.controllerSessionId,
      expectedRevision: request.expectedRevision,
      auditId,
    };
    const response = {
      type: "launch.request.decision.result",
      requestId: request.requestId,
      code: request.decision === "approved"
        ? "launch_request_approved"
        : "launch_request_rejected",
      authorizationClass,
      idempotencyKeyHash,
      expectedRevision: request.expectedRevision,
      revision: resultingRevision,
      idempotentReplay: false,
      auditId,
      launchRequest: structuredClone(launchRequest),
    };
    state.decisionOutcomes.push({
      idempotencyKeyHash,
      requestFingerprint,
      response,
    });
    await writePrivateJson(statePath(options.dataDir), state);
    return response;
  });

  return { prepare, decide };
};

export const launchRequestInternals = Object.freeze({ statePath });
