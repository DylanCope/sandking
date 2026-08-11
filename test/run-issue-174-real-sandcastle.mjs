import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  captureCleanIssue174EvidenceRevision,
  verifyIssue174EvidenceRevisionUnchanged,
} from "./issue-174-evidence-source.mjs";
import {
  assertIssue174EvidenceSanitized,
  createIssue174Qualification,
  inspectIssue174RetainedRunState,
  ISSUE_174_SCENARIO,
  validateIssue174RealEvidence,
} from "./issue-174-real-evidence.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = resolve(
  process.argv.find((argument) => argument.endsWith(".json"))
    ?? "acceptance/issue-174.manifest.json",
);
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const gitEnvironment = () => ({
  LANG: "C.UTF-8",
  ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
});
const git = async (projectPath, args) => (await execFileAsync(
  "git",
  ["-C", projectPath, ...args],
  { env: gitEnvironment(), maxBuffer: 1024 * 1024 },
)).stdout.trim();
const readJson = (path) => readFile(path, "utf8").then(JSON.parse);

const emitQualification = (qualification) => {
  process.stderr.write(`${JSON.stringify(qualification)}\n`);
};

const verifyManifest = (manifest) => {
  if (
    manifest?.schemaVersion !== 1
    || manifest.issue !== 174
    || manifest.parentPrd !== 169
    || manifest.scenario?.id !== ISSUE_174_SCENARIO
    || manifest.scenario?.provider?.kind !== "openai-codex"
    || manifest.scenario?.provider?.simulationAllowed !== false
    || manifest.environmentGate?.name !== "SANDKING_REAL_SANDCASTLE_ACCEPTANCE"
    || manifest.environmentGate?.requiredValue !== "1"
    || manifest.environmentGate?.fixtureSubstitutionAllowed !== false
    || manifest.retainedEvidence?.path !== "acceptance/evidence/issue-174.real.json"
  ) {
    throw new Error("issue_174_real_acceptance_manifest_invalid");
  }
};

const verifySourceIssues = async (manifest) => {
  for (const [issue, expectedHash] of [
    [174, manifest.sourceIssue.githubBodyUtf8Sha256],
    [169, manifest.sourcePrd.githubBodyUtf8Sha256],
    [168, manifest.sourceSpecification.githubBodyUtf8Sha256],
  ]) {
    const { stdout } = await execFileAsync(
      "gh",
      ["issue", "view", String(issue), "--json", "body"],
      { cwd: repositoryRoot, maxBuffer: 1024 * 1024 },
    );
    if (sha256(JSON.parse(stdout).body) !== `sha256:${expectedHash}`) {
      throw new Error(`issue_174_source_revision_mismatch:${issue}`);
    }
  }
};

const probeRealProvider = async (expectedVersion) => {
  let version;
  try {
    version = (await execFileAsync("codex", ["--version"], {
      env: process.env,
      timeout: 5_000,
    })).stdout.trim();
  } catch {
    return { code: "real_provider_unavailable" };
  }
  if (version !== `codex-cli ${expectedVersion}`) {
    return { code: "real_provider_incompatible" };
  }
  try {
    const authentication = await execFileAsync("codex", ["login", "status"], {
      env: process.env,
      timeout: 5_000,
    });
    if (!/^Logged in\b/m.test(`${authentication.stdout}\n${authentication.stderr}`)) {
      return { code: "real_provider_unauthenticated" };
    }
    await execFileAsync("npm", ["--version"], { env: process.env, timeout: 5_000 });
  } catch {
    return { code: "real_provider_unauthenticated" };
  }
  return { version: expectedVersion };
};

const snapshotDirectory = async (root) => {
  const entries = [];
  const visit = async (directory, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, relativePath);
      } else if (entry.isFile()) {
        entries.push({ path: relativePath, integrity: sha256(await readFile(path)) });
      } else {
        throw new Error("issue_174_projection_shape_invalid");
      }
    }
  };
  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
};

