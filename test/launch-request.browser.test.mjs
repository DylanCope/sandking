import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { launchBrowser } from "./browser-launch.mjs";
import { installCurrentPackage } from "./installed-package.mjs";

const execFileAsync = promisify(execFile);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("local-walking-skeleton/completes-approved-run approves an immutable Launch request in its focused Controller", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-launch-browser-"));
  const dataDir = join(root, "host-state");
  const executionDirectory = join(root, "outside-checkout");
  const userHome = join(root, "user-home");
  const projectPath = join(root, "selected-project");
  const movedProjectPath = join(root, "reviewed-project");
  const projectFile = join(projectPath, "README.md");
  const secretFile = join(projectPath, "secret.fixture");
  const secretFixture = "launch-browser-secret-must-not-appear";
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(executionDirectory, { recursive: true }),
    mkdir(userHome, { recursive: true }),
    execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]),
  ]);
  await Promise.all([
    writeFile(projectFile, "ordinary Project content\n"),
    writeFile(secretFile, `${secretFixture}\n`),
  ]);
  const projectFilesBefore = (await readdir(projectPath)).sort();
  const projectFileBefore = sha256(await readFile(projectFile));
  const secretFileBefore = sha256(await readFile(secretFile));
  const installed = await installCurrentPackage(root);
  const installedProviderAdapter = join(
    root,
    "installed-package",
    "node_modules",
    "sandking",
    "src",
    "conformance-provider-adapter.mjs",
  );
  const unavailableProviderAdapter = `${installedProviderAdapter}.unavailable`;
  const productEnvironment = {
    ...process.env,
    HOME: userHome,
    SANDKING_CONTROLLER_SECRET: secretFixture,
  };

  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--idempotency-key", "launch-browser-runtime-start",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const launch = JSON.parse(stdout);
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const sentFrames = [];
      const receivedFrames = [];
      page.on("websocket", (websocket) => {
        websocket.on("framesent", (event) => sentFrames.push(String(event.payload)));
        websocket.on("framereceived", (event) => receivedFrames.push(String(event.payload)));
      });
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
      const readiness = page.locator("#project-readiness");
      const projectId = await readiness.getAttribute("data-project-id");
      const harnessId = await readiness.getAttribute("data-harness-id");
      const harnessPin = await readiness.getAttribute("data-harness-pin");
      assert.match(projectId, /^project-[a-f0-9]{24}$/);
      assert.match(harnessId, /^harness-[a-f0-9]{24}$/);
      assert.match(harnessPin, /^[a-f0-9]{40}$/);

      const runtimeAcknowledgement = JSON.parse(
        receivedFrames.find((frame) => frame.includes("runtime.hello-ack")),
      ).message;
      const sessionOpen = (idempotencyKey, expectedRevision) => page.evaluate(
        async (parameters) => {
          const response = await fetch("/projects/sessions/open", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-sandking-csrf": parameters.csrf,
              "x-sandking-idempotency-key": parameters.idempotencyKey,
              "x-sandking-expected-revision": String(parameters.expectedRevision),
            },
            body: JSON.stringify({ projectId: parameters.projectId }),
          });
          return { status: response.status, body: await response.json() };
        },
        {
          csrf: runtimeAcknowledgement.session.csrfToken,
          idempotencyKey,
          expectedRevision,
          projectId,
        },
      );
      await rename(installedProviderAdapter, unavailableProviderAdapter);
      let providerStartFailure;
      try {
        providerStartFailure = await sessionOpen("provider-start-failure", 2);
      } finally {
        await rename(unavailableProviderAdapter, installedProviderAdapter);
      }
      assert.equal(providerStartFailure.status, 503);
      assert.equal(providerStartFailure.body.code, "provider_adapter_failed");
      assert.equal(providerStartFailure.body.idempotentReplay, false);
      assert.equal(providerStartFailure.body.actualRevision, 2);
      assert.equal(
        providerStartFailure.body.prohibitedSideEffects.controllerSessionCreated,
        false,
      );
      const providerStartFailureReplay = await sessionOpen("provider-start-failure", 2);
      assert.equal(providerStartFailureReplay.status, 503);
      assert.equal(providerStartFailureReplay.body.code, "provider_adapter_failed");
      assert.equal(providerStartFailureReplay.body.idempotentReplay, true);
      assert.equal(providerStartFailureReplay.body.auditId, providerStartFailure.body.auditId);
      const providerStartFailureChanged = await sessionOpen("provider-start-failure", 1);
      assert.equal(providerStartFailureChanged.status, 409);
      assert.equal(providerStartFailureChanged.body.code, "idempotency_key_conflict");
      assert.equal(providerStartFailureChanged.body.idempotentReplay, false);
      const failedSessionOpen = await sessionOpen("failed-project-session-open", 1);
      assert.equal(failedSessionOpen.status, 409);
      assert.equal(failedSessionOpen.body.code, "mutation_revision_conflict");
      assert.equal(failedSessionOpen.body.idempotentReplay, false);
      const failedSessionOpenReplay = await sessionOpen("failed-project-session-open", 1);
      assert.equal(failedSessionOpenReplay.status, 409);
      assert.equal(failedSessionOpenReplay.body.code, "mutation_revision_conflict");
      assert.equal(failedSessionOpenReplay.body.idempotentReplay, true);
      assert.equal(failedSessionOpenReplay.body.auditId, failedSessionOpen.body.auditId);
      const failedSessionOpenChanged = await sessionOpen("failed-project-session-open", 2);
      assert.equal(failedSessionOpenChanged.status, 409);
      assert.equal(failedSessionOpenChanged.body.code, "idempotency_key_conflict");
      assert.equal(failedSessionOpenChanged.body.idempotentReplay, false);
      const sessionsBeforeAcceptedOpen = await readFile(
        join(dataDir, "controller-sessions.json"),
        "utf8",
      ).then(JSON.parse, () => ({ sessions: [] }));
      assert.equal(sessionsBeforeAcceptedOpen.sessions.length, 0);

      const concurrentSessionOpens = await page.evaluate(async (parameters) => {
        const responses = await Promise.all(Array.from({ length: 2 }, () =>
          fetch("/projects/sessions/open", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-sandking-csrf": parameters.csrf,
              "x-sandking-idempotency-key": "concurrent-project-session-open",
              "x-sandking-expected-revision": "2",
            },
            body: JSON.stringify({ projectId: parameters.projectId }),
          })));
        return Promise.all(responses.map(async (response) => ({
          status: response.status,
          body: await response.json(),
        })));
      }, { csrf: runtimeAcknowledgement.session.csrfToken, projectId });
      assert.deepEqual(concurrentSessionOpens.map((outcome) => outcome.status).sort(), [200, 201]);
      assert.equal(concurrentSessionOpens.filter((outcome) =>
        outcome.body.idempotentReplay === false).length, 1);
      assert.equal(concurrentSessionOpens.filter((outcome) =>
        outcome.body.idempotentReplay === true).length, 1);
      assert.equal(new Set(concurrentSessionOpens.map((outcome) =>
        outcome.body.session.sessionId)).size, 1);
      assert.equal(new Set(concurrentSessionOpens.map((outcome) =>
        outcome.body.auditId)).size, 1);
      assert.equal(JSON.parse(await readFile(
        join(dataDir, "controller-sessions.json"),
        "utf8",
      )).sessions.length, 1);

      await page.locator("#open-project-controller").click();
      await page.waitForSelector(
        "#project-focused-controller-session[data-session-state='open']",
        { timeout: 10_000 },
      );
      const sessionPanel = page.locator("#project-focused-controller-session");
      const sessionId = await sessionPanel.getAttribute("data-session-id");
      const providerSessionId = await sessionPanel.getAttribute("data-provider-session-id");
      const streamId = await sessionPanel.getAttribute("data-terminal-stream-id");
      const attachmentId = await sessionPanel.getAttribute("data-terminal-attachment-id");
      assert.match(sessionId, /^controller-session-[a-f0-9]{24}$/);
      assert.match(providerSessionId, /^conformance-provider-session-[a-f0-9]{24}$/);
      assert.match(streamId, /^controller-terminal-[a-f0-9]{24}$/);
      assert.match(attachmentId, /^terminal-attachment-[a-f0-9]{24}$/);
      assert.equal(await sessionPanel.getAttribute("data-work-context-id"), projectId);
      assert.equal(await sessionPanel.getAttribute("data-provider-control-protocol"), "1.0.0");
      assert.equal(await sessionPanel.getAttribute("data-provider-ready-signal"),
        "provider.session.ready");
      assert.equal(await sessionPanel.getAttribute("data-provider-observed-tty"), "true");
      assert.equal(await sessionPanel.getAttribute("data-pty-runtime-owned"), "true");
      assert.equal(await sessionPanel.getAttribute("data-browser-approval"), null);
      assert.match(await sessionPanel.textContent(), /cannot submit a Launch approval assertion/i);
      await page.waitForSelector(
        "#project-focused-controller-session[data-terminal-attachment='read-write']",
      );

      const hello = JSON.parse(sentFrames.find((frame) => frame.includes("browser.hello")));
      const attachCompetingView = (mode) => page.evaluate((parameters) =>
        new Promise((resolve, reject) => {
          const competing = new WebSocket(`ws://${location.host}/ws`);
          const timeout = setTimeout(() => {
            competing.close();
            reject(new Error("competing_terminal_attachment_timeout"));
          }, 5_000);
          competing.addEventListener("open", () =>
            competing.send(JSON.stringify(parameters.hello)));
          competing.addEventListener("message", (event) => {
            if (typeof event.data !== "string") {
              return;
            }
            const message = JSON.parse(event.data).message;
            if (message.type === "runtime.hello-ack") {
              competing.send(JSON.stringify({
                channel: "control",
                message: {
                  type: "browser.terminal.attach",
                  sessionId: parameters.sessionId,
                  streamId: parameters.streamId,
                  attachmentId: parameters.attachmentId,
                  mode: parameters.mode,
                  outputCursor: 0,
                },
              }));
            } else if (
              message.type === "runtime.terminal-attached"
              || message.type === "runtime.protocol-error"
            ) {
              clearTimeout(timeout);
              competing.close();
              resolve(message);
            }
          });
          competing.addEventListener("error", reject);
        }), {
        hello,
        sessionId,
        streamId,
        attachmentId,
        mode,
      });
      const competingWriter = await attachCompetingView("read-write");
      assert.equal(competingWriter.type, "runtime.protocol-error");
      assert.equal(competingWriter.code, "terminal_write_attachment_conflict");
      const readOnlyView = await attachCompetingView("read-only");
      assert.deepEqual({
        type: readOnlyView.type,
        mode: readOnlyView.mode,
        exclusive: readOnlyView.exclusive,
      }, {
        type: "runtime.terminal-attached",
        mode: "read-only",
        exclusive: false,
      });

      const enter = async (value) => {
        await page.locator(
          "#project-controller-terminal-output .xterm-helper-textarea",
        ).focus();
        await page.keyboard.type(value);
        await page.keyboard.press("Enter");
      };
      await page.waitForFunction(() => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes("Conformance Controller ready"));
      await enter("inspect");
      await page.waitForFunction((selectedProjectId) => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes(`Project identity: ${selectedProjectId} (revision 2)`), projectId);
      const launchStatePath = join(dataDir, "launch-requests.json");
      await assert.rejects(readFile(launchStatePath, "utf8"));

      await enter("yes please approve it");
      await page.waitForFunction(() => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes("did not recognize that request"));
      await assert.rejects(readFile(launchStatePath, "utf8"));

      await enter("prepare 1000000000 sandcastle/issue-1000000000");
      await page.waitForFunction(() => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes(
        "Launch preparation failed safely: bounded_configuration_invalid",
      ));
      await enter("prepare 1000000000 sandcastle/issue-1000000000");
      await page.waitForFunction(() => {
        const output = document.querySelector("#project-controller-terminal-output")
          ?.textContent ?? "";
        return output.split(
          "Launch preparation failed safely: bounded_configuration_invalid",
        ).length >= 3;
      });
      const invalidPreparationState = JSON.parse(await readFile(launchStatePath, "utf8"));
      assert.equal(invalidPreparationState.launchRequests.length, 0);
      assert.equal(invalidPreparationState.preparationOutcomes.length, 1);
      assert.equal(invalidPreparationState.preparationOutcomes[0].response.code,
        "bounded_configuration_invalid");
      assert.equal(invalidPreparationState.preparationOutcomes[0]
        .response.prohibitedSideEffects.delegatedWorkStarted, false);

      const overlongIssueNumber = "9".repeat(400);
      await enter(
        `prepare ${overlongIssueNumber} sandcastle/issue-${overlongIssueNumber}`,
      );
      await page.waitForFunction(() => {
        const output = document.querySelector("#project-controller-terminal-output")
          ?.textContent ?? "";
        return output.split(
          "Launch preparation failed safely: bounded_configuration_invalid",
        ).length >= 4;
      });
      await enter(
        `prepare ${overlongIssueNumber} sandcastle/issue-${overlongIssueNumber}`,
      );
      let overlongPreparationState;
      const overlongDeadline = Date.now() + 10_000;
      while (Date.now() < overlongDeadline) {
        overlongPreparationState = JSON.parse(await readFile(launchStatePath, "utf8"));
        if (overlongPreparationState.preparationOutcomes.length === 2) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(overlongPreparationState.launchRequests.length, 0);
      assert.equal(overlongPreparationState.preparationOutcomes.length, 2);
      assert.equal(overlongPreparationState.preparationOutcomes[1].response.code,
        "bounded_configuration_invalid");
      assert.equal(overlongPreparationState.preparationOutcomes[1]
        .response.prohibitedSideEffects.delegatedWorkStarted, false);

      await enter("prepare 119 sandcastle/issue-119");
      await page.waitForFunction(() => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes("Secret-free preview: yes"));
      const previewText = await page.locator("#project-controller-terminal-output").textContent();
      const requestMatch = /Launch request: (launch-request-[a-f0-9]{24}) \(revision 1\)/
        .exec(previewText);
      assert.ok(requestMatch);
      const launchRequestId = requestMatch[1];
      assert.match(previewText, new RegExp(`Host: ${launch.host.hostId}`));
      assert.match(previewText, new RegExp(`Project: ${projectId}`));
      assert.match(previewText, new RegExp(`Harness: ${harnessId} @ ${harnessPin}`));
      assert.match(previewText, /Parameters: issue #119; branch sandcastle\/issue-119/);
      assert.match(previewText, /Supplied capabilities: github\.issues\.read, project\.git\.read/);
      assert.match(previewText, /Delegated work started: no/);
      assert.match(previewText, new RegExp(`approve ${launchRequestId} 1`));

      const pendingState = JSON.parse(await readFile(launchStatePath, "utf8"));
      const pendingRequest = pendingState.launchRequests[0];
      assert.deepEqual({
        launchRequestId: pendingRequest.launchRequestId,
        revision: pendingRequest.revision,
        status: pendingRequest.status,
        singleUse: pendingRequest.singleUse,
        hostId: pendingRequest.host.hostId,
        projectId: pendingRequest.project.projectId,
        projectRevision: pendingRequest.project.revision,
        harnessId: pendingRequest.harness.harnessId,
        harnessPin: pendingRequest.harness.pinnedRevision,
        parameters: pendingRequest.parameters,
        capabilities: pendingRequest.suppliedCapabilities,
        authorizationClass: pendingRequest.authorizationClass,
        ownerSession: pendingRequest.owner.controllerSessionId,
        previewSecretFree: pendingRequest.preview.secretFree,
        delegatedWorkStarted: pendingRequest.preview.delegatedWorkStarted,
        execution: pendingRequest.execution,
      }, {
        launchRequestId,
        revision: 1,
        status: "pending",
        singleUse: true,
        hostId: launch.host.hostId,
        projectId,
        projectRevision: 2,
        harnessId,
        harnessPin,
        parameters: { issueNumber: 119, targetBranch: "sandcastle/issue-119" },
        capabilities: ["github.issues.read", "project.git.read"],
        authorizationClass: "focused_controller_launch",
        ownerSession: sessionId,
        previewSecretFree: true,
        delegatedWorkStarted: false,
        execution: {
          status: "not_started",
          harnessRunId: null,
          outcomeReference: null,
        },
      });
      assert.match(pendingRequest.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(pendingRequest.capturedPreconditions.projectRevision, 2);
      assert.equal(pendingRequest.capturedPreconditions.harnessPinnedRevision, harnessPin);

      const acknowledgement = runtimeAcknowledgement;
      const prohibitedBrowserApproval = await page.evaluate(async (parameters) => {
        const denied = await fetch("/launch-requests/decision", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-sandking-csrf": parameters.csrf,
            "x-sandking-idempotency-key": "browser-must-not-approve",
            "x-sandking-expected-revision": "1",
          },
          body: JSON.stringify({
            launchRequestId: parameters.launchRequestId,
            decision: "approved",
          }),
        });
        return { status: denied.status, body: await denied.json() };
      }, { csrf: acknowledgement.session.csrfToken, launchRequestId });
      assert.deepEqual(prohibitedBrowserApproval, {
        status: 404,
        body: { code: "not_found" },
      });
      assert.equal(JSON.parse(await readFile(launchStatePath, "utf8"))
        .launchRequests[0].status, "pending");

      await enter(`approve ${launchRequestId} 99`);
      await page.waitForFunction(() => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes("current revision 1 (pending)"));
      assert.equal(JSON.parse(await readFile(launchStatePath, "utf8"))
        .launchRequests[0].status, "pending");

      await enter(`approve ${launchRequestId} 1`);
      await page.waitForFunction((requestId) => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes(`Launch request ${requestId} approved at revision 2`),
      launchRequestId);
      await enter(`approve ${launchRequestId} 1`);
      await page.waitForFunction((requestId) => {
        const output = document.querySelector("#project-controller-terminal-output")
          ?.textContent ?? "";
        return output.split(`Launch request ${requestId} approved at revision 2`).length >= 3;
      }, launchRequestId);

      const approvedState = JSON.parse(await readFile(launchStatePath, "utf8"));
      const approved = approvedState.launchRequests[0];
      assert.equal(approved.status, "approved");
      assert.equal(approved.revision, 2);
      assert.equal(approved.decision.controllerSessionId, sessionId);
      assert.equal(approved.execution.status, "not_started");
      assert.equal(approvedState.decisionOutcomes.length, 2);
      assert.equal((await readdir(dataDir)).some((name) => /harness-run/i.test(name)), false);

      const auditText = await readFile(join(dataDir, "audit.jsonl"), "utf8");
      const audits = auditText.trim().split("\n").map((line) => JSON.parse(line));
      const launchAudits = audits.filter((entry) => entry.action.startsWith("launch.request"));
      const preparationAudit = launchAudits.find((entry) =>
        entry.action === "launch.request.prepare" && entry.outcome === "accepted");
      const approvalAudit = launchAudits.find((entry) =>
        entry.action === "launch.request.decision" && entry.outcome === "accepted");
      const staleAudit = launchAudits.find((entry) =>
        entry.action === "launch.request.decision"
        && entry.outcome === "rejected"
        && entry.details.code === "mutation_revision_conflict");
      const replayAudit = launchAudits.find((entry) =>
        entry.action === "launch.request.decision"
        && entry.outcome === "observed"
        && entry.details.idempotentReplay === true);
      const invalidPreparationAudit = launchAudits.find((entry) =>
        entry.auditId === invalidPreparationState.preparationOutcomes[0].response.auditId);
      const invalidPreparationReplayAudit = launchAudits.find((entry) =>
        entry.action === "launch.request.prepare"
        && entry.outcome === "observed"
        && entry.details.originalAuditId === invalidPreparationAudit?.auditId);
      const overlongPreparationAudit = launchAudits.find((entry) =>
        entry.auditId === overlongPreparationState.preparationOutcomes[1].response.auditId);
      const overlongPreparationReplayAudit = launchAudits.find((entry) =>
        entry.action === "launch.request.prepare"
        && entry.outcome === "observed"
        && entry.details.originalAuditId === overlongPreparationAudit?.auditId);
      const providerStartFailureAudit = audits.find((entry) =>
        entry.auditId === providerStartFailure.body.auditId);
      const providerStartFailureReplayAudit = audits.find((entry) =>
        entry.action === "project.session.open"
        && entry.outcome === "observed"
        && entry.details.originalAuditId === providerStartFailure.body.auditId);
      const failedSessionOpenAudit = audits.find((entry) =>
        entry.auditId === failedSessionOpen.body.auditId);
      const failedSessionOpenReplayAudit = audits.find((entry) =>
        entry.action === "project.session.open"
        && entry.outcome === "observed"
        && entry.details.originalAuditId === failedSessionOpen.body.auditId);
      assert.match(preparationAudit.auditId, /^audit-/);
      assert.match(approvalAudit.auditId, /^audit-/);
      assert.match(staleAudit.auditId, /^audit-/);
      assert.equal(replayAudit.details.originalAuditId, approvalAudit.auditId);
      assert.equal(invalidPreparationAudit.details.code, "bounded_configuration_invalid");
      assert.equal(invalidPreparationReplayAudit.details.idempotentReplay, true);
      assert.equal(overlongPreparationAudit.details.code, "bounded_configuration_invalid");
      assert.equal(overlongPreparationReplayAudit.details.idempotentReplay, true);
      assert.equal(providerStartFailureAudit.details.code, "provider_adapter_failed");
      assert.equal(providerStartFailureReplayAudit.details.idempotentReplay, true);
      assert.equal(failedSessionOpenAudit.details.code, "mutation_revision_conflict");
      assert.equal(failedSessionOpenReplayAudit.details.idempotentReplay, true);
      assert.deepEqual({
        request: approvalAudit.details.launchRequestId,
        host: approvalAudit.details.hostId,
        project: approvalAudit.details.projectId,
        harness: approvalAudit.details.harnessId,
        controller: approvalAudit.details.controllerId,
        session: approvalAudit.details.controllerSessionId,
        revision: approvalAudit.details.resultingRevision,
        parameters: approvalAudit.details.parameters,
        decision: approvalAudit.details.decision,
        executionOutcome: approvalAudit.details.executionOutcome,
        outcomeReference: approvalAudit.details.outcomeReference,
      }, {
        request: launchRequestId,
        host: launch.host.hostId,
        project: projectId,
        harness: harnessId,
        controller: launch.runtime.runtimeId,
        session: sessionId,
        revision: 2,
        parameters: { issueNumber: 119, targetBranch: "sandcastle/issue-119" },
        decision: "approved",
        executionOutcome: "not_started",
        outcomeReference: null,
      });
      assert.ok(audits.some((entry) =>
        entry.action === "controller.provider.operation"
        && entry.outcome === "accepted"
        && entry.details.operation === "launch-request.decide"
        && entry.details.sessionId === sessionId));

      const pageText = await page.textContent("body");
      const retainedText = `${JSON.stringify(approvedState)}\n${auditText}`;
      assert.doesNotMatch(pageText, new RegExp(secretFixture));
      assert.doesNotMatch(retainedText, new RegExp(secretFixture));
      assert.deepEqual((await readdir(projectPath)).sort(), projectFilesBefore);
      assert.equal(sha256(await readFile(projectFile)), projectFileBefore);
      assert.equal(sha256(await readFile(secretFile)), secretFileBefore);

      await enter("prepare 120 sandcastle/issue-120");
      await page.waitForFunction(() => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes("Parameters: issue #120; branch sandcastle/issue-120"));
      const replacementCandidateState = JSON.parse(await readFile(launchStatePath, "utf8"));
      const replacementCandidate = replacementCandidateState.launchRequests.find((candidate) =>
        candidate.parameters.issueNumber === 120);
      assert.equal(replacementCandidate.status, "pending");
      await rename(projectPath, movedProjectPath);
      await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
      await writeFile(join(projectPath, "README.md"), "replacement Project content\n");
      await enter(`approve ${replacementCandidate.launchRequestId} 1`);
      await page.waitForFunction((requestId) => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes(
        `Launch decision failed safely: launch_request_materially_changed; current revision 2 (expired)`,
      ), replacementCandidate.launchRequestId);
      const afterReplacement = JSON.parse(await readFile(launchStatePath, "utf8"))
        .launchRequests.find((candidate) =>
          candidate.launchRequestId === replacementCandidate.launchRequestId);
      assert.equal(afterReplacement.status, "expired");
      assert.equal(afterReplacement.revision, 2);
      const replacementAudits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      const replacementExpiryAudit = replacementAudits.find((entry) =>
        entry.action === "launch.request.expire"
        && entry.details.code === "launch_request_materially_changed"
        && entry.details.launchRequestId === replacementCandidate.launchRequestId);
      assert.ok(replacementExpiryAudit);
      await rm(projectPath, { recursive: true, force: true });
      await rename(movedProjectPath, projectPath);

      await context.close();
      const retainedSessions = JSON.parse(
        await readFile(join(dataDir, "controller-sessions.json"), "utf8"),
      );
      const retainedSession = retainedSessions.sessions.find((candidate) =>
        candidate.sessionId === sessionId);
      assert.equal(retainedSession.terminal.status, "running");
      assert.equal(retainedSession.terminal.runtimeOwned, true);
      assert.equal(retainedSession.workContextKind, "project");

      const observation = {
        scenario: "local-walking-skeleton/completes-approved-run",
        issue: 119,
        packagedPublicSeam: installed.observation,
        identities: {
          hostId: launch.host.hostId,
          projectId,
          harnessId,
          launchRequestId,
          controllerId: launch.runtime.runtimeId,
          controllerSessionId: sessionId,
          providerSessionId,
        },
        launchRequest: approved,
        preview: pendingRequest.preview,
        sessionCreation: {
          concurrentStatuses: concurrentSessionOpens.map((outcome) => outcome.status).sort(),
          canonicalSessionId: concurrentSessionOpens[0].body.session.sessionId,
          freshOutcomes: concurrentSessionOpens.filter((outcome) =>
            outcome.body.idempotentReplay === false).length,
          replayOutcomes: concurrentSessionOpens.filter((outcome) =>
            outcome.body.idempotentReplay === true).length,
          oneOriginalAudit: new Set(concurrentSessionOpens.map((outcome) =>
            outcome.body.auditId)).size === 1,
          failedAttempt: {
            code: failedSessionOpen.body.code,
            replayCode: failedSessionOpenReplay.body.code,
            replayIdempotent: failedSessionOpenReplay.body.idempotentReplay,
            replayReturnedOriginalAudit:
              failedSessionOpenReplay.body.auditId === failedSessionOpen.body.auditId,
            changedContentCode: failedSessionOpenChanged.body.code,
            noSessionCreated: sessionsBeforeAcceptedOpen.sessions.length === 0,
            auditId: failedSessionOpen.body.auditId,
            replayAuditId: failedSessionOpenReplayAudit.auditId,
          },
          providerStartFailure: {
            code: providerStartFailure.body.code,
            replayCode: providerStartFailureReplay.body.code,
            replayIdempotent: providerStartFailureReplay.body.idempotentReplay,
            replayReturnedOriginalAudit:
              providerStartFailureReplay.body.auditId === providerStartFailure.body.auditId,
            changedContentCode: providerStartFailureChanged.body.code,
            noSessionCreated:
              providerStartFailure.body.prohibitedSideEffects.controllerSessionCreated === false,
            auditId: providerStartFailure.body.auditId,
            replayAuditId: providerStartFailureReplayAudit.auditId,
          },
        },
        invalidPreparation: {
          code: invalidPreparationState.preparationOutcomes[0].response.code,
          issueNumber: 1_000_000_000,
          retainedHostOutcome: true,
          replayIdempotent: true,
          replayReturnedOriginalAudit:
            invalidPreparationReplayAudit.details.originalAuditId
              === invalidPreparationAudit.auditId,
          delegatedWorkStarted: invalidPreparationState.preparationOutcomes[0]
            .response.prohibitedSideEffects.delegatedWorkStarted,
          auditId: invalidPreparationAudit.auditId,
          replayAuditId: invalidPreparationReplayAudit.auditId,
        },
        overlongPreparation: {
          code: overlongPreparationState.preparationOutcomes[1].response.code,
          issueDigitCount: overlongIssueNumber.length,
          branchLength: `sandcastle/issue-${overlongIssueNumber}`.length,
          retainedHostOutcome: true,
          replayIdempotent: true,
          replayReturnedOriginalAudit:
            overlongPreparationReplayAudit.details.originalAuditId
              === overlongPreparationAudit.auditId,
          delegatedWorkStarted: overlongPreparationState.preparationOutcomes[1]
            .response.prohibitedSideEffects.delegatedWorkStarted,
          auditId: overlongPreparationAudit.auditId,
          replayAuditId: overlongPreparationReplayAudit.auditId,
        },
        materialDeviation: {
          kind: "project_path_replaced",
          launchRequestId: replacementCandidate.launchRequestId,
          code: replacementExpiryAudit.details.code,
          status: afterReplacement.status,
          revision: afterReplacement.revision,
          auditId: replacementExpiryAudit.auditId,
        },
        decision: {
          code: "launch_request_approved",
          auditId: approvalAudit.auditId,
          idempotentReplayAuditId: replayAudit.auditId,
          staleRevision: { code: staleAudit.details.code, actualRevision: 1 },
          browserApproval: prohibitedBrowserApproval,
        },
        terminal: {
          streamId,
          runtimeOwned: retainedSession.terminal.runtimeOwned,
          survivesBrowserDisconnection: retainedSession.terminal.status === "running",
          writableAttachment: "exclusive",
          competingWritableRejectedAs: competingWriter.code,
          secondaryView: { mode: readOnlyView.mode, exclusive: readOnlyView.exclusive },
        },
        auditReferences: replacementAudits.filter((entry) =>
          entry.action.startsWith("launch.request")
          || entry.action.startsWith("controller.")
          || entry.action === "project.session.open"),
        prohibitedSideEffectAssertions: {
          browserApprovalAccepted: false,
          delegatedWorkStarted: false,
          harnessRunStarted: false,
          projectFileWrite: false,
          sudo: false,
          systemPackageInstall: false,
          shellProfileMutation: false,
          serviceConfiguration: false,
        },
        securityAssertions: {
          secretAbsentFromPage: !pageText.includes(secretFixture),
          secretAbsentFromRetainedState: !retainedText.includes(secretFixture),
          previewSecretFree: pendingRequest.preview.secretFree,
        },
        scopeExclusions: [
          "dangerous-mode",
          "production-claude-completeness",
          "external-writable-attachment-transfer",
          "arbitrary-interactive-worker-instruction",
          "harness-run-execution",
        ],
        software: {
          sandking: "0.1.0",
          browserProtocol: acknowledgement.protocol.version,
          browser: browser.version(),
          node: process.version,
        },
      };
      assert.ok(Object.values(observation.securityAssertions).every(Boolean));
      assert.ok(Object.values(observation.prohibitedSideEffectAssertions).every(
        (observed) => observed === false,
      ));
      if (process.env.SANDKING_ACCEPTANCE_OBSERVATION_PATH) {
        await writeFile(
          process.env.SANDKING_ACCEPTANCE_OBSERVATION_PATH,
          `${JSON.stringify(observation, null, 2)}\n`,
          { mode: 0o600 },
        );
      }
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
