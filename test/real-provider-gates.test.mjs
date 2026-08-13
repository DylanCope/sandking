import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  ]) {
    assert.throws(() => serializeSanitizedRealProviderResult({
      result: { value: machinePath },
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
