/**
 * @param {{
 *   audits: any[],
 *   session: {sessionId: string, providerSessionId: string},
 *   launchRequest: {launchRequestId: string},
 *   run: {harnessRunId: string, outcome: {outcomeId: string, status: string, code: string}},
 * }} input
 */
export const selectInstalledClaudeAcceptanceAuditChain = ({
  audits,
  session,
  launchRequest,
  run,
}) => {
  const requiredAudits = [
    audits.find((entry) => entry.action === "controller.session.start"
      && entry.outcome === "accepted"
      && entry.details?.sessionId === session.sessionId
      && entry.details?.controllerSessionId === session.sessionId
      && entry.details?.providerSessionId === session.providerSessionId),
    audits.find((entry) => entry.action === "launch.request.prepare"
      && entry.outcome === "accepted"
      && entry.details?.controllerSessionId === session.sessionId
      && entry.details?.launchRequestId === launchRequest.launchRequestId),
    audits.find((entry) => entry.action === "launch.request.decision"
      && entry.outcome === "accepted"
      && entry.details?.controllerSessionId === session.sessionId
      && entry.details?.launchRequestId === launchRequest.launchRequestId
      && entry.details?.decision === "approved"),
    audits.find((entry) => entry.action === "harness.run.start"
      && entry.outcome === "accepted"
      && entry.details?.controllerSessionId === session.sessionId
      && entry.details?.launchRequestId === launchRequest.launchRequestId
      && entry.details?.harnessRunId === run.harnessRunId),
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
