import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { launchBrowser } from "./browser-launch.mjs";
import {
  enableInstalledHostModeCli,
  installCurrentPackage,
} from "./installed-package.mjs";

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
    if (match && Number(match[2]) === runtimePid
      && /(?:^|[/\s])local-host\.mjs(?:\s|$)/.test(match[3])) {
      return Number(match[1]);
    }
  }
  throw new Error("local_host_process_not_found");
};

const waitForStoppedProcess = async (pid) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { stdout } = await execFileAsync("ps", ["-o", "stat=", "-p", String(pid)]);
    if (stdout.trim().startsWith("T")) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("local_host_process_not_stopped");
};

test("one-action Cockpit launch shows a truthful Harness failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-truthful-failure-browser-"));
  const dataDir = join(root, "host-state");
  const executionDirectory = join(root, "outside-checkout");
  const userHome = join(root, "user-home");
  const projectPath = join(root, "selected-project");
  const secret = "truthful-failure-controller-secret";
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(executionDirectory, { recursive: true }),
    mkdir(userHome, { recursive: true }),
    execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]),
  ]);
  await writeFile(join(projectPath, "README.md"), "ordinary Project content\n");
  const projectFilesBefore = (await readdir(projectPath)).sort();
  const installed = await installCurrentPackage(root);
  const productEnvironment = { ...process.env, HOME: userHome, SANDKING_CONTROLLER_SECRET: secret };
  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch", "--data-dir", dataDir, "--startup-timeout-ms", "60000",
      "--idempotency-key", "truthful-failure-runtime-start", "--expected-revision", "0",
      "--json", "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const runtime = JSON.parse(stdout);
    const browser = await launchBrowser({ niceAdjustment: 10 });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(runtime.bootstrapUrl, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#project-preparation[data-explicit-path-only='true']", {
        timeout: 90_000,
      });
      await page.locator("#project-path").fill(projectPath);
      await page.locator("#open-project").click();
      await page.waitForSelector("#launch-harness:not([disabled])", { timeout: 90_000 });
      await page.locator("#harness-launch-parameter-issueNumber").fill("999999999");
      await page.locator("#launch-harness").click();
      await page.locator("#harness-launch-confirmation-yes").click();
      await page.waitForFunction(() => /Harness run harness-run-[a-f0-9]{24} launched\./.test(
        document.querySelector("#harness-launch-feedback")?.textContent ?? "",
      ));
      const harnessRunId = /Harness run (harness-run-[a-f0-9]{24}) launched\./.exec(
        await page.locator("#harness-launch-feedback").textContent(),
      )?.[1];
      assert.match(harnessRunId, /^harness-run-[a-f0-9]{24}$/);
      await page.waitForSelector(
        `#harness-run-observation[data-run-id='${harnessRunId}'][data-run-status='failed']`,
        { timeout: 90_000 },
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

      const { state: runState, run } = await waitForTerminalRun(dataDir);
      assert.equal(runState.runs.length, 1);
      assert.equal(run.source, "cockpit");
      assert.equal(run.outcome.code, "harness_result_incomplete");
      assert.equal(run.outcome.incompleteResult, true);
      assert.equal("launchRequestId" in run, false);
      await assert.rejects(access(join(dataDir, "launch-requests.json")));
      const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(audits.filter((audit) => audit.action === "harness.run.launch"
        && audit.outcome === "accepted").length, 1);
      assert.ok(audits.some((audit) => audit.action === "harness.run.outcome"
        && audit.details.harnessRunId === harnessRunId));
      assert.equal(audits.some((audit) => /launch\.request|harness\.run\.start/.test(
        audit.action,
      )), false);
      assert.deepEqual((await readdir(projectPath)).sort(), projectFilesBefore);
      assert.doesNotMatch(JSON.stringify({ runState, audits }), new RegExp(secret));
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    await execFileAsync(installed.command, ["stop", "--data-dir", dataDir, "--json"], {
      cwd: executionDirectory,
      env: productEnvironment,
    }).catch(() => undefined);
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
      "--startup-timeout-ms", "60000",
      "--idempotency-key", "active-host-loss-runtime-start",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const launch = JSON.parse(stdout);
    const browser = await launchBrowser({ niceAdjustment: 10 });
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
        timeout: 90_000,
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
      "--startup-timeout-ms", "60000",
      "--idempotency-key", "accepted-project-replay-runtime-start",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const launch = JSON.parse(stdout);
    const browser = await launchBrowser({ niceAdjustment: 10 });
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
        timeout: 90_000,
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
        timeout: 90_000,
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

  await enableInstalledHostModeCli(installed);

  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--startup-timeout-ms", "60000",
      "--host-mode", "pause-after-project-registration",
      "--idempotency-key", "partial-project-host-loss-runtime-start",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const launch = JSON.parse(stdout);
    const browser = await launchBrowser({ niceAdjustment: 10 });
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
        timeout: 90_000,
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
      assert.ok(acceptedRequest);

      const runtimeState = await readJson(join(dataDir, "runtime-state.json"));
      pausedHostPid = await findLocalHostPid(runtimeState.pid);
      await waitForStoppedProcess(pausedHostPid);
      const duplicateRequestStarted = page.waitForRequest((request) =>
        request.method() === "POST" && request.url().endsWith("/projects/open"));
      const duplicateProjectResponse = page.evaluate(async (parameters) => {
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
      }, acceptedRequest);
      await duplicateRequestStarted;
      process.kill(pausedHostPid, "SIGKILL");
      pausedHostPid = null;

      const [failedResponse, duplicateFailure] = await Promise.all([
        projectResponse,
        duplicateProjectResponse,
      ]);
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
      assert.equal(duplicateFailure.status, failure.status);
      assert.equal(duplicateFailure.body.code, failure.body.code);
      assert.equal(duplicateFailure.body.idempotentReplay, true);
      assert.equal(duplicateFailure.body.auditId, failure.body.auditId);
      assert.equal(duplicateFailure.body.project.projectId, acceptedProject.projectId);
      assert.equal(
        duplicateFailure.body.mutations.projectRegistration.auditId,
        acceptedRegistrationAudit.auditId,
      );
      assert.deepEqual(failure.body.prohibitedSideEffects, {
        projectRegistrationCreated: true,
        harnessRegistrationCreated: false,
        harnessPinChanged: false,
        harnessRunLaunched: false,
        projectFileWrite: false,
        privilegedMutation: false,
      });

      await page.waitForSelector(
        `#project-readiness[data-project-id='${acceptedProject.projectId}']`,
        { timeout: 90_000 },
      );
      assert.equal(await page.locator("#project-readiness")
        .getAttribute("data-harness-launch-ready"), "false");
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
      const queuedReplayAudit = auditsAfter.find((entry) =>
        entry.action === "project.prepare"
        && entry.outcome === "observed"
        && entry.details.idempotentReplay === true
        && entry.details.originalAuditId === failure.body.auditId
        && entry.details.projectId === acceptedProject.projectId);
      assert.ok(queuedReplayAudit);
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
            queuedReplay: duplicateFailure,
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
              replay: queuedReplayAudit,
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

  await enableInstalledHostModeCli(installed);

  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch",
      "--data-dir", dataDir,
      "--startup-timeout-ms", "60000",
      "--host-mode", "malformed-frame-after-negotiation",
      "--idempotency-key", "active-host-protocol-runtime-start",
      "--expected-revision", "0",
      "--json",
      "--no-open",
    ], { cwd: executionDirectory, env: productEnvironment });
    const launch = JSON.parse(stdout);
    const browser = await launchBrowser({ niceAdjustment: 10 });
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
        { timeout: 90_000 },
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
        { timeout: 90_000 },
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
