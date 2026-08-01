# ISSUES

Here are the implementation tickets eligible for this run:

<issues-json>

!`gh api --paginate --slurp 'repos/{owner}/{repo}/issues?state=open&labels=ready-for-agent&per_page=100' | node .sandcastle/list-planner-candidates.mjs`

</issues-json>

The list above has already been filtered using GitHub's native metadata. Every
entry is open, unblocked, ready for an AFK agent, a leaf ticket rather than a
PRD parent, and unrelated to a wayfinder workflow.

# TASK

Return every supplied ticket. Assign each one a branch name using the exact
format `sandcastle/issue-{id}` (no slug or other suffix). This must be
deterministic so that re-planning the same ticket preserves accumulated
progress.

For each ticket, assess whether it combines several independently reviewable boundaries or acceptance clusters. If so, include a concise `sizeWarning` explaining why corrective review may be unusually deep. This warning is advisory: do not omit or split an approved ticket, and omit `sizeWarning` for normally bounded work.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [{"id": "42", "title": "Fix auth bug", "branch": "sandcastle/issue-42", "sizeWarning": "Optional advisory warning for an unusually broad ticket."}]}
</plan>

Always emit the `<plan>` tags, even when there is nothing to do. If there are no issues to work on at all, output `<plan>{"issues": []}</plan>` so the run can exit cleanly.
