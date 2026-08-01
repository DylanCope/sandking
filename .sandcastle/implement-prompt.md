# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue using `gh issue view <ID>`. If it has a parent PRD, pull that in too.

Only work on the issue specified.

Work on branch {{BRANCH}}. Make commits and run tests.

# PULL REQUEST REVIEW FINDINGS

{{REVIEW_FINDINGS}}

On a change-request pass, address every finding without weakening the issue requirements or tests. Commit the corrections to the same issue branch; the harness will push the revised head for independent re-review.

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

Before committing, run `npm run typecheck` and `npm run test` to ensure the tests pass.

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
