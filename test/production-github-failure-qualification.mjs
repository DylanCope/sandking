import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createProductionFixture,
  installReadyProbeCommands,
  observeProductionTerminal,
  productionLaunchRequest,
  readBundledIssueClaimActions,
  readBundledMainState,
  setBundledMainScenario,
} from "./production-sandcastle-host-fixture.mjs";

test("a crashed bundled main resumes its Host claim and existing pull request", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-main-crash-"));
  let fixture;
  let restorePath = () => undefined;
  try {
    restorePath = await installReadyProbeCommands(root, {
      mainScenario: "crash-after-pull-request",
    });
    fixture = await createProductionFixture(root);
    const crashed = await fixture.manager.launch(productionLaunchRequest(
      fixture.project.project.projectId,
      { requestId: "launch-crashing-main" },
    ));
    assert.equal(crashed.type, "harness.run.launch.result", JSON.stringify(crashed));
    const interrupted = await observeProductionTerminal(
      fixture.manager,
      crashed.run.harnessRunId,
      30_000,
    );
    assert.equal(interrupted.run.status, "failed", JSON.stringify(interrupted));
    assert.equal(interrupted.outcome.result.code, "real_delegation_interrupted");
    const crashedState = await readBundledMainState(root);
    assert.equal(crashedState.issues[173].state, "open");
    assert.equal(crashedState.pullRequests.length, 1);
    assert.deepEqual(readBundledIssueClaimActions(crashedState, 173), ["claim"]);

    await setBundledMainScenario(root, "success");
    const resumed = await fixture.manager.launch(productionLaunchRequest(
      fixture.project.project.projectId,
      {
        requestId: "resume-crashed-main",
        idempotencyKeyHash: `sha256:${"9".repeat(64)}`,
      },
    ));
    assert.equal(resumed.type, "harness.run.launch.result", JSON.stringify(resumed));
    const recovered = await observeProductionTerminal(
      fixture.manager,
      resumed.run.harnessRunId,
      30_000,
    );
    assert.equal(recovered.run.status, "succeeded", JSON.stringify(recovered));
    assert.equal(recovered.outcome.result.code, "issue_delivery_completed");
    const recoveredState = await readBundledMainState(root);
    assert.equal(recoveredState.issues[173].state, "closed");
    assert.equal(recoveredState.pullRequests.length, 1);
    assert.equal(recoveredState.pullRequests[0].state, "MERGED");
    assert.deepEqual(readBundledIssueClaimActions(recoveredState, 173), [
      "claim",
      "claim",
      "release",
    ]);
  } finally {
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
