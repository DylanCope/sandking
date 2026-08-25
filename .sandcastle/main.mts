// Sandcastle issue delivery loop
//
// A planner selects unblocked issues. Each issue starts from synchronized main,
// is implemented on its canonical issue branch, pushed, opened as a PR, and
// reviewed by a separate process. Only an approved, checked, confirmed merge
// closes the issue. Eligible parent issues are then closed recursively.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Usage:
//   npx tsx .sandcastle/main.mts
//   npx tsx .sandcastle/main.mts --parent 165 --max-review-attempts 20
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }
//
// --max-review-attempts overrides how many review rounds a single pull
// request may use before delivery gives up on it (default: see
// DEFAULT_MAX_REVIEW_ATTEMPTS in issue-delivery.mjs). Applies per issue, not
// per run — a resumed PR's existing review ledger still counts toward it.
//
// Each run claims an issue (a comment on the GitHub issue itself) before
// delivering it, and releases the claim when delivery finishes, so a second
// Harness instance running concurrently (e.g. on another machine) with
// overlapping scope skips issues this run already holds instead of racing
// it. Claims are keyed by hostname, so relaunching on the same machine
// always resumes your own claim without friction. To take over an issue
// claimed by a different, presumed-dead instance, pass
// --override-claim <issueId> (repeatable) — verify that instance really
// isn't still running before doing this, since claims aren't released on a
// crash.

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFileSync } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  createGitHubDelivery,
  createGitRepository,
} from "./delivery-adapters.mjs";
import {
  completeIssueThroughPullRequest,
  DEFAULT_MAX_REVIEW_ATTEMPTS,
  getActiveIssueClaim,
} from "./issue-delivery.mjs";
import { runPullRequestReview } from "./pr-review-runner.mjs";
import {
  createCodexSandboxSettings,
  createRunSettings,
  createWorkerSandboxSettings,
} from "./sandbox-settings.mjs";
import { retryOperation } from "./resilience.mjs";
import {
  createIssueScope,
  createParentScope,
  parseMaxReviewAttempts,
  parseOverrideClaimIssueIds,
  parseRunScope,
  selectScopedIssues,
} from "./run-scope.mjs";

const delegationProtocolUrl = new URL("../real-delegation-protocol.mjs", import.meta.url);
const sourceDelegationProtocolUrl = new URL(
  "../src/real-delegation-protocol.mjs",
  import.meta.url,
);
const {
  createRealDelegationProgress,
  createRealDelegationResult,
} = await import(delegationProtocolUrl.href).catch(() =>
  import(sourceDelegationProtocolUrl.href));

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
const planSchema = z.object({
  issues: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      branch: z.string(),
      sizeWarning: z.string().optional(),
    }),
  ),
});

const blockingFindingSchema = z.object({
  summary: z.string().min(1),
  requirement: z.string().min(1),
  evidence: z.string().min(1),
  materialImpact: z.string().min(1),
  cannotDefer: z.string().min(1),
});

const followUpSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  sourceFinding: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
});

const reviewSchema = z.object({
  approved: z.boolean(),
  blockingFindings: z.array(blockingFindingSchema),
  followUps: z.array(followUpSchema),
  resolvedFindings: z.array(z.string()),
}).refine(
  (review) => review.approved === (review.blockingFindings.length === 0),
  "A review is approved exactly when it has no blocking findings.",
);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;
const PHASE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;
const protocolEnabled = process.env.SANDKING_REAL_DELEGATION_PROTOCOL === "1";
const githubCredentialPath = process.env.SANDKING_GITHUB_CREDENTIAL_PATH;
if (protocolEnabled) {
  if (!githubCredentialPath) throw new Error("github_credential_path_missing");
  const githubToken = readFileSync(githubCredentialPath, "utf8").trim();
  if (!githubToken || /\s/.test(githubToken)) {
    throw new Error("github_credential_invalid");
  }
  process.env.GH_TOKEN = githubToken;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_ENTERPRISE_TOKEN;
  delete process.env.GITHUB_ENTERPRISE_TOKEN;
}
const controller = new AbortController();
const handleTermination = () => controller.abort(new Error("delivery_cancelled"));
process.once("SIGTERM", handleTermination);
const harnessDirectory = fileURLToPath(new URL("./", import.meta.url));
const harnessFile = (name: string) => `${harnessDirectory}${name}`;
const codexAuthPath = process.env.SANDCASTLE_CODEX_AUTH_PATH
  ?? "~/.codex/auth.json";

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const sandboxSettings = createCodexSandboxSettings(codexAuthPath);
const runSettings = { ...createRunSettings(), signal: controller.signal };
const hooks = sandboxSettings.hooks;
const codexDocker = () => docker(sandboxSettings.docker);

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];

