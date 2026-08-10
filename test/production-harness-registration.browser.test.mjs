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
    assert.match(await page.locator("#project-feedback").textContent(),
      /Sand-King Sandcastle Harness are ready to launch/);

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
    assert.deepEqual((await readdir(projectPath)).sort(), projectFilesBefore);
    assert.equal((await readdir(projectPath)).includes(".sandcastle"), false);
    await context.close();
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
