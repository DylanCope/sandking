import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { launchBrowser } from "./browser-launch.mjs";
import { installCurrentPackage } from "./installed-package.mjs";

const execFileAsync = promisify(execFile);

const waitForRetainedRun = async (dataDir) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await readFile(join(dataDir, "harness-runs.json"), "utf8")
      .then(JSON.parse, () => null);
    const run = state?.runs?.[0];
    if (run && ["succeeded", "failed", "cancelled"].includes(run.status)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("retained_harness_run_timeout");
};

test("local-walking-skeleton/completes-approved-run crosses the public Cockpit and survives observation disconnect", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-harness-run-browser-"));
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
  const projectFilesBefore = (await readdir(projectPath)).sort();
  const installed = await installCurrentPackage(root);
  const productEnvironment = {
    ...process.env,
    HOME: userHome,
    SANDKING_CONTROLLER_SECRET: "harness-run-browser-secret",
  };

  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--idempotency-key", "harness-run-browser-runtime-start",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const launch = JSON.parse(stdout);
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      let page = await context.newPage();
      const sentFrames = [];
      const receivedFrames = [];
      const observeFrames = (candidate) => candidate.on("websocket", (websocket) => {
        websocket.on("framesent", (event) => sentFrames.push(String(event.payload)));
        websocket.on("framereceived", (event) => receivedFrames.push(String(event.payload)));
      });
      observeFrames(page);
      const response = await page.goto(launch.bootstrapUrl, { waitUntil: "domcontentloaded" });
      assert.equal(response?.status(), 200);
      await page.waitForSelector("#project-preparation[data-explicit-path-only='true']", {
        timeout: 10_000,
      });
      await page.locator("#project-path").fill(projectPath);
      await page.locator("#open-project").click();
      await page.waitForSelector("#project-readiness[data-launch-request-ready='true']", {
        timeout: 10_000,
      });
      const projectId = await page.locator("#project-readiness").getAttribute("data-project-id");
      const harnessId = await page.locator("#project-readiness").getAttribute("data-harness-id");
      const harnessPin = await page.locator("#project-readiness").getAttribute("data-harness-pin");
      await page.locator("#open-project-controller").click();
      await page.waitForSelector(
        "#project-focused-controller-session[data-terminal-attachment='read-write']",
        { timeout: 10_000 },
      );
      const sessionId = await page.locator("#project-focused-controller-session")
        .getAttribute("data-session-id");
      const enter = async (value) => {
        await page.locator("#project-controller-terminal-input").fill(value);
        await page.locator("#send-project-controller-input").click();
      };
      await page.waitForFunction(() => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes("Conformance Controller ready"));
      await enter("prepare 120 sandcastle/issue-120");
      await page.waitForFunction(() => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes("Secret-free preview: yes"));
      const preview = await page.locator("#project-controller-terminal-output").textContent();
      const requestMatch = /Launch request: (launch-request-[a-f0-9]{24}) \(revision 1\)/
        .exec(preview);
      assert.ok(requestMatch);
      const launchRequestId = requestMatch[1];
      await enter(`approve ${launchRequestId} 1`);
      await page.waitForFunction((requestId) => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes(`Launch request ${requestId} approved at revision 2`),
      launchRequestId);
      await enter(`start ${launchRequestId} 2`);
      await page.waitForFunction(() => /Harness run harness-run-[a-f0-9]{24} created/.test(
        document.querySelector("#project-controller-terminal-output")?.textContent ?? "",
      ));
      const startOutput = await page.locator("#project-controller-terminal-output").textContent();
      const runId = /Harness run (harness-run-[a-f0-9]{24}) created/.exec(startOutput)?.[1];
      assert.match(runId, /^harness-run-[a-f0-9]{24}$/);

      await page.close();
      const retainedRun = await waitForRetainedRun(dataDir);
      assert.equal(retainedRun.harnessRunId, runId);
      assert.equal(retainedRun.status, "succeeded");
      const retainedSession = JSON.parse(
        await readFile(join(dataDir, "controller-sessions.json"), "utf8"),
      ).sessions.find((candidate) => candidate.sessionId === sessionId);
      assert.equal(retainedSession.terminal.status, "running");

      page = await context.newPage();
      observeFrames(page);
      await page.goto(new URL(launch.bootstrapUrl).origin, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(
        `#harness-run-observation[data-run-id='${runId}'][data-run-status='succeeded']`,
        { timeout: 10_000 },
      );
      await page.waitForFunction(() => (
        document.querySelector("[data-log-producer='stdout']")?.textContent
          ?.includes("diagnostic stdout")
        && document.querySelector("[data-log-producer='stderr']")?.textContent
          ?.includes("diagnostic stderr")
      ));
      const eventSequences = await page.locator("#harness-run-events")
        .getAttribute("data-event-sequences");
      assert.equal(eventSequences, "1,2,3,4");
      assert.deepEqual(await page.locator("#harness-run-events li").evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-event-type"))), [
        "harness_run_created",
        "harness_adapter_ready",
        "harness_progress_published",
        "harness_run_succeeded",
      ]);
      assert.equal(await page.locator("#harness-terminal-validation")
        .getAttribute("data-exactly-one-terminal"), "true");
      assert.equal(await page.locator("#harness-terminal-validation")
        .getAttribute("data-process-exit-observed"), "true");
      assert.equal(await page.locator("#harness-terminal-validation")
        .getAttribute("data-adapter-channel-closed-observed"), "true");
      assert.equal(await page.locator("#harness-run-structured-outcome")
        .getAttribute("data-outcome-status"), "succeeded");
      assert.equal(await page.locator("#harness-run-diagnostics")
        .getAttribute("data-conversation-insertion"), "false");
      assert.equal(await page.locator("[data-log-producer='stdout']")
        .getAttribute("data-range-start"), "0");
      assert.ok(Number(await page.locator("[data-log-producer='stdout']")
        .getAttribute("data-range-end")) > 0);
      assert.deepEqual((await readdir(projectPath)).sort(), projectFilesBefore);

      const launchState = JSON.parse(await readFile(join(dataDir, "launch-requests.json"), "utf8"));
      const retainedLaunch = launchState.launchRequests.find((candidate) =>
        candidate.launchRequestId === launchRequestId);
      assert.equal(retainedLaunch.execution.status, "succeeded");
      assert.equal(retainedLaunch.execution.harnessRunId, runId);
      assert.match(retainedLaunch.execution.outcomeReference, /^harness-outcome-/);
      const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      const startAudit = audits.find((entry) =>
        entry.action === "harness.run.start" && entry.outcome === "accepted");
      const outcomeAudit = audits.find((entry) =>
        entry.action === "harness.run.outcome" && entry.details.harnessRunId === runId);
      assert.equal(startAudit.details.returnedBeforeTerminal, true);
      assert.equal(outcomeAudit.details.validTerminalEnvelopeCount, 1);
      assert.ok(audits.some((entry) =>
        entry.action === "browser.harness-run.logs"
        && entry.details.insertedIntoControllerConversation === false));
      const retainedText = `${JSON.stringify(launchState)}\n${JSON.stringify(retainedRun)}\n${JSON.stringify(audits)}`;
      const pageText = await page.textContent("body");
      assert.doesNotMatch(retainedText, /harness-run-browser-secret/);
      assert.doesNotMatch(pageText, /harness-run-browser-secret/);
      assert.ok(sentFrames.some((frame) => frame.includes("browser.harness-run.observe")));
      assert.ok(sentFrames.some((frame) => frame.includes("browser.harness-run.logs.get")));
      assert.ok(receivedFrames.some((frame) => frame.includes("runtime.harness-run.observation")));

      if (process.env.SANDKING_ACCEPTANCE_OBSERVATION_PATH) {
        await writeFile(process.env.SANDKING_ACCEPTANCE_OBSERVATION_PATH, `${JSON.stringify({
          scenario: "local-walking-skeleton/completes-approved-run",
          issue: 120,
          packagedPublicSeam: installed.observation,
          identities: {
            hostId: launch.host.hostId,
            projectId,
            harnessId,
            harnessPin,
            launchRequestId,
            harnessRunId: runId,
            controllerId: launch.runtime.runtimeId,
            controllerSessionId: sessionId,
          },
          run: retainedRun,
          launchRequest: retainedLaunch,
          auditReferences: [startAudit, outcomeAudit],
          observation: {
            orderedEventSequences: eventSequences,
            separateLogProducers: ["stdout", "stderr"],
            structuredOutcome: retainedRun.outcome,
            reconnectAfterTabClosure: true,
            controllerSessionSurvived: retainedSession.terminal.status === "running",
          },
          prohibitedSideEffectAssertions: {
            projectFileWrite: false,
            logInsertedIntoControllerConversation: false,
            browserDisconnectCancellation: false,
            controllerSessionTermination: false,
            sudo: false,
            systemPackageInstall: false,
            shellProfileMutation: false,
            serviceConfiguration: false,
          },
          securityAssertions: {
            secretAbsentFromPage: !pageText.includes("harness-run-browser-secret"),
            secretAbsentFromRetainedState: !retainedText.includes("harness-run-browser-secret"),
          },
          software: {
            sandking: "0.1.0",
            browserProtocol: "1.0.0",
            browser: browser.version(),
            node: process.version,
          },
        }, null, 2)}\n`, { mode: 0o600 });
      }
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    await execFileAsync(installed.command, [
      "stop", "--data-dir", dataDir, "--json",
    ], { cwd: executionDirectory, env: productEnvironment }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
