import assert from "node:assert/strict";
import test from "node:test";
import {
  completeIssueThroughPullRequest,
  computeActiveClaim,
  DEFAULT_MAX_REVIEW_ATTEMPTS,
  deliverIssueThroughPullRequest,
  getActiveIssueClaim,
  produceIssueBranch,
} from "./issue-delivery.mjs";

test("an issue is implemented on a fresh branch from synchronized origin/main and pushed", async () => {
  const repository = createFakeRepository("main-abc123");
  const worker = {
    async implement({ branch, issue }) {
      repository.commit(branch, `complete issue ${issue.id}`);
    },
  };

  const result = await produceIssueBranch({
    issue: { id: "26", title: "Launch the Cockpit" },
    repository,
    worker,
  });

  assert.deepEqual(result, {
    branch: "sandcastle/issue-26",
    baseCommit: "main-abc123",
    headCommit: "commit-1",
  });
  assert.deepEqual(repository.inspectBranch("sandcastle/issue-26"), {
    baseCommit: "main-abc123",
    commits: ["complete issue 26"],
    pushedHead: "commit-1",
  });
});

test("an issue closes only after its approved PR passes checks and is confirmed merged", async () => {
  const repository = createFakeRepository("main-merge-base");
  const github = createFakeGitHub();
  const worker = {
    async implement({ branch, issue }) {
      repository.commit(branch, `complete issue ${issue.id}`);
    },
  };
  const reviewer = {
    async evaluatePullRequest() {
      return { approved: true, findings: [] };
    },
  };

  const result = await completeIssueThroughPullRequest({
    issue: { id: "31", title: "Accept the walking skeleton" },
    repository,
    worker,
    github,
    reviewer,
  });

  assert.equal(result.pullRequest.state, "merged");
  assert.deepEqual(github.inspectPullRequest(101), {
    base: "main",
    head: "sandcastle/issue-31",
    issueId: "31",
    state: "merged",
  });
  assert.deepEqual(github.inspectIssue("31"), {
    state: "closed",
    completionPullRequest: "https://github.test/pull/101",
  });
});

test("an approved delivery publishes actionable follow-ups after merge without blocking completion", async () => {
  const repository = createFakeRepository("main-follow-up-base");
  const github = createFakeGitHub();
  let workerCalls = 0;

  const result = await completeIssueThroughPullRequest({
    issue: { id: "41", title: "Launch the secure Cockpit" },
    repository,
    github,
    worker: {
      async implement({ branch }) {
        workerCalls += 1;
        repository.commit(branch, "complete the secure Cockpit");
      },
    },
    reviewer: {
      async evaluatePullRequest() {
        return {
          approved: true,
          blockingFindings: [],
          followUps: [{
            title: "Split runtime lifecycle responsibilities",
            body: "Extract lifecycle coordination behind a stable interface.\n\nAcceptance criteria:\n- Runtime behavior remains unchanged.\n- Existing acceptance scenarios pass.",
            sourceFinding: "The runtime module owns unrelated responsibilities.",
            acceptanceCriteria: [
              "Runtime behavior remains unchanged.",
              "Existing acceptance scenarios pass.",
            ],
          }],
          resolvedFindings: [],
        };
      },
    },
  });

  assert.equal(result.pullRequest.state, "merged");
  assert.equal(workerCalls, 1);
  assert.deepEqual(github.inspectFollowUps(), [{
    sourceIssueId: "41",
    sourcePullRequest: "https://github.test/pull/101",
    title: "Split runtime lifecycle responsibilities",
    body: "Extract lifecycle coordination behind a stable interface.\n\nAcceptance criteria:\n- Runtime behavior remains unchanged.\n- Existing acceptance scenarios pass.",
    sourceFinding: "The runtime module owns unrelated responsibilities.",
    acceptanceCriteria: [
      "Runtime behavior remains unchanged.",
      "Existing acceptance scenarios pass.",
    ],
    labels: ["ready-for-agent"],
  }]);
});

