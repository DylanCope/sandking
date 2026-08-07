import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { readJson, writePrivateJson } from "./private-state.mjs";

export const builtInPlanningStages = Object.freeze([
  "wayfinding",
  "speccing",
  "ticketing",
]);

export const planningAdapter = Object.freeze({
  adapterId: "github-conformance-fixture-v1",
  authority: "github",
  fixture: true,
  label: "Conformance fixture data — not live GitHub",
});

export const excludedPlanningCapabilities = Object.freeze([
  "skill-owned-reasoning",
  "private-specifications",
  "ticket-set-publication",
  "complete-optional-or-out-of-order-planning",
  "downstream-needs-review",
]);

const identifierSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9._:-]+$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const workContextSchema = z.object({
  workContextId: identifierSchema,
  kind: z.literal("planning-stage"),
  canonicalReference: z.string().regex(/^github:fixture:issue:[0-9]+$/),
}).strict();
const stageMutationSchema = z.object({
  enabled: z.boolean(),
  disabledReason: identifierSchema.nullable(),
}).strict();
const stageSchema = z.object({
  stageId: z.enum(["wayfinding", "speccing", "ticketing"]),
  label: z.enum(["Wayfinding", "Speccing", "Ticketing"]),
  status: z.enum(["Not started", "In progress", "Complete", "Not used"]),
  optional: z.boolean(),
  revision: z.number().int().positive(),
  artifact: z.object({
    kind: z.literal("github-issue"),
    reference: z.string().regex(/^github:fixture:issue:[0-9]+$/),
    title: z.string().min(1).max(200),
  }).strict(),
  workContext: workContextSchema,
  mutation: stageMutationSchema,
}).strict();
const journeyProjectionSchema = z.object({
  projectionId: identifierSchema,
  sourceFixtureId: identifierSchema,
  projectionDigest: digestSchema,
  freshness: z.enum(["fresh", "stale"]),
  mutationsEnabled: z.boolean(),
  refreshFailure: z.object({
    code: z.literal("github_projection_unavailable"),
    retryable: z.literal(true),
  }).strict().nullable(),
}).strict();
const journeySchema = z.object({
  journeyId: identifierSchema,
  title: z.string().min(1).max(200),
  projection: journeyProjectionSchema,
  ordinaryWork: z.object({
    status: z.literal("available"),
    blocked: z.literal(false),
  }).strict(),
  stages: z.array(stageSchema).length(3),
}).strict();

export const planningProjectionSchema = z.object({
  kind: z.literal("cockpit.planning-spine"),
  adapter: z.object({
    adapterId: z.literal("github-conformance-fixture-v1"),
    authority: z.literal("github"),
    fixture: z.literal(true),
    label: z.literal("Conformance fixture data — not live GitHub"),
  }).strict(),
  builtInStages: z.tuple([
    z.literal("wayfinding"),
    z.literal("speccing"),
    z.literal("ticketing"),
  ]),
  excludedCapabilities: z.tuple([
    z.literal("skill-owned-reasoning"),
    z.literal("private-specifications"),
    z.literal("ticket-set-publication"),
    z.literal("complete-optional-or-out-of-order-planning"),
    z.literal("downstream-needs-review"),
  ]),
  journeys: z.array(journeySchema).length(2),
}).strict();

/** @param {unknown} value */
const digestFixture = (value) => `sha256:${createHash("sha256")
  .update(JSON.stringify(value))
  .digest("hex")}`;

/**
 * @param {"wayfinding" | "speccing" | "ticketing"} stageId
 * @param {"Wayfinding" | "Speccing" | "Ticketing"} label
 * @param {"Not started" | "In progress" | "Complete" | "Not used"} status
 * @param {number} issue
 * @param {string} journeySuffix
 * @param {boolean} mutationsEnabled
 */
const stage = (stageId, label, status, issue, journeySuffix, mutationsEnabled) => ({
  stageId,
  label,
  status,
  optional: true,
  revision: 1,
  artifact: {
    kind: "github-issue",
    reference: `github:fixture:issue:${issue}`,
    title: `${label} conformance artifact`,
  },
  workContext: {
    workContextId: `work-context-${stageId}-${journeySuffix}`,
    kind: "planning-stage",
    canonicalReference: `github:fixture:issue:${issue}`,
  },
  mutation: {
    enabled: mutationsEnabled,
    disabledReason: mutationsEnabled ? null : "github_projection_unavailable",
  },
});

