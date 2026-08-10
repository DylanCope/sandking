import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { SANDCASTLE_HARNESS_ADAPTER_ID } from "../src/harness-adapter-identity.mjs";
import { createProjectRegistry } from "../src/project-registration.mjs";
import { initializeProductionHarnessWorkspace } from "../src/production-harness-seed.mjs";

const execFileAsync = promisify(execFile);

const recordAudit = async () => `audit-${"1".repeat(24)}`;

const rewriteLockedSeedFile = async (sourceRoot, relativePath, source) => {
  await writeFile(join(sourceRoot, relativePath), source);
  const manifestPath = join(sourceRoot, "seed-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files.find((file) => file.path === relativePath).integrity =
    `sha256:${createHash("sha256").update(source).digest("hex")}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
};

const rewriteLockedSeedJson = async (sourceRoot, relativePath, transform) => {
  const path = join(sourceRoot, relativePath);
  const value = JSON.parse(await readFile(path, "utf8"));
  transform(value);
  const source = `${JSON.stringify(value, null, 2)}\n`;
  await rewriteLockedSeedFile(sourceRoot, relativePath, source);
};

const removeLockedSeedFile = async (sourceRoot, relativePath) => {
  await rm(join(sourceRoot, relativePath));
  const manifestPath = join(sourceRoot, "seed-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files = manifest.files.filter((file) => file.path !== relativePath);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
};

test("fresh Hosts seed and pin one reproducible production Sandcastle Harness", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-harness-seed-"));
  const firstDataDir = join(root, "first-host-state");
  const secondDataDir = join(root, "second-host-state");
  const projectPath = join(root, "selected-project");

  try {
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
    const firstRegistry = await createProjectRegistry({
      dataDir: firstDataDir,
      recordAudit,
    });
    const secondRegistry = await createProjectRegistry({
      dataDir: secondDataDir,
      recordAudit,
    });
    const request = {
      requestId: "register-production-harness",
      name: "Sand-King Sandcastle Harness",
      authorizationClass: "host_local_harness_registration",
      idempotencyKey: "register-production-harness",
      expectedRevision: 0,
    };

    const first = await firstRegistry.registerSandcastleHarness(request);
    const second = await secondRegistry.registerSandcastleHarness(request);
    assert.equal(first.type, "harness.sandcastle.register.result");
    assert.equal(first.code, "sandcastle_harness_registered");
    assert.equal(first.harness.adapterId, SANDCASTLE_HARNESS_ADAPTER_ID);
    assert.equal(first.harness.kind, "production");
    assert.equal(first.harness.immutableRevision, second.harness.immutableRevision);
    assert.equal(
      first.harness.workspace.headRevision,
      first.harness.immutableRevision,
    );

    const firstState = JSON.parse(await readFile(
      join(firstDataDir, "harness-registry.json"),
      "utf8",
    ));
    const workspacePath = firstState.harnesses[0].workspacePath;
    assert.match(relative(firstDataDir, workspacePath), /^\.\./);
    assert.equal(
      (await execFileAsync("git", ["-C", workspacePath, "rev-parse", "HEAD"]))
        .stdout.trim(),
      first.harness.immutableRevision,
    );
    const commitMessage = (await execFileAsync(
      "git",
      ["-C", workspacePath, "log", "-1", "--format=%B"],
    )).stdout;
    assert.match(commitMessage,
      /Sand-King-Seed: https:\/\/github\.com\/DylanCope\/sandking\.git@[a-f0-9]{40}/);
    assert.match(commitMessage, /Sand-King-Seed-Source: sha256:[a-f0-9]{64}/);
    assert.match(commitMessage,
      /Upstream-Sandcastle: https:\/\/github\.com\/mattpocock\/sandcastle\.git@e99f832/);
    assert.match(commitMessage, /Sandcastle-Package: @ai-hero\/sandcastle@0\.12\.0/);
    assert.match(commitMessage, /Dependency-Lock: sha256:[a-f0-9]{64}/);
    assert.match(commitMessage, /Skill-Set-Lock: sha256:[a-f0-9]{64}/);

    const provenance = JSON.parse(await readFile(
      join(workspacePath, "provenance.json"),
      "utf8",
    ));
    assert.equal(provenance.sandKing.repository, "https://github.com/DylanCope/sandking.git");
    assert.equal(
      provenance.sandKing.revision,
      "e239c0ec5a3db8b6e41b99ce62022f1dff34cd9d",
    );
    const seedManifest = JSON.parse(await readFile(
      join(workspacePath, "seed-manifest.json"),
      "utf8",
    ));
    for (const file of seedManifest.files.filter(({ path }) =>
      path !== "provenance.json" && path !== "skills.lock.json")) {
      const materializationPath = file.sourcePath ?? file.path;
      const sourcePath = file.source === "seed"
        ? `src/bundled-production-harness/${materializationPath}`
        : materializationPath;
      const sourceAtRevision = (await execFileAsync("git", [
        "show", `${provenance.sandKing.revision}:${sourcePath}`,
      ])).stdout;
      assert.equal(
        `sha256:${createHash("sha256").update(sourceAtRevision).digest("hex")}`,
        file.integrity,
        `${file.path} must originate at the recorded Sand-King revision`,
      );
    }
    const seedSourceInventory = seedManifest.files
      .filter(({ path }) => path !== "provenance.json" && path !== "skills.lock.json")
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
      .map((file) => JSON.stringify({
        path: file.path,
        source: file.source,
        sourcePath: file.sourcePath ?? file.path,
        integrity: file.integrity,
        executable: file.executable,
      }))
      .join("\n") + "\n";
    assert.equal(
      provenance.sandKing.seedSourceIntegrity,
      `sha256:${createHash("sha256").update(seedSourceInventory).digest("hex")}`,
    );
    assert.deepEqual(provenance.sandcastle, {
      repository: "https://github.com/mattpocock/sandcastle.git",
      revision: "e99f832f26dc9d245c019a9ddd19fa5dee792427",
      package: "@ai-hero/sandcastle",
      version: "0.12.0",
    });
    assert.equal(
      provenance.artifacts.dependencyLock.integrity,
      seedManifest.files.find(({ path }) => path === "package-lock.json").integrity,
    );
    assert.equal(
      provenance.artifacts.skillSetLock.integrity,
      seedManifest.files.find(({ path }) => path === "skills.lock.json").integrity,
    );
    const orchestrationSource = await readFile(
      join(workspacePath, ".sandcastle", "main.mts"),
      "utf8",
    );
    assert.match(orchestrationSource,
      /import \* as sandcastle from "@ai-hero\/sandcastle";/);
    assert.match(orchestrationSource,
      /from "@ai-hero\/sandcastle\/sandboxes\/docker";/);

    const packageManifest = JSON.parse(await readFile(
      join(workspacePath, "package.json"),
      "utf8",
    ));
    const dependencyLock = JSON.parse(await readFile(
      join(workspacePath, "package-lock.json"),
      "utf8",
    ));
    assert.equal(packageManifest.dependencies["@ai-hero/sandcastle"], "0.12.0");
    assert.equal(
      typeof dependencyLock.packages["node_modules/@ai-hero/sandcastle"],
      "object",
    );
    assert.equal(
      dependencyLock.packages["node_modules/@ai-hero/sandcastle"].resolved,
      "https://registry.npmjs.org/@ai-hero/sandcastle/-/sandcastle-0.12.0.tgz",
    );
    assert.equal(
      dependencyLock.packages["node_modules/@ai-hero/sandcastle"].integrity,
      "sha512-kdQ414rM8t1QiWeqZ3Klz4KSd0PqQG4bRVuqGpRDUomWhojSZkEAc1tbcEcThVmBEaHkCt8LmYR49vqEPNIoYQ==",
    );

    const skillLock = JSON.parse(await readFile(
      join(workspacePath, "skills.lock.json"),
      "utf8",
    ));
    assert.equal(skillLock.policy.ambientDiscovery, "disabled");
    assert.equal(skillLock.policy.unlistedSkills, "reject");
    assert.deepEqual(skillLock.skills.map((skill) => skill.identity), [
      "sandking.issue-implementation",
      "sandking.issue-planning",
      "sandking.pull-request-review",
    ]);
    assert.ok(skillLock.skills.every((skill) =>
      /^[a-z0-9][a-z0-9.-]*$/.test(skill.identity)
      && /^[a-f0-9]{40}$/.test(skill.source.revision)
      && !skill.source.path.startsWith("/")
      && /^sha256:[a-f0-9]{64}$/.test(skill.contentIntegrity)));
    for (const skill of skillLock.skills) {
      assert.equal(skill.source.revision, provenance.sandKing.revision);
      const sourceAtRevision = (await execFileAsync("git", [
        "show", `${skill.source.revision}:${skill.source.path}`,
      ])).stdout;
      assert.equal(
        `sha256:${createHash("sha256").update(sourceAtRevision).digest("hex")}`,
        skill.contentIntegrity,
      );
      assert.equal(
        sourceAtRevision,
        await readFile(join(workspacePath, skill.source.path), "utf8"),
      );
    }
    assert.doesNotMatch(JSON.stringify(skillLock), /(?:\/home\/|\\Users\\|secret|token)/i);

    const projectRegistration = await firstRegistry.registerProject({
      requestId: "register-production-project",
      path: projectPath,
      configuration: {
        issueWorkflow: { provider: "github", kind: "issues" },
        checks: [{ checkId: "test", command: "npm test" }],
      },
      authorizationClass: "host_local_project_registration",
      idempotencyKey: "register-production-project",
      expectedRevision: 0,
    });
    const pin = await firstRegistry.pinHarness({
      requestId: "pin-production-harness",
      projectId: projectRegistration.project.projectId,
      harnessId: first.harness.harnessId,
      boundedConfiguration: {
        adapterProtocol: "1.0.0",
        launchProfile: "delegated-work",
      },
      authorizationClass: "host_local_project_configuration",
      idempotencyKey: "pin-production-harness",
      expectedRevision: 1,
    });
    assert.equal(pin.code, "project_harness_pinned");
    assert.equal(pin.project.harness.adapterId, SANDCASTLE_HARNESS_ADAPTER_ID);
    assert.equal(pin.project.harness.pinnedRevision, first.harness.immutableRevision);
    assert.equal(pin.project.readiness.launchRequest, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid production seed inputs fail truthfully without retaining a ready Harness", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sandking-invalid-production-seed-"));
  const validSeed = join(root, "valid-materialized-seed");

  try {
    await initializeProductionHarnessWorkspace(validSeed);
    const cases = [
      {
        name: "missing-content",
        code: "harness_seed_missing",
        mutate: (sourceRoot) => rm(join(sourceRoot, "harness.json")),
      },
      {
        name: "missing-runtime-import",
        code: "harness_seed_missing",
        mutate: (sourceRoot) => removeLockedSeedFile(
          sourceRoot,
          ".sandcastle/issue-delivery.mjs",
        ),
      },
      {
        name: "undeclared-runtime-import",
        code: "harness_seed_missing",
        mutate: async (sourceRoot) => {
          const mainPath = join(sourceRoot, ".sandcastle/main.mts");
          const main = await readFile(mainPath, "utf8");
          await rewriteLockedSeedFile(
            sourceRoot,
            ".sandcastle/main.mts",
            `${main}\nimport "./uncommitted-runtime-module.mjs";\n`,
          );
        },
      },
      {
        name: "invalid-adapter",
        code: "harness_seed_provenance_invalid",
        mutate: (sourceRoot) => rewriteLockedSeedFile(
          sourceRoot,
          "adapters/sandcastle.mjs",
          "this is not an executable Harness adapter\n",
        ),
      },
      {
        name: "invalid-provenance",
        code: "harness_seed_provenance_invalid",
        mutate: (sourceRoot) => rewriteLockedSeedJson(
          sourceRoot,
          "provenance.json",
          (value) => {
          value.sandcastle.revision = "f".repeat(40);
          },
        ),
      },
      {
        name: "unrelated-sand-king-provenance",
        code: "harness_seed_provenance_invalid",
        mutate: async (sourceRoot) => {
          await rewriteLockedSeedJson(sourceRoot, "provenance.json", (value) => {
            value.sandKing.revision = "606ec57970e3468f48b8251ef651d8a710d20a93";
          });
          await rewriteLockedSeedJson(sourceRoot, "skills.lock.json", (value) => {
            for (const skill of value.skills) {
              skill.source.revision = "606ec57970e3468f48b8251ef651d8a710d20a93";
            }
          });
        },
      },
      {
        name: "incomplete-dependency-lock",
        code: "harness_dependency_lock_invalid",
        mutate: (sourceRoot) => rewriteLockedSeedJson(
          sourceRoot,
          "package-lock.json",
          (value) => {
            delete value.packages["node_modules/@ai-hero/sandcastle"].integrity;
          },
        ),
      },
      {
        name: "missing-transitive-dependency",
        code: "harness_dependency_lock_invalid",
        mutate: (sourceRoot) => rewriteLockedSeedJson(
          sourceRoot,
          "package-lock.json",
          (value) => {
            delete value.packages["node_modules/@clack/prompts"];
          },
        ),
      },
      {
        name: "self-consistent-but-incomplete-dependency-graph",
        code: "harness_dependency_lock_invalid",
        mutate: (sourceRoot) => rewriteLockedSeedJson(
          sourceRoot,
          "package-lock.json",
          (value) => {
            delete value.packages["node_modules/@ai-hero/sandcastle"]
              .dependencies["@clack/prompts"];
            for (const path of [
              "node_modules/@clack/core",
              "node_modules/@clack/prompts",
              "node_modules/fast-string-truncated-width",
              "node_modules/fast-string-width",
              "node_modules/fast-wrap-ansi",
              "node_modules/sisteransi",
            ]) {
              delete value.packages[path];
            }
          },
        ),
      },
      {
        name: "invalid-skill-lock",
        code: "harness_skill_lock_invalid",
        mutate: (sourceRoot) => rewriteLockedSeedJson(
          sourceRoot,
          "skills.lock.json",
          (value) => {
            value.skills[0].source.path = "/home/person/ambient/SKILL.md";
          },
        ),
      },
      {
        name: "missing-worker-visible-skill",
        code: "harness_skill_lock_invalid",
        mutate: (sourceRoot) => rewriteLockedSeedJson(
          sourceRoot,
          "skills.lock.json",
          (value) => {
            value.skills = value.skills.filter(({ identity }) =>
              identity !== "sandking.pull-request-review");
            for (const bundle of value.bundles) {
              bundle.skills = bundle.skills.filter((identity) =>
                identity !== "sandking.pull-request-review");
            }
          },
        ),
      },
      {
        name: "non-literal-worker-visible-skill",
        code: "harness_skill_lock_invalid",
        mutate: async (sourceRoot) => {
          const mainPath = join(sourceRoot, ".sandcastle/main.mts");
          const main = await readFile(mainPath, "utf8");
          const altered = main.replace(
            'promptFile: "./.sandcastle/pr-review-prompt.md",',
            'promptFile: ["./.sandcastle", "CODING_STANDARDS.md"].join("/"),',
          );
          assert.notEqual(altered, main);
          await rewriteLockedSeedFile(
            sourceRoot,
            ".sandcastle/main.mts",
            `${altered}\nvoid { promptFile: "./.sandcastle/pr-review-prompt.md" };\n`,
          );
        },
      },
      {
        name: "source-bytes-do-not-match-provenance",
        code: "harness_seed_provenance_invalid",
        mutate: async (sourceRoot) => {
          const dockerfilePath = join(sourceRoot, ".sandcastle/Dockerfile");
          const dockerfile = await readFile(dockerfilePath, "utf8");
          await rewriteLockedSeedFile(
            sourceRoot,
            ".sandcastle/Dockerfile",
            `${dockerfile}\n# bytes absent from the recorded Sand-King revision\n`,
          );
        },
      },
      {
        name: "seed-owned-adapter-bytes-do-not-match-provenance",
        code: "harness_seed_provenance_invalid",
        mutate: async (sourceRoot) => {
          const adapterPath = join(sourceRoot, "adapters/sandcastle.mjs");
          const adapter = await readFile(adapterPath, "utf8");
          await rewriteLockedSeedFile(
            sourceRoot,
            "adapters/sandcastle.mjs",
            `${adapter}\n// bytes absent from the recorded Sand-King revision\n`,
          );
        },
      },
    ];

    for (const fixture of cases) {
      await t.test(fixture.name, async () => {
        const sourceRoot = join(root, `${fixture.name}-source`);
        const dataDir = join(root, `${fixture.name}-state`);
        await cp(validSeed, sourceRoot, { recursive: true });
        await fixture.mutate(sourceRoot);
        const audits = [];
        const registry = await createProjectRegistry({
          dataDir,
          productionSeedRoot: sourceRoot,
          recordAudit: async (action, outcome, details) => {
            audits.push({ action, outcome, details });
            return `audit-${String(audits.length).padStart(24, "0")}`;
          },
        });
        const outcome = await registry.registerSandcastleHarness({
          requestId: `register-${fixture.name}`,
          name: "Sand-King Sandcastle Harness",
          authorizationClass: "host_local_harness_registration",
          idempotencyKey: `register-${fixture.name}`,
          expectedRevision: 0,
        });
        assert.equal(outcome.type, "project.operation.failure");
        assert.equal(outcome.operation, "harness.sandcastle.register");
        assert.equal(outcome.code, fixture.code);
        assert.equal(outcome.retryable, false);
        assert.equal(outcome.prohibitedSideEffects.projectFileWrite, false);
        assert.equal(outcome.prohibitedSideEffects.harnessWorkspaceWrite, false);
        assert.equal(
          (await registry.inspectSandcastleHarness({ requestId: `inspect-${fixture.name}` }))
            .harness,
          null,
        );
        assert.equal(audits.at(-1).details.falselyReadyHarnessRetained, false);
        assert.deepEqual(
          await readdir(join(root, `${fixture.name}-state-harness-workspaces`))
            .catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error)),
          [],
        );
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transitive bundles and plugin-provided skills resolve into one locked inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-skill-sources-"));
  const validSeed = join(root, "valid-materialized-seed");
  const composedSeed = join(root, "composed-skill-seed");
  const dataDir = join(root, "host-state");

  try {
    await initializeProductionHarnessWorkspace(validSeed);
    await cp(validSeed, composedSeed, { recursive: true });
    await rewriteLockedSeedJson(composedSeed, "skills.lock.json", (lock) => {
      lock.bundles.push({
        identity: "sandking.transitive-worker-skills",
        includes: ["sandking.production-worker-skills"],
        skills: [],
      });
      lock.plugins.push({
        identity: "sandking.delivery-plugin",
        package: "@sandking/delivery-plugin",
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/@sandking/delivery-plugin/-/delivery-plugin-1.0.0.tgz",
        integrity: "sha512-YWJjZA==",
        skills: ["sandking.issue-implementation"],
      });
      lock.skills[0].providers.push(
        { kind: "bundle", identity: "sandking.transitive-worker-skills" },
        { kind: "plugin", identity: "sandking.delivery-plugin" },
      );
    });
    const composedSkillLock = await readFile(join(composedSeed, "skills.lock.json"));
    await rewriteLockedSeedJson(composedSeed, "provenance.json", (provenance) => {
      provenance.artifacts.skillSetLock.integrity =
        `sha256:${createHash("sha256").update(composedSkillLock).digest("hex")}`;
    });
    const registry = await createProjectRegistry({
      dataDir,
      productionSeedRoot: composedSeed,
      recordAudit,
    });
    const registration = await registry.registerSandcastleHarness({
      requestId: "register-composed-skill-seed",
      name: "Sand-King Sandcastle Harness",
      authorizationClass: "host_local_harness_registration",
      idempotencyKey: "register-composed-skill-seed",
      expectedRevision: 0,
    });
    assert.equal(registration.code, "sandcastle_harness_registered");
    const state = JSON.parse(await readFile(join(dataDir, "harness-registry.json"), "utf8"));
    const lock = JSON.parse(await readFile(
      join(state.harnesses[0].workspacePath, "skills.lock.json"),
      "utf8",
    ));
    assert.equal(lock.skills.length, 3);
    assert.deepEqual(lock.skills[0].providers.map((provider) => provider.kind), [
      "bundle",
      "bundle",
      "plugin",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
