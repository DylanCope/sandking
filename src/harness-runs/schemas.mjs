import { randomBytes } from "node:crypto";
import { z } from "zod";
import { identifierSchemas } from "../common/identifiers.mjs";
import { harnessAdapterEntryPointSchema } from "../harness-adapter-protocol.mjs";
import { harnessAdapterIdSchema } from "../harness-adapter-identity.mjs";
import { launchParametersSchema } from "../harness-launch.mjs";
import { productionHarnessPreparationSchema } from "../production-harness-preparation.mjs";

export const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const {
  auditIdSchema,
  harnessIdSchema,
  hostIdSchema,
  projectIdSchema,
  runtimeIdSchema: controllerIdSchema,
} = identifierSchemas(z);
export const harnessRunIdSchema = z.string().regex(/^harness-run-[a-f0-9]{24}$/);
const outcomeIdSchema = z.string().regex(/^harness-outcome-[a-f0-9]{24}$/);
const eventIdSchema = z.string().regex(/^harness-event-[a-f0-9]{24}$/);
const logStreamIdSchema = z.string().regex(/^harness-log-[a-f0-9]{24}$/);
export const controllerSessionIdSchema = z.string()
  .regex(/^controller-session-[a-f0-9]{24}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const runStatusSchema = z.enum([
  "starting",
  "running",
  "cancelling",
  "recovery_required",
  "succeeded",
  "failed",
  "cancelled",
]);
const credentialCapabilityReferenceSchema = z.enum([
  "github.issues.read",
  "project.git.read",
]);
// Cancellation and uncertain recovery can add two universal transitions to
// the prior 1,024 event bound. Preserve the previously valid 1,021 progress
// records while reserving cancellation acceptance, recovery-required, and the
// one truthful terminal event.
export const MAX_RETAINED_RUN_EVENTS = 1_026;
export const MAX_PROGRESS_RECORDS_PER_RUN = MAX_RETAINED_RUN_EVENTS - 5;
export const PROGRESS_PERSIST_BATCH_SIZE = 32;

export const progressRecordSchema = z.object({
  recordId: z.string().regex(/^progress-[a-f0-9]{24}$/),
  schemaVersion: z.literal("1.0.0"),
  type: z.string().min(1).max(128),
  parentRecordId: z.string().regex(/^progress-[a-f0-9]{24}$/).nullable(),
  label: z.string().min(1).max(160),
  summary: z.string().min(1).max(512),
  status: z.string().min(1).max(64),
  timestamp: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
}).strict();

export const harnessRunEventSchema = z.object({
  eventId: eventIdSchema,
  harnessRunId: harnessRunIdSchema,
  sequence: z.number().int().positive(),
  type: z.enum([
    "harness_run_created",
    "harness_adapter_ready",
    "harness_progress_published",
    "harness_run_cancellation_accepted",
    "harness_run_recovery_required",
    "harness_run_succeeded",
    "harness_run_failed",
    "harness_run_cancelled",
  ]),
  recordedAt: z.string().datetime(),
  progressRecord: progressRecordSchema.nullable(),
  outcomeReference: outcomeIdSchema.nullable(),
}).strict();

export const harnessRunOutcomeSchema = z.object({
  outcomeId: outcomeIdSchema,
  status: z.enum(["succeeded", "failed", "cancelled"]),
  code: z.enum([
    "conformance_run_succeeded",
    "conformance_run_failed",
    "conformance_run_cancelled",
    "harness_run_succeeded",
    "harness_run_failed",
    "harness_run_cancelled",
    "harness_result_incomplete",
    "harness_adapter_protocol_invalid",
    "harness_adapter_start_failed",
    "host_daemon_interrupted",
  ]),
  completedAt: z.string().datetime(),
  incompleteResult: z.boolean(),
  result: z.record(z.string(), z.unknown()).nullable(),
  diagnosticReferences: z.array(z.object({
    streamId: logStreamIdSchema,
    producer: z.enum(["stdout", "stderr"]),
    range: z.object({
      start: z.literal(0),
      end: z.number().int().nonnegative(),
    }).strict(),
    explicitRetrievalRequired: z.literal(true),
    insertedIntoControllerConversation: z.literal(false),
  }).strict()).length(2),
  terminalEnvelope: z.object({
    terminalId: z.string().regex(/^harness-terminal-[a-f0-9]{24}$/),
    status: z.enum(["succeeded", "failed", "cancelled"]),
    adapterId: harnessAdapterIdSchema,
    adapterProtocol: z.literal("1.0.0"),
  }).strict().nullable(),
  outcomeAuditId: auditIdSchema.nullable().default(null),
  interruption: z.object({
    code: z.literal("host_daemon_interrupted"),
    previousStatus: z.enum(["starting", "running"]),
    reconciledAt: z.string().datetime(),
    reconciliationAuditId: auditIdSchema,
  }).strict().nullable().default(null),
}).strict();

const terminalEnvelopeValidationSchema = z.object({
  adapterReadyObserved: z.boolean(),
  validTerminalEnvelopeCount: z.number().int().nonnegative(),
  exactlyOne: z.boolean(),
  adapterChannelClosedObserved: z.boolean(),
  processExitObserved: z.boolean(),
}).strict();

const logStreamSchema = z.object({
  streamId: logStreamIdSchema,
  producer: z.enum(["stdout", "stderr"]),
  availableStart: z.literal(0),
  availableEnd: z.number().int().nonnegative(),
  explicitRetrievalRequired: z.literal(true),
  insertedIntoControllerConversation: z.literal(false),
}).strict();

export const harnessRunCancellationSchema = z.object({
  acceptedAt: z.string().datetime(),
  cooperativeDeadlineAt: z.string().datetime(),
  auditId: auditIdSchema,
  idempotencyKeyHash: digestSchema,
  cooperativeSignalSentAt: z.string().datetime().nullable(),
  forcedTerminationSentAt: z.string().datetime().nullable(),
  terminationConfirmedAt: z.string().datetime().nullable(),
}).strict();

export const harnessRunRecoveryActionSchema = z.enum([
  "recheck",
  "terminate_confirmed_tree",
  "finalize",
]);

export const harnessRunRecoveryProcessObservationSchema = z.object({
  schemaVersion: z.literal(1),
  observedAt: z.string().datetime(),
  platform: z.enum(["linux", "win32", "darwin"]),
  terminationEvidence: z.enum(["unconfirmed", "confirmed"]),
  relatedProcessState: z.enum([
    "unknown",
    "running_confirmed",
    "terminated_confirmed",
  ]),
  identityProof: z.enum(["unavailable", "retained_supervision_identity"]),
  terminationScope: z.literal("complete_process_tree"),
  processCount: z.number().int().nonnegative().max(65_536).nullable(),
  launchSettled: z.boolean().nullable(),
  treeEmpty: z.boolean().nullable(),
  safeToTerminate: z.boolean(),
  processIdentifiersExposed: z.literal(false),
  unrestrictedProcessHandleExposed: z.literal(false),
}).strict().superRefine((observation, context) => {
  if (observation.terminationEvidence === "confirmed" && (
    observation.relatedProcessState !== "terminated_confirmed"
    || observation.treeEmpty !== true
    || observation.processCount !== 0
    || observation.safeToTerminate
  )) {
    context.addIssue({ code: "custom", message: "termination proof is inconsistent" });
  }
  if (observation.safeToTerminate && (
    observation.terminationEvidence !== "unconfirmed"
    || observation.relatedProcessState !== "running_confirmed"
    || observation.identityProof !== "retained_supervision_identity"
    || observation.processCount === null
    || observation.processCount < 1
    || observation.launchSettled !== true
    || observation.treeEmpty !== false
  )) {
    context.addIssue({ code: "custom", message: "termination capability is unsafe" });
  }
  if (observation.relatedProcessState === "unknown" && (
    observation.identityProof !== "unavailable"
    || observation.processCount !== null
    || observation.safeToTerminate
  )) {
    context.addIssue({ code: "custom", message: "unknown process state exposes identity" });
  }
});

/** @param {z.infer<typeof harnessRunRecoveryProcessObservationSchema>} observation */
const applicableRecoveryActionsForObservation = (observation) =>
  observation.terminationEvidence === "confirmed"
    ? ["finalize"]
    : observation.safeToTerminate
      ? ["recheck", "terminate_confirmed_tree"]
      : ["recheck"];

export const harnessRunRecoverySchema = z.object({
  code: z.literal("harness_process_termination_unconfirmed"),
  previousStatus: z.enum(["starting", "running", "cancelling"]),
  detectedAt: z.string().datetime(),
  platform: z.enum(["linux", "win32", "darwin"]),
  terminationEvidence: z.enum(["unconfirmed", "confirmed"]),
  reconciliationAuditId: auditIdSchema,
  evidenceSchemaVersion: z.union([z.literal(1), z.literal(2)]),
  initialProcessObservation: harnessRunRecoveryProcessObservationSchema,
  initialAvailableActions: z.array(harnessRunRecoveryActionSchema).min(1).max(2),
  processObservation: harnessRunRecoveryProcessObservationSchema,
  availableActions: z.array(harnessRunRecoveryActionSchema).min(1).max(2),
}).strict().superRefine((recovery, context) => {
  if (
    recovery.initialProcessObservation.terminationEvidence !== "unconfirmed"
    || recovery.initialProcessObservation.platform !== recovery.platform
    || recovery.processObservation.platform !== recovery.platform
    || recovery.processObservation.terminationEvidence !== recovery.terminationEvidence
    || recovery.initialAvailableActions.join("|")
      !== applicableRecoveryActionsForObservation(recovery.initialProcessObservation).join("|")
    || recovery.availableActions.join("|")
      !== applicableRecoveryActionsForObservation(recovery.processObservation).join("|")
  ) {
    context.addIssue({ code: "custom", message: "recovery actions contradict process facts" });
  }
});

export const harnessRunCancellationReconciliationSchema = z.object({
  previousStatus: z.literal("cancelling"),
  reconciledAt: z.string().datetime(),
  platform: z.enum(["linux", "win32", "darwin"]),
  terminationEvidence: z.literal("confirmed"),
  reconciliationAuditId: auditIdSchema,
}).strict();

const baseHarnessRunSchema = z.object({
  harnessRunId: harnessRunIdSchema,
  revision: z.number().int().positive(),
  status: runStatusSchema,
  hostId: hostIdSchema,
  projectId: projectIdSchema,
  harnessId: harnessIdSchema,
  harnessPinnedRevision: commitSchema,
  adapterId: harnessAdapterIdSchema,
  adapterProtocol: z.literal("1.0.0"),
  adapterEntryPoint: harnessAdapterEntryPointSchema,
  parameters: launchParametersSchema,
  source: z.enum(["controller-cli", "cockpit"]),
  controllerId: controllerIdSchema,
  controllerSessionId: controllerSessionIdSchema.nullable(),
  createdAt: z.string().datetime(),
  adapterReadyAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  launchAuditId: auditIdSchema,
}).strict();

export const harnessRunExecutionSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  capture: z.literal("launch"),
  hostId: hostIdSchema,
  projectRegistration: z.object({
    projectId: projectIdSchema,
    revision: z.number().int().positive(),
    displayName: z.string().min(1).max(255),
  }).strict(),
  harness: z.object({
    harnessId: harnessIdSchema,
    revision: z.number().int().positive(),
    name: z.string().min(1).max(120),
    pinnedRevision: commitSchema,
  }).strict(),
  adapter: z.object({
    adapterId: harnessAdapterIdSchema,
    protocol: z.literal("1.0.0"),
    entryPoint: harnessAdapterEntryPointSchema,
  }).strict(),
  parameters: launchParametersSchema,
  source: z.enum(["controller-cli", "cockpit"]),
  attribution: z.object({
    controllerId: controllerIdSchema,
    controllerSessionId: controllerSessionIdSchema.nullable(),
  }).strict(),
  createdAt: z.string().datetime(),
  credentialCapabilityReferences: z.array(credentialCapabilityReferenceSchema)
    .max(8),
  productionHarness: z.object({
    skillSetLockDigest: productionHarnessPreparationSchema.shape.skillSetLockDigest,
    resolvedSkills: productionHarnessPreparationSchema.shape.resolvedSkills,
    executionRuntimeInputs:
      productionHarnessPreparationSchema.shape.executionRuntimeInputs,
    projectionDigest: digestSchema,
  }).strict().nullable().default(null),
  launchAuditId: auditIdSchema,
}).strict();

