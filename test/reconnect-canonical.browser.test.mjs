import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { launchBrowser } from "./browser-launch.mjs";
import { installCurrentPackage } from "./installed-package.mjs";

const execFileAsync = promisify(execFile);

test("one-action Harness launch reconnects to canonical state without duplicate work", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-canonical-reconnect-browser-"));
  const dataDir = join(root, "host-state");
  const executionDirectory = join(root, "outside-project");
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
    SANDKING_CONTROLLER_SECRET: "canonical-reconnect-browser-secret",
  };
  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch", "--data-dir", dataDir,
      "--startup-timeout-ms", "60000",
      "--host-mode", "delayed-harness-run-launch-response",
      "--idempotency-key", "issue-152-runtime-start",
      "--expected-revision", "0", "--json", "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const runtime = JSON.parse(stdout);
    const runtimeBefore = JSON.parse(await readFile(join(dataDir, "runtime-state.json"), "utf8"));
    const browser = await launchBrowser({ niceAdjustment: 10 });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const sentFrames = [];
      const receivedFrames = [];
      page.on("websocket", (websocket) => {
        websocket.on("framesent", (event) => sentFrames.push(String(event.payload)));
        websocket.on("framereceived", (event) => receivedFrames.push(String(event.payload)));
      });
      await page.goto(runtime.bootstrapUrl, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#project-preparation[data-explicit-path-only='true']", {
        timeout: 90_000,
      });
      await page.locator("#project-path").fill(projectPath);
      await page.locator("#open-project").click();
      await page.waitForSelector("#project-readiness[data-harness-launch-ready='true']", {
        timeout: 90_000,
      });
      const projectId = await page.locator("#project-readiness").getAttribute("data-project-id");
      await page.locator("#open-project-controller").click();
      await page.waitForSelector(
        "#project-focused-controller-session[data-terminal-attachment='read-write']",
        { timeout: 90_000 },
      );
      const panel = page.locator("#project-focused-controller-session");
      const controllerSessionId = await panel.getAttribute("data-session-id");
      const providerSessionId = await panel.getAttribute("data-provider-session-id");
      const enter = async (value) => {
        await page.locator("#project-controller-terminal-output .xterm-helper-textarea").focus();
        await page.keyboard.type(value);
        await page.keyboard.press("Enter");
      };
      await page.waitForFunction(() => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes("Conformance Controller ready"));
      await enter("launch 152 sandcastle/issue-152");
      await page.waitForFunction(() => /Harness run harness-run-[a-f0-9]{24} created/.test(
        document.querySelector("#project-controller-terminal-output")?.textContent ?? "",
      ), undefined, { timeout: 15_000 });
      const controllerOutput = await page.locator("#project-controller-terminal-output")
        .textContent();
      const harnessRunId = /Harness run (harness-run-[a-f0-9]{24}) created/
        .exec(controllerOutput)?.[1];
      assert.match(harnessRunId, /^harness-run-[a-f0-9]{24}$/);
      assert.match(controllerOutput,
        /Recovered the accepted outcome by exact idempotency-key lookup after the launch response timed out/);

      await page.waitForSelector(
        `#harness-run-observation[data-run-id='${harnessRunId}'][data-run-status='succeeded']`,
        { timeout: 90_000 },
      );
      const cursorBeforeRefresh = await page.evaluate(() =>
        JSON.parse(sessionStorage.getItem("sandking.harnessRunCursor")));
      await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.waitForSelector(
        `#project-focused-controller-session[data-session-id='${controllerSessionId}']`
          + `[data-provider-session-id='${providerSessionId}'][data-reconnected='true']`
          + "[data-terminal-attachment='read-write']",
        { timeout: 90_000 },
      );
      await page.waitForSelector(
        `#harness-run-observation[data-run-id='${harnessRunId}'][data-run-status='succeeded']`
          + "[data-observation-mode='resume']",
        { timeout: 90_000 },
      );
      assert.equal(await page.locator("#project-readiness").getAttribute("data-project-id"),
        projectId);

      await page.evaluate((runId) => sessionStorage.setItem(
        "sandking.harnessRunCursor",
        JSON.stringify({ harnessRunId: runId, sequence: 9_999 }),
      ), harnessRunId);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.waitForSelector(
        `#harness-run-observation[data-run-id='${harnessRunId}']`
          + "[data-observation-mode='resync-required']"
          + "[data-resynchronization-reason='cursor_incompatible']",
        { timeout: 90_000 },
      );
      assert.equal(await page.locator("#harness-run-events")
        .getAttribute("data-event-sequences"), "1,2,3,4");

      const [runtimeAfter, controllerState, projectState, runState, audits] = await Promise.all([
        readFile(join(dataDir, "runtime-state.json"), "utf8").then(JSON.parse),
        readFile(join(dataDir, "controller-sessions.json"), "utf8").then(JSON.parse),
        readFile(join(dataDir, "project-registrations.json"), "utf8").then(JSON.parse),
        readFile(join(dataDir, "harness-runs.json"), "utf8").then(JSON.parse),
        readFile(join(dataDir, "audit.jsonl"), "utf8")
          .then((text) => text.trim().split("\n").map((line) => JSON.parse(line))),
      ]);
      assert.deepEqual({ pid: runtimeAfter.pid, runtimeId: runtimeAfter.runtimeId },
        { pid: runtimeBefore.pid, runtimeId: runtimeBefore.runtimeId });
      assert.equal(controllerState.sessions.length, 1);
      assert.equal(projectState.projects.length, 1);
      assert.equal(runState.runs.length, 1);
      assert.equal(runState.launchOutcomes.length, 1);
      assert.equal(runState.runs[0].source, "controller-cli");
      assert.equal("launchRequestId" in runState.runs[0], false);
      const launchOperations = audits.filter((audit) =>
        audit.action === "controller.provider.operation"
        && audit.details.operation === "harness-run.launch");
      const lookups = audits.filter((audit) =>
        audit.action === "controller.provider.operation"
        && audit.details.operation === "harness-run.lookup");
      assert.equal(launchOperations.length, 1);
      assert.equal(lookups.length, 1);
      assert.equal(launchOperations[0].details.idempotencyKeyHash,
        lookups[0].details.idempotencyKeyHash);
      assert.equal(audits.filter((audit) => audit.action === "harness.run.launch"
        && audit.outcome === "accepted").length, 1);
      assert.equal(audits.some((audit) => /launch\.request|harness\.run\.start/.test(
        audit.action,
      )), false);
      await assert.rejects(access(join(dataDir, "launch-requests.json")));
      assert.deepEqual((await readdir(projectPath)).sort(), projectFilesBefore);
      assert.ok(sentFrames.some((frame) => frame.includes(
        `"harnessRunId":"${harnessRunId}","afterSequence":${cursorBeforeRefresh.sequence}`,
      )));
      assert.ok(receivedFrames.some((frame) => frame.includes('"code":"resync-required"')));
      const retainedText = JSON.stringify({ controllerState, projectState, runState, audits });
      assert.doesNotMatch(retainedText, /canonical-reconnect-browser-secret/);
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
