import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  REAL_SANDBOX_IMAGE,
  runPinnedMain,
} from "../src/production-sandcastle-adapter/real-worker-v2.mjs";

const installedTsxPath = join(process.cwd(), "node_modules", "tsx");

const installTsx = async (executionPath) => {
  const modulesPath = join(executionPath, "node_modules");
  await mkdir(modulesPath, { recursive: true });
  await symlink(
    installedTsxPath,
    join(modulesPath, "tsx"),
    process.platform === "win32" ? "junction" : "dir",
  );
};

const createContainerLauncher = (invocations) => (command, args, options) => {
  invocations.push({ command, args, options });
  assert.equal(command, "docker");
  const imageIndex = args.indexOf(REAL_SANDBOX_IMAGE);
  assert.notEqual(imageIndex, -1, JSON.stringify(args));
  assert.deepEqual(args.slice(0, 2), ["run", "--rm"]);
  const entrypointIndex = args.indexOf("--entrypoint");
  assert.equal(args[entrypointIndex + 1], "/usr/local/bin/node");
  const environment = {
    PATH: process.env.PATH,
  };
  for (let index = 0; index < imageIndex; index += 1) {
    if (args[index] !== "--env") continue;
    const [name, ...value] = args[index + 1].split("=");
    environment[name] = value.join("=");
  }
  return spawn(process.execPath, args.slice(imageIndex + 1), {
    ...options,
    env: environment,
  });
};

test("the real Worker invokes pinned main.mts for one issue and accepts its attestation", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-main-dispatch-"));
  const executionPath = join(root, "execution");
  const projectPath = join(root, "project");
  const capturePath = join(projectPath, "main-invocation.json");
  const authPath = join(root, "codex-auth.json");
  const githubCredentialPath = join(root, "github-token");
  try {
    await Promise.all([
      installTsx(executionPath),
      mkdir(join(executionPath, ".sandcastle"), { recursive: true }),
      mkdir(projectPath, { recursive: true }),
      writeFile(authPath, "{}\n"),
      writeFile(githubCredentialPath, "github_pat_main_dispatch_secret\n"),
    ]);
    await writeFile(join(executionPath, ".sandcastle", "main.mts"), `
import { writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
const issueNumber: number = Number(process.argv.at(-1));
const protocolFd: number = Number(process.env.SANDKING_REAL_DELEGATION_PROTOCOL_FD ?? 3);
writeFileSync(join(process.cwd(), "main-invocation.json"), JSON.stringify({
  argv: process.argv.slice(2),
  credentialPath: process.env.SANDKING_GITHUB_CREDENTIAL_PATH,
  codexAuthPath: process.env.SANDCASTLE_CODEX_AUTH_PATH,
  protocol: process.env.SANDKING_REAL_DELEGATION_PROTOCOL,
  protocolFd: process.env.SANDKING_REAL_DELEGATION_PROTOCOL_FD,
  sandboxed: process.env.SANDKING_REAL_DELEGATION_CONTAINER,
  leakedToken: process.env.GH_TOKEN ?? null,
}));
writeSync(protocolFd, JSON.stringify({
  type: "sandcastle.delivery.progress",
  issueNumber,
  phase: "planning",
  label: "Plan issue #262",
  summary: "The scoped planner is selecting issue #262.",
  status: "running",
}) + "\\n");
writeSync(protocolFd, JSON.stringify({
  type: "sandcastle.delivery.result",
  issueNumber,
  status: "succeeded",
  code: "scoped_issue_completed",
  completion: {
    kind: "merged-pull-request",
    pullRequestNumber: 266,
    pullRequestUrl: "https://github.com/DylanCope/sandking/pull/266",
  },
}) + "\\n");
`);
    const progress = [];
    const invocations = [];

    const completed = await runPinnedMain({
      executionPath,
      projectPath,
      issueNumber: 262,
      authPath,
      githubCredentialPath,
      signal: AbortSignal.timeout(5_000),
      timeoutMs: 4_000,
      onProgress: (message) => progress.push(message),
      spawnProcess: createContainerLauncher(invocations),
    });

    assert.deepEqual(JSON.parse(await readFile(capturePath, "utf8")), {
      argv: ["--issue", "262"],
      credentialPath: githubCredentialPath,
      codexAuthPath: authPath,
      protocol: "1",
      protocolFd: "1",
      sandboxed: "1",
      leakedToken: null,
    });
    assert.equal(invocations.length, 1);
    assert.equal(JSON.stringify(invocations[0].args).includes(
      "github_pat_main_dispatch_secret",
    ), false);
    assert.ok(invocations[0].args.some((value) =>
      value.includes(`${githubCredentialPath}:${githubCredentialPath}`)));
    assert.equal(progress.length, 1);
    assert.equal(progress[0].phase, "planning");
    assert.equal(completed.exitCode, 0);
    assert.equal(completed.termination, "completed");
    assert.equal(completed.result.code, "scoped_issue_completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation reaches main.mts and preserves its structured failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-main-cancellation-"));
  const executionPath = join(root, "execution");
  const projectPath = join(root, "project");
  const authPath = join(root, "codex-auth.json");
  const githubCredentialPath = join(root, "github-token");
  try {
    await Promise.all([
      installTsx(executionPath),
      mkdir(join(executionPath, ".sandcastle"), { recursive: true }),
      mkdir(projectPath, { recursive: true }),
      writeFile(authPath, "{}\n"),
      writeFile(githubCredentialPath, "github_pat_cancellation_secret\n"),
    ]);
    await writeFile(join(executionPath, ".sandcastle", "main.mts"), `
import { writeSync } from "node:fs";
const issueNumber: number = Number(process.argv.at(-1));
const protocolFd: number = Number(process.env.SANDKING_REAL_DELEGATION_PROTOCOL_FD ?? 3);
process.on("SIGTERM", () => {
  writeSync(protocolFd, JSON.stringify({
    type: "sandcastle.delivery.result",
    issueNumber,
    status: "failed",
    code: "delivery_cancelled",
    completion: null,
  }) + "\\n");
  process.exit(1);
});
writeSync(protocolFd, JSON.stringify({
  type: "sandcastle.delivery.progress",
  issueNumber,
  phase: "planning",
  label: "Plan issue #262",
  summary: "The scoped planner is ready for cancellation.",
  status: "running",
}) + "\\n");
setInterval(() => undefined, 10);
`);
    const controller = new AbortController();
    const invocations = [];
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const running = runPinnedMain({
      executionPath,
      projectPath,
      issueNumber: 262,
      authPath,
      githubCredentialPath,
      signal: controller.signal,
      timeoutMs: 4_000,
      onProgress: markStarted,
      spawnProcess: createContainerLauncher(invocations),
    });
    await started;
    controller.abort(new Error("cancelled by Harness run"));

    const cancelled = await running;
    assert.equal(cancelled.termination, "cancelled");
    assert.equal(cancelled.result.status, "failed");
    assert.equal(cancelled.result.code, "delivery_cancelled");
    assert.equal(invocations.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
