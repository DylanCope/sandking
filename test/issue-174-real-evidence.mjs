const commitPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const idPattern = /^(?:harness|harness-run|harness-log|audit)-[a-f0-9]{24}$/;
const prohibitedKeyPattern = /(?:credential|account|transcript|bootstrap|cookie|session|environmentDump|logContent|diagnosticContent|skillContent|promptText|promptContent|fullContents|raw[A-Z_])/i;

export const ISSUE_174_SCENARIO =
  "production-sandcastle-delegation/commits-real-project-work";

export const createIssue174Qualification = (code) => ({
  schemaVersion: 1,
  issue: 174,
  scenario: ISSUE_174_SCENARIO,
  qualification: {
    status: "not-run",
    code,
    productionEvidence: false,
    fixtureSubstitution: false,
    modelInvoked: false,
  },
});

export const inspectIssue174RetainedRunState = (state) => {
  if (!state || !Array.isArray(state.runs) || !Array.isArray(state.launchOutcomes)) {
    return { status: "pending" };
  }
  if (state.runs.length > 1) {
    throw new Error("issue_174_retained_run_state_invalid");
  }
  const run = state.runs[0];
  if (run && ["succeeded", "failed", "cancelled"].includes(run.status)) {
    return { status: "terminal", run };
  }
  const launchFailure = state.launchOutcomes
    .map(({ response }) => response)
    .findLast((response) => response?.type === "harness.run.launch.failure");
  if (launchFailure) {
    return {
      status: "launch-failed",
      code: launchFailure.code,
      modelInvocationMayHaveOccurred:
        launchFailure.prohibitedSideEffects?.adapterStarted !== false,
    };
  }
  return { status: "pending" };
};

const inspectKeys = (value, path = []) => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectKeys(item, [...path, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (prohibitedKeyPattern.test(key)) {
      throw new Error(`issue_174_evidence_prohibited_field:${[...path, key].join(".")}`);
    }
    inspectKeys(child, [...path, key]);
  }
};

export const assertIssue174EvidenceSanitized = ({ evidence, prohibitedValues = [] }) => {
  inspectKeys(evidence);
  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  if (
    Buffer.byteLength(text, "utf8") > 65_536
    || prohibitedValues.some((value) => typeof value === "string" && value && text.includes(value))
    || /(?:sk-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9]{12,}|Bearer\s+[A-Za-z0-9._~-]+)/i
      .test(text)
  ) {
    throw new Error("issue_174_real_evidence_not_sanitized");
  }
  return text;
};

export const validateIssue174RealEvidence = (evidence) => {
  if (
    evidence?.schemaVersion !== 1
    || evidence.issue !== 174
    || evidence.parentPrd !== 169
    || evidence.scenario !== ISSUE_174_SCENARIO
    || !commitPattern.test(evidence.generatedFromCommit ?? "")
    || evidence.qualification?.status !== "passed"
    || evidence.qualification?.productionEvidence !== true
    || evidence.qualification?.fixtureSubstitution !== false
    || evidence.installedSandKing?.revision !== evidence.generatedFromCommit
    || evidence.installedSandKing?.command !== "sandking"
    || evidence.installedSandKing?.installed !== true
    || evidence.installedSandKing?.launchedOutsideCheckout !== true
    || !digestPattern.test(evidence.installedSandKing?.tarballIntegrity ?? "")
    || evidence.publicSeam?.surface !== "cockpit"
    || evidence.publicSeam?.defaultProductionHarness !== true
    || evidence.publicSeam?.launchActionCount !== 1
    || evidence.provider?.kind !== "openai-codex"
    || evidence.provider?.version !== "0.146.0"
    || evidence.provider?.realExecution !== true
    || evidence.provider?.simulated !== false
    || evidence.provider?.sandbox?.provider !== "docker"
    || evidence.provider?.sandbox?.image !== "sandcastle:sandking-real-worker"
    || !digestPattern.test(evidence.provider?.sandbox?.imageId ?? "")
    || evidence.provider?.sandbox?.configurationSource !== ".sandcastle/Dockerfile"
    || !digestPattern.test(evidence.provider?.sandbox?.configurationIntegrity ?? "")
    || evidence.provider?.sandbox?.destinationIsolation !== true
    || evidence.provider?.sandbox?.temporaryImageRemoved !== true
    || evidence.adapter?.identity !== "sandcastle-harness-adapter-v1"
    || evidence.adapter?.protocol !== "1.0.0"
    || !digestPattern.test(evidence.adapter?.contentIntegrity ?? "")
    || !idPattern.test(evidence.harness?.harnessId ?? "")
    || !commitPattern.test(evidence.harness?.pinnedRevision ?? "")
    || evidence.harness?.upstream?.package !== "@ai-hero/sandcastle"
    || evidence.harness?.upstream?.version !== "0.12.0"
    || !digestPattern.test(evidence.harness?.dependencyLock?.integrity ?? "")
    || !digestPattern.test(evidence.harness?.skillSetLock?.integrity ?? "")
    || evidence.harness?.skillSetLock?.delivery?.ambient !== "disabled"
    || evidence.harness?.skillSetLock?.delivery?.method
      !== "complete-pinned-inventory-in-worker-prompt"
    || evidence.harness?.skillSetLock?.resolvedSkills?.length !== 4
    || JSON.stringify(evidence.harness.skillSetLock.resolvedSkills.map(({ identity }) => identity))
      !== JSON.stringify([
        "sandking.issue-implementation",
        "sandking.issue-planning",
        "sandking.pull-request-review",
        "sandking.real-delegation",
      ])
    || !evidence.harness.skillSetLock.resolvedSkills.every((skill) =>
      typeof skill.identity === "string"
      && commitPattern.test(skill.revision ?? "")
      && digestPattern.test(skill.contentIntegrity ?? ""))
    || !commitPattern.test(evidence.project?.beforeCommit ?? "")
    || !commitPattern.test(evidence.project?.afterCommit ?? "")
    || evidence.project?.parentCommit !== evidence.project.beforeCommit
    || evidence.project?.artifact?.path !== "sandking-real-delegation.txt"
    || evidence.project?.artifact?.contentIntegrity
      !== "sha256:d249b05094457d73964be3ca190a1497399ddc9ae629b7e21f5e7ddd9dcfd57a"
    || !digestPattern.test(evidence.project?.artifact?.contentIntegrity ?? "")
    || !Object.values(evidence.project?.invariants ?? {}).every((value) => value === true)
    || !idPattern.test(evidence.structuredOutcome?.harnessRunId ?? "")
    || evidence.structuredOutcome?.status !== "succeeded"
    || evidence.structuredOutcome?.code !== "real_work_committed"
    || evidence.structuredOutcome?.commit !== evidence.project.afterCommit
    || evidence.structuredOutcome?.exactlyOneTerminalEnvelope !== true
    || evidence.diagnostics?.contentRetained !== false
    || evidence.diagnostics?.bounded !== true
    || !Array.isArray(evidence.diagnostics?.references)
    || evidence.diagnostics.references.length > 2
    || !evidence.diagnostics.references.every((reference) =>
      idPattern.test(reference.streamId ?? "")
      && ["stdout", "stderr"].includes(reference.producer)
      && reference.start === 0
      && Number.isSafeInteger(reference.end)
      && reference.end >= 0
      && reference.explicitRetrievalRequired === true)
  ) {
    throw new Error("issue_174_real_evidence_invalid");
  }
  assertIssue174EvidenceSanitized({ evidence });
  return evidence;
};
