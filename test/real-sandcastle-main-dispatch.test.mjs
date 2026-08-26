import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
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
  const containerArgs = args.slice(imageIndex + 1).map((argument) => {
    if (argument === "file:///workspace/harness/node_modules/tsx/dist/loader.mjs") {
      return pathToFileURL(join(
        options.cwd,
        "..",
        "execution",
        "node_modules",
        "tsx",
        "dist",
        "loader.mjs",
      )).href;
    }
    if (argument === "/workspace/harness/.sandcastle/main.mts") {
      return join(options.cwd, "..", "execution", ".sandcastle", "main.mts");
    }
    return argument;
  });
  return spawn(process.execPath, containerArgs, {
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
  claimInstanceId: process.env.SANDKING_REAL_DELEGATION_CLAIM_INSTANCE_ID,
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
      claimInstanceId: "qualification-host",
      dockerEndpoint: "unix:///run/user/1000/docker.sock",
      signal: AbortSignal.timeout(5_000),
      timeoutMs: 4_000,
      onProgress: (message) => progress.push(message),
      createDockerRelay: async (dockerEndpoint, { platform }) => {
        assert.equal(dockerEndpoint, "unix:///run/user/1000/docker.sock");
        assert.equal(platform, process.platform);
        return {
          environment: { DOCKER_HOST: "unix:///var/run/docker.sock" },
          mountArguments: ["/private/rootless-relay.sock:/var/run/docker.sock:rw"],
          close: async () => undefined,
        };
      },
      spawnProcess: createContainerLauncher(invocations),
    });

    assert.deepEqual(JSON.parse(await readFile(capturePath, "utf8")), {
      argv: ["--issue", "262"],
      credentialPath: "/run/secrets/github-token",
      codexAuthPath: "/run/secrets/codex-auth.json",
      protocol: "1",
      protocolFd: "1",
      sandboxed: "1",
      claimInstanceId: "qualification-host",
      leakedToken: null,
    });
    assert.equal(invocations.length, 1);
    assert.equal(
      invocations[0].options.env.DOCKER_HOST,
      "unix:///run/user/1000/docker.sock",
    );
    assert.equal(JSON.stringify(invocations[0].args).includes(
      "github_pat_main_dispatch_secret",
    ), false);
    assert.ok(invocations[0].args.some((value) =>
      value === `${githubCredentialPath}:/run/secrets/github-token:ro`));
    assert.ok(invocations[0].args.some((value) =>
      /:\/var\/run\/docker\.sock:rw$/.test(value)));
    assert.equal(progress.length, 1);
    assert.equal(progress[0].phase, "planning");
    assert.equal(completed.exitCode, 0);
    assert.equal(completed.termination, "completed");
    assert.equal(completed.result.code, "scoped_issue_completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native Windows dispatch relays Docker's named pipe into Linux container paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-main-windows-dispatch-"));
  const executionPath = join(root, "execution");
  const projectPath = join(root, "project");
  const authPath = join(root, "codex-auth.json");
  const githubCredentialPath = join(root, "github-token");
  let relayClosed = false;
  try {
    await Promise.all([
      mkdir(executionPath, { recursive: true }),
      mkdir(projectPath, { recursive: true }),
      writeFile(authPath, "{}\n"),
      writeFile(githubCredentialPath, "github_pat_windows_dispatch_secret\n"),
    ]);
    const invocations = [];
    const completed = await runPinnedMain({
      executionPath,
      projectPath,
      issueNumber: 262,
      authPath,
      githubCredentialPath,
      dockerEndpoint: "npipe:////./pipe/docker_engine",
      platform: "win32",
      timeoutMs: 4_000,
      createDockerRelay: async (dockerEndpoint, { platform }) => {
        assert.equal(dockerEndpoint, "npipe:////./pipe/docker_engine");
        assert.equal(platform, "win32");
        return {
          port: 43_262,
          environment: {
            DOCKER_HOST: "tcp://host.docker.internal:43262",
            DOCKER_CONFIG: "/run/sandking-docker-config",
          },
          mountArguments: [
            "C:/private/docker-config:/run/sandking-docker-config:ro",
          ],
          close: async () => {
            relayClosed = true;
          },
        };
      },
      spawnProcess: (command, args, options) => {
        invocations.push({ command, args, options });
        const workdirIndex = args.indexOf("--workdir");
        const imageIndex = args.indexOf(REAL_SANDBOX_IMAGE);
        assert.equal(workdirIndex >= 0 && args[workdirIndex + 1], "/workspace/project");
        assert.notEqual(imageIndex, -1);
        for (const mount of [
          `${projectPath}:/workspace/project:rw`,
          `${executionPath}:/workspace/harness:ro`,
          `${authPath}:/run/secrets/codex-auth.json:ro`,
          `${githubCredentialPath}:/run/secrets/github-token:ro`,
          "C:/private/docker-config:/run/sandking-docker-config:ro",
        ]) {
          assert.ok(args.includes(mount), JSON.stringify(args));
        }
        assert.equal(args.includes("/var/run/docker.sock:/var/run/docker.sock:rw"), false);
        assert.ok(args.includes("DOCKER_HOST=tcp://host.docker.internal:43262"));
        assert.ok(args.includes("DOCKER_CONFIG=/run/sandking-docker-config"));
        assert.ok(args.includes(
          "SANDCASTLE_CODEX_AUTH_PATH=/run/secrets/codex-auth.json",
        ));
        assert.ok(args.includes(
          "SANDKING_GITHUB_CREDENTIAL_PATH=/run/secrets/github-token",
        ));
        assert.deepEqual(args.slice(imageIndex + 1), [
          "--import",
          "file:///workspace/harness/node_modules/tsx/dist/loader.mjs",
          "/workspace/harness/.sandcastle/main.mts",
          "--issue",
          "262",
        ]);

        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        queueMicrotask(() => {
          child.stdout.end(`${JSON.stringify({
            type: "sandcastle.delivery.result",
            issueNumber: 262,
            status: "failed",
            code: "scoped_issue_incomplete",
            completion: null,
          })}\n`);
          child.emit("close", 1, null);
        });
        return child;
      },
    });

    assert.equal(completed.result.code, "scoped_issue_incomplete");
    assert.equal(invocations.length, 1);
    assert.equal(relayClosed, true);
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
      dockerEndpoint: "unix:///run/user/1000/docker.sock",
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