const initialProjection = () => {
  const freshStages = [
    stage("wayfinding", "Wayfinding", "Complete", 18, "optional-planning", true),
    stage("speccing", "Speccing", "In progress", 116, "optional-planning", true),
    stage("ticketing", "Ticketing", "Not started", 125, "optional-planning", true),
  ];
  const staleStages = [
    stage("wayfinding", "Wayfinding", "Complete", 201, "unrefreshable", false),
    stage("speccing", "Speccing", "In progress", 202, "unrefreshable", false),
    stage("ticketing", "Ticketing", "Not started", 203, "unrefreshable", false),
  ];
  return planningProjectionSchema.parse({
    kind: "cockpit.planning-spine",
    adapter: planningAdapter,
    builtInStages: builtInPlanningStages,
    excludedCapabilities: excludedPlanningCapabilities,
    journeys: [
      {
        journeyId: "journey-fixture-optional-planning",
        title: "Optional Planning journey",
        projection: {
          projectionId: "projection-fixture-optional-planning-v1",
          sourceFixtureId: "github-fixture-optional-planning-v1",
          projectionDigest: digestFixture(freshStages),
          freshness: "fresh",
          mutationsEnabled: true,
          refreshFailure: null,
        },
        ordinaryWork: { status: "available", blocked: false },
        stages: freshStages,
      },
      {
        journeyId: "journey-fixture-unrefreshable",
        title: "Unavailable GitHub projection",
        projection: {
          projectionId: "projection-fixture-unrefreshable-v1",
          sourceFixtureId: "github-fixture-unrefreshable-v1",
          projectionDigest: digestFixture(staleStages),
          freshness: "stale",
          mutationsEnabled: false,
          refreshFailure: {
            code: "github_projection_unavailable",
            retryable: true,
          },
        },
        ordinaryWork: { status: "available", blocked: false },
        stages: staleStages,
      },
    ],
  });
};

const prohibitedSideEffectsSchema = z.object({
  githubWrite: z.literal(false),
  queuedWrite: z.literal(false),
  skillInvocation: z.literal(false),
  projectFileWrite: z.literal(false),
}).strict();
const focusedSessionSchema = z.object({
  sessionId: z.string().regex(/^controller-session-[a-f0-9]{24}$/),
  focused: z.literal(true),
  provider: z.object({
    providerId: z.literal("conformance-controller-v1"),
    kind: z.literal("conformance"),
    fixture: z.literal(true),
    adapterId: z.literal("conformance-controller-adapter-v1"),
    adapterProtocol: z.string().regex(/^1\.[0-9]+\.[0-9]+$/),
    capabilities: z.array(z.enum([
      "controller.session.start",
      "controller.session.interactive",
      "controller.session.terminate",
      "controller.work-context.inspect",
      "controller.harness-run.launch",
      "controller.harness-run.cancel",
    ])).min(3).max(6),
    providerSessionId: z.string()
      .regex(/^conformance-provider-session-[a-f0-9]{24}$/),
    readiness: z.object({
      controlProtocol: z.literal("1.0.0"),
      signal: z.literal("provider.session.ready"),
      providerObservedTty: z.literal(true),
    }).strict(),
  }).strict(),
  terminal: z.object({
    streamId: z.string().regex(/^controller-terminal-[a-f0-9]{24}$/),
    kind: z.literal("pty"),
    runtimeOwned: z.literal(true),
    state: z.literal("running"),
    writableAttachment: z.object({
      attachmentId: z.string().regex(/^terminal-attachment-[a-f0-9]{24}$/),
      mode: z.literal("exclusive"),
    }).strict(),
  }).strict(),
  workContext: workContextSchema,
}).strict();
const focusedSessionResultSchema = z.object({
  type: z.literal("mutation_result"),
  code: z.literal("focused_controller_session_opened"),
  authorizationClass: z.literal("planning_focused_session"),
  expectedRevision: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  idempotentReplay: z.literal(false),
  auditId: z.string().regex(/^audit-[a-f0-9]{24}$/),
  session: focusedSessionSchema,
  prohibitedSideEffects: prohibitedSideEffectsSchema,
}).strict();
const notUsedResultSchema = z.object({
  type: z.literal("mutation_result"),
  code: z.literal("planning_stage_not_used"),
  authorizationClass: z.literal("planning_stage_status"),
  expectedRevision: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  idempotentReplay: z.literal(false),
  auditId: z.string().regex(/^audit-[a-f0-9]{24}$/),
  journeyId: identifierSchema,
  stage: z.object({
    stageId: z.enum(["wayfinding", "speccing", "ticketing"]),
    status: z.literal("Not used"),
    revision: z.number().int().positive(),
  }).strict(),
  ordinaryWorkBlocked: z.literal(false),
  prohibitedSideEffects: prohibitedSideEffectsSchema,
}).strict();
/** @param {z.ZodType} responseSchema */
const outcomeRecord = (responseSchema) => z.object({
  idempotencyKeyHash: digestSchema,
  requestFingerprint: digestSchema,
  response: responseSchema,
}).strict();
const planningStateSchema = z.object({
  schemaVersion: z.literal(2),
  sessionRevisions: z.record(identifierSchema, z.number().int().positive()),
  sessions: z.array(focusedSessionSchema).max(128),
  sessionOutcomes: z.array(outcomeRecord(focusedSessionResultSchema)).max(128),
  stageOverrides: z.record(identifierSchema, z.object({
    status: z.literal("Not used"),
    revision: z.number().int().positive(),
  }).strict()),
  stageOutcomes: z.array(outcomeRecord(notUsedResultSchema)).max(128),
}).strict();