test("a failed PR check leaves the issue and PR open", async () => {
  const repository = createFakeRepository("main-check-base");
  const github = createFakeGitHub({ checksPassed: false });

  await assert.rejects(
    completeIssueThroughPullRequest({
      issue: { id: "32", title: "Reject a failing delivery" },
      repository,
      github,
      worker: {
        async implement({ branch }) {
          repository.commit(branch, "implementation with a failing check");
        },
      },
      reviewer: {
        async evaluatePullRequest() {
          return { approved: true, findings: [] };
        },
      },
    }),
    /checks failed/,
  );

  assert.equal(github.inspectIssue("32").state, "open");
  assert.equal(github.inspectPullRequest(101).state, "open");
});

test("closing a delivered issue recursively closes parents whose direct sub-issues are complete", async () => {
  const repository = createFakeRepository("main-parent-base");
  const github = createFakeGitHub({
    parents: { "31": "25", "25": "24" },
    children: {
      "25": ["26", "27", "28", "29", "30", "31"],
      "24": ["25", "32"],
    },
    closedIssues: ["26", "27", "28", "29", "30", "32"],
  });
  const worker = {
    async implement({ branch }) {
      repository.commit(branch, "accept the local walking skeleton");
    },
  };
  const reviewer = {
    async evaluatePullRequest() {
      return { approved: true, findings: [] };
    },
  };

  await completeIssueThroughPullRequest({
    issue: { id: "31", title: "Accept the local walking skeleton" },
    repository,
    worker,
    github,
    reviewer,
  });

  assert.equal(github.inspectIssue("31").state, "closed");
  assert.equal(github.inspectIssue("25").state, "closed");
  assert.equal(github.inspectIssue("24").state, "closed");
  assert.equal(
    github.inspectIssue("24").completionPullRequest,
    "https://github.test/pull/101",
  );
});

test("a pushed issue branch becomes a main-targeted pull request reviewed by an independent process", async () => {
  const repository = createFakeRepository("main-def456");
  const github = createFakeGitHub();
  const worker = {
    async implement({ branch, issue }) {
      repository.commit(branch, `complete issue ${issue.id}`);
    },
  };
  const reviewer = {
    async evaluatePullRequest({ pullRequest, issue }) {
      assert.equal(pullRequest.head, "sandcastle/issue-27");
      assert.equal(issue.id, "27");
      return { approved: true, findings: [] };
    },
  };

  const result = await deliverIssueThroughPullRequest({
    issue: { id: "27", title: "Connect a local Host" },
    repository,
    worker,
    github,
    reviewer,
  });

  assert.deepEqual(result.pullRequest, {
    number: 101,
    base: "main",
    head: "sandcastle/issue-27",
    url: "https://github.test/pull/101",
  });
  assert.deepEqual(result.review, { approved: true, findings: [] });
  assert.deepEqual(github.inspectPullRequest(101), {
    base: "main",
    head: "sandcastle/issue-27",
    issueId: "27",
    state: "open",
  });
});

test("requested PR changes are implemented, pushed, and independently re-reviewed", async () => {
  const repository = createFakeRepository("main-review-base");
  const github = createFakeGitHub({ pullRequestDiffs: ["initial diff", "fixed diff"] });
  const worker = {
    async implement({ branch, findings, issue }) {
      repository.commit(
        branch,
        findings?.[0] ?? `initial implementation for ${issue.id}`,
      );
    },
  };
  let reviewAttempt = 0;
  const reviewer = {
    async evaluatePullRequest() {
      reviewAttempt += 1;
      return reviewAttempt === 1
        ? { approved: false, findings: ["Exercise the public Cockpit seam"] }
        : { approved: true, findings: [] };
    },
  };

  const result = await deliverIssueThroughPullRequest({
    issue: { id: "29", title: "Approve a Harness run" },
    repository,
    worker,
    github,
    reviewer,
  });

  assert.deepEqual(result.review, { approved: true, findings: [] });
  assert.deepEqual(repository.inspectBranch("sandcastle/issue-29"), {
    baseCommit: "main-review-base",
    commits: [
      "initial implementation for 29",
      "Exercise the public Cockpit seam",
    ],
    pushedHead: "commit-2",
  });
  assert.deepEqual(github.inspectReviews(101), [
    { approved: false, findings: ["Exercise the public Cockpit seam"] },
    { approved: true, findings: [] },
  ]);
});

