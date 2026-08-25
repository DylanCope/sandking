import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { REAL_PROVIDER_MANIFEST_SOURCE } from "../src/production-provider-preparation.mjs";
import { installCurrentPackage } from "./installed-package.mjs";
import {
  installedProductionLaunchArguments,
  installedProductionLaunchEnvironment,
  listProjectPreparationDebris,
  startInstalledProductionHost,
  waitForPathState,
  writeProviderMutationPause,
} from "./installed-production-host.mjs";
import {
  createProductionRegistration,
  execFileAsync,
  installReadyProbeCommands,
} from "./production-sandcastle-host-fixture.mjs";

test("installed launch preserves a Git exclusion written through a pre-capture descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-exclude-open-descriptor-"));
  const endpoint = join(root, "controller.sock");
  const retryDirectory = join(root, "controller-private");
  const userHome = join(root, "user-home");
  const target = "open-descriptor-target";
  const priorRule = `/${target}`;
  const lateRule = `!${priorRule}`;
  let descriptor;
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
    const excludePath = join(registration.projectPath, ".git", "info", "exclude");
    await appendFile(excludePath, `${priorRule}\n`);
    const excludeBefore = await readFile(excludePath, "utf8");
    descriptor = await open(excludePath, "a");
    pause = await writeProviderMutationPause({
      excludePath,
      manifestPath,
      mode: "exclude-after-capture",
      root,
    });
    await writeFile(pause.armPath, "armed\n");
    host = await startInstalledProductionHost({
      endpoint,
      installed,
      nodePath: process.execPath,
      preloadPath: pause.preloadPath,
      registration,
    });

    const launch = execFileAsync(installed.command, installedProductionLaunchArguments(projectId), {
      cwd: root,
      env: installedProductionLaunchEnvironment({
        endpoint,
        projectId,
        retryDirectory,
        userHome,
      }),
    });
    await waitForPathState(pause.blockedPath, true);
    await descriptor.appendFile(`${lateRule}\n`);
    await descriptor.sync();
    await descriptor.close();
    descriptor = undefined;
    await writeFile(pause.releasePath, "release\n");
    assert.equal(JSON.parse((await launch).stdout).type, "harness.run.launch.result");
    await waitForPathState(
      join(registration.dataDir, "production-provider-preparations.json"),
      false,
    );

    assert.equal(await readFile(excludePath, "utf8"), `${excludeBefore}${lateRule}\n`);
    await writeFile(join(registration.projectPath, target), "exposed Project file\n");
    await assert.rejects(execFileAsync("git", [
      "-C", registration.projectPath,
      "check-ignore", "--no-index", "--quiet", target,
    ]), { code: 1 });
    await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });
    assert.deepEqual(await listProjectPreparationDebris(registration.projectPath), []);
  } finally {
    await descriptor?.close().catch(() => undefined);
    if (pause) await writeFile(pause.releasePath, "release\n").catch(() => undefined);
    await host?.stop().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("installed launch restores a selector changed through its pre-capture descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-selector-open-descriptor-"));
  const endpoint = join(root, "controller.sock");
  const retryDirectory = join(root, "controller-private");
  const userHome = join(root, "user-home");
  const lateSource = "user-owned descriptor content\n";
  let descriptor;
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
    const excludePath = join(registration.projectPath, ".git", "info", "exclude");
    const excludeBefore = await readFile(excludePath, "utf8");
    pause = await writeProviderMutationPause({
      excludePath,
      manifestPath,
      mode: "selector-open-descriptor",
      root,
    });
    await writeFile(pause.armPath, "armed\n");
    host = await startInstalledProductionHost({
      endpoint,
      installed,
      nodePath: process.execPath,
      preloadPath: pause.preloadPath,
      registration,
    });

    const launch = execFileAsync(installed.command, installedProductionLaunchArguments(projectId), {
      cwd: root,
      env: installedProductionLaunchEnvironment({
        endpoint,
        projectId,
        retryDirectory,
        userHome,
      }),
    });
    assert.equal(JSON.parse((await launch).stdout).type, "harness.run.launch.result");
    await waitForPathState(pause.blockedPath, true);
    descriptor = await open(manifestPath, "a");
    await writeFile(pause.releasePath, "release\n");
    await waitForPathState(pause.reconciliationBlockedPath, true);
    await descriptor.appendFile(lateSource);
    await descriptor.sync();
    await descriptor.close();
    descriptor = undefined;
    await writeFile(pause.reconciliationReleasePath, "release\n");
    await waitForPathState(
      join(registration.dataDir, "production-provider-preparations.json"),
      false,
    );

    assert.equal(
      await readFile(manifestPath, "utf8"),
      `${REAL_PROVIDER_MANIFEST_SOURCE}${lateSource}`,
    );
    assert.equal(await readFile(excludePath, "utf8"), excludeBefore);
    assert.deepEqual(await listProjectPreparationDebris(registration.projectPath), []);
  } finally {
    await descriptor?.close().catch(() => undefined);
    if (pause) {
      await writeFile(pause.releasePath, "release\n").catch(() => undefined);
      await writeFile(pause.reconciliationReleasePath, "release\n")
        .catch(() => undefined);
    }
    await host?.stop().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("installed launch preserves a Git exclusion changed at captured-generation release", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-exclude-release-descriptor-"));
  const endpoint = join(root, "controller.sock");
  const retryDirectory = join(root, "controller-private");
  const userHome = join(root, "user-home");
  const target = "release-descriptor-target";
  const priorRule = `/${target}`;
  const lateRule = `!${priorRule}`;
  let descriptor;
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
    const excludePath = join(registration.projectPath, ".git", "info", "exclude");
    await appendFile(excludePath, `${priorRule}\n`);
    const excludeBefore = await readFile(excludePath, "utf8");
    descriptor = await open(excludePath, "a");
    pause = await writeProviderMutationPause({
      excludePath,
      manifestPath,
      mode: "exclude-post-refresh-descriptor",
      root,
    });
    await writeFile(pause.armPath, "armed\n");
    host = await startInstalledProductionHost({
      endpoint,
      installed,
      nodePath: process.execPath,
      preloadPath: pause.preloadPath,
      registration,
    });

    const launch = execFileAsync(installed.command, installedProductionLaunchArguments(projectId), {
      cwd: root,
      env: installedProductionLaunchEnvironment({
        endpoint,
        projectId,
        retryDirectory,
        userHome,
      }),
    });
    await waitForPathState(pause.blockedPath, true);
    await descriptor.appendFile(`${lateRule}\n`);
    await descriptor.sync();
    await descriptor.close();
    descriptor = undefined;
    await writeFile(pause.releasePath, "release\n");
    assert.equal(JSON.parse((await launch).stdout).type, "harness.run.launch.result");
    await waitForPathState(
      join(registration.dataDir, "production-provider-preparations.json"),
      false,
    );

    assert.equal(await readFile(excludePath, "utf8"), `${excludeBefore}${lateRule}\n`);
    await writeFile(join(registration.projectPath, target), "exposed Project file\n");
    await assert.rejects(execFileAsync("git", [
      "-C", registration.projectPath,
      "check-ignore", "--no-index", "--quiet", target,
    ]), { code: 1 });
    await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });
    assert.deepEqual(await listProjectPreparationDebris(registration.projectPath), []);
  } finally {
    await descriptor?.close().catch(() => undefined);
    if (pause) await writeFile(pause.releasePath, "release\n").catch(() => undefined);
    await host?.stop().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("installed launch restores a selector changed at captured-generation release", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-selector-release-descriptor-"));
  const endpoint = join(root, "controller.sock");
  const retryDirectory = join(root, "controller-private");
  const userHome = join(root, "user-home");
  const lateSource = "user-owned release descriptor content\n";
  let descriptor;
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
    const excludePath = join(registration.projectPath, ".git", "info", "exclude");
    const excludeBefore = await readFile(excludePath, "utf8");
    pause = await writeProviderMutationPause({
      excludePath,
      manifestPath,
      mode: "selector-post-refresh-descriptor",
      root,
    });
    await writeFile(pause.armPath, "armed\n");
    host = await startInstalledProductionHost({
      endpoint,
      installed,
      nodePath: process.execPath,
      preloadPath: pause.preloadPath,
      registration,
    });

    const launch = execFileAsync(installed.command, installedProductionLaunchArguments(projectId), {
      cwd: root,
      env: installedProductionLaunchEnvironment({
        endpoint,
        projectId,
        retryDirectory,
        userHome,
      }),
    });
    assert.equal(JSON.parse((await launch).stdout).type, "harness.run.launch.result");
    await waitForPathState(pause.blockedPath, true);
    descriptor = await open(manifestPath, "a");
    await writeFile(pause.releasePath, "release\n");
    await waitForPathState(pause.reconciliationBlockedPath, true);
    await descriptor.appendFile(lateSource);
    await descriptor.sync();
    await descriptor.close();
    descriptor = undefined;
    await writeFile(pause.reconciliationReleasePath, "release\n");
    await waitForPathState(
      join(registration.dataDir, "production-provider-preparations.json"),
      false,
    );

    assert.equal(
      await readFile(manifestPath, "utf8"),
      `${REAL_PROVIDER_MANIFEST_SOURCE}${lateSource}`,
    );
    assert.equal(await readFile(excludePath, "utf8"), excludeBefore);
    assert.deepEqual(await listProjectPreparationDebris(registration.projectPath), []);
  } finally {
    await descriptor?.close().catch(() => undefined);
    if (pause) {
      await writeFile(pause.releasePath, "release\n").catch(() => undefined);
      await writeFile(pause.reconciliationReleasePath, "release\n")
        .catch(() => undefined);
    }
    await host?.stop().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("Host restart restores a selector changed while its private release guard is active", {
  skip: process.platform !== "linux"
    ? "the deterministic Host interruption uses a Linux process signal"
    : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-selector-release-restart-"));
  const endpoint = join(root, "controller.sock");
  const retryDirectory = join(root, "controller-private");
  const userHome = join(root, "user-home");
  const lateSource = "user-owned release-guard content\n";
  let descriptor;
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
    const excludePath = join(registration.projectPath, ".git", "info", "exclude");
    const excludeBefore = await readFile(excludePath, "utf8");
    pause = await writeProviderMutationPause({
      excludePath,
      manifestPath,
      mode: "selector-release-guard-crash",
      root,
    });
    await writeFile(pause.armPath, "armed\n");
    host = await startInstalledProductionHost({
      endpoint,
      installed,
      nodePath: process.execPath,
      preloadPath: pause.preloadPath,
      registration,
    });

    const launch = execFileAsync(installed.command, installedProductionLaunchArguments(projectId), {
      cwd: root,
      env: installedProductionLaunchEnvironment({
        endpoint,
        projectId,
        retryDirectory,
        userHome,
      }),
    });
    assert.equal(JSON.parse((await launch).stdout).type, "harness.run.launch.result");
    await waitForPathState(pause.blockedPath, true);
    descriptor = await open(manifestPath, "a");
    await writeFile(pause.releasePath, "release\n");
    await waitForPathState(pause.capturedPath, true);
    await descriptor.appendFile(lateSource);
    await descriptor.sync();
    await descriptor.close();
    descriptor = undefined;
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

    assert.equal(
      await readFile(manifestPath, "utf8"),
      `${REAL_PROVIDER_MANIFEST_SOURCE}${lateSource}`,
    );
    assert.equal(await readFile(excludePath, "utf8"), excludeBefore);
    assert.deepEqual(await listProjectPreparationDebris(registration.projectPath), []);
  } finally {
    await descriptor?.close().catch(() => undefined);
    if (pause) {
      await writeFile(pause.releasePath, "release\n").catch(() => undefined);
      await writeFile(pause.capturedReleasePath, "release\n").catch(() => undefined);
    }
    await host?.stop().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("Host restart resumes an open-descriptor Git exclusion rollback", {
  skip: process.platform !== "linux"
    ? "the deterministic Host interruption uses a Linux process signal"
    : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-exclude-descriptor-restart-"));
  const endpoint = join(root, "controller.sock");
  const retryDirectory = join(root, "controller-private");
  const userHome = join(root, "user-home");
  const target = "open-descriptor-recovery-target";
  const priorRule = `/${target}`;
  const lateRule = `!${priorRule}`;
  let descriptor;
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
    const excludePath = join(registration.projectPath, ".git", "info", "exclude");
    await appendFile(excludePath, `${priorRule}\n`);
    const excludeBefore = await readFile(excludePath, "utf8");
    descriptor = await open(excludePath, "a");
    pause = await writeProviderMutationPause({
      excludePath,
      manifestPath,
      mode: "exclude-open-descriptor-rollback-crash",
      root,
    });
    await writeFile(pause.armPath, "armed\n");
    host = await startInstalledProductionHost({
      endpoint,
      installed,
      nodePath: process.execPath,
      preloadPath: pause.preloadPath,
      registration,
    });

    const launch = execFileAsync(installed.command, installedProductionLaunchArguments(projectId), {
      cwd: root,
      env: installedProductionLaunchEnvironment({
        endpoint,
        projectId,
        retryDirectory,
        userHome,
      }),
    });
    await waitForPathState(pause.blockedPath, true);
    await descriptor.appendFile(`${lateRule}\n`);
    await descriptor.sync();
    await descriptor.close();
    descriptor = undefined;
    await writeFile(pause.releasePath, "release\n");
    await waitForPathState(pause.capturedPath, true);
    await host.kill();
    host = undefined;
    await assert.rejects(launch);
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

    assert.equal(await readFile(excludePath, "utf8"), `${excludeBefore}${lateRule}\n`);
    await writeFile(join(registration.projectPath, target), "exposed Project file\n");
    await assert.rejects(execFileAsync("git", [
      "-C", registration.projectPath,
      "check-ignore", "--no-index", "--quiet", target,
    ]), { code: 1 });
    await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });
    assert.deepEqual(await listProjectPreparationDebris(registration.projectPath), []);
  } finally {
    await descriptor?.close().catch(() => undefined);
    if (pause) {
      await writeFile(pause.releasePath, "release\n").catch(() => undefined);
      await writeFile(pause.capturedReleasePath, "release\n").catch(() => undefined);
    }
    await host?.stop().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});
