import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { probeClaude } from "../src/claude-provider-adapter.mjs";
import { launchBrowser } from "./browser-launch.mjs";
import { installCurrentPackage } from "./installed-package.mjs";

const execFileAsync = promisify(execFile);
if (process.env.SANDKING_REAL_CLAUDE_ACCEPTANCE !== "1") {
  throw new Error(
    "issue_146_real_acceptance_gate_closed:set SANDKING_REAL_CLAUDE_ACCEPTANCE=1 explicitly",
  );
}

const configuredProject = process.env.SANDKING_REAL_CLAUDE_PROJECT;
if (!configuredProject || !isAbsolute(configuredProject)) {
  throw new Error("issue_146_real_acceptance_project_must_be_absolute");
}
const projectPath = await realpath(configuredProject);
if (!(await stat(projectPath)).isDirectory()) {
  throw new Error("issue_146_real_acceptance_project_not_directory");
}
const projectStatusBefore = (await execFileAsync("git", [
  "-C", projectPath, "status", "--porcelain=v1", "--untracked-files=all",
], { env: { PATH: process.env.PATH, LANG: "C.UTF-8" } })).stdout;
const probe = await probeClaude();
if (probe.availability.status !== "available") {
  throw new Error(
    `issue_146_real_acceptance_environment_unavailable:${probe.availability.failure?.code
      ?? probe.availability.status}`,
  );
}
const root = await mkdtemp(join(tmpdir(), "sandking-issue-146-real-"));
const dataDir = join(root, "state");
const executionDirectory = join(root, "outside-project");
await mkdir(executionDirectory);
const installed = await installCurrentPackage(root);
let browser;
let runtimeStarted = false;

