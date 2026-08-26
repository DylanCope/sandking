import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { BrowserProtocolError, parseBrowserControl } from "../src/browser-protocol.mjs";
import { ProtocolError, readFrame, writeFrame } from "../src/protocol.mjs";
import {
  inspectRealSandcastleRunState,
  serializeSanitizedRealProviderResult,
} from "./real-sandcastle-acceptance.mjs";
import {
  realGitHubDelegationScenario,
  validateRealGitHubDelegationResult,
} from "./real-github-delegation.mjs";
import { provisionDisposableProjectPat } from "./disposable-github-repository.mjs";

// Real-provider acceptance runners invoke paid models against a real
// destination. Each must refuse to run unless its environment gate is set
// explicitly, so an ordinary `npm test` can never trigger a billed
// invocation. These assertions were preserved when the per-ticket evidence
// receipt files were retired; they are the only part of that machinery that
// guarded a real safety property.
//
const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const closedEnvironment = { PATH: process.env.PATH, LANG: "C.UTF-8" };

/**
 * @param {string} runner
 * @param {string[]} arguments_
 * @param {RegExp} expectedFailure
 */
const assertGateClosed = async (runner, arguments_, expectedFailure) => {
  await assert.rejects(execFileAsync(process.execPath, [
    fileURLToPath(new URL(runner, import.meta.url)),
    ...arguments_,
  ], { cwd: repositoryRoot, env: closedEnvironment }), (error) => {
    assert.match(error.stderr, expectedFailure);
    return true;
  });
};

test("issue 124 real-Claude acceptance fails closed unless its human gate is explicit", async () => {
  await assertGateClosed(
    "./run-installed-claude-acceptance.mjs",
    ["--issue", "124"],
    /issue_124_real_acceptance_gate_closed/,
  );
});

test("issue 146 real-Claude acceptance fails closed without the explicit gate", async () => {
  await assertGateClosed(
    "./run-issue-146-real-claude.mjs",
    [],
    /issue_146_real_acceptance_gate_closed/,
  );
});

test("issue 152 real-Claude acceptance fails closed without the explicit gate", async () => {
  await assertGateClosed(
    "./run-installed-claude-acceptance.mjs",
    ["--issue", "152"],
    /issue_152_real_acceptance_gate_closed/,
  );
});

test("issue 174 real-Sandcastle acceptance fails closed without the explicit gate", async () => {
  await assert.rejects(execFileAsync(process.execPath, [
    fileURLToPath(new URL("./run-issue-174-real-sandcastle.mjs", import.meta.url)),
  ], { cwd: repositoryRoot, env: closedEnvironment }), (error) => {
    const qualification = JSON.parse(error.stderr.trim().split("\n")[0]);
    assert.deepEqual(qualification.qualification, {
      status: "not-run",
      code: "real_provider_gate_disabled",
      productionEvidence: false,
      fixtureSubstitution: false,
      modelInvoked: false,
    });
    return true;
  });
});

test("real GitHub delegation qualification fails closed without explicit opt-in", async () => {
  const qualificationArguments = [
    "--test",
    fileURLToPath(new URL("./real-github-delegation.qualification.mjs", import.meta.url)),
  ];
  await assert.rejects(execFileAsync(process.execPath, qualificationArguments, {
    cwd: repositoryRoot,
    env: closedEnvironment,
  }), (error) => {
    assert.match(error.stdout, /real_github_delegation_gate_disabled/);
    assert.doesNotMatch(error.stdout, /productionEvidence.*true/);
    return true;
  });
  await assert.rejects(execFileAsync(process.execPath, qualificationArguments, {
    cwd: repositoryRoot,
    env: { ...closedEnvironment, SANDKING_REAL_GITHUB_DELEGATION: "1" },
  }), (error) => {
    assert.match(error.stdout, /real_github_provisioning_token_missing/);
    assert.doesNotMatch(error.stdout, /productionEvidence.*true/);
    return true;
  });
  await assert.rejects(execFileAsync(process.execPath, qualificationArguments, {
    cwd: repositoryRoot,
    env: {
      ...closedEnvironment,
      SANDKING_REAL_GITHUB_DELEGATION: "1",
      SANDKING_REAL_GITHUB_PROVISIONING_TOKEN: "provisioning-token-present",
    },
  }), (error) => {
    assert.match(error.stdout, /real_github_project_pat_provisioner_missing/);
    assert.doesNotMatch(error.stdout, /productionEvidence.*true/);
    return true;
  });
});

