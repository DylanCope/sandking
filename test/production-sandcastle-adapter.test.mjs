import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import { createHarnessRunManager } from "../src/harness-runs.mjs";
import { REAL_PROVIDER_MANIFEST_SOURCE } from "../src/production-provider-preparation.mjs";
import { installCurrentPackage } from "./installed-package.mjs";
import {
  startInstalledProductionHost,
  waitForPathState,
  writeProviderMutationPause,
} from "./installed-production-host.mjs";
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
import "./github-credentials.qualification.mjs";
import "./production-github-failure-qualification.mjs";
import "./production-sandcastle-qualification.mjs";

const launchRequest = productionLaunchRequest;
const observeRunning = observeProductionRunning;
const observeTerminal = observeProductionTerminal;

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

test("terminal cleanup removes only its selector and later readiness preserves a lookalike", async () => {
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

    await writeFile(manifestPath, REAL_PROVIDER_MANIFEST_SOURCE);
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
    assert.equal(await readFile(manifestPath, "utf8"), REAL_PROVIDER_MANIFEST_SOURCE);
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
        const concurrentSource = mode === "cleanup"
          ? REAL_PROVIDER_MANIFEST_SOURCE
          : `user-owned concurrent ${mode} content\n`;
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
            const replacementPath = join(scenarioRoot, "concurrent-selector");
            await writeFile(replacementPath, concurrentSource);
            await rename(replacementPath, manifestPath);
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

test("installed sandking launch restores a captured Project selector after Host death", {
  skip: process.platform !== "linux"
    ? "the deterministic Host interruption uses a Linux process signal"
    : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-selector-capture-crash-"));
  const endpoint = join(root, "controller.sock");
  const retryDirectory = join(root, "controller-private");
  const userHome = join(root, "user-home");
  const concurrentSource = "user-owned concurrent replacement\n";
  let host;
  let pause;
  let restorePath = () => undefined;
  try {
    const installed = await installCurrentPackage(root);
    restorePath = await installReadyProbeCommands(root);
    await Promise.all([
      mkdir(retryDirectory, { recursive: true }),
      mkdir(userHome, { recursive: true }),
    ]);
    const registration = await createProductionRegistration(root);
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
      mode: "capture-crash",
      root,
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
    const { stdout } = await execFileAsync(installed.command, [
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
        SANDKING_CONTROLLER_SESSION_ID: `controller-session-${"5".repeat(24)}`,
        SANDKING_CONTROLLER_RETRY_DIRECTORY: retryDirectory,
        SANDKING_WORK_CONTEXT_ID: projectId,
      },
    });
    assert.equal(JSON.parse(stdout).type, "harness.run.launch.result");

    await waitForPathState(pause.blockedPath, true);
    const replacementPath = join(root, "concurrent-selector");
    await writeFile(replacementPath, concurrentSource);
    await rename(replacementPath, manifestPath);
    await writeFile(pause.releasePath, "release\n");
    await waitForPathState(pause.capturedPath, true);
    await host.kill();
    host = undefined;
    await rm(endpoint, { force: true });

    host = await startInstalledProductionHost({
      endpoint,
      installed,
      nodePath: process.execPath,
      registration,
    });
    await waitForPathState(
      join(registration.dataDir, "production-provider-preparations.json"),
      false,
    );

    assert.equal(await readFile(manifestPath, "utf8"), concurrentSource);
    assert.equal(await readFile(excludePath, "utf8"), excludeBefore);
    assert.deepEqual(
      (await readdir(join(registration.projectPath, ".git", "info")))
        .filter((name) => name.startsWith(".sandking-capture-")),
      [],
    );
  } finally {
    if (pause) {
      await writeFile(pause.releasePath, "release\n").catch(() => undefined);
      await writeFile(pause.capturedReleasePath, "release\n").catch(() => undefined);
    }
    await host?.stop().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("installed sandking launch preserves Git exclude edits at each commit boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-exclude-commit-races-"));
  let restorePath = () => undefined;
  try {
    const installed = await installCurrentPackage(root);
    restorePath = await installReadyProbeCommands(root);
    for (const phase of ["append", "cleanup"]) {
      await t.test(phase, async () => {
        const scenarioRoot = join(root, phase);
        const endpoint = join(scenarioRoot, "controller.sock");
        const retryDirectory = join(scenarioRoot, "controller-private");
        const userHome = join(scenarioRoot, "user-home");
        const userRule = `/user-added-at-${phase}-commit`;
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
            excludePath,
            manifestPath,
            mode: `exclude-${phase}`,
            root: scenarioRoot,
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

          if (phase === "append") {
            await waitForPathState(pause.blockedPath, true);
            await appendFile(excludePath, `${userRule}\n`);
            await writeFile(pause.releasePath, "release\n");
          }
          const launched = JSON.parse((await launch).stdout);
          assert.equal(launched.type, "harness.run.launch.result");
          if (phase === "cleanup") {
            await waitForPathState(pause.blockedPath, true);
            await appendFile(excludePath, `${userRule}\n`);
            await writeFile(pause.releasePath, "release\n");
          }
          await waitForPathState(
            join(registration.dataDir, "production-provider-preparations.json"),
            false,
          );

          assert.equal(
            await readFile(excludePath, "utf8"),
            `${excludeBefore}${userRule}\n`,
          );
          await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });
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
