import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { probeClaude } from "../src/claude-provider-adapter.mjs";
import {
  selectInstalledClaudeAcceptanceAuditChain,
  selectInstalledClaudeProjectRegistration,
} from "./installed-claude-acceptance-audits.mjs";
import { installCurrentPackage } from "./installed-package.mjs";

const execFileAsync = promisify(execFile);
const issueArgumentIndex = process.argv.indexOf("--issue");
const configuredIssue = issueArgumentIndex === -1
  ? 152
  : Number(process.argv[issueArgumentIndex + 1]);
if (configuredIssue !== 124 && configuredIssue !== 152) {
  throw new Error("installed_claude_real_acceptance_issue_invalid: expected 124 or 152");
}
/** @type {124 | 152} */
const issue = configuredIssue;
const acceptanceError = (suffix) => `issue_${issue}_real_acceptance_${suffix}`;

if (process.env.SANDKING_REAL_CLAUDE_ACCEPTANCE !== "1") {
  throw new Error(
    `${acceptanceError("gate_closed")}: set SANDKING_REAL_CLAUDE_ACCEPTANCE=1 explicitly`,
  );
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error(acceptanceError("requires_human_tty"));
}

const configuredProject = process.env.SANDKING_REAL_CLAUDE_PROJECT;
if (!configuredProject || !isAbsolute(configuredProject)) {
  throw new Error(acceptanceError("project_must_be_absolute"));
}
const projectPath = await realpath(configuredProject);
if (!(await stat(projectPath)).isDirectory()) {
  throw new Error(acceptanceError("project_not_directory"));
}
await execFileAsync("git", ["-C", projectPath, "rev-parse", "--show-toplevel"], {
  env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
});
const projectStatusBefore = (await execFileAsync("git", [
  "-C", projectPath, "status", "--porcelain=v1", "--untracked-files=all",
], { env: { PATH: process.env.PATH, LANG: "C.UTF-8" } })).stdout;

const probe = await probeClaude();
if (probe.availability.status !== "available") {
  throw new Error(
    `${acceptanceError("provider_unavailable")}:${probe.availability.failure?.code
      ?? probe.availability.status}`,
  );
}

const acceptanceRoot = await mkdtemp(join(tmpdir(), "sandking-real-claude-acceptance-"));
const dataDir = join(acceptanceRoot, "state");
const outsideCheckout = join(acceptanceRoot, "work");
let cliPath;
let packagedEnvironment;
try {
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(outsideCheckout, { recursive: true }),
  ]);
  const installed = await installCurrentPackage(acceptanceRoot);
  cliPath = installed.command;
  await stat(cliPath);
  packagedEnvironment = {
    ...process.env,
    PATH: `${dirname(cliPath)}:${process.env.PATH ?? ""}`,
  };
} catch (error) {
  await rm(acceptanceRoot, { recursive: true, force: true });
  throw error;
}
const lifecycleKey = `issue-${issue}-real-${randomBytes(12).toString("hex")}`;
let runtimeStarted = false;

try {
  const { stdout } = await execFileAsync(cliPath, [
    "launch",
    "--data-dir", dataDir,
    "--idempotency-key", lifecycleKey,
    "--expected-revision", "0",
    "--json",
  ], {
    cwd: outsideCheckout,
    env: packagedEnvironment,
    maxBuffer: 1024 * 1024,
  });
  const launch = JSON.parse(stdout);
  if (!launch.bootstrapUrl || !launch.runtime?.runtimeId) {
    throw new Error(acceptanceError("runtime_start_invalid"));
  }
  runtimeStarted = true;

  process.stdout.write(
    "\nSand-King opened a one-use Cockpit bootstrap in your browser.\n"
    + "The bootstrap URL is intentionally not echoed or retained. Complete this exact checklist:\n\n"
    + `  1. Open the explicit Project: ${projectPath}\n`
    + "  2. Confirm the Cockpit reports the installed Claude Code CLI as available/authenticated.\n"
    + "  3. Click “Open installed Claude Code”.\n"
    + `  4. Ask Claude to use Sand-King's ordinary CLI to launch issue #${issue} for the focused Project. Do not give it command syntax; Claude must discover the packaged CLI surface.\n`
    + "  5. Confirm there is no plugin command, proposal, approval, revision, or separate start step.\n"
    + "  6. Wait for the Cockpit to show one structured conformance Harness outcome.\n"
    + "  7. Close or refresh the browser once and confirm the Controller session survives.\n\n"
    + "Do not paste or transfer credentials. Sand-King uses the destination-local Claude credential store in place.\n",
  );
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const confirmation = await readline.question(
      "Type COMPLETE only after every checklist item has been observed: ",
    );
    if (confirmation !== "COMPLETE") {
      throw new Error(acceptanceError("not_confirmed"));
    }
  } finally {
    readline.close();
  }

  const [projectState, controllerState, harnessState, auditText] =
    await Promise.all([
      readFile(join(dataDir, "project-registrations.json"), "utf8").then(JSON.parse),
      readFile(join(dataDir, "controller-sessions.json"), "utf8").then(JSON.parse),
      readFile(join(dataDir, "harness-runs.json"), "utf8").then(JSON.parse),
      readFile(join(dataDir, "audit.jsonl"), "utf8"),
    ]);
  const projectRegistration = selectInstalledClaudeProjectRegistration({
    issue,
    projectState,
    projectPath,
  });
  const claudeSessions = controllerState.sessions.filter((session) =>
    session.providerId === "claude-code");
  if (claudeSessions.length !== 1) {
    throw new Error(acceptanceError("requires_one_claude_session"));
  }
  const session = claudeSessions[0];
  if (session.terminal.runtimeOwned !== true || session.terminal.status !== "running") {
    throw new Error(acceptanceError("runtime_owned_session_not_retained"));
  }
  const runs = harnessState.runs.filter((run) =>
    run.controllerSessionId === session.sessionId
    && run.source === "controller-cli");
  if (
    runs.length !== 1
    || !["succeeded", "failed", "cancelled"].includes(runs[0].status)
    || !runs[0].outcome
    || runs[0].terminalEnvelopeValidation?.exactlyOne !== true
  ) {
    throw new Error(acceptanceError("requires_one_structured_harness_outcome"));
  }
  const audits = auditText.trim().split("\n").map((line) => JSON.parse(line));
  selectInstalledClaudeAcceptanceAuditChain({
    issue,
    audits,
    session,
    projectRegistration,
    run: runs[0],
  });
  const projectStatusAfter = (await execFileAsync("git", [
    "-C", projectPath, "status", "--porcelain=v1", "--untracked-files=all",
  ], { env: { PATH: process.env.PATH, LANG: "C.UTF-8" } })).stdout;
  if (projectStatusAfter !== projectStatusBefore) {
    throw new Error(acceptanceError("project_state_changed"));
  }

  process.stdout.write(`Installed-Claude acceptance passed for issue #${issue}.\n`);
} finally {
  if (runtimeStarted) {
    await execFileAsync(cliPath, [
      "stop",
      "--data-dir", dataDir,
      "--json",
    ], { cwd: outsideCheckout, env: packagedEnvironment }).catch(() => undefined);
  }
  await rm(acceptanceRoot, { recursive: true, force: true });
}
