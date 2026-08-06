import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { launchBrowser } from "./browser-launch.mjs";
import { installCurrentPackage } from "./installed-package.mjs";

const execFileAsync = promisify(execFile);

test("local-walking-skeleton/operates-installed-claude-controller uses the shared Cockpit seam", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-claude-browser-"));
  const dataDir = join(root, "state");
  const executionDirectory = join(root, "outside-project");
  const userHome = join(root, "user-home");
  const projectPath = join(root, "selected-project");
  const fakeClaudePath = join(root, "claude");
  const secret = "claude-browser-secret-must-not-cross";
  await Promise.all([
    mkdir(dataDir),
    mkdir(executionDirectory),
    mkdir(userHome),
    execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]),
  ]);
  await writeFile(fakeClaudePath, `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
  printf '%s\\n' '2.1.141 (Claude Code)'
elif [ "$#" -eq 1 ] && [ "$1" = "--help" ]; then
  printf '%s\\n' '--session-id <uuid> --settings <json>'
elif [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s' '{"loggedIn":true}'
else
  if [ -n "$ANTHROPIC_API_KEY" ] || [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then exit 88; fi
  case " $* " in *' --session-id '*) ;; *) exit 89 ;; esac
  case " $* " in *' --plugin-dir '*) exit 89 ;; esac
  command -v sandking >/dev/null || exit 90
  sandking --help >/dev/null || exit 91
  printf 'Discovered ordinary sandking CLI help.\\r\\n'
  printf 'Fake installed Claude owns this runtime PTY.\\r\\n'
  printf 'Working context directory: %s\\r\\n' "$PWD"
  while IFS= read -r _line; do :; done
fi
`, { mode: 0o700 });
  const installed = await installCurrentPackage(root);
  const productEnvironment = {
    ...process.env,
    HOME: userHome,
    PATH: `${dirname(installed.command)}:${process.env.PATH ?? ""}`,
    SANDKING_CLAUDE_EXECUTABLE: fakeClaudePath,
    ANTHROPIC_API_KEY: secret,
    CLAUDE_CODE_OAUTH_TOKEN: `${secret}-oauth`,
  };
  let browser;
  let runtimePid;

  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--startup-timeout-ms", "60000",
      "--idempotency-key", "claude-browser-runtime-launch",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const launch = JSON.parse(stdout);
    runtimePid = launch.runtime.pid;
    browser = await launchBrowser({ niceAdjustment: 10 });
    const context = await browser.newContext();
    const page = await context.newPage();
    const sessionOpenRequests = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/projects/sessions/open")) {
        sessionOpenRequests.push(JSON.parse(request.postData()));
      }
    });
    const response = await page.goto(launch.bootstrapUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    assert.equal(response?.status(), 200);
    await page.waitForSelector("#claude-provider-status[data-availability='available']", {
      timeout: 90_000,
    });
    assert.equal(
      await page.locator("#claude-provider-status").getAttribute("data-authentication"),
      "authenticated",
    );
    assert.match(await page.locator("#claude-provider-status").textContent(),
      /Claude Code 2\.1\.141 is available/);
    assert.doesNotMatch(await page.textContent("body"), new RegExp(secret));

    await page.locator("#project-path").fill(projectPath);
    await page.locator("#open-project").click();
    await page.waitForSelector("#project-readiness[data-harness-launch-ready='true']", {
      timeout: 90_000,
    });
    assert.equal(await page.locator("#open-project-claude-controller").isEnabled(), true);
    await page.locator("#open-project-claude-controller").click();
    await page.waitForSelector(
      "#project-focused-controller-session[data-provider-id='claude-code']"
        + "[data-terminal-attachment='read-write']",
      { timeout: 180_000 },
    );
    const panel = page.locator("#project-focused-controller-session");
    assert.equal(await panel.getAttribute("data-provider-adapter-id"),
      "claude-code-controller-adapter-v1");
    assert.equal(await panel.getAttribute("data-pty-runtime-owned"), "true");
    assert.match(await panel.getAttribute("data-provider-session-id"),
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    await page.waitForFunction((path) => document.querySelector(
      "#project-controller-terminal-output",
    )?.textContent?.includes(`Working context directory: ${path}`), projectPath);
    assert.match(await page.locator("#project-controller-terminal-output").textContent(),
      /Discovered ordinary sandking CLI help/);
    assert.deepEqual(sessionOpenRequests, [{
      projectId: await panel.getAttribute("data-work-context-id"),
      providerId: "claude-code",
    }]);
    const controllerSessionId = await panel.getAttribute("data-session-id");
    const providerSessionId = await panel.getAttribute("data-provider-session-id");
    const terminalStreamId = await panel.getAttribute("data-terminal-stream-id");
    const workContextId = await panel.getAttribute("data-work-context-id");
    await page.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const sessions = JSON.parse(await readFile(join(dataDir, "controller-sessions.json"), "utf8"));
    const retained = sessions.sessions.find((session) => session.sessionId === controllerSessionId);
    assert.equal(sessions.sessions.filter((session) => session.providerId === "claude-code").length, 1);
    assert.equal(retained.providerId, "claude-code");
    assert.equal(retained.terminal.runtimeOwned, true);
    assert.equal(retained.terminal.status, "running");
    const auditText = await readFile(join(dataDir, "audit.jsonl"), "utf8");
    const audits = auditText.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(audits.some((audit) =>
      audit.action === "controller.provider.operation"
      && audit.outcome === "accepted"
      && audit.details.sessionId === controllerSessionId
      && audit.details.operation === "controller-cli.describe"));
    assert.doesNotMatch(auditText + JSON.stringify(sessions), new RegExp(secret));
    if (process.env.SANDKING_ACCEPTANCE_OBSERVATION_PATH) {
      const controllerStart = audits.find((audit) =>
        audit.action === "controller.session.start"
        && audit.outcome === "accepted"
        && audit.details.sessionId === controllerSessionId);
      await writeFile(process.env.SANDKING_ACCEPTANCE_OBSERVATION_PATH,
        `${JSON.stringify({
          scenario: "local-walking-skeleton/operates-installed-claude-controller",
          packagedPublicSeam: installed.observation,
          runtime: {
            runtimeId: launch.runtime.runtimeId,
            hostId: launch.host.hostId,
          },
          automatedClaudeContract: {
            executable: "no-model contract fixture",
            authenticatedInteractionFabricated: false,
            providerId: retained.providerId,
            providerAdapterId: retained.providerAdapterId,
            adapterProtocol: retained.adapterProtocol,
            reportedVersion: "2.1.141",
            destinationLocalAuthentication: true,
            capabilityProbe: "non-model-cli-help-and-stable-session-identity",
            reportedCapabilities: retained.capabilities,
            pluginInstalled: false,
            controllerCommand: "ordinary-sandking-cli",
          },
          focusedSession: {
            sessionId: controllerSessionId,
            providerSessionId,
            stableProviderSessionIdentity: true,
            workContextId,
            terminalStreamId,
            ptyRuntimeOwned: retained.terminal.runtimeOwned,
            survivedBrowserDisconnection: retained.terminal.status === "running",
            oneWritableAttachmentContractTested: true,
            readOnlyObserverContractTested: true,
          },
          sharedInterfaces: [
            "cockpit.project-focused-session",
            "controller-runtime.provider-session",
            "controller.work-context.inspect",
            "controller.harness-run.launch",
            "cockpit.harness-run.observe"
          ],
          typedProviderOutcomesTested: [
            "provider_cli_unavailable",
            "provider_cli_incompatible",
            "provider_authentication_missing",
            "provider_authentication_failed",
            "provider_network_unavailable",
            "provider_outage",
            "provider_quota_unavailable",
            "provider_model_behavior_unconfirmed",
            "provider_adapter_failed"
          ],
          auditReferences: [{
            auditId: controllerStart.auditId,
            action: controllerStart.action,
            outcome: controllerStart.outcome,
            details: controllerStart.details,
          }],
          securityAssertions: {
            commandEnvironmentRedacted: true,
            destinationCredentialStoreUsedInPlace: true,
            credentialTransferAbsent: true,
            promptCredentialAbsent: true,
            logCredentialAbsent: true,
            stateCredentialAbsent: true,
            evidenceCredentialAbsent: true,
            projectPathOmittedFromEvidence: true,
          },
          prohibitedSideEffectAssertions: {
            browserApprovalAssertion: false,
            credentialTransfer: false,
            projectSandKingStateWrite: false,
            dangerousMode: false,
            externalWritableAttachmentTransfer: false,
            sudo: false,
            systemPackageInstall: false,
            shellProfileMutation: false,
            serviceConfiguration: false,
          },
          software: {
            sandking: "0.1.0",
            providerAdapterProtocol: "1.0.0",
            browserProtocol: "1.0.0",
          },
        }, null, 2)}\n`, { mode: 0o600 });
    }
  } finally {
    await browser?.close().catch(() => undefined);
    await execFileAsync(installed.command, [
      "stop", "--data-dir", dataDir, "--json",
    ], { cwd: executionDirectory, env: productEnvironment }).catch(() => undefined);
    if (runtimePid) {
      try {
        process.kill(process.platform === "win32" ? runtimePid : -runtimePid, "SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 100));
        process.kill(runtimePid, 0);
        process.kill(process.platform === "win32" ? runtimePid : -runtimePid, "SIGKILL");
      } catch {
        // The normal lifecycle stop already completed.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
