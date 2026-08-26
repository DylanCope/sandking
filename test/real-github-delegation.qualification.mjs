import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createDestinationWorkerEnvironment } from "../src/destination-worker-environment.mjs";
import {
  createDisposableGitHubRepositories,
  provisionDisposableProjectPat,
  readGitHubDelegationState,
  verifyProjectPatRepositoryScope,
} from "./disposable-github-repository.mjs";
import { installCurrentPackage } from "./installed-package.mjs";
import {
  realGitHubDelegationScenario,
  validateRealGitHubDelegationResult,
} from "./real-github-delegation.mjs";
import { serializeSanitizedRealProviderResult } from "./real-sandcastle-acceptance.mjs";

const execFileAsync = promisify(execFile);
const terminalStatuses = new Set(["cancelled", "failed", "succeeded"]);

const requireGate = () => {
  if (process.env[realGitHubDelegationScenario.environmentGate] !== "1") {
    throw new Error("real_github_delegation_gate_disabled");
  }
  const provisioningToken = process.env.SANDKING_REAL_GITHUB_PROVISIONING_TOKEN;
  const projectPatProvisioner =
    process.env.SANDKING_REAL_GITHUB_PROJECT_PAT_PROVISIONER;
  if (!provisioningToken) throw new Error("real_github_provisioning_token_missing");
  if (!projectPatProvisioner) {
    throw new Error("real_github_project_pat_provisioner_missing");
  }
  return {
    owner: process.env.SANDKING_REAL_GITHUB_OWNER,
    projectPatProvisioner,
    provisioningToken,
  };
};

const probeHostGhSession = async () => {
  try {
    const [{ stdout }] = await Promise.all([
      execFileAsync("gh", ["auth", "token", "--hostname", "github.com"], {
        env: createDestinationWorkerEnvironment(),
        timeout: 10_000,
        maxBuffer: 16_384,
      }),
      execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], {
        env: createDestinationWorkerEnvironment(),
        timeout: 10_000,
      }),
      execFileAsync("codex", ["login", "status"], {
        env: createDestinationWorkerEnvironment(),
        timeout: 10_000,
      }),
    ]);
    const token = stdout.trim();
    if (!token || /\s/.test(token)) throw new Error("invalid");
    return token;
  } catch {
    throw new Error("real_github_host_session_or_provider_unavailable");
  }
};

const readJson = (path) => readFile(path, "utf8").then(JSON.parse);

