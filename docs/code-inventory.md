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
| Real & working (genuinely reachable and load-bearing today) | ~27,200 | ~87% |
| Dead code (unreachable from anything, including tests) | ~2,029 | ~6.5% |
| Test scaffolding living in `src/` instead of `test/` | ~1,072 | ~3.5% |
| Speculative/future (built for a capability that doesn't work end-to-end) | ~1,109 | ~3.5% |

**Read this with a caveat, not as pure reassurance.** A large share of the
"real & working" bucket (~19,300 lines: registration, preparation, the
daemon↔Host protocol, the run state machine, process supervision) is real in
the sense that it correctly implements its own contract and genuinely
executes on every launch — but for the production Harness specifically, all
of it currently builds up to one ~1,072-line dead end (see below). Raw line
count says "mostly real"; capability delivery says "the flagship feature
cannot complete," and comparatively few lines are the reason why.

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

## Cockpit UI: button-by-button reality check

Full trace of every interactive control in `cockpit.js` against its actual
backend handler in `runtime-daemon.mjs`, verified for real (not assumed
working because the button exists):

| Control | Claimed function | Actual status |
|---|---|---|
| Open and prepare Project | Register a Project by path | **Working** |
| Launch (conformance Harness selected) | Launch the pinned Harness | **Working** |
| Launch (production Harness selected) | Launch the pinned Harness | **Always fails** — `harness_worker_provider_unavailable`, see above |
| Open focused Controller for Launch | Open a conformance Controller session | **Working** |
| Open installed Claude Controller | Open local `claude` CLI in a PTY | **Working**, correctly disabled when `claude` isn't installed/authenticated |
| Cancel / reconnect / recovery actions | Harness-run lifecycle management | **Working**, correctly gated on real run state |
| Planning: open focused session / mark stage "Not used" | Planning journey actions | **Working**, but against fixture data (known gap) |
| "Provider CLI escape hatch" | Unclear from the label | **Cosmetic only** — click sets a static status string, no request, no state change (~10 lines) |
| Navigation/drawer toggles, mobile terminal keys | Pure client-side UI | Working as intended, no backend involved by design |

**Conclusion**: not a UI full of unwired stubs. One real, high-consequence
broken chain (production Launch — fully wired, fails downstream) plus one
trivial cosmetic non-button. Remediation effort belongs entirely on the
adapter-gate fix, not a UI-wide rewiring pass.

## What this means for next steps

Closing the `sandcastle.worker-fixture.json`/`sandcastle.real-provider.json`
gap — having `prepareProductionHarness` (or an equivalent product code path)
decide and write this manifest itself instead of leaving it to test setup —
is the single highest-leverage fix available: it's small (the gate itself is
one function), and it's what everything else in the "real & working" bucket
has been waiting on. It's also the natural point to fold in the earlier-found
gap (wiring `main.mts` instead of the fixed canary prompt), since both
require touching the same code path. See `docs/current-state.md` gap #2.
