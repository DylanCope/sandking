#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const adapterProtocol = Object.freeze({
  major: 1,
  minor: 0,
  patch: 0,
  version: "1.0.0",
});
const adapterId = "claude-code-controller-adapter-v1";
const provider = Object.freeze({
  providerId: "claude-code",
  kind: "production",
  fixture: false,
});
const capabilities = Object.freeze([
  "controller.session.start",
  "controller.session.interactive",
  "controller.session.terminate",
  "controller.work-context.inspect",
  "controller.launch-request.prepare",
  "controller.launch-request.decide",
  "controller.harness-run.start",
  "controller.session.stable-identity",
  "controller.session.typed-exit",
]);
const baseSessionCapabilities = Object.freeze([
  "controller.session.start",
  "controller.session.interactive",
  "controller.session.terminate",
]);
const pluginCapabilities = Object.freeze([
  "controller.work-context.inspect",
  "controller.launch-request.prepare",
  "controller.launch-request.decide",
  "controller.harness-run.start",
  "controller.session.typed-exit",
]);
const adapterPath = fileURLToPath(import.meta.url);
const pluginDirectory = fileURLToPath(new URL("./claude-controller-plugin", import.meta.url));
const controllerSessionPattern = /^controller-session-[a-f0-9]{24}$/;
const providerSessionPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const workContextPattern = /^[a-zA-Z0-9._:-]{1,160}$/;
const canonicalReferencePattern = /^(?:github:fixture:issue:[0-9]+|sandking:project:project-[a-f0-9]{24})$/;
const launchRequestPattern = /^launch-request-[a-f0-9]{24}$/;
const claudeStopFailureTypes = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "rate_limit",
  "overloaded",
  "server_error",
  "network_error",
  "invalid_request",
  "max_output_tokens",
  "unknown",
]);

/** @param {unknown} input */
export const classifyClaudeStopFailure = (input) => {
  if (
    !input
    || typeof input !== "object"
    || !("error" in input)
    || typeof input.error !== "string"
    || !claudeStopFailureTypes.has(input.error)
  ) {
    return { code: "provider_adapter_failed", retryable: true, source: "sandking-adapter" };
  }
  if (input.error === "authentication_failed" || input.error === "oauth_org_not_allowed") {
    return {
      code: "provider_authentication_failed",
      retryable: false,
      source: "claude-stop-failure",
    };
  }
  if (input.error === "rate_limit" || input.error === "billing_error") {
    return {
      code: "provider_quota_unavailable",
      retryable: input.error === "rate_limit",
      source: "claude-stop-failure",
    };
  }
  if (input.error === "overloaded" || input.error === "server_error") {
    return { code: "provider_outage", retryable: true, source: "claude-stop-failure" };
  }
  const details = "error_details" in input && typeof input.error_details === "string"
    ? input.error_details.slice(0, 512)
    : "";
  if (
    input.error === "network_error"
    || (input.error === "unknown"
      && /\b(?:network|dns|connect(?:ion)?|socket|tls|timed?\s*out|unreachable)\b/i.test(details))
  ) {
    return {
      code: "provider_network_unavailable",
      retryable: true,
      source: "claude-stop-failure",
    };
  }
  return {
    code: "provider_model_behavior_unconfirmed",
    retryable: input.error !== "invalid_request",
    source: "claude-stop-failure",
  };
};

/** @param {NodeJS.ProcessEnv} source */
export const createClaudeDestinationEnvironment = (source = process.env) => {
  /** @type {NodeJS.ProcessEnv} */
  const environment = {};
  for (const name of [
    "HOME",
    "PATH",
    "LANG",
    "LC_ALL",
    "TERM",
    "COLORTERM",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
  ]) {
    if (typeof source[name] === "string" && source[name].length > 0) {
      environment[name] = source[name];
    }
  }
  environment.LANG ??= "C.UTF-8";
  environment.TERM ??= "xterm-256color";
  if (
    typeof source.SANDKING_CLAUDE_EXECUTABLE === "string"
    && source.SANDKING_CLAUDE_EXECUTABLE.length > 0
    && source.SANDKING_CLAUDE_EXECUTABLE.length <= 4_096
    && !/[\r\n\0]/.test(source.SANDKING_CLAUDE_EXECUTABLE)
  ) {
    environment.SANDKING_CLAUDE_EXECUTABLE = source.SANDKING_CLAUDE_EXECUTABLE;
  }
  return environment;
};

