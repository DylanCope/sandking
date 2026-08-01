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
framed stdio protocol. Stop the runtime with:

```bash
npm run cockpit:stop
```

The published package exposes the stable `sandking` executable, so an installed
package launches from any working directory without source-checkout-relative
paths:

```bash
sandking launch --no-open
sandking stop
```

The runtime stores its lock, bootstrap claims, audit records, and readiness
state in a private user directory (`~/.sandking` by default). The Host inherits
no Controller environment or credentials. Browser control is a versioned typed
same-origin WebSocket protocol; opaque stream bytes use a separate bounded
binary channel.

Run the executable issue-117 acceptance manifest, including its npm-pinned real
Chromium gate, with:

```bash
npm run acceptance:issue-117
```

The retained sanitized evidence is in
`acceptance/evidence/issue-117.json`. Maintainers can regenerate it after a
successful acceptance run with `npm run acceptance:issue-117:update-evidence`.
