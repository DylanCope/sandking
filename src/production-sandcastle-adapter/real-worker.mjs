import { execFile } from "node:child_process";
import { writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const REAL_PROVIDER_KIND = "openai-codex";
export const REAL_PROVIDER_MODEL = "gpt-5.6-sol";
export const REAL_PROVIDER_EFFORT = "medium";
export const REAL_DELEGATION_SKILL_ID = "sandking.real-delegation";
export const REAL_DELEGATION_ARTIFACT = "sandking-real-delegation.txt";
export const REAL_DELEGATION_CONTENT =
  "Real delegation through the pinned Sandcastle Harness.\n";
const SANDCASTLE_VERSION = "0.12.0";
const SANDCASTLE_RESOLVED =
  "https://registry.npmjs.org/@ai-hero/sandcastle/-/sandcastle-0.12.0.tgz";
const SANDCASTLE_INTEGRITY =
  "sha512-kdQ414rM8t1QiWeqZ3Klz4KSd0PqQG4bRVuqGpRDUomWhojSZkEAc1tbcEcThVmBEaHkCt8LmYR49vqEPNIoYQ==";
const CODEX_VERSION = "0.146.0";

const gitEnvironment = () => ({
  LANG: "C.UTF-8",
  ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
});

const git = async (projectPath, args) => (await execFileAsync(
  "git",
  ["-C", projectPath, ...args],
  { env: gitEnvironment(), timeout: 10_000, maxBuffer: 256_000 },
)).stdout.trim();

const loadPinnedInputs = async (executionPath) => {
  const [workerEnvironment, dependencyLock] = await Promise.all([
    readFile(join(executionPath, "worker-environment.json"), "utf8").then(JSON.parse),
    readFile(join(executionPath, "package-lock.json"), "utf8").then(JSON.parse),
  ]);
  const runtime = workerEnvironment.executionRuntimeInputs?.find(({ identity }) =>
    identity === "openai.codex-cli");
  const skill = workerEnvironment.skills?.find(({ identity }) =>
    identity === REAL_DELEGATION_SKILL_ID);
  const sandcastle = dependencyLock.packages?.["node_modules/@ai-hero/sandcastle"];
  if (
    workerEnvironment.schemaVersion !== 1
    || workerEnvironment.skillDiscovery?.ambient !== "disabled"
    || workerEnvironment.skillDiscovery?.unlisted !== "reject"
    || !/^sha256:[a-f0-9]{64}$/.test(workerEnvironment.skillSetLockDigest ?? "")
    || !Array.isArray(workerEnvironment.skills)
    || workerEnvironment.skills.length !== 4
    || runtime?.version !== CODEX_VERSION
    || skill?.path !== `worker-skills/${REAL_DELEGATION_SKILL_ID}/SKILL.md`
    || sandcastle?.version !== SANDCASTLE_VERSION
    || sandcastle?.resolved !== SANDCASTLE_RESOLVED
    || sandcastle?.integrity !== SANDCASTLE_INTEGRITY
  ) {
    throw new Error("pinned_real_worker_inputs_invalid");
  }
  return {
    skillSetLockDigest: workerEnvironment.skillSetLockDigest,
    resolvedSkillCount: workerEnvironment.skills.length,
    prompt: await readFile(join(executionPath, ...skill.path.split("/")), "utf8"),
  };
};

export const verifyRealDelegationCommit = async ({ projectPath, beforeCommit }) => {
  const [afterCommit, status, artifact] = await Promise.all([
    git(projectPath, ["rev-parse", "HEAD"]),
    git(projectPath, ["status", "--porcelain=v1", "--untracked-files=all"]),
    readFile(join(projectPath, REAL_DELEGATION_ARTIFACT), "utf8"),
  ]);
  if (
    afterCommit === beforeCommit
    || status !== ""
    || artifact !== REAL_DELEGATION_CONTENT
    || await git(projectPath, ["rev-parse", `${afterCommit}^`]) !== beforeCommit
    || await git(projectPath, [
      "diff-tree", "--no-commit-id", "--name-only", "-r", afterCommit,
    ]) !== REAL_DELEGATION_ARTIFACT
  ) {
    throw new Error("real_delegation_commit_invalid");
  }
  return afterCommit;
};

export const runRealDelegation = async ({
  executionPath,
  projectPath,
  signal,
  loadSandcastle = async () => Promise.all([
    import("@ai-hero/sandcastle"),
    import("@ai-hero/sandcastle/sandboxes/no-sandbox"),
  ]),
}) => {
  const pinned = await loadPinnedInputs(executionPath);
  const beforeCommit = await git(projectPath, ["rev-parse", "HEAD"]);
  if (
    await git(projectPath, ["status", "--porcelain=v1", "--untracked-files=all"]) !== ""
  ) {
    throw new Error("real_delegation_project_dirty");
  }
  const [sandcastle, sandboxProvider] = await loadSandcastle();
  const run = await sandcastle.run({
    agent: sandcastle.codex(REAL_PROVIDER_MODEL, {
      effort: REAL_PROVIDER_EFFORT,
      captureSessions: false,
    }),
    sandbox: sandboxProvider.noSandbox(),
    cwd: projectPath,
    branchStrategy: { type: "head" },
    prompt: pinned.prompt,
    maxIterations: 1,
    completionSignal: "<promise>COMPLETE</promise>",
    idleTimeoutSeconds: 600,
    completionTimeoutSeconds: 30,
    logging: {
      type: "file",
      path: join(executionPath, ".sandcastle", "logs", "real-delegation.log"),
    },
    signal,
    name: "pinned-real-delegation",
  });
  const afterCommit = await verifyRealDelegationCommit({ projectPath, beforeCommit });
  if (
    run.completionSignal !== "<promise>COMPLETE</promise>"
    || run.commits.length !== 1
    || run.commits[0]?.sha !== afterCommit
  ) {
    throw new Error("real_delegation_sandcastle_result_invalid");
  }
  return {
    schemaVersion: 1,
    kind: "sandcastle.delegation",
    code: "real_work_committed",
    provider: {
      kind: REAL_PROVIDER_KIND,
      model: REAL_PROVIDER_MODEL,
      effort: REAL_PROVIDER_EFFORT,
    },
    upstream: {
      package: "@ai-hero/sandcastle",
      version: SANDCASTLE_VERSION,
    },
    skillSetLockDigest: pinned.skillSetLockDigest,
    resolvedSkillCount: pinned.resolvedSkillCount,
    artifact: REAL_DELEGATION_ARTIFACT,
    commit: afterCommit,
  };
};

export const executeRealDelegation = async ({ runDelegation = runRealDelegation, ...options }) => {
  try {
    return {
      type: "sandcastle.worker.result",
      status: "succeeded",
      result: await runDelegation(options),
    };
  } catch {
    return {
      type: "sandcastle.worker.result",
      status: "failed",
      result: {
        schemaVersion: 1,
        kind: "sandcastle.delegation",
        code: "real_provider_execution_failed",
        provider: { kind: REAL_PROVIDER_KIND },
      },
    };
  }
};

const publish = (message) => {
  writeSync(3, `${JSON.stringify(message)}\n`);
};

const invokedPath = (process.argv[1] ?? "").replaceAll("\\", "/");
if (invokedPath.endsWith("/.sandcastle/real-worker.mjs")) {
  const projectPath = process.argv[2];
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort(new Error("real_worker_cancelled")));
  publish({
    type: "sandcastle.worker.progress",
    label: "Real Sandcastle Worker",
    summary: "The pinned upstream Sandcastle runtime invoked the configured real Worker provider.",
    status: "running",
  });
  const outcome = await executeRealDelegation({
    executionPath: process.cwd(),
    projectPath,
    signal: controller.signal,
  });
  if (outcome.status === "failed") {
    process.stderr.write("sandcastle_real_provider_execution_failed\n");
  }
  publish(outcome);
}
