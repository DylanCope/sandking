#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
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
  "controller.harness-run.launch",
  "controller.harness-run.cancel",
  "controller.session.stable-identity",
  "controller.session.typed-exit",
]);
const baseSessionCapabilities = Object.freeze([
  "controller.session.start",
  "controller.session.interactive",
  "controller.session.terminate",
]);
const adapterPath = fileURLToPath(import.meta.url);
const controllerSessionPattern = /^controller-session-[a-f0-9]{24}$/;
const providerSessionPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const workContextPattern = /^[a-zA-Z0-9._:-]{1,160}$/;
const canonicalReferencePattern = /^(?:github:fixture:issue:[0-9]+|sandking:project:project-[a-f0-9]{24})$/;
const claudeStopFailureTypes = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "rate_limit",
  "overloaded",
  "server_error",
  "network_error",
  "invalid_request",
  "model_not_found",
  "max_output_tokens",
  "unknown",
]);
// `--settings` predates the notification-only StopFailure event. Treat the
// documented 2.1.78 introduction as part of the typed-exit capability seam.
const claudeStopFailureMinimumVersion = Object.freeze([2, 1, 78]);

/** @param {string} version @param {readonly number[]} minimum */
const versionAtLeast = (version, minimum) => {
  const parts = version.split(".").map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (parts[index] > minimum[index]) return true;
    if (parts[index] < minimum[index]) return false;
  }
  return true;
};

/** @param {unknown} input */
export const classifyClaudeStopFailure = (input) => {
  const error = input && typeof input === "object" && "error" in input
    && typeof input.error === "string"
    ? input.error
    : null;
  const type = input && typeof input === "object" && "type" in input
    && typeof input.type === "string"
    ? input.type
    : null;
  const failureType = error ?? type;
  if (
    !input
    || typeof input !== "object"
    || (error !== null && type !== null && error !== type)
    || failureType === null
    || !claudeStopFailureTypes.has(failureType)
  ) {
    return { code: "provider_adapter_failed", retryable: true, source: "sandking-adapter" };
  }
  if (failureType === "authentication_failed" || failureType === "oauth_org_not_allowed") {
    return {
      code: "provider_authentication_failed",
      retryable: false,
      source: "claude-stop-failure",
    };
  }
  if (failureType === "rate_limit" || failureType === "billing_error") {
    return {
      code: "provider_quota_unavailable",
      retryable: failureType === "rate_limit",
      source: "claude-stop-failure",
    };
  }
  if (failureType === "overloaded" || failureType === "server_error") {
    return { code: "provider_outage", retryable: true, source: "claude-stop-failure" };
  }
  const details = [
    "error_details" in input && typeof input.error_details === "string"
      ? input.error_details
      : "",
    "last_assistant_message" in input && typeof input.last_assistant_message === "string"
      ? input.last_assistant_message
      : "",
  ]
    .filter(Boolean)
    .map((detail) => detail.slice(0, 512))
    .join("\n");
  if (
    failureType === "network_error"
    || (failureType === "unknown"
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
    retryable: failureType !== "invalid_request" && failureType !== "model_not_found",
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
  environment.COLORTERM ??= "truecolor";
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

/** @param {string} stdout */
const parseClaudeAuthenticationStatus = (stdout) => {
  const status = JSON.parse(stdout);
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error("provider_authentication_status_invalid");
  }
  /** @type {boolean[]} */
  const declarations = [];
  for (const property of ["loggedIn", "authenticated"]) {
    if (Object.hasOwn(status, property)) {
      if (typeof status[property] !== "boolean") {
        throw new Error("provider_authentication_status_invalid");
      }
      declarations.push(status[property]);
    }
  }
  if (
    declarations.length === 0
    || declarations.some((value) => value !== declarations[0])
  ) {
    throw new Error("provider_authentication_status_invalid");
  }
  return declarations[0];
};

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
});

