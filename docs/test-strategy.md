# Test suite audit: what guards correctness, what is ceremony

An audit of all 102 files / 34,505 lines in `test/` plus the 30 files /
15,321 lines in `acceptance/`, done to answer one question: **what is
required to ensure correctness under future changes, and what is
unnecessary going forward?** Written 2026-08-11 by reading the tests and
running them, not by inspecting names. Companion to
`docs/code-inventory.md` (which audits `src/`).

## Headline: `main` is red right now, because someone edited a Markdown file

```
not ok - retained issue 152 evidence identifies the unchanged complete public seam
not ok - retained issue 164 evidence identifies a current sanitized packaged qualification
not ok - retained issue 174 evidence proves the unchanged packaged real delegation
not ok - retained issue 175 evidence qualifies the unchanged complete acceptance graph
    issue 175 evidence predates changes:
    README.md
```

Cause: commit `00d9368` added a documentation link to `README.md`.
`README.md` is a member of `ISSUE_175_DEMONSTRATED_PATHS`
(`test/issue-175-evidence-source.mjs:3`), so editing it invalidates the
retained evidence of four separate tickets. No product code was touched; no
behaviour changed; four tests went red.

This is the clearest possible demonstration of the problem: **this machinery
detects repository mutation, not behavioural regression.** A suite that goes
red for a docs edit trains everyone to ignore red suites.

## What the acceptance machinery actually is

**The acceptance runners contain no assertions of their own.** Each
`acceptance/issue-N.manifest.json` has a `verification.commands` array that
is a list of `node --test test/<ordinary-file>.test.mjs` invocations — files
that `npm test` already globs. For example,
`acceptance/issue-118.manifest.json:72-75` runs `protocol.test.mjs`,
`project-registration.test.mjs`, `browser-protocol.test.mjs`, and
`project-preparation.browser.test.mjs`, all of which `npm test` runs anyway.

**Every `npm run acceptance:issue-*` is therefore a strict subset of
`npm test`.** Its only unique output is the evidence JSON, and only when
passed `--update-evidence`. Regression coverage added over the ordinary
suite: zero.

The evidence tests themselves split three ways:

1. **Tests of the test helpers.** `test/harness-acceptance-evidence.test.mjs:27-49`
   builds a temporary git repo purely to assert that a capture helper throws
   on a dirty tree. No product code is loaded.
2. **Assertions that a JSON file still says what was typed into it** —
   schema versions, issue numbers, hardcoded content hashes.
3. **Genuine safety properties** — e.g.
   `test/issue-152-acceptance-evidence.test.mjs:32-43` asserts the real-Claude
   runner fails closed without explicit authorization. These prevent
   accidental paid model invocations and are **real value** (~150 lines
   total across the suite).

## The freshness tripwire

`ISSUE_152_DEMONSTRATED_PATHS` (`test/issue-152-evidence-source.mjs:6-14`)
lists: `CONTEXT.md`, `README.md`, `package.json`, `package-lock.json`,
`src`, the manifest, and `test`. **`src` and `test` are whole trees** — so
any change to any file under either invalidates the evidence.

Consequences, all observed rather than theorised:
- Delivering issue #175 forced regeneration of issue-152's and issue-164's
  receipts; both now carry `generatedFromCommit: a88b6ca`, an issue-175
  commit.
- Regeneration requires a clean working tree, network access with `gh`
  auth, and for some tickets Docker plus Codex credentials.
- Four tickets (152, 164, 174, 175) carry this tripwire; the older ten
  assert frozen content without it.

## Would any of it catch a real regression?

| Scenario | What goes red | From the acceptance machinery? |
|---|---|---|
| Break run cancellation in `harness-runs.mjs` | `test/harness-run.test.mjs` | **No** — the manifests merely re-invoke that same ordinary file |
| Delete the Planning spine | `planning-spine.test.mjs` | No — ordinary tests, and they cover fixture-only code |
| Fix the production-adapter gate | issue-174/175 evidence needs regenerating | **Yes — it is coupled to currently-broken behaviour** |
| Edit `README.md` | 4 evidence tests | Yes, spuriously — happening on `main` today |

## Tests that guard code no user can reach

| Target | Test lines |
|---|---|
| Test-only-reachable adapter payload | 1,763 |
| Fixture-only Planning spine (`planning-spine.test.mjs` 349 + `.browser` 522) | 871 |
| Dead v1/v2/v3 adapters (via the package-boundary test) | 43 |

~2,677 lines of tests verify code that is unreachable from the shipped
product.

## Schema migrations for a past that never shipped

`test/harness-run.test.mjs` devotes **~1,015 lines** to durable-state
migration tests across schema v2 → v7 plus a "main-era" case. Sand-King is
version `0.1.0`, unpublished (`npm view sandking` 404s), and its flagship
feature cannot launch. **There is no deployed state at any prior schema
version to migrate from.** These test compatibility with versions that
never existed outside this repository.

## Duplication