const targetBranch = execFileSync("git", ["branch", "--show-current"], {
  encoding: "utf8",
}).trim();
if (targetBranch !== "main") {
  throw new Error(
    `Sandcastle must start from main; current branch is ${targetBranch}.`,
  );
}

const repository = createGitRepository();
const github = createGitHubDelivery();
const scopeOptions = parseRunScope(process.argv.slice(2));
const maxReviewAttempts =
  parseMaxReviewAttempts(process.argv.slice(2)) ?? DEFAULT_MAX_REVIEW_ATTEMPTS;
const overrideClaimIssueIds = parseOverrideClaimIssueIds(process.argv.slice(2));
const instance = { id: os.hostname(), host: os.hostname(), pid: process.pid };
const runScope = scopeOptions
  ? "issueId" in scopeOptions
    ? await createIssueScope({ issueId: scopeOptions.issueId, github })
    : await createParentScope({
        parentIssueId: scopeOptions.parentIssueId,
        github,
      })
  : null;
const scopedIssueNumber = scopeOptions && "issueId" in scopeOptions
  ? Number(scopeOptions.issueId)
  : null;
const publishDelegationMessage = (message: unknown) => {
  if (protocolEnabled) writeSync(3, `${JSON.stringify(message)}\n`);
};
const reportProgress = (value: {
  phase: "planning" | "implementation" | "review" | "completion";
  label: string;
  summary: string;
  status: "running" | "succeeded";
}) => {
  if (!scopedIssueNumber) return;
  publishDelegationMessage(createRealDelegationProgress({
    issueNumber: scopedIssueNumber,
    ...value,
  }));
};
const completedDeliveries: Array<{
  issueId: string;
  pullRequest: { number: number; url: string; state: string };
}> = [];

if (runScope && scopeOptions) {
  console.log(
    "issueId" in scopeOptions
      ? `Harness run scoped to issue #${scopeOptions.issueId}.`
      : `Harness run scoped to ${runScope.issueIds.size} descendant issue(s) of #${scopeOptions.parentIssueId}.`,
  );
}
console.log(`Review-attempt budget per issue: ${maxReviewAttempts}.`);
console.log(`Harness instance: ${instance.host} (pid ${instance.pid}).`);
if (overrideClaimIssueIds.size > 0) {
  console.log(
    `Will override existing claims on: ${[...overrideClaimIssueIds].map((id) => `#${id}`).join(", ")}.`,
  );
}

const runIssueWorker = async (
  issue: z.infer<typeof planSchema>["issues"][number],
  findings: string[] = [],
  defectHistory: string[] = [],
  roundContext = "",
) =>
  retryOperation({
    label: `Issue #${issue.id} implementer`,
    attempts: PHASE_ATTEMPTS,
    initialDelayMs: RETRY_DELAY_MS,
    signal: controller.signal,
    operation: async () => {
      reportProgress({
        phase: "implementation",
        label: `Implement issue #${issue.id}`,
        summary: findings.length > 0
          ? `The implementation Worker is addressing review findings for issue #${issue.id}.`
          : `The implementation Worker is delivering issue #${issue.id}.`,
        status: "running",
      });
      const workerSandboxSettings = createWorkerSandboxSettings(
        issue.id,
        process.env,
        { codexAuthPath },
      );
      // A retry gets a fresh container while retaining the named worktree.
      // This preserves commits and uncommitted edits from an interrupted agent.
      const sandbox = await sandcastle.createSandbox({
        branch: issue.branch,
        sandbox: docker(workerSandboxSettings.docker),
        hooks: workerSandboxSettings.hooks,
        copyToWorktree,
      });

      try {
        return await sandbox.run({
          ...runSettings,
          name: "implementer",
          maxIterations: 100,
          agent: sandcastle.codex("gpt-5.6-sol", { effort: "xhigh" }),
          promptFile: harnessFile("implement-prompt.md"),
          promptArgs: {
            TASK_ID: issue.id,
            ISSUE_TITLE: issue.title,
            BRANCH: issue.branch,
            REVIEW_FINDINGS:
              findings.length > 0
                ? findings.map((finding) => `- ${finding}`).join("\n")
                : "- None; this is the initial implementation pass.",
            // Short headline history, not full transcripts — helps a fresh
            // sandbox notice a recurring defect family instead of only ever
            // seeing the single most recent instance of it.
            DEFECT_HISTORY:
              defectHistory.length > 0
                ? defectHistory.map((summary) => `- ${summary}`).join("\n")
                : "- None yet.",
            ROUND_CONTEXT:
              roundContext
                || "This is the initial implementation pass; no review has occurred yet.",
            SIZE_WARNING: issue.sizeWarning ?? "None noted by the planner.",
          },
        });
      } finally {
        await sandbox.close();
      }
    },
  });

