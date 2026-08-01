import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("the stable sandking command is public, executable, and contains module-relative runtime assets", async () => {
  assert.equal(packageJson.private, false);
  assert.equal(packageJson.bin.sandking, "./src/cli.mjs");
  assert.equal(packageJson.bin["sandking-host"], "./src/local-host.mjs");
  const cliPath = new URL("../src/cli.mjs", import.meta.url);
  assert.notEqual((await stat(cliPath)).mode & 0o111, 0);

  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
    cwd: new URL("..", import.meta.url),
  });
  const [{ files }] = JSON.parse(stdout);
  const packagedFiles = files.map((file) => file.path);
  for (const required of [
    "src/cli.mjs",
    "src/runtime.mjs",
    "src/runtime-daemon.mjs",
    "src/local-host.mjs",
    "src/host-identity.mjs",
    "src/protocol.mjs",
    "src/browser-protocol.mjs",
    "src/cockpit.js",
  ]) {
    assert.ok(packagedFiles.includes(required), `${required} must be packaged`);
  }
});

test("an installed production package launches outside the source checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-package-"));
  const installDirectory = join(root, "installed");
  const runtimeDirectory = join(root, "runtime-state");

  try {
    const { stdout: packOutput } = await execFileAsync("npm", [
      "pack", "--json", "--pack-destination", root,
    ], { cwd: new URL("..", import.meta.url) });
    const [{ filename }] = JSON.parse(packOutput);
    const tarball = join(root, filename);
    await execFileAsync("npm", [
      "install", "--ignore-scripts", "--omit=dev", "--prefix", installDirectory, tarball,
    ], { cwd: root });

    const command = join(installDirectory, "node_modules", ".bin", "sandking");
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
