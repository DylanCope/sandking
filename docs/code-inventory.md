# Code inventory: what's real, what's speculative, what's test-only

A line-by-line classification of `src/` (~29,700–31,100 lines depending on
count method), done to answer a direct question: how much of this codebase is
real functionality, how much is speculative future-feature scaffolding, and
how much is test/conformance infrastructure that leaked into production code.
Written 2026-08-11 by tracing real invocation paths (an actual Cockpit click,
a real `sandking` CLI call), not by trusting file names, comments, or "proven
by an acceptance test" claims. See `docs/architecture.md` for structure and
`docs/current-state.md` for the functional-gap narrative — this doc is the
quantitative backing for both.

**Update (2026-08-15, post-#207):** the two buckets below that were fully
resolvable by deletion have been deleted — see "Dead code" and
"Speculative/future" below for what changed and the commits that did it. The
percentage split above has **not** been recomputed against current line
counts (that requires redoing the full invocation-path trace this doc is
built from, not just a line count) — treat the shares as directional and
pre-#207 until a fresh pass is done. What's known to have changed: the Dead
code and Speculative/future buckets are now ~0; the "Reachable and correctly
implemented" and "Test scaffolding in `src/`" buckets were not targeted by
#207 and are presumed roughly stable in content, though every line number
cited below for the four decomposed files has moved (see
`docs/architecture.md`).

## Headline numbers (pre-#207, superseded in two of four rows — see update note above)

| Bucket | Lines (approx) | Share |
|---|---|---|
| Reachable and correctly implemented | ~27,200 | ~87% |
| Dead code (unreachable from anything, including tests) | ~~~2,029~~ **0 — deleted, see below** | ~~6.5%~~ |
| Test scaffolding living in `src/` instead of `test/` | ~1,072 | ~3.5% |
| Speculative/future (built for a capability that doesn't work end-to-end) | ~~~1,109~~ **0 — deleted, see below** | ~~3.5%~~ |

**This table measures the wrong thing, and is kept only to be explicit about
that.** "Reachable and correctly implemented" is not the same as "delivers
user value," and scoring by the former badly overstates how much of this
codebase is doing useful work. Nearly all of that ~87% — registration,
preparation, the daemon↔Host protocol, the run state machine, process
supervision — correctly implements its own contract and genuinely executes,
but currently terminates at a ~1,072-line dead end (below), and the UI it
serves offers a person exactly two useful actions (see the Cockpit section).

Scored on delivered capability rather than reachability, the honest summary
is: **a small amount of the product works, a lot of correct machinery is
waiting on one broken link, and a substantial fraction was built for
features that don't exist.** Use the per-area sections below rather than the
percentages above.

## The single biggest finding: the entire production-adapter payload is test-only

`sandcastle-v4.mjs`'s readiness gate (`inspectRuntime`, line 263) requires a
`sandcastle.worker-fixture.json` or `sandcastle.real-provider.json` manifest
in the Project root. **The only code anywhere that writes either file is
`test/*.test.mjs` fixture setup.** This was first found on the real-provider
path; auditing further found `controlled-worker-fixture.mjs:9` has the
identical unconditional dependency on `sandcastle.worker-fixture.json`, with
no fallback. So both branches behind the gate — real provider and its own
fixture/test-double — are unreachable from the shipped product, not just one
of them.

| File | Lines | Status |
|---|---|---|
| `sandcastle-v4.mjs` lines 1–~260 (protocol framing, arg parsing, the gate itself) | ~260 | **Real** — genuinely executed on every launch attempt, correctly produces `harness_worker_provider_unavailable` |
| `sandcastle-v4.mjs` lines ~260–708 (dispatch logic past the gate) | ~448 | **Test-only** |
| `real-worker-v2.mjs` | 301 | **Test-only** — only reachable past the gate |
| `controlled-worker-fixture.mjs` | 63 | **Test-only** — same gate, no fallback (corrects `docs/architecture.md`, which previously listed this as "Live") |

This pattern was actively hunted for elsewhere across the full `src/` tree
(every manifest-like filename, every `process.env` read, every "exactly one
of X configured" gate) — it does not recur. It's isolated to this one adapter,
but it's a total blocker for the single most consequential capability in the
product.

## Dead code — resolved, deleted by #209 (PRD #207)

**Update (post-#207):** `sandcastle-v1.mjs` (531) / `v2.mjs` (650) / `v3.mjs`
(653) / `real-worker.mjs` (195) — 2,029 lines total — along with their
`.npmignore` entries and `test/issue-174-package-boundary.test.mjs`, were
deleted outright (commit `7f587dc`, "delete dead Sandcastle revisions (PRD
#207)"). The package-boundary guarantee that test used to provide by
asserting these files never ship is now preserved in the existing
installed-package test instead. `src/production-sandcastle-adapter/` now
contains only `sandcastle-v4.mjs`, `real-worker-v2.mjs`, and
`controlled-worker-fixture.mjs`.

## Speculative/future — resolved, removed by #207

**Update (post-#207):** `planning-spine.mjs` (817) and the Planning section
of what was `cockpit.js` (`renderPlanning`, ~292 lines) — 1,109 lines total —
no longer exist. Rather than being connected to live GitHub data, the whole
fixture-only Planning journey was deleted (commit `bce19ce`, "remove fixture
Planning journey (PRD #207)"). There is no `planning-spine` or
`renderPlanning` reference left anywhere in `src/`, and the Cockpit's product
navigation no longer has a Planning destination — see the nav table below,
also updated. This was previously the only large speculative block found
anywhere in `src/`; that bucket is now empty.

## Cockpit UI: does each control achieve anything useful?

**The bar matters.** An earlier version of this audit asked "is there a
working backend handler behind this click," and concluded the UI was largely
fine. That is the wrong question. A button that opens a real PTY session
against fabricated fixture issues has a working handler and achieves nothing.
Re-scored below on the correct bar: *does clicking this produce a useful
outcome for a person using Sand-King today?*

**Update (post-#207):** the Planning row and the 8-destination nav table
below are stale — Planning was deleted entirely (see "Speculative/future"
above) and the nav was cut down alongside it. Both are corrected below.

| Control | Wired to a handler? | Achieves something useful? |
|---|---|---|
| Open and prepare Project | Yes | **Yes** — real registration |
| Open installed Claude Controller | Yes | **Yes** — opens your real, authenticated `claude` CLI |
| Launch (conformance Harness) | Yes | **Marginal** — produces a real run of a deterministic test oracle; proves plumbing, delivers no work |
| Open focused Controller for Launch | Yes | **Marginal** — real PTY, but conformance-backed |
| Launch (production Harness) | Yes | **No** — always fails, `harness_worker_provider_unavailable` |
| Cancel / reconnect / recovery actions | Yes | **Unreachable** — require a live run, which production can't produce |
| Nav destinations (see below) | N/A — anchors | **N/A** — no longer simulates unbuilt product areas, see below |
| "Provider CLI escape hatch" | No | **No** — sets a static status string, nothing else |

~~Planning: "Open focused session" ×5, "Mark Not used" ×5~~ — row removed;
Planning no longer exists in the product.

### The navigation — resolved

**Update (post-#207):** the 8-destination, 5-unique-anchor navigation this
section used to describe is gone. `workbenchLink` now lives in
`src/cockpit/chrome.mjs`, and the product navigation
(`src/cockpit/chrome.mjs:178-187`) has exactly three destinations:

| Nav item | Anchor | What's actually at that anchor |
|---|---|---|
| Projects | `#project-preparation` | the registration form (real) |
| Controller | `#project-focused-controller-session` | focused Controller session view |
| Runs | `#harness-run-observation` | Harness run observation |

The old "Home", "Harnesses" (duplicate of "Runs"), "Hosts" (pointed at a
one-line status string), "Planning", "Project", and "No focused work context"
(duplicate of "Controller") destinations are all gone — this is exactly the
"multi-destination navigation" simplification the "Recorded direction"
section below called for, and it has been acted on.

**Corrected conclusion**: of the Cockpit's interactive surface, two controls
deliver real value (register a Project, open installed Claude Code), two are
marginal (conformance-backed), and production Launch and the escape hatch
still achieve nothing useful today. The navigation and Planning items that
used to pad this list out with non-functional surface are gone rather than
fixed — a smaller, more honest UI than the one this audit originally scored.

## Repo-wide scale: the product is a minority of the code

**Update (2026-08-15, post-#207):** `acceptance/` no longer exists —
retired outright (commit `ddb3367`, "retire per-ticket acceptance ceremony
(PRD #207)"), not just trimmed. `src/` and `test/` totals below are
current re-counts (`wc -l`); the per-ticket-artifact sub-breakdown (issue-
numbered files, retained evidence, manifests) has not been recomputed and is
struck through, since most of what it measured (`acceptance/`) is gone.

| Tree | Lines | Files | Note |
|---|---|---|---|
| `src/` (the product) | 28,471 | 75 | current count, 2026-08-15 |
| `test/` | 27,062 | 64 | current count, 2026-08-15 — both file count and lines dropped substantially post-#207 |
| `acceptance/` | ~~15,321~~ **gone — retired by #207** | ~~30~~ | ~~of which 13,328 lines are retained evidence JSON (16 files)~~ |
| `.sandcastle/` (build tooling) | ~3,499 | — | separate; builds Sand-King, isn't part of it |
| **Total** | **~59,000** (was ~83,200) | | not recomputed for `docs/` and other repo-root files |

~~Test + acceptance is **1.68×** the size of the product it verifies. More
pointedly, ~20,700 lines are *per-ticket* artifacts... That is the structural
cost of the `.sandcastle` methodology's "retained sanitized evidence"
requirement, and it is worth deciding deliberately whether that cost keeps
being paid at this rate.~~ — resolved: the retained-evidence requirement that
drove this cost has itself been retired, per the commit above.

## Recorded direction: strip back what doesn't connect to a real feature

Noted 2026-08-11 as the product owner's stated intent. **Update (post-#207):
largely acted on.** Of the items originally listed here — the Planning rail
and spine (~1,109 lines), the multi-destination navigation (Harnesses/Hosts
destinations with no management surface), the dead adapter versions (~2,029
lines) — all three have been removed (see "Speculative/future", "Dead code",
and the navigation update above). **Not yet acted on**: the cosmetic
"Provider CLI escape hatch" still sets a static status string and does
nothing else. The argument for removal is not just line count: carrying
unconnected code makes the product look more finished than it is, which is
precisely how the production-Harness gap went unnoticed until someone
clicked Launch — that gap itself (see `docs/current-state.md` gap #2) is
still open and was not in scope for #207.

## What this means for next steps

Closing the `sandcastle.worker-fixture.json`/`sandcastle.real-provider.json`
gap — having `prepareProductionHarness` (or an equivalent product code path)
decide and write this manifest itself instead of leaving it to test setup —
is the single highest-leverage fix available: it's small (the gate itself is
one function), and it's what everything else in the "real & working" bucket
has been waiting on. It's also the natural point to fold in the earlier-found
gap (wiring `main.mts` instead of the fixed canary prompt), since both
require touching the same code path. See `docs/current-state.md` gap #2.
