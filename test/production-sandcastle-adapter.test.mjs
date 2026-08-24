import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createHarnessRunManager } from "../src/harness-runs.mjs";
import { installCurrentPackage } from "./installed-package.mjs";
import {
  createProductionFixture,
  createProductionRegistration,
  execFileAsync,
  installReadyProbeCommands,
  observeProductionRunning,
  observeProductionTerminal,
  productionLaunchRequest,
  writeExecutable,
} from "./production-sandcastle-host-fixture.mjs";
import {
  installRealReadinessProcesses,
  REAL_READINESS_TEST_API_KEY,
} from "./real-readiness-processes.mjs";
import "./production-sandcastle-qualification.mjs";

const launchRequest = productionLaunchRequest;
const observeRunning = observeProductionRunning;
const observeTerminal = observeProductionTerminal;

const startInstalledProductionHost = async ({
  endpoint,
  installed,
  nodePath,
  preloadPath,
  registration,
}) => {
  const harnessRunsUrl = pathToFileURL(join(
    installed.packageDirectory,
    "src",
    "harness-runs.mjs",
  )).href;
  const projectRegistrationUrl = pathToFileURL(join(
    installed.packageDirectory,
    "src",
    "project-registration.mjs",
  )).href;
  const source = `
import { createServer } from "node:net";
import { createHarnessRunManager } from ${JSON.stringify(harnessRunsUrl)};
import { createProjectRegistry } from ${JSON.stringify(projectRegistrationUrl)};
const dataDir = ${JSON.stringify(registration.dataDir)};
const endpoint = ${JSON.stringify(endpoint)};
const projectId = ${JSON.stringify(registration.project.project.projectId)};
let auditSequence = 0;
const recordAudit = async (_action, _outcome, _details, requestedAuditId) =>
  requestedAuditId ?? \`audit-\${String(++auditSequence).padStart(24, "0")}\`;
const registry = await createProjectRegistry({ dataDir, recordAudit });
const manager = await createHarnessRunManager({
  dataDir,
  hostId: \`host-\${"7".repeat(24)}\`,
  recordAudit,
  loadLaunchContext: registry.loadLaunchContext,
});
const server = createServer((socket) => {
  socket.setEncoding("utf8");
  let input = "";
  socket.on("data", async (chunk) => {
    input += chunk;
    if (!input.includes("\\n")) return;
    try {
      const request = JSON.parse(input.slice(0, input.indexOf("\\n")));
      const outcome = request.operation === "describe"
        ? {
            type: "controller.cli.description",
            protocol: "1.0.0",
            command: "sandking launch",
            focusedProjectId: projectId,
            projectArgumentOptional: true,
            pluginRequired: false,
            launchParameters: ${JSON.stringify(registration.harness.harness.launchParameters)},
          }
        : await manager.launch({
            requestId: request.requestId,
            projectId,
            parameters: request.parameters ?? {},
            controllerId: \`runtime-\${"8".repeat(24)}\`,
            controllerSessionId: request.controllerSessionId,
            source: "controller-cli",
            authorizationClass: "harness_run_launch",
            idempotencyKeyHash: request.idempotencyKeyHash,
          });
      const succeeded = outcome.type === "controller.cli.description"
        || outcome.type === "harness.run.launch.result";
      socket.end(\`\${JSON.stringify({
        type: "sandking.cli.result",
        protocol: "1.0.0",
        requestId: request.requestId,
        ok: succeeded,
        ...(succeeded ? { outcome } : { failure: { code: outcome.code } }),
      })}\\n\`);
    } catch (error) {
      socket.destroy(error instanceof Error ? error : undefined);
    }
  });
});
process.once("SIGTERM", async () => {
  await manager.waitForIdle();
  server.close(() => process.exit(0));
});
server.listen(endpoint, () => process.stdout.write("ready\\n"));
`;
  const child = spawn(nodePath, [
    ...(preloadPath ? ["--import", pathToFileURL(preloadPath).href] : []),
    "--input-type=module",
    "--eval",
    source,
  ], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostic = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    diagnostic += chunk;
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`installed_readiness_host_timeout: ${diagnostic}`));
    }, 10_000);
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes("ready\n")) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (output.includes("ready\n")) return;
      clearTimeout(timeout);
      reject(new Error(
        `installed_readiness_host_exited: ${code ?? signal ?? "unknown"}: ${diagnostic}`,
      ));
    });
  });
  return {
    diagnostic: () => diagnostic,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGTERM");
      await exited;
    },
  };
};

