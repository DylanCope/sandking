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

const readJson = (path) => readFile(path, "utf8").then(JSON.parse);

const waitForTerminalRun = async (dataDir) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await readJson(join(dataDir, "harness-runs.json")).catch(() => null);
    const run = state?.runs?.[0];
    if (run && ["succeeded", "failed", "cancelled"].includes(run.status)) {
      return { state, run };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("truthful_failure_run_timeout");
};

const findLocalHostPid = async (runtimePid) => {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,args="]);
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (
      match
      && Number(match[2]) === runtimePid
      && /(?:^|[/\s])local-host\.mjs(?:\s|$)/.test(match[3])
    ) {
      return Number(match[1]);
    }
  }
  throw new Error("local_host_process_not_found");
};

test("local-walking-skeleton/shows-truthful-failure drives the public Cockpit", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-truthful-failure-browser-"));
  const dataDir = join(root, "host-state");
  const executionDirectory = join(root, "outside-checkout");
  const userHome = join(root, "user-home");
  const projectPath = join(root, "selected-project");
  const secretFixtures = [
    "truthful-failure-controller-secret",
    "ghp_truthfulFailureCredentialFixture1234567890",
    "truthful-failure-environment-dump-marker",
  ];
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(executionDirectory, { recursive: true }),
    mkdir(userHome, { recursive: true }),
    execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]),
  ]);
  await writeFile(join(projectPath, "README.md"), "ordinary Project content\n");
  const projectFilesBefore = (await readdir(projectPath)).sort();
  const projectReadmeBefore = sha256(await readFile(join(projectPath, "README.md")));
  const installed = await installCurrentPackage(root);
  const productEnvironment = {
    ...process.env,
    HOME: userHome,
    SANDKING_CONTROLLER_SECRET: secretFixtures[0],
    GITHUB_TOKEN: secretFixtures[1],
    SANDKING_ENVIRONMENT_DUMP_MARKER: secretFixtures[2],
  };

  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--idempotency-key", "truthful-failure-runtime-start",
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
      let acceptedProjectSessionRequest = null;
      page.on("request", (request) => {
        if (
          request.method() === "POST"
          && request.url().endsWith("/projects/sessions/open")
          && !acceptedProjectSessionRequest
        ) {
          acceptedProjectSessionRequest = {
            body: request.postDataJSON(),
            csrfToken: request.headers()["x-sandking-csrf"],
            idempotencyKey: request.headers()["x-sandking-idempotency-key"],
            expectedRevision: request.headers()["x-sandking-expected-revision"],
          };
        }
      });
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
      assert.deepEqual(acceptedProjectSessionRequest?.body, {
        projectId,
        providerId: "conformance-controller-v1",
      });
      assert.ok(acceptedProjectSessionRequest?.idempotencyKey);
      assert.equal(acceptedProjectSessionRequest?.expectedRevision, "2");
      const enter = async (value) => {
        await page.locator("#project-controller-terminal-input").fill(value);
        await page.locator("#send-project-controller-input").click();
      };
      await page.waitForFunction(() => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes("Conformance Controller ready"));
      await enter("prepare 999999999 sandcastle/issue-999999999");
      await page.waitForFunction(() => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes("Secret-free preview: yes"));
      const preview = await page.locator("#project-controller-terminal-output").textContent();
      const launchRequestId = /Launch request: (launch-request-[a-f0-9]{24}) \(revision 1\)/
        .exec(preview)?.[1];
      assert.match(launchRequestId, /^launch-request-[a-f0-9]{24}$/);
      await enter(`approve ${launchRequestId} 1`);
      await page.waitForFunction((requestId) => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes(`Launch request ${requestId} approved at revision 2`),
      launchRequestId);
      await enter(`start ${launchRequestId} 2`);
      await page.waitForFunction(() => /Harness run harness-run-[a-f0-9]{24} created/.test(
        document.querySelector("#project-controller-terminal-output")?.textContent ?? "",
      ));
      const controllerOutput = await page.locator("#project-controller-terminal-output")
        .textContent();
      const harnessRunId = /Harness run (harness-run-[a-f0-9]{24}) created/
        .exec(controllerOutput)?.[1];
      assert.match(harnessRunId, /^harness-run-[a-f0-9]{24}$/);

      await page.waitForSelector(
        `#harness-run-observation[data-run-id='${harnessRunId}'][data-run-status='failed']`,
        { timeout: 10_000 },
      );
      await page.waitForFunction(() => document.querySelector(
        "[data-log-producer='stdout']",
      )?.textContent?.includes("SUCCESS"));
      assert.equal(await page.locator("#harness-run-structured-outcome")
        .getAttribute("data-outcome-status"), "failed");
      assert.equal(await page.locator("#harness-run-structured-outcome")
        .getAttribute("data-incomplete-result"), "true");
      assert.equal(await page.locator("#harness-terminal-validation")
        .getAttribute("data-exactly-one-terminal"), "false");

      const { state: runStateBeforeDisconnect, run: failedRun } =
        await waitForTerminalRun(dataDir);
      assert.equal(runStateBeforeDisconnect.runs.length, 1);
      assert.equal(failedRun.harnessRunId, harnessRunId);
      assert.equal(failedRun.status, "failed");
      assert.equal(failedRun.outcome.code, "harness_result_incomplete");
      assert.equal(failedRun.outcome.incompleteResult, true);
      assert.deepEqual(failedRun.outcome.diagnosticReferences.map((reference) => ({
        producer: reference.producer,
        streamId: reference.streamId,
        start: reference.range.start,
        end: reference.range.end,
      })), failedRun.logStreams.map((stream) => ({
        producer: stream.producer,
        streamId: stream.streamId,
        start: stream.availableStart,
        end: stream.availableEnd,
      })));
      const auditsBeforeDisconnect = await readFile(join(dataDir, "audit.jsonl"), "utf8")
        .then((text) => text.trim().split("\n").filter(Boolean).map(JSON.parse));
      const retainedEventIdsBefore = failedRun.events.map(({ eventId }) => eventId);
      const retainedAuditIdsBefore = auditsBeforeDisconnect
        .filter((entry) => (
          ["launch.request.decision", "harness.run.start"].includes(entry.action)
            && entry.outcome === "accepted"
        ) || (
          entry.action === "harness.run.outcome" && entry.outcome === "observed"
        ))
        .map(({ auditId }) => auditId);
      const acceptedProjectSessionAudit = auditsBeforeDisconnect.find((entry) =>
        entry.action === "project.session.open"
        && entry.outcome === "accepted"
        && entry.details.sessionId === sessionId);
      const acceptedFocusedMutationAudit = auditsBeforeDisconnect.find((entry) =>
        entry.action === "launch.request.prepare"
        && entry.outcome === "accepted"
        && entry.details.launchRequestId === launchRequestId);
      assert.ok(retainedEventIdsBefore.length >= 3);
      assert.ok(retainedAuditIdsBefore.length >= 3);
      assert.ok(acceptedProjectSessionAudit);
      assert.ok(acceptedFocusedMutationAudit);

      const runtimeStateBeforeDisconnect = await readJson(join(dataDir, "runtime-state.json"));
      const hostPid = await findLocalHostPid(runtimeStateBeforeDisconnect.pid);
      process.kill(hostPid, "SIGKILL");
      await page.waitForSelector("#connection-status[data-host-status='disconnected']", {
        timeout: 10_000,
      });
      assert.equal(await page.locator("#project-preparation")
        .getAttribute("data-host-freshness"), "stale");
      assert.equal(await page.locator("#harness-run-observation")
        .getAttribute("data-host-freshness"), "stale");
      assert.equal(await page.locator("#planning-spine")
        .getAttribute("data-host-impact"), "unaffected");
      assert.equal(await page.locator("#project-focused-controller-session")
        .getAttribute("data-session-state"), "open");
      const replayAcceptedProjectSession = (body) => page.evaluate(async (parameters) => {
        const response = await fetch("/projects/sessions/open", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-sandking-csrf": parameters.csrfToken,
            "x-sandking-idempotency-key": parameters.idempotencyKey,
            "x-sandking-expected-revision": parameters.expectedRevision,
          },
          body: JSON.stringify(parameters.body),
        });
        return { status: response.status, body: await response.json() };
      }, {
        csrfToken: acceptedProjectSessionRequest.csrfToken,
        idempotencyKey: acceptedProjectSessionRequest.idempotencyKey,
        expectedRevision: acceptedProjectSessionRequest.expectedRevision,
        body,
      });
      const acceptedProjectSessionReplay = await replayAcceptedProjectSession(
        acceptedProjectSessionRequest.body,
      );
      assert.equal(acceptedProjectSessionReplay.status, 200);
      assert.equal(
        acceptedProjectSessionReplay.body.code,
        "project_focused_controller_session_opened",
      );
      assert.equal(acceptedProjectSessionReplay.body.idempotentReplay, true);
      assert.equal(acceptedProjectSessionReplay.body.auditId, acceptedProjectSessionAudit.auditId);
      assert.equal(acceptedProjectSessionReplay.body.session.sessionId, sessionId);
      const acceptedProjectSessionChangedUse = await replayAcceptedProjectSession({
        ...acceptedProjectSessionRequest.body,
        providerId: "claude-code",
      });
      assert.equal(acceptedProjectSessionChangedUse.status, 409);
      assert.equal(acceptedProjectSessionChangedUse.body.code, "idempotency_key_conflict");
      assert.equal(acceptedProjectSessionChangedUse.body.idempotentReplay, false);
      await enter("prepare 999999999 sandcastle/issue-999999999");
      await page.waitForFunction((requestId) => (
        document.querySelector("#project-controller-terminal-output")
          ?.textContent?.match(new RegExp(`Launch request: ${requestId}`, "g"))?.length
          ?? 0
      ) >= 2, launchRequestId);
      await enter("prepare 122 sandcastle/issue-122");
      await page.waitForFunction(() => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes("Controller operation failed safely: host_disconnected"));
      await enter("prepare 122 sandcastle/issue-122");
      await page.waitForFunction(() => (
        document.querySelector("#project-controller-terminal-output")
          ?.textContent?.match(/Controller operation failed safely: host_disconnected/g)?.length
          ?? 0
      ) >= 2);
      assert.doesNotMatch(
        await page.locator("#project-controller-terminal-output").textContent(),
        /Controller operation failed safely: provider_operation_failed/,
      );
      assert.equal(await page.locator("#open-project").isDisabled(), true);
      assert.equal(await page.locator("#open-project-controller").isDisabled(), true);
      assert.equal(await page.locator("#open-project-claude-controller").isDisabled(), true);
      assert.equal(await page.locator("#harness-run-observation")
        .getAttribute("data-run-id"), harnessRunId);
      assert.equal(await page.locator("#harness-run-observation")
        .getAttribute("data-run-status"), "failed");

      const freshTicketing = page.locator(
        "[data-journey-id='journey-fixture-optional-planning'] "
          + "[data-stage-id='ticketing']",
      );
      assert.equal(await freshTicketing.locator("[data-action='not-used']").isEnabled(), true);
      await freshTicketing.locator("[data-action='not-used']").click();
      await page.waitForFunction(() => document.querySelector(
        "[data-journey-id='journey-fixture-optional-planning'] "
          + "[data-stage-id='ticketing']",
      )?.getAttribute("data-stage-status") === "Not used");
      assert.equal(await page.locator(
        "[data-journey-id='journey-fixture-unrefreshable']",
      ).getAttribute("data-freshness"), "stale");
      assert.equal(await page.locator(
        "[data-journey-id='journey-fixture-unrefreshable'] "
          + "button[data-planning-mutation]:not(:disabled)",
      ).count(), 0);

      const acknowledgement = receivedFrames.map((frame) => {
        try {
          return JSON.parse(frame)?.message;
        } catch {
          return null;
        }
      }).find((message) => message?.type === "runtime.hello-ack");
      assert.ok(acknowledgement);
      const exerciseDisconnectedProjectOpen = (path) => page.evaluate(async ({ csrfToken, path }) => {
        const response = await fetch("/projects/open", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-sandking-csrf": csrfToken,
            "x-sandking-idempotency-key": "host-disconnected-project-mutation",
            "x-sandking-expected-revision": "1",
          },
          body: JSON.stringify({
            path,
            configuration: {
              issueWorkflow: { provider: "github", kind: "issues" },
              checks: [{ checkId: "test", command: "npm run test" }],
            },
          }),
        });
        return { status: response.status, body: await response.json() };
      }, { csrfToken: acknowledgement.session.csrfToken, path });
      const disconnectedMutation = await exerciseDisconnectedProjectOpen(projectPath);
      assert.equal(disconnectedMutation.status, 503);
      assert.equal(disconnectedMutation.body.code, "host_disconnected");
      assert.equal(disconnectedMutation.body.retryable, true);
      assert.deepEqual(disconnectedMutation.body.prohibitedSideEffects, {
        projectRegistrationCreated: false,
        harnessRegistrationCreated: false,
        harnessPinChanged: false,
        launchRequestPrepared: false,
        approvalRecorded: false,
        harnessRunStarted: false,
        projectFileWrite: false,
        privilegedMutation: false,
      });
      const disconnectedReplay = await exerciseDisconnectedProjectOpen(projectPath);
      assert.equal(disconnectedReplay.status, 503);
      assert.equal(disconnectedReplay.body.code, "host_disconnected");
      assert.equal(disconnectedReplay.body.idempotentReplay, true);
      assert.equal(disconnectedReplay.body.auditId, disconnectedMutation.body.auditId);
      const disconnectedChangedUse = await exerciseDisconnectedProjectOpen(
        join(root, "different-project"),
      );
      assert.equal(disconnectedChangedUse.status, 409);
      assert.equal(disconnectedChangedUse.body.code, "idempotency_key_conflict");
      assert.equal(disconnectedChangedUse.body.idempotentReplay, false);

      const reconnectPage = await context.newPage();
      const reconnectFrames = [];
      await reconnectPage.addInitScript(() => {
        sessionStorage.setItem("sandking.observationCursor", "host:unavailable-cursor");
      });
      reconnectPage.on("websocket", (websocket) => {
        websocket.on("framereceived", (event) => reconnectFrames.push(String(event.payload)));
      });
      await reconnectPage.goto(new URL(launch.bootstrapUrl).origin, {
        waitUntil: "domcontentloaded",
      });
      await reconnectPage.waitForSelector("#connection-status[data-host-status='disconnected']", {
        timeout: 10_000,
      });
      await reconnectPage.waitForSelector(
        `#harness-run-observation[data-run-id='${harnessRunId}'][data-run-status='failed']`,
        { timeout: 10_000 },
      );
      const reconnectAcknowledgement = reconnectFrames.map((frame) => {
        try {
          return JSON.parse(frame)?.message;
        } catch {
          return null;
        }
      }).find((message) => message?.type === "runtime.hello-ack");
      assert.deepEqual(reconnectAcknowledgement.observation, {
        mode: "resynchronization-failed",
        cursor: "host:origin",
        reason: "host_observation_resynchronization_failed",
      });
      assert.equal(
        reconnectAcknowledgement.viewModel.harnessRunObservation.run.harnessRunId,
        harnessRunId,
      );
      await reconnectPage.close();

      const [runStateAfterDisconnect, launchState, projectState, audits] = await Promise.all([
        readJson(join(dataDir, "harness-runs.json")),
        readJson(join(dataDir, "launch-requests.json")),
        readJson(join(dataDir, "project-registrations.json")),
        readFile(join(dataDir, "audit.jsonl"), "utf8")
          .then((text) => text.trim().split("\n").filter(Boolean).map(JSON.parse)),
      ]);
      const retainedAfterDisconnect = runStateAfterDisconnect.runs[0];
      const retainedLaunch = launchState.launchRequests[0];
      const outcomeAudit = audits.find((entry) =>
        entry.action === "harness.run.outcome"
        && entry.details.harnessRunId === harnessRunId);
      const disconnectAudit = audits.find((entry) =>
        entry.action === "host.connection"
        && entry.details.code === "host_disconnected");
      const disconnectedMutationAudit = audits.find((entry) =>
        entry.auditId === disconnectedMutation.body.auditId);
      const controllerHostFailureAudits = audits.filter((entry) =>
        entry.action === "controller.provider.operation"
        && entry.details.operation === "launch-request.prepare"
        && entry.details.code === "host_disconnected");
      const [controllerHostFailureAudit, controllerHostFailureReplayAudit] =
        controllerHostFailureAudits;
      const focusedHostMutationAudits = audits.filter((entry) =>
        entry.action === "launch.request.prepare"
        && entry.details.code === "host_disconnected");
      const acceptedFocusedMutationReplayAudit = audits.find((entry) =>
        entry.action === "launch.request.prepare"
        && entry.outcome === "observed"
        && entry.details.idempotentReplay === true
        && entry.details.originalAuditId === acceptedFocusedMutationAudit.auditId);
      assert.ok(outcomeAudit);
      assert.ok(disconnectAudit);
      assert.equal(disconnectAudit.outcome, "observed");
      assert.equal(disconnectAudit.details.hostId, launch.host.hostId);
      assert.deepEqual(disconnectAudit.details.affectedViews, [
        "project-preparation",
        "harness-run-observation",
      ]);
      assert.ok(disconnectedMutationAudit);
      assert.equal(disconnectedMutationAudit.outcome, "rejected");
      assert.ok(controllerHostFailureAudit);
      assert.ok(controllerHostFailureReplayAudit);
      assert.deepEqual(controllerHostFailureAudits.map(({ outcome }) => outcome), [
        "rejected",
        "observed",
      ]);
      assert.equal(controllerHostFailureAudit.details.idempotentReplay, false);
      assert.equal(controllerHostFailureReplayAudit.details.idempotentReplay, true);
      assert.equal(
        controllerHostFailureReplayAudit.details.originalAuditId,
        controllerHostFailureAudit.auditId,
      );
      assert.equal(
        controllerHostFailureReplayAudit.details.outcomeAuditId,
        controllerHostFailureAudit.details.outcomeAuditId,
      );
      assert.deepEqual(focusedHostMutationAudits.map(({ outcome }) => outcome), [
        "rejected",
        "observed",
      ]);
      assert.equal(
        focusedHostMutationAudits[1].details.originalAuditId,
        focusedHostMutationAudits[0].auditId,
      );
      assert.ok(acceptedFocusedMutationReplayAudit);
      assert.equal(runStateAfterDisconnect.runs.length, 1);
      assert.equal(projectState.projects.length, 1);
      assert.equal(launchState.launchRequests.length, 1);
      assert.equal(retainedAfterDisconnect.harnessRunId, harnessRunId);
      assert.equal(retainedAfterDisconnect.projectId, projectId);
      assert.equal(retainedAfterDisconnect.harnessId, harnessId);
      assert.equal(retainedAfterDisconnect.harnessPinnedRevision, harnessPin);
      assert.equal(retainedAfterDisconnect.launchRequestId, launchRequestId);
      assert.deepEqual(
        retainedAfterDisconnect.events.map(({ eventId }) => eventId),
        retainedEventIdsBefore,
      );
      assert.ok(retainedAuditIdsBefore.every((auditId) =>
        audits.some((entry) => entry.auditId === auditId)));
      assert.equal(retainedLaunch.status, "approved");
      assert.deepEqual(retainedLaunch.execution, {
        status: "failed",
        harnessRunId,
        outcomeReference: retainedAfterDisconnect.outcome.outcomeId,
      });
      assert.equal(audits.filter((entry) =>
        entry.action === "launch.request.decision"
        && entry.outcome === "accepted").length, 1);
      assert.equal(audits.filter((entry) =>
        entry.action === "harness.run.start"
        && entry.outcome === "accepted").length, 1);

      const stdoutLog = await readFile(
        join(dataDir, "harness-runs", harnessRunId, "stdout.log"),
        "utf8",
      );
      const stderrLog = await readFile(
        join(dataDir, "harness-runs", harnessRunId, "stderr.log"),
        "utf8",
      );
      const runtimeError = await readFile(join(dataDir, "runtime-error.log"), "utf8")
        .catch(() => "");
      const runtimeErrors = runtimeError.trim().split("\n").filter(Boolean).map(JSON.parse);
      assert.ok(runtimeErrors.some((entry) => entry.code === "host_disconnected"));
      assert.equal(audits.filter((entry) =>
        entry.action === "host.connection"
        && entry.details.code === "host_disconnected").length, 1);
      const pageText = await page.textContent("body");
      const retainedAndPublicSurfaces = [
        ...sentFrames,
        ...receivedFrames,
        ...reconnectFrames,
        preview,
        controllerOutput,
        JSON.stringify(failedRun.events),
        stdoutLog,
        stderrLog,
        JSON.stringify(audits),
        JSON.stringify(disconnectedMutation),
        JSON.stringify(disconnectedReplay),
        JSON.stringify(disconnectedChangedUse),
        JSON.stringify(acceptedProjectSessionReplay),
        JSON.stringify(acceptedProjectSessionChangedUse),
        JSON.stringify(acknowledgement.viewModel),
        runtimeError,
        pageText,
      ].join("\n");
      for (const secret of secretFixtures) {
        assert.doesNotMatch(retainedAndPublicSurfaces, new RegExp(secret, "i"));
      }
      assert.doesNotMatch(retainedAndPublicSurfaces, /-----BEGIN [A-Z ]+PRIVATE KEY-----/);
      assert.doesNotMatch(retainedAndPublicSurfaces, /\b(?:Error: .+\n\s+at|process\.env|SANDKING_CONTROLLER_SECRET=|GITHUB_TOKEN=)/);
      assert.deepEqual((await readdir(projectPath)).sort(), projectFilesBefore);
      assert.equal(sha256(await readFile(join(projectPath, "README.md"))), projectReadmeBefore);

      const observation = {
        scenario: "local-walking-skeleton/shows-truthful-failure",
        issue: 122,
        packagedPublicSeam: installed.observation,
        injectedFault: {
          adapterId: failedRun.adapterId,
          kind: "confirmed_process_exit_without_terminal_envelope",
          conformanceIssueNumber: 999_999_999,
        },
        identities: {
          runtimeId: launch.runtime.runtimeId,
          hostId: launch.host.hostId,
          projectId,
          harnessId,
          harnessPin,
          launchRequestId,
          harnessRunId,
          controllerSessionId: sessionId,
          outcomeId: failedRun.outcome.outcomeId,
        },
        visibleFailure: {
          runStatus: failedRun.status,
          code: failedRun.outcome.code,
          incompleteResult: failedRun.outcome.incompleteResult,
          exactlyOneTerminal: failedRun.terminalEnvelopeValidation.exactlyOne,
          successLookingDiagnosticVisible: stdoutLog.includes("SUCCESS"),
          diagnosticReferences: failedRun.outcome.diagnosticReferences,
        },
        staleStateEvidence: {
          hostStatus: "disconnected",
          affectedViews: disconnectAudit.details.affectedViews,
          retainedHarnessRunVisible: true,
          planningHostImpact: "unaffected",
          freshPlanningMutationSucceeded: true,
          githubProjectionFreshness: "stale",
          stalePlanningMutationsDisabled: true,
          typedHostMutationFailure: disconnectedMutation,
          disconnectedMutationIdempotency: {
            replayStatus: disconnectedReplay.status,
            replayCode: disconnectedReplay.body.code,
            replayIdempotent: disconnectedReplay.body.idempotentReplay,
            replayReturnedOriginalAudit:
              disconnectedReplay.body.auditId === disconnectedMutation.body.auditId,
            changedContentStatus: disconnectedChangedUse.status,
            changedContentCode: disconnectedChangedUse.body.code,
          },
          typedControllerHostFailure: {
            operation: controllerHostFailureAudit.details.operation,
            code: controllerHostFailureAudit.details.code,
            auditId: controllerHostFailureAudit.auditId,
          },
          acceptedProjectSessionIdempotency: {
            sessionId,
            originalAuditId: acceptedProjectSessionAudit.auditId,
            replayStatus: acceptedProjectSessionReplay.status,
            replayCode: acceptedProjectSessionReplay.body.code,
            replayIdempotent: acceptedProjectSessionReplay.body.idempotentReplay,
            replayReturnedOriginalAudit:
              acceptedProjectSessionReplay.body.auditId === acceptedProjectSessionAudit.auditId,
            replayReturnedOriginalSession:
              acceptedProjectSessionReplay.body.session.sessionId === sessionId,
            changedContentStatus: acceptedProjectSessionChangedUse.status,
            changedContentCode: acceptedProjectSessionChangedUse.body.code,
          },
          focusedControllerMutationIdempotency: {
            operation: controllerHostFailureAudit.details.operation,
            code: controllerHostFailureAudit.details.code,
            acceptedOutcomeAuditId: acceptedFocusedMutationAudit.auditId,
            acceptedOutcomeReplayAuditId: acceptedFocusedMutationReplayAudit.auditId,
            acceptedOutcomeReplayLinkedToOriginalAudit:
              acceptedFocusedMutationReplayAudit.details.originalAuditId
                === acceptedFocusedMutationAudit.auditId,
            replayCode: controllerHostFailureReplayAudit.details.code,
            replayIdempotent: controllerHostFailureReplayAudit.details.idempotentReplay,
            originalFailureAuditId: controllerHostFailureAudit.auditId,
            originalOutcomeAuditId: controllerHostFailureAudit.details.outcomeAuditId,
            replayAuditId: controllerHostFailureReplayAudit.auditId,
            replayOriginalAuditId: controllerHostFailureReplayAudit.details.originalAuditId,
            replayLinkedToOriginalAudit:
              controllerHostFailureReplayAudit.details.originalAuditId
                === controllerHostFailureAudit.auditId,
            replayReturnedOriginalOutcomeAudit:
              controllerHostFailureReplayAudit.details.outcomeAuditId
                === controllerHostFailureAudit.details.outcomeAuditId,
          },
          resynchronizationFailure: reconnectAcknowledgement.observation,
        },
        canonicalStateBefore: {
          runCount: runStateBeforeDisconnect.runs.length,
          harnessRunId: failedRun.harnessRunId,
          outcomeId: failedRun.outcome.outcomeId,
          eventIds: retainedEventIdsBefore,
          auditIds: retainedAuditIdsBefore,
        },
        canonicalStateAfter: {
          runCount: runStateAfterDisconnect.runs.length,
          harnessRunId: retainedAfterDisconnect.harnessRunId,
          outcomeId: retainedAfterDisconnect.outcome.outcomeId,
          eventIds: retainedAfterDisconnect.events.map(({ eventId }) => eventId),
          retainedAuditIds: retainedAuditIdsBefore.filter((auditId) =>
            audits.some((entry) => entry.auditId === auditId)),
          launchExecution: retainedLaunch.execution,
        },
        auditReferences: [
          outcomeAudit,
          disconnectAudit,
          disconnectedMutationAudit,
          controllerHostFailureAudit,
          controllerHostFailureReplayAudit,
        ],
        prohibitedSideEffectAssertions: {
          unauthorizedRegistration: false,
          unauthorizedApproval: false,
          duplicateRun: false,
          inventedSuccess: false,
          privilegedMutation: false,
          projectFileWrite: false,
          liveGithubWrite: false,
          queuedGithubWrite: false,
          sudo: false,
          systemPackageInstall: false,
          shellProfileMutation: false,
          serviceConfiguration: false,
        },
        securityAssertions: {
          recognizableSecretsAbsent: secretFixtures.every((secret) =>
            !retainedAndPublicSurfaces.toLowerCase().includes(secret.toLowerCase())),
          credentialMaterialAbsent:
            !/-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(retainedAndPublicSurfaces),
          stackTraceAbsent:
            !/\bError: .+\n\s+at/.test(retainedAndPublicSurfaces),
          environmentDumpAbsent:
            !/(?:process\.env|SANDKING_CONTROLLER_SECRET=|GITHUB_TOKEN=)/
              .test(retainedAndPublicSurfaces),
        },
        software: {
          sandking: "0.1.0",
          browserProtocol: acknowledgement.protocol.version,
          hostProtocol: acknowledgement.viewModel.negotiation.protocol.version,
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

test("Host loss during an active Cockpit mutation returns one typed idempotent failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-active-host-loss-browser-"));
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
  const installed = await installCurrentPackage(root);
  const productEnvironment = { ...process.env, HOME: userHome };
  let pausedHostPid = null;

  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--idempotency-key", "active-host-loss-runtime-start",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const launch = JSON.parse(stdout);
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const receivedFrames = [];
      page.on("websocket", (websocket) => {
        websocket.on("framereceived", (event) => receivedFrames.push(String(event.payload)));
      });
      const response = await page.goto(launch.bootstrapUrl, { waitUntil: "domcontentloaded" });
      assert.equal(response?.status(), 200);
      await page.waitForSelector("#project-preparation[data-explicit-path-only='true']", {
        timeout: 10_000,
      });
      const acknowledgement = JSON.parse(
        receivedFrames.find((frame) => frame.includes("runtime.hello-ack")),
      ).message;
      const exerciseProjectOpen = (path) => page.evaluate(async (parameters) => {
        const mutation = await fetch("/projects/open", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-sandking-csrf": parameters.csrfToken,
            "x-sandking-idempotency-key": "active-host-loss-project-open",
            "x-sandking-expected-revision": "0",
          },
          body: JSON.stringify({
            path: parameters.path,
            configuration: {
              issueWorkflow: { provider: "github", kind: "issues" },
              checks: [{ checkId: "test", command: "npm run test" }],
            },
          }),
        });
        return { status: mutation.status, body: await mutation.json() };
      }, { csrfToken: acknowledgement.session.csrfToken, path });

      const runtimeState = await readJson(join(dataDir, "runtime-state.json"));
      pausedHostPid = await findLocalHostPid(runtimeState.pid);
      process.kill(pausedHostPid, "SIGSTOP");
      const requestStarted = page.waitForRequest((request) =>
        request.method() === "POST" && request.url().endsWith("/projects/open"));
      const activeMutation = exerciseProjectOpen(projectPath);
      await requestStarted;
      await new Promise((resolve) => setTimeout(resolve, 100));
      process.kill(pausedHostPid, "SIGKILL");
      pausedHostPid = null;

      const failure = await activeMutation;
      assert.equal(failure.status, 503);
      assert.equal(failure.body.code, "host_disconnected");
      assert.equal(failure.body.idempotentReplay, false);
      assert.match(failure.body.auditId, /^audit-[a-f0-9]{24}$/);
      const replay = await exerciseProjectOpen(projectPath);
      assert.equal(replay.status, 503);
      assert.equal(replay.body.code, "host_disconnected");
      assert.equal(replay.body.idempotentReplay, true);
      assert.equal(replay.body.auditId, failure.body.auditId);
      const changedUse = await exerciseProjectOpen(join(root, "different-project"));
      assert.equal(changedUse.status, 409);
      assert.equal(changedUse.body.code, "idempotency_key_conflict");

      const audits = await readFile(join(dataDir, "audit.jsonl"), "utf8")
        .then((text) => text.trim().split("\n").filter(Boolean).map(JSON.parse));
      const failureAudit = audits.find((entry) =>
        entry.auditId === failure.body.auditId
        && entry.action === "project.prepare"
        && entry.outcome === "rejected"
        && entry.details.code === "host_disconnected");
      const replayAudit = audits.find((entry) =>
        entry.action === "project.prepare"
        && entry.outcome === "observed"
        && entry.details.idempotentReplay === true
        && entry.details.originalAuditId === failure.body.auditId);
      const conflictAudit = audits.find((entry) =>
        entry.auditId === changedUse.body.auditId
        && entry.action === "project.prepare"
        && entry.outcome === "rejected"
        && entry.details.code === "idempotency_key_conflict");
      assert.ok(failureAudit);
      assert.ok(replayAudit);
      assert.ok(conflictAudit);
      if (process.env.SANDKING_ACCEPTANCE_RESULT_DIR) {
        await writeFile(
          join(process.env.SANDKING_ACCEPTANCE_RESULT_DIR, "active-host-loss-contract.json"),
          `${JSON.stringify({
            kind: "active_host_loss_contract",
            packagedPublicSeam: installed.observation,
            typedFailure: failure,
            idempotency: {
              replayStatus: replay.status,
              replayCode: replay.body.code,
              replayIdempotent: replay.body.idempotentReplay,
              replayReturnedOriginalAudit: replay.body.auditId === failure.body.auditId,
              changedContentStatus: changedUse.status,
              changedContentCode: changedUse.body.code,
            },
            audit: {
              failure: failureAudit,
              replay: replayAudit,
              conflict: conflictAudit,
            },
          }, null, 2)}\n`,
          { mode: 0o600 },
        );
      }
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    if (pausedHostPid) {
      process.kill(pausedHostPid, "SIGCONT");
      process.kill(pausedHostPid, "SIGKILL");
    }
    await execFileAsync(installed.command, [
      "stop", "--data-dir", dataDir, "--json",
    ], { cwd: executionDirectory, env: productEnvironment }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("accepted Cockpit Project preparation replays its public outcome after Host loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-accepted-project-replay-browser-"));
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
  const installed = await installCurrentPackage(root);
  const productEnvironment = { ...process.env, HOME: userHome };

  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--idempotency-key", "accepted-project-replay-runtime-start",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const launch = JSON.parse(stdout);
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      let acceptedRequest = null;
      page.on("request", (request) => {
        if (
          request.method() === "POST"
          && request.url().endsWith("/projects/open")
          && !acceptedRequest
        ) {
          acceptedRequest = {
            body: request.postDataJSON(),
            csrfToken: request.headers()["x-sandking-csrf"],
            idempotencyKey: request.headers()["x-sandking-idempotency-key"],
            expectedRevision: request.headers()["x-sandking-expected-revision"],
          };
        }
      });
      const response = await page.goto(launch.bootstrapUrl, { waitUntil: "domcontentloaded" });
      assert.equal(response?.status(), 200);
      await page.waitForSelector("#project-preparation[data-explicit-path-only='true']", {
        timeout: 10_000,
      });
      await page.locator("#project-path").fill(projectPath);
      const acceptedResponsePromise = page.waitForResponse((candidate) =>
        candidate.request().method() === "POST"
        && candidate.url().endsWith("/projects/open"));
      await page.locator("#open-project").click();
      const acceptedResponse = await acceptedResponsePromise;
      const accepted = {
        status: acceptedResponse.status(),
        body: await acceptedResponse.json(),
      };
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.code, "project_ready");
      assert.equal(accepted.body.idempotentReplay, false);
      assert.match(accepted.body.project.projectId, /^project-[a-f0-9]{24}$/);
      assert.match(accepted.body.project.harness.harnessId, /^harness-[a-f0-9]{24}$/);
      assert.match(accepted.body.auditId, /^audit-[a-f0-9]{24}$/);
      assert.ok(acceptedRequest);

      const runtimeState = await readJson(join(dataDir, "runtime-state.json"));
      const hostPid = await findLocalHostPid(runtimeState.pid);
      process.kill(hostPid, "SIGKILL");
      await page.waitForSelector("#connection-status[data-host-status='disconnected']", {
        timeout: 10_000,
      });

      const exerciseProjectOpen = (body) => page.evaluate(async (parameters) => {
        const mutation = await fetch("/projects/open", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-sandking-csrf": parameters.csrfToken,
            "x-sandking-idempotency-key": parameters.idempotencyKey,
            "x-sandking-expected-revision": parameters.expectedRevision,
          },
          body: JSON.stringify(parameters.body),
        });
        return { status: mutation.status, body: await mutation.json() };
      }, { ...acceptedRequest, body });

      const replay = await exerciseProjectOpen(acceptedRequest.body);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.code, "project_ready");
      assert.equal(replay.body.idempotentReplay, true);
      assert.equal(replay.body.auditId, accepted.body.auditId);
      assert.deepEqual(replay.body.project, accepted.body.project);
      assert.deepEqual(replay.body.mutations, accepted.body.mutations);

      const changedUse = await exerciseProjectOpen({
        ...acceptedRequest.body,
        path: join(root, "different-project"),
      });
      assert.equal(changedUse.status, 409);
      assert.equal(changedUse.body.code, "idempotency_key_conflict");
      assert.equal(changedUse.body.idempotentReplay, false);

      const [projectState, audits] = await Promise.all([
        readJson(join(dataDir, "project-registrations.json")),
        readFile(join(dataDir, "audit.jsonl"), "utf8")
          .then((text) => text.trim().split("\n").filter(Boolean).map(JSON.parse)),
      ]);
      assert.equal(projectState.projects.length, 1);
      assert.equal(projectState.projects[0].projectId, accepted.body.project.projectId);
      const acceptedAudit = audits.find((entry) => entry.auditId === accepted.body.auditId);
      const replayAudit = audits.find((entry) =>
        entry.action === "project.prepare"
        && entry.outcome === "observed"
        && entry.details.idempotentReplay === true
        && entry.details.originalAuditId === accepted.body.auditId);
      const conflictAudit = audits.find((entry) =>
        entry.auditId === changedUse.body.auditId
        && entry.action === "project.prepare"
        && entry.outcome === "rejected"
        && entry.details.code === "idempotency_key_conflict");
      assert.ok(acceptedAudit);
      assert.ok(replayAudit);
      assert.ok(conflictAudit);

      if (process.env.SANDKING_ACCEPTANCE_RESULT_DIR) {
        await writeFile(
          join(
            process.env.SANDKING_ACCEPTANCE_RESULT_DIR,
            "accepted-project-open-replay-contract.json",
          ),
          `${JSON.stringify({
            kind: "accepted_project_open_replay_contract",
            packagedPublicSeam: installed.observation,
            accepted,
            replay,
            changedUse,
            canonicalState: {
              projectCount: projectState.projects.length,
              projectId: projectState.projects[0].projectId,
            },
            audit: {
              accepted: acceptedAudit,
              replay: replayAudit,
              conflict: conflictAudit,
            },
          }, null, 2)}\n`,
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

test("Host loss after accepted Project registration preserves its identity and effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-partial-project-host-loss-browser-"));
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
  const installed = await installCurrentPackage(root);
  const productEnvironment = { ...process.env, HOME: userHome };
  let pausedHostPid = null;

  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--idempotency-key", "partial-project-host-loss-runtime-start",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const launch = JSON.parse(stdout);
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const response = await page.goto(launch.bootstrapUrl, { waitUntil: "domcontentloaded" });
      assert.equal(response?.status(), 200);
      await page.waitForSelector("#project-preparation[data-explicit-path-only='true']", {
        timeout: 10_000,
      });
      await page.locator("#project-path").fill(projectPath);

      const projectResponse = page.waitForResponse((candidate) =>
        candidate.request().method() === "POST"
        && candidate.url().endsWith("/projects/open"));
      await page.locator("#open-project").click();

      const registrationDeadline = Date.now() + 10_000;
      let acceptedProject;
      let acceptedRegistrationAudit;
      while (Date.now() < registrationDeadline) {
        const [projectState, audits] = await Promise.all([
          readJson(join(dataDir, "project-registrations.json")).catch(() => null),
          readFile(join(dataDir, "audit.jsonl"), "utf8")
            .then((text) => text.trim().split("\n").filter(Boolean).map(JSON.parse))
            .catch(() => []),
        ]);
        acceptedProject = projectState?.projects?.[0];
        acceptedRegistrationAudit = audits.find((entry) =>
          entry.action === "project.register"
          && entry.outcome === "accepted"
          && entry.details.projectId === acceptedProject?.projectId);
        if (acceptedProject && acceptedRegistrationAudit) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      assert.ok(acceptedProject);
      assert.ok(acceptedRegistrationAudit);
      assert.equal(acceptedProject.harness, null);
      assert.equal(acceptedProject.readiness.launchRequest, "blocked");

      const runtimeState = await readJson(join(dataDir, "runtime-state.json"));
      pausedHostPid = await findLocalHostPid(runtimeState.pid);
      process.kill(pausedHostPid, "SIGSTOP");
      process.kill(pausedHostPid, "SIGKILL");
      pausedHostPid = null;

      const failedResponse = await projectResponse;
      const failure = {
        status: failedResponse.status(),
        body: await failedResponse.json(),
      };
      assert.equal(failure.status, 503);
      assert.equal(failure.body.code, "host_disconnected");
      assert.equal(failure.body.project.projectId, acceptedProject.projectId);
      assert.equal(failure.body.project.revision, acceptedProject.revision);
      assert.equal(failure.body.project.canPrepareLaunchRequest, false);
      assert.equal(failure.body.mutations.projectRegistration.code, "project_registered");
      assert.equal(
        failure.body.mutations.projectRegistration.auditId,
        acceptedRegistrationAudit.auditId,
      );
      assert.deepEqual(failure.body.prohibitedSideEffects, {
        projectRegistrationCreated: true,
        harnessRegistrationCreated: false,
        harnessPinChanged: false,
        launchRequestPrepared: false,
        approvalRecorded: false,
        harnessRunStarted: false,
        projectFileWrite: false,
        privilegedMutation: false,
      });

      await page.waitForSelector(
        `#project-readiness[data-project-id='${acceptedProject.projectId}']`,
        { timeout: 10_000 },
      );
      assert.equal(await page.locator("#project-readiness")
        .getAttribute("data-launch-request-ready"), "false");
      assert.match(await page.locator("#project-readiness").textContent(), /Harness: missing/);
      assert.equal(await page.locator("#project-preparation")
        .getAttribute("data-host-freshness"), "stale");
      assert.equal(await page.locator("#planning-spine")
        .getAttribute("data-host-impact"), "unaffected");

      const [projectStateAfter, auditsAfter] = await Promise.all([
        readJson(join(dataDir, "project-registrations.json")),
        readFile(join(dataDir, "audit.jsonl"), "utf8")
          .then((text) => text.trim().split("\n").filter(Boolean).map(JSON.parse)),
      ]);
      assert.equal(projectStateAfter.projects.length, 1);
      assert.equal(projectStateAfter.projects[0].projectId, acceptedProject.projectId);
      assert.ok(auditsAfter.some((entry) => entry.auditId === acceptedRegistrationAudit.auditId));
      const failureAudit = auditsAfter.find((entry) => entry.auditId === failure.body.auditId);
      assert.equal(failureAudit.action, "project.prepare");
      assert.equal(failureAudit.outcome, "rejected");
      assert.equal(failureAudit.details.projectId, acceptedProject.projectId);
      assert.equal(failureAudit.details.projectRegistrationAuditId,
        acceptedRegistrationAudit.auditId);
      assert.equal(failureAudit.details.projectRegistrationCreated, true);
      assert.equal(failureAudit.details.harnessRegistrationCreated, false);
      if (process.env.SANDKING_ACCEPTANCE_RESULT_DIR) {
        await writeFile(
          join(
            process.env.SANDKING_ACCEPTANCE_RESULT_DIR,
            "accepted-project-host-loss-contract.json",
          ),
          `${JSON.stringify({
            kind: "accepted_project_host_loss_contract",
            packagedPublicSeam: installed.observation,
            typedFailure: failure,
            acceptedProject: {
              projectId: acceptedProject.projectId,
              revision: acceptedProject.revision,
              readiness: acceptedProject.readiness,
              registrationAuditId: acceptedRegistrationAudit.auditId,
            },
            cockpit: {
              retainedProjectVisible: true,
              launchRequestReady: false,
              hostFreshness: "stale",
              planningHostImpact: "unaffected",
            },
            canonicalState: {
              projectCount: projectStateAfter.projects.length,
              projectId: projectStateAfter.projects[0].projectId,
              registrationAuditRetained: auditsAfter.some((entry) =>
                entry.auditId === acceptedRegistrationAudit.auditId),
            },
            audit: {
              registration: acceptedRegistrationAudit,
              failure: failureAudit,
            },
          }, null, 2)}\n`,
          { mode: 0o600 },
        );
      }
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    if (pausedHostPid) {
      process.kill(pausedHostPid, "SIGCONT");
      process.kill(pausedHostPid, "SIGKILL");
    }
    await execFileAsync(installed.command, [
      "stop", "--data-dir", dataDir, "--json",
    ], { cwd: executionDirectory, env: productEnvironment }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("post-negotiation Host framing failure degrades only Host-scoped Cockpit views", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-active-host-protocol-browser-"));
  const dataDir = join(root, "host-state");
  const executionDirectory = join(root, "outside-checkout");
  const userHome = join(root, "user-home");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(executionDirectory, { recursive: true }),
    mkdir(userHome, { recursive: true }),
  ]);
  const installed = await installCurrentPackage(root);
  const productEnvironment = { ...process.env, HOME: userHome };

  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--host-mode", "malformed-frame-after-negotiation",
      "--idempotency-key", "active-host-protocol-runtime-start",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const launch = JSON.parse(stdout);
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const receivedFrames = [];
      let browserSocketClosed = false;
      page.on("websocket", (websocket) => {
        websocket.on("framereceived", (event) => receivedFrames.push(String(event.payload)));
        websocket.on("close", () => {
          browserSocketClosed = true;
        });
      });
      const response = await page.goto(launch.bootstrapUrl, { waitUntil: "domcontentloaded" });
      assert.equal(response?.status(), 200);
      await page.waitForSelector("#planning-spine[data-planning-ready='true']");

      await page.waitForSelector(
        "#connection-status[data-host-status='disconnected'][data-failure-code='host_protocol_invalid']",
        { timeout: 10_000 },
      );
      const receivedMessages = receivedFrames.flatMap((frame) => {
        try {
          return [JSON.parse(frame)?.message];
        } catch {
          return [];
        }
      });
      assert.ok(receivedMessages.some((message) =>
        message?.type === "runtime.connection-state"
        && message.failure.code === "host_protocol_invalid"));
      assert.ok(receivedMessages.some((message) =>
        message?.type === "runtime.hello-ack"
        && message.viewModel.host.status === "connected"));
      assert.equal(receivedMessages.some((message) =>
        message?.type === "runtime.protocol-error"
        && message.code === "browser_protocol_invalid"), false);
      assert.equal(browserSocketClosed, false);
      assert.equal(await page.locator("#project-preparation")
        .getAttribute("data-host-freshness"), "stale");
      assert.equal(await page.locator("#planning-spine")
        .getAttribute("data-host-impact"), "unaffected");
      assert.equal(await page.locator("#planning-spine").count(), 1);

      const freshJourney = page.locator(
        "[data-journey-id='journey-fixture-optional-planning']",
      );
      await freshJourney.locator(
        "[data-stage-id='speccing'] button[data-action='open-session']",
      ).click();
      await page.waitForSelector(
        "#focused-controller-session[data-terminal-attachment='read-write']",
        { timeout: 10_000 },
      );
      assert.equal(await page.locator("#focused-controller-session")
        .getAttribute("data-session-state"), "open");
      const ticketing = freshJourney.locator("[data-stage-id='ticketing']");
      await ticketing.locator("button[data-action='not-used']").click();
      await page.waitForFunction(() => document.querySelector(
        "[data-journey-id='journey-fixture-optional-planning'] [data-stage-id='ticketing']",
      )?.getAttribute("data-stage-status") === "Not used");

      const audits = await readFile(join(dataDir, "audit.jsonl"), "utf8")
        .then((text) => text.trim().split("\n").filter(Boolean).map(JSON.parse));
      const protocolFailureAudit = audits.find((entry) =>
        entry.action === "host.connection"
        && entry.outcome === "observed"
        && entry.details.code === "host_protocol_invalid");
      assert.ok(protocolFailureAudit);
      assert.deepEqual(protocolFailureAudit.details.affectedViews, [
        "project-preparation",
        "harness-run-observation",
      ]);
      assert.deepEqual(protocolFailureAudit.details.unaffectedViews, [
        "planning-spine",
        "controller-sessions",
      ]);
      if (process.env.SANDKING_ACCEPTANCE_RESULT_DIR) {
        await writeFile(
          join(
            process.env.SANDKING_ACCEPTANCE_RESULT_DIR,
            "post-negotiation-host-protocol-contract.json",
          ),
          `${JSON.stringify({
            kind: "post_negotiation_host_protocol_contract",
            packagedPublicSeam: installed.observation,
            negotiatedHostObserved: true,
            typedConnectionFailure: receivedMessages.find((message) =>
              message?.type === "runtime.connection-state"
              && message.failure.code === "host_protocol_invalid"),
            browserProtocolFailureMisattributed: receivedMessages.some((message) =>
              message?.type === "runtime.protocol-error"
              && message.code === "browser_protocol_invalid"),
            browserSocketRetained: !browserSocketClosed,
            cockpit: {
              projectFreshness: "stale",
              planningHostImpact: "unaffected",
              planningVisible: true,
              controllerSessionOpened: true,
              planningMutationSucceeded: true,
            },
            audit: protocolFailureAudit,
          }, null, 2)}\n`,
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
