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
 *   session: {sessionId: string, providerSessionId: string, workContextId: string, workContextKind: string, canonicalReference: string, terminal: {streamId: string}},
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
  const cliDescriptionAudits = audits.filter((entry) =>
    entry.action === "controller.provider.operation"
    && entry.outcome === "accepted"
    && entry.details?.sessionId === session.sessionId
    && entry.details?.providerSessionId === session.providerSessionId
    && entry.details?.workContextId === projectId
    && entry.details?.operation === "controller-cli.describe");
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
  const terminalAttachmentAudits = audits.filter((entry) =>
    entry.action === "controller.terminal.attach"
    && entry.outcome === "accepted"
    && entry.details?.sessionId === session.sessionId
    && entry.details?.providerSessionId === session.providerSessionId
    && entry.details?.streamId === session.terminal?.streamId);
  const launchIdempotencyKeyHash = harnessLaunchAudit?.details?.idempotencyKeyHash;
  const providerLaunchAudit = providerLaunchAudits[0];
  const sessionStartIndex = audits.indexOf(sessionStartAudit);
  const harnessLaunchIndex = audits.indexOf(harnessLaunchAudit);
  const providerLaunchIndex = audits.indexOf(providerLaunchAudit);
  const harnessOutcomeIndex = audits.indexOf(harnessOutcomeAudit);
  const causalCliDescriptionAudits = cliDescriptionAudits.filter((entry) => {
    const index = audits.indexOf(entry);
    return index > sessionStartIndex && index < harnessLaunchIndex;
  });
  const initialTerminalAttachment = terminalAttachmentAudits.find((entry) => {
    const index = audits.indexOf(entry);
    return index > sessionStartIndex
      && index < audits.indexOf(causalCliDescriptionAudits[0]);
  });
  const terminalReattachmentAudit = terminalAttachmentAudits.find((entry) =>
    audits.indexOf(entry) > harnessOutcomeIndex);
  if (
    !sessionStartAudit
    || causalCliDescriptionAudits.length < 1
    || providerLaunchAudits.length !== 1
    || !harnessLaunchAudit
    || !harnessOutcomeAudit
    || !initialTerminalAttachment
    || !terminalReattachmentAudit
    || harnessLaunchIndex >= providerLaunchIndex
    || harnessOutcomeIndex <= harnessLaunchIndex
    || typeof launchIdempotencyKeyHash !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(launchIdempotencyKeyHash)
    || providerLaunchAudit.details?.idempotencyKeyHash !== launchIdempotencyKeyHash
  ) {
    throw new Error(acceptanceError(issue, "audit_chain_incomplete"));
  }
  const selectedAuditIds = new Set([
    sessionStartAudit.auditId,
    initialTerminalAttachment.auditId,
    ...causalCliDescriptionAudits.map((entry) => entry.auditId),
    harnessLaunchAudit.auditId,
    providerLaunchAudit.auditId,
    harnessOutcomeAudit.auditId,
    terminalReattachmentAudit.auditId,
  ]);
  return audits.filter((entry) => selectedAuditIds.has(entry.auditId));
};
