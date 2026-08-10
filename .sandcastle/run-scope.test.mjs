import assert from "node:assert/strict";
import test from "node:test";
import {
  createIssueScope,
  createParentScope,
  parseMaxReviewAttempts,
  parseOverrideClaimIssueIds,
  parseRunScope,
  selectScopedIssues,
} from "./run-scope.mjs";

test("--parent accepts a GitHub issue number", () => {
  assert.deepEqual(parseRunScope(["--parent", "25"]), {
    parentIssueId: "25",
  });
  assert.deepEqual(parseRunScope(["--parent=25"]), {
    parentIssueId: "25",
  });
  assert.equal(parseRunScope([]), null);
});

test("invalid or incomplete parent options fail before a Harness run starts", () => {
  assert.throws(() => parseRunScope(["--parent"]), /issue number/);
  assert.throws(() => parseRunScope(["--parent", "twenty-five"]), /issue number/);
  assert.throws(() => parseRunScope(["--unknown", "25"]), /Unknown option/);
});

test("parseRunScope tolerates --max-review-attempts without folding it into the scope", () => {
  assert.deepEqual(
    parseRunScope(["--parent", "165", "--max-review-attempts", "20"]),
    { parentIssueId: "165" },
  );
  assert.deepEqual(
    parseRunScope(["--max-review-attempts=20", "--issue", "152"]),
    { issueId: "152" },
  );
  assert.equal(parseRunScope(["--max-review-attempts", "20"]), null);
});

test("--max-review-attempts accepts a positive integer in either flag form", () => {
  assert.equal(parseMaxReviewAttempts(["--max-review-attempts", "20"]), 20);
  assert.equal(parseMaxReviewAttempts(["--max-review-attempts=20"]), 20);
  assert.equal(
    parseMaxReviewAttempts(["--parent", "165", "--max-review-attempts", "20"]),
    20,
  );
  assert.equal(parseMaxReviewAttempts([]), undefined);
  assert.equal(parseMaxReviewAttempts(["--parent", "165"]), undefined);
});

test("invalid --max-review-attempts values fail before a Harness run starts", () => {
  assert.throws(
    () => parseMaxReviewAttempts(["--max-review-attempts", "0"]),
    /positive integer/,
  );
  assert.throws(
    () => parseMaxReviewAttempts(["--max-review-attempts", "not-a-number"]),
    /positive integer/,
  );
  assert.throws(
    () => parseMaxReviewAttempts(["--max-review-attempts", "-5"]),
    /positive integer/,
  );
});

test("parseRunScope tolerates --override-claim without folding it into the scope", () => {
  assert.deepEqual(
    parseRunScope(["--parent", "165", "--override-claim", "162"]),
    { parentIssueId: "165" },
  );
  assert.deepEqual(
    parseRunScope(["--override-claim=162", "--issue", "152"]),
    { issueId: "152" },
  );
  assert.equal(parseRunScope(["--override-claim", "162"]), null);
});

test("--override-claim collects one or more positive GitHub issue numbers", () => {
  assert.deepEqual(parseOverrideClaimIssueIds([]), new Set());
  assert.deepEqual(
    parseOverrideClaimIssueIds(["--override-claim", "162"]),
    new Set(["162"]),
  );
  assert.deepEqual(
    parseOverrideClaimIssueIds(["--override-claim=162"]),
    new Set(["162"]),
  );
  assert.deepEqual(
    parseOverrideClaimIssueIds([
      "--override-claim", "162",
      "--parent", "165",
      "--override-claim", "163",
    ]),
    new Set(["162", "163"]),
  );
});

test("invalid --override-claim values fail before a Harness run starts", () => {
  assert.throws(
    () => parseOverrideClaimIssueIds(["--override-claim", "not-a-number"]),
    /positive GitHub issue number/,
  );
  assert.throws(
    () => parseOverrideClaimIssueIds(["--override-claim"]),
    /positive GitHub issue number/,
  );
});

test("a parent scope recursively includes descendants and excludes other trees", async () => {
  const children = new Map([
    ["25", ["26", "27"]],
    ["26", ["31"]],
  ]);
  const github = {
    async getIssue(issueId) {
      return { id: issueId, state: issueId === "25" ? "open" : "closed" };
    },
    async listSubIssues(issueId) {
      return (children.get(issueId) ?? []).map((id) => ({ id, state: "open" }));
    },
  };

  const scope = await createParentScope({ parentIssueId: "25", github });

  assert.deepEqual([...scope.issueIds].sort(), ["26", "27", "31"]);
  assert.deepEqual(
    selectScopedIssues(
      [
        { id: "26", title: "Scoped" },
        { id: "40", title: "Another slice" },
      ],
      scope,
    ),
    [{ id: "26", title: "Scoped" }],
  );
  assert.equal(await scope.isComplete(), false);
});

test("a parent scope is complete only when GitHub reports its parent closed", async () => {
  const github = {
    async getIssue(issueId) {
      return { id: issueId, state: "closed" };
    },
    async listSubIssues() {
      return [];
    },
  };
  const scope = await createParentScope({ parentIssueId: "25", github });

  assert.equal(await scope.isComplete(), true);
});

test("--issue accepts a GitHub issue number and rejects combination with --parent", () => {
  assert.deepEqual(parseRunScope(["--issue", "152"]), { issueId: "152" });
  assert.deepEqual(parseRunScope(["--issue=152"]), { issueId: "152" });
  assert.throws(() => parseRunScope(["--issue"]), /issue number/);
  assert.throws(() => parseRunScope(["--issue", "not-a-number"]), /issue number/);
  assert.throws(
    () => parseRunScope(["--parent", "25", "--issue", "152"]),
    /cannot be combined/,
  );
});

test("an issue scope targets exactly one issue, ignoring everything else in the plan", async () => {
  const github = {
    async getIssue(issueId) {
      return { id: issueId, state: issueId === "152" ? "open" : "closed" };
    },
  };

  const scope = await createIssueScope({ issueId: "152", github });

  assert.deepEqual([...scope.issueIds], ["152"]);
  assert.deepEqual(
    selectScopedIssues(
      [
        { id: "129", title: "Older follow-up" },
        { id: "152", title: "Simplify the launch lifecycle" },
      ],
      scope,
    ),
    [{ id: "152", title: "Simplify the launch lifecycle" }],
  );
  assert.equal(await scope.isComplete(), false);
});

test("an issue scope rejects an issue GitHub does not know about", async () => {
  const github = { async getIssue() { return null; } };

  await assert.rejects(
    () => createIssueScope({ issueId: "9999", github }),
    /was not found/,
  );
});
