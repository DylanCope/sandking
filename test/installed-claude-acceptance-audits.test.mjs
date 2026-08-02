import assert from "node:assert/strict";
import test from "node:test";
import { selectInstalledClaudeAcceptanceAuditChain } from
  "./installed-claude-acceptance-audits.mjs";

const session = {
  sessionId: `controller-session-${"1".repeat(24)}`,
  providerSessionId: "550e8400-e29b-41d4-a716-446655440000",
};
const launchRequest = { launchRequestId: `launch-request-${"2".repeat(24)}` };
const run = {
  harnessRunId: `harness-run-${"3".repeat(24)}`,
  outcome: {
    outcomeId: `harness-outcome-${"4".repeat(24)}`,
    status: "succeeded",
    code: "conformance_completed",
  },
};

const audit = (auditId, action, outcome, details) => ({
  auditId,
  action,
  outcome,
  details,
});

test("the real Claude gate selects one fully correlated accepted audit chain", () => {
  const misleading = audit("audit-rejected", "launch.request.decision", "rejected", {
    controllerSessionId: session.sessionId,
    launchRequestId: launchRequest.launchRequestId,
    decision: "approved",
  });
  const expected = [
    audit("audit-session", "controller.session.start", "accepted", {
      sessionId: session.sessionId,
      controllerSessionId: session.sessionId,
      providerSessionId: session.providerSessionId,
    }),
    audit("audit-prepare", "launch.request.prepare", "accepted", {
      controllerSessionId: session.sessionId,
      launchRequestId: launchRequest.launchRequestId,
    }),
    audit("audit-decision", "launch.request.decision", "accepted", {
      controllerSessionId: session.sessionId,
      launchRequestId: launchRequest.launchRequestId,
      decision: "approved",
    }),
    audit("audit-start", "harness.run.start", "accepted", {
      controllerSessionId: session.sessionId,
      launchRequestId: launchRequest.launchRequestId,
      harnessRunId: run.harnessRunId,
    }),
    audit("audit-outcome", "harness.run.outcome", "observed", {
      launchRequestId: launchRequest.launchRequestId,
      harnessRunId: run.harnessRunId,
      outcomeReference: run.outcome.outcomeId,
      status: run.outcome.status,
      code: run.outcome.code,
    }),
  ];
  assert.deepEqual(selectInstalledClaudeAcceptanceAuditChain({
    audits: [misleading, ...expected],
    session,
    launchRequest,
    run,
  }), expected);
});

test("the real Claude gate rejects a session-start audit without Controller correlation", () => {
  const incomplete = [
    audit("audit-session", "controller.session.start", "accepted", {
      sessionId: session.sessionId,
      providerSessionId: session.providerSessionId,
    }),
  ];
  assert.throws(() => selectInstalledClaudeAcceptanceAuditChain({
    audits: incomplete,
    session,
    launchRequest,
    run,
  }), /issue_124_real_acceptance_audit_chain_incomplete/);
});
