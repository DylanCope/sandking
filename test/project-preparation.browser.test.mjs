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
      "--idempotency-key", "project-browser-runtime-launch",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const launch = JSON.parse(stdout);
    const browser = await launchBrowser();

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
        "#project-readiness[data-launch-request-ready='true']",
        { timeout: 10_000 },
      );
      const readiness = page.locator("#project-readiness");
      const projectId = await readiness.getAttribute("data-project-id");
      const harnessId = await readiness.getAttribute("data-harness-id");
      const pinnedRevision = await readiness.getAttribute("data-harness-pin");
      assert.match(projectId, /^project-[a-f0-9]{24}$/);
      assert.match(harnessId, /^harness-[a-f0-9]{24}$/);
      assert.match(pinnedRevision, /^[a-f0-9]{40}$/);
      assert.equal(await readiness.getAttribute("data-project-revision"), "2");
      assert.equal(await readiness.getAttribute("data-checks-readiness"), "ready");
      assert.equal(await readiness.getAttribute("data-configuration-readiness"), "ready");
      assert.match(await readiness.textContent(), new RegExp(`Project identity: ${projectId}`));
      assert.match(await readiness.textContent(), new RegExp(`Harness identity: ${harnessId}`));
      assert.match(await readiness.textContent(), new RegExp(pinnedRevision));
      assert.match(await readiness.textContent(), /A Launch request can be prepared/);
      assert.match(await page.locator("#project-feedback").textContent(), /ready for Launch/i);

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
      assert.equal(replay.body.project.projectId, projectId);
      assert.equal(replay.body.mutations.projectRegistration.idempotentReplay, true);
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
        [".git", "adapter.mjs", "harness.json"],
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
          replayIdempotent:
            replay.body.mutations.projectRegistration.idempotentReplay,
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
