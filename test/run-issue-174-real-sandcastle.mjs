import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  createRealSandcastleQualification,
  inspectRealSandcastleRunState,
  realSandcastleScenario,
  serializeSanitizedRealProviderResult,
  validateRealSandcastleResult,
} from "./real-sandcastle-acceptance.mjs";
import { waitForIssue174ProductionHarness } from "./issue-174-harness-state.mjs";
import { snapshotIssue174Projection } from "./issue-174-projection-snapshot.mjs";
import {
  inspectIssue174SandboxImage,
  restoreIssue174SandboxImage,
} from "./issue-174-sandbox-image.mjs";

const execFileAsync = promisify(execFile);
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

const probeRealProvider = async (expectedVersion) => {
  let version;
  try {
    version = (await execFileAsync("codex", ["--version"], {
      env: process.env,
      shell: process.platform === "win32",
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
      shell: process.platform === "win32",
      timeout: 5_000,
    });
    if (!/^Logged in\b/m.test(`${authentication.stdout}\n${authentication.stderr}`)) {
      return { code: "real_provider_unauthenticated" };
    }
    await execFileAsync("npm", ["--version"], {
      env: process.env,
      shell: process.platform === "win32",
      timeout: 5_000,
    });
  } catch {
    return { code: "real_provider_unauthenticated" };
  }
  let sandboxVersion;
  try {
    sandboxVersion = (await execFileAsync("docker", [
      "version", "--format", "{{.Server.Version}}",
    ], { env: process.env, timeout: 5_000 })).stdout.trim();
    if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(sandboxVersion)) {
      return { code: "real_sandbox_unavailable" };
    }
  } catch {
    return { code: "real_sandbox_unavailable" };
  }
  return { version: expectedVersion, sandboxVersion };
};

