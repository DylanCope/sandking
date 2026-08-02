import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createGitHubDelivery,
  createGitRepository,
} from "./delivery-adapters.mjs";

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("the Git adapter creates and pushes an issue branch from origin/main", async (t) => {
  const root = mkdtempSync(join(process.cwd(), ".sandcastle-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const working = join(root, "working");

  git(root, "init", "--bare", origin);
  git(root, "clone", origin, working);
  git(working, "config", "user.name", "Sandcastle Test");
  git(working, "config", "user.email", "sandcastle@example.test");
  git(working, "switch", "-c", "main");
  writeFileSync(join(working, "README.md"), "base\n");
  git(working, "add", "README.md");
  git(working, "commit", "-m", "base");
  git(working, "push", "-u", "origin", "main");

  const repository = createGitRepository({ cwd: working });
  const baseCommit = await repository.synchronizeMain();
  await repository.createFreshBranch("sandcastle/issue-12", baseCommit);
  git(working, "switch", "sandcastle/issue-12");
  writeFileSync(join(working, "delivery.txt"), "delivered\n");
  git(working, "add", "delivery.txt");
  git(working, "commit", "-m", "deliver issue 12");
  const headCommit = await repository.pushBranch("sandcastle/issue-12");

  assert.equal(
    git(origin, "rev-parse", "refs/heads/sandcastle/issue-12"),
    headCommit,
  );
  assert.equal(
    git(working, "merge-base", baseCommit, headCommit),
    baseCommit,
  );
});

test("the GitHub adapter publishes each ready follow-up once with source provenance", async () => {
  const created = [];
  let existing = [];
  const github = createGitHubDelivery({
    cwd: "/repo",
    commandRunner: {
      run(command, args) {
        assert.equal(command, "gh");
        if (args[0] === "repo") return "DylanCope/sandking";
        if (args[0] === "issue" && args[1] === "list") {
          return JSON.stringify(existing);
        }
        if (args[0] === "issue" && args[1] === "create") {
          created.push(args);
          existing = [{ number: 142 }];
          return "https://github.test/issues/142";
        }
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
      runResult() {
        throw new Error("runResult is not expected");
      },
    },
  });
  const followUp = {
    sourceIssueId: "117",
    sourcePullRequest: "https://github.test/pull/127",
    title: "Split runtime lifecycle responsibilities",
    body: "Extract the lifecycle module.\n\nAcceptance criteria:\n- Public behavior is unchanged.",
    sourceFinding: "Runtime coordination has divergent responsibilities.",
    acceptanceCriteria: [
      "Runtime behavior remains unchanged.",
      "Existing acceptance scenarios pass.",
    ],
    labels: ["ready-for-agent"],
  };

  await github.createFollowUpIssue(followUp);
  await github.createFollowUpIssue(followUp);

  assert.equal(created.length, 1);
  assert.deepEqual(created[0].slice(0, 4), [
    "issue",
    "create",
    "--title",
    followUp.title,
  ]);
  const body = created[0][created[0].indexOf("--body") + 1];
  assert.match(body, /Origin issue: #117/);
  assert.match(body, /Origin PR: https:\/\/github\.test\/pull\/127/);
  assert.match(body, /Runtime coordination has divergent responsibilities/);
  assert.match(body, /## Acceptance criteria/);
  assert.match(body, /- \[ \] Runtime behavior remains unchanged\./);
  assert.match(body, /sandcastle-follow-up:117:/);
  assert.deepEqual(
    created[0].slice(created[0].indexOf("--label") + 1),
    ["ready-for-agent"],
  );
});

test("the GitHub adapter persists structured review verdicts for resumed runs", async () => {
  const comments = [];
  const github = createGitHubDelivery({
    commandRunner: {
      run(command, args) {
        assert.equal(command, "gh");
        if (args[0] === "repo") return "DylanCope/sandking";
        if (args[0] === "pr" && args[1] === "comment") {
          comments.push({ body: args[args.indexOf("--body") + 1] });
          return "";
        }
        if (args[0] === "pr" && args[1] === "view") {
          return JSON.stringify({ comments });
        }
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
      runResult() {
        throw new Error("runResult is not expected");
      },
    },
  });
  const review = {
    approved: false,
    blockingFindings: [{
      summary: "Competing runtimes are possible",
      requirement: "Repeated launch reuses one runtime",
      evidence: "Two listeners answered readiness",
      materialImpact: "Lifecycle authority is split",
      cannotDefer: "The launch seam would merge unsafe",
    }],
    followUps: [],
    resolvedFindings: [],
  };

  await github.submitPullRequestReview({ pullRequest: { number: 127 }, review });

  assert.deepEqual(
    await github.getReviewLedger({ pullRequest: { number: 127 } }),
    [review],
  );
  assert.match(comments[0].body, /BLOCKERS/);
  assert.match(comments[0].body, /Competing runtimes are possible/);
});

test("the GitHub adapter reads pull request patches larger than the subprocess default buffer", async () => {
  const minimumPatchCapacity = 2 * 1024 * 1024;
  const github = createGitHubDelivery({
    commandRunner: {
      run(command, args, options = {}) {
        assert.equal(command, "gh");
        if (args[0] === "repo") return "DylanCope/sandking";
        if (args[0] === "pr" && args[1] === "diff") {
          if ((options.maxBuffer ?? 1024 * 1024) < minimumPatchCapacity) {
            const error = new Error("spawnSync gh ENOBUFS");
            error.code = "ENOBUFS";
            throw error;
          }
          return "large pull request patch";
        }
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
      runResult() {
        throw new Error("runResult is not expected");
      },
    },
  });

  assert.equal(
    await github.getPullRequestDiff({ pullRequest: { number: 141 } }),
    "large pull request patch",
  );
});
