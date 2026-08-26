import { hasExactKeys } from "./common/exact-object-keys.mjs";

export { hasExactKeys };

const progressPhases = new Set([
  "planning",
  "implementation",
  "review",
  "completion",
]);
const progressStatuses = new Set(["running", "succeeded"]);
const failureCodes = new Set([
  "delivery_cancelled",
  "delivery_execution_failed",
  "github_credential_expired",
  "github_rate_limited",
  "scoped_issue_incomplete",
]);

export const REAL_PROVIDER_EXECUTION_RUNTIME_INPUTS = Object.freeze([
  Object.freeze({
    identity: "openai.codex-cli",
    package: "@openai/codex",
    version: "0.146.0",
    resolved: "https://registry.npmjs.org/@openai/codex/-/codex-0.146.0.tgz",
    integrity:
      "sha512-yG3sPWNda/2YAIQIDq9MrrjoCTIQ7rxYM5IasrG3VBcuhCLTkgeg/JzqmJq1V98RE4MJ5jCxDXXQlOjrditFRw==",
    skillExposure: "versioned-with-runtime-package",
  }),
  Object.freeze({
    identity: "docker.cli",
    package: "docker.io",
    version: "20.10.24+dfsg1-1+deb12u1+b6",
    resolved:
      "https://snapshot.debian.org/archive/debian/20260825T000000Z/dists/bookworm/InRelease",
    integrity:
      "sha512-g2nfFf0TRYofHqQEnRCEaW5q1Tc0ResEDDfA49URb5Ns3r0Djz8zNnnzJ9Rkw0MY9uB6pNZcz9Lg/LH6DvOaAA==",
    skillExposure: "versioned-with-runtime-package",
  }),
]);

/**
 * @param {unknown} value
 * @param {readonly Readonly<Record<string, string>>[]} expected
 */
export const hasExecutionRuntimeInputs = (value, expected) => Array.isArray(value)
  && value.length === expected.length
  && value.every((input, index) => hasExactKeys(input, Object.keys(expected[index]))
    && Object.entries(expected[index]).every(([key, expectedValue]) =>
      input[key] === expectedValue));

/** @param {any} value */
export const isValidIssueNumber = (value) => Number.isSafeInteger(value)
  && value >= 1
  && value <= 999_999_999;

const localDockerEndpointPatterns = Object.freeze([
  /^unix:\/\/\/[^?#\s\0]+$/,
  /^npipe:\/\/\/\/\.\/pipe\/[^?#\s\0]+$/,
]);

/** @param {unknown} value */
export const isDockerEndpoint = (value) => {
  if (
    typeof value !== "string"
    || value.length > 2_048
    || !localDockerEndpointPatterns.some((pattern) => pattern.test(value))
  ) {
    return false;
  }
  try {
    return !/[\0\r\n]/.test(decodeURIComponent(new URL(value).pathname));
  } catch {
    return false;
  }
};

/** @param {any} value */
export const isProductionProviderRuntime = (value) => hasExactKeys(value, [
  "dockerEndpoint",
  "sandboxImageId",
])
  && isDockerEndpoint(value.dockerEndpoint)
  && /^sha256:[a-f0-9]{64}$/.test(value.sandboxImageId ?? "");

/** @param {unknown} value @param {string} [code] */
export const parseProductionProviderRuntime = (
  value,
  code = "production_provider_runtime_invalid",
) => {
  if (!isProductionProviderRuntime(value)) throw new Error(code);
  return value;
};

/** @param {unknown} value @param {number} maximum */
const boundedText = (value, maximum) => typeof value === "string"
  && value.length >= 1
  && value.length <= maximum
  && !/[\0\r\n]/.test(value);

/** @param {any} value */
const validCompletion = (value) => (
  hasExactKeys(value, ["kind", "pullRequestNumber", "pullRequestUrl"])
    && value.kind === "merged-pull-request"
    && isValidIssueNumber(value.pullRequestNumber)
    && boundedText(value.pullRequestUrl, 512)
    && (() => {
      try {
        const url = new URL(value.pullRequestUrl);
        return url.protocol === "https:" && url.username === "" && url.password === "";
      } catch {
        return false;
      }
    })()
) || (
  hasExactKeys(value, ["kind"])
    && value.kind === "issue-already-closed"
);

/** @param {any} value */
const validateMessage = (value) => {
  if (hasExactKeys(value, [
    "type",
    "issueNumber",
    "phase",
    "label",
    "summary",
    "status",
  ])) {
    return value.type === "sandcastle.delivery.progress"
      && isValidIssueNumber(value.issueNumber)
      && progressPhases.has(value.phase)
      && boundedText(value.label, 160)
      && boundedText(value.summary, 512)
      && progressStatuses.has(value.status);
  }
  if (!hasExactKeys(value, [
    "type",
    "issueNumber",
    "status",
    "code",
    "completion",
  ])) {
    return false;
  }
  if (
    value.type !== "sandcastle.delivery.result"
    || !isValidIssueNumber(value.issueNumber)
    || !["succeeded", "failed"].includes(value.status)
  ) {
    return false;
  }
  return value.status === "succeeded"
    ? value.code === "scoped_issue_completed" && validCompletion(value.completion)
    : failureCodes.has(value.code) && value.completion === null;
};

/** @param {any} value */
const requireValidMessage = (value) => {
  if (!validateMessage(value)) throw new Error("real_delegation_message_invalid");
  return value;
};

/** @param {any} value */
export const createRealDelegationProgress = (value) => requireValidMessage({
  type: "sandcastle.delivery.progress",
  ...value,
});

/** @param {any} value */
export const createRealDelegationResult = (value) => requireValidMessage({
  type: "sandcastle.delivery.result",
  ...value,
});

/** @param {unknown} source */
export const parseRealDelegationMessage = (source) => {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 4_096) {
    throw new Error("real_delegation_message_invalid");
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("real_delegation_message_invalid");
  }
  return requireValidMessage(value);
};
