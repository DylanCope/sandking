import { execFileSync, spawnSync } from "node:child_process";

const commandRunner = (cwd) => ({
  run: (command, args) =>
    execFileSync(command, args, { cwd, encoding: "utf8" }).trim(),
  runResult: (command, args) =>
    spawnSync(command, args, { cwd, encoding: "utf8" }),
});

export function createGitRepository({ cwd = process.cwd() } = {}) {
  const { run, runResult } = commandRunner(cwd);
  return {
    async synchronizeMain() {
      run("git", ["fetch", "origin", "main"]);
      run("git", ["merge", "--ff-only", "origin/main"]);
      return run("git", ["rev-parse", "origin/main"]);
    },

    async createFreshBranch(branch, baseCommit) {
      const local = runResult("git", [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
      const remote = runResult("git", [
        "ls-remote",
        "--exit-code",
        "--heads",
        "origin",
        branch,
      ]);
      if (local.status === 0 || remote.status === 0) {
        throw new Error(`Issue branch already exists: ${branch}`);
      }
      run("git", ["branch", branch, baseCommit]);
    },

    async resumeBranch(branch) {
      run("git", ["fetch", "origin", "main", branch]);
      const local = runResult("git", [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
      if (local.status !== 0) {
        run("git", ["branch", "--track", branch, `origin/${branch}`]);
      }
      return {
        branch,
        baseCommit: run("git", ["merge-base", "origin/main", branch]),
        headCommit: run("git", ["rev-parse", branch]),
      };
    },

    async pushBranch(branch) {
      run("git", ["push", "--set-upstream", "origin", branch]);
      return run("git", ["rev-parse", branch]);
    },
  };
}

export function createGitHubDelivery() {
  const { run, runResult } = commandRunner(process.cwd());
  const repository = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);

  const readPullRequest = (selector) => {
    const payload = JSON.parse(
      run("gh", [
        "pr",
        "view",
        String(selector),
        "--json",
        "number,url,baseRefName,headRefName,state,mergedAt",
      ]),
    );
    return {
      number: payload.number,
      url: payload.url,
      base: payload.baseRefName,
      head: payload.headRefName,
      state: payload.mergedAt ? "merged" : payload.state.toLowerCase(),
    };
  };

  return {
    async getIssue(issueId) {
      const issue = JSON.parse(
        run("gh", [
          "issue",
          "view",
          String(issueId),
          "--json",
          "number,title,state",
        ]),
      );
      return {
        id: String(issue.number),
        title: issue.title,
        state: issue.state.toLowerCase(),
      };
    },

    async findOpenPullRequest({ issue }) {
      const branch = `sandcastle/issue-${issue.id}`;
      const matches = JSON.parse(
        run("gh", [
          "pr",
          "list",
          "--state",
          "open",
          "--base",
          "main",
          "--head",
          branch,
          "--json",
          "number,url,baseRefName,headRefName,state,mergedAt",
        ]),
      );
      if (matches.length > 1) {
        throw new Error(`Multiple open pull requests found for ${branch}.`);
      }
      return matches.length === 0 ? null : readPullRequest(matches[0].number);
    },

    async createPullRequest({ base, head, issue }) {
      run("gh", [
        "pr",
        "create",
        "--base",
        base,
        "--head",
        head,
        "--title",
        `#${issue.id}: ${issue.title}`,
        "--body",
        `Implements #${issue.id}. Sandcastle closes the issue only after this PR is reviewed, checked, and merged.`,
      ]);
      return readPullRequest(head);
    },

    async submitPullRequestReview({ pullRequest, review }) {
      const heading = review.approved
        ? "Sandcastle independent review: APPROVED"
        : "Sandcastle independent review: CHANGES REQUESTED";
      const findings = review.findings.length > 0
        ? review.findings.map((finding) => `- ${finding}`).join("\n")
        : "- No findings.";
      run("gh", [
        "pr",
        "comment",
        String(pullRequest.number),
        "--body",
        `${heading}\n\n${findings}`,
      ]);
    },

    async getPullRequestDiff({ pullRequest }) {
      return run("gh", ["pr", "diff", String(pullRequest.number), "--patch"]);
    },

    async waitForPullRequestChecks({ pullRequest }) {
      const result = runResult("gh", [
        "pr",
        "checks",
        String(pullRequest.number),
        "--watch",
        "--fail-fast",
      ]);
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      return {
        passed: result.status === 0 || /no checks reported/i.test(output),
        details: output.trim(),
      };
    },

    async mergePullRequest({ pullRequest }) {
      run("gh", ["pr", "merge", String(pullRequest.number), "--merge"]);
    },

    async getPullRequest(number) {
      return readPullRequest(number);
    },

    async closeIssue({ issueId, pullRequest }) {
      run("gh", [
        "issue",
        "close",
        String(issueId),
        "--comment",
        `Completed by merged PR ${pullRequest.url}`,
      ]);
    },

    async getParentIssue(issueId) {
      const result = runResult("gh", [
        "api",
        `repos/${repository}/issues/${issueId}/parent`,
      ]);
      if (result.status !== 0) {
        return null;
      }
      const parent = JSON.parse(result.stdout);
      return { id: String(parent.number) };
    },

    async listSubIssues(issueId) {
      const children = JSON.parse(
        run("gh", [
          "api",
          `repos/${repository}/issues/${issueId}/sub_issues`,
        ]),
      );
      return children.map((child) => ({
        id: String(child.number),
        state: child.state,
      }));
    },
  };
}