/**
 * @param {{adapterId: string, adapterProtocol: string}} run
 * @param {{terminalEnvelope?: {adapterId: string, adapterProtocol: string} | null} | null | undefined} outcome
 */
export const harnessRunOutcomeAdapterIdentityAgrees = (run, outcome) =>
  !outcome?.terminalEnvelope
  || (
    outcome.terminalEnvelope.adapterId === run.adapterId
    && outcome.terminalEnvelope.adapterProtocol === run.adapterProtocol
  );

/**
 * Apply the run/outcome adapter invariant to any public composite that carries
 * those two fields. Keeping the refinement here prevents retained, Host, and
 * browser schemas from drifting into different identity rules.
 * @param {{run?: {adapterId: string, adapterProtocol: string} | null, outcome?: {terminalEnvelope?: {adapterId: string, adapterProtocol: string} | null} | null}} composite
 * @param {import("zod").RefinementCtx} context
 */
export const requireHarnessRunOutcomeAdapterIdentityAgreement = (composite, context) => {
  if (
    composite.run
    && !harnessRunOutcomeAdapterIdentityAgrees(composite.run, composite.outcome)
  ) {
    context.addIssue({
      code: "custom",
      message: "Harness run and outcome adapter identities disagree",
      path: ["outcome", "terminalEnvelope"],
    });
  }
};

