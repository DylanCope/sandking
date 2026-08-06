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
const run = {
  harnessRunId: `harness-run-${"3".repeat(24)}`,
  projectId: projectRegistration.projectId,
  controllerSessionId: session.sessionId,
  outcome: {
    outcomeId: `harness-outcome-${"4".repeat(24)}`,
    status: "succeeded",
    code: "conformance_run_succeeded",
  },
};
const launchIdempotencyKeyHash = `sha256:${"6".repeat(64)}`;
const audit = (auditId, action, outcome, details) => ({ auditId, action, outcome, details });
const acceptedAuditChain = [
  audit("audit-session", "controller.session.start", "accepted", {
    sessionId: session.sessionId,
    controllerSessionId: session.sessionId,
    providerSessionId: session.providerSessionId,
    workContextId: projectRegistration.projectId,
    canonicalReference: session.canonicalReference,
  }),
  audit("audit-provider-launch", "controller.provider.operation", "accepted", {
    sessionId: session.sessionId,
    providerSessionId: session.providerSessionId,
    workContextId: projectRegistration.projectId,
    operation: "harness-run.launch",
    idempotencyKeyHash: launchIdempotencyKeyHash,
  }),
  audit("audit-launch", "harness.run.launch", "accepted", {
    controllerSessionId: session.sessionId,
    harnessRunId: run.harnessRunId,
    projectId: projectRegistration.projectId,
    source: "controller-cli",
    idempotencyKeyHash: launchIdempotencyKeyHash,
  }),
  audit("audit-outcome", "harness.run.outcome", "observed", {
    harnessRunId: run.harnessRunId,
    outcomeReference: run.outcome.outcomeId,
    status: run.outcome.status,
    code: run.outcome.code,
  }),
];

test("the real Claude gate selects only the configured Project registration", () => {
  assert.equal(selectInstalledClaudeProjectRegistration({
    issue: 152,
    projectState: { projects: [{ ...projectRegistration }] },
    projectPath: projectRegistration.canonicalPath,
  }).projectId, projectRegistration.projectId);
  assert.throws(() => selectInstalledClaudeProjectRegistration({
    issue: 152,
    projectState: { projects: [] },
    projectPath: projectRegistration.canonicalPath,
  }), /issue_152_real_acceptance_selected_project_not_registered/);
});

test("the real Claude gate selects one correlated ordinary-CLI launch chain", () => {
  const misleading = audit("audit-rejected", "harness.run.launch", "rejected", {
    controllerSessionId: session.sessionId,
  });
  assert.deepEqual(selectInstalledClaudeAcceptanceAuditChain({
    issue: 152,
    audits: [misleading, ...acceptedAuditChain],
    session,
    projectRegistration,
    run,
  }), acceptedAuditChain);
});

test("the real Claude gate rejects a flow without the provider launch operation", () => {
  assert.throws(() => selectInstalledClaudeAcceptanceAuditChain({
    issue: 152,
    audits: acceptedAuditChain.filter((entry) => entry.auditId !== "audit-provider-launch"),
    session,
    projectRegistration,
    run,
  }), /issue_152_real_acceptance_audit_chain_incomplete/);
});

test("the real Claude gate rejects an uncorrelated provider launch operation", () => {
  const uncorrelated = acceptedAuditChain.map((entry) => entry.auditId === "audit-provider-launch"
    ? {
        ...entry,
        details: { ...entry.details, idempotencyKeyHash: `sha256:${"7".repeat(64)}` },
      }
    : entry);
  assert.throws(() => selectInstalledClaudeAcceptanceAuditChain({
    issue: 152,
    audits: uncorrelated,
    session,
    projectRegistration,
    run,
  }), /issue_152_real_acceptance_audit_chain_incomplete/);
});

test("the real Claude gate requires exactly one accepted provider launch operation", () => {
  const secondProviderLaunch = {
    ...acceptedAuditChain[1],
    auditId: "audit-provider-launch-duplicate",
  };
  assert.throws(() => selectInstalledClaudeAcceptanceAuditChain({
    issue: 152,
    audits: [...acceptedAuditChain, secondProviderLaunch],
    session,
    projectRegistration,
    run,
  }), /issue_152_real_acceptance_audit_chain_incomplete/);
});

test("the real Claude gate rejects a run launched by another Controller", () => {
  assert.throws(() => selectInstalledClaudeAcceptanceAuditChain({
    issue: 152,
    audits: acceptedAuditChain,
    session,
    projectRegistration,
    run: { ...run, controllerSessionId: `controller-session-${"9".repeat(24)}` },
  }), /issue_152_real_acceptance_selected_project_not_focused/);
});
