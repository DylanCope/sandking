import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createHarnessRunFixture } from "./harness-run-fixture.mjs";
import { waitForTestCheckpoint } from "./test-checkpoint.mjs";

const hostId = `host-${"1".repeat(24)}`;
const controllerId = `runtime-${"2".repeat(24)}`;
const controllerSessionId = `controller-session-${"3".repeat(24)}`;
const linuxProcessTreeHelper = fileURLToPath(new URL(
  `../src/native/linux-${process.arch}/posix-process-tree-helper`,
  import.meta.url,
));

const launchRequest = (projectId, issueNumber) => ({
  requestId: `launch-${issueNumber}`,
  projectId,
  parameters: {
    issueNumber,
    targetBranch: `sandcastle/issue-${issueNumber}`,
  },
  controllerId,
  controllerSessionId,
  source: "controller-cli",
  authorizationClass: "harness_run_launch",
  idempotencyKey: `launch-${issueNumber}`,
});

const cancellationRequest = (harnessRunId) => ({
  requestId: "cancel-harness-run",
  harnessRunId,
  controllerId,
  controllerSessionId,
  source: "controller-cli",
  authorizationClass: "harness_run_cancellation",
  idempotencyKey: "cancel-harness-run-once",
});

const schedulerStarvationControllerSource = String.raw`
  import { readFile, readlink } from "node:fs/promises";

  const [hostPidText, helperPath] = process.argv.slice(1);
  const hostPid = Number(hostPidText);
  const deadline = Date.now() + 10_000;
  const childrenPath = "/proc/" + hostPid + "/task/" + hostPid + "/children";
  const resumeHost = () => {
    try {
      process.kill(hostPid, "SIGCONT");
    } catch {
      // The Host already exited.
    }
  };
  process.once("exit", resumeHost);
  process.once("SIGTERM", () => process.exit(143));
  process.once("SIGINT", () => process.exit(130));
  process.send?.("armed");
  while (Date.now() < deadline) {
    let childPids = [];
    try {
      childPids = (await readFile(childrenPath, "utf8"))
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    } catch {
      process.exit(1);
    }
    for (const childPid of childPids) {
      try {
        const executable = await readlink("/proc/" + childPid + "/exe");
        const argv = (await readFile("/proc/" + childPid + "/cmdline", "utf8"))
          .split("\0");
        if (
          executable !== helperPath
          || argv[1] !== "subreaper"
        ) continue;
        process.kill(hostPid, "SIGSTOP");
        process.send?.("supervision-starved");
        // Keep only the Host-side test process starved. The shipped native
        // guardian, supervisor, and short-lived Harness adapter continue for
        // longer than the pending cancellation timer, deterministically
        // widening the scheduling race diagnosed on two CPUs.
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        process.kill(hostPid, "SIGCONT");
        process.exit(0);
      } catch {
        // A different direct child exited while procfs was being inspected.
      }
    }
    // Supervision has not started yet, so leave the Host runnable. Reading its
    // direct-child list avoids a load-sensitive system-wide procfs walk while
    // still observing the packaged helper before its adapter can complete.
    await new Promise((resolve) => setImmediate(resolve));
  }
  process.exit(1);
`;

const startSchedulerStarvation = async () => {
  const controller = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    schedulerStarvationControllerSource,
    String(process.pid),
    linuxProcessTreeHelper,
  ], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const completion = once(controller, "exit");
  await waitForTestCheckpoint(
    once(controller, "message"),
    "scheduler_starvation_controller_not_armed",
    10_000,
  );
  return { controller, completion };
};

test("a source-created Linux termination-confirmation stall fails boundedly", async () => {
  const fixture = await createHarnessRunFixture(
    "sandking-source-stalled-confirmation-",
    hostId,
    { cancellationGraceMs: 50 },
  );
  let schedulerStarvation;
  try {
    schedulerStarvation = await startSchedulerStarvation();
    const supervisionStarved = once(schedulerStarvation.controller, "message");
    let reportLaunched;
    const launchedRun = new Promise((resolve) => {
      reportLaunched = resolve;
    });
    const cancellation = new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          const launched = await launchedRun;
          resolve(await fixture.manager.cancel(cancellationRequest(
            launched.run.harnessRunId,
          )));
        } catch (error) {
          reject(error);
        }
        // The controller holds the Host for six seconds after shipped Linux
        // supervision starts, so this remains pending until the adapter exits.
      }, 5_000);
    });
    const launched = await fixture.manager.launch(launchRequest(
      fixture.registered.project.projectId,
      216,
    ));
    reportLaunched(launched);
    await waitForTestCheckpoint(
      supervisionStarved,
      "harness_supervision_not_starved_by_scheduler_controller",
      10_000,
    );
    const accepted = await cancellation;
    assert.equal(accepted.code, "harness_run_cancellation_accepted");
    const [starvationExitCode] = await waitForTestCheckpoint(
      schedulerStarvation.completion,
      "scheduler_starvation_not_completed",
      10_000,
    );
    assert.equal(starvationExitCode, 0);
    await waitForTestCheckpoint(
      fixture.manager.waitForIdle(),
      "source_created_confirmation_stall_not_quiescent",
      10_000,
    );

    const stalled = await fixture.manager.observe({
      requestId: "observe-source-created-confirmation-stall",
      harnessRunId: launched.run.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(stalled.run.status, "cancelling");
    assert.match(stalled.run.cancellation.forcedTerminationSentAt, /^20[0-9]{2}-/);
    assert.equal(stalled.run.cancellation.terminationConfirmedAt, null);
    // This checkpoint observes the missing public terminal transition. It is
    // not withheld by a test hook: supervision itself declined to confirm an
    // empty tree after the Host process was starved while the adapter exited.
    const terminalOutcome = ["succeeded", "failed", "cancelled"]
      .includes(stalled.run.status)
      ? Promise.resolve(stalled)
      : new Promise(() => undefined);
    await waitForTestCheckpoint(
      terminalOutcome,
      "cancellation_terminal_outcome_not_reached",
      25,
    );
  } finally {
    if (schedulerStarvation?.controller.exitCode === null) {
      schedulerStarvation.controller.kill("SIGKILL");
    }
    await fixture.manager.waitForIdle();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a later Harness-run test still reaches its terminal outcome", async () => {
  const fixture = await createHarnessRunFixture(
    "sandking-after-stalled-confirmation-",
    hostId,
  );
  try {
    const launched = await fixture.manager.launch(launchRequest(
      fixture.registered.project.projectId,
      216,
    ));
    // launch() schedules supervision for the next event-loop turn.
    await new Promise((resolve) => setImmediate(resolve));
    await waitForTestCheckpoint(
      fixture.manager.waitForIdle(),
      "later_harness_run_not_quiescent",
      60_000,
    );
    const observation = await fixture.manager.observe({
      requestId: "observe-after-stalled-confirmation",
      harnessRunId: launched.run.harnessRunId,
      afterSequence: 0,
    });
    assert.equal(observation.run.status, "succeeded");
    assert.equal(observation.outcome.code, "conformance_run_succeeded");
  } finally {
    await fixture.manager.waitForIdle();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
