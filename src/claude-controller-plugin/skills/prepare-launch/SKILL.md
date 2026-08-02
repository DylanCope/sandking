---
name: prepare-launch
description: Prepare a bounded Sand-King Launch request for review.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/sandking-controller" prepare *)
---

The arguments must be an issue number followed by its exact `sandcastle/issue-<number>` target branch. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/sandking-controller" prepare <issue-number> <target-branch>` once, then present the returned immutable Launch-request identity, revision, and sanitized preview. Preparation does not approve or start delegated work.
