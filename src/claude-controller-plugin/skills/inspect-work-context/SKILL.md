---
name: inspect-work-context
description: Inspect the sanitized selected Sand-King work context.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/sandking-controller" inspect)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/sandking-controller" inspect` once. Present only the typed, sanitized selected work context returned by the command. Do not inspect arbitrary paths or infer canonical state from terminal output.
