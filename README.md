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
configuration readiness, and whether a Launch request can be prepared. Moved,
replaced, conflicting, missing, and tombstoned paths fail with typed resolution
guidance rather than inheriting an old identity. Registration, Harness links,
pins, idempotency outcomes, and audits remain in Host-private state; neither the
Project nor the Harness workspace receives execution state, and the Project
receives no manifest or `.sandcastle/` projection in this slice.

From a ready Project, the Cockpit can navigate to one focused conformance
Controller session but cannot submit a Launch approval assertion. Inside that
runtime-owned PTY, `inspect` reads the selected Project work context and
`prepare <issue> sandcastle/issue-<issue>` invokes the exact pinned Harness
adapter through its capability-negotiated subprocess boundary. Preparation
accepts only the bounded secret-free conformance parameters, starts no delegated
work, and presents a sanitized preview with the immutable Launch-request ID and
revision, Host, Project revision, Harness pin, supplied capabilities,
authorization class, expiry, and captured preconditions.

The person decides by entering the exact `approve <request-id> <revision>` or
`reject <request-id> <revision>` assertion in that owning Controller
conversation. The provider sends the same typed framed Host operation required
of other provider adapters; terminal output is never parsed as authorization.
Silence, unrelated input, a Cockpit POST, a different Controller session, or a
stale/materially changed request fails closed. Identical decision retries return
the original durable result, changed idempotency content conflicts, and rejected
or expired requests are terminal. Approval records `not_started` execution
linkage and does not itself create a Harness run. One PTY view may
write while secondary views attach read-only, and browser disconnection does
not terminate the provider PTY.

After approval, `start <request-id> <revision>` sends a separate typed,
revisioned, idempotent Harness-run mutation through the provider, Controller
runtime, and framed Host protocol. The Host durably creates or finds one
canonical run and returns while supervision continues. It invokes the exact
pinned conformance Harness adapter entry point declared with its protocol in the
committed compatibility envelope. The dedicated framed channel carries adapter
readiness, bounded progress with unique identities and valid published parents,
and exactly one terminal envelope; stdout and stderr remain independently ranged
diagnostic streams. Observed expiry or material drift permanently invalidates
the original approval. Adapter-channel closure, process exit, or log text never
implies success. The Cockpit
observes ordered lifecycle events, explicitly fetches each log range over the
opaque bulk channel, and renders the structured outcome. Closing or refreshing
the browser neither cancels the run nor terminates its focused Controller
session.

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
probes the destination-local version and authentication, checks the installed
CLI's session-ID and plugin-loading surfaces, and strictly validates, loads, and
exactly enumerates the bundled plugin before advertising its negotiated
capabilities. It reports a
typed unavailable, incompatible, or unauthenticated state and enables **Open
installed Claude Code** only when the complete minimal surface is ready.
Sand-King launches Claude in its runtime-owned PTY with a stable
controller-assigned CLI session ID. The bundled plugin is loaded for that
session with `--plugin-dir`; it has no user-installed plugin record and is
truthfully paired with a runtime-private typed CLI shim. The plugin exposes only
sanitized work-context inspection, immutable Launch preparation, the exact
approve or reject decision, and a separate approved-run start over the private
typed Controller channel. User-scoped plugin installation and update lifecycle
remain part of the later complete Claude integration slice. Credentials stay
in the destination-local Claude store and are excluded from the adapter command
environment, browser models, prompts supplied by Sand-King, logs, state, audit,
and retained evidence. Conformance remains the deterministic Harness oracle;
Claude uses the same work-context, preview, approval, run, and observation
interfaces.

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

Run the immutable Launch-request preparation and focused-Controller approval
scenario with:

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

The gated runner opens the Cockpit, prints the exact in-conversation inspection,
preparation, approval, separate start, structured-outcome, and browser-detach
checklist, then verifies the durable canonical records. It never copies
credentials or treats automation as evidence that a person approved a request.
