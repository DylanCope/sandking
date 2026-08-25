import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { createLocalHostTransport } from "../src/daemon/host-transport/local.mjs";
import { createDestinationWorkerEnvironment } from "../src/destination-worker-environment.mjs";
import {
  HOST_GH_SESSION_RISK_ACKNOWLEDGEMENT,
  createGitHubCredentialManager,
} from "../src/github-credentials.mjs";
import { createHarnessRunManager } from "../src/harness-runs.mjs";
import {
  createProductionRegistration,
  execFileAsync,
  installReadyProbeCommands,
  observeProductionTerminal,
  productionLaunchRequest,
  writeExecutable,
} from "./production-sandcastle-host-fixture.mjs";
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

// Imported by production-sandcastle-adapter.test.mjs so production Host
// qualification remains serialized in one test process.

const projectToken = "github_pat_project_specific_secret_261";
const hostToken = "gho_host_session_secret_261";

const createTransportRuntime = ({ dataDir, hostId, recordAudit, startupId }) => ({
  args: {
    allowHostIdentityCreate: true,
    dataDir,
    expectedHostId: hostId,
    startupId,
  },
  controllerProtocol: protocolVersion,
  controllerRequiredCapabilities: [...hostCapabilities],
  controllerSchemaDigest: HOST_SCHEMA_DIGEST,
  hostArgs: [
    join(process.cwd(), "src", "local-host.mjs"),
    "--data-dir", dataDir,
    "--allow-host-identity-create",
  ],
  hostCapabilities,
  hostSchemaDigest: HOST_SCHEMA_DIGEST,
  protocolVersion,
  recordAudit,
  state: null,
});

const readTreeText = async (root) => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
    .catch(() => []);
  const files = entries.filter((entry) => entry.isFile());
  return (await Promise.all(files.map((entry) => readFile(join(entry.parentPath, entry.name),
    "utf8").catch(() => "")))).join("\n");
};

const waitForTransportTerminalCleanup = async (transport, harnessRunId, projectPath) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const observation = await transport.requestHostOperation({
      type: "harness.run.observe",
      requestId: "observe-github-credential-qualification",
      harnessRunId,
      afterSequence: 0,
    });
    const selectorRemoved = await readFile(
      join(projectPath, "sandcastle.real-provider.json"),
      "utf8",
    ).then(() => false, (error) => error?.code === "ENOENT");
    if (["succeeded", "failed", "cancelled"].includes(observation.run?.status)
      && selectorRemoved) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("production_terminal_cleanup_timeout");
};

