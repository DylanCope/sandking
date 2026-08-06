/** @param {124 | 152} issue @param {string} suffix */
const acceptanceError = (issue, suffix) => `issue_${issue}_real_acceptance_${suffix}`;

/**
 * @param {{issue: 124 | 152, projectState: {projects?: any[]}, projectPath: string}} input
 */
export const selectInstalledClaudeProjectRegistration = ({ issue, projectState, projectPath }) => {
  const matches = Array.isArray(projectState?.projects)
    ? projectState.projects.filter((project) => project?.status === "active"
      && project.canonicalPath === projectPath)
    : [];
  if (matches.length !== 1) {
    throw new Error(acceptanceError(issue, "selected_project_not_registered"));
  }
  return matches[0];
};

/**
 * Select the correlated one-action launch chain produced by an installed
 * Claude Controller invoking the ordinary sandking CLI.
 * @param {{
 *   issue: 124 | 152,
 *   audits: any[],
 *   session: {sessionId: string, providerSessionId: string, workContextId: string, workContextKind: string, canonicalReference: string},
 *   projectRegistration: {projectId: string},
 *   run: {harnessRunId: string, projectId: string, controllerSessionId: string | null, outcome: {outcomeId: string, status: string, code: string}},
 * }} input
 */
export const selectInstalledClaudeAcceptanceAuditChain = ({
  issue,
  audits,
  session,
  projectRegistration,
  run,
}) => {
  const projectId = projectRegistration?.projectId;
  const canonicalReference = `sandking:project:${projectId}`;
  if (
    !projectId
    || session.workContextId !== projectId
    || session.workContextKind !== "project"
    || session.canonicalReference !== canonicalReference
    || run.projectId !== projectId
    || run.controllerSessionId !== session.sessionId
  ) {
    throw new Error(acceptanceError(issue, "selected_project_not_focused"));
  }
  const sessionStartAudit = audits.find((entry) => entry.action === "controller.session.start"
    && entry.outcome === "accepted"
    && entry.details?.sessionId === session.sessionId
    && entry.details?.controllerSessionId === session.sessionId
    && entry.details?.providerSessionId === session.providerSessionId
    && entry.details?.workContextId === projectId
    && entry.details?.canonicalReference === canonicalReference);
  const providerLaunchAudits = audits.filter((entry) =>
    entry.action === "controller.provider.operation"
    && entry.outcome === "accepted"
    && entry.details?.sessionId === session.sessionId
    && entry.details?.providerSessionId === session.providerSessionId
    && entry.details?.workContextId === projectId
    && entry.details?.operation === "harness-run.launch");
  const harnessLaunchAudit = audits.find((entry) => entry.action === "harness.run.launch"
    && entry.outcome === "accepted"
    && entry.details?.controllerSessionId === session.sessionId
    && entry.details?.harnessRunId === run.harnessRunId
    && entry.details?.projectId === projectId
    && entry.details?.source === "controller-cli");
  const harnessOutcomeAudit = audits.find((entry) => entry.action === "harness.run.outcome"
    && entry.outcome === "observed"
    && entry.details?.harnessRunId === run.harnessRunId
    && entry.details?.outcomeReference === run.outcome.outcomeId
    && entry.details?.status === run.outcome.status
    && entry.details?.code === run.outcome.code);
  const launchIdempotencyKeyHash = harnessLaunchAudit?.details?.idempotencyKeyHash;
  const providerLaunchAudit = providerLaunchAudits[0];
  if (
    !sessionStartAudit
    || providerLaunchAudits.length !== 1
    || !harnessLaunchAudit
    || !harnessOutcomeAudit
    || typeof launchIdempotencyKeyHash !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(launchIdempotencyKeyHash)
    || providerLaunchAudit.details?.idempotencyKeyHash !== launchIdempotencyKeyHash
  ) {
    throw new Error(acceptanceError(issue, "audit_chain_incomplete"));
  }
  return [sessionStartAudit, providerLaunchAudit, harnessLaunchAudit, harnessOutcomeAudit];
};
