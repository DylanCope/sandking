import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "src", "cli.mjs");

const failureCases = [
  ["incompatible-major", "host_protocol_major_mismatch"],
  ["unexpected-identity", "host_identity_mismatch"],
  ["unknown-required-capability", "host_capability_unsupported"],
  ["malformed-frame", "host_protocol_invalid_frame"],
];

for (const [mode, expectedCode] of failureCases) {
  test(`${mode} Host negotiation fails with ${expectedCode} before readiness`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sandking-host-failure-"));
    const acceptedStatePath = join(dataDir, "accepted-state.fixture");
    await writeFile(acceptedStatePath, "preserve-me\n");

    try {
      await assert.rejects(
        execFileAsync(process.execPath, [
          cliPath,
          "launch",
          "--data-dir",
          dataDir,
          "--host-mode",
          mode,
          "--json",
          "--no-open",
        ], { cwd: tmpdir(), env: process.env }),
        new RegExp(expectedCode),
      );

      assert.equal(await readFile(acceptedStatePath, "utf8"), "preserve-me\n");
      await assert.rejects(access(join(dataDir, "runtime-state.json")));
      const failure = JSON.parse(await readFile(join(dataDir, "last-startup-error.json"), "utf8"));
      assert.equal(failure.code, expectedCode);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}

test("Controller credentials are not inherited by the local Host process", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-host-env-"));
  const secret = "controller-secret-must-not-cross-host-boundary";

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      "launch",
      "--data-dir",
      dataDir,
      "--host-mode",
      "secret-probe",
      "--json",
      "--no-open",
    ], {
      cwd: tmpdir(),
      env: { ...process.env, SANDKING_CONTROLLER_SECRET: secret },
    });
    const launch = JSON.parse(stdout);
    assert.equal(launch.host.identity, "local-host");
    assert.doesNotMatch(stdout, new RegExp(secret));
  } finally {
    await execFileAsync(process.execPath, [cliPath, "stop", "--data-dir", dataDir, "--json"], {
      cwd: tmpdir(),
      env: process.env,
    }).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});
