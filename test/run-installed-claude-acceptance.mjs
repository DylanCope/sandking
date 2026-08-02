import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { probeClaude } from "../src/claude-provider-adapter.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = resolve(
  process.argv.find((argument) => argument.endsWith(".json"))
    ?? "acceptance/issue-124.manifest.json",
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

if (
  manifest.issue !== 124
  || manifest.parentPrd !== 125
  || manifest.environmentGate?.name !== "SANDKING_REAL_CLAUDE_ACCEPTANCE"
) {
  throw new Error("issue_124_real_acceptance_manifest_invalid");
}
if (process.env.SANDKING_REAL_CLAUDE_ACCEPTANCE !== "1") {
  throw new Error(
    "issue_124_real_acceptance_gate_closed: set SANDKING_REAL_CLAUDE_ACCEPTANCE=1 explicitly",
  );
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("issue_124_real_acceptance_requires_human_tty");
}

const configuredProject = process.env.SANDKING_REAL_CLAUDE_PROJECT;
if (!configuredProject || !isAbsolute(configuredProject)) {
  throw new Error("issue_124_real_acceptance_project_must_be_absolute");
}
const projectPath = await realpath(configuredProject);
if (!(await stat(projectPath)).isDirectory()) {
  throw new Error("issue_124_real_acceptance_project_not_directory");
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
    `issue_124_real_acceptance_provider_unavailable:${probe.availability.failure?.code
      ?? probe.availability.status}`,
  );
}

const dataDir = await mkdtemp(join(tmpdir(), "sandking-real-claude-acceptance-"));
const cliPath = join(repositoryRoot, "src", "cli.mjs");
const lifecycleKey = `issue-124-real-${randomBytes(12).toString("hex")}`;
let runtimeStarted = false;
let evidenceWritten = false;

