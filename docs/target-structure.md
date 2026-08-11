# Target repository structure

Where the codebase should end up after the strip-back and refactor tickets.
Written 2026-08-11, informed by the audits in `docs/code-inventory.md` and
`docs/test-strategy.md`, and by what the remaining roadmap slices actually
require.

The organising principle is deliberately conservative: **follow the grain the
code already has, and only accommodate roadmap needs that are specified.**
Three of the seven remaining slices (9, 10, 11) are stale and unspecified —
structuring for them now would be guessing.

## What the roadmap actually demands of the structure

Seven slices remain (4, 5, 6, 8, 9, 10, 11); none has an approved
Specification. Of those, only three impose real structural requirements:

| Slice | Requirement | Structural consequence |
|---|---|---|
| 4 — Harness lifecycle | Import, validate, switch, retire **multiple** Harness adapters | Adapters must be plural and first-class, not one bundled seed |
| 6 — SSH Host parity | Run everything against a remote host over SSH | The Daemon↔Host link must separate **transport** from **protocol**. Today the Host is spawned locally with stdio pipes, hardcoded |
| 8 — Planning graph | Real GitHub issue graph replacing the fixture spine | Planning must be a self-contained area that can be **deleted and rebuilt**, not extended |

Slices 5, 9, 10, 11 need no structural anticipation beyond what falls out of
the above.

## The structure

Top level is organised by **process**, because that is the strongest real
boundary in the system — three OS processes with wire protocols between them
(see `docs/architecture.md`). Layering appears *inside* each process area,
where the code already half-follows it.

```text
src/
├── common/                   # shared primitives — fixes 3 classes of duplication
│   ├── identifiers.mjs       #   ID schemas/regexes (currently re-declared in 12 files)
│   ├── canonical-json.mjs    #   ONE implementation (currently 5, one divergent)
│   └── digest.mjs            #   sha256 wrapper (currently 8, under 3 names)
│
├── protocol/                 # wire contracts between processes
│   ├── framing.mjs           #   frame read/write, versions, capability negotiation
│   ├── host-messages.mjs     #   Daemon ↔ Host schemas (from protocol.mjs)
│   ├── browser-messages.mjs  #   Browser ↔ Daemon (from browser-protocol.mjs)
│   └── harness-adapter.mjs   #   fd-3 adapter contract
│
├── cli/                      # the `sandking` executable
│
├── daemon/                   # Controller runtime process
│   ├── http/                 #   route table + static assets
│   ├── security.mjs          #   CSP, cookies, origin checks
│   ├── browser-sessions/     #   session registry, lifecycle, expiry
│   ├── websocket-router.mjs
│   ├── host-transport/       #   ← SLICE 6 SEAM
│   │   ├── local.mjs         #     spawn + stdio (today's only implementation)
│   │   └── ssh.mjs           #     future
│   ├── host-mutations.mjs    #   idempotency replay + retention
│   └── controller-sessions/  #   provider registry, session manager
│
├── host/                     # Host process (bin: sandking-host)
│   ├── project-registry/     #   schemas, path resolution, state, projection
│   ├── harness-runs/         #   see decomposition below
│   ├── harness-preparation/  #   seed loading, pinning, projection
│   └── planning/             #   ← SLICE 8: self-contained, disposable
│
├── supervision/              # per-OS process trees + host-loss evidence
│
├── adapters/                 # Harness adapters as real, checked-in files
│   ├── conformance/          #   ← extracted from a template string
│   └── sandcastle/           #   ← today's production adapter
│
└── cockpit/                  # browser UI modules
    ├── dom.mjs, socket.mjs, chrome.mjs, terminal.mjs
    ├── project-preparation.mjs
    ├── harness-run.mjs
    └── planning.mjs          #   ← SLICE 8: one call site, deletes cleanly
```

## Decomposing the two 3,000+ line files

Both are large for the same reason: **each spans several layers at once.**

### `harness-runs.mjs` (3,620 → ~9 modules)

Lines 1–1,631 are module-level and can be split today with near-zero risk;
1,632–3,620 is one closure (`createHarnessRunManager`) that must be broken
first.