const waitForPathState = async (path, exists) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await access(path).then(() => true, () => false);
    if (current === exists) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`production_provider_race_timeout:${path}:${exists}`);
};

const writeProviderMutationPause = async ({ mode, root, manifestPath }) => {
  const armPath = join(root, "arm-provider-mutation");
  const blockedPath = join(root, "provider-mutation-blocked");
  const claimedPath = join(root, "claimed-provider-mutation");
  const releasePath = join(root, "release-provider-mutation");
  const preloadPath = join(root, "pause-provider-mutation.mjs");
  await writeFile(preloadPath, `
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const manifestPath = ${JSON.stringify(manifestPath)};
const mode = ${JSON.stringify(mode)};
const originalAccess = fsPromises.access.bind(fsPromises);
const originalLink = fsPromises.link.bind(fsPromises);
const originalRename = fsPromises.rename.bind(fsPromises);
const originalRm = fsPromises.rm.bind(fsPromises);
const originalWriteFile = fsPromises.writeFile.bind(fsPromises);
const pause = async () => {
  try {
    await originalRename(${JSON.stringify(armPath)}, ${JSON.stringify(claimedPath)});
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await originalWriteFile(${JSON.stringify(blockedPath)}, "blocked\\n");
  while (await originalAccess(${JSON.stringify(releasePath)}).then(
    () => false,
    () => true,
  )) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
fsPromises.link = async (from, to, ...rest) => {
  if (mode === "creation" && String(to) === manifestPath) await pause();
  return originalLink(from, to, ...rest);
};
fsPromises.rename = async (from, to, ...rest) => {
  if (
    (mode === "creation" && String(to) === manifestPath)
    || (
      mode === "cleanup"
      && String(from) === manifestPath
      && await originalAccess(manifestPath).then(() => true, () => false)
    )
  ) await pause();
  return originalRename(from, to, ...rest);
};
fsPromises.rm = async (path, ...rest) => {
  if (mode === "cleanup" && String(path) === manifestPath) await pause();
  return originalRm(path, ...rest);
};
syncBuiltinESMExports();
`);
  return { armPath, blockedPath, preloadPath, releasePath };
};

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

test("restart reconciliation removes the selector retained across durable acceptance", async () => {
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

    const reconciled = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId: `host-${"1".repeat(24)}`,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      inspectInterruptedRunTermination: async () => ({
        platform: "linux",
        status: "confirmed",
      }),
    });
    await reconciled.waitForIdle();
    await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });
  } finally {
    await fixture?.manager.waitForIdle().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal production completion and later unavailable readiness leave no selector", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-provider-lifecycle-"));
  let restorePath = () => undefined;
  let fixture;
  try {
    restorePath = await installReadyProbeCommands(root);
    fixture = await createProductionFixture(root);
    const manifestPath = join(fixture.projectPath, "sandcastle.real-provider.json");
    const launched = await fixture.manager.launch(launchRequest(
      fixture.project.project.projectId,
      { idempotencyKeyHash: `sha256:${"6".repeat(64)}` },
    ));
    assert.equal(launched.type, "harness.run.launch.result", JSON.stringify(launched));
    const terminal = await observeTerminal(fixture.manager, launched.run.harnessRunId);
    assert.equal(terminal.run.status, "failed", JSON.stringify(terminal));
    await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });

    await writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      provider: { kind: "openai-codex", ready: true },
      scenario: "project-commit",
    }, null, 2)}\n`);
    restorePath();
    restorePath = () => undefined;
    const rejected = await fixture.manager.launch(launchRequest(
      fixture.project.project.projectId,
      {
        requestId: "launch-after-provider-became-unavailable",
        idempotencyKeyHash: `sha256:${"7".repeat(64)}`,
      },
    ));
    assert.equal(rejected.type, "harness.run.launch.failure");
    assert.equal(rejected.code, "harness_worker_provider_unavailable");
    await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });
  } finally {
    await fixture?.manager.waitForIdle().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter readiness releases the real-provider selector before terminal completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-provider-ready-cleanup-"));
  const releasePath = join(root, "release-dependency-install");
  let restorePath = () => undefined;
  let fixture;
  try {
    restorePath = await installReadyProbeCommands(root);
    await writeExecutable(join(root, "bin", "npm"), `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' '10.9.8'; exit 0; fi
if [ "$1" = "ci" ]; then
  trap 'exit 0' TERM INT
  while [ ! -f '${releasePath}' ]; do sleep 0.05; done
  exit 0