const waitForTerminalRun = async (dataDir) => {
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const state = await readJson(join(dataDir, "harness-runs.json")).catch(() => null);
    const retained = inspectIssue174RetainedRunState(state);
    if (retained.status === "terminal") {
      return retained.run;
    }
    if (retained.status === "launch-failed") {
      const error = new Error(`issue_174_launch_failed:${retained.code}`);
      error.modelInvocationMayHaveOccurred = retained.modelInvocationMayHaveOccurred;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("issue_174_real_run_timeout");
};

const initializeProject = async (projectPath) => {
  const readme = "Disposable Project for Sand-King issue #174.\n";
  const providerManifest = `${JSON.stringify({
    schemaVersion: 1,
    provider: { kind: "openai-codex", ready: true },
    scenario: "project-commit",
  }, null, 2)}\n`;
  await mkdir(projectPath, { recursive: true, mode: 0o700 });
  await execFileAsync("git", [
    "init", "--quiet", "--initial-branch=main", "--object-format=sha1", projectPath,
  ], { env: gitEnvironment() });
  await Promise.all([
    writeFile(join(projectPath, "README.md"), readme, { mode: 0o600 }),
    writeFile(
      join(projectPath, "sandcastle.real-provider.json"),
      providerManifest,
      { mode: 0o600 },
    ),
  ]);
  await execFileAsync("git", ["-C", projectPath, "add", "--all"], {
    env: gitEnvironment(),
  });
  await execFileAsync("git", [
    "-C", projectPath,
    "-c", "user.name=Issue 174 Project Fixture",
    "-c", "user.email=issue-174-project@sandking.invalid",
    "-c", "commit.gpgSign=false",
    "-c", "core.hooksPath=/dev/null",
    "commit", "--quiet", "-m", "Initialize disposable real-delegation Project",
  ], { env: gitEnvironment() });
  return { readme, providerManifest, beforeCommit: await git(projectPath, ["rev-parse", "HEAD"]) };
};

const readAudits = async (dataDir) => (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
  .trim().split("\n").filter(Boolean).map(JSON.parse);

const main = async () => {
  let manifest;
  try {
    manifest = await readJson(manifestPath);
    verifyManifest(manifest);
  } catch {
    emitQualification(createIssue174Qualification("real_acceptance_manifest_invalid"));
    return 1;
  }
  if (process.env.SANDKING_REAL_SANDCASTLE_ACCEPTANCE !== "1") {
    emitQualification(createIssue174Qualification("real_provider_gate_disabled"));
    return 1;
  }
  const provider = await probeRealProvider(manifest.scenario.provider.cliVersion);
  if (provider.code) {
    emitQualification(createIssue174Qualification(provider.code));
    return 1;
  }

  let root;
  let projectPath;
  let dataDir;
  let executionDirectory;
  let installed;
  let browser;
  let runtimeStarted = false;
  let launchActionCount = 0;
  let run = null;
  let completed = false;
  try {
    await verifySourceIssues(manifest);
    const evidenceSourceRevision = await captureCleanIssue174EvidenceRevision({
      repositoryRoot,
    });
    root = await mkdtemp(join(tmpdir(), "sandking-issue-174-real-"));
    projectPath = join(root, "project");
    dataDir = join(root, "state");
    executionDirectory = join(root, "outside-checkout");
    await mkdir(executionDirectory, { mode: 0o700 });
    const projectBefore = await initializeProject(projectPath);

    const { installCurrentPackage } = await import("./installed-package.mjs");
    const { launchBrowser } = await import("./browser-launch.mjs");
    installed = await installCurrentPackage(root);
    const { stdout: launchSource } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--startup-timeout-ms", "60000",
      "--idempotency-key", "issue-174-real-sandcastle-runtime",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: process.env, maxBuffer: 1024 * 1024 });
    const launch = JSON.parse(launchSource);
    runtimeStarted = true;
    browser = await launchBrowser({ niceAdjustment: 10 });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(launch.bootstrapUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#project-preparation[data-explicit-path-only='true']", {
      timeout: 90_000,
    });
    if (await page.locator("#project-harness-adapter").inputValue()
      !== "sandcastle-harness-adapter-v1") {
      throw new Error("issue_174_default_production_harness_missing");
    }
    await page.locator("#project-path").fill(projectPath);
    await page.locator("#open-project").click();
    await page.waitForSelector(
      "#project-readiness[data-harness-launch-ready='true']"
        + "[data-harness-adapter-id='sandcastle-harness-adapter-v1']",
      { timeout: 90_000 },
    );
    const readiness = page.locator("#project-readiness");
    const projectId = await readiness.getAttribute("data-project-id");
    const harnessId = await readiness.getAttribute("data-harness-id");
    const pinnedRevision = await readiness.getAttribute("data-harness-pin");
    const projectStateBefore = await readJson(join(dataDir, "project-registrations.json"));
    const registration = projectStateBefore.projects.find((candidate) =>
      candidate.projectId === projectId);
    const projectionPath = join(
      projectPath,
      ...registration.harness.preparation.projection.path.split("/"),
    );
    const projectionBefore = await snapshotDirectory(projectionPath);

    launchActionCount += 1;
    await page.locator("#launch-harness").click();
    await page.locator("#harness-launch-confirmation-yes").click();
    run = await waitForTerminalRun(dataDir);
    await page.waitForSelector(
      `#harness-run-observation[data-run-id='${run.harnessRunId}']`
        + `[data-run-status='${run.status}']`,
      { timeout: 90_000 },
    );
    if (
      run.status !== "succeeded"
      || run.outcome?.code !== "harness_run_succeeded"
      || run.outcome?.result?.code !== "real_work_committed"
      || run.terminalEnvelopeValidation?.exactlyOne !== true
    ) {
      throw new Error("issue_174_structured_outcome_failed");
    }

    const afterCommit = await git(projectPath, ["rev-parse", "HEAD"]);
    const parentCommit = await git(projectPath, ["rev-parse", `${afterCommit}^`]);
    const changedFiles = (await git(projectPath, [
      "diff-tree", "--no-commit-id", "--name-only", "-r", afterCommit,
    ])).split("\n").filter(Boolean);
    const trackedFiles = (await git(projectPath, ["ls-files"])).split("\n").filter(Boolean);
    const commitIdentity = await git(projectPath, [
      "log", "-1", "--format=%s%n%an%n%ae", afterCommit,
    ]);
    const artifact = await readFile(
      join(projectPath, manifest.scenario.expectedArtifact.path),
    );
    const projectionAfter = await snapshotDirectory(projectionPath);
    const ignored = await execFileAsync("git", [
      "-C", projectPath, "check-ignore", "--no-index", "--quiet",
      join(projectionPath, "worker-environment.json"),
    ], { env: gitEnvironment() }).then(() => true, () => false);
    const status = await git(projectPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const childCommitCount = Number(await git(projectPath, [
      "rev-list", "--count", `${projectBefore.beforeCommit}..${afterCommit}`,
    ]));
    const projectInvariants = {
      exactlyOneChildCommit: childCommitCount === 1,
      expectedArtifactOnly: JSON.stringify(changedFiles)
        === JSON.stringify([manifest.scenario.expectedArtifact.path]),
      expectedArtifactContent: sha256(artifact)
        === `sha256:${manifest.scenario.expectedArtifact.contentUtf8Sha256}`,
      unrelatedTrackedContentPreserved:
        await readFile(join(projectPath, "README.md"), "utf8") === projectBefore.readme
        && await readFile(join(projectPath, "sandcastle.real-provider.json"), "utf8")
          === projectBefore.providerManifest,
      cleanAfter: status === "",
      ignoredProjection: ignored,
      projectionUnchanged: JSON.stringify(projectionAfter) === JSON.stringify(projectionBefore),
      noRuntimeTracked: trackedFiles.every((path) =>
        !path.startsWith(".sandking/") && !path.startsWith(".sandcastle/")),
      prescribedCommitIdentity: commitIdentity
        === "Prove pinned Sandcastle delegation\nSandcastle Real Worker\nreal-worker@sandking.invalid",
      structuredCommitAgrees: run.outcome.result.commit === afterCommit,
    };
    if (
      parentCommit !== projectBefore.beforeCommit
      || !Object.values(projectInvariants).every(Boolean)
    ) {
      throw new Error("issue_174_project_commit_invalid");
    }

    const harnessState = await readJson(join(dataDir, "harness-registry.json"));
    const harness = harnessState.harnesses.find((candidate) =>
      candidate.harnessId === harnessId);
    const workspacePath = harness.workspacePath;
    const [provenance, skillSetLock, seedManifest, adapterSource] = await Promise.all([
      readJson(join(workspacePath, "provenance.json")),
      readJson(join(workspacePath, "skills.lock.json")),
      readJson(join(workspacePath, "seed-manifest.json")),
      readFile(join(workspacePath, "adapters", "sandcastle.mjs")),
    ]);
    if (
      await git(workspacePath, ["rev-parse", "HEAD"]) !== pinnedRevision
      || await git(workspacePath, ["status", "--porcelain=v1", "--untracked-files=all"]) !== ""
    ) {
      throw new Error("issue_174_pinned_harness_changed");
    }
    const adapterManifest = seedManifest.files.find(({ path }) =>
      path === "adapters/sandcastle.mjs");
    if (
      adapterManifest.sourcePath !== "src/production-sandcastle-adapter/sandcastle-v3.mjs"
      || adapterManifest.integrity !== sha256(adapterSource)
    ) {
      throw new Error("issue_174_adapter_provenance_invalid");
    }
    const audits = await readAudits(dataDir);
    const auditReferences = audits.filter((audit) =>
      ["harness.run.launch", "harness.adapter.start", "harness.run.outcome"]
        .includes(audit.action)
      && audit.details?.harnessRunId === run.harnessRunId)
      .map(({ auditId, action, outcome }) => ({ auditId, action, outcome }));
    if (
      auditReferences.filter(({ action }) => action === "harness.run.launch").length !== 1
      || auditReferences.filter(({ action }) => action === "harness.adapter.start").length !== 1
      || auditReferences.filter(({ action }) => action === "harness.run.outcome").length !== 1
    ) {
      throw new Error("issue_174_audit_proof_invalid");
    }

    await verifyIssue174EvidenceRevisionUnchanged({
      repositoryRoot,
      expectedRevision: evidenceSourceRevision,
    });
    const evidence = {
      schemaVersion: 1,
      issue: 174,
      parentPrd: 169,
      generatedFromCommit: evidenceSourceRevision,
      recordedAt: new Date().toISOString(),
      scenario: ISSUE_174_SCENARIO,
      qualification: {
        status: "passed",
        productionEvidence: true,
        fixtureSubstitution: false,
      },
      installedSandKing: {
        revision: evidenceSourceRevision,
        command: installed.observation.command,
        installed: installed.observation.installed,
        launchedOutsideCheckout: installed.observation.launchedOutsideCheckout,
        tarballIntegrity: `sha256:${installed.observation.tarballSha256}`,
      },
      publicSeam: {
        surface: "cockpit",
        defaultProductionHarness: true,
        launchActionCount,
        transport:
          "installed sandking -> loopback Cockpit -> authenticated WebSocket -> framed local Host",
      },
      provider: {
        kind: "openai-codex",
        version: provider.version,
        authentication: "destination-local-authenticated",
        realExecution: true,
        simulated: false,
        model: manifest.scenario.provider.model,
        effort: manifest.scenario.provider.effort,
      },
      adapter: {
        identity: run.adapterId,
        protocol: run.adapterProtocol,
        entryPoint: run.executionSnapshot.adapter.entryPoint,
        sourcePath: adapterManifest.sourcePath,
        contentIntegrity: sha256(adapterSource),
      },
      harness: {
        harnessId,
        pinnedRevision,
        sandKingSeed: provenance.sandKing,
        upstream: provenance.sandcastle,
        dependencyLock: provenance.artifacts.dependencyLock,
        skillSetLock: {
          integrity: provenance.artifacts.skillSetLock.integrity,
          resolvedSkills: skillSetLock.skills.map((skill) => ({
            identity: skill.identity,
            revision: skill.source.revision,
            contentIntegrity: skill.contentIntegrity,
          })),
        },
        projectionIntegrity: registration.harness.preparation.projection.digest,
      },
      project: {
        beforeCommit: projectBefore.beforeCommit,
        afterCommit,
        parentCommit,
        artifact: {
          path: manifest.scenario.expectedArtifact.path,
          contentIntegrity: sha256(artifact),
        },
        invariants: projectInvariants,
      },
      structuredOutcome: {
        harnessRunId: run.harnessRunId,
        status: run.status,
        code: run.outcome.result.code,
        commit: run.outcome.result.commit,
        artifact: run.outcome.result.artifact,
        exactlyOneTerminalEnvelope: run.terminalEnvelopeValidation.exactlyOne,
      },
      diagnostics: {
        bounded: true,
        contentRetained: false,
        references: run.logStreams.map((stream) => ({
          streamId: stream.streamId,
          producer: stream.producer,
          start: stream.availableStart,
          end: stream.availableEnd,
          explicitRetrievalRequired: stream.explicitRetrievalRequired,
        })),
      },
      auditReferences,
    };
    validateIssue174RealEvidence(evidence);
    const evidenceText = assertIssue174EvidenceSanitized({
      evidence,
      prohibitedValues: [
        root,
        projectPath,
        dataDir,
        executionDirectory,
        installed.packageDirectory,
        workspacePath,
        process.env.HOME,
        process.env.CODEX_HOME,
      ],
    });
    const evidencePath = resolve(repositoryRoot, manifest.retainedEvidence.path);
    await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
    await writeFile(evidencePath, evidenceText, { mode: 0o600 });
    completed = true;
    process.stdout.write(`Retained sanitized issue #174 real-provider evidence: ${evidencePath}\n`);
    return 0;
  } catch (error) {
    const modelInvocationMayHaveOccurred = error
      && typeof error === "object"
      && "modelInvocationMayHaveOccurred" in error
      ? error.modelInvocationMayHaveOccurred === true
      : launchActionCount === 1;
    emitQualification({
      schemaVersion: 1,
      issue: 174,
      scenario: ISSUE_174_SCENARIO,
      qualification: {
        status: "failed",
        code: "real_provider_proof_failed",
        productionEvidence: false,
        fixtureSubstitution: false,
        launchActionCount,
        modelInvocationMayHaveOccurred,
        partialProjectRetained: Boolean(projectPath),
        structuredOutcome: run
          ? { status: run.status, code: run.outcome?.result?.code ?? null }
          : null,
      },
    });
    if (projectPath) process.stderr.write(`Partial Project retained for inspection: ${projectPath}\n`);
    return 1;
  } finally {
    await browser?.close().catch(() => undefined);
    if (runtimeStarted) {
      await execFileAsync(installed.command, [
        "stop", "--data-dir", dataDir, "--json",
      ], { cwd: executionDirectory, env: process.env }).catch(() => undefined);
    }
    if (completed && root) await rm(root, { recursive: true, force: true });
  }
};

process.exitCode = await main();
