# Current state

An honest snapshot of what Sand-King can actually do, what's scaffolded but
not real, and the structural loose ends worth a deliberate decision. Written
2026-08-11, right after slice 3 (issue #169) merged; gap #1 and structural
loose end #1 updated 2026-08-15 after parent issue #207 closed. This is a
snapshot, not a living doc — re-verify anything load-bearing against the code
before acting on it, especially after further slices land.

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

### 1. Planning — resolved by removal, not by connecting to GitHub
**Update (post-#207):** this gap no longer exists in the form described here.
`planning-spine.mjs` and the fixture-only Planning journey it powered were
removed outright (commit `bce19ce`, "remove fixture Planning journey (PRD
#207)"), rather than connected to a real GitHub issue graph. There is no
Planning destination in the Cockpit nav and no `planning-spine` reference
left anywhere in `src/`. If real GitHub-backed planning is wanted, it is now
a from-scratch feature addition against a clean slate, not a matter of
"turning on" dormant fixture code.

### 2. Production reachability is fixed; real work is still a fixed canary

**Update (#256):** the manifest reachability half of this gap is closed.
The shared Host launch operation used by both the Cockpit and `sandking launch`
now runs the production adapter's exact Codex/npm and Docker-engine readiness
probes before adapter preflight. If the fixed sandbox image is absent, shipped
Host preparation builds it from the verified production Harness projection
and then re-runs the adapter's exact image probe. When readiness passes, it
publishes the exact `sandcastle.real-provider.json` selector expected by
`inspectRuntime()` with a no-clobber filesystem operation and adds a local
`.git/info/exclude` rule. The operation verifies `git status` and `git ls-files`
are unchanged. A selector created concurrently wins with a typed Project
collision instead of being replaced. When any probe fails, launch returns the typed
`harness_worker_provider_unavailable` failure before a run or adapter process
exists and without writing the manifest. The selector exists only until the
adapter publishes readiness after inspecting it; the Host then removes the
selector and any exclude rule it added. Pre-acceptance failures and terminal
supervision provide rollback boundaries, a later launch removes an exact
untracked stale selector before probing, and Host-private preparation ownership
is durably journaled before the Project mutation. Host startup therefore cleans
the selector even when process loss happened before run acceptance and there is
no retained run. The temporary exclude block has a unique ownership marker, so cleanup
preserves concurrent edits to `.git/info/exclude`. Both exclude append and cleanup rebase
when the exact file generation changes before commit and publish without clobbering a
new public path. If a writer creates that path after the old exclude generation has
already been captured, recovery keeps both generations durable, restores missing older
rules ahead of the newest public generation, and replays that newest ordering so a
concurrent ignore or unignore decision keeps its Git precedence. Only then does it
remove the capture and temporary candidate. Recovery preserves each generation as an
ordered sequence, including duplicate rules, and uses a generation-checked atomic
publication. Same-inode edits made after its final read therefore rebase too. The
publication boundary re-reads the captured inode after the Host candidate is public;
when an already-open descriptor changed that older inode, the candidate is durably
captured, the changed inode is restored, and the mutation retries from the newer bytes.
Startup restores an interrupted rollback before re-entering production Harness
preparation, so a temporarily absent public exclude path cannot block journal recovery.
Selector cleanup atomically captures the exact candidate under a stable
name derived from the journaled preparation ID before checking its contents, Git
ownership, and recorded filesystem identity. Startup resumes that capture and restores
a Project-owned replacement when Host loss occurred while its public name was absent.
A post-inspection byte revalidation likewise restores a captured selector changed
through an already-open descriptor rather than unlinking the new Project content. The
shared capture primitive retains a private release link across the final unlink, proves
that pre-capture descriptors have closed through the platform ownership boundary, and
then re-reads that retained inode. Writes in the former revalidation-to-unlink window are
therefore restored for selectors and rebased for Git exclusions. Release itself moves
through a restartable private directory, so process loss cannot discard the last name or
mistake a newer public candidate for the captured generation. Descriptor ownership probes
remain bounded, but a zero-holder preparation lease automatically starts another cleanup
attempt until safe release succeeds; restart reconciliation does the same for retained
journals. Finalization also accepts the durable empty-directory phase after the release link
has already been unlinked, so process loss between that unlink and directory removal is
idempotently completed instead of reported as a Project collision.
A failed preparation retains the durably recorded selector identity through cleanup, so
a transient rollback failure is retried without releasing the preparation journal or
leaving a false readiness selector. A concurrent replacement is restored or left at the
public path rather than deleted, even when it contains the same valid selector JSON.
Tracked, unjournaled, or
identity-mismatched manifest files are never deleted and continue to fail as Project
collisions.

The explicit `sandcastle.worker-fixture.json` branch remains available only at
the adapter protocol's deterministic qualification boundary; a production
registration never selects it. The gated real acceptance now starts without a
provider manifest or sandbox image and requires product preparation to create
both before accepting delegated commits through the Cockpit and installed
`sandking launch`. The conformance Harness does not enter this preparation path
and never writes the selector.

What remains is the task the real adapter performs: a **fixed canary prompt**
(`.sandcastle/real-delegation-prompt.md`: write one file, commit it, stop),
not GitHub-issue-driven work — see below.

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

**What closing the remaining gap looks like**: point the adapter's execution step at
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

1. **Resolved (#207).** `harness-runs.mjs`'s single ~2000-line
   `createHarnessRunManager` closure — previously the single largest
   concentration of logic in the repo — has been decomposed into
   `src/harness-runs/` (`store.mjs`, `adapter-supervision.mjs`,
   `run-supervision.mjs`, `cancellation-escalation.mjs`, `fingerprints.mjs`,
   `reconciliation.mjs`, `schemas.mjs`, and `operations/{launch,cancel,recover,queries}.mjs`
   — 3,320 ln across 10 modules). `src/harness-runs.mjs` is now a one-line
   re-export. The equivalent monoliths in `project-registration.mjs`,
   `runtime-daemon.mjs`, and `cockpit.js` were decomposed the same way in the
   same effort — see `docs/architecture.md` and `docs/target-structure.md`.

2. **Resolved (#209, under PRD #207).** The dead adapter versions
   (`sandcastle-v1/v2/v3.mjs` + `real-worker.mjs`, 2,029 lines total) and
   `test/issue-174-package-boundary.test.mjs`, which existed only to assert
   they never ship, were deleted (commit `7f587dc`). The package-boundary
   guarantee now lives in the existing installed-package test instead.

3. **General CI is now split by feedback speed.** Pull requests and pushes to
   `main` run typecheck, unit, and browser jobs independently on the repository's
   pinned Node version. The browser job exercises the bundled Chromium through
   the same launch gate as local tests. Linux cancellation cases affected by
   the open guardian-lifetime defect (#221) remain visible in explicitly
   non-blocking quarantine jobs; the remaining checks are required. The
   separately path-scoped native helper workflow retains its pinned Zig rebuild
   check.

4. **Linux native process-tree helper is a deliberately prebuilt asset.**
   `posix-process-tree-helper.c` compiles to static-musl binaries checked into
   `src/native/{linux-x64,linux-arm64}/`, avoiding a compiler requirement for
   people installing Sand-King. `npm run build:native-helpers` reproduces both
   with pinned Zig 0.13.0, and a path-scoped GitHub Actions workflow runs
   `npm run check:native-helpers` to compare both builds byte-for-byte whenever
   the source, binaries, or recipe changes. This catches stale assets but does
   not establish that a source-level process-supervision behavior is correct.

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
   sessions) and, as of #207, a real checked-in file
   (`src/conformance-harness-adapter/conformance.mjs`, Harness runs — no
   longer an inline template string in `project-registration.mjs`, see
   `docs/target-structure.md`). Same protocol family, different code, same
   name in casual conversation — still a real source of possible confusion,
   even though the code is no longer inline-generated.

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
   (`materializeProductionHarnessExecutionSnapshot`, defined in
   `production-harness-preparation.mjs:330` and invoked from
   `harness-runs/operations/launch.mjs`, `~/.sandking/.../harness-runs/<id>/execution/`),
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
independent of that and can be picked up on their own schedule.

Repo convention (`docs/agents/domain.md`) points at `docs/adr/` for recorded
architectural decisions. None of the items above are decisions yet — they're
open questions. Once any of them gets a real decision, it likely belongs as
an ADR rather than staying in this snapshot doc.