test("each reviewer receives the complete verdict ledger from earlier attempts", async () => {
  const repository = createFakeRepository("main-ledger-base");
  const github = createFakeGitHub({ pullRequestDiffs: ["initial", "corrected"] });
  const ledgers = [];
  const firstReview = {
    approved: false,
    blockingFindings: [{
      summary: "Runtime reuse can create competitors",
      requirement: "Issue acceptance: reuse one runtime",
      evidence: "Two live listeners were reproduced.",
      materialImpact: "Core lifecycle invariant is broken.",
      cannotDefer: "Merging would establish unsafe launch behavior.",
    }],
    followUps: [],
    resolvedFindings: [],
  };

  await deliverIssueThroughPullRequest({
    issue: { id: "42", title: "Reuse the runtime" },
    repository,
    github,
    worker: {
      async implement({ branch, findings }) {
        repository.commit(branch, findings?.[0] ?? "initial runtime reuse");
      },
    },
    reviewer: {
      async evaluatePullRequest({ reviewLedger }) {
        ledgers.push(structuredClone(reviewLedger));
        return ledgers.length === 1
          ? firstReview
          : {
              approved: true,
              blockingFindings: [],
              followUps: [],
              resolvedFindings: ["Runtime reuse can create competitors"],
            };
      },
    },
  });

  assert.deepEqual(ledgers, [[], [firstReview]]);
});

test("a productive review loop may use its full custom review-attempt budget", async () => {
  const repository = createFakeRepository("main-long-review-base");
  const github = createFakeGitHub({
    pullRequestDiffs: Array.from({ length: 4 }, (_, index) => `diff ${index + 1}`),
  });
  let reviewAttempt = 0;

  const result = await deliverIssueThroughPullRequest({
    issue: { id: "117", title: "Build the runtime skeleton" },
    repository,
    github,
    maxReviewAttempts: 4,
    worker: {
      async implement({ branch, findings, issue }) {
        repository.commit(
          branch,
          findings?.[0] ?? `initial implementation for ${issue.id}`,
        );
      },
    },
    reviewer: {
      async evaluatePullRequest() {
        reviewAttempt += 1;
        return reviewAttempt === 4
          ? { approved: true, findings: [] }
          : { approved: false, findings: [`Resolve review ${reviewAttempt}`] };
      },
    },
  });

  assert.equal(reviewAttempt, 4);
  assert.equal(result.review.approved, true);
});

test("maxReviewAttempts defaults to DEFAULT_MAX_REVIEW_ATTEMPTS when not supplied", async () => {
  const repository = createFakeRepository("main-default-budget-base");
  const github = createFakeGitHub({
    pullRequestDiffs: Array.from(
      { length: DEFAULT_MAX_REVIEW_ATTEMPTS },
      (_, index) => `diff ${index + 1}`,
    ),
  });
  let reviewAttempt = 0;

  const result = await deliverIssueThroughPullRequest({
    issue: { id: "117", title: "Build the runtime skeleton" },
    repository,
    github,
    worker: {
      async implement({ branch, findings, issue }) {
        repository.commit(
          branch,
          findings?.[0] ?? `initial implementation for ${issue.id}`,
        );
      },
    },
    reviewer: {
      async evaluatePullRequest() {
        reviewAttempt += 1;
        return reviewAttempt === DEFAULT_MAX_REVIEW_ATTEMPTS
          ? { approved: true, findings: [] }
          : { approved: false, findings: [`Resolve review ${reviewAttempt}`] };
      },
    },
  });

  assert.equal(reviewAttempt, DEFAULT_MAX_REVIEW_ATTEMPTS);
  assert.equal(result.review.approved, true);
});

