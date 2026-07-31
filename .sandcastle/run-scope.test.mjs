import assert from "node:assert/strict";
import test from "node:test";
import {
  createParentScope,
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
