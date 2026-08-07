import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createProjectRegistry } from "../src/project-registration.mjs";
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
      assert.equal(await page.locator("#harness-launch-parameters")
        .getAttribute("data-parameter-count"), "2");
      assert.deepEqual(
        await page.locator("#harness-launch-parameters > label").allTextContents(),
        ["Issue number", "Target branch"],
      );
      assert.deepEqual(await page.evaluate(async () => {
        const { renderHarnessLaunchParameterFields } = await import(
          "/cockpit-launch-parameters.mjs"
        );
        const empty = renderHarnessLaunchParameterFields(document, { kind: "none" });
        document.body.append(empty);
        const result = {
          kind: empty.dataset.parameterKind,
          count: empty.dataset.parameterCount,
          inputs: empty.querySelectorAll("input, select").length,
        };
        empty.remove();
        return result;
      }), { kind: "none", count: "0", inputs: 0 });
      await page.locator("#harness-launch-parameter-issueNumber").fill("152");
      await page.locator("#harness-launch-parameter-targetBranch")
        .fill("sandcastle/issue-152");

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
      assert.deepEqual(firstRun.parameters, {});
      assert.equal("launchRequestId" in firstRun, false);
      assert.equal(firstRun.executionSnapshot.capture, "launch");
      assert.equal(firstRun.executionSnapshot.projectRegistration.projectId, projectId);
      assert.equal(firstRun.executionSnapshot.projectRegistration.revision, 2);
      assert.equal(firstRun.executionSnapshot.projectRegistration.displayName, "selected-project");
      assert.equal(firstRun.executionSnapshot.harness.pinnedRevision,
        firstRun.harnessPinnedRevision);
      assert.deepEqual(firstRun.executionSnapshot.parameters, {});
      assert.deepEqual(firstRun.executionSnapshot.credentialCapabilityReferences, [
        "github.issues.read",
        "project.git.read",
      ]);

      await page.waitForSelector(
        `#harness-run-observation[data-run-id='${firstRun.harnessRunId}'][data-run-status='succeeded']`,
        { timeout: 15_000 },
      );
      const executionFacts = page.locator("#harness-run-execution-snapshot");
      assert.equal(await executionFacts.getAttribute("data-launch-time"),
        firstRun.createdAt);
      assert.equal(await executionFacts.getAttribute("data-project-registration-revision"), "2");
      assert.equal(await executionFacts.getAttribute("data-adapter-id"), firstRun.adapterId);
      assert.equal(await executionFacts.getAttribute("data-adapter-protocol"),
        firstRun.adapterProtocol);
      assert.equal(await executionFacts.getAttribute("data-adapter-entry-point"),
        firstRun.adapterEntryPoint);
      assert.match(await executionFacts.textContent(), /Immutable execution facts/);
      assert.equal(await page.locator("#harness-run-launch-parameters").textContent(), "{}");
      assert.equal(await page.locator("#harness-run-events").getAttribute("data-event-count"), "4");
      assert.equal(await page.locator("[data-log-producer='stdout']")
        .getAttribute("data-range-end"), String(firstRun.logStreams[0].availableEnd));
      assert.equal(await page.locator("#harness-terminal-validation")
        .getAttribute("data-exactly-one-terminal"), "true");
      assert.equal(await page.locator("#harness-run-structured-outcome")
        .getAttribute("data-outcome-status"), "succeeded");

      // Emulate a response lost after Host commit by restoring the Cockpit's
      // hidden retry plumbing and reloading. The exact same hash/content must
      // reconnect to the retained launch rather than create or start another run.
      const firstLaunchFrame = sentFrames.find((frame) =>
        frame.includes('"type":"browser.harness-run.launch"'));
      const firstLaunchMessage = JSON.parse(firstLaunchFrame).message;
      await page.evaluate((pending) => {
        sessionStorage.setItem("sandking.pendingHarnessLaunch", JSON.stringify(pending));
      }, {
        projectId: firstLaunchMessage.projectId,
        parameters: firstLaunchMessage.parameters ?? {},
        idempotencyKeyHash: firstLaunchMessage.idempotencyKeyHash,
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => /Harness run harness-run-[a-f0-9]{24} launched\./
        .test(document.querySelector("#harness-launch-feedback")?.textContent ?? ""));
      assert.equal((await waitForRetainedRuns(dataDir, 1)).length, 1);
      assert.equal(await page.evaluate(() =>
        sessionStorage.getItem("sandking.pendingHarnessLaunch")), null);
      const replayFrames = sentFrames.filter((frame) =>
        frame.includes('"type":"browser.harness-run.launch"')).map((frame) =>
        JSON.parse(frame).message);
      assert.equal(replayFrames.length, 2);
      assert.equal(replayFrames[1].idempotencyKeyHash,
        replayFrames[0].idempotencyKeyHash);
      assert.deepEqual(replayFrames[1].parameters ?? {}, replayFrames[0].parameters ?? {});

      // A new page in the same browser session retains the explicit preference
      // and launches immediately without presenting another dialog.
      await page.close();
      page = await context.newPage();
      observeFrames(page);
      await page.goto(new URL(runtime.bootstrapUrl).origin, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#launch-harness:not([disabled])", { timeout: 90_000 });
      await page.locator("#harness-launch-parameter-issueNumber").fill("999999993");
      await page.locator("#harness-launch-parameter-targetBranch")
        .fill("sandcastle/issue-999999993");
      await page.locator("#launch-harness").click();
      assert.equal(await page.locator("#harness-launch-confirmation").isVisible(), false);
      await page.waitForFunction(() => /Harness run harness-run-[a-f0-9]{24} launched\./
        .test(document.querySelector("#harness-launch-feedback")?.textContent ?? ""));
      const secondLaunchFeedback = await page.locator("#harness-launch-feedback").textContent();
      const secondHarnessRunId = /Harness run (harness-run-[a-f0-9]{24}) launched\./
        .exec(secondLaunchFeedback)?.[1];
      assert.match(secondHarnessRunId, /^harness-run-[a-f0-9]{24}$/);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(
        `#harness-run-observation[data-run-id='${secondHarnessRunId}']`,
        { timeout: 15_000 },
      );
      await page.waitForSelector("#cancel-harness-run:not([disabled])", { timeout: 15_000 });
      assert.equal(sentFrames.filter((frame) =>
        frame.includes('"type":"browser.harness-run.cancel"')).length, 0);
      assert.equal(sentFrames.filter((frame) =>
        frame.includes('"type":"browser.harness-run.launch"')).length, 3);
      await page.locator("#cancel-harness-run").click();
      await page.waitForFunction(() => /Cancellation accepted/
        .test(document.querySelector("#harness-run-cancellation-feedback")?.textContent ?? ""));
      const cancellationFrame = sentFrames.find((frame) =>
        frame.includes('"type":"browser.harness-run.cancel"'));
      const cancellationMessage = JSON.parse(cancellationFrame).message;
      assert.equal("idempotencyKey" in cancellationMessage, false);
      assert.match(cancellationMessage.idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);

      // Closing the tab after durable acceptance is observation-only. A fresh
      // tab reconnects to the same run and its one truthful terminal outcome.
      await page.close();
      page = await context.newPage();
      observeFrames(page);
      await page.goto(new URL(runtime.bootstrapUrl).origin, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(
        `#harness-run-observation[data-run-id='${cancellationMessage.harnessRunId}'][data-run-status='cancelled']`,
        { timeout: 15_000 },
      );
      const retainedRuns = await waitForRetainedRuns(dataDir, 2);
      assert.deepEqual(retainedRuns[1].parameters, {
        issueNumber: 999_999_993,
        targetBranch: "sandcastle/issue-999999993",
      });
      assert.equal(retainedRuns[1].status, "cancelled");
      assert.equal(retainedRuns[1].events.filter((event) =>
        event.type === "harness_run_cancellation_accepted").length, 1);
      assert.equal(retainedRuns[1].events.filter((event) =>
        event.type === "harness_run_cancelled").length, 1);

      // Restore only the hidden hash/content as if the accepted response were
      // lost. Reload must replay the original cancellation without another event.
      await page.evaluate((pending) => {
        sessionStorage.setItem("sandking.pendingHarnessCancellation", JSON.stringify(pending));
      }, {
        harnessRunId: cancellationMessage.harnessRunId,
        idempotencyKeyHash: cancellationMessage.idempotencyKeyHash,
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() =>
        sessionStorage.getItem("sandking.pendingHarnessCancellation") === null);
      const cancellationFrames = sentFrames.filter((frame) =>
        frame.includes('"type":"browser.harness-run.cancel"')).map((frame) =>
        JSON.parse(frame).message);
      assert.equal(cancellationFrames.length, 2);
      assert.equal(cancellationFrames[1].idempotencyKeyHash,
        cancellationFrames[0].idempotencyKeyHash);
      assert.equal(cancellationFrames[1].harnessRunId,
        cancellationFrames[0].harnessRunId);
      const replayedRuns = await waitForRetainedRuns(dataDir, 2);
      assert.equal(replayedRuns[1].events.length, retainedRuns[1].events.length);

      const launchFrames = sentFrames.filter((frame) =>
        frame.includes('"type":"browser.harness-run.launch"'));
      assert.equal(launchFrames.length, 3);
      assert.equal(launchFrames.some((frame) => frame.includes('"parameters"')), true);
      assert.equal(launchFrames.some((frame) => !frame.includes('"parameters"')), true);
      for (const frame of launchFrames) {
        assert.doesNotMatch(frame, /expectedRevision|approve|prepare|launchRequest/);
        assert.doesNotMatch(frame, /"idempotencyKey":/);
        assert.match(frame, /"idempotencyKeyHash":"sha256:[a-f0-9]{64}"/);
      }
      await assert.rejects(access(join(dataDir, "launch-requests.json")));
      const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      const launchAudits = audits.filter((audit) => audit.action === "harness.run.launch"
        && audit.outcome === "accepted");
      assert.equal(launchAudits.length, 2);
      assert.ok(launchAudits.every((audit) => audit.details.source === "cockpit"));
      const cancellationAudits = audits.filter((audit) =>
        audit.action === "harness.run.cancel" && audit.outcome === "accepted");
      assert.equal(cancellationAudits.length, 1);
      assert.match(cancellationAudits[0].details.idempotencyKeyHash,
        /^sha256:[a-f0-9]{64}$/);
      assert.equal(audits.some((audit) => /launch\.request|approval/.test(audit.action)), false);
      assert.deepEqual((await readdir(projectPath)).sort(), projectFilesBefore);
      const retainedText = [
        JSON.stringify(firstRuns),
        JSON.stringify(audits),
        JSON.stringify(sentFrames),
        await page.locator("body").textContent(),
      ].join("\n");
      assert.doesNotMatch(retainedText, /harness-run-browser-secret/);
      assert.doesNotMatch(await page.locator("body").textContent(),
        /idempotencyKey|sha256:[a-f0-9]{64}/);
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

test("Cockpit Launch renders no fields for a focused Harness that declares none", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-empty-harness-form-browser-"));
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
  let auditSequence = 0;
  const registry = await createProjectRegistry({
    dataDir,
    recordAudit: async () => {
      auditSequence += 1;
      return `audit-${String(auditSequence).padStart(24, "0")}`;
    },
  });
  const harness = await registry.registerConformanceHarness({
    requestId: "register-empty-form-harness",
    name: "Sand-King Conformance Harness",
    authorizationClass: "host_local_harness_registration",
    idempotencyKey: "register-empty-form-harness",
    expectedRevision: 0,
  });

  const harnessStatePath = join(dataDir, "harness-registry.json");
  const harnessState = JSON.parse(await readFile(harnessStatePath, "utf8"));
  const workspacePath = harnessState.harnesses[0].workspacePath;
  const adapterPath = join(workspacePath, "adapters", "conformance.mjs");
  const adapterSource = await readFile(adapterPath, "utf8");
  const noParameterSource = adapterSource.replace(
    /^const launchParameters = .*;$/m,
    'const launchParameters = {"kind":"none"};',
  );
  assert.notEqual(noParameterSource, adapterSource);
  await writeFile(adapterPath, noParameterSource, { mode: 0o700 });
  await execFileAsync("git", ["-C", workspacePath, "add", "--", "adapters/conformance.mjs"]);
  await execFileAsync("git", [
    "-C", workspacePath,
    "-c", "user.name=Sand-King Conformance",
    "-c", "user.email=conformance@sandking.invalid",
    "-c", "commit.gpgSign=false",
    "commit", "--quiet", "-m", "Declare no launch parameters",
  ]);
  const { stdout: noneRevisionOutput } = await execFileAsync(
    "git",
    ["-C", workspacePath, "rev-parse", "HEAD"],
  );
  const noneRevision = noneRevisionOutput.trim();
  harnessState.harnesses[0].immutableRevision = noneRevision;
  harnessState.harnesses[0].launchParameters = { kind: "none" };
  harnessState.harnesses[0].workspace.headRevision = noneRevision;
  await writeFile(harnessStatePath, `${JSON.stringify(harnessState, null, 2)}\n`);

  const installed = await installCurrentPackage(root);
  const productEnvironment = {
    ...process.env,
    HOME: userHome,
    SANDKING_CONTROLLER_SECRET: "empty-harness-form-browser-secret",
  };
  let browser;
  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--startup-timeout-ms", "60000",
      "--idempotency-key", "empty-harness-form-runtime-start",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const runtime = JSON.parse(stdout);
    browser = await launchBrowser({ niceAdjustment: 10 });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(runtime.bootstrapUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#project-preparation[data-explicit-path-only='true']", {
      timeout: 90_000,
    });
    await page.locator("#project-path").fill(projectPath);
    await page.locator("#open-project").click();
    await page.waitForSelector(
      "#project-readiness[data-harness-launch-ready='true']",
      { timeout: 90_000 },
    );
    const projectId = await page.locator("#project-readiness").getAttribute("data-project-id");
    assert.match(projectId, /^project-[a-f0-9]{24}$/);
    const parameters = page.locator("#harness-launch-parameters");
    assert.equal(await parameters.getAttribute("data-parameter-kind"), "none");
    assert.equal(await parameters.getAttribute("data-parameter-count"), "0");
    assert.equal(await parameters.locator("input, select, label").count(), 0);

    await page.locator("#launch-harness").click();
    await page.locator("#harness-launch-confirmation").waitFor({ state: "visible" });
    await page.locator("#harness-launch-confirmation-yes").click();
    await page.waitForFunction(() => /Harness run harness-run-[a-f0-9]{24} launched\./
      .test(document.querySelector("#harness-launch-feedback")?.textContent ?? ""));
    const [run] = await waitForRetainedRuns(dataDir, 1);
    assert.equal(run.projectId, projectId);
    assert.equal(run.harnessPinnedRevision, noneRevision);
    assert.equal(run.status, "succeeded");
    assert.equal(run.source, "cockpit");
    assert.deepEqual(run.parameters, {});
    await context.close();
  } finally {
    await browser?.close().catch(() => undefined);
    await execFileAsync(installed.command, [
      "stop", "--data-dir", dataDir, "--json",
    ], { cwd: executionDirectory, env: productEnvironment }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