const currentHarnessRunSchema = baseHarnessRunSchema.extend({
  executionSnapshot: harnessRunExecutionSnapshotSchema,
  cancellation: harnessRunCancellationSchema.nullable(),
  recovery: harnessRunRecoverySchema.nullable().default(null),
  launchIdempotencyKeyHash: digestSchema.nullable().default(null),
}).strict();

/** @param {any} run @param {import("zod").RefinementCtx} context */
const requireConsistentRetainedAdapterIdentity = (run, context) => {
  if (
    run.executionSnapshot.adapter.adapterId !== run.adapterId
    || run.executionSnapshot.adapter.protocol !== run.adapterProtocol
    || run.executionSnapshot.adapter.entryPoint !== run.adapterEntryPoint
  ) {
    context.addIssue({
      code: "custom",
      message: "retained Harness adapter facts disagree",
      path: ["executionSnapshot", "adapter"],
    });
  }
  requireHarnessRunOutcomeAdapterIdentityAgreement({ run, outcome: run.outcome }, context);
};

export const harnessRunSchema = currentHarnessRunSchema
  .superRefine(requireConsistentRetainedAdapterIdentity);

const storedRunFields = {
  events: z.array(harnessRunEventSchema).max(MAX_RETAINED_RUN_EVENTS),
  outcome: harnessRunOutcomeSchema.nullable(),
  terminalEnvelopeValidation: terminalEnvelopeValidationSchema,
  logStreams: z.tuple([logStreamSchema, logStreamSchema]),
  cancellationReconciliation: harnessRunCancellationReconciliationSchema
    .nullable().default(null),
};
const currentStoredRunSchema = currentHarnessRunSchema.extend(storedRunFields).strict();
export const storedRunSchema = currentStoredRunSchema
  .superRefine(requireConsistentRetainedAdapterIdentity);
