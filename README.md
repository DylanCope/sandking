# Sand-King

Sand-King is a developer agent system for interactively directing work across
local and SSH-hosted projects and delegating durable coding work to
project-adjacent agent harnesses.

The product is currently being specified through the
[Sand-King MVP Wayfinder map](https://github.com/DylanCope/sandking/issues/1).
This initial planning workspace preserves the known-good Sandcastle harness
used to develop the concept. Its safe bootstrap source is temporarily tracked
under `.sandcastle/`; credentials, databases, logs, and worktrees remain
ignored. The MVP design will determine how hosts generate untracked harnesses
for target projects.

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

The Cockpit also projects a thin optional Planning journey. Its Journey Rail
shows the built-in Wayfinding, Speccing, and Ticketing stages from data labelled
`Conformance fixture data — not live GitHub`. Selecting fixture-backed work
opens an independently identified focused conformance Controller session. A
person may mark an optional stage **Not used** without blocking ordinary work.
That mutation is browser-session-authorized, revisioned, idempotent, typed, and
audited; only a hashed idempotency key is retained. An unavailable claimed
GitHub projection remains visibly stale, disables its controls in the Cockpit,
and is rejected again by the runtime without queuing a write.

Planning fixture mutation and session state stays in the private runtime data
directory, outside Projects. This thin spine does not implement skill-owned
reasoning, private Specifications, Ticket-set publication, complete optional or
out-of-order behavior, or downstream **Needs review**.

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

Run the optional-Planning public-seam scenario with:

```bash
npm run acceptance:issue-123
```

Its retained sanitized evidence is generated with
`npm run acceptance:issue-123:update-evidence` and stored in
`acceptance/evidence/issue-123.json`.
