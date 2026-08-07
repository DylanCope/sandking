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

const waitForRetainedRuns = async (dataDir, count) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = await readFile(join(dataDir, "harness-runs.json"), "utf8")
      .then(JSON.parse, () => null);
    if (state?.runs?.length >= count
      && state.runs.slice(0, count).every((run) =>
        ["succeeded", "failed", "cancelled"].includes(run.status))) {
      return state.runs;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("retained_harness_run_timeout");
};

test("Cockpit Launch uses one persistable confirmation and one Host action", async () => {
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
      "--startup-timeout-ms", "60000",
      "--host-mode", "delayed-harness-run-launch-response",
      "--idempotency-key", "harness-run-browser-runtime-start",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const runtime = JSON.parse(stdout);
    const browser = await launchBrowser({ niceAdjustment: 10 });
    try {
      const context = await browser.newContext();
      let page = await context.newPage();
      const sentFrames = [];
      const observeFrames = (candidate) => candidate.on("websocket", (websocket) => {
        websocket.on("framesent", (event) => sentFrames.push(String(event.payload)));
      });
      observeFrames(page);
      const response = await page.goto(runtime.bootstrapUrl, { waitUntil: "domcontentloaded" });
      assert.equal(response?.status(), 200);
      await page.waitForSelector("#project-preparation[data-explicit-path-only='true']", {
        timeout: 90_000,
      });
      await page.locator("#project-path").fill(projectPath);
      await page.locator("#open-project").click();
      await page.waitForSelector("#project-readiness[data-harness-launch-ready='true']", {
        timeout: 90_000,
      });
      const projectId = await page.locator("#project-readiness").getAttribute("data-project-id");
      const projectRevision = Number(await page.locator("#project-readiness")
        .getAttribute("data-project-revision"));
      await page.locator("#harness-launch-issue").fill("152");
      assert.equal(await page.locator("#harness-launch-branch").inputValue(),
        "sandcastle/issue-152");

      await page.locator("#launch-harness").click();
      const dialog = page.locator("#harness-launch-confirmation");
      await dialog.waitFor({ state: "visible" });
      assert.equal(await page.locator("dialog").count(), 1);
      assert.deepEqual(await dialog.locator("button").allTextContents(), ["Yes", "No"]);
      assert.equal(await dialog.locator("label").textContent(), "Don’t show again");
      await page.locator("#harness-launch-confirmation-no").click();
      await assert.rejects(access(join(dataDir, "harness-runs.json")));

      await page.locator("#launch-harness").click();
      await dialog.waitFor({ state: "visible" });

      // Confirmation is optional ceremony, not authority to launch stale state.
      // If the selected Project becomes non-launchable while the dialog is open,
      // Yes must not bypass the Launch control's current readiness contract.
      await page.route("**/projects/open", (route) => route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "harness_preparation_failed",
          project: {
            projectId,
            revision: projectRevision,
            displayName: "selected-project",
            issueWorkflow: { readiness: "ready" },
            checks: [],
            harness: null,
            readiness: {
              issueWorkflow: "ready",
              checks: "ready",
              configuration: "blocked",
              launchRequest: "blocked",
              diagnostics: ["harness_missing"],
            },
            canPrepareLaunchRequest: false,
          },
        }),
      }));
      await page.evaluate(() => document.querySelector("#open-project")?.click());
      await page.waitForSelector("#project-readiness[data-harness-launch-ready='false']");
      assert.equal(await page.locator("#launch-harness").isDisabled(), true);
      await page.locator("#harness-launch-confirmation-yes").click();
      await page.waitForFunction(() => document.querySelector("#harness-launch-feedback")
        ?.textContent?.includes("selected Project is not launch-ready"));
      assert.equal(sentFrames.filter((frame) =>
        frame.includes('"type":"browser.harness-run.launch"')).length, 0);
      assert.equal(await page.evaluate(() =>
        localStorage.getItem("sandking.skipLaunchConfirmation")), null);

      await page.unroute("**/projects/open");
      await page.waitForSelector("#open-project:not([disabled])");
      await page.locator("#open-project").click();
      await page.waitForSelector("#project-readiness[data-harness-launch-ready='true']", {
        timeout: 90_000,
      });
      await page.locator("#launch-harness").click();
      await dialog.waitFor({ state: "visible" });
      await page.locator("#harness-launch-confirmation-skip").check();
      await page.locator("#harness-launch-confirmation-yes").click();

      // A Project can become non-launchable while the Host is still resolving
      // an already accepted launch. The eventual result must not override the
      // selected Project's current readiness and re-enable Launch.
      await page.route("**/projects/open", (route) => route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "harness_preparation_failed",
          project: {
            projectId,
            revision: 1,
            displayName: "selected-project",
            issueWorkflow: { readiness: "ready" },
            checks: [],
            harness: null,
            readiness: {
              issueWorkflow: "ready",
              checks: "ready",
              configuration: "blocked",
              launchRequest: "blocked",
              diagnostics: ["harness_missing"],
            },
            canPrepareLaunchRequest: false,
          },
        }),
      }));
      await page.locator("#open-project").click();
      await page.waitForSelector("#project-readiness[data-harness-launch-ready='false']");
      await page.waitForFunction(() => /Harness run harness-run-[a-f0-9]{24} launched\./
        .test(document.querySelector("#harness-launch-feedback")?.textContent ?? ""));
      assert.equal(await page.locator("#launch-harness").isDisabled(), true);
      await page.unroute("**/projects/open");
      const firstRuns = await waitForRetainedRuns(dataDir, 1);
      const firstRun = firstRuns[0];
      assert.equal(firstRun.projectId, projectId);
      assert.equal(firstRun.source, "cockpit");
      assert.equal(firstRun.controllerSessionId, null);
      assert.equal("launchRequestId" in firstRun, false);

      await page.waitForSelector(
        `#harness-run-observation[data-run-id='${firstRun.harnessRunId}'][data-run-status='succeeded']`,
        { timeout: 15_000 },
      );
      assert.equal(await page.locator("#harness-terminal-validation")
        .getAttribute("data-exactly-one-terminal"), "true");
      assert.equal(await page.locator("#harness-run-structured-outcome")
        .getAttribute("data-outcome-status"), "succeeded");

      // A new page in the same browser session retains the explicit preference
      // and launches immediately without presenting another dialog.
      await page.close();
      page = await context.newPage();
      observeFrames(page);
      await page.goto(new URL(runtime.bootstrapUrl).origin, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#launch-harness:not([disabled])", { timeout: 90_000 });
      await page.locator("#harness-launch-issue").fill("152");
      await page.locator("#launch-harness").click();
      assert.equal(await page.locator("#harness-launch-confirmation").isVisible(), false);
      await page.waitForFunction(() => /Harness run harness-run-[a-f0-9]{24} launched\./
        .test(document.querySelector("#harness-launch-feedback")?.textContent ?? ""));
      await waitForRetainedRuns(dataDir, 2);

      const launchFrames = sentFrames.filter((frame) =>
        frame.includes('"type":"browser.harness-run.launch"'));
      assert.equal(launchFrames.length, 2);
      for (const frame of launchFrames) {
        assert.doesNotMatch(frame, /expectedRevision|approve|prepare|launchRequest/);
      }
      await assert.rejects(access(join(dataDir, "launch-requests.json")));
      const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      const launchAudits = audits.filter((audit) => audit.action === "harness.run.launch"
        && audit.outcome === "accepted");
      assert.equal(launchAudits.length, 2);
      assert.ok(launchAudits.every((audit) => audit.details.source === "cockpit"));
      assert.equal(audits.some((audit) => /launch\.request|approval/.test(audit.action)), false);
      assert.deepEqual((await readdir(projectPath)).sort(), projectFilesBefore);
      const retainedText = `${JSON.stringify(firstRuns)}\n${JSON.stringify(audits)}`;
      assert.doesNotMatch(retainedText, /harness-run-browser-secret/);
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