test("GitHub credentials are explicitly configured in Host-private state with Project precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-github-credentials-"));
  try {
    const fixture = await createProductionRegistration(root);
    let hostTokenRequests = 0;
    const manager = await createGitHubCredentialManager({
      dataDir: fixture.dataDir,
      recordAudit: fixture.recordAudit,
      readHostGhToken: async () => {
        hostTokenRequests += 1;
        return hostToken;
      },
    });
    const projectId = fixture.project.project.projectId;
    const initial = await manager.inspect({
      requestId: "inspect-unconfigured-github-credentials",
      projectId,
    });
    assert.equal(initial.code, "github_credentials_unconfigured");
    assert.equal(initial.revision, 0);
    assert.equal(initial.projectPat, "not-configured");
    assert.equal(initial.hostGhSessionReuse, "disabled");
    assert.deepEqual(initial.configurationOptions.map(({ mode }) => mode), [
      "project-pat",
      "host-gh-session",
    ]);
    assert.match(initial.configurationOptions[0].guidance, /fine-grained/i);
    assert.match(initial.configurationOptions[1].guidance, /full.*Host.*GitHub access/i);

    const rejectedOptIn = await manager.configureHost({
      requestId: "reject-implicit-host-gh-session",
      action: "enable",
      authorizationClass: "host_local_github_credentials",
      idempotencyKey: "reject-implicit-host-gh-session",
      expectedRevision: 0,
    });
    assert.equal(rejectedOptIn.type, "github.credentials.configure.failure");
    assert.equal(rejectedOptIn.code, "github_host_session_risk_not_acknowledged");

    const enabled = await manager.configureHost({
      requestId: "enable-host-gh-session",
      action: "enable",
      riskAcknowledgement: HOST_GH_SESSION_RISK_ACKNOWLEDGEMENT,
      authorizationClass: "host_local_github_credentials",
      idempotencyKey: "enable-host-gh-session",
      expectedRevision: 0,
    });
    assert.equal(enabled.type, "github.credentials.configure.result");
    assert.equal(enabled.hostGhSessionReuse, "enabled");
    assert.equal(enabled.revision, 1);

    const configured = await manager.configureProject({
      requestId: "configure-project-pat",
      projectId,
      action: "set",
      personalAccessToken: projectToken,
      authorizationClass: "host_local_github_credentials",
      idempotencyKey: "configure-project-pat",
      expectedRevision: 1,
    });
    assert.equal(configured.type, "github.credentials.configure.result");
    assert.equal(configured.projectPat, "configured");
    assert.equal(configured.revision, 2);
    assert.doesNotMatch(JSON.stringify(configured), new RegExp(projectToken));

    const statePath = join(fixture.dataDir, "github-credentials.json");
    const retainedConfigured = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(retainedConfigured.projectPersonalAccessTokens[projectId], projectToken);
    assert.equal(statePath.startsWith(`${fixture.projectPath}/`), false);
    assert.equal((await execFileAsync("git", [
      "-C", fixture.projectPath, "status", "--porcelain=v1", "--untracked-files=all",
    ])).stdout, "");

    assert.deepEqual(await manager.resolveForProject(projectId), {
      mode: "project-pat",
      token: projectToken,
    });
    assert.equal(hostTokenRequests, 0);

    const cleared = await manager.configureProject({
      requestId: "clear-project-pat",
      projectId,
      action: "clear",
      authorizationClass: "host_local_github_credentials",
      idempotencyKey: "clear-project-pat",
      expectedRevision: 2,
    });
    assert.equal(cleared.projectPat, "not-configured");
    assert.deepEqual(await manager.resolveForProject(projectId), {
      mode: "host-gh-session",
      token: hostToken,
    });
    assert.equal(hostTokenRequests, 1);

    const disabled = await manager.configureHost({
      requestId: "disable-host-gh-session",
      action: "disable",
      authorizationClass: "host_local_github_credentials",
      idempotencyKey: "disable-host-gh-session",
      expectedRevision: 3,
    });
    assert.equal(disabled.hostGhSessionReuse, "disabled");
    assert.equal(await manager.resolveForProject(projectId), null);

    const stateDetails = await stat(statePath);
    const directoryDetails = await stat(fixture.dataDir);
    assert.equal(stateDetails.mode & 0o777, 0o600);
    assert.equal(directoryDetails.mode & 0o777, 0o700);
    assert.doesNotMatch(await readFile(join(fixture.projectPath, "README.md"), "utf8"),
      /secret_261/);
    assert.doesNotMatch(JSON.stringify(fixture.audits), /secret_261/);
    const retained = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(retained.projectPersonalAccessTokens[projectId], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unscoped production delegation fails before optional GitHub credential resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-github-credential-launch-"));
  let restorePath = () => undefined;
  let manager;
  try {
    restorePath = await installReadyProbeCommands(root);
    const fixture = await createProductionRegistration(root);
    const credentials = await createGitHubCredentialManager({
      dataDir: fixture.dataDir,
      recordAudit: fixture.recordAudit,
      readHostGhToken: async () => {
        throw new Error(hostToken);
      },
    });
    manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId: `host-${"1".repeat(24)}`,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      resolveGitHubCredential: credentials.resolveForProject,
    });
    const projectId = fixture.project.project.projectId;

    const unconfigured = await manager.launch(productionLaunchRequest(projectId, {
      parameters: {},
    }));
    assert.equal(unconfigured.type, "harness.run.launch.failure");
    assert.equal(unconfigured.code, "real_delegation_issue_required");

    await credentials.configureHost({
      requestId: "enable-unavailable-host-session",
      action: "enable",
      riskAcknowledgement: HOST_GH_SESSION_RISK_ACKNOWLEDGEMENT,
      authorizationClass: "host_local_github_credentials",
      idempotencyKey: "enable-unavailable-host-session",
      expectedRevision: 0,
    });
    const unavailable = await manager.launch(productionLaunchRequest(projectId, {
      requestId: "launch-with-unavailable-host-session",
      parameters: {},
      idempotencyKeyHash: `sha256:${"5".repeat(64)}`,
    }));
    assert.equal(unavailable.type, "harness.run.launch.failure");
    assert.equal(unavailable.code, "real_delegation_issue_required");
    const requiredUnavailable = await manager.launch(productionLaunchRequest(projectId, {
      requestId: "reject-required-unavailable-host-session",
      parameters: { issueNumber: 262 },
      idempotencyKeyHash: `sha256:${"6".repeat(64)}`,
    }));
    assert.equal(requiredUnavailable.type, "harness.run.launch.failure");
    assert.equal(requiredUnavailable.code, "github_host_gh_session_unavailable");
    assert.match(requiredUnavailable.configurationOptions[0].guidance, /Project PAT/i);
    assert.match(requiredUnavailable.configurationOptions[1].guidance, /gh auth login/i);

    const retained = [
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
      JSON.stringify(fixture.audits),
    ].join("\n");
    assert.doesNotMatch(retained, /host_session_secret_261/);
    assert.equal((await execFileAsync("git", [
      "-C", fixture.projectPath, "status", "--porcelain=v1", "--untracked-files=all",
    ])).stdout, "");
  } finally {
    await manager?.waitForIdle().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("the POSIX local Host reads the configured gh session for global reuse", {
  skip: process.platform === "win32" ? "POSIX executable fixture" : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-host-gh-path-"));
  const originalPath = process.env.PATH;
  const originalGitHubConfigDirectory = process.env.GH_CONFIG_DIR;
  let transport;
  try {
    const fixture = await createProductionRegistration(root);
    const binPath = join(root, "host-account-bin");
    const githubConfigDirectory = join(root, "host-account-gh-config");
    const ghInvokedPath = join(root, "host-gh-invoked");
    await Promise.all([
      mkdir(binPath),
      mkdir(githubConfigDirectory),
    ]);
    await writeFile(join(githubConfigDirectory, "hosts.yml"), `${hostToken}\n`);
    await Promise.all([
      writeExecutable(join(binPath, "gh"), `#!/bin/sh
set -eu
if [ "$1 $2 $3 $4" = "auth token --hostname github.com" ]; then
  [ "$(cat "$GH_CONFIG_DIR/hosts.yml")" = "${hostToken}" ]
  printf '%s\\n' 'invoked' > '${ghInvokedPath}'
  cat "$GH_CONFIG_DIR/hosts.yml"
  exit 0
fi
exit 94
`),
      writeExecutable(join(binPath, "codex"), `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 0.146.0'; exit 0; fi
if [ "$1 $2" = "login status" ]; then printf '%s\\n' 'Logged in using fixture'; exit 0; fi
exit 91
`),
      writeExecutable(join(binPath, "npm"), `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' '10.9.8'; exit 0; fi
if [ "$1" = "ci" ]; then exit 0; fi
exit 92
`),
      writeExecutable(join(binPath, "docker"), `#!/bin/sh
if [ "$1 $2" = "version --format" ]; then printf '%s\\n' '27.5.1'; exit 0; fi
if [ "$1 $2 $3" = "image inspect sandcastle:sandking-real-worker" ]; then
  printf '%s\\n' 'sha256:${"d".repeat(64)}'
  exit 0
fi
exit 93
`),
    ]);
    process.env.PATH = `${binPath}${delimiter}${originalPath ?? ""}`;
    process.env.GH_CONFIG_DIR = githubConfigDirectory;

    const hostId = `host-${"6".repeat(24)}`;
    const runtime = createTransportRuntime({
      dataDir: fixture.dataDir,
      hostId,
      recordAudit: fixture.recordAudit,
      startupId: "github-host-path-qualification",
    });
    transport = createLocalHostTransport(runtime);
    await transport.launchHost(`runtime-${"7".repeat(24)}`);

    const legacyIssueLaunch = await transport.requestHostOperation({
      type: "harness.run.launch",
      ...productionLaunchRequest(fixture.project.project.projectId, {
        requestId: "launch-legacy-issue-without-github-credential",
        parameters: {
          issueNumber: 261,
          targetBranch: "sandcastle/issue-261",
        },
        idempotencyKeyHash: `sha256:${"8".repeat(64)}`,
      }),
    });
    assert.equal(legacyIssueLaunch.type, "harness.run.launch.failure");
    assert.equal(legacyIssueLaunch.code, "github_credential_unconfigured");
    await assert.rejects(readFile(ghInvokedPath, "utf8"), { code: "ENOENT" });

    const unconfigured = await transport.requestHostOperation({
      type: "harness.run.launch",
      ...productionLaunchRequest(fixture.project.project.projectId, {
        requestId: "reject-unconfigured-shipped-host-launch",
        parameters: { issueNumber: 261, verifyGitHubAccess: true },
        idempotencyKeyHash: `sha256:${"9".repeat(64)}`,
      }),
    });
    assert.equal(
      unconfigured.type,
      "harness.run.launch.failure",
      JSON.stringify(unconfigured),
    );
    assert.equal(unconfigured.code, "github_credential_unconfigured");
    assert.deepEqual(unconfigured.configurationOptions.map(({ mode }) => mode), [
      "project-pat",
      "host-gh-session",
    ]);
    assert.match(unconfigured.configurationOptions[0].guidance, /fine-grained Project PAT/i);
    assert.match(unconfigured.configurationOptions[1].guidance, /full Host GitHub access/i);
    await assert.rejects(readFile(ghInvokedPath, "utf8"), { code: "ENOENT" });

    const enabled = await transport.requestHostOperation({
      type: "github.credentials.host.configure",
      requestId: "enable-host-path-session",
      action: "enable",
      riskAcknowledgement: HOST_GH_SESSION_RISK_ACKNOWLEDGEMENT,
      authorizationClass: "host_local_github_credentials",
      idempotencyKey: "enable-host-path-session",
      expectedRevision: 0,
    });
    assert.equal(enabled.type, "github.credentials.configure.result");

    const launched = await transport.requestHostOperation({
      type: "harness.run.launch",
      ...productionLaunchRequest(fixture.project.project.projectId, {
        requestId: "launch-with-host-path-session",
        parameters: { issueNumber: 261, verifyGitHubAccess: true },
        idempotencyKeyHash: `sha256:${"a".repeat(64)}`,
      }),
    });
    assert.equal(launched.type, "harness.run.launch.result", JSON.stringify(launched));
    assert.equal(await readFile(ghInvokedPath, "utf8"), "invoked\n");
  } finally {
    await transport?.stopHost().catch(() => undefined);
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalGitHubConfigDirectory === undefined) delete process.env.GH_CONFIG_DIR;
    else process.env.GH_CONFIG_DIR = originalGitHubConfigDirectory;
    await rm(root, { recursive: true, force: true });
  }
});

