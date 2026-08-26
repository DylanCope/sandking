import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { digest as sha256 } from "../src/common/digest.mjs";
import {
  REAL_PROVIDER_CODEX_VERSION,
  REAL_PROVIDER_SANDBOX_IMAGE,
  probeRealProviderReadiness,
} from "../src/production-sandcastle-adapter/sandcastle-v4.mjs";
import {
  prepareProductionProviderManifest,
  prepareProductionProviderLaunch,
  REAL_PROVIDER_MANIFEST_NAME,
  REAL_PROVIDER_MANIFEST_SOURCE,
} from "../src/production-provider-preparation.mjs";
import { ensureProductionProviderRuntime } from "../src/production-provider-runtime.mjs";
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
const defaultDockerEndpoint = "unix:///var/run/docker.sock";
const defaultSandboxImageId = `sha256:${"d".repeat(64)}`;

test("product preparation builds and verifies a missing pinned sandbox image", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-provider-image-"));
  try {
    const projectionPath = join(root, "projection");
    const dockerfilePath = join(projectionPath, ".sandcastle", "Dockerfile");
    const dockerfile = "FROM node:22-bookworm\n";
    const configurationIntegrity = sha256(dockerfile);
    await mkdir(join(projectionPath, ".sandcastle"), { recursive: true });
    await writeFile(dockerfilePath, dockerfile);
    const calls = [];
    let imageBuilt = false;
    const result = await ensureProductionProviderRuntime({
      projectionPath,
      productionPreparation,
      environment: { PATH: "/usr/bin:/bin", DOCKER_HOST: defaultDockerEndpoint },
      executeFile: async (command, args, options) => {
        calls.push({ command, args, options });
        if (args[0] === "image") {
          if (!imageBuilt) throw new Error("image_missing");
          return { stdout: `${JSON.stringify({
            Id: defaultSandboxImageId,
            Config: {
              Labels: {
                "org.sandking.production-sandbox.configuration-integrity":
                  configurationIntegrity,
                "org.sandking.production-sandbox.agent-uid":
                  String(process.getuid?.() ?? 1000),
                "org.sandking.production-sandbox.agent-gid":
                  String(process.getgid?.() ?? 1000),
              },
              User: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
            },
          })}\n`, stderr: "" };
        }
        imageBuilt = true;
        return { stdout: "", stderr: "" };
      },
      realProviderContract: {
        REAL_PROVIDER_CODEX_VERSION,
        REAL_PROVIDER_SANDBOX_CONFIGURATION: ".sandcastle/Dockerfile",
        REAL_PROVIDER_SANDBOX_IMAGE,
        REAL_PROVIDER_SKILL_IDENTITIES: requiredSkills,
        realProviderAvailable: () => true,
        realSandboxEngineAvailable: () => true,
        realSandboxImageAvailable: () => imageBuilt,
      },
    });

    assert.deepEqual(result, {
      ready: true,
      imageBuilt: true,
      dockerEndpoint: defaultDockerEndpoint,
      sandboxImageId: defaultSandboxImageId,
    });
    assert.equal(calls.length, 3);
    assert.equal(calls[1].command, "docker");
    assert.deepEqual(calls[1].args, [
      "build",
      "--build-arg", `AGENT_UID=${process.getuid?.() ?? 1000}`,
      "--build-arg", `AGENT_GID=${process.getgid?.() ?? 1000}`,
      "--label",
      `org.sandking.production-sandbox.configuration-integrity=${configurationIntegrity}`,
      "--label",
      `org.sandking.production-sandbox.agent-uid=${process.getuid?.() ?? 1000}`,
      "--label",
      `org.sandking.production-sandbox.agent-gid=${process.getgid?.() ?? 1000}`,
      "--tag", REAL_PROVIDER_SANDBOX_IMAGE,
      "--file", dockerfilePath,
      projectionPath,
    ]);
    assert.equal(calls[1].options.env.PATH, "/usr/bin:/bin");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("product preparation rebuilds a retained image from stale Dockerfile bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-provider-stale-image-"));
  try {
    const projectionPath = join(root, "projection");
    const dockerfilePath = join(projectionPath, ".sandcastle", "Dockerfile");
    const dockerfile = "FROM node:22-bookworm\nRUN printf current-runtime\n";
    const configurationIntegrity = sha256(dockerfile);
    await mkdir(join(projectionPath, ".sandcastle"), { recursive: true });
    await writeFile(dockerfilePath, dockerfile);
    const calls = [];
    let inspected = 0;
    const result = await ensureProductionProviderRuntime({
      projectionPath,
      productionPreparation,
      environment: { PATH: "/usr/bin:/bin", DOCKER_HOST: defaultDockerEndpoint },
      executeFile: async (command, args, options) => {
        calls.push({ command, args, options });
        if (args[0] === "image") {
          inspected += 1;
          return {
            stdout: `${JSON.stringify({
              Id: defaultSandboxImageId,
              Config: {
                Labels: {
                  "org.sandking.production-sandbox.configuration-integrity":
                    inspected === 1 ? `sha256:${"a".repeat(64)}` : configurationIntegrity,
                  "org.sandking.production-sandbox.agent-uid":
                    String(process.getuid?.() ?? 1000),
                  "org.sandking.production-sandbox.agent-gid":
                    String(process.getgid?.() ?? 1000),
                },
                User: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
              },
            })}\n`,
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      },
      realProviderContract: {
        REAL_PROVIDER_CODEX_VERSION,
        REAL_PROVIDER_SANDBOX_CONFIGURATION: ".sandcastle/Dockerfile",
        REAL_PROVIDER_SANDBOX_IMAGE,
        REAL_PROVIDER_SKILL_IDENTITIES: requiredSkills,
        realProviderAvailable: () => true,
        realSandboxEngineAvailable: () => true,
        realSandboxImageAvailable: () => true,
      },
    });

    assert.deepEqual(result, {
      ready: true,
      imageBuilt: true,
      dockerEndpoint: defaultDockerEndpoint,
      sandboxImageId: defaultSandboxImageId,
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].args, [
      "image", "inspect", REAL_PROVIDER_SANDBOX_IMAGE,
      "--format={{json .}}",
    ]);
    assert.ok(calls[1].args.includes(
      `org.sandking.production-sandbox.configuration-integrity=${configurationIntegrity}`,
    ));
    assert.deepEqual(calls[2].args, calls[0].args);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("product preparation rebuilds a retained image with another Host user's identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-provider-user-image-"));
  try {
    const projectionPath = join(root, "projection");
    const dockerfilePath = join(projectionPath, ".sandcastle", "Dockerfile");
    const dockerfile = "FROM node:22-bookworm\nARG AGENT_UID\nARG AGENT_GID\n";
    const configurationIntegrity = sha256(dockerfile);
    const expectedUid = process.getuid?.() ?? 1000;
    const expectedGid = process.getgid?.() ?? 1000;
    await mkdir(join(projectionPath, ".sandcastle"), { recursive: true });
    await writeFile(dockerfilePath, dockerfile);
    let imageBuilt = false;
    const calls = [];
    const result = await ensureProductionProviderRuntime({
      projectionPath,
      productionPreparation,
      environment: { PATH: "/usr/bin:/bin", DOCKER_HOST: defaultDockerEndpoint },
      executeFile: async (command, args, options) => {
        calls.push({ command, args, options });
        if (args[0] === "image") {
          return {
            stdout: `${JSON.stringify({
              Id: defaultSandboxImageId,
              Config: {
                Labels: {
                  "org.sandking.production-sandbox.configuration-integrity":
                    configurationIntegrity,
                  "org.sandking.production-sandbox.agent-uid": String(
                    imageBuilt ? expectedUid : expectedUid + 1,
                  ),
                  "org.sandking.production-sandbox.agent-gid": String(
                    imageBuilt ? expectedGid : expectedGid + 1,
                  ),
                },
                User: imageBuilt
                  ? `${expectedUid}:${expectedGid}`
                  : `${expectedUid + 1}:${expectedGid + 1}`,
              },
            })}\n`,
            stderr: "",
          };
        }
        imageBuilt = true;
        return { stdout: "", stderr: "" };
      },
      realProviderContract: {
        REAL_PROVIDER_CODEX_VERSION,
        REAL_PROVIDER_SANDBOX_CONFIGURATION: ".sandcastle/Dockerfile",
        REAL_PROVIDER_SANDBOX_IMAGE,
        REAL_PROVIDER_SKILL_IDENTITIES: requiredSkills,
        realProviderAvailable: () => true,
        realSandboxEngineAvailable: () => true,
        realSandboxImageAvailable: () => true,
      },
    });

    assert.deepEqual(result, {
      ready: true,
      imageBuilt: true,
      dockerEndpoint: defaultDockerEndpoint,
      sandboxImageId: defaultSandboxImageId,
    });
    assert.equal(calls.filter(({ args }) => args[0] === "build").length, 1);
    assert.ok(calls.some(({ args }) => args.includes(
      `org.sandking.production-sandbox.agent-uid=${expectedUid}`,
    )));
    assert.ok(calls.some(({ args }) => args.includes(
      `org.sandking.production-sandbox.agent-gid=${expectedGid}`,
    )));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider readiness binds the selected Docker endpoint to its validated image ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-provider-binding-"));
  try {
    const projectionPath = join(root, "projection");
    const dockerfilePath = join(projectionPath, ".sandcastle", "Dockerfile");
    const dockerfile = "FROM node:22-bookworm\n";
    const configurationIntegrity = sha256(dockerfile);
    const sandboxImageId = `sha256:${"e".repeat(64)}`;
    const dockerEndpoint = "unix:///run/user/1000/docker.sock";
    await mkdir(join(projectionPath, ".sandcastle"), { recursive: true });
    await writeFile(dockerfilePath, dockerfile);
    const calls = [];

    const result = await ensureProductionProviderRuntime({
      projectionPath,
      productionPreparation,
      environment: { PATH: "/usr/bin:/bin" },
      executeFile: async (command, args, options) => {
        calls.push({ command, args, options });
        if (args[0] === "context") {
          return { stdout: `${JSON.stringify(dockerEndpoint)}\n`, stderr: "" };
        }
        if (args[0] === "image") {
          return {
            stdout: `${JSON.stringify({
              Id: sandboxImageId,
              Config: {
                Labels: {
                  "org.sandking.production-sandbox.configuration-integrity":
                    configurationIntegrity,
                  "org.sandking.production-sandbox.agent-uid":
                    String(process.getuid?.() ?? 1000),
                  "org.sandking.production-sandbox.agent-gid":
                    String(process.getgid?.() ?? 1000),
                },
                User: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
              },
            })}\n`,
            stderr: "",
          };
        }
        throw new Error("unexpected_provider_runtime_command");
      },
      realProviderContract: {
        REAL_PROVIDER_CODEX_VERSION,
        REAL_PROVIDER_SANDBOX_CONFIGURATION: ".sandcastle/Dockerfile",
        REAL_PROVIDER_SANDBOX_IMAGE,
        REAL_PROVIDER_SKILL_IDENTITIES: requiredSkills,
        realProviderAvailable: () => true,
        realSandboxEngineAvailable: () => true,
        realSandboxImageAvailable: () => true,
      },
    });

    assert.deepEqual(result, {
      ready: true,
      imageBuilt: false,
      dockerEndpoint,
      sandboxImageId,
    });
    assert.deepEqual(calls.map(({ args }) => args), [
      ["context", "inspect", "--format={{json .Endpoints.docker.Host}}"],
      [
        "image", "inspect", REAL_PROVIDER_SANDBOX_IMAGE,
        "--format={{json .}}",
      ],
    ]);
    assert.equal(calls[1].options.env.DOCKER_HOST, dockerEndpoint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    const prepared = await prepareProductionProviderManifest({
      projectPath,
    });

    assert.equal(prepared.providerKind, "openai-codex");
    assert.equal(prepared.manifestWritten, true);
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

test("production provider cleanup preserves Git exclusions added during launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-provider-concurrent-exclude-"));
  try {
    const projectPath = await initializeProject(root);
    const manifestPath = join(projectPath, REAL_PROVIDER_MANIFEST_NAME);
    const excludePath = join(projectPath, ".git", "info", "exclude");
    const excludeBefore = await readFile(excludePath, "utf8");
    const prepared = await prepareProductionProviderManifest({ projectPath });

    await appendFile(excludePath, "/user-added-during-launch\n");
    await prepared.rollback();

    await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });
    assert.equal(
      await readFile(excludePath, "utf8"),
      `${excludeBefore}/user-added-during-launch\n`,
    );
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
        projectionPath: projectPath,
        productionPreparation: null,
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

test("a controlled fixture cannot bypass production real-provider preparation", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-controlled-provider-selection-"));
  try {
    const projectPath = await initializeProject(root);
    await writeFile(join(projectPath, "sandcastle.worker-fixture.json"), `${JSON.stringify({
      schemaVersion: 1,
      provider: { kind: "controlled-worker-fixture", ready: true },
      scenario: "succeeded",
    })}\n`);
    await assert.rejects(prepareProductionProviderLaunch({
      projectPath,
      projectionPath: projectPath,
      productionPreparation: null,
    }), {
      name: "ProductionProviderPreparationError",
      code: "harness_worker_provider_unavailable",
    });
    await assert.rejects(prepareProductionProviderManifest({ projectPath }), {
      name: "ProductionProviderPreparationError",
      code: "harness_projection_collision",
    });
    await assert.rejects(
      readFile(join(projectPath, REAL_PROVIDER_MANIFEST_NAME), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conformance launches remain successful without a production provider or manifest", async () => {
  const fixture = await createHarnessRunFixture(
    "sandking-conformance-provider-isolation-",
    hostId,
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
    await assert.rejects(
      readFile(join(fixture.projectPath, REAL_PROVIDER_MANIFEST_NAME), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await fixture.manager.waitForIdle();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
