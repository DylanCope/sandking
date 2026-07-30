# TASK

Review branch `{{BRANCH}}` as an independent acceptance gate. Fetch the issue and every parent requirement from GitHub before judging the implementation. Verify both specification compliance and code quality; do not infer completion merely from commits or passing unit tests.

# CONTEXT

## Branch diff

!`git diff {{TARGET_BRANCH}}...{{BRANCH}}`

## Commits on this branch

!`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

# REVIEW PROCESS

1. **Understand the change**: Read the diff and commits above to understand the intent.

2. **Analyze for improvements**: Look for opportunities to:
   - Reduce unnecessary complexity and nesting
   - Eliminate redundant code and abstractions
   - Improve readability through clear variable and function names
   - Consolidate related logic
   - Remove unnecessary comments that describe obvious code
   - Avoid nested ternary operators - prefer switch statements or if/else chains
   - Choose clarity over brevity - explicit code is often better than overly compact code

3. **Check correctness and specification**:
   - Trace every issue and parent acceptance criterion to executable evidence.
   - Exercise the public acceptance seam named by the issue. API-only tests do not satisfy a public Cockpit requirement, and a conformance fake does not satisfy a requirement for a real provider or process.
   - Treat prototypes as prior art unless the specification explicitly names them as the production boundary.
   - Confirm required person approval is actually interactive rather than fabricated by startup code.
   - Does the implementation match the intent? Are edge cases handled?
   - Are new/changed behaviours covered by tests?
   - Are there unsafe casts, `any` types, or unchecked assumptions?
   - Does the change introduce injection vulnerabilities, credential leaks, or other security issues?

4. **Maintain balance**: Avoid over-simplification that could:
   - Reduce code clarity or maintainability
   - Create overly clever solutions that are hard to understand
   - Combine too many concerns into single functions or components
   - Remove helpful abstractions that improve code organization
   - Make the code harder to debug or extend

5. **Apply project standards**: Follow the coding standards defined in @.sandcastle/CODING_STANDARDS.md

6. **Preserve functionality while reviewing**: You may improve clarity, but do not conceal a specification gap by changing requirements or weakening tests.

# EXECUTION

If you find improvements to make:

1. Make the changes directly on this branch
2. Run tests and type checking to ensure nothing is broken
3. Commit describing the refinements

If the code is already clean and well-structured, do nothing.

# VERDICT

Approve only when every issue and parent requirement applicable to this increment has evidence at the correct public boundary and all checks pass. Otherwise reject it and list concrete findings.

As your final action, write exactly one JSON object to `.sandcastle/review-verdicts/issue-{{TASK_ID}}.json`:

```json
{"issueId":"{{TASK_ID}}","approved":false,"findings":["Public Cockpit does not exercise the Launch request API."]}
```

The verdict file is an ignored orchestration artifact. Do not commit it. Missing or malformed verdicts fail closed.
