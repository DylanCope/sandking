import { spawn as spawnChild } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "@lydell/node-pty";
import { z } from "zod";
import { createClaudeDestinationEnvironment } from "./claude-provider-adapter.mjs";
import { readJson, writePrivateJson } from "./private-state.mjs";

const conformanceAdapterPath = fileURLToPath(
  new URL("./conformance-provider-adapter.mjs", import.meta.url),
);
const claudeAdapterPath = fileURLToPath(new URL("./claude-provider-adapter.mjs", import.meta.url));
const adapterIdSchema = z.enum([
  "conformance-controller-adapter-v1",
  "claude-code-controller-adapter-v1",
]);
const providerIdSchema = z.enum(["conformance-controller-v1", "claude-code"]);
const providerSessionIdSchema = z.union([
  z.string().regex(/^conformance-provider-session-[a-f0-9]{24}$/),
  z.string().uuid(),
]);
const providerDefinitions = Object.freeze({
  "conformance-controller-v1": Object.freeze({
    adapterPath: conformanceAdapterPath,
    adapterId: "conformance-controller-adapter-v1",
    createSessionId: () => `conformance-provider-session-${randomBytes(12).toString("hex")}`,
  }),
  "claude-code": Object.freeze({
    adapterPath: claudeAdapterPath,
    adapterId: "claude-code-controller-adapter-v1",
    createSessionId: () => randomUUID(),
  }),
});
const identifierSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9._:-]+$/);
const adapterProtocolSchema = z.object({
  major: z.literal(1),
  minor: z.number().int().nonnegative(),
  patch: z.number().int().nonnegative(),
  version: z.string().regex(/^1\.[0-9]+\.[0-9]+$/),
}).strict();
const providerSchema = z.discriminatedUnion("providerId", [
  z.object({
    providerId: z.literal("conformance-controller-v1"),
    kind: z.literal("conformance"),
    fixture: z.literal(true),
  }).strict(),
  z.object({
    providerId: z.literal("claude-code"),
    kind: z.literal("production"),
    fixture: z.literal(false),
  }).strict(),
]);
const reportedCapabilitiesSchema = z.array(z.enum([
  "controller.session.start",
  "controller.session.interactive",
  "controller.session.terminate",
  "controller.work-context.inspect",
  "controller.launch-request.prepare",
  "controller.launch-request.decide",
  "controller.harness-run.start",
  "controller.session.stable-identity",
  "controller.session.typed-exit",
])).max(9).refine((capabilities) => new Set(capabilities).size === capabilities.length);
const operationalCapabilitiesSchema = reportedCapabilitiesSchema.refine((capabilities) =>
  capabilities.includes("controller.session.start")
  && capabilities.includes("controller.session.interactive")
  && capabilities.includes("controller.session.terminate"));
