import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GitHubCredentialUnavailableError,
  HOST_GH_SESSION_RISK_ACKNOWLEDGEMENT,
  createGitHubCredentialManager,
} from "../src/github-credentials.mjs";
import { createHarnessRunManager } from "../src/harness-runs.mjs";
import {
  createProductionRegistration,
  execFileAsync,
  productionLaunchRequest,
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

const projectToken = "github_pat_project_specific_secret_261";
const hostToken = "gho_host_session_secret_261";

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

    assert.deepEqual(await manager.resolveForProject(projectId, { required: true }), {
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
    assert.deepEqual(await manager.resolveForProject(projectId, { required: true }), {
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
    await assert.rejects(
      manager.resolveForProject(projectId, { required: true }),
      (error) => {
        assert.ok(error instanceof GitHubCredentialUnavailableError);
        assert.equal(error.code, "github_credential_unconfigured");
        assert.doesNotMatch(JSON.stringify(error), /secret_261/);
        assert.match(error.message, /Project PAT/);
        assert.match(error.message, /Host.*gh CLI session/);
        return true;
      },
    );

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

test("a GitHub-dependent launch fails with typed sanitized guidance for both configuration paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-github-credential-launch-"));
  try {
    const fixture = await createProductionRegistration(root);
    const credentials = await createGitHubCredentialManager({
      dataDir: fixture.dataDir,
      recordAudit: fixture.recordAudit,
      readHostGhToken: async () => {
        throw new Error(hostToken);
      },
    });
    const manager = await createHarnessRunManager({
      dataDir: fixture.dataDir,
      hostId: `host-${"1".repeat(24)}`,
      recordAudit: fixture.recordAudit,
      loadLaunchContext: fixture.registry.loadLaunchContext,
      resolveGitHubCredential: (projectId) =>
        credentials.resolveForProject(projectId, { required: true }),
    });
    const projectId = fixture.project.project.projectId;

    const unconfigured = await manager.launch(productionLaunchRequest(projectId));
    assert.equal(unconfigured.type, "harness.run.launch.failure");
    assert.equal(unconfigured.code, "github_credential_unconfigured");
    assert.deepEqual(unconfigured.configurationOptions.map(({ mode }) => mode), [
      "project-pat",
      "host-gh-session",
    ]);
    assert.match(unconfigured.configurationOptions[0].guidance, /fine-grained/i);
    assert.match(unconfigured.configurationOptions[1].guidance, /full.*Host/i);

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
      idempotencyKeyHash: `sha256:${"5".repeat(64)}`,
    }));
    assert.equal(unavailable.type, "harness.run.launch.failure");
    assert.equal(unavailable.code, "github_host_gh_session_unavailable");
    assert.match(unavailable.configurationOptions[0].guidance, /Project PAT/i);
    assert.match(unavailable.configurationOptions[1].guidance, /gh auth login/i);

    const retained = [
      await readFile(join(fixture.dataDir, "harness-runs.json"), "utf8"),
      JSON.stringify(fixture.audits),
    ].join("\n");
    assert.doesNotMatch(retained, /host_session_secret_261/);
    assert.equal((await execFileAsync("git", [
      "-C", fixture.projectPath, "status", "--porcelain=v1", "--untracked-files=all",
    ])).stdout, "");
  } finally {
    await rm(root, { recursive: true, force: true });
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
