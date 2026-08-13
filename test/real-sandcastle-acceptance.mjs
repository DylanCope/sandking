const commitPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const idPattern = /^(?:harness|harness-run|harness-log|audit)-[a-f0-9]{24}$/;
const prohibitedKeyPattern = new RegExp([
  "credential|account|transcript|bootstrap|cookie|session",
  "environmentDump|unrestrictedLog|logContent|diagnosticContent",
  "skillContent|fullSkillContent|promptText|promptContent|fullContents",
  "raw[A-Z_]|machineSpecificSecretPath",
].join("|"), "i");
const providerSecretPattern =
  /(?:sk-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9]{12,}|Bearer\s+[A-Za-z0-9._~-]+)/i;
const sessionMaterialPattern = /(?:bootstrap\?token=|sandking_session=)/i;
const namedSecretPattern =
  /(?:ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|GITHUB_TOKEN|SANDKING_CONTROLLER_SECRET)\s*=/i;
const machinePathPattern =
  /(?:^|[^A-Za-z0-9._/\\-])(?:[\\/](?![\\/])|[A-Za-z]:[\\/]|\\\\[^\\/])/;

export const realSandcastleScenario = Object.freeze({
  id: "production-sandcastle-delegation/commits-real-project-work",
  provider: Object.freeze({
    cliVersion: "0.146.0",
    sandbox: Object.freeze({
      image: "sandcastle:sandking-real-worker",
      configurationSource: ".sandcastle/Dockerfile",
    }),
  }),
  expectedArtifact: Object.freeze({
    path: "sandking-real-delegation.txt",
    contentUtf8Sha256: "d249b05094457d73964be3ca190a1497399ddc9ae629b7e21f5e7ddd9dcfd57a",
  }),
});

export const createRealSandcastleQualification = (code) => ({
  schemaVersion: 1,
  issue: 174,
  scenario: realSandcastleScenario.id,
  qualification: {
    status: "not-run",
    code,
    productionEvidence: false,
    fixtureSubstitution: false,
    modelInvoked: false,
  },
});

