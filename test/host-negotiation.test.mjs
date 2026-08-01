import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "src", "cli.mjs");

test("incompatible Host protocol versions fail before the runtime becomes ready", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-host-failure-"));

  try {
    await assert.rejects(
      execFileAsync("node", [cliPath, "launch", "--data-dir", dataDir, "--json", "--no-open"], {
        cwd: process.cwd(),
        env: { ...process.env, SANDKING_HOST_MODE: "incompatible-major" },
      }),
      /host_protocol_major_mismatch/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
