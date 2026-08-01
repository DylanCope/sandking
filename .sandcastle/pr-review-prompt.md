# TASK

Independently review pull request #{{PR_NUMBER}} for issue #{{TASK_ID}} as a delivery gate into `main`.

This is a separate review process. Inspect the remote PR and its full issue hierarchy; do not rely on an implementer's local worktree or completion claim.

## PRIOR REVIEW LEDGER

{{REVIEW_LEDGER}}

Treat this ledger as history, not truth. Reproduce each prior blocker against the current head and classify it in this verdict as still blocking, resolved/stale, or incorrect. Reassess prior follow-ups too: carry every still-applicable follow-up into the current `followUps`, or name it in `resolvedFindings` when it is resolved, stale, incorrect, or no longer actionable. Do not present a previously reported concern as newly discovered.

1. Fetch the issue, all parent requirements, and the PR metadata/diff.
   Also inspect the PR conversation, submitted reviews, and inline review comments, including comments from Copilot and other automated reviewers. The inline-comments endpoint is `repos/{owner}/{repo}/pulls/{pull_number}/comments`.
2. The isolated review worktree is already on `{{BRANCH}}`. Fetch the remote PR metadata and verify that the current `HEAD` exactly matches the PR head commit.
3. Run typechecking and the full test suite.
4. Trace every applicable acceptance criterion to executable evidence at the named public seam.
5. Reject API-only evidence for a public Cockpit requirement, conformance fakes for real provider/process requirements, fabricated person approvals, weakened tests, secrets, or prohibited side effects.
6. Confirm the PR targets `main` and contains only the issue's scope.
7. Triage every existing review suggestion as one of: applicable to the current diff; resolved or stale; or out of scope or incorrect. Verify suggestions yourself rather than accepting them blindly.
8. If requesting changes, report all applicable blocking findings you can identify in this pass so the worker can address them together. Do not drip-feed findings across reviews.
9. Apply a materiality threshold. A finding blocks only when it violates an exact applicable requirement, makes a required public seam incorrect, breaks a security/data-integrity/core-lifecycle invariant, fails a required check, introduces harmful scope, or otherwise makes the PR unsafe to merge.
10. Record maintainability improvements, implementation preferences, speculative resilience, and work explicitly assigned to later slices as non-blocking follow-ups. Software can be safe and complete for this issue without implementing every possible improvement.
11. Every blocking finding must state the exact requirement, concrete evidence, material impact, and why it cannot reasonably be deferred. If any of those cannot be supplied, classify it as a follow-up rather than a blocker.

Do not run `git checkout`, `git switch`, `gh pr checkout`, `git reset`, or any command that changes a branch or worktree. Reject the PR if the current `HEAD` does not match its remote head.

Return exactly one verdict:

<review>
{"approved":false,"blockingFindings":[{"summary":"Concrete unmet requirement or failing check.","requirement":"Exact issue or parent requirement.","evidence":"Observed failure or source location.","materialImpact":"Why merging would be unsafe or incomplete.","cannotDefer":"Why a later issue is insufficient."}],"followUps":[{"title":"Actionable improvement","body":"Context, proposed outcome, and acceptance criteria sufficient for an independent Worker.","sourceFinding":"Evidence observed during this review."}],"resolvedFindings":["Previously reported finding verified as resolved or stale."]}
</review>

Approve when `blockingFindings` is empty, required checks pass, and the PR is safe to merge and satisfies the issue and applicable parent requirements. Follow-ups do not prevent approval.