const availabilitySchema = z.object({
  status: z.enum(["available", "unavailable", "unauthenticated"]),
  command: z.literal("claude"),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/).nullable(),
  authentication: z.object({
    status: z.enum(["authenticated", "missing", "unknown"]),
    source: z.literal("destination-local"),
  }).strict(),
  failure: z.object({
    code: z.enum([
      "provider_cli_unavailable",
      "provider_cli_probe_failed",
      "provider_cli_incompatible",
      "provider_authentication_missing",
      "provider_adapter_failed",
    ]),
    retryable: z.boolean(),
  }).strict().nullable(),
}).strict();
const integrationSchema = z.object({
  pluginId: z.literal("sandking-controller"),
  pluginVersion: z.literal("1.0.0"),
  scope: z.literal("session"),
  loading: z.literal("--plugin-dir"),
  installed: z.literal(false),
  boundary: z.literal("session-plugin-private-typed-shim"),
  credentialsTransferred: z.literal(false),
}).strict();
const probeSchema = z.object({
  type: z.literal("provider.adapter.probe"),
  adapterProtocol: adapterProtocolSchema,
  adapterId: adapterIdSchema,
  provider: providerSchema,
  availability: availabilitySchema.optional(),
  capabilities: reportedCapabilitiesSchema,
  terminal: z.object({
    ptyRequired: z.literal(true),
    runtimeOwnershipRequired: z.literal(true),
  }).strict(),
  integration: integrationSchema.optional(),
}).strict().superRefine((probe, context) => {
  const expected = providerDefinitions[probe.provider.providerId];
  if (expected.adapterId !== probe.adapterId) {
    context.addIssue({ code: "custom", message: "provider adapter identity mismatch" });
  }
  if (probe.provider.providerId === "claude-code" && !probe.availability) {
    context.addIssue({ code: "custom", message: "Claude availability missing" });
  }
  if (
    probe.availability?.status === "available"
    && probe.capabilities.length !== 9
  ) {
    context.addIssue({ code: "custom", message: "available provider capabilities incomplete" });
  }
});
const sessionIdentitySchema = z.object({
  stable: z.literal(true),
  source: z.literal("controller-assigned-supported-cli-flag"),
}).strict();
const preparedSchema = z.object({
  type: z.literal("provider.session.prepared"),
  adapterProtocol: adapterProtocolSchema,
  adapterId: adapterIdSchema,
  provider: providerSchema,
  providerSessionId: providerSessionIdSchema,
  capabilities: operationalCapabilitiesSchema,
  terminal: z.object({
    ptyRequired: z.literal(true),
    columns: z.number().int().min(20).max(500),
    rows: z.number().int().min(5).max(200),
  }).strict(),
  control: z.object({
    protocol: adapterProtocolSchema,
    readySignal: z.literal("provider.session.ready"),
    exitSignal: z.literal("provider.session.exit").optional(),
    endpoint: z.string().min(1).max(512),
  }).strict(),
  sessionIdentity: sessionIdentitySchema.optional(),
  integration: integrationSchema.extend({
    pluginDirectory: z.string().min(1).max(4_096),
  }).strict().optional(),
  command: z.object({
    executable: z.string().min(1),
    args: z.array(z.string()).min(1).max(32),
    providerArgs: z.array(z.string()).max(16).optional(),
    environment: z.record(z.string(), z.string()).refine((environment) =>
      !Object.keys(environment).some((name) => /secret|token|credential|key/i.test(name))),
  }).strict(),
}).strict().superRefine((prepared, context) => {
  const expected = providerDefinitions[prepared.provider.providerId];
  if (expected.adapterId !== prepared.adapterId) {
    context.addIssue({ code: "custom", message: "provider adapter identity mismatch" });
  }
});
const providerReadySchema = z.object({
  type: z.literal("provider.session.ready"),
  controlProtocol: adapterProtocolSchema,
  adapterId: adapterIdSchema,
  sessionId: z.string().regex(/^controller-session-[a-f0-9]{24}$/),
  providerSessionId: providerSessionIdSchema,
  workContext: z.object({
    workContextId: identifierSchema,
    canonicalReference: z.string().regex(
      /^(?:github:fixture:issue:[0-9]+|sandking:project:project-[a-f0-9]{24})$/,
    ),
  }).strict(),
  sessionIdentity: sessionIdentitySchema.optional(),
  process: z.object({
    pid: z.number().int().positive(),
  }).strict(),
  terminal: z.object({
    stdinTty: z.literal(true),
    stdoutTty: z.literal(true),
  }).strict(),
}).strict();
const providerExitReasonSchema = z.object({
  code: z.enum([
    "provider_session_completed",
    "provider_cli_unavailable",
    "provider_cli_incompatible",
    "provider_authentication_missing",
    "provider_authentication_failed",
    "provider_network_unavailable",
    "provider_outage",
    "provider_quota_unavailable",
    "provider_model_behavior_unconfirmed",
    "provider_process_exit_unclassified",
    "provider_adapter_failed",
    "runtime_terminated",
  ]),
  retryable: z.boolean(),
  source: z.enum([
    "claude-cli",
    "claude-stop-failure",
    "sandking-adapter",
    "controller-runtime",
    "conformance-provider",
  ]),
}).strict();
const providerFailureSchema = z.object({
  type: z.literal("provider.session.failure"),
  controlProtocol: adapterProtocolSchema,
  adapterId: adapterIdSchema,
  sessionId: z.string().regex(/^controller-session-[a-f0-9]{24}$/),
  providerSessionId: providerSessionIdSchema,
  failure: providerExitReasonSchema,
}).strict();
const providerExitSchema = z.object({
  type: z.literal("provider.session.exit"),
  controlProtocol: adapterProtocolSchema,
  adapterId: adapterIdSchema,
  sessionId: z.string().regex(/^controller-session-[a-f0-9]{24}$/),
  providerSessionId: providerSessionIdSchema,
  reason: providerExitReasonSchema,
}).strict();
const planningWorkContextSchema = z.object({
  workContextId: identifierSchema,
  kind: z.literal("planning-stage"),
  canonicalReference: z.string().regex(/^github:fixture:issue:[0-9]+$/),
}).strict();
const projectWorkContextSchema = z.object({
  workContextId: z.string().regex(/^project-[a-f0-9]{24}$/),
  kind: z.literal("project"),
  canonicalReference: z.string().regex(/^sandking:project:project-[a-f0-9]{24}$/),
}).strict();
const workContextSchema = z.discriminatedUnion("kind", [
  planningWorkContextSchema,
  projectWorkContextSchema,
]);
const providerOperationRequestSchema = z.object({
  type: z.literal("provider.operation.request"),
  controlProtocol: adapterProtocolSchema,
  operationId: identifierSchema,
  sessionId: z.string().regex(/^controller-session-[a-f0-9]{24}$/),
  providerSessionId: providerSessionIdSchema,
  operation: z.enum([
    "work-context.inspect",
    "launch-request.prepare",
    "launch-request.decide",
    "harness-run.start",
    "harness-run.lookup",
  ]),
  input: z.unknown(),
}).strict();
const retainedSessionSchema = z.object({
  sessionId: z.string().regex(/^controller-session-[a-f0-9]{24}$/),
  providerSessionId: providerSessionIdSchema,
  providerId: providerIdSchema,
  providerAdapterId: adapterIdSchema,
  adapterProtocol: z.string().regex(/^1\.[0-9]+\.[0-9]+$/),
  capabilities: operationalCapabilitiesSchema,
  providerAvailability: availabilitySchema.optional(),
  sessionIdentity: sessionIdentitySchema.optional(),
  workContextId: identifierSchema,
  workContextKind: z.enum(["planning-stage", "project"]).optional(),
  canonicalReference: z.string().regex(
    /^(?:github:fixture:issue:[0-9]+|sandking:project:project-[a-f0-9]{24})$/,
  ),
  providerControl: z.object({
    protocol: z.literal("1.0.0"),
    readySignal: z.literal("provider.session.ready"),
    readyObservedAt: z.string(),
    providerObservedTty: z.literal(true),
  }).strict(),
  terminal: z.object({
    streamId: z.string().regex(/^controller-terminal-[a-f0-9]{24}$/),
    runtimeOwned: z.literal(true),
    kind: z.literal("pty"),
    status: z.enum(["running", "exited", "interrupted"]),
    startedAt: z.string(),
    exitedAt: z.string().nullable(),
    exitCode: z.number().int().nullable(),
    signal: z.number().int().nullable(),
    exitReason: providerExitReasonSchema.nullable().optional(),
  }).strict(),
}).strict();
const retainedStateSchema = z.object({
  schemaVersion: z.literal(1),
  sessions: z.array(retainedSessionSchema).max(128),
}).strict();