| New module | Source lines | ~Size |
|---|---|---|
| `harness-runs/schemas.mjs` | 66–480 | 415 |
| `harness-runs/legacy-schemas.mjs` + `migrations.mjs` | 421–610, 766–979 | 405 |
| `harness-runs/fingerprints.mjs` | 619–730 | 110 |
| `harness-runs/store.mjs` | paths, persist, audit backfill | 315 |
| `harness-runs/adapter-supervision.mjs` | 1,076–1,631 | 555 |
| `harness-runs/reconciliation.mjs` | 1,998–2,185 | 190 |
| `harness-runs/operations/{launch,cancel,recover,queries}.mjs` | 2,699–3,601 | 900 |
| `harness-runs/index.mjs` | thin wiring | small |

**Isolating the legacy schemas and migrations matters beyond tidiness**: it
quarantines the ~405-line phantom v2–v7 migration surface (see
`docs/test-strategy.md` — there is no deployed prior state to migrate) so it
can be deleted as one unit.

### `runtime-daemon.mjs` (3,336 → ~8 modules)

Split by concern, per the tree above. The HTTP layer is currently a flat
`if (method && url === …)` chain (lines 2,900–3,140); extracting a route
table is a mechanical, low-risk first move. The browser-session registry uses
**seven parallel `Map`s** keyed by session — collapsing those into one session
record type should happen as part of the extraction.

### Two other extractions worth calling out

- **`project-registration.mjs:663–936` contains ~250 lines of a different
  program embedded as a template string** — a complete fd-3 adapter with its
  own frame I/O, written to disk and `git init`-ed at runtime. It becomes a
  real file under `adapters/conformance/`, copied into the workspace the way
  `production-harness-seed.mjs` already copies the production seed. This makes
  it lintable, typecheckable and testable, and removes one of the two
  confusingly-named "conformance adapters" flagged in `docs/architecture.md`.
- **`claude-provider-adapter.mjs`** (1,095 lines, three self-contained
  exports) is nearly a three-file split already — the lowest-effort win
  available.

## Sequencing, and why the refactor is safer than it looks

**The splits can land with zero test edits.** Keeping `harness-runs/index.mjs`
and `project-registration/index.mjs` re-exporting the current public surface
makes each split a pure file move. Import re-pointing becomes a separate,
optional follow-up. This defuses the "tests import internals" blocker noted in
`docs/test-strategy.md` — those imports (`scheduleCancellationEscalation` in
`harness-run.test.mjs:21`; five schemas in
`harness-adapter-identity.test.mjs:20–25`) keep resolving through the index.

Two export hatches, `harnessRunInternals` and `projectRegistrationInternals`,
exist solely for tests and are currently imported by nothing — delete them
during the split.

Suggested order:

1. **`common/`** first. It is pure extraction, touches every file lightly, and
   **fixes a latent bug**: `canonicalJson` at `runtime-daemon.mjs:358` omits
   the `undefined` case the other four implementations have, so the same
   logical request can hash to different idempotency fingerprints either side
   of the Daemon↔Host boundary.
2. **Deletions before decomposition** — strip Planning, the dead adapters, and
   the remaining test ceremony. Never refactor code you are about to delete.
3. **`harness-runs/` and `runtime-daemon/`** splits behind index re-exports.
4. **`adapters/`** extraction (conformance out of the template string).
5. **`host-transport/`** seam — only when slice 6 is actually specified.
   Introducing the interface earlier, with one implementation, is
   speculative generality.

## What this structure deliberately does not do

- **No `domain/` or `services/` layer at the top level.** The code's real
  boundary is the three processes; a layer-first tree would cut across that
  and force arbitrary decisions about where Host-owned schemas live.
- **No structure for slices 9, 10, 11.** They are stale, unspecified, and
  still written in vocabulary tied to a deleted approval system. Structuring
  for them would be guessing.
- **No plugin/extension framework for adapters.** Slice 4 needs *import,
  validate, switch, retire* — a registry over real files, not an extension
  API.

## Blocked-by note

Slices 4 and 11 both depend on a real (non-conformance) Harness actually
launching, which it cannot today (`docs/current-state.md` gap #2). Directive
#157 already flagged the real-adapter gap as "the single largest gap between
the README's stated purpose and current reality" — that was written *before*
slice 3 shipped, and the gap survived delivery. Fixing the manifest gate is
the prerequisite for a third of what remains on the roadmap, not just a
nice-to-have.