/** @param {string[]} argv */
const parseFlags = (argv) => {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || flags.has(flag.slice(2))) {
      throw new Error("provider_adapter_arguments_invalid");
    }
    flags.set(flag.slice(2), value);
  }
  return flags;
};

/** @param {unknown} value */
const writeResult = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

/** @param {string} executable @param {string[]} args */
const invokeClaudeMetadataCommand = async (executable, args) => execFileAsync(
  executable,
  args,
  {
    encoding: "utf8",
    env: createClaudeDestinationEnvironment(),
    timeout: 3_000,
    maxBuffer: 32_768,
  },
);

/** @param {string[]} detectedCapabilities */
const baseProbe = (detectedCapabilities) => ({
  type: "provider.adapter.probe",
  adapterProtocol,
  adapterId,
  provider,
  capabilities: detectedCapabilities,
  terminal: {
    ptyRequired: true,
    runtimeOwnershipRequired: true,
  },
  integration: {
    pluginId: "sandking-controller",
    pluginVersion: "1.0.0",
    scope: "session",
    loading: "--plugin-dir",
    boundary: "session-plugin-private-typed-shim",
    credentialsTransferred: false,
  },
});

/** @param {string} executable */
const detectClaudeCapabilities = async (executable) => {
  const detected = new Set();
  let help;
  try {
    help = (await invokeClaudeMetadataCommand(executable, ["--help"])).stdout;
  } catch {
    return [];
  }
  for (const capability of baseSessionCapabilities) detected.add(capability);
  if (/(?:^|\s)--session-id(?:[=\s,]|$)/m.test(help)) {
    detected.add("controller.session.stable-identity");
  }
  if (/(?:^|\s)--plugin-dir(?:[=\s,]|$)/m.test(help)) {
    try {
      const result = await invokeClaudeMetadataCommand(executable, [
        "--plugin-dir", pluginDirectory, "plugin", "list", "--json",
      ]);
      const pluginInventory = JSON.stringify(JSON.parse(result.stdout));
      if (
        pluginInventory.includes("sandking-controller")
        && pluginInventory.includes("1.0.0")
      ) {
        for (const capability of pluginCapabilities) detected.add(capability);
      }
    } catch {
      // A CLI that cannot load and enumerate the shipped plugin does not support its capabilities.
    }
  }
  return capabilities.filter((capability) => detected.has(capability));
};

