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
  "scoped_issue_incomplete",
]);

/** @param {any} value @param {readonly string[]} keys */
export const hasExactKeys = (value, keys) => value
  && typeof value === "object"
  && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

/** @param {any} value */
const validIssueNumber = (value) => Number.isSafeInteger(value)
  && value >= 1
  && value <= 999_999_999;

/** @param {unknown} value @param {number} maximum */
const boundedText = (value, maximum) => typeof value === "string"
  && value.length >= 1
  && value.length <= maximum
  && !/[\0\r\n]/.test(value);

/** @param {any} value */
const validCompletion = (value) => (
  hasExactKeys(value, ["kind", "pullRequestNumber", "pullRequestUrl"])
    && value.kind === "merged-pull-request"
    && validIssueNumber(value.pullRequestNumber)
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
      && validIssueNumber(value.issueNumber)
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
    || !validIssueNumber(value.issueNumber)
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
