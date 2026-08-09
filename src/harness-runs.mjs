import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  HarnessAdapterProtocolError,
  harnessAdapterEntryPointSchema,
  harnessTerminalEnvelopeSchema,
  loadPinnedHarnessAdapter,
  readHarnessAdapterFrame,
} from "./harness-adapter-protocol.mjs";
import { sendHarnessCancellationRequest } from "./harness-process-control.mjs";
import {
  launchParametersSchema,
  validateConformanceHarnessLaunch,
} from "./harness-launch.mjs";
import {
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
  readJson,
  writePrivateJson,
} from "./private-state.mjs";
import { spawnPosixProcessTree } from "./posix-process-tree.mjs";
import {
  captureWindowsProcessTreeSnapshot,
  createNativeWindowsJobObject,
  createWindowsProcessTreeTracker,
} from "./windows-process-tree.mjs";

const windowsProcessBarrierPath = fileURLToPath(
  new URL("./windows-process-barrier.cjs", import.meta.url),
);

/** @param {string} markerPath @param {"assigned" | "aborted"} decision */
const publishWindowsProcessBarrierDecision = async (markerPath, decision) => {
  const candidatePath = `${markerPath}.${decision}`;
  await writeFile(candidatePath, `${decision}\n`, { mode: 0o600 });
  await rename(candidatePath, markerPath);
};

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const auditIdSchema = z.string().regex(/^audit-[a-f0-9]{24}$/);
const hostIdSchema = z.string().regex(/^host-[a-f0-9]{24}$/);
const projectIdSchema = z.string().regex(/^project-[a-f0-9]{24}$/);
const harnessIdSchema = z.string().regex(/^harness-[a-f0-9]{24}$/);
const legacyLaunchRequestIdSchema = z.string().regex(/^launch-request-[a-f0-9]{24}$/);
const harnessRunIdSchema = z.string().regex(/^harness-run-[a-f0-9]{24}$/);
const outcomeIdSchema = z.string().regex(/^harness-outcome-[a-f0-9]{24}$/);
const eventIdSchema = z.string().regex(/^harness-event-[a-f0-9]{24}$/);
const logStreamIdSchema = z.string().regex(/^harness-log-[a-f0-9]{24}$/);
const controllerIdSchema = z.string().regex(/^runtime-[a-f0-9]{24}$/);
const controllerSessionIdSchema = z.string().regex(/^controller-session-[a-f0-9]{24}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const runStatusSchema = z.enum([
  "starting",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
]);
const credentialCapabilityReferenceSchema = z.enum([
  "github.issues.read",
  "project.git.read",
]);
// Cancellation adds one universal lifecycle transition to the prior 1,024
// event bound. Preserve the previously valid 1,021 progress records while
// reserving both cancellation acceptance and the one truthful terminal event.
const MAX_RETAINED_RUN_EVENTS = 1_025;
const MAX_PROGRESS_RECORDS_PER_RUN = MAX_RETAINED_RUN_EVENTS - 4;
const PROGRESS_PERSIST_BATCH_SIZE = 32;

const progressRecordSchema = z.object({
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
    adapterId: z.literal("conformance-harness-adapter-v1"),
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

const previousHarnessRunSchema = z.object({
  harnessRunId: harnessRunIdSchema,
  revision: z.number().int().positive(),
  status: runStatusSchema,
  hostId: hostIdSchema,
  projectId: projectIdSchema,
  harnessId: harnessIdSchema,
  harnessPinnedRevision: commitSchema,
  adapterId: z.literal("conformance-harness-adapter-v1"),
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

// Schema v1 runs are durable execution history. Keep their exact public shape
// readable after the launch-request command path is retired instead of
// inventing parameters or an invocation source that v1 did not retain.
const previousLegacyHarnessRunSchema = z.object({
  harnessRunId: harnessRunIdSchema,
  revision: z.number().int().positive(),
  status: runStatusSchema,
  launchRequestId: legacyLaunchRequestIdSchema,
  launchRequestRevision: z.number().int().positive(),
  hostId: hostIdSchema,
  projectId: projectIdSchema,
  harnessId: harnessIdSchema,
  harnessPinnedRevision: commitSchema,
  adapterId: z.literal("conformance-harness-adapter-v1"),
  adapterProtocol: z.literal("1.0.0"),
  adapterEntryPoint: harnessAdapterEntryPointSchema,
  controllerId: controllerIdSchema,
  controllerSessionId: controllerSessionIdSchema,
  createdAt: z.string().datetime(),
  adapterReadyAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  startAuditId: auditIdSchema,
}).strict();

export const harnessRunExecutionSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  capture: z.enum(["launch", "migration"]),
  hostId: hostIdSchema,
  projectRegistration: z.object({
    projectId: projectIdSchema,
    revision: z.number().int().positive().nullable(),
    displayName: z.string().min(1).max(255).nullable(),
  }).strict(),
  harness: z.object({
    harnessId: harnessIdSchema,
    revision: z.number().int().positive().nullable(),
    name: z.string().min(1).max(120).nullable(),
    pinnedRevision: commitSchema,
  }).strict(),
  adapter: z.object({
    adapterId: z.literal("conformance-harness-adapter-v1"),
    protocol: z.literal("1.0.0"),
    entryPoint: harnessAdapterEntryPointSchema,
  }).strict(),
  parameters: launchParametersSchema.nullable(),
  source: z.enum(["controller-cli", "cockpit"]).nullable(),
  attribution: z.object({
    controllerId: controllerIdSchema,
    controllerSessionId: controllerSessionIdSchema.nullable(),
  }).strict(),
  createdAt: z.string().datetime(),
  credentialCapabilityReferences: z.array(credentialCapabilityReferenceSchema)
    .max(8).nullable(),
  launchAuditId: auditIdSchema,
}).strict();

const previousCurrentHarnessRunSchema = previousHarnessRunSchema.extend({
  executionSnapshot: harnessRunExecutionSnapshotSchema,
}).strict();
const previousLegacyHarnessRunWithSnapshotSchema = previousLegacyHarnessRunSchema.extend({
  executionSnapshot: harnessRunExecutionSnapshotSchema,
}).strict();
const currentHarnessRunSchema = previousCurrentHarnessRunSchema.extend({
  cancellation: harnessRunCancellationSchema.nullable(),
  launchIdempotencyKeyHash: digestSchema.nullable().default(null),
}).strict();
const legacyHarnessRunSchema = previousLegacyHarnessRunWithSnapshotSchema.extend({
  cancellation: harnessRunCancellationSchema.nullable(),
}).strict();

export const harnessRunSchema = z.union([
  currentHarnessRunSchema,
  legacyHarnessRunSchema,
]);
export const retainedLegacyHarnessRunSchema = z.union([
  legacyHarnessRunSchema,
  previousLegacyHarnessRunSchema,
]);

const storedRunFields = {
  events: z.array(harnessRunEventSchema).max(MAX_RETAINED_RUN_EVENTS),
  outcome: harnessRunOutcomeSchema.nullable(),
  terminalEnvelopeValidation: terminalEnvelopeValidationSchema,
  logStreams: z.tuple([logStreamSchema, logStreamSchema]),
};
const previousCurrentStoredRunSchema = previousHarnessRunSchema.extend(storedRunFields).strict();
const previousLegacyStoredRunSchema = previousLegacyHarnessRunSchema
  .extend(storedRunFields).strict();
const previousStoredRunSchema = z.union([
  previousCurrentStoredRunSchema,
  previousLegacyStoredRunSchema,
]);
const previousCurrentStoredRunWithSnapshotSchema = previousCurrentHarnessRunSchema
  .extend(storedRunFields).strict();
const previousLegacyStoredRunWithSnapshotSchema = previousLegacyHarnessRunWithSnapshotSchema
  .extend(storedRunFields).strict();
const previousStoredRunWithSnapshotSchema = z.union([
  previousCurrentStoredRunWithSnapshotSchema,
  previousLegacyStoredRunWithSnapshotSchema,
]);
const currentStoredRunSchema = currentHarnessRunSchema.extend(storedRunFields).strict();
const legacyStoredRunSchema = legacyHarnessRunSchema.extend(storedRunFields).strict();
const storedRunSchema = z.union([currentStoredRunSchema, legacyStoredRunSchema]);
const retainedOutcomeSchema = z.object({
  idempotencyKeyHash: digestSchema,
  requestFingerprint: digestSchema,
  response: z.object({}).passthrough(),
}).strict();
const stateSchema = z.object({
  schemaVersion: z.literal(5),
  // Canonical runs and keyed mutation outcomes cannot be evicted without
  // breaking reconnect and ambiguous-outcome lookup. Retention/cleanup is a
  // later explicit workflow; the records themselves remain schema-bounded.
  runs: z.array(storedRunSchema),
  launchOutcomes: z.array(retainedOutcomeSchema),
  cancellationOutcomes: z.array(retainedOutcomeSchema),
  legacyStartOutcomes: z.array(retainedOutcomeSchema).default([]),
}).strict();
const previousStateWithCancellationSchema = z.object({
  schemaVersion: z.literal(4),
  runs: z.array(storedRunSchema),
  launchOutcomes: z.array(retainedOutcomeSchema),
  cancellationOutcomes: z.array(retainedOutcomeSchema),
  legacyStartOutcomes: z.array(retainedOutcomeSchema).default([]),
}).strict();
const previousStateWithSnapshotsSchema = z.object({
  schemaVersion: z.literal(3),
  runs: z.array(previousStoredRunWithSnapshotSchema),
  launchOutcomes: z.array(retainedOutcomeSchema),
  legacyStartOutcomes: z.array(retainedOutcomeSchema).default([]),
}).strict();
const previousStateSchema = z.object({
  schemaVersion: z.literal(2),
  runs: z.array(previousStoredRunSchema),
  launchOutcomes: z.array(retainedOutcomeSchema),
  legacyStartOutcomes: z.array(retainedOutcomeSchema).default([]),
}).strict();
const legacyStateSchema = z.object({
  schemaVersion: z.literal(1),
  runs: z.array(previousLegacyStoredRunSchema),
  startOutcomes: z.array(retainedOutcomeSchema),
}).strict();

const initialState = () => ({
  schemaVersion: 5,
  runs: [],
  launchOutcomes: [],
  cancellationOutcomes: [],
  legacyStartOutcomes: [],
});
/** @param {string} dataDir */
const statePath = (dataDir) => join(dataDir, "harness-runs.json");
/** @param {string} dataDir @param {string} harnessRunId @param {"stdout" | "stderr"} producer */
const logPath = (dataDir, harnessRunId, producer) =>
  join(dataDir, "harness-runs", harnessRunId, `${producer}.log`);
/** @param {string | Buffer} value */
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
/** @param {unknown} value @returns {string} */
const canonicalJson = (value) => {
  if (value === undefined) return '"<undefined>"';
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = /** @type {Record<string, unknown>} */ (value);
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};
/** @param {unknown} value */
const fingerprint = (value) => digest(canonicalJson(value));
/** @param {any} request */
const launchRequestFingerprint = (request) => fingerprint({
  projectId: request.projectId,
  parameters: request.parameters === undefined ? {} : request.parameters,
  controllerSessionId: request.controllerSessionId,
  source: request.source,
  authorizationClass: request.authorizationClass,
});
/**
 * Schemas v2-v4 treated the ephemeral Controller runtime as material launch
 * content. Retain this comparison only for outcomes, such as rejected
 * launches, that do not carry enough immutable request facts to normalize.
 * @param {any} request
 */
const legacyLaunchRequestFingerprint = (request) => fingerprint({
  projectId: request.projectId,
  parameters: request.parameters === undefined ? {} : request.parameters,
  controllerId: request.controllerId,
  controllerSessionId: request.controllerSessionId,
  source: request.source,
  authorizationClass: request.authorizationClass,
});
/** @param {any} request */
const requestIdempotencyKeyHash = (request) => {
  const suppliedHash = digestSchema.safeParse(request.idempotencyKeyHash);
  if (suppliedHash.success) return suppliedHash.data;
  return typeof request.idempotencyKey === "string"
    && request.idempotencyKey.length > 0
    && request.idempotencyKey.length <= 256
    ? digest(request.idempotencyKey)
    : null;
};

/** @param {z.infer<typeof storedRunSchema>} run */
const publicRun = (run) => {
  const common = {
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
  };
  return harnessRunSchema.parse("launchRequestId" in run ? {
    ...common,
    launchRequestId: run.launchRequestId,
    launchRequestRevision: run.launchRequestRevision,
    startAuditId: run.startAuditId,
  } : {
    ...common,
    parameters: structuredClone(run.parameters),
    source: run.source,
    launchAuditId: run.launchAuditId,
    launchIdempotencyKeyHash: run.launchIdempotencyKeyHash,
  });
};

/** @param {z.infer<typeof previousStoredRunSchema>} run */
const migrateExecutionSnapshot = (run) => harnessRunExecutionSnapshotSchema.parse({
  schemaVersion: 1,
  capture: "migration",
  hostId: run.hostId,
  projectRegistration: {
    projectId: run.projectId,
    revision: null,
    displayName: null,
  },
  harness: {
    harnessId: run.harnessId,
    revision: null,
    name: null,
    pinnedRevision: run.harnessPinnedRevision,
  },
  adapter: {
    adapterId: run.adapterId,
    protocol: run.adapterProtocol,
    entryPoint: run.adapterEntryPoint,
  },
  parameters: "parameters" in run ? structuredClone(run.parameters) : null,
  source: "source" in run ? run.source : null,
  attribution: {
    controllerId: run.controllerId,
    controllerSessionId: run.controllerSessionId,
  },
  createdAt: run.createdAt,
  credentialCapabilityReferences: null,
  launchAuditId: "launchAuditId" in run ? run.launchAuditId : run.startAuditId,
});

/** @param {z.infer<typeof previousStoredRunSchema>} run */
const migrateStoredRun = (run) => storedRunSchema.parse({
  ...structuredClone(run),
  executionSnapshot: migrateExecutionSnapshot(run),
  cancellation: null,
});

/** @param {z.infer<typeof previousStoredRunWithSnapshotSchema>} run */
const migrateStoredRunWithSnapshot = (run) => storedRunSchema.parse({
  ...structuredClone(run),
  cancellation: null,
});

/**
 * Retained mutation outcomes are immutable accepted responses. Add only the
 * execution snapshot field introduced by schema v3; lifecycle changes in the
 * canonical run must never rewrite the launch-time projection that a retry
 * replays.
 * @param {z.infer<typeof retainedOutcomeSchema>} outcome
 * @param {Array<z.infer<typeof storedRunSchema>>} runs
 */
const migrateRetainedOutcome = (outcome, runs) => {
  const migrated = structuredClone(outcome);
  const harnessRunId = /** @type {any} */ (migrated.response)?.run?.harnessRunId;
  const run = typeof harnessRunId === "string"
    ? runs.find((candidate) => candidate.harnessRunId === harnessRunId)
    : null;
  const responseRun = /** @type {any} */ (migrated.response)?.run;
  if (run && responseRun && typeof responseRun === "object") {
    responseRun.executionSnapshot = structuredClone(run.executionSnapshot);
    responseRun.cancellation = null;
    if ("launchIdempotencyKeyHash" in run) {
      responseRun.launchIdempotencyKeyHash = outcome.idempotencyKeyHash;
    }
  }
  return retainedOutcomeSchema.parse(migrated);
};

/**
 * Derive the current launch fingerprint only from facts that were durably
 * accepted with the run. Outcomes without a canonical current-style run are
 * left byte-for-byte compatible with their original request fingerprint.
 * @param {z.infer<typeof retainedOutcomeSchema>} outcome
 * @param {Array<z.infer<typeof storedRunSchema>>} runs
 */
const normalizeRetainedLaunchOutcomeFingerprint = (outcome, runs) => {
  const normalized = structuredClone(outcome);
  const harnessRunId = /** @type {any} */ (normalized.response)?.run?.harnessRunId;
  const run = typeof harnessRunId === "string"
    ? runs.find((candidate) => candidate.harnessRunId === harnessRunId)
    : null;
  if (run && "parameters" in run && "source" in run) {
    normalized.requestFingerprint = launchRequestFingerprint({
      projectId: run.projectId,
      parameters: run.parameters,
      controllerSessionId: run.controllerSessionId,
      source: run.source,
      authorizationClass: "harness_run_launch",
    });
  }
  return retainedOutcomeSchema.parse(normalized);
};

/**
 * Successful launch outcomes can be upgraded to the current fingerprint from
 * their immutable run facts. This lets the Cockpit reconnect after its
 * ephemeral Controller runtime is replaced. Rejected launches have no run
 * snapshot, so their original fingerprint is retained and matched through the
 * legacy comparison in launch().
 * @param {z.infer<typeof retainedOutcomeSchema>} outcome
 * @param {Array<z.infer<typeof storedRunSchema>>} runs
 */
const migrateRetainedLaunchOutcome = (outcome, runs) =>
  normalizeRetainedLaunchOutcomeFingerprint(migrateRetainedOutcome(outcome, runs), runs);

/**
 * @param {z.infer<typeof previousStateWithCancellationSchema> | z.infer<typeof previousStateWithSnapshotsSchema> | z.infer<typeof previousStateSchema> | z.infer<typeof legacyStateSchema>} previous
 */
const migrateState = (previous) => {
  const runs = previous.schemaVersion === 4
    ? previous.runs
    : previous.schemaVersion === 3
      ? previous.runs.map(migrateStoredRunWithSnapshot)
      : previous.runs.map(migrateStoredRun);
  const launchOutcomes = previous.schemaVersion === 1 ? [] : previous.launchOutcomes;
  for (const outcome of launchOutcomes) {
    const harnessRunId = /** @type {any} */ (outcome.response)?.run?.harnessRunId;
    const run = runs.find((candidate) => candidate.harnessRunId === harnessRunId);
    if (run && "launchIdempotencyKeyHash" in run) {
      run.launchIdempotencyKeyHash = outcome.idempotencyKeyHash;
    }
  }
  const legacyStartOutcomes = previous.schemaVersion === 1
    ? previous.startOutcomes
    : previous.legacyStartOutcomes;
  return stateSchema.parse({
    schemaVersion: 5,
    runs,
    launchOutcomes: launchOutcomes.map((outcome) =>
      migrateRetainedLaunchOutcome(outcome, runs)),
    cancellationOutcomes: previous.schemaVersion === 4
      ? previous.cancellationOutcomes
      : [],
    legacyStartOutcomes: legacyStartOutcomes
      .map((outcome) => migrateRetainedOutcome(outcome, runs)),
  });
};

/**
 * @param {z.infer<typeof storedRunSchema>} run
 * @param {z.infer<typeof harnessRunEventSchema>["type"]} type
 * @param {{progressRecord?: z.infer<typeof progressRecordSchema> | null, outcomeReference?: string | null}} [details]
 */
const appendEvent = (run, type, details = {}) => {
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

/**
 * Arm forced cancellation against the absolute deadline retained in canonical
 * state. The escalation callback is invoked when the deadline becomes due even
 * if platform-specific process-tree preparation is still pending inside it.
 *
 * @param {string} cooperativeDeadlineAt
 * @param {() => Promise<void>} escalate
 * @param {{now?: () => number, setTimer?: typeof setTimeout}} [timing]
 */
export const scheduleCancellationEscalation = (
  cooperativeDeadlineAt,
  escalate,
  timing = {},
) => {
  const currentTime = timing.now ?? Date.now;
  const setTimer = timing.setTimer ?? setTimeout;
  let reportDeadlineReached = () => {};
  const deadlineReached = new Promise((resolve) => {
    reportDeadlineReached = () => resolve(undefined);
  });
  /** @type {(value: void | PromiseLike<void>) => void} */
  let finishOperation = () => {};
  /** @type {(reason?: unknown) => void} */
  let failOperation = () => {};
  let operationSettled = false;
  let escalationStarted = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let activeTimer;
  const operation = new Promise((resolve, reject) => {
    finishOperation = (value) => {
      if (operationSettled) return;
      operationSettled = true;
      resolve(value);
    };
    failOperation = (reason) => {
      if (operationSettled) return;
      operationSettled = true;
      reject(reason);
    };
  });
  const deadline = Date.parse(cooperativeDeadlineAt);
  const escalateWhenDue = () => {
    if (operationSettled) return;
    const remaining = deadline - currentTime();
    if (remaining > 0) {
      activeTimer = setTimer(escalateWhenDue, remaining);
      return;
    }
    escalationStarted = true;
    let escalation;
    try {
      escalation = escalate();
    } catch (error) {
      reportDeadlineReached();
      failOperation(error);
      return;
    }
    reportDeadlineReached();
    escalation.then(finishOperation, failOperation);
  };
  activeTimer = setTimer(escalateWhenDue, Math.max(0, deadline - currentTime()));
  const timer = activeTimer;
  const cancel = () => {
    if (escalationStarted || operationSettled) return false;
    clearTimeout(activeTimer);
    finishOperation();
    return true;
  };
  return { timer, deadlineReached, operation, cancel };
};

/**
 * @param {z.infer<typeof storedRunSchema>} run
 * @param {any} context
 * @param {{onReady: (readyAt: string) => Promise<void>, onProgress: (record: z.infer<typeof progressRecordSchema>) => Promise<void>, onDiagnostic: (producer: "stdout" | "stderr", data: Buffer) => Promise<void>, onSupervisorAvailable: (supervisor: {prepareCancellation: () => Promise<boolean>, requestCancellation: (cooperativeDeadlineAt: string) => Promise<{cooperativeSignalSentAt: string | null, forcedTerminationSentAt: string | null, terminationConfirmedAt: string | null}>, releaseProcessTree: () => Promise<void>}) => void}} observer
 */
const superviseConformanceHarness = async (run, context, observer) => {
  const pinnedAdapter = await loadPinnedHarnessAdapter({
    workspacePath: context.harnessWorkspacePath,
    pinnedRevision: run.harnessPinnedRevision,
  });
  if (
    pinnedAdapter.compatibility.adapterId !== run.adapterId
    || pinnedAdapter.compatibility.adapterProtocol !== run.adapterProtocol
    || pinnedAdapter.compatibility.entryPoint !== run.adapterEntryPoint
  ) {
    throw new Error("harness_adapter_protocol_invalid");
  }
  const encodedExecution = Buffer.from(JSON.stringify({
    harnessRunId: run.harnessRunId,
    parameters: context.parameters,
  }), "utf8").toString("base64url");
  const windowsBarrierDirectory = process.platform === "win32"
    ? await mkdtemp(join(tmpdir(), "sandking-harness-job-"))
    : null;
  const windowsBarrierMarker = windowsBarrierDirectory
    ? join(windowsBarrierDirectory, "assigned")
    : null;
  const windowsJobObject = windowsBarrierMarker
    ? createNativeWindowsJobObject({
        name: `Local\\SandKingHarnessRun-${randomBytes(16).toString("hex")}`,
      })
    : null;
  // Execute the exact bytes read from the immutable Git object. The worktree
  // comparison detects drift, while the inline source removes the check/use
  // window in which different adapter bytes could otherwise be launched.
  const adapterArgs = [
    ...(windowsBarrierMarker ? ["--require", windowsProcessBarrierPath] : []),
    "--input-type=module",
    "--eval", pinnedAdapter.pinnedEntryPointSource,
    pinnedAdapter.compatibility.entryPoint,
    "run",
    encodedExecution,
  ];
  const posixProcessTree = process.platform === "win32"
    ? null
    : spawnPosixProcessTree(process.execPath, adapterArgs, {
        cwd: context.harnessWorkspacePath,
        env: { LANG: "C.UTF-8" },
      });
  const child = posixProcessTree?.child ?? spawn(process.execPath, adapterArgs, {
    cwd: context.harnessWorkspacePath,
    env: {
      LANG: "C.UTF-8",
      ...(windowsBarrierMarker
        ? { SANDKING_WINDOWS_JOB_BARRIER: windowsBarrierMarker }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe", "pipe", "ipc"],
  });
  if (windowsBarrierDirectory) {
    child.once("close", () => {
      void rm(windowsBarrierDirectory, { recursive: true, force: true });
    });
  }
  const windowsProcessTreePromise = process.platform === "win32"
    && typeof child.pid === "number" && windowsJobObject
    ? captureWindowsProcessTreeSnapshot(child.pid, {
        // The encoded invocation contains this run's unique identity. It lets
        // the launch-time native query reject a different process that reused
        // the adapter PID before its creation time could be captured.
        expectedCommandLineFragment: encodedExecution,
        jobObject: windowsJobObject,
      }).then(async (snapshot) => {
        if (!snapshot || !windowsBarrierMarker) {
          // The adapter is still blocked in the preloaded barrier. Abort that
          // already-bound launch channel rather than signalling a numeric PID
          // which may now identify an unrelated replacement process.
          await windowsJobObject.terminate().catch(() => false);
          if (windowsBarrierMarker) {
            await publishWindowsProcessBarrierDecision(
              windowsBarrierMarker,
              "aborted",
            ).catch(() => undefined);
          }
          return createWindowsProcessTreeTracker({ rootIdentity: null });
        }
        await publishWindowsProcessBarrierDecision(
          windowsBarrierMarker,
          "assigned",
        );
        return createWindowsProcessTreeTracker(snapshot);
      }).catch(async () => {
        // Assignment may have completed before a native query or publication
        // failure became observable. Terminating the unguessable Job identity
        // is safe in either case; the abort marker handles an unassigned child.
        await windowsJobObject.terminate().catch(() => false);
        if (windowsBarrierMarker) {
          await publishWindowsProcessBarrierDecision(
            windowsBarrierMarker,
            "aborted",
          ).catch(() => undefined);
        }
        return createWindowsProcessTreeTracker({ rootIdentity: null });
      })
    : null;
  const terminateContainedAdapter = () => {
    if (posixProcessTree) {
      void posixProcessTree.signal("SIGKILL");
      return;
    }
    if (windowsProcessTreePromise) {
      void windowsProcessTreePromise.then((processTree) =>
        processTree.forceTerminate()).catch(() => undefined);
    }
  };
  const adapterChannel = posixProcessTree?.adapterChannel ?? child.stdio[3];
  if (!adapterChannel || !child.stdout || !child.stderr || !("readable" in adapterChannel)) {
    terminateContainedAdapter();
    await windowsJobObject?.close();
    throw new Error("harness_adapter_start_failed");
  }
  let diagnosticQueue = Promise.resolve();
  child.stdout.on("data", (chunk) => {
    diagnosticQueue = diagnosticQueue.then(() => observer.onDiagnostic("stdout", Buffer.from(chunk)));
  });
  child.stderr.on("data", (chunk) => {
    diagnosticQueue = diagnosticQueue.then(() => observer.onDiagnostic("stderr", Buffer.from(chunk)));
  });

  let adapterReadyObserved = false;
  let protocolInvalid = false;
  let adapterChannelClosedObserved = false;
  adapterChannel.once("close", () => {
    adapterChannelClosedObserved = true;
  });
  const terminateProtocolInvalidAdapter = () => {
    protocolInvalid = true;
    terminateContainedAdapter();
    adapterChannel.destroy();
  };
  const publishedProgressRecordIds = new Set();
  /** @type {Array<z.infer<typeof harnessTerminalEnvelopeSchema>>} */
  const terminalEnvelopes = [];
  const consumeFrames = async () => {
    while (true) {
      let message;
      try {
        message = await readHarnessAdapterFrame(adapterChannel);
      } catch (error) {
        if (
          error instanceof HarnessAdapterProtocolError
          && error.code === "harness_adapter_channel_closed"
        ) {
          adapterChannelClosedObserved = true;
          return;
        }
        terminateProtocolInvalidAdapter();
        return;
      }
      if (
        message.type === "harness.adapter.probe"
        || message.type === "harness.launch.prepared"
      ) {
        terminateProtocolInvalidAdapter();
        continue;
      }
      if (
        message.harnessRunId !== run.harnessRunId
        || message.adapterId !== run.adapterId
        || message.adapterProtocol !== run.adapterProtocol
      ) {
        terminateProtocolInvalidAdapter();
        continue;
      }
      if (message.type === "harness.run.ready") {
        if (adapterReadyObserved) {
          terminateProtocolInvalidAdapter();
          continue;
        }
        adapterReadyObserved = true;
        await observer.onReady(message.readyAt);
        // Readiness is the first public point at which the adapter may already
        // have launched Workers. Retain their ancestry after publishing ready
        // so inventory cannot delay the selected run's cancellation action.
        if (posixProcessTree) void posixProcessTree.captureDescendants();
        continue;
      }
      if (message.type === "harness.run.progress") {
        if (
          !adapterReadyObserved
          || terminalEnvelopes.length > 0
          || publishedProgressRecordIds.size >= MAX_PROGRESS_RECORDS_PER_RUN
          || publishedProgressRecordIds.has(message.record.recordId)
          || (message.record.parentRecordId !== null
            && !publishedProgressRecordIds.has(message.record.parentRecordId))
        ) {
          terminateProtocolInvalidAdapter();
          continue;
        }
        publishedProgressRecordIds.add(message.record.recordId);
        await observer.onProgress(message.record);
        continue;
      }
      if (message.type === "harness.run.terminal") {
        if (!adapterReadyObserved) {
          protocolInvalid = true;
        }
        terminalEnvelopes.push(message);
        continue;
      }
      terminateProtocolInvalidAdapter();
    }
  };
  const exit = posixProcessTree?.adapterExit ?? new Promise((resolve) => {
    child.once("error", () => resolve({ code: null, signal: null, startFailed: true }));
    child.once("exit", (code, signal) => resolve({ code, signal, startFailed: false }));
  });
  /** @type {string | null} */
  let cooperativeSignalSentAt = null;
  /** @type {string | null} */
  let forcedTerminationSentAt = null;
  let retainedCooperativeDeadlineAt = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let forcedTerminationTimer;
  let forcedTerminationOperation = Promise.resolve();
  /** @type {Promise<{cooperativeSignalSentAt: string | null, forcedTerminationSentAt: string | null, terminationConfirmedAt: string | null}> | null} */
  let cancellationOperation = null;
  /** @type {Promise<boolean> | null} */
  let processTreePreparation = null;
  const processTreeAlive = async () => {
    if (typeof child.pid !== "number") return false;
    if (posixProcessTree) return posixProcessTree.processTreeAlive();
    if (process.platform === "win32") {
      // Missing or uncertain descendant tracking cannot prove tree termination.
      const windowsProcessTree = windowsProcessTreePromise
        ? await windowsProcessTreePromise
        : null;
      return windowsProcessTree ? windowsProcessTree.processTreeAlive() : true;
    }
    return true;
  };
  /** @param {NodeJS.Signals} signal */
  const signalProcessTree = async (signal) => {
    if (typeof child.pid !== "number") {
      return { sent: false, sentAt: null };
    }
    if (posixProcessTree && ["SIGTERM", "SIGKILL"].includes(signal)) {
      return posixProcessTree.signal(/** @type {"SIGTERM" | "SIGKILL"} */ (signal));
    }
    // Windows ChildProcess.kill maps every supported signal to abrupt
    // termination. Cooperative cancellation uses the adapter IPC request and
    // forced cancellation is bound to retained native process handles.
    return { sent: false, sentAt: null };
  };
  const prepareCancellation = () => {
    if (processTreePreparation) return processTreePreparation;
    processTreePreparation = (async () => {
      if (posixProcessTree) return posixProcessTree.prepareCancellation();
      const windowsProcessTree = windowsProcessTreePromise
        ? await windowsProcessTreePromise
        : null;
      return windowsProcessTree
        ? windowsProcessTree.prepareCancellation()
        : false;
    })();
    return processTreePreparation;
  };
  const completion = Promise.all([exit, consumeFrames()]);
  /** @param {string} cooperativeDeadlineAt */
  const requestCancellation = (cooperativeDeadlineAt) => {
    if (cancellationOperation) return cancellationOperation;
    retainedCooperativeDeadlineAt = cooperativeDeadlineAt;
    // This may already be in flight from the read-only preparation started by
    // the mutation path before its durable commit. Reuse it so no second tree
    // inventory delays the post-commit cooperative signal.
    const cancellationPreparation = prepareCancellation();
    const scheduledEscalation = scheduleCancellationEscalation(
      cooperativeDeadlineAt,
      async () => {
        // A cooperative exit disarms escalation before any signal is sent.
        // The POSIX group guard remains alive through the terminal commit but
        // is not itself part of the supervised Harness process tree.
        if (
          posixProcessTree?.adapterExited()
          && !(await processTreeAlive())
        ) {
          return;
        }
        const windowsProcessTree = windowsProcessTreePromise
          ? await windowsProcessTreePromise
          : null;
        if (windowsProcessTree) {
          if (await windowsProcessTree.forceTerminate()) {
            forcedTerminationSentAt = new Date().toISOString();
          }
          return;
        }
        const forcedTermination = await signalProcessTree("SIGKILL");
        if (forcedTermination.sent) {
          forcedTerminationSentAt = forcedTermination.sentAt;
        }
      },
    );
    forcedTerminationTimer = scheduledEscalation.timer;
    forcedTerminationOperation = scheduledEscalation.operation;
    cancellationOperation = (async () => {
      await cancellationPreparation;
      const windowsProcessTree = windowsProcessTreePromise
        ? await windowsProcessTreePromise
        : null;
      const posixTreeRequiresCooperativeSignal = posixProcessTree
        ? !posixProcessTree.adapterExited()
        : false;
      if (windowsProcessTree) {
        const cooperativeRequestSent = sendHarnessCancellationRequest(child, {
          type: "harness.run.cancel",
          adapterProtocol: run.adapterProtocol,
          adapterId: run.adapterId,
          harnessRunId: run.harnessRunId,
          cooperativeDeadlineAt,
        });
        if (cooperativeRequestSent) {
          cooperativeSignalSentAt = new Date().toISOString();
        }
      } else if (posixTreeRequiresCooperativeSignal) {
        const cooperativeSignal = await signalProcessTree("SIGTERM");
        if (cooperativeSignal.sent) {
          cooperativeSignalSentAt = cooperativeSignal.sentAt;
        }
      }
      await completion;
      let terminationConfirmedAt = null;
      // The adapter may exit cooperatively while an inherited descendant
      // remains in its supervised process group. Keep the forced deadline
      // active until the entire group is gone, then confirm termination from
      // that boundary. This also handles cancellation accepted after the
      // adapter root exits but before its terminal outcome commits.
      const confirmationDeadline = Math.max(
        Date.now(),
        Date.parse(retainedCooperativeDeadlineAt ?? ""),
      ) + 1_000;
      while (
        forcedTerminationSentAt === null
        && await processTreeAlive()
        && Date.now() < confirmationDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!(await processTreeAlive())) scheduledEscalation.cancel();
      await forcedTerminationOperation;
      // A dispatched force signal is evidence of an attempt, not evidence that
      // every retained descendant terminated. Confirm the tree again before
      // allowing the cancellation terminal transition.
      if (!(await processTreeAlive())) {
        terminationConfirmedAt = new Date().toISOString();
      }
      clearTimeout(forcedTerminationTimer);
      return {
        cooperativeSignalSentAt,
        forcedTerminationSentAt,
        terminationConfirmedAt,
      };
    })();
    return cancellationOperation;
  };
  observer.onSupervisorAvailable({
    prepareCancellation,
    requestCancellation,
    releaseProcessTree: posixProcessTree?.release ?? (async () => {
      await windowsProcessTreePromise?.catch(() => undefined);
      await windowsJobObject?.close();
    }),
  });
  const [exitResult] = await completion;
  const cancellation = cancellationOperation ? await cancellationOperation : null;
  await diagnosticQueue;
  return {
    adapterReadyObserved,
    protocolInvalid,
    terminalEnvelopes,
    adapterChannelClosedObserved,
    exit: exitResult,
    cancellation,
  };
};

/**
 * @param {{
 *   dataDir: string,
 *   hostId: string,
 *   recordAudit: (action: string, outcome: "accepted" | "rejected" | "observed", details?: Record<string, unknown>, auditId?: string) => Promise<string>,
 *   loadLaunchContext: (projectId: string) => Promise<any>,
 *   now?: () => Date,
 *   cancellationGraceMs?: number,
 *   faultInjector?: (point: "harness_run_launch.before_commit" | "harness_run_launch.after_state_commit" | "harness_run_launch.after_commit" | "harness_run_cancellation.before_commit" | "harness_run_cancellation.after_state_commit" | "harness_run_cancellation.after_commit" | "harness_run_cancellation.before_termination_confirmation_commit" | "harness_run_outcome.before_commit" | "harness_run_reconciliation.before_commit" | "harness_run_reconciliation.after_state_commit" | "harness_run_reconciliation.after_commit") => Promise<void> | void,
 * }} options
 */
export const createHarnessRunManager = async (options) => {
  const parsedHostId = hostIdSchema.parse(options.hostId);
  const now = options.now ?? (() => new Date());
  const cancellationGraceMs = options.cancellationGraceMs ?? 250;
  if (!Number.isSafeInteger(cancellationGraceMs) || cancellationGraceMs < 10
    || cancellationGraceMs > 10_000) {
    throw new Error("harness_run_cancellation_deadline_invalid");
  }
  let mutationQueue = Promise.resolve();
  /** @type {Map<string, {prepareCancellation: () => Promise<boolean>, requestCancellation: (cooperativeDeadlineAt: string) => Promise<{cooperativeSignalSentAt: string | null, forcedTerminationSentAt: string | null, terminationConfirmedAt: string | null}>, releaseProcessTree: () => Promise<void>}>} */
  const activeSupervisions = new Map();
  /** @type {Map<string, string>} */
  const acceptedCancellations = new Map();
  /** @template T @param {() => Promise<T>} operation */
  const withMutationLock = (operation) => {
    const current = mutationQueue.catch(() => undefined).then(operation);
    mutationQueue = current.then(() => undefined, () => undefined);
    return current;
  };
  /** @param {z.infer<typeof stateSchema>} state */
  const ensureAcceptedLaunchAudits = async (state) => {
    for (const outcome of state.launchOutcomes) {
      const response = /** @type {any} */ (outcome.response);
      const harnessRunId = response?.run?.harnessRunId;
      if (response?.type !== "harness.run.launch.result" || typeof harnessRunId !== "string") {
        continue;
      }
      const run = state.runs.find((candidate) =>
        candidate.harnessRunId === harnessRunId);
      if (!run || !("launchAuditId" in run)
        || response.auditId !== run.launchAuditId
        || run.executionSnapshot.launchAuditId !== run.launchAuditId) {
        throw new Error("harness_run_launch_audit_reference_invalid");
      }
      const snapshot = run.executionSnapshot;
      const auditId = await options.recordAudit("harness.run.launch", "accepted", {
        authorizationClass: "harness_run_launch",
        idempotencyKeyHash: outcome.idempotencyKeyHash,
        harnessRunId: run.harnessRunId,
        hostId: snapshot.hostId,
        projectId: snapshot.projectRegistration.projectId,
        harnessId: snapshot.harness.harnessId,
        harnessPinnedRevision: snapshot.harness.pinnedRevision,
        controllerId: snapshot.attribution.controllerId,
        controllerSessionId: snapshot.attribution.controllerSessionId,
        source: snapshot.source,
        parameters: structuredClone(snapshot.parameters),
        adapterId: snapshot.adapter.adapterId,
        adapterProtocol: snapshot.adapter.protocol,
        adapterEntryPoint: snapshot.adapter.entryPoint,
        returnedBeforeTerminal: true,
        projectWrite: false,
      }, run.launchAuditId);
      if (auditId !== run.launchAuditId) {
        throw new Error("harness_run_launch_audit_commit_invalid");
      }
    }
  };
  /** @param {z.infer<typeof stateSchema>} state */
  const ensureAcceptedCancellationAudits = async (state) => {
    for (const outcome of state.cancellationOutcomes) {
      const response = /** @type {any} */ (outcome.response);
      if (response?.type !== "harness.run.cancel.result") continue;
      const run = state.runs.find((candidate) =>
        candidate.harnessRunId === response.harnessRunId);
      if (!run?.cancellation || run.cancellation.auditId !== response.auditId
        || run.cancellation.idempotencyKeyHash !== outcome.idempotencyKeyHash) {
        throw new Error("harness_run_cancellation_audit_reference_invalid");
      }
      const auditId = await options.recordAudit("harness.run.cancel", "accepted", {
        code: response.code,
        authorizationClass: "harness_run_cancellation",
        idempotencyKeyHash: outcome.idempotencyKeyHash,
        harnessRunId: run.harnessRunId,
        projectId: run.projectId,
        acceptedAt: run.cancellation.acceptedAt,
        cooperativeDeadlineAt: run.cancellation.cooperativeDeadlineAt,
        returnedBeforeTerminal: true,
        projectWrite: false,
      }, run.cancellation.auditId);
      if (auditId !== run.cancellation.auditId) {
        throw new Error("harness_run_cancellation_audit_commit_invalid");
      }
    }
  };
  /** @param {z.infer<typeof storedRunSchema>} run */
  const outcomeAuditDetails = (run) => {
    if (!run.outcome) throw new Error("harness_run_outcome_missing");
    return {
      harnessRunId: run.harnessRunId,
      projectId: run.projectId,
      outcomeReference: run.outcome.outcomeId,
      status: run.outcome.status,
      code: run.outcome.code,
      incompleteResult: run.outcome.incompleteResult,
      adapterReadyObserved: run.terminalEnvelopeValidation.adapterReadyObserved,
      validTerminalEnvelopeCount:
        run.terminalEnvelopeValidation.validTerminalEnvelopeCount,
      adapterChannelClosedObserved:
        run.terminalEnvelopeValidation.adapterChannelClosedObserved,
      processExitObserved: run.terminalEnvelopeValidation.processExitObserved,
      stdoutRange: run.logStreams[0].availableEnd,
      stderrRange: run.logStreams[1].availableEnd,
      interruptionCode: run.outcome.interruption?.code ?? null,
    };
  };
  /** @param {z.infer<typeof stateSchema>} state */
  const ensureOutcomeAudits = async (state) => {
    for (const run of state.runs) {
      if (!run.outcome?.outcomeAuditId) continue;
      const auditId = await options.recordAudit(
        "harness.run.outcome",
        "observed",
        outcomeAuditDetails(run),
        run.outcome.outcomeAuditId,
      );
      if (auditId !== run.outcome.outcomeAuditId) {
        throw new Error("harness_run_outcome_audit_commit_invalid");
      }
    }
  };
  /** @param {z.infer<typeof stateSchema>} state */
  const ensureReconciliationAudits = async (state) => {
    for (const run of state.runs) {
      const interruption = run.outcome?.interruption;
      if (!interruption) continue;
      const auditId = await options.recordAudit("harness.run.reconcile", "observed", {
        code: interruption.code,
        harnessRunId: run.harnessRunId,
        hostId: run.hostId,
        projectId: run.projectId,
        previousStatus: interruption.previousStatus,
        status: run.outcome?.status,
        outcomeReference: run.outcome?.outcomeId,
        incompleteResult: run.outcome?.incompleteResult,
        retainedEventCount: run.events.length,
        stdoutRange: run.logStreams[0].availableEnd,
        stderrRange: run.logStreams[1].availableEnd,
        adapterRelaunched: false,
        harnessRunCreated: false,
        projectWrite: false,
      }, interruption.reconciliationAuditId);
      if (auditId !== interruption.reconciliationAuditId) {
        throw new Error("harness_run_reconciliation_audit_commit_invalid");
      }
    }
  };
  const readState = async () => {
    const raw = await readJson(statePath(options.dataDir), initialState());
    if (
      raw
      && typeof raw === "object"
      && "schemaVersion" in raw
      && raw.schemaVersion === 1
    ) {
      const legacy = legacyStateSchema.parse(raw);
      const migrated = migrateState(legacy);
      await writePrivateJson(statePath(options.dataDir), migrated);
      await ensureAcceptedLaunchAudits(migrated);
      await ensureAcceptedCancellationAudits(migrated);
      await ensureOutcomeAudits(migrated);
      await ensureReconciliationAudits(migrated);
      return migrated;
    }
    if (
      raw
      && typeof raw === "object"
      && "schemaVersion" in raw
      && raw.schemaVersion === 2
    ) {
      const previous = previousStateSchema.parse(raw);
      const migrated = migrateState(previous);
      await writePrivateJson(statePath(options.dataDir), migrated);
      await ensureAcceptedLaunchAudits(migrated);
      await ensureAcceptedCancellationAudits(migrated);
      await ensureOutcomeAudits(migrated);
      await ensureReconciliationAudits(migrated);
      return migrated;
    }
    if (
      raw
      && typeof raw === "object"
      && "schemaVersion" in raw
      && raw.schemaVersion === 3
    ) {
      const previous = previousStateWithSnapshotsSchema.parse(raw);
      const migrated = migrateState(previous);
      await writePrivateJson(statePath(options.dataDir), migrated);
      await ensureAcceptedLaunchAudits(migrated);
      await ensureAcceptedCancellationAudits(migrated);
      await ensureOutcomeAudits(migrated);
      await ensureReconciliationAudits(migrated);
      return migrated;
    }
    if (
      raw
      && typeof raw === "object"
      && "schemaVersion" in raw
      && raw.schemaVersion === 4
    ) {
      const previous = previousStateWithCancellationSchema.parse(raw);
      const migrated = migrateState(previous);
      await writePrivateJson(statePath(options.dataDir), migrated);
      await ensureAcceptedLaunchAudits(migrated);
      await ensureAcceptedCancellationAudits(migrated);
      await ensureOutcomeAudits(migrated);
      await ensureReconciliationAudits(migrated);
      return migrated;
    }
    const retained = stateSchema.parse(raw);
    const normalizedLaunchOutcomes = retained.launchOutcomes.map((outcome) =>
      normalizeRetainedLaunchOutcomeFingerprint(outcome, retained.runs));
    if (normalizedLaunchOutcomes.some((outcome, index) =>
      outcome.requestFingerprint !== retained.launchOutcomes[index].requestFingerprint)) {
      retained.launchOutcomes = normalizedLaunchOutcomes;
      // Repair schema-v5 snapshots written by the initial reconciliation
      // implementation before exposing lookup or lifecycle operations. The
      // atomic rewrite is deterministic, so interruption simply retries it.
      await writePrivateJson(statePath(options.dataDir), retained);
    }
    await ensureAcceptedLaunchAudits(retained);
    await ensureAcceptedCancellationAudits(retained);
    await ensureOutcomeAudits(retained);
    await ensureReconciliationAudits(retained);
    return retained;
  };
  /** @param {z.infer<typeof stateSchema>} state */
  const persist = (state) => writePrivateJson(
    statePath(options.dataDir),
    stateSchema.parse(state),
  );
  const terminalEventTypes = new Set([
    "harness_run_succeeded",
    "harness_run_failed",
    "harness_run_cancelled",
  ]);
  /** @param {z.infer<typeof storedRunSchema>} run */
  const repairAcceptedTerminalOutcome = (run) => {
    if (!run.outcome) return false;
    const expectedEventType = run.outcome.status === "succeeded"
      ? "harness_run_succeeded"
      : run.outcome.status === "cancelled"
        ? "harness_run_cancelled"
        : "harness_run_failed";
    const terminalEvents = run.events.filter((event) => terminalEventTypes.has(event.type));
    if (terminalEvents.length > 1) {
      throw new Error("harness_run_terminal_history_invalid");
    }
    if (terminalEvents.length === 1 && (
      terminalEvents[0].type !== expectedEventType
      || terminalEvents[0].outcomeReference !== run.outcome.outcomeId
    )) {
      throw new Error("harness_run_terminal_history_invalid");
    }
    let repaired = false;
    if (terminalEvents.length === 0) {
      appendEvent(run, expectedEventType, { outcomeReference: run.outcome.outcomeId });
      repaired = true;
    }
    if (run.status !== run.outcome.status || run.completedAt !== run.outcome.completedAt) {
      run.status = run.outcome.status;
      run.completedAt = run.outcome.completedAt;
      repaired = true;
    }
    if (repaired) run.revision += 1;
    return repaired;
  };
  const reconcileInterruptedRuns = async () => {
    const retained = await readState();
    let changed = false;
    for (const run of retained.runs) {
      if (run.outcome) {
        changed = repairAcceptedTerminalOutcome(run) || changed;
        continue;
      }
      if (!["starting", "running"].includes(run.status)) continue;
      if (run.cancellation !== null) {
        throw new Error("harness_run_reconciliation_state_invalid");
      }
      if (run.events.some((event) => terminalEventTypes.has(event.type))) {
        throw new Error("harness_run_terminal_history_invalid");
      }
      if (
        run.terminalEnvelopeValidation.validTerminalEnvelopeCount !== 0
        || run.terminalEnvelopeValidation.exactlyOne
      ) {
        throw new Error("harness_run_terminal_outcome_missing");
      }
      const previousStatus = run.status;
      const reconciledAt = now().toISOString();
      const outcomeId = `harness-outcome-${randomBytes(12).toString("hex")}`;
      run.status = "failed";
      run.completedAt = reconciledAt;
      run.revision += 1;
      run.terminalEnvelopeValidation = {
        adapterReadyObserved: run.terminalEnvelopeValidation.adapterReadyObserved,
        validTerminalEnvelopeCount: 0,
        exactlyOne: false,
        adapterChannelClosedObserved: false,
        processExitObserved: false,
      };
      run.outcome = harnessRunOutcomeSchema.parse({
        outcomeId,
        status: "failed",
        code: "host_daemon_interrupted",
        completedAt: reconciledAt,
        incompleteResult: true,
        result: null,
        diagnosticReferences: run.logStreams.map((stream) => ({
          streamId: stream.streamId,
          producer: stream.producer,
          range: {
            start: stream.availableStart,
            end: stream.availableEnd,
          },
          explicitRetrievalRequired: stream.explicitRetrievalRequired,
          insertedIntoControllerConversation: stream.insertedIntoControllerConversation,
        })),
        terminalEnvelope: null,
        outcomeAuditId: `audit-${randomBytes(12).toString("hex")}`,
        interruption: {
          code: "host_daemon_interrupted",
          previousStatus,
          reconciledAt,
          reconciliationAuditId: `audit-${randomBytes(12).toString("hex")}`,
        },
      });
      appendEvent(run, "harness_run_failed", { outcomeReference: outcomeId });
      changed = true;
    }
    if (!changed) return;
    await options.faultInjector?.("harness_run_reconciliation.before_commit");
    await persist(retained);
    await options.faultInjector?.("harness_run_reconciliation.after_state_commit");
    await ensureOutcomeAudits(retained);
    await ensureReconciliationAudits(retained);
    await options.faultInjector?.("harness_run_reconciliation.after_commit");
  };
  // Complete migration, terminal-view repair, and active-run reconciliation
  // before exposing observation or mutation methods to the framed Host loop.
  await reconcileInterruptedRuns();
  /** @param {z.infer<typeof stateSchema>} state @param {string | null} idempotencyKeyHash */
  const retainedLaunchOutcome = (state, idempotencyKeyHash) => idempotencyKeyHash
    ? state.launchOutcomes.find((outcome) =>
        outcome.idempotencyKeyHash === idempotencyKeyHash)
      ?? state.legacyStartOutcomes.find((outcome) =>
        outcome.idempotencyKeyHash === idempotencyKeyHash)
    : null;
  /** @param {z.infer<typeof stateSchema>} state @param {string | null} idempotencyKeyHash */
  const retainedCancellationOutcome = (state, idempotencyKeyHash) => idempotencyKeyHash
    ? state.cancellationOutcomes.find((outcome) =>
        outcome.idempotencyKeyHash === idempotencyKeyHash) ?? null
    : null;

  /** @param {string} harnessRunId @param {(run: z.infer<typeof storedRunSchema>, state: z.infer<typeof stateSchema>) => Promise<void> | void} update */
  const updateRun = (harnessRunId, update) => withMutationLock(async () => {
    const retained = await readState();
    const run = retained.runs.find((candidate) => candidate.harnessRunId === harnessRunId);
    if (!run) {
      throw new Error("harness_run_not_found");
    }
    await update(run, retained);
    await persist(retained);
    return structuredClone(run);
  });

  /** @param {string} harnessRunId @param {"stdout" | "stderr"} producer @param {Buffer} data */
  const appendDiagnostic = async (harnessRunId, producer, data) => {
    if (data.byteLength === 0) {
      return;
    }
    await updateRun(harnessRunId, async (run) => {
      const stream = run.logStreams.find((candidate) => candidate.producer === producer);
      if (!stream) {
        throw new Error("harness_log_stream_invalid");
      }
      const remaining = Math.max(0, 65_536 - stream.availableEnd);
      const bounded = data.subarray(0, remaining);
      if (bounded.byteLength > 0) {
        await appendFile(logPath(options.dataDir, harnessRunId, producer), bounded, {
          mode: PRIVATE_FILE_MODE,
        });
        stream.availableEnd += bounded.byteLength;
      }
    });
  };

  /** @param {z.infer<typeof storedRunSchema>} initialRun @param {any} context */
  const supervise = async (initialRun, context) => {
    let supervision;
    /** @type {{prepareCancellation: () => Promise<boolean>, requestCancellation: (cooperativeDeadlineAt: string) => Promise<{cooperativeSignalSentAt: string | null, forcedTerminationSentAt: string | null, terminationConfirmedAt: string | null}>, releaseProcessTree: () => Promise<void>} | null} */
    let cancellationSupervisor = null;
    /** @type {() => Promise<void>} */
    let releaseSupervisedProcessTree = async () => undefined;
    /** @type {Array<z.infer<typeof progressRecordSchema>>} */
    const pendingProgressRecords = [];
    let progressRecordCount = 0;
    const persistProgressRecords = async () => {
      if (pendingProgressRecords.length === 0) {
        return;
      }
      const records = pendingProgressRecords.slice();
      await updateRun(initialRun.harnessRunId, (run) => {
        // Cancellation acceptance is the canonical boundary after which no
        // Harness-defined work can enter history. A frame emitted earlier but
        // queued behind that durable mutation cannot overtake it.
        if (run.cancellation || run.outcome) return;
        for (const record of records) {
          run.revision += 1;
          appendEvent(run, "harness_progress_published", { progressRecord: record });
        }
      });
      pendingProgressRecords.splice(0, records.length);
    };
    try {
      supervision = await superviseConformanceHarness(initialRun, context, {
        onSupervisorAvailable: (supervisor) => {
          cancellationSupervisor = supervisor;
          releaseSupervisedProcessTree = supervisor.releaseProcessTree;
          activeSupervisions.set(initialRun.harnessRunId, supervisor);
          const cooperativeDeadlineAt = acceptedCancellations.get(
            initialRun.harnessRunId,
          );
          if (cooperativeDeadlineAt) {
            supervisor.requestCancellation(cooperativeDeadlineAt);
          }
        },
        onReady: async (readyAt) => {
          await updateRun(initialRun.harnessRunId, (run) => {
            if (run.status !== "starting" && run.status !== "cancelling") {
              throw new Error("harness_run_state_invalid");
            }
            if (run.status === "starting") run.status = "running";
            run.adapterReadyAt = readyAt;
            run.revision += 1;
            appendEvent(run, "harness_adapter_ready");
          });
        },
        onProgress: async (record) => {
          progressRecordCount += 1;
          pendingProgressRecords.push(record);
          if (
            progressRecordCount === 1
            || pendingProgressRecords.length >= PROGRESS_PERSIST_BATCH_SIZE
          ) {
            await persistProgressRecords();
          }
        },
        onDiagnostic: (producer, data) =>
          appendDiagnostic(initialRun.harnessRunId, producer, data),
      });
    } catch {
      supervision = {
        adapterReadyObserved: false,
        protocolInvalid: false,
        terminalEnvelopes: [],
        adapterChannelClosedObserved: false,
        exit: { code: null, signal: null, startFailed: true },
        cancellation: null,
      };
    } finally {
      activeSupervisions.delete(initialRun.harnessRunId);
    }
    try {
      await persistProgressRecords();
      const terminal = supervision.terminalEnvelopes.length === 1
        ? supervision.terminalEnvelopes[0]
        : null;
      const validTerminal = terminal && !supervision.protocolInvalid;
      let terminalOutcomeCommitted = false;
      let status = validTerminal ? terminal.status : "failed";
      let code = supervision.exit.startFailed
        ? "harness_adapter_start_failed"
        : supervision.protocolInvalid
          ? "harness_adapter_protocol_invalid"
          : validTerminal
            ? terminal.status === "succeeded"
              ? "conformance_run_succeeded"
              : terminal.status === "failed"
                ? "conformance_run_failed"
                : "conformance_run_cancelled"
            : "harness_result_incomplete";
      let incompleteResult = !validTerminal;
      let acceptedTerminal = validTerminal ? terminal : null;
      const outcomeId = `harness-outcome-${randomBytes(12).toString("hex")}`;
      const outcomeAuditId = `audit-${randomBytes(12).toString("hex")}`;
      let completedAt = now().toISOString();
      await options.faultInjector?.("harness_run_outcome.before_commit");
      const finalized = await updateRun(initialRun.harnessRunId, async (run) => {
        if (run.outcome) return;
        if (run.cancellation) {
          const cancellationTermination = supervision.cancellation
            ?? (cancellationSupervisor
              ? await cancellationSupervisor.requestCancellation(
                  run.cancellation.cooperativeDeadlineAt,
                )
              : {
                  cooperativeSignalSentAt: null,
                  forcedTerminationSentAt: null,
                  // No supervisor means adapter setup failed before a process
                  // tree became available. That start-failure boundary is the
                  // only late-cancellation case that can confirm no tree without
                  // consulting a live supervisor.
                  terminationConfirmedAt: supervision.exit.startFailed
                    ? completedAt
                    : null,
                });
          if (cancellationTermination.terminationConfirmedAt) {
            await options.faultInjector?.(
              "harness_run_cancellation.before_termination_confirmation_commit",
            );
          }
          run.cancellation.cooperativeSignalSentAt =
            cancellationTermination.cooperativeSignalSentAt;
          run.cancellation.forcedTerminationSentAt =
            cancellationTermination.forcedTerminationSentAt;
          run.cancellation.terminationConfirmedAt =
            cancellationTermination.terminationConfirmedAt;
          if (!cancellationTermination.terminationConfirmedAt) return;
          completedAt = now().toISOString();
          const validCancellationTerminal = validTerminal && terminal.status === "cancelled";
          status = "cancelled";
          code = "conformance_run_cancelled";
          incompleteResult = !validCancellationTerminal
            || cancellationTermination.forcedTerminationSentAt !== null;
          acceptedTerminal = validCancellationTerminal ? terminal : null;
        }
        run.status = status;
        run.completedAt = completedAt;
        run.revision += 1;
        run.terminalEnvelopeValidation = {
          adapterReadyObserved: supervision.adapterReadyObserved,
          validTerminalEnvelopeCount: supervision.terminalEnvelopes.length,
          exactlyOne: Boolean(validTerminal),
          adapterChannelClosedObserved: supervision.adapterChannelClosedObserved,
          processExitObserved: !supervision.exit.startFailed,
        };
        run.outcome = harnessRunOutcomeSchema.parse({
          outcomeId,
          status,
          code,
          completedAt,
          incompleteResult,
          result: acceptedTerminal ? acceptedTerminal.result : null,
          diagnosticReferences: run.logStreams.map((stream) => ({
            streamId: stream.streamId,
            producer: stream.producer,
            range: {
              start: stream.availableStart,
              end: stream.availableEnd,
            },
            explicitRetrievalRequired: stream.explicitRetrievalRequired,
            insertedIntoControllerConversation: stream.insertedIntoControllerConversation,
          })),
          terminalEnvelope: acceptedTerminal ? {
            terminalId: acceptedTerminal.terminalId,
            status: acceptedTerminal.status,
            adapterId: acceptedTerminal.adapterId,
            adapterProtocol: acceptedTerminal.adapterProtocol,
          } : null,
          outcomeAuditId,
          interruption: null,
        });
        appendEvent(
          run,
          status === "succeeded"
            ? "harness_run_succeeded"
            : status === "cancelled"
              ? "harness_run_cancelled"
              : "harness_run_failed",
          { outcomeReference: outcomeId },
        );
        terminalOutcomeCommitted = true;
      });
      if (!terminalOutcomeCommitted) return;
      acceptedCancellations.delete(initialRun.harnessRunId);
      const committedAuditId = await options.recordAudit(
        "harness.run.outcome",
        "observed",
        outcomeAuditDetails(finalized),
        outcomeAuditId,
      );
      if (committedAuditId !== outcomeAuditId) {
        throw new Error("harness_run_outcome_audit_commit_invalid");
      }
    } finally {
      await releaseSupervisedProcessTree();
    }
  };

  /** @param {any} request */
  const launch = (request) => withMutationLock(async () => {
    const authorizationClass = "harness_run_launch";
    const idempotencyKeyHash = requestIdempotencyKeyHash(request);
    const requestFingerprint = launchRequestFingerprint(request);
    const compatibleRequestFingerprints = new Set([
      requestFingerprint,
      legacyLaunchRequestFingerprint(request),
    ]);
    const retained = await readState();
    const existing = retainedLaunchOutcome(retained, idempotencyKeyHash);
    if (existing) {
      if (!compatibleRequestFingerprints.has(existing.requestFingerprint)) {
        const auditId = await options.recordAudit("harness.run.launch", "rejected", {
          code: "idempotency_key_conflict",
          authorizationClass,
          idempotencyKeyHash,
          harnessRunCreated: false,
        });
        return {
          type: "harness.run.launch.failure",
          requestId: request.requestId,
          code: "idempotency_key_conflict",
          retryable: false,
          authorizationClass,
          idempotencyKeyHash,
          idempotentReplay: false,
          auditId,
          prohibitedSideEffects: { harnessRunCreated: false, projectWrite: false },
        };
      }
      await options.recordAudit("harness.run.launch", "observed", {
        authorizationClass,
        idempotencyKeyHash,
        idempotentReplay: true,
        originalAuditId: existing.response.auditId,
        harnessRunId: /** @type {any} */ (existing.response).run?.harnessRunId ?? null,
      });
      return {
        ...structuredClone(existing.response),
        requestId: request.requestId,
        idempotentReplay: true,
      };
    }

    const parameters = launchParametersSchema.safeParse(request.parameters);
    let code = null;
    if (
      request.authorizationClass !== authorizationClass
      || !idempotencyKeyHash
      || !projectIdSchema.safeParse(request.projectId).success
      || !controllerIdSchema.safeParse(request.controllerId).success
      || !["controller-cli", "cockpit"].includes(request.source)
      || (request.source === "controller-cli"
        ? !controllerSessionIdSchema.safeParse(request.controllerSessionId).success
        : request.controllerSessionId !== null)
    ) {
      code = "mutation_contract_invalid";
    } else if (!parameters.success) {
      code = "bounded_configuration_invalid";
    }

    let context;
    let prepared;
    if (!code && parameters.success) {
      try {
        context = await options.loadLaunchContext(request.projectId);
        prepared = await validateConformanceHarnessLaunch(context, parameters.data);
        if (
          context.project.projectId !== request.projectId
          || context.harness.harnessId !== context.project.harness.harnessId
          || context.harness.immutableRevision !== context.project.harness.pinnedRevision
          || prepared.adapterId !== context.harness.adapterId
          || prepared.adapterProtocol
            !== context.project.harness.boundedConfiguration.adapterProtocol
        ) {
          code = "harness_pin_invalid";
        }
      } catch (error) {
        const typedCode = error instanceof Error ? error.message : "";
        code = new Set([
          "project_not_found",
          "harness_not_found",
          "harness_pin_missing",
          "harness_pin_invalid",
          "harness_workspace_invalid",
          "bounded_configuration_invalid",
          "harness_capability_unsupported",
          "harness_adapter_protocol_invalid",
          "harness_preparation_side_effect_detected",
        ]).has(typedCode) ? typedCode : "harness_workspace_invalid";
      }
    }

    if (code || !context || !prepared || !parameters.success || !idempotencyKeyHash) {
      const failureCode = code ?? "mutation_contract_invalid";
      const auditId = await options.recordAudit("harness.run.launch", "rejected", {
        code: failureCode,
        authorizationClass,
        idempotencyKeyHash,
        hostId: parsedHostId,
        projectId: projectIdSchema.safeParse(request.projectId).success ? request.projectId : null,
        harnessId: context?.harness?.harnessId ?? null,
        source: ["controller-cli", "cockpit"].includes(request.source) ? request.source : null,
        harnessRunCreated: false,
        projectWrite: false,
      });
      const response = {
        type: "harness.run.launch.failure",
        requestId: typeof request.requestId === "string" ? request.requestId : "invalid-request",
        code: failureCode,
        retryable: failureCode === "project_not_found",
        authorizationClass,
        idempotencyKeyHash,
        idempotentReplay: false,
        auditId,
        prohibitedSideEffects: { harnessRunCreated: false, projectWrite: false },
      };
      if (idempotencyKeyHash) {
        retained.launchOutcomes.push({ idempotencyKeyHash, requestFingerprint, response });
        await persist(retained);
      }
      return response;
    }

    const harnessRunId = `harness-run-${randomBytes(12).toString("hex")}`;
    const createdAt = now().toISOString();
    const auditId = `audit-${randomBytes(12).toString("hex")}`;
    const run = storedRunSchema.parse({
      harnessRunId,
      revision: 1,
      status: "starting",
      hostId: parsedHostId,
      projectId: context.project.projectId,
      harnessId: context.harness.harnessId,
      harnessPinnedRevision: context.harness.immutableRevision,
      adapterId: prepared.adapterId,
      adapterProtocol: prepared.adapterProtocol,
      adapterEntryPoint: prepared.adapterEntryPoint,
      parameters: parameters.data,
      source: request.source,
      controllerId: request.controllerId,
      controllerSessionId: request.controllerSessionId,
      createdAt,
      adapterReadyAt: null,
      completedAt: null,
      launchAuditId: auditId,
      launchIdempotencyKeyHash: idempotencyKeyHash,
      cancellation: null,
      executionSnapshot: {
        schemaVersion: 1,
        capture: "launch",
        hostId: parsedHostId,
        projectRegistration: {
          projectId: context.project.projectId,
          revision: context.project.revision,
          displayName: context.project.displayName,
        },
        harness: {
          harnessId: context.harness.harnessId,
          revision: context.harness.revision,
          name: context.harness.name,
          pinnedRevision: context.harness.immutableRevision,
        },
        adapter: {
          adapterId: prepared.adapterId,
          protocol: prepared.adapterProtocol,
          entryPoint: prepared.adapterEntryPoint,
        },
        parameters: parameters.data,
        source: request.source,
        attribution: {
          controllerId: request.controllerId,
          controllerSessionId: request.controllerSessionId,
        },
        createdAt,
        credentialCapabilityReferences: prepared.suppliedCapabilities,
        launchAuditId: auditId,
      },
      events: [],
      outcome: null,
      terminalEnvelopeValidation: {
        adapterReadyObserved: false,
        validTerminalEnvelopeCount: 0,
        exactlyOne: false,
        adapterChannelClosedObserved: false,
        processExitObserved: false,
      },
      logStreams: [
        {
          streamId: `harness-log-${randomBytes(12).toString("hex")}`,
          producer: "stdout",
          availableStart: 0,
          availableEnd: 0,
          explicitRetrievalRequired: true,
          insertedIntoControllerConversation: false,
        },
        {
          streamId: `harness-log-${randomBytes(12).toString("hex")}`,
          producer: "stderr",
          availableStart: 0,
          availableEnd: 0,
          explicitRetrievalRequired: true,
          insertedIntoControllerConversation: false,
        },
      ],
    });
    appendEvent(run, "harness_run_created");
    const logsDirectory = join(options.dataDir, "harness-runs", harnessRunId);
    await ensurePrivateDirectory(logsDirectory);
    await Promise.all([
      writeFile(logPath(options.dataDir, harnessRunId, "stdout"), Buffer.alloc(0), {
        mode: PRIVATE_FILE_MODE,
      }),
      writeFile(logPath(options.dataDir, harnessRunId, "stderr"), Buffer.alloc(0), {
        mode: PRIVATE_FILE_MODE,
      }),
    ]);
    retained.runs.push(run);
    const response = {
      type: "harness.run.launch.result",
      requestId: request.requestId,
      code: "harness_run_created",
      authorizationClass,
      idempotencyKeyHash,
      revision: run.revision,
      idempotentReplay: false,
      auditId,
      run: publicRun(run),
    };
    retained.launchOutcomes.push({ idempotencyKeyHash, requestFingerprint, response });
    // Everything needed to replay the accepted result and repair its audit is
    // now present in one atomic Host-private snapshot. No accepted audit is
    // published before this canonical commit.
    await options.faultInjector?.("harness_run_launch.before_commit");
    await persist(retained);
    // The Host-private snapshot is already sufficient for exact replay here,
    // but the accepted audit may still need idempotent publication after an
    // interruption. Keep this repairable window distinct from the completed
    // launch commit boundary.
    await options.faultInjector?.("harness_run_launch.after_state_commit");
    await ensureAcceptedLaunchAudits(retained);
    await options.faultInjector?.("harness_run_launch.after_commit");
    setImmediate(() => {
      supervise(structuredClone(run), {
        ...context,
        parameters: structuredClone(parameters.data),
        cancellationGraceMs,
      }).catch(() => undefined);
    });
    return response;
  });

  /** @param {any} request */
  const cancel = (request) => withMutationLock(async () => {
    const authorizationClass = "harness_run_cancellation";
    const idempotencyKeyHash = requestIdempotencyKeyHash(request);
    const requestFingerprint = fingerprint({
      harnessRunId: request.harnessRunId,
      controllerId: request.controllerId,
      controllerSessionId: request.controllerSessionId,
      source: request.source,
      authorizationClass: request.authorizationClass,
    });
    const retained = await readState();
    const existing = retainedCancellationOutcome(retained, idempotencyKeyHash);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        const auditId = await options.recordAudit("harness.run.cancel", "rejected", {
          code: "idempotency_key_conflict",
          authorizationClass,
          idempotencyKeyHash,
          harnessRunId: harnessRunIdSchema.safeParse(request.harnessRunId).success
            ? request.harnessRunId
            : null,
          cancellationAccepted: false,
          cooperativeSignalSent: false,
          forcedTerminationSent: false,
          projectWrite: false,
        });
        return {
          type: "harness.run.cancel.failure",
          requestId: request.requestId,
          code: "idempotency_key_conflict",
          retryable: false,
          authorizationClass,
          idempotencyKeyHash,
          idempotentReplay: false,
          auditId,
          harnessRunId: harnessRunIdSchema.safeParse(request.harnessRunId).success
            ? request.harnessRunId
            : null,
          prohibitedSideEffects: {
            cancellationAccepted: false,
            cooperativeSignalSent: false,
            forcedTerminationSent: false,
            projectWrite: false,
          },
        };
      }
      await options.recordAudit("harness.run.cancel", "observed", {
        code: /** @type {any} */ (existing.response).code,
        authorizationClass,
        idempotencyKeyHash,
        idempotentReplay: true,
        originalAuditId: /** @type {any} */ (existing.response).auditId,
        harnessRunId: /** @type {any} */ (existing.response).harnessRunId,
      });
      if ((/** @type {any} */ (existing.response)).type === "harness.run.cancel.result") {
        const harnessRunId = /** @type {any} */ (existing.response).harnessRunId;
        const cooperativeDeadlineAt = /** @type {any} */ (
          existing.response
        ).cooperativeDeadlineAt;
        acceptedCancellations.set(harnessRunId, cooperativeDeadlineAt);
        setImmediate(() => activeSupervisions.get(harnessRunId)
          ?.requestCancellation(cooperativeDeadlineAt));
      }
      return {
        ...structuredClone(existing.response),
        requestId: request.requestId,
        idempotentReplay: true,
      };
    }

    let failureCode = null;
    if (
      request.authorizationClass !== authorizationClass
      || !idempotencyKeyHash
      || !harnessRunIdSchema.safeParse(request.harnessRunId).success
      || !controllerIdSchema.safeParse(request.controllerId).success
      || !["controller-cli", "cockpit"].includes(request.source)
      || (request.source === "controller-cli"
        ? !controllerSessionIdSchema.safeParse(request.controllerSessionId).success
        : request.controllerSessionId !== null)
    ) {
      failureCode = "mutation_contract_invalid";
    }
    const run = failureCode ? null : retained.runs.find((candidate) =>
      candidate.harnessRunId === request.harnessRunId);
    if (!failureCode && !run) failureCode = "harness_run_not_found";
    if (!failureCode && run
      && (run.outcome !== null || run.cancellation !== null
        || ["succeeded", "failed", "cancelled"].includes(run.status))) {
      failureCode = "harness_run_not_cancellable";
    }

    if (failureCode || !run || !idempotencyKeyHash) {
      const auditId = await options.recordAudit("harness.run.cancel", "rejected", {
        code: failureCode ?? "mutation_contract_invalid",
        authorizationClass,
        idempotencyKeyHash,
        harnessRunId: harnessRunIdSchema.safeParse(request.harnessRunId).success
          ? request.harnessRunId
          : null,
        cancellationAccepted: false,
        cooperativeSignalSent: false,
        forcedTerminationSent: false,
        projectWrite: false,
      });
      const response = {
        type: "harness.run.cancel.failure",
        requestId: typeof request.requestId === "string" ? request.requestId : "invalid-request",
        code: failureCode ?? "mutation_contract_invalid",
        retryable: failureCode === "harness_run_not_found",
        authorizationClass,
        idempotencyKeyHash,
        idempotentReplay: false,
        auditId,
        harnessRunId: harnessRunIdSchema.safeParse(request.harnessRunId).success
          ? request.harnessRunId
          : null,
        prohibitedSideEffects: {
          cancellationAccepted: false,
          cooperativeSignalSent: false,
          forcedTerminationSent: false,
          projectWrite: false,
        },
      };
      if (idempotencyKeyHash) {
        retained.cancellationOutcomes.push({
          idempotencyKeyHash,
          requestFingerprint,
          response,
        });
        await persist(retained);
      }
      return response;
    }

    // Tree inventory is read-only and may safely overlap the durable mutation.
    // Starting it here captures descendants while the adapter is live without
    // moving any signal or accepted lifecycle effect before the commit.
    void activeSupervisions.get(run.harnessRunId)?.prepareCancellation();
    const acceptedDate = now();
    const acceptedAt = acceptedDate.toISOString();
    const cooperativeDeadlineAt = new Date(
      acceptedDate.getTime() + cancellationGraceMs,
    ).toISOString();
    const auditId = `audit-${randomBytes(12).toString("hex")}`;
    run.status = "cancelling";
    run.revision += 1;
    run.cancellation = harnessRunCancellationSchema.parse({
      acceptedAt,
      cooperativeDeadlineAt,
      auditId,
      idempotencyKeyHash,
      cooperativeSignalSentAt: null,
      forcedTerminationSentAt: null,
      terminationConfirmedAt: null,
    });
    appendEvent(run, "harness_run_cancellation_accepted");
    const response = {
      type: "harness.run.cancel.result",
      requestId: request.requestId,
      code: "harness_run_cancellation_accepted",
      authorizationClass,
      idempotencyKeyHash,
      idempotentReplay: false,
      auditId,
      harnessRunId: run.harnessRunId,
      acceptedAt,
      cooperativeDeadlineAt,
    };
    retained.cancellationOutcomes.push({
      idempotencyKeyHash,
      requestFingerprint,
      response,
    });
    await options.faultInjector?.("harness_run_cancellation.before_commit");
    await persist(retained);
    await options.faultInjector?.("harness_run_cancellation.after_state_commit");
    acceptedCancellations.set(run.harnessRunId, cooperativeDeadlineAt);
    void activeSupervisions.get(run.harnessRunId)
      ?.requestCancellation(cooperativeDeadlineAt);
    await ensureAcceptedCancellationAudits(retained);
    await options.faultInjector?.("harness_run_cancellation.after_commit");
    return response;
  });

  /** @param {{requestId: string, harnessRunId: string | null, afterSequence: number}} request */
  const observe = async (request) => {
    const retained = await readState();
    const run = request.harnessRunId
      ? retained.runs.find((candidate) => candidate.harnessRunId === request.harnessRunId)
      : retained.runs.at(-1);
    if (!run) {
      return {
        type: "harness.run.observe.result",
        requestId: request.requestId,
        code: "harness_run_absent",
        mode: "snapshot",
        resynchronization: null,
        run: null,
        events: [],
        nextSequence: 0,
        outcome: null,
        logStreams: [],
        terminalEnvelopeValidation: null,
      };
    }
    const afterSequence = Number.isSafeInteger(request.afterSequence) && request.afterSequence >= 0
      ? request.afterSequence
      : 0;
    const maximumSequence = run.events.at(-1)?.sequence ?? 0;
    const availableFromSequence = run.events[0]?.sequence ?? 0;
    const laterEvents = run.events.filter((event) => event.sequence > afterSequence);
    const historyGap = afterSequence > 0
      && afterSequence < maximumSequence
      && laterEvents.length > 0
      && laterEvents[0].sequence !== afterSequence + 1;
    const cursorIncompatible = afterSequence > maximumSequence;
    const resynchronizationReason = cursorIncompatible
      ? "cursor_incompatible"
      : historyGap
        ? "history_gap"
        : null;
    const resynchronization = resynchronizationReason ? {
      code: "resync-required",
      reason: resynchronizationReason,
      requestedAfterSequence: afterSequence,
      availableFromSequence,
      canonicalSnapshot: true,
    } : null;
    return {
      type: "harness.run.observe.result",
      requestId: request.requestId,
      code: resynchronization ? "resync-required" : "harness_run_observed",
      mode: resynchronization
        ? "resync-required"
        : afterSequence === 0
          ? "snapshot"
          : "resume",
      resynchronization,
      run: publicRun(run),
      events: structuredClone(resynchronization
        ? run.events
        : laterEvents),
      nextSequence: maximumSequence,
      outcome: structuredClone(run.outcome),
      logStreams: structuredClone(run.logStreams),
      terminalEnvelopeValidation: structuredClone(run.terminalEnvelopeValidation),
    };
  };

  /** @param {{requestId: string, harnessRunId: string, producer: "stdout" | "stderr", offset: number, limit: number}} request */
  const readLogs = async (request) => {
    const retained = await readState();
    const run = retained.runs.find((candidate) => candidate.harnessRunId === request.harnessRunId);
    if (!run) {
      throw new Error("harness_run_not_found");
    }
    const stream = run.logStreams.find((candidate) => candidate.producer === request.producer);
    if (
      !stream
      || !Number.isSafeInteger(request.offset)
      || request.offset < 0
      || !Number.isSafeInteger(request.limit)
      || request.limit < 1
      || request.limit > 16_384
    ) {
      throw new Error("harness_log_range_invalid");
    }
    const available = await readFile(logPath(options.dataDir, run.harnessRunId, stream.producer));
    // State is the diagnostic commit boundary. A Host can die after appending
    // bytes but before advancing availableEnd, so never expose that tail as
    // though reconciliation had retained it canonically.
    const durableAvailableEnd = Math.min(stream.availableEnd, available.byteLength);
    const start = Math.min(request.offset, durableAvailableEnd);
    const end = Math.min(start + request.limit, durableAvailableEnd);
    const data = available.subarray(start, end);
    return {
      response: {
        type: "harness.run.logs.result",
        requestId: request.requestId,
        code: "harness_log_range",
        harnessRunId: run.harnessRunId,
        producer: stream.producer,
        streamId: stream.streamId,
        range: {
          start,
          end,
          availableEnd: durableAvailableEnd,
          eof: end === durableAvailableEnd,
        },
        byteLength: data.byteLength,
        sha256: digest(data),
        insertedIntoControllerConversation: false,
      },
      data,
    };
  };

  /** @param {{requestId: string, idempotencyKeyHash?: string, idempotencyKey?: string}} request */
  const lookup = async (request) => {
    const retained = await readState();
    const idempotencyKeyHash = requestIdempotencyKeyHash(request);
    const existing = retainedLaunchOutcome(retained, idempotencyKeyHash);
    return {
      type: "harness.run.lookup.result",
      requestId: request.requestId,
      code: existing ? "harness_run_launch_outcome_found" : "harness_run_launch_outcome_absent",
      idempotencyKeyHash,
      found: Boolean(existing),
      launchOutcome: existing ? structuredClone(existing.response) : null,
    };
  };

  return { launch, cancel, lookup, observe, readLogs };
};

export const harnessRunInternals = Object.freeze({ statePath, logPath });
