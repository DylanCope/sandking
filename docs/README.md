# Docs

Human-facing project documentation. For agent-consumed skill docs, see
`docs/agents/` (referenced from `AGENTS.md`) — different audience, don't
conflate the two.

- **[`../CONTEXT.md`](../CONTEXT.md)** — canonical vocabulary (Controller,
  Cockpit, Host, Project, Harness, Worker, etc.). Start here for terms.
- **[`architecture.md`](architecture.md)** — process topology, wire
  protocols, launch-flow sequence diagram, the adapter/provider landscape,
  cross-platform process supervision.
- **[`current-state.md`](current-state.md)** — what works today, known
  functional gaps, and structural loose ends worth a deliberate decision.
  Snapshot dated 2026-08-11 (end of slice 3); re-verify before relying on it.
- **[`code-inventory.md`](code-inventory.md)** — line-by-line classification
  of `src/` into real/working, dead, test-scaffolding-in-`src/`, and
  speculative/future, with a button-by-button Cockpit UI audit. The
  quantitative backing for the other two docs.

All three docs are grounded in direct code inspection with file:line
citations, not aspiration — they were written specifically to reconcile the
docs with what the code actually does after a long autonomous build cycle.
Treat them as snapshots that will drift, not living specs.
