import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("the orchestration loop retries every remote agent phase", async () => {
  const main = await readFile(".sandcastle/main.mts", "utf8");

  assert.match(main, /retryOperation\(\{\s*label: "Planner"/s);
  assert.match(main, /label: `Issue #\$\{issue\.id\} \$\{role\}`/);
  assert.match(main, /runIssueAgent\(issue, "implementer"\)/);
  assert.match(main, /runIssueAgent\(issue, "reviewer"\)/);
  assert.match(main, /retryOperation\(\{\s*label: "Merger"/s);
});

test("an exhausted worker cycle exits for a safe command restart", async () => {
  const main = await readFile(".sandcastle/main.mts", "utf8");

  assert.match(main, /Some issue pipelines failed/);
  assert.doesNotMatch(
    main,
    /if \(completedBranches\.length === 0\) \{[\s\S]*?continue;/,
  );
});

test("only spec-approved issue branches reach the merge phase", async () => {
  const main = await readFile(".sandcastle/main.mts", "utf8");
  const reviewPrompt = await readFile(".sandcastle/review-prompt.md", "utf8");
  const mergePrompt = await readFile(".sandcastle/merge-prompt.md", "utf8");

  assert.match(main, /approved: z\.boolean\(\)/);
  assert.match(main, /reviewResult\.review\.approved/);
  assert.match(main, /hasCommits: false, reviewFindings/);
  assert.match(reviewPrompt, /Fetch the issue and every parent requirement/);
  assert.match(reviewPrompt, /public acceptance seam/);
  assert.match(reviewPrompt, /review-verdicts\/issue-\{\{TASK_ID\}\}\.json/);
  assert.match(mergePrompt, /Do not close an issue merely because its branch merged/);
});
