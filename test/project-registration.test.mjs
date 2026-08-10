import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  HOST_SCHEMA_DIGEST,
  MAX_BULK_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  hostCapabilities,
  protocolVersion,
  readFrame,
  releaseVersion,
  writeFrame,
} from "../src/protocol.mjs";
import { createProjectRegistry } from "../src/project-registration.mjs";

const execFileAsync = promisify(execFile);
const localHostPath = join(process.cwd(), "src", "local-host.mjs");

const projectConfiguration = {
  issueWorkflow: { provider: "github", kind: "issues" },
  checks: [
    { checkId: "typecheck", command: "npm run typecheck" },
    { checkId: "test", command: "npm run test" },
  ],
};

/** @param {import("node:child_process").ChildProcessWithoutNullStreams} child */
const negotiate = async (child) => {
  const hostId = `host-${"1".repeat(24)}`;
  writeFrame(child.stdin, {
    type: "hello",
    protocol: protocolVersion,
    release: releaseVersion,
    identity: "controller-runtime",
    controllerId: `runtime-${"2".repeat(24)}`,
    expectedPeerIdentity: "local-host",
    expectedHostId: hostId,
    capabilities: { required: [...hostCapabilities], optional: [] },
    schemaDigest: HOST_SCHEMA_DIGEST,
    framing: {
      maxFrameBytes: MAX_FRAME_BYTES,
      maxBulkChunkBytes: MAX_BULK_CHUNK_BYTES,
    },
    observationCursor: null,
  });
  const acknowledgement = await readFrame(child.stdout);
  assert.equal(acknowledgement.type, "hello-ack");
  writeFrame(child.stdin, {
    type: "host.identity.accept",
    requestId: "accept-host-for-project-test",
    hostId,
    authorizationClass: "controller_host_identity_binding",
    idempotencyKey: "accept-host-for-project-test",
    expectedRevision: 0,
  });
  assert.equal((await readFrame(child.stdout)).type, "host.identity.result");
};

