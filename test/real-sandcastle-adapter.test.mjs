import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
  readHarnessAdapterFrame,
  writeHarnessAdapterFrame,
} from "../src/harness-adapter-protocol.mjs";

const adapterPath = new URL(
  "../src/production-sandcastle-adapter/sandcastle-v4.mjs",
  import.meta.url,
);
const githubCredentialContractPath = new URL(
  "../src/github-credential-contract.mjs",
  import.meta.url,
);
const realDelegationProtocolPath = new URL(
  "../src/real-delegation-protocol.mjs",
  import.meta.url,
);
const exactObjectKeysPath = new URL(
  "../src/common/exact-object-keys.mjs",
  import.meta.url,
);
const adapterId = "sandcastle-harness-adapter-v1";
const adapterProtocol = "1.0.0";
const workerPath = ".sandcastle/real-worker-v2.mjs";
const githubCredentialContractSource = await readFile(githubCredentialContractPath, "utf8");
const realDelegationProtocolSource = await readFile(realDelegationProtocolPath, "utf8");
const exactObjectKeysSource = await readFile(exactObjectKeysPath, "utf8");

const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const integrity = (source) => `sha256:${createHash("sha256").update(source).digest("hex")}`;

const writeExecutable = async (path, source) => {
  await writeFile(path, source);
  await chmod(path, 0o700);
};

const createFixture = async ({
  providerReady = true,
  authenticated = true,
  authenticationStream = "stderr",
  sandboxReady = true,
} = {}) => {
  const root = await mkdtemp(join(tmpdir(), "sandking-real-adapter-"));
  const projectPath = join(root, "project");
  const executionPath = join(projectPath, ".sandking", "projection");
  const binPath = join(root, "bin");
  await Promise.all([
    mkdir(join(executionPath, "common"), { recursive: true }),
    mkdir(binPath, { recursive: true }),
  ]);
  await new Promise((resolve, reject) => {
    const child = spawn("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("git_init_failed")));
  });
  await writeFile(join(projectPath, "sandcastle.real-provider.json"), `${JSON.stringify({
    schemaVersion: 1,
    provider: { kind: "openai-codex", ready: providerReady },
    scenario: "project-commit",
  })}\n`);
  await writeFile(join(executionPath, "worker-environment.json"), `${JSON.stringify({
    schemaVersion: 1,
    harness: { adapterId },
    skillSetLockDigest: `sha256:${"1".repeat(64)}`,
    skillDiscovery: { ambient: "disabled", roots: ["worker-skills"], unlisted: "reject" },
    skills: [
      { identity: "sandking.issue-implementation" },
      { identity: "sandking.issue-planning" },
      { identity: "sandking.pull-request-review" },
      { identity: "sandking.real-delegation" },
    ],
    executionRuntimeInputs: [{ identity: "openai.codex-cli", version: "0.146.0" }],
  })}\n`);
  await writeFile(
    join(executionPath, "github-credential-contract.mjs"),
    githubCredentialContractSource,
  );
  await writeFile(
    join(executionPath, "real-delegation-protocol.mjs"),
    realDelegationProtocolSource,
  );
  await writeFile(
    join(executionPath, "common", "exact-object-keys.mjs"),
    exactObjectKeysSource,
  );
  await writeExecutable(join(binPath, "codex"), `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'codex-cli 0.146.0'
elif [ "$1" = "login" ] && [ "$2" = "status" ]; then
  printf '%s\\n' '${authenticated ? "Logged in using fixture" : "Not logged in"}'${
    authenticationStream === "stderr" ? " >&2" : ""
  }
  ${authenticated ? "exit 0" : "exit 1"}
else
  exit 91
fi
`);
  await writeExecutable(join(binPath, "npm"), `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' '10.9.8'; exit 0; fi
if [ "$1" = "ci" ]; then
  mkdir -p node_modules/.bin node_modules/fake-runtime
  printf '%s\\n' 'temporary dependency' > node_modules/fake-runtime/index.js
  ln -s ../fake-runtime/index.js node_modules/.bin/fake-runtime
  exit 0
fi
exit 92
`);
  if (sandboxReady) {
    await writeExecutable(join(binPath, "docker"), `#!/bin/sh
if [ "$1" = "version" ] && [ "$2" = "--format" ]; then
  printf '%s\\n' '27.5.1'
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ] && [ "$3" = "sandcastle:sandking-real-worker" ]; then
  printf '%s\\n' 'sha256:${"d".repeat(64)}'
  exit 0
fi
exit 93
`);
  }
  return {
    root,
    projectPath,
    executionPath,
    environment: {
      LANG: "C.UTF-8",
      HOME: root,
      PATH: `${binPath}${delimiter}${process.env.PATH ?? ""}`,
    },
  };
};

const invoke = async ({ command, encoded = encode({}), executionPath, environment }) => {
  const source = await readFile(adapterPath, "utf8");
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval", source,
    "adapters/sandcastle.mjs",
    command,
    encoded,
  ], {
    cwd: executionPath,
    env: environment,
    stdio: ["ignore", "pipe", "pipe", "pipe", "ipc"],
  });
  return { child, channel: child.stdio[3] };
};

