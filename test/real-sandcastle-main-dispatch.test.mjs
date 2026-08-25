import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runPinnedMain } from "../src/production-sandcastle-adapter/real-worker-v2.mjs";

test("the real Worker invokes pinned main.mts for one issue and accepts its attestation", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-main-dispatch-"));
  const executionPath = join(root, "execution");
  const projectPath = join(root, "project");
  const capturePath = join(projectPath, "main-invocation.json");
  const authPath = join(root, "codex-auth.json");
  const githubCredentialPath = join(root, "github-token");
  try {
    await Promise.all([
      mkdir(join(executionPath, "node_modules", "tsx", "dist"), { recursive: true }),
      mkdir(join(executionPath, ".sandcastle"), { recursive: true }),
      mkdir(projectPath, { recursive: true }),
      writeFile(authPath, "{}\n"),
      writeFile(githubCredentialPath, "github_pat_main_dispatch_secret\n"),
    ]);
    await writeFile(join(executionPath, ".sandcastle", "main.mts"), "// pinned main\n");
    await writeFile(join(executionPath, "node_modules", "tsx", "dist", "cli.mjs"), `
import { writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.cwd(), "main-invocation.json"), JSON.stringify({
  argv: process.argv.slice(2),
  credentialPath: process.env.SANDKING_GITHUB_CREDENTIAL_PATH,
  codexAuthPath: process.env.SANDCASTLE_CODEX_AUTH_PATH,
  protocol: process.env.SANDKING_REAL_DELEGATION_PROTOCOL,
  leakedToken: process.env.GH_TOKEN ?? null,
}));
writeSync(3, JSON.stringify({
  type: "sandcastle.delivery.progress",
  issueNumber: 262,
  phase: "planning",
  label: "Plan issue #262",
  summary: "The scoped planner is selecting issue #262.",
  status: "running",
}) + "\\n");
writeSync(3, JSON.stringify({
  type: "sandcastle.delivery.result",
  issueNumber: 262,
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

    const completed = await runPinnedMain({
      executionPath,
      projectPath,
      issueNumber: 262,
      authPath,
      githubCredentialPath,
      signal: AbortSignal.timeout(5_000),
      timeoutMs: 4_000,
      onProgress: (message) => progress.push(message),
    });

    assert.deepEqual(JSON.parse(await readFile(capturePath, "utf8")), {
      argv: [join(executionPath, ".sandcastle", "main.mts"), "--issue", "262"],
      credentialPath: githubCredentialPath,
      codexAuthPath: authPath,
      protocol: "1",
      leakedToken: null,
    });
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
      mkdir(join(executionPath, "node_modules", "tsx", "dist"), { recursive: true }),
      mkdir(join(executionPath, ".sandcastle"), { recursive: true }),
      mkdir(projectPath, { recursive: true }),
      writeFile(authPath, "{}\n"),
      writeFile(githubCredentialPath, "github_pat_cancellation_secret\n"),
    ]);
    await writeFile(join(executionPath, ".sandcastle", "main.mts"), "// pinned main\n");
    await writeFile(join(executionPath, "node_modules", "tsx", "dist", "cli.mjs"), `
import { writeSync } from "node:fs";
process.once("SIGTERM", () => {
  writeSync(3, JSON.stringify({
    type: "sandcastle.delivery.result",
    issueNumber: 262,
    status: "failed",
    code: "delivery_cancelled",
    completion: null,
  }) + "\\n");
  process.exit(1);
});
writeSync(3, JSON.stringify({
  type: "sandcastle.delivery.progress",
  issueNumber: 262,
  phase: "planning",
  label: "Plan issue #262",
  summary: "The scoped planner is ready for cancellation.",
  status: "running",
}) + "\\n");
setInterval(() => undefined, 10);
`);
    const controller = new AbortController();
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
    });
    await started;
    controller.abort(new Error("cancelled by Harness run"));

    const cancelled = await running;
    assert.equal(cancelled.termination, "cancelled");
    assert.equal(cancelled.result.status, "failed");
    assert.equal(cancelled.result.code, "delivery_cancelled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
