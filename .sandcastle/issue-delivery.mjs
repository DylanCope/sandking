export const DEFAULT_MAX_REVIEW_ATTEMPTS = 15;
const MAX_CONSECUTIVE_NO_PROGRESS_ATTEMPTS = 3;

function blockingFindingMessages(review) {
  if (review?.blockingFindings) {
    return review.blockingFindings.map((finding) => [
      finding.summary,
      `Requirement: ${finding.requirement}`,
      `Evidence: ${finding.evidence}`,
      `Material impact: ${finding.materialImpact}`,
      `Cannot defer: ${finding.cannotDefer}`,
    ].join("\n"));
  }
  return review?.findings ?? [];
}

// A short, deduplicated headline list of every distinct blocking-finding
// summary seen across all review rounds so far — not the full evidence text.
// Lets a fresh implementer sandbox recognize a recurring defect family (e.g.
// "this is the third PID-reuse finding") without re-reading full transcripts.
function defectHistorySummaries(reviewLedger) {
  const seen = new Set();
  const summaries = [];
  for (const entry of reviewLedger) {
    for (const finding of entry?.blockingFindings ?? []) {
      if (finding?.summary && !seen.has(finding.summary)) {
        seen.add(finding.summary);
        summaries.push(finding.summary);
      }
    }
  }
  return summaries;
}

function roundContextMessage(reviewAttempt, maxReviewAttempts) {
  return reviewAttempt > 0
    ? `This is review round ${reviewAttempt} of ${maxReviewAttempts}.`
    : "";
}

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
  maxReviewAttempts = DEFAULT_MAX_REVIEW_ATTEMPTS,
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
  const reviewLedger = await github.getReviewLedger?.({ pullRequest }) ?? [];
  let review = reviewLedger.at(-1);
  let reviewAttempt = reviewLedger.length;
  if (reviewAttempt >= maxReviewAttempts) {
    throw new Error(
      `Pull request for issue #${issue.id} has used all ${maxReviewAttempts} review attempts.`,
    );
  }
  let consecutiveEmptyDiffs = 0;
  let consecutiveUnchangedDiffs = 0;
  let lastReviewedDiff;
  while (reviewAttempt < maxReviewAttempts) {
    const diff = await github.getPullRequestDiff({ pullRequest });
    if (diff.trim().length === 0) {
      consecutiveEmptyDiffs += 1;
      if (consecutiveEmptyDiffs >= MAX_CONSECUTIVE_NO_PROGRESS_ATTEMPTS) {
        throw new Error(
          `Pull request for issue #${issue.id} remained empty after ${consecutiveEmptyDiffs} worker attempts.`,
        );
      }
      await worker.implement({
        branch: branchResult.branch,
        findings: [
          "The pull request has no code changes. Implement the issue before requesting another review.",
        ],
        defectHistory: defectHistorySummaries(reviewLedger),
        roundContext: roundContextMessage(reviewAttempt, maxReviewAttempts),
        issue,
        pullRequest,
      });
      branchResult.headCommit = await repository.pushBranch(branchResult.branch);
      continue;
    }

    consecutiveEmptyDiffs = 0;
    if (diff === lastReviewedDiff) {
      consecutiveUnchangedDiffs += 1;
      if (consecutiveUnchangedDiffs >= MAX_CONSECUTIVE_NO_PROGRESS_ATTEMPTS) {
        throw new Error(
          `Pull request for issue #${issue.id} remained unchanged after ${consecutiveUnchangedDiffs} worker attempts.`,
        );
      }
      await worker.implement({
        branch: branchResult.branch,
        findings: [
          ...blockingFindingMessages(review),
          "The pull request diff is unchanged. Make a substantive code change that addresses the review findings.",
        ],
        defectHistory: defectHistorySummaries(reviewLedger),
        roundContext: roundContextMessage(reviewAttempt, maxReviewAttempts),
        issue,
        pullRequest,
      });
      branchResult.headCommit = await repository.pushBranch(branchResult.branch);
      continue;
    }

    consecutiveUnchangedDiffs = 0;
    lastReviewedDiff = diff;
    reviewAttempt += 1;
    review = await reviewer.evaluatePullRequest({
      pullRequest,
      issue,
      reviewLedger: structuredClone(reviewLedger),
    });
    await github.submitPullRequestReview({ pullRequest, review });
    reviewLedger.push(structuredClone(review));
    if (review.approved) {
      break;
    }
    if (reviewAttempt === maxReviewAttempts) {
      throw new Error(`Pull request for issue #${issue.id} was not approved.`);
    }

    await worker.implement({
      branch: branchResult.branch,
      findings: blockingFindingMessages(review),
      defectHistory: defectHistorySummaries(reviewLedger),
      roundContext: roundContextMessage(reviewAttempt, maxReviewAttempts),
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
  for (const followUp of delivery.review.followUps ?? []) {
    await options.github.createFollowUpIssue({
      sourceIssueId: options.issue.id,
      sourcePullRequest: pullRequest.url,
      ...followUp,
      labels: ["ready-for-agent"],
    });
  }
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
