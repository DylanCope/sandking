import { hasExactKeys } from "../src/common/exact-object-keys.mjs";

const commitPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const harnessRunIdPattern = /^harness-run-[a-f0-9]{24}$/;
const logStreamIdPattern = /^harness-log-[a-f0-9]{24}$/;
const repositoryNamePattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const realGitHubDelegationScenario = Object.freeze({
  id: "production-github-issue-delegation/disposable-repository",
  environmentGate: "SANDKING_REAL_GITHUB_DELEGATION",
});

const isGitHubUrl = (value, suffix) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "github.com"
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === ""
      && (!suffix || url.pathname.endsWith(suffix));
  } catch {
    return false;
  }
};

const validRepositoryReference = (value) => hasExactKeys(value, [
  "nameWithOwner",
  "url",
])
  && repositoryNamePattern.test(value.nameWithOwner)
  && isGitHubUrl(value.url, `/${value.nameWithOwner}`);

/**
 * Keep the gated live qualification honest: every field below represents a
 * behavior re-read from the installed Host or GitHub after delegation.
 *
 * @param {any} result
 */
export const validateRealGitHubDelegationResult = (result) => {
  const repository = result?.github?.repository;
  const deniedRepository = result?.github?.deniedRepository;
  const issue = result?.github?.issue;
  const pullRequest = result?.github?.pullRequest;
  const outcome = result?.structuredOutcome;
  const diagnostics = result?.diagnostics;
  if (
    !hasExactKeys(result, [
      "authentication",
      "diagnostics",
      "github",
      "harness",
      "hostGhPassthrough",
      "idempotency",
      "installedSandKing",
      "qualification",
      "scenario",
      "schemaVersion",
      "structuredOutcome",
    ])
    || result.schemaVersion !== 1
    || result.scenario !== realGitHubDelegationScenario.id
    || !hasExactKeys(result.qualification, [
      "fixtureSubstitution",
      "productionEvidence",
      "status",
    ])
    || result.qualification.status !== "passed"
    || result.qualification.productionEvidence !== true
    || result.qualification.fixtureSubstitution !== false
    || !hasExactKeys(result.installedSandKing, [
      "command",
      "installed",
      "launchedOutsideCheckout",
      "tarballIntegrity",
    ])
    || result.installedSandKing.command !== "sandking"
    || result.installedSandKing.installed !== true
    || result.installedSandKing.launchedOutsideCheckout !== true
    || !digestPattern.test(result.installedSandKing.tarballIntegrity ?? "")
    || !hasExactKeys(result.harness, ["identity", "pinnedRevision"])
    || result.harness.identity !== "sandcastle-harness-adapter-v1"
    || !commitPattern.test(result.harness.pinnedRevision ?? "")
    || !hasExactKeys(result.authentication, [
      "passthroughMode",
      "primaryMode",
      "projectScopeEnforced",
    ])
    || result.authentication.primaryMode !== "project-pat"
    || result.authentication.passthroughMode !== "host-gh-session"
    || result.authentication.projectScopeEnforced !== true
    || !hasExactKeys(result.github, [
      "deniedRepository",
      "issue",
      "pullRequest",
      "repository",
    ])
    || !validRepositoryReference(repository)
    || !hasExactKeys(deniedRepository, ["access", "nameWithOwner", "url"])
    || deniedRepository.access !== "denied"
    || !validRepositoryReference({
      nameWithOwner: deniedRepository.nameWithOwner,
      url: deniedRepository.url,
    })
    || deniedRepository.nameWithOwner === repository.nameWithOwner
    || !hasExactKeys(issue, ["number", "state", "url"])
    || !Number.isSafeInteger(issue.number)
    || issue.number < 1
    || issue.state !== "CLOSED"
    || !isGitHubUrl(issue.url, `/${repository.nameWithOwner}/issues/${issue.number}`)
    || !hasExactKeys(pullRequest, [
      "baseRefName",
      "headRefName",
      "number",
      "state",
      "url",
    ])
    || !Number.isSafeInteger(pullRequest.number)
    || pullRequest.number < 1
    || pullRequest.state !== "MERGED"
    || pullRequest.baseRefName !== "main"
    || pullRequest.headRefName !== `sandcastle/issue-${issue.number}`
    || !isGitHubUrl(
      pullRequest.url,
      `/${repository.nameWithOwner}/pull/${pullRequest.number}`,
    )
    || !hasExactKeys(outcome, [
      "code",
      "completion",
      "harnessRunId",
      "status",
    ])
    || !harnessRunIdPattern.test(outcome.harnessRunId ?? "")
    || outcome.status !== "succeeded"
    || outcome.code !== "issue_delivery_completed"
    || !hasExactKeys(outcome.completion, [
      "kind",
      "pullRequestNumber",
      "pullRequestUrl",
    ])
    || outcome.completion.kind !== "merged-pull-request"
    || outcome.completion.pullRequestNumber !== pullRequest.number
    || outcome.completion.pullRequestUrl !== pullRequest.url
    || !hasExactKeys(result.idempotency, [
      "canonicalRunCount",
      "claimActions",
      "launchAttempts",
      "pullRequestCount",
    ])
    || result.idempotency.launchAttempts !== 2
    || result.idempotency.canonicalRunCount !== 1
    || result.idempotency.pullRequestCount !== 1
    || JSON.stringify(result.idempotency.claimActions)
      !== JSON.stringify(["claim", "release"])
    || !hasExactKeys(result.hostGhPassthrough, [
      "completion",
      "harnessRunId",
      "status",
    ])
    || !harnessRunIdPattern.test(result.hostGhPassthrough.harnessRunId ?? "")
    || result.hostGhPassthrough.harnessRunId === outcome.harnessRunId
    || result.hostGhPassthrough.status !== "succeeded"
    || result.hostGhPassthrough.completion !== "issue-already-closed"
    || !hasExactKeys(diagnostics, ["contentRetained", "references"])
    || diagnostics.contentRetained !== false
    || !Array.isArray(diagnostics.references)
    || diagnostics.references.length > 2
    || !diagnostics.references.every((reference) => hasExactKeys(reference, [
      "explicitRetrievalRequired",
      "producer",
      "streamId",
    ])
      && logStreamIdPattern.test(reference.streamId ?? "")
      && ["stdout", "stderr"].includes(reference.producer)
      && reference.explicitRetrievalRequired === true)
  ) {
    throw new Error("real_github_delegation_result_invalid");
  }
  return result;
};
