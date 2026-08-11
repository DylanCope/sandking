import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createHarnessRunManager } from "../src/harness-runs.mjs";
import { createProjectRegistry } from "../src/project-registration.mjs";

const execFileAsync = promisify(execFile);
const recordAudit = async () => `audit-${"1".repeat(24)}`;

const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
};
const retainedMainPinFingerprint = (request) =>
  `sha256:${createHash("sha256").update(canonicalJson(request)).digest("hex")}`;

const commitProject = async (projectPath) => {
  await execFileAsync("git", ["-C", projectPath, "add", "--all"]);
  await execFileAsync("git", [
    "-C", projectPath,
    "-c", "user.name=Project Fixture",
    "-c", "user.email=project-fixture@sandking.invalid",
    "-c", "commit.gpgSign=false",
    "commit", "--quiet", "-m", "Initialize disposable Project",
  ]);
};

const createFixture = async (root, name) => {
  const dataDir = join(root, `${name}-state`);
  const projectPath = join(root, `${name}-project`);
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
  await writeFile(join(projectPath, "README.md"), `${name} tracked content\n`);
  await commitProject(projectPath);
  const audits = [];
  const registry = await createProjectRegistry({
    dataDir,
    recordAudit: async (action, outcome, details) => {
      audits.push({ action, outcome, details });
      return `audit-${String(audits.length).padStart(24, "0")}`;
    },
  });
  const harness = await registry.registerSandcastleHarness({
    requestId: `${name}-register-harness`,
    name: "Sand-King Sandcastle Harness",
    authorizationClass: "host_local_harness_registration",
    idempotencyKey: `${name}-register-harness`,
    expectedRevision: 0,
  });
  const project = await registry.registerProject({
    requestId: `${name}-register-project`,
    path: projectPath,
    configuration: {
      issueWorkflow: { provider: "github", kind: "issues" },
      checks: [{ checkId: "test", command: "npm test" }],
    },
    authorizationClass: "host_local_project_registration",
    idempotencyKey: `${name}-register-project`,
    expectedRevision: 0,
  });
  const harnessStatePath = join(dataDir, "harness-registry.json");
  const harnessState = JSON.parse(await readFile(harnessStatePath, "utf8"));
  const workspacePath = harnessState.harnesses[0].workspacePath;
  const originalRevision = harness.harness.immutableRevision;
  const pin = (requestId, expectedRevision = 1) => registry.pinHarness({
    requestId,
    projectId: project.project.projectId,
    harnessId: harness.harness.harnessId,
    boundedConfiguration: {
      adapterProtocol: "1.0.0",
      launchProfile: "delegated-work",
    },
    authorizationClass: "host_local_project_configuration",
    idempotencyKey: `${name}-preparation`,
    expectedRevision,
  });
  const setRegisteredRevision = async (revision) => {
    const state = JSON.parse(await readFile(harnessStatePath, "utf8"));
    state.harnesses[0].immutableRevision = revision;
    state.harnesses[0].workspace.headRevision = revision;
    await writeFile(harnessStatePath, `${JSON.stringify(state, null, 2)}\n`);
  };
  const commitHarnessMutation = async (message) => {
    await execFileAsync("git", ["-C", workspacePath, "add", "--all"]);
    await execFileAsync("git", [
      "-C", workspacePath,
      "-c", "user.name=Harness Repair Fixture",
      "-c", "user.email=harness-repair@sandking.invalid",
      "-c", "commit.gpgSign=false",
      "commit", "--quiet", "-m", message,
    ]);
    const revision = (await execFileAsync(
      "git",
      ["-C", workspacePath, "rev-parse", "HEAD"],
    )).stdout.trim();
    await setRegisteredRevision(revision);
    return revision;
  };
  return {
    audits,
    dataDir,
    harness,
    originalRevision,
    pin,
    project,
    projectPath,
    registry,
    setRegisteredRevision,
    commitHarnessMutation,
    workspacePath,
  };
};

