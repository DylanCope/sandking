import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  inspectRealSandcastleRunState,
  serializeSanitizedRealProviderResult,
} from "./real-sandcastle-acceptance.mjs";

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

test("real-provider result serialization rejects secrets, session material, and machine paths", () => {
  for (const result of [
    { credentialValue: "secret" },
    { rawIdempotencyKey: "raw-key" },
    { providerTranscript: "provider output" },
    { unrestrictedLog: "all logs" },
    { environmentDump: "NAME=value" },
    { reusableSessionMaterial: "cookie" },
    { machineSpecificSecretPath: "/private/secret" },
    { fullSkillContent: "complete instructions" },
  ]) {
    assert.throws(() => serializeSanitizedRealProviderResult({ result }),
      /real_provider_result_prohibited_field/);
  }
  assert.throws(() => serializeSanitizedRealProviderResult({
    result: { value: "/home/person/project" },
  }), /real_provider_result_not_sanitized/);
  for (const secret of [
    "sk-1234567890abcdef",
    "ghp_1234567890abcdef",
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

test("fault injection remains outside production control and browser contracts", async () => {
  const productionSources = await Promise.all([
    "../src/cli.mjs",
    "../src/local-host.mjs",
    "../src/protocol.mjs",
    "../src/browser-protocol.mjs",
    "../src/runtime.mjs",
    "../src/runtime-daemon.mjs",
    "../src/cockpit.js",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  const [cli, host, protocol, browserProtocol, runtime, daemon, cockpit] = productionSources;

  assert.doesNotMatch(cli, /--host-mode|\bhostMode\b/);
  assert.doesNotMatch(runtime, /--host-mode|\bhostMode\b/);
  assert.doesNotMatch(daemon, /--host-mode|\bhostMode\b/);
  assert.doesNotMatch(host, /--mode|\bmode ===/);
  for (const faultMode of [
    "exit-before-ack",
    "hang-before-ack",
    "malformed-frame",
    "secret-probe",
    "pause-after-project-registration",
    "delayed-harness-run-launch-response",
  ]) {
    assert.doesNotMatch(host, new RegExp(faultMode));
  }
  assert.doesNotMatch([host, protocol, browserProtocol, daemon, cockpit].join("\n"),
    /pause-after-harness-run-cancellation-acceptance|harness_run_(?:terminal_envelope|lifecycle)\.|faultInjector/);
});
