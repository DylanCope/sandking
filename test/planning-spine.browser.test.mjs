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

test("planning-spine/projects-an-optional-journey drives the served Cockpit", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-planning-browser-"));
  const dataDir = join(root, "runtime-state");
  const executionDirectory = join(root, "outside-checkout");
  const userHome = join(root, "user-home");
  const protectedProject = join(root, "protected-project");
  const protectedProjectFile = join(protectedProject, "README.md");
  const controllerSecret = "planning-browser-secret-must-not-appear";
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(executionDirectory, { recursive: true }),
    mkdir(userHome, { recursive: true }),
    mkdir(protectedProject, { recursive: true }),
  ]);
  await writeFile(protectedProjectFile, "protected Project content\n");
  const projectBefore = sha256(await readFile(protectedProjectFile));
  const installed = await installCurrentPackage(root);
  const productEnvironment = {
    ...process.env,
    HOME: userHome,
    SANDKING_CONTROLLER_SECRET: controllerSecret,
  };

  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--idempotency-key", "planning-acceptance-runtime-launch",
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
      const sentFrames = [];
      const planningRequests = [];
      page.on("websocket", (socket) => {
        socket.on("framesent", (event) => sentFrames.push(String(event.payload)));
        socket.on("framereceived", (event) => receivedFrames.push(String(event.payload)));
      });
      page.on("request", (request) => {
        if (request.method() === "POST" && request.url().includes("/planning/")) {
          planningRequests.push({
            url: request.url(),
            postData: request.postData(),
            headers: request.allHeaders(),
          });
        }
      });

      const response = await page.goto(launch.bootstrapUrl, { waitUntil: "domcontentloaded" });
      assert.equal(response?.status(), 200);
      await page.waitForSelector("#planning-spine[data-planning-ready='true']", {
        timeout: 10_000,
      });

      const acknowledgement = JSON.parse(
        receivedFrames.find((frame) => frame.includes("runtime.hello-ack")),
      ).message;
      assert.equal(acknowledgement.viewModel.planning.kind, "cockpit.planning-spine");
      assert.equal(acknowledgement.viewModel.planning.adapter.fixture, true);
      assert.equal(
        acknowledgement.viewModel.planning.adapter.label,
        "Conformance fixture data — not live GitHub",
      );
      assert.deepEqual(acknowledgement.viewModel.planning.builtInStages, [
        "wayfinding",
        "speccing",
        "ticketing",
      ]);

      const freshJourney = page.locator(
        "[data-journey-id='journey-fixture-optional-planning']",
      );
      assert.equal(await freshJourney.getAttribute("data-freshness"), "fresh");
      assert.deepEqual(
        await freshJourney.locator("[data-stage-id]").evaluateAll((nodes) =>
          nodes.map((node) => ({
            stageId: node.getAttribute("data-stage-id"),
            status: node.getAttribute("data-stage-status"),
          }))),
        [
          { stageId: "wayfinding", status: "Complete" },
          { stageId: "speccing", status: "In progress" },
          { stageId: "ticketing", status: "Not started" },
        ],
      );
      assert.equal(await freshJourney.getAttribute("data-ordinary-work-blocked"), "false");

      const staleJourney = page.locator(
        "[data-journey-id='journey-fixture-unrefreshable']",
      );
      const staleFreshnessAttribute = await staleJourney.getAttribute("data-freshness");
      const staleWarning = await staleJourney.textContent();
      const staleControlsDisabled = await staleJourney
        .locator("button[data-planning-mutation]")
        .evaluateAll((buttons) => buttons.every((button) => button.disabled));
      assert.equal(staleFreshnessAttribute, "stale");
      assert.match(staleWarning, /stale.*mutation.*disabled/is);
      assert.equal(staleControlsDisabled, true);

      const sessionButton = freshJourney.locator(
        "[data-stage-id='speccing'] button[data-action='open-session']",
      );
      await sessionButton.click();
      await page.waitForSelector("#focused-controller-session[data-session-state='open']");
      const focusedSession = page.locator("#focused-controller-session");
      const sessionId = await focusedSession.getAttribute("data-session-id");
      assert.match(sessionId, /^controller-session-[a-f0-9]{24}$/);
      assert.equal(
        await focusedSession.getAttribute("data-work-context-id"),
        "work-context-speccing-optional-planning",
      );
      assert.equal(
        await focusedSession.getAttribute("data-provider-id"),
        "conformance-controller-v1",
      );
      assert.equal(
        await focusedSession.getAttribute("data-provider-adapter-id"),
        "conformance-controller-adapter-v1",
      );
      assert.equal(
        await focusedSession.getAttribute("data-provider-control-protocol"),
        "1.0.0",
      );
      assert.equal(
        await focusedSession.getAttribute("data-provider-ready-signal"),
        "provider.session.ready",
      );
      assert.equal(await focusedSession.getAttribute("data-provider-observed-tty"), "true");
      assert.equal(await focusedSession.getAttribute("data-pty-runtime-owned"), "true");
      assert.match(
        await focusedSession.getAttribute("data-provider-session-id"),
        /^conformance-provider-session-[a-f0-9]{24}$/,
      );
      assert.match(
        await focusedSession.getAttribute("data-terminal-stream-id"),
        /^controller-terminal-[a-f0-9]{24}$/,
      );
      await page.waitForSelector(
        "#focused-controller-session[data-terminal-attachment='read-write']",
      );
      assert.match(await focusedSession.textContent(), /focused conformance Controller session/i);

      const secondAttachmentOutcome = await page.evaluate((parameters) =>
        new Promise((resolve, reject) => {
          const competing = new WebSocket(`ws://${location.host}/ws`);
          const timeout = setTimeout(() => {
            competing.close();
            reject(new Error("competing_terminal_attachment_timeout"));
          }, 5_000);
          competing.addEventListener("open", () => competing.send(JSON.stringify(parameters.hello)));
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
                  mode: "read-write",
                  outputCursor: 0,
                },
              }));
            } else if (message.type === "runtime.protocol-error") {
              clearTimeout(timeout);
              competing.close();
              resolve(message.code);
            }
          });
          competing.addEventListener("error", reject);
        }), {
        hello: JSON.parse(sentFrames.find((frame) => frame.includes("browser.hello"))),
        sessionId,
        streamId: await focusedSession.getAttribute("data-terminal-stream-id"),
        attachmentId: await focusedSession.getAttribute("data-terminal-attachment-id"),
      });
      assert.equal(secondAttachmentOutcome, "terminal_write_attachment_conflict");

      await page.locator("#controller-terminal-input").fill("inspect");
      await page.locator("#send-controller-input").click();
      await page.waitForFunction(() => document.querySelector("#controller-terminal-output")
        ?.textContent?.includes(
          "Inspected github:fixture:issue:116 for work-context-speccing-optional-planning",
        ));
      const controllerOutput = await page.locator("#controller-terminal-output").textContent();
      assert.match(controllerOutput, /Conformance Controller ready/);
      assert.match(controllerOutput, /Provider terminal: stdin TTY=true; stdout TTY=true/);
      assert.match(controllerOutput, /Focused work context: work-context-speccing-optional-planning/);

      const notUsedButton = freshJourney.locator(
        "[data-stage-id='ticketing'] button[data-action='not-used']",
      );
      await notUsedButton.click();
      await page.waitForFunction(() => {
        const stage = document.querySelector(
          "[data-journey-id='journey-fixture-optional-planning'] [data-stage-id='ticketing']",
        );
        return stage?.getAttribute("data-stage-status") === "Not used";
      });
      assert.equal(await freshJourney.getAttribute("data-ordinary-work-blocked"), "false");
      assert.match(await freshJourney.textContent(), /ordinary work remains available/i);

      const notUsedRequest = planningRequests.find((request) =>
        request.url.endsWith("/planning/stages/not-used"));
      assert.ok(notUsedRequest);
      const mutationHeaders = await notUsedRequest.headers;
      const mutationBody = JSON.parse(notUsedRequest.postData);
      const idempotencyKey = mutationHeaders["x-sandking-idempotency-key"];
      assert.ok(idempotencyKey);

      const exerciseMutation = (input) => page.evaluate(async (parameters) => {
        const replay = await fetch(parameters.path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-sandking-csrf": parameters.csrf,
            "x-sandking-idempotency-key": parameters.idempotencyKey,
            "x-sandking-expected-revision": String(parameters.expectedRevision),
          },
          body: JSON.stringify(parameters.body),
        });
        return { status: replay.status, body: await replay.json() };
      }, input);
      const commonMutation = {
        path: "/planning/stages/not-used",
        csrf: acknowledgement.session.csrfToken,
        expectedRevision: 1,
      };
      const replay = await exerciseMutation({
        ...commonMutation,
        idempotencyKey,
        body: mutationBody,
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.body.idempotentReplay, true);
      assert.equal(replay.body.code, "planning_stage_not_used");

      const changedUse = await exerciseMutation({
        ...commonMutation,
        idempotencyKey,
        body: { ...mutationBody, stageId: "speccing" },
      });
      assert.equal(changedUse.status, 409);
      assert.equal(changedUse.body.code, "idempotency_key_conflict");

      const staleRevision = await exerciseMutation({
        ...commonMutation,
        idempotencyKey: "planning-browser-stale-revision",
        body: mutationBody,
      });
      assert.equal(staleRevision.status, 409);
      assert.equal(staleRevision.body.code, "mutation_revision_conflict");
      assert.equal(staleRevision.body.actualRevision, 2);

      const unavailable = await exerciseMutation({
        ...commonMutation,
        idempotencyKey: "planning-browser-unavailable-projection",
        body: {
          journeyId: "journey-fixture-unrefreshable",
          stageId: "ticketing",
        },
      });
      assert.equal(unavailable.status, 409);
      assert.equal(unavailable.body.code, "projection_stale");
      assert.equal(unavailable.body.prohibitedSideEffects.queuedWrite, false);

      const unauthorized = await page.evaluate(async () => {
        const denied = await fetch("/planning/stages/not-used", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-sandking-idempotency-key": "planning-browser-unauthorized",
            "x-sandking-expected-revision": "1",
          },
          body: JSON.stringify({
            journeyId: "journey-fixture-optional-planning",
            stageId: "speccing",
          }),
        });
        return { status: denied.status, body: await denied.json() };
      });
      assert.equal(unauthorized.status, 403);
      assert.equal(unauthorized.body.code, "authorization_failed");

      const pageText = await page.textContent("body");
      assert.doesNotMatch(pageText, new RegExp(controllerSecret));
      assert.match(pageText, /thin Planning spine/i);
      assert.match(pageText, /does not include skill-owned reasoning/i);

      const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      const planningAudits = audits.filter((entry) => entry.action.startsWith("planning."));
      const planningSessionAudits = audits.filter((entry) =>
        entry.action.startsWith("planning.") || entry.action.startsWith("controller."));
      const acceptedSessionAudit = planningAudits.find((entry) =>
        entry.action === "planning.session.open" && entry.outcome === "accepted");
      const acceptedNotUsedAudit = planningAudits.find((entry) =>
        entry.action === "planning.stage.not-used" && entry.outcome === "accepted");
      assert.equal(acceptedSessionAudit.details.workContextId,
        "work-context-speccing-optional-planning");
      assert.equal(acceptedSessionAudit.details.sessionId, sessionId);
      assert.match(acceptedSessionAudit.details.providerSessionId,
        /^conformance-provider-session-[a-f0-9]{24}$/);
      assert.equal(acceptedSessionAudit.details.ptyRuntimeOwned, true);
      assert.ok(planningSessionAudits.some((entry) =>
        entry.action === "controller.session.start"
        && entry.outcome === "accepted"
        && entry.details.sessionId === sessionId
        && entry.details.providerAdapterId === "conformance-controller-adapter-v1"
        && entry.details.providerControlProtocol === "1.0.0"
        && entry.details.providerReadySignal === "provider.session.ready"
        && entry.details.providerObservedTty === true
        && entry.details.ptyRuntimeOwned === true));
      assert.ok(planningSessionAudits.some((entry) =>
        entry.action === "controller.terminal.input"
        && entry.outcome === "observed"
        && entry.details.sessionId === sessionId
        && entry.details.byteLength > 0));
      assert.equal(acceptedNotUsedAudit.details.resultingRevision, 2);
      assert.equal(acceptedNotUsedAudit.details.fixtureProjectionWrite, true);
      assert.match(acceptedNotUsedAudit.details.idempotencyKeyHash,
        /^sha256:[a-f0-9]{64}$/);
      assert.ok(planningAudits.some((entry) =>
        entry.details.code === "projection_stale" && entry.details.queuedWrite === false));

      const projectAfter = sha256(await readFile(protectedProjectFile));
      assert.equal(projectAfter, projectBefore);
      const projectFilesAfter = await readdir(protectedProject);
      assert.deepEqual(projectFilesAfter, ["README.md"]);
      const privateStateFiles = await readdir(dataDir);
      assert.ok(privateStateFiles.includes("planning-state.json"));
      assert.ok(privateStateFiles.includes("controller-sessions.json"));
      assert.equal(privateStateFiles.some((file) => /queue/i.test(file)), false);
      const retainedControllerState = JSON.parse(
        await readFile(join(dataDir, "controller-sessions.json"), "utf8"),
      );
      const retainedControllerSession = retainedControllerState.sessions.find(
        (session) => session.sessionId === sessionId,
      );
      assert.ok(retainedControllerSession);
      assert.equal(retainedControllerSession.providerId, "conformance-controller-v1");
      assert.equal(
        retainedControllerSession.providerAdapterId,
        "conformance-controller-adapter-v1",
      );
      assert.equal(retainedControllerSession.workContextId,
        "work-context-speccing-optional-planning");
      assert.equal(retainedControllerSession.providerControl.protocol, "1.0.0");
      assert.equal(
        retainedControllerSession.providerControl.readySignal,
        "provider.session.ready",
      );
      assert.equal(retainedControllerSession.providerControl.providerObservedTty, true);
      assert.match(retainedControllerSession.providerControl.readyObservedAt,
        /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual({
        kind: retainedControllerSession.terminal.kind,
        runtimeOwned: retainedControllerSession.terminal.runtimeOwned,
        status: retainedControllerSession.terminal.status,
      }, {
        kind: "pty",
        runtimeOwned: true,
        status: "running",
      });

      const observation = {
        scenario: "planning-spine/projects-an-optional-journey",
        packagedPublicSeam: installed.observation,
        runtime: {
          runtimeId: launch.runtime.runtimeId,
          hostId: launch.host.hostId,
        },
        projectionProvenance: {
          adapter: acknowledgement.viewModel.planning.adapter,
          fresh: acknowledgement.viewModel.planning.journeys[0].projection,
          stale: acknowledgement.viewModel.planning.journeys[1].projection,
        },
        builtInStages: acknowledgement.viewModel.planning.builtInStages,
        visibleStaleState: {
          freshnessAttribute: staleFreshnessAttribute,
          warningShown: /stale.*mutation.*disabled/is.test(staleWarning),
          allMutationControlsDisabled: staleControlsDisabled,
        },
        focusedSession: {
          sessionId,
          workContextId: "work-context-speccing-optional-planning",
          canonicalReference: "github:fixture:issue:116",
          providerId: "conformance-controller-v1",
          providerAdapterId: await focusedSession.getAttribute("data-provider-adapter-id"),
          providerSessionId: await focusedSession.getAttribute("data-provider-session-id"),
          providerControlProtocol:
            await focusedSession.getAttribute("data-provider-control-protocol"),
          providerReadySignal: await focusedSession.getAttribute("data-provider-ready-signal"),
          terminalStreamId: await focusedSession.getAttribute("data-terminal-stream-id"),
          ptyRuntimeOwned:
            await focusedSession.getAttribute("data-pty-runtime-owned") === "true",
          providerObservedTty:
            await focusedSession.getAttribute("data-provider-observed-tty") === "true",
          terminalDisplayedTtyObservation:
            controllerOutput.includes("Provider terminal: stdin TTY=true; stdout TTY=true"),
          writableAttachment:
            await focusedSession.getAttribute("data-terminal-attachment") === "read-write",
          competingWritableAttachmentRejectedAs: secondAttachmentOutcome,
          inspectedSelectedContext: controllerOutput.includes(
            "Inspected github:fixture:issue:116 for work-context-speccing-optional-planning",
          ),
          retainedLifecycle: {
            providerSessionId: retainedControllerSession.providerSessionId,
            providerAdapterId: retainedControllerSession.providerAdapterId,
            providerControlProtocol: retainedControllerSession.providerControl.protocol,
            providerReadySignal: retainedControllerSession.providerControl.readySignal,
            providerObservedTty:
              retainedControllerSession.providerControl.providerObservedTty,
            terminalKind: retainedControllerSession.terminal.kind,
            ptyRuntimeOwned: retainedControllerSession.terminal.runtimeOwned,
            status: retainedControllerSession.terminal.status,
          },
        },
        notUsedMutation: {
          authorizationClass: replay.body.authorizationClass,
          expectedRevision: replay.body.expectedRevision,
          resultingRevision: replay.body.revision,
          auditId: replay.body.auditId,
          replayReturnedSameAudit: replay.body.auditId === acceptedNotUsedAudit.auditId,
          replayIdempotent: replay.body.idempotentReplay,
          ordinaryWorkBlocked: replay.body.ordinaryWorkBlocked,
        },
        failureOutcomes: {
          changedUse: { status: changedUse.status, code: changedUse.body.code },
          staleRevision: {
            status: staleRevision.status,
            code: staleRevision.body.code,
            actualRevision: staleRevision.body.actualRevision,
          },
          unavailableProjection: {
            status: unavailable.status,
            code: unavailable.body.code,
            queuedWrite: unavailable.body.prohibitedSideEffects.queuedWrite,
          },
          unauthorized: { status: unauthorized.status, code: unauthorized.body.code },
        },
        scopeExclusions: acknowledgement.viewModel.planning.excludedCapabilities,
        auditReferences: planningSessionAudits.map((entry) => ({
          auditId: entry.auditId,
          action: entry.action,
          outcome: entry.outcome,
          details: entry.details,
        })),
        prohibitedSideEffectAssertions: {
          liveGithubWrite: false,
          queuedWrite: false,
          skillInvocation: false,
          projectFileWrite: projectAfter !== projectBefore,
        },
        securityAssertions: {
          secretAbsentFromPage: !pageText.includes(controllerSecret),
          idempotencyKeyAbsentFromAudit: !JSON.stringify(planningAudits).includes(idempotencyKey),
          planningStateOutsideProject:
            privateStateFiles.includes("planning-state.json")
            && privateStateFiles.includes("controller-sessions.json")
            && projectFilesAfter.length === 1
            && projectFilesAfter[0] === "README.md",
        },
        software: {
          sandking: "0.1.0",
          browserProtocol: acknowledgement.protocol.version,
          browser: browser.version(),
          node: process.version,
        },
      };
      const observationText = JSON.stringify(observation);
      assert.doesNotMatch(observationText, new RegExp(controllerSecret));
      assert.doesNotMatch(observationText, new RegExp(idempotencyKey));
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
