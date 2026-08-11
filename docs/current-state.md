# Current state

An honest snapshot of what Sand-King can actually do, what's scaffolded but
not real, and the structural loose ends worth a deliberate decision. Written
2026-08-11, right after slice 3 (issue #169) merged. This is a snapshot, not a
living doc — re-verify anything load-bearing against the code before acting on
it, especially after further slices land.

See `docs/architecture.md` for how the pieces fit together, and `CONTEXT.md`
for term definitions.

## What works today

- **Install and launch lifecycle**: `sandking launch` / `stop` / `cancel` /
  `recover`, idempotent and revisioned, with a shared launch/stop lock and
  fail-closed handling of corrupt state.
- **Cockpit UI**: register a Project by explicit local path (no scanning, no
  git-repo requirement), see readiness, launch with a single confirm, watch a
  live PTY and ordered lifecycle events, reconnect/resync across refreshes.
- **Project & Harness registration**: pins an exact Harness commit into a
  Host-private, integrity-verified workspace. Registration itself works
  against any local directory — doesn't need to be a git repo, doesn't touch
  GitHub. **Caveat**: actually *launching* the production Harness has a
  stricter requirement not covered by registration alone — see loose end #9
  below.
- **Real Harness run execution**: the full protocol — readiness → progress →
  exactly one terminal envelope, process exit/stdout never trusted for
  outcome — is proven end to end, including a real `openai-codex` provider
  running inside Docker (issue #174's proof).
- **Installed Claude Code delegation**: opens your authenticated local
  `claude` CLI in a runtime-owned PTY with the `sandking` executable
  available to it. Credentials stay local.
- **Conformance oracle**: a deterministic, fixture-driven adapter used as
  ground truth for the whole protocol, independent of any real provider.
- **Cross-platform process supervision & PTY streaming**: per-OS process-tree
  teardown, real interactive terminal streamed to the browser over a typed
  WebSocket channel.

## Known functional gaps

### 1. Planning is 100% fixture, not live GitHub
`planning-spine.mjs` is schema-enforced to only ever hold fixture data
(`^github:fixture:issue:[0-9]+$`). This isn't a flag to flip — it's a
from-scratch implementation to connect it to a real GitHub issue graph. This
was already known going into slice 4 planning.

### 2. The production Harness cannot currently be launched by a person at all
Confirmed by reproducing Dylan's exact error (`harness_worker_provider_unavailable`)
on a real registered Project. `sandcastle-v4.mjs`'s readiness check
(`inspectRuntime`, line 263) requires exactly one of two manifest files —
`sandcastle.worker-fixture.json` or `sandcastle.real-provider.json` — to exist
in the Project root before it will run at all. Grepped every write of either
filename across the repo: **the only writers are `test/*.test.mjs` files**,
which `mkdtemp` a throwaway directory, hand-write the manifest as fixture
setup, and drive the adapter directly. No code path in `src/` — not
`production-harness-preparation.mjs`, not `harness-runs.mjs`, not the Cockpit
— ever writes either file into a real Project.

**Practical consequence**: clicking Launch with the production Harness
selected, on any Project, with Docker and Codex auth perfectly configured,
will always fail with `harness_worker_provider_unavailable`. This is not a
local misconfiguration — it reproduces for anyone. Issue #174's real-provider
proof is genuine (it really did drive Codex through the real adapter), but it
achieved this by having its *test script* pre-stage the manifest the shipped
product never creates — technically satisfying "launches through the ordinary
Cockpit/CLI surface" (the launch call is ordinary) while depending on a
precondition no person using the product can produce. Closing this gap is a
prerequisite to everything below — the canary task described next has never
actually been reachable through the Cockpit, only through test harnesses.

Separately, even once that manifest gap is closed, the task the real adapter
performs is a **fixed canary prompt**
(`.sandcastle/real-delegation-prompt.md`: write one file, commit it, stop),
not real work — see below.

The important part: **this isn't a missing capability, it's a disconnected
one.** The full `.sandcastle` toolkit — `main.mts`, `issue-delivery.mjs`,
`run-scope.mjs`, real GitHub-issue discovery, `--parent`/`--issue` direct
instruction, the plan→implement→review loop that built Sand-King itself — is
bundled into the production seed, integrity-verified, and sitting in every
registered Project's Harness workspace. `main.mts` is confirmed genuinely
repo-agnostic (`gh repo view --json nameWithOwner` — nothing hardcoded to
this repo). **No code path in `src/` ever executes it.**

The pinned adapter (`sandcastle-v4.mjs` → `real-worker-v2.mjs`) is a separate,
bespoke script that runs `codex exec` directly with a hand-built prompt. It
never shells out to `main.mts`.

**What closing this gap looks like**: point the adapter's execution step at
`main.mts` (mapping the already-declared `issueNumber`/`targetBranch` launch
parameters to `--issue`/`--parent`) instead of the fixed canary prompt. The
Docker sandbox, credential handling, and skill-pinning work from #174 should
carry over largely unchanged — it's the same container and provider, a
different command run inside it. This looks like the natural next slice if
real delegated work is the near-term goal.

The Cockpit's "production default" label overpromises relative to this —
worth a naming fix regardless of when the gap above closes.

## Structural loose ends (decisions worth making deliberately, not by accident)

None of these are bugs. They're places where either scale, retained-but-dead
code, or missing automation has accumulated without a conscious call being
made — flagging them so the next call is a deliberate one.

1. **`harness-runs.mjs` is one ~2000-line undecomposed factory function**
   (`createHarnessRunManager`, lines 1632–3620) — run creation, cancellation,
   recovery actions, and escalation scheduling all as one closure. The single
   largest concentration of logic in the repo. A decomposition pass here
   would be the highest-leverage readability investment in `src/`.

2. **Dead adapter versions retained for a test's convenience.**
   `sandcastle-v1/v2/v3.mjs` + `real-worker.mjs` (2029 lines total) are
   unreachable from any runtime path, kept only so
   `test/issue-174-package-boundary.test.mjs` can assert-by-path that they
   never ship. The adapter's own `.npmignore` comment concedes Git history
   already covers this — the source-tree retention is a judgment call, not a
   necessity. Worth deciding: delete and let the boundary test check against
   git history instead, or keep as-is.

3. **No CI pipeline at all.** Zero `.github/workflows`. Every guarantee in
   this codebase — typecheck, the full test suite, the native-binary-arch
   check below — currently depends entirely on local `npm test`/`npm run
   typecheck` discipline holding on every change, including the overnight
   autonomous runs. Nothing re-verifies anything automatically.

4. **Linux native process-tree helper has no build automation.**
   `posix-process-tree-helper.c` compiles to prebuilt binaries checked into
   `src/native/{linux-x64,linux-arm64}/`. There's no `postinstall`/`prepare`
   script and no CI to rebuild them. `test/package-command.test.mjs` only
   checks the binaries are present and match the target architecture's ELF
   header — it does not check they're actually built from the current `.c`
   source. If the `.c` file is ever edited, nothing catches a stale committed
   binary; it has to be remembered and done by hand. Combined with (3), this
   is the least-observable risk in the repo.

5. **Three structurally different per-OS process-containment mechanisms**
   (Linux: native C helper; macOS: pure JS + `.cjs` containment file;
   Windows: pure JS + `.cjs` "barrier" file, the largest of the three at 1262
   lines) with no shared interface documented anywhere. Real OS constraints
   plausibly justify the asymmetry, but nothing currently makes the case
   explicit — worth a short note (or an ADR, see below) on why each OS needed
   a different shape, so a future reader doesn't assume it's accidental.

6. **Three non-unified "how do I run a provider" mechanisms** (framed
   Harness-run adapter / framed Controller-session adapter / raw-CLI-probe-
   and-spawn for Claude) — see `docs/architecture.md`. Not a bug, but there's
   no single abstraction; understanding the full provider surface means
   learning three separate mechanisms.

7. **Two different things both informally called "the conformance adapter"**
   — a standalone process (`conformance-provider-adapter.mjs`, Controller
   sessions) and an inline template-string-generated one
   (`project-registration.mjs:662-936`, Harness runs). Same protocol family,
   different code, same name in casual conversation — a real source of the
   confusion in this project's own recent conversations.

8. **`main.mts` and the full `.sandcastle` toolkit are dead weight at
   runtime** — bundled, integrity-verified, never executed. Covered above
   under gap #2; listed again here because it's as much a "why does the repo
   carry all this" question as a "what's missing" one.

9. **The production Harness path writes a persistent, undocumented artifact
   into the Project directory, and triples the same bytes across three
   locations.** `prepareProductionHarness` (`production-harness-preparation.mjs:632`)
   projects the pinned Harness into `<project>/.sandking/harnesses/<harnessId>/`
   on every launch — a real write into the Project, not the Host-private state
   the rest of the system uses. It's kept git-invisible via `.git/info/exclude`
   and verified not to disturb tracked files, but it is **never cleaned up on
   success** (the only removal path is a failed-preparation rollback,
   `production-harness-preparation.mjs:1012`) — it just accumulates in the
   Project directory indefinitely. It also silently requires the Project be a
   git repository at its own root, a requirement registration alone doesn't
   surface. At actual launch, that projection is copied a third time into a
   Host-private per-run execution snapshot
   (`harness-runs.mjs:2844`, `~/.sandking/.../harness-runs/<id>/execution/`),
   which is what the real Worker script actually reads. Three copies of the
   same pinned bytes, one of them leaking into the Project directory
   permanently, is worth a deliberate design pass — either the project-local
   copy should be cleaned up after use, or its persistence and purpose should
   be documented and surfaced to the person using Sand-King rather than
   discovered by `ls -a`.

## Suggested next step

If real delegated work (item #2 above) is the near-term goal, that's a
concretely scoped follow-up ticket, not a redesign — see the "what closing
this gap looks like" note above. The loose ends in the previous section are
independent of that and can be picked up on their own schedule; items 3 and 4
(no CI, unverified native binary) are the ones with the highest
silent-failure risk if left alone.

Repo convention (`docs/agents/domain.md`) points at `docs/adr/` for recorded
architectural decisions. None of the items above are decisions yet — they're
open questions. Once any of them gets a real decision, it likely belongs as
an ADR rather than staying in this snapshot doc.
