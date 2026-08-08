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

Before changing code, build a complete acceptance matrix from the ticket and inherited parent requirements. For every applicable requirement record the required public seam, executable evidence, current status, and any relevant review finding. Keep this matrix in your working context; do not add a tracked planning artifact unless the issue requests one.

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

# FEEDBACK LOOPS

Before every commit, including your final one, run the full `npm run typecheck` and `npm test` (not a filtered subset) and confirm there are zero failures. Do not commit while any test is failing, including a test that checks retained acceptance-evidence freshness against the current commit. If your change makes any `acceptance/evidence/issue-*.json` file stale, regenerate it with its corresponding `acceptance:issue-<N>:update-evidence` script and commit that update as part of the same change — do not treat evidence refresh as a separate step you might do later.

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