test("production preparation resolves the registered pin and projects only verified inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-preparation-"));
  const dataDir = join(root, "host-state");
  const projectPath = join(root, "project");

  try {
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
    await writeFile(join(projectPath, "README.md"), "tracked Project content\n");
    await commitProject(projectPath);
    const trackedBefore = (await execFileAsync(
      "git",
      ["-C", projectPath, "ls-files", "--stage"],
    )).stdout;

    const registry = await createProjectRegistry({ dataDir, recordAudit });
    const harness = await registry.registerSandcastleHarness({
      requestId: "register-production-harness",
      name: "Sand-King Sandcastle Harness",
      authorizationClass: "host_local_harness_registration",
      idempotencyKey: "register-production-harness",
      expectedRevision: 0,
    });
    const project = await registry.registerProject({
      requestId: "register-project",
      path: projectPath,
      configuration: {
        issueWorkflow: { provider: "github", kind: "issues" },
        checks: [{ checkId: "test", command: "npm test" }],
      },
      authorizationClass: "host_local_project_registration",
      idempotencyKey: "register-project",
      expectedRevision: 0,
    });

    const prepared = await registry.pinHarness({
      requestId: "prepare-production-harness",
      projectId: project.project.projectId,
      harnessId: harness.harness.harnessId,
      boundedConfiguration: {
        adapterProtocol: "1.0.0",
        launchProfile: "delegated-work",
      },
      authorizationClass: "host_local_project_configuration",
      idempotencyKey: "prepare-production-harness",
      expectedRevision: 1,
    });

    assert.equal(prepared.type, "project.harness.pin.result");
    assert.equal(prepared.project.harness.pinnedRevision, harness.harness.immutableRevision);
    assert.equal(prepared.project.harness.preparation.status, "ready");
    assert.deepEqual(prepared.project.harness.preparation.harness, {
      harnessId: harness.harness.harnessId,
      adapterId: "sandcastle-harness-adapter-v1",
      pinnedRevision: harness.harness.immutableRevision,
    });
    assert.match(
      prepared.project.harness.preparation.skillSetLockDigest,
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.deepEqual(
      prepared.project.harness.preparation.resolvedSkills.map(({ identity }) => identity),
      [
        "sandking.issue-implementation",
        "sandking.issue-planning",
        "sandking.pull-request-review",
        "sandking.real-delegation",
      ],
    );
    assert.ok(prepared.project.harness.preparation.resolvedSkills.every((skill) =>
      /^[a-f0-9]{40}$/.test(skill.revision)
      && /^sha256:[a-f0-9]{64}$/.test(skill.contentIntegrity)));
    assert.deepEqual(
      prepared.project.harness.preparation.executionRuntimeInputs.map((input) => ({
        identity: input.identity,
        version: input.version,
      })),
      [{ identity: "openai.codex-cli", version: "0.146.0" }],
    );

    const projectionPath = join(
      projectPath,
      ...prepared.project.harness.preparation.projection.path.split("/"),
    );
    const workerEnvironment = JSON.parse(await readFile(
      join(projectionPath, "worker-environment.json"),
      "utf8",
    ));
    assert.deepEqual(workerEnvironment.skillDiscovery, {
      ambient: "disabled",
      roots: ["worker-skills"],
      unlisted: "reject",
    });
    assert.deepEqual(
      (await readdir(join(projectionPath, "worker-skills"))).sort(),
      [
        "sandking.issue-implementation",
        "sandking.issue-planning",
        "sandking.pull-request-review",
        "sandking.real-delegation",
      ],
    );
    assert.equal(
      (await execFileAsync("git", [
        "-C", projectPath,
        "check-ignore", "--no-index", "--quiet",
        join(projectionPath, "worker-environment.json"),
      ])).stderr,
      "",
    );
    assert.equal(
      (await execFileAsync("git", ["-C", projectPath, "status", "--porcelain=v1"])).stdout,
      "",
    );
    assert.equal(
      (await execFileAsync("git", ["-C", projectPath, "ls-files", "--stage"])).stdout,
      trackedBefore,
    );

    const retried = await registry.pinHarness({
      requestId: "retry-production-preparation",
      projectId: project.project.projectId,
      harnessId: harness.harness.harnessId,
      boundedConfiguration: {
        adapterProtocol: "1.0.0",
        launchProfile: "delegated-work",
      },
      authorizationClass: "host_local_project_configuration",
      idempotencyKey: "retry-production-preparation",
      expectedRevision: 2,
    });
    assert.equal(retried.code, "project_harness_pin_reused");
    assert.deepEqual(retried.project.harness.preparation, prepared.project.harness.preparation);
    assert.equal(
      (await execFileAsync("git", ["-C", projectPath, "status", "--porcelain=v1"])).stdout,
      "",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retained main-era production registrations prepare and replay after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-retained-production-registration-"));

  try {
    const fixture = await createFixture(root, "retained-production-registration");
    const conformanceHarness = await fixture.registry.registerConformanceHarness({
      requestId: "register-retained-conformance-harness",
      name: "Sand-King Conformance Harness",
      authorizationClass: "host_local_harness_registration",
      idempotencyKey: "register-retained-conformance-harness",
      expectedRevision: 0,
    });
    const conformancePin = await fixture.registry.pinHarness({
      requestId: "retain-main-era-conformance-pin",
      projectId: fixture.project.project.projectId,
      harnessId: conformanceHarness.harness.harnessId,
      boundedConfiguration: {
        adapterProtocol: "1.0.0",
        launchProfile: "delegated-work",
      },
      authorizationClass: "host_local_project_configuration",
      idempotencyKey: "retained-main-era-conformance-pin",
      expectedRevision: 1,
    });
    const pinned = await fixture.pin("retain-main-era-production-pin", 2);
    const otherProjectPath = join(root, "other-project");
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", otherProjectPath]);
    await writeFile(join(otherProjectPath, "README.md"), "other tracked content\n");
    await commitProject(otherProjectPath);
    const otherProject = await fixture.registry.registerProject({
      requestId: "register-other-project",
      path: otherProjectPath,
      configuration: {
        issueWorkflow: { provider: "github", kind: "issues" },
        checks: [{ checkId: "test", command: "npm test" }],
      },
      authorizationClass: "host_local_project_registration",
      idempotencyKey: "register-other-project",
      expectedRevision: 0,
    });

    const projectStatePath = join(fixture.dataDir, "project-registrations.json");
    const retainedMainState = JSON.parse(await readFile(projectStatePath, "utf8"));
    retainedMainState.schemaVersion = 1;
    delete retainedMainState.projects[0].harness.preparation;
    delete retainedMainState.pinOutcomes[1].response.project.harness.preparation;
    retainedMainState.pinOutcomes[0].requestFingerprint = retainedMainPinFingerprint({
      projectId: fixture.project.project.projectId,
      harnessId: conformanceHarness.harness.harnessId,
      immutableRevision: conformanceHarness.harness.immutableRevision,
      boundedConfiguration: {
        adapterProtocol: "1.0.0",
        launchProfile: "delegated-work",
      },
      authorizationClass: "host_local_project_configuration",
      expectedRevision: 1,
    });
    retainedMainState.pinOutcomes[1].requestFingerprint = retainedMainPinFingerprint({
      projectId: fixture.project.project.projectId,
      harnessId: fixture.harness.harness.harnessId,
      immutableRevision: fixture.harness.harness.immutableRevision,
      boundedConfiguration: {
        adapterProtocol: "1.0.0",
        launchProfile: "delegated-work",
      },
      authorizationClass: "host_local_project_configuration",
      expectedRevision: 2,
    });
    await writeFile(projectStatePath, `${JSON.stringify(retainedMainState, null, 2)}\n`);
    await rm(join(
      fixture.projectPath,
      ...pinned.project.harness.preparation.projection.path.split("/"),
    ), { recursive: true });

    const restarted = await createProjectRegistry({
      dataDir: fixture.dataDir,
      recordAudit,
    });
    const unaffected = await restarted.inspectProject({
      requestId: "inspect-unaffected-project",
      path: otherProjectPath,
    });
    assert.equal(unaffected.code, "project_registered");
    assert.equal(unaffected.project.projectId, otherProject.project.projectId);
    const reusedUnaffected = await restarted.registerProject({
      requestId: "reuse-unaffected-project",
      path: otherProjectPath,
      configuration: {
        issueWorkflow: { provider: "github", kind: "issues" },
        checks: [{ checkId: "test", command: "npm test" }],
      },
      authorizationClass: "host_local_project_registration",
      idempotencyKey: "reuse-unaffected-project",
      expectedRevision: otherProject.project.revision,
    });
    assert.equal(reusedUnaffected.code, "project_registration_reused");
    const partiallyMigratedState = JSON.parse(await readFile(projectStatePath, "utf8"));
    assert.equal(partiallyMigratedState.schemaVersion, 1);
    assert.equal(partiallyMigratedState.projects[0].harness.preparation, undefined);
    const migratedInspection = await restarted.inspectProject({
      requestId: "inspect-retained-production-project",
      path: fixture.projectPath,
    });
    assert.equal(migratedInspection.code, "project_registered");
    assert.equal(migratedInspection.project.revision, pinned.project.revision);
    assert.equal(migratedInspection.project.harness.preparation.status, "ready");

    const replayed = await restarted.pinHarness({
      requestId: "replay-retained-main-era-pin",
      projectId: fixture.project.project.projectId,
      harnessId: fixture.harness.harness.harnessId,
      boundedConfiguration: {
        adapterProtocol: "1.0.0",
        launchProfile: "delegated-work",
      },
      authorizationClass: "host_local_project_configuration",
      idempotencyKey: "retained-production-registration-preparation",
      expectedRevision: 2,
    });
    assert.equal(replayed.type, "project.harness.pin.result");
    assert.equal(replayed.idempotentReplay, true);
    assert.equal(replayed.auditId, pinned.auditId);
    assert.equal(replayed.revision, pinned.revision);
    assert.equal(replayed.project.harness.preparation.status, "ready");
    assert.equal(
      replayed.project.harness.preparation.harness.pinnedRevision,
      fixture.harness.harness.immutableRevision,
    );
    const replayedConformancePin = await restarted.pinHarness({
      requestId: "replay-retained-main-era-conformance-pin",
      projectId: fixture.project.project.projectId,
      harnessId: conformanceHarness.harness.harnessId,
      boundedConfiguration: {
        adapterProtocol: "1.0.0",
        launchProfile: "delegated-work",
      },
      authorizationClass: "host_local_project_configuration",
      idempotencyKey: "retained-main-era-conformance-pin",
      expectedRevision: 1,
    });
    assert.equal(replayedConformancePin.type, "project.harness.pin.result");
    assert.equal(replayedConformancePin.idempotentReplay, true);
    assert.equal(replayedConformancePin.auditId, conformancePin.auditId);
    assert.equal(
      replayedConformancePin.project.harness.adapterId,
      "conformance-harness-adapter-v1",
    );

    const launchContext = await restarted.loadLaunchContext(
      fixture.project.project.projectId,
    );
    assert.deepEqual(
      launchContext.project.harness.preparation,
      replayed.project.harness.preparation,
    );
    assert.equal(
      launchContext.productionHarnessProjectionPath,
      join(
        fixture.projectPath,
        ...replayed.project.harness.preparation.projection.path.split("/"),
      ),
    );
    const migratedState = JSON.parse(await readFile(projectStatePath, "utf8"));
    assert.equal(migratedState.schemaVersion, 2);
    assert.deepEqual(
      migratedState.projects[0].harness.preparation,
      replayed.project.harness.preparation,
    );
    assert.equal(
      migratedState.pinOutcomes[1].requestFingerprint,
      retainedMainPinFingerprint({
        projectId: fixture.project.project.projectId,
        harnessId: fixture.harness.harness.harnessId,
        immutableRevision: fixture.harness.harness.immutableRevision,
        boundedConfiguration: {
          adapterProtocol: "1.0.0",
          launchProfile: "delegated-work",
        },
        authorizationClass: "host_local_project_configuration",
        expectedRevision: 2,
      }),
    );
    assert.equal(
      migratedState.pinOutcomes[0].requestFingerprint,
      retainedMainPinFingerprint({
        projectId: fixture.project.project.projectId,
        harnessId: conformanceHarness.harness.harnessId,
        immutableRevision: conformanceHarness.harness.immutableRevision,
        boundedConfiguration: {
          adapterProtocol: "1.0.0",
          launchProfile: "delegated-work",
        },
        authorizationClass: "host_local_project_configuration",
        expectedRevision: 1,
      }),
    );
    assert.equal(
      (await execFileAsync("git", ["-C", fixture.projectPath, "status", "--porcelain=v1"])).stdout,
      "",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary registration readiness revalidates retained production projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-readiness-revalidation-"));

  try {
    const fixture = await createFixture(root, "readiness-revalidation");
    const prepared = await fixture.pin("prepare-before-readiness-drift");
    const projectionPath = join(
      fixture.projectPath,
      ...prepared.project.harness.preparation.projection.path.split("/"),
    );
    const workerEnvironmentPath = join(projectionPath, "worker-environment.json");
    const originalWorkerEnvironment = await readFile(workerEnvironmentPath, "utf8");
    await writeFile(
      workerEnvironmentPath,
      `${originalWorkerEnvironment}\n{"ambient":"enabled"}\n`,
    );

    const driftedInspection = await fixture.registry.inspectProject({
      requestId: "inspect-drifted-production-project",
      path: fixture.projectPath,
    });
    assert.equal(driftedInspection.type, "project.operation.failure");
    assert.equal(driftedInspection.operation, "project.inspect");
    assert.equal(driftedInspection.code, "harness_projection_collision");
    assert.equal(driftedInspection.prohibitedSideEffects.projectFileWrite, false);

    const driftedRegistration = await fixture.registry.registerProject({
      requestId: "reopen-drifted-production-project",
      path: fixture.projectPath,
      configuration: fixture.project.project.configuration,
      authorizationClass: "host_local_project_registration",
      idempotencyKey: "reopen-drifted-production-project",
      expectedRevision: prepared.project.revision,
    });
    assert.equal(driftedRegistration.type, "project.operation.failure");
    assert.equal(driftedRegistration.operation, "project.register");
    assert.equal(driftedRegistration.code, "harness_projection_collision");
    assert.equal(driftedRegistration.prohibitedSideEffects.projectFileWrite, false);

    const driftedPinReplay = await fixture.pin("replay-pin-with-readiness-drift");
    assert.equal(driftedPinReplay.type, "project.operation.failure");
    assert.equal(driftedPinReplay.operation, "project.harness.pin");
    assert.equal(driftedPinReplay.code, "harness_projection_collision");
    assert.equal(driftedPinReplay.prohibitedSideEffects.harnessPinWrite, false);

    await writeFile(workerEnvironmentPath, originalWorkerEnvironment);
    const recoveredInspection = await fixture.registry.inspectProject({
      requestId: "inspect-recovered-production-project",
      path: fixture.projectPath,
    });
    assert.equal(recoveredInspection.type, "project.inspect.result");
    assert.equal(recoveredInspection.project.readiness.launchRequest, "ready");
    assert.equal(recoveredInspection.project.harness.preparation.status, "ready");

    const recoveredRegistration = await fixture.registry.registerProject({
      requestId: "reopen-recovered-production-project",
      path: fixture.projectPath,
      configuration: fixture.project.project.configuration,
      authorizationClass: "host_local_project_registration",
      idempotencyKey: "reopen-recovered-production-project",
      expectedRevision: prepared.project.revision,
    });
    assert.equal(recoveredRegistration.type, "project.register.result");
    assert.equal(recoveredRegistration.code, "project_registration_reused");
    assert.equal(recoveredRegistration.project.readiness.launchRequest, "ready");

    const recoveredPinReplay = await fixture.pin("replay-pin-after-readiness-recovery");
    assert.equal(recoveredPinReplay.type, "project.harness.pin.result");
    assert.equal(recoveredPinReplay.idempotentReplay, true);
    assert.equal(recoveredPinReplay.project.harness.preparation.status, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production pinning rejects a replacement repository before projection writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-replaced-project-"));

  try {
    const fixture = await createFixture(root, "replaced-project");
    const movedProjectPath = join(root, "registered-project-moved");
    await rename(fixture.projectPath, movedProjectPath);
    await execFileAsync("git", [
      "init", "--quiet", "--initial-branch=main", fixture.projectPath,
    ]);
    await writeFile(
      join(fixture.projectPath, "README.md"),
      "unrelated replacement repository content\n",
    );
    await commitProject(fixture.projectPath);
    const replacementExcludePath = join(fixture.projectPath, ".git", "info", "exclude");
    const replacementExcludeBefore = await readFile(replacementExcludePath, "utf8");
    const projectStateBefore = await readFile(
      join(fixture.dataDir, "project-registrations.json"),
      "utf8",
    );

    const rejected = await fixture.pin("pin-replacement-repository");
    assert.equal(rejected.type, "project.operation.failure");
    assert.equal(rejected.operation, "project.harness.pin");
    assert.equal(rejected.code, "project_path_replaced");
    assert.equal(rejected.prohibitedSideEffects.projectFileWrite, false);
    assert.equal(rejected.prohibitedSideEffects.harnessPinWrite, false);
    assert.equal(
      await readFile(replacementExcludePath, "utf8"),
      replacementExcludeBefore,
    );
    assert.equal((await readdir(fixture.projectPath)).includes(".sandking"), false);
    assert.equal(
      await readFile(join(fixture.dataDir, "project-registrations.json"), "utf8"),
      projectStateBefore,
    );
    assert.equal(
      (await execFileAsync("git", [
        "-C", fixture.projectPath, "status", "--porcelain=v1",
      ])).stdout,
      "",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production pinning rejects aliased Git exclude files without mutating either Project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-exclude-alias-"));

  try {
    for (const aliasKind of ["symbolic-link", "hard-link", "parent-symbolic-link"]) {
      await t.test(aliasKind, async () => {
        const fixture = await createFixture(root, `exclude-${aliasKind}`);
        const unrelatedProjectPath = join(root, `unrelated-${aliasKind}-project`);
        await execFileAsync("git", [
          "init", "--quiet", "--initial-branch=main", unrelatedProjectPath,
        ]);
        const unrelatedTrackedPath = aliasKind === "parent-symbolic-link"
          ? join(unrelatedProjectPath, "git-info", "exclude")
          : join(unrelatedProjectPath, "README.md");
        const unrelatedTrackedSource = `unrelated ${aliasKind} tracked content\n`;
        await mkdir(join(unrelatedTrackedPath, ".."), { recursive: true });
        await writeFile(unrelatedTrackedPath, unrelatedTrackedSource);
        await commitProject(unrelatedProjectPath);

        const infoPath = join(fixture.projectPath, ".git", "info");
        const excludePath = join(fixture.projectPath, ".git", "info", "exclude");
        const aliasPath = aliasKind === "parent-symbolic-link" ? infoPath : excludePath;
        await rm(aliasPath, { recursive: true });
        if (aliasKind === "symbolic-link") {
          await symlink(unrelatedTrackedPath, excludePath);
        } else if (aliasKind === "parent-symbolic-link") {
          await symlink(join(unrelatedProjectPath, "git-info"), infoPath);
        } else {
          await link(unrelatedTrackedPath, excludePath);
        }
        const aliasBefore = await lstat(aliasPath);
        const projectStateBefore = await readFile(
          join(fixture.dataDir, "project-registrations.json"),
          "utf8",
        );

        const rejected = await fixture.pin(`pin-${aliasKind}-exclude`);
        assert.equal(rejected.type, "project.operation.failure");
        assert.equal(rejected.operation, "project.harness.pin");
        assert.equal(rejected.code, "harness_projection_collision");
        assert.equal(rejected.prohibitedSideEffects.projectFileWrite, false);
        assert.equal(rejected.prohibitedSideEffects.harnessPinWrite, false);
        assert.equal(
          await readFile(unrelatedTrackedPath, "utf8"),
          unrelatedTrackedSource,
        );
        const aliasAfter = await lstat(aliasPath);
        assert.equal(aliasAfter.dev, aliasBefore.dev);
        assert.equal(aliasAfter.ino, aliasBefore.ino);
        assert.equal(
          await readFile(join(fixture.dataDir, "project-registrations.json"), "utf8"),
          projectStateBefore,
        );
        assert.equal((await readdir(fixture.projectPath)).includes(".sandking"), false);
        assert.equal(
          (await execFileAsync("git", [
            "-C", fixture.projectPath, "status", "--porcelain=v1",
          ])).stdout,
          "",
        );
        assert.equal(
          (await execFileAsync("git", [
            "-C", unrelatedProjectPath, "status", "--porcelain=v1",
          ])).stdout,
          "",
        );
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production pinning rejects a tracked nested-repository ancestor before projection writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-gitlink-collision-"));

  try {
    const fixture = await createFixture(root, "gitlink-collision");
    const nestedProjectPath = join(fixture.projectPath, ".sandking", "harnesses");
    await execFileAsync("git", [
      "init", "--quiet", "--initial-branch=main", nestedProjectPath,
    ]);
    const nestedReadmePath = join(nestedProjectPath, "README.md");
    const nestedReadme = "tracked nested Project content\n";
    await writeFile(nestedReadmePath, nestedReadme);
    await commitProject(nestedProjectPath);
    await commitProject(fixture.projectPath);
    const trackedInventoryBefore = (await execFileAsync("git", [
      "-C", fixture.projectPath, "ls-files", "--stage",
    ])).stdout;
    assert.match(trackedInventoryBefore, /^160000 [a-f0-9]{40} 0\t\.sandking\/harnesses$/m);
    const projectStateBefore = await readFile(
      join(fixture.dataDir, "project-registrations.json"),
      "utf8",
    );

    const rejected = await fixture.pin("pin-through-tracked-gitlink");
    assert.equal(rejected.type, "project.operation.failure");
    assert.equal(rejected.operation, "project.harness.pin");
    assert.equal(rejected.code, "harness_projection_collision");
    assert.equal(rejected.prohibitedSideEffects.projectFileWrite, false);
    assert.equal(rejected.prohibitedSideEffects.harnessPinWrite, false);
    assert.equal(await readFile(nestedReadmePath, "utf8"), nestedReadme);
    await assert.rejects(
      readFile(join(
        nestedProjectPath,
        fixture.harness.harness.harnessId,
        "projection-manifest.json",
      )),
      { code: "ENOENT" },
    );
    assert.equal(
      await readFile(join(fixture.dataDir, "project-registrations.json"), "utf8"),
      projectStateBefore,
    );
    assert.equal(
      (await execFileAsync("git", [
        "-C", fixture.projectPath, "ls-files", "--stage",
      ])).stdout,
      trackedInventoryBefore,
    );
    assert.equal(
      (await execFileAsync("git", [
        "-C", fixture.projectPath, "status", "--porcelain=v1",
      ])).stdout,
      "",
    );
    assert.equal(
      (await execFileAsync("git", [
        "-C", nestedProjectPath, "status", "--porcelain=v1",
      ])).stdout,
      "",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production preparation failures are typed, side-effect free, and recoverable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-preparation-failures-"));

  try {
    const cases = [
      {
        name: "unreadable-pin",
        code: "harness_pin_unreadable",
        break: async (fixture) => {
          await fixture.setRegisteredRevision("f".repeat(40));
          return () => fixture.setRegisteredRevision(fixture.originalRevision);
        },
      },
      {
        name: "altered-adapter-bytes",
        code: "harness_adapter_bytes_mismatch",
        break: async (fixture) => {
          const path = join(fixture.workspacePath, "adapters", "sandcastle.mjs");
          const original = await readFile(path, "utf8");
          await writeFile(path, `${original}\n// mutable workspace drift\n`);
          return () => writeFile(path, original);
        },
      },
      {
        name: "unsupported-compatibility",
        code: "harness_compatibility_unsupported",
        break: async (fixture) => {
          const path = join(fixture.workspacePath, "harness.json");
          const original = await readFile(path, "utf8");
          const unsupported = JSON.parse(original);
          unsupported.compatibility.adapterProtocol = "2.0.0";
          await writeFile(path, `${JSON.stringify(unsupported, null, 2)}\n`);
          await fixture.commitHarnessMutation("Introduce unsupported compatibility");
          return async () => {
            await writeFile(path, original);
            await fixture.commitHarnessMutation("Restore supported compatibility");
          };
        },
      },
      {
        name: "missing-skill-lock",
        code: "harness_skill_lock_missing",
        break: async (fixture) => {
          const path = join(fixture.workspacePath, "skills.lock.json");
          const original = await readFile(path, "utf8");
          await rm(path);
          await fixture.commitHarnessMutation("Remove the committed skill lock");
          return async () => {
            await writeFile(path, original);
            await fixture.commitHarnessMutation("Restore the committed skill lock");
          };
        },
      },
      {
        name: "invalid-skill-lock-schema",
        code: "harness_skill_lock_invalid",
        break: async (fixture) => {
          const path = join(fixture.workspacePath, "skills.lock.json");
          const original = await readFile(path, "utf8");
          const invalid = JSON.parse(original);
          invalid.policy.ambientDiscovery = "enabled";
          await writeFile(path, `${JSON.stringify(invalid, null, 2)}\n`);
          await fixture.commitHarnessMutation("Invalidate the committed skill lock schema");
          return async () => {
            await writeFile(path, original);
            await fixture.commitHarnessMutation("Restore the skill lock schema");
          };
        },
      },
      {
        name: "incomplete-skill-inventory",
        code: "harness_skill_lock_invalid",
        break: async (fixture) => {
          const path = join(fixture.workspacePath, ".sandcastle", "main.mts");
          const original = await readFile(path, "utf8");
          await writeFile(
            path,
            `${original}\nvoid { promptFile: "./.sandcastle/CODING_STANDARDS.md" };\n`,
          );
          await fixture.commitHarnessMutation("Expose an unlocked Worker skill");
          return async () => {
            await writeFile(path, original);
            await fixture.commitHarnessMutation("Restore the locked Worker inventory");
          };
        },
      },
      {
        name: "ambient-only-locked-skill",
        code: "harness_locked_skill_unavailable",
        break: async (fixture) => {
          const path = join(fixture.workspacePath, ".sandcastle", "implement-prompt.md");
          const original = await readFile(path, "utf8");
          await rm(path);
          await fixture.commitHarnessMutation("Remove one locked skill source");
          const ambientPath = join(
            root,
            "ambient-user-skills",
            "sandking.issue-implementation",
            "SKILL.md",
          );
          await mkdir(join(ambientPath, ".."), { recursive: true });
          await writeFile(ambientPath, original);
          return async () => {
            await writeFile(path, original);
            await fixture.commitHarnessMutation("Restore the locked skill source");
          };
        },
      },
      {
        name: "mismatched-locked-skill",
        code: "harness_skill_integrity_mismatch",
        break: async (fixture) => {
          const path = join(fixture.workspacePath, ".sandcastle", "plan-prompt.md");
          const original = await readFile(path, "utf8");
          await writeFile(path, `${original}\nUnverified instruction.\n`);
          await fixture.commitHarnessMutation("Alter locked skill bytes");
          return async () => {
            await writeFile(path, original);
            await fixture.commitHarnessMutation("Restore locked skill bytes");
          };
        },
      },
      {
        name: "mutable-runtime-input",
        code: "harness_projection_failed",
        break: async (fixture) => {
          const path = join(fixture.workspacePath, ".sandcastle", "main.mts");
          const original = await readFile(path, "utf8");
          await writeFile(path, `${original}\n// mutable runtime drift\n`);
          return () => writeFile(path, original);
        },
      },
      {
        name: "tracked-projection-collision",
        code: "harness_projection_collision",
        break: async (fixture) => {
          const path = join(
            fixture.projectPath,
            ".sandking",
            "harnesses",
            fixture.harness.harness.harnessId,
            "unrelated.txt",
          );
          await mkdir(join(path, ".."), { recursive: true });
          await writeFile(path, "unrelated tracked Project content\n");
          await commitProject(fixture.projectPath);
          return async () => {
            await rm(join(
              fixture.projectPath,
              ".sandking",
              "harnesses",
              fixture.harness.harness.harnessId,
            ), { recursive: true });
            await commitProject(fixture.projectPath);
          };
        },
      },
    ];

    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        const fixture = await createFixture(root, scenario.name);
        const recover = await scenario.break(fixture);
        const trackedBefore = (await execFileAsync("git", [
          "-C", fixture.projectPath, "status", "--porcelain=v1", "--untracked-files=no",
        ])).stdout;
        const failed = await fixture.pin(`${scenario.name}-failed`);
        assert.equal(failed.type, "project.operation.failure");
        assert.equal(failed.operation, "project.harness.pin");
        assert.equal(failed.code, scenario.code);
        assert.equal(failed.prohibitedSideEffects.projectFileWrite, false);
        assert.equal(failed.prohibitedSideEffects.harnessPinWrite, false);
        assert.equal((await execFileAsync("git", [
          "-C", fixture.projectPath, "status", "--porcelain=v1", "--untracked-files=no",
        ])).stdout, trackedBefore);
        const failedState = JSON.parse(await readFile(
          join(fixture.dataDir, "project-registrations.json"),
          "utf8",
        ));
        assert.equal(failedState.projects[0].harness, null);
        assert.equal(failedState.projects[0].readiness.launchRequest, "blocked");
        assert.equal(fixture.audits.at(-1).details.harnessRunCreated, false);
        assert.equal(fixture.audits.at(-1).details.adapterStarted, false);

        await recover();
        const recovered = await fixture.pin(`${scenario.name}-recovered`);
        assert.equal(recovered.type, "project.harness.pin.result");
        assert.equal(recovered.code, "project_harness_pinned");
        assert.equal(recovered.project.harness.preparation.status, "ready");
        assert.equal(recovered.project.harness.pinnedRevision,
          recovered.harness.immutableRevision);
        assert.equal((await execFileAsync("git", [
          "-C", fixture.projectPath, "status", "--porcelain=v1",
        ])).stdout, "");
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-readiness projection drift fails before a Harness run or adapter starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-prelaunch-drift-"));

  try {
    const fixture = await createFixture(root, "prelaunch-drift");
    const prepared = await fixture.pin("prepare-before-drift");
    const projectionPath = join(
      fixture.projectPath,
      ...prepared.project.harness.preparation.projection.path.split("/"),
    );
    const workerEnvironmentPath = join(projectionPath, "worker-environment.json");
    const originalWorkerEnvironment = await readFile(workerEnvironmentPath, "utf8");
    await writeFile(
      workerEnvironmentPath,
      `${originalWorkerEnvironment}\n{"ambient":"enabled"}\n`,
    );

    const manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId: `host-${"2".repeat(24)}`,
      recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
    });
    const rejected = await manager.launch({
      requestId: "launch-with-projection-drift",
      projectId: fixture.project.project.projectId,
      parameters: {},
      controllerId: `runtime-${"3".repeat(24)}`,
      controllerSessionId: null,
      source: "cockpit",
      authorizationClass: "harness_run_launch",
      idempotencyKeyHash: `sha256:${"4".repeat(64)}`,
    });
    assert.equal(rejected.type, "harness.run.launch.failure");
    assert.equal(rejected.code, "harness_projection_collision");
    assert.equal(rejected.retryable, true);
    assert.deepEqual(rejected.prohibitedSideEffects, {
      harnessRunCreated: false,
      adapterStarted: false,
      projectWrite: false,
    });
    const retained = JSON.parse(await readFile(
      join(fixture.dataDir, "harness-runs.json"),
      "utf8",
    ));
    assert.deepEqual(retained.runs, []);

    await writeFile(workerEnvironmentPath, originalWorkerEnvironment);
    const recoveredContext = await fixture.registry.loadLaunchContext(
      fixture.project.project.projectId,
    );
    assert.equal(
      recoveredContext.productionHarnessProjectionPath,
      projectionPath,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
