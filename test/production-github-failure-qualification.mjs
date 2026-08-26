import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createProductionRegistration,
  createProductionFixture,
  installReadyProbeCommands,
  observeProductionTerminal,
  productionLaunchRequest,
  readBundledIssueClaimActions,
  readBundledMainState,
  setBundledMainScenario,
} from "./production-sandcastle-host-fixture.mjs";
import { installCurrentPackage } from "./installed-package.mjs";
import {
  installedProductionLaunchEnvironment,
  startInstalledProductionHost,
} from "./installed-production-host.mjs";

const execFileAsync = promisify(execFile);
const readJson = (path) => readFile(path, "utf8").then(JSON.parse);

const waitFor = async (read, predicate, code, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value !== null && predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(code);
};

const installedLaunch = async ({ endpoint, installed, registration, retryDirectory }) => {
  const { stdout } = await execFileAsync(installed.command, [
    "launch",
    registration.project.project.projectId,
    "--issue", "173",
    "--json",
  ], {
    cwd: registration.projectPath,
    env: installedProductionLaunchEnvironment({
      endpoint,
      projectId: registration.project.project.projectId,
      retryDirectory,
      userHome: join(retryDirectory, "home"),
    }),
  });
  return JSON.parse(stdout);
};

test("a real Host process loss recovers its issue claim and existing pull request", {
  skip: process.platform !== "linux"
    ? "the real Host-loss qualification requires Linux process supervision"
    : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-host-loss-"));
  const endpoint = join(root, "controller.sock");
  const firstRetryDirectory = join(root, "first-controller-private");
  const secondRetryDirectory = join(root, "second-controller-private");
  let host;
  let restorePath = () => undefined;
  try {
    const installed = await installCurrentPackage(root);
    restorePath = await installReadyProbeCommands(root, {
      mainScenario: "pause-first-review",
    });
    const registration = await createProductionRegistration(root);
    await Promise.all([
      mkdir(join(firstRetryDirectory, "home"), { recursive: true }),
      mkdir(join(secondRetryDirectory, "home"), { recursive: true }),
    ]);
    host = await startInstalledProductionHost({
      endpoint,
      installed,
      nodePath: process.execPath,
      registration,
    });
    const hostCommandLine = (await readFile(`/proc/${host.pid}/cmdline`, "utf8"))
      .split("\0")
      .filter(Boolean);
    assert.equal(hostCommandLine.includes(join(
      installed.packageDirectory,
      "src",
      "local-host.mjs",
    )), true, JSON.stringify(hostCommandLine));
    assert.equal(hostCommandLine.includes("--eval"), false, JSON.stringify(hostCommandLine));
    const crashed = await installedLaunch({
      endpoint,
      installed,
      registration,
      retryDirectory: firstRetryDirectory,
    });
    assert.equal(crashed.type, "harness.run.launch.result", JSON.stringify(crashed));
    await waitFor(
      () => readBundledMainState(root),
      (state) => state.reviewStarted === true && state.pullRequests.length === 1,
      "host_loss_review_start_timeout",
    );
    await host.kill();
    host = undefined;
    await rm(endpoint, { force: true });

    const crashedState = await readBundledMainState(root);
    assert.equal(crashedState.issues[173].state, "open");
    assert.equal(crashedState.pullRequests.length, 1);
    assert.deepEqual(readBundledIssueClaimActions(crashedState, 173), ["claim"]);

    await setBundledMainScenario(root, "success");
    host = await startInstalledProductionHost({
      endpoint,
      installed,
      nodePath: process.execPath,
      registration,
    });
    const reconciled = await waitFor(
      () => readJson(join(registration.dataDir, "harness-runs.json")),
      (state) => state.runs[0]?.outcome?.code === "host_daemon_interrupted",
      "host_loss_reconciliation_timeout",
    );
    assert.equal(reconciled.runs[0].harnessRunId, crashed.run.harnessRunId);
    assert.equal(reconciled.runs[0].status, "failed");

    const resumed = await installedLaunch({
      endpoint,
      installed,
      registration,
      retryDirectory: secondRetryDirectory,
    });
    assert.equal(resumed.type, "harness.run.launch.result", JSON.stringify(resumed));
    const retained = await waitFor(
      () => readJson(join(registration.dataDir, "harness-runs.json")),
      (state) => state.runs.find(({ harnessRunId }) =>
        harnessRunId === resumed.run.harnessRunId)?.status === "succeeded",
      "host_loss_recovery_timeout",
    );
    const recovered = retained.runs.find(({ harnessRunId }) =>
      harnessRunId === resumed.run.harnessRunId);
    assert.equal(recovered.outcome.result.code, "issue_delivery_completed");
    const recoveredState = await readBundledMainState(root);
    assert.equal(recoveredState.issues[173].state, "closed");
    assert.equal(recoveredState.pullRequests.length, 1);
    assert.equal(recoveredState.pullRequests[0].state, "MERGED");
    assert.deepEqual(readBundledIssueClaimActions(recoveredState, 173), [
      "claim",
      "override",
      "claim",
      "release",
    ]);
    assert.match((await execFileAsync("git", [
      "-C", registration.projectPath,
      "show", "main:issue-173-delivered.txt",
    ])).stdout, /^implemented issue 173 /);
  } finally {
    await host?.stop().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

test("the Host excludes overlapping same-issue runs without blocking other issues", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-claim-race-"));
  let fixture;
  let restorePath = () => undefined;
  try {
    restorePath = await installReadyProbeCommands(root, {
      mainScenario: "pause-first-review",
    });
    fixture = await createProductionFixture(root);
    const first = await fixture.manager.launch(productionLaunchRequest(
      fixture.project.project.projectId,
      { requestId: "launch-first-claim-holder" },
    ));
    await waitFor(
      () => readBundledMainState(root),
      (state) => state.reviewStarted === true,
      "first_claim_holder_timeout",
    );

    const second = await fixture.manager.launch(productionLaunchRequest(
      fixture.project.project.projectId,
      {
        requestId: "launch-overlapping-claim-contender",
        idempotencyKeyHash: `sha256:${"9".repeat(64)}`,
      },
    ));
    assert.equal(second.type, "harness.run.launch.failure", JSON.stringify(second));
    assert.equal(second.code, "harness_issue_run_active");
    assert.equal(second.retryable, true);
    assert.deepEqual(second.prohibitedSideEffects, {
      harnessRunCreated: false,
      adapterStarted: false,
      projectWrite: false,
    });
    const state = await readBundledMainState(root);
    assert.equal(state.pullRequests.length, 1);
    assert.deepEqual(readBundledIssueClaimActions(state, 173), ["claim"]);
    const retained = await readJson(join(fixture.dataDir, "harness-runs.json"));
    assert.deepEqual(retained.runs.map(({ harnessRunId }) => harnessRunId), [
      first.run.harnessRunId,
    ]);

    const independent = await fixture.manager.launch(productionLaunchRequest(
      fixture.project.project.projectId,
      {
        requestId: "launch-independent-issue",
        parameters: { issueNumber: 174 },
        idempotencyKeyHash: `sha256:${"8".repeat(64)}`,
      },
    ));
    assert.equal(independent.type, "harness.run.launch.result", JSON.stringify(independent));
    const independentTerminal = await waitFor(
      () => fixture.manager.observe({
        requestId: "observe-independent-issue",
        harnessRunId: independent.run.harnessRunId,
        afterSequence: 0,
      }),
      (observation) => observation.run.status === "succeeded",
      "independent_issue_delivery_timeout",
    );
    assert.equal(independentTerminal.run.status, "succeeded");
    const independentState = await readBundledMainState(root);
    assert.equal(independentState.issues[174].state, "closed");
    assert.deepEqual(readBundledIssueClaimActions(independentState, 174), [
      "claim",
      "release",
    ]);
  } finally {
    await setBundledMainScenario(root, "success").catch(() => undefined);
    await fixture?.manager.waitForIdle().catch(() => undefined);
    restorePath();
    await rm(root, { recursive: true, force: true });
  }
});

for (const [scenario, expectedCode] of [
  ["credential-expired", "github_credential_expired"],
  ["rate-limited", "github_rate_limited"],
]) {
  test(`${scenario} GitHub access fails truthfully and recovers without a duplicate claim`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), `sandking-production-${scenario}-`));
      let fixture;
      let restorePath = () => undefined;
      try {
        restorePath = await installReadyProbeCommands(root, { mainScenario: scenario });
        fixture = await createProductionFixture(root);
        const failed = await fixture.manager.launch(productionLaunchRequest(
          fixture.project.project.projectId,
          { requestId: `launch-${scenario}` },
        ));
        assert.equal(failed.type, "harness.run.launch.result", JSON.stringify(failed));
        const terminal = await observeProductionTerminal(
          fixture.manager,
          failed.run.harnessRunId,
          30_000,
        );
        assert.equal(terminal.run.status, "failed", JSON.stringify(terminal));
        assert.equal(terminal.outcome.result.code, expectedCode);
        const failedState = await readBundledMainState(root);
        assert.equal(failedState.issues[173].state, "open");
        assert.equal(failedState.pullRequests.length, 0);
        assert.deepEqual(readBundledIssueClaimActions(failedState, 173), ["claim"]);

        await setBundledMainScenario(root, "success");
        const resumed = await fixture.manager.launch(productionLaunchRequest(
          fixture.project.project.projectId,
          {
            requestId: `resume-${scenario}`,
            idempotencyKeyHash: `sha256:${scenario === "credential-expired"
              ? "a".repeat(64)
              : "b".repeat(64)}`,
          },
        ));
        const recovered = await observeProductionTerminal(
          fixture.manager,
          resumed.run.harnessRunId,
          30_000,
        );
        assert.equal(recovered.run.status, "succeeded", JSON.stringify(recovered));
        const recoveredState = await readBundledMainState(root);
        assert.equal(recoveredState.issues[173].state, "closed");
        assert.equal(recoveredState.pullRequests.length, 1);
        assert.deepEqual(readBundledIssueClaimActions(recoveredState, 173), [
          "claim",
          "override",
          "claim",
          "release",
        ]);
        const retained = JSON.stringify({
          audits: fixture.audits,
          failed: terminal,
          recovered,
        });
        assert.doesNotMatch(retained, /github_pat_production_fixture_delivery/);
        assert.doesNotMatch(retained, /Bad credentials|API rate limit exceeded/);
      } finally {
        await fixture?.manager.waitForIdle().catch(() => undefined);
        restorePath();
        await rm(root, { recursive: true, force: true });
      }
    });
}
