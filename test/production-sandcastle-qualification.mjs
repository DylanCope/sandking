import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import { createGitHubCredentialManager } from "../src/github-credentials.mjs";
import { createHarnessRunManager } from "../src/harness-runs.mjs";
import { REAL_PROVIDER_MANIFEST_SOURCE } from "../src/production-provider-preparation.mjs";
import { installCurrentPackage } from "./installed-package.mjs";
import {
  createProductionFixture,
  execFileAsync,
  installReadyProbeCommands,
  observeProductionRunning,
  observeProductionTerminal,
  productionLaunchRequest,
  readBundledMainState,
  setBundledMainScenario,
  setProductionSandboxImage,
} from "./production-sandcastle-host-fixture.mjs";

// Imported by production-sandcastle-adapter.test.mjs so all production Host
// qualification runs in one test process rather than contending with it.

const alteredWorkerSource = [
  'import { writeFile } from "node:fs/promises";',
  'import { join } from "node:path";',
  'await writeFile(join(process.argv.at(-1), "tampered-runtime.txt"), "tampered runtime executed\\n");',
  'process.exit(0);',
  "",
].join("\n");

const alteredMainSource = [
  'import { writeFileSync, writeSync } from "node:fs";',
  'import { join } from "node:path";',
  'writeFileSync(join(process.cwd(), "tampered-main.txt"), "tampered main executed\\n");',
  'writeSync(1, JSON.stringify({',
  '  type: "sandcastle.delivery.result",',
  '  issueNumber: 173,',
  '  status: "succeeded",',
  '  code: "scoped_issue_completed",',
  '  completion: {',
  '    kind: "merged-pull-request",',
  '    pullRequestNumber: 999,',
  '    pullRequestUrl: "https://github.test/tampered/pull/999",',
  '  },',
  '}) + "\\n");',
  "",
].join("\n");

const installRunnableProviderCommands = async (
  root,
  { mainScenario = "incomplete" } = {},
) => installReadyProbeCommands(root, { mainScenario });

const observeProductionProgress = async (manager, harnessRunId) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const observation = await manager.observe({
      requestId: "observe-production-progress",
      harnessRunId,
      afterSequence: 0,
    });
    if (
      observation.run.status === "running"
      && observation.events.some(({ type }) => type === "harness_progress_published")
    ) return observation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("production_progress_timeout");
};

const waitForBundledMainReview = async (root) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await readBundledMainState(root)).reviewStarted) return;
    } catch {
      // The controlled `gh` process may be replacing its small state file.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("bundled_main_review_timeout");
};

