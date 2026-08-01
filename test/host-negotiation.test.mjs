import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "src", "cli.mjs");
/** @param {Buffer | string} value */
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

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
  ["controller-incompatible-major", {
    type: "host_negotiation_failure",
    code: "controller_protocol_major_mismatch",
    retryable: true,
    explanation: "The local Host rejected the Controller protocol major version as incompatible.",
    retryGuidance: "Install matching Sand-King Controller and Host releases, then retry the launch.",
  }],
  ["controller-unknown-required-capability", {
    type: "host_negotiation_failure",
    code: "controller_capability_unsupported",
    retryable: true,
    explanation: "The local Host rejected a required Controller capability.",
    retryGuidance: "Install compatible Sand-King Controller and Host releases, then retry the launch.",
  }],
  ["controller-schema-mismatch", {
    type: "host_negotiation_failure",
    code: "controller_schema_mismatch",
    retryable: true,
    explanation: "The local Host rejected the Controller control schema as incompatible.",
    retryGuidance: "Install matching Sand-King Controller and Host releases, then retry the launch.",
  }],
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
    const acceptedStateBeforeSha256 = sha256(await readFile(acceptedStatePath));

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
      assert.equal(publicOutcome.ok, false);
      assert.match(publicOutcome.diagnosis.auditId, /^audit-/);
      assert.deepEqual(
        { ...publicOutcome.diagnosis, auditId: "<audit-id>" },
        { ...expectedDiagnosis, auditId: "<audit-id>" },
      );

      assert.equal(await readFile(acceptedStatePath, "utf8"), "preserve-me\n");
      await assert.rejects(access(join(dataDir, "runtime-state.json")));
      const retained = JSON.parse(
        await readFile(join(dataDir, "last-startup-error.json"), "utf8"),
      );
      assert.deepEqual(
        { ...retained, recordedAt: "<timestamp>" },
        { ...publicOutcome.diagnosis, recordedAt: "<timestamp>" },
      );
      assert.match(retained.recordedAt, /^\d{4}-\d{2}-\d{2}T/);
      const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      const negotiationAudit = audits.find((entry) =>
        entry.action === "host.negotiate" && entry.outcome === "rejected");
      assert.equal(negotiationAudit.auditId, publicOutcome.diagnosis.auditId);
      assert.equal(negotiationAudit.details.code, expectedDiagnosis.code);
      assert.equal(negotiationAudit.details.mutationOccurred, false);
      if (mode === "unexpected-identity") {
        assert.equal(negotiationAudit.details.expectedHostIdentity, "local-host");
        assert.match(negotiationAudit.details.expectedHostId, /^host-[a-f0-9]{24}$/);
        assert.equal(negotiationAudit.details.observedHostId, `host-${"0".repeat(24)}`);
        assert.notEqual(
          negotiationAudit.details.observedHostId,
          negotiationAudit.details.expectedHostId,
        );
      }
      if (process.env.SANDKING_ACCEPTANCE_RESULT_DIR) {
        const acceptedStateAfterSha256 = sha256(await readFile(acceptedStatePath));
        const runtimeStatePresent = await access(join(dataDir, "runtime-state.json"))
          .then(() => true, () => false);
        await mkdir(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(
          join(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, `host-${mode}.json`),
          `${JSON.stringify({
            kind: "host_negotiation_failure",
            mode,
            diagnosis: publicOutcome.diagnosis,
            acceptedState: {
              beforeSha256: acceptedStateBeforeSha256,
              afterSha256: acceptedStateAfterSha256,
              preserved: acceptedStateBeforeSha256 === acceptedStateAfterSha256,
            },
            runtimeStatePresent,
            mutationOccurred: negotiationAudit.details.mutationOccurred,
            auditReferences: audits.map((entry) => ({
              auditId: entry.auditId,
              action: entry.action,
              outcome: entry.outcome,
              details: entry.details,
            })),
          }, null, 2)}\n`,
          { mode: 0o600 },
        );
      }
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
    assert.match(launch.host.hostId, /^host-[a-f0-9]{24}$/);
    assert.doesNotMatch(stdout, new RegExp(secret));
    if (process.env.SANDKING_ACCEPTANCE_RESULT_DIR) {
      await mkdir(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, { recursive: true, mode: 0o700 });
      await writeFile(
        join(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, "host-credential-boundary.json"),
        `${JSON.stringify({
          kind: "host_credential_boundary",
          mode: "secret-probe",
          observedHostIdentity: launch.host.identity,
          controllerSecretForwarded: launch.host.identity === "controller-secret-leaked",
          negotiationAuditId: launch.audit.negotiationId,
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  } finally {
    await execFileAsync(process.execPath, [cliPath, "stop", "--data-dir", dataDir, "--json"], {
      cwd: tmpdir(),
      env: process.env,
    }).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});
