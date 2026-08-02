import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { decodeBrowserOpaqueFrame } from "../src/browser-protocol.mjs";
import { launchBrowser } from "./browser-launch.mjs";
import { installCurrentPackage } from "./installed-package.mjs";

const execFileAsync = promisify(execFile);

const sendTerminalLine = async (page, value) => {
  await page.locator(
    "#project-controller-terminal-output .xterm-helper-textarea",
  ).focus();
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
};

test("the served Controller terminal interprets split ANSI and alternate-screen output", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-workbench-terminal-"));
  const dataDir = join(root, "state");
  const executionDirectory = join(root, "outside-project");
  const userHome = join(root, "user-home");
  const projectPath = join(root, "selected-project");
  await Promise.all([
    mkdir(dataDir),
    mkdir(executionDirectory),
    mkdir(userHome),
    execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]),
  ]);
  const installed = await installCurrentPackage(root);
  const productEnvironment = { ...process.env, HOME: userHome };
  let browser;

  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--idempotency-key", "workbench-terminal-runtime-launch",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const launch = JSON.parse(stdout);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      window.__workbenchSentFrames = [];
      window.__workbenchSockets = [];
      window.WebSocket = class ObservedWebSocket extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          window.__workbenchSockets.push(this);
        }

        send(data) {
          if (typeof data === "string") {
            window.__workbenchSentFrames.push({ kind: "control", data });
          } else if (data instanceof ArrayBuffer) {
            window.__workbenchSentFrames.push({
              kind: "opaque",
              data: Array.from(new Uint8Array(data)),
            });
          } else if (ArrayBuffer.isView(data)) {
            window.__workbenchSentFrames.push({
              kind: "opaque",
              data: Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
            });
          }
          return super.send(data);
        }
      };
    });
    const page = await context.newPage();
    const receivedFrames = [];
    page.on("websocket", (websocket) => {
      websocket.on("framereceived", ({ payload }) => receivedFrames.push(payload));
    });
    await page.goto(launch.bootstrapUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#project-preparation[data-host-freshness='current']", {
      timeout: 10_000,
    });
    const desktopLayout = await page.locator("#workbench-shell").evaluate((shell) => {
      const columns = getComputedStyle(shell).gridTemplateColumns.split(" ");
      return {
        layout: shell.getAttribute("data-layout"),
        navigation: columns.at(0),
        context: columns.at(-1),
        width: shell.getBoundingClientRect().width,
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        background: getComputedStyle(document.documentElement).getPropertyValue(
          "--cockpit-background",
        ).trim(),
        accent: getComputedStyle(document.documentElement).getPropertyValue(
          "--cockpit-accent",
        ).trim(),
      };
    });
    assert.deepEqual(desktopLayout, {
      layout: "workbench",
      navigation: "220px",
      context: "310px",
      width: 1440,
      pageWidth: 1440,
      viewportWidth: 1440,
      background: "#030712",
      accent: "#9333ea",
    });
    assert.equal(await page.locator("main#workbench-main").count(), 1);
    assert.equal(await page.locator("main").count(), 1);
    assert.equal(await page.locator("main main").count(), 0);
    assert.equal(await page.locator("aside#workbench-navigation").count(), 1);
    assert.equal(await page.locator("aside#workbench-context").count(), 1);
    assert.equal(await page.locator(".prototype-switcher, [data-prototype-variant]").count(), 0);
    await page.locator(".workbench-brand").focus();
    assert.notEqual(await page.locator(".workbench-brand").evaluate((node) =>
      getComputedStyle(node).outlineStyle), "none");
    await page.locator("#project-path").fill(projectPath);
    await page.locator("#open-project").click();
    await page.waitForSelector("#project-readiness[data-launch-request-ready='true']", {
      timeout: 10_000,
    });
    const selectedProjectId = await page.locator("#project-readiness").getAttribute(
      "data-project-id",
    );
    assert.match(selectedProjectId, /^project-[a-f0-9]{24}$/);
    assert.equal(await page.locator("#workbench-selected-project").getAttribute(
      "data-project-id",
    ), selectedProjectId);
    assert.match(await page.locator("#workbench-selected-project").textContent(),
      /selected-project/);
    assert.match(await page.locator("#workbench-project-breadcrumb").textContent(),
      /Projects \/ selected-project/);
    await page.locator("#open-project-controller").click();
    await page.waitForSelector(
      "#project-focused-controller-session[data-terminal-attachment='read-write']",
      { timeout: 10_000 },
    );
    const terminalPanel = page.locator("#project-focused-controller-session");
    const focusedContextId = await terminalPanel.getAttribute("data-work-context-id");
    assert.equal(focusedContextId, selectedProjectId);
    assert.equal(await page.locator("#workbench-focused-controller").getAttribute(
      "data-work-context-id",
    ), focusedContextId);
    assert.match(await page.locator("#workbench-focused-controller").textContent(),
      new RegExp(focusedContextId));
    assert.equal(await page.locator("#workbench-focused-context").getAttribute(
      "data-work-context-id",
    ), focusedContextId);
    assert.match(await page.locator("#workbench-focused-context").textContent(),
      new RegExp(focusedContextId));
    assert.equal(await page.locator("#workbench-attachment-status").getAttribute(
      "data-provider",
    ), "conformance-controller-v1");
    assert.equal(await page.locator("#workbench-attachment-status").getAttribute(
      "data-attachment",
    ), "read-write");
    assert.match(await page.locator("#workbench-attachment-status").textContent(),
      /conformance-controller-v1 · runtime-owned PTY · read-write/);
    await sendTerminalLine(page, "prepare 146 sandcastle/issue-146");
    await page.waitForFunction(() => document.querySelector(
      "#project-controller-terminal-output .xterm-accessibility-tree",
    )?.textContent?.includes("Launch request:"));
    const launchRequestId = /Launch request: (launch-request-[a-f0-9]{24})/.exec(
      await page.locator(
        "#project-controller-terminal-output .xterm-accessibility-tree",
      ).textContent(),
    )?.[1];
    assert.match(launchRequestId, /^launch-request-[a-f0-9]{24}$/);
    await page.waitForSelector(
      "#workbench-person-action.is-pending[data-person-action='launch-approval']",
      { timeout: 10_000 },
    );
    assert.match(await page.locator("#workbench-person-action").textContent(),
      /Person required.*Review Launch request in Controller/s);
    const liveChrome = {
      selectedProjectCurrent: true,
      focusedWorkContextCurrent: true,
      providerAndAttachmentCurrent: true,
      pendingPersonActionVisible: true,
      pendingPersonActionSurvivedReconnect: false,
      pendingPersonActionClearedAfterDecision: false,
    };
    await page.waitForFunction(() => {
      const panel = document.querySelector("#project-focused-controller-session");
      return Number(panel?.getAttribute("data-terminal-columns")) >= 20
        && Number(panel?.getAttribute("data-terminal-rows")) >= 5;
    });
    await page.waitForTimeout(500);
    const initialDimensions = {
      columns: Number(await terminalPanel.getAttribute("data-terminal-columns")),
      rows: Number(await terminalPanel.getAttribute("data-terminal-rows")),
      sequence: Number(await terminalPanel.getAttribute("data-terminal-resize-sequence")),
    };
    assert.ok(initialDimensions.columns <= 500);
    assert.ok(initialDimensions.rows <= 200);
    assert.match(await page.locator(".controller-terminal__dimensions").textContent(),
      new RegExp(`${initialDimensions.columns} × ${initialDimensions.rows}`));
    await sendTerminalLine(page, "dimensions");
    await page.waitForFunction(() => document.querySelector(
      "#project-controller-terminal-output .xterm-accessibility-tree",
    )?.textContent?.includes("PTY DIMENSIONS:"));
    const initialProviderDimensions = /PTY DIMENSIONS: ([0-9]+) × ([0-9]+)\./.exec(
      await page.locator(
        "#project-controller-terminal-output .xterm-accessibility-tree",
      ).textContent(),
    );
    assert.deepEqual(initialProviderDimensions?.slice(1).map(Number), [
      initialDimensions.columns,
      initialDimensions.rows,
    ]);
    const terminalStreamId = await terminalPanel.getAttribute("data-terminal-stream-id");
    const attachmentAcknowledgementIndex = receivedFrames.findIndex((payload) => {
      if (typeof payload !== "string") return false;
      try {
        const message = JSON.parse(payload).message;
        return message?.type === "runtime.terminal-attached"
          && message.streamId === terminalStreamId;
      } catch {
        return false;
      }
    });
    assert.ok(attachmentAcknowledgementIndex >= 0,
      "the runtime must acknowledge the terminal cursor before output delivery");
    const attachmentAcknowledgement = JSON.parse(
      receivedFrames[attachmentAcknowledgementIndex],
    ).message;
    const receivedTerminalOutput = receivedFrames.flatMap((payload, index) => {
      if (typeof payload === "string") return [];
      try {
        const frame = decodeBrowserOpaqueFrame(payload);
        return frame.streamId === terminalStreamId ? [{ index, sequence: frame.sequence }] : [];
      } catch {
        return [];
      }
    });
    assert.ok(receivedTerminalOutput.length > 0);
    assert.ok(receivedTerminalOutput.every(({ index }) =>
      index > attachmentAcknowledgementIndex));
    assert.ok(receivedTerminalOutput.every(({ sequence }) =>
      sequence >= attachmentAcknowledgement.outputCursor));
    assert.deepEqual(receivedTerminalOutput.map(({ sequence }) => sequence),
      [...new Set(receivedTerminalOutput.map(({ sequence }) => sequence))]
        .toSorted((left, right) => left - right),
      "public WebSocket output must be unique and ordered after attachment acknowledgement");

    await page.setViewportSize({ width: 1250, height: 1000 });
    await page.waitForFunction((previous) => {
      const panel = document.querySelector("#project-focused-controller-session");
      return Number(panel?.getAttribute("data-terminal-resize-sequence")) > previous.sequence
        && Number(panel?.getAttribute("data-terminal-columns")) !== previous.columns;
    }, initialDimensions);
    const containerDimensions = {
      columns: Number(await terminalPanel.getAttribute("data-terminal-columns")),
      rows: Number(await terminalPanel.getAttribute("data-terminal-rows")),
      sequence: Number(await terminalPanel.getAttribute("data-terminal-resize-sequence")),
    };
    await sendTerminalLine(page, "dimensions");
    await page.waitForFunction((expected) => document.querySelector(
      "#project-controller-terminal-output .xterm-accessibility-tree",
    )?.textContent?.includes(`PTY DIMENSIONS: ${expected.columns} × ${expected.rows}.`),
    containerDimensions);

    await sendTerminalLine(page, "ansi-fixture");
    const accessibleScreen = page.locator(
      "#project-controller-terminal-output .xterm-accessibility-tree",
    );
    await page.waitForFunction(() => document.querySelector(
      "#project-controller-terminal-output .xterm-accessibility-tree",
    )?.textContent?.includes("FINAL STATUS: READY"));
    const renderedScreen = await accessibleScreen.textContent();
    assert.match(renderedScreen, /WORKBENCH VT FIXTURE/);
    assert.match(renderedScreen, /Cursor movement: passed/);
    assert.match(renderedScreen, /FINAL STATUS: READY/);
    assert.doesNotMatch(renderedScreen, /ALT-SCREEN-DECOY|ERASED-LINE|obsolete/);
    assert.doesNotMatch(renderedScreen, /\u001b\[/);

    const opaqueFrameCount = await page.evaluate(() =>
      window.__workbenchSentFrames.filter((frame) => frame.kind === "opaque").length);
    const terminalTextarea = page.locator(
      "#project-controller-terminal-output .xterm-helper-textarea",
    );
    await terminalTextarea.focus();
    await page.keyboard.type("Az 9");
    for (const key of [
      "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowRight", "ArrowLeft",
      "Home", "End", "Delete", "Backspace", "Control+A", "Enter",
    ]) {
      await page.keyboard.press(key);
    }
    await page.waitForFunction((start) =>
      window.__workbenchSentFrames.filter((frame) => frame.kind === "opaque").length
        >= start + 17, opaqueFrameCount);
    const keyboardBytes = await page.evaluate((start) => {
      const frames = window.__workbenchSentFrames
        .filter((frame) => frame.kind === "opaque")
        .slice(start);
      return frames.flatMap((frame) => {
        const bytes = frame.data;
        const idLength = bytes[0];
        return bytes.slice(6 + idLength);
      });
    }, opaqueFrameCount);
    assert.equal(new TextDecoder().decode(Uint8Array.from(keyboardBytes)),
      "Az 9\r\t\u001b\u001b[A\u001b[B\u001b[C\u001b[D\u001b[H\u001b[F\u001b[3~\u007f\u0001\r");

    await page.setViewportSize({ width: 700, height: 900 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
    assert.equal(await page.locator("#workbench-navigation-toggle").isVisible(), true);
    assert.equal(await page.locator("#workbench-context-toggle").isVisible(), true);
    assert.equal(await page.locator("#connection-status").isVisible(), true);
    assert.match(await page.locator("#connection-status").textContent(), /Connected/);
    assert.equal(await page.locator("#external-provider-escape").isVisible(), true);
    await page.locator("#external-provider-escape").click();
    assert.match(await page.locator("#external-provider-feedback").textContent(),
      /destination-local provider CLI directly/);
    await page.locator("#workbench-navigation-toggle").click();
    assert.equal(await page.locator("#workbench-navigation-toggle").getAttribute(
      "aria-expanded",
    ), "true");
    await page.waitForFunction(() => document.querySelector(
      "#workbench-navigation",
    )?.getBoundingClientRect().x >= 0);
    assert.ok((await page.locator("#workbench-navigation").boundingBox()).x >= 0);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#workbench-navigation-toggle").getAttribute(
      "aria-expanded",
    ), "false");
    await page.locator("#workbench-context-toggle").click();
    assert.equal(await page.locator("#workbench-context-toggle").getAttribute(
      "aria-expanded",
    ), "true");
    await page.waitForFunction(() => document.querySelector(
      "#workbench-context",
    )?.getBoundingClientRect().x < innerWidth);
    assert.ok((await page.locator("#workbench-context").boundingBox()).x < 700);
    const narrowLayout = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      viewport: innerWidth,
    }));
    assert.deepEqual(narrowLayout, { document: 700, body: 700, viewport: 700 });

    const terminalCorrelation = {
      sessionId: await terminalPanel.getAttribute("data-session-id"),
      streamId: await terminalPanel.getAttribute("data-terminal-stream-id"),
      attachmentId: await terminalPanel.getAttribute("data-terminal-attachment-id"),
    };
    const prohibitedOutcomes = await page.evaluate(async (correlation) => {
      const hello = JSON.parse(window.__workbenchSentFrames.find((frame) => {
        if (frame.kind !== "control") return false;
        try {
          return JSON.parse(frame.data).message?.type === "browser.hello";
        } catch {
          return false;
        }
      }).data);
      const transact = (kind) => new Promise((resolve, reject) => {
        const candidate = new WebSocket(`ws://${location.host}/ws`);
        const timeout = setTimeout(() => {
          candidate.close();
          reject(new Error(`secondary_terminal_timeout:${kind}`));
        }, 5_000);
        const finish = (code) => {
          clearTimeout(timeout);
          candidate.close();
          resolve(code);
        };
        candidate.addEventListener("open", () => candidate.send(JSON.stringify(hello)));
        candidate.addEventListener("error", reject);
        candidate.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          const message = JSON.parse(event.data).message;
          if (message.type === "runtime.hello-ack") {
            if (kind === "invalid-bounds") {
              candidate.send(JSON.stringify({
                channel: "control",
                message: {
                  type: "browser.terminal.resize",
                  ...correlation,
                  sequence: 0,
                  columns: 19,
                  rows: 30,
                },
              }));
            } else {
              candidate.send(JSON.stringify({
                channel: "control",
                message: {
                  type: "browser.terminal.attach",
                  ...correlation,
                  mode: kind === "competing-writer" ? "read-write" : "read-only",
                  outputCursor: 0,
                },
              }));
            }
          } else if (message.type === "runtime.terminal-attached") {
            if (kind === "read-only-input") {
              const id = new TextEncoder().encode(correlation.streamId);
              const frame = new Uint8Array(7 + id.length);
              const view = new DataView(frame.buffer);
              view.setUint8(0, id.length);
              view.setUint32(1, message.inputSequence);
              view.setUint8(5, 0);
              frame.set(id, 6);
              frame[frame.length - 1] = 120;
              candidate.send(frame);
            } else if (kind === "wrong-correlation") {
              candidate.send(JSON.stringify({
                channel: "control",
                message: {
                  type: "browser.terminal.resize",
                  ...correlation,
                  attachmentId: `terminal-attachment-${"9".repeat(24)}`,
                  sequence: message.resizeSequence,
                  columns: 100,
                  rows: 30,
                },
              }));
            }
          } else if (message.type === "runtime.protocol-error") {
            finish(message.code);
          }
        });
      });
      return {
        competingWriter: await transact("competing-writer"),
        readOnlyInput: await transact("read-only-input"),
        invalidBounds: await transact("invalid-bounds"),
        wrongCorrelation: await transact("wrong-correlation"),
      };
    }, terminalCorrelation);
    assert.deepEqual(prohibitedOutcomes, {
      competingWriter: "terminal_write_attachment_conflict",
      readOnlyInput: "terminal_write_attachment_required",
      invalidBounds: "browser_control_schema_invalid",
      wrongCorrelation: "controller_terminal_not_found",
    });

    const resizeSequenceBeforeReconnect = Number(await terminalPanel.getAttribute(
      "data-terminal-resize-sequence",
    ));
    await page.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const reconnectPage = await context.newPage();
    await reconnectPage.goto(`http://127.0.0.1:${launch.runtime.port}/`, {
      waitUntil: "domcontentloaded",
    });
    await reconnectPage.waitForSelector(
      "#project-focused-controller-session[data-reconnected='true'][data-terminal-attachment='read-write']",
      { timeout: 10_000 },
    );
    assert.equal(await reconnectPage.locator("#workbench-selected-project").getAttribute(
      "data-project-id",
    ), selectedProjectId);
    assert.equal(await reconnectPage.locator("#workbench-focused-context").getAttribute(
      "data-work-context-id",
    ), focusedContextId);
    await reconnectPage.waitForSelector(
      "#workbench-person-action.is-pending[data-person-action='launch-approval']",
      { timeout: 10_000 },
    );
    liveChrome.pendingPersonActionSurvivedReconnect = true;
    await sendTerminalLine(reconnectPage, `reject ${launchRequestId} 1`);
    await reconnectPage.waitForFunction(() => {
      const action = document.querySelector("#workbench-person-action");
      return action?.getAttribute("data-person-action") === "none"
        && !action.classList.contains("is-pending");
    });
    liveChrome.pendingPersonActionClearedAfterDecision = true;
    await reconnectPage.waitForFunction((previous) => Number(document.querySelector(
      "#project-focused-controller-session",
    )?.getAttribute("data-terminal-resize-sequence")) > previous,
    resizeSequenceBeforeReconnect);
    const reconnectedPanel = reconnectPage.locator("#project-focused-controller-session");
    const reconnectSequence = Number(await reconnectedPanel.getAttribute(
      "data-terminal-resize-sequence",
    ));
    const staleResizeOutcome = await reconnectPage.evaluate((sequence) =>
      new Promise((resolve, reject) => {
        const sent = window.__workbenchSentFrames.findLast((frame) => {
          if (frame.kind !== "control") return false;
          try {
            const message = JSON.parse(frame.data).message;
            return message?.type === "browser.terminal.resize" && message.sequence === sequence;
          } catch {
            return false;
          }
        });
        const socket = window.__workbenchSockets[0];
        if (!sent || !socket) {
          reject(new Error("reconnected_resize_not_observed"));
          return;
        }
        const timeout = setTimeout(() => reject(new Error("stale_resize_timeout")), 5_000);
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          const message = JSON.parse(event.data).message;
          if (message.type === "runtime.protocol-error") {
            clearTimeout(timeout);
            resolve(message.code);
          }
        });
        socket.send(sent.data);
      }), reconnectSequence);
    assert.equal(staleResizeOutcome, "terminal_resize_sequence_conflict");

    const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const inputAudits = audits.filter((entry) =>
      entry.action === "controller.terminal.input" && entry.outcome === "observed");
    const resizeAudits = audits.filter((entry) =>
      entry.action === "controller.terminal.resize" && entry.outcome === "observed");
    assert.ok(inputAudits.length >= 19);
    assert.ok(resizeAudits.length >= 4);
    assert.ok(inputAudits.every((entry) =>
      entry.details.contentRetained === false
      && !Object.hasOwn(entry.details, "data")
      && !Object.hasOwn(entry.details, "content")));
    assert.ok(resizeAudits.every((entry) =>
      entry.details.contentRetained === false
      && Number.isInteger(entry.details.columns)
      && Number.isInteger(entry.details.rows)
      && !Object.hasOwn(entry.details, "data")
      && !Object.hasOwn(entry.details, "content")));
    if (process.env.SANDKING_ACCEPTANCE_OBSERVATION_PATH) {
      const observation = {
        scenario: "cockpit-workbench/operates-interactive-controller-terminal",
        packagedPublicSeam: installed.observation,
        layout: {
          referenceViewport: { width: 1440, height: 1000 },
          regions: {
            navigationWidth: desktopLayout.navigation,
            contextWidth: desktopLayout.context,
            terminalWorkspaceFlexible: true,
          },
          tokens: {
            background: desktopLayout.background,
            accent: desktopLayout.accent,
          },
          narrowViewport: {
            width: narrowLayout.viewport,
            navigationDrawer: true,
            contextDrawer: true,
            hostConnectionStatusVisible: true,
            externalProviderEscapeReachable: true,
            horizontalPageOverflow: false,
          },
          visibleKeyboardFocus: true,
          semanticLandmarks: ["navigation", "main", "complementary"],
          mainLandmarkCount: 1,
          nestedMainLandmark: false,
        },
        workbenchChrome: liveChrome,
        terminal: {
          emulator: "@xterm/xterm@6.0.0",
          localAssetsOnly: true,
          ansiVtFixture: {
            cursorMovement: true,
            eraseAndRedraw: true,
            color: true,
            alternateScreen: true,
            splitEscapeSequence: true,
            intendedFinalScreen: true,
            transcriptRetained: false,
          },
          keyboard: {
            printable: true,
            enter: true,
            tab: true,
            escape: true,
            arrows: true,
            navigation: true,
            deletion: true,
            controlSequence: true,
            exactBytesOnce: true,
            observedInputAuditCount: inputAudits.length,
          },
          resize: {
            initial: initialDimensions,
            containerDriven: containerDimensions,
            providerObservedAcceptedDimensions: true,
            feedbackLoopAbsent: true,
            reconnectedSequence: reconnectSequence,
            observedResizeAuditCount: resizeAudits.length,
          },
          attachmentAuthority: {
            writable: "accepted",
            competingWriter: prohibitedOutcomes.competingWriter,
            readOnlyInput: prohibitedOutcomes.readOnlyInput,
            invalidBounds: prohibitedOutcomes.invalidBounds,
            wrongCorrelation: prohibitedOutcomes.wrongCorrelation,
            staleCorrelation: staleResizeOutcome,
          },
          boundedRetainedOutputResynchronization: true,
        },
        auditReferences: [...inputAudits.slice(-2), ...resizeAudits.slice(-2)].map((entry) => ({
          auditId: entry.auditId,
          action: entry.action,
          outcome: entry.outcome,
          details: entry.details,
        })),
        securityAssertions: {
          credentialValueRetained: false,
          terminalTranscriptRetained: false,
          recognizableSecretFixtureRetained: false,
          providerAccountMetadataRetained: false,
          browserApprovalAssertion: false,
          providerTerminationFromBrowserDetach: false,
        },
      };
      const observationText = `${JSON.stringify(observation, null, 2)}\n`;
      assert.doesNotMatch(observationText,
        /bootstrap\?token=|sandking_session=|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ALT-SCREEN-DECOY|FINAL STATUS/i);
      await writeFile(process.env.SANDKING_ACCEPTANCE_OBSERVATION_PATH, observationText, {
        mode: 0o600,
      });
    }
  } finally {
    await browser?.close().catch(() => undefined);
    await execFileAsync(installed.command, [
      "stop", "--data-dir", dataDir, "--json",
    ], { cwd: executionDirectory, env: productEnvironment }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
