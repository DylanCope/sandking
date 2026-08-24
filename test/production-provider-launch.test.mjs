import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  REAL_PROVIDER_CODEX_VERSION,
  REAL_PROVIDER_SANDBOX_IMAGE,
  probeRealProviderReadiness,
} from "../src/production-sandcastle-adapter/sandcastle-v4.mjs";
import {
  prepareProductionProviderLaunch,
  REAL_PROVIDER_MANIFEST_NAME,
  REAL_PROVIDER_MANIFEST_SOURCE,
} from "../src/production-provider-preparation.mjs";
import { createHarnessRunFixture } from "./harness-run-fixture.mjs";

const execFileAsync = promisify(execFile);
const hostId = `host-${"1".repeat(24)}`;
const requiredSkills = [
  "sandking.issue-implementation",
  "sandking.issue-planning",
  "sandking.pull-request-review",
  "sandking.real-delegation",
];

const productionPreparation = {
  resolvedSkills: requiredSkills.map((identity) => ({ identity })),
  executionRuntimeInputs: [{
    identity: "openai.codex-cli",
    version: REAL_PROVIDER_CODEX_VERSION,
  }],
};

const initializeProject = async (root) => {
  const projectPath = join(root, "project");
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
  await writeFile(join(projectPath, "README.md"), "tracked Project content\n");
  await execFileAsync("git", ["-C", projectPath, "add", "README.md"]);
  await execFileAsync("git", [
    "-C", projectPath,
    "-c", "user.name=Provider Preparation Fixture",
    "-c", "user.email=provider-preparation@sandking.invalid",
    "-c", "commit.gpgSign=false",
    "commit", "--quiet", "-m", "Initialize provider preparation Project",
  ]);
  return projectPath;
};

test("the shared real-provider probe requires exact Codex, auth, npm, Docker, and image readiness", () => {
  const calls = [];
  const execFileSync = (command, args) => {
    calls.push([command, ...args]);
    if (command === "codex") return `codex-cli ${REAL_PROVIDER_CODEX_VERSION}\n`;
    if (command === "npm") return "10.9.8\n";
    if (args[0] === "version") return "27.5.1\n";
    if (args[0] === "image") return `sha256:${"d".repeat(64)}\n`;
    throw new Error("unexpected_probe_command");
  };
  const spawnSync = (command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: "Logged in using fixture\n", stderr: "" };
  };
  const options = { environment: {}, execFileSync, platform: "linux", spawnSync };

  assert.equal(probeRealProviderReadiness(options), true);
  assert.deepEqual(calls, [
    ["codex", "--version"],
    ["codex", "login", "status"],
    ["npm", "--version"],
    ["docker", "version", "--format", "{{.Server.Version}}"],
    ["docker", "image", "inspect", REAL_PROVIDER_SANDBOX_IMAGE, "--format={{.Id}}"],
  ]);

  assert.equal(probeRealProviderReadiness({
    ...options,
    execFileSync: (command, args) => command === "codex"
      ? "codex-cli 0.145.0\n"
      : execFileSync(command, args),
  }), false);
  assert.equal(probeRealProviderReadiness({
    ...options,
    spawnSync: () => ({ status: 1, stdout: "", stderr: "Not logged in\n" }),
  }), false);
  assert.equal(probeRealProviderReadiness({
    ...options,
    execFileSync: (command, args) => command === "npm"
      ? (() => { throw new Error("npm_missing"); })()
      : execFileSync(command, args),
  }), false);
  assert.equal(probeRealProviderReadiness({
    ...options,
    execFileSync: (command, args) => command === "docker" && args[0] === "version"
      ? "not-a-server-version\n"
      : execFileSync(command, args),
  }), false);
  assert.equal(probeRealProviderReadiness({
    ...options,
    execFileSync: (command, args) => command === "docker" && args[0] === "image"
      ? "not-an-image-id\n"
      : execFileSync(command, args),
  }), false);
});