/** @param {string} executable @param {string} version */
const detectClaudeCapabilities = async (executable, version) => {
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
    detected.add("controller.harness-run.launch");
    detected.add("controller.harness-run.cancel");
  }
  if (
    /(?:^|\s)--settings(?:[=\s,]|$)/m.test(help)
    && versionAtLeast(version, claudeStopFailureMinimumVersion)
  ) {
    detected.add("controller.session.typed-exit");
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

  const detectedCapabilities = await detectClaudeCapabilities(executable, version);
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

  const missingAuthentication = () => ({
    ...baseProbe(detectedCapabilities),
    availability: {
      status: "unauthenticated",
      command: "claude",
      version,
      authentication: { status: "missing", source: "destination-local" },
      failure: { code: "provider_authentication_missing", retryable: false },
    },
  });
  const failedAuthenticationProbe = () => ({
    ...baseProbe(detectedCapabilities),
    availability: {
      status: "unavailable",
      command: "claude",
      version,
      authentication: { status: "unknown", source: "destination-local" },
      failure: { code: "provider_adapter_failed", retryable: true },
    },
  });

  let result;
  try {
    result = await invokeClaudeMetadataCommand(executable, ["auth", "status"]);
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && "code" in error
      && error.code === 1
      && "stdout" in error
      && typeof error.stdout === "string"
    ) {
      try {
        if (parseClaudeAuthenticationStatus(error.stdout) === false) {
          return missingAuthentication();
        }
      } catch {
        // Invalid output from a failed process is an adapter/protocol failure.
      }
    }
    return failedAuthenticationProbe();
  }
  try {
    if (parseClaudeAuthenticationStatus(result.stdout) === false) {
      return missingAuthentication();
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
    return failedAuthenticationProbe();
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
  const timedOutOperationIds = new Set();
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
          timedOutOperationIds.add(operationId);
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
      if (!operation) {
        if (
          response?.type === "provider.operation.result"
          && timedOutOperationIds.delete(response.operationId)
        ) {
          continue;
        }
        socket.destroy(new Error("provider_control_protocol_invalid"));
        return;
      }
      if (response?.type !== "provider.operation.result") {
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
    timedOutOperationIds.clear();
    if (!settled) finish(new Error("provider_control_unavailable"));
  });
});

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
const canonicalDigest = (value) => createHash("sha256")
  .update(canonicalJson(value))
  .digest("hex");

/**
 * Keep the adapter entry point self-contained while enforcing the same
 * correlation contract as the packaged CLI at the provider/runtime seam.
 * @param {any} outcome
 * @param {{projectId: string, controllerSessionId: string, parameters: any, idempotencyKeyHash: string}} request
 */
const requireCorrelatedControllerLaunchResult = (outcome, request) => {
  const run = outcome?.run;
  if (
    outcome?.type !== "harness.run.launch.result"
    || !["harness_run_created", "harness_run_found"].includes(outcome.code)
    || outcome.authorizationClass !== "harness_run_launch"
    || outcome.idempotencyKeyHash !== request.idempotencyKeyHash
    || !/^harness-run-[a-f0-9]{24}$/.test(run?.harnessRunId ?? "")
    || run?.projectId !== request.projectId
    || run?.controllerSessionId !== request.controllerSessionId
    || run?.source !== "controller-cli"
    || canonicalDigest(run?.parameters ?? {}) !== canonicalDigest(request.parameters)
  ) {
    throw new Error("controller_cli_protocol_invalid");
  }
  return outcome;
};

/**
 * A successful lookup can recover either side of the original launch
 * mutation. Keep that transport success distinct from the launch outcome so
 * the ordinary CLI never exits zero for a durably retained Host failure.
 * @param {any} outcome
 * @param {{projectId: string, controllerSessionId: string, parameters: any, idempotencyKeyHash: string}} request
 */
const requireSuccessfulControllerLaunch = (outcome, request) => {
  if (
    outcome?.type === "harness.run.launch.result"
    && /^harness-run-[a-f0-9]{24}$/.test(outcome.run?.harnessRunId ?? "")
  ) {
    return requireCorrelatedControllerLaunchResult(outcome, request);
  }
  if (
    outcome?.type === "harness.run.launch.failure"
    && /^[a-z0-9_]{1,128}$/.test(outcome.code ?? "")
  ) {
    throw new Error(outcome.code);
  }
  throw new Error("controller_cli_protocol_invalid");
};

/**
 * Preserve Claude's typed API failures without loading a plugin. This
 * provider-owned, notification-only HTTP hook does not mediate tool calls or
 * Harness launches; it only forwards the documented StopFailure event.
 * @param {{providerSessionId: string, recordProviderFailure: (failure: {code: string, retryable: boolean, source: string}) => void}} options
 */
