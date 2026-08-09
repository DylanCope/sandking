import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { launchBrowser } from "./browser-launch.mjs";
import { installCurrentPackage } from "./installed-package.mjs";

const execFileAsync = promisify(execFile);
const readJson = (path) => readFile(path, "utf8").then(JSON.parse);
const softwareVersion = JSON.parse(await readFile(
  new URL("../package.json", import.meta.url),
  "utf8",
)).version;

const writeAcceptanceResult = async (name, result) => {
  const resultDirectory = process.env.SANDKING_ACCEPTANCE_RESULT_DIR;
  if (!resultDirectory) return;
  await mkdir(resultDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(resultDirectory, name),
    `${JSON.stringify(result, null, 2)}\n`,
    { mode: 0o600 },
  );
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

const findLocalHostPid = async (runtimePid) => {
  const processes = await readProcesses();
  const host = processes.find((candidate) =>
    candidate.parentPid === runtimePid
    && /(?:^|[/\s])local-host\.mjs(?:\s|$)/.test(candidate.args));
  if (!host) throw new Error("local_host_process_not_found");
  return host.pid;
};

const descendantProcesses = (rootPid, processes) => {
  const retained = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of processes) {
      if (retained.has(candidate.parentPid) && !retained.has(candidate.pid)) {
        retained.add(candidate.pid);
        changed = true;
      }
    }
  }
  retained.delete(rootPid);
  return processes.filter((processEntry) => retained.has(processEntry.pid));
};

const inspectHostProcessTree = async (rootPid) => {
  const processes = await readProcesses();
  const descendants = descendantProcesses(rootPid, processes);
  const processByPid = new Map(processes.map((processEntry) => [processEntry.pid, processEntry]));
  const adapters = descendants.filter((processEntry) =>
    processByPid.get(processEntry.parentPid)?.args.includes("posix-process-tree.mjs supervise")
    && !processEntry.args.includes("posix-process-tree.mjs supervise")
    && processEntry.args.includes("adapters/conformance.mjs run"));
  return { descendants, adapters };
};

const snapshotProjectContents = async (root, relativePath = "") => {
  const directory = join(root, relativePath);
  const entries = await readdir(directory, { withFileTypes: true });
  const snapshots = await Promise.all(entries.map(async (entry) => {
    const entryRelativePath = join(relativePath, entry.name);
    if (entry.isDirectory()) {
      return [
        { path: entryRelativePath, kind: "directory" },
        ...await snapshotProjectContents(root, entryRelativePath),
      ];
    }
    if (entry.isSymbolicLink()) {
      return [{
        path: entryRelativePath,
        kind: "symbolic-link",
        target: await readlink(join(root, entryRelativePath)),
      }];
    }
    const contents = await readFile(join(root, entryRelativePath));
    return [{
      path: entryRelativePath,
      kind: "file",
      bytes: contents.byteLength,
      digest: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
    }];
  }));
  return snapshots.flat().sort((left, right) => left.path.localeCompare(right.path));
};

const waitForActiveRun = async (dataDir) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await readJson(join(dataDir, "harness-runs.json")).catch(() => null);
    const run = state?.runs?.[0];
    if (run?.status === "running"
      && run.logStreams.every((stream) => stream.availableEnd > 0)) {
      return { state, run };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("active_harness_run_timeout");
};

const waitForRunCount = async (dataDir, count) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await readJson(join(dataDir, "harness-runs.json")).catch(() => null);
    if (state?.runs?.length === count) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`harness_run_count_timeout:${count}`);
};

const waitForAcceptedCancellation = async (dataDir) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await readJson(join(dataDir, "harness-runs.json")).catch(() => null);
    const run = state?.runs?.[0];
    if (run?.status === "cancelling" && run.cancellation) {
      return { state, run };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("accepted_harness_cancellation_timeout");
};

const readAudits = (dataDir) => readFile(join(dataDir, "audit.jsonl"), "utf8")
  .then((source) => source.trim().split("\n").filter(Boolean).map(JSON.parse));

const waitForHostLossEvidence = async (dataDir, harnessRunId) => {
  const path = join(
    dataDir,
    "harness-runs",
    harnessRunId,
    "host-loss-termination.json",
  );
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const evidence = await readJson(path).catch(() => null);
    if (evidence?.schemaVersion === 2) return { path, evidence };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("host_loss_termination_evidence_timeout");
};

const waitForProcessesToExit = async (pids) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const processes = new Map((await readProcesses()).map((entry) => [entry.pid, entry]));
    if (pids.every((pid) => {
      const retained = processes.get(pid);
      return !retained || /[XZ]/.test(retained.state[0]);
    })) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("supervised_process_exit_timeout");
};