test("a resumed delivery preserves a custom review-attempt budget from its ledger", async () => {
  const repository = createFakeRepository("main-budget-base", {
    "sandcastle/issue-120": ["existing implementation"],
  });
  const priorReview = {
    approved: false,
    blockingFindings: [{
      summary: "Unresolved blocker",
      requirement: "Required behavior",
      evidence: "Observed failure",
      materialImpact: "Unsafe merge",
      cannotDefer: "Required in this issue",
    }],
    followUps: [],
    resolvedFindings: [],
  };
  const github = createFakeGitHub({
    openPullRequest: {
      number: 77,
      base: "main",
      head: "sandcastle/issue-120",
      url: "https://github.test/pull/77",
    },
    reviewLedger: Array.from({ length: 4 }, () => priorReview),
  });
  let reviewerCalls = 0;

  await assert.rejects(
    deliverIssueThroughPullRequest({
      issue: { id: "120", title: "Exhausted review budget" },
      repository,
      github,
      maxReviewAttempts: 4,
      worker: { async implement() {} },
      reviewer: {
        async evaluatePullRequest() {
          reviewerCalls += 1;
          return priorReview;
        },
      },
    }),
    /used all 4 review attempts/,
  );

  assert.equal(reviewerCalls, 0);
});

test("an empty PR is returned to the worker without consuming a review", async () => {
  const repository = createFakeRepository("main-empty-pr-base");
  const github = createFakeGitHub({ pullRequestDiffs: ["", "real diff"] });
  let workerCalls = 0;
  let reviewerCalls = 0;

  await deliverIssueThroughPullRequest({
    issue: { id: "118", title: "Add runtime observability" },
    repository,
    github,
    worker: {
      async implement({ branch }) {
        workerCalls += 1;
        repository.commit(branch, `implementation ${workerCalls}`);
      },
    },
    reviewer: {
      async evaluatePullRequest() {
        reviewerCalls += 1;
        return { approved: true, findings: [] };
      },
    },
  });

  assert.equal(workerCalls, 2);
  assert.equal(reviewerCalls, 1);
});

test("an unchanged rejected PR stops after three worker attempts without wasting reviews", async () => {
  const repository = createFakeRepository("main-stalled-pr-base");
  const github = createFakeGitHub({ pullRequestDiffs: ["unchanged diff"] });
  let workerCalls = 0;
  let reviewerCalls = 0;

  await assert.rejects(
    deliverIssueThroughPullRequest({
      issue: { id: "119", title: "Expose runtime status" },
      repository,
      github,
      worker: {
        async implement({ branch }) {
          workerCalls += 1;
          repository.commit(branch, `worker attempt ${workerCalls}`);
        },
      },
      reviewer: {
        async evaluatePullRequest() {
          reviewerCalls += 1;
          return { approved: false, findings: ["Expose the status seam"] };
        },
      },
    }),
    /unchanged after 3 worker attempts/,
  );

  assert.equal(reviewerCalls, 1);
  assert.equal(workerCalls, 4);
});

test("a rerun resumes an existing open issue PR instead of creating a new branch or PR", async () => {
  const repository = createFakeRepository("main-resume-base", {
    "sandcastle/issue-40": ["interrupted implementation"],
  });
  const github = createFakeGitHub({
    openPullRequest: {
      number: 77,
      base: "main",
      head: "sandcastle/issue-40",
      url: "https://github.test/pull/77",
    },
  });
  let workerCalls = 0;

  const result = await deliverIssueThroughPullRequest({
    issue: { id: "40", title: "Resume interrupted delivery" },
    repository,
    github,
    worker: {
      async implement() {
        workerCalls += 1;
      },
    },
    reviewer: {
      async evaluatePullRequest() {
        return { approved: true, findings: [] };
      },
    },
  });

  assert.equal(result.pullRequest.number, 77);
  assert.equal(workerCalls, 0);
  assert.equal(github.inspectCreatedPullRequestCount(), 0);
  assert.deepEqual(repository.inspectResumedBranches(), [
    "sandcastle/issue-40",
  ]);
});

test("computeActiveClaim replays claim/release/override events to find the current holder", () => {
  assert.equal(computeActiveClaim([]), null);

  assert.deepEqual(
    computeActiveClaim([
      { action: "claim", instanceId: "host-a", at: "1" },
    ]),
    { action: "claim", instanceId: "host-a", at: "1" },
  );

  assert.equal(
    computeActiveClaim([
      { action: "claim", instanceId: "host-a", at: "1" },
      { action: "release", instanceId: "host-a", at: "2" },
    ]),
    null,
  );

  // First claim wins; a second claim from a different instance while one is
  // already active is ignored rather than replacing the holder.
  assert.deepEqual(
    computeActiveClaim([
      { action: "claim", instanceId: "host-a", at: "1" },
      { action: "claim", instanceId: "host-b", at: "2" },
    ]),
    { action: "claim", instanceId: "host-a", at: "1" },
  );

  assert.equal(
    computeActiveClaim([
      { action: "claim", instanceId: "host-a", at: "1" },
      { action: "override", instanceId: "host-b", overriddenInstanceId: "host-a", at: "2" },
    ]),
    null,
  );
});

