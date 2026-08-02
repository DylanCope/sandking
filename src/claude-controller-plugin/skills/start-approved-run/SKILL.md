---
name: start-approved-run
description: Start the exact already-approved Sand-King Launch request.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/sandking-controller" start *)
---

This skill is valid only when the person explicitly invokes it for an already-approved Launch request in this Controller conversation. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/sandking-controller" start <launch-request-id> <approved-revision>` exactly once, then present the typed Harness-run reference. Observe canonical progress and outcome in the Cockpit.