const waitForExit = (child) => new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

test("real-provider preparation fails closed unless its exact gate and credentials are ready", {
  skip: process.platform === "win32" ? "POSIX command fixture" : false,
}, async () => {
  const disabled = await createFixture({ providerReady: false });
  const unauthenticated = await createFixture({ authenticated: false });
  const sandboxUnavailable = await createFixture({ sandboxReady: false });
  const readyOnStderr = await createFixture();
  const readyOnStdout = await createFixture({ authenticationStream: "stdout" });
  try {
    for (const [fixture, expectedType] of [
      [disabled, "harness.launch.failure"],
      [unauthenticated, "harness.launch.failure"],
      [sandboxUnavailable, "harness.launch.failure"],
      [readyOnStderr, "harness.launch.prepared"],
      [readyOnStdout, "harness.launch.prepared"],
    ]) {
      const invocation = await invoke({
        command: "prepare",
        encoded: encode(expectedType === "harness.launch.prepared"
          ? { issueNumber: 262 }
          : {}),
        executionPath: fixture.executionPath,
        environment: fixture.environment,
      });
      const frame = await readHarnessAdapterFrame(invocation.channel);
      assert.equal(frame.type, expectedType);
      if (expectedType === "harness.launch.failure") {
        assert.equal(frame.code, "harness_worker_provider_unavailable");
        assert.deepEqual(frame.sideEffects, {
          delegatedWorkStarted: false,
          projectWrite: false,
          harnessWorkspaceWrite: false,
        });
      } else {
        assert.deepEqual(frame.retainedExecutionInputs, [workerPath]);
        assert.deepEqual(frame.suppliedCapabilities, [
          "github.issues.read",
          "project.git.read",
        ]);
      }
      assert.deepEqual(await waitForExit(invocation.child), { code: 0, signal: null });
    }
    const issueInvocation = await invoke({
      command: "prepare",
      encoded: encode({ issueNumber: 261 }),
      executionPath: readyOnStderr.executionPath,
      environment: readyOnStderr.environment,
    });
    const issueFrame = await readHarnessAdapterFrame(issueInvocation.channel);
    assert.equal(issueFrame.type, "harness.launch.prepared");
    assert.deepEqual(issueFrame.suppliedCapabilities, [
      "github.issues.read",
      "project.git.read",
    ]);
    assert.deepEqual(await waitForExit(issueInvocation.child), { code: 0, signal: null });

    const githubAccessInvocation = await invoke({
      command: "prepare",
      encoded: encode({ issueNumber: 261, verifyGitHubAccess: true }),
      executionPath: readyOnStderr.executionPath,
      environment: readyOnStderr.environment,
    });
    const githubAccessFrame = await readHarnessAdapterFrame(githubAccessInvocation.channel);
    assert.equal(githubAccessFrame.type, "harness.launch.prepared");
    assert.deepEqual(githubAccessFrame.suppliedCapabilities, [
      "github.issues.read",
      "github.authentication.verify",
      "project.git.read",
    ]);
    assert.deepEqual(
      await waitForExit(githubAccessInvocation.child),
      { code: 0, signal: null },
    );
  } finally {
    await Promise.all([
      disabled,
      unauthenticated,
      sandboxUnavailable,
      readyOnStderr,
      readyOnStdout,
    ].map((fixture) =>
      rm(fixture.root, { recursive: true, force: true })));
  }
});

