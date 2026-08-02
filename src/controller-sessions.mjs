import { spawn as spawnChild } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "@lydell/node-pty";
import { z } from "zod";
import { readJson, writePrivateJson } from "./private-state.mjs";

const adapterPath = fileURLToPath(new URL("./conformance-provider-adapter.mjs", import.meta.url));
const identifierSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9._:-]+$/);
const adapterProtocolSchema = z.object({
  major: z.literal(1),
  minor: z.number().int().nonnegative(),
  patch: z.number().int().nonnegative(),
  version: z.string().regex(/^1\.[0-9]+\.[0-9]+$/),
}).strict();
const providerSchema = z.object({
  providerId: z.literal("conformance-controller-v1"),
  kind: z.literal("conformance"),
  fixture: z.literal(true),
}).strict();
const capabilitiesSchema = z.array(z.enum([
  "controller.session.start",
  "controller.session.interactive",
  "controller.session.terminate",
  "controller.work-context.inspect",
  "controller.launch-request.prepare",
  "controller.launch-request.decide",
  "controller.harness-run.start",
])).min(3).max(7).refine((capabilities) =>
  capabilities.includes("controller.session.start")
  && capabilities.includes("controller.session.interactive")
  && capabilities.includes("controller.session.terminate"));
const probeSchema = z.object({
  type: z.literal("provider.adapter.probe"),
  adapterProtocol: adapterProtocolSchema,
  adapterId: z.literal("conformance-controller-adapter-v1"),
  provider: providerSchema,
  capabilities: capabilitiesSchema,
  terminal: z.object({
    ptyRequired: z.literal(true),
    runtimeOwnershipRequired: z.literal(true),
  }).strict(),
}).strict();
const preparedSchema = z.object({
  type: z.literal("provider.session.prepared"),
  adapterProtocol: adapterProtocolSchema,
  adapterId: z.literal("conformance-controller-adapter-v1"),
  provider: providerSchema,
  providerSessionId: z.string().regex(/^conformance-provider-session-[a-f0-9]{24}$/),
  capabilities: capabilitiesSchema,
  terminal: z.object({
    ptyRequired: z.literal(true),
    columns: z.number().int().min(20).max(500),
    rows: z.number().int().min(5).max(200),
  }).strict(),
  control: z.object({
    protocol: adapterProtocolSchema,
    readySignal: z.literal("provider.session.ready"),
    endpoint: z.string().min(1).max(512),
  }).strict(),
  command: z.object({
    executable: z.string().min(1),
    args: z.array(z.string()).min(1).max(32),
    environment: z.record(z.string(), z.string()).refine((environment) =>
      !Object.keys(environment).some((name) => /secret|token|credential|key/i.test(name))),
  }).strict(),
}).strict();
const providerReadySchema = z.object({
  type: z.literal("provider.session.ready"),
  controlProtocol: adapterProtocolSchema,
  adapterId: z.literal("conformance-controller-adapter-v1"),
  sessionId: z.string().regex(/^controller-session-[a-f0-9]{24}$/),
  providerSessionId: z.string().regex(/^conformance-provider-session-[a-f0-9]{24}$/),
  workContext: z.object({
    workContextId: identifierSchema,
    canonicalReference: z.string().regex(
      /^(?:github:fixture:issue:[0-9]+|sandking:project:project-[a-f0-9]{24})$/,
    ),
  }).strict(),
  process: z.object({
    pid: z.number().int().positive(),
  }).strict(),
  terminal: z.object({
    stdinTty: z.literal(true),
    stdoutTty: z.literal(true),
  }).strict(),
}).strict();
const planningWorkContextSchema = z.object({
  workContextId: identifierSchema,
  kind: z.literal("planning-stage"),
  canonicalReference: z.string().regex(/^github:fixture:issue:[0-9]+$/),
}).strict();
const projectWorkContextSchema = z.object({
  workContextId: z.string().regex(/^project-[a-f0-9]{24}$/),
  kind: z.literal("project"),
  canonicalReference: z.string()
    .regex(/^sandking:project:project-[a-f0-9]{24}$/),
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
  providerSessionId: z.string().regex(/^conformance-provider-session-[a-f0-9]{24}$/),
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
  providerSessionId: z.string().regex(/^conformance-provider-session-[a-f0-9]{24}$/),
  providerId: z.literal("conformance-controller-v1"),
  providerAdapterId: z.literal("conformance-controller-adapter-v1"),
  adapterProtocol: z.string().regex(/^1\.[0-9]+\.[0-9]+$/),
  capabilities: capabilitiesSchema,
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
  }).strict(),
}).strict();
const retainedStateSchema = z.object({
  schemaVersion: z.literal(1),
  sessions: z.array(retainedSessionSchema).max(128),
}).strict();

