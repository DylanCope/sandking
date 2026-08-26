import assert from "node:assert/strict";
import test from "node:test";
import {
  createRealDelegationProgress,
  createRealDelegationResult,
  isProductionProviderRuntime,
  isValidIssueNumber,
  parseRealDelegationMessage,
} from "../src/real-delegation-protocol.mjs";

test("provider runtimes accept only Docker endpoints sharing the Host mount namespace", () => {
  const sandboxImageId = `sha256:${"a".repeat(64)}`;
  for (const dockerEndpoint of [
    "unix:///var/run/docker.sock",
    "npipe:////./pipe/docker_engine",
  ]) {
    assert.equal(isProductionProviderRuntime({ dockerEndpoint, sandboxImageId }), true);
  }
  for (const dockerEndpoint of [
    "ssh://remote.example",
    "tcp://remote.example:2376",
    "http://remote.example:2375",
    "https://remote.example:2376",
    "unix://remote.example/var/run/docker.sock",
    "npipe://remote.example/pipe/docker_engine",
    "npipe:////remote.example/pipe/docker_engine",
  ]) {
    assert.equal(isProductionProviderRuntime({ dockerEndpoint, sandboxImageId }), false);
  }
});

test("one bounded issue-number predicate governs delegation protocol identifiers", () => {
  assert.equal(isValidIssueNumber(1), true);
  assert.equal(isValidIssueNumber(999_999_999), true);
  for (const value of [0, 1_000_000_000, 1.5, Number.MAX_SAFE_INTEGER, "262"]) {
    assert.equal(isValidIssueNumber(value), false, String(value));
  }
});

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
  for (const code of ["github_credential_expired", "github_rate_limited"]) {
    const failure = createRealDelegationResult({
      issueNumber: 262,
      status: "failed",
      code,
      completion: null,
    });
    assert.deepEqual(parseRealDelegationMessage(JSON.stringify(failure)), failure);
  }
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
