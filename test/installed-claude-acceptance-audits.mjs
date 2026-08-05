/**
 * @param {{projectState: {projects?: any[]}, projectPath: string}} input
 */
export const selectInstalledClaudeProjectRegistration = ({ projectState, projectPath }) => {
  const matches = Array.isArray(projectState?.projects)
    ? projectState.projects.filter((project) => project?.status === "active"
      && project.canonicalPath === projectPath)
    : [];
  if (matches.length !== 1) {
    throw new Error("issue_124_real_acceptance_selected_project_not_registered");
  }
  return matches[0];
};

/**
 * Select the correlated one-action launch chain produced by an installed
 * Claude Controller invoking the ordinary sandking CLI.
 * @param {{
 *   audits: any[],
 *   session: {sessionId: string, providerSessionId: string, workContextId: string, workContextKind: string, canonicalReference: string},
 *   projectRegistration: {projectId: string},
 *   run: {harnessRunId: string, projectId: string, controllerSessionId: string | null, outcome: {outcomeId: string, status: string, code: string}},
 * }} input
 */
export const selectInstalledClaudeAcceptanceAuditChain = ({
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
    throw new Error("issue_124_real_acceptance_selected_project_not_focused");
  }
  const requiredAudits = [
    audits.find((entry) => entry.action === "controller.session.start"
      && entry.outcome === "accepted"
      && entry.details?.sessionId === session.sessionId
      && entry.details?.controllerSessionId === session.sessionId
      && entry.details?.providerSessionId === session.providerSessionId
      && entry.details?.workContextId === projectId
      && entry.details?.canonicalReference === canonicalReference),
    audits.find((entry) => entry.action === "controller.provider.operation"
      && entry.outcome === "accepted"
      && entry.details?.sessionId === session.sessionId
      && entry.details?.providerSessionId === session.providerSessionId
      && entry.details?.workContextId === projectId
      && entry.details?.operation === "harness-run.launch"),
    audits.find((entry) => entry.action === "harness.run.launch"
      && entry.outcome === "accepted"
      && entry.details?.controllerSessionId === session.sessionId
      && entry.details?.harnessRunId === run.harnessRunId
      && entry.details?.projectId === projectId
      && entry.details?.source === "controller-cli"),
    audits.find((entry) => entry.action === "harness.run.outcome"
      && entry.outcome === "observed"
      && entry.details?.harnessRunId === run.harnessRunId
      && entry.details?.outcomeReference === run.outcome.outcomeId
      && entry.details?.status === run.outcome.status
      && entry.details?.code === run.outcome.code),
  ];
  if (requiredAudits.some((entry) => !entry)) {
    throw new Error("issue_124_real_acceptance_audit_chain_incomplete");
  }
  return requiredAudits;
};