export const inspectRealSandcastleRunState = (state) => {
  if (!state || !Array.isArray(state.runs) || !Array.isArray(state.launchOutcomes)) {
    return { status: "pending" };
  }
  if (state.runs.length > 1) {
    throw new Error("real_sandcastle_retained_run_state_invalid");
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

// Inspect values before JSON encoding so Windows separators and other escaped
// characters cannot hide prohibited result material.
const inspectResult = (value, prohibitedValues, path = []) => {
  if (typeof value === "string") {
    if (
      machinePathPattern.test(value)
      || prohibitedValues.some((prohibited) => value.includes(prohibited))
    ) {
      throw new Error("real_provider_result_not_sanitized");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      inspectResult(item, prohibitedValues, [...path, String(index)]);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (prohibitedKeyPattern.test(key)) {
      throw new Error(`real_provider_result_prohibited_field:${[...path, key].join(".")}`);
    }
    inspectResult(child, prohibitedValues, [...path, key]);
  }
};

export const serializeSanitizedRealProviderResult = ({ result, prohibitedValues = [] }) => {
  const retainedProhibitedValues = prohibitedValues.filter((value) =>
    typeof value === "string" && value);
  inspectResult(result, retainedProhibitedValues);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (
    Buffer.byteLength(text, "utf8") > 65_536
    || providerSecretPattern.test(text)
    || sessionMaterialPattern.test(text)
    || namedSecretPattern.test(text)
  ) {
    throw new Error("real_provider_result_not_sanitized");
  }
  return text;
};

export const validateRealSandcastleResult = (result) => {
  if (
    result?.schemaVersion !== 1
    || result.issue !== 174
    || result.scenario !== realSandcastleScenario.id
    || result.qualification?.status !== "passed"
    || result.qualification?.productionEvidence !== true
    || result.qualification?.fixtureSubstitution !== false
    || result.installedSandKing?.command !== "sandking"
    || result.installedSandKing?.installed !== true
    || result.installedSandKing?.launchedOutsideCheckout !== true
    || !digestPattern.test(result.installedSandKing?.tarballIntegrity ?? "")
    || result.publicSeam?.surface !== "cockpit"
    || result.publicSeam?.defaultProductionHarness !== true
    || result.publicSeam?.launchActionCount !== 1
    || result.provider?.kind !== "openai-codex"
    || result.provider?.version !== realSandcastleScenario.provider.cliVersion
    || result.provider?.realExecution !== true
    || result.provider?.simulated !== false
    || result.provider?.sandbox?.provider !== "docker"
    || result.provider?.sandbox?.image !== realSandcastleScenario.provider.sandbox.image
    || !digestPattern.test(result.provider?.sandbox?.imageId ?? "")
    || result.provider?.sandbox?.configurationSource
      !== realSandcastleScenario.provider.sandbox.configurationSource
    || !digestPattern.test(result.provider?.sandbox?.configurationIntegrity ?? "")
    || result.provider?.sandbox?.destinationIsolation !== true
    || result.provider?.sandbox?.temporaryImageRemoved !== true
    || result.adapter?.identity !== "sandcastle-harness-adapter-v1"
    || result.adapter?.protocol !== "1.0.0"
    || !digestPattern.test(result.adapter?.contentIntegrity ?? "")
    || !idPattern.test(result.harness?.harnessId ?? "")
    || !commitPattern.test(result.harness?.pinnedRevision ?? "")
    || result.harness?.upstream?.package !== "@ai-hero/sandcastle"
    || result.harness?.upstream?.version !== "0.12.0"
    || !digestPattern.test(result.harness?.dependencyLock?.integrity ?? "")
    || !digestPattern.test(result.harness?.skillSetLock?.integrity ?? "")
    || result.harness?.skillSetLock?.delivery?.ambient !== "disabled"
    || result.harness?.skillSetLock?.delivery?.method
      !== "complete-pinned-inventory-in-worker-prompt"
    || JSON.stringify(result.harness?.skillSetLock?.resolvedSkills?.map(({ identity }) => identity))
      !== JSON.stringify([
        "sandking.issue-implementation",
        "sandking.issue-planning",
        "sandking.pull-request-review",
        "sandking.real-delegation",
      ])
    || !result.harness.skillSetLock.resolvedSkills.every((skill) =>
      typeof skill.identity === "string"
      && commitPattern.test(skill.revision ?? "")
      && digestPattern.test(skill.contentIntegrity ?? ""))
    || !commitPattern.test(result.project?.beforeCommit ?? "")
    || !commitPattern.test(result.project?.afterCommit ?? "")
    || result.project?.parentCommit !== result.project.beforeCommit
    || result.project?.artifact?.path !== realSandcastleScenario.expectedArtifact.path
    || result.project?.artifact?.contentIntegrity
      !== `sha256:${realSandcastleScenario.expectedArtifact.contentUtf8Sha256}`
    || !Object.values(result.project?.invariants ?? {}).every((value) => value === true)
    || !idPattern.test(result.structuredOutcome?.harnessRunId ?? "")
    || result.structuredOutcome?.status !== "succeeded"
    || result.structuredOutcome?.code !== "real_work_committed"
    || result.structuredOutcome?.commit !== result.project.afterCommit
    || result.structuredOutcome?.exactlyOneTerminalEnvelope !== true
    || result.diagnostics?.contentRetained !== false
    || result.diagnostics?.bounded !== true
    || !Array.isArray(result.diagnostics?.references)
    || result.diagnostics.references.length > 2
    || !result.diagnostics.references.every((reference) =>
      idPattern.test(reference.streamId ?? "")
      && ["stdout", "stderr"].includes(reference.producer)
      && reference.start === 0
      && Number.isSafeInteger(reference.end)
      && reference.end >= 0
      && reference.explicitRetrievalRequired === true)
  ) {
    throw new Error("real_sandcastle_acceptance_result_invalid");
  }
  return result;
};
