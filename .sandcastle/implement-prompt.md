# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue using `gh issue view <ID>`. If it has a parent PRD, pull that in too.

Only work on the issue specified.

Work on branch {{BRANCH}}. Make commits and run tests.

{{ROUND_CONTEXT}}

Planner's own size assessment of this ticket: {{SIZE_WARNING}} If this flags the ticket as spanning several independently reviewable concerns, treat that as a cue to look for shared root causes across those concerns rather than fixing each reported instance in isolation.

# PULL REQUEST REVIEW FINDINGS

{{REVIEW_FINDINGS}}

On a change-request pass, address every finding without weakening the issue requirements or tests. Commit the corrections to the same issue branch; the harness will push the revised head for independent re-review.

# DEFECT HISTORY

This is a short, deduplicated list of every distinct defect summary raised against this ticket across all review rounds so far, including ones already fixed. It is not new work — the current findings above are the only things you need to act on. It exists purely so you can recognize a pattern: if the current findings share a root cause, code shape, or invariant with something in this history, fix the general case now instead of only the newly reported instance.

{{DEFECT_HISTORY}}

A concrete example of the failure mode this is meant to prevent: fixing a process-identity/PID-reuse bug on one platform's code path, then leaving the identical bug in an equivalent code path (a different platform, a different mode, a duplicated branch) for a later review round to separately rediscover. If a finding you're fixing now looks like an instance of a pattern that already appears above, audit sibling code paths for the same defect class before committing, rather than waiting for it to be reported again.

# ACCEPTANCE MATRIX

Before changing code, build a complete acceptance matrix from the ticket and inherited parent requirements. For every applicable requirement record the required public seam, the behavioural test that would fail if the requirement were violated, current status, and any relevant review finding. Keep this matrix in your working context; do not add a tracked planning artifact, and do not add an evidence file, manifest, or runner to represent it.

A requirement is satisfied when a test fails if the behaviour breaks. It is not satisfied by a recorded artifact, a stored hash, or a test that only proves the requirement was once demonstrated. If a criterion genuinely cannot be expressed as a behavioural test, say so explicitly in your issue comment rather than substituting an artifact.

On a change-request pass, re-audit the complete matrix against the current branch, not merely the latest findings. A correction is complete only when the new regression test passes and the rest of the matrix remains satisfied. Explicitly identify any review suggestion that conflicts with the source requirements or belongs to a later slice rather than silently expanding scope.

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION

If applicable, use RGR to complete the task.

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

# LEAVE THE CODEBASE BETTER THAN YOU FOUND IT

Your change is judged on the state it leaves behind, not only on satisfying the ticket. Read `@.sandcastle/CODING_STANDARDS.md` — it is enforced at review, and complying now is far cheaper than a correction round.

In particular:

- Before adding a helper, grep for an existing one and import it instead of writing a second copy.
- If the file you are editing is already over ~1,000 lines, ask whether your addition belongs in a new module rather than appended to it.
- If your change makes existing code unreachable, delete it in the same commit.
- Do not add a file, artifact, or test whose only purpose is to record that this ticket was delivered.
- Product code must not depend on state that only a test creates. If your feature needs a precondition — a manifest, a fixture, a built image, an environment variable — product code must establish it, or the feature does not work outside the test harness.

# FEEDBACK LOOPS

Use `npm run test:unit` for fast iteration; it does not launch a browser. Before your final commit, run the full `npm run typecheck` and `npm test` and confirm you have introduced no new failures. Establish the pre-existing failure set first, so you can distinguish your regressions from the repository's existing state rather than assuming a fully green baseline.

If a test fails only because a file changed — not because behaviour changed — that test is defective and the correct response is to report it, not to service it. Say so in your issue comment and commit message. Do not regenerate an artifact to turn such a test green, and do not add one.

# COMMIT

Make a git commit. The commit message must:

1. Start with `RALPH:` prefix
2. Include task completed + PRD reference
3. Key decisions made
4. Files changed
5. Blockers or notes for next iteration

Keep it concise.

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done.

Do not close the issue - this will be done later.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
