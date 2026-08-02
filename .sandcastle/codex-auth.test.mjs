import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  createCodexSandboxSettings,
  createRunSettings,
  createWorkerSandboxSettings,
} from "./sandbox-settings.mjs";

test("the sandbox receives an independent copy of the host Codex auth file", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "sandcastle-codex-auth-"));
  const hostAuth = join(testRoot, "host-auth.json");
  const sandboxHome = join(testRoot, "sandbox-home");
  const credentials = '{"tokens":{"access_token":"consumer-account"}}\n';
  await writeFile(hostAuth, credentials, { mode: 0o600 });

  const result = spawnSync("bash", [".sandcastle/install-codex-auth.sh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_AUTH_SOURCE: hostAuth,
      CODEX_HOME: join(sandboxHome, ".codex"),
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);

  const sandboxAuth = join(sandboxHome, ".codex", "auth.json");
  assert.equal(await readFile(sandboxAuth, "utf8"), credentials);

  await writeFile(sandboxAuth, '{"tokens":{"access_token":"refreshed"}}\n');
  assert.equal(await readFile(hostAuth, "utf8"), credentials);
});

test("the Docker sandbox mounts the host Codex auth file read-only", () => {
  const settings = createCodexSandboxSettings("/host/.codex/auth.json");

  assert.deepEqual(settings.docker.mounts, [
    {
      hostPath: "/host/.codex/auth.json",
      sandboxPath: "/home/agent/.sandcastle-secrets/codex-auth.json",
      readonly: true,
    },
  ]);
});

test("real Claude access is granted only to an explicitly selected Worker issue", () => {
  const paths = {
    codexAuthPath: "/host/.codex/auth.json",
    claudeCredentialPath: "/host/.claude/.credentials.json",
    claudeExecutablePath: "/host/bin/claude",
  };
  const environment = { SANDCASTLE_REAL_CLAUDE_ISSUES: "146, 150" };

  const selected = createWorkerSandboxSettings("146", environment, paths);
  const unrelated = createWorkerSandboxSettings("147", environment, paths);
  const disabled = createWorkerSandboxSettings("146", {}, paths);

  assert.deepEqual(selected.docker.mounts, [
    {
      hostPath: paths.codexAuthPath,
      sandboxPath: "/home/agent/.sandcastle-secrets/codex-auth.json",
      readonly: true,
    },
    {
      hostPath: paths.claudeCredentialPath,
      sandboxPath: "/home/agent/.sandcastle-secrets/claude-credentials.json",
      readonly: true,
    },
    {
      hostPath: paths.claudeExecutablePath,
      sandboxPath: "/usr/local/bin/claude",
      readonly: true,
    },
  ]);
  assert.deepEqual(unrelated, createCodexSandboxSettings(paths.codexAuthPath));
  assert.deepEqual(disabled, createCodexSandboxSettings(paths.codexAuthPath));
});

test("the selected Worker receives a writable isolated copy of Claude authentication", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "sandcastle-claude-auth-"));
  const hostCredential = join(testRoot, "host-claude-credentials.json");
  const sandboxHome = join(testRoot, "sandbox-home");
  const credentials = '{"claudeAiOauth":{"accessToken":"destination-local"}}\n';
  await writeFile(hostCredential, credentials, { mode: 0o600 });
  const settings = createWorkerSandboxSettings(
    "146",
    { SANDCASTLE_REAL_CLAUDE_ISSUES: "146" },
    {
      codexAuthPath: "/host/.codex/auth.json",
      claudeCredentialPath: "/host/.claude/.credentials.json",
      claudeExecutablePath: "/host/bin/claude",
    },
  );
  const claudeHook = settings.hooks.sandbox.onSandboxReady.find((hook) =>
    hook.command.includes("CLAUDE_CREDENTIAL_SOURCE"));

  assert.ok(claudeHook, "selected Worker must install isolated Claude authentication");
  const result = spawnSync("bash", ["-lc", claudeHook.command], {
    cwd: testRoot,
    env: {
      ...process.env,
      HOME: sandboxHome,
      CLAUDE_CREDENTIAL_SOURCE: hostCredential,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const sandboxCredential = join(sandboxHome, ".claude", ".credentials.json");
  assert.equal(await readFile(sandboxCredential, "utf8"), credentials);
  await writeFile(sandboxCredential, '{"refreshed":true}\n');
  assert.equal(await readFile(hostCredential, "utf8"), credentials);
});

test("the sandbox installs Codex auth when the worktree has no Sandcastle files", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "sandcastle-empty-worktree-"));
  const hostAuth = join(testRoot, "host-auth.json");
  const sandboxHome = join(testRoot, "sandbox-home");
  const credentials = '{"tokens":{"access_token":"consumer-account"}}\n';
  await writeFile(hostAuth, credentials, { mode: 0o600 });

  const settings = createCodexSandboxSettings("/host/.codex/auth.json");
  const authHook = settings.hooks.sandbox.onSandboxReady[0].command;
  const result = spawnSync("bash", ["-lc", authHook], {
    cwd: testRoot,
    env: {
      ...process.env,
      CODEX_AUTH_SOURCE: hostAuth,
      CODEX_HOME: join(sandboxHome, ".codex"),
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(join(sandboxHome, ".codex", "auth.json"), "utf8"),
    credentials,
  );
});

test("npm exposes the Sandcastle orchestration command", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(packageJson.scripts.sandcastle, "tsx .sandcastle/main.mts");
});

test("--stdout enables terminal output for Sandcastle runs", () => {
  assert.deepEqual(createRunSettings(["--stdout"]), {
    logging: { type: "stdout" },
  });
});

test("every Harness agent uses GPT-5.6 Sol at the highest supported effort", async () => {
  const source = await readFile(".sandcastle/main.mts", "utf8");
  const configuredAgents = source.match(
    /sandcastle\.codex\("gpt-5\.6-sol", \{ effort: "xhigh" \}\)/g,
  );

  assert.equal(configuredAgents?.length, 3);
  assert.doesNotMatch(source, /sandcastle\.codex\("gpt-5\.4"/);
});
