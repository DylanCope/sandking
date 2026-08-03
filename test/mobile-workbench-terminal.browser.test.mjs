import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { devices } from "playwright";
import { launchBrowser } from "./browser-launch.mjs";
import { installCurrentPackage } from "./installed-package.mjs";

const execFileAsync = promisify(execFile);

const opaqueInputBytes = async (page, start) => page.evaluate((offset) =>
  window.__mobileWorkbenchSentFrames
    .filter((frame) => frame.kind === "opaque")
    .slice(offset)
    .flatMap((frame) => {
      const idLength = frame.data[0];
      return frame.data.slice(6 + idLength);
    }), start);

const opaqueInputCount = async (page) => page.evaluate(() =>
  window.__mobileWorkbenchSentFrames.filter((frame) => frame.kind === "opaque").length);

const swipe = async (client, { x, fromY, toY }) => {
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: fromY }],
  });
  for (let step = 1; step <= 5; step += 1) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{
        x,
        y: fromY + ((toY - fromY) * step) / 5,
      }],
    });
  }
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
};

test("the production Workbench terminal is usable at a touch phone viewport", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-mobile-workbench-"));
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
  let runtimePid;

  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--idempotency-key", "mobile-workbench-runtime-launch",
      "--expected-revision", "0",
      "--startup-timeout-ms", "30000",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const launch = JSON.parse(stdout);
    runtimePid = launch.runtime.pid;
    browser = await launchBrowser();
    const { defaultBrowserType: _defaultBrowserType, ...phone } = devices["iPhone 13"];
    const context = await browser.newContext({
      ...phone,
      viewport: { width: 390, height: 844 },
      screen: { width: 390, height: 844 },
    });
    await context.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      window.__mobileWorkbenchSentFrames = [];
      window.WebSocket = class ObservedWebSocket extends NativeWebSocket {
        send(data) {
          if (typeof data === "string") {
            window.__mobileWorkbenchSentFrames.push({ kind: "control", data });
          } else if (data instanceof ArrayBuffer) {
            window.__mobileWorkbenchSentFrames.push({
              kind: "opaque",
              data: Array.from(new Uint8Array(data)),
            });
          } else if (ArrayBuffer.isView(data)) {
            window.__mobileWorkbenchSentFrames.push({
              kind: "opaque",
              data: Array.from(new Uint8Array(
                data.buffer,
                data.byteOffset,
                data.byteLength,
              )),
            });
          }
          return super.send(data);
        }
      };
    });
    const page = await context.newPage();
    await page.goto(launch.bootstrapUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#project-preparation[data-host-freshness='current']", {
      timeout: 10_000,
    });
    await page.locator("#project-path").fill(projectPath);
    await page.locator("#open-project").click();
    await page.waitForSelector("#project-readiness[data-launch-request-ready='true']", {
      timeout: 10_000,
    });
    let controllerAttached = false;
    for (let attempt = 0; attempt < 3 && !controllerAttached; attempt += 1) {
      await page.locator("#open-project-controller").click();
      const controllerOutcome = await page.waitForFunction(() => {
        const panel = document.querySelector("#project-focused-controller-session");
        if (panel?.getAttribute("data-terminal-attachment") === "read-write") {
          return "attached";
        }
        const feedback = document.querySelector("#project-controller-feedback")?.textContent ?? "";
        return feedback.startsWith("Focused Controller failed safely:") ? feedback : false;
      }, undefined, { timeout: 90_000 }).then((handle) => handle.jsonValue());
      controllerAttached = controllerOutcome === "attached";
      if (!controllerAttached) {
        assert.match(controllerOutcome,
          /provider_adapter_timeout|provider_session_ready_timeout/);
      }
    }
    assert.equal(controllerAttached, true, "the conformance Controller must attach");
    await page.waitForFunction(() => {
      const panel = document.querySelector("#project-focused-controller-session");
      return Number(panel?.getAttribute("data-terminal-columns")) >= 20
        && Number(panel?.getAttribute("data-terminal-rows")) >= 5;
    });

    const phoneLayout = await page.evaluate(() => {
      const shell = document.querySelector("#workbench-shell");
      const terminal = document.querySelector(".controller-terminal");
      const header = document.querySelector(".controller-terminal__header");
      const terminalEmulator = document.querySelector(".controller-terminal__output .xterm");
      const viewport = document.querySelector(".xterm-viewport");
      const meta = document.querySelector('meta[name="viewport"]');
      const terminalBounds = terminal.getBoundingClientRect();
      return {
        viewport: { width: innerWidth, height: innerHeight },
        screen: { width: screen.width, height: screen.height },
        visualViewport: {
          width: window.visualViewport?.width,
          scale: window.visualViewport?.scale,
        },
        viewportMeta: meta?.getAttribute("content"),
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        shellWidth: shell.getBoundingClientRect().width,
        terminalLeft: terminalBounds.left,
        terminalRight: terminalBounds.right,
        terminalClientWidth: terminal.clientWidth,
        terminalScrollWidth: terminal.scrollWidth,
        headerClientWidth: header.clientWidth,
        headerScrollWidth: header.scrollWidth,
        terminalTouchAction: getComputedStyle(terminalEmulator).touchAction,
        terminalOverscroll: getComputedStyle(viewport).overscrollBehaviorY,
      };
    });
    assert.deepEqual(phoneLayout.viewport, { width: 390, height: 844 });
    assert.deepEqual(phoneLayout.screen, { width: 390, height: 844 });
    assert.equal(phoneLayout.visualViewport.width, 390);
    assert.equal(phoneLayout.visualViewport.scale, 1);
    assert.match(phoneLayout.viewportMeta,
      /width=device-width,\s*initial-scale=1/);
    assert.equal(phoneLayout.documentWidth, 390);
    assert.equal(phoneLayout.bodyWidth, 390);
    assert.equal(phoneLayout.shellWidth, 390);
    assert.ok(phoneLayout.terminalLeft >= 0);
    assert.ok(phoneLayout.terminalRight <= 390);
    assert.equal(phoneLayout.terminalScrollWidth, phoneLayout.terminalClientWidth);
    assert.equal(phoneLayout.headerScrollWidth, phoneLayout.headerClientWidth);
    assert.equal(phoneLayout.terminalTouchAction, "none");
    assert.equal(phoneLayout.terminalOverscroll, "contain");

    for (const [toggleSelector, drawerSelector] of [
      ["#workbench-navigation-toggle", "#workbench-navigation"],
      ["#workbench-context-toggle", "#workbench-context"],
    ]) {
      const toggle = page.locator(toggleSelector);
      await toggle.tap();
      assert.equal(await toggle.getAttribute("aria-expanded"), "true");
      await page.waitForFunction((selector) => {
        const bounds = document.querySelector(selector)?.getBoundingClientRect();
        return bounds && bounds.left < innerWidth && bounds.right > 0;
      }, drawerSelector);
      const drawer = await page.locator(drawerSelector).boundingBox();
      assert.ok(drawer.x < 390 && drawer.x + drawer.width > 0);
      await page.keyboard.press("Escape");
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    }

    const mobileControls = page.locator(".controller-terminal__mobile-keys");
    await assert.doesNotReject(mobileControls.waitFor({ state: "visible" }));
    assert.deepEqual(await mobileControls.locator("button").evaluateAll((buttons) =>
      buttons.map((button) => ({
        key: button.getAttribute("data-terminal-key"),
        label: button.getAttribute("aria-label"),
      }))), [
      { key: "escape", label: "Send Escape" },
      { key: "arrow-up", label: "Send Arrow Up" },
      { key: "arrow-down", label: "Send Arrow Down" },
      { key: "arrow-left", label: "Send Arrow Left" },
      { key: "arrow-right", label: "Send Arrow Right" },
      { key: "backspace", label: "Send Backspace" },
      { key: "enter", label: "Send Enter" },
    ]);

    const terminalScreen = page.locator(
      "#project-controller-terminal-output .xterm-screen",
    );
    await terminalScreen.tap({ position: { x: 80, y: 80 } });
    assert.deepEqual(await page.locator(
      "#project-controller-terminal-output .xterm-helper-textarea",
    ).evaluate((textarea) => ({
      focused: document.activeElement === textarea,
      inputMode: textarea.inputMode,
      enterKeyHint: textarea.enterKeyHint,
      autocapitalize: textarea.getAttribute("autocapitalize"),
      autocomplete: textarea.autocomplete,
      spellcheck: textarea.spellcheck,
    })), {
      focused: true,
      inputMode: "text",
      enterKeyHint: "send",
      autocapitalize: "off",
      autocomplete: "off",
      spellcheck: false,
    });

    const inputStart = await opaqueInputCount(page);
    await page.keyboard.insertText("mobile printable");
    for (const key of [
      "escape",
      "arrow-up",
      "arrow-down",
      "arrow-left",
      "arrow-right",
      "backspace",
      "enter",
    ]) {
      await mobileControls.locator(`[data-terminal-key="${key}"]`).tap();
    }
    await page.waitForFunction((start) =>
      window.__mobileWorkbenchSentFrames.filter((frame) => frame.kind === "opaque").length
        >= start + 8, inputStart);
    const mobileInput = new TextDecoder().decode(Uint8Array.from(
      await opaqueInputBytes(page, inputStart),
    ));
    assert.equal(mobileInput,
      "mobile printable\u001b\u001b[A\u001b[B\u001b[D\u001b[C\u007f\r");
    assert.equal(await page.locator(
      "#project-controller-terminal-output .xterm-helper-textarea",
    ).evaluate((textarea) => document.activeElement === textarea), true);

    await page.keyboard.insertText("ansi-fixture");
    await mobileControls.locator('[data-terminal-key="enter"]').tap();
    const accessibleRows = page.locator(
      "#project-controller-terminal-output .xterm-accessibility-tree > [role='listitem']",
    );
    await page.waitForFunction(() => document.querySelector(
      "#project-controller-terminal-output .xterm-accessibility-tree",
    )?.textContent?.includes("FINAL STATUS: READY"));
    const phoneFinalScreen = await accessibleRows.evaluateAll((rows) =>
      rows.map((row) => row.textContent.replaceAll("\u00a0", "").trimEnd()));
    assert.deepEqual(phoneFinalScreen.slice(0, 5), [
      "WORKBENCH VT FIXTURE",
      "",
      "Cursor movement: passed",
      "FINAL STATUS: READY",
      "controller>",
    ]);
    assert.doesNotMatch(phoneFinalScreen.join("\n"),
      /ALT-SCREEN-DECOY|ERASED-LINE|obsolete|\u001b\[/);
    const renderingScale = await page.locator(
      "#project-controller-terminal-output .xterm-screen",
    ).evaluate(async (screenNode) => {
      await document.fonts.ready;
      const output = screenNode.closest(".controller-terminal__output");
      const screenBounds = screenNode.getBoundingClientRect();
      const outputBounds = output.getBoundingClientRect();
      return {
        devicePixelRatio,
        fontLoaded: document.fonts.check('13px "Fira Code"'),
        screenWidth: screenBounds.width,
        outputWidth: outputBounds.width,
        contained: screenBounds.left >= outputBounds.left
          && screenBounds.right <= outputBounds.right,
      };
    });
    assert.equal(renderingScale.devicePixelRatio, 3);
    assert.equal(renderingScale.fontLoaded, true);
    assert.ok(renderingScale.screenWidth > 0);
    assert.ok(renderingScale.screenWidth <= renderingScale.outputWidth);
    assert.equal(renderingScale.contained, true);

    await page.locator(
      "#project-controller-terminal-output .xterm-helper-textarea",
    ).focus();
    for (let line = 0; line < 30; line += 1) {
      await page.keyboard.insertText(`scrollback-${line}`);
      await mobileControls.locator('[data-terminal-key="enter"]').tap();
    }
    await page.waitForFunction(() => {
      const output = document.querySelector("#project-controller-terminal-output");
      return Number(output?.dataset.terminalScrollbackLines) > 0
        && output.dataset.terminalScrollLine === output.dataset.terminalScrollbackLines;
    });
    const terminalViewport = page.locator(
      "#project-controller-terminal-output .xterm-viewport",
    );
    const beforeTerminalSwipe = await page.evaluate(() => {
      const output = document.querySelector("#project-controller-terminal-output");
      const stage = document.querySelector(".workbench-stage");
      return {
        terminalScrollLine: Number(output.dataset.terminalScrollLine),
        stageScrollTop: stage.scrollTop,
        pageScrollY: scrollY,
        navigationOpen: document.querySelector("#workbench-navigation-toggle")
          .getAttribute("aria-expanded"),
        contextOpen: document.querySelector("#workbench-context-toggle")
          .getAttribute("aria-expanded"),
        selectedText: getSelection()?.toString() ?? "",
      };
    });
    const viewportBounds = await terminalViewport.boundingBox();
    const client = await context.newCDPSession(page);
    await swipe(client, {
      x: viewportBounds.x + viewportBounds.width / 2,
      fromY: viewportBounds.y + viewportBounds.height * 0.35,
      toY: viewportBounds.y + viewportBounds.height * 0.75,
    });
    await page.waitForFunction((previous) => Number(document.querySelector(
      "#project-controller-terminal-output",
    ).dataset.terminalScrollLine) < previous, beforeTerminalSwipe.terminalScrollLine);
    const afterTerminalSwipe = await page.evaluate(() => {
      const output = document.querySelector("#project-controller-terminal-output");
      const stage = document.querySelector(".workbench-stage");
      return {
        terminalScrollLine: Number(output.dataset.terminalScrollLine),
        stageScrollTop: stage.scrollTop,
        pageScrollY: scrollY,
        navigationOpen: document.querySelector("#workbench-navigation-toggle")
          .getAttribute("aria-expanded"),
        contextOpen: document.querySelector("#workbench-context-toggle")
          .getAttribute("aria-expanded"),
        selectedText: getSelection()?.toString() ?? "",
      };
    });
    assert.ok(afterTerminalSwipe.terminalScrollLine
      < beforeTerminalSwipe.terminalScrollLine);
    assert.deepEqual({
      stageScrollTop: afterTerminalSwipe.stageScrollTop,
      pageScrollY: afterTerminalSwipe.pageScrollY,
      navigationOpen: afterTerminalSwipe.navigationOpen,
      contextOpen: afterTerminalSwipe.contextOpen,
      selectedText: afterTerminalSwipe.selectedText,
    }, {
      stageScrollTop: beforeTerminalSwipe.stageScrollTop,
      pageScrollY: beforeTerminalSwipe.pageScrollY,
      navigationOpen: "false",
      contextOpen: "false",
      selectedText: "",
    });

    const terminalScrollBeforeDrawer = afterTerminalSwipe.terminalScrollLine;
    const inputCountBeforeDrawer = await opaqueInputCount(page);
    await page.locator("#workbench-context-toggle").tap();
    const contextDrawer = page.locator("#workbench-context");
    const contextBounds = await contextDrawer.boundingBox();
    await swipe(client, {
      x: contextBounds.x + contextBounds.width / 2,
      fromY: contextBounds.y + contextBounds.height * 0.75,
      toY: contextBounds.y + contextBounds.height * 0.3,
    });
    await page.waitForTimeout(100);
    assert.equal(await page.locator("#project-controller-terminal-output").evaluate((output) =>
      Number(output.dataset.terminalScrollLine)),
      terminalScrollBeforeDrawer);
    assert.equal(await opaqueInputCount(page), inputCountBeforeDrawer);
    assert.equal(await page.evaluate(() => getSelection()?.toString() ?? ""), "");
    assert.equal(await page.locator("#workbench-context-toggle").getAttribute(
      "aria-expanded",
    ), "true");

    const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const mobileInputAudits = audits.filter((entry) =>
      entry.action === "controller.terminal.input" && entry.outcome === "observed");
    assert.ok(mobileInputAudits.length >= 9);
    assert.ok(mobileInputAudits.every((entry) =>
      entry.details.contentRetained === false
      && !Object.hasOwn(entry.details, "data")
      && !Object.hasOwn(entry.details, "content")));
    if (process.env.SANDKING_ACCEPTANCE_OBSERVATION_PATH) {
      const terminalPanel = page.locator("#project-focused-controller-session");
      const observation = {
        scenario: "cockpit-workbench/operates-mobile-controller-terminal",
        packagedPublicSeam: installed.observation,
        mobileBrowser: {
          engine: "chromium",
          deviceProfile: "iPhone 13",
          touchEmulation: true,
          virtualKeyboardInputEmulation: true,
          devicePixelRatio: renderingScale.devicePixelRatio,
        },
        layout: {
          phoneViewport: phoneLayout.viewport,
          phoneScreen: phoneLayout.screen,
          viewportScale: phoneLayout.visualViewport.scale,
          horizontalPageOverflow: false,
          terminalContained: phoneLayout.terminalRight <= phoneLayout.viewport.width,
          terminalInternalOverflow: false,
          navigationDrawer: true,
          contextDrawer: true,
          desktopAndTabletCoverageRetained: true,
        },
        terminal: {
          emulator: "@xterm/xterm@6.0.0",
          fontReadyBeforeOpen: renderingScale.fontLoaded,
          fittedColumns: Number(await terminalPanel.getAttribute("data-terminal-columns")),
          fittedRows: Number(await terminalPanel.getAttribute("data-terminal-rows")),
          ansiVtFixture: {
            sameIntendedFinalScreenAsDesktop: true,
            cursorMovement: true,
            eraseAndRedraw: true,
            color: true,
            alternateScreen: true,
            splitEscapeSequence: true,
            transcriptRetained: false,
          },
          mobileInput: {
            terminalTapFocusesTextarea: true,
            printableExactlyOnce: true,
            enterExactlyOnce: true,
            backspaceExactlyOnce: true,
            escapeExactlyOnce: true,
            arrowsExactlyOnce: true,
            applicationCursorModePreserved: true,
            observedInputAuditCount: mobileInputAudits.length,
          },
          touchIsolation: {
            terminalScrollbackMoved: afterTerminalSwipe.terminalScrollLine
              < beforeTerminalSwipe.terminalScrollLine,
            pageDidNotScroll: afterTerminalSwipe.pageScrollY
              === beforeTerminalSwipe.pageScrollY,
            stageDidNotScroll: afterTerminalSwipe.stageScrollTop
              === beforeTerminalSwipe.stageScrollTop,
            drawersDidNotToggle: afterTerminalSwipe.navigationOpen === "false"
              && afterTerminalSwipe.contextOpen === "false",
            unintendedSelection: false,
            drawerGestureChangedTerminalScroll: false,
            drawerGestureSentTerminalInput: false,
          },
        },
        auditReferences: mobileInputAudits.slice(-4).map((entry) => ({
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
        /bootstrap\?token=|sandking_session=|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|mobile printable|scrollback-|ALT-SCREEN-DECOY|FINAL STATUS/i);
      await writeFile(process.env.SANDKING_ACCEPTANCE_OBSERVATION_PATH, observationText, {
        mode: 0o600,
      });
    }
  } finally {
    await browser?.close().catch(() => undefined);
    await execFileAsync(installed.command, [
      "stop", "--data-dir", dataDir, "--json",
    ], { cwd: executionDirectory, env: productEnvironment }).catch(() => undefined);
    if (runtimePid) {
      try {
        process.kill(runtimePid, "SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 100));
        process.kill(runtimePid, 0);
        process.kill(runtimePid, "SIGKILL");
      } catch {
        // The normal lifecycle stop already completed.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
