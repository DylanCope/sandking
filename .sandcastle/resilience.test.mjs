import assert from "node:assert/strict";
import test from "node:test";
import { retryOperation } from "./resilience.mjs";

test("a crashed phase retries with exponential backoff and then resumes", async () => {
  const delays = [];
  const messages = [];
  let calls = 0;

  const result = await retryOperation({
    label: "Planner",
    attempts: 3,
    initialDelayMs: 1_000,
    operation: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("error connecting to api.github.com");
      }
      return "recovered";
    },
    sleep: async (delayMs) => delays.push(delayMs),
    log: (message) => messages.push(message),
  });

  assert.equal(result, "recovered");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [1_000]);
  assert.match(messages[0], /Planner failed \(attempt 1\/3\)/);
});

test("a repeatedly failing phase stops after the configured attempt limit", async () => {
  const failure = new Error("HTTP error: 401 Unauthorized");
  const delays = [];
  let calls = 0;

  await assert.rejects(
    retryOperation({
      label: "Issue #5 implementer",
      attempts: 3,
      initialDelayMs: 1_000,
      operation: async () => {
        calls += 1;
        throw failure;
      },
      sleep: async (delayMs) => delays.push(delayMs),
      log: () => {},
    }),
    failure,
  );

  assert.equal(calls, 3);
  assert.deepEqual(delays, [1_000, 2_000]);
});