test("the native Windows Host resolver reads gh's default AppData session", {
  skip: process.platform === "win32"
    ? false
    : "requires the native Windows GitHub CLI configuration path",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-windows-host-gh-config-"));
  const originalAppData = process.env.APPDATA;
  const originalGitHubConfigDirectory = process.env.GH_CONFIG_DIR;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  try {
    const appDataDirectory = join(root, "Roaming");
    const githubConfigDirectory = join(appDataDirectory, "GitHub CLI");
    await mkdir(githubConfigDirectory, { recursive: true });
    await writeFile(join(githubConfigDirectory, "hosts.yml"), `github.com:
    git_protocol: https
    users:
        sandking-fixture:
            oauth_token: ${hostToken}
    user: sandking-fixture
`);
    process.env.APPDATA = appDataDirectory;
    delete process.env.GH_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;

    const fixture = await createProductionRegistration(root);
    const credentials = await createGitHubCredentialManager({
      dataDir: fixture.dataDir,
      recordAudit: fixture.recordAudit,
    });
    const enabled = await credentials.configureHost({
      requestId: "enable-native-windows-host-session",
      action: "enable",
      riskAcknowledgement: HOST_GH_SESSION_RISK_ACKNOWLEDGEMENT,
      authorizationClass: "host_local_github_credentials",
      idempotencyKey: "enable-native-windows-host-session",
      expectedRevision: 0,
    });
    assert.equal(enabled.type, "github.credentials.configure.result");
    assert.deepEqual(
      await credentials.resolveForProject(fixture.project.project.projectId),
      { mode: "host-gh-session", token: hostToken },
    );
  } finally {
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    if (originalGitHubConfigDirectory === undefined) delete process.env.GH_CONFIG_DIR;
    else process.env.GH_CONFIG_DIR = originalGitHubConfigDirectory;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("both credential modes and Project-PAT precedence authenticate through the real Host and Docker boundary without disclosure", {
  skip: process.env.SANDKING_REAL_GITHUB_CREDENTIAL_QUALIFICATION === "1"
    && process.platform !== "win32"
    ? false
    : "requires the explicit real GitHub credential qualification gate on a POSIX Docker Host",
  timeout: 5 * 60_000,
}, async (t) => {
  const cleanHostEnvironment = createDestinationWorkerEnvironment();
  const [{ stdout: projectTokenOutput }, { stdout: hostTokenOutput }] = await Promise.all([
    execFileAsync("gh", ["auth", "token", "--hostname", "github.com"], {
      env: process.env,
      timeout: 10_000,
      maxBuffer: 16_384,
    }),
    execFileAsync("gh", ["auth", "token", "--hostname", "github.com"], {
      env: cleanHostEnvironment,
      timeout: 10_000,
      maxBuffer: 16_384,
    }),
    execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], {
      env: cleanHostEnvironment,
      timeout: 10_000,
    }),
    execFileAsync("codex", ["login", "status"], {
      env: cleanHostEnvironment,
      timeout: 10_000,
    }),
  ]);
  const realTokens = {
    "project-pat": projectTokenOutput.trim(),
    "host-gh-session": hostTokenOutput.trim(),
    "project-pat-precedence": projectTokenOutput.trim(),
  };

  for (const [index, mode] of [
    "project-pat",
    "host-gh-session",
    "project-pat-precedence",
  ].entries()) {
    await t.test(mode, async () => {
      const root = await mkdtemp(join(tmpdir(), `sandking-real-github-${mode}-`));
      const token = realTokens[mode];
      const runtimeMarker = ["8", "9", "a"][index];
      const controllerMarker = ["3", "4", "5"][index];
      const hostFallbackInvokedPath = join(root, "host-fallback-invoked");
      const originalPath = process.env.PATH;
      const existingContainers = new Set((await execFileAsync("docker", [
        "ps", "--filter", "ancestor=sandcastle:sandking-real-worker", "--format", "{{.ID}}",
      ], { env: cleanHostEnvironment })).stdout.trim().split("\n").filter(Boolean));
      let transport;
      let observedContainerId = null;
      try {
        if (mode === "project-pat-precedence") {
          const binPath = join(root, "bin");
          await mkdir(binPath);
          await writeExecutable(join(binPath, "gh"), `#!/bin/sh
set -eu
if [ "$1 $2 $3 $4" = "auth token --hostname github.com" ]; then
  printf '%s\n' 'invoked' > '${hostFallbackInvokedPath}'
  printf '%s\n' 'gho_deliberately_unusable_host_fallback_261'
  exit 0
fi
exit 94
`);
          process.env.PATH = `${binPath}${delimiter}${originalPath ?? ""}`;
        }
        const fixture = await createProductionRegistration(root);
        const hostId = `host-${runtimeMarker.repeat(24)}`;
        const runtime = createTransportRuntime({
          dataDir: fixture.dataDir,
          hostId,
          recordAudit: fixture.recordAudit,
          startupId: `real-github-${mode}`,
        });
        transport = createLocalHostTransport(runtime);
        await transport.launchHost(`runtime-${runtimeMarker.repeat(24)}`);

        const configured = mode === "project-pat"
          ? await transport.requestHostOperation({
              type: "github.credentials.project.configure",
              requestId: `configure-real-${mode}`,
              projectId: fixture.project.project.projectId,
              action: "set",
              personalAccessToken: token,
              authorizationClass: "host_local_github_credentials",
              idempotencyKey: `configure-real-${mode}`,
              expectedRevision: 0,
            })
          : await transport.requestHostOperation({
              type: "github.credentials.host.configure",
              requestId: `configure-real-${mode}`,
              action: "enable",
              riskAcknowledgement: HOST_GH_SESSION_RISK_ACKNOWLEDGEMENT,
              authorizationClass: "host_local_github_credentials",
              idempotencyKey: `configure-real-${mode}`,
              expectedRevision: 0,
            });
        assert.equal(configured.type, "github.credentials.configure.result");
        if (mode === "project-pat-precedence") {
          const configuredProjectPat = await transport.requestHostOperation({
            type: "github.credentials.project.configure",
            requestId: "configure-real-project-pat-precedence",
            projectId: fixture.project.project.projectId,
            action: "set",
            personalAccessToken: token,
            authorizationClass: "host_local_github_credentials",
            idempotencyKey: "configure-real-project-pat-precedence",
            expectedRevision: 1,
          });
          assert.equal(
            configuredProjectPat.type,
            "github.credentials.configure.result",
          );
          assert.equal(configuredProjectPat.effectiveMode, "project-pat");
        }

        const controllerId = `runtime-${controllerMarker.repeat(24)}`;
        const controllerSessionId = `controller-session-${controllerMarker.repeat(24)}`;
        const launched = await transport.requestHostOperation({
          type: "harness.run.launch",
          ...productionLaunchRequest(fixture.project.project.projectId, {
            requestId: `launch-real-${mode}`,
            controllerId,
            controllerSessionId,
            parameters: { verifyGitHubAccess: true },
            idempotencyKeyHash: `sha256:${String(index + 6).repeat(64)}`,
          }),
        });
        assert.equal(launched.type, "harness.run.launch.result", JSON.stringify(launched));

        const authenticationDeadline = Date.now() + 60_000;
        let containerArguments = "";
        while (Date.now() < authenticationDeadline) {
          const containerIds = (await execFileAsync("docker", [
            "ps", "--filter", "ancestor=sandcastle:sandking-real-worker", "--format", "{{.ID}}",
          ], { env: cleanHostEnvironment })).stdout.trim().split("\n").filter(Boolean);
          observedContainerId = containerIds.find((id) => !existingContainers.has(id)) ?? null;
          if (observedContainerId) {
            containerArguments = (await execFileAsync("docker", [
              "top", observedContainerId, "-eo", "args",
            ], { env: cleanHostEnvironment }).catch(() => ({ stdout: "" }))).stdout;
            if (/\bcodex\b/.test(containerArguments)) break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.match(containerArguments, /\bcodex\b/,
          "the Codex process starts only after the real gh api authentication hook succeeds");
        const authenticatedLogin = (await execFileAsync("docker", [
          "exec", observedContainerId,
          "gh", "api", "user", "--hostname", "github.com", "--jq", ".login",
        ], {
          env: cleanHostEnvironment,
          timeout: 10_000,
          maxBuffer: 16_384,
        })).stdout.trim();
        assert.match(authenticatedLogin, /\S/,
          "the configured credential authenticates an explicit gh API command inside Docker");
        if (mode === "project-pat-precedence") {
          await assert.rejects(readFile(hostFallbackInvokedPath, "utf8"), { code: "ENOENT" });
        }

        const [hostArguments, containerEnvironment] = await Promise.all([
          execFileAsync("ps", ["-ww", "-axo", "command="], {
            env: cleanHostEnvironment,
            maxBuffer: 2 * 1024 * 1024,
          }).then(({ stdout }) => stdout),
          execFileAsync("docker", [
            "inspect", observedContainerId, "--format", "{{json .Config.Env}}",
          ], { env: cleanHostEnvironment }).then(({ stdout }) => stdout),
        ]);
        assert.equal(hostArguments.includes(token), false);
        assert.equal(containerArguments.includes(token), false);
        assert.equal(containerEnvironment.includes(token), false);

        const cancelled = await transport.requestHostOperation({
          type: "harness.run.cancel",
          requestId: `cancel-real-${mode}`,
          harnessRunId: launched.run.harnessRunId,
          controllerId,
          controllerSessionId,
          source: "controller-cli",
          authorizationClass: "harness_run_cancellation",
          idempotencyKeyHash: `sha256:${String(index + 4).repeat(64)}`,
        });
        assert.equal(cancelled.type, "harness.run.cancel.result", JSON.stringify(cancelled));

        const terminalDeadline = Date.now() + 60_000;
        let observation;
        while (Date.now() < terminalDeadline) {
          observation = await transport.requestHostOperation({
            type: "harness.run.observe",
            requestId: `observe-real-${mode}`,
            harnessRunId: launched.run.harnessRunId,
            afterSequence: 0,
          });
          if (["succeeded", "failed", "cancelled"].includes(observation.run?.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(["succeeded", "failed", "cancelled"].includes(observation?.run?.status));

        const retained = [
          await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
          await readFile(join(fixture.dataDir, "audit.jsonl"), "utf8"),
          await readTreeText(join(
            fixture.dataDir,
            "harness-runs",
            launched.run.harnessRunId,
          )),
        ].join("\n");
        assert.equal(retained.includes(token), false);
        assert.equal(JSON.stringify(observation).includes(token), false);
        assert.equal((await readTreeText(fixture.projectPath)).includes(token), false);
      } finally {
        await transport?.stopHost().catch(() => undefined);
        if (observedContainerId) {
          await execFileAsync("docker", ["rm", "--force", observedContainerId], {
            env: cleanHostEnvironment,
          }).catch(() => undefined);
        }
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("the framed Host API configures a Project PAT without returning or auditing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-github-credential-host-api-"));
  let child;
  try {
    const fixture = await createProductionRegistration(root);
    const projectId = fixture.project.project.projectId;
    const hostId = `host-${"1".repeat(24)}`;
    child = spawn(process.execPath, [
      join(process.cwd(), "src", "local-host.mjs"),
      "--data-dir", fixture.dataDir,
      "--allow-host-identity-create",
    ], { stdio: ["pipe", "pipe", "pipe"], env: { LANG: "C.UTF-8" } });
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
    assert.equal((await readFrame(child.stdout)).type, "hello-ack");
    writeFrame(child.stdin, {
      type: "host.identity.accept",
      requestId: "accept-host-for-github-credentials",
      hostId,
      authorizationClass: "controller_host_identity_binding",
      idempotencyKey: "accept-host-for-github-credentials",
      expectedRevision: 0,
    });
    assert.equal((await readFrame(child.stdout)).type, "host.identity.result");

    writeFrame(child.stdin, {
      type: "github.credentials.project.configure",
      requestId: "configure-host-api-project-pat",
      projectId,
      action: "set",
      personalAccessToken: projectToken,
      authorizationClass: "host_local_github_credentials",
      idempotencyKey: "configure-host-api-project-pat",
      expectedRevision: 0,
    });
    const configured = await readFrame(child.stdout);
    assert.equal(configured.type, "github.credentials.configure.result");
    assert.equal(configured.projectPat, "configured");
    assert.doesNotMatch(JSON.stringify(configured), /secret_261/);

    writeFrame(child.stdin, {
      type: "github.credentials.host.configure",
      requestId: "enable-host-api-gh-session",
      action: "enable",
      riskAcknowledgement: HOST_GH_SESSION_RISK_ACKNOWLEDGEMENT,
      authorizationClass: "host_local_github_credentials",
      idempotencyKey: "enable-host-api-gh-session",
      expectedRevision: 1,
    });
    const enabled = await readFrame(child.stdout);
    assert.equal(enabled.type, "github.credentials.configure.result");
    assert.equal(enabled.code, "github_credentials_configured");
    assert.equal(enabled.hostGhSessionReuse, "enabled");
    assert.equal(enabled.effectiveMode, null);

    writeFrame(child.stdin, {
      type: "github.credentials.inspect",
      requestId: "inspect-host-api-project-pat",
      projectId,
    });
    const inspected = await readFrame(child.stdout);
    assert.equal(inspected.effectiveMode, "project-pat");
    assert.doesNotMatch(JSON.stringify(inspected), /secret_261/);

    writeFrame(child.stdin, {
      type: "github.credentials.project.configure",
      requestId: "clear-host-api-project-pat",
      projectId,
      action: "clear",
      authorizationClass: "host_local_github_credentials",
      idempotencyKey: "clear-host-api-project-pat",
      expectedRevision: 2,
    });
    const cleared = await readFrame(child.stdout);
    assert.equal(cleared.projectPat, "not-configured");
    assert.equal(cleared.effectiveMode, "host-gh-session");

    writeFrame(child.stdin, {
      type: "github.credentials.host.configure",
      requestId: "disable-host-api-gh-session",
      action: "disable",
      authorizationClass: "host_local_github_credentials",
      idempotencyKey: "disable-host-api-gh-session",
      expectedRevision: 3,
    });
    const disabled = await readFrame(child.stdout);
    assert.equal(disabled.hostGhSessionReuse, "disabled");
    assert.doesNotMatch(await readFile(join(fixture.dataDir, "audit.jsonl"), "utf8"),
      /secret_261/);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
});