test("a delivery without an instance never touches claiming", async () => {
  const repository = createFakeRepository("main-no-claim-base");
  const github = createFakeGitHub();

  await deliverIssueThroughPullRequest({
    issue: { id: "170", title: "Deliver without claim awareness" },
    repository,
    github,
    worker: {
      async implement({ branch }) {
        repository.commit(branch, "implementation");
      },
    },
    reviewer: {
      async evaluatePullRequest() {
        return { approved: true, findings: [] };
      },
    },
  });

  assert.deepEqual(github.inspectClaimLedger("170"), []);
});

test("a delivery claims the issue before working on it and releases the claim on completion", async () => {
  const repository = createFakeRepository("main-claim-base");
  const github = createFakeGitHub();
  const instance = { id: "devbox", host: "devbox", pid: 111 };

  await deliverIssueThroughPullRequest({
    issue: { id: "171", title: "Deliver with claim awareness" },
    repository,
    github,
    instance,
    worker: {
      async implement({ branch }) {
        repository.commit(branch, "implementation");
      },
    },
    reviewer: {
      async evaluatePullRequest() {
        return { approved: true, findings: [] };
      },
    },
  });

  const ledger = github.inspectClaimLedger("171");
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].action, "claim");
  assert.equal(ledger[0].instanceId, "devbox");
  assert.equal(ledger[1].action, "release");
  assert.equal(ledger[1].instanceId, "devbox");
  assert.equal(await getActiveIssueClaim({ issue: { id: "171" }, github }), null);
});

test("a delivery releases its claim even when the review budget is exhausted", async () => {
  const repository = createFakeRepository("main-claim-failure-base");
  const github = createFakeGitHub({ pullRequestDiffs: ["unchanged diff"] });
  const instance = { id: "devbox", host: "devbox", pid: 111 };

  await assert.rejects(
    deliverIssueThroughPullRequest({
      issue: { id: "172", title: "Deliver a doomed change" },
      repository,
      github,
      instance,
      worker: {
        async implement({ branch }) {
          repository.commit(branch, "implementation");
        },
      },
      reviewer: {
        async evaluatePullRequest() {
          return { approved: false, findings: ["Unresolved"] };
        },
      },
    }),
    /unchanged after 3 worker attempts/,
  );

  assert.equal(await getActiveIssueClaim({ issue: { id: "172" }, github }), null);
});

test("a second instance skips an issue already claimed and never invokes the worker", async () => {
  const repository = createFakeRepository("main-skip-base");
  const github = createFakeGitHub();
  await github.postIssueClaimEvent({
    issue: { id: "173" },
    event: {
      action: "claim",
      instanceId: "laptop",
      host: "laptop",
      pid: 222,
      branch: "sandcastle/issue-173",
      at: "2026-08-09T10:00:00.000Z",
    },
  });
  let workerCalls = 0;

  const result = await deliverIssueThroughPullRequest({
    issue: { id: "173", title: "Already claimed elsewhere" },
    repository,
    github,
    instance: { id: "devbox", host: "devbox", pid: 111 },
    worker: {
      async implement() {
        workerCalls += 1;
      },
    },
    reviewer: {
      async evaluatePullRequest() {
        return { approved: true, findings: [] };
      },
    },
  });

  assert.deepEqual(result, {
    skipped: true,
    reason: "claimed",
    claim: {
      action: "claim",
      instanceId: "laptop",
      host: "laptop",
      pid: 222,
      branch: "sandcastle/issue-173",
      at: "2026-08-09T10:00:00.000Z",
    },
  });
  assert.equal(workerCalls, 0);
});