/** @typedef {z.infer<typeof planningStateSchema>} PlanningState */

/** @param {string} dataDir */
const planningStatePath = (dataDir) => join(dataDir, "planning-state.json");
/** @returns {PlanningState} */
const initialState = () => ({
  schemaVersion: 2,
  sessionRevisions: {},
  sessions: [],
  sessionOutcomes: [],
  stageOverrides: {},
  stageOutcomes: [],
});

/** @param {string} dataDir */
const readState = async (dataDir) => {
  const raw = await readJson(planningStatePath(dataDir), initialState());
  if (raw && typeof raw === "object" && "schemaVersion" in raw && raw.schemaVersion === 1) {
    const legacy = z.object({
      schemaVersion: z.literal(1),
      stageOverrides: planningStateSchema.shape.stageOverrides,
      stageOutcomes: planningStateSchema.shape.stageOutcomes,
    }).passthrough().safeParse(raw);
    if (!legacy.success) {
      throw new Error("planning_state_invalid");
    }
    const migrated = {
      ...initialState(),
      stageOverrides: legacy.data.stageOverrides,
      stageOutcomes: legacy.data.stageOutcomes,
    };
    await writePrivateJson(planningStatePath(dataDir), migrated);
    return planningStateSchema.parse(migrated);
  }
  const parsed = planningStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("planning_state_invalid");
  }
  return parsed.data;
};

const prohibitedSideEffects = () => ({
  githubWrite: false,
  queuedWrite: false,
  skillInvocation: false,
  projectFileWrite: false,
});

/** @param {unknown} value */
const requestFingerprint = (value) => digestFixture(value);

/** @param {ReturnType<typeof initialProjection>} projection @param {string} workContextId */
const findWorkContext = (projection, workContextId) => {
  for (const journey of projection.journeys) {
    const matchingStage = journey.stages.find((candidate) =>
      candidate.workContext.workContextId === workContextId);
    if (matchingStage) {
      return { journey, stage: matchingStage, workContext: matchingStage.workContext };
    }
  }
  return null;
};

/**
 * @param {ReturnType<typeof initialProjection>} projection
 * @param {string} journeyId
 * @param {string} stageId
 */
const findStage = (projection, journeyId, stageId) => {
  const journey = projection.journeys.find((candidate) =>
    candidate.journeyId === journeyId);
  const matchingStage = journey?.stages.find((candidate) => candidate.stageId === stageId);
  return journey && matchingStage ? { journey, stage: matchingStage } : null;
};

/**
 * @param {string} code
 * @param {string} authorizationClass
 * @param {number} expectedRevision
 * @param {number} actualRevision
 * @param {string} auditId
 * @param {boolean} retryable
 */
const planningFailure = (
  code,
  authorizationClass,
  expectedRevision,
  actualRevision,
  auditId,
  retryable,
) => ({
  type: "mutation_failure",
  code,
  retryable,
  authorizationClass,
  expectedRevision,
  actualRevision,
  auditId,
  prohibitedSideEffects: prohibitedSideEffects(),
});

/**
 * @param {{
 *   dataDir: string,
 *   recordAudit: (action: string, outcome: "accepted" | "rejected" | "observed", details?: Record<string, unknown>) => Promise<string>,
 *   startControllerSession?: (workContext: z.infer<typeof workContextSchema>) => Promise<unknown>,
 *   terminateControllerSession?: (sessionId: string) => Promise<void>,
 * }} options
 */
