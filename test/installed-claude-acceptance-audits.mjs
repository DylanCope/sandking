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
 * @param {{
 *   audits: any[],
 *   session: {sessionId: string, providerSessionId: string, workContextId: string, workContextKind: string, canonicalReference: string},
 *   projectRegistration: {projectId: string},
 *   launchRequest: {launchRequestId: string, project: {projectId: string}},
 *   run: {harnessRunId: string, projectId: string, outcome: {outcomeId: string, status: string, code: string}},
 * }} input
 */
export const selectInstalledClaudeAcceptanceAuditChain = ({
  audits,
  session,
  projectRegistration,
  launchRequest,
  run,
}) => {
  const projectId = projectRegistration?.projectId;
  const canonicalReference = `sandking:project:${projectId}`;
  if (
    !projectId
    || session.workContextId !== projectId
    || session.workContextKind !== "project"
    || session.canonicalReference !== canonicalReference
    || launchRequest.project?.projectId !== projectId
    || run.projectId !== projectId
  ) {
    throw new Error("issue_124_real_acceptance_selected_project_not_focused");
  }
  const sessionStartAudit = audits.find((entry) => entry.action === "controller.session.start"
    && entry.outcome === "accepted"
    && entry.details?.sessionId === session.sessionId
    && entry.details?.controllerSessionId === session.sessionId
    && entry.details?.providerSessionId === session.providerSessionId
    && entry.details?.workContextId === projectId
    && entry.details?.canonicalReference === canonicalReference);
  const workContextInspectionAudits = audits.filter((entry) =>
    entry.action === "controller.provider.operation"
      && entry.outcome === "accepted"
      && entry.details?.sessionId === session.sessionId
      && entry.details?.providerSessionId === session.providerSessionId
      && entry.details?.workContextId === projectId
      && entry.details?.operation === "work-context.inspect");
  if (
    workContextInspectionAudits.length < 2
    || new Set(workContextInspectionAudits.map((entry) => entry.auditId)).size < 2
  ) {
    throw new Error("issue_124_real_acceptance_audit_chain_incomplete");
  }
  const requiredAudits = [
    sessionStartAudit,
    ...workContextInspectionAudits.slice(0, 2),
    audits.find((entry) => entry.action === "launch.request.prepare"
      && entry.outcome === "accepted"
      && entry.details?.controllerSessionId === session.sessionId
      && entry.details?.launchRequestId === launchRequest.launchRequestId
      && entry.details?.projectId === projectId),
    audits.find((entry) => entry.action === "launch.request.decision"
      && entry.outcome === "accepted"
      && entry.details?.controllerSessionId === session.sessionId
      && entry.details?.launchRequestId === launchRequest.launchRequestId
      && entry.details?.projectId === projectId
      && entry.details?.decision === "approved"),
    audits.find((entry) => entry.action === "harness.run.start"
      && entry.outcome === "accepted"
      && entry.details?.controllerSessionId === session.sessionId
      && entry.details?.launchRequestId === launchRequest.launchRequestId
      && entry.details?.harnessRunId === run.harnessRunId
      && entry.details?.projectId === projectId),
    audits.find((entry) => entry.action === "harness.run.outcome"
      && entry.outcome === "observed"
      && entry.details?.launchRequestId === launchRequest.launchRequestId
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