test("the live gate provisions and revokes its Project PAT after repository selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-project-pat-provisioner-"));
  const provisionerPath = join(root, "provision-project-pat.mjs");
  const observationPath = join(root, "provisioner-observations.jsonl");
  const projectPat = `github_pat_${"p".repeat(32)}`;
  try {
    await writeFile(provisionerPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const [operation, primaryRepository, deniedRepository] = process.argv.slice(2);
const observe = () => appendFileSync(${JSON.stringify(observationPath)}, JSON.stringify({
  operation,
  primaryRepository,
  deniedRepository,
}) + "\\n");
if (operation === "issue") {
  observe();
  process.stdout.write(${JSON.stringify(projectPat)} + "\\n");
} else if (operation === "revoke") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    if (input.trim() !== ${JSON.stringify(projectPat)}) process.exit(2);
    observe();
  });
} else {
  process.exit(3);
}
`);
    await chmod(provisionerPath, 0o700);
    const lease = await provisionDisposableProjectPat({
      provisionerPath,
      primaryRepository: "fixture-owner/disposable-a",
      deniedRepository: "fixture-owner/disposable-b",
    });
    assert.equal(lease.token, projectPat);
    await lease.dispose();
    await lease.dispose();
    assert.deepEqual((await readFile(observationPath, "utf8")).trim()
      .split("\n").map(JSON.parse), [
      {
        operation: "issue",
        primaryRepository: "fixture-owner/disposable-a",
        deniedRepository: "fixture-owner/disposable-b",
      },
      {
        operation: "revoke",
        primaryRepository: "fixture-owner/disposable-a",
        deniedRepository: "fixture-owner/disposable-b",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real-provider result serialization rejects secrets, session material, and machine paths", () => {
  for (const result of [
    { credentialValue: "secret" },
    { rawIdempotencyKey: "raw-key" },
    { providerTranscript: "provider output" },
    { unrestrictedLog: "all logs" },
    { environmentDump: "NAME=value" },
    { reusableSessionMaterial: "cookie" },
    { browserSessionId: "controller-session-0123456789abcdef" },
    { providerSessionId: "provider-session-0123456789abcdef" },
    { machineSpecificSecretPath: "/private/secret" },
    { fullSkillContent: "complete instructions" },
  ]) {
    assert.throws(() => serializeSanitizedRealProviderResult({ result }),
      /real_provider_result_prohibited_field/);
  }
  assert.throws(() => serializeSanitizedRealProviderResult({
    result: { value: "/home/person/project" },
  }), /real_provider_result_not_sanitized/);
  for (const machinePath of [
    "C:\\Users\\alice\\project",
    "D:\\sandking\\state",
    "\\Users\\alice\\project",
    "\\ProgramData\\SandKing\\state",
    "\\\\host\\credentials\\provider.json",
    "//host/credentials/provider.json",
  ]) {
    assert.throws(() => serializeSanitizedRealProviderResult({
      result: { artifact: { path: machinePath } },
    }), /real_provider_result_not_sanitized/);
    assert.throws(() => serializeSanitizedRealProviderResult({
      result: { value: `retained path: ${machinePath}` },
      prohibitedValues: [machinePath],
    }), /real_provider_result_not_sanitized/);
  }
  const escapedProhibitedValue = "private\\credential\"segment";
  assert.throws(() => serializeSanitizedRealProviderResult({
    result: { value: `prefix ${escapedProhibitedValue} suffix` },
    prohibitedValues: [escapedProhibitedValue],
  }), /real_provider_result_not_sanitized/);
  for (const secret of [
    "sk-1234567890abcdef",
    "ghp_1234567890abcdef",
    "github_pat_1234567890abcdef",
    "Bearer abcdefghijklmnop",
    "https://127.0.0.1/bootstrap?token=reusable",
    "sandking_session=reusable",
    "ANTHROPIC_API_KEY=secret",
    "CLAUDE_CODE_OAUTH_TOKEN=secret",
    "GITHUB_TOKEN=secret",
    "SANDKING_CONTROLLER_SECRET=secret",
  ]) {
    assert.throws(() => serializeSanitizedRealProviderResult({
      result: { value: secret },
    }), /real_provider_result_not_sanitized/);
  }
  assert.doesNotThrow(() => serializeSanitizedRealProviderResult({
    result: {
      sourcePath: "src/production-sandcastle-adapter/sandcastle-v4.mjs",
      configurationSource: ".sandcastle/Dockerfile",
      repository: "https://github.com/mattpocock/sandcastle.git",
    },
  }));
});

test("the real-Sandcastle runner recognizes a rejected launch before model invocation", () => {
  assert.deepEqual(inspectRealSandcastleRunState({
    runs: [],
    launchOutcomes: [{
      response: {
        type: "harness.run.launch.failure",
        code: "harness_worker_provider_unavailable",
        prohibitedSideEffects: {
          harnessRunCreated: false,
          adapterStarted: false,
          projectWrite: false,
        },
      },
    }],
  }), {
    status: "launch-failed",
    code: "harness_worker_provider_unavailable",
    modelInvocationMayHaveOccurred: false,
  });
});

test("real GitHub delegation evidence requires scoped, canonical, merged behavior", () => {
  const result = {
    schemaVersion: 1,
    scenario: realGitHubDelegationScenario.id,
    qualification: {
      status: "passed",
      productionEvidence: true,
      fixtureSubstitution: false,
    },
    installedSandKing: {
      command: "sandking",
      installed: true,
      launchedOutsideCheckout: true,
      tarballIntegrity: `sha256:${"1".repeat(64)}`,
    },
    harness: {
      identity: "sandcastle-harness-adapter-v1",
      pinnedRevision: "2".repeat(40),
    },
    authentication: {
      primaryMode: "project-pat",
      passthroughMode: "host-gh-session",
      projectScopeEnforced: true,
    },
    github: {
      repository: {
        nameWithOwner: "fixture-owner/sandking-a",
        url: "https://github.com/fixture-owner/sandking-a",
      },
      deniedRepository: {
        nameWithOwner: "fixture-owner/sandking-b",
        url: "https://github.com/fixture-owner/sandking-b",
        access: "denied",
      },
      issue: {
        number: 1,
        url: "https://github.com/fixture-owner/sandking-a/issues/1",
        state: "CLOSED",
      },
      pullRequest: {
        number: 2,
        url: "https://github.com/fixture-owner/sandking-a/pull/2",
        state: "MERGED",
        baseRefName: "main",
        headRefName: "sandcastle/issue-1",
      },
      delivery: {
        baseCommit: "6".repeat(40),
        mainCommit: "7".repeat(40),
        artifact: {
          path: "delegated-issue.txt",
          integrity: "sha256:434b05aee5fa527f23415993037d2fa9943300c54ad892a53836fc666aa0e961",
          bytes: 29,
        },
        seededTest: { command: "npm test", passed: true },
      },
    },
    structuredOutcome: {
      harnessRunId: `harness-run-${"3".repeat(24)}`,
      status: "succeeded",
      code: "issue_delivery_completed",
      completion: {
        kind: "merged-pull-request",
        pullRequestNumber: 2,
        pullRequestUrl: "https://github.com/fixture-owner/sandking-a/pull/2",
      },
    },
    idempotency: {
      launchAttempts: 2,
      canonicalRunCount: 1,
      pullRequestCount: 1,
      claimActions: ["claim", "release"],
    },
    hostGhPassthrough: {
      harnessRunId: `harness-run-${"4".repeat(24)}`,
      status: "succeeded",
      completion: "issue-already-closed",
    },
    diagnostics: {
      contentRetained: false,
      references: [{
        streamId: `harness-log-${"5".repeat(24)}`,
        producer: "stderr",
        explicitRetrievalRequired: true,
      }],
    },
  };

  assert.equal(validateRealGitHubDelegationResult(result), result);
  for (const invalid of [
    { authentication: { ...result.authentication, projectScopeEnforced: false } },
    { github: { ...result.github, issue: { ...result.github.issue, state: "OPEN" } } },
    { github: { ...result.github, delivery: {
      ...result.github.delivery,
      seededTest: { command: "npm test", passed: false },
    } } },
    { idempotency: { ...result.idempotency, pullRequestCount: 2 } },
    { diagnostics: { ...result.diagnostics, providerTranscript: "not allowed" } },
  ]) {
    assert.throws(
      () => validateRealGitHubDelegationResult({ ...result, ...invalid }),
      /real_github_delegation_result_invalid/,
    );
  }
});

test("production Host and Cockpit protocols exclude fault-injection controls", async () => {
  const injectedFaultFields = {
    hostMode: "hang-before-ack",
    faultPoint: "harness_run_lifecycle.adapter_ready.before_commit",
    faultInjector: "pause-before-commit",
  };
  for (const message of [
    {
      type: "host.fault.inject",
      requestId: "reject-host-fault-mode",
      mode: "hang-before-ack",
    },
    {
      type: "harness.run.fault.inject",
      requestId: "reject-harness-run-fault-point",
      faultPoint: "harness_run_lifecycle.adapter_ready.before_commit",
    },
  ]) {
    assert.throws(
      () => writeFrame(new PassThrough(), message),
      (error) => error instanceof ProtocolError && error.code === "frame_schema_invalid",
    );
    assert.throws(
      () => parseBrowserControl({
        channel: "control",
        message: { ...message, type: `browser.${message.type}` },
      }),
      (error) => error instanceof BrowserProtocolError
        && error.code === "browser_control_schema_invalid",
    );
  }

  const hostControl = new PassThrough();
  writeFrame(hostControl, {
    type: "ping",
    requestId: "host-control-with-injected-fault-fields",
    ...injectedFaultFields,
  });
  assert.deepEqual(await readFrame(hostControl), {
    type: "ping",
    requestId: "host-control-with-injected-fault-fields",
  });

  assert.throws(
    () => parseBrowserControl({
      channel: "control",
      message: {
        type: "browser.ping",
        requestId: "browser-control-with-injected-fault-fields",
        ...injectedFaultFields,
      },
    }),
    (error) => error instanceof BrowserProtocolError
      && error.code === "browser_control_schema_invalid",
  );
});
