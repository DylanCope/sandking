import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  HarnessAdapterProtocolError,
  harnessAdapterEntryPointSchema,
  harnessTerminalEnvelopeSchema,
  loadPinnedHarnessAdapter,
  readHarnessAdapterFrame,
} from "./harness-adapter-protocol.mjs";
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
const runStatusSchema = z.enum(["starting", "running", "succeeded", "failed", "cancelled"]);
const credentialCapabilityReferenceSchema = z.enum([
  "github.issues.read",
  "project.git.read",
]);
const MAX_RETAINED_RUN_EVENTS = 1_024;
// Creation and readiness consume two lifecycle slots. Always reserve the final
// slot for the truthful terminal event, including protocol-invalid outcomes.
const MAX_PROGRESS_RECORDS_PER_RUN = MAX_RETAINED_RUN_EVENTS - 3;
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

const currentHarnessRunSchema = previousHarnessRunSchema.extend({
  executionSnapshot: harnessRunExecutionSnapshotSchema,
}).strict();
const legacyHarnessRunSchema = previousLegacyHarnessRunSchema.extend({
  executionSnapshot: harnessRunExecutionSnapshotSchema,
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
const currentStoredRunSchema = currentHarnessRunSchema.extend(storedRunFields).strict();
const legacyStoredRunSchema = legacyHarnessRunSchema.extend(storedRunFields).strict();
const storedRunSchema = z.union([currentStoredRunSchema, legacyStoredRunSchema]);
const retainedOutcomeSchema = z.object({
  idempotencyKeyHash: digestSchema,
  requestFingerprint: digestSchema,
  response: z.object({}).passthrough(),
}).strict();
const stateSchema = z.object({
  schemaVersion: z.literal(3),
  // Canonical runs and keyed mutation outcomes cannot be evicted without
  // breaking reconnect and ambiguous-outcome lookup. Retention/cleanup is a
  // later explicit workflow; the records themselves remain schema-bounded.
  runs: z.array(storedRunSchema),
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
  schemaVersion: 3,
  runs: [],
  launchOutcomes: [],
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
  }
  return retainedOutcomeSchema.parse(migrated);
};

/**
 * @param {z.infer<typeof previousStateSchema> | z.infer<typeof legacyStateSchema>} previous
 */
const migrateState = (previous) => {
  const runs = previous.runs.map(migrateStoredRun);
  const launchOutcomes = previous.schemaVersion === 2 ? previous.launchOutcomes : [];
  const legacyStartOutcomes = previous.schemaVersion === 2
    ? previous.legacyStartOutcomes
    : previous.startOutcomes;
  return stateSchema.parse({
    schemaVersion: 3,
    runs,
    launchOutcomes: launchOutcomes.map((outcome) => migrateRetainedOutcome(outcome, runs)),
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
 * @param {z.infer<typeof storedRunSchema>} run
 * @param {any} context
 * @param {{onReady: (readyAt: string) => Promise<void>, onProgress: (record: z.infer<typeof progressRecordSchema>) => Promise<void>, onDiagnostic: (producer: "stdout" | "stderr", data: Buffer) => Promise<void>}} observer
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
  // Execute the exact bytes read from the immutable Git object. The worktree
  // comparison detects drift, while the inline source removes the check/use
  // window in which different adapter bytes could otherwise be launched.
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval", pinnedAdapter.pinnedEntryPointSource,
    pinnedAdapter.compatibility.entryPoint,
    "run",
    encodedExecution,
  ], {
    cwd: context.harnessWorkspacePath,
    env: { LANG: "C.UTF-8" },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const adapterChannel = child.stdio[3];
  if (!adapterChannel || !child.stdout || !child.stderr || !("readable" in adapterChannel)) {
    child.kill("SIGKILL");
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
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
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
  const exit = new Promise((resolve) => {
    child.once("error", () => resolve({ code: null, signal: null, startFailed: true }));
    child.once("exit", (code, signal) => resolve({ code, signal, startFailed: false }));
  });
  const [exitResult] = await Promise.all([exit, consumeFrames()]);
  await diagnosticQueue;
  return {
    adapterReadyObserved,
    protocolInvalid,
    terminalEnvelopes,
    adapterChannelClosedObserved,
    exit: exitResult,
  };
};

/**
 * @param {{
 *   dataDir: string,
 *   hostId: string,
 *   recordAudit: (action: string, outcome: "accepted" | "rejected" | "observed", details?: Record<string, unknown>, auditId?: string) => Promise<string>,
 *   loadLaunchContext: (projectId: string) => Promise<any>,
 *   now?: () => Date,
 *   faultInjector?: (point: "harness_run_launch.before_commit" | "harness_run_launch.after_state_commit" | "harness_run_launch.after_commit") => Promise<void> | void,
 * }} options
 */
export const createHarnessRunManager = async (options) => {
  const parsedHostId = hostIdSchema.parse(options.hostId);
  const now = options.now ?? (() => new Date());
  let mutationQueue = Promise.resolve();
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
      return migrated;
    }
    const retained = stateSchema.parse(raw);
    await ensureAcceptedLaunchAudits(retained);
    return retained;
  };
  /** @param {z.infer<typeof stateSchema>} state */
  const persist = (state) => writePrivateJson(
    statePath(options.dataDir),
    stateSchema.parse(state),
  );
  // Complete the one-time upgrade before exposing read and mutation methods.
  // Otherwise a first observation can migrate a stale v1 snapshot concurrently
  // with a first launch and overwrite the newly retained run.
  await readState();
  /** @param {z.infer<typeof stateSchema>} state @param {string | null} idempotencyKeyHash */
  const retainedMutationOutcome = (state, idempotencyKeyHash) => idempotencyKeyHash
    ? state.launchOutcomes.find((outcome) =>
        outcome.idempotencyKeyHash === idempotencyKeyHash)
      ?? state.legacyStartOutcomes.find((outcome) =>
        outcome.idempotencyKeyHash === idempotencyKeyHash)
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
    /** @type {Array<z.infer<typeof progressRecordSchema>>} */
    const pendingProgressRecords = [];
    let progressRecordCount = 0;
    const persistProgressRecords = async () => {
      if (pendingProgressRecords.length === 0) {
        return;
      }
      const records = pendingProgressRecords.slice();
      await updateRun(initialRun.harnessRunId, (run) => {
        for (const record of records) {
          run.revision += 1;
          appendEvent(run, "harness_progress_published", { progressRecord: record });
        }
      });
      pendingProgressRecords.splice(0, records.length);
    };
    try {
      supervision = await superviseConformanceHarness(initialRun, context, {
        onReady: async (readyAt) => {
          await updateRun(initialRun.harnessRunId, (run) => {
            if (run.status !== "starting") {
              throw new Error("harness_run_state_invalid");
            }
            run.status = "running";
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
      };
    }
    await persistProgressRecords();
    const terminal = supervision.terminalEnvelopes.length === 1
      ? supervision.terminalEnvelopes[0]
      : null;
    const validTerminal = terminal && !supervision.protocolInvalid;
    const status = validTerminal ? terminal.status : "failed";
    const code = supervision.exit.startFailed
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
    const outcomeId = `harness-outcome-${randomBytes(12).toString("hex")}`;
    const completedAt = now().toISOString();
    const finalized = await updateRun(initialRun.harnessRunId, (run) => {
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
        incompleteResult: !validTerminal,
        result: validTerminal ? terminal.result : null,
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
        terminalEnvelope: validTerminal ? {
          terminalId: terminal.terminalId,
          status: terminal.status,
          adapterId: terminal.adapterId,
          adapterProtocol: terminal.adapterProtocol,
        } : null,
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
    });
    await options.recordAudit("harness.run.outcome", "observed", {
      harnessRunId: finalized.harnessRunId,
      projectId: finalized.projectId,
      outcomeReference: outcomeId,
      status,
      code,
      incompleteResult: !validTerminal,
      adapterReadyObserved: supervision.adapterReadyObserved,
      validTerminalEnvelopeCount: supervision.terminalEnvelopes.length,
      adapterChannelClosedObserved: supervision.adapterChannelClosedObserved,
      processExitObserved: !supervision.exit.startFailed,
      stdoutRange: finalized.logStreams[0].availableEnd,
      stderrRange: finalized.logStreams[1].availableEnd,
    });
  };

  /** @param {any} request */
  const launch = (request) => withMutationLock(async () => {
    const authorizationClass = "harness_run_launch";
    const idempotencyKeyHash = requestIdempotencyKeyHash(request);
    const requestFingerprint = fingerprint({
      projectId: request.projectId,
      parameters: request.parameters === undefined ? {} : request.parameters,
      controllerId: request.controllerId,
      controllerSessionId: request.controllerSessionId,
      source: request.source,
      authorizationClass: request.authorizationClass,
    });
    const retained = await readState();
    const existing = retainedMutationOutcome(retained, idempotencyKeyHash);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
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
      }).catch(() => undefined);
    });
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
    const start = Math.min(request.offset, available.byteLength);
    const end = Math.min(start + request.limit, available.byteLength);
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
          availableEnd: available.byteLength,
          eof: end === available.byteLength,
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
    const existing = retainedMutationOutcome(retained, idempotencyKeyHash);
    return {
      type: "harness.run.lookup.result",
      requestId: request.requestId,
      code: existing ? "harness_run_launch_outcome_found" : "harness_run_launch_outcome_absent",
      idempotencyKeyHash,
      found: Boolean(existing),
      launchOutcome: existing ? structuredClone(existing.response) : null,
    };
  };

  return { launch, lookup, observe, readLogs };
};

export const harnessRunInternals = Object.freeze({ statePath, logPath });
