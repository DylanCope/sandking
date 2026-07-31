export async function produceIssueBranch({ issue, repository, worker }) {
  const branch = `sandcastle/issue-${issue.id}`;
  const baseCommit = await repository.synchronizeMain();
  await repository.createFreshBranch(branch, baseCommit);
  await worker.implement({ branch, issue });
  const headCommit = await repository.pushBranch(branch);

  return { branch, baseCommit, headCommit };
}

export async function deliverIssueThroughPullRequest({
  issue,
  repository,
  worker,
  github,
  reviewer,
}) {
  const existingPullRequest = await github.findOpenPullRequest({ issue });
  const branchResult = existingPullRequest
    ? await repository.resumeBranch(existingPullRequest.head)
    : await produceIssueBranch({ issue, repository, worker });
  const pullRequest = existingPullRequest ?? await github.createPullRequest({
    base: "main",
    head: branchResult.branch,
    issue,
  });
  if (existingPullRequest) {
    branchResult.headCommit = await repository.pushBranch(branchResult.branch);
  }
  let review;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    review = await reviewer.evaluatePullRequest({ pullRequest, issue });
    await github.submitPullRequestReview({ pullRequest, review });
    if (review.approved) {
      break;
    }
    if (attempt === 3) {
      throw new Error(`Pull request for issue #${issue.id} was not approved.`);
    }

    await worker.implement({
      branch: branchResult.branch,
      findings: review.findings,
      issue,
      pullRequest,
    });
    branchResult.headCommit = await repository.pushBranch(branchResult.branch);
  }

  return { ...branchResult, pullRequest, review };
}

export async function completeIssueThroughPullRequest(options) {
  const delivery = await deliverIssueThroughPullRequest(options);
  const checks = await options.github.waitForPullRequestChecks({
    pullRequest: delivery.pullRequest,
  });
  if (!checks.passed) {
    throw new Error(`Pull request checks failed for issue #${options.issue.id}.`);
  }

  await options.github.mergePullRequest({ pullRequest: delivery.pullRequest });
  const pullRequest = await options.github.getPullRequest(
    delivery.pullRequest.number,
  );
  if (pullRequest.state !== "merged") {
    throw new Error(`Pull request for issue #${options.issue.id} was not merged.`);
  }

  await options.github.closeIssue({
    issueId: options.issue.id,
    pullRequest,
  });
  await completeEligibleParents({
    completedIssueId: options.issue.id,
    github: options.github,
    pullRequest,
  });
  return { ...delivery, pullRequest };
}

export async function completeEligibleParents({
  completedIssueId,
  github,
  pullRequest,
}) {
  let childIssueId = completedIssueId;
  while (true) {
    const parent = await github.getParentIssue(childIssueId);
    if (!parent) {
      return;
    }

    const subIssues = await github.listSubIssues(parent.id);
    if (
      subIssues.length === 0
      || subIssues.some((subIssue) => subIssue.state !== "closed")
    ) {
      return;
    }

    await github.closeIssue({ issueId: parent.id, pullRequest });
    childIssueId = parent.id;
  }
}
