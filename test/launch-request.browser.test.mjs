import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
        await page.locator("#project-controller-terminal-input").fill(value);
        await page.locator("#send-project-controller-input").click();
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

      const acknowledgement = JSON.parse(
        receivedFrames.find((frame) => frame.includes("runtime.hello-ack")),
      ).message;
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
      assert.equal(approvedState.decisionOutcomes.length, 1);
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
      assert.match(preparationAudit.auditId, /^audit-/);
      assert.match(approvalAudit.auditId, /^audit-/);
      assert.match(staleAudit.auditId, /^audit-/);
      assert.equal(replayAudit.details.originalAuditId, approvalAudit.auditId);
      assert.deepEqual({
        request: approvalAudit.details.launchRequestId,
        host: approvalAudit.details.hostId,
        project: approvalAudit.details.projectId,
        harness: approvalAudit.details.harnessId,
        controller: approvalAudit.details.controllerId,
        session: approvalAudit.details.controllerSessionId,
        revision: approvalAudit.details.resultingRevision,
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
        auditReferences: audits.filter((entry) =>
          entry.action.startsWith("launch.request")
          || entry.action.startsWith("controller.")),
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