fi
exit 92
`);
    fixture = await createProductionFixture(root, null, { cancellationGraceMs: 1_000 });
    const manifestPath = join(fixture.projectPath, "sandcastle.real-provider.json");
    const launched = await fixture.manager.launch(launchRequest(
      fixture.project.project.projectId,
      { idempotencyKeyHash: `sha256:${"8".repeat(64)}` },
    ));
    assert.equal(launched.type, "harness.run.launch.result", JSON.stringify(launched));
    const running = await observeRunning(fixture.manager, launched.run.harnessRunId);
    assert.equal(running.run.status, "running");
    await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });

    await writeFile(releasePath, "release dependency installation\n");
    const terminal = await observeTerminal(
      fixture.manager,
      launched.run.harnessRunId,
    );
    assert.equal(terminal.run.status, "failed", JSON.stringify(terminal));
    assert.equal(terminal.outcome.code, "harness_run_failed");
  } finally {
    await writeFile(releasePath, "release dependency installation\n").catch(() => undefined);
    await fixture?.manager.waitForIdle().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("installed sandking launch rejects every named live readiness condition", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-public-readiness-"));
  try {
    const installed = await installCurrentPackage(root);
    for (const condition of [
      "missing-codex",
      "wrong-codex-version",
      "unauthenticated-codex",
      "unavailable-docker",
    ]) {
      await t.test(condition, async (scenario) => {
        const scenarioRoot = join(root, condition);
        const endpoint = join(scenarioRoot, "controller.sock");
        const userHome = join(scenarioRoot, "user-home");
        const retryDirectory = join(scenarioRoot, "controller-private");
        let host;
        let registration;
        let restoreProcesses = () => undefined;
        try {
          await Promise.all([
            mkdir(scenarioRoot, { recursive: true }),
            mkdir(userHome, { recursive: true }),
            mkdir(retryDirectory, { recursive: true }),
          ]);
          registration = await createProductionRegistration(scenarioRoot);
          const manifestPath = join(
            registration.projectPath,
            "sandcastle.real-provider.json",
          );
          const excludePath = join(registration.projectPath, ".git", "info", "exclude");
          const [excludeBefore, statusBefore, trackedBefore] = await Promise.all([
            readFile(excludePath, "utf8"),
            execFileAsync("git", [
              "-C", registration.projectPath,
              "status", "--porcelain=v1", "--untracked-files=all",
            ]).then(({ stdout }) => stdout),
            execFileAsync("git", [
              "-C", registration.projectPath, "ls-files", "--stage", "-z",
            ]).then(({ stdout }) => stdout),
          ]);
          const processes = await installRealReadinessProcesses({
            condition,
            homeDirectory: userHome,
            root: scenarioRoot,
          });
          restoreProcesses = processes.restore;
          if (!processes.supported) {
            if (process.env.CI === "true") {
              assert.fail(`required real readiness boundary unavailable: ${processes.reason}`);
            }
            scenario.skip(processes.reason);
            return;
          }
          if (condition === "missing-codex") {
            assert.deepEqual(processes.observation, { codex: "ENOENT" });
          } else if (condition === "wrong-codex-version") {
            assert.equal(processes.observation.version, "codex-cli 0.145.0");
            assert.deepEqual(processes.observation.authentication, {
              authenticated: true,
              exitCode: 0,
            });
          } else if (condition === "unauthenticated-codex") {
            assert.equal(processes.observation.version, "codex-cli 0.146.0");
            assert.equal(processes.observation.authentication.authenticated, false);
            assert.notEqual(processes.observation.authentication.exitCode, 0);
          } else {
            assert.equal(processes.observation.version, "codex-cli 0.146.0");
            assert.deepEqual(processes.observation.authentication, {
              authenticated: true,
              exitCode: 0,
            });
            assert.equal(processes.observation.docker, "daemon-unavailable");
          }
          const projectId = registration.project.project.projectId;
          const controllerSessionId = `controller-session-${"5".repeat(24)}`;
          host = await startInstalledProductionHost({
            endpoint,
            installed,
            nodePath: processes.nodePath,
            registration,
          });

          await assert.rejects(execFileAsync(installed.command, [
            "launch", projectId, "--json",
          ], {
            cwd: scenarioRoot,
            env: {
              ...process.env,
              HOME: userHome,
              SANDKING_CONTROLLER_ENDPOINT: endpoint,
              SANDKING_CONTROLLER_SESSION_ID: controllerSessionId,
              SANDKING_CONTROLLER_RETRY_DIRECTORY: retryDirectory,
              SANDKING_WORK_CONTEXT_ID: projectId,
            },
          }), (error) => {
            const stderr = `${error.stderr ?? ""}`;
            assert.match(stderr, /harness_worker_provider_unavailable/, condition);
            assert.equal(stderr.includes(scenarioRoot), false, condition);
            assert.equal(stderr.includes(REAL_READINESS_TEST_API_KEY), false, condition);
            assert.doesNotMatch(
              stderr,
              /Logged in|Not logged in|codex-cli|Docker daemon/i,
              condition,
            );
            return true;
          });
          await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });
          assert.equal(await readFile(excludePath, "utf8"), excludeBefore);
          assert.equal((await execFileAsync("git", [
            "-C", registration.projectPath,
            "status", "--porcelain=v1", "--untracked-files=all",
          ])).stdout, statusBefore);
          assert.equal((await execFileAsync("git", [
            "-C", registration.projectPath, "ls-files", "--stage", "-z",
          ])).stdout, trackedBefore);
          const retained = JSON.parse(await readFile(
            join(registration.dataDir, "harness-runs.json"),
            "utf8",
          ));
          assert.deepEqual(retained.runs, []);
        } finally {
          await host?.stop().catch(() => undefined);
          restoreProcesses();
        }
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed sandking launch preserves concurrent Project selector contents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-selector-races-"));
  let restorePath = () => undefined;
  try {
    const installed = await installCurrentPackage(root);
    restorePath = await installReadyProbeCommands(root);
    for (const mode of ["creation", "cleanup"]) {
      await t.test(mode, async () => {
        const scenarioRoot = join(root, mode);
        const endpoint = join(scenarioRoot, "controller.sock");
        const retryDirectory = join(scenarioRoot, "controller-private");
        const userHome = join(scenarioRoot, "user-home");
        const concurrentSource = `user-owned concurrent ${mode} content\n`;
        let host;
        let pause;
        try {
          await Promise.all([
            mkdir(retryDirectory, { recursive: true }),
            mkdir(userHome, { recursive: true }),
          ]);
          const registration = await createProductionRegistration(scenarioRoot);
          const projectId = registration.project.project.projectId;
          const manifestPath = join(
            registration.projectPath,
            "sandcastle.real-provider.json",
          );
          const excludePath = join(
            registration.projectPath,
            ".git",
            "info",
            "exclude",
          );
          const excludeBefore = await readFile(excludePath, "utf8");
          pause = await writeProviderMutationPause({
            mode,
            root: scenarioRoot,
            manifestPath,
          });
          await writeFile(pause.armPath, "armed\n");
          host = await startInstalledProductionHost({
            endpoint,
            installed,
            nodePath: process.execPath,
            preloadPath: pause.preloadPath,
            registration,
          });
          const launch = execFileAsync(installed.command, [
            "launch", projectId,
            "--issue", "256",
            "--target-branch", "sandcastle/issue-256",
            "--json",
          ], {
            cwd: scenarioRoot,
            env: {
              ...process.env,
              HOME: userHome,
              SANDKING_CONTROLLER_ENDPOINT: endpoint,
              SANDKING_CONTROLLER_SESSION_ID:
                `controller-session-${"5".repeat(24)}`,
              SANDKING_CONTROLLER_RETRY_DIRECTORY: retryDirectory,
              SANDKING_WORK_CONTEXT_ID: projectId,
            },
          });

          if (mode === "creation") {
            await waitForPathState(pause.blockedPath, true);
            await writeFile(manifestPath, concurrentSource);
            await writeFile(pause.releasePath, "release\n");
            await assert.rejects(launch, (error) => {
              assert.match(`${error.stderr ?? ""}`, /harness_projection_collision/);
              return true;
            });
            const retained = JSON.parse(await readFile(
              join(registration.dataDir, "harness-runs.json"),
              "utf8",
            ));
            assert.deepEqual(retained.runs, []);
          } else {
            const { stdout } = await launch;
            const launched = JSON.parse(stdout);
            assert.equal(
              launched.type,
              "harness.run.launch.result",
              JSON.stringify(launched),
            );
            await waitForPathState(pause.blockedPath, true);
            await writeFile(manifestPath, concurrentSource);
            await writeFile(pause.releasePath, "release\n");
            await waitForPathState(
              join(
                registration.dataDir,
                "production-provider-preparations.json",
              ),
              false,
            );
          }
          assert.equal(await readFile(manifestPath, "utf8"), concurrentSource);
          assert.equal(await readFile(excludePath, "utf8"), excludeBefore);
        } finally {
          if (pause) {
            await writeFile(pause.releasePath, "release\n").catch(() => undefined);
          }
          await host?.stop().catch(() => undefined);
        }
      });
    }
  } finally {
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
