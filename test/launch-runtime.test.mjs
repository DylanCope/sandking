import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

const cliPath = join(process.cwd(), "src", "cli.mjs");

const runCli = async (args, options = {}) => {
  const { stdout } = await execFileAsync("node", [cliPath, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...options.env },
  });
  return JSON.parse(stdout);
};

test("launch reuses one compatible runtime and exposes Host negotiation details", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-runtime-"));

  try {
    const first = await runCli(["launch", "--data-dir", dataDir, "--json", "--no-open"]);
    const second = await runCli(["launch", "--data-dir", dataDir, "--json", "--no-open"]);

    assert.equal(first.runtime.runtimeId, second.runtime.runtimeId);
    assert.equal(first.runtime.port, second.runtime.port);
    assert.equal(first.runtime.reused, false);
    assert.equal(second.runtime.reused, true);
    assert.equal(first.host.identity, "local-host");
    assert.deepEqual(first.host.capabilities, ["slice-1"]);
    assert.match(first.bootstrapUrl, /^http:\/\/127\.0\.0\.1:\d+\/bootstrap\?token=/);

    const state = JSON.parse(
      await readFile(join(dataDir, "runtime-state.json"), "utf8"),
    );
    assert.equal(state.host.identity, "local-host");
    assert.equal(state.protocol.version, "1.0.0");
  } finally {
    await runCli(["stop", "--data-dir", dataDir, "--json"]);
    await rm(dataDir, { recursive: true, force: true });
  }
});
