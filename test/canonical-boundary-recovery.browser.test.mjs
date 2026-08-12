import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { launchBrowser } from "./browser-launch.mjs";
import {
  installCurrentPackage,
  pauseInstalledHostOnceAtHarnessRunFault,
} from "./installed-package.mjs";

const execFileAsync = promisify(execFile);
const manifest = JSON.parse(await readFile(
  new URL("../acceptance/issue-164.manifest.json", import.meta.url),
  "utf8",
));
const declarations = manifest.verification.faultMatrix.flatMap((boundary) =>
  boundary.faultPoints.map((faultPoint) => ({
    boundary: boundary.boundary,
    faultPoint,
  })));
const selectedDeclarations = process.env.SANDKING_TEST_FAULT_POINT
  ? declarations.filter(({ faultPoint }) =>
      faultPoint === process.env.SANDKING_TEST_FAULT_POINT)
  : declarations;
const packagedPublicSeam =
  "loopback Cockpit -> authenticated WebSocket -> Controller runtime -> framed local Host";
const resultFileName = "canonical-boundary-results.json";

const readJson = (path) => readFile(path, "utf8").then(JSON.parse);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForFile = async (path, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await access(path).then(() => true, () => false)) return;
    await wait(20);
  }
  throw new Error(`file_wait_timeout:${path}`);
};

const readProcesses = async () => {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,stat=,args="]);
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    return match ? [{
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      state: match[3],
      args: match[4],
    }] : [];
  });
};

const findHostPid = async (dataDir) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const processes = await readProcesses();
    const host = processes.find((entry) =>
      entry.args.includes("local-host.mjs")
      && entry.args.includes("--data-dir")
      && entry.args.includes(dataDir));
    if (host) return host.pid;
    await wait(20);
  }
  throw new Error(`local_host_process_not_found:${dataDir}`);
};

const descendantPids = (rootPid, processes) => {
  const retained = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of processes) {
      if (retained.has(entry.parentPid) && !retained.has(entry.pid)) {
        retained.add(entry.pid);
        changed = true;
      }
    }
  }
  retained.delete(rootPid);
  return [...retained];
};

const waitForProcessesToExit = async (pids) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const processes = new Map((await readProcesses()).map((entry) => [entry.pid, entry]));
    if (pids.every((pid) => {
      const entry = processes.get(pid);
      return !entry || /[XZ]/.test(entry.state[0]);
    })) return;
    await wait(20);
  }
  throw new Error(`supervised_process_exit_timeout:${pids.join(",")}`);
};

const launchRuntime = async (installed, dataDir, executionDirectory, environment, key) => {
  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--startup-timeout-ms", "60000",
      "--idempotency-key", key,
      "--json",
      "--no-open",
    ], {
      cwd: executionDirectory,
      env: environment,
      timeout: 90_000,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const diagnostics = {
      stdout: error && typeof error === "object" && "stdout" in error
        ? String(error.stdout) : "",
      stderr: error && typeof error === "object" && "stderr" in error
        ? String(error.stderr) : "",
      startup: await readJson(join(dataDir, "startup-error.json")).catch(() => null),
      runtime: await readFile(join(dataDir, "runtime-error.log"), "utf8").catch(() => ""),
      lifecycle: await readJson(join(dataDir, "runtime-lifecycle.json")).catch(() => null),
      harnessRuns: await readJson(join(dataDir, "harness-runs.json")).catch(() => null),
    };
    throw new Error(`packaged_runtime_launch_failed:${JSON.stringify(diagnostics)}`, {
      cause: error,
    });
  }
};

const stopRuntime = async (installed, dataDir, executionDirectory, environment) => {
  await execFileAsync(installed.command, ["stop", "--data-dir", dataDir, "--json"], {
    cwd: executionDirectory,
    env: environment,
    timeout: 30_000,
  }).catch(() => undefined);
};