test("production provider preparation atomically writes one git-invisible real manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-provider-preparation-"));
  try {
    const projectPath = await initializeProject(root);
    const manifestPath = join(projectPath, REAL_PROVIDER_MANIFEST_NAME);
    const excludePath = join(projectPath, ".git", "info", "exclude");
    const statusBefore = (await execFileAsync("git", [
      "-C", projectPath, "status", "--porcelain=v1", "--untracked-files=all",
    ])).stdout;
    const trackedBefore = (await execFileAsync("git", [
      "-C", projectPath, "ls-files", "--stage", "-z",
    ])).stdout;
    const excludeBefore = await readFile(excludePath, "utf8");
    let probeCount = 0;

    const prepared = await prepareProductionProviderLaunch({
      projectPath,
      productionPreparation,
      probeRealProviderReadiness: () => {
        probeCount += 1;
        return true;
      },
    });

    assert.equal(prepared.providerKind, "openai-codex");
    assert.equal(prepared.manifestWritten, true);
    assert.equal(probeCount, 1);
    assert.equal(await readFile(manifestPath, "utf8"), REAL_PROVIDER_MANIFEST_SOURCE);
    await execFileAsync("git", [
      "-C", projectPath, "check-ignore", "--no-index", "--quiet", manifestPath,
    ]);
    assert.equal((await execFileAsync("git", [
      "-C", projectPath, "status", "--porcelain=v1", "--untracked-files=all",
    ])).stdout, statusBefore);
    assert.equal((await execFileAsync("git", [
      "-C", projectPath, "ls-files", "--stage", "-z",
    ])).stdout, trackedBefore);

    await prepared.rollback();
    await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });
    assert.equal(await readFile(excludePath, "utf8"), excludeBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unavailable production providers fail before any manifest or Git metadata write", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-provider-unavailable-"));
  try {
    const projectPath = await initializeProject(root);
    const manifestPath = join(projectPath, REAL_PROVIDER_MANIFEST_NAME);
    const excludePath = join(projectPath, ".git", "info", "exclude");
    const excludeBefore = await readFile(excludePath, "utf8");
    const statusBefore = (await execFileAsync("git", [
      "-C", projectPath, "status", "--porcelain=v1", "--untracked-files=all",
    ])).stdout;
    const trackedBefore = (await execFileAsync("git", [
      "-C", projectPath, "ls-files", "--stage", "-z",
    ])).stdout;

    await assert.rejects(
      prepareProductionProviderLaunch({
        projectPath,
        productionPreparation,
        probeRealProviderReadiness: () => false,
      }),
      { name: "ProductionProviderPreparationError", code: "harness_worker_provider_unavailable" },
    );
    await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });
    assert.equal(await readFile(excludePath, "utf8"), excludeBefore);
    assert.equal((await execFileAsync("git", [
      "-C", projectPath, "status", "--porcelain=v1", "--untracked-files=all",
    ])).stdout, statusBefore);
    assert.equal((await execFileAsync("git", [
      "-C", projectPath, "ls-files", "--stage", "-z",
    ])).stdout, trackedBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit controlled fixture is never masked by a manufactured real provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-controlled-provider-selection-"));
  try {
    const projectPath = await initializeProject(root);
    await writeFile(join(projectPath, "sandcastle.worker-fixture.json"), `${JSON.stringify({
      schemaVersion: 1,
      provider: { kind: "controlled-worker-fixture", ready: true },
      scenario: "succeeded",
    })}\n`);
    let probeCount = 0;
    const prepared = await prepareProductionProviderLaunch({
      projectPath,
      productionPreparation,
      probeRealProviderReadiness: () => {
        probeCount += 1;
        return true;
      },
    });

    assert.equal(prepared.providerKind, "controlled-worker-fixture");
    assert.equal(prepared.manifestWritten, false);
    assert.equal(probeCount, 0);
    await assert.rejects(
      readFile(join(projectPath, REAL_PROVIDER_MANIFEST_NAME), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conformance launches never probe or write the production provider manifest", async () => {
  let probeCount = 0;
  const fixture = await createHarnessRunFixture(
    "sandking-conformance-provider-isolation-",
    hostId,
    {
      probeRealProviderReadiness: () => {
        probeCount += 1;
        return true;
      },
    },
  );
  try {
    const launched = await fixture.manager.launch({
      requestId: "launch-conformance-with-production-probe",
      projectId: fixture.registered.project.projectId,
      parameters: { issueNumber: 256, targetBranch: "sandcastle/issue-256" },
      controllerId: `runtime-${"2".repeat(24)}`,
      controllerSessionId: `controller-session-${"3".repeat(24)}`,
      source: "controller-cli",
      authorizationClass: "harness_run_launch",
      idempotencyKey: "launch-conformance-with-production-probe",
    });
    assert.equal(launched.type, "harness.run.launch.result", JSON.stringify(launched));
    assert.equal(probeCount, 0);
    await assert.rejects(
      readFile(join(fixture.projectPath, REAL_PROVIDER_MANIFEST_NAME), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await fixture.manager.waitForIdle();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
