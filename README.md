# Sand-King

Sand-King is a developer agent system for interactively directing work across
local and SSH-hosted projects and delegating durable coding work to
project-adjacent agent harnesses.

The product is currently being specified through the
[Sand-King MVP Wayfinder map](https://github.com/DylanCope/sandking/issues/1).
This initial planning workspace preserves the known-good Sandcastle harness
used to develop the concept. Its safe bootstrap source is temporarily tracked
under `.sandcastle/`; credentials, databases, logs, and worktrees remain
ignored. That bootstrap workspace is distinct from the independently identified
Host-local Harness registrations used by the Cockpit product path.

Install the harness dependencies:

```bash
npm install
```

Run its checks:

```bash
npm run typecheck
npm test
```

Start the bootstrap Sandcastle harness when the issue tracker has eligible
implementation work:

```bash
npm run sandcastle
```

Scope a run to one parent issue and all of its descendants:

```bash
npm run sandcastle -- --parent 25
```

The scoped run ignores eligible tickets outside that issue tree and stops once
GitHub reports the parent issue closed.

Launch the local Cockpit walking-skeleton slice:

```bash
npm run cockpit -- --no-open --json
```

This starts or reuses one loopback-only Controller runtime, prints a short-lived
bootstrap URL for the Cockpit, and negotiates with the local Host over the
framed stdio protocol. The handshake binds the generated runtime ID to a
private Host ID only after compatible negotiation succeeds. Stop the runtime with:

```bash
npm run cockpit:stop
```

The published package exposes the stable `sandking` executable, so an installed
package launches from any working directory without source-checkout-relative
paths:

```bash
sandking launch --no-open --idempotency-key <key> --expected-revision <revision>
sandking stop
```

The runtime stores its lifecycle revision, shared launch/stop lock, independent
Controller-to-Host identity binding, Host identity, bootstrap claims, audit
records, and readiness state in a private user directory (`~/.sandking` by
default). Launch and stop use the same lock and record their idempotency-key
hashes, expected and resulting revisions, outcomes, and audit IDs. Omitting the
flags lets the local CLI generate a one-shot key and use the current lifecycle
revision. The lock wait covers the full startup deadline, and corrupt state for
a still-live runtime fails closed without deleting its ownership record or
starting a competitor. Until readiness is acknowledged, the runtime and Host
remain owned by the launcher and shut down if it is killed. The first durable
Host identity is accepted through an explicit framed, authorized, idempotent,
revisioned Host mutation whose typed outcome carries the Host audit ID; a
readiness ping does not create identity state. The Host inherits no Controller
environment or credentials. Browser control is a versioned typed same-origin
WebSocket protocol. Its HttpOnly cookie is non-persistent, and the runtime
expires the session after at most 15 minutes and revokes its existing
WebSockets. Bootstrap and session-end rejections return typed failures linked
to audit evidence. Explicitly ending a browser session serializes concurrent
retries; opaque stream bytes remain on a separate bounded binary channel.

From the Cockpit, a person can enter one explicit Host-native Project path and
confirm its bounded GitHub-Issues/check configuration. Sand-King never scans
for Projects. The real local Host creates or reuses a generated, path-anchored
Project identity without a separate approval, registers the named conformance
Harness in its own Git-versioned Harness workspace, and pins its exact commit.
The Cockpit shows the Project and Harness identities, pin, checks and
configuration readiness, and whether the Harness can launch. Moved,
replaced, conflicting, missing, and tombstoned paths fail with typed resolution
guidance rather than inheriting an old identity. Registration, Harness links,
pins, idempotency outcomes, and audits remain in Host-private state; neither the
Project nor the Harness workspace receives execution state, and the Project
receives no manifest or `.sandcastle/` projection in this slice.

From any ready Project, Launch is one revision-free, idempotent action through
the Controller runtime and framed Host protocol. The Cockpit exposes a Launch
button with one Yes/No confirmation dialog and a persisted **Don’t show again**
preference; it adds no proposal, approval, revision, or separate start gate.
A focused Controller can invoke the same action with the ordinary executable:
`sandking launch [<project-id>] --issue <issue> --target-branch
sandcastle/issue-<issue>`. Inside that Controller session, the Project ID
defaults to the focused Project. The packaged command advertises this surface
through `sandking launch --help`, so the agent does not need a plugin or
pre-scripted command syntax. In a Controller session, using that help surface
records a sanitized CLI-description operation, allowing real-provider evidence
to prove executable discovery instead of inferring it from terminal prose or a
human checkbox. The runtime never parses terminal prose as a command or
authorization assertion. The real-provider gate also rejects retained plugin
capabilities or any prepare, decision, or separate-start operation/audit in the
same fresh lifecycle. One PTY view may write while secondary
views attach read-only, and browser disconnection does not terminate the
provider PTY.

The Host validates the current Project and pinned Harness at launch time,
durably creates or finds one canonical run, and returns while supervision
continues. It invokes the exact
pinned conformance Harness adapter entry point declared with its protocol in the
committed compatibility envelope. The dedicated framed channel carries adapter
readiness, bounded progress with unique identities and valid published parents,
and exactly one terminal envelope; stdout and stderr remain independently ranged
diagnostic streams. Adapter-channel closure, process exit, or log text never
implies success. The Cockpit observes ordered lifecycle events, explicitly
fetches each log range over the opaque bulk channel, and renders the structured
outcome. Closing or refreshing the browser neither cancels the run nor
terminates its focused Controller session. On refresh, the Cockpit reconnects
to the same runtime and reattaches that existing provider PTY using its retained
output and next input sequence; it does not launch another provider session.
Harness-run observation acknowledges its last sequence and requests only later
retained events. An unavailable or incompatible run cursor returns typed
`resync-required` with the canonical run snapshot, retained
events, log references, and structured outcome instead of claiming gap-free
continuity.

If the Harness process exits without exactly one valid terminal envelope, the
Cockpit shows a failed incomplete result even when a diagnostic says
`SUCCESS`; the structured outcome retains only explicit stdout and stderr range
references. If the real Host process disconnects, the Controller runtime and
its provider sessions remain available while Project and Harness views are
marked stale and their mutations are disabled. The cached accepted run remains
visible, reconnecting with an unavailable Host cursor reports a typed
resynchronization failure, and direct Host mutations fail as
`host_disconnected` with sanitized audit evidence. Planning remains separately
usable when its GitHub projection is fresh; an unavailable GitHub projection
alone is visibly stale and mutation-disabled.

For an explicitly selected Project, the same focused-session Cockpit action can
also operate an installed Claude Code CLI. Without invoking a model, the runtime
probes the destination-local version and authentication and checks the installed
CLI's stable session-ID surface before advertising its negotiated capabilities. It reports a
typed unavailable, incompatible, or unauthenticated state and enables **Open
installed Claude Code** only when the complete minimal surface is ready.
Sand-King launches Claude in its runtime-owned PTY with a stable
controller-assigned CLI session ID and makes the ordinary `sandking` executable
available to the agent. No Sand-King Claude plugin, skill, launch-mediating hook,
plugin inventory, or `--plugin-dir` loading path is involved. A provider-owned,
notification-only `StopFailure` HTTP hook preserves typed provider failures and
never mediates a tool call or Harness launch. Credentials stay
in the destination-local Claude store and are excluded from the adapter command
environment, browser models, prompts supplied by Sand-King, logs, state, audit,
and retained evidence. Conformance remains the deterministic Harness oracle;
Claude uses the same one-action launch and run-observation interfaces.

The Cockpit also projects a thin optional Planning journey. Its Journey Rail
shows the built-in Wayfinding, Speccing, and Ticketing stages from data labelled
`Conformance fixture data — not live GitHub`. Selecting fixture-backed work
opens an independently identified focused conformance Controller session. The
runtime negotiates with the packaged conformance provider adapter, launches its
provider command in a runtime-owned PTY, and requires a typed, process-correlated
`provider.session.ready` envelope on a private runtime-owned control socket before
reporting the session opened. Terminal bytes remain opaque presentation data and
do not determine session state. The runtime gives the Cockpit one exclusive
writable attachment over the opaque WebSocket channel. The deterministic
Controller can inspect the selected canonical work context through that real
interactive boundary. A person may mark an optional stage **Not used** without
blocking ordinary work. That mutation is browser-session-authorized,
revisioned, idempotent, typed, and audited; only a hashed idempotency key is
retained. An unavailable claimed GitHub projection remains visibly stale,
disables its controls in the Cockpit, and is rejected again by the runtime
without queuing a write.

Planning fixture mutation, provider-session metadata, and PTY lifecycle records
stay in the private runtime data directory, outside Projects. This thin spine
does not implement skill-owned reasoning, private Specifications, Ticket-set
publication, complete optional or out-of-order behavior, or downstream **Needs
review**.

Run the executable issue-117 acceptance manifest, including its npm-pinned real
Chromium gate, with:

```bash
npm run acceptance:issue-117
```

The retained sanitized evidence is in
`acceptance/evidence/issue-117.json`. Maintainers can regenerate it after a
successful acceptance run with `npm run acceptance:issue-117:update-evidence`.
The manifest distinguishes GitHub's exact specification-body bytes from the
parent PRD's legacy line-terminated text export, so source provenance does not
depend on an implicit trailing-newline convention.

Run the explicit-Project and conformance-Harness preparation scenario with:

```bash
npm run acceptance:issue-118
```

Its retained sanitized evidence is generated with
`npm run acceptance:issue-118:update-evidence` and stored in
`acceptance/evidence/issue-118.json`.

Run the historical issue-119 acceptance scenario with:

```bash
npm run acceptance:issue-119
```

Its retained sanitized evidence is generated with
`npm run acceptance:issue-119:update-evidence` and stored in
`acceptance/evidence/issue-119.json`.

Run the approved conformance Harness and Cockpit observation scenario with:

```bash
npm run acceptance:issue-120
```

Its retained sanitized evidence is generated with
`npm run acceptance:issue-120:update-evidence` and stored in
`acceptance/evidence/issue-120.json`.

Run the canonical reconnect and ambiguous-outcome lookup scenario with:

```bash
npm run acceptance:issue-121
```

Its retained sanitized evidence is generated with
`npm run acceptance:issue-121:update-evidence` and stored in
`acceptance/evidence/issue-121.json`.

Run the truthful Harness and connection-failure scenario with:

```bash
npm run acceptance:issue-122
```

Its retained sanitized evidence is generated with
`npm run acceptance:issue-122:update-evidence` and stored in
`acceptance/evidence/issue-122.json`.

Run the optional-Planning public-seam scenario with:

```bash
npm run acceptance:issue-123
```

Its retained sanitized evidence is generated with
`npm run acceptance:issue-123:update-evidence` and stored in
`acceptance/evidence/issue-123.json`.

Run the installed-Claude Controller contract and Cockpit scenario without
requiring a real model interaction with:

```bash
npm run acceptance:issue-124
```

Its deterministic retained evidence is generated with
`npm run acceptance:issue-124:update-evidence` and stored in
`acceptance/evidence/issue-124.json`. The final authenticated acceptance child
is intentionally separate and human-driven. On a known per-user development
environment with an installed, authenticated `claude` CLI and an explicit Git
Project, run:

```bash
SANDKING_REAL_CLAUDE_ACCEPTANCE=1 \
SANDKING_REAL_CLAUDE_PROJECT=/absolute/path \
npm run acceptance:issue-124:real
```

The gated runner opens the Cockpit, prints the exact ordinary-CLI launch,
structured-outcome, and browser-detach checklist, then verifies the durable
canonical records. It never copies credentials or treats terminal prose as a
launch operation.
