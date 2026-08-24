import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { promisify } from "node:util";
import test from "node:test";
import { createHarnessRunManager } from "../src/harness-runs.mjs";
import { createProjectRegistry } from "../src/project-registration.mjs";
import { installCurrentPackage } from "./installed-package.mjs";

const execFileAsync = promisify(execFile);

const commitProject = async (projectPath, message) => {
  await execFileAsync("git", ["-C", projectPath, "add", "--all"]);
  await execFileAsync("git", [
    "-C", projectPath,
    "-c", "user.name=Production Adapter Fixture",
    "-c", "user.email=production-adapter@sandking.invalid",
    "-c", "commit.gpgSign=false",
    "commit", "--quiet", "-m", message,
  ]);
};

const writeControlledFixture = (projectPath, value) => writeFile(
  join(projectPath, "sandcastle.worker-fixture.json"),
  `${JSON.stringify(value, null, 2)}\n`,
);

const writeExecutable = async (path, source) => {
  await writeFile(path, source);
  await chmod(path, 0o700);
};

const installReadyProbeCommands = async (root) => {
  const binPath = join(root, "bin");
  const originalPath = process.env.PATH;
  await mkdir(binPath, { recursive: true });
  await Promise.all([
    writeExecutable(join(binPath, "codex"), `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 0.146.0'; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then printf '%s\\n' 'Logged in using fixture'; exit 0; fi
exit 91
`),
    writeExecutable(join(binPath, "npm"), `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' '10.9.8'; exit 0; fi
exit 92
`),
    writeExecutable(join(binPath, "docker"), `#!/bin/sh
if [ "$1" = "version" ] && [ "$2" = "--format" ]; then printf '%s\\n' '27.5.1'; exit 0; fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ] && [ "$3" = "sandcastle:sandking-real-worker" ]; then
  printf '%s\\n' 'sha256:${"d".repeat(64)}'
  exit 0
fi
exit 93
`),
  ]);
  process.env.PATH = `${binPath}:${originalPath ?? ""}`;
  return () => {
    process.env.PATH = originalPath;
  };
};

