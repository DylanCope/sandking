import assert from "node:assert/strict";
import test from "node:test";
import { runPullRequestReview } from "./pr-review-runner.mjs";

test("PR review runs in the issue worktree without changing the root branch", async () => {
  const root = { branch: "main" };
  const reviewWorktree = { branch: null, closed: false };
  const verdict = { approved: false, findings: ["Connect the public Cockpit"] };

  const result = await runPullRequestReview({
    issue: { id: "26", branch: "sandcastle/issue-26" },
    pullRequest: { number: 103 },
    createSandbox: async ({ branch }) => {
      reviewWorktree.branch = branch;
      return {
        async run(options) {
          assert.equal(options.promptArgs.PR_NUMBER, "103");
          assert.equal(options.promptArgs.BRANCH, "sandcastle/issue-26");
          return {
            stdout: `Review complete.\n<review>\n${JSON.stringify(verdict)}\n</review>`,
          };
        },
        async close() {
          reviewWorktree.closed = true;
        },
      };
    },
    sandboxOptions: { sandbox: "docker", hooks: [], copyToWorktree: [] },
    runOptions: { name: "reviewer" },
    parseReview(value) {
      assert.equal(typeof value.approved, "boolean");
      assert.equal(Array.isArray(value.findings), true);
      return value;
    },
  });

  assert.deepEqual(result, verdict);
  assert.equal(reviewWorktree.branch, "sandcastle/issue-26");
  assert.equal(reviewWorktree.closed, true);
  assert.equal(root.branch, "main");
});

test("PR review fails clearly when stdout has no structured verdict", async () => {
  await assert.rejects(
    runPullRequestReview({
      issue: { id: "26", branch: "sandcastle/issue-26" },
      pullRequest: { number: 103 },
      createSandbox: async () => ({
        async run() {
          return { stdout: "Review finished without a verdict." };
        },
        async close() {},
      }),
      sandboxOptions: {},
      runOptions: {},
      parseReview: (value) => value,
    }),
    /did not emit a <review> verdict/,
  );
});

test("PR review closes its issue worktree when the reviewer fails", async () => {
  let closed = false;

  await assert.rejects(
    runPullRequestReview({
      issue: { id: "26", branch: "sandcastle/issue-26" },
      pullRequest: { number: 103 },
      createSandbox: async () => ({
        async run() {
          throw new Error("reviewer unavailable");
        },
        async close() {
          closed = true;
        },
      }),
      sandboxOptions: {},
      runOptions: {},
    }),
    /reviewer unavailable/,
  );

  assert.equal(closed, true);
});
