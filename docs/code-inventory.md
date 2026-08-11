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

## Headline numbers

| Bucket | Lines (approx) | Share |
|---|---|---|
| Reachable and correctly implemented | ~27,200 | ~87% |
| Dead code (unreachable from anything, including tests) | ~2,029 | ~6.5% |
| Test scaffolding living in `src/` instead of `test/` | ~1,072 | ~3.5% |
| Speculative/future (built for a capability that doesn't work end-to-end) | ~1,109 | ~3.5% |

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

## Dead code (unchanged from `docs/architecture.md`)

`sandcastle-v1.mjs` (531) / `v2.mjs` (650) / `v3.mjs` (653) / `real-worker.mjs`
(195) — 2029 lines total, unreachable from any runtime path including tests,
retained solely so `test/issue-174-package-boundary.test.mjs` can assert they
never ship.

## Speculative/future

`planning-spine.mjs` (817) + the Planning section of `cockpit.js`
(`renderPlanning`, ~292 lines) — 1,109 lines total. Schema-enforced
fixture-only (`^github:fixture:issue:[0-9]+$`); no live-GitHub code path
exists to "turn on." The only large speculative block found anywhere in
`src/` — nothing else in the audited scope fell into this bucket.

## Cockpit UI: does each control achieve anything useful?

**The bar matters.** An earlier version of this audit asked "is there a
working backend handler behind this click," and concluded the UI was largely
fine. That is the wrong question. A button that opens a real PTY session
against fabricated fixture issues has a working handler and achieves nothing.
Re-scored below on the correct bar: *does clicking this produce a useful
outcome for a person using Sand-King today?*

| Control | Wired to a handler? | Achieves something useful? |
|---|---|---|
| Open and prepare Project | Yes | **Yes** — real registration |
| Open installed Claude Controller | Yes | **Yes** — opens your real, authenticated `claude` CLI |
| Launch (conformance Harness) | Yes | **Marginal** — produces a real run of a deterministic test oracle; proves plumbing, delivers no work |
| Open focused Controller for Launch | Yes | **Marginal** — real PTY, but conformance-backed |
| Launch (production Harness) | Yes | **No** — always fails, `harness_worker_provider_unavailable` |
| Planning: "Open focused session" ×5, "Mark Not used" ×5 | Yes | **No** — operates on fabricated fixture issues; nothing reaches real GitHub |
| Cancel / reconnect / recovery actions | Yes | **Unreachable** — require a live run, which production can't produce |
| All 8 nav destinations (see below) | N/A — anchors | **No** |
| "Provider CLI escape hatch" | No | **No** — sets a static status string, nothing else |

### The navigation is IA for a product that doesn't exist yet

Every nav item is an `<a href="#anchor">` scroll link (`workbenchLink`,
`cockpit.js:1753`). There are no separate pages or views — the entire Cockpit
is one page, and the sidebar simulates a multi-destination product on top of
it:

| Nav item | Anchor | What's actually at that anchor |
|---|---|---|
| Home | `#workbench-main` | top of the page |
| Projects | `#project-preparation` | the registration form (real) |
| **Harnesses** | `#harness-run-observation` | **identical target to "Runs"** |
| **Hosts** | `#connection-status` | a single `<p>` status line, already visible in the header |
| Controller | `#project-focused-controller-session` | |
| Planning | `#planning-spine` | fixture-only journey |
| **Runs** | `#harness-run-observation` | **duplicate of "Harnesses"**; permanently reads "No Harness run has launched" |
| Project | `#project-readiness` | a sub-part of the section already on screen |
| "No focused work context" | `#project-focused-controller-session` | **duplicate of "Controller"** |

Eight destinations, five unique anchors, two exact duplicate pairs, one
pointing at a one-line status string. "Harnesses" and "Hosts" as top-level
product destinations imply managing fleets of harnesses and hosts — neither
concept has a management surface anywhere in the product.

**Corrected conclusion**: of the Cockpit's interactive surface, two controls
deliver real value (register a Project, open installed Claude Code), two are
marginal (conformance-backed), and everything else — the entire navigation,
the whole Planning rail, production Launch, and the escape hatch — achieves
nothing useful today. The earlier "not a UI full of stubs" conclusion was
wrong on the substance, not just the framing.

## Repo-wide scale: the product is a minority of the code

| Tree | Lines | Files | Note |
|---|---|---|---|
| `src/` (the product) | 29,593 | ~45 | 36% of the repo |
| `test/` | 34,505 | 102 | **larger than the product itself** |
| `acceptance/` | 15,321 | 30 | of which 13,328 lines are retained evidence JSON (16 files) |
| `.sandcastle/` (build tooling) | 3,770 | — | separate; builds Sand-King, isn't part of it |
| **Total** | **~83,200** | | |

Test + acceptance is **1.68×** the size of the product it verifies. More
pointedly, ~20,700 lines are *per-ticket* artifacts rather than durable tests
of product behaviour: 42 issue-numbered files in `test/` (5,398 lines),
13,328 lines of retained evidence JSON, and 1,993 lines of acceptance
manifests. These exist to prove specific tickets were delivered to their
acceptance criteria, and they accumulate permanently — every future ticket
adds more. That is the structural cost of the `.sandcastle` methodology's
"retained sanitized evidence" requirement, and it is worth deciding
deliberately whether that cost keeps being paid at this rate.

## Recorded direction: strip back what doesn't connect to a real feature

Noted 2026-08-11 as the product owner's stated intent, not yet acted on: code
that doesn't connect to an existing, working feature should be removed rather
than carried. On current evidence that points at least at the Planning rail
and spine (~1,109 lines), the multi-destination navigation (which simulates
product areas — Harnesses, Hosts — that have no management surface), the
cosmetic escape hatch, and the dead adapter versions (~2,029 lines). The
argument for removal is not just line count: carrying these makes the product
look substantially more finished than it is, which is precisely how the
production-Harness gap went unnoticed until someone clicked Launch.

## What this means for next steps

Closing the `sandcastle.worker-fixture.json`/`sandcastle.real-provider.json`
gap — having `prepareProductionHarness` (or an equivalent product code path)
decide and write this manifest itself instead of leaving it to test setup —
is the single highest-leverage fix available: it's small (the gate itself is
one function), and it's what everything else in the "real & working" bucket
has been waiting on. It's also the natural point to fold in the earlier-found
gap (wiring `main.mts` instead of the fixed canary prompt), since both
require touching the same code path. See `docs/current-state.md` gap #2.
