import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { launchBrowser } from "./browser-launch.mjs";
import { installCurrentPackage } from "./installed-package.mjs";

const execFileAsync = promisify(execFile);

const waitForRetainedRuns = async (dataDir, expectedCount) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(join(dataDir, "harness-runs.json"), "utf8"));
      if (state.runs.length === expectedCount) return state.runs;
    } catch {
      // The durable run store is created lazily.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("retained_production_harness_run_timeout");
};

test("ordinary Cockpit Project registration defaults to the production Sandcastle Harness", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-registration-browser-"));
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
  await writeFile(join(projectPath, "sandcastle.worker-fixture.json"), `${JSON.stringify({
    schemaVersion: 1,
    provider: { kind: "controlled-worker-fixture", ready: false },
    scenario: "succeeded",
  }, null, 2)}\n`);
  await execFileAsync("git", ["-C", projectPath, "add", "--all"]);
  await execFileAsync("git", [
    "-C", projectPath,
    "-c", "user.name=Project Fixture",
    "-c", "user.email=project-fixture@sandking.invalid",
    "-c", "commit.gpgSign=false",
    "commit", "--quiet", "-m", "Initialize disposable Project",
  ]);
  const projectFilesBefore = (await readdir(projectPath)).sort();
  const installed = await installCurrentPackage(root);
  const environment = { ...process.env, HOME: userHome };
  let browser;

  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--startup-timeout-ms", "60000",
      "--idempotency-key", "production-registration-browser-runtime",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: environment });
    const runtime = JSON.parse(stdout);
    browser = await launchBrowser({ niceAdjustment: 10 });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(runtime.bootstrapUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#project-preparation[data-explicit-path-only='true']", {
      timeout: 90_000,
    });
    const selector = page.locator("#project-harness-adapter");
    assert.equal(await selector.inputValue(), "sandcastle-harness-adapter-v1");
    assert.deepEqual(await selector.locator("option").evaluateAll((options) =>
      options.map((option) => ({ value: option.value, text: option.textContent }))), [
      {
        value: "sandcastle-harness-adapter-v1",
        text: "Sand-King Sandcastle Harness (production default)",
      },
      {
        value: "conformance-harness-adapter-v1",
        text: "Sand-King Conformance Harness (deterministic conformance)",
      },
    ]);

    await page.locator("#project-path").fill(projectPath);
    await page.locator("#open-project").click();
    await page.waitForSelector(
      "#project-readiness[data-harness-launch-ready='true']"
        + "[data-harness-adapter-id='sandcastle-harness-adapter-v1']",
      { timeout: 90_000 },
    );
    const readiness = page.locator("#project-readiness");
    const projectId = await readiness.getAttribute("data-project-id");
    const harnessId = await readiness.getAttribute("data-harness-id");
    const pinnedRevision = await readiness.getAttribute("data-harness-pin");
    assert.match(projectId, /^project-[a-f0-9]{24}$/);
    assert.match(harnessId, /^harness-[a-f0-9]{24}$/);
    assert.match(pinnedRevision, /^[a-f0-9]{40}$/);
    assert.match(
      await readiness.getAttribute("data-harness-skill-lock"),
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.match(
      await readiness.getAttribute("data-harness-projection-digest"),
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.match(
      await readiness.getAttribute("data-harness-resolved-skills"),
      /sandking\.issue-implementation@[a-f0-9]{40}/,
    );
    assert.match(await page.locator("#project-feedback").textContent(),
      /Sand-King Sandcastle Harness are ready to launch/);
    assert.match(await readiness.textContent(), /Production preparation: ready/);
    assert.match(await readiness.textContent(), /openai\.codex-cli@0\.146\.0/);

    const reopenResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith("/projects/open"));
    await page.locator("#open-project").click();
    const reopenResponse = await reopenResponsePromise;
    const reopenOutcome = await reopenResponse.json();
    assert.equal(reopenResponse.status(), 200);
    assert.equal(reopenOutcome.code, "project_ready");
    assert.equal(reopenOutcome.project.projectId, projectId);
    assert.equal(reopenOutcome.project.harness.harnessId, harnessId);
    assert.equal(reopenOutcome.project.harness.pinnedRevision, pinnedRevision);
    assert.equal(reopenOutcome.project.readiness.launchRequest, "ready");
    assert.equal(reopenOutcome.project.harness.preparation.status, "ready");

    assert.equal(await page.locator("#harness-launch-parameter-issueNumber").count(), 1);
    assert.equal(await page.locator("#harness-launch-parameter-targetBranch").count(), 1);
    await page.locator("#launch-harness").click();
    await page.locator("#harness-launch-confirmation-yes").click();
    await page.waitForFunction(() => document.querySelector("#harness-launch-feedback")
      ?.textContent?.includes("harness_worker_provider_unavailable"));
    assert.equal((await waitForRetainedRuns(dataDir, 0)).length, 0);

    await writeFile(join(projectPath, "sandcastle.worker-fixture.json"), `${JSON.stringify({
      schemaVersion: 1,
      provider: { kind: "controlled-worker-fixture", ready: true },
      scenario: "succeeded",
    }, null, 2)}\n`);
    await execFileAsync("git", ["-C", projectPath, "add", "sandcastle.worker-fixture.json"]);
    await execFileAsync("git", [
      "-C", projectPath,
      "-c", "user.name=Project Fixture",
      "-c", "user.email=project-fixture@sandking.invalid",
      "-c", "commit.gpgSign=false",
      "commit", "--quiet", "-m", "Enable controlled Worker provider",
    ]);

    await page.locator("#launch-harness").click();
    await page.locator("#harness-launch-confirmation-yes").click();
    const [acceptedProductionRun] = await waitForRetainedRuns(dataDir, 1);
    await page.waitForSelector(
      `#harness-run-observation[data-run-id='${acceptedProductionRun.harnessRunId}']`
        + "[data-run-status='succeeded']",
      { timeout: 20_000 },
    );
    const [productionRun] = await waitForRetainedRuns(dataDir, 1);
    assert.equal(productionRun.status, "succeeded");
    assert.equal(productionRun.adapterId, "sandcastle-harness-adapter-v1");
    assert.deepEqual(productionRun.parameters, {});
    assert.equal(productionRun.outcome.code, "harness_run_succeeded");
    assert.equal(productionRun.terminalEnvelopeValidation.exactlyOne, true);
    assert.deepEqual(productionRun.executionSnapshot.productionHarness, {
      skillSetLockDigest: reopenOutcome.project.harness.preparation.skillSetLockDigest,
      resolvedSkills: reopenOutcome.project.harness.preparation.resolvedSkills,
      executionRuntimeInputs: reopenOutcome.project.harness.preparation.executionRuntimeInputs,
      projectionDigest: reopenOutcome.project.harness.preparation.projection.digest,
    });
    const executionFacts = page.locator("#harness-run-execution-snapshot");
    assert.equal(
      await executionFacts.getAttribute("data-production-skill-lock"),
      productionRun.executionSnapshot.productionHarness.skillSetLockDigest,
    );
    assert.equal(
      await executionFacts.getAttribute("data-production-projection-digest"),
      productionRun.executionSnapshot.productionHarness.projectionDigest,
    );
    assert.match(await executionFacts.textContent(), /Resolved production skills:/);
    assert.match(await executionFacts.textContent(), /Production runtime inputs:/);
    assert.equal(await page.locator("#harness-run-launch-parameters").textContent(), "{}");

    const projectState = JSON.parse(await readFile(
      join(dataDir, "project-registrations.json"),
      "utf8",
    ));
    const harnessState = JSON.parse(await readFile(
      join(dataDir, "harness-registry.json"),
      "utf8",
    ));
    assert.equal(projectState.projects.length, 1);
    assert.equal(projectState.projects[0].harness.adapterId, "sandcastle-harness-adapter-v1");
    assert.equal(projectState.projects[0].harness.pinnedRevision, pinnedRevision);
    const preparation = projectState.projects[0].harness.preparation;
    assert.equal(preparation.status, "ready");
    assert.equal(preparation.harness.harnessId, harnessId);
    assert.equal(preparation.harness.pinnedRevision, pinnedRevision);
    assert.deepEqual(preparation.resolvedSkills.map(({ identity }) => identity), [
      "sandking.issue-implementation",
      "sandking.issue-planning",
      "sandking.pull-request-review",
      "sandking.real-delegation",
    ]);
    assert.equal(harnessState.harnesses.length, 1);
    assert.equal(harnessState.harnesses[0].kind, "production");
    assert.equal(harnessState.harnesses[0].immutableRevision, pinnedRevision);
    assert.match(relative(dataDir, harnessState.harnesses[0].workspacePath), /^\.\./);
    assert.equal(
      (await execFileAsync("git", [
        "-C", harnessState.harnesses[0].workspacePath, "rev-parse", "HEAD",
      ])).stdout.trim(),
      pinnedRevision,
    );
    assert.deepEqual((await readdir(projectPath)).sort(), [
      ...projectFilesBefore,
      ".sandking",
    ].sort());
    assert.equal((await readdir(projectPath)).includes(".sandcastle"), false);
    const projectionPath = join(projectPath, ...preparation.projection.path.split("/"));
    assert.equal(
      (await execFileAsync("git", [
        "-C", projectPath,
        "check-ignore", "--no-index", "--quiet",
        join(projectionPath, "worker-environment.json"),
      ])).stderr,
      "",
    );
    assert.equal(
      (await execFileAsync("git", ["-C", projectPath, "status", "--porcelain=v1"])).stdout,
      "",
    );
    await context.close();
    await browser.close();

    const stopped = JSON.parse((await execFileAsync(installed.command, [
      "stop", "--data-dir", dataDir, "--json",
    ], { cwd: executionDirectory, env: environment })).stdout);
    assert.equal(stopped.stopped, true);
    const restartedRuntime = JSON.parse((await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--startup-timeout-ms", "60000",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: environment })).stdout);
    assert.notEqual(restartedRuntime.runtime.runtimeId, runtime.runtime.runtimeId);
    assert.equal(restartedRuntime.host.hostId, runtime.host.hostId);

    browser = await launchBrowser({ niceAdjustment: 10 });
    const restartedContext = await browser.newContext();
    const restartedPage = await restartedContext.newPage();
    await restartedPage.goto(restartedRuntime.bootstrapUrl, { waitUntil: "domcontentloaded" });
    await restartedPage.waitForSelector(
      "#project-preparation[data-explicit-path-only='true']",
      { timeout: 90_000 },
    );
    await restartedPage.locator("#project-path").fill(projectPath);
    const restartedReopenResponsePromise = restartedPage.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith("/projects/open"));
    await restartedPage.locator("#open-project").click();
    const restartedReopenResponse = await restartedReopenResponsePromise;
    const restartedReopenOutcome = await restartedReopenResponse.json();
    assert.equal(
      restartedReopenResponse.status(),
      200,
      JSON.stringify(restartedReopenOutcome),
    );
    assert.equal(restartedReopenOutcome.code, "project_ready");
    await restartedPage.waitForSelector(
      `#project-readiness[data-project-id='${projectId}']`
        + "[data-harness-launch-ready='true']"
        + `[data-harness-id='${harnessId}']`
        + `[data-harness-pin='${pinnedRevision}']`,
      { timeout: 90_000 },
    );
    assert.match(
      await restartedPage.locator("#project-feedback").textContent(),
      /Sand-King Sandcastle Harness are ready to launch/,
    );
    await restartedPage.waitForSelector(
      `#harness-run-observation[data-run-id='${productionRun.harnessRunId}']`
        + "[data-run-status='succeeded']",
      { timeout: 20_000 },
    );
    assert.equal(
      await restartedPage.locator("#harness-run-execution-snapshot")
        .getAttribute("data-production-projection-digest"),
      productionRun.executionSnapshot.productionHarness.projectionDigest,
    );
    await restartedContext.close();
  } finally {
    await browser?.close().catch(() => undefined);
    await execFileAsync(installed.command, [
      "stop", "--data-dir", dataDir, "--json",
    ], { cwd: executionDirectory, env: environment }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("production registration rejects a Project overlapping Host-private Harness workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-workspace-isolation-browser-"));
  const dataDir = join(root, "host-state");
  const executionDirectory = join(root, "outside-project");
  const userHome = join(root, "user-home");
  const projectPath = `${dataDir}-harness-workspaces`;
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(executionDirectory, { recursive: true }),
    mkdir(userHome, { recursive: true }),
    execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]),
  ]);
  await writeFile(join(projectPath, "README.md"), "ordinary Project content\n");
  await execFileAsync("git", ["-C", projectPath, "add", "README.md"]);
  await execFileAsync("git", [
    "-C", projectPath,
    "-c", "user.name=Project Fixture",
    "-c", "user.email=project-fixture@sandking.invalid",
    "commit", "--quiet", "-m", "Initialize Project fixture",
  ]);
  const projectFilesBefore = (await readdir(projectPath)).sort();
  const installed = await installCurrentPackage(root);
  const environment = { ...process.env, HOME: userHome };
  let browser;

  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--startup-timeout-ms", "60000",
      "--idempotency-key", "production-workspace-isolation-runtime",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: environment });
    const runtime = JSON.parse(stdout);
    browser = await launchBrowser({ niceAdjustment: 10 });
    const page = await browser.newPage();
    await page.goto(runtime.bootstrapUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#project-preparation[data-explicit-path-only='true']", {
      timeout: 90_000,
    });
    await page.locator("#project-path").fill(projectPath);
    const responsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith("/projects/open"));
    await page.locator("#open-project").click();
    const response = await responsePromise;
    const outcome = { status: response.status(), body: await response.json() };

    assert.equal(outcome.status, 400);
    assert.equal(outcome.body.type, "project.operation.failure");
    assert.equal(outcome.body.operation, "project.inspect");
    assert.equal(outcome.body.code, "project_path_invalid");
    assert.equal(outcome.body.prohibitedSideEffects.projectFileWrite, false);
    assert.equal(outcome.body.prohibitedSideEffects.harnessWorkspaceWrite, false);
    assert.deepEqual((await readdir(projectPath)).sort(), projectFilesBefore);
    assert.equal(
      (await execFileAsync("git", ["-C", projectPath, "status", "--short"])).stdout,
      "",
    );
    await assert.rejects(readFile(join(dataDir, "project-registrations.json"), "utf8"));
    await assert.rejects(readFile(join(dataDir, "harness-registry.json"), "utf8"));
  } finally {
    await browser?.close().catch(() => undefined);
    await execFileAsync(installed.command, [
      "stop", "--data-dir", dataDir, "--json",
    ], { cwd: executionDirectory, env: environment }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid production seed rejects the composite without tracking a Project", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-production-seed-failure-browser-"));
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
  const installed = await installCurrentPackage(root);
  const seedRoot = join(installed.packageDirectory, "src", "bundled-production-harness");
  const provenancePath = join(seedRoot, "provenance.json");
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  provenance.sandcastle.revision = "f".repeat(40);
  const provenanceSource = `${JSON.stringify(provenance, null, 2)}\n`;
  await writeFile(provenancePath, provenanceSource);
  const manifestPath = join(seedRoot, "seed-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files.find((file) => file.path === "provenance.json").integrity =
    `sha256:${createHash("sha256").update(provenanceSource).digest("hex")}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const environment = { ...process.env, HOME: userHome };
  let browser;

  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--startup-timeout-ms", "60000",
      "--idempotency-key", "production-seed-failure-runtime",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: environment });
    const runtime = JSON.parse(stdout);
    browser = await launchBrowser({ niceAdjustment: 10 });
    const page = await browser.newPage();
    await page.goto(runtime.bootstrapUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#project-preparation[data-explicit-path-only='true']", {
      timeout: 90_000,
    });
    await page.locator("#project-path").fill(projectPath);
    const responsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith("/projects/open"));
    await page.locator("#open-project").click();
    const response = await responsePromise;
    const outcome = { status: response.status(), body: await response.json() };
    assert.equal(outcome.status, 409);
    assert.equal(outcome.body.type, "project.operation.failure");
    assert.equal(outcome.body.operation, "harness.sandcastle.register");
    assert.equal(outcome.body.code, "harness_seed_provenance_invalid");

    const projectState = await readFile(
      join(dataDir, "project-registrations.json"),
      "utf8",
    ).then(JSON.parse, (error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    const harnessState = await readFile(
      join(dataDir, "harness-registry.json"),
      "utf8",
    ).then(JSON.parse, (error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    assert.equal(projectState?.projects.length ?? 0, 0);
    assert.equal(harnessState?.harnesses.length ?? 0, 0);
    assert.deepEqual(
      await readdir(`${dataDir}-harness-workspaces`)
        .catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error)),
      [],
    );
  } finally {
    await browser?.close().catch(() => undefined);
    await execFileAsync(installed.command, [
      "stop", "--data-dir", dataDir, "--json",
    ], { cwd: executionDirectory, env: environment }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
