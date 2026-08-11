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
4. Trace every applicable acceptance criterion to executable evidence at the named public seam. Evidence means a test that fails when the behaviour breaks. A retained artifact, a stored hash, a file-freshness assertion, or a test that only proves the behaviour was once demonstrated is **not** evidence.
5. **Verify each criterion is satisfied through the real product path.** If a criterion is demonstrated only because the test harness staged a precondition that no `src/` code ever creates — a manifest, fixture file, built image, or environment variable — the requirement is **not met**, however green the test is. Ask of each passing acceptance test: could a person reach this by installing the package and using the CLI or Cockpit? If not, block.
6. Reject API-only evidence for a public Cockpit requirement, conformance fakes for real provider/process requirements, fabricated person approvals, weakened tests, secrets, or prohibited side effects.
7. Confirm the PR targets `main` and contains only the issue's scope.
8. Check the change against `@.sandcastle/CODING_STANDARDS.md`.
9. Triage every existing review suggestion as one of: applicable to the current diff; resolved or stale; or out of scope or incorrect. Verify suggestions yourself rather than accepting them blindly.
10. If requesting changes, report all applicable blocking findings you can identify in this pass so the worker can address them together. Do not drip-feed findings across reviews.
11. Apply a materiality threshold. A finding blocks only when it violates an exact applicable requirement, makes a required public seam incorrect, breaks a security/data-integrity/core-lifecycle invariant, fails a required check, introduces harmful scope, or otherwise makes the PR unsafe to merge. Three structural defects also block, because each is cheap to fix now and expensive later: adding a second copy of a primitive that already exists in the repository; adding product code reachable only from a test; and adding a test that fails when a file changes rather than when behaviour changes.
12. Record maintainability improvements, implementation preferences, speculative resilience, and work explicitly assigned to later slices as non-blocking follow-ups. Software can be safe and complete for this issue without implementing every possible improvement. Also record as follow-ups: a file grown materially past ~1,000 lines, and superseded code left beside its replacement.
13. Every blocking finding must state the exact requirement, concrete evidence, material impact, and why it cannot reasonably be deferred. If any of those cannot be supplied, classify it as a follow-up rather than a blocker.
14. Do not request an artifact, evidence file, manifest, or acceptance runner as the remedy for a finding. If a requirement lacks proof, the remedy is a behavioural test.

Do not run `git checkout`, `git switch`, `gh pr checkout`, `git reset`, or any command that changes a branch or worktree. Reject the PR if the current `HEAD` does not match its remote head.

Return exactly one verdict:

<review>
{"approved":false,"blockingFindings":[{"summary":"Concrete unmet requirement or failing check.","requirement":"Exact issue or parent requirement.","evidence":"Observed failure or source location.","materialImpact":"Why merging would be unsafe or incomplete.","cannotDefer":"Why a later issue is insufficient."}],"followUps":[{"title":"Actionable improvement","body":"Context and proposed outcome sufficient for an independent Worker.","sourceFinding":"Evidence observed during this review.","acceptanceCriteria":["Observable criterion that proves the improvement is complete."]}],"resolvedFindings":["Previously reported finding verified as resolved or stale."]}
</review>

Approve when `blockingFindings` is empty, required checks pass, and the PR is safe to merge and satisfies the issue and applicable parent requirements. Follow-ups do not prevent approval.