try {
  const { stdout } = await execFileAsync(installed.command, [
    "launch",
    "--data-dir", dataDir,
    "--idempotency-key", "issue-146-real-claude-runtime",
    "--expected-revision", "0",
    "--json",
    "--no-open",
  ], { cwd: executionDirectory, env: process.env, maxBuffer: 1024 * 1024 });
  const launch = JSON.parse(stdout);
  runtimeStarted = true;
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(launch.bootstrapUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#claude-provider-status[data-availability='available']", {
    timeout: 15_000,
  });
  await page.locator("#project-path").fill(projectPath);
  await page.locator("#project-harness-adapter")
    .selectOption("conformance-harness-adapter-v1");
  await page.locator("#open-project").click();
  await page.waitForSelector("#project-readiness[data-harness-launch-ready='true']", {
    timeout: 15_000,
  });
  const projectId = await page.locator("#project-readiness").getAttribute("data-project-id");
  await page.waitForFunction((selectedProjectId) => {
    const selectedProject = document.querySelector("#project-readiness");
    const breadcrumb = document.querySelector("#workbench-project-breadcrumb");
    return selectedProject?.getAttribute("data-project-id") === selectedProjectId
      && breadcrumb?.textContent?.includes("Projects / ");
  }, projectId);
  await page.locator("#open-project-claude-controller").click();
  await page.waitForSelector(
    "#project-focused-controller-session[data-provider-id='claude-code'][data-terminal-attachment='read-write']",
    { timeout: 30_000 },
  );
  const panel = page.locator("#project-focused-controller-session");
  await page.waitForFunction((selectedProjectId) => {
    const focusedController = document.querySelector("#workbench-focused-controller");
    const focusedContext = document.querySelector("#workbench-focused-context");
    const attachment = document.querySelector("#workbench-attachment-status");
    return focusedController?.getAttribute("data-work-context-id") === selectedProjectId
      && focusedContext?.getAttribute("data-work-context-id") === selectedProjectId
      && attachment?.getAttribute("data-provider") === "claude-code"
      && attachment?.getAttribute("data-attachment") === "read-write";
  }, projectId);
  await page.waitForFunction(() => {
    const target = document.querySelector("#project-focused-controller-session");
    return Number(target?.getAttribute("data-terminal-columns")) >= 20
      && Number(target?.getAttribute("data-terminal-rows")) >= 5
      && document.querySelectorAll(
        "#project-controller-terminal-output .xterm-accessibility-tree [role='listitem']",
      ).length >= 5;
  }, undefined, { timeout: 30_000 });
  const initialResizeSequence = Number(
    await panel.getAttribute("data-terminal-resize-sequence"),
  );
  const terminal = page.locator("#project-controller-terminal-output .xterm-helper-textarea");
  await terminal.focus();
  await page.keyboard.type("/help");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Control+L");
  await page.setViewportSize({ width: 1250, height: 900 });
  await page.waitForFunction((previous) => Number(document.querySelector(
    "#project-focused-controller-session",
  )?.getAttribute("data-terminal-resize-sequence")) > previous,
  initialResizeSequence);
  const sessionId = await panel.getAttribute("data-session-id");
  const streamId = await panel.getAttribute("data-terminal-stream-id");
  await page.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const reconnectPage = await context.newPage();
  await reconnectPage.goto(`http://127.0.0.1:${launch.runtime.port}/`, {
    waitUntil: "domcontentloaded",
  });
  await reconnectPage.waitForSelector(
    `#project-focused-controller-session[data-session-id='${sessionId}'][data-reconnected='true']`,
    { timeout: 15_000 },
  );
  await reconnectPage.close();

  const [controllerState, auditText] = await Promise.all([
    readFile(join(dataDir, "controller-sessions.json"), "utf8").then(JSON.parse),
    readFile(join(dataDir, "audit.jsonl"), "utf8"),
  ]);
  const session = controllerState.sessions.find((candidate) =>
    candidate.sessionId === sessionId);
  if (
    !session
    || session.providerId !== "claude-code"
    || session.terminal.streamId !== streamId
    || session.terminal.runtimeOwned !== true
    || session.terminal.status !== "running"
  ) {
    throw new Error("issue_146_real_acceptance_runtime_session_invalid");
  }
  const audits = auditText.trim().split("\n").map((line) => JSON.parse(line));
  const inputAudits = audits.filter((entry) =>
    entry.action === "controller.terminal.input"
    && entry.details.sessionId === sessionId);
  const resizeAudits = audits.filter((entry) =>
    entry.action === "controller.terminal.resize"
    && entry.details.sessionId === sessionId);
  if (
    inputAudits.length < 6
    || resizeAudits.length < 2
    || inputAudits.some((entry) => entry.details.contentRetained !== false)
    || resizeAudits.some((entry) => entry.details.contentRetained !== false)
  ) {
    throw new Error("issue_146_real_acceptance_terminal_observation_invalid");
  }
  await Promise.all([
    readFile(join(dataDir, "launch-requests.json"), "utf8")
      .then(() => { throw new Error("issue_146_real_acceptance_launch_request_prohibited"); })
      .catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      }),
    readFile(join(dataDir, "harness-runs.json"), "utf8")
      .then(() => { throw new Error("issue_146_real_acceptance_harness_run_prohibited"); })
      .catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      }),
  ]);
  const projectStatusAfter = (await execFileAsync("git", [
    "-C", projectPath, "status", "--porcelain=v1", "--untracked-files=all",
  ], { env: { PATH: process.env.PATH, LANG: "C.UTF-8" } })).stdout;
  if (projectStatusAfter !== projectStatusBefore) {
    throw new Error("issue_146_real_acceptance_project_state_changed");
  }
  process.stdout.write("Real-Claude terminal acceptance passed for issue #146.\n");
} finally {
  await browser?.close().catch(() => undefined);
  if (runtimeStarted) {
    await execFileAsync(installed.command, [
      "stop", "--data-dir", dataDir, "--json",
    ], { cwd: executionDirectory, env: process.env }).catch(() => undefined);
  }
  await rm(root, { recursive: true, force: true });
}