const createProductionFixture = async (root, controlledFixture = null, managerOptions = {}) => {
  const dataDir = join(root, "host-state");
  const projectPath = join(root, "project");
  await mkdir(projectPath, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
  await writeFile(join(projectPath, "README.md"), "production Project\n");
  if (controlledFixture) await writeControlledFixture(projectPath, controlledFixture);
  await commitProject(projectPath, "Initialize production Project");

  const audits = [];
  const recordAudit = async (action, outcome, details, requestedAuditId) => {
    const auditId = requestedAuditId
      ?? `audit-${String(audits.length + 1).padStart(24, "0")}`;
    audits.push({ auditId, action, outcome, details });
    return auditId;
  };
  const registry = await createProjectRegistry({ dataDir, recordAudit });
  const harness = await registry.registerSandcastleHarness({
    requestId: "register-production-harness",
    name: "Sand-King Sandcastle Harness",
    authorizationClass: "host_local_harness_registration",
    idempotencyKey: "register-production-harness",
    expectedRevision: 0,
  });
  const project = await registry.registerProject({
    requestId: "register-production-project",
    path: projectPath,
    configuration: {
      issueWorkflow: { provider: "github", kind: "issues" },
      checks: [{ checkId: "test", command: "npm test" }],
    },
    authorizationClass: "host_local_project_registration",
    idempotencyKey: "register-production-project",
    expectedRevision: 0,
  });
  const pinned = await registry.pinHarness({
    requestId: "pin-production-harness",
    projectId: project.project.projectId,
    harnessId: harness.harness.harnessId,
    boundedConfiguration: {
      adapterProtocol: "1.0.0",
      launchProfile: "delegated-work",
    },
    authorizationClass: "host_local_project_configuration",
    idempotencyKey: "pin-production-harness",
    expectedRevision: 1,
  });
  const manager = await createHarnessRunManager({
    dataDir,
    hostId: `host-${"1".repeat(24)}`,
    recordAudit,
    loadLaunchContext: registry.loadLaunchContext,
    ...managerOptions,
  });
  return {
    audits,
    dataDir,
    harness,
    manager,
    pinned,
    project,
    projectPath,
    recordAudit,
    registry,
  };
};

const launchRequest = (projectId, overrides = {}) => ({
  requestId: "launch-production-work",
  projectId,
  parameters: {},
  controllerId: `runtime-${"2".repeat(24)}`,
  controllerSessionId: `controller-session-${"3".repeat(24)}`,
  source: "controller-cli",
  authorizationClass: "harness_run_launch",
  idempotencyKeyHash: `sha256:${"4".repeat(64)}`,
  ...overrides,
});

test("unavailable real providers reject the Host launch before a run, manifest, or adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-host-provider-unavailable-"));
  const providerHome = join(root, "provider-home");
  const originalHome = process.env.HOME;
  let fixture;
  try {
    await mkdir(providerHome, { recursive: true });
    process.env.HOME = providerHome;
    fixture = await createProductionFixture(root);
    const manifestPath = join(fixture.projectPath, "sandcastle.real-provider.json");
    const excludePath = join(fixture.projectPath, ".git", "info", "exclude");
    const excludeBefore = await readFile(excludePath, "utf8");
    const statusBefore = (await execFileAsync("git", [
      "-C", fixture.projectPath, "status", "--porcelain=v1", "--untracked-files=all",
    ])).stdout;
    const trackedBefore = (await execFileAsync("git", [
      "-C", fixture.projectPath, "ls-files", "--stage", "-z",
    ])).stdout;

    const rejected = await fixture.manager.launch(launchRequest(
      fixture.project.project.projectId,
    ));
    assert.equal(rejected.type, "harness.run.launch.failure");
    assert.equal(rejected.code, "harness_worker_provider_unavailable");
    assert.equal(rejected.retryable, true);
    assert.deepEqual(rejected.prohibitedSideEffects, {
      harnessRunCreated: false,
      adapterStarted: false,
      projectWrite: false,
    });
    await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });
    assert.equal(await readFile(excludePath, "utf8"), excludeBefore);
    assert.equal((await execFileAsync("git", [
      "-C", fixture.projectPath, "status", "--porcelain=v1", "--untracked-files=all",
    ])).stdout, statusBefore);
    assert.equal((await execFileAsync("git", [
      "-C", fixture.projectPath, "ls-files", "--stage", "-z",
    ])).stdout, trackedBefore);
    assert.equal(fixture.audits.some(({ action }) => action === "harness.adapter.start"), false);
    const retained = JSON.parse(await readFile(
      join(fixture.dataDir, "harness-runs.json"),
      "utf8",
    ));
    assert.deepEqual(retained.runs, []);
  } finally {
    await fixture?.manager.waitForIdle().catch(() => undefined);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("a post-probe adapter rejection rolls back the manifest and its new exclude rule", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-provider-rollback-"));
  let restorePath = () => undefined;
  let fixture;
  try {
    restorePath = await installReadyProbeCommands(root);
    fixture = await createProductionFixture(root);
    const launchContext = await fixture.registry.loadLaunchContext(
      fixture.project.project.projectId,
    );
    fixture.manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId: `host-${"1".repeat(24)}`,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: async () => structuredClone(launchContext),
    });
    const projectionPath = join(
      fixture.projectPath,
      ...fixture.pinned.project.harness.preparation.projection.path.split("/"),
    );
    const workerEnvironmentPath = join(projectionPath, "worker-environment.json");
    await writeExecutable(join(root, "bin", "docker"), `#!/bin/sh
if [ "$1" = "version" ] && [ "$2" = "--format" ]; then printf '%s\\n' '27.5.1'; exit 0; fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ] && [ "$3" = "sandcastle:sandking-real-worker" ]; then
  sed -i 's/0.146.0/0.145.0/' '${workerEnvironmentPath}'
  printf '%s\\n' 'sha256:${"d".repeat(64)}'
  exit 0
fi
exit 93
`);
    const manifestPath = join(fixture.projectPath, "sandcastle.real-provider.json");
    const excludePath = join(fixture.projectPath, ".git", "info", "exclude");
    const excludeBefore = await readFile(excludePath, "utf8");

    const rejected = await fixture.manager.launch(launchRequest(
      fixture.project.project.projectId,
      { idempotencyKeyHash: `sha256:${"d".repeat(64)}` },
    ));
    assert.equal(rejected.type, "harness.run.launch.failure");
    assert.equal(rejected.code, "harness_worker_provider_unavailable");
    await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });
    assert.equal(await readFile(excludePath, "utf8"), excludeBefore);
    assert.equal(fixture.audits.some(({ action }) => action === "harness.adapter.start"), false);
    const retained = JSON.parse(await readFile(
      join(fixture.dataDir, "harness-runs.json"),
      "utf8",
    ));
    assert.deepEqual(retained.runs, []);
  } finally {
    await fixture?.manager.waitForIdle().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("a durably accepted production launch retains its manifest for Host reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-provider-reconciliation-"));
  let restorePath = () => undefined;
  let fixture;
  try {
    restorePath = await installReadyProbeCommands(root);
    fixture = await createProductionFixture(root, null, {
      faultInjector: (point) => {
        if (point === "harness_run_launch.after_state_commit") {
          throw new Error("simulate_host_loss_after_durable_acceptance");
        }
      },
    });
    const manifestPath = join(fixture.projectPath, "sandcastle.real-provider.json");

    await assert.rejects(
      fixture.manager.launch(launchRequest(fixture.project.project.projectId, {
        idempotencyKeyHash: `sha256:${"e".repeat(64)}`,
      })),
      /simulate_host_loss_after_durable_acceptance/,
    );
    assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), {
      schemaVersion: 1,
      provider: { kind: "openai-codex", ready: true },
      scenario: "project-commit",
    });
    const retained = JSON.parse(await readFile(
      join(fixture.dataDir, "harness-runs.json"),
      "utf8",
    ));
    assert.equal(retained.runs.length, 1);
    assert.equal(retained.runs[0].status, "starting");
  } finally {
    await fixture?.manager.waitForIdle().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("installed sandking launch reaches real readiness and cannot select a controlled Worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-installed-cli-"));
  const endpoint = join(root, "controller.sock");
  const providerHome = join(root, "provider-home");
  const originalHome = process.env.HOME;
  let server;
  let fixture;
  try {
    await mkdir(providerHome, { recursive: true });
    process.env.HOME = providerHome;
    fixture = await createProductionFixture(root, {
      schemaVersion: 1,
      provider: { kind: "controlled-worker-fixture", ready: true },
      scenario: "succeeded",
    });
    const projectId = fixture.project.project.projectId;
    const controllerSessionId = `controller-session-${"5".repeat(24)}`;
    const requests = [];
    server = createServer((socket) => {
      socket.setEncoding("utf8");
      let input = "";
      socket.on("data", async (chunk) => {
        input += chunk;
        if (!input.includes("\n")) return;
        try {
          const request = JSON.parse(input.slice(0, input.indexOf("\n")));
          requests.push(request);
          if (request.operation === "describe") {
            socket.end(`${JSON.stringify({
              type: "sandking.cli.result",
              protocol: "1.0.0",
              requestId: request.requestId,
              ok: true,
              outcome: {
                type: "controller.cli.description",
                protocol: "1.0.0",
                command: "sandking launch",
                focusedProjectId: projectId,
                projectArgumentOptional: true,
                pluginRequired: false,
                launchParameters: fixture.harness.harness.launchParameters,
              },
            })}\n`);
            return;
          }
          if (request.operation !== "harness-run.launch") {
            throw new Error("unexpected_controller_cli_operation");
          }
          const outcome = await fixture.manager.launch({
            requestId: request.requestId,
            projectId,
            parameters: request.parameters ?? {},
            controllerId: `runtime-${"6".repeat(24)}`,
            controllerSessionId: request.controllerSessionId,
            source: "controller-cli",
            authorizationClass: "harness_run_launch",
            idempotencyKeyHash: request.idempotencyKeyHash,
          });
          assert.equal(outcome.type, "harness.run.launch.failure");
          socket.end(`${JSON.stringify({
            type: "sandking.cli.result",
            protocol: "1.0.0",
            requestId: request.requestId,
            ok: false,
            failure: { code: outcome.code },
          })}\n`);
        } catch (error) {
          socket.destroy(error instanceof Error ? error : undefined);
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    const installed = await installCurrentPackage(root);
    const retryDirectory = join(root, "controller-private");
    const userHome = join(root, "user-home");
    await Promise.all([
      mkdir(retryDirectory, { recursive: true }),
      mkdir(userHome, { recursive: true }),
    ]);

    await assert.rejects(execFileAsync(installed.command, [
      "launch", projectId,
      "--issue", "256",
      "--target-branch", "sandcastle/issue-256",
      "--json",
    ], {
      cwd: root,
      env: {
        ...process.env,
        HOME: userHome,
        SANDKING_CONTROLLER_ENDPOINT: endpoint,
        SANDKING_CONTROLLER_SESSION_ID: controllerSessionId,
        SANDKING_CONTROLLER_RETRY_DIRECTORY: retryDirectory,
        SANDKING_WORK_CONTEXT_ID: projectId,
      },
    }), (error) => {
      assert.match(error.stderr, /harness_worker_provider_unavailable/);
      return true;
    });
    assert.deepEqual(requests.map(({ operation }) => operation), [
      "describe",
      "harness-run.launch",
    ]);
    await assert.rejects(
      readFile(join(fixture.projectPath, "sandcastle.real-provider.json"), "utf8"),
      { code: "ENOENT" },
    );
    assert.equal(fixture.audits.some(({ action }) => action === "harness.adapter.start"), false);
    const retained = JSON.parse(await readFile(
      join(fixture.dataDir, "harness-runs.json"),
      "utf8",
    ));
    assert.deepEqual(retained.runs, []);
  } finally {
    await fixture?.manager.waitForIdle().catch(() => undefined);
    await new Promise((resolve) => server?.close(resolve) ?? resolve());
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  }
});
