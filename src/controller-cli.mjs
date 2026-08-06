import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { launchParametersSchema } from "./harness-launch.mjs";

const projectIdPattern = /^project-[a-f0-9]{24}$/;
const controllerSessionPattern = /^controller-session-[a-f0-9]{24}$/;
// A launch may consume one provider-operation window and then use a second
// window for exact ambiguous-outcome lookup.
const CONTROLLER_CLI_TIMEOUT_MS = 12_000;

/**
 * @param {{operation: "describe" | "harness-run.launch", projectId: string, parameters?: unknown, idempotencyKey?: string}} request
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
          idempotencyKey: request.idempotencyKey,
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
          throw new Error(response?.failure?.code ?? "controller_cli_operation_failed");
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
  return requestControllerOperation({ operation: "describe", projectId }, environment);
};

/**
 * Invoke the Controller runtime from the ordinary `sandking` executable made
 * available inside a Controller session.
 * @param {{projectId: string, parameters: unknown, idempotencyKey: string}} request
 * @param {NodeJS.ProcessEnv} [environment]
 */
export const requestControllerLaunch = async (request, environment = process.env) => {
  const parameters = launchParametersSchema.safeParse(request.parameters);
  if (
    !parameters.success
    || typeof request.idempotencyKey !== "string"
    || request.idempotencyKey.length < 1
    || request.idempotencyKey.length > 256
  ) {
    throw new Error("controller_cli_contract_invalid");
  }
  return requestControllerOperation({
    operation: "harness-run.launch",
    projectId: request.projectId,
    parameters: parameters.data,
    idempotencyKey: request.idempotencyKey,
  }, environment);
};
