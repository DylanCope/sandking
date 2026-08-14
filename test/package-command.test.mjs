import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("..", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", repositoryRoot), "utf8"));
const productionHarnessSeedManifest = JSON.parse(await readFile(
  new URL("src/bundled-production-harness/seed-manifest.json", repositoryRoot),
  "utf8",
));
const productionHarnessPackageSources = productionHarnessSeedManifest.files
  .filter(({ source }) => source === "sandking-package")
  .map(({ path, sourcePath }) => sourcePath ?? path);

test("the stable sandking command is public, executable, and contains module-relative runtime assets", async () => {
  assert.equal(packageJson.private, false);
  assert.deepEqual(packageJson.os, ["darwin", "linux", "win32"]);
  assert.deepEqual(packageJson.cpu, ["arm64", "x64"]);
  assert.equal(packageJson.bin.sandking, "./src/cli.mjs");
  assert.equal(packageJson.bin["sandking-host"], "./src/local-host.mjs");
  const cliPath = new URL("../src/cli.mjs", import.meta.url);
  assert.notEqual((await stat(cliPath)).mode & 0o111, 0);

  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repositoryRoot,
  });
  const [{ files }] = JSON.parse(stdout);
  const packagedFiles = new Set(files.map((file) => file.path));
  for (const required of [
    "src/cli.mjs",
    "src/runtime.mjs",
    "src/runtime-daemon.mjs",
    "src/local-host.mjs",
    "src/host-identity.mjs",
    "src/host-loss-termination-evidence.mjs",
    "src/protocol.mjs",
    "src/browser-protocol.mjs",
    "src/cockpit/index.mjs",
    "src/cockpit/dom.mjs",
    "src/cockpit/socket.mjs",
    "src/cockpit/terminal.mjs",
    "src/cockpit/project-preparation.mjs",
    "src/cockpit/harness-run.mjs",
    "src/cockpit/chrome.mjs",
    "src/darwin-process-containment.cjs",
    "src/darwin-process-tree.mjs",
    "src/posix-process-tree-helper.c",
    "src/native/linux-arm64/posix-process-tree-helper",
    "src/native/linux-x64/posix-process-tree-helper",
    ...productionHarnessPackageSources,
    "src/windows-process-barrier.cjs",
    "src/windows-host-loss-witness.cjs",
  ]) {
    assert.ok(packagedFiles.has(required), `${required} must be packaged`);
  }
  for (const [relativePath, expectedMachine] of [
    ["../src/native/linux-arm64/posix-process-tree-helper", 0xb7],
    ["../src/native/linux-x64/posix-process-tree-helper", 0x3e],
  ]) {
    const helperUrl = new URL(relativePath, import.meta.url);
    const helper = await readFile(helperUrl);
    assert.deepEqual([...helper.subarray(0, 4)], [0x7f, 0x45, 0x4c, 0x46]);
    assert.equal(helper.readUInt16LE(18), expectedMachine);
    assert.notEqual((await stat(helperUrl)).mode & 0o111, 0);
  }
});

test("an installed production package launches outside the source checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-package-"));
  const installDirectory = join(root, "installed");
  const runtimeDirectory = join(root, "runtime-state");

  try {
    const { stdout: packOutput } = await execFileAsync("npm", [
      "pack", "--json", "--pack-destination", root,
    ], { cwd: repositoryRoot });
    const [{ filename }] = JSON.parse(packOutput);
    const tarball = join(root, filename);
    await execFileAsync("npm", [
      "install", "--ignore-scripts", "--omit=dev", "--prefix", installDirectory, tarball,
    ], { cwd: root });

    if (process.platform === "linux") {
      const coldDirectory = join(root, "cold-runtime");
      await mkdir(coldDirectory, { mode: 0o700 });
      const installedProcessTree = join(
        installDirectory,
        "node_modules",
        "sandking",
        "src",
        "posix-process-tree.mjs",
      );
      const source = `
        import { spawnPosixProcessTree } from ${JSON.stringify(installedProcessTree)};
        const tree = spawnPosixProcessTree(process.execPath, [
          "--input-type=module", "--eval", "process.exit(0)",
        ], { cwd: process.cwd(), env: { LANG: "C.UTF-8" } });
        const result = await tree.adapterExit;
        await tree.release();
        process.stdout.write(JSON.stringify(result));
      `;
      const { stdout: processTreeOutput } = await execFileAsync(process.execPath, [
        "--input-type=module",
        "--eval",
        source,
      ], {
        cwd: root,
        env: { LANG: "C.UTF-8", PATH: coldDirectory, TMPDIR: coldDirectory },
      });
      assert.deepEqual(JSON.parse(processTreeOutput), {
        code: 0,
        signal: null,
        startFailed: false,
      });
    }

    const command = join(installDirectory, "node_modules", ".bin", "sandking");
    const { stdout: help } = await execFileAsync(command, ["launch", "--help"], {
      cwd: root,
      env: process.env,
    });
    assert.match(help, /sandking launch \[<project-id>\] \[--parameters <json-object>\]/);
    assert.match(help, /defaults to the focused Controller Project/);
    for (const invocation of [["-h"], ["help", "launch"]]) {
      const { stdout: discoveredHelp } = await execFileAsync(command, invocation, {
        cwd: root,
        env: process.env,
      });
      assert.equal(discoveredHelp, help);
    }

    const prohibitedFaultState = join(root, "prohibited-fault-state");
    await assert.rejects(execFileAsync(command, [
      "launch", "--data-dir", prohibitedFaultState,
      "--host-mode", "pause-after-harness-run-cancellation-acceptance",
      "--json", "--no-open",
    ], { cwd: root, env: process.env }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Harness launch requires a Project ID or focused Controller Project/);
      return true;
    });
    await assert.rejects(access(prohibitedFaultState));

    const hostCommand = join(installDirectory, "node_modules", ".bin", "sandking-host");
    await assert.rejects(execFileAsync(hostCommand, [
      "--mode", "hang-before-ack", "--data-dir", prohibitedFaultState,
    ], { cwd: root, env: process.env }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /host_option_unsupported/);
      return true;
    });
    await assert.rejects(access(prohibitedFaultState));

    const { stdout } = await execFileAsync(command, [
      "launch", "--data-dir", runtimeDirectory, "--json", "--no-open",
    ], { cwd: root, env: process.env });
    const launch = JSON.parse(stdout);
    assert.equal(launch.runtime.identity, "controller-runtime");
    assert.equal(launch.host.identity, "local-host");
    assert.deepEqual(launch.runtime.listener, { address: "127.0.0.1", class: "loopback" });

    await execFileAsync(command, ["stop", "--data-dir", runtimeDirectory, "--json"], {
      cwd: root,
      env: process.env,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
