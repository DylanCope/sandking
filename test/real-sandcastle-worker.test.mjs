import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { REAL_PROVIDER_EXECUTION_RUNTIME_INPUTS } from "../src/real-delegation-protocol.mjs";
import {
  REAL_DELEGATION_TIMEOUT_MS,
  REAL_SANDBOX_IMAGE,
  executeRealDelegation,
  parseRealDelegationInvocationParameters,
  runRealDelegation,
} from "../src/production-sandcastle-adapter/real-worker-v2.mjs";

const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const skillIdentities = [
  "sandking.issue-implementation",
  "sandking.issue-planning",
  "sandking.pull-request-review",
  "sandking.real-delegation",
];
const productionProviderRuntime = {
  dockerEndpoint: "unix:///run/user/1000/docker.sock",
  sandboxImageId: `sha256:${"c".repeat(64)}`,
};

const createPinnedFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-real-worker-"));
  const executionPath = join(root, "execution");
  const projectPath = join(root, "project");
  const authPath = join(root, "codex-auth.json");
  await Promise.all([
    mkdir(join(executionPath, ".sandcastle"), { recursive: true }),
    mkdir(projectPath, { recursive: true }),
    writeFile(authPath, "{}\n", { mode: 0o600 }),
  ]);
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
  await Promise.all([
    writeFile(join(executionPath, "worker-environment.json"), `${JSON.stringify({
      schemaVersion: 1,
      skillSetLockDigest: `sha256:${"b".repeat(64)}`,
      skillDiscovery: {
        ambient: "disabled",
        roots: ["worker-skills"],
        unlisted: "reject",
      },
      skills,
      executionRuntimeInputs: REAL_PROVIDER_EXECUTION_RUNTIME_INPUTS,
    })}\n`),
    writeFile(join(executionPath, "package-lock.json"), `${JSON.stringify({
      packages: {
        "node_modules/@ai-hero/sandcastle": {
          version: "0.12.0",
          resolved: "https://registry.npmjs.org/@ai-hero/sandcastle/-/sandcastle-0.12.0.tgz",
          integrity: "sha512-kdQ414rM8t1QiWeqZ3Klz4KSd0PqQG4bRVuqGpRDUomWhojSZkEAc1tbcEcThVmBEaHkCt8LmYR49vqEPNIoYQ==",
        },
      },
    })}\n`),
    writeFile(join(executionPath, ".sandcastle", "Dockerfile"), "FROM node:22-bookworm\n"),
  ]);
  return {
    root,
    executionPath,
    projectPath,
    authPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

const successfulAttestation = (issueNumber = 262) => ({
  exitCode: 0,
  signal: null,
  startFailed: false,
  termination: "completed",
  outputInvalid: false,
  resultCount: 1,
  result: {
    type: "sandcastle.delivery.result",
    issueNumber,
    status: "succeeded",
    code: "scoped_issue_completed",
    completion: {
      kind: "merged-pull-request",
      pullRequestNumber: 266,
      pullRequestUrl: "https://github.com/DylanCope/sandking/pull/266",
    },
  },
});

test("the standalone Worker rejects an out-of-range issue before credential decoding", () => {
  const encoded = Buffer.from(JSON.stringify({ issueNumber: 1_000_000_000 }), "utf8")
    .toString("base64url");
  assert.throws(
    () => parseRealDelegationInvocationParameters(encoded),
    /real_delegation_parameters_invalid/,
  );
});

for (const mode of ["project-pat", "host-gh-session"]) {
  test(`the real Worker delegates issue delivery with an isolated ${mode} credential`, async () => {
    const fixture = await createPinnedFixture();
    const token = mode === "project-pat"
      ? "github_pat_scoped_delivery_secret"
      : "gho_scoped_delivery_secret";
    let credentialPath;
    try {
      const progress = [];
      const result = await runRealDelegation({
        ...fixture,
        issueNumber: 262,
        productionProviderRuntime,
        githubCredential: { mode, token },
        signal: AbortSignal.timeout(5_000),
        onProgress: (message) => progress.push(message),
        runMain: async (options) => {
          credentialPath = options.githubCredentialPath;
          assert.equal(await readFile(credentialPath, "utf8"), `${token}\n`);
          assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
          assert.equal(options.issueNumber, 262);
          assert.equal(options.sandboxImage, `sha256:${"c".repeat(64)}`);
          assert.equal(options.dockerEndpoint, productionProviderRuntime.dockerEndpoint);
          options.onProgress({ phase: "review" });
          return successfulAttestation();
        },
      });

      assert.equal(progress.length, 1);
      assert.equal(result.code, "issue_delivery_completed");
      assert.equal(result.issueNumber, 262);
      assert.equal("artifact" in result, false);
      assert.equal("commit" in result, false);
      assert.deepEqual(result.skillDelivery, {
        ambient: "disabled",
        method: "pinned-main-orchestration-files",
        deliveredIdentities: skillIdentities.slice(0, 3),
      });
      assert.equal(result.sandbox.image, REAL_SANDBOX_IMAGE);
      assert.deepEqual(result.completionContract, {
        kind: "structured-main-attestation",
        timeoutSeconds: REAL_DELEGATION_TIMEOUT_MS / 1_000,
      });
      await assert.rejects(readFile(credentialPath, "utf8"), { code: "ENOENT" });
    } finally {
      await fixture.cleanup();
    }
  });
}

test("zero exit and diagnostic success text cannot replace main's completion attestation", async () => {
  const fixture = await createPinnedFixture();
  try {
    const outcome = await executeRealDelegation({
      ...fixture,
      issueNumber: 262,
      productionProviderRuntime,
      githubCredential: { mode: "project-pat", token: "github_pat_missing_attestation" },
      signal: AbortSignal.timeout(5_000),
      runMain: async () => ({
        exitCode: 0,
        signal: null,
        startFailed: false,
        termination: "completed",
        outputInvalid: false,
        resultCount: 0,
        result: null,
        diagnostic: "SUCCESS: merged and complete",
      }),
    });

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.result.code, "real_delegation_main_result_missing");
  } finally {
    await fixture.cleanup();
  }
});

