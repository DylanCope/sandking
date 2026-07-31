# TASK

Independently review pull request #{{PR_NUMBER}} for issue #{{TASK_ID}} as a delivery gate into `main`.

This is a separate review process. Inspect the remote PR and its full issue hierarchy; do not rely on an implementer's local worktree or completion claim.

1. Fetch the issue, all parent requirements, and the PR metadata/diff.
2. The isolated review worktree is already on `{{BRANCH}}`. Fetch the remote PR metadata and verify that the current `HEAD` exactly matches the PR head commit.
3. Run typechecking and the full test suite.
4. Trace every applicable acceptance criterion to executable evidence at the named public seam.
5. Reject API-only evidence for a public Cockpit requirement, conformance fakes for real provider/process requirements, fabricated person approvals, weakened tests, secrets, or prohibited side effects.
6. Confirm the PR targets `main` and contains only the issue's scope.

Do not run `git checkout`, `git switch`, `gh pr checkout`, `git reset`, or any command that changes a branch or worktree. Reject the PR if the current `HEAD` does not match its remote head.

Return exactly one verdict:

<review>
{"approved":false,"findings":["Concrete unmet requirement or failing check."]}
</review>

Approve only when the PR is safe to merge and fully satisfies the issue and applicable parent requirements.
