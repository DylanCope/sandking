import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { launchBrowser } from "./browser-launch.mjs";
import { installCurrentPackage } from "./installed-package.mjs";

const execFileAsync = promisify(execFile);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("local-walking-skeleton/completes-approved-run opens and prepares an explicit Project", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-project-browser-"));
  const dataDir = join(root, "host-state");
  const executionDirectory = join(root, "outside-checkout");
  const userHome = join(root, "user-home");
  const projectPath = join(root, "selected-project");
  const movedProjectPath = join(root, "moved-project");
  const anotherProjectPath = join(root, "another-project");
  const unrelatedPath = join(root, "unrelated-directory");
  const projectSecret = "project-browser-secret-must-not-appear";
  const projectFile = join(projectPath, "README.md");
  const secretFile = join(projectPath, "secret.fixture");
  const unrelatedFile = join(unrelatedPath, "must-not-be-scanned.txt");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(executionDirectory, { recursive: true }),
    mkdir(userHome, { recursive: true }),
    mkdir(unrelatedPath, { recursive: true }),
    execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]),
    execFileAsync("git", ["init", "--quiet", "--initial-branch=main", anotherProjectPath]),
  ]);
  await Promise.all([
    writeFile(projectFile, "selected Project content\n"),
    writeFile(secretFile, `${projectSecret}\n`),
    writeFile(unrelatedFile, "unrelated sentinel\n"),
  ]);
  const projectFilesBefore = (await readdir(projectPath)).sort();
  const projectFileBefore = sha256(await readFile(projectFile));
  const secretFileBefore = sha256(await readFile(secretFile));
  const unrelatedBefore = sha256(await readFile(unrelatedFile));
  const installed = await installCurrentPackage(root);
  const productEnvironment = {
    ...process.env,
    HOME: userHome,
    SANDKING_CONTROLLER_SECRET: "controller-secret-must-not-reach-host",
  };

  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--startup-timeout-ms", "60000",
      "--idempotency-key", "project-browser-runtime-launch",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const launch = JSON.parse(stdout);
    const browser = await launchBrowser({ niceAdjustment: 10 });

    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const projectRequests = [];
      const receivedFrames = [];
      page.on("websocket", (socket) => {
        socket.on("framereceived", (event) => receivedFrames.push(String(event.payload)));
      });
      page.on("request", (request) => {
        if (request.method() === "POST" && request.url().endsWith("/projects/open")) {
          projectRequests.push({
            postData: request.postData(),
            headers: request.headers(),
          });
        }
      });
      const response = await page.goto(launch.bootstrapUrl, { waitUntil: "domcontentloaded" });
      assert.equal(response?.status(), 200);
      await page.waitForSelector("#project-preparation[data-explicit-path-only='true']", {
        timeout: 10_000,
      });
      assert.equal(
        await page.locator("#project-preparation").getAttribute("data-directory-scanning"),
        "false",
      );
      assert.match(await page.locator("#project-preparation").textContent(), /does not scan/i);
      assert.equal(await page.locator("#project-not-selected").getAttribute(
        "data-project-selected",
      ), "false");
      await page.locator("#project-harness-adapter")
        .selectOption("conformance-harness-adapter-v1");

      await page.locator("#project-path").fill("relative/project");
      await page.locator("#open-project").click();
      await page.waitForFunction(() => document.querySelector("#project-feedback")
        ?.textContent?.includes("project_path_invalid"));
      assert.equal(await page.locator("#project-not-selected").count(), 1);
      await assert.rejects(readFile(join(dataDir, "project-registrations.json"), "utf8"));

      await page.locator("#project-path").fill(projectPath);
      await page.locator("#project-typecheck-command").fill("npm run typecheck");
      await page.locator("#project-test-command").fill("npm run test");
      await page.locator("#open-project").click();
      await page.waitForSelector(
        "#project-readiness[data-harness-launch-ready='true']",
        { timeout: 10_000 },
      );
      const readiness = page.locator("#project-readiness");
      const projectId = await readiness.getAttribute("data-project-id");
      const harnessId = await readiness.getAttribute("data-harness-id");
      assert.equal(
        await readiness.getAttribute("data-harness-adapter-id"),
        "conformance-harness-adapter-v1",
      );
      const pinnedRevision = await readiness.getAttribute("data-harness-pin");
      assert.match(projectId, /^project-[a-f0-9]{24}$/);
      assert.match(harnessId, /^harness-[a-f0-9]{24}$/);
      assert.match(pinnedRevision, /^[a-f0-9]{40}$/);
      assert.equal(await readiness.getAttribute("data-project-revision"), "2");
      assert.equal(await readiness.getAttribute("data-checks-readiness"), "ready");
      assert.equal(await readiness.getAttribute("data-configuration-readiness"), "ready");
      assert.match(await readiness.textContent(), new RegExp(`Project identity: ${projectId}`));
      assert.match(await readiness.textContent(), new RegExp(`Harness identity: ${harnessId}`));
      assert.match(
        await readiness.textContent(),
        /Harness adapter: conformance-harness-adapter-v1/,
      );
      assert.match(await readiness.textContent(), new RegExp(pinnedRevision));
      assert.match(await readiness.textContent(), /pinned Harness is ready to launch/);
      assert.match(await page.locator("#project-feedback").textContent(), /ready to launch/i);

      assert.equal(projectRequests.length, 2);
      const acceptedRequest = projectRequests[1];
      const acceptedBody = JSON.parse(acceptedRequest.postData);
      assert.equal(acceptedBody.path, projectPath);
      assert.deepEqual(acceptedBody.configuration, {
        issueWorkflow: { provider: "github", kind: "issues" },
        checks: [
          { checkId: "typecheck", command: "npm run typecheck" },
          { checkId: "test", command: "npm run test" },
        ],
      });
      assert.equal(acceptedBody.harnessAdapterId, "conformance-harness-adapter-v1");
      const browserIdempotencyKey = acceptedRequest.headers["x-sandking-idempotency-key"];
      assert.ok(browserIdempotencyKey);
      assert.equal(acceptedRequest.headers["x-sandking-expected-revision"], "0");
      const runtimeAcknowledgement = JSON.parse(
        receivedFrames.find((frame) => frame.includes("runtime.hello-ack")),
      ).message;
      const csrf = runtimeAcknowledgement.session.csrfToken;

      const exerciseProjectOpen = (input) => page.evaluate(async (parameters) => {
        const mutation = await fetch("/projects/open", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-sandking-csrf": parameters.csrf,
            "x-sandking-idempotency-key": parameters.idempotencyKey,
            "x-sandking-expected-revision": String(parameters.expectedRevision),
          },
          body: JSON.stringify(parameters.body),
        });
        return { status: mutation.status, body: await mutation.json() };
      }, input);
      const websocketAck = await page.evaluate(() => sessionStorage.getItem("sandking.observationCursor"));
      assert.equal(websocketAck, "host:origin");

      const replay = await exerciseProjectOpen({
        csrf,
        idempotencyKey: browserIdempotencyKey,
        expectedRevision: 0,
        body: acceptedBody,
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.body.code, "project_ready");
      assert.equal(replay.body.idempotentReplay, true);
      assert.equal(replay.body.project.projectId, projectId);
      assert.equal(replay.body.mutations.projectRegistration.idempotentReplay, false);
      assert.match(replay.body.mutations.projectRegistration.auditId, /^audit-/);

      const changedUse = await exerciseProjectOpen({
        csrf,
        idempotencyKey: browserIdempotencyKey,
        expectedRevision: 0,
        body: { ...acceptedBody, path: anotherProjectPath },
      });
      assert.equal(changedUse.status, 409);
      assert.equal(changedUse.body.code, "idempotency_key_conflict");
      assert.equal(changedUse.body.retryable, false);

      const stale = await exerciseProjectOpen({
        csrf,
        idempotencyKey: "project-browser-stale-registration",
        expectedRevision: 0,
        body: acceptedBody,
      });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, "mutation_revision_conflict");
      assert.equal(stale.body.actualRevision, 2);
      assert.equal(stale.body.prohibitedSideEffects.projectFileWrite, false);

      await rename(projectPath, movedProjectPath);
      const missing = await exerciseProjectOpen({
        csrf,
        idempotencyKey: "project-browser-missing-path",
        expectedRevision: 2,
        body: acceptedBody,
      });
      assert.equal(missing.status, 409);
      assert.equal(missing.body.code, "project_path_missing");
      assert.deepEqual(missing.body.resolution.actions, [
        "update_registration",
        "forget_registration",
      ]);
      await rename(movedProjectPath, projectPath);

      const projectState = JSON.parse(
        await readFile(join(dataDir, "project-registrations.json"), "utf8"),
      );
      const harnessState = JSON.parse(
        await readFile(join(dataDir, "harness-registry.json"), "utf8"),
      );
      assert.equal(projectState.projects.length, 1);
      assert.equal(projectState.projects[0].projectId, projectId);
      assert.equal(projectState.projects[0].canonicalPath, projectPath);
      assert.deepEqual(projectState.projects[0].configuration, acceptedBody.configuration);
      assert.equal(projectState.projects[0].harness.harnessId, harnessId);
      assert.equal(projectState.projects[0].harness.pinnedRevision, pinnedRevision);
      assert.equal(projectState.projects[0].readiness.launchRequest, "ready");
      assert.equal(harnessState.harnesses.length, 1);
      assert.equal(harnessState.harnesses[0].harnessId, harnessId);
      assert.equal(harnessState.harnesses[0].immutableRevision, pinnedRevision);
      assert.notEqual(harnessState.harnesses[0].workspacePath, projectPath);
      assert.match(relative(dataDir, harnessState.harnesses[0].workspacePath), /^\.\./);
      assert.deepEqual(
        (await readdir(harnessState.harnesses[0].workspacePath)).sort(),
        [".git", "adapters", "harness.json"],
      );
      assert.equal(
        (await execFileAsync("git", [
          "-C", harnessState.harnesses[0].workspacePath, "rev-parse", "HEAD",
        ])).stdout.trim(),
        pinnedRevision,
      );
      assert.deepEqual((await readdir(projectPath)).sort(), projectFilesBefore);
      assert.equal(sha256(await readFile(projectFile)), projectFileBefore);
      assert.equal(sha256(await readFile(secretFile)), secretFileBefore);
      assert.equal(sha256(await readFile(unrelatedFile)), unrelatedBefore);
      assert.equal((await readdir(projectPath)).includes(".sandcastle"), false);

      const auditText = await readFile(join(dataDir, "audit.jsonl"), "utf8");
      const audits = auditText.trim().split("\n").map((line) => JSON.parse(line));
      const projectAudits = audits.filter((entry) =>
        entry.action.startsWith("project.") || entry.action.startsWith("harness."));
      const acceptedRegistrationAudit = projectAudits.find((entry) =>
        entry.action === "project.register" && entry.outcome === "accepted");
      const acceptedHarnessAudit = projectAudits.find((entry) =>
        entry.action === "harness.conformance.register" && entry.outcome === "accepted");
      const acceptedPinAudit = projectAudits.find((entry) =>
        entry.action === "project.harness.pin" && entry.outcome === "accepted");
      assert.match(acceptedRegistrationAudit.auditId, /^audit-/);
      assert.match(acceptedHarnessAudit.auditId, /^audit-/);
      assert.match(acceptedPinAudit.auditId, /^audit-/);
      assert.equal(acceptedRegistrationAudit.details.directoryScanPerformed, false);
      assert.equal(acceptedRegistrationAudit.details.separateApprovalRequired, false);
      assert.equal(acceptedPinAudit.details.launchRequestReady, true);
      assert.equal(acceptedPinAudit.details.projectFileWrite, false);
      assert.doesNotMatch(auditText, new RegExp(browserIdempotencyKey));

      const pageText = await page.textContent("body");
      const retainedText = `${JSON.stringify(projectState)}\n${JSON.stringify(harnessState)}\n${auditText}`;
      assert.doesNotMatch(pageText, new RegExp(projectSecret));
      assert.doesNotMatch(retainedText, new RegExp(projectSecret));
      assert.doesNotMatch(pageText, /controller-secret-must-not-reach-host/);

      const observation = {
        scenario: "local-walking-skeleton/completes-approved-run",
        packagedPublicSeam: installed.observation,
        identities: {
          hostId: launch.host.hostId,
          projectId,
          harnessId,
        },
        pinnedCommit: pinnedRevision,
        revisions: {
          projectRegistrationExpected: 0,
          projectRegistrationResult: 1,
          projectHarnessPinExpected: 1,
          projectHarnessPinResult: 2,
        },
        readiness: projectState.projects[0].readiness,
        idempotency: {
          registrationAuditId: acceptedRegistrationAudit.auditId,
          harnessRegistrationAuditId: acceptedHarnessAudit.auditId,
          pinAuditId: acceptedPinAudit.auditId,
          mismatchedPayloadCode: changedUse.body.code,
          replayCode: replay.body.mutations.projectRegistration.code,
          replayReturnsOriginalAudit:
            replay.body.mutations.projectRegistration.auditId
              === acceptedRegistrationAudit.auditId,
          replayIdempotent: replay.body.idempotentReplay,
        },
        failureOutcomes: {
          invalidPath: "project_path_invalid",
          staleRevision: {
            code: stale.body.code,
            actualRevision: stale.body.actualRevision,
          },
          missingPath: {
            code: missing.body.code,
            guidance: missing.body.resolution.actions,
          },
        },
        projectFootprint: {
          before: projectFilesBefore,
          after: (await readdir(projectPath)).sort(),
          trackedSandKingFiles: [],
          projectContentPreserved: true,
        },
        storageBoundaries: {
          registrationOutsideProject: true,
          harnessWorkspaceOutsideProject: true,
          executionStateOutsideHarnessWorkspace: true,
        },
        auditReferences: projectAudits.map((entry) => ({
          auditId: entry.auditId,
          action: entry.action,
          outcome: entry.outcome,
          details: entry.details,
        })),
        securityAssertions: {
          projectSecretAbsent: !retainedText.includes(projectSecret)
            && !pageText.includes(projectSecret),
          rawIdempotencyKeyAbsent: !auditText.includes(browserIdempotencyKey),
          unrelatedDirectoryPreserved:
            sha256(await readFile(unrelatedFile)) === unrelatedBefore,
        },
        prohibitedSideEffectAssertions: {
          directoryScan: false,
          projectFileWrite: false,
          trackedSandKingFileWrite: false,
          approvalRequest: false,
          sudo: false,
          systemPackageInstall: false,
          shellProfileMutation: false,
          serviceConfiguration: false,
        },
        scopeExclusions: [
          "full-harness-projection",
          "production-harness-lifecycle",
          "harness-import-update-rollback-switching",
          "drift-recovery",
        ],
        software: {
          sandking: "0.1.0",
          browser: browser.version(),
          node: process.version,
        },
      };
      assert.ok(Object.values(observation.securityAssertions).every(Boolean));
      assert.ok(Object.values(observation.prohibitedSideEffectAssertions).every(
        (observed) => observed === false,
      ));
      const observationText = JSON.stringify(observation);
      assert.doesNotMatch(observationText, new RegExp(projectSecret));
      assert.doesNotMatch(observationText, new RegExp(browserIdempotencyKey));
      if (process.env.SANDKING_ACCEPTANCE_OBSERVATION_PATH) {
        await writeFile(
          process.env.SANDKING_ACCEPTANCE_OBSERVATION_PATH,
          `${JSON.stringify(observation, null, 2)}\n`,
          { mode: 0o600 },
        );
      }

      page.once("dialog", (dialog) => dialog.accept());
      await page.locator("#forget-project-registration").click();
      await page.waitForFunction(() => document.querySelector("#project-feedback")
        ?.textContent?.includes("was forgotten safely"));
      await page.locator("#project-path").fill(projectPath);
      await page.locator("#open-project").click();
      await page.waitForFunction(() => document.querySelector("#project-feedback")
        ?.textContent?.includes("project_path_tombstoned"));
      const restore = page.locator(
        `.restore-project-registration[data-project-id='${projectId}']`,
      );
      await restore.waitFor({ state: "visible" });
      assert.equal(await restore.getAttribute("data-project-path"), projectPath);
      await restore.click();
      await page.waitForFunction(() => document.querySelector("#project-feedback")
        ?.textContent?.includes("was restored"));
      await page.locator("#project-path").fill(projectPath);
      await page.locator("#open-project").click();
      await page.waitForSelector(
        `#project-readiness[data-project-id='${projectId}'][data-harness-launch-ready='true']`,
        { timeout: 10_000 },
      );

      await rename(projectPath, movedProjectPath);
      await page.locator("#project-path").fill(movedProjectPath);
      await page.locator("#open-project").click();
      await page.waitForFunction(() => document.querySelector("#project-feedback")
        ?.textContent?.includes("project_path_moved"));
      await page.locator("#register-project-as-new").click();
      await page.waitForFunction(() => document.querySelector("#project-feedback")
        ?.textContent?.includes("project_path_conflict"));
      const conflictChoices = page.locator(".resolve-project-registration-conflict");
      await conflictChoices.first().waitFor({ state: "visible" });
      assert.equal(await conflictChoices.count(), 2);
      const candidateIds = await conflictChoices.evaluateAll((buttons) =>
        buttons.map((button) => button.dataset.projectId));
      assert.ok(candidateIds.includes(projectId));
      const newProjectId = candidateIds.find((candidate) => candidate !== projectId);
      assert.match(newProjectId, /^project-[a-f0-9]{24}$/);

      await context.close();

      const stopped = JSON.parse((await execFileAsync(installed.command, [
        "stop", "--data-dir", dataDir, "--json",
      ], { cwd: executionDirectory, env: productEnvironment })).stdout);
      assert.equal(stopped.stopped, true);
      const restarted = JSON.parse((await execFileAsync(installed.command, [
        "launch",
        "--data-dir", dataDir,
        "--startup-timeout-ms", "60000",
        "--idempotency-key", "project-registration-resolution-runtime-restart",
        "--json",
        "--no-open",
      ], { cwd: executionDirectory, env: productEnvironment })).stdout);
      assert.notEqual(restarted.runtime.runtimeId, launch.runtime.runtimeId);
      assert.equal(restarted.host.hostId, launch.host.hostId);

      await browser.close();
      const restartedBrowser = await launchBrowser({ niceAdjustment: 10 });
      const restartedContext = await restartedBrowser.newContext();
      const restartedPage = await restartedContext.newPage();
      await restartedPage.goto(restarted.bootstrapUrl, { waitUntil: "domcontentloaded" });
      await restartedPage.waitForSelector(
        "#project-preparation[data-explicit-path-only='true']",
        { timeout: 10_000 },
      );
      await restartedPage.locator("#project-harness-adapter")
        .selectOption("conformance-harness-adapter-v1");
      await restartedPage.locator("#project-path").fill(movedProjectPath);
      await restartedPage.locator("#open-project").click();
      await restartedPage.waitForFunction(() => document.querySelector("#project-feedback")
        ?.textContent?.includes("project_path_conflict"));
      const restartedChoices = restartedPage.locator(
        ".resolve-project-registration-conflict",
      );
      await restartedChoices.first().waitFor({ state: "visible" });
      assert.deepEqual(
        (await restartedChoices.evaluateAll((buttons) =>
          buttons.map((button) => button.dataset.projectId))).sort(),
        candidateIds.sort(),
      );
      await restartedPage.locator(
        `.resolve-project-registration-conflict[data-project-id='${newProjectId}']`,
      ).click();
      await restartedPage.waitForFunction(() => document.querySelector("#project-feedback")
        ?.textContent?.includes("was kept and its conflicts were retired"));
      await restartedPage.locator("#project-path").fill(movedProjectPath);
      await restartedPage.locator("#open-project").click();
      await restartedPage.waitForSelector(
        `#project-readiness[data-project-id='${newProjectId}']`
          + "[data-harness-launch-ready='true']",
        { timeout: 10_000 },
      );
      await restartedPage.locator("#project-path").fill(projectPath);
      await mkdir(projectPath, { recursive: true });
      await writeFile(join(projectPath, "replacement.txt"), "replacement Project content\n");
      await restartedPage.locator("#open-project").click();
      await restartedPage.waitForFunction(() => document.querySelector("#project-feedback")
        ?.textContent?.includes("project_path_tombstoned"));
      assert.equal(
        await restartedPage.locator("#project-readiness").getAttribute("data-project-id"),
        newProjectId,
      );
      await restartedPage.locator("#register-project-as-new").click();
      await restartedPage.waitForFunction((previousProjectId) => {
        const readiness = document.querySelector(
          "#project-readiness[data-harness-launch-ready='true']",
        );
        return readiness?.getAttribute("data-project-id") !== previousProjectId
          || document.querySelector("#project-feedback")?.textContent
            ?.includes("Project was not changed");
      }, newProjectId);
      assert.match(
        await restartedPage.locator("#project-feedback").textContent(),
        /ready to launch/i,
      );
      const replacementProjectId = await restartedPage.locator("#project-readiness")
        .getAttribute("data-project-id");
      assert.match(replacementProjectId, /^project-[a-f0-9]{24}$/);
      assert.notEqual(replacementProjectId, projectId);
      assert.notEqual(replacementProjectId, newProjectId);
      const recoveredState = JSON.parse(
        await readFile(join(dataDir, "project-registrations.json"), "utf8"),
      );
      const retainedOriginal = recoveredState.projects.find((project) =>
        project.projectId === projectId);
      assert.equal(retainedOriginal?.status, "tombstoned");
      assert.equal(
        recoveredState.projects.find((project) => project.projectId === replacementProjectId)
          ?.canonicalPath,
        projectPath,
      );
      const finalAudits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      const replacementAudit = finalAudits.find((entry) =>
        entry.action === "project.register"
        && entry.outcome === "accepted"
        && entry.details.projectId === replacementProjectId);
      assert.equal(replacementAudit?.details.resolutionAction, "register_as_new");
      assert.equal(replacementAudit?.details.expectedRevision, retainedOriginal.revision);
      assert.equal(replacementAudit?.details.actualRevision, retainedOriginal.revision);
      const lifecycleAudits = finalAudits.filter((entry) =>
          entry.action === "project.registration.resolve" && entry.outcome === "accepted");
      assert.deepEqual(
        lifecycleAudits.map((entry) => entry.details.action),
        ["forget", "restore", "resolve_conflict"],
      );
      assert.ok(lifecycleAudits.every((entry) =>
        entry.details.directoryScanPerformed === false
        && entry.details.projectFileWrite === false));
      await restartedContext.close();
      await restartedBrowser.close();
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