export const retainedOutcomeSchema = z.object({
  idempotencyKeyHash: digestSchema,
  requestFingerprint: digestSchema,
  response: z.object({}).passthrough(),
}).strict();
export const retainedRecoveryMutationSchema = z.object({
  idempotencyKeyHash: digestSchema,
  requestFingerprint: digestSchema,
  harnessRunId: harnessRunIdSchema.nullable(),
  action: harnessRunRecoveryActionSchema.nullable(),
  acceptedAt: z.string().datetime(),
  auditId: auditIdSchema,
  response: z.object({}).passthrough().nullable(),
}).strict();
export const stateSchema = z.object({
  schemaVersion: z.literal(8),
  // Canonical runs and keyed mutation outcomes cannot be evicted without
  // breaking reconnect and ambiguous-outcome lookup. Retention/cleanup is a
  // later explicit workflow; the records themselves remain schema-bounded.
  runs: z.array(storedRunSchema),
  launchOutcomes: z.array(retainedOutcomeSchema),
  cancellationOutcomes: z.array(retainedOutcomeSchema),
  recoveryMutations: z.array(retainedRecoveryMutationSchema),
}).strict();

export const initialState = () => ({
  schemaVersion: 8,
  runs: [],
  launchOutcomes: [],
  cancellationOutcomes: [],
  recoveryMutations: [],
});