const waitForTerminal = async (manager, harnessRunId) => {
  const deadline = Date.now() + 2 * 60 * 60_000;
  while (Date.now() < deadline) {
    const observation = await manager.observe({
      requestId: `observe-${harnessRunId}`,
      harnessRunId,
      afterSequence: 0,
    });
    if (terminalStatuses.has(observation.run.status)) return observation;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("real_github_delegation_timeout");
};

const registerProject = async ({ dataDir, installed, projectPath, recordAudit }) => {
  const { createProjectRegistry } = await import(pathToFileURL(join(
    installed.packageDirectory,
    "src",
    "project-registration.mjs",
  )).href);
  const registry = await createProjectRegistry({ dataDir, recordAudit });
  const harness = await registry.registerSandcastleHarness({
    requestId: "register-real-github-harness",
    name: "Sand-King Sandcastle Harness",
    authorizationClass: "host_local_harness_registration",
    idempotencyKey: "register-real-github-harness",
    expectedRevision: 0,
  });
  const project = await registry.registerProject({
    requestId: "register-real-github-project",
    path: projectPath,
    configuration: {
      issueWorkflow: { provider: "github", kind: "issues" },
      checks: [{ checkId: "test", command: "npm test" }],
    },
    authorizationClass: "host_local_project_registration",
    idempotencyKey: "register-real-github-project",
    expectedRevision: 0,
  });
  const pinned = await registry.pinHarness({
    requestId: "pin-real-github-harness",
    projectId: project.project.projectId,
    harnessId: harness.harness.harnessId,
    boundedConfiguration: {
      adapterProtocol: "1.0.0",
      launchProfile: "delegated-work",
    },
    authorizationClass: "host_local_project_configuration",
    idempotencyKey: "pin-real-github-harness",
    expectedRevision: 1,
  });
  return { harness, pinned, project, registry };
};

const createControllerServer = async ({ endpoint, manager, project, requests }) => {
  let dropAcceptedLaunchResponse = true;
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      void (async () => {
        const request = JSON.parse(input.slice(0, input.indexOf("\n")));
        requests.push(request);
        const outcome = request.operation === "describe"
          ? {
              type: "controller.cli.description",
              protocol: "1.0.0",
              command: "sandking launch",
              focusedProjectId: project.project.projectId,
              projectArgumentOptional: true,
              pluginRequired: false,
              launchParameters: project.harness.harness.launchParameters,
            }
          : await manager.launch({
              requestId: request.requestId,
              projectId: project.project.projectId,
              parameters: request.parameters ?? {},
              controllerId: `runtime-${"6".repeat(24)}`,
              controllerSessionId: request.controllerSessionId,
              source: "controller-cli",
              authorizationClass: "harness_run_launch",
              idempotencyKeyHash: request.idempotencyKeyHash,
            });
        if (
          request.operation === "harness-run.launch"
          && outcome.type === "harness.run.launch.result"
          && dropAcceptedLaunchResponse
        ) {
          dropAcceptedLaunchResponse = false;
          socket.destroy();
          return;
        }
        const ok = outcome.type === "controller.cli.description"
          || outcome.type === "harness.run.launch.result";
        socket.end(`${JSON.stringify({
          type: "sandking.cli.result",
          protocol: "1.0.0",
          requestId: request.requestId,
          ok,
          ...(ok ? { outcome } : { failure: { code: outcome.code } }),
        })}\n`);
      })().catch(() => socket.destroy());
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  return server;
};

const closeServer = (server) => new Promise((resolve) => server?.close(resolve) ?? resolve());

const cancelActiveRun = async (manager, harnessRunId) => {
  if (!manager || !harnessRunId) return;
  const observed = await manager.observe({
    requestId: "observe-before-qualification-cleanup",
    harnessRunId,
    afterSequence: 0,
  }).catch(() => null);
  if (!observed || terminalStatuses.has(observed.run.status)) return;
  await manager.cancel({
    requestId: "cancel-failed-real-github-qualification",
    harnessRunId,
    controllerId: `runtime-${"7".repeat(24)}`,
    controllerSessionId: null,
    source: "controller-cli",
    authorizationClass: "harness_run_cancellation",
    idempotencyKeyHash: `sha256:${"8".repeat(64)}`,
  }).catch(() => undefined);
};

test("Production GitHub issue delegation uses a disposable repository", {
  timeout: 3 * 60 * 60_000,
}, async (t) => {
  const credentials = requireGate();
  const hostGhToken = await probeHostGhSession();
  const root = await mkdtemp(join(tmpdir(), "sandking-real-github-delegation-"));
  const projectPath = join(root, "project");
  const dataDir = join(root, "state");
  const endpoint = join(root, "controller.sock");
  const retryDirectory = join(root, "controller-private");
  const userHome = join(root, "controller-home");
  const verificationPath = join(root, "merged-project");
  let disposable;
  let manager;
  let projectPatLease;
  let server;
  let activeHarnessRunId;
  let cleanupFailure;
  try {
    await Promise.all([
      mkdir(dataDir, { recursive: true, mode: 0o700 }),
      mkdir(retryDirectory, { recursive: true, mode: 0o700 }),
      mkdir(userHome, { recursive: true, mode: 0o700 }),
    ]);
    disposable = await createDisposableGitHubRepositories({
      owner: credentials.owner,
      provisioningToken: credentials.provisioningToken,
    });
    projectPatLease = await provisionDisposableProjectPat({
      deniedRepository: disposable.denied.nameWithOwner,
      primaryRepository: disposable.primary.nameWithOwner,
      provisionerPath: credentials.projectPatProvisioner,
    });
    if (credentials.provisioningToken === projectPatLease.token) {
      throw new Error("real_github_credential_roles_not_isolated");
    }
    await disposable.clone(projectPath);
    const projectScopeEnforced = await verifyProjectPatRepositoryScope({
      deniedRepository: disposable.denied.nameWithOwner,
      primaryRepository: disposable.primary.nameWithOwner,
      projectPat: projectPatLease.token,
    });

    const installed = await installCurrentPackage(root);
    const audits = [];
    const recordAudit = async (action, outcome, details, requestedAuditId) => {
      const auditId = requestedAuditId
        ?? `audit-${String(audits.length + 1).padStart(24, "0")}`;
      audits.push({ action, auditId, details, outcome });
      return auditId;
    };
    const registration = await registerProject({
      dataDir,
      installed,
      projectPath,
      recordAudit,
    });
    const {
      HOST_GH_SESSION_RISK_ACKNOWLEDGEMENT,
      createGitHubCredentialManager,
    } = await import(pathToFileURL(join(
      installed.packageDirectory,
      "src",
      "github-credentials.mjs",
    )).href);
    const githubCredentials = await createGitHubCredentialManager({ dataDir, recordAudit });
    const configured = await githubCredentials.configureProject({
      requestId: "configure-real-github-project-pat",
      projectId: registration.project.project.projectId,
      action: "set",
      personalAccessToken: projectPatLease.token,
      authorizationClass: "host_local_github_credentials",
      idempotencyKey: "configure-real-github-project-pat",
      expectedRevision: 0,
    });
    assert.equal(configured.effectiveMode, "project-pat");

    const { createHarnessRunManager } = await import(pathToFileURL(join(
      installed.packageDirectory,
      "src",
      "harness-runs.mjs",
    )).href);
    manager = await createHarnessRunManager({
      dataDir,
      hostId: `host-${"5".repeat(24)}`,
      recordAudit,
      loadLaunchContext: registration.registry.loadLaunchContext,
      resolveGitHubCredential: githubCredentials.resolveForProject,
    });
    const requests = [];
    server = await createControllerServer({
      endpoint,
      manager,
      project: registration,
      requests,
    });
    const launchEnvironment = {
      ...process.env,
      HOME: userHome,
      SANDKING_CONTROLLER_ENDPOINT: endpoint,
      SANDKING_CONTROLLER_RETRY_DIRECTORY: retryDirectory,
      SANDKING_CONTROLLER_SESSION_ID: `controller-session-${"4".repeat(24)}`,
      SANDKING_WORK_CONTEXT_ID: registration.project.project.projectId,
    };
    const launchArguments = [
      "launch",
      registration.project.project.projectId,
      "--issue", String(disposable.issue.number),
      "--json",
    ];
    await assert.rejects(execFileAsync(installed.command, launchArguments, {
      cwd: root,
      env: launchEnvironment,
      timeout: 60_000,
    }));
    const replay = JSON.parse((await execFileAsync(installed.command, launchArguments, {
      cwd: root,
      env: launchEnvironment,
      timeout: 60_000,
    })).stdout);
    assert.equal(replay.type, "harness.run.launch.result", JSON.stringify(replay));
    assert.equal(replay.idempotentReplay, true);
    activeHarnessRunId = replay.run.harnessRunId;
    const primary = await waitForTerminal(manager, activeHarnessRunId);
    assert.equal(primary.run.status, "succeeded", JSON.stringify(primary.outcome));
    assert.equal(primary.outcome.result.code, "issue_delivery_completed");

    const primaryState = await readGitHubDelegationState({
      issueNumber: disposable.issue.number,
      provisioningToken: credentials.provisioningToken,
      repository: disposable.primary.nameWithOwner,
    });
    assert.equal(primaryState.pullRequests.length, 1);
    const pullRequest = primaryState.pullRequests[0];
    const delivery = await disposable.verifyMergedProject(verificationPath);
    const retainedAfterPrimary = await readJson(join(dataDir, "harness-runs.json"));
    assert.equal(retainedAfterPrimary.runs.length, 1);

    const cleared = await githubCredentials.configureProject({
      requestId: "clear-real-github-project-pat",
      projectId: registration.project.project.projectId,
      action: "clear",
      authorizationClass: "host_local_github_credentials",
      idempotencyKey: "clear-real-github-project-pat",
      expectedRevision: 1,
    });
    assert.equal(cleared.effectiveMode, null);
    const enabled = await githubCredentials.configureHost({
      requestId: "enable-real-github-host-session",
      action: "enable",
      riskAcknowledgement: HOST_GH_SESSION_RISK_ACKNOWLEDGEMENT,
      authorizationClass: "host_local_github_credentials",
      idempotencyKey: "enable-real-github-host-session",
      expectedRevision: 2,
    });
    assert.equal(enabled.effectiveMode, null);
    const resolvedHostCredential = await githubCredentials.resolveForProject(
      registration.project.project.projectId,
    );
    assert.equal(resolvedHostCredential.mode, "host-gh-session");
    assert.equal(resolvedHostCredential.token === hostGhToken, true);

    const hostLaunch = JSON.parse((await execFileAsync(installed.command, launchArguments, {
      cwd: root,
      env: launchEnvironment,
      timeout: 60_000,
    })).stdout);
    activeHarnessRunId = hostLaunch.run.harnessRunId;
    assert.notEqual(activeHarnessRunId, primary.run.harnessRunId);
    const passthrough = await waitForTerminal(manager, activeHarnessRunId);
    assert.equal(passthrough.run.status, "succeeded", JSON.stringify(passthrough.outcome));
    assert.equal(passthrough.outcome.result.completion.kind, "issue-already-closed");

    const finalState = await readGitHubDelegationState({
      issueNumber: disposable.issue.number,
      provisioningToken: credentials.provisioningToken,
      repository: disposable.primary.nameWithOwner,
    });
    const primaryLaunchAttempts = requests.filter((request) =>
      request.operation === "harness-run.launch"
      && request.idempotencyKeyHash === replay.run.launchIdempotencyKeyHash).length;
    const result = {
      schemaVersion: 1,
      scenario: realGitHubDelegationScenario.id,
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
      harness: {
        identity: primary.run.adapterId,
        pinnedRevision: primary.run.harnessPinnedRevision,
      },
      authentication: {
        primaryMode: "project-pat",
        passthroughMode: "host-gh-session",
        projectScopeEnforced,
      },
      github: {
        repository: disposable.primary,
        deniedRepository: { ...disposable.denied, access: "denied" },
        issue: {
          number: finalState.issue.number,
          url: finalState.issue.url,
          state: finalState.issue.state,
        },
        pullRequest,
        delivery,
      },
      structuredOutcome: {
        harnessRunId: primary.run.harnessRunId,
        status: primary.run.status,
        code: primary.outcome.result.code,
        completion: primary.outcome.result.completion,
      },
      idempotency: {
        launchAttempts: primaryLaunchAttempts,
        canonicalRunCount: retainedAfterPrimary.runs.length,
        pullRequestCount: finalState.pullRequests.length,
        claimActions: finalState.claimActions,
      },
      hostGhPassthrough: {
        harnessRunId: passthrough.run.harnessRunId,
        status: passthrough.run.status,
        completion: passthrough.outcome.result.completion.kind,
      },
      diagnostics: {
        contentRetained: false,
        references: primary.logStreams.map((stream) => ({
          streamId: stream.streamId,
          producer: stream.producer,
          explicitRetrievalRequired: stream.explicitRetrievalRequired,
        })),
      },
    };
    validateRealGitHubDelegationResult(result);
    const serialized = serializeSanitizedRealProviderResult({
      result,
      prohibitedValues: [
        projectPatLease.token,
        credentials.provisioningToken,
        hostGhToken,
        root,
        projectPath,
        dataDir,
        process.env.HOME,
        process.env.CODEX_HOME,
      ],
    });
    t.diagnostic(serialized.trim());
    activeHarnessRunId = null;
  } finally {
    await cancelActiveRun(manager, activeHarnessRunId);
    await manager?.waitForIdle().catch(() => undefined);
    await closeServer(server);
    if (projectPatLease) {
      await projectPatLease.dispose().catch((error) => {
        cleanupFailure ??= error;
      });
    }
    if (disposable) {
      await disposable.dispose().catch((error) => {
        cleanupFailure ??= error;
      });
    }
    await rm(root, { recursive: true, force: true });
    if (cleanupFailure) throw cleanupFailure;
  }
});