Normalised pairwise comparison of the acceptance runners against
`run-issue-119-acceptance.mjs`: issue-118 is **93%** identical, 120 **88%**,
121 **87%**, 123 **79%**, 122 and 124 **72%**. The same ~110-line skeleton
(parse manifest → validate shape → shell out to `verification.commands` →
optionally regenerate evidence) is reimplemented 14 times. The 13
`issue-*-evidence-source.mjs` helpers (808 lines) are 60–90% identical.

## Test infrastructure cost

`package.json`'s `pretest` hook runs `test/ensure-playwright.mjs`, which
launches real Chromium and fails the entire suite if it cannot render.
**There is no way to run only the fast unit tests** — a one-line change to
`protocol.mjs` costs a full browser launch. 12 browser tests total 7,090
lines (24% of the non-acceptance suite). This is the main driver of the
~11-minute suite runtime and of the environmental flakiness repeatedly seen
during autonomous runs (barrier timing races, Host-loss browser tests).
That flakiness is an artifact of the infrastructure choice, not inherent to
what is being tested.

## Verdicts

| Category | Lines | Verdict |
|---|---|---|
| `acceptance/evidence/*.json` | 13,328 | **Retire** — frozen receipts, recoverable from git history |
| Evidence tests under descriptive names (14 files, e.g. `acceptance-evidence.test.mjs` = issue-117, `truthful-failure-acceptance-evidence.test.mjs` = issue-122) | ~3,850 | **Retire** — assert helper behaviour and JSON literals |
| Non-gated acceptance runners (117–124, 146, 149, 152, 164, 175) | 2,121 | **Retire** — provably a subset of `npm test` |
| `acceptance/*.manifest.json` | 1,993 | **Retire** — preserve requirement→test traceability elsewhere first if valued |
| `issue-*-evidence-source.mjs` + `retained-evidence-supersession.mjs` | 907 | **Retire** — dies with the tripwire |
| Other `issue-*` helpers | 484 | **Retire** |
| Issue-numbered evidence tests (152/164/174/175) | 865 | **Replace** — extract the ~150 lines of fail-closed safety tests, drop the rest |
| Legacy schema-migration tests in `harness-run.test.mjs` | ~1,015 | **Retire** — no deployed prior state exists |
| Tests of the unreachable adapter payload | 1,763 | **Conditional** — keep if the manifest gate is fixed (they become coverage for a working feature); retire if the adapter is rewritten |
| Planning tests | 871 | **Retire with the Planning feature**, if that strip-back proceeds |
| Gated real-provider runners (174-real-sandcastle, 146-real-claude, installed-claude) | 1,225 | **Keep, consolidate** — the only executable path to a real provider; heavy duplication between the three |
| Ordinary `test/*.test.mjs` suite | ~21,600 | **Keep** — this is the actual safety net |

**Retirable now: ~24,500 lines**, with a further ~2,600 conditional on the
Planning and adapter decisions. Correctness risk is near zero: none of it
detects a behavioural regression the ordinary suite misses.

## The minimal safety net — keep regardless

- **Protocol contracts**: `protocol.test.mjs` (466), `browser-protocol.test.mjs`
  (716), `harness-adapter-protocol.test.mjs` (302), `host-negotiation.test.mjs` (608).
- **Identity and registration**: `project-registration.test.mjs` (572),
  `production-harness-preparation.test.mjs` (997),
  `production-harness-seed.test.mjs` (559).
- **Lifecycle**: `launch-runtime.test.mjs` (947), `controller-cli.test.mjs` (785).
- **The two features that actually deliver value**: `project-registration.test.mjs`
  above, plus `claude-provider-adapter.test.mjs` (587),
  `claude-controller-session.test.mjs` (535), `claude-controller.browser.test.mjs` (296).
  Both features are genuinely well covered and would go red on a real regression.
- **Safety**: `security-boundary.test.mjs` (428), the three process-tree files
  (1,951), `host-loss-termination-evidence.test.mjs` (39).
- **The fail-closed provider gates** (~150 lines inside files otherwise marked
  for retirement) — extract these before deleting their hosts.
- **The non-migration ~3,880 lines of `harness-run.test.mjs`** — cancellation
  and crash-recovery semantics are hard-won, and this state machine is the
  most likely refactor target.

## Warning: current tests will obstruct the refactor `src/` needs

`test/harness-run.test.mjs:20-23` imports `scheduleCancellationEscalation`
directly — an internal. `test/harness-adapter-identity.test.mjs:20-26`
imports five internal schemas. Decomposing the 3,620-line `harness-runs.mjs`
(the top structural recommendation in `docs/current-state.md`) will break
these mechanically even if behaviour is fully preserved. **Re-point them at
public manager operations before attempting that refactor**, or the refactor
will look far riskier than it is.

Two naming traps worth knowing: `harness-adapter-identity.test.mjs` (836
lines) barely touches the 11-line `harness-adapter-identity.mjs` — it is
really a registration/run-manager integration suite. And
`local-walking-skeleton.browser.test.mjs` (751 lines) is a full end-to-end
suite, not a skeleton.