const waitForTerminalRun = async (dataDir) => {
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const state = await readJson(join(dataDir, "harness-runs.json")).catch(() => null);
    const retained = inspectRealSandcastleRunState(state);
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
  await mkdir(projectPath, { recursive: true, mode: 0o700 });
  await execFileAsync("git", [
    "init", "--quiet", "--initial-branch=main", "--object-format=sha1", projectPath,
  ], { env: gitEnvironment() });
  await writeFile(join(projectPath, "README.md"), readme, { mode: 0o600 });
  await execFileAsync("git", ["-C", projectPath, "add", "README.md"], {
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
  return { readme, beforeCommit: await git(projectPath, ["rev-parse", "HEAD"]) };
};

const readAudits = async (dataDir) => (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
  .trim().split("\n").filter(Boolean).map(JSON.parse);

const runInstalledCliDelegation = async ({ installed, root, sandboxImageId }) => {
  const cliRoot = join(root, "cli-delegation");
  const cliDataDir = join(cliRoot, "state");
  const cliProjectPath = join(cliRoot, "project");
  const endpoint = join(cliRoot, "controller.sock");
  const retryDirectory = join(cliRoot, "controller-private");
  const userHome = join(cliRoot, "user-home");
  await Promise.all([
    mkdir(cliRoot, { recursive: true, mode: 0o700 }),
    mkdir(retryDirectory, { recursive: true, mode: 0o700 }),
    mkdir(userHome, { recursive: true, mode: 0o700 }),
  ]);
  const projectBefore = await initializeProject(cliProjectPath);
  const [{ createProjectRegistry }, { createHarnessRunManager }] = await Promise.all([
    import(pathToFileURL(join(
      installed.packageDirectory,
      "src",
      "project-registration.mjs",
    )).href),
    import(pathToFileURL(join(
      installed.packageDirectory,
      "src",
      "harness-runs.mjs",
    )).href),
  ]);
  const audits = [];
  const recordAudit = async (action, outcome, details, requestedAuditId) => {
    const auditId = requestedAuditId
      ?? `audit-${String(audits.length + 1).padStart(24, "0")}`;
    audits.push({ auditId, action, outcome, details });
    return auditId;
  };
  const registry = await createProjectRegistry({ dataDir: cliDataDir, recordAudit });
  const harness = await registry.registerSandcastleHarness({
    requestId: "register-real-cli-harness",
    name: "Sand-King Sandcastle Harness",
    authorizationClass: "host_local_harness_registration",
    idempotencyKey: "register-real-cli-harness",
    expectedRevision: 0,
  });
  const project = await registry.registerProject({
    requestId: "register-real-cli-project",
    path: cliProjectPath,
    configuration: {
      issueWorkflow: { provider: "github", kind: "issues" },
      checks: [{ checkId: "test", command: "npm test" }],
    },
    authorizationClass: "host_local_project_registration",
    idempotencyKey: "register-real-cli-project",
    expectedRevision: 0,
  });
  await registry.pinHarness({
    requestId: "pin-real-cli-harness",
    projectId: project.project.projectId,
    harnessId: harness.harness.harnessId,
    boundedConfiguration: {
      adapterProtocol: "1.0.0",
      launchProfile: "delegated-work",
    },
    authorizationClass: "host_local_project_configuration",
    idempotencyKey: "pin-real-cli-harness",
    expectedRevision: 1,
  });
  const manager = await createHarnessRunManager({
    dataDir: cliDataDir,
    hostId: `host-${"7".repeat(24)}`,
    recordAudit,
    loadLaunchContext: registry.loadLaunchContext,
  });
  const controllerSessionId = `controller-session-${"8".repeat(24)}`;
  const requests = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", async (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      try {
        const request = JSON.parse(input.slice(0, input.indexOf("\n")));
        requests.push(request);
        if (request.operation === "describe") {
          socket.end(`${JSON.stringify({
            type: "sandking.cli.result",
            protocol: "1.0.0",
            requestId: request.requestId,
            ok: true,
            outcome: {
              type: "controller.cli.description",
              protocol: "1.0.0",
              command: "sandking launch",
              focusedProjectId: project.project.projectId,
              projectArgumentOptional: true,
              pluginRequired: false,
              launchParameters: harness.harness.launchParameters,
            },
          })}\n`);
          return;
        }
        if (request.operation !== "harness-run.launch") {
          throw new Error("issue_174_cli_operation_invalid");
        }
        const outcome = await manager.launch({
          requestId: request.requestId,
          projectId: project.project.projectId,
          parameters: request.parameters ?? {},
          controllerId: `runtime-${"9".repeat(24)}`,
          controllerSessionId: request.controllerSessionId,
          source: "controller-cli",
          authorizationClass: "harness_run_launch",
          idempotencyKeyHash: request.idempotencyKeyHash,
        });
        socket.end(`${JSON.stringify({
          type: "sandking.cli.result",
          protocol: "1.0.0",
          requestId: request.requestId,
          ok: outcome.type === "harness.run.launch.result",
          ...(outcome.type === "harness.run.launch.result"
            ? { outcome }
            : { failure: { code: outcome.code } }),
        })}\n`);
      } catch (error) {
        socket.destroy(error instanceof Error ? error : undefined);
      }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    const { stdout } = await execFileAsync(installed.command, [
      "launch", project.project.projectId,
      "--issue", "256",
      "--target-branch", "sandcastle/issue-256",
      "--json",
    ], {
      cwd: cliRoot,
      env: {
        ...process.env,
        HOME: userHome,
        SANDKING_CONTROLLER_ENDPOINT: endpoint,
        SANDKING_CONTROLLER_SESSION_ID: controllerSessionId,
        SANDKING_CONTROLLER_RETRY_DIRECTORY: retryDirectory,
        SANDKING_WORK_CONTEXT_ID: project.project.projectId,
      },
    });
    const launched = JSON.parse(stdout);
    if (
      launched.type !== "harness.run.launch.result"
      || launched.run.source !== "controller-cli"
      || launched.run.controllerSessionId !== controllerSessionId
    ) {
      throw new Error("issue_174_cli_launch_invalid");
    }
    const run = await waitForTerminalRun(cliDataDir);
    const afterCommit = await git(cliProjectPath, ["rev-parse", "HEAD"]);
    const changedFiles = (await git(cliProjectPath, [
      "diff-tree", "--no-commit-id", "--name-only", "-r", afterCommit,
    ])).split("\n").filter(Boolean);
    const artifact = await readFile(
      join(cliProjectPath, realSandcastleScenario.expectedArtifact.path),
    );
    if (
      run.harnessRunId !== launched.run.harnessRunId
      || run.status !== "succeeded"
      || run.outcome?.result?.code !== "real_work_committed"
      || run.outcome?.result?.sandbox?.imageId !== sandboxImageId
      || run.terminalEnvelopeValidation?.exactlyOne !== true
      || await git(cliProjectPath, ["rev-parse", `${afterCommit}^`])
        !== projectBefore.beforeCommit
      || JSON.stringify(changedFiles)
        !== JSON.stringify([realSandcastleScenario.expectedArtifact.path])
      || sha256(artifact)
        !== `sha256:${realSandcastleScenario.expectedArtifact.contentUtf8Sha256}`
      || await git(cliProjectPath, ["status", "--porcelain=v1", "--untracked-files=all"])
        !== ""
      || JSON.stringify(requests.map(({ operation }) => operation))
        !== JSON.stringify(["describe", "harness-run.launch"])
    ) {
      throw new Error("issue_174_cli_delegation_invalid");
    }
    return {
      surface: "sandking launch",
      source: run.source,
      harnessRunId: run.harnessRunId,
      beforeCommit: projectBefore.beforeCommit,
      afterCommit,
      artifactIntegrity: sha256(artifact),
      exactlyOneTerminalEnvelope: run.terminalEnvelopeValidation.exactlyOne,
    };
  } finally {
    await manager.waitForIdle().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
  }
};

const main = async () => {
  if (process.env.SANDKING_REAL_SANDCASTLE_ACCEPTANCE !== "1") {
    emitQualification(createRealSandcastleQualification("real_provider_gate_disabled"));
    return 1;
  }
  const provider = await probeRealProvider(realSandcastleScenario.provider.cliVersion);
  if (provider.code) {
    emitQualification(createRealSandcastleQualification(provider.code));
    return 1;
  }

  let root;
  let projectPath;
  let dataDir;
  let executionDirectory;
  let installed;
  let browser;
  let cliProof = null;
  let runtimeStarted = false;
  let launchActionCount = 0;
  let run = null;
  let completed = false;
  let sandboxImageBefore = null;
  let sandboxImageName;
  let sandboxImageId;
  let sandboxConfigurationIntegrity;
  let sandboxFixedTagChanged = false;
  let sandboxTemporaryImageName;
  let sandboxTemporaryImageOwned = false;
  let workspacePath;
  try {
    root = await mkdtemp(join(tmpdir(), "sandking-issue-174-real-"));
    projectPath = join(root, "project");
    dataDir = join(root, "state");
    executionDirectory = join(root, "outside-checkout");
    await mkdir(executionDirectory, { mode: 0o700 });
    const projectBefore = await initializeProject(projectPath);
    sandboxImageName = realSandcastleScenario.provider.sandbox.image;
    sandboxImageBefore = await inspectIssue174SandboxImage(sandboxImageName);
    sandboxTemporaryImageName = `${sandboxImageName}-issue-174-${createHash("sha256")
      .update(`${root}\0${process.pid}`)
      .digest("hex")
      .slice(0, 16)}`;
    if (await inspectIssue174SandboxImage(sandboxTemporaryImageName)) {
      throw new Error("issue_174_real_sandbox_temporary_tag_exists");
    }
    if (sandboxImageBefore) {
      await execFileAsync("docker", [
        "tag", sandboxImageName, sandboxTemporaryImageName,
      ], { env: process.env });
      sandboxTemporaryImageOwned = true;
      await execFileAsync("docker", ["image", "rm", sandboxImageName], {
        env: process.env,
      });
      sandboxFixedTagChanged = true;
    }

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

    const initialHarness = await waitForIssue174ProductionHarness({
      harnessId,
      readState: () => readJson(join(dataDir, "harness-registry.json")),
    });
    workspacePath = initialHarness.workspacePath;
    const sandboxConfigurationPath = join(
      workspacePath,
      ...realSandcastleScenario.provider.sandbox.configurationSource.split("/"),
    );
    sandboxConfigurationIntegrity = sha256(await readFile(sandboxConfigurationPath));
    const projectionBefore = await snapshotIssue174Projection(projectionPath);

    launchActionCount += 1;
    await page.locator("#launch-harness").click();
    await page.locator("#harness-launch-confirmation-yes").click();
    run = await waitForTerminalRun(dataDir);
    sandboxImageId = await inspectIssue174SandboxImage(sandboxImageName);
    if (!sandboxImageId) {
      throw new Error("issue_174_product_sandbox_image_missing");
    }
    sandboxFixedTagChanged = true;
    if (
      await inspectIssue174SandboxImage(sandboxImageName) !== sandboxImageId
      || await git(workspacePath, ["status", "--porcelain=v1", "--untracked-files=all"]) !== ""
    ) {
      throw new Error("issue_174_real_sandbox_image_invalid");
    }
    await page.waitForSelector(
      `#harness-run-observation[data-run-id='${run.harnessRunId}']`
        + `[data-run-status='${run.status}']`,
      { timeout: 90_000 },
    );
    if (
      run.status !== "succeeded"
      || run.outcome?.code !== "harness_run_succeeded"
      || run.outcome?.result?.code !== "real_work_committed"
      || run.outcome?.result?.sandbox?.provider !== "docker"
      || run.outcome?.result?.sandbox?.image !== sandboxImageName
      || run.outcome?.result?.sandbox?.imageId !== sandboxImageId
      || run.outcome?.result?.sandbox?.configurationSource
        !== realSandcastleScenario.provider.sandbox.configurationSource
      || run.outcome?.result?.sandbox?.configurationIntegrity !== sandboxConfigurationIntegrity
      || run.outcome?.result?.sandbox?.destinationIsolation !== true
      || run.outcome?.result?.resolvedSkillCount !== 4
      || run.outcome?.result?.skillDelivery?.ambient !== "disabled"
      || run.outcome?.result?.skillDelivery?.method
        !== "complete-pinned-inventory-in-worker-prompt"
      || JSON.stringify(run.outcome?.result?.skillDelivery?.deliveredIdentities)
        !== JSON.stringify([
          "sandking.issue-implementation",
          "sandking.issue-planning",
          "sandking.pull-request-review",
          "sandking.real-delegation",
        ])
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
      join(projectPath, realSandcastleScenario.expectedArtifact.path),
    );
    const projectionAfter = await snapshotIssue174Projection(projectionPath);
    const ignoredProjection = await execFileAsync("git", [
      "-C", projectPath, "check-ignore", "--no-index", "--quiet",
      join(projectionPath, "worker-environment.json"),
    ], { env: gitEnvironment() }).then(() => true, () => false);
    const providerManifestPath = join(projectPath, "sandcastle.real-provider.json");
    const providerManifestRemoved = await readFile(providerManifestPath, "utf8")
      .then(() => false, (error) => error?.code === "ENOENT");
    const status = await git(projectPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const childCommitCount = Number(await git(projectPath, [
      "rev-list", "--count", `${projectBefore.beforeCommit}..${afterCommit}`,
    ]));
    const projectInvariants = {
      exactlyOneChildCommit: childCommitCount === 1,
      expectedArtifactOnly: JSON.stringify(changedFiles)
        === JSON.stringify([realSandcastleScenario.expectedArtifact.path]),
      expectedArtifactContent: sha256(artifact)
        === `sha256:${realSandcastleScenario.expectedArtifact.contentUtf8Sha256}`,
      unrelatedTrackedContentPreserved:
        await readFile(join(projectPath, "README.md"), "utf8") === projectBefore.readme,
      hostProviderManifestRemoved: providerManifestRemoved
        && !trackedFiles.includes("sandcastle.real-provider.json"),
      cleanAfter: status === "",
      ignoredProjection,
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
    if (harness?.workspacePath !== workspacePath) {
      throw new Error("issue_174_pinned_harness_changed");
    }
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
      adapterManifest.sourcePath !== "src/production-sandcastle-adapter/sandcastle-v4.mjs"
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

    launchActionCount += 1;
    cliProof = await runInstalledCliDelegation({
      installed,
      root,
      sandboxImageId,
    });

    await restoreIssue174SandboxImage({
      fixedImageName: sandboxImageName,
      fixedImageBefore: sandboxImageBefore,
      fixedTagChanged: sandboxFixedTagChanged,
      temporaryImageName: sandboxTemporaryImageName,
      temporaryImageOwned: sandboxTemporaryImageOwned,
    });
    sandboxFixedTagChanged = false;
    sandboxTemporaryImageOwned = false;

    const result = {
      schemaVersion: 1,
      issue: 174,
      scenario: realSandcastleScenario.id,
      qualification: {
        status: "passed",
        productionEvidence: true,
        fixtureSubstitution: false,
      },
      installedSandKing: {
        command: installed.observation.command,
        installed: installed.observation.installed,
        launchedOutsideCheckout: installed.observation.launchedOutsideCheckout,
        tarballIntegrity: `sha256:${installed.observation.tarballSha256}`,
      },
      publicSeam: {
        surfaces: ["cockpit", "sandking launch"],
        defaultProductionHarness: true,
        launchActionCount,
        cockpit: {
          transport:
            "installed sandking -> loopback Cockpit -> authenticated WebSocket -> framed local Host",
          harnessRunId: run.harnessRunId,
        },
        cli: cliProof,
      },
      provider: {
        kind: "openai-codex",
        version: provider.version,
        authentication: "destination-local-authenticated",
        realExecution: true,
        simulated: false,
        sandbox: {
          provider: "docker",
          version: provider.sandboxVersion,
          image: sandboxImageName,
          imageId: sandboxImageId,
          configurationSource: realSandcastleScenario.provider.sandbox.configurationSource,
          configurationIntegrity: sandboxConfigurationIntegrity,
          destinationIsolation: true,
          temporaryImageRemoved: true,
        },
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
          delivery: {
            ambient: "disabled",
            method: "complete-pinned-inventory-in-worker-prompt",
          },
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
          path: realSandcastleScenario.expectedArtifact.path,
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
    validateRealSandcastleResult(result);
    const resultText = serializeSanitizedRealProviderResult({
      result,
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
    completed = true;
    process.stdout.write(resultText);
    return 0;
  } catch (error) {
    const modelInvocationMayHaveOccurred = error
      && typeof error === "object"
      && "modelInvocationMayHaveOccurred" in error
      ? error.modelInvocationMayHaveOccurred === true
      : launchActionCount > 0;
    emitQualification({
      schemaVersion: 1,
      issue: 174,
      scenario: realSandcastleScenario.id,
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
    if (sandboxImageName && sandboxTemporaryImageName) {
      await restoreIssue174SandboxImage({
        fixedImageName: sandboxImageName,
        fixedImageBefore: sandboxImageBefore,
        fixedTagChanged: sandboxFixedTagChanged,
        temporaryImageName: sandboxTemporaryImageName,
        temporaryImageOwned: sandboxTemporaryImageOwned,
      }).catch(() => undefined);
    }
    if (completed && root) await rm(root, { recursive: true, force: true });
  }
};

process.exitCode = await main();
