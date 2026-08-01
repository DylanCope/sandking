import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createImplementPromptArgs } from "./issue-context.mjs";

test("implementation prompt args include the issue body and full parent chain", async () => {
  const issues = new Map([
    ["117", issue("117", "Launch the secure local Cockpit", "Issue body.")],
    ["125", issue("125", "Deliver slice 1", "Parent PRD body.")],
    ["116", issue("116", "Specification", "Specification body.")],
  ]);
  const parents = new Map([
    ["117", "125"],
    ["125", "116"],
  ]);

  const promptArgs = await createImplementPromptArgs({
    issue: { id: "117", title: "stale title" },
    github: {
      async getIssueDetails(issueId) {
        return issues.get(issueId);
      },
      async getParentIssue(issueId) {
        const parentId = parents.get(issueId);
        return parentId ? { id: parentId } : null;
      },
    },
  });

  assert.equal(promptArgs.TASK_ID, "117");
  assert.equal(promptArgs.ISSUE_TITLE, "Launch the secure local Cockpit");
  assert.match(promptArgs.ISSUE_BODY, /^#117: Launch the secure local Cockpit\n\nIssue body\.$/);
  assert.match(promptArgs.PARENT_ISSUES, /^#125: Deliver slice 1\n\nParent PRD body\.\n\n#116: Specification\n\nSpecification body\.$/);
});

test("implementation prompt args render absent parent requirements explicitly", async () => {
  const promptArgs = await createImplementPromptArgs({
    issue: { id: "118", title: "Register a Project" },
    github: {
      async getIssueDetails(issueId) {
        return issue(issueId, "Register a Project", "");
      },
      async getParentIssue() {
        return null;
      },
    },
  });

  assert.equal(promptArgs.PARENT_ISSUES, "None.");
  assert.match(promptArgs.ISSUE_BODY, /^#118: Register a Project\n\n_No issue body provided\._$/);
});

test("the implementation prompt includes injected issue and parent requirement context", async () => {
  const prompt = await readFile(".sandcastle/implement-prompt.md", "utf8");

  assert.match(prompt, /\{\{ISSUE_BODY\}\}/);
  assert.match(prompt, /\{\{PARENT_ISSUES\}\}/);
});

function issue(id, title, body) {
  return {
    id,
    title,
    body,
    state: "open",
  };
}
