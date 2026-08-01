import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "src", "cli.mjs");

/** @param {string[]} args */
const runFailingCli = async (args) => {
  try {
    await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: tmpdir(),
      env: process.env,
    });
    assert.fail("expected the command to fail");
  } catch (error) {
    assert.ok(error && typeof error === "object");
    return /** @type {{stdout: string, stderr: string}} */ (error);
  }
};

const failureCases = [
  ["incompatible-major", {
    type: "host_negotiation_failure",
    code: "host_protocol_major_mismatch",
    retryable: true,
    explanation: "The Controller and local Host use incompatible protocol major versions.",
    retryGuidance: "Install matching Sand-King Controller and Host releases, then retry the launch.",
  }],
  ["unexpected-identity", {
    type: "host_negotiation_failure",
    code: "host_identity_mismatch",
    retryable: true,
    explanation: "The local Host reported an unexpected identity.",
    retryGuidance: "Verify the local Host installation and expected identity, then retry the launch.",
  }],
  ["unknown-required-capability", {
    type: "host_negotiation_failure",
    code: "host_capability_unsupported",
    retryable: true,
    explanation: "The Controller and local Host could not agree on required capabilities.",
    retryGuidance: "Install compatible Sand-King Controller and Host releases, then retry the launch.",
  }],
  ["malformed-frame", {
    type: "host_negotiation_failure",
    code: "host_protocol_invalid_frame",
    retryable: true,
    explanation: "The local Host sent malformed framed protocol data during negotiation.",
    retryGuidance: "Restart or update the local Host, then retry the launch.",
  }],
];

for (const [mode, expectedDiagnosis] of failureCases) {
  test(`${mode} Host negotiation returns a typed diagnosis before readiness`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sandking-host-failure-"));
    const acceptedStatePath = join(dataDir, "accepted-state.fixture");
    await writeFile(acceptedStatePath, "preserve-me\n");

    try {
      const commandFailure = await runFailingCli([
        "launch",
        "--data-dir",
        dataDir,
        "--host-mode",
        mode,
        "--json",
        "--no-open",
      ]);
      assert.equal(commandFailure.stderr, "");
      const publicOutcome = JSON.parse(commandFailure.stdout);
      assert.deepEqual(publicOutcome, { ok: false, diagnosis: expectedDiagnosis });

      assert.equal(await readFile(acceptedStatePath, "utf8"), "preserve-me\n");
      await assert.rejects(access(join(dataDir, "runtime-state.json")));
      const retained = JSON.parse(
        await readFile(join(dataDir, "last-startup-error.json"), "utf8"),
      );
      assert.deepEqual(
        { ...retained, recordedAt: "<timestamp>" },
        { ...expectedDiagnosis, recordedAt: "<timestamp>" },
      );
      assert.match(retained.recordedAt, /^\d{4}-\d{2}-\d{2}T/);
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
