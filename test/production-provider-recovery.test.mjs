import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installCurrentPackage } from "./installed-package.mjs";
import {
  startInstalledProductionHost,
  waitForPathState,
  writeProviderMutationPause,
} from "./installed-production-host.mjs";
import {
  createProductionRegistration,
  execFileAsync,
  installReadyProbeCommands,
} from "./production-sandcastle-host-fixture.mjs";

const listProjectPreparationDebris = async (projectPath) => {
  const [projectEntries, gitInfoEntries] = await Promise.all([
    readdir(projectPath),
    readdir(join(projectPath, ".git", "info")),
  ]);
  return [
    ...projectEntries.map((name) => `Project/${name}`),
    ...gitInfoEntries.map((name) => `.git/info/${name}`),
  ].filter((name) => name.includes(".sandking-") || name.includes("sandking-capture-"));
};

const assertProjectRulesEffective = async (projectPath, rules) => {
  for (const rule of rules) {
    const relativePath = rule.slice(1);
    await writeFile(join(projectPath, relativePath), "ignored Project file\n");
    await execFileAsync("git", [
      "-C", projectPath,
      "check-ignore", "--no-index", "--quiet", relativePath,
    ]);
  }
};

test("installed launch retries selector cleanup after preparation rollback is denied once", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-selector-rollback-retry-"));
  const endpoint = join(root, "controller.sock");
  const retryDirectory = join(root, "controller-private");
  const userHome = join(root, "user-home");
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
    const userEditPath = join(registration.projectPath, "user-edit-after-selector");
    const excludeBefore = await readFile(excludePath, "utf8");
    pause = await writeProviderMutationPause({
      excludePath,
      manifestPath,
      mode: "rollback-retry",
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

    const launch = execFileAsync(installed.command, [
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

    await waitForPathState(pause.blockedPath, true);
    await writeFile(userEditPath, "concurrent Project edit\n");
    await writeFile(pause.releasePath, "release\n");
    await assert.rejects(launch, (error) => {
      assert.match(`${error.stderr ?? ""}`, /harness_projection_failed/);
      return true;
    });

    await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });
    assert.equal(await readFile(excludePath, "utf8"), excludeBefore);
    assert.equal(await readFile(userEditPath, "utf8"), "concurrent Project edit\n");
    await assert.rejects(readFile(
      join(registration.dataDir, "production-provider-preparations.json"),
      "utf8",
    ), { code: "ENOENT" });
    assert.deepEqual(await listProjectPreparationDebris(registration.projectPath), []);
  } finally {
    if (pause) {
      await writeFile(pause.releasePath, "release\n").catch(() => undefined);
    }
    await host?.stop().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("installed launch rebases concurrent Git exclude ordering throughout collision recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-exclude-collision-recovery-"));
  const endpoint = join(root, "controller.sock");
  const retryDirectory = join(root, "controller-private");
  const userHome = join(root, "user-home");
  const exposedTarget = "concurrently-exposed-target";
  const hiddenTarget = "concurrently-hidden-target";
  const existingRules = [`/${exposedTarget}`, `!/${hiddenTarget}`];
  const replacementRules = [`!/${exposedTarget}`, `!/${hiddenTarget}`];
  const latestRule = `/${hiddenTarget}`;
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
    await appendFile(excludePath, `${existingRules.join("\n")}\n`);
    const excludeBefore = await readFile(excludePath, "utf8");
    const preparationStatePath = join(
      registration.dataDir,
      "production-provider-preparations.json",
    );
    pause = await writeProviderMutationPause({
      excludePath,
      manifestPath,
      mode: "exclude-reconciliation-rebase",
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

    const launch = execFileAsync(installed.command, [
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

    await waitForPathState(pause.blockedPath, true);
    await writeFile(excludePath, `${replacementRules.join("\n")}\n`);
    await writeFile(pause.releasePath, "release\n");
    await waitForPathState(pause.reconciliationBlockedPath, true);
    await appendFile(excludePath, `${latestRule}\n`);
    await writeFile(pause.reconciliationReleasePath, "release\n");
    await assert.rejects(launch, (error) => {
      assert.match(`${error.stderr ?? ""}`, /harness_projection_collision/);
      return true;
    });
    await host.stop();
    host = undefined;
    await rm(endpoint, { force: true });

    host = await startInstalledProductionHost({
      endpoint,
      installed,
      nodePath: process.execPath,
      registration,
    });
    await waitForPathState(preparationStatePath, false);

    const recoveredRules = new Set((await readFile(excludePath, "utf8")).split("\n"));
    for (const rule of excludeBefore.split("\n").filter(Boolean)) {
      assert.equal(recoveredRules.has(rule), true, `missing prior rule: ${rule}`);
    }
    for (const rule of [...replacementRules, latestRule]) {
      assert.equal(recoveredRules.has(rule), true, `missing concurrent rule: ${rule}`);
    }
    await Promise.all([
      writeFile(join(registration.projectPath, exposedTarget), "exposed Project file\n"),
      writeFile(join(registration.projectPath, hiddenTarget), "hidden Project file\n"),
    ]);
    await assert.rejects(execFileAsync("git", [
      "-C", registration.projectPath,
      "check-ignore", "--no-index", "--quiet", exposedTarget,
    ]), { code: 1 });
    await execFileAsync("git", [
      "-C", registration.projectPath,
      "check-ignore", "--no-index", "--quiet", hiddenTarget,
    ]);
    await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });
    assert.deepEqual(await listProjectPreparationDebris(registration.projectPath), []);
  } finally {
    if (pause) {
      await writeFile(pause.releasePath, "release\n").catch(() => undefined);
      await writeFile(pause.reconciliationReleasePath, "release\n").catch(() => undefined);
    }
    await host?.stop().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("installed launch retries cleanup when an exclude replacement appears after capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-exclude-cleanup-retry-"));
  const endpoint = join(root, "controller.sock");
  const retryDirectory = join(root, "controller-private");
  const userHome = join(root, "user-home");
  const existingRule = "/user-existing-before-exclude-cleanup";
  const userRule = "/user-created-during-exclude-cleanup";
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
    await appendFile(excludePath, `${existingRule}\n`);
    const excludeBefore = await readFile(excludePath, "utf8");
    const preparationStatePath = join(
      registration.dataDir,
      "production-provider-preparations.json",
    );
    pause = await writeProviderMutationPause({
      excludePath,
      manifestPath,
      mode: "exclude-cleanup-after-capture",
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
    await writeFile(excludePath, `${userRule}\n`);
    await writeFile(pause.releasePath, "release\n");
    await waitForPathState(preparationStatePath, false);
    await host.stop();
    host = undefined;
    await rm(endpoint, { force: true });

    host = await startInstalledProductionHost({
      endpoint,
      installed,
      nodePath: process.execPath,
      registration,
    });
    const recoveredRules = new Set((await readFile(excludePath, "utf8")).split("\n"));
    for (const rule of excludeBefore.split("\n").filter(Boolean)) {
      assert.equal(recoveredRules.has(rule), true, `missing prior rule: ${rule}`);
    }
    assert.equal(recoveredRules.has(userRule), true);
    await assertProjectRulesEffective(
      registration.projectPath,
      [existingRule, userRule],
    );
    await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });
    assert.deepEqual(await listProjectPreparationDebris(registration.projectPath), []);
  } finally {
    if (pause) {
      await writeFile(pause.releasePath, "release\n").catch(() => undefined);
    }
    await host?.stop().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});
