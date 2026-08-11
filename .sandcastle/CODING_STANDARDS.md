# Coding Standards

Loaded by the reviewer during code review, and referenced by the implementer.
Keep it short — every line costs tokens on every PR.

## Do not grow the acceptance-artifact surface

- **Never add a test that fails when a file changes rather than when behaviour
  changes.** No assertion that a `git diff` is empty, that a file's hash matches
  a recorded value, or that retained JSON was generated from the current commit.
  Such tests produce red builds for documentation edits while staying green
  through real regressions.
- **Do not add per-ticket evidence artifacts, acceptance manifests, or
  acceptance runners.** A ticket is proven by behavioural tests in the ordinary
  suite. If an acceptance criterion cannot be expressed as a test that fails
  when behaviour breaks, say so in the pull request rather than inventing an
  artifact that records the ticket was delivered.

## Keep the product free of test-only code

- Product code in `src/` must be reachable from a real user action — a CLI
  invocation or a Cockpit interaction.
- **Never make product code depend on state that only tests create**: a
  manifest, fixture file, built image, or environment variable written by a test
  runner rather than by `src/`. If a feature needs a precondition, product code
  must establish it. A green test that passes only because the harness staged
  the precondition does not demonstrate a working feature.

## Do not duplicate primitives

- Before writing a helper — hashing, canonical JSON, ID validation, path
  resolution, framed I/O — grep for an existing one and import it. Divergent
  copies of the same primitive have already produced a latent fingerprint bug in
  this repository.

## Keep modules bounded

- Prefer files under ~600 lines. Past ~1,000, a new concern almost certainly
  belongs in its own module rather than appended to the existing one.
- A file that spans several layers at once — schemas, persistence, transport,
  process supervision — should be split along those layers.

## Delete what you supersede

- When a change makes code unreachable, delete it in the same pull request. Do
  not leave superseded versions beside their replacements; Git history preserves
  them.