export class ControllerSessionError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = "ControllerSessionError";
    this.code = code;
  }
}

/**
 * @param {string} mode
 * @param {string[]} args
 */
const invokeAdapter = async (mode, args = []) => new Promise((resolve, reject) => {
  const child = spawnChild(process.execPath, [adapterPath, mode, ...args], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { LANG: "C.UTF-8" },
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
  }, 3_000);
  child.stdout.on("data", (chunk) => {
    size += chunk.byteLength;
    if (size <= 32_768) {
      stdout.push(Buffer.from(chunk));
    }
  });
  child.stderr.on("data", (chunk) => {
    if (Buffer.concat(stderr).byteLength < 1_024) {
      stderr.push(Buffer.from(chunk).subarray(0, 1_024));
    }
  });
  child.once("error", () => finish(new ControllerSessionError("provider_adapter_unavailable")));
  child.once("exit", (code) => {
    if (code !== 0 || size > 32_768) {
      finish(new ControllerSessionError("provider_adapter_failed"));
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
 *   handleOperation?: (request: {sessionId: string, providerSessionId: string, workContext: z.infer<typeof workContextSchema>, operation: string, input: unknown}) => Promise<unknown>,
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
          let operationRequest;
          try {
            operationRequest = providerOperationRequestSchema.parse(JSON.parse(line));
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
            await context.recordAudit("controller.provider.operation", "rejected", {
              sessionId: context.sessionId,
              providerSessionId: context.providerSessionId,
              workContextId: context.workContext.workContextId,
              operation: operationRequest.operation,
              operationId: operationRequest.operationId,
              code,
              inputRetained: false,
            });
            socket.write(`${JSON.stringify({
              type: "provider.operation.result",
              controlProtocol: "1.0.0",
              operationId: operationRequest.operationId,
              ok: false,
              failure: { code },
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
  timeout = setTimeout(() => {
    finishReady(new ControllerSessionError("provider_session_ready_timeout"));
  }, 3_000);
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
  /** @type {Promise<z.infer<typeof probeSchema>> | undefined} */
  let probePromise;

  const persist = async () => {
    const current = stateWriteQueue.catch(() => undefined).then(() =>
      writePrivateJson(statePath, retainedStateSchema.parse(retained)));
    stateWriteQueue = current.then(() => undefined, () => undefined);
    await current;
  };

  const probe = async () => {
    if (!probePromise) {
      probePromise = invokeAdapter("probe").then((value) => probeSchema.parse(value));
    }
    try {
      return await probePromise;
    } catch (error) {
      probePromise = undefined;
      throw error instanceof ControllerSessionError
        ? error
        : new ControllerSessionError("provider_adapter_protocol_invalid");
    }
  };

  /** @param {z.infer<typeof workContextSchema>} workContext */
  const start = async (workContext) => {
    const selectedWorkContext = workContextSchema.parse(workContext);
    const sessionId = `controller-session-${randomBytes(12).toString("hex")}`;
    const providerSessionId = `conformance-provider-session-${randomBytes(12).toString("hex")}`;
    const streamId = `controller-terminal-${randomBytes(12).toString("hex")}`;
    const attachmentId = `terminal-attachment-${randomBytes(12).toString("hex")}`;
    const providerControl = await openProviderControl({
      sessionId,
      providerSessionId,
      workContext: selectedWorkContext,
      handleOperation: options.handleProviderOperation,
      recordAudit: options.recordAudit,
    });
    let adapter;
    let prepared;
    try {
      adapter = await probe();
      prepared = preparedSchema.parse(await invokeAdapter("prepare", [
        "--session-id", sessionId,
        "--provider-session-id", providerSessionId,
        "--work-context-id", selectedWorkContext.workContextId,
        "--canonical-reference", selectedWorkContext.canonicalReference,
        "--control-endpoint", providerControl.endpoint,
      ]));
    } catch (error) {
      await providerControl.close();
      await options.recordAudit("controller.session.start", "rejected", {
        code: error instanceof ControllerSessionError
          ? error.code
          : "provider_adapter_protocol_invalid",
        sessionId,
        workContextId: selectedWorkContext.workContextId,
        providerAdapterId: "conformance-controller-adapter-v1",
        ptyRuntimeOwned: true,
      });
      throw error instanceof ControllerSessionError
        ? error
        : new ControllerSessionError("provider_adapter_protocol_invalid");
    }
    if (
      prepared.providerSessionId !== providerSessionId
      || prepared.adapterId !== adapter.adapterId
      || prepared.command.executable !== process.execPath
      || prepared.command.args[0] !== adapterPath
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
        cwd: options.dataDir,
        env: prepared.command.environment,
      });
    } catch {
      await providerControl.close();
      throw new ControllerSessionError("provider_pty_start_failed");
    }

    /** @type {Array<{streamId: string, sequence: number, eof: boolean, data: Buffer}>} */
    const bufferedFrames = [];
    /** @type {any} */
    const runtimeSession = {
      sessionId,
      providerSessionId,
      streamId,
      attachmentId,
      terminal,
      bufferedFrames,
      outputSequence: 0,
      expectedInputSequence: 0,
      writableSocket: null,
      readOnlySockets: new Set(),
      outputHandlers: new Map(),
      running: true,
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

    /** @type {z.infer<typeof retainedSessionSchema> | undefined} */
    let retainedSession;
    terminal.onExit(({ exitCode, signal }) => {
      runtimeSession.running = false;
      if (retainedSession) {
        retainedSession.terminal.status = "exited";
        retainedSession.terminal.exitedAt = new Date().toISOString();
        retainedSession.terminal.exitCode = exitCode;
        retainedSession.terminal.signal = signal ?? null;
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
      }).catch(() => undefined);
      providerControl.fail(new ControllerSessionError("provider_session_exited_before_ready"));
      providerControl.close().catch(() => undefined);
      resolveExit(undefined);
    });

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
      },
    });

    retained.sessions.push(retainedSession);
    retained.sessions = retained.sessions.slice(-128);
    await persist();
    await options.recordAudit("controller.session.start", "accepted", {
      sessionId,
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
   * @param {{socket: any, sessionId: string, streamId: string, attachmentId: string, mode: "read-write" | "read-only", outputCursor: number, onOutput: (socket: any, frame: any) => void}} request
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
    if (request.mode !== "read-write" && request.mode !== "read-only") {
      throw new ControllerSessionError("controller_terminal_attachment_mode_invalid");
    }
    if (
      request.mode === "read-write"
      && session.writableSocket
      && session.writableSocket !== request.socket
    ) {
      throw new ControllerSessionError("terminal_write_attachment_conflict");
    }
    if (request.mode === "read-write") {
      session.writableSocket = request.socket;
      session.onOutput = request.onOutput;
      session.readOnlySockets.delete(request.socket);
      session.outputHandlers.delete(request.socket);
    } else {
      if (session.writableSocket === request.socket) {
        session.writableSocket = null;
        session.onOutput = null;
      }
      session.readOnlySockets.add(request.socket);
      session.outputHandlers.set(request.socket, request.onOutput);
    }
    await options.recordAudit("controller.terminal.attach", "accepted", {
      sessionId: session.sessionId,
      providerSessionId: session.providerSessionId,
      streamId: session.streamId,
      mode: request.mode,
      exclusive: request.mode === "read-write",
      outputCursor: request.outputCursor,
    });
    return {
      session,
      mode: request.mode,
      exclusive: request.mode === "read-write",
      frames: session.bufferedFrames.filter(
        (/** @type {{sequence: number}} */ frame) => frame.sequence >= request.outputCursor,
      ),
    };
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

  return { start, attach, write, detach, terminate, shutdown };
};