const runPullRequestReviewer = async (
  issue: z.infer<typeof planSchema>["issues"][number],
  pullRequest: { number: number },
  reviewLedger: z.infer<typeof reviewSchema>[],
) =>
  retryOperation({
    label: `Pull request #${pullRequest.number} reviewer`,
    attempts: PHASE_ATTEMPTS,
    initialDelayMs: RETRY_DELAY_MS,
    signal: controller.signal,
    operation: () => {
      reportProgress({
        phase: "review",
        label: `Review pull request #${pullRequest.number}`,
        summary: `An independent review round is evaluating the delivery for issue #${issue.id}.`,
        status: "running",
      });
      return runPullRequestReview({
      issue,
      pullRequest,
      reviewLedger,
      createSandbox: sandcastle.createSandbox,
      sandboxOptions: {
        sandbox: codexDocker(),
        hooks,
        copyToWorktree,
      },
      runOptions: {
        ...runSettings,
        name: `pr-${pullRequest.number}-reviewer`,
        maxIterations: 1,
        agent: sandcastle.codex("gpt-5.6-sol", { effort: "xhigh" }),
        promptFile: harnessFile("pr-review-prompt.md"),
      },
      parseReview: (value: unknown) => reviewSchema.parse(value),
      });
    },
  });

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const main = async () => {
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    if (runScope && scopeOptions && await runScope.isComplete()) {
      console.log(
        "issueId" in scopeOptions
          ? `Issue #${scopeOptions.issueId} is complete. Scoped Harness run finished.`
          : `Parent issue #${scopeOptions.parentIssueId} is complete. Scoped Harness run finished.`,
      );
      break;
    }

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
  reportProgress({
    phase: "planning",
    label: `Plan issue #${scopedIssueNumber}`,
    summary: `The scoped planner is selecting issue #${scopedIssueNumber} for delivery.`,
    status: "running",
  });
  const plan = await retryOperation({
    label: "Planner",
    attempts: PHASE_ATTEMPTS,
    initialDelayMs: RETRY_DELAY_MS,
    signal: controller.signal,
    operation: () => sandcastle.run({
      ...runSettings,
      hooks,
      sandbox: codexDocker(),
      name: "planner",
      // One iteration is enough: the planner just needs to read and reason,
      // not write code. (Structured output requires maxIterations: 1.)
      maxIterations: 1,
      agent: sandcastle.codex("gpt-5.6-sol", { effort: "xhigh" }),
      promptFile: harnessFile("plan-prompt.md"),
      output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
    }),
  });

  const issues: z.infer<typeof planSchema>["issues"] = selectScopedIssues(
    plan.output.issues,
    runScope,
  );
  reportProgress({
    phase: "planning",
    label: `Plan issue #${scopedIssueNumber}`,
    summary: `Planning selected ${issues.length} scoped issue(s) for this delivery round.`,
    status: "succeeded",
  });

  if (issues.length === 0) {
    console.log(
      scopeOptions && "issueId" in scopeOptions
        ? `Issue #${scopeOptions.issueId} is not unblocked yet. Exiting.`
        : scopeOptions
          ? `No unblocked descendants of #${scopeOptions.parentIssueId} are ready. Exiting.`
          : "No unblocked issues to work on. Exiting.",
    );
    break;
  }

  console.log(`Planning complete. ${issues.length} issue(s) to deliver:`);
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
    if (issue.sizeWarning) {
      console.warn(`    ⚠ Ticket-size warning: ${issue.sizeWarning}`);
    }
  }

  let deliveryFailed = false;
  for (const issue of issues) {
    const overrideClaim = overrideClaimIssueIds.has(issue.id);
    if (overrideClaim) {
      const existingClaim = await getActiveIssueClaim({ issue, github });
      if (existingClaim && existingClaim.instanceId !== instance.id) {
        console.warn(
          `  ⚠ Overriding existing claim on issue #${issue.id}: held by ${existingClaim.host} (pid ${existingClaim.pid}, claimed ${existingClaim.at}). Verify that instance is not still running before proceeding.`,
        );
      }
    }
    try {
      const result = await completeIssueThroughPullRequest({
        issue,
        repository,
        github,
        maxReviewAttempts,
        instance,
        overrideClaim,
        worker: {
          implement: ({
            branch,
            findings = [],
            defectHistory = [],
            roundContext = "",
          }: {
            branch: string;
            findings?: string[];
            defectHistory?: string[];
            roundContext?: string;
          }) => runIssueWorker({ ...issue, branch }, findings, defectHistory, roundContext),
        },
        reviewer: {
          evaluatePullRequest: ({
            pullRequest,
            reviewLedger,
          }: {
            pullRequest: { number: number };
            reviewLedger: z.infer<typeof reviewSchema>[];
          }) => runPullRequestReviewer(issue, pullRequest, reviewLedger),
        },
      });
      if (result.skipped) {
        console.log(
          `  ⏭ Issue #${issue.id} is already claimed by ${result.claim.host} (pid ${result.claim.pid}, claimed ${result.claim.at}). Skipping this iteration. Use --override-claim ${issue.id} to take over if that instance has crashed.`,
        );
        continue;
      }
      console.log(
        `  ✓ Issue #${issue.id} merged through ${result.pullRequest.url}`,
      );
      completedDeliveries.push({
        issueId: issue.id,
        pullRequest: result.pullRequest,
      });
      reportProgress({
        phase: "completion",
        label: `Complete issue #${issue.id}`,
        summary: `Issue #${issue.id} was closed through merged pull request #${result.pullRequest.number}.`,
        status: "succeeded",
      });
    } catch (error) {
      deliveryFailed = true;
      console.error(`  ✗ Issue #${issue.id} delivery failed:`, error);
      break;
    }
  }

  if (deliveryFailed) {
    process.exitCode = 1;
    return;
  }
  }

  console.log("\nAll done.");
};