export const probeClaude = async () => {
  const executable = process.env.SANDKING_CLAUDE_EXECUTABLE ?? "claude";
  let version;
  try {
    const result = await invokeClaudeMetadataCommand(executable, ["--version"]);
    version = /(?:^|\s)([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/.exec(result.stdout.trim())?.[1];
    if (!version) {
      throw new Error("provider_cli_version_invalid");
    }
  } catch (error) {
    const unavailable = error && typeof error === "object" && "code" in error
      && (error.code === "ENOENT" || error.code === "EACCES");
    return {
      ...baseProbe([]),
      availability: {
        status: "unavailable",
        command: "claude",
        version: null,
        authentication: { status: "unknown", source: "destination-local" },
        failure: {
          code: unavailable ? "provider_cli_unavailable" : "provider_cli_probe_failed",
          retryable: true,
        },
      },
    };
  }

  const detectedCapabilities = await detectClaudeCapabilities(executable);
  if (detectedCapabilities.length !== capabilities.length) {
    return {
      ...baseProbe(detectedCapabilities),
      availability: {
        status: "unavailable",
        command: "claude",
        version,
        authentication: { status: "unknown", source: "destination-local" },
        failure: { code: "provider_cli_incompatible", retryable: false },
      },
    };
  }

  try {
    const result = await invokeClaudeMetadataCommand(executable, ["auth", "status"]);
    const status = JSON.parse(result.stdout);
    if (status?.loggedIn !== true && status?.authenticated !== true) {
      throw new Error("provider_authentication_missing");
    }
    return {
      ...baseProbe(detectedCapabilities),
      availability: {
        status: "available",
        command: "claude",
        version,
        authentication: { status: "authenticated", source: "destination-local" },
        failure: null,
      },
    };
  } catch {
    return {
      ...baseProbe(detectedCapabilities),
      availability: {
        status: "unauthenticated",
        command: "claude",
        version,
        authentication: { status: "missing", source: "destination-local" },
        failure: { code: "provider_authentication_missing", retryable: false },
      },
    };
  }
};

/** @param {string[]} argv */
const prepareClaude = async (argv) => {
  const flags = parseFlags(argv);
  const sessionId = flags.get("session-id") ?? "";
  const providerSessionId = flags.get("provider-session-id") ?? "";
  const workContextId = flags.get("work-context-id") ?? "";
  const canonicalReference = flags.get("canonical-reference") ?? "";
  const controlEndpoint = flags.get("control-endpoint") ?? "";
  if (
    !controllerSessionPattern.test(sessionId)
    || !providerSessionPattern.test(providerSessionId)
    || !workContextPattern.test(workContextId)
    || !canonicalReferencePattern.test(canonicalReference)
    || controlEndpoint.length < 1
    || controlEndpoint.length > 512
    || /[\r\n\0]/.test(controlEndpoint)
  ) {
    throw new Error("provider_session_contract_invalid");
  }
  const probe = await probeClaude();
  if (probe.availability.status !== "available") {
    throw new Error(probe.availability.failure?.code ?? "provider_adapter_failed");
  }
  const environment = {
    ...createClaudeDestinationEnvironment(),
    SANDKING_CLAUDE_SESSION_ID: providerSessionId,
    SANDKING_CONTROLLER_SESSION_ID: sessionId,
  };
  return {
    type: "provider.session.prepared",
    adapterProtocol,
    adapterId,
    provider,
    providerSessionId,
    capabilities,
    terminal: {
      ptyRequired: true,
      columns: 100,
      rows: 30,
    },
    control: {
      protocol: adapterProtocol,
      readySignal: "provider.session.ready",
      exitSignal: "provider.session.exit",
      endpoint: controlEndpoint,
    },
    sessionIdentity: {
      stable: true,
      source: "controller-assigned-supported-cli-flag",
    },
    integration: {
      pluginDirectory,
      pluginId: "sandking-controller",
      pluginVersion: "1.0.0",
      scope: "session",
      loading: "--plugin-dir",
      boundary: "session-plugin-private-typed-shim",
      credentialsTransferred: false,
    },
    command: {
      executable: process.execPath,
      args: [
        adapterPath,
        "run",
        "--session-id", sessionId,
        "--provider-session-id", providerSessionId,
        "--work-context-id", workContextId,
        "--canonical-reference", canonicalReference,
        "--control-endpoint", controlEndpoint,
      ],
      providerArgs: [
        "--session-id", providerSessionId,
        "--plugin-dir", pluginDirectory,
      ],
      environment,
    },
  };
};

/**
 * @param {string} endpoint
 * @param {Record<string, any>} readyMessage
 * @returns {Promise<any>}
 */
const openRuntimeControl = async (endpoint, readyMessage) => new Promise((resolve, reject) => {
  const socket = createConnection(endpoint);
  const pending = new Map();
  let input = "";
  let operationSequence = 0;
  let settled = false;
  /** @param {Error | null} error @param {unknown} [value] */
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error) reject(error);
    else resolve(value);
  };
  const timeout = setTimeout(() => {
    socket.destroy();
    finish(new Error("provider_control_timeout"));
  }, 3_000);
  socket.once("connect", () => {
    finish(null, {
      ready: () => socket.write(`${JSON.stringify(readyMessage)}\n`),
      /** @param {string} operation @param {unknown} operationInput */
      request: (operation, operationInput) => new Promise((resolveOperation, rejectOperation) => {
        const operationId = `provider-operation-${operationSequence}`;
        operationSequence += 1;
        const operationTimeout = setTimeout(() => {
          pending.delete(operationId);
          rejectOperation(new Error("provider_operation_timeout"));
        }, 5_000);
        pending.set(operationId, {
          /** @param {unknown} value */
          resolve: (value) => {
            clearTimeout(operationTimeout);
            resolveOperation(value);
          },
          /** @param {Error} error */
          reject: (error) => {
            clearTimeout(operationTimeout);
            rejectOperation(error);
          },
        });
        socket.write(`${JSON.stringify({
          type: "provider.operation.request",
          controlProtocol: adapterProtocol,
          operationId,
          sessionId: readyMessage.sessionId,
          providerSessionId: readyMessage.providerSessionId,
          operation,
          input: operationInput,
        })}\n`);
      }),
      /** @param {Record<string, unknown>} message */
      notify: (message) => {
        if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
      },
      close: () => new Promise((resolve) => {
        if (socket.destroyed) {
          resolve(undefined);
          return;
        }
        socket.end(() => resolve(undefined));
      }),
    });
  });
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    input += chunk;
    if (Buffer.byteLength(input, "utf8") > 65_536) {
      socket.destroy(new Error("provider_control_frame_too_large"));
      return;
    }
    while (input.includes("\n")) {
      const newline = input.indexOf("\n");
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        socket.destroy(new Error("provider_control_protocol_invalid"));
        return;
      }
      const operation = pending.get(response?.operationId);
      if (!operation || response?.type !== "provider.operation.result") {
        socket.destroy(new Error("provider_control_protocol_invalid"));
        return;
      }
      pending.delete(response.operationId);
      if (response.ok === true) operation.resolve(response.outcome);
      else operation.reject(new Error(response?.failure?.code ?? "provider_operation_failed"));
    }
  });
  socket.once("error", () => finish(new Error("provider_control_unavailable")));
  socket.once("close", () => {
    for (const operation of pending.values()) {
      operation.reject(new Error("provider_control_unavailable"));
    }
    pending.clear();
    if (!settled) finish(new Error("provider_control_unavailable"));
  });
});

