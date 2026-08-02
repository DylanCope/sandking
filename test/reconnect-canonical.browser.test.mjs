import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { launchBrowser } from "./browser-launch.mjs";
import { installCurrentPackage } from "./installed-package.mjs";

const execFileAsync = promisify(execFile);

test("local-walking-skeleton/reconnects-to-canonical-state without duplicate work", async () => {
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
      "launch",
      "--data-dir", dataDir,
      "--host-mode", "delayed-harness-run-start-response",
      "--idempotency-key", "issue-121-runtime-start",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const launch = JSON.parse(stdout);
    const runtimeBefore = JSON.parse(
      await readFile(join(dataDir, "runtime-state.json"), "utf8"),
    );
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
      const projectId = await page.locator("#project-readiness").getAttribute("data-project-id");
      const harnessId = await page.locator("#project-readiness").getAttribute("data-harness-id");
      const harnessPin = await page.locator("#project-readiness").getAttribute("data-harness-pin");
      await page.locator("#open-project-controller").click();
      await page.waitForSelector(
        "#project-focused-controller-session[data-terminal-attachment='read-write']",
        { timeout: 10_000 },
      );
      const controllerSessionId = await page.locator("#project-focused-controller-session")
        .getAttribute("data-session-id");
      const providerSessionId = await page.locator("#project-focused-controller-session")
        .getAttribute("data-provider-session-id");
      const enter = async (value) => {
        await page.locator("#project-controller-terminal-input").fill(value);
        await page.locator("#send-project-controller-input").click();
      };
      await page.waitForFunction(() => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes("Conformance Controller ready"));
      await enter("prepare 121 sandcastle/issue-121");
      await page.waitForFunction(() => /Launch request: launch-request-[a-f0-9]{24}/.test(
        document.querySelector("#project-controller-terminal-output")?.textContent ?? "",
      ));
      const preview = await page.locator("#project-controller-terminal-output").textContent();
      const launchRequestId = /Launch request: (launch-request-[a-f0-9]{24}) \(revision 1\)/
        .exec(preview)?.[1];
      assert.match(launchRequestId, /^launch-request-[a-f0-9]{24}$/);

      await enter(`approve ${launchRequestId} 1`);
      await page.waitForFunction((requestId) => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes(`Launch request ${requestId} approved at revision 2`),
      launchRequestId);
      await enter(`approve ${launchRequestId} 1`);
      await page.waitForFunction((requestId) => (
        document.querySelector("#project-controller-terminal-output")?.textContent
          ?.split(`Launch request ${requestId} approved at revision 2`).length ?? 0
      ) >= 3, launchRequestId);

      await enter(`start ${launchRequestId} 2`);
      await page.waitForFunction(() => /Harness run harness-run-[a-f0-9]{24} created/.test(
        document.querySelector("#project-controller-terminal-output")?.textContent ?? "",
      ));
      await page.waitForFunction(() => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes(
        "Recovered the accepted outcome by exact idempotency-key lookup after the start response timed out",
      ));
      const startOutput = await page.locator("#project-controller-terminal-output").textContent();
      const harnessRunId = /Harness run (harness-run-[a-f0-9]{24}) created/
        .exec(startOutput)?.[1];
      assert.match(harnessRunId, /^harness-run-[a-f0-9]{24}$/);
      assert.match(
        startOutput,
        /Recovered the accepted outcome by exact idempotency-key lookup after the start response timed out/,
      );
      const [recoveryAudits, recoveryRunState] = await Promise.all([
        readFile(join(dataDir, "audit.jsonl"), "utf8")
          .then((text) => text.trim().split("\n").map((line) => JSON.parse(line))),
        readFile(join(dataDir, "harness-runs.json"), "utf8").then(JSON.parse),
      ]);
      const recoveryStartOperationAudits = recoveryAudits.filter((entry) =>
        entry.action === "controller.provider.operation"
        && entry.outcome === "accepted"
        && entry.details.operation === "harness-run.start");
      const recoveryLookupOperationAudits = recoveryAudits.filter((entry) =>
        entry.action === "controller.provider.operation"
        && entry.outcome === "accepted"
        && entry.details.operation === "harness-run.lookup");
      const recoveryAcceptedStartAudits = recoveryAudits.filter((entry) =>
        entry.action === "harness.run.start" && entry.outcome === "accepted");
      assert.equal(recoveryStartOperationAudits.length, 1);
      assert.equal(recoveryLookupOperationAudits.length, 1);
      assert.equal(recoveryAcceptedStartAudits.length, 1);
      assert.match(
        recoveryStartOperationAudits[0].details.idempotencyKeyHash,
        /^sha256:[a-f0-9]{64}$/,
      );
      assert.equal(
        recoveryLookupOperationAudits[0].details.idempotencyKeyHash,
        recoveryStartOperationAudits[0].details.idempotencyKeyHash,
      );
      assert.equal(
        recoveryAcceptedStartAudits[0].details.idempotencyKeyHash,
        recoveryStartOperationAudits[0].details.idempotencyKeyHash,
      );
      assert.equal(recoveryAcceptedStartAudits[0].details.harnessRunId, harnessRunId);
      assert.equal(recoveryRunState.runs.length, 1);
      assert.equal(recoveryRunState.runs[0].harnessRunId, harnessRunId);
      assert.equal(recoveryRunState.startOutcomes.length, 1);
      assert.equal(
        recoveryRunState.startOutcomes[0].idempotencyKeyHash,
        recoveryStartOperationAudits[0].details.idempotencyKeyHash,
      );
      await enter(`start ${launchRequestId} 2`);
      await page.waitForFunction((runId) => (
        document.querySelector("#project-controller-terminal-output")?.textContent
          ?.split(`Harness run ${runId} created`).length ?? 0
      ) >= 3, harnessRunId);

      await page.waitForSelector(
        `#harness-run-observation[data-run-id='${harnessRunId}'][data-run-present='true']`,
        { timeout: 10_000 },
      );
      const cursorBeforeRefresh = await page.evaluate(() =>
        JSON.parse(sessionStorage.getItem("sandking.harnessRunCursor")));
      assert.equal(cursorBeforeRefresh.harnessRunId, harnessRunId);
      assert.ok(cursorBeforeRefresh.sequence >= 1);

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(
        `#project-focused-controller-session[data-session-id='${controllerSessionId}']`
          + `[data-provider-session-id='${providerSessionId}'][data-reconnected='true']`
          + "[data-terminal-attachment='read-write']",
        { timeout: 10_000 },
      );
      await page.waitForSelector(
        `#harness-run-observation[data-run-id='${harnessRunId}'][data-run-status='succeeded']`
          + "[data-observation-mode='resume'][data-launch-request-status='approved']"
          + "[data-launch-execution-status='succeeded']",
        { timeout: 10_000 },
      );
      assert.equal(
        await page.locator("#project-readiness").getAttribute("data-project-id"),
        projectId,
      );
      assert.match(
        await page.locator("#project-controller-terminal-output").textContent(),
        new RegExp(`Harness run ${harnessRunId} created`),
      );
      await enter("inspect");
      await page.waitForFunction((selectedProjectId) => document.querySelector(
        "#project-controller-terminal-output",
      )?.textContent?.includes(`Project identity: ${selectedProjectId}`), projectId);

      const cursorAfterResume = await page.evaluate(() =>
        JSON.parse(sessionStorage.getItem("sandking.harnessRunCursor")));
      assert.equal(cursorAfterResume.harnessRunId, harnessRunId);
      assert.equal(cursorAfterResume.sequence, 4);
      assert.ok(sentFrames.some((frame) => frame.includes(
        `"harnessRunId":"${harnessRunId}","afterSequence":${cursorBeforeRefresh.sequence}`,
      )));

      await page.evaluate((runId) => sessionStorage.setItem(
        "sandking.harnessRunCursor",
        JSON.stringify({ harnessRunId: runId, sequence: 9_999 }),
      ), harnessRunId);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(
        `#harness-run-observation[data-run-id='${harnessRunId}']`
          + "[data-observation-mode='resync-required']"
          + "[data-resynchronization-reason='cursor_incompatible']",
        { timeout: 10_000 },
      );
      assert.equal(
        await page.locator("#harness-run-events").getAttribute("data-event-sequences"),
        "1,2,3,4",
      );
      assert.equal(
        await page.locator("#harness-run-observation").getAttribute("data-launch-request-id"),
        launchRequestId,
      );
      assert.match(
        await page.locator("#harness-run-observation").getAttribute("data-launch-decision-id"),
        /^launch-decision-[a-f0-9]{24}$/,
      );
      assert.match(
        await page.locator("#harness-run-observation")
          .getAttribute("data-launch-decision-audit-id"),
        /^audit-[a-f0-9]{24}$/,
      );
      await page.waitForFunction(() => (
        document.querySelector("[data-log-producer='stdout']")?.textContent
          ?.includes("diagnostic stdout")
        && document.querySelector("[data-log-producer='stderr']")?.textContent
          ?.includes("diagnostic stderr")
      ));
      assert.equal(
        await page.locator("#harness-run-structured-outcome").getAttribute("data-outcome-status"),
        "succeeded",
      );

      const [runtimeAfter, controllerState, projectState, launchState, runState, audits] =
        await Promise.all([
          readFile(join(dataDir, "runtime-state.json"), "utf8").then(JSON.parse),
          readFile(join(dataDir, "controller-sessions.json"), "utf8").then(JSON.parse),
          readFile(join(dataDir, "project-registrations.json"), "utf8").then(JSON.parse),
          readFile(join(dataDir, "launch-requests.json"), "utf8").then(JSON.parse),
          readFile(join(dataDir, "harness-runs.json"), "utf8").then(JSON.parse),
          readFile(join(dataDir, "audit.jsonl"), "utf8")
            .then((text) => text.trim().split("\n").map((line) => JSON.parse(line))),
        ]);
      assert.deepEqual(
        { pid: runtimeAfter.pid, runtimeId: runtimeAfter.runtimeId },
        { pid: runtimeBefore.pid, runtimeId: runtimeBefore.runtimeId },
      );
      assert.equal(controllerState.sessions.length, 1);
      assert.equal(controllerState.sessions[0].sessionId, controllerSessionId);
      assert.equal(controllerState.sessions[0].providerSessionId, providerSessionId);
      assert.equal(projectState.projects.length, 1);
      assert.equal(projectState.projects[0].projectId, projectId);
      assert.equal(launchState.launchRequests.length, 1);
      assert.equal(launchState.launchRequests[0].launchRequestId, launchRequestId);
      assert.equal(runState.runs.length, 1);
      assert.equal(runState.runs[0].harnessRunId, harnessRunId);
      assert.equal(runState.startOutcomes.length, 1);
      const acceptedApprovalAudits = audits.filter((entry) =>
        entry.action === "launch.request.decision" && entry.outcome === "accepted");
      const acceptedStartAudits = audits.filter((entry) =>
        entry.action === "harness.run.start" && entry.outcome === "accepted");
      assert.equal(acceptedApprovalAudits.length, 1);
      assert.equal(acceptedStartAudits.length, 1);
      assert.ok(audits.some((entry) =>
        entry.action === "launch.request.decision"
        && entry.outcome === "observed"
        && entry.details.idempotentReplay === true
        && entry.details.originalAuditId === acceptedApprovalAudits[0].auditId));
      assert.ok(audits.some((entry) =>
        entry.action === "harness.run.start"
        && entry.outcome === "observed"
        && entry.details.idempotentReplay === true
        && entry.details.originalAuditId === acceptedStartAudits[0].auditId));
      assert.deepEqual((await readdir(projectPath)).sort(), projectFilesBefore);
      assert.ok(receivedFrames.some((frame) => frame.includes('"code":"resync-required"')));

      const retainedText = JSON.stringify({
        controllerState,
        projectState,
        launchState,
        runState,
        audits,
      });
      const pageText = await page.textContent("body");
      assert.doesNotMatch(retainedText, /canonical-reconnect-browser-secret/);
      assert.doesNotMatch(pageText, /canonical-reconnect-browser-secret/);

      if (process.env.SANDKING_ACCEPTANCE_OBSERVATION_PATH) {
        await writeFile(process.env.SANDKING_ACCEPTANCE_OBSERVATION_PATH, `${JSON.stringify({
          scenario: "local-walking-skeleton/reconnects-to-canonical-state",
          issue: 121,
          packagedPublicSeam: installed.observation,
          identities: {
            runtimeId: runtimeAfter.runtimeId,
            hostId: launch.host.hostId,
            projectId,
            harnessId,
            harnessPin,
            launchRequestId,
            harnessRunId,
            controllerSessionId,
            providerSessionId,
          },
          cursors: {
            beforeRefresh: cursorBeforeRefresh,
            afterResume: cursorAfterResume,
            incompatible: { harnessRunId, sequence: 9_999 },
            resynchronization: {
              code: "resync-required",
              reason: "cursor_incompatible",
              canonicalSnapshot: true,
              orderedEventSequences: [1, 2, 3, 4],
            },
          },
          canonicalState: {
            runtime: { pid: runtimeAfter.pid, runtimeId: runtimeAfter.runtimeId },
            project: projectState.projects[0],
            launchRequest: launchState.launchRequests[0],
            harnessRun: runState.runs[0],
          },
          ambiguousMutationLookup: {
            kind: "ambiguous_mutation_lookup_contract",
            operation: "harness-run.start",
            publicSeam: "packaged Cockpit -> runtime-owned provider PTY -> Controller runtime -> framed local Host",
            ambiguousResponse: {
              code: "provider_operation_timeout",
              providerDeadlineMs: 3_000,
              acceptedHostResponseDelayMs: 3_250,
            },
            lookupOperation: "harness-run.lookup",
            lookupOperationAuditId: recoveryLookupOperationAudits[0].auditId,
            idempotencyKeyHash: recoveryLookupOperationAudits[0].details.idempotencyKeyHash,
            lookupUsedSameIdempotencyKey: true,
            lookupReturnedExistingHarnessRunId: harnessRunId,
            canonicalStartAuditId: recoveryAcceptedStartAudits[0].auditId,
            startRequestsBeforeRecoveryReturned: recoveryStartOperationAudits.length,
            canonicalStartEffectsBeforeRecoveryReturned: recoveryAcceptedStartAudits.length,
            canonicalRunCountBeforeRecoveryReturned: recoveryRunState.runs.length,
            canonicalStartOutcomeCountBeforeRecoveryReturned:
              recoveryRunState.startOutcomes.length,
            duplicateStartRequestedDuringRecovery: false,
            visibleCanonicalRecovery: true,
          },
          auditReferences: {
            approval: acceptedApprovalAudits[0],
            start: acceptedStartAudits[0],
            outcome: audits.find((entry) =>
              entry.action === "harness.run.outcome"
              && entry.details.harnessRunId === harnessRunId),
          },
          duplicateEffectAssertions: {
            runtimeCount: 1,
            providerSessionCount: controllerState.sessions.length,
            projectRegistrationCount: projectState.projects.length,
            launchRequestCount: launchState.launchRequests.length,
            launchDecisionCount: acceptedApprovalAudits.length,
            harnessRunCount: runState.runs.length,
            startOutcomeCount: runState.startOutcomes.length,
          },
          observation: {
            launchRequestStatus: launchState.launchRequests[0].status,
            orderedEventSequences: runState.runs[0].events.map((event) => event.sequence),
            separateLogProducers: runState.runs[0].logStreams.map((stream) => stream.producer),
            structuredOutcome: runState.runs[0].outcome,
            controllerSessionReattached: true,
          },
          prohibitedSideEffectAssertions: {
            duplicateRuntime: false,
            duplicateProviderSession: false,
            duplicateProjectRegistration: false,
            duplicateLaunchRequest: false,
            duplicateLaunchDecision: false,
            duplicateHarnessRun: false,
            inventedGapFreeContinuity: false,
            newMutationIdentityAfterAmbiguousResponse: false,
            projectFileWrite: false,
            sudo: false,
            systemPackageInstall: false,
            shellProfileMutation: false,
            serviceConfiguration: false,
          },
          software: {
            sandking: "0.1.0",
            browserProtocol: "1.0.0",
            browser: browser.version(),
            node: process.version,
          },
        }, null, 2)}\n`, { mode: 0o600 });
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
