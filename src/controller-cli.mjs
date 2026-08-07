import { createHash, randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { harnessLaunchParametersDeclarationSchema } from "./harness-adapter-protocol.mjs";
import { launchParametersSchema } from "./harness-launch.mjs";
import { readJson, removePrivateFile, writePrivateJson } from "./private-state.mjs";

const projectIdPattern = /^project-[a-f0-9]{24}$/;
const controllerSessionPattern = /^controller-session-[a-f0-9]{24}$/;
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const pendingLaunchStateSchema = z.object({
  schemaVersion: z.literal(1),
  launches: z.array(z.object({
    requestFingerprint: digestSchema,
    retryHash: digestSchema,
  }).strict()).max(64),
}).strict();
const controllerCliDescriptionSchema = z.object({
  type: z.literal("controller.cli.description"),
  protocol: z.literal("1.0.0"),
  command: z.literal("sandking launch"),
  focusedProjectId: z.string().regex(projectIdPattern),
  projectArgumentOptional: z.literal(true),
  pluginRequired: z.literal(false),
  launchParameters: harnessLaunchParametersDeclarationSchema,
}).strict();
const controllerLaunchResultSchema = z.object({
  type: z.literal("harness.run.launch.result"),
  code: z.enum(["harness_run_created", "harness_run_found"]),
  authorizationClass: z.literal("harness_run_launch"),
  idempotencyKeyHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  run: z.object({
    harnessRunId: z.string().regex(/^harness-run-[a-f0-9]{24}$/),
    projectId: z.string().regex(projectIdPattern),
    parameters: launchParametersSchema,
    source: z.literal("controller-cli"),
    controllerSessionId: z.string().regex(controllerSessionPattern),
  }).passthrough(),
}).passthrough();
// A launch may consume one provider-operation window, while the first exact
// lookup can spend a second window queued behind it. Leave one final lookup
// window plus bounded transport overhead without ever retrying the mutation.
const CONTROLLER_CLI_TIMEOUT_MS = 17_000;
const pendingLaunchStateFile = "harness-launch-retries.json";

class ControllerCliAcknowledgedFailure extends Error {}

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
const digest = (value) => `sha256:${createHash("sha256").update(
  typeof value === "string" ? value : canonicalJson(value),
).digest("hex")}`;

/** @param {NodeJS.ProcessEnv} environment */
const retryStatePath = (environment) => {
  const directory = environment.SANDKING_CONTROLLER_RETRY_DIRECTORY ?? "";
  if (
    directory.length < 1
    || directory.length > 4_096
    || /[\r\n\0]/.test(directory)
    || !isAbsolute(directory)
  ) {
    throw new Error("controller_cli_retry_state_unavailable");
  }
  return join(directory, pendingLaunchStateFile);
};

/**
 * Keep only hashed retry plumbing in the Controller-owned private directory.
 * The file outlives one ordinary CLI process, but is removed with the active
 * provider session and never touches the Project.
 * @param {{projectId: string, controllerSessionId: string, parameters: unknown}} request
 * @param {NodeJS.ProcessEnv} environment
 */
const retainPendingLaunch = async (request, environment) => {
  const path = retryStatePath(environment);
  const parsed = pendingLaunchStateSchema.safeParse(await readJson(path, {
    schemaVersion: 1,
    launches: [],
  }));
  if (!parsed.success) {
    throw new Error("controller_cli_retry_state_invalid");
  }
  const requestFingerprint = digest(request);
  const existing = parsed.data.launches.find((launch) =>
    launch.requestFingerprint === requestFingerprint);
  if (existing) {
    return { path, requestFingerprint, retryHash: existing.retryHash };
  }
  if (parsed.data.launches.length >= 64) {
    throw new Error("controller_cli_retry_capacity_exceeded");
  }
  const retryHash = digest(randomBytes(32));
  parsed.data.launches.push({ requestFingerprint, retryHash });
  await writePrivateJson(path, parsed.data);
  return { path, requestFingerprint, retryHash };
};

/** @param {{path: string, requestFingerprint: string, retryHash: string}} pending */
const clearPendingLaunch = async (pending) => {
  const parsed = pendingLaunchStateSchema.safeParse(await readJson(pending.path, {
    schemaVersion: 1,
    launches: [],
  }));
  if (!parsed.success) {
    throw new Error("controller_cli_retry_state_invalid");
  }
  parsed.data.launches = parsed.data.launches.filter((launch) =>
    launch.requestFingerprint !== pending.requestFingerprint
    || launch.retryHash !== pending.retryHash);
  if (parsed.data.launches.length === 0) {
    await removePrivateFile(pending.path);
  } else {
    await writePrivateJson(pending.path, parsed.data);
  }
};

/**
 * @param {{operation: "describe" | "harness-run.launch", projectId: string, parameters?: unknown, idempotencyKeyHash?: string}} request
 * @param {NodeJS.ProcessEnv} environment
 */
const requestControllerOperation = async (request, environment) => {
  const endpoint = environment.SANDKING_CONTROLLER_ENDPOINT ?? "";
  const controllerSessionId = environment.SANDKING_CONTROLLER_SESSION_ID ?? "";
  const workContextId = environment.SANDKING_WORK_CONTEXT_ID ?? "";
  if (
    endpoint.length < 1
    || endpoint.length > 512
    || /[\r\n\0]/.test(endpoint)
    || !controllerSessionPattern.test(controllerSessionId)
    || !projectIdPattern.test(request.projectId)
    || request.projectId !== workContextId
  ) {
    throw new Error("controller_cli_contract_invalid");
  }
  const requestId = `sandking-cli-${randomBytes(8).toString("hex")}`;
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let input = "";
    let settled = false;
    /** @param {Error | null} error @param {unknown} [value] */
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(
      () => finish(new Error("controller_cli_timeout")),
      CONTROLLER_CLI_TIMEOUT_MS,
    );
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        type: "sandking.cli.request",
        protocol: "1.0.0",
        requestId,
        operation: request.operation,
        controllerSessionId,
        projectId: request.projectId,
        ...(request.operation === "harness-run.launch" ? {
          parameters: request.parameters,
          idempotencyKeyHash: request.idempotencyKeyHash,
        } : {}),
      })}\n`);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > 65_536) {
        finish(new Error("controller_cli_protocol_invalid"));
        return;
      }
      if (!input.includes("\n")) return;
      try {
        const response = JSON.parse(input.slice(0, input.indexOf("\n")));
        if (
          response?.type !== "sandking.cli.result"
          || response.protocol !== "1.0.0"
          || response.requestId !== requestId
        ) {
          throw new Error("controller_cli_protocol_invalid");
        }
        if (response.ok !== true) {
          throw new ControllerCliAcknowledgedFailure(
            response?.failure?.code ?? "controller_cli_operation_failed",
          );
        }
        finish(null, response.outcome);
      } catch (error) {
        finish(error instanceof Error ? error : new Error("controller_cli_protocol_invalid"));
      }
    });
    socket.once("error", () => finish(new Error("controller_cli_unavailable")));
    socket.once("close", () => {
      if (!settled) finish(new Error("controller_cli_unavailable"));
    });
  });
};

/**
 * Record that the focused Controller used the packaged ordinary CLI's
 * self-description before launching. Help remains available outside a
 * Controller session without this private runtime correlation.
 * @param {NodeJS.ProcessEnv} [environment]
 */
export const requestControllerDescription = async (environment = process.env) => {
  const projectId = environment.SANDKING_WORK_CONTEXT_ID ?? "";
  const description = controllerCliDescriptionSchema.safeParse(
    await requestControllerOperation({ operation: "describe", projectId }, environment),
  );
  if (!description.success || description.data.focusedProjectId !== projectId) {
    throw new Error("controller_cli_protocol_invalid");
  }
  return description.data;
};

/**
 * Accept only the exact durable run created for this ordinary CLI request.
 * A success-shaped response for another Project or Controller session must
 * never be reported to the provider as a successful launch.
 * @param {unknown} outcome
 * @param {{projectId: string, controllerSessionId: string, parameters: import("zod").infer<typeof launchParametersSchema>, idempotencyKeyHash: string}} request
 */
export const requireCorrelatedControllerLaunchResult = (outcome, request) => {
  const parsed = controllerLaunchResultSchema.safeParse(outcome);
  if (
    !parsed.success
    || parsed.data.idempotencyKeyHash !== request.idempotencyKeyHash
    || parsed.data.run.projectId !== request.projectId
    || parsed.data.run.controllerSessionId !== request.controllerSessionId
    || !isDeepStrictEqual(parsed.data.run.parameters, request.parameters)
  ) {
    throw new Error("controller_cli_protocol_invalid");
  }
  return parsed.data;
};

/**
 * Invoke the Controller runtime from the ordinary `sandking` executable made
 * available inside a Controller session.
 * @param {{projectId: string, parameters?: unknown, idempotencyKey?: string}} request
 * @param {NodeJS.ProcessEnv} [environment]
 */
export const requestControllerLaunch = async (request, environment = process.env) => {
  const parameters = launchParametersSchema.safeParse(request.parameters);
  if (
    !parameters.success
    || (request.idempotencyKey !== undefined
      && (typeof request.idempotencyKey !== "string"
        || request.idempotencyKey.length < 1
        || request.idempotencyKey.length > 256))
  ) {
    throw new Error("controller_cli_contract_invalid");
  }
  const correlation = {
    projectId: request.projectId,
    controllerSessionId: environment.SANDKING_CONTROLLER_SESSION_ID ?? "",
    parameters: parameters.data,
  };
  const pending = request.idempotencyKey === undefined
    ? await retainPendingLaunch(correlation, environment)
    : null;
  const idempotencyKeyHash = pending?.retryHash ?? digest(request.idempotencyKey);
  try {
    const outcome = await requestControllerOperation({
      operation: "harness-run.launch",
      projectId: request.projectId,
      ...(Object.keys(parameters.data).length === 0 ? {} : { parameters: parameters.data }),
      idempotencyKeyHash,
    }, environment);
    const result = requireCorrelatedControllerLaunchResult(outcome, {
      ...correlation,
      idempotencyKeyHash,
    });
    if (pending) await clearPendingLaunch(pending);
    return result;
  } catch (error) {
    if (pending && error instanceof ControllerCliAcknowledgedFailure) {
      await clearPendingLaunch(pending);
    }
    throw error;
  }
};