test("the framed Host opens, registers, and prepares only an explicitly selected Project", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-project-registration-"));
  const dataDir = join(root, "host-state");
  const projectPath = join(root, "selected-project");
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
  await writeFile(join(projectPath, "README.md"), "ordinary Project content\n");
  const projectFilesBefore = await readdir(projectPath);
  const child = spawn(process.execPath, [
    localHostPath,
    "--data-dir",
    dataDir,
    "--allow-host-identity-create",
  ], { stdio: ["pipe", "pipe", "pipe"], env: { LANG: "C.UTF-8" } });

  try {
    await negotiate(child);
    writeFrame(child.stdin, {
      type: "project.inspect",
      requestId: "inspect-selected-project",
      path: projectPath,
    });
    const inspection = await readFrame(child.stdout);
    assert.deepEqual(inspection, {
      type: "project.inspect.result",
      requestId: "inspect-selected-project",
      code: "project_unregistered",
      actualRevision: 0,
      project: null,
    });

    const registrationRequest = {
      type: "project.register",
      requestId: "register-selected-project",
      path: projectPath,
      configuration: projectConfiguration,
      authorizationClass: "host_local_project_registration",
      idempotencyKey: "register-selected-project",
      expectedRevision: 0,
    };
    writeFrame(child.stdin, registrationRequest);
    const registration = await readFrame(child.stdout);
    assert.equal(registration.type, "project.register.result");
    assert.equal(registration.code, "project_registered");
    assert.equal(registration.revision, 1);
    assert.equal(registration.idempotentReplay, false);
    assert.match(registration.project.projectId, /^project-[a-f0-9]{24}$/);
    assert.equal(registration.project.canonicalPath, projectPath);
    assert.deepEqual(registration.project.readiness, {
      issueWorkflow: "ready",
      checks: "ready",
      configuration: "ready",
      harness: "missing",
      pin: "missing",
      launchRequest: "blocked",
      diagnostics: ["harness_not_registered", "harness_pin_missing"],
    });
    assert.match(registration.auditId, /^audit-/);

    writeFrame(child.stdin, { ...registrationRequest, requestId: "replay-project-registration" });
    const replay = await readFrame(child.stdout);
    assert.deepEqual(replay, {
      ...registration,
      requestId: "replay-project-registration",
      idempotentReplay: true,
    });

    writeFrame(child.stdin, {
      type: "harness.conformance.register",
      requestId: "register-conformance-harness",
      name: "Sand-King Conformance Harness",
      authorizationClass: "host_local_harness_registration",
      idempotencyKey: "register-conformance-harness",
      expectedRevision: 0,
    });
    const harnessRegistration = await readFrame(child.stdout);
    assert.equal(harnessRegistration.type, "harness.conformance.register.result");
    assert.equal(harnessRegistration.code, "conformance_harness_registered");
    assert.match(harnessRegistration.harness.harnessId, /^harness-[a-f0-9]{24}$/);
    assert.match(harnessRegistration.harness.immutableRevision, /^[a-f0-9]{40}$/);
    assert.equal(harnessRegistration.harness.workspace.versionControl, "git");
    assert.equal(harnessRegistration.harness.workspace.independent, true);

    writeFrame(child.stdin, {
      type: "project.harness.pin",
      requestId: "pin-conformance-harness",
      projectId: registration.project.projectId,
      harnessId: harnessRegistration.harness.harnessId,
      boundedConfiguration: {
        adapterProtocol: "1.0.0",
        launchProfile: "delegated-work",
      },
      authorizationClass: "host_local_project_configuration",
      idempotencyKey: "pin-conformance-harness",
      expectedRevision: 1,
    });
    const pin = await readFrame(child.stdout);
    assert.equal(pin.type, "project.harness.pin.result");
    assert.equal(pin.code, "project_harness_pinned");
    assert.equal(pin.revision, 2);
    assert.equal(pin.project.projectId, registration.project.projectId);
    assert.equal(pin.project.harness.harnessId, harnessRegistration.harness.harnessId);
    assert.equal(
      pin.project.harness.pinnedRevision,
      harnessRegistration.harness.immutableRevision,
    );
    assert.deepEqual(pin.project.readiness, {
      issueWorkflow: "ready",
      checks: "ready",
      configuration: "ready",
      harness: "ready",
      pin: "ready",
      launchRequest: "ready",
      diagnostics: [],
    });

    const projectState = JSON.parse(
      await readFile(join(dataDir, "project-registrations.json"), "utf8"),
    );
    const harnessState = JSON.parse(
      await readFile(join(dataDir, "harness-registry.json"), "utf8"),
    );
    assert.equal(projectState.projects[0].projectId, registration.project.projectId);
    assert.equal(harnessState.harnesses[0].harnessId, harnessRegistration.harness.harnessId);
    assert.notEqual(harnessState.harnesses[0].workspacePath, projectPath);
    assert.match(relative(dataDir, harnessState.harnesses[0].workspacePath), /^\.\./);
    const compatibilityManifest = JSON.parse(await readFile(
      join(harnessState.harnesses[0].workspacePath, "harness.json"),
      "utf8",
    ));
    assert.deepEqual(compatibilityManifest.compatibility, {
      adapterId: "conformance-harness-adapter-v1",
      adapterProtocol: "1.0.0",
      entryPoint: "adapters/conformance.mjs",
    });
    assert.deepEqual(
      (await readdir(harnessState.harnesses[0].workspacePath)).sort(),
      [".git", "adapters", "harness.json"],
    );
    assert.deepEqual(
      await readdir(join(harnessState.harnesses[0].workspacePath, "adapters")),
      ["conformance.mjs"],
    );
    assert.equal(
      (await execFileAsync("git", [
        "-C",
        harnessState.harnesses[0].workspacePath,
        "rev-parse",
        "HEAD",
      ])).stdout.trim(),
      harnessRegistration.harness.immutableRevision,
    );
    assert.deepEqual(await readdir(projectPath), projectFilesBefore);
    assert.equal((await readdir(projectPath)).includes(".sandcastle"), false);

    writeFrame(child.stdin, {
      type: "harness.sandcastle.inspect",
      requestId: "inspect-production-harness",
    });
    assert.deepEqual(await readFrame(child.stdout), {
      type: "harness.sandcastle.inspect.result",
      requestId: "inspect-production-harness",
      code: "sandcastle_harness_unregistered",
      actualRevision: 0,
      harness: null,
    });
    writeFrame(child.stdin, {
      type: "harness.sandcastle.register",
      requestId: "register-production-harness",
      name: "Sand-King Sandcastle Harness",
      authorizationClass: "host_local_harness_registration",
      idempotencyKey: "register-production-harness",
      expectedRevision: 0,
    });
    const productionHarness = await readFrame(child.stdout);
    assert.equal(productionHarness.type, "harness.sandcastle.register.result");
    assert.equal(productionHarness.code, "sandcastle_harness_registered");
    assert.equal(productionHarness.harness.adapterId, "sandcastle-harness-adapter-v1");
    const sideBySideState = JSON.parse(
      await readFile(join(dataDir, "harness-registry.json"), "utf8"),
    );
    assert.deepEqual(
      sideBySideState.harnesses.map((harness) => harness.adapterId),
      ["conformance-harness-adapter-v1", "sandcastle-harness-adapter-v1"],
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("path identity changes return typed resolution guidance without silently reattaching", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-project-resolution-"));
  const dataDir = join(root, "host-state");
  const originalPath = join(root, "original-project");
  const movedPath = join(root, "moved-project");
  const secretFixture = "project-secret-fixture-must-not-appear";
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", originalPath]);
  await writeFile(join(originalPath, "secret.txt"), `${secretFixture}\n`);
  const audits = [];
  const recordAudit = async (action, outcome, details) => {
    const auditId = `audit-${String(audits.length + 1).padStart(24, "0")}`;
    audits.push({ auditId, action, outcome, details });
    return auditId;
  };

  try {
    const registry = await createProjectRegistry({ dataDir, recordAudit });
    const registered = await registry.registerProject({
      requestId: "register-resolution-project",
      path: originalPath,
      configuration: projectConfiguration,
      authorizationClass: "host_local_project_registration",
      idempotencyKey: "register-resolution-project",
      expectedRevision: 0,
    });
    assert.equal(registered.code, "project_registered");
    await rename(originalPath, movedPath);

    const missing = await registry.inspectProject({
      requestId: "inspect-missing-project",
      path: originalPath,
    });
    assert.equal(missing.type, "project.operation.failure");
    assert.equal(missing.code, "project_path_missing");
    assert.deepEqual(missing.resolution.actions, ["update_registration", "forget_registration"]);

    const moved = await registry.inspectProject({
      requestId: "inspect-moved-project",
      path: movedPath,
    });
    assert.equal(moved.code, "project_path_moved");
    assert.deepEqual(moved.resolution.actions, [
      "update_registration",
      "forget_registration",
      "register_as_new",
    ]);

    await mkdir(originalPath);
    const replaced = await registry.inspectProject({
      requestId: "inspect-replaced-project",
      path: originalPath,
    });
    assert.equal(replaced.code, "project_path_replaced");
    assert.deepEqual(replaced.resolution.actions, [
      "replace_registration",
      "register_as_new",
      "select_another_path",
    ]);

    const statePath = join(dataDir, "project-registrations.json");
    const tombstonedState = JSON.parse(await readFile(statePath, "utf8"));
    tombstonedState.projects[0].status = "tombstoned";
    await writeFile(statePath, `${JSON.stringify(tombstonedState, null, 2)}\n`);
    const tombstoned = await registry.inspectProject({
      requestId: "inspect-tombstoned-project",
      path: originalPath,
    });
    assert.equal(tombstoned.code, "project_path_tombstoned");
    assert.deepEqual(tombstoned.resolution.actions, ["restore_registration", "register_as_new"]);

    tombstonedState.projects[0].status = "active";
    tombstonedState.projects.push({
      ...tombstonedState.projects[0],
      projectId: `project-${"f".repeat(24)}`,
    });
    await writeFile(statePath, `${JSON.stringify(tombstonedState, null, 2)}\n`);
    const conflict = await registry.inspectProject({
      requestId: "inspect-conflicting-project",
      path: originalPath,
    });
    assert.equal(conflict.code, "project_path_conflict");
    assert.deepEqual(conflict.resolution.actions, ["resolve_conflicting_registrations"]);

    const retained = `${await readFile(statePath, "utf8")}\n${JSON.stringify(audits)}`;
    assert.doesNotMatch(retained, new RegExp(secretFixture));
    assert.ok(audits.filter((entry) => entry.action === "project.inspect").every((entry) =>
      entry.outcome === "rejected"
      && entry.details.directoryScanPerformed === false));
    if (process.env.SANDKING_ACCEPTANCE_RESULT_DIR) {
      await mkdir(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, "project-path-resolution.json"),
        `${JSON.stringify({
          kind: "project_path_resolution",
          outcomes: {
            missing: { code: missing.code, guidance: missing.resolution.actions },
            moved: { code: moved.code, guidance: moved.resolution.actions },
            replaced: { code: replaced.code, guidance: replaced.resolution.actions },
            tombstoned: { code: tombstoned.code, guidance: tombstoned.resolution.actions },
            conflict: { code: conflict.code, guidance: conflict.resolution.actions },
          },
          silentlyReattached: false,
          directoryScanPerformed: false,
          secretFixtureRetained: retained.includes(secretFixture),
          auditReferences: audits,
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registration and pinning reject changed retries, stale revisions, and invalid inputs atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-project-failures-"));
  const dataDir = join(root, "host-state");
  const projectPath = join(root, "selected-project");
  const anotherProjectPath = join(root, "another-project");
  await Promise.all([
    execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]),
    execFileAsync("git", ["init", "--quiet", "--initial-branch=main", anotherProjectPath]),
  ]);
  const audits = [];
  const recordAudit = async (action, outcome, details) => {
    const auditId = `audit-${String(audits.length + 1).padStart(24, "0")}`;
    audits.push({ auditId, action, outcome, details });
    return auditId;
  };

  try {
    const registry = await createProjectRegistry({ dataDir, recordAudit });
    const invalidPath = await registry.registerProject({
      requestId: "invalid-relative-path",
      path: "relative/project",
      configuration: projectConfiguration,
      authorizationClass: "host_local_project_registration",
      idempotencyKey: "invalid-relative-path",
      expectedRevision: 0,
    });
    assert.equal(invalidPath.code, "project_path_invalid");

    const embeddedStatePath = join(projectPath, ".sandking-host-state");
    const unsafeRegistry = await createProjectRegistry({
      dataDir: embeddedStatePath,
      recordAudit,
    });
    const embeddedStateRejected = await unsafeRegistry.registerProject({
      requestId: "embedded-state-project",
      path: projectPath,
      configuration: projectConfiguration,
      authorizationClass: "host_local_project_registration",
      idempotencyKey: "embedded-state-project",
      expectedRevision: 0,
    });
    assert.equal(embeddedStateRejected.code, "project_path_invalid");
    await assert.rejects(readFile(join(embeddedStatePath, "project-registrations.json")));

    const invalidConfiguration = await registry.registerProject({
      requestId: "invalid-project-configuration",
      path: projectPath,
      configuration: {
        issueWorkflow: { provider: "github", kind: "issues" },
        checks: [],
      },
      authorizationClass: "host_local_project_registration",
      idempotencyKey: "invalid-project-configuration",
      expectedRevision: 0,
    });
    assert.equal(invalidConfiguration.code, "bounded_configuration_invalid");
    await assert.rejects(readFile(join(dataDir, "project-registrations.json"), "utf8"));

    const registrationRequest = {
      requestId: "accepted-project-registration",
      path: projectPath,
      configuration: projectConfiguration,
      authorizationClass: "host_local_project_registration",
      idempotencyKey: "accepted-project-registration",
      expectedRevision: 0,
    };
    const registration = await registry.registerProject(registrationRequest);
    assert.equal(registration.code, "project_registered");
    const registrationState = await readFile(
      join(dataDir, "project-registrations.json"),
      "utf8",
    );

    const changedRetry = await registry.registerProject({
      ...registrationRequest,
      requestId: "changed-registration-retry",
      path: anotherProjectPath,
    });
    assert.equal(changedRetry.code, "idempotency_key_conflict");
    assert.equal(changedRetry.retryable, false);
    assert.equal(
      await readFile(join(dataDir, "project-registrations.json"), "utf8"),
      registrationState,
    );

    const staleRegistration = await registry.registerProject({
      ...registrationRequest,
      requestId: "stale-project-registration",
      idempotencyKey: "stale-project-registration",
    });
    assert.equal(staleRegistration.code, "mutation_revision_conflict");
    assert.equal(staleRegistration.actualRevision, 1);

    const harness = await registry.registerConformanceHarness({
      requestId: "accepted-harness-registration",
      name: "Sand-King Conformance Harness",
      authorizationClass: "host_local_harness_registration",
      idempotencyKey: "accepted-harness-registration",
      expectedRevision: 0,
    });
    assert.equal(harness.code, "conformance_harness_registered");
    const unpinnedState = await readFile(join(dataDir, "project-registrations.json"), "utf8");
    const pinRequest = {
      requestId: "accepted-harness-pin",
      projectId: registration.project.projectId,
      harnessId: harness.harness.harnessId,
      boundedConfiguration: {
        adapterProtocol: "1.0.0",
        launchProfile: "delegated-work",
      },
      authorizationClass: "host_local_project_configuration",
      idempotencyKey: "accepted-harness-pin",
      expectedRevision: 1,
    };
    const invalidPinConfiguration = await registry.pinConformanceHarness({
      ...pinRequest,
      requestId: "invalid-pin-configuration",
      idempotencyKey: "invalid-pin-configuration",
      boundedConfiguration: { adapterProtocol: "2.0.0", unbounded: true },
    });
    assert.equal(invalidPinConfiguration.code, "bounded_configuration_invalid");
    const invalidFailuresPreservedUnpinned =
      await readFile(join(dataDir, "project-registrations.json"), "utf8") === unpinnedState;
    assert.equal(invalidFailuresPreservedUnpinned, true);

    const pinned = await registry.pinConformanceHarness(pinRequest);
    assert.equal(pinned.code, "project_harness_pinned");
    assert.equal(pinned.project.readiness.launchRequest, "ready");
    const replay = await registry.pinConformanceHarness({
      ...pinRequest,
      requestId: "replay-harness-pin",
    });
    assert.deepEqual(replay, {
      ...pinned,
      requestId: "replay-harness-pin",
      idempotentReplay: true,
    });
    const changedPinRetry = await registry.pinConformanceHarness({
      ...pinRequest,
      requestId: "changed-harness-pin-retry",
      boundedConfiguration: {
        adapterProtocol: "1.0.0",
        launchProfile: "changed",
      },
    });
    assert.equal(changedPinRetry.code, "idempotency_key_conflict");

    assert.ok(audits.some((entry) =>
      entry.action === "project.register"
      && entry.outcome === "rejected"
      && entry.details.code === "mutation_revision_conflict"));
    assert.ok(audits.filter((entry) => entry.action === "project.harness.pin").every((entry) =>
      entry.details.projectFileWrite === false || entry.outcome === "observed"));
    if (process.env.SANDKING_ACCEPTANCE_RESULT_DIR) {
      await mkdir(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, "project-mutation-contract.json"),
        `${JSON.stringify({
          kind: "project_mutation_contract",
          registration: {
            projectId: registration.project.projectId,
            expectedRevision: registration.expectedRevision,
            revision: registration.revision,
            auditId: registration.auditId,
          },
          idempotency: {
            changedRequestCode: changedRetry.code,
            changedRequestRetryable: changedRetry.retryable,
            replayCode: replay.code,
            replayAuditId: replay.auditId,
            replayIdempotent: replay.idempotentReplay,
            replayReturnedOriginalAudit: replay.auditId === pinned.auditId,
          },
          staleRevision: {
            code: staleRegistration.code,
            actualRevision: staleRegistration.actualRevision,
          },
          invalidFailures: {
            path: invalidPath.code,
            configuration: invalidConfiguration.code,
            missingPin: missingPin.code,
            invalidPin: invalidPin.code,
            invalidPinConfiguration: invalidPinConfiguration.code,
            preservedUnpinnedState: invalidFailuresPreservedUnpinned,
          },
          pin: {
            expectedRevision: pinned.expectedRevision,
            revision: pinned.revision,
            auditId: pinned.auditId,
          },
          auditReferences: audits,
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