/** @param {unknown} value */
const canonicalDigest = (value) => createHash("sha256")
  .update(JSON.stringify(value))
  .digest("hex");

/**
 * @param {{sessionId: string, providerSessionId: string, control: any, recordProviderFailure: (failure: {code: string, retryable: boolean, source: string}) => void}} options
 */
const openPluginShimServer = async ({
  sessionId,
  providerSessionId,
  control,
  recordProviderFailure,
}) => {
  const directory = process.platform === "win32"
    ? null
    : await mkdtemp(join(tmpdir(), "sandking-claude-shim-"));
  const endpoint = directory
    ? join(directory, "operations.sock")
    : `\\\\.\\pipe\\sandking-claude-shim-${canonicalDigest({ sessionId }).slice(0, 24)}`;
  let closed = false;

  /** @param {any} request */
  const handle = async (request) => {
    if (
      request?.type !== "claude.plugin.operation.request"
      || request.protocol !== "1.0.0"
      || typeof request.operationId !== "string"
      || !/^claude-plugin-operation-[a-f0-9]{24}$/.test(request.operationId)
      || request.controllerSessionId !== sessionId
      || request.providerSessionId !== providerSessionId
      || !request.input
      || typeof request.input !== "object"
    ) {
      throw new Error("claude_plugin_protocol_invalid");
    }
    if (request.operation === "work-context.inspect") {
      return control.request("work-context.inspect", {});
    }
    if (request.operation === "launch-request.prepare") {
      const parameters = request.input.parameters;
      const expiresInSeconds = Number(request.input.expiresInSeconds);
      if (
        !parameters
        || typeof parameters !== "object"
        || !Number.isSafeInteger(parameters.issueNumber)
        || parameters.issueNumber < 1
        || parameters.issueNumber > 4_095
        || parameters.targetBranch !== `sandcastle/issue-${parameters.issueNumber}`
        || expiresInSeconds !== 300
      ) {
        throw new Error("launch_request_parameters_invalid");
      }
      return control.request("launch-request.prepare", {
        parameters,
        expiresInSeconds,
        idempotencyKey: `provider:${sessionId}:prepare:${canonicalDigest(parameters)}`,
      });
    }
    if (request.operation === "launch-request.decide") {
      const { launchRequestId, decision } = request.input;
      const expectedRevision = Number(request.input.expectedRevision);
      if (
        !launchRequestPattern.test(String(launchRequestId))
        || (decision !== "approved" && decision !== "rejected")
        || !Number.isSafeInteger(expectedRevision)
        || expectedRevision < 1
      ) {
        throw new Error("launch_request_decision_invalid");
      }
      return control.request("launch-request.decide", {
        launchRequestId,
        decision,
        expectedRevision,
        idempotencyKey:
          `provider:${sessionId}:decision:${launchRequestId}:${expectedRevision}:${decision}`,
      });
    }
    if (request.operation === "harness-run.start") {
      const { launchRequestId } = request.input;
      const expectedRevision = Number(request.input.expectedRevision);
      if (
        !launchRequestPattern.test(String(launchRequestId))
        || !Number.isSafeInteger(expectedRevision)
        || expectedRevision < 1
      ) {
        throw new Error("harness_run_start_invalid");
      }
      return control.request("harness-run.start", {
        launchRequestId,
        expectedRevision,
        idempotencyKey:
          `provider:${sessionId}:harness-run:start:${launchRequestId}:${expectedRevision}`,
      });
    }
    if (request.operation === "claude.session-start") {
      if (
        request.input.hookEventName !== "SessionStart"
        || request.input.sessionId !== providerSessionId
        || !["startup", "resume"].includes(request.input.source)
      ) {
        throw new Error("claude_session_identity_mismatch");
      }
      const inspected = await control.request("work-context.inspect", {});
      return {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext:
            `Sand-King selected work context (sanitized): ${JSON.stringify(inspected)}`,
        },
      };
    }
    if (request.operation === "claude.stop-failure") {
      if (
        request.input.hookEventName !== "StopFailure"
        || request.input.sessionId !== providerSessionId
      ) {
        throw new Error("claude_session_identity_mismatch");
      }
      const failure = classifyClaudeStopFailure(request.input);
      recordProviderFailure(failure);
      control.notify({
        type: "provider.session.failure",
        controlProtocol: adapterProtocol,
        adapterId,
        sessionId,
        providerSessionId,
        failure,
      });
      return { reported: true, failure };
    }
    throw new Error("claude_plugin_operation_unsupported");
  };

  const server = createNetServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > 32_768) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      const line = input.slice(0, input.indexOf("\n"));
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      handle(request).then(
        (outcome) => socket.end(`${JSON.stringify({
          type: "claude.plugin.operation.result",
          protocol: "1.0.0",
          operationId: request.operationId,
          ok: true,
          outcome,
        })}\n`),
        (error) => socket.end(`${JSON.stringify({
          type: "claude.plugin.operation.result",
          protocol: "1.0.0",
          operationId: request.operationId,
          ok: false,
          failure: {
            code: error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
              ? error.message
              : "claude_plugin_operation_failed",
          },
        })}\n`),
      );
    });
  });
  await new Promise((resolve, reject) => {
    const onError = () => reject(new Error("claude_plugin_channel_unavailable"));
    server.once("error", onError);
    server.listen(endpoint, () => {
      server.off("error", onError);
      resolve(undefined);
    });
  });
  return {
    endpoint,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
};