const issueClaimActions = (state, issueNumber) => state.issues[issueNumber].comments
  .flatMap((body) => [...body.matchAll(/<!-- sandcastle-claim:([A-Za-z0-9_-]+) -->/g)])
  .map(([, encoded]) => JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")))
  .map(({ action }) => action);

test("the ordinary launch seam delegates once through the pinned production adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-adapter-"));
  let fixture;
  let restorePath = () => undefined;
  try {
    restorePath = await installRunnableProviderCommands(root, { mainScenario: "success" });
    fixture = await createProductionFixture(root);
    const request = productionLaunchRequest(fixture.project.project.projectId);
    const launched = await fixture.manager.launch(request);
    assert.equal(launched.type, "harness.run.launch.result", JSON.stringify(launched));
    assert.equal(launched.run.adapterId, "sandcastle-harness-adapter-v1");
    assert.equal(
      launched.run.harnessPinnedRevision,
      fixture.harness.harness.immutableRevision,
    );
    assert.deepEqual(launched.run.executionSnapshot.productionHarness, {
      skillSetLockDigest: fixture.pinned.project.harness.preparation.skillSetLockDigest,
      resolvedSkills: fixture.pinned.project.harness.preparation.resolvedSkills,
      executionRuntimeInputs:
        fixture.pinned.project.harness.preparation.executionRuntimeInputs,
      projectionDigest: fixture.pinned.project.harness.preparation.projection.digest,
    });
    const snapshotText = JSON.stringify(launched.run.executionSnapshot);
    assert.doesNotMatch(snapshotText, new RegExp(root.replaceAll("/", "\\/")));
    assert.doesNotMatch(snapshotText, /secret|credentialValue|machinePath/i);

    const observed = await observeProductionTerminal(
      fixture.manager,
      launched.run.harnessRunId,
    );
    const diagnostics = await fixture.manager.readLogs({
      requestId: "read-production-qualification-diagnostics",
      harnessRunId: launched.run.harnessRunId,
      producer: "stderr",
      offset: 0,
      limit: 16_384,
    });
    assert.equal(observed.run.status, "succeeded", diagnostics.data.toString("utf8"));
    assert.equal(observed.outcome.code, "harness_run_succeeded");
    assert.equal(observed.outcome.result.code, "issue_delivery_completed",
      diagnostics.data.toString("utf8"));
    assert.equal(observed.outcome.result.issueNumber, 173);
    assert.deepEqual(observed.outcome.result.completion, {
      kind: "merged-pull-request",
      pullRequestNumber: 700,
      pullRequestUrl: "https://github.test/fixture/controlled-main/pull/700",
    });
    assert.equal(observed.terminalEnvelopeValidation.exactlyOne, true);
    assert.equal(observed.terminalEnvelopeValidation.validTerminalEnvelopeCount, 1);
    assert.equal(observed.events.some(({ progressRecord }) =>
      progressRecord?.type === "sandcastle.worker"
      && progressRecord.payload?.provider === "openai-codex"), true);
    const progressLabels = observed.events.flatMap(({ progressRecord }) =>
      progressRecord ? [progressRecord.label] : []);
    for (const phase of ["Plan issue #173", "Implement issue #173", "Review pull request #700",
      "Complete issue #173"]) {
      assert.ok(progressLabels.includes(phase), JSON.stringify(progressLabels));
    }
    const mainState = await readBundledMainState(root);
    assert.ok(mainState.authenticatedCalls > 0);
    assert.deepEqual(mainState.agentConfigurations, [
      { phase: "planning", model: "gpt-5.6-sol", effort: "xhigh" },
      { phase: "implementation", model: "gpt-5.6-sol", effort: "xhigh" },
      { phase: "review", model: "gpt-5.6-sol", effort: "xhigh" },
    ]);
    assert.equal(mainState.issues[173].state, "closed");
    assert.equal(mainState.pullRequests.length, 1);
    assert.equal(mainState.pullRequests[0].state, "MERGED");
    assert.equal(mainState.pullRequests[0].headRefName, "sandcastle/issue-173");
    assert.match(await readFile(join(fixture.projectPath, "issue-173-delivered.txt"), "utf8"),
      /implemented issue 173/);
    await assert.rejects(
      readFile(join(fixture.projectPath, "sandcastle.real-provider.json"), "utf8"),
      { code: "ENOENT" },
    );

    const replay = await fixture.manager.launch({
      ...request,
      requestId: "replay-production-work",
    });
    assert.equal(replay.type, "harness.run.launch.result");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.run.harnessRunId, launched.run.harnessRunId);
    const conflict = await fixture.manager.launch({
      ...request,
      requestId: "conflict-production-work",
      parameters: { issueNumber: 174 },
    });
    assert.equal(conflict.type, "harness.run.launch.failure");
    assert.equal(conflict.code, "idempotency_key_conflict");
    assert.equal(fixture.audits.filter(({ action }) =>
      action === "harness.adapter.start").length, 1);
    const retained = JSON.parse(await readFile(
      join(fixture.dataDir, "harness-runs.json"),
      "utf8",
    ));
    assert.equal(retained.runs.length, 1);
  } finally {
    await fixture?.manager.waitForIdle().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("the bundled main reports review-budget exhaustion as a truthful typed failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-review-budget-"));
  let fixture;
  let restorePath = () => undefined;
  try {
    restorePath = await installRunnableProviderCommands(root, {
      mainScenario: "review-exhausted",
    });
    fixture = await createProductionFixture(root);
    const launched = await fixture.manager.launch(productionLaunchRequest(
      fixture.project.project.projectId,
      { requestId: "launch-review-exhaustion" },
    ));
    assert.equal(launched.type, "harness.run.launch.result", JSON.stringify(launched));

    const terminal = await observeProductionTerminal(
      fixture.manager,
      launched.run.harnessRunId,
      30_000,
    );
    assert.equal(terminal.run.status, "failed", JSON.stringify(terminal));
    assert.equal(terminal.outcome.code, "harness_run_failed");
    assert.equal(terminal.outcome.result.code, "delivery_execution_failed");
    assert.equal(terminal.terminalEnvelopeValidation.exactlyOne, true);
    assert.equal(terminal.events.some(({ progressRecord }) =>
      progressRecord?.label === "Review pull request #700"), true);

    const state = await readBundledMainState(root);
    assert.equal(state.issues[173].state, "open");
    assert.equal(state.pullRequests.length, 1);
    assert.equal(state.pullRequests[0].state, "OPEN");
    assert.equal(state.pullRequests[0].comments.length, 15);
    assert.deepEqual(issueClaimActions(state, 173), ["claim", "release"]);
  } finally {
    await fixture?.manager.waitForIdle().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("an accepted production launch keeps the image that passed readiness after retagging", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-image-binding-"));
  let fixture;
  let restorePath = () => undefined;
  try {
    restorePath = await installRunnableProviderCommands(root, { mainScenario: "success" });
    fixture = await createProductionFixture(root, null, {
      faultInjector: async (point) => {
        if (point === "harness_run_launch.after_commit") {
          await setProductionSandboxImage(root, `sha256:${"e".repeat(64)}`);
        }
      },
    });
    const launched = await fixture.manager.launch(productionLaunchRequest(
      fixture.project.project.projectId,
      { requestId: "launch-image-binding" },
    ));
    assert.equal(launched.type, "harness.run.launch.result", JSON.stringify(launched));

    const terminal = await observeProductionTerminal(
      fixture.manager,
      launched.run.harnessRunId,
    );
    assert.equal(terminal.run.status, "succeeded", JSON.stringify(terminal));
    assert.equal(
      terminal.outcome.result.sandbox.imageId,
      `sha256:${"d".repeat(64)}`,
    );
  } finally {
    await fixture?.manager.waitForIdle().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("an accepted production launch executes its immutable pinned runtime snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-immutable-runtime-"));
  let fixture;
  let restorePath = () => undefined;
  try {
    restorePath = await installRunnableProviderCommands(root);
    fixture = await createProductionFixture(root, null, {
      faultInjector: async (point) => {
        if (point !== "harness_run_launch.after_commit") return;
        const projectionPath = join(
          fixture.projectPath,
          ...fixture.pinned.project.harness.preparation.projection.path.split("/"),
        );
        await writeFile(
          join(projectionPath, ".sandcastle", "real-worker-v2.mjs"),
          alteredWorkerSource,
        );
      },
    });

    const launched = await fixture.manager.launch(productionLaunchRequest(
      fixture.project.project.projectId,
    ));
    assert.equal(launched.type, "harness.run.launch.result", JSON.stringify(launched));
    assert.equal(
      launched.run.executionSnapshot.productionHarness.projectionDigest,
      fixture.pinned.project.harness.preparation.projection.digest,
    );
    const terminal = await observeProductionTerminal(
      fixture.manager,
      launched.run.harnessRunId,
    );
    assert.equal(terminal.run.status, "failed", JSON.stringify(terminal));
    assert.equal(terminal.outcome.result.code, "scoped_issue_incomplete");
    await assert.rejects(
      readFile(join(fixture.projectPath, "tampered-runtime.txt"), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await fixture?.manager.waitForIdle().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("an altered retained production runtime never starts or reports success", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-altered-runtime-"));
  let fixture;
  let restorePath = () => undefined;
  try {
    restorePath = await installRunnableProviderCommands(root);
    fixture = await createProductionFixture(root, null, {
      faultInjector: async (point) => {
        if (point !== "harness_run_launch.after_commit") return;
        const [harnessRunId] = await readdir(join(fixture.dataDir, "harness-runs"));
        const executionWorkerPath = join(
          fixture.dataDir,
          "harness-runs",
          harnessRunId,
          "execution",
          ".sandcastle",
          "real-worker-v2.mjs",
        );
        await chmod(executionWorkerPath, 0o600);
        await writeFile(executionWorkerPath, alteredWorkerSource);
      },
    });

    const launched = await fixture.manager.launch(productionLaunchRequest(
      fixture.project.project.projectId,
    ));
    assert.equal(launched.type, "harness.run.launch.result", JSON.stringify(launched));
    const terminal = await observeProductionTerminal(
      fixture.manager,
      launched.run.harnessRunId,
      20_000,
    );
    assert.equal(terminal.run.status, "failed", JSON.stringify(terminal));
    assert.equal(terminal.outcome.code, "harness_adapter_start_failed");
    assert.equal(fixture.audits.some(({ action }) => action === "harness.adapter.start"), false);
    await assert.rejects(
      readFile(join(fixture.projectPath, "tampered-runtime.txt"), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await fixture?.manager.waitForIdle().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("the accepted production runtime closure remains bound after the adapter process starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-worker-handoff-"));
  let fixture;
  let restorePath = () => undefined;
  try {
    restorePath = await installRunnableProviderCommands(root);
    fixture = await createProductionFixture(root, null, {
      onAudit: async (action, _outcome, details) => {
        if (action !== "harness.adapter.start") return;
        const executionRoot = join(
          fixture.dataDir,
          "harness-runs",
          details.harnessRunId,
          "execution",
        );
        const replacements = [
          [join(executionRoot, ".sandcastle", "real-worker-v2.mjs"), alteredWorkerSource],
          [join(executionRoot, ".sandcastle", "main.mts"), alteredMainSource],
          [
            join(executionRoot, ".sandcastle", "issue-delivery.mjs"),
            'throw new Error("tampered issue delivery executed");\n',
          ],
        ];
        for (const [path, source] of replacements) {
          await chmod(path, 0o600);
          await writeFile(path, source);
        }
      },
    });

    const launched = await fixture.manager.launch(productionLaunchRequest(
      fixture.project.project.projectId,
    ));
    assert.equal(launched.type, "harness.run.launch.result", JSON.stringify(launched));
    const terminal = await observeProductionTerminal(
      fixture.manager,
      launched.run.harnessRunId,
    );
    assert.equal(terminal.run.status, "failed", JSON.stringify(terminal));
    assert.equal(terminal.outcome.result.code, "scoped_issue_incomplete");
    await assert.rejects(
      readFile(join(fixture.projectPath, "tampered-runtime.txt"), "utf8"),
      { code: "ENOENT" },
    );
    await assert.rejects(
      readFile(join(fixture.projectPath, "tampered-main.txt"), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await fixture?.manager.waitForIdle().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("the installed ordinary CLI discovers production parameters and launches the same adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-installed-qualification-"));
  const endpoint = join(root, "controller.sock");
  let fixture;
  let credentials;
  let server;
  let restorePath = () => undefined;
  try {
    const installed = await installCurrentPackage(root);
    restorePath = await installRunnableProviderCommands(root);
    fixture = await createProductionFixture(root, null, {
      resolveGitHubCredential: (projectId) => credentials.resolveForProject(projectId),
    });
    credentials = await createGitHubCredentialManager({
      dataDir: fixture.dataDir,
      recordAudit: fixture.recordAudit,
    });
    const projectId = fixture.project.project.projectId;
    const controllerSessionId = `controller-session-${"5".repeat(24)}`;
    const requests = [];
    server = createServer((socket) => {
      socket.setEncoding("utf8");
      let input = "";
      socket.on("data", async (chunk) => {
        input += chunk;
        if (!input.includes("\n")) return;
        try {
          const request = JSON.parse(input.slice(0, input.indexOf("\n")));
          requests.push(request);
          let outcome;
          if (request.operation === "describe") {
            outcome = {
              type: "controller.cli.description",
              protocol: "1.0.0",
              command: "sandking launch",
              focusedProjectId: projectId,
              projectArgumentOptional: true,
              pluginRequired: false,
              launchParameters: fixture.harness.harness.launchParameters,
            };
          } else if (request.operation === "harness-run.launch") {
            outcome = await fixture.manager.launch({
              requestId: request.requestId,
              projectId,
              parameters: request.parameters ?? {},
              controllerId: `runtime-${"6".repeat(24)}`,
              controllerSessionId: request.controllerSessionId,
              source: "controller-cli",
              authorizationClass: "harness_run_launch",
              idempotencyKeyHash: request.idempotencyKeyHash,
            });
          } else {
            throw new Error("unexpected_controller_cli_operation");
          }
          const launchFailed = outcome?.type === "harness.run.launch.failure";
          socket.end(`${JSON.stringify({
            type: "sandking.cli.result",
            protocol: "1.0.0",
            requestId: request.requestId,
            ok: !launchFailed,
            ...(launchFailed
              ? {
                  failure: {
                    code: outcome.code,
                    sanitizedExplanation: outcome.sanitizedExplanation,
                    configurationOptions: outcome.configurationOptions,
                  },
                }
              : { outcome }),
          })}\n`);
        } catch (error) {
          socket.destroy(error instanceof Error ? error : undefined);
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    const retryDirectory = join(root, "controller-private");
    const userHome = join(root, "user-home");
    await Promise.all([
      mkdir(retryDirectory, { recursive: true }),
      mkdir(userHome, { recursive: true }),
    ]);
    const legacyIssueLaunchArguments = [
      "launch", projectId,
      "--issue", "173",
      "--target-branch", "sandcastle/issue-173",
      "--json",
    ];
    const missingIssueLaunchArguments = ["launch", projectId, "--json"];
    const githubAccessLaunchArguments = [
      "launch", projectId,
      "--issue", "174",
      "--verify-github-access", "true",
      "--json",
    ];
    const launchEnvironment = {
      ...process.env,
      HOME: userHome,
      SANDKING_CONTROLLER_ENDPOINT: endpoint,
      SANDKING_CONTROLLER_SESSION_ID: controllerSessionId,
      SANDKING_CONTROLLER_RETRY_DIRECTORY: retryDirectory,
      SANDKING_WORK_CONTEXT_ID: projectId,
    };
    const adapterStartsBeforeCredentialFailure = fixture.audits.filter(
      ({ action }) => action === "harness.adapter.start",
    ).length;

    await assert.rejects(execFileAsync(installed.command, missingIssueLaunchArguments, {
      cwd: root,
      env: launchEnvironment,
    }), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stderr, "");
      const failure = JSON.parse(error.stdout);
      assert.equal(failure.ok, false);
      assert.equal(failure.failure.code, "real_delegation_issue_required");
      assert.match(failure.failure.sanitizedExplanation, /--issue <number>/);
      return true;
    });
    assert.equal(fixture.audits.filter(
      ({ action }) => action === "harness.adapter.start",
    ).length, adapterStartsBeforeCredentialFailure);

    await assert.rejects(execFileAsync(installed.command, githubAccessLaunchArguments, {
      cwd: root,
      env: launchEnvironment,
    }), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stderr, "");
      const failure = JSON.parse(error.stdout);
      assert.equal(failure.ok, false);
      assert.equal(failure.failure.code, "github_credential_unconfigured");
      assert.deepEqual(failure.failure.configurationOptions.map(({ mode }) => mode), [
        "project-pat",
        "host-gh-session",
      ]);
      assert.match(
        failure.failure.configurationOptions[0].guidance,
        /fine-grained Project PAT/i,
      );
      assert.match(
        failure.failure.configurationOptions[1].guidance,
        /Host.*GitHub access/i,
      );
      assert.doesNotMatch(error.stdout, /installed_qualification_secret_261/);
      return true;
    });
    await assert.rejects(execFileAsync(
      installed.command,
      githubAccessLaunchArguments.filter((argument) => argument !== "--json"),
      {
        cwd: root,
        env: launchEnvironment,
      },
    ), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /github_credential_unconfigured/);
      assert.match(error.stderr, /fine-grained Project PAT/i);
      assert.match(error.stderr, /Host.*gh CLI session/i);
      assert.doesNotMatch(error.stderr, /installed_qualification_secret_261/);
      return true;
    });
    assert.equal(fixture.audits.filter(
      ({ action }) => action === "harness.adapter.start",
    ).length, adapterStartsBeforeCredentialFailure);

    const configured = await credentials.configureProject({
      requestId: "configure-installed-qualification-project-pat",
      projectId,
      action: "set",
      personalAccessToken: "github_pat_installed_qualification_secret_261",
      authorizationClass: "host_local_github_credentials",
      idempotencyKey: "configure-installed-qualification-project-pat",
      expectedRevision: 0,
    });
    assert.equal(configured.type, "github.credentials.configure.result");

    const { stdout: legacyIssueStdout } = await execFileAsync(
      installed.command,
      legacyIssueLaunchArguments,
      {
        cwd: root,
        env: launchEnvironment,
      },
    );
    const legacyIssueLaunch = JSON.parse(legacyIssueStdout);
    assert.equal(
      legacyIssueLaunch.type,
      "harness.run.launch.result",
      JSON.stringify(legacyIssueLaunch),
    );
    assert.deepEqual(legacyIssueLaunch.run.parameters, {
      issueNumber: 173,
      targetBranch: "sandcastle/issue-173",
    });
    await observeProductionTerminal(fixture.manager, legacyIssueLaunch.run.harnessRunId);

    const { stdout } = await execFileAsync(installed.command, githubAccessLaunchArguments, {
      cwd: root,
      env: launchEnvironment,
    });
    const launched = JSON.parse(stdout);
    assert.equal(launched.type, "harness.run.launch.result", JSON.stringify(launched));
    assert.deepEqual(launched.run.parameters, {
      issueNumber: 174,
      verifyGitHubAccess: true,
    });
    const observed = await observeProductionTerminal(
      fixture.manager,
      launched.run.harnessRunId,
    );
    const observedDiagnostics = await fixture.manager.readLogs({
      requestId: "read-installed-qualification-diagnostics",
      harnessRunId: launched.run.harnessRunId,
      producer: "stderr",
      offset: 0,
      limit: 16_384,
    });
    assert.equal(observed.run.status, "failed", JSON.stringify(observed));
    assert.equal(observed.run.adapterId, "sandcastle-harness-adapter-v1");
    assert.equal(
      observed.outcome.code,
      "harness_run_failed",
      observedDiagnostics.data.toString("utf8"),
    );
    assert.equal(observed.outcome.result.code, "scoped_issue_incomplete");
    assert.equal(observed.terminalEnvelopeValidation.exactlyOne, true);
    assert.deepEqual(requests.map(({ operation }) => operation), [
      "harness-run.launch",
      "describe",
      "harness-run.launch",
      "describe",
      "harness-run.launch",
      "describe",
      "harness-run.launch",
      "describe",
      "harness-run.launch",
    ]);
    assert.equal(requests[0].projectId, projectId);
    assert.equal(requests[8].controllerSessionId, controllerSessionId);
    assert.equal("plugin" in requests[8], false);
    assert.equal("expectedRevision" in requests[8], false);
  } finally {
    await fixture?.manager.waitForIdle().catch(() => undefined);
    await new Promise((resolve) => server?.close(resolve) ?? resolve());
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("production cancellation and reconnection converge on the same canonical run", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-cancellation-"));
  let fixture;
  let restorePath = () => undefined;
  try {
    restorePath = await installRunnableProviderCommands(root, { mainScenario: "cancellable" });
    fixture = await createProductionFixture(root, null, { cancellationGraceMs: 10_000 });
    const originalMain = (await execFileAsync(
      "git",
      ["-C", fixture.projectPath, "rev-parse", "main"],
    )).stdout.trim();
    const launched = await fixture.manager.launch(productionLaunchRequest(
      fixture.project.project.projectId,
      {
        requestId: "launch-cancellable-production-work",
        controllerSessionId: null,
        source: "cockpit",
        idempotencyKeyHash: `sha256:${"d".repeat(64)}`,
      },
    ));
    assert.equal(launched.type, "harness.run.launch.result", JSON.stringify(launched));
    await waitForBundledMainReview(root);
    const activeState = await readBundledMainState(root);
    assert.equal(activeState.issues[173].state, "open");
    assert.equal(activeState.pullRequests.length, 1);
    assert.equal(activeState.pullRequests[0].state, "OPEN");
    assert.deepEqual(issueClaimActions(activeState, 173), ["claim"]);

    const cancellation = await fixture.manager.cancel({
      requestId: "cancel-production-work",
      harnessRunId: launched.run.harnessRunId,
      controllerId: `runtime-${"2".repeat(24)}`,
      controllerSessionId: null,
      source: "cockpit",
      authorizationClass: "harness_run_cancellation",
      idempotencyKeyHash: `sha256:${"e".repeat(64)}`,
    });
    assert.equal(cancellation.type, "harness.run.cancel.result", JSON.stringify(cancellation));
    const terminal = await observeProductionTerminal(
      fixture.manager,
      launched.run.harnessRunId,
      20_000,
    );
    assert.equal(terminal.run.status, "cancelled", JSON.stringify(terminal));
    assert.equal(terminal.outcome.code, "harness_run_cancelled");
    const cancellationDiagnostics = await fixture.manager.readLogs({
      requestId: "read-cancellation-diagnostics",
      harnessRunId: launched.run.harnessRunId,
      producer: "stderr",
      offset: 0,
      limit: 16_384,
    });
    assert.equal(terminal.outcome.incompleteResult, false,
      cancellationDiagnostics.data.toString("utf8"));
    assert.equal(terminal.terminalEnvelopeValidation.validTerminalEnvelopeCount, 1);
    assert.equal(terminal.terminalEnvelopeValidation.exactlyOne, true);
    assert.ok(terminal.run.cancellation.terminationConfirmedAt);
    assert.equal(terminal.events.filter(({ type }) =>
      type === "harness_run_cancellation_accepted").length, 1);
    assert.equal(terminal.events.filter(({ type }) =>
      type === "harness_run_cancelled").length, 1);

    const cancelledState = await readBundledMainState(root);
    assert.equal(cancelledState.issues[173].state, "open");
    assert.equal(cancelledState.pullRequests.length, 1);
    assert.equal(cancelledState.pullRequests[0].state, "OPEN");
    assert.deepEqual(issueClaimActions(cancelledState, 173), ["claim", "release"]);
    assert.equal((await execFileAsync(
      "git",
      ["-C", fixture.projectPath, "branch", "--show-current"],
    )).stdout.trim(), "main");
    assert.equal((await execFileAsync(
      "git",
      ["-C", fixture.projectPath, "rev-parse", "main"],
    )).stdout.trim(), originalMain);
    const partialBranch = (await execFileAsync(
      "git",
      ["-C", fixture.projectPath, "rev-parse", "sandcastle/issue-173"],
    )).stdout.trim();
    assert.notEqual(partialBranch, originalMain);
    assert.equal((await execFileAsync(
      "git",
      ["-C", fixture.projectPath, "rev-parse", "origin/sandcastle/issue-173"],
    )).stdout.trim(), partialBranch);
    await assert.rejects(
      readFile(join(fixture.projectPath, "issue-173-delivered.txt"), "utf8"),
      { code: "ENOENT" },
    );

    const reconnectedManager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId: `host-${"1".repeat(24)}`,
      recordAudit: async (_action, _outcome, _details, requestedAuditId) =>
        requestedAuditId ?? `audit-${"f".repeat(24)}`,
      loadLaunchContext: fixture.registry.loadLaunchContext,
    });
    const reconnected = await reconnectedManager.observe({
      requestId: "reconnect-cancelled-production-work",
      harnessRunId: launched.run.harnessRunId,
      afterSequence: 0,
    });
    assert.deepEqual(reconnected.run, terminal.run);
    assert.deepEqual(reconnected.events, terminal.events);
    assert.deepEqual(reconnected.outcome, terminal.outcome);
    assert.deepEqual(reconnected.logStreams, terminal.logStreams);
    assert.equal(fixture.audits.filter(({ action }) =>
      action === "harness.adapter.start").length, 1);

    await setBundledMainScenario(root, "success");
    const resumed = await fixture.manager.launch(productionLaunchRequest(
      fixture.project.project.projectId,
      {
        requestId: "resume-cancelled-production-work",
        idempotencyKeyHash: `sha256:${"a".repeat(64)}`,
      },
    ));
    assert.equal(resumed.type, "harness.run.launch.result", JSON.stringify(resumed));
    assert.notEqual(resumed.run.harnessRunId, launched.run.harnessRunId);
    const recovered = await observeProductionTerminal(
      fixture.manager,
      resumed.run.harnessRunId,
    );
    assert.equal(recovered.run.status, "succeeded", JSON.stringify(recovered));
    assert.equal(recovered.outcome.result.code, "issue_delivery_completed");
    assert.deepEqual(recovered.outcome.result.completion, {
      kind: "merged-pull-request",
      pullRequestNumber: 700,
      pullRequestUrl: "https://github.test/fixture/controlled-main/pull/700",
    });
    const recoveredState = await readBundledMainState(root);
    assert.equal(recoveredState.issues[173].state, "closed");
    assert.equal(recoveredState.pullRequests.length, 1);
    assert.equal(recoveredState.pullRequests[0].state, "MERGED");
    assert.deepEqual(issueClaimActions(recoveredState, 173), [
      "claim",
      "release",
      "claim",
      "release",
    ]);
    assert.match(await readFile(join(fixture.projectPath, "issue-173-delivered.txt"), "utf8"),
      /implemented issue 173/);
  } finally {
    await fixture?.manager.waitForIdle().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal cleanup retry preserves a Project replacement after readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-provider-release-retry-"));
  const manifestPath = join(root, "project", "sandcastle.real-provider.json");
  const excludePath = join(root, "project", ".git", "info", "exclude");
  let fixture;
  let excludeBefore;
  let repairManifest = Promise.resolve();
  let restorePath = () => undefined;
  try {
    restorePath = await installRunnableProviderCommands(root);
    fixture = await createProductionFixture(root, null, {
      faultInjector: async (point) => {
        if (point !== "harness_run_lifecycle.adapter_ready.before_commit") return;
        await rm(manifestPath);
        await mkdir(manifestPath);
        repairManifest = new Promise((resolve, reject) => {
          setTimeout(() => {
            void (async () => {
              await rm(manifestPath, { recursive: true });
              await writeFile(manifestPath, REAL_PROVIDER_MANIFEST_SOURCE);
            })().then(resolve, reject);
          }, 5);
        });
      },
    });
    excludeBefore = await readFile(excludePath, "utf8");

    const launched = await fixture.manager.launch(productionLaunchRequest(
      fixture.project.project.projectId,
    ));
    assert.equal(launched.type, "harness.run.launch.result", JSON.stringify(launched));
    const terminal = await observeProductionTerminal(
      fixture.manager,
      launched.run.harnessRunId,
    );
    assert.equal(terminal.run.status, "failed", JSON.stringify(terminal));
    assert.equal(terminal.outcome.result.code, "scoped_issue_incomplete");
    await repairManifest;
    assert.equal(await readFile(manifestPath, "utf8"), REAL_PROVIDER_MANIFEST_SOURCE);
    assert.equal(await readFile(excludePath, "utf8"), excludeBefore);
  } finally {
    await repairManifest.catch(() => undefined);
    await fixture?.manager.waitForIdle().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});
