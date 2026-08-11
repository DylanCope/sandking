import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  REAL_DELEGATION_ARTIFACT,
  REAL_DELEGATION_CONTENT,
  REAL_SANDBOX_IMAGE,
  executeRealDelegation,
  runRealDelegation,
  verifyRealDelegationCommit,
} from "../src/production-sandcastle-adapter/real-worker-v2.mjs";

const execFileAsync = promisify(execFile);
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const skillIdentities = [
  "sandking.issue-implementation",
  "sandking.issue-planning",
  "sandking.pull-request-review",
  "sandking.real-delegation",
];

const commit = (projectPath, message) => execFileAsync("git", [
  "-C", projectPath,
  "-c", "user.name=Real Worker Test",
  "-c", "user.email=real-worker-test@sandking.invalid",
  "-c", "commit.gpgSign=false",
  "commit", "--quiet", "-m", message,
]);

test("the real Worker accepts only one clean exact artifact commit", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "sandking-real-worker-commit-"));
  try {
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
    await writeFile(join(projectPath, "README.md"), "unrelated tracked content\n");
    await execFileAsync("git", ["-C", projectPath, "add", "README.md"]);
    await commit(projectPath, "Initialize disposable Project");
    const beforeCommit = (await execFileAsync(
      "git",
      ["-C", projectPath, "rev-parse", "HEAD"],
    )).stdout.trim();

    await writeFile(join(projectPath, REAL_DELEGATION_ARTIFACT), REAL_DELEGATION_CONTENT);
    await execFileAsync("git", ["-C", projectPath, "add", REAL_DELEGATION_ARTIFACT]);
    await commit(projectPath, "Prove pinned Sandcastle delegation");

    const afterCommit = await verifyRealDelegationCommit({ projectPath, beforeCommit });
    assert.match(afterCommit, /^[a-f0-9]{40}$/);
    assert.equal(
      await readFile(join(projectPath, REAL_DELEGATION_ARTIFACT), "utf8"),
      REAL_DELEGATION_CONTENT,
    );
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test("the real Worker rejects extra tracked changes in the delegated commit", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "sandking-real-worker-extra-"));
  try {
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
    await writeFile(join(projectPath, "README.md"), "original\n");
    await execFileAsync("git", ["-C", projectPath, "add", "README.md"]);
    await commit(projectPath, "Initialize disposable Project");
    const beforeCommit = (await execFileAsync(
      "git",
      ["-C", projectPath, "rev-parse", "HEAD"],
    )).stdout.trim();

    await Promise.all([
      writeFile(join(projectPath, REAL_DELEGATION_ARTIFACT), REAL_DELEGATION_CONTENT),
      writeFile(join(projectPath, "README.md"), "changed\n"),
    ]);
    await execFileAsync("git", ["-C", projectPath, "add", "--all"]);
    await commit(projectPath, "Invalid broad delegation");

    await assert.rejects(
      verifyRealDelegationCommit({ projectPath, beforeCommit }),
      /real_delegation_commit_invalid/,
    );
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test("the real Worker gives Sandcastle only the complete pinned skills and Docker sandbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-real-worker-pinned-"));
  const projectPath = join(root, "project");
  const executionPath = join(projectPath, ".sandking", "projection");
  const authPath = join(root, "destination-auth.json");
  const captured = {};
  try {
    await mkdir(executionPath, { recursive: true });
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
    await writeFile(join(projectPath, ".git", "info", "exclude"), ".sandking/\n");
    await writeFile(join(projectPath, "README.md"), "unrelated tracked content\n");
    await execFileAsync("git", ["-C", projectPath, "add", "README.md"]);
    await commit(projectPath, "Initialize disposable Project");
    await writeFile(authPath, "{}\n", { mode: 0o600 });

    const skills = [];
    for (const identity of skillIdentities) {
      const source = `Pinned instructions for ${identity}.\n`;
      const path = `worker-skills/${identity}/SKILL.md`;
      await mkdir(join(executionPath, "worker-skills", identity), { recursive: true });
      await writeFile(join(executionPath, ...path.split("/")), source);
      skills.push({
        identity,
        revision: "a".repeat(40),
        contentIntegrity: sha256(source),
        path,
      });
    }
    await writeFile(join(executionPath, "worker-environment.json"), `${JSON.stringify({
      schemaVersion: 1,
      skillSetLockDigest: `sha256:${"b".repeat(64)}`,
      skillDiscovery: {
        ambient: "disabled",
        roots: ["worker-skills"],
        unlisted: "reject",
      },
      skills,
      executionRuntimeInputs: [{ identity: "openai.codex-cli", version: "0.146.0" }],
    })}\n`);
    await writeFile(join(executionPath, "package-lock.json"), `${JSON.stringify({
      packages: {
        "node_modules/@ai-hero/sandcastle": {
          version: "0.12.0",
          resolved: "https://registry.npmjs.org/@ai-hero/sandcastle/-/sandcastle-0.12.0.tgz",
          integrity: "sha512-kdQ414rM8t1QiWeqZ3Klz4KSd0PqQG4bRVuqGpRDUomWhojSZkEAc1tbcEcThVmBEaHkCt8LmYR49vqEPNIoYQ==",
        },
      },
    })}\n`);
    await mkdir(join(executionPath, ".sandcastle"), { recursive: true });
    await writeFile(
      join(executionPath, ".sandcastle", "Dockerfile"),
      "FROM node:22-bookworm\n",
    );

    const result = await runRealDelegation({
      executionPath,
      projectPath,
      authPath,
      signal: AbortSignal.timeout(10_000),
      inspectSandboxImage: async () => `sha256:${"c".repeat(64)}`,
      loadSandcastle: async () => [{
        codex: (model, options) => {
          captured.agent = { model, options };
          return { name: "codex" };
        },
        run: async (options) => {
          captured.run = options;
          await writeFile(join(projectPath, REAL_DELEGATION_ARTIFACT), REAL_DELEGATION_CONTENT);
          await execFileAsync("git", ["-C", projectPath, "add", REAL_DELEGATION_ARTIFACT]);
          await execFileAsync("git", [
            "-C", projectPath,
            "-c", "user.name=Sandcastle Real Worker",
            "-c", "user.email=real-worker@sandking.invalid",
            "-c", "commit.gpgSign=false",
            "commit", "--quiet", "-m", "Prove pinned Sandcastle delegation",
          ]);
          return {
            completionSignal: "<promise>COMPLETE</promise>",
            commits: [{
              sha: (await execFileAsync("git", ["-C", projectPath, "rev-parse", "HEAD"]))
                .stdout.trim(),
            }],
          };
        },
      }, {
        docker: (options) => {
          captured.docker = options;
          return { name: "docker", options };
        },
      }],
    });

    assert.deepEqual(captured.agent, {
      model: "gpt-5.6-sol",
      options: { effort: "medium", captureSessions: false },
    });
    assert.equal(captured.run.sandbox.name, "docker");
    assert.equal(captured.docker.imageName, REAL_SANDBOX_IMAGE);
    assert.deepEqual(captured.docker.mounts, [{
      hostPath: authPath,
      sandboxPath: "/home/agent/.sandcastle-secrets/codex-auth.json",
      readonly: true,
    }]);
    assert.match(captured.run.hooks.sandbox.onSandboxReady[0].command,
      /rm -rf "\$\{HOME\}\/\.codex"/);
    assert.equal(captured.run.logging.type, "stdout");
    assert.equal(captured.run.branchStrategy.type, "head");
    for (const identity of skillIdentities) {
      assert.match(captured.run.prompt, new RegExp(`<skill identity="${identity}"`));
      assert.match(captured.run.prompt, new RegExp(`Pinned instructions for ${identity}`));
    }
    assert.equal(result.resolvedSkillCount, 4);
    assert.deepEqual(result.skillDelivery, {
      ambient: "disabled",
      method: "complete-pinned-inventory-in-worker-prompt",
      deliveredIdentities: skillIdentities,
    });
    assert.deepEqual(result.sandbox, {
      provider: "docker",
      image: REAL_SANDBOX_IMAGE,
      imageId: `sha256:${"c".repeat(64)}`,
      configurationSource: ".sandcastle/Dockerfile",
      configurationIntegrity: sha256("FROM node:22-bookworm\n"),
      destinationIsolation: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed real work publishes one truthful failure and preserves partial Project state", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "sandking-real-worker-partial-"));
  try {
    const partialPath = join(projectPath, "partial-real-worker-change.txt");
    const outcome = await executeRealDelegation({
      executionPath: projectPath,
      projectPath,
      signal: AbortSignal.timeout(1_000),
      runDelegation: async () => {
        await writeFile(partialPath, "partial state remains inspectable\n");
        throw new Error("provider transcript must not become a result");
      },
    });

    assert.deepEqual(outcome, {
      type: "sandcastle.worker.result",
      status: "failed",
      result: {
        schemaVersion: 1,
        kind: "sandcastle.delegation",
        code: "real_provider_execution_failed",
        provider: { kind: "openai-codex" },
      },
    });
    assert.equal(await readFile(partialPath, "utf8"), "partial state remains inspectable\n");
    assert.doesNotMatch(JSON.stringify(outcome), /provider transcript/i);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});