/** @param {z.infer<typeof storedRunSchema>} run */
export const publicRun = (run) => harnessRunSchema.parse({
  harnessRunId: run.harnessRunId,
  revision: run.revision,
  status: run.status,
  hostId: run.hostId,
  projectId: run.projectId,
  harnessId: run.harnessId,
  harnessPinnedRevision: run.harnessPinnedRevision,
  adapterId: run.adapterId,
  adapterProtocol: run.adapterProtocol,
  adapterEntryPoint: run.adapterEntryPoint,
  controllerId: run.controllerId,
  controllerSessionId: run.controllerSessionId,
  createdAt: run.createdAt,
  adapterReadyAt: run.adapterReadyAt,
  completedAt: run.completedAt,
  executionSnapshot: structuredClone(run.executionSnapshot),
  cancellation: structuredClone(run.cancellation),
  recovery: structuredClone(run.recovery),
  parameters: structuredClone(run.parameters),
  source: run.source,
  launchAuditId: run.launchAuditId,
  launchIdempotencyKeyHash: run.launchIdempotencyKeyHash,
});

/**
 * @param {z.infer<typeof storedRunSchema>} run
 * @param {z.infer<typeof harnessRunEventSchema>["type"]} type
 * @param {{progressRecord?: z.infer<typeof progressRecordSchema> | null, outcomeReference?: string | null}} [details]
 */
export const appendEvent = (run, type, details = {}) => {
  if (run.events.length >= MAX_RETAINED_RUN_EVENTS) {
    throw new Error("harness_run_event_capacity_exceeded");
  }
  run.events.push(harnessRunEventSchema.parse({
    eventId: `harness-event-${randomBytes(12).toString("hex")}`,
    harnessRunId: run.harnessRunId,
    sequence: run.events.length + 1,
    type,
    recordedAt: new Date().toISOString(),
    progressRecord: details.progressRecord ?? null,
    outcomeReference: details.outcomeReference ?? null,
  }));
};

/** @param {z.infer<typeof storedRunSchema>} run */
export const adapterReadinessWasDurablyObserved = (run) =>
  run.terminalEnvelopeValidation.adapterReadyObserved
  || run.adapterReadyAt !== null
  || run.events.some((event) => event.type === "harness_adapter_ready");

/** @param {unknown} value */
export const optionalBoolean = (value) => typeof value === "boolean" ? value : null;

/**
 * Reduce platform inspection data to the only process facts that may cross a
 * public recovery boundary. Numeric identities, handles, commands, and
 * environment data are deliberately not representable by this projection.
 *
 * @param {any} inspection
 * @param {string} observedAt
 * @param {boolean} [terminationAvailable]
 */
export const recoveryProcessObservation = (
  inspection,
  observedAt,
  terminationAvailable = false,
) => {
  const platform = z.enum(["linux", "win32", "darwin"]).parse(inspection?.platform);
  if (inspection?.status === "confirmed") {
    return harnessRunRecoveryProcessObservationSchema.parse({
      schemaVersion: 1,
      observedAt,
      platform,
      terminationEvidence: "confirmed",
      relatedProcessState: "terminated_confirmed",
      identityProof: inspection?.identityProof === "retained_supervision_identity"
        ? "retained_supervision_identity"
        : "unavailable",
      terminationScope: "complete_process_tree",
      processCount: 0,
      launchSettled: optionalBoolean(inspection?.launchSettled) ?? true,
      treeEmpty: true,
      safeToTerminate: false,
      processIdentifiersExposed: false,
      unrestrictedProcessHandleExposed: false,
    });
  }
  const processCount = Number.isSafeInteger(inspection?.processCount)
    && inspection.processCount > 0
    && inspection.processCount <= 65_536
    ? inspection.processCount
    : null;
  const safeToTerminate = inspection?.relatedProcessState === "running_confirmed"
    && inspection?.identityProof === "retained_supervision_identity"
    && inspection?.safeToTerminate === true
    && terminationAvailable
    && inspection?.launchSettled === true
    && inspection?.treeEmpty === false
    && processCount !== null;
  return harnessRunRecoveryProcessObservationSchema.parse({
    schemaVersion: 1,
    observedAt,
    platform,
    terminationEvidence: "unconfirmed",
    relatedProcessState: safeToTerminate ? "running_confirmed" : "unknown",
    identityProof: safeToTerminate ? "retained_supervision_identity" : "unavailable",
    terminationScope: "complete_process_tree",
    processCount: safeToTerminate ? processCount : null,
    launchSettled: optionalBoolean(inspection?.launchSettled),
    treeEmpty: optionalBoolean(inspection?.treeEmpty),
    safeToTerminate,
    processIdentifiersExposed: false,
    unrestrictedProcessHandleExposed: false,
  });
};

/** @param {z.infer<typeof harnessRunRecoveryProcessObservationSchema>} observation */
export const availableRecoveryActions = (observation) =>
  applicableRecoveryActionsForObservation(observation);