export const createPlanningSpine = async (options) => {
  const fixtureProjection = initialProjection();
  let mutationQueue = Promise.resolve();

  /** @template T @param {() => Promise<T>} operation */
  const withMutationLock = async (operation) => {
    const current = mutationQueue.catch(() => undefined).then(operation);
    mutationQueue = current.then(() => undefined, () => undefined);
    return current;
  };

  /**
   * @param {{authorizationAccepted: boolean, idempotencyKeyHash: string | null, expectedRevision: number, workContextId: string}} request
   */
  const openFocusedSession = async (request) => withMutationLock(async () => {
    const authorizationClass = "planning_focused_session";
    const action = "planning.session.open";
    const state = await readState(options.dataDir);
    const workContextMatch = typeof request.workContextId === "string"
      ? findWorkContext(fixtureProjection, request.workContextId)
      : null;
    const actualRevision = Number.isSafeInteger(
      state.sessionRevisions[request.workContextId],
    ) ? state.sessionRevisions[request.workContextId] : 0;
    const auditBase = {
      authorizationClass,
      idempotencyKeyHash: request.idempotencyKeyHash,
      expectedRevision: Number.isSafeInteger(request.expectedRevision)
        ? request.expectedRevision
        : null,
      actualRevision,
      workContextId: typeof request.workContextId === "string"
        ? request.workContextId
        : null,
      ...prohibitedSideEffects(),
    };

    if (!request.authorizationAccepted) {
      const auditId = await options.recordAudit(action, "rejected", {
        ...auditBase,
        code: "authorization_failed",
      });
      return {
        status: 403,
        body: planningFailure(
          "authorization_failed",
          authorizationClass,
          Number.isSafeInteger(request.expectedRevision) ? request.expectedRevision : -1,
          actualRevision,
          auditId,
          false,
        ),
      };
    }
    if (
      !request.idempotencyKeyHash
      || !/^sha256:[a-f0-9]{64}$/.test(request.idempotencyKeyHash)
      || !Number.isSafeInteger(request.expectedRevision)
      || request.expectedRevision < 0
      || !workContextMatch
    ) {
      const code = workContextMatch ? "mutation_contract_invalid" : "work_context_not_found";
      const auditId = await options.recordAudit(action, "rejected", { ...auditBase, code });
      return {
        status: workContextMatch ? 400 : 404,
        body: planningFailure(
          code,
          authorizationClass,
          Number.isSafeInteger(request.expectedRevision) ? request.expectedRevision : -1,
          actualRevision,
          auditId,
          false,
        ),
      };
    }

    const fingerprint = requestFingerprint({
      expectedRevision: request.expectedRevision,
      workContextId: request.workContextId,
    });
    const existing = state.sessionOutcomes.find((outcome) =>
      outcome.idempotencyKeyHash === request.idempotencyKeyHash);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        const auditId = await options.recordAudit(action, "rejected", {
          ...auditBase,
          code: "idempotency_key_conflict",
        });
        return {
          status: 409,
          body: planningFailure(
            "idempotency_key_conflict",
            authorizationClass,
            request.expectedRevision,
            actualRevision,
            auditId,
            false,
          ),
        };
      }
      await options.recordAudit(action, "observed", {
        ...auditBase,
        idempotentReplay: true,
        originalAuditId: existing.response.auditId,
      });
      return {
        status: 200,
        body: { ...structuredClone(existing.response), idempotentReplay: true },
      };
    }
    if (
      workContextMatch.journey.projection.freshness !== "fresh"
      || !workContextMatch.journey.projection.mutationsEnabled
    ) {
      const auditId = await options.recordAudit(action, "rejected", {
        ...auditBase,
        code: "projection_stale",
        refreshFailure: workContextMatch.journey.projection.refreshFailure?.code ?? null,
      });
      return {
        status: 409,
        body: planningFailure(
          "projection_stale",
          authorizationClass,
          request.expectedRevision,
          actualRevision,
          auditId,
          true,
        ),
      };
    }
    if (request.expectedRevision !== actualRevision) {
      const auditId = await options.recordAudit(action, "rejected", {
        ...auditBase,
        code: "mutation_revision_conflict",
      });
      return {
        status: 409,
        body: planningFailure(
          "mutation_revision_conflict",
          authorizationClass,
          request.expectedRevision,
          actualRevision,
          auditId,
          true,
        ),
      };
    }

    let session;
    try {
      if (!options.startControllerSession) {
        throw new Error("controller_session_runtime_unavailable");
      }
      session = focusedSessionSchema.parse(
        await options.startControllerSession(structuredClone(workContextMatch.workContext)),
      );
    } catch (error) {
      const auditId = await options.recordAudit(action, "rejected", {
        ...auditBase,
        code: "controller_session_start_failed",
        providerFailureCode: error instanceof Error
          && /^[a-z0-9_]+$/.test(error.message)
          ? error.message
          : "controller_session_start_failed",
      });
      return {
        status: 503,
        body: planningFailure(
          "controller_session_start_failed",
          authorizationClass,
          request.expectedRevision,
          actualRevision,
          auditId,
          true,
        ),
      };
    }

    try {
      const resultingRevision = actualRevision + 1;
      const auditId = await options.recordAudit(action, "accepted", {
        ...auditBase,
        resultingRevision,
        sessionId: session.sessionId,
        providerSessionId: session.provider.providerSessionId,
        providerAdapterId: session.provider.adapterId,
        providerControlProtocol: session.provider.readiness.controlProtocol,
        providerReadySignal: session.provider.readiness.signal,
        providerObservedTty: session.provider.readiness.providerObservedTty,
        streamId: session.terminal.streamId,
        ptyRuntimeOwned: session.terminal.runtimeOwned,
      });
      const response = focusedSessionResultSchema.parse({
        type: "mutation_result",
        code: "focused_controller_session_opened",
        authorizationClass,
        expectedRevision: request.expectedRevision,
        revision: resultingRevision,
        idempotentReplay: false,
        auditId,
        session,
        prohibitedSideEffects: prohibitedSideEffects(),
      });
      state.sessionRevisions[request.workContextId] = resultingRevision;
      state.sessions.push(session);
      state.sessionOutcomes.push({
        idempotencyKeyHash: request.idempotencyKeyHash,
        requestFingerprint: fingerprint,
        response,
      });
      state.sessions = state.sessions.slice(-128);
      state.sessionOutcomes = state.sessionOutcomes.slice(-128);
      await writePrivateJson(planningStatePath(options.dataDir), state);
      return { status: 201, body: response };
    } catch (error) {
      await options.terminateControllerSession?.(session.sessionId).catch(() => undefined);
      throw error;
    }
  });

  /**
   * @param {{authorizationAccepted: boolean, idempotencyKeyHash: string | null, expectedRevision: number, journeyId: string, stageId: string}} request
   */
  const markStageNotUsed = async (request) => withMutationLock(async () => {
    const authorizationClass = "planning_stage_status";
    const action = "planning.stage.not-used";
    const state = await readState(options.dataDir);
    const target = typeof request.journeyId === "string" && typeof request.stageId === "string"
      ? findStage(fixtureProjection, request.journeyId, request.stageId)
      : null;
    const stageKey = `${request.journeyId}:${request.stageId}`;
    const override = state.stageOverrides[stageKey];
    const actualRevision = Number.isSafeInteger(override?.revision)
      ? Number(override.revision)
      : target?.stage.revision ?? 0;
    const auditBase = {
      authorizationClass,
      idempotencyKeyHash: request.idempotencyKeyHash,
      expectedRevision: Number.isSafeInteger(request.expectedRevision)
        ? request.expectedRevision
        : null,
      actualRevision,
      journeyId: typeof request.journeyId === "string" ? request.journeyId : null,
      stageId: typeof request.stageId === "string" ? request.stageId : null,
      ...prohibitedSideEffects(),
    };

    if (!request.authorizationAccepted) {
      const auditId = await options.recordAudit(action, "rejected", {
        ...auditBase,
        code: "authorization_failed",
      });
      return {
        status: 403,
        body: planningFailure(
          "authorization_failed",
          authorizationClass,
          Number.isSafeInteger(request.expectedRevision) ? request.expectedRevision : -1,
          actualRevision,
          auditId,
          false,
        ),
      };
    }
    if (
      !request.idempotencyKeyHash
      || !/^sha256:[a-f0-9]{64}$/.test(request.idempotencyKeyHash)
      || !Number.isSafeInteger(request.expectedRevision)
      || request.expectedRevision < 0
      || !target
    ) {
      const code = target ? "mutation_contract_invalid" : "planning_stage_not_found";
      const auditId = await options.recordAudit(action, "rejected", { ...auditBase, code });
      return {
        status: target ? 400 : 404,
        body: planningFailure(
          code,
          authorizationClass,
          Number.isSafeInteger(request.expectedRevision) ? request.expectedRevision : -1,
          actualRevision,
          auditId,
          false,
        ),
      };
    }

    const fingerprint = requestFingerprint({
      expectedRevision: request.expectedRevision,
      journeyId: request.journeyId,
      stageId: request.stageId,
    });
    const existing = state.stageOutcomes.find((outcome) =>
      outcome.idempotencyKeyHash === request.idempotencyKeyHash);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        const auditId = await options.recordAudit(action, "rejected", {
          ...auditBase,
          code: "idempotency_key_conflict",
        });
        return {
          status: 409,
          body: planningFailure(
            "idempotency_key_conflict",
            authorizationClass,
            request.expectedRevision,
            actualRevision,
            auditId,
            false,
          ),
        };
      }
      await options.recordAudit(action, "observed", {
        ...auditBase,
        idempotentReplay: true,
        originalAuditId: existing.response.auditId,
      });
      return {
        status: 200,
        body: { ...structuredClone(existing.response), idempotentReplay: true },
      };
    }
    if (
      target.journey.projection.freshness !== "fresh"
      || !target.journey.projection.mutationsEnabled
    ) {
      const auditId = await options.recordAudit(action, "rejected", {
        ...auditBase,
        code: "projection_stale",
        refreshFailure: target.journey.projection.refreshFailure?.code ?? null,
      });
      return {
        status: 409,
        body: planningFailure(
          "projection_stale",
          authorizationClass,
          request.expectedRevision,
          actualRevision,
          auditId,
          true,
        ),
      };
    }
    if (request.expectedRevision !== actualRevision) {
      const auditId = await options.recordAudit(action, "rejected", {
        ...auditBase,
        code: "mutation_revision_conflict",
      });
      return {
        status: 409,
        body: planningFailure(
          "mutation_revision_conflict",
          authorizationClass,
          request.expectedRevision,
          actualRevision,
          auditId,
          true,
        ),
      };
    }
    if (!target.stage.optional || override?.status === "Not used") {
      const code = target.stage.optional ? "stage_already_not_used" : "stage_not_optional";
      const auditId = await options.recordAudit(action, "rejected", { ...auditBase, code });
      return {
        status: 409,
        body: planningFailure(
          code,
          authorizationClass,
          request.expectedRevision,
          actualRevision,
          auditId,
          false,
        ),
      };
    }

    const resultingRevision = actualRevision + 1;
    const auditId = await options.recordAudit(action, "accepted", {
      ...auditBase,
      resultingRevision,
      fixtureProjectionWrite: true,
    });
    const response = notUsedResultSchema.parse({
      type: "mutation_result",
      code: "planning_stage_not_used",
      authorizationClass,
      expectedRevision: request.expectedRevision,
      revision: resultingRevision,
      idempotentReplay: false,
      auditId,
      journeyId: request.journeyId,
      stage: {
        stageId: request.stageId,
        status: "Not used",
        revision: resultingRevision,
      },
      ordinaryWorkBlocked: false,
      prohibitedSideEffects: prohibitedSideEffects(),
    });
    state.stageOverrides[stageKey] = { status: "Not used", revision: resultingRevision };
    state.stageOutcomes.push({
      idempotencyKeyHash: request.idempotencyKeyHash,
      requestFingerprint: fingerprint,
      response,
    });
    state.stageOutcomes = state.stageOutcomes.slice(-128);
    await writePrivateJson(planningStatePath(options.dataDir), state);
    return { status: 200, body: response };
  });

  const project = async () => {
    const projection = structuredClone(fixtureProjection);
    const state = await readState(options.dataDir);
    for (const journey of projection.journeys) {
      for (const projectedStage of journey.stages) {
        const override = state.stageOverrides[`${journey.journeyId}:${projectedStage.stageId}`];
        if (override?.status === "Not used" && Number.isSafeInteger(override.revision)) {
          projectedStage.status = "Not used";
          projectedStage.revision = Number(override.revision);
          projectedStage.mutation = {
            enabled: false,
            disabledReason: "stage_already_not_used",
          };
        }
      }
      journey.projection.projectionDigest = digestFixture(journey.stages);
    }
    return planningProjectionSchema.parse(projection);
  };

  return {
    project,
    openFocusedSession,
    markStageNotUsed,
  };
};
