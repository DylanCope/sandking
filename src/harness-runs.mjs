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
import { prepareConformanceHarnessLaunch } from "./launch-requests.mjs";
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
const launchRequestIdSchema = z.string().regex(/^launch-request-[a-f0-9]{24}$/);
const harnessRunIdSchema = z.string().regex(/^harness-run-[a-f0-9]{24}$/);
const outcomeIdSchema = z.string().regex(/^harness-outcome-[a-f0-9]{24}$/);
const eventIdSchema = z.string().regex(/^harness-event-[a-f0-9]{24}$/);
const logStreamIdSchema = z.string().regex(/^harness-log-[a-f0-9]{24}$/);
const controllerIdSchema = z.string().regex(/^runtime-[a-f0-9]{24}$/);
const controllerSessionIdSchema = z.string().regex(/^controller-session-[a-f0-9]{24}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const runStatusSchema = z.enum(["starting", "running", "succeeded", "failed", "cancelled"]);

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

export const harnessRunSchema = z.object({
  harnessRunId: harnessRunIdSchema,
  revision: z.number().int().positive(),
  status: runStatusSchema,
  launchRequestId: launchRequestIdSchema,
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

const storedRunSchema = harnessRunSchema.extend({
  events: z.array(harnessRunEventSchema).max(1_024),
  outcome: harnessRunOutcomeSchema.nullable(),
  terminalEnvelopeValidation: terminalEnvelopeValidationSchema,
  logStreams: z.tuple([logStreamSchema, logStreamSchema]),
}).strict();
const retainedOutcomeSchema = z.object({
  idempotencyKeyHash: digestSchema,
  requestFingerprint: digestSchema,
  response: z.object({}).passthrough(),
}).strict();
const stateSchema = z.object({
  schemaVersion: z.literal(1),
  runs: z.array(storedRunSchema).max(256),
  startOutcomes: z.array(retainedOutcomeSchema).max(256),
}).strict();

const initialState = () => ({ schemaVersion: 1, runs: [], startOutcomes: [] });
/** @param {string} dataDir */
const statePath = (dataDir) => join(dataDir, "harness-runs.json");
/** @param {string} dataDir @param {string} harnessRunId @param {"stdout" | "stderr"} producer */
const logPath = (dataDir, harnessRunId, producer) =>
  join(dataDir, "harness-runs", harnessRunId, `${producer}.log`);
/** @param {string | Buffer} value */
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
/** @param {unknown} value */
const fingerprint = (value) => digest(JSON.stringify(value));

/** @param {z.infer<typeof storedRunSchema>} run */
const publicRun = (run) => harnessRunSchema.parse({
  harnessRunId: run.harnessRunId,
  revision: run.revision,
  status: run.status,
  launchRequestId: run.launchRequestId,
  launchRequestRevision: run.launchRequestRevision,
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
  startAuditId: run.startAuditId,
});

/**
 * @param {z.infer<typeof storedRunSchema>} run
 * @param {z.infer<typeof harnessRunEventSchema>["type"]} type
 * @param {{progressRecord?: z.infer<typeof progressRecordSchema> | null, outcomeReference?: string | null}} [details]
 */
const appendEvent = (run, type, details = {}) => {
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
        protocolInvalid = true;
        return;
      }
      if (
        message.type === "harness.adapter.probe"
        || message.type === "harness.launch.prepared"
      ) {
        protocolInvalid = true;
        continue;
      }
      if (
        message.harnessRunId !== run.harnessRunId
        || message.adapterId !== run.adapterId
        || message.adapterProtocol !== run.adapterProtocol
      ) {
        protocolInvalid = true;
        continue;
      }
      if (message.type === "harness.run.ready") {
        if (adapterReadyObserved) {
          protocolInvalid = true;
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
          || publishedProgressRecordIds.has(message.record.recordId)
          || (message.record.parentRecordId !== null
            && !publishedProgressRecordIds.has(message.record.parentRecordId))
        ) {
          protocolInvalid = true;
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
      protocolInvalid = true;
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
 *   recordAudit: (action: string, outcome: "accepted" | "rejected" | "observed", details?: Record<string, unknown>) => Promise<string>,
 *   launchRequests: {get: (launchRequestId: string) => Promise<any>, expireExecutionAuthorization: (request: any) => Promise<any>, claimExecution: (request: any) => Promise<any>, completeExecution: (request: any) => Promise<any>},
 *   loadLaunchContext: (projectId: string) => Promise<any>,
 *   now?: () => Date,
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
  const readState = async () => stateSchema.parse(
    await readJson(statePath(options.dataDir), initialState()),
  );
  /** @param {z.infer<typeof stateSchema>} state */
  const persist = (state) => writePrivateJson(statePath(options.dataDir), state);

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
          await updateRun(initialRun.harnessRunId, (run) => {
            run.revision += 1;
            appendEvent(run, "harness_progress_published", { progressRecord: record });
          });
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
    await options.launchRequests.completeExecution({
      launchRequestId: finalized.launchRequestId,
      harnessRunId: finalized.harnessRunId,
      status,
      outcomeReference: outcomeId,
    });
    await options.recordAudit("harness.run.outcome", "observed", {
      harnessRunId: finalized.harnessRunId,
      launchRequestId: finalized.launchRequestId,
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
  const start = (request) => withMutationLock(async () => {
    const authorizationClass = "approved_launch_request_execution";
    const keyValid = typeof request.idempotencyKey === "string"
      && request.idempotencyKey.length > 0
      && request.idempotencyKey.length <= 256;
    const idempotencyKeyHash = keyValid ? digest(request.idempotencyKey) : null;
    const requestFingerprint = fingerprint({
      launchRequestId: request.launchRequestId,
      controllerId: request.controllerId,
      controllerSessionId: request.controllerSessionId,
      authorizationClass: request.authorizationClass,
      expectedRevision: request.expectedRevision,
    });
    const retained = await readState();
    const existing = idempotencyKeyHash
      ? retained.startOutcomes.find((outcome) =>
          outcome.idempotencyKeyHash === idempotencyKeyHash)
      : null;
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        const launchRequest = await options.launchRequests.get(request.launchRequestId);
        const auditId = await options.recordAudit("harness.run.start", "rejected", {
          code: "idempotency_key_conflict",
          authorizationClass,
          idempotencyKeyHash,
          expectedRevision: Number.isSafeInteger(request.expectedRevision)
            ? request.expectedRevision
            : null,
          actualRevision: launchRequest?.revision ?? 0,
          harnessRunStarted: false,
        });
        return {
          type: "harness.run.start.failure",
          requestId: request.requestId,
          code: "idempotency_key_conflict",
          retryable: false,
          authorizationClass,
          idempotencyKeyHash,
          expectedRevision: request.expectedRevision,
          actualRevision: launchRequest?.revision ?? 0,
          idempotentReplay: false,
          auditId,
          current: launchRequest,
          prohibitedSideEffects: { harnessRunStarted: false, projectWrite: false },
        };
      }
      await options.recordAudit("harness.run.start", "observed", {
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

    let launchRequest = launchRequestIdSchema.safeParse(request.launchRequestId).success
      ? await options.launchRequests.get(request.launchRequestId)
      : null;
    let code = null;
    if (
      request.authorizationClass !== authorizationClass
      || !idempotencyKeyHash
      || !launchRequestIdSchema.safeParse(request.launchRequestId).success
      || !controllerIdSchema.safeParse(request.controllerId).success
      || !controllerSessionIdSchema.safeParse(request.controllerSessionId).success
      || !Number.isSafeInteger(request.expectedRevision)
      || request.expectedRevision < 1
    ) {
      code = "mutation_contract_invalid";
    } else if (!launchRequest) {
      code = "launch_request_not_found";
    } else if (launchRequest.owner.controllerId !== request.controllerId
      || launchRequest.owner.controllerSessionId !== request.controllerSessionId) {
      code = "authorization_failed";
    } else if (launchRequest.status === "pending") {
      code = "launch_request_unapproved";
    } else if (launchRequest.status !== "approved") {
      code = "launch_request_terminal";
    } else if (now().getTime() >= Date.parse(launchRequest.expiresAt)) {
      code = "launch_request_expired";
    } else if (launchRequest.execution.status !== "not_started") {
      const canonical = retained.runs.find((run) =>
        run.harnessRunId === launchRequest.execution.harnessRunId);
      if (canonical) {
        const auditId = await options.recordAudit("harness.run.start", "observed", {
          authorizationClass,
          idempotencyKeyHash,
          expectedRevision: request.expectedRevision,
          actualRevision: launchRequest.revision,
          launchRequestId: launchRequest.launchRequestId,
          harnessRunId: canonical.harnessRunId,
          canonicalRunFound: true,
        });
        const response = {
          type: "harness.run.start.result",
          requestId: request.requestId,
          code: "harness_run_found",
          authorizationClass,
          idempotencyKeyHash,
          expectedRevision: request.expectedRevision,
          launchRequestRevision: launchRequest.revision,
          revision: canonical.revision,
          idempotentReplay: false,
          auditId,
          run: publicRun(canonical),
        };
        retained.startOutcomes.push({ idempotencyKeyHash, requestFingerprint, response });
        await persist(retained);
        return response;
      }
      code = "launch_request_already_started";
    } else if (launchRequest.revision !== request.expectedRevision) {
      code = "mutation_revision_conflict";
    }

    if (code === "launch_request_expired" && launchRequest) {
      const observedAt = now().toISOString();
      launchRequest = await options.launchRequests.expireExecutionAuthorization({
        launchRequestId: launchRequest.launchRequestId,
        expectedRevision: launchRequest.revision,
        reason: "launch_request_expired",
        observedAt,
      });
    }

    let context;
    if (!code && launchRequest) {
      try {
        context = await options.loadLaunchContext(launchRequest.project.projectId);
        const prepared = await prepareConformanceHarnessLaunch(context, launchRequest.parameters);
        if (
          context.project.projectId !== launchRequest.project.projectId
          || context.project.revision !== launchRequest.project.revision
          || context.harness.harnessId !== launchRequest.harness.harnessId
          || context.harness.immutableRevision !== launchRequest.harness.pinnedRevision
          || prepared.adapterId !== launchRequest.harness.adapterId
          || prepared.adapterProtocol !== launchRequest.harness.adapterProtocol
          || prepared.adapterEntryPoint !== launchRequest.harness.adapterEntryPoint
          || JSON.stringify(prepared.suppliedCapabilities)
            !== JSON.stringify(launchRequest.suppliedCapabilities)
          || prepared.sanitizedPreview.summary !== launchRequest.preview.summary
        ) {
          code = "launch_request_stale";
        }
      } catch {
        code = "launch_request_stale";
      }
      if (code === "launch_request_stale") {
        const observedAt = now().toISOString();
        launchRequest = await options.launchRequests.expireExecutionAuthorization({
          launchRequestId: launchRequest.launchRequestId,
          expectedRevision: launchRequest.revision,
          reason: "launch_request_stale",
          observedAt,
        });
      }
    }

    if (code || !launchRequest || !context || !idempotencyKeyHash) {
      const failureCode = code ?? "mutation_contract_invalid";
      const auditId = await options.recordAudit("harness.run.start", "rejected", {
        code: failureCode,
        authorizationClass,
        idempotencyKeyHash,
        expectedRevision: Number.isSafeInteger(request.expectedRevision)
          ? request.expectedRevision
          : null,
        actualRevision: launchRequest?.revision ?? 0,
        launchRequestId: launchRequest?.launchRequestId ?? null,
        hostId: launchRequest?.host.hostId ?? parsedHostId,
        projectId: launchRequest?.project.projectId ?? null,
        harnessId: launchRequest?.harness.harnessId ?? null,
        harnessRunStarted: false,
        projectWrite: false,
      });
      const response = {
        type: "harness.run.start.failure",
        requestId: typeof request.requestId === "string" ? request.requestId : "invalid-request",
        code: failureCode,
        retryable: [
          "mutation_revision_conflict",
          "launch_request_not_found",
        ].includes(failureCode),
        authorizationClass,
        idempotencyKeyHash,
        expectedRevision: Number.isSafeInteger(request.expectedRevision)
          ? request.expectedRevision
          : null,
        actualRevision: launchRequest?.revision ?? 0,
        idempotentReplay: false,
        auditId,
        current: launchRequest,
        prohibitedSideEffects: { harnessRunStarted: false, projectWrite: false },
      };
      if (idempotencyKeyHash) {
        retained.startOutcomes.push({ idempotencyKeyHash, requestFingerprint, response });
        await persist(retained);
      }
      return response;
    }

    const harnessRunId = `harness-run-${randomBytes(12).toString("hex")}`;
    const createdAt = now().toISOString();
    const auditId = await options.recordAudit("harness.run.start", "accepted", {
      authorizationClass,
      idempotencyKeyHash,
      expectedRevision: request.expectedRevision,
      launchRequestId: launchRequest.launchRequestId,
      harnessRunId,
      hostId: launchRequest.host.hostId,
      projectId: launchRequest.project.projectId,
      harnessId: launchRequest.harness.harnessId,
      harnessPinnedRevision: launchRequest.harness.pinnedRevision,
      controllerId: request.controllerId,
      controllerSessionId: request.controllerSessionId,
      adapterId: launchRequest.harness.adapterId,
      adapterProtocol: launchRequest.harness.adapterProtocol,
      adapterEntryPoint: launchRequest.harness.adapterEntryPoint,
      returnedBeforeTerminal: true,
      projectWrite: false,
    });
    const run = storedRunSchema.parse({
      harnessRunId,
      revision: 1,
      status: "starting",
      launchRequestId: launchRequest.launchRequestId,
      launchRequestRevision: launchRequest.revision,
      hostId: launchRequest.host.hostId,
      projectId: launchRequest.project.projectId,
      harnessId: launchRequest.harness.harnessId,
      harnessPinnedRevision: launchRequest.harness.pinnedRevision,
      adapterId: launchRequest.harness.adapterId,
      adapterProtocol: launchRequest.harness.adapterProtocol,
      adapterEntryPoint: launchRequest.harness.adapterEntryPoint,
      controllerId: request.controllerId,
      controllerSessionId: request.controllerSessionId,
      createdAt,
      adapterReadyAt: null,
      completedAt: null,
      startAuditId: auditId,
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
    const linkedLaunch = await options.launchRequests.claimExecution({
      launchRequestId: launchRequest.launchRequestId,
      expectedRevision: request.expectedRevision,
      harnessRunId,
    });
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
      type: "harness.run.start.result",
      requestId: request.requestId,
      code: "harness_run_created",
      authorizationClass,
      idempotencyKeyHash,
      expectedRevision: request.expectedRevision,
      launchRequestRevision: linkedLaunch.revision,
      revision: run.revision,
      idempotentReplay: false,
      auditId,
      run: publicRun(run),
    };
    retained.startOutcomes.push({ idempotencyKeyHash, requestFingerprint, response });
    await persist(retained);
    setImmediate(() => {
      supervise(structuredClone(run), {
        ...context,
        parameters: structuredClone(launchRequest.parameters),
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
    const resynchronize = afterSequence > maximumSequence;
    return {
      type: "harness.run.observe.result",
      requestId: request.requestId,
      code: "harness_run_observed",
      mode: afterSequence === 0 || resynchronize ? "snapshot" : "resume",
      run: publicRun(run),
      events: structuredClone(resynchronize
        ? run.events
        : run.events.filter((event) => event.sequence > afterSequence)),
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

  /** @param {{requestId: string, idempotencyKey: string}} request */
  const lookup = async (request) => {
    const retained = await readState();
    const idempotencyKeyHash = typeof request.idempotencyKey === "string"
      && request.idempotencyKey.length > 0
      && request.idempotencyKey.length <= 256
      ? digest(request.idempotencyKey)
      : null;
    const existing = idempotencyKeyHash
      ? retained.startOutcomes.find((outcome) => outcome.idempotencyKeyHash === idempotencyKeyHash)
      : null;
    return {
      type: "harness.run.lookup.result",
      requestId: request.requestId,
      code: existing ? "harness_run_start_outcome_found" : "harness_run_start_outcome_absent",
      idempotencyKeyHash,
      found: Boolean(existing),
      startOutcome: existing ? structuredClone(existing.response) : null,
    };
  };

  return { start, lookup, observe, readLogs };
};

export const harnessRunInternals = Object.freeze({ statePath, logPath });