export class ControllerSessionError extends Error {
  /** @param {string} code @param {Record<string, unknown> | null} [retainedOutcome] */
  constructor(code, retainedOutcome = null) {
    super(code);
    this.name = "ControllerSessionError";
    this.code = code;
    this.retainedOutcome = retainedOutcome;
  }
}

/**
 * @param {{adapterPath: string, adapterId: string}} definition
 * @param {string} providerId
 * @param {string} mode
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} environmentSource
 */
const invokeAdapter = async (
  definition,
  providerId,
  mode,
  args = [],
  environmentSource = process.env,
) => new Promise((resolve, reject) => {
  /** @type {NodeJS.ProcessEnv} */
  const environment = providerId === "claude-code"
    ? createClaudeDestinationEnvironment(environmentSource)
    : { LANG: "C.UTF-8" };
  const child = spawnChild(process.execPath, [definition.adapterPath, mode, ...args], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: environment,
  });
  /** @type {Buffer[]} */
  const stdout = [];
  /** @type {Buffer[]} */
  const stderr = [];
  let size = 0;
  let settled = false;
  /** @param {Error | null} error @param {unknown} [value] */
  const finish = (error, value) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timeout);
    if (error) {
      reject(error);
    } else {
      resolve(value);
    }
  };
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    finish(new ControllerSessionError("provider_adapter_timeout"));
  }, 30_000);
  child.stdout.on("data", (/** @type {Buffer} */ chunk) => {
    size += chunk.byteLength;
    if (size <= 32_768) {
      stdout.push(Buffer.from(chunk));
    }
  });
  child.stderr.on("data", (/** @type {Buffer} */ chunk) => {
    if (Buffer.concat(stderr).byteLength < 1_024) {
      stderr.push(Buffer.from(chunk).subarray(0, 1_024));
    }
  });
  child.once("error", () => finish(new ControllerSessionError("provider_adapter_unavailable")));
  child.once("exit", (code) => {
    if (code !== 0 || size > 32_768) {
      const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
      const typedCode = new Set([
        "provider_cli_unavailable",
        "provider_cli_probe_failed",
        "provider_cli_incompatible",
        "provider_authentication_missing",
        "provider_adapter_failed",
      ]).has(diagnostic) ? diagnostic : "provider_adapter_failed";
      finish(new ControllerSessionError(typedCode));
      return;
    }
    try {
      finish(null, JSON.parse(Buffer.concat(stdout).toString("utf8")));
    } catch {
      finish(new ControllerSessionError("provider_adapter_protocol_invalid"));
    }
  });
});

/**
 * @param {{
 *   sessionId: string,
 *   providerSessionId: string,
 *   workContext: z.infer<typeof workContextSchema>,
 *   adapterId: string,
 *   handleOperation?: (request: {sessionId: string, providerSessionId: string, workContext: z.infer<typeof workContextSchema>, operation: string, input: unknown}) => Promise<unknown>,
 *   handleLifecycle?: (event: "failure" | "exit", reason: z.infer<typeof providerExitReasonSchema>) => Promise<void> | void,
 *   recordAudit: (action: string, outcome: "accepted" | "rejected" | "observed", details?: Record<string, unknown>) => Promise<string>,
 * }} context
 */
