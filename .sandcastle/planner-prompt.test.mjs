import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { selectPlannerCandidates } from "./list-planner-candidates.mjs";

test("the planner only sees unblocked leaf implementation tickets", async () => {
  const issues = [
    issue(4, { subIssues: 5 }),
    issue(5),
    issue(6, { blockedBy: 1 }),
    issue(7, { labels: ["ready-for-agent", "prd"] }),
    issue(8, { labels: ["ready-for-agent", "wayfinder:task"] }),
    issue(9, { labels: ["ready-for-human"] }),
    issue(10, { state: "closed" }),
  ];

  assert.deepEqual(selectPlannerCandidates([issues]), [
    {
      number: 5,
      title: "Issue 5",
      body: "Implement issue 5",
      labels: ["ready-for-agent"],
    },
  ]);
});

test("the planner prompt gets candidates from the metadata filter", async () => {
  const prompt = await readFile(".sandcastle/plan-prompt.md", "utf8");

  assert.match(prompt, /gh api --paginate --slurp/);
  assert.match(prompt, /list-planner-candidates\.mjs/);
  assert.doesNotMatch(prompt, /gh issue list/);
  assert.doesNotMatch(prompt, /fewest or weakest dependencies/);
});

function issue(
  number,
  {
    state = "open",
    labels = ["ready-for-agent"],
    blockedBy = 0,
    subIssues = 0,
  } = {},
) {
  return {
    number,
    title: `Issue ${number}`,
    body: `Implement issue ${number}`,
    state,
    labels: labels.map((name) => ({ name })),
    sub_issues_summary: { total: subIssues },
    issue_dependencies_summary: { blocked_by: blockedBy },
  };
}
