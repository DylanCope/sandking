import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("..", import.meta.url);

test("the package exposes only the pinned production Sandcastle adapter and Worker", async () => {
  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repositoryRoot,
    maxBuffer: 1024 * 1024,
  });
  const [{ files }] = JSON.parse(stdout);
  const packagedFiles = new Set(files.map(({ path }) => path));

  for (const path of [
    "src/production-sandcastle-adapter/controlled-worker-fixture.mjs",
    "src/production-sandcastle-adapter/real-worker-v2.mjs",
    "src/production-sandcastle-adapter/sandcastle-v4.mjs",
  ]) {
    assert.ok(packagedFiles.has(path), `${path} must be packaged`);
  }
  for (const path of [
    "src/production-sandcastle-adapter/real-worker.mjs",
    "src/production-sandcastle-adapter/sandcastle-v1.mjs",
    "src/production-sandcastle-adapter/sandcastle-v2.mjs",
    "src/production-sandcastle-adapter/sandcastle-v3.mjs",
  ]) {
    assert.equal(packagedFiles.has(path), false, `${path} must not be packaged`);
  }

  const [adapter, worker] = await Promise.all([
    readFile(new URL("../src/production-sandcastle-adapter/sandcastle-v4.mjs", import.meta.url),
      "utf8"),
    readFile(new URL("../src/production-sandcastle-adapter/real-worker-v2.mjs", import.meta.url),
      "utf8"),
  ]);
  assert.doesNotMatch(`${adapter}\n${worker}`, /noSandbox|sandboxes\/no-sandbox/);
  assert.match(adapter, /\.sandcastle\/real-worker-v2\.mjs/);
  assert.match(worker, /sandboxes\/docker/);
});
