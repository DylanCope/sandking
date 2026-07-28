// Parallel Planner with Review — four-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):             An opus agent analyzes open issues, builds a
//                               dependency graph, and outputs a <plan> JSON
//                               listing unblocked issues with branch names.
//   Phase 2 (Execute + Review): For each issue, a sandbox is created via
//                               createSandbox(). The implementer runs first
//                               (100 iterations). If it produces commits, a
//                               reviewer runs in the same sandbox on the same
//                               branch (1 iteration). All issue pipelines run
//                               concurrently via Promise.allSettled().
//   Phase 3 (Merge):            A single agent merges all completed branches
//                               into the current branch.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Usage:
//   npx tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import {
  createCodexSandboxSettings,
  createRunSettings,
} from "./sandbox-settings.mjs";
import { retryOperation } from "./resilience.mjs";

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
const planSchema = z.object({
  issues: z.array(
    z.object({ id: z.string(), title: z.string(), branch: z.string() }),
  ),
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;
const PHASE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const sandboxSettings = createCodexSandboxSettings();
const runSettings = createRunSettings();
const hooks = sandboxSettings.hooks;
const codexDocker = () => docker(sandboxSettings.docker);

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];

const targetBranch = execFileSync("git", ["branch", "--show-current"], {
  encoding: "utf8",
}).trim();

const branchHasCommits = (branch: string) =>
  Number(
    execFileSync("git", ["rev-list", "--count", `${targetBranch}..${branch}`], {
      encoding: "utf8",
    }).trim(),
  ) > 0;

const runIssueAgent = async (
  issue: z.infer<typeof planSchema>["issues"][number],
  role: "implementer" | "reviewer",
) =>
  retryOperation({
    label: `Issue #${issue.id} ${role}`,
    attempts: PHASE_ATTEMPTS,
    initialDelayMs: RETRY_DELAY_MS,
    operation: async () => {
      // A retry gets a fresh container while retaining the named worktree.
      // This preserves commits and uncommitted edits from an interrupted agent.
      const sandbox = await sandcastle.createSandbox({
        branch: issue.branch,
        sandbox: codexDocker(),
        hooks,
        copyToWorktree,
      });

      try {
        return await sandbox.run({
          ...runSettings,
          name: role,
          maxIterations: role === "implementer" ? 100 : 1,
          agent: sandcastle.codex("gpt-5.4"),
          promptFile:
            role === "implementer"
              ? "./.sandcastle/implement-prompt.md"
              : "./.sandcastle/review-prompt.md",
          promptArgs:
            role === "implementer"
              ? {
                  TASK_ID: issue.id,
                  ISSUE_TITLE: issue.title,
                  BRANCH: issue.branch,
                }
              : { BRANCH: issue.branch },
        });
      } finally {
        await sandbox.close();
      }
    },
  });

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const main = async () => {
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planning agent (opus, for deeper reasoning) reads the open issue list,
  // builds a dependency graph, and selects the issues that can be worked in
  // parallel right now (i.e., no blocking dependencies on other open issues).
  //
  // It outputs a <plan> JSON block — Output.object parses and validates it.
  // -------------------------------------------------------------------------
  const plan = await retryOperation({
    label: "Planner",
    attempts: PHASE_ATTEMPTS,
    initialDelayMs: RETRY_DELAY_MS,
    operation: () => sandcastle.run({
      ...runSettings,
      hooks,
      sandbox: codexDocker(),
      name: "planner",
      // One iteration is enough: the planner just needs to read and reason,
      // not write code. (Structured output requires maxIterations: 1.)
      maxIterations: 1,
      agent: sandcastle.codex("gpt-5.4"),
      promptFile: "./.sandcastle/plan-prompt.md",
      output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
    }),
  });

  const issues: z.infer<typeof planSchema>["issues"] = plan.output.issues;

  if (issues.length === 0) {
    // No unblocked work — either everything is done or everything is blocked.
    console.log("No unblocked issues to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute + Review
  //
  // For each issue, create a sandbox via createSandbox() so the implementer
  // and reviewer share the same sandbox instance per branch. The implementer
  // runs first; if it produces commits, the reviewer runs in the same sandbox.
  //
  // Promise.allSettled means one failing pipeline doesn't cancel the others.
  // -------------------------------------------------------------------------

  const settled = await Promise.allSettled(
    issues.map(async (issue) => {
      await runIssueAgent(issue, "implementer");

      // Check git rather than only the latest run result. A prior process may
      // have committed before losing its network connection or being killed.
      if (branchHasCommits(issue.branch)) {
        await runIssueAgent(issue, "reviewer");
      }

      return { hasCommits: branchHasCommits(issue.branch) };
    }),
  );

  // Log any agents that threw (network error, sandbox crash, etc.).
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`,
      );
    }
  }

  // Only pass branches that actually produced commits to the merge phase.
  // An agent that ran successfully but made no commits has nothing to merge.
  const hadFailures = settled.some((outcome) => outcome.status === "rejected");
  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (entry) =>
        entry.outcome.status === "fulfilled" &&
        entry.outcome.value.hasCommits,
    )
    .map((entry) => entry.issue);

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    console.log("No commits produced. Nothing to merge.");
    if (hadFailures) {
      console.error(
        "Some issue pipelines failed after all retries. Progress remains in their worktrees; rerun the same npm command to resume.",
      );
      process.exitCode = 1;
    }
    break;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Merge
  //
  // One agent merges all completed branches into the current branch,
  // resolving any conflicts and running tests to confirm everything works.
  //
  // The {{BRANCHES}} and {{ISSUES}} prompt arguments are lists that the agent
  // uses to know which branches to merge and which issues to close.
  // -------------------------------------------------------------------------
  await retryOperation({
    label: "Merger",
    attempts: PHASE_ATTEMPTS,
    initialDelayMs: RETRY_DELAY_MS,
    operation: () => sandcastle.run({
      ...runSettings,
      hooks,
      sandbox: codexDocker(),
      name: "merger",
      maxIterations: 1,
      agent: sandcastle.codex("gpt-5.4"),
      promptFile: "./.sandcastle/merge-prompt.md",
      promptArgs: {
        BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
        ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
      },
    }),
  });

  console.log("\nBranches merged.");

  if (hadFailures) {
    console.error(
      "Some issue pipelines failed after all retries. Successful branches were merged; rerun the same npm command to resume the others.",
    );
    process.exitCode = 1;
    break;
  }
  }

  console.log("\nAll done.");
};

try {
  await main();
} catch (error) {
  console.error("\nSandcastle stopped after all retries:", error);
  console.error(
    "Branch worktrees were preserved. Restore connectivity, then rerun the same npm command to resume.",
  );
  process.exitCode = 1;
}