const openClaudeFailureTelemetry = async ({ providerSessionId, recordProviderFailure }) => {
  const path = `/stop-failure/${randomBytes(12).toString("hex")}`;
  const server = createHttpServer((request, response) => {
    if (
      request.method !== "POST"
      || request.url !== path
      || request.headers["content-type"]?.split(";", 1)[0] !== "application/json"
    ) {
      response.writeHead(404).end();
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.byteLength;
      if (size > 32_768) {
        request.destroy();
        response.writeHead(413).end();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.once("end", () => {
      if (size > 32_768) return;
      let event;
      try {
        event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (
        event?.hook_event_name !== "StopFailure"
        || event.session_id !== providerSessionId
      ) {
        response.writeHead(400).end();
        return;
      }
      recordProviderFailure(classifyClaudeStopFailure(event));
      response.writeHead(204).end();
    });
  });
  server.maxConnections = 4;
  await new Promise((resolve, reject) => {
    const onError = () => reject(new Error("claude_failure_telemetry_unavailable"));
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve(undefined);
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    throw new Error("claude_failure_telemetry_unavailable");
  }
  const url = `http://127.0.0.1:${address.port}${path}`;
  return {
    settings: {
      allowedHttpHookUrls: [url],
      hooks: {
        StopFailure: [{
          hooks: [{ type: "http", url, timeout: 3 }],
        }],
      },
    },
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
};

/**
 * @param {{sessionId: string, workContextId: string, control: any}} options
 */
const openControllerCliServer = async ({
  sessionId,
  workContextId,
  control,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "sandking-controller-cli-"));
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\sandking-controller-cli-${canonicalDigest({ sessionId }).slice(0, 24)}`
    : join(directory, "operations.sock");
  let closed = false;
  let providerReady = false;
  /** @type {() => void} */
  let releaseProviderReady = () => undefined;
  /** @type {Promise<void>} */
  const waitForProviderReady = new Promise((resolve) => {
    releaseProviderReady = () => resolve();
  });

  /** @param {any} request */
  const handle = async (request) => {
    if (
      request?.type !== "sandking.cli.request"
      || request.protocol !== "1.0.0"
      || !/^sandking-cli-[a-f0-9]{16}$/.test(request.requestId ?? "")
      || request.controllerSessionId !== sessionId
      || request.projectId !== workContextId
      || !["describe", "harness-run.launch", "harness-run.cancel"].includes(request.operation)
    ) {
      throw new Error("controller_cli_contract_invalid");
    }
    // A freshly spawned provider can discover and invoke `sandking` before
    // this adapter's spawn event is delivered. Keep that operation queued so
    // provider.session.ready is always the first frame on the shared control
    // socket; otherwise the runtime can reject a valid session nondeterministically.
    await waitForProviderReady;
    if (!providerReady) {
      throw new Error("controller_cli_unavailable");
    }
    if (request.operation === "describe") {
      return control.request("controller-cli.describe", {});
    }
    if (request.operation === "harness-run.cancel") {
      if (
        !/^harness-run-[a-f0-9]{24}$/.test(request.harnessRunId ?? "")
        || !/^sha256:[a-f0-9]{64}$/.test(request.idempotencyKeyHash ?? "")
      ) {
        throw new Error("controller_cli_contract_invalid");
      }
      const outcome = await control.request("harness-run.cancel", {
        harnessRunId: request.harnessRunId,
        idempotencyKeyHash: request.idempotencyKeyHash,
      });
      if (
        outcome?.type !== "harness.run.cancel.result"
        || outcome.harnessRunId !== request.harnessRunId
        || outcome.idempotencyKeyHash !== request.idempotencyKeyHash
      ) {
        if (outcome?.type === "harness.run.cancel.failure"
          && /^[a-z0-9_]{1,128}$/.test(outcome.code ?? "")) {
          throw new Error(outcome.code);
        }
        throw new Error("controller_cli_protocol_invalid");
      }
      return outcome;
    }
    const parameters = request.parameters ?? {};
    let parametersValid = parameters
      && typeof parameters === "object"
      && !Array.isArray(parameters)
      && Object.keys(parameters).length <= 16;
    try {
      parametersValid = parametersValid
        && Buffer.byteLength(JSON.stringify(parameters), "utf8") <= 8_192;
    } catch {
      parametersValid = false;
    }
    if (
      !parametersValid
      || !/^sha256:[a-f0-9]{64}$/.test(request.idempotencyKeyHash ?? "")
    ) {
      throw new Error("controller_cli_contract_invalid");
    }
    const correlation = {
      projectId: workContextId,
      controllerSessionId: sessionId,
      parameters,
      idempotencyKeyHash: request.idempotencyKeyHash,
    };
    try {
      return requireSuccessfulControllerLaunch(await control.request("harness-run.launch", {
        ...(Object.keys(parameters).length === 0 ? {} : { parameters }),
        idempotencyKeyHash: request.idempotencyKeyHash,
      }), correlation);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "provider_operation_timeout") {
        throw error;
      }
      let lookup;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          lookup = await control.request("harness-run.lookup", {
            idempotencyKeyHash: request.idempotencyKeyHash,
          });
          break;
        } catch (lookupError) {
          if (
            !(lookupError instanceof Error)
            || lookupError.message !== "provider_operation_timeout"
            || attempt === 1
          ) {
            throw lookupError;
          }
          // The runtime serializes provider operations, so the first lookup
          // can spend its whole window queued behind the accepted launch.
          // Retry only the exact same-key read; never issue a second launch.
        }
      }
      if (
        lookup?.type !== "harness.run.lookup.result"
        || lookup.found !== true
        || !lookup.launchOutcome
      ) {
        throw error;
      }
      return requireSuccessfulControllerLaunch(lookup.launchOutcome, correlation);
    }
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
          type: "sandking.cli.result",
          protocol: "1.0.0",
          requestId: request.requestId,
          ok: true,
          outcome,
        })}\n`),
        (error) => socket.end(`${JSON.stringify({
          type: "sandking.cli.result",
          protocol: "1.0.0",
          requestId: request.requestId,
          ok: false,
          failure: {
            code: error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
              ? error.message
              : "controller_cli_operation_failed",
          },
        })}\n`),
      );
    });
  });
  await new Promise((resolve, reject) => {
    const onError = () => reject(new Error("controller_cli_unavailable"));
    server.once("error", onError);
    server.listen(endpoint, () => {
      server.off("error", onError);
      resolve(undefined);
    });
  });
  return {
    endpoint,
    retryDirectory: directory,
    announceProviderReady: () => {
      if (closed || providerReady) return false;
      providerReady = true;
      releaseProviderReady();
      return true;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      releaseProviderReady();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      await rm(directory, { recursive: true, force: true });
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
  const controllerCli = await openControllerCliServer({
    sessionId,
    workContextId,
    control,
  });
  let providerFailure = null;
  const failureTelemetry = await openClaudeFailureTelemetry({
    providerSessionId,
    recordProviderFailure: (failure) => {
      providerFailure = failure;
      control.notify({
        type: "provider.session.failure",
        controlProtocol: adapterProtocol,
        adapterId,
        sessionId,
        providerSessionId,
        failure,
      });
    },
  });
  const executable = process.env.SANDKING_CLAUDE_EXECUTABLE ?? "claude";
  const providerArgs = [
    "--session-id", providerSessionId,
    "--settings", JSON.stringify(failureTelemetry.settings),
  ];
  let runtimeTerminated = false;
  /** @type {import("node:child_process").ChildProcess} */
  let child;
  try {
    child = spawn(executable, providerArgs, {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...createClaudeDestinationEnvironment(),
        SANDKING_CONTROLLER_ENDPOINT: controllerCli.endpoint,
        SANDKING_CONTROLLER_RETRY_DIRECTORY: controllerCli.retryDirectory,
        SANDKING_CONTROLLER_SESSION_ID: sessionId,
        SANDKING_WORK_CONTEXT_ID: workContextId,
      },
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    control.ready();
    if (!controllerCli.announceProviderReady()) {
      throw new Error("controller_cli_unavailable");
    }
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
    await controllerCli.close();
    await failureTelemetry.close();
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
  await controllerCli.close();
  await failureTelemetry.close();
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
