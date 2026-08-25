import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createProductionRegistration } from "./production-sandcastle-host-fixture.mjs";

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

const execFileWithStdin = (file, args, input, options) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("error", reject);
  child.once("close", (code, signal) => {
    if (code === 0) {
      resolve({ stdout, stderr });
      return;
    }
    reject(Object.assign(new Error(`command failed: ${code ?? signal ?? "unknown"}`), {
      code,
      signal,
      stdout,
      stderr,
    }));
  });
  child.stdin.end(input);
});

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

    const credentialFixture = await createProductionRegistration(
      join(root, "credential-configuration"),
    );
    const credentialArgs = [
      "--data-dir", credentialFixture.dataDir,
      "--json",
    ];
    const { stdout: credentialHelp } = await execFileAsync(command, [
      "github-credentials", "--help",
    ], { cwd: root, env: process.env });
    assert.match(credentialHelp, /fine-grained Project PAT/i);
    assert.match(credentialHelp, /standard input/i);
    assert.match(credentialHelp, /full Host GitHub access/i);
    assert.match(credentialHelp, /--acknowledge-full-host-access/);

    const projectId = credentialFixture.project.project.projectId;
    const inspect = async (id) => JSON.parse((await execFileAsync(command, [
      "github-credentials", "inspect", ...(id ? [id] : []), ...credentialArgs,
    ], { cwd: root, env: process.env })).stdout);
    const initialCredentials = await inspect(projectId);
    assert.deepEqual({
      ...initialCredentials,
      configurationOptions: initialCredentials.configurationOptions.map(({ mode }) => mode),
    }, {
      code: "github_credentials_unconfigured",
      revision: 0,
      projectPat: "not-configured",
      hostGhSessionReuse: "disabled",
      effectiveMode: null,
      configurationOptions: ["project-pat", "host-gh-session"],
    });
    assert.match(initialCredentials.configurationOptions[0].guidance, /fine-grained/i);
    assert.match(initialCredentials.configurationOptions[1].guidance, /full Host/i);

    const projectToken = "github_pat_installed_cli_secret_261";
    const setArguments = [
      "github-credentials", "set-project-pat", projectId, ...credentialArgs,
    ];
    const set = JSON.parse((await execFileWithStdin(
      command,
      setArguments,
      `${projectToken}\n`,
      { cwd: root, env: process.env },
    )).stdout);
    assert.equal(set.projectPat, "configured");
    assert.equal(set.revision, 1);
    assert.doesNotMatch(JSON.stringify(set), /installed_cli_secret_261/);
    assert.equal(setArguments.includes(projectToken), false);

    await assert.rejects(execFileAsync(command, [
      "github-credentials", "enable-host-session", ...credentialArgs,
    ], { cwd: root, env: process.env }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /full Host GitHub access/i);
      assert.match(error.stderr, /--acknowledge-full-host-access/);
      return true;
    });
    assert.equal((await inspect(projectId)).revision, 1);

    const enabled = JSON.parse((await execFileAsync(command, [
      "github-credentials", "enable-host-session",
      "--acknowledge-full-host-access", ...credentialArgs,
    ], { cwd: root, env: process.env })).stdout);
    assert.equal(enabled.hostGhSessionReuse, "enabled");
    assert.equal(enabled.revision, 2);
    assert.equal((await inspect(projectId)).effectiveMode, "project-pat");

    const cleared = JSON.parse((await execFileAsync(command, [
      "github-credentials", "clear-project-pat", projectId, ...credentialArgs,
    ], { cwd: root, env: process.env })).stdout);
    assert.equal(cleared.projectPat, "not-configured");
    assert.equal(cleared.effectiveMode, "host-gh-session");

    const disabled = JSON.parse((await execFileAsync(command, [
      "github-credentials", "disable-host-session", ...credentialArgs,
    ], { cwd: root, env: process.env })).stdout);
    assert.equal(disabled.hostGhSessionReuse, "disabled");
    assert.equal(disabled.code, "github_credentials_unconfigured");

    const concurrentActions = Array.from({ length: 16 }, (_, index) => {
      if (index % 2 === 0) {
        return execFileWithStdin(
          command,
          [
            "github-credentials", "set-project-pat", projectId, ...credentialArgs,
          ],
          `github_pat_concurrent_secret_261_${index}\n`,
          { cwd: root, env: process.env },
        );
      }
      return execFileAsync(command, [
        "github-credentials", "enable-host-session",
        "--acknowledge-full-host-access", ...credentialArgs,
      ], { cwd: root, env: process.env });
    });
    const concurrentOutcomes = await Promise.allSettled(concurrentActions);
    assert.equal(
      concurrentOutcomes.every(({ status }) => status === "fulfilled"),
      true,
      concurrentOutcomes
        .filter(({ status }) => status === "rejected")
        .map(({ reason }) => reason.stderr ?? reason.message)
        .join("\n"),
    );
    const retainedCredentialState = JSON.parse(await readFile(
      join(credentialFixture.dataDir, "github-credentials.json"),
      "utf8",
    ));
    assert.equal(retainedCredentialState.revision, 4 + concurrentActions.length);
    assert.equal(
      retainedCredentialState.mutationOutcomes.length,
      4 + concurrentActions.length,
    );
    assert.equal(retainedCredentialState.reuseHostGhSession, true);
    assert.equal(
      Object.hasOwn(retainedCredentialState.projectPersonalAccessTokens, projectId),
      true,
    );
    assert.match(
      await readFile(join(credentialFixture.dataDir, "host-identity.json"), "utf8"),
      /"hostId": "host-[a-f0-9]{24}"/,
    );
    assert.doesNotMatch(
      await readFile(join(credentialFixture.dataDir, "audit.jsonl"), "utf8"),
      /installed_cli_secret_261|concurrent_secret_261/,
    );
    assert.equal((await execFileAsync("git", [
      "-C", credentialFixture.projectPath,
      "status", "--porcelain=v1", "--untracked-files=all",
    ])).stdout, "");

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
