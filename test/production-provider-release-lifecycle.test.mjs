import assert from "node:assert/strict";
import {
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

test("installed launch cleans a selector after both bounded descriptor waits expire", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-selector-long-descriptor-"));
  const endpoint = join(root, "controller.sock");
  const retryDirectory = join(root, "controller-private");
  const userHome = join(root, "user-home");
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
    const preparationStatePath = join(
      registration.dataDir,
      "production-provider-preparations.json",
    );
    pause = await writeProviderMutationPause({
      excludePath,
      manifestPath,
      mode: "selector-long-lived-descriptor",
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

    const launch = execFileAsync(
      installed.command,
      installedProductionLaunchArguments(projectId),
      {
        cwd: root,
        env: installedProductionLaunchEnvironment({
          endpoint,
          projectId,
          retryDirectory,
          userHome,
        }),
      },
    );
    assert.equal(JSON.parse((await launch).stdout).type, "harness.run.launch.result");
    await waitForPathState(pause.blockedPath, true);
    descriptor = await open(manifestPath, "r");
    await writeFile(pause.releasePath, "release\n");
    await waitForPathState(pause.capturedPath, true);

    await new Promise((resolve) => setTimeout(resolve, 12_000));
    await descriptor.close();
    descriptor = undefined;
    await waitForPathState(preparationStatePath, false);

    await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });
    assert.equal(await readFile(excludePath, "utf8"), excludeBefore);
    assert.deepEqual(await listProjectPreparationDebris(registration.projectPath), []);
  } finally {
    await descriptor?.close().catch(() => undefined);
    if (pause) await writeFile(pause.releasePath, "release\n").catch(() => undefined);
    await host?.stop().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged Host restart finishes an empty released selector capture", {
  skip: process.platform !== "linux"
    ? "the deterministic Host interruption uses a Linux process signal"
    : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-selector-released-crash-"));
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
    const excludePath = join(registration.projectPath, ".git", "info", "exclude");
    const excludeBefore = await readFile(excludePath, "utf8");
    const preparationStatePath = join(
      registration.dataDir,
      "production-provider-preparations.json",
    );
    pause = await writeProviderMutationPause({
      excludePath,
      manifestPath,
      mode: "selector-release-directory-crash",
      root,
    });
    host = await startInstalledProductionHost({
      endpoint,
      installed,
      nodePath: process.execPath,
      preloadPath: pause.preloadPath,
      registration,
    });

    const launch = execFileAsync(
      installed.command,
      installedProductionLaunchArguments(projectId),
      {
        cwd: root,
        env: installedProductionLaunchEnvironment({
          endpoint,
          projectId,
          retryDirectory,
          userHome,
        }),
      },
    );
    assert.equal(JSON.parse((await launch).stdout).type, "harness.run.launch.result");
    await waitForPathState(pause.capturedPath, true);
    assert.equal(
      (await listProjectPreparationDebris(registration.projectPath))
        .some((path) => path.endsWith(".released")),
      true,
    );
    await host.kill();
    host = undefined;
    await rm(endpoint, { force: true });

    host = await startInstalledProductionHost({
      endpoint,
      installed,
      nodePath: process.execPath,
      registration,
    });
    await waitForPathState(preparationStatePath, false);

    await assert.rejects(readFile(manifestPath, "utf8"), { code: "ENOENT" });
    assert.equal(await readFile(excludePath, "utf8"), excludeBefore);
    assert.deepEqual(await listProjectPreparationDebris(registration.projectPath), []);
  } finally {
    if (pause) {
      await writeFile(pause.capturedReleasePath, "release\n").catch(() => undefined);
    }
    await host?.stop().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});
