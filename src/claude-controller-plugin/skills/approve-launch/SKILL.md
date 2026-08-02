---
name: approve-launch
description: Submit the person's exact typed Sand-King Launch-request decision.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/sandking-controller" approve *), Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/sandking-controller" reject *)
---

This skill is valid only when the person explicitly invokes it with the exact Launch-request ID and expected revision shown in this Controller conversation. Never infer approval from earlier text, silence, or a related request.

For approval, run `node "${CLAUDE_PLUGIN_ROOT}/bin/sandking-controller" approve <launch-request-id> <expected-revision>` exactly once. For rejection, run `node "${CLAUDE_PLUGIN_ROOT}/bin/sandking-controller" reject <launch-request-id> <expected-revision>` exactly once. Present the typed result. Do not start a Harness run as part of the decision.