for (const [name, main, expectedCode] of [
  ["review budget exhaustion", {
    ...successfulAttestation(),
    result: {
      type: "sandcastle.delivery.result",
      issueNumber: 262,
      status: "failed",
      code: "scoped_issue_incomplete",
      completion: null,
    },
  }, "scoped_issue_incomplete"],
  ["wall timeout", {
    ...successfulAttestation(),
    termination: "timed-out",
    result: null,
    resultCount: 0,
  }, "real_delegation_timed_out"],
  ["process interruption", {
    ...successfulAttestation(),
    termination: "interrupted",
    signal: "SIGKILL",
    result: null,
    resultCount: 0,
  }, "real_delegation_interrupted"],
]) {
  test(`${name} produces a typed failure`, async () => {
    const fixture = await createPinnedFixture();
    try {
      const outcome = await executeRealDelegation({
        ...fixture,
        issueNumber: 262,
        productionProviderRuntime,
        githubCredential: { mode: "project-pat", token: "github_pat_typed_failure" },
        signal: AbortSignal.timeout(5_000),
        runMain: async () => main,
      });
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.result.code, expectedCode);
    } finally {
      await fixture.cleanup();
    }
  });
}

test("failed real work preserves partial Project state", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "sandking-real-worker-partial-"));
  try {
    const partialPath = join(projectPath, "partial-real-worker-change.txt");
    const outcome = await executeRealDelegation({
      executionPath: projectPath,
      projectPath,
      issueNumber: 262,
      signal: AbortSignal.timeout(1_000),
      runDelegation: async () => {
        await writeFile(partialPath, "partial state remains inspectable\n");
        throw new Error("provider transcript must not become a result");
      },
    });

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.result.code, "real_provider_execution_failed");
    assert.equal(await readFile(partialPath, "utf8"), "partial state remains inspectable\n");
    assert.doesNotMatch(JSON.stringify(outcome), /provider transcript/i);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});