try {
  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "launch",
    "--data-dir", dataDir,
    "--idempotency-key", lifecycleKey,
    "--expected-revision", "0",
    "--json",
  ], {
    cwd: repositoryRoot,
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  const launch = JSON.parse(stdout);
  if (!launch.bootstrapUrl || !launch.runtime?.runtimeId) {
    throw new Error("issue_124_real_acceptance_runtime_start_invalid");
  }
  runtimeStarted = true;

  process.stdout.write(
    "\nSand-King opened a one-use Cockpit bootstrap in your browser.\n"
    + "The bootstrap URL is intentionally not echoed or retained. Complete this exact checklist:\n\n"
    + `  1. Open the explicit Project: ${projectPath}\n`
    + "  2. Confirm the Cockpit reports the installed Claude Code CLI as available/authenticated.\n"
    + "  3. Click “Open installed Claude Code”.\n"
    + "  4. In that Claude conversation run /sandking-controller:inspect-work-context.\n"
    + "  5. Run /sandking-controller:prepare-launch with an issue number and its exact sandcastle/issue-<id> branch.\n"
    + "  6. Inspect the sanitized immutable preview, then run /sandking-controller:approve-launch with the exact request ID and revision.\n"
    + "  7. Separately run /sandking-controller:start-approved-run with the approved request ID and revision.\n"
    + "  8. Wait for the Cockpit to show one structured conformance Harness outcome.\n"
    + "  9. Close or refresh the browser once and confirm the Controller session survives.\n\n"
    + "Do not paste or transfer credentials. Sand-King uses the destination-local Claude credential store in place.\n",
  );
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const confirmation = await readline.question(
      "Type COMPLETE only after every checklist item has been observed: ",
    );
    if (confirmation !== "COMPLETE") {
      throw new Error("issue_124_real_acceptance_not_confirmed");
    }
  } finally {
    readline.close();
  }

  const [controllerState, launchState, harnessState, auditText] = await Promise.all([
    readFile(join(dataDir, "controller-sessions.json"), "utf8").then(JSON.parse),
    readFile(join(dataDir, "launch-requests.json"), "utf8").then(JSON.parse),
    readFile(join(dataDir, "harness-runs.json"), "utf8").then(JSON.parse),
    readFile(join(dataDir, "audit.jsonl"), "utf8"),
  ]);
  const claudeSessions = controllerState.sessions.filter((session) =>
    session.providerId === "claude-code");
  if (claudeSessions.length !== 1) {
    throw new Error("issue_124_real_acceptance_requires_one_claude_session");
  }
  const session = claudeSessions[0];
  if (session.terminal.runtimeOwned !== true || session.terminal.status !== "running") {
    throw new Error("issue_124_real_acceptance_runtime_owned_session_not_retained");
  }
  const approvedRequests = launchState.launchRequests.filter((request) =>
    request.owner?.controllerSessionId === session.sessionId
    && request.status === "approved"
    && request.decision?.decision === "approved");
  if (approvedRequests.length !== 1) {
    throw new Error("issue_124_real_acceptance_requires_one_exact_approval");
  }
  const launchRequest = approvedRequests[0];
  const runs = harnessState.runs.filter((run) =>
    run.controllerSessionId === session.sessionId
    && run.launchRequestId === launchRequest.launchRequestId);
  if (
    runs.length !== 1
    || !["succeeded", "failed", "cancelled"].includes(runs[0].status)
    || !runs[0].outcome
    || runs[0].terminalEnvelopeValidation?.exactlyOne !== true
  ) {
    throw new Error("issue_124_real_acceptance_requires_one_structured_harness_outcome");
  }
  const audits = auditText.trim().split("\n").map((line) => JSON.parse(line));
  const sessionAudits = [
    "controller.session.start",
    "launch.request.prepare",
    "launch.request.decision",
    "harness.run.start",
  ].map((action) => audits.find((entry) =>
    entry.action === action
    && entry.details?.controllerSessionId === session.sessionId));
  const outcomeAudit = audits.find((entry) =>
    entry.action === "harness.run.outcome"
    && entry.details?.harnessRunId === runs[0].harnessRunId);
  const requiredAudits = [...sessionAudits, outcomeAudit];
  if (requiredAudits.some((entry) => !entry)) {
    throw new Error("issue_124_real_acceptance_audit_chain_incomplete");
  }
  const projectStatusAfter = (await execFileAsync("git", [
    "-C", projectPath, "status", "--porcelain=v1", "--untracked-files=all",
  ], { env: { PATH: process.env.PATH, LANG: "C.UTF-8" } })).stdout;
  if (projectStatusAfter !== projectStatusBefore) {
    throw new Error("issue_124_real_acceptance_project_state_changed");
  }

  const run = runs[0];
  const evidence = {
    schemaVersion: 1,
    issue: 124,
    parentPrd: 125,
    scenario: manifest.scenarios[0].id,
    recordedAt: new Date().toISOString(),
    execution: "final-human-environment-acceptance-child",
    environment: {
      claudeVersion: probe.availability.version,
      availability: probe.availability.status,
      authentication: probe.availability.authentication.status,
      credentialSource: "destination-local",
      credentialsTransferred: false,
      modelInteractionPerformedByHuman: true,
      integration: {
        pluginId: probe.integration.pluginId,
        pluginVersion: probe.integration.pluginVersion,
        pluginScope: probe.integration.scope,
        pluginLoading: probe.integration.loading,
        shimBoundary: probe.integration.boundary,
      },
    },
    observations: {
      projectFocusedControllerSessionOpened: true,
      providerId: session.providerId,
      providerAdapterId: session.providerAdapterId,
      stableProviderSessionIdentity: session.sessionIdentity?.stable === true,
      ptyRuntimeOwned: session.terminal.runtimeOwned,
      browserDisconnectionSurvivalHumanConfirmed: true,
      launchRequestPrepared: true,
      exactLaunchRequestApprovedInConversation: true,
      approvalSeparatedFromRunStart: true,
      harnessRunId: run.harnessRunId,
      structuredHarnessOutcome: {
        status: run.outcome.status,
        code: run.outcome.code,
        incompleteResult: run.outcome.incompleteResult,
        exactlyOneTerminalEnvelope: run.terminalEnvelopeValidation.exactlyOne,
      },
    },
    auditReferences: requiredAudits.map(({ auditId, action, outcome }) => ({
      auditId,
      action,
      outcome,
    })),
    securityAssertions: {
      projectPathRetained: false,
      credentialValueRetained: false,
      browserApprovalAssertion: false,
      projectSandKingStateWrite: false,
    },
  };
  const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
  if (
    evidenceText.includes(projectPath)
    || /ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|bootstrap\?token=|sandking_session=/i
      .test(evidenceText)
  ) {
    throw new Error("issue_124_real_acceptance_evidence_not_sanitized");
  }
  const evidencePath = resolve(
    process.env.SANDKING_REAL_CLAUDE_EVIDENCE_PATH
      ?? join(repositoryRoot, "acceptance", "evidence", "issue-124.real.json"),
  );
  await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
  await writeFile(evidencePath, evidenceText, { mode: 0o600 });
  evidenceWritten = true;
  process.stdout.write(`Retained sanitized real-environment evidence: ${evidencePath}\n`);
} finally {
  if (runtimeStarted) {
    await execFileAsync(process.execPath, [
      cliPath,
      "stop",
      "--data-dir", dataDir,
      "--json",
    ], { cwd: repositoryRoot, env: process.env }).catch(() => undefined);
  }
  await rm(dataDir, { recursive: true, force: true });
  if (!evidenceWritten) {
    process.stderr.write("No real-environment acceptance evidence was retained.\n");
  }
}