test("packaged Cockpit reconciles an active Harness run after real Host death", {
  skip: process.platform !== "linux"
    ? "the deterministic real-process identity assertions use Linux process inventory"
    : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-host-death-reconciliation-"));
  const dataDir = join(root, "host-state");
  const executionDirectory = join(root, "outside-checkout");
  const userHome = join(root, "user-home");
  const projectPath = join(root, "selected-project");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(executionDirectory, { recursive: true }),
    mkdir(userHome, { recursive: true }),
    execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]),
  ]);
  await writeFile(join(projectPath, "README.md"), "ordinary Project content\n");
  await execFileAsync("git", [
    "-c", "user.name=Sand-King Acceptance",
    "-c", "user.email=sandking-acceptance@example.invalid",
    "add", "README.md",
  ], { cwd: projectPath });
  await execFileAsync("git", [
    "-c", "user.name=Sand-King Acceptance",
    "-c", "user.email=sandking-acceptance@example.invalid",
    "commit", "--quiet", "-m", "Project fixture",
  ], { cwd: projectPath });
  const trackedProjectChange = "TRACKED_PROJECT_CHANGE_164";
  await writeFile(
    join(projectPath, "README.md"),
    `ordinary Project content\n${trackedProjectChange}\n`,
  );
  const projectContentsBefore = await snapshotProjectContents(projectPath);
  const installed = await installCurrentPackage(root);
  const rawRuntimeRetryKey = "raw-durable-retry-key-164-runtime-first";
  const environmentDumpMarker = "durable-environment-dump-164";
  const processHandleMarker = "unrestricted-process-handle-164";
  const productEnvironment = {
    ...process.env,
    HOME: userHome,
    SANDKING_CONTROLLER_SECRET: "host-death-reconciliation-secret",
    SANDKING_DURABLE_ENVIRONMENT_DUMP: environmentDumpMarker,
    SANDKING_UNRESTRICTED_PROCESS_HANDLE: processHandleMarker,
  };

  try {
    const firstLaunch = JSON.parse((await execFileAsync(installed.command, [
      "launch", "--data-dir", dataDir, "--startup-timeout-ms", "60000",
      "--idempotency-key", rawRuntimeRetryKey, "--expected-revision", "0",
      "--json", "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment })).stdout);
    const browser = await launchBrowser({ niceAdjustment: 10 });
    try {
      const context = await browser.newContext();
      let page = await context.newPage();
      const firstSentFrames = [];
      page.on("websocket", (websocket) => {
        websocket.on("framesent", (event) => firstSentFrames.push(String(event.payload)));
      });
      await page.goto(firstLaunch.bootstrapUrl, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#project-preparation[data-explicit-path-only='true']", {
        timeout: 90_000,
      });
      await page.locator("#project-path").fill(projectPath);
      await page.locator("#open-project").click();
      await page.waitForSelector("#launch-harness:not([disabled])", { timeout: 90_000 });
      await page.locator("#open-project-controller").click();
      await page.waitForSelector(
        "#project-focused-controller-session[data-terminal-attachment='read-write']",
        { timeout: 90_000 },
      );
      const controllerSessionId = await page.locator("#project-focused-controller-session")
        .getAttribute("data-session-id");
      await page.waitForFunction(() => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes("Conformance Controller ready"));
      await page.locator("#project-controller-terminal-output .xterm-helper-textarea").focus();
      await page.keyboard.type("launch 999999993 sandcastle/issue-999999993");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => /Harness run harness-run-[a-f0-9]{24} created/
        .test(document.querySelector("#project-controller-terminal-output")?.textContent ?? ""));

      const { run: activeRun } = await waitForActiveRun(dataDir);
      assert.equal(activeRun.source, "controller-cli");
      assert.equal(activeRun.controllerSessionId, controllerSessionId);
      assert.equal(firstSentFrames.some((frame) =>
        frame.includes('"type":"browser.harness-run.launch"')), false);
      const runtimeState = await readJson(join(dataDir, "runtime-state.json"));
      const hostPid = await findLocalHostPid(runtimeState.pid);
      const initialProcessTree = await inspectHostProcessTree(hostPid);
      const supervisedPids = initialProcessTree.descendants.map(({ pid }) => pid);
      assert.ok(supervisedPids.length >= 3, JSON.stringify({ hostPid, supervisedPids }));
      const adapterStartCountBeforeHostDeath = initialProcessTree.adapters.length;
      assert.equal(adapterStartCountBeforeHostDeath, 1, JSON.stringify({
        descendants: initialProcessTree.descendants.map(({ pid, parentPid }) => ({ pid, parentPid })),
        adapters: initialProcessTree.adapters.map(({ pid, parentPid }) => ({ pid, parentPid })),
      }));

      process.kill(hostPid, "SIGKILL");
      await page.waitForSelector(
        "#connection-status[data-host-status='disconnected'][data-failure-code='host_disconnected']",
        { timeout: 90_000 },
      );
      const durableAtInterruption = await readJson(join(dataDir, "harness-runs.json"));
      const retainedActive = durableAtInterruption.runs[0];
      assert.equal(retainedActive.harnessRunId, activeRun.harnessRunId);
      assert.equal(retainedActive.status, "running");
      assert.equal(retainedActive.outcome, null);
      assert.equal(retainedActive.terminalEnvelopeValidation.adapterReadyObserved, true);

      await execFileAsync(installed.command, ["stop", "--data-dir", dataDir, "--json"], {
        cwd: executionDirectory,
        env: productEnvironment,
      });
      const secondLaunch = JSON.parse((await execFileAsync(installed.command, [
        "launch", "--data-dir", dataDir, "--startup-timeout-ms", "60000",
        "--idempotency-key", "host-death-runtime-second", "--json", "--no-open",
      ], { cwd: executionDirectory, env: productEnvironment })).stdout);
      assert.notEqual(secondLaunch.runtime.runtimeId, firstLaunch.runtime.runtimeId);
      assert.equal(secondLaunch.host.hostId, firstLaunch.host.hostId);
      const restartedRuntimeState = await readJson(join(dataDir, "runtime-state.json"));
      const restartedHostPid = await findLocalHostPid(restartedRuntimeState.pid);

      await page.close();
      page = await context.newPage();
      const secondSentFrames = [];
      const secondReceivedFrames = [];
      page.on("websocket", (websocket) => {
        websocket.on("framesent", (event) => secondSentFrames.push(String(event.payload)));
        websocket.on("framereceived", (event) => secondReceivedFrames.push(String(event.payload)));
      });
      await page.goto(secondLaunch.bootstrapUrl, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(
        `#harness-run-observation[data-run-id='${activeRun.harnessRunId}'][data-run-status='failed']`,
        { timeout: 90_000 },
      );
      const interruption = page.locator(
        "#harness-run-interruption[data-interruption-code='host_daemon_interrupted']",
      );
      await interruption.waitFor({ state: "visible" });
      assert.equal(await interruption.getAttribute("data-next-action"), "deliberate-new-run");
      assert.match(await interruption.textContent(), /adapter was not relaunched/i);
      assert.match(await interruption.textContent(), /Earlier ordered events/i);
      assert.match(await interruption.textContent(), /Retrying the original launch/i);
      assert.match(await interruption.textContent(), /deliberate new run/i);
      const reconnect = interruption.locator(
        "#reconnect-harness-launch[data-action='reconnect-original-launch']",
      );
      await reconnect.waitFor({ state: "visible" });
      await reconnect.click();
      await page.waitForFunction(() => /Harness run harness-run-[a-f0-9]{24} launched\./
        .test(document.querySelector("#harness-launch-feedback")?.textContent ?? ""));
      await page.waitForFunction(() => document.querySelector(
        "[data-log-producer='stdout']",
      )?.textContent?.includes("Conformance diagnostic stdout"));

      const helloAcknowledgement = secondReceivedFrames
        .flatMap((frame) => {
          try {
            return [JSON.parse(frame)?.message];
          } catch {
            return [];
          }
        })
        .find((message) => message?.type === "runtime.hello-ack");
      assert.equal(helloAcknowledgement.viewModel.harnessRunObservation.run.status, "failed");
      assert.equal(
        helloAcknowledgement.viewModel.harnessRunObservation.outcome.code,
        "host_daemon_interrupted",
      );
      const retryFrame = secondSentFrames
        .map((frame) => JSON.parse(frame)?.message)
        .find((message) => message?.type === "browser.harness-run.launch");
      assert.equal(retryFrame.reconnectHarnessRunId, activeRun.harnessRunId);
      assert.equal(retryFrame.idempotencyKeyHash, activeRun.launchIdempotencyKeyHash);
      assert.deepEqual(retryFrame.parameters ?? {}, activeRun.parameters ?? {});
      assert.equal("source" in retryFrame, false);
      assert.equal("controllerSessionId" in retryFrame, false);

      const reconciledState = await waitForRunCount(dataDir, 1);
      const reconciled = reconciledState.runs[0];
      const processesAfterReconciliation = new Map(
        (await readProcesses()).map((entry) => [entry.pid, entry]),
      );
      assert.deepEqual(supervisedPids.filter((pid) => {
        const retained = processesAfterReconciliation.get(pid);
        return retained && !/[XZ]/.test(retained.state[0]);
      }), []);
      assert.equal(reconciled.status, "failed");
      assert.equal(reconciled.outcome.code, "host_daemon_interrupted");
      assert.equal(reconciled.outcome.incompleteResult, true);
      assert.equal(reconciled.outcome.result, null);
      assert.equal(reconciled.outcome.terminalEnvelope, null);
      assert.deepEqual(reconciled.events.slice(0, retainedActive.events.length),
        retainedActive.events);
      assert.equal(reconciled.events.at(-1).type, "harness_run_failed");
      assert.deepEqual(reconciled.executionSnapshot, retainedActive.executionSnapshot);
      assert.deepEqual(reconciled.logStreams, retainedActive.logStreams);
      assert.deepEqual(reconciled.outcome.diagnosticReferences,
        retainedActive.logStreams.map((stream) => ({
          streamId: stream.streamId,
          producer: stream.producer,
          range: { start: stream.availableStart, end: stream.availableEnd },
          explicitRetrievalRequired: stream.explicitRetrievalRequired,
          insertedIntoControllerConversation: stream.insertedIntoControllerConversation,
        })));
      const processTreeAfterReplay = await inspectHostProcessTree(restartedHostPid);
      assert.deepEqual(processTreeAfterReplay.descendants, [],
        JSON.stringify(processTreeAfterReplay));
      assert.deepEqual(await snapshotProjectContents(projectPath), projectContentsBefore);
      const auditsBeforeNewLaunch = await readAudits(dataDir);
      assert.equal(auditsBeforeNewLaunch.filter((audit) =>
        audit.action === "harness.adapter.start"
        && audit.details.harnessRunId === activeRun.harnessRunId).length, 1);
      assert.equal(auditsBeforeNewLaunch.filter((audit) =>
        audit.action === "harness.run.launch" && audit.outcome === "accepted").length, 1);
      assert.equal(auditsBeforeNewLaunch.filter((audit) =>
        audit.action === "harness.run.reconcile"
        && audit.details.harnessRunId === activeRun.harnessRunId).length, 1);
      assert.equal(auditsBeforeNewLaunch.filter((audit) =>
        audit.action === "harness.run.outcome"
        && audit.details.harnessRunId === activeRun.harnessRunId).length, 1);

      await page.locator("#project-path").fill(projectPath);
      await page.locator("#open-project").click();
      await page.waitForSelector("#open-project:not([disabled])", { timeout: 90_000 });
      if (await page.locator("#launch-harness").isDisabled()) {
        await page.locator("#open-project").click();
      }
      await page.waitForSelector("#launch-harness:not([disabled])", { timeout: 90_000 });
      await page.locator("#harness-launch-parameter-issueNumber").fill("160");
      await page.locator("#harness-launch-parameter-targetBranch")
        .fill("sandcastle/issue-160");
      await page.locator("#launch-harness").click();
      await page.locator("#harness-launch-confirmation-yes").click();
      await page.waitForFunction(() => /Harness run harness-run-[a-f0-9]{24} launched\./
        .test(document.querySelector("#harness-launch-feedback")?.textContent ?? ""));
      const withDeliberateRun = await waitForRunCount(dataDir, 2);
      assert.notEqual(withDeliberateRun.runs[1].harnessRunId, activeRun.harnessRunId);
      assert.deepEqual(withDeliberateRun.runs[0], reconciled);
      assert.deepEqual(await snapshotProjectContents(projectPath), projectContentsBefore);

      const finalAudits = await readAudits(dataDir);
      assert.equal(finalAudits.filter((audit) =>
        audit.action === "harness.run.launch" && audit.outcome === "accepted").length, 2);
      assert.equal(finalAudits.filter((audit) =>
        audit.action === "harness.run.reconcile"
        && audit.details.harnessRunId === activeRun.harnessRunId).length, 1);
      assert.doesNotMatch(JSON.stringify({ reconciled, finalAudits }),
        /host-death-reconciliation-secret/);
      assert.doesNotMatch(await page.locator("body").textContent(),
        /sha256:[a-f0-9]{64}|idempotencyKey/);
      const diagnosticText = (await Promise.all(reconciled.logStreams.map((stream) =>
        readFile(join(
          dataDir,
          "harness-runs",
          reconciled.harnessRunId,
          `${stream.producer}.log`,
        ), "utf8")))).join("\n");
      const publicAndRetainedSurfaces = JSON.stringify({
        firstSentFrames,
        secondSentFrames,
        secondReceivedFrames,
        reconciled,
        finalAudits,
        browserModel: await page.locator("body").textContent(),
        diagnostics: diagnosticText,
      });
      for (const prohibited of [
        "host-death-reconciliation-secret",
        environmentDumpMarker,
        processHandleMarker,
        rawRuntimeRetryKey,
        trackedProjectChange,
      ]) {
        assert.doesNotMatch(publicAndRetainedSurfaces, new RegExp(prohibited));
      }
      assert.doesNotMatch(publicAndRetainedSurfaces,
        /processHandle|unrestrictedProcessHandle|process\.env|GITHUB_TOKEN=/i);
      await writeAcceptanceResult("reconciles-host-death-mid-run.json", {
        schemaVersion: 1,
        id: "durable-execution/reconciles-host-death-mid-run",
        scenarioVersion: "1.0.0",
        softwareVersion,
        passed: true,
        packagedPublicSeam: {
          ...installed.observation,
          transport:
            "loopback Cockpit -> authenticated WebSocket -> Controller runtime -> framed local Host",
        },
        identities: {
          hostId: reconciled.hostId,
          projectId: reconciled.projectId,
          harnessId: reconciled.harnessId,
          harnessRunId: reconciled.harnessRunId,
          harnessPinnedCommit: reconciled.harnessPinnedRevision,
        },
        adapter: {
          identity: reconciled.adapterId,
          protocol: reconciled.adapterProtocol,
          entryPoint: reconciled.adapterEntryPoint,
        },
        eventReferences: reconciled.events.map((event) => ({
          eventId: event.eventId,
          sequence: event.sequence,
          type: event.type,
          outcomeReference: event.outcomeReference,
        })),
        auditReferences: finalAudits.filter((audit) =>
          audit.details?.harnessRunId === reconciled.harnessRunId).map((audit) => ({
          auditId: audit.auditId,
          action: audit.action,
          outcome: audit.outcome,
        })),
        retryKeyHashes: [
          reconciled.launchIdempotencyKeyHash,
          ...finalAudits.flatMap((audit) =>
            typeof audit.details?.idempotencyKeyHash === "string"
              ? [audit.details.idempotencyKeyHash]
              : []),
        ].filter((value, index, values) => value && values.indexOf(value) === index),
        faultPoint: "real_host_sigkill_after_active_publication",
        reconciliationDecision: "finalize_failed_incomplete",
        terminalEnvelopeValidation: reconciled.terminalEnvelopeValidation,
        typedOutcome: {
          outcomeId: reconciled.outcome.outcomeId,
          status: reconciled.outcome.status,
          code: reconciled.outcome.code,
          incompleteResult: reconciled.outcome.incompleteResult,
          terminalEnvelope: reconciled.outcome.terminalEnvelope,
        },
        sanitizedDiagnosticRanges: reconciled.outcome.diagnosticReferences.map((reference) => ({
          streamId: reference.streamId,
          producer: reference.producer,
          range: reference.range,
          explicitRetrievalRequired: reference.explicitRetrievalRequired,
        })),
        invariantAssertions: {
          sameRunIdentity: true,
          immutableExecutionSnapshot: true,
          orderedHistoryPreserved: true,
          oneTerminalOutcome: true,
          sameKeyReplayDidNotStartAdapter: true,
          originalProcessTreeTerminated: true,
          projectContentsUnchanged: true,
        },
        securityAssertions: {
          credentialFixtureAbsent: true,
          rawRetryKeyAbsent: true,
          unrestrictedProcessHandleAbsent: true,
          environmentDumpAbsent: true,
          trackedProjectChangeAbsent: true,
        },
      });
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    await execFileAsync(installed.command, ["stop", "--data-dir", dataDir, "--json"], {
      cwd: executionDirectory,
      env: productEnvironment,
    }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged Cockpit resolves uncertain Host-loss supervision through bounded recovery", {
  skip: process.platform !== "linux"
    ? "the deterministic real-process identity assertions use Linux process inventory"
    : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-uncertain-host-recovery-"));
  const dataDir = join(root, "host-state");
  const executionDirectory = join(root, "outside-checkout");
  const userHome = join(root, "user-home");
  const projectPath = join(root, "selected-project");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(executionDirectory, { recursive: true }),
    mkdir(userHome, { recursive: true }),
    execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]),
  ]);
  await writeFile(join(projectPath, "README.md"), "ordinary Project content\n");
  const projectContentsBefore = await snapshotProjectContents(projectPath);
  const installed = await installCurrentPackage(root);
  const secret = "uncertain-host-recovery-secret";
  const productEnvironment = { ...process.env, HOME: userHome, SANDKING_CONTROLLER_SECRET: secret };

  try {
    const firstLaunch = JSON.parse((await execFileAsync(installed.command, [
      "launch", "--data-dir", dataDir, "--startup-timeout-ms", "60000",
      "--idempotency-key", "uncertain-recovery-runtime-first",
      "--expected-revision", "0", "--json", "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment })).stdout);
    const browser = await launchBrowser({ niceAdjustment: 10 });
    try {
      const context = await browser.newContext();
      let page = await context.newPage();
      await page.goto(firstLaunch.bootstrapUrl, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#project-preparation[data-explicit-path-only='true']", {
        timeout: 90_000,
      });
      await page.locator("#project-path").fill(projectPath);
      await page.locator("#open-project").click();
      await page.waitForSelector("#launch-harness:not([disabled])", { timeout: 90_000 });
      await page.locator("#harness-launch-parameter-issueNumber").fill("999999993");
      await page.locator("#harness-launch-parameter-targetBranch")
        .fill("sandcastle/issue-999999993");
      await page.locator("#launch-harness").click();
      await page.locator("#harness-launch-confirmation-yes").click();
      const { run: activeRun } = await waitForActiveRun(dataDir);
      const beforeRecoveryEvents = structuredClone(activeRun.events);
      const runtimeState = await readJson(join(dataDir, "runtime-state.json"));
      const hostPid = await findLocalHostPid(runtimeState.pid);
      const initialTree = await inspectHostProcessTree(hostPid);
      const supervisedPids = initialTree.descendants.map(({ pid }) => pid);
      assert.ok(supervisedPids.length >= 3, JSON.stringify(initialTree));

      process.kill(hostPid, "SIGKILL");
      await page.waitForSelector(
        "#connection-status[data-host-status='disconnected']"
          + "[data-failure-code='host_disconnected']",
        { timeout: 90_000 },
      );
      await waitForProcessesToExit(supervisedPids);
      const { path: evidencePath } = await waitForHostLossEvidence(
        dataDir,
        activeRun.harnessRunId,
      );
      await execFileAsync(installed.command, ["stop", "--data-dir", dataDir, "--json"], {
        cwd: executionDirectory,
        env: productEnvironment,
      });
      await writeFile(evidencePath, `${JSON.stringify({
        schemaVersion: 2,
        platform: "linux",
        status: "termination_unconfirmed",
        terminationScope: "complete_process_tree",
        launchSettled: true,
        treeEmpty: false,
        observedAt: "2026-08-09T18:00:00.000Z",
      })}\n`);

      const secondLaunch = JSON.parse((await execFileAsync(installed.command, [
        "launch", "--data-dir", dataDir, "--startup-timeout-ms", "60000",
        "--idempotency-key", "uncertain-recovery-runtime-second",
        "--json", "--no-open",
      ], { cwd: executionDirectory, env: productEnvironment })).stdout);
      await page.close();
      page = await context.newPage();
      const sentFrames = [];
      page.on("websocket", (websocket) => {
        websocket.on("framesent", (event) => sentFrames.push(String(event.payload)));
      });
      await page.goto(secondLaunch.bootstrapUrl, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(
        `#harness-run-observation[data-run-id='${activeRun.harnessRunId}']`
          + "[data-run-status='recovery_required']",
        { timeout: 90_000 },
      );
      const recoveryPanel = page.locator(
        "#harness-run-recovery-required[data-related-process-state='unknown']"
          + "[data-identity-proof='unavailable'][data-safe-to-terminate='false']",
      );
      await recoveryPanel.waitFor({ state: "visible" });
      assert.equal(await recoveryPanel.getAttribute("data-process-identifiers-exposed"), "false");
      assert.equal(
        await recoveryPanel.getAttribute("data-unrestricted-process-handle-exposed"),
        "false",
      );
      assert.match(await recoveryPanel.textContent(), /No terminal outcome has been invented/i);
      assert.match(await recoveryPanel.textContent(), /deliberately launch a new run/i);
      assert.match(await recoveryPanel.textContent(), /could overlap/i);
      await page.locator("#project-path").fill(projectPath);
      await page.locator("#open-project").click();
      await page.waitForSelector("#open-project:not([disabled])", { timeout: 90_000 });
      if (await page.locator("#launch-harness").isDisabled()) {
        await page.locator("#open-project").click();
      }
      await page.waitForSelector("#launch-harness:not([disabled])", { timeout: 90_000 });
      assert.equal(await page.locator("#launch-harness").isDisabled(), false);
      assert.equal(await recoveryPanel.locator("[data-harness-recovery-action]").count(), 1);
      assert.equal(
        await recoveryPanel.locator("[data-harness-recovery-action]").getAttribute(
          "data-harness-recovery-action",
        ),
        "recheck",
      );

      await writeFile(evidencePath, `${JSON.stringify({
        schemaVersion: 2,
        platform: "linux",
        status: "termination_confirmed",
        terminationScope: "complete_process_tree",
        launchSettled: true,
        treeEmpty: true,
        observedAt: "2026-08-09T18:01:00.000Z",
      })}\n`);
      await page.locator("#harness-recovery-recheck").click();
      const recheckDeadline = Date.now() + 10_000;
      let recheckedState = null;
      while (Date.now() < recheckDeadline) {
        recheckedState = await readJson(join(dataDir, "harness-runs.json"));
        if (recheckedState.runs[0].recovery?.processObservation.relatedProcessState
          === "terminated_confirmed") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(
        recheckedState?.runs[0].recovery?.processObservation.relatedProcessState,
        "terminated_confirmed",
        JSON.stringify({
          sentFrames,
          feedback: await page.locator("#harness-run-recovery-feedback").textContent(),
          evidence: await readJson(evidencePath),
          recovery: recheckedState?.runs[0].recovery,
        }),
      );
      await page.waitForSelector(
        "#harness-run-recovery-required[data-related-process-state='terminated_confirmed'] "
          + "[data-harness-recovery-action='finalize']:not([disabled])",
        { timeout: 10_000 },
      );
      const recheckFrame = sentFrames
        .flatMap((frame) => {
          try {
            return [JSON.parse(frame)?.message];
          } catch {
            return [];
          }
        })
        .find((message) => message?.type === "browser.harness-run.recover"
          && message.action === "recheck");
      assert.equal(recheckFrame.harnessRunId, activeRun.harnessRunId);
      assert.match(recheckFrame.idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
      assert.equal("idempotencyKey" in recheckFrame, false);
      assert.equal("expectedRevision" in recheckFrame, false);

      await page.evaluate((pending) => {
        sessionStorage.setItem("sandking.pendingHarnessRecovery", JSON.stringify(pending));
      }, {
        harnessRunId: recheckFrame.harnessRunId,
        action: recheckFrame.action,
        idempotencyKeyHash: recheckFrame.idempotencyKeyHash,
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() =>
        sessionStorage.getItem("sandking.pendingHarnessRecovery") === null);
      await page.waitForSelector("[data-harness-recovery-action='finalize']:not([disabled])", {
        timeout: 90_000,
      });
      await page.locator("[data-harness-recovery-action='finalize']").click();
      await page.waitForSelector(
        `#harness-run-observation[data-run-id='${activeRun.harnessRunId}']`
          + "[data-run-status='failed']",
        { timeout: 90_000 },
      );

      const retained = await waitForRunCount(dataDir, 1);
      const resolved = retained.runs[0];
      assert.equal(resolved.status, "failed");
      assert.equal(resolved.outcome.status, "failed");
      assert.equal(resolved.outcome.code, "host_daemon_interrupted");
      assert.equal(resolved.outcome.incompleteResult, true);
      assert.equal(resolved.outcome.result, null);
      assert.deepEqual(resolved.events.slice(0, beforeRecoveryEvents.length), beforeRecoveryEvents);
      assert.equal(resolved.events.filter((event) =>
        event.type === "harness_run_recovery_required").length, 1);
      assert.equal(resolved.events.filter((event) =>
        event.type === "harness_run_failed").length, 1);
      assert.equal(resolved.events.some((event) =>
        event.type === "harness_run_succeeded"), false);
      assert.deepEqual(await snapshotProjectContents(projectPath), projectContentsBefore);
      const audits = await readAudits(dataDir);
      const recoveryAudits = audits.filter((audit) => audit.action === "harness.run.recover");
      assert.equal(recoveryAudits.filter((audit) => audit.outcome === "accepted").length, 2);
      assert.equal(recoveryAudits.filter((audit) => audit.outcome === "observed").length, 1);
      assert.equal(recoveryAudits.every((audit) => audit.details.projectWrite !== true), true);
      assert.doesNotMatch(JSON.stringify({ resolved, recoveryAudits }),
        new RegExp(`${secret}|idempotencyKey(?!Hash)|processHandle|environment`));
      for (const pid of supervisedPids) {
        assert.doesNotMatch(JSON.stringify({ resolved, recoveryAudits }), new RegExp(`\\b${pid}\\b`));
      }
      assert.doesNotMatch(await page.locator("body").textContent(), /sha256:[a-f0-9]{64}/);
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    await execFileAsync(installed.command, ["stop", "--data-dir", dataDir, "--json"], {
      cwd: executionDirectory,
      env: productEnvironment,
    }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged Cockpit continues accepted cancellation after real Host death", {
  skip: process.platform !== "linux"
    ? "the deterministic real-process identity assertions use Linux process inventory"
    : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-cancellation-host-restart-"));
  const dataDir = join(root, "host-state");
  const executionDirectory = join(root, "outside-checkout");
  const userHome = join(root, "user-home");
  const projectPath = join(root, "selected-project");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(executionDirectory, { recursive: true }),
    mkdir(userHome, { recursive: true }),
    execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]),
  ]);
  await writeFile(join(projectPath, "README.md"), "ordinary Project content\n");
  const projectContentsBefore = await snapshotProjectContents(projectPath);
  const installed = await installCurrentPackage(root);
  const productEnvironment = {
    ...process.env,
    HOME: userHome,
    SANDKING_CONTROLLER_SECRET: "cancellation-host-restart-secret",
  };

  try {
    const firstLaunch = JSON.parse((await execFileAsync(installed.command, [
      "launch", "--data-dir", dataDir, "--startup-timeout-ms", "60000",
      "--host-mode", "pause-after-harness-run-cancellation-acceptance",
      "--idempotency-key", "cancellation-restart-runtime-first",
      "--expected-revision", "0", "--json", "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment })).stdout);
    const browser = await launchBrowser({ niceAdjustment: 10 });
    try {
      const context = await browser.newContext();
      let page = await context.newPage();
      const firstSentFrames = [];
      page.on("websocket", (websocket) => {
        websocket.on("framesent", (event) => firstSentFrames.push(String(event.payload)));
      });
      await page.goto(firstLaunch.bootstrapUrl, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#project-preparation[data-explicit-path-only='true']", {
        timeout: 90_000,
      });
      await page.locator("#project-path").fill(projectPath);
      await page.locator("#open-project").click();
      await page.waitForSelector("#launch-harness:not([disabled])", { timeout: 90_000 });
      await page.locator("#harness-launch-parameter-issueNumber").fill("999999993");
      await page.locator("#harness-launch-parameter-targetBranch")
        .fill("sandcastle/issue-999999993");
      await page.locator("#launch-harness").click();
      await page.locator("#harness-launch-confirmation-yes").click();
      await page.waitForFunction(() => /Harness run harness-run-[a-f0-9]{24} launched\./
        .test(document.querySelector("#harness-launch-feedback")?.textContent ?? ""));

      const { run: activeRun } = await waitForActiveRun(dataDir);
      await page.waitForSelector(
        `#harness-run-observation[data-run-id='${activeRun.harnessRunId}'] `
          + "#cancel-harness-run:not([disabled])",
        { timeout: 15_000 },
      );
      const runtimeState = await readJson(join(dataDir, "runtime-state.json"));
      const hostPid = await findLocalHostPid(runtimeState.pid);
      const initialProcessTree = await inspectHostProcessTree(hostPid);
      const supervisedPids = initialProcessTree.descendants.map(({ pid }) => pid);
      assert.ok(supervisedPids.length >= 3, JSON.stringify({ hostPid, supervisedPids }));
      assert.equal(initialProcessTree.adapters.length, 1, JSON.stringify(initialProcessTree));

      await page.locator("#cancel-harness-run").click();
      const { run: acceptedRun } = await waitForAcceptedCancellation(dataDir);
      const cancellationFrame = firstSentFrames
        .map((frame) => {
          try {
            return JSON.parse(frame)?.message;
          } catch {
            return null;
          }
        })
        .find((message) => message?.type === "browser.harness-run.cancel");
      assert.equal(cancellationFrame.harnessRunId, activeRun.harnessRunId);
      assert.match(cancellationFrame.idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
      assert.equal(acceptedRun.cancellation.cooperativeSignalSentAt, null);
      assert.equal(acceptedRun.cancellation.forcedTerminationSentAt, null);
      assert.equal(acceptedRun.cancellation.terminationConfirmedAt, null);
      assert.equal(acceptedRun.events.filter((event) =>
        event.type === "harness_run_cancellation_accepted").length, 1);

      process.kill(hostPid, "SIGKILL");
      await page.waitForSelector(
        "#connection-status[data-host-status='disconnected']"
          + "[data-failure-code='host_disconnected']",
        { timeout: 90_000 },
      );
      await execFileAsync(installed.command, ["stop", "--data-dir", dataDir, "--json"], {
        cwd: executionDirectory,
        env: productEnvironment,
      });
      const secondLaunch = JSON.parse((await execFileAsync(installed.command, [
        "launch", "--data-dir", dataDir, "--startup-timeout-ms", "60000",
        "--idempotency-key", "cancellation-restart-runtime-second",
        "--json", "--no-open",
      ], { cwd: executionDirectory, env: productEnvironment })).stdout);
      assert.notEqual(secondLaunch.runtime.runtimeId, firstLaunch.runtime.runtimeId);
      assert.equal(secondLaunch.host.hostId, firstLaunch.host.hostId);

      await page.close();
      page = await context.newPage();
      const secondSentFrames = [];
      page.on("websocket", (websocket) => {
        websocket.on("framesent", (event) => secondSentFrames.push(String(event.payload)));
      });
      await page.goto(secondLaunch.bootstrapUrl, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(
        `#harness-run-observation[data-run-id='${activeRun.harnessRunId}']`
          + "[data-run-status='cancelled']",
        { timeout: 90_000 },
      );
      const progress = page.locator(
        "#harness-run-cancellation-progress[data-cancellation-accepted='true']"
          + "[data-termination-confirmed='true'][data-reconciled-result='cancelled']",
      );
      await progress.waitFor({ state: "visible" });
      assert.match(await progress.textContent(), /truthful terminal outcome: cancelled/i);
      assert.doesNotMatch(await page.locator("#harness-run-cancellation-feedback").textContent(),
        /null|recovery/i);
      assert.equal(await page.locator("#harness-run-structured-outcome")
        .getAttribute("data-outcome-status"), "cancelled");

      await page.evaluate((pending) => {
        sessionStorage.setItem("sandking.pendingHarnessCancellation", JSON.stringify(pending));
      }, {
        harnessRunId: cancellationFrame.harnessRunId,
        idempotencyKeyHash: cancellationFrame.idempotencyKeyHash,
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() =>
        sessionStorage.getItem("sandking.pendingHarnessCancellation") === null);
      const replayFrame = secondSentFrames
        .map((frame) => JSON.parse(frame)?.message)
        .find((message) => message?.type === "browser.harness-run.cancel");
      assert.equal(replayFrame.harnessRunId, cancellationFrame.harnessRunId);
      assert.equal(replayFrame.idempotencyKeyHash, cancellationFrame.idempotencyKeyHash);

      const reconciledState = await waitForRunCount(dataDir, 1);
      const reconciled = reconciledState.runs[0];
      assert.equal(reconciled.status, "cancelled");
      assert.equal(reconciled.outcome.status, "cancelled");
      assert.equal(reconciled.outcome.incompleteResult, true);
      assert.equal(reconciled.events.filter((event) =>
        event.type === "harness_run_cancellation_accepted").length, 1);
      assert.equal(reconciled.events.filter((event) =>
        event.type === "harness_run_cancelled").length, 1);
      assert.deepEqual(reconciled.executionSnapshot, acceptedRun.executionSnapshot);
      assert.deepEqual(reconciled.logStreams, acceptedRun.logStreams);
      const processesAfterReconciliation = new Map(
        (await readProcesses()).map((entry) => [entry.pid, entry]),
      );
      assert.deepEqual(supervisedPids.filter((pid) => {
        const retained = processesAfterReconciliation.get(pid);
        return retained && !/[XZ]/.test(retained.state[0]);
      }), []);
      assert.deepEqual(await snapshotProjectContents(projectPath), projectContentsBefore);

      const audits = await readAudits(dataDir);
      assert.equal(audits.filter((audit) =>
        audit.action === "harness.adapter.start"
        && audit.details.harnessRunId === activeRun.harnessRunId).length, 1);
      assert.equal(audits.filter((audit) =>
        audit.action === "harness.run.cancel"
        && audit.outcome === "accepted"
        && audit.details.harnessRunId === activeRun.harnessRunId).length, 1);
      const reconciliationAudits = audits.filter((audit) =>
        audit.action === "harness.run.reconcile"
        && audit.details.harnessRunId === activeRun.harnessRunId);
      assert.equal(reconciliationAudits.length, 1);
      assert.equal(reconciliationAudits[0].details.cancellationAccepted, true);
      assert.equal(reconciliationAudits[0].details.cooperativeSignalSent, false);
      assert.equal(reconciliationAudits[0].details.forcedTerminationSent, false);
      assert.equal(reconciliationAudits[0].details.terminationConfirmed, true);
      assert.doesNotMatch(JSON.stringify({ reconciled, audits }),
        /cancellation-host-restart-secret/);
      assert.doesNotMatch(await page.locator("body").textContent(),
        /sha256:[a-f0-9]{64}|idempotencyKey/);
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    await execFileAsync(installed.command, ["stop", "--data-dir", dataDir, "--json"], {
      cwd: executionDirectory,
      env: productEnvironment,
    }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
