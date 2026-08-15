import { canonicalJson } from "../common/canonical-json.mjs";
import { digest } from "../common/digest.mjs";
import { digestSchema } from "./schemas.mjs";

/** @param {unknown} value */
const fingerprint = (value) => digest(canonicalJson(value));

/** @param {any} request */
export const launchRequestFingerprint = (request) => fingerprint({
  projectId: request.projectId,
  parameters: request.parameters === undefined ? {} : request.parameters,
  controllerSessionId: request.controllerSessionId,
  source: request.source,
  authorizationClass: request.authorizationClass,
});

/** @param {any} request */
export const cancellationRequestFingerprint = (request) => fingerprint({
  harnessRunId: request.harnessRunId,
  controllerSessionId: request.controllerSessionId,
  source: request.source,
  authorizationClass: request.authorizationClass,
});

/** @param {any} request */
export const recoveryRequestFingerprint = (request) => fingerprint({
  harnessRunId: request.harnessRunId,
  action: request.action,
  controllerSessionId: request.controllerSessionId,
  source: request.source,
  authorizationClass: request.authorizationClass,
});

/** @param {any} request */
export const requestIdempotencyKeyHash = (request) => {
  const suppliedHash = digestSchema.safeParse(request.idempotencyKeyHash);
  if (suppliedHash.success) return suppliedHash.data;
  return typeof request.idempotencyKey === "string"
    && request.idempotencyKey.length > 0
    && request.idempotencyKey.length <= 256
    ? digest(request.idempotencyKey)
    : null;
};
