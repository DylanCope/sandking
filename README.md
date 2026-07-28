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