/** @param {string[]} argv */
const runClaude = async (argv) => {
  const flags = parseFlags(argv);
  const sessionId = flags.get("session-id") ?? "";
  const providerSessionId = flags.get("provider-session-id") ?? "";
  const workContextId = flags.get("work-context-id") ?? "";
  const canonicalReference = flags.get("canonical-reference") ?? "";
  const controlEndpoint = flags.get("control-endpoint") ?? "";
  if (
    !controllerSessionPattern.test(sessionId)
    || !providerSessionPattern.test(providerSessionId)
    || !workContextPattern.test(workContextId)
    || !canonicalReferencePattern.test(canonicalReference)
    || controlEndpoint.length < 1
    || controlEndpoint.length > 512
    || /[\r\n\0]/.test(controlEndpoint)
    || process.stdin.isTTY !== true
    || process.stdout.isTTY !== true
  ) {
    throw new Error("provider_session_contract_invalid");
  }

  const readyMessage = {
    type: "provider.session.ready",
    controlProtocol: adapterProtocol,
    adapterId,
    sessionId,
    providerSessionId,
    workContext: { workContextId, canonicalReference },
    sessionIdentity: {
      stable: true,
      source: "controller-assigned-supported-cli-flag",
    },
    process: { pid: process.pid },
    terminal: { stdinTty: true, stdoutTty: true },
  };
  const control = await openRuntimeControl(controlEndpoint, readyMessage);
  let providerFailure = null;
  const shim = await openPluginShimServer({
    sessionId,
    providerSessionId,
    control,
    recordProviderFailure: (failure) => {
      providerFailure = failure;
    },
  });
  const executable = process.env.SANDKING_CLAUDE_EXECUTABLE ?? "claude";
  const providerArgs = ["--session-id", providerSessionId, "--plugin-dir", pluginDirectory];
  let runtimeTerminated = false;
  /** @type {import("node:child_process").ChildProcess} */
  let child;
  try {
    child = spawn(executable, providerArgs, {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...createClaudeDestinationEnvironment(),
        SANDKING_CLAUDE_SHIM_ENDPOINT: shim.endpoint,
        SANDKING_CLAUDE_SESSION_ID: providerSessionId,
        SANDKING_CONTROLLER_SESSION_ID: sessionId,
      },
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    control.ready();
  } catch {
    const reason = {
      code: "provider_cli_unavailable",
      retryable: true,
      source: "claude-cli",
    };
    control.notify({
      type: "provider.session.exit",
      controlProtocol: adapterProtocol,
      adapterId,
      sessionId,
      providerSessionId,
      reason,
    });
    await shim.close();
    await control.close();
    throw new Error(reason.code);
  }

  /** @param {NodeJS.Signals} signal */
  const relay = (signal) => {
    runtimeTerminated = true;
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const signalHandlers = new Map([
    ["SIGTERM", () => relay("SIGTERM")],
    ["SIGINT", () => relay("SIGINT")],
    ["SIGHUP", () => relay("SIGHUP")],
  ]);
  for (const [signal, handler] of signalHandlers) process.once(signal, handler);
  const outcome = await new Promise((resolve) => {
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  const reason = providerFailure ?? (runtimeTerminated || outcome.signal
    ? { code: "runtime_terminated", retryable: false, source: "controller-runtime" }
    : outcome.exitCode === 0
      ? { code: "provider_session_completed", retryable: false, source: "claude-cli" }
      : {
          code: "provider_model_behavior_unconfirmed",
          retryable: true,
          source: "claude-cli",
        });
  control.notify({
    type: "provider.session.exit",
    controlProtocol: adapterProtocol,
    adapterId,
    sessionId,
    providerSessionId,
    reason,
  });
  await shim.close();
  await control.close();
  process.exitCode = outcome.exitCode ?? (outcome.signal ? 1 : 0);
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "probe") {
    writeResult(await probeClaude());
    return;
  }
  if (command === "prepare") {
    writeResult(await prepareClaude(rest));
    return;
  }
  if (command === "run") {
    await runClaude(rest);
    return;
  }
  throw new Error("provider_adapter_command_invalid");
};

if (process.argv[1] === adapterPath) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "provider_adapter_failed"}\n`);
    process.exitCode = 1;
  }
}