test("real-provider preparation requires an issue before delegated work starts", {
  skip: process.platform === "win32" ? "POSIX command fixture" : false,
}, async () => {
  const fixture = await createFixture();
  try {
    const invocation = await invoke({
      command: "prepare",
      executionPath: fixture.executionPath,
      environment: fixture.environment,
    });
    const frame = await readHarnessAdapterFrame(invocation.channel);

    assert.equal(frame.type, "harness.launch.failure");
    assert.equal(frame.code, "real_delegation_issue_required");
    assert.match(frame.sanitizedExplanation, /--issue <number>/);
    assert.deepEqual(frame.sideEffects, {
      delegatedWorkStarted: false,
      projectWrite: false,
      harnessWorkspaceWrite: false,
    });
    assert.deepEqual(await waitForExit(invocation.child), { code: 0, signal: null });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const mode of ["project-pat", "host-gh-session"]) {
  test(`real-provider ${mode} credentials stay off argv and retained output`, {
    skip: process.platform === "win32" ? "POSIX command fixture" : false,
  }, async () => {
    const fixture = await createFixture();
    const runId = `harness-run-${(mode === "project-pat" ? "2" : "3").repeat(24)}`;
    const githubToken = mode === "project-pat"
      ? "github_pat_adapter_pipe_secret_261"
      : "gho_adapter_pipe_secret_261";
    const fakeWorker = `
import { execFileSync } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const projectPath = process.argv.at(-1);
const githubCredential = JSON.parse(readFileSync(4, "utf8"));
const visibleArguments = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(process.pid)], {
  encoding: "utf8",
});
if (
  githubCredential.mode !== "${mode}"
  || !githubCredential.token.endsWith("adapter_pipe_secret_261")
  || visibleArguments.includes(githubCredential.token)
) throw new Error("github_credential_pipe_invalid");
await writeFile(join(projectPath, "partial-provider-state.txt"), "inspectable partial state\\n");
process.stdout.write("provider transcript must be discarded\\n");
process.stderr.write("token=reusable-provider-secret\\n");
const tokenBoundary = Math.floor(githubCredential.token.length / 2);
process.stderr.write("bare credential " + githubCredential.token.slice(0, tokenBoundary));
await new Promise((resolve) => setTimeout(resolve, 50));
process.stderr.write(githubCredential.token.slice(tokenBoundary) + "\\n");
writeSync(3, JSON.stringify({
  type: "sandcastle.worker.progress",
  label: "Credential-safe progress",
  summary: "credential echo " + githubCredential.token,
  status: "running",
}) + "\\n");
writeSync(3, JSON.stringify({
  type: "sandcastle.worker.result",
  status: "failed",
  result: {
    schemaVersion: 1,
    kind: "sandcastle.delegation",
    code: "real_provider_execution_failed",
    provider: { kind: "openai-codex" },
    credentialEcho: githubCredential.token,
  },
}) + "\\n");
`;
    try {
      const invocation = await invoke({
        command: "run",
        encoded: encode({ harnessRunId: runId, parameters: { issueNumber: 262 } }),
        executionPath: fixture.executionPath,
        environment: fixture.environment,
      });
      let diagnostic = "";
      invocation.child.stderr.on("data", (chunk) => {
        diagnostic += Buffer.from(chunk).toString("utf8");
      });
      writeHarnessAdapterFrame(invocation.channel, {
        type: "harness.run.start",
        adapterProtocol,
        adapterId,
        harnessRunId: runId,
        retainedExecutionInputs: [{
          path: workerPath,
          source: fakeWorker,
          integrity: integrity(fakeWorker),
        }],
        githubCredential: { mode, token: githubToken },
      });

      const frames = [];
      while (!frames.some(({ type }) => type === "harness.run.terminal")) {
        frames.push(await readHarnessAdapterFrame(invocation.channel));
      }
      assert.deepEqual(await waitForExit(invocation.child), { code: 0, signal: null });
      const terminals = frames.filter(({ type }) => type === "harness.run.terminal");
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0].status, "failed");
      assert.equal(terminals[0].result.code, "real_provider_execution_failed");
      assert.equal(
        await readFile(join(fixture.projectPath, "partial-provider-state.txt"), "utf8"),
        "inspectable partial state\n",
      );
      await assert.rejects(access(join(fixture.executionPath, "node_modules")));
      assert.match(diagnostic, /token=\[redacted\]/);
      assert.match(diagnostic, /bare credential \[redacted\]/);
      assert.doesNotMatch(diagnostic,
        /reusable-provider-secret|provider transcript|adapter_pipe_secret_261/);
      assert.doesNotMatch(JSON.stringify(frames), /adapter_pipe_secret_261/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}