const openProviderControl = async (context) => {
  const controlDirectory = process.platform === "win32"
    ? null
    : await mkdtemp(join(tmpdir(), "sandking-provider-control-"));
  const endpoint = controlDirectory
    ? join(controlDirectory, "ready.sock")
    : `\\\\.\\pipe\\sandking-provider-${randomBytes(18).toString("hex")}`;
  let readySettled = false;
  let closed = false;
  /** @type {import("node:net").Socket | undefined} */
  let controlSocket;
  /** @type {NodeJS.Timeout | undefined} */
  let timeout;
  /** @type {Map<string, string>} */
  const controllerAuditByRetainedOutcome = new Map();
  /** @type {(value: z.infer<typeof providerReadySchema>) => void} */
  let resolveReady = () => undefined;
  /** @type {(reason?: unknown) => void} */
  let rejectReady = () => undefined;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  /**
   * @param {ControllerSessionError | null} error
   * @param {z.infer<typeof providerReadySchema> | undefined} [value]
   */
  const finishReady = (error, value) => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    clearTimeout(timeout);
    if (error) {
      rejectReady(error);
    } else if (value) {
      resolveReady(value);
    } else {
      rejectReady(new ControllerSessionError("provider_control_protocol_invalid"));
    }
  };
  const server = createNetServer((socket) => {
    if (controlSocket) {
      socket.destroy();
      return;
    }
    controlSocket = socket;
    let input = "";
    let readyReceived = false;
    let operationProcessing = Promise.resolve();
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > 32_768) {
        finishReady(new ControllerSessionError("provider_control_frame_too_large"));
        socket.destroy();
        return;
      }
      while (input.includes("\n")) {
        const newline = input.indexOf("\n");
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        if (!readyReceived) {
          try {
            const readyMessage = providerReadySchema.parse(JSON.parse(line));
            readyReceived = true;
            finishReady(null, readyMessage);
          } catch {
            finishReady(new ControllerSessionError("provider_control_protocol_invalid"));
            socket.destroy();
          }
          continue;
        }
        operationProcessing = operationProcessing.then(async () => {
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            throw new ControllerSessionError("provider_control_protocol_invalid");
          }
          if (message?.type === "provider.session.failure" || message?.type === "provider.session.exit") {
            const lifecycle = message.type === "provider.session.failure"
              ? providerFailureSchema.parse(message)
              : providerExitSchema.parse(message);
            if (
              lifecycle.controlProtocol.version !== "1.0.0"
              || lifecycle.adapterId !== context.adapterId
              || lifecycle.sessionId !== context.sessionId
              || lifecycle.providerSessionId !== context.providerSessionId
            ) {
              throw new ControllerSessionError("provider_control_correlation_failed");
            }
            const event = lifecycle.type === "provider.session.failure" ? "failure" : "exit";
            const reason = lifecycle.type === "provider.session.failure"
              ? lifecycle.failure
              : lifecycle.reason;
            await context.handleLifecycle?.(event, reason);
            await context.recordAudit(`controller.session.${event}`, "observed", {
              sessionId: context.sessionId,
              providerSessionId: context.providerSessionId,
              providerAdapterId: context.adapterId,
              code: reason.code,
              retryable: reason.retryable,
              source: reason.source,
            });
            return;
          }
          let operationRequest;
          try {
            operationRequest = providerOperationRequestSchema.parse(message);
          } catch {
            throw new ControllerSessionError("provider_control_protocol_invalid");
          }
          if (
            operationRequest.controlProtocol.version !== adapterProtocolSchema.parse({
              major: 1,
              minor: 0,
              patch: 0,
              version: "1.0.0",
            }).version
            || operationRequest.sessionId !== context.sessionId
            || operationRequest.providerSessionId !== context.providerSessionId
          ) {
            throw new ControllerSessionError("provider_control_correlation_failed");
          }
          if (!context.handleOperation) {
            throw new ControllerSessionError("provider_operation_unsupported");
          }
          const operationInput = operationRequest.input
            && typeof operationRequest.input === "object"
            && !Array.isArray(operationRequest.input)
            ? operationRequest.input
            : null;
          const idempotencyKey = operationInput && "idempotencyKey" in operationInput
            ? operationInput.idempotencyKey
            : null;
          const idempotencyKeyHash = typeof idempotencyKey === "string"
            && idempotencyKey.length > 0
            && idempotencyKey.length <= 256
            ? `sha256:${createHash("sha256").update(idempotencyKey).digest("hex")}`
            : null;
          try {
            const outcome = await context.handleOperation({
              sessionId: context.sessionId,
              providerSessionId: context.providerSessionId,
              workContext: structuredClone(context.workContext),
              operation: operationRequest.operation,
              input: operationRequest.input,
            });
            await context.recordAudit("controller.provider.operation", "accepted", {
              sessionId: context.sessionId,
              providerSessionId: context.providerSessionId,
              workContextId: context.workContext.workContextId,
              operation: operationRequest.operation,
              operationId: operationRequest.operationId,
              idempotencyKeyHash,
              inputRetained: false,
            });
            socket.write(`${JSON.stringify({
              type: "provider.operation.result",
              controlProtocol: "1.0.0",
              operationId: operationRequest.operationId,
              ok: true,
              outcome,
            })}\n`);
          } catch (error) {
            const code = error instanceof ControllerSessionError
              ? error.code
              : "provider_operation_failed";
            const retainedOutcome = error instanceof ControllerSessionError
              && error.retainedOutcome
              && typeof error.retainedOutcome === "object"
              ? error.retainedOutcome
              : null;
            const outcomeAuditId = typeof retainedOutcome?.auditId === "string"
              ? retainedOutcome.auditId
              : null;
            const idempotentReplay = retainedOutcome?.idempotentReplay === true;
            const originalControllerAuditId = outcomeAuditId && idempotentReplay
              ? controllerAuditByRetainedOutcome.get(outcomeAuditId)
              : null;
            const controllerAuditId = await context.recordAudit(
              "controller.provider.operation",
              idempotentReplay ? "observed" : "rejected",
              {
                sessionId: context.sessionId,
                providerSessionId: context.providerSessionId,
                workContextId: context.workContext.workContextId,
                operation: operationRequest.operation,
                operationId: operationRequest.operationId,
                idempotencyKeyHash,
                code,
                ...(retainedOutcome ? {
                  idempotentReplay,
                  outcomeAuditId,
                  ...(originalControllerAuditId
                    ? { originalAuditId: originalControllerAuditId }
                    : {}),
                } : {}),
                inputRetained: false,
              },
            );
            if (outcomeAuditId && !idempotentReplay) {
              controllerAuditByRetainedOutcome.set(outcomeAuditId, controllerAuditId);
            }
            socket.write(`${JSON.stringify({
              type: "provider.operation.result",
              controlProtocol: "1.0.0",
              operationId: operationRequest.operationId,
              ok: false,
              failure: retainedOutcome ? structuredClone(retainedOutcome) : { code },
            })}\n`);
          }
        }).catch(() => {
          socket.destroy();
        });
      }
    });
    socket.once("error", () => {
      finishReady(new ControllerSessionError("provider_control_unavailable"));
    });
    socket.once("end", () => {
      if (!readySettled) {
        finishReady(new ControllerSessionError("provider_control_protocol_invalid"));
      }
    });
  });
  server.maxConnections = 1;
  try {
    await new Promise((resolve, reject) => {
      const onError = () => reject(new ControllerSessionError("provider_control_unavailable"));
      server.once("error", onError);
      server.listen(endpoint, () => {
        server.off("error", onError);
        resolve(undefined);
      });
    });
  } catch (error) {
    if (controlDirectory) {
      await rm(controlDirectory, { recursive: true, force: true });
    }
    throw error;
  }
  server.once("error", () => {
    finishReady(new ControllerSessionError("provider_control_unavailable"));
  });
  const expectReady = () => {
    if (readySettled || timeout) return;
    timeout = setTimeout(() => {
      finishReady(new ControllerSessionError("provider_session_ready_timeout"));
    }, 30_000);
  };
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    clearTimeout(timeout);
    controlSocket?.destroy();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    if (controlDirectory) {
      await rm(controlDirectory, { recursive: true, force: true });
    }
  };
  return {
    endpoint,
    ready,
    expectReady,
    /** @param {ControllerSessionError} error */
    fail: (error) => {
      finishReady(error);
      controlSocket?.destroy();
    },
    close,
  };
};