let executionFailed = false;
try {
  await main();
} catch (error) {
  executionFailed = true;
  console.error("\nSandcastle stopped after all retries:", error);
  console.error(
    "Branch worktrees were preserved. Restore connectivity, then rerun the same npm command to resume.",
  );
  process.exitCode = 1;
}

if (protocolEnabled && scopedIssueNumber && runScope) {
  let issueComplete = false;
  try {
    issueComplete = await runScope.isComplete();
  } catch (error) {
    executionFailed = true;
    console.error("Unable to attest scoped issue completion:", error);
  }
  const delivery = completedDeliveries.find(({ issueId }) =>
    Number(issueId) === scopedIssueNumber);
  const succeeded = !executionFailed && process.exitCode !== 1 && issueComplete;
  publishDelegationMessage(createRealDelegationResult(succeeded
    ? {
        issueNumber: scopedIssueNumber,
        status: "succeeded",
        code: "scoped_issue_completed",
        completion: delivery
          ? {
              kind: "merged-pull-request",
              pullRequestNumber: delivery.pullRequest.number,
              pullRequestUrl: delivery.pullRequest.url,
            }
          : { kind: "issue-already-closed" },
      }
    : {
        issueNumber: scopedIssueNumber,
        status: "failed",
        code: controller.signal.aborted
          ? "delivery_cancelled"
          : executionFailed
            ? "delivery_execution_failed"
            : "scoped_issue_incomplete",
        completion: null,
      }));
  if (!succeeded) process.exitCode = 1;
}
process.removeListener("SIGTERM", handleTermination);
