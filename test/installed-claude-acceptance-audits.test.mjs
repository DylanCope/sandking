import assert from "node:assert/strict";
import test from "node:test";
import {
  selectInstalledClaudeAcceptanceAuditChain,
  selectInstalledClaudeProjectRegistration,
} from "./installed-claude-acceptance-audits.mjs";

const projectRegistration = {
  projectId: `project-${"5".repeat(24)}`,
  canonicalPath: "/projects/selected",
  status: "active",
};
const session = {
  sessionId: `controller-session-${"1".repeat(24)}`,
  providerSessionId: "550e8400-e29b-41d4-a716-446655440000",
  workContextId: projectRegistration.projectId,
  workContextKind: "project",
  canonicalReference: `sandking:project:${projectRegistration.projectId}`,
};
const launchRequest = {
  launchRequestId: `launch-request-${"2".repeat(24)}`,
  project: { projectId: projectRegistration.projectId },
};
const run = {
  harnessRunId: `harness-run-${"3".repeat(24)}`,
  projectId: projectRegistration.projectId,
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
const acceptedAuditChain = [
  audit("audit-session", "controller.session.start", "accepted", {
    sessionId: session.sessionId,
    controllerSessionId: session.sessionId,
    providerSessionId: session.providerSessionId,
    workContextId: projectRegistration.projectId,
    canonicalReference: `sandking:project:${projectRegistration.projectId}`,
  }),
  audit("audit-session-context", "controller.provider.operation", "accepted", {
    sessionId: session.sessionId,
    providerSessionId: session.providerSessionId,
    workContextId: projectRegistration.projectId,
    operation: "work-context.inspect",
  }),
  audit("audit-inspect", "controller.provider.operation", "accepted", {
    sessionId: session.sessionId,
    providerSessionId: session.providerSessionId,
    workContextId: projectRegistration.projectId,
    operation: "work-context.inspect",
  }),
  audit("audit-prepare", "launch.request.prepare", "accepted", {
    controllerSessionId: session.sessionId,
    launchRequestId: launchRequest.launchRequestId,
    projectId: projectRegistration.projectId,
  }),
  audit("audit-decision", "launch.request.decision", "accepted", {
    controllerSessionId: session.sessionId,
    launchRequestId: launchRequest.launchRequestId,
    projectId: projectRegistration.projectId,
    decision: "approved",
  }),
  audit("audit-start", "harness.run.start", "accepted", {
    controllerSessionId: session.sessionId,
    launchRequestId: launchRequest.launchRequestId,
    harnessRunId: run.harnessRunId,
    projectId: projectRegistration.projectId,
  }),
  audit("audit-outcome", "harness.run.outcome", "observed", {
    launchRequestId: launchRequest.launchRequestId,
    harnessRunId: run.harnessRunId,
    outcomeReference: run.outcome.outcomeId,
    status: run.outcome.status,
    code: run.outcome.code,
  }),
];

test("the real Claude gate selects only the configured Project registration", () => {
  const selected = {
    projectId: `project-${"5".repeat(24)}`,
    canonicalPath: "/projects/selected",
    status: "active",
  };
  const projectState = {
    projects: [
      {
        projectId: `project-${"6".repeat(24)}`,
        canonicalPath: "/projects/other",
        status: "active",
      },
      selected,
    ],
  };

  assert.equal(selectInstalledClaudeProjectRegistration({
    projectState,
    projectPath: selected.canonicalPath,
  }), selected);
  assert.throws(() => selectInstalledClaudeProjectRegistration({
    projectState,
    projectPath: "/projects/not-opened",
  }), /issue_124_real_acceptance_selected_project_not_registered/);
});

test("the real Claude gate selects one fully correlated accepted audit chain", () => {
  const misleading = audit("audit-rejected", "launch.request.decision", "rejected", {
    controllerSessionId: session.sessionId,
    launchRequestId: launchRequest.launchRequestId,
    decision: "approved",
  });
  assert.deepEqual(selectInstalledClaudeAcceptanceAuditChain({
    audits: [misleading, ...acceptedAuditChain],
    session,
    projectRegistration,
    launchRequest,
    run,
  }), acceptedAuditChain);
});

test("the real Claude gate rejects a complete flow without explicit work-context inspection", () => {
  assert.throws(() => selectInstalledClaudeAcceptanceAuditChain({
    audits: acceptedAuditChain.filter((entry) => entry.auditId !== "audit-inspect"),
    session,
    projectRegistration,
    launchRequest,
    run,
  }), /issue_124_real_acceptance_audit_chain_incomplete/);
});

test("the real Claude gate rejects a session focused on another Project", () => {
  assert.throws(() => selectInstalledClaudeAcceptanceAuditChain({
    audits: acceptedAuditChain,
    session: {
      ...session,
      workContextId: `project-${"6".repeat(24)}`,
      canonicalReference: `sandking:project:project-${"6".repeat(24)}`,
    },
    projectRegistration,
    launchRequest,
    run,
  }), /issue_124_real_acceptance_selected_project_not_focused/);
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
    projectRegistration,
    launchRequest,
    run,
  }), /issue_124_real_acceptance_audit_chain_incomplete/);
});