const openCockpit = async (context, bootstrapUrl) => {
  const page = await context.newPage();
  const sentMessages = [];
  page.on("websocket", (websocket) => {
    websocket.on("framesent", (event) => {
      try {
        const message = JSON.parse(String(event.payload))?.message;
        if (message) sentMessages.push(message);
      } catch {
        // Binary diagnostic frames are not mutation controls.
      }
    });
  });
  await page.goto(bootstrapUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(
    "#connection-status[data-host-status='connected']",
    { timeout: 90_000 },
  );
  await page.waitForSelector("#harness-run-observation", { timeout: 90_000 });
  return { page, sentMessages };
};

const reopenWithCursorResynchronization = async (page) => {
  await page.evaluate(() => {
    sessionStorage.setItem("sandking.observationCursor", "host:issue-164-stale-cursor");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("html[data-observation-mode='resynchronize']", {
    timeout: 90_000,
  });
  await page.waitForSelector(
    "#connection-status[data-host-status='connected']",
    { timeout: 90_000 },
  );
};

const openPreparedProject = async (page, projectPath) => {
  await page.waitForSelector("#project-preparation[data-explicit-path-only='true']", {
    timeout: 90_000,
  });
  await page.locator("#project-path").fill(projectPath);
  await page.locator("#project-harness-adapter")
    .selectOption("conformance-harness-adapter-v1");
  await page.locator("#open-project").click();
  await page.waitForSelector("#open-project:not([disabled])", { timeout: 90_000 });
  if (await page.locator("#launch-harness").isDisabled()) {
    await page.locator("#open-project").click();
  }
  await page.waitForSelector("#launch-harness:not([disabled])", { timeout: 90_000 });
};

const launchHarness = async (page, issueNumber) => {
  await page.waitForSelector("#launch-harness:not([disabled])", { timeout: 90_000 });
  await page.locator("#harness-launch-parameter-issueNumber").fill(String(issueNumber));
  await page.locator("#harness-launch-parameter-targetBranch")
    .fill(`sandcastle/issue-${issueNumber}`);
  await page.locator("#launch-harness").click();
  await page.locator("#harness-launch-confirmation-yes").click();
};

const waitForRunStatus = async (page, status) => {
  await page.waitForSelector(
    `#harness-run-observation[data-run-status='${status}']`,
    { timeout: 90_000 },
  );
};

const mutationMessage = (messages, type) => {
  const matched = messages.findLast((message) => message.type === type);
  assert.ok(matched, `Cockpit did not send ${type}`);
  return matched;
};

const terminationEvidencePath = (dataDir, harnessRunId) => join(
  dataDir,
  "harness-runs",
  harnessRunId,
  "host-loss-termination.json",
);

const writeTerminationEvidence = async (dataDir, harnessRunId, status) => {
  const path = terminationEvidencePath(dataDir, harnessRunId);
  await mkdir(join(dataDir, "harness-runs", harnessRunId), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 2,
    platform: "linux",
    status,
    terminationScope: "complete_process_tree",
    launchSettled: true,
    treeEmpty: status === "termination_confirmed",
    observedAt: "2026-08-09T18:00:00.000Z",
  })}\n`, { mode: 0o600 });
};

const ensureConfirmedTerminationEvidence = async (dataDir, run) => {
  if (!run || run.outcome || !["starting", "running", "cancelling"].includes(run.status)) {
    return;
  }
  const path = terminationEvidencePath(dataDir, run.harnessRunId);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const evidence = await readJson(path).catch(() => null);
    if (evidence?.status === "termination_confirmed") return;
    await wait(20);
  }
  // The test has already proved the complete observed Host subtree empty. A
  // deterministic retained fact avoids turning a commit-boundary matrix into
  // another real-guardian timing test; the separate Host-death suite owns that.
  await writeTerminationEvidence(dataDir, run.harnessRunId, "termination_confirmed");
};

const expectedStatusAfterRestart = (faultPoint) => {
  if (faultPoint === "harness_run_launch.before_commit") return null;
  if (
    faultPoint === "harness_run_terminal_envelope.after_state_commit"
    || faultPoint === "harness_run_outcome.after_state_commit"
  ) return "succeeded";
  if (faultPoint.startsWith("harness_run_recovery.")) return "recovery_required";
  if (faultPoint.startsWith("harness_run_cancellation.")) {
    return faultPoint === "harness_run_cancellation.before_commit"
      ? "failed"
      : "cancelled";
  }
  return "failed";
};

const inspectCockpitTruth = async (page, dataDir, expectedStatus, snapshotBefore) => {
  const state = await readJson(join(dataDir, "harness-runs.json")).catch(() => ({
    schemaVersion: 8,
    runs: [],
  }));
  if (expectedStatus === null) {
    await page.waitForSelector(
      "#harness-run-observation[data-run-present='false'] #harness-run-empty",
      { timeout: 90_000 },
    );
    assert.equal(state.runs.length, 0);
    return {
      status: "absent",
      eventCount: 0,
      outcomeCode: null,
      observationMode: await page.locator("html").getAttribute("data-observation-mode"),
    };
  }

  await waitForRunStatus(page, expectedStatus);
  assert.equal(state.runs.length, 1);
  const run = state.runs[0];
  assert.equal(run.status, expectedStatus);
  const browserModel = await page.locator("#harness-run-observation").evaluate((section) => ({
    runId: section.dataset.runId,
    status: section.dataset.runStatus,
    harnessPin: section.dataset.harnessPin,
    events: [...section.querySelectorAll("#harness-run-events [data-event-type]")]
      .map((entry) => ({
        id: entry.dataset.eventId,
        sequence: Number(entry.dataset.eventSequence),
        type: entry.dataset.eventType,
      })),
    outcome: section.querySelector("#harness-run-structured-outcome")?.textContent
      === "Outcome pending"
      ? null
      : JSON.parse(section.querySelector("#harness-run-structured-outcome")?.textContent ?? "null"),
    snapshot: {
      hostId: section.querySelector("#harness-run-execution-snapshot")
        ?.querySelector("[data-execution-host-id]")?.dataset.executionHostId,
      projectId: section.querySelector("#harness-run-execution-snapshot")
        ?.querySelector("[data-execution-project-id]")?.dataset.executionProjectId,
      harnessId: section.querySelector("#harness-run-execution-snapshot")
        ?.querySelector("[data-execution-harness-id]")?.dataset.executionHarnessId,
      adapterId: section.querySelector("#harness-run-execution-snapshot")
        ?.dataset.adapterId,
      adapterProtocol: section.querySelector("#harness-run-execution-snapshot")
        ?.dataset.adapterProtocol,
    },
  }));
  assert.equal(browserModel.runId, run.harnessRunId);
  assert.equal(browserModel.status, run.status);
  assert.equal(browserModel.harnessPin, run.harnessPinnedRevision);
  assert.deepEqual(browserModel.events, run.events.map((event) => ({
    id: event.eventId,
    sequence: event.sequence,
    type: event.type,
  })));
  assert.deepEqual(
    run.events.map(({ sequence }) => sequence),
    run.events.map((_, index) => index + 1),
  );
  assert.equal(new Set(run.events.map(({ eventId }) => eventId)).size, run.events.length);
  assert.equal(run.events.filter((event) => [
    "harness_run_succeeded",
    "harness_run_failed",
    "harness_run_cancelled",
  ].includes(event.type)).length, run.outcome ? 1 : 0);
  assert.equal(browserModel.outcome?.outcomeId ?? null, run.outcome?.outcomeId ?? null);
  assert.equal(browserModel.outcome?.status ?? null, run.outcome?.status ?? null);
  assert.deepEqual(browserModel.snapshot, {
    hostId: run.executionSnapshot.hostId,
    projectId: run.executionSnapshot.projectRegistration.projectId,
    harnessId: run.executionSnapshot.harness.harnessId,
    adapterId: run.executionSnapshot.adapter.adapterId,
    adapterProtocol: run.executionSnapshot.adapter.protocol,
  });
  if (snapshotBefore) {
    assert.deepEqual(run.executionSnapshot, snapshotBefore);
  }
  assert.doesNotMatch(await page.locator("body").textContent(),
    /issue-164-packaged-secret|idempotencyKeyHash|sha256:[a-f0-9]{64}/i);
  return {
    status: run.status,
    eventCount: run.events.length,
    outcomeCode: run.outcome?.code ?? null,
    observationMode: await page.locator("html").getAttribute("data-observation-mode"),
  };
};

const retryPendingMutation = async (page, storageKey, pending, expectedStatus) => {
  await page.evaluate(({ key, value }) => {
    sessionStorage.setItem(key, JSON.stringify(value));
  }, { key: storageKey, value: pending });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction((key) => sessionStorage.getItem(key) === null, storageKey, {
    timeout: 90_000,
  });
  if (expectedStatus) await waitForRunStatus(page, expectedStatus);
};

const prepareProjectBaseline = async ({
  installed,
  context,
  dataDir,
  executionDirectory,
  environment,
  projectPath,
}) => {
  const launch = await launchRuntime(
    installed,
    dataDir,
    executionDirectory,
    environment,
    "issue-164-baseline-runtime",
  );
  const { page } = await openCockpit(context, launch.bootstrapUrl);
  await openPreparedProject(page, projectPath);
  await page.close();
  await stopRuntime(installed, dataDir, executionDirectory, environment);
};

const prepareTerminalSeed = async (options) => {
  const launch = await launchRuntime(
    options.installed,
    options.dataDir,
    options.executionDirectory,
    options.environment,
    "issue-164-terminal-seed-runtime",
  );
  const { page } = await openCockpit(options.context, launch.bootstrapUrl);
  await openPreparedProject(page, options.projectPath);
  await launchHarness(page, 164);
  await waitForRunStatus(page, "succeeded");
  await page.close();
  await stopRuntime(
    options.installed,
    options.dataDir,
    options.executionDirectory,
    options.environment,
  );
};

const prepareReconciliationSeed = async (options) => {
  const launch = await launchRuntime(
    options.installed,
    options.dataDir,
    options.executionDirectory,
    options.environment,
    "issue-164-reconciliation-seed-runtime",
  );
  const { page } = await openCockpit(options.context, launch.bootstrapUrl);
  await openPreparedProject(page, options.projectPath);
  await launchHarness(page, 999_999_993);
  await waitForRunStatus(page, "running");
  const state = await readJson(join(options.dataDir, "harness-runs.json"));
  const run = state.runs[0];
  const hostPid = await findHostPid(options.dataDir);
  const descendants = descendantPids(hostPid, await readProcesses());
  process.kill(hostPid, "SIGKILL");
  await waitForProcessesToExit(descendants);
  await ensureConfirmedTerminationEvidence(options.dataDir, run);
  await page.close();
  await stopRuntime(
    options.installed,
    options.dataDir,
    options.executionDirectory,
    options.environment,
  );
  return run.harnessRunId;
};

const prepareRecoverySeed = async (options) => {
  const state = await readJson(join(options.dataDir, "harness-runs.json"));
  const run = state.runs[0];
  await writeTerminationEvidence(
    options.dataDir,
    run.harnessRunId,
    "termination_unconfirmed",
  );
  const launch = await launchRuntime(
    options.installed,
    options.dataDir,
    options.executionDirectory,
    options.environment,
    "issue-164-recovery-seed-runtime",
  );
  const { page } = await openCockpit(options.context, launch.bootstrapUrl);
  await waitForRunStatus(page, "recovery_required");
  await page.close();
  await stopRuntime(
    options.installed,
    options.dataDir,
    options.executionDirectory,
    options.environment,
  );
};

const writeResults = async (results) => {
  const resultDirectory = process.env.SANDKING_ACCEPTANCE_RESULT_DIR;
  if (!resultDirectory) return;
  await mkdir(resultDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(resultDirectory, resultFileName),
    `${JSON.stringify({ schemaVersion: 2, issue: 164, results }, null, 2)}\n`,
    { mode: 0o600 },
  );
};

test("packaged Cockpit recovers every canonical boundary", {
  skip: process.platform !== "linux"
    ? "the deterministic installed-Host pause driver uses Linux process signals"
    : false,
  timeout: 20 * 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-canonical-boundary-cockpit-"));
  const executionDirectory = join(root, "outside-checkout");
  const userHome = join(root, "user-home");
  const projectPath = join(root, "selected-project");
  const baselineDir = join(root, "baseline-host-state");
  const terminalSeedDir = join(root, "terminal-seed-host-state");
  const reconciliationSeedDir = join(root, "reconciliation-seed-host-state");
  const recoverySeedDir = join(root, "recovery-seed-host-state");
  await Promise.all([
    mkdir(executionDirectory, { recursive: true }),
    mkdir(userHome, { recursive: true }),
    mkdir(baselineDir, { recursive: true }),
    execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]),
  ]);
  await writeFile(join(projectPath, "README.md"), "canonical boundary Project fixture\n");
  await execFileAsync("git", [
    "-C", projectPath,
    "-c", "user.name=Sand-King Acceptance",
    "-c", "user.email=sandking-acceptance@example.invalid",
    "add", "README.md",
  ]);
  await execFileAsync("git", [
    "-C", projectPath,
    "-c", "user.name=Sand-King Acceptance",
    "-c", "user.email=sandking-acceptance@example.invalid",
    "commit", "--quiet", "-m", "Canonical boundary fixture",
  ]);
  const projectDigest = createHash("sha256")
    .update(await readFile(join(projectPath, "README.md")))
    .digest("hex");
  const installed = await installCurrentPackage(root);
  const environment = {
    ...process.env,
    HOME: userHome,
    SANDKING_CONTROLLER_SECRET: "issue-164-packaged-secret",
  };
  const browser = await launchBrowser({ niceAdjustment: 10 });
  const context = await browser.newContext();
  const results = [];

  try {
    await prepareProjectBaseline({
      installed,
      context,
      dataDir: baselineDir,
      executionDirectory,
      environment,
      projectPath,
    });

    await cp(baselineDir, terminalSeedDir, { recursive: true });
    await prepareTerminalSeed({
      installed,
      context,
      dataDir: terminalSeedDir,
      executionDirectory,
      environment,
      projectPath,
    });

    await cp(baselineDir, reconciliationSeedDir, { recursive: true });
    await prepareReconciliationSeed({
      installed,
      context,
      dataDir: reconciliationSeedDir,
      executionDirectory,
      environment,
      projectPath,
    });

    await cp(reconciliationSeedDir, recoverySeedDir, { recursive: true });
    await prepareRecoverySeed({
      installed,
      context,
      dataDir: recoverySeedDir,
      executionDirectory,
      environment,
    });

    for (const [index, declaration] of selectedDeclarations.entries()) {
      const { boundary, faultPoint } = declaration;
      process.stdout.write(`qualifying packaged Cockpit boundary ${index + 1}/${selectedDeclarations.length}: ${faultPoint}\n`);
      const caseRoot = join(root, `case-${String(index).padStart(2, "0")}`);
      const dataDir = join(caseRoot, "host-state");
      await mkdir(caseRoot, { recursive: true });
      const seedDir = faultPoint.startsWith("harness_run_reconciliation.")
          ? reconciliationSeedDir
          : faultPoint.startsWith("harness_run_recovery.")
            ? recoverySeedDir
            : baselineDir;
      await cp(seedDir, dataDir, { recursive: true });
      const markerPath = join(caseRoot, "fault-reached");
      await pauseInstalledHostOnceAtHarnessRunFault(installed, faultPoint, markerPath);

      const isStartupBoundary = faultPoint.startsWith("harness_run_reconciliation.");
      let interruptedState;
      let pendingMutation = null;
      let pendingStorageKey = null;

      if (isStartupBoundary) {
        const launchAttempt = launchRuntime(
          installed,
          dataDir,
          executionDirectory,
          environment,
          `issue-164-fault-runtime-${index}`,
        ).then(
          (value) => ({ status: "fulfilled", value }),
          (reason) => ({ status: "rejected", reason }),
        );
        await waitForFile(markerPath);
        interruptedState = await readJson(join(dataDir, "harness-runs.json"));
        const hostPid = await findHostPid(dataDir);
        const descendants = descendantPids(hostPid, await readProcesses());
        process.kill(hostPid, "SIGKILL");
        await waitForProcessesToExit(descendants);
        const launchResult = await launchAttempt;
        assert.equal(launchResult.status, "rejected", faultPoint);
        await stopRuntime(installed, dataDir, executionDirectory, environment);
      } else {
        const launch = await launchRuntime(
          installed,
          dataDir,
          executionDirectory,
          environment,
          `issue-164-active-runtime-${index}`,
        );
        const opened = await openCockpit(context, launch.bootstrapUrl);
        try {
          if (!faultPoint.startsWith("harness_run_recovery.")) {
            await openPreparedProject(opened.page, projectPath);
          }
          if (faultPoint.startsWith("harness_run_launch.")) {
            await launchHarness(opened.page, 164);
            await waitForFile(markerPath);
            pendingMutation = mutationMessage(
              opened.sentMessages,
              "browser.harness-run.launch",
            );
            pendingStorageKey = "sandking.pendingHarnessLaunch";
          } else if (
            faultPoint.startsWith("harness_run_lifecycle.")
            || faultPoint.startsWith("harness_run_terminal_envelope.")
            || faultPoint.startsWith("harness_run_outcome.")
          ) {
            await launchHarness(opened.page, 164);
            await waitForFile(markerPath);
          } else if (faultPoint.startsWith("harness_run_cancellation.")) {
            const issueNumber = faultPoint.includes("forced_signal")
              ? 999_999_994
              : 999_999_993;
            await launchHarness(opened.page, issueNumber);
            await waitForRunStatus(opened.page, "running");
            await opened.page.waitForSelector("#cancel-harness-run:not([disabled])", {
              timeout: 90_000,
            });
            await opened.page.locator("#cancel-harness-run").click();
            await waitForFile(markerPath);
            const message = mutationMessage(
              opened.sentMessages,
              "browser.harness-run.cancel",
            );
            pendingMutation = {
              harnessRunId: message.harnessRunId,
              idempotencyKeyHash: message.idempotencyKeyHash,
            };
            pendingStorageKey = "sandking.pendingHarnessCancellation";
          } else if (faultPoint.startsWith("harness_run_recovery.")) {
            await waitForRunStatus(opened.page, "recovery_required");
            const state = await readJson(join(dataDir, "harness-runs.json"));
            await writeTerminationEvidence(
              dataDir,
              state.runs[0].harnessRunId,
              "termination_confirmed",
            );
            await opened.page.waitForSelector("#harness-recovery-recheck:not([disabled])", {
              timeout: 90_000,
            });
            await opened.page.locator("#harness-recovery-recheck").click();
            await waitForFile(markerPath);
            const message = mutationMessage(
              opened.sentMessages,
              "browser.harness-run.recover",
            );
            pendingMutation = {
              harnessRunId: message.harnessRunId,
              action: message.action,
              idempotencyKeyHash: message.idempotencyKeyHash,
            };
            pendingStorageKey = "sandking.pendingHarnessRecovery";
          } else {
            throw new Error(`canonical_boundary_kind_unknown:${faultPoint}`);
          }

          interruptedState = await readJson(join(dataDir, "harness-runs.json"))
            .catch(() => ({ runs: [] }));
          const hostPid = await findHostPid(dataDir);
          const descendants = descendantPids(hostPid, await readProcesses());
          process.kill(hostPid, "SIGKILL");
          await waitForProcessesToExit(descendants);
          await ensureConfirmedTerminationEvidence(dataDir, interruptedState.runs[0]);
        } finally {
          await opened.page.close();
          await stopRuntime(installed, dataDir, executionDirectory, environment);
        }
      }

      assert.equal(await readFile(markerPath, "utf8"), faultPoint);
      const snapshotBefore = interruptedState?.runs?.[0]?.executionSnapshot
        ? structuredClone(interruptedState.runs[0].executionSnapshot)
        : null;
      const restart = await launchRuntime(
        installed,
        dataDir,
        executionDirectory,
        environment,
        `issue-164-restart-runtime-${index}`,
      );
      const reopened = await openCockpit(context, restart.bootstrapUrl);
      let publicInspection;
      try {
        await reopenWithCursorResynchronization(reopened.page);
        const expectedStatus = expectedStatusAfterRestart(faultPoint);
        const afterRestart = await inspectCockpitTruth(
          reopened.page,
          dataDir,
          expectedStatus,
          snapshotBefore,
        );
        let afterReplay = null;

        if (pendingMutation && pendingStorageKey) {
          if (faultPoint === "harness_run_launch.before_commit") {
            await openPreparedProject(reopened.page, projectPath);
          }
          const replayStatus = faultPoint === "harness_run_launch.before_commit"
            ? "succeeded"
            : expectedStatus;
          await retryPendingMutation(
            reopened.page,
            pendingStorageKey,
            pendingMutation,
            replayStatus,
          );
          afterReplay = await inspectCockpitTruth(
            reopened.page,
            dataDir,
            replayStatus,
            snapshotBefore,
          );
        }
        publicInspection = { afterRestart, afterReplay };

        const converged = await readJson(join(dataDir, "harness-runs.json"));
        assert.equal(converged.schemaVersion, 8, faultPoint);
        assert.ok(converged.runs.length <= 1, faultPoint);
        assert.ok(converged.launchOutcomes.length <= 1, faultPoint);
        assert.ok(converged.cancellationOutcomes.length <= 1, faultPoint);
        assert.ok(converged.recoveryMutations.length <= 1, faultPoint);
        assert.equal(
          createHash("sha256")
            .update(await readFile(join(projectPath, "README.md")))
            .digest("hex"),
          projectDigest,
          faultPoint,
        );
        assert.equal((await execFileAsync("git", ["status", "--porcelain"], {
          cwd: projectPath,
        })).stdout, "", faultPoint);
        assert.doesNotMatch(JSON.stringify(converged),
          /issue-164-packaged-secret|idempotencyKey(?!Hash)/i);
      } finally {
        await reopened.page.close();
        await stopRuntime(installed, dataDir, executionDirectory, environment);
      }

      results.push({
        boundary,
        faultPoint,
        injected: true,
        restarted: true,
        converged: true,
        passed: true,
        executableEvidence:
          "test/canonical-boundary-recovery.browser.test.mjs:packaged Cockpit recovers every canonical boundary",
        packagedPublicSeam,
        cursorResynchronized: true,
        publicInspection,
      });
    }

    assert.deepEqual(results.map(({ faultPoint }) => faultPoint),
      selectedDeclarations.map(({ faultPoint }) => faultPoint));
    if (!process.env.SANDKING_TEST_FAULT_POINT) await writeResults(results);
  } finally {
    await context.close();
    await browser.close();
    await Promise.all([
      stopRuntime(installed, baselineDir, executionDirectory, environment),
      stopRuntime(installed, terminalSeedDir, executionDirectory, environment),
      stopRuntime(installed, reconciliationSeedDir, executionDirectory, environment),
      stopRuntime(installed, recoverySeedDir, executionDirectory, environment),
    ]);
    if (!process.env.SANDKING_KEEP_BOUNDARY_FIXTURE) {
      await rm(root, { recursive: true, force: true });
    } else {
      process.stdout.write(`retained boundary fixture: ${root}\n`);
    }
  }
});