test("completeIssueThroughPullRequest returns a skipped result without merging when claimed elsewhere", async () => {
  const repository = createFakeRepository("main-skip-complete-base");
  const github = createFakeGitHub();
  await github.postIssueClaimEvent({
    issue: { id: "174" },
    event: {
      action: "claim",
      instanceId: "laptop",
      host: "laptop",
      pid: 222,
      branch: "sandcastle/issue-174",
      at: "2026-08-09T10:00:00.000Z",
    },
  });

  const result = await completeIssueThroughPullRequest({
    issue: { id: "174", title: "Already claimed elsewhere" },
    repository,
    github,
    instance: { id: "devbox", host: "devbox", pid: 111 },
    worker: { async implement() {} },
    reviewer: {
      async evaluatePullRequest() {
        return { approved: true, findings: [] };
      },
    },
  });

  assert.equal(result.skipped, true);
  assert.equal(github.inspectIssue("174").state, "open");
});

test("the same instance resuming its own claim is never blocked", async () => {
  const repository = createFakeRepository("main-self-claim-base", {
    "sandcastle/issue-175": ["earlier work"],
  });
  const github = createFakeGitHub({
    openPullRequest: {
      number: 80,
      base: "main",
      head: "sandcastle/issue-175",
      url: "https://github.test/pull/80",
    },
  });
  await github.postIssueClaimEvent({
    issue: { id: "175" },
    event: {
      action: "claim",
      instanceId: "devbox",
      host: "devbox",
      pid: 999,
      branch: "sandcastle/issue-175",
      at: "2026-08-09T09:00:00.000Z",
    },
  });

  const result = await deliverIssueThroughPullRequest({
    issue: { id: "175", title: "Resume my own claim" },
    repository,
    github,
    instance: { id: "devbox", host: "devbox", pid: 111 },
    worker: { async implement() {} },
    reviewer: {
      async evaluatePullRequest() {
        return { approved: true, findings: [] };
      },
    },
  });

  assert.equal(result.skipped, undefined);
  assert.equal(result.review.approved, true);
});

test("an explicit override claims through another instance's claim and records who was overridden", async () => {
  const repository = createFakeRepository("main-override-base");
  const github = createFakeGitHub();
  await github.postIssueClaimEvent({
    issue: { id: "176" },
    event: {
      action: "claim",
      instanceId: "devbox",
      host: "devbox",
      pid: 999,
      branch: "sandcastle/issue-176",
      at: "2026-08-09T09:00:00.000Z",
    },
  });

  const result = await deliverIssueThroughPullRequest({
    issue: { id: "176", title: "Take over a crashed instance's claim" },
    repository,
    github,
    instance: { id: "laptop", host: "laptop", pid: 222 },
    overrideClaim: true,
    worker: {
      async implement({ branch }) {
        repository.commit(branch, "implementation");
      },
    },
    reviewer: {
      async evaluatePullRequest() {
        return { approved: true, findings: [] };
      },
    },
  });

  assert.equal(result.skipped, undefined);
  assert.deepEqual(result.overriddenClaim, {
    action: "claim",
    instanceId: "devbox",
    host: "devbox",
    pid: 999,
    branch: "sandcastle/issue-176",
    at: "2026-08-09T09:00:00.000Z",
  });

  const ledger = github.inspectClaimLedger("176");
  assert.deepEqual(
    ledger.map((event) => event.action),
    ["claim", "override", "claim", "release"],
  );
  assert.equal(ledger[3].instanceId, "laptop");
});

function createFakeRepository(remoteMain, existingBranches = {}) {
  const branches = new Map();
  const resumedBranches = [];
  for (const [branch, commits] of Object.entries(existingBranches)) {
    branches.set(branch, {
      baseCommit: remoteMain,
      commits: [...commits],
      pushedHead: `commit-${commits.length}`,
    });
  }

  return {
    async synchronizeMain() {
      return remoteMain;
    },
    async createFreshBranch(branch, baseCommit) {
      assert.equal(branches.has(branch), false);
      branches.set(branch, { baseCommit, commits: [], pushedHead: null });
    },
    async resumeBranch(branch) {
      assert.equal(branches.has(branch), true);
      resumedBranches.push(branch);
      const state = branches.get(branch);
      return {
        branch,
        baseCommit: state.baseCommit,
        headCommit: state.pushedHead,
      };
    },
    commit(branch, message) {
      branches.get(branch).commits.push(message);
    },
    async pushBranch(branch) {
      const state = branches.get(branch);
      state.pushedHead = `commit-${state.commits.length}`;
      return state.pushedHead;
    },
    inspectBranch(branch) {
      return structuredClone(branches.get(branch));
    },
    inspectResumedBranches() {
      return [...resumedBranches];
    },
  };
}