/**
 * @param {{
 *   dataDir: string,
 *   recordAudit: (action: string, outcome: "accepted" | "rejected" | "observed", details?: Record<string, unknown>) => Promise<string>,
 *   handleProviderOperation?: (request: {sessionId: string, providerSessionId: string, workContext: z.infer<typeof workContextSchema>, operation: string, input: unknown}) => Promise<unknown>,
 *   providerEnvironment?: NodeJS.ProcessEnv,
 * }} options
 */
export const createControllerSessionManager = async (options) => {
  const statePath = join(options.dataDir, "controller-sessions.json");
  const retained = retainedStateSchema.parse(await readJson(statePath, {
    schemaVersion: 1,
    sessions: [],
  }));
  let reconciledInterruptedSession = false;
  for (const previous of retained.sessions) {
    if (previous.terminal.status === "running") {
      previous.terminal.status = "interrupted";
      previous.terminal.exitedAt = new Date().toISOString();
      reconciledInterruptedSession = true;
    }
  }
  if (reconciledInterruptedSession) {
    await writePrivateJson(statePath, retained);
  }

  /** @type {Map<string, any>} */
  const activeBySession = new Map();
  /** @type {Map<string, any>} */
  const activeByStream = new Map();
  let stateWriteQueue = Promise.resolve();
  /** @type {Map<string, Promise<z.infer<typeof probeSchema>>>} */
  const probePromises = new Map();

  const persist = async () => {
    const current = stateWriteQueue.catch(() => undefined).then(() =>
      writePrivateJson(statePath, retainedStateSchema.parse(retained)));
    stateWriteQueue = current.then(() => undefined, () => undefined);
    await current;
  };

  /** @param {z.infer<typeof providerIdSchema>} providerId */
  const probeProvider = async (providerId) => {
    const selectedProviderId = providerIdSchema.parse(providerId);
    const definition = providerDefinitions[selectedProviderId];
    if (!probePromises.has(selectedProviderId)) {
      probePromises.set(selectedProviderId, invokeAdapter(
        definition,
        selectedProviderId,
        "probe",
        [],
        options.providerEnvironment ?? process.env,
      ).then((value) => probeSchema.parse(value)));
    }
    const probePromise = probePromises.get(selectedProviderId);
    if (!probePromise) {
      throw new ControllerSessionError("provider_adapter_unavailable");
    }
    try {
      return await probePromise;
    } catch (error) {
      probePromises.delete(selectedProviderId);
      throw error instanceof ControllerSessionError
        ? error
        : new ControllerSessionError("provider_adapter_protocol_invalid");
    }
  };

  /**
   * @param {z.infer<typeof workContextSchema>} workContext
   * @param {{providerId?: z.infer<typeof providerIdSchema>, workingDirectory?: string}} [startOptions]
   */
  const start = async (workContext, startOptions = {}) => {
    const selectedWorkContext = workContextSchema.parse(workContext);
    const selectedProviderId = providerIdSchema.parse(
      startOptions.providerId ?? "conformance-controller-v1",
    );
    const definition = providerDefinitions[selectedProviderId];
    const workingDirectory = startOptions.workingDirectory ?? options.dataDir;
    if (
      !isAbsolute(workingDirectory)
      || workingDirectory.includes("\0")
      || workingDirectory.length > 4_096
      || (selectedProviderId === "claude-code" && selectedWorkContext.kind !== "project")
    ) {
      throw new ControllerSessionError("provider_work_context_invalid");
    }
    const sessionId = `controller-session-${randomBytes(12).toString("hex")}`;
    const providerSessionId = definition.createSessionId();
    const streamId = `controller-terminal-${randomBytes(12).toString("hex")}`;
    const attachmentId = `terminal-attachment-${randomBytes(12).toString("hex")}`;
    /** @type {any} */
    let runtimeSession;
    /** @type {z.infer<typeof retainedSessionSchema> | undefined} */
    let retainedSession;
    /** @type {z.infer<typeof providerExitReasonSchema> | null} */
    let reportedExitReason = null;
    let providerControl;
    let adapter;
    let prepared;
    try {
      adapter = await probeProvider(selectedProviderId);
      if (adapter.provider.providerId !== selectedProviderId) {
        throw new ControllerSessionError("provider_adapter_protocol_invalid");
      }
      if (adapter.availability && adapter.availability.status !== "available") {
        throw new ControllerSessionError(
          adapter.availability.failure?.code ?? "provider_adapter_failed",
        );
      }
      providerControl = await openProviderControl({
        sessionId,
        providerSessionId,
        adapterId: definition.adapterId,
        workContext: selectedWorkContext,
        handleOperation: options.handleProviderOperation,
        handleLifecycle: async (_event, reason) => {
          reportedExitReason = reason;
          if (runtimeSession) runtimeSession.exitReason = reason;
          if (retainedSession) {
            retainedSession.terminal.exitReason = reason;
            await persist();
          }
        },
        recordAudit: options.recordAudit,
      });
      prepared = preparedSchema.parse(await invokeAdapter(
        definition,
        selectedProviderId,
        "prepare",
        [
        "--session-id", sessionId,
        "--provider-session-id", providerSessionId,
        "--work-context-id", selectedWorkContext.workContextId,
        "--canonical-reference", selectedWorkContext.canonicalReference,
        "--control-endpoint", providerControl.endpoint,
        ],
        options.providerEnvironment ?? process.env,
      ));
    } catch (error) {
      await providerControl?.close();
      await options.recordAudit("controller.session.start", "rejected", {
        code: error instanceof ControllerSessionError
          ? error.code
          : "provider_adapter_protocol_invalid",
        sessionId,
        controllerSessionId: sessionId,
        workContextId: selectedWorkContext.workContextId,
        providerId: selectedProviderId,
        providerAdapterId: definition.adapterId,
        ptyRuntimeOwned: true,
      });
      throw error instanceof ControllerSessionError
        ? error
        : new ControllerSessionError("provider_adapter_protocol_invalid");
    }
    if (!adapter || !prepared || !providerControl) {
      throw new ControllerSessionError("provider_adapter_protocol_invalid");
    }
    if (
      prepared.providerSessionId !== providerSessionId
      || prepared.adapterId !== adapter.adapterId
      || prepared.provider.providerId !== selectedProviderId
      || prepared.command.executable !== process.execPath
      || prepared.command.args[0] !== definition.adapterPath
      || prepared.command.args[1] !== "run"
      || prepared.control.endpoint !== providerControl.endpoint
      || prepared.control.protocol.version !== adapter.adapterProtocol.version
    ) {
      await providerControl.close();
      throw new ControllerSessionError("provider_adapter_protocol_invalid");
    }

    let terminal;
    try {
      terminal = pty.spawn(prepared.command.executable, prepared.command.args, {
        name: "xterm-256color",
        cols: prepared.terminal.columns,
        rows: prepared.terminal.rows,
        cwd: workingDirectory,
        env: prepared.command.environment,
      });
    } catch {
      await providerControl.close();
      throw new ControllerSessionError("provider_pty_start_failed");
    }

    /** @type {Array<{streamId: string, sequence: number, eof: boolean, data: Buffer}>} */
    const bufferedFrames = [];
    /** @type {any} */
    runtimeSession = {
      sessionId,
      providerSessionId,
      streamId,
      attachmentId,
      terminal,
      bufferedFrames,
      outputSequence: 0,
      expectedInputSequence: 0,
      expectedResizeSequence: 0,
      columns: prepared.terminal.columns,
      rows: prepared.terminal.rows,
      writableSocket: null,
      readOnlySockets: new Set(),
      outputHandlers: new Map(),
      running: true,
      exitReason: null,
      providerControl,
    };
    activeBySession.set(sessionId, runtimeSession);
    activeByStream.set(streamId, runtimeSession);

    /** @type {(value: undefined) => void} */
    let resolveExit = () => undefined;
    const exited = new Promise((resolve) => {
      resolveExit = resolve;
    });
    runtimeSession.exited = exited;
    terminal.onData((data) => {
      const bytes = Buffer.from(data, "utf8");
      for (let offset = 0; offset < bytes.byteLength; offset += 16_384) {
        const frame = {
          streamId,
          sequence: runtimeSession.outputSequence,
          eof: false,
          data: bytes.subarray(offset, offset + 16_384),
        };
        runtimeSession.outputSequence += 1;
        bufferedFrames.push(frame);
        if (bufferedFrames.length > 256) {
          bufferedFrames.shift();
        }
        if (runtimeSession.writableSocket?.readyState === 1) {
          runtimeSession.onOutput?.(runtimeSession.writableSocket, frame);
        }
        for (const readOnlySocket of runtimeSession.readOnlySockets) {
          if (readOnlySocket.readyState === 1) {
            runtimeSession.outputHandlers.get(readOnlySocket)?.(readOnlySocket, frame);
          }
        }
      }
    });

    terminal.onExit(({ exitCode, signal }) => {
      runtimeSession.running = false;
      const exitReason = reportedExitReason ?? (signal
        ? { code: "runtime_terminated", retryable: false, source: "controller-runtime" }
        : exitCode === 0
          ? {
              code: "provider_session_completed",
              retryable: false,
              source: selectedProviderId === "claude-code"
                ? "claude-cli"
                : "conformance-provider",
            }
          : {
              code: "provider_process_exit_unclassified",
              retryable: true,
              source: "sandking-adapter",
            });
      runtimeSession.exitReason = exitReason;
      if (retainedSession) {
        retainedSession.terminal.status = "exited";
        retainedSession.terminal.exitedAt = new Date().toISOString();
        retainedSession.terminal.exitCode = exitCode;
        retainedSession.terminal.signal = signal ?? null;
        retainedSession.terminal.exitReason = exitReason;
      }
      const eofFrame = {
        streamId,
        sequence: runtimeSession.outputSequence,
        eof: true,
        data: Buffer.alloc(0),
      };
      runtimeSession.outputSequence += 1;
      bufferedFrames.push(eofFrame);
      if (runtimeSession.writableSocket?.readyState === 1) {
        runtimeSession.onOutput?.(runtimeSession.writableSocket, eofFrame);
      }
      for (const readOnlySocket of runtimeSession.readOnlySockets) {
        if (readOnlySocket.readyState === 1) {
          runtimeSession.outputHandlers.get(readOnlySocket)?.(readOnlySocket, eofFrame);
        }
      }
      if (retainedSession) {
        persist().catch(() => undefined);
      }
      options.recordAudit("controller.session.exit", "observed", {
        sessionId,
        providerSessionId,
        streamId,
        exitCode,
        signal,
        exitReason,
      }).catch(() => undefined);
      providerControl.fail(new ControllerSessionError("provider_session_exited_before_ready"));
      providerControl.close().catch(() => undefined);
      resolveExit(undefined);
    });

    providerControl.expectReady();
    let readyMessage;
    try {
      readyMessage = await providerControl.ready;
      if (
        readyMessage.sessionId !== sessionId
        || readyMessage.providerSessionId !== providerSessionId
        || readyMessage.adapterId !== prepared.adapterId
        || readyMessage.controlProtocol.version !== prepared.control.protocol.version
        || readyMessage.process.pid !== terminal.pid
        || readyMessage.workContext.workContextId !== selectedWorkContext.workContextId
        || readyMessage.workContext.canonicalReference !== selectedWorkContext.canonicalReference
        || JSON.stringify(readyMessage.sessionIdentity ?? null)
          !== JSON.stringify(prepared.sessionIdentity ?? null)
        || !runtimeSession.running
      ) {
        throw new ControllerSessionError("provider_control_correlation_failed");
      }
    } catch (error) {
      activeBySession.delete(sessionId);
      activeByStream.delete(streamId);
      if (runtimeSession.running) {
        terminal.kill();
      }
      await providerControl.close();
      throw error;
    }
    const readyObservedAt = new Date().toISOString();
    const startedAt = readyObservedAt;
    retainedSession = retainedSessionSchema.parse({
      sessionId,
      providerSessionId,
      providerId: prepared.provider.providerId,
      providerAdapterId: prepared.adapterId,
      adapterProtocol: prepared.adapterProtocol.version,
      capabilities: prepared.capabilities,
      ...(adapter.availability ? { providerAvailability: adapter.availability } : {}),
      ...(prepared.sessionIdentity ? { sessionIdentity: prepared.sessionIdentity } : {}),
      workContextId: selectedWorkContext.workContextId,
      workContextKind: selectedWorkContext.kind,
      canonicalReference: selectedWorkContext.canonicalReference,
      providerControl: {
        protocol: prepared.control.protocol.version,
        readySignal: readyMessage.type,
        readyObservedAt,
        providerObservedTty:
          readyMessage.terminal.stdinTty && readyMessage.terminal.stdoutTty,
      },
      terminal: {
        streamId,
        runtimeOwned: true,
        kind: "pty",
        status: "running",
        startedAt,
        exitedAt: null,
        exitCode: null,
        signal: null,
        exitReason: null,
      },
    });

    retained.sessions.push(retainedSession);
    retained.sessions = retained.sessions.slice(-128);
    await persist();
    await options.recordAudit("controller.session.start", "accepted", {
      sessionId,
      controllerSessionId: sessionId,
      providerSessionId,
      providerId: prepared.provider.providerId,
      providerAdapterId: prepared.adapterId,
      adapterProtocol: prepared.adapterProtocol.version,
      capabilities: prepared.capabilities,
      workContextId: selectedWorkContext.workContextId,
      canonicalReference: selectedWorkContext.canonicalReference,
      streamId,
      providerControlProtocol: prepared.control.protocol.version,
      providerReadySignal: readyMessage.type,
      providerObservedTty: true,
      ptyRuntimeOwned: true,
      terminalKind: "pty",
    });

    return {
      sessionId,
      focused: true,
      provider: {
        ...prepared.provider,
        adapterId: prepared.adapterId,
        adapterProtocol: prepared.adapterProtocol.version,
        capabilities: prepared.capabilities,
        providerSessionId,
        readiness: {
          controlProtocol: prepared.control.protocol.version,
          signal: readyMessage.type,
          providerObservedTty: true,
        },
        ...(adapter.availability ? { availability: adapter.availability } : {}),
        ...(prepared.sessionIdentity ? { sessionIdentity: prepared.sessionIdentity } : {}),
        ...(adapter.integration ? { integration: adapter.integration } : {}),
      },
      terminal: {
        streamId,
        kind: "pty",
        runtimeOwned: true,
        state: "running",
        writableAttachment: {
          attachmentId,
          mode: "exclusive",
        },
      },
      workContext: structuredClone(selectedWorkContext),
    };
  };

  /**
   * @param {{socket: any, sessionId: string, streamId: string, attachmentId: string, mode: "read-write" | "read-only" | "read-write-if-available", outputCursor: number, onAttached?: (attachment: any) => void, onOutput: (socket: any, frame: any) => void}} request
   */
  const attach = async (request) => {
    const session = activeBySession.get(request.sessionId);
    if (
      !session
      || session.streamId !== request.streamId
      || session.attachmentId !== request.attachmentId
      || !Number.isSafeInteger(request.outputCursor)
      || request.outputCursor < 0
    ) {
      throw new ControllerSessionError("controller_terminal_not_found");
    }
    if (
      request.mode !== "read-write"
      && request.mode !== "read-only"
      && request.mode !== "read-write-if-available"
    ) {
      throw new ControllerSessionError("controller_terminal_attachment_mode_invalid");
    }
    const mode = request.mode === "read-write-if-available"
      ? session.writableSocket && session.writableSocket !== request.socket
        ? "read-only"
        : "read-write"
      : request.mode;
    if (
      mode === "read-write"
      && session.writableSocket
      && session.writableSocket !== request.socket
    ) {
      throw new ControllerSessionError("terminal_write_attachment_conflict");
    }
    if (mode === "read-write") {
      session.writableSocket = request.socket;
      session.onOutput = null;
      session.readOnlySockets.delete(request.socket);
      session.outputHandlers.delete(request.socket);
    } else {
      if (session.writableSocket === request.socket) {
        session.writableSocket = null;
        session.onOutput = null;
      }
      session.readOnlySockets.add(request.socket);
      session.outputHandlers.delete(request.socket);
    }
    const availableOutputCursorAtAcceptance = session.bufferedFrames[0]?.sequence
      ?? session.outputSequence;
    const outputCursorAtAcceptance = Math.max(
      request.outputCursor,
      availableOutputCursorAtAcceptance,
    );
    await options.recordAudit("controller.terminal.attach", "accepted", {
      sessionId: session.sessionId,
      providerSessionId: session.providerSessionId,
      streamId: session.streamId,
      mode,
      exclusive: mode === "read-write",
      requestedOutputCursor: request.outputCursor,
      outputCursor: outputCursorAtAcceptance,
      resynchronized: outputCursorAtAcceptance !== request.outputCursor,
    });
    const availableOutputCursor = session.bufferedFrames[0]?.sequence
      ?? session.outputSequence;
    const outputCursor = Math.max(request.outputCursor, availableOutputCursor);
    const resynchronized = outputCursor !== request.outputCursor;
    const frames = session.bufferedFrames.filter(
      (/** @type {{sequence: number}} */ frame) => frame.sequence >= outputCursor,
    );
    const replayTail = frames.at(-1);
    const nextOutputSequence = replayTail ? replayTail.sequence + 1 : outputCursor;
    let deliveryState = "staged";
    const attachment = {
      session,
      mode,
      exclusive: mode === "read-write",
      inputSequence: session.expectedInputSequence,
      resizeSequence: session.expectedResizeSequence,
      outputCursor,
      resynchronized,
      frames,
      activate: () => {
        if (deliveryState !== "staged") return false;
        if (mode === "read-write") {
          if (session.writableSocket !== request.socket) return false;
        } else {
          if (!session.readOnlySockets.has(request.socket)) return false;
        }
        deliveryState = "activating";
        try {
          request.onAttached?.(attachment);
          for (const frame of frames) {
            request.onOutput(request.socket, frame);
          }
          for (const frame of session.bufferedFrames) {
            if (frame.sequence >= nextOutputSequence) {
              request.onOutput(request.socket, frame);
            }
          }
          if (mode === "read-write") {
            session.onOutput = request.onOutput;
          } else {
            session.outputHandlers.set(request.socket, request.onOutput);
          }
          deliveryState = "active";
          return true;
        } catch (error) {
          deliveryState = "failed";
          throw error;
        }
      },
    };
    return attachment;
  };

  /** @param {{socket: any, streamId: string, sequence: number, eof: boolean, data: Buffer}} request */
  const write = async (request) => {
    const session = activeByStream.get(request.streamId);
    if (!session) {
      return false;
    }
    if (session.writableSocket !== request.socket) {
      throw new ControllerSessionError("terminal_write_attachment_required");
    }
    if (request.sequence !== session.expectedInputSequence || request.eof || !session.running) {
      throw new ControllerSessionError("terminal_input_sequence_conflict");
    }
    session.expectedInputSequence += 1;
    session.terminal.write(request.data.toString("utf8"));
    await options.recordAudit("controller.terminal.input", "observed", {
      sessionId: session.sessionId,
      providerSessionId: session.providerSessionId,
      streamId: session.streamId,
      sequence: request.sequence,
      byteLength: request.data.byteLength,
      contentRetained: false,
    });
    return true;
  };

  /** @param {{socket: any, sessionId: string, streamId: string, attachmentId: string, sequence: number, columns: number, rows: number}} request */
  const resize = async (request) => {
    const session = activeBySession.get(request.sessionId);
    if (
      !session
      || session.streamId !== request.streamId
      || session.attachmentId !== request.attachmentId
    ) {
      throw new ControllerSessionError("controller_terminal_not_found");
    }
    if (session.writableSocket !== request.socket) {
      throw new ControllerSessionError("terminal_resize_attachment_required");
    }
    if (
      !Number.isSafeInteger(request.sequence)
      || request.sequence !== session.expectedResizeSequence
    ) {
      throw new ControllerSessionError("terminal_resize_sequence_conflict");
    }
    if (
      !Number.isSafeInteger(request.columns)
      || request.columns < 20
      || request.columns > 500
      || !Number.isSafeInteger(request.rows)
      || request.rows < 5
      || request.rows > 200
    ) {
      throw new ControllerSessionError("terminal_resize_dimensions_invalid");
    }
    if (!session.running) {
      throw new ControllerSessionError("terminal_resize_sequence_conflict");
    }
    try {
      session.terminal.resize(request.columns, request.rows);
    } catch {
      throw new ControllerSessionError("provider_pty_resize_failed");
    }
    session.expectedResizeSequence += 1;
    session.columns = request.columns;
    session.rows = request.rows;
    await options.recordAudit("controller.terminal.resize", "observed", {
      sessionId: session.sessionId,
      providerSessionId: session.providerSessionId,
      streamId: session.streamId,
      attachmentId: session.attachmentId,
      sequence: request.sequence,
      columns: request.columns,
      rows: request.rows,
      contentRetained: false,
    });
    return {
      sessionId: session.sessionId,
      streamId: session.streamId,
      attachmentId: session.attachmentId,
      sequence: request.sequence,
      columns: session.columns,
      rows: session.rows,
    };
  };

  /** @param {any} socket */
  const detach = (socket) => {
    for (const session of activeBySession.values()) {
      if (session.writableSocket === socket) {
        session.writableSocket = null;
        session.onOutput = null;
      }
      session.readOnlySockets.delete(socket);
      session.outputHandlers.delete(socket);
    }
  };

  /** @param {string} sessionId */
  const terminate = async (sessionId) => {
    const session = activeBySession.get(sessionId);
    if (session?.running) {
      session.terminal.kill();
      await Promise.race([
        session.exited,
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
  };

  const shutdown = async () => {
    const exits = [];
    const controlCloses = [];
    for (const session of activeBySession.values()) {
      if (session.running) {
        session.terminal.kill();
      }
      controlCloses.push(session.providerControl?.close().catch(() => undefined));
      exits.push(session.exited);
    }
    await Promise.race([
      Promise.all(exits),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    await Promise.all(controlCloses);
    await stateWriteQueue.catch(() => undefined);
  };

  /** @param {string} sessionId */
  const inspect = (sessionId) => {
    const session = retained.sessions.find((candidate) => candidate.sessionId === sessionId);
    return session ? structuredClone(session) : null;
  };

  return { probeProvider, start, inspect, attach, write, resize, detach, terminate, shutdown };
};
