import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  createCodexSandboxSettings,
  createRunSettings,
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