function createFakeGitHub({
  parents = {},
  children = {},
  closedIssues = [],
  openPullRequest = null,
  checksPassed = true,
  pullRequestDiffs = ["substantive diff"],
  reviewLedger = [],
} = {}) {
  const pullRequests = new Map();
  const issues = new Map(
    closedIssues.map((issueId) => [issueId, { state: "closed" }]),
  );
  let diffRead = 0;
  const followUps = [];
  const claimEvents = [];

  return {
    async getIssueClaimLedger({ issue }) {
      return claimEvents
        .filter((event) => event.issueId === issue.id)
        .map(({ issueId: _issueId, ...event }) => event);
    },
    async postIssueClaimEvent({ issue, event }) {
      claimEvents.push({ issueId: issue.id, ...event });
    },
    inspectClaimLedger(issueId) {
      return claimEvents
        .filter((event) => event.issueId === issueId)
        .map(({ issueId: _issueId, ...event }) => structuredClone(event));
    },
    async findOpenPullRequest() {
      if (!openPullRequest) return null;
      pullRequests.set(openPullRequest.number, {
        base: openPullRequest.base,
        head: openPullRequest.head,
        issueId: openPullRequest.head.replace("sandcastle/issue-", ""),
        state: "open",
        reviews: [],
      });
      return structuredClone(openPullRequest);
    },
    async createPullRequest({ base, head, issue }) {
      const pullRequest = {
        number: 101,
        base,
        head,
        url: "https://github.test/pull/101",
      };
      pullRequests.set(pullRequest.number, {
        base,
        head,
        issueId: issue.id,
        state: "open",
        reviews: [],
      });
      return pullRequest;
    },
    async submitPullRequestReview({ pullRequest, review }) {
      pullRequests.get(pullRequest.number).reviews.push(structuredClone(review));
    },
    async getPullRequestDiff() {
      const diff = pullRequestDiffs[Math.min(diffRead, pullRequestDiffs.length - 1)];
      diffRead += 1;
      return diff;
    },
    async getReviewLedger() {
      return structuredClone(reviewLedger);
    },
    async waitForPullRequestChecks() {
      return { passed: checksPassed };
    },
    async mergePullRequest({ pullRequest }) {
      pullRequests.get(pullRequest.number).state = "merged";
    },
    async getPullRequest(number) {
      const pullRequest = pullRequests.get(number);
      return {
        number,
        base: pullRequest.base,
        head: pullRequest.head,
        url: `https://github.test/pull/${number}`,
        state: pullRequest.state,
      };
    },
    async closeIssue({ issueId, pullRequest }) {
      issues.set(issueId, {
        state: "closed",
        completionPullRequest: pullRequest.url,
      });
    },
    async createFollowUpIssue(followUp) {
      followUps.push(structuredClone(followUp));
    },
    async getParentIssue(issueId) {
      return parents[issueId] ? { id: parents[issueId] } : null;
    },
    async listSubIssues(issueId) {
      return (children[issueId] ?? []).map((id) => ({
        id,
        state: issues.get(id)?.state ?? "open",
      }));
    },
    inspectPullRequest(number) {
      const { reviews: _reviews, ...pullRequest } = pullRequests.get(number);
      return structuredClone(pullRequest);
    },
    inspectReviews(number) {
      return structuredClone(pullRequests.get(number).reviews);
    },
    inspectIssue(issueId) {
      return structuredClone(issues.get(issueId) ?? { state: "open" });
    },
    inspectCreatedPullRequestCount() {
      return [...pullRequests.keys()].filter((number) => number === 101).length;
    },
    inspectFollowUps() {
      return structuredClone(followUps);
    },
  };
}
