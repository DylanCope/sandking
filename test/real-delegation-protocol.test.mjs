import assert from "node:assert/strict";
import test from "node:test";
import {
  createRealDelegationProgress,
  createRealDelegationResult,
  parseRealDelegationMessage,
} from "../src/real-delegation-protocol.mjs";

test("main delegation messages are strict structured progress and completion attestations", () => {
  const progress = createRealDelegationProgress({
    issueNumber: 262,
    phase: "review",
    label: "Review issue #262",
    summary: "An independent review round is evaluating the scoped pull request.",
    status: "running",
  });
  const result = createRealDelegationResult({
    issueNumber: 262,
    status: "succeeded",
    code: "scoped_issue_completed",
    completion: {
      kind: "merged-pull-request",
      pullRequestNumber: 266,
      pullRequestUrl: "https://github.com/DylanCope/sandking/pull/266",
    },
  });

  assert.deepEqual(parseRealDelegationMessage(JSON.stringify(progress)), progress);
  assert.deepEqual(parseRealDelegationMessage(JSON.stringify(result)), result);
  assert.throws(
    () => parseRealDelegationMessage(JSON.stringify({
      ...result,
      transcript: "SUCCESS",
    })),
    /real_delegation_message_invalid/,
  );
  assert.throws(
    () => createRealDelegationResult({
      issueNumber: 262,
      status: "succeeded",
      code: "delivery_execution_failed",
      completion: null,
    }),
    /real_delegation_message_invalid/,
  );
});
