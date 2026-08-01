import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { launchBrowser } from "./browser-launch.mjs";
import { installCurrentPackage } from "./installed-package.mjs";

const execFileAsync = promisify(execFile);

/** @param {Buffer | string} value */
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** @param {string[]} paths */
const observeFiles = async (paths) => Object.fromEntries(await Promise.all(
  paths.map(async (path) => [path.split("/").at(-1), sha256(await readFile(path))]),
));

/** @param {number} port */
const probeNonLoopbackListener = async (port) => {
  const attemptedAddresses = Object.values(networkInterfaces()).flat()
    .filter((address) => address && address.family === "IPv4" && !address.internal)
    .map((address) => address.address);
  const acceptedAddresses = [];
  for (const address of attemptedAddresses) {
    try {
      await fetch(`http://${address}:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      acceptedAddresses.push(address);
    } catch {
      // Refusal is the expected observation for a loopback-only listener.
    }
  }
  return { attemptedAddresses, acceptedAddresses };
};

const startHostileOrigin = async (targetPort) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><body>
      <div id="cors">pending</div><div id="websocket">pending</div>
      <script>
        fetch("http://127.0.0.1:${targetPort}/session/end", { method: "POST" })
          .then(() => document.querySelector("#cors").textContent = "unexpected")
          .catch(() => document.querySelector("#cors").textContent = "blocked");
        const socket = new WebSocket("ws://127.0.0.1:${targetPort}/ws");
        socket.onopen = () => document.querySelector("#websocket").textContent = "unexpected";
        socket.onerror = () => document.querySelector("#websocket").textContent = "blocked";
      </script>
    </body>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("hostile_origin_listener_failed");
  }
  return { server, url: `http://127.0.0.1:${address.port}/` };
};

test("local-walking-skeleton/completes-approved-run enters the secure Cockpit in a real browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-browser-"));
  const dataDir = join(root, "runtime-state");
  const executionDirectory = join(root, "outside-checkout");
  const userHome = join(root, "user-home");
  const instrumentedCommandsDirectory = join(root, "instrumented-commands");
  const prohibitedCommandLog = join(root, "prohibited-commands.log");
  const profileDirectory = userHome;
  const systemdDirectory = join(userHome, ".config", "systemd", "user");
  const launchAgentsDirectory = join(userHome, "Library", "LaunchAgents");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(executionDirectory, { recursive: true }),
    mkdir(userHome, { recursive: true }),
    mkdir(instrumentedCommandsDirectory, { recursive: true }),
    mkdir(systemdDirectory, { recursive: true }),
    mkdir(launchAgentsDirectory, { recursive: true }),
  ]);
  const installed = await installCurrentPackage(root);
  const instrumentedCommands = [
    "sudo", "apt", "apt-get", "dnf", "yum", "apk", "pacman", "brew",
    "systemctl", "launchctl", "service",
  ];
  await Promise.all(instrumentedCommands.map(async (command) => {
    const commandPath = join(instrumentedCommandsDirectory, command);
    await writeFile(commandPath, "#!/bin/sh\nprintf '%s\\n' \"$0\" >> \"$SANDKING_PROHIBITED_COMMAND_LOG\"\nexit 97\n");
    await chmod(commandPath, 0o700);
  }));
  const protectedConfigurationFiles = [
    join(profileDirectory, ".profile"),
    join(profileDirectory, ".bashrc"),
    join(profileDirectory, ".zshrc"),
    join(systemdDirectory, "sandking-protected.service"),
    join(launchAgentsDirectory, "dev.sandking.protected.plist"),
  ];
  await Promise.all(protectedConfigurationFiles.map((path) => writeFile(path, "protected\n")));
  const protectedConfigurationBefore = await observeFiles(protectedConfigurationFiles);
  const protectedFixture = join(dataDir, "prohibited-side-effect.fixture");
  const controllerSecret = "browser-visible-secret-must-never-appear";
  const productEnvironment = {
    ...process.env,
    HOME: userHome,
    PATH: `${instrumentedCommandsDirectory}${delimiter}${process.env.PATH ?? ""}`,
    SANDKING_PROHIBITED_COMMAND_LOG: prohibitedCommandLog,
    SANDKING_CONTROLLER_SECRET: controllerSecret,
  };
  await writeFile(protectedFixture, "unchanged\n");
  const protectedFixtureBeforeSha256 = sha256(await readFile(protectedFixture));
  let hostileOrigin;

  try {
    const { stdout } = await execFileAsync(installed.command, [
      "launch", "--data-dir", dataDir, "--host-mode", "secret-probe", "--json", "--no-open",
    ], {
      cwd: executionDirectory,
      env: productEnvironment,
    });
    const launch = JSON.parse(stdout);
    const nonLoopbackProbe = await probeNonLoopbackListener(launch.runtime.port);
    assert.deepEqual(nonLoopbackProbe.acceptedAddresses, []);
    const browser = await launchBrowser();
    const browserVersion = browser.version();
    hostileOrigin = await startHostileOrigin(launch.runtime.port);

    try {
      const browserContext = await browser.newContext();
      const page = await browserContext.newPage();
      const sentFrames = [];
      const receivedFrames = [];
      page.on("websocket", (socket) => {
        socket.on("framesent", (event) => sentFrames.push(String(event.payload)));
        socket.on("framereceived", (event) => receivedFrames.push(String(event.payload)));
      });

      const bootstrapResponse = await page.goto(launch.bootstrapUrl, {
        waitUntil: "domcontentloaded",
      });
      assert.equal(bootstrapResponse?.status(), 200);
      await page.waitForFunction(
        () => document.querySelector("#app")?.textContent?.includes("Connected to local-host"),
        { timeout: 10_000 },
      );
      assert.match(
        await page.textContent("#app"),
        /Connected to local-host with protocol 1\.0\.0/,
      );
      assert.equal(await page.getAttribute("html", "data-observation-mode"), "snapshot");

      const hello = JSON.parse(sentFrames.find((frame) => frame.includes("browser.hello")));
      assert.equal(hello.channel, "control");
      assert.equal(hello.message.identity, "cockpit");
      assert.equal(hello.message.protocol.version, "1.0.0");
      assert.deepEqual(hello.message.capabilities.required, [
        "cockpit.structured-control.v1",
        "cockpit.opaque-stream.v1",
        "cockpit.resynchronization.v1",
      ]);
      assert.deepEqual(hello.message.framing, {
        maxControlMessageBytes: 32_768,
        maxOpaqueStreamChunkBytes: 16_384,
      });
      assert.equal(hello.message.observationCursor, null);

      const acknowledgement = JSON.parse(
        receivedFrames.find((frame) => frame.includes("runtime.hello-ack")),
      );
      assert.equal(acknowledgement.channel, "control");
      assert.equal(acknowledgement.message.viewModel.kind, "cockpit.connection");
      assert.equal(acknowledgement.message.viewModel.host.identity, "local-host");
      assert.deepEqual(acknowledgement.message.viewModel.negotiation.capabilities, [
        "sandking.control.slice-1",
        "sandking.bulk-stream.v1",
      ]);

      const sessionCookie = (await browserContext.cookies()).find(
        (cookie) => cookie.name === "sandking_session",
      );
      assert.ok(sessionCookie);
      const bootstrapReplay = await fetch(launch.bootstrapUrl, { redirect: "manual" });
      assert.equal(bootstrapReplay.status, 302);
      assert.equal(
        bootstrapReplay.headers.get("set-cookie")?.split(";")[0],
        `sandking_session=${sessionCookie.value}`,
      );
      const staleBootstrapUrl = new URL(launch.bootstrapUrl);
      staleBootstrapUrl.searchParams.set("expectedRevision", "1");
      const staleBootstrap = await fetch(staleBootstrapUrl, { redirect: "manual" });
      assert.equal(staleBootstrap.status, 409);
      const staleBootstrapOutcome = await staleBootstrap.json();
      assert.equal(staleBootstrapOutcome.code, "mutation_revision_conflict");

      const { stdout: expiringLaunchOutput } = await execFileAsync(installed.command, [
        "launch", "--data-dir", dataDir, "--bootstrap-ttl-ms", "25", "--json", "--no-open",
      ], { cwd: executionDirectory, env: productEnvironment });
      const expiringLaunch = JSON.parse(expiringLaunchOutput);
      await new Promise((resolve) => setTimeout(resolve, 75));
      const expiredBootstrap = await fetch(expiringLaunch.bootstrapUrl, { redirect: "manual" });
      assert.equal(expiredBootstrap.status, 410);
      const expiredBootstrapOutcome = await expiredBootstrap.json();
      assert.equal(expiredBootstrapOutcome.code, "bootstrap_token_expired");
      const bootstrapMutationEvidence = {
        ttlMs: expiringLaunch.bootstrap.ttlMs,
        expiredStatus: expiredBootstrap.status,
        expiredCode: expiredBootstrapOutcome.code,
        replayStatus: bootstrapReplay.status,
        replayReturnedSameSession: true,
        staleStatus: staleBootstrap.status,
        staleCode: staleBootstrapOutcome.code,
      };

      const publicBoundary = `${sentFrames.join("\n")}\n${receivedFrames.join("\n")}\n${await page.content()}`;
      assert.doesNotMatch(publicBoundary, new RegExp(controllerSecret));
      assert.doesNotMatch(publicBoundary, new RegExp(new URL(launch.bootstrapUrl).searchParams.get("token")));
      assert.doesNotMatch(publicBoundary, new RegExp(dataDir));
      assert.doesNotMatch(publicBoundary, /credential|unrestricted.filesystem|process\.env/i);

      const csrfStatus = await page.evaluate(async () =>
        (await fetch("/session/end", { method: "POST" })).status);
      assert.equal(csrfStatus, 403);

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.documentElement.dataset.observationMode === "resume",
        { timeout: 10_000 },
      );

      const capabilityMismatchPage = await browserContext.newPage();
      const capabilityMismatchAcknowledgement = structuredClone(acknowledgement);
      capabilityMismatchAcknowledgement.message.negotiatedCapabilities =
        capabilityMismatchAcknowledgement.message.negotiatedCapabilities.filter(
          (capability) => capability !== "cockpit.opaque-stream.v1",
        );
      await capabilityMismatchPage.addInitScript((runtimeAcknowledgement) => {
        class RuntimeMismatchSocket extends EventTarget {
          constructor() {
            super();
            this.binaryType = "blob";
            setTimeout(() => this.dispatchEvent(new Event("open")), 0);
          }

          send() {
            setTimeout(() => this.dispatchEvent(new MessageEvent("message", {
              data: JSON.stringify(runtimeAcknowledgement),
            })), 0);
          }
        }
        Object.defineProperty(window, "WebSocket", {
          configurable: true,
          value: RuntimeMismatchSocket,
        });
      }, capabilityMismatchAcknowledgement);
      await capabilityMismatchPage.goto(`http://127.0.0.1:${launch.runtime.port}/`, {
        waitUntil: "domcontentloaded",
      });
      await capabilityMismatchPage.waitForTimeout(250);
      const runtimeHandshakeMismatch = await capabilityMismatchPage.evaluate(() => ({
        reloadRequired: document.documentElement.dataset.reloadRequired,
        protocolError: document.documentElement.dataset.protocolError,
        text: document.querySelector("#app")?.textContent,
      }));
      assert.deepEqual(runtimeHandshakeMismatch, {
        reloadRequired: "true",
        protocolError: "browser_runtime_handshake_mismatch",
        text: "Cockpit update required. Reload to reconnect safely.",
      });
      await capabilityMismatchPage.close();

      await page.route("**/cockpit.js", async (route) => {
        const response = await route.fetch();
        const mismatched = (await response.text()).replace(
          "protocol: { major: 1, minor: 0, patch: 0, version: \"1.0.0\" }",
          "protocol: { major: 2, minor: 0, patch: 0, version: \"2.0.0\" }",
        );
        await route.fulfill({ response, body: mismatched });
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.documentElement.dataset.reloadRequired === "true",
        { timeout: 10_000 },
      );
      assert.equal(await page.isVisible("#reload-cockpit"), true);
      assert.match(await page.textContent("#app"), /Cockpit update required/);
      const browserMajorMismatchCode = await page.getAttribute("html", "data-protocol-error");
      assert.equal(browserMajorMismatchCode, "browser_protocol_major_mismatch");

      const requiredCapabilityPage = await browserContext.newPage();
      await requiredCapabilityPage.route("**/cockpit.js", async (route) => {
        const response = await route.fetch();
        const mismatched = (await response.text()).replace(
          '"cockpit.resynchronization.v1",',
          '"cockpit.resynchronization.v1",\n      "cockpit.future-required",',
        );
        await route.fulfill({ response, body: mismatched });
      });
      await requiredCapabilityPage.goto(`http://127.0.0.1:${launch.runtime.port}/`, {
        waitUntil: "domcontentloaded",
      });
      await requiredCapabilityPage.waitForFunction(
        () => document.documentElement.dataset.protocolError === "browser_capability_unsupported",
        { timeout: 10_000 },
      );
      const browserCapabilityMismatchCode = await requiredCapabilityPage.getAttribute(
        "html",
        "data-protocol-error",
      );
      await requiredCapabilityPage.close();

      const opaquePage = await browserContext.newPage();
      await opaquePage.goto(`http://127.0.0.1:${launch.runtime.port}/`, {
        waitUntil: "domcontentloaded",
      });
      const browserOpaqueMismatchCode = await opaquePage.evaluate((browserHello) =>
        new Promise((resolve, reject) => {
          const socket = new WebSocket(`ws://${location.host}/ws`);
          const timeout = setTimeout(() => reject(new Error("opaque_mismatch_timeout")), 5_000);
          socket.addEventListener("open", () => socket.send(JSON.stringify(browserHello)));
          socket.addEventListener("message", (event) => {
            const message = JSON.parse(event.data).message;
            if (message.type === "runtime.hello-ack") {
              const oversized = new Uint8Array(6 + 1 + 16_385);
              oversized[0] = 1;
              oversized[4] = 1;
              oversized[6] = "x".charCodeAt(0);
              socket.send(oversized);
            } else if (message.type === "runtime.protocol-error") {
              clearTimeout(timeout);
              socket.close();
              resolve(message.code);
            }
          });
          socket.addEventListener("error", reject);
        }), hello);
      assert.equal(browserOpaqueMismatchCode, "browser_opaque_frame_invalid");
      await opaquePage.close();
      const browserMismatchEvidence = [
        { code: browserMajorMismatchCode, observedAt: "runtime_rejection" },
        { code: browserCapabilityMismatchCode, observedAt: "runtime_rejection" },
        {
          code: runtimeHandshakeMismatch.protocolError,
          observedAt: "cockpit_acknowledgement_validation",
        },
        { code: browserOpaqueMismatchCode, observedAt: "runtime_frame_rejection" },
      ];

      const hostilePage = await browser.newPage();
      await hostilePage.goto(hostileOrigin.url, { waitUntil: "domcontentloaded" });
      await hostilePage.waitForFunction(() =>
        document.querySelector("#cors")?.textContent === "blocked"
        && document.querySelector("#websocket")?.textContent === "blocked");
      assert.equal(await hostilePage.textContent("#cors"), "blocked");
      assert.equal(await hostilePage.textContent("#websocket"), "blocked");

      const hostMismatch = await page.goto(`http://localhost:${launch.runtime.port}/`);
      assert.equal(hostMismatch?.status(), 403);

      const mutationHeaders = {
        cookie: `sandking_session=${sessionCookie.value}`,
        origin: `http://127.0.0.1:${launch.runtime.port}`,
        "x-sandking-csrf": acknowledgement.message.session.csrfToken,
        "x-sandking-idempotency-key": "acceptance-session-end-key",
        "x-sandking-expected-revision": String(acknowledgement.message.session.revision),
      };
      const sessionEndUrl = `http://127.0.0.1:${launch.runtime.port}/session/end`;
      const sessionEnd = await fetch(sessionEndUrl, { method: "POST", headers: mutationHeaders });
      assert.equal(sessionEnd.status, 200);
      const sessionEndOutcome = await sessionEnd.json();
      assert.equal(sessionEndOutcome.code, "session_ended");
      assert.equal(sessionEndOutcome.idempotentReplay, false);
      const sessionEndReplay = await fetch(sessionEndUrl, {
        method: "POST",
        headers: mutationHeaders,
      });
      assert.equal(sessionEndReplay.status, 200);
      const sessionEndReplayOutcome = await sessionEndReplay.json();
      assert.equal(sessionEndReplayOutcome.auditId, sessionEndOutcome.auditId);
      assert.equal(sessionEndReplayOutcome.idempotentReplay, true);
      const staleSessionEnd = await fetch(sessionEndUrl, {
        method: "POST",
        headers: {
          ...mutationHeaders,
          "x-sandking-idempotency-key": "acceptance-stale-session-end-key",
        },
      });
      assert.equal(staleSessionEnd.status, 409);
      const staleSessionEndOutcome = await staleSessionEnd.json();
      assert.equal(staleSessionEndOutcome.code, "mutation_revision_conflict");
      const sessionMutationEvidence = {
        authorizationClass: "runtime_browser_session",
        initialRevision: acknowledgement.message.session.revision,
        resultingRevision: sessionEndOutcome.revision,
        auditId: sessionEndOutcome.auditId,
        replayStatus: sessionEndReplay.status,
        replayReturnedSameAudit: sessionEndReplayOutcome.auditId === sessionEndOutcome.auditId,
        staleStatus: staleSessionEnd.status,
        staleCode: staleSessionEndOutcome.code,
      };

      const protectedFixtureAfterSha256 = sha256(await readFile(protectedFixture));
      assert.equal(protectedFixtureAfterSha256, protectedFixtureBeforeSha256);
      const protectedConfigurationAfter = await observeFiles(protectedConfigurationFiles);
      assert.deepEqual(protectedConfigurationAfter, protectedConfigurationBefore);
      const invokedProhibitedCommands = (await readFile(prohibitedCommandLog, "utf8")
        .catch(() => ""))
        .trim().split("\n").filter(Boolean);
      assert.deepEqual(invokedProhibitedCommands, []);
      const prohibitedSideEffectObservations = {
        remoteListener: nonLoopbackProbe,
        commandInterception: {
          instrumentedCommands,
          invokedCommands: invokedProhibitedCommands,
        },
        protectedConfiguration: {
          beforeSha256: protectedConfigurationBefore,
          afterSha256: protectedConfigurationAfter,
        },
        protectedFixture: {
          beforeSha256: protectedFixtureBeforeSha256,
          afterSha256: protectedFixtureAfterSha256,
        },
        hostEnvironmentProbe: {
          injectedControllerSecret: true,
          observedHostIdentity: launch.host.identity,
          secretLeakIdentityObserved: launch.host.identity === "controller-secret-leaked",
        },
      };
      const audit = await readFile(join(dataDir, "audit.jsonl"), "utf8");
      assert.match(audit, /"action":"host.negotiate"/);
      assert.match(audit, /"action":"browser.negotiate"/);
      assert.match(audit, /"code":"csrf_rejected"/);
      assert.match(audit, /"code":"origin_mismatch"/);
      assert.doesNotMatch(audit, new RegExp(controllerSecret));

      if (process.env.SANDKING_ACCEPTANCE_OBSERVATION_PATH) {
        const auditEntries = audit.trim().split("\n").map((line) => JSON.parse(line));
        await writeFile(process.env.SANDKING_ACCEPTANCE_OBSERVATION_PATH, `${JSON.stringify({
          browserVersion,
          packagedPublicSeam: installed.observation,
          listener: launch.runtime.listener,
          runtime: {
            identity: launch.runtime.identity,
            reference: launch.runtime.runtimeId,
            browserReloadReusedRuntime: true,
          },
          host: {
            identity: launch.host.identity,
            release: launch.host.release,
            capabilities: launch.host.capabilities,
            negotiatedCapabilities: launch.host.negotiatedCapabilities,
            schemaDigest: launch.host.schemaDigest,
            framing: launch.host.framing,
            observationCursor: launch.host.observationCursor,
          },
          protocol: launch.protocol,
          browserNegotiation: {
            identity: hello.message.identity,
            runtimeIdentity: acknowledgement.message.identity,
            protocol: acknowledgement.message.protocol,
            capabilities: acknowledgement.message.negotiatedCapabilities,
            schemaDigest: acknowledgement.message.schemaDigest,
            framing: acknowledgement.message.framing,
            initialObservationMode: "snapshot",
            reloadObservationMode: "resume",
            mismatchReloadRequired: true,
            capabilityMismatchReloadRequired: true,
          },
          auditReferences: auditEntries.map((entry) => ({
            auditId: entry.auditId,
            action: entry.action,
            outcome: entry.outcome,
            details: entry.details,
          })),
          bootstrapMutationEvidence,
          sessionMutationEvidence,
          browserMismatchEvidence,
          prohibitedSideEffectObservations,
          securityAssertions: {
            exactHostRejected: hostMismatch?.status() === 403,
            hostileOriginRejected:
              (await hostilePage.textContent("#cors")) === "blocked"
              && (await hostilePage.textContent("#websocket")) === "blocked",
            corsAbsent: (await hostilePage.textContent("#cors")) === "blocked",
            csrfRejected: csrfStatus === 403,
            sanitizedBrowserModel: !/credential|unrestricted\.filesystem|process\.env/i
              .test(publicBoundary),
            controllerSecretAbsent: !publicBoundary.includes(controllerSecret),
            bootstrapCredentialAbsent: !publicBoundary.includes(
              new URL(launch.bootstrapUrl).searchParams.get("token"),
            ),
          },
          prohibitedSideEffectAssertions: {
            remoteListenerCreated: nonLoopbackProbe.acceptedAddresses.length > 0,
            controllerCredentialForwarded:
              launch.host.identity === "controller-secret-leaked",
            protectedFixtureMutated:
              protectedFixtureBeforeSha256 !== protectedFixtureAfterSha256,
            sudoUsed: invokedProhibitedCommands.some((command) => command.endsWith("/sudo")),
            systemPackageInstalled: invokedProhibitedCommands.some((command) =>
              ["apt", "apt-get", "dnf", "yum", "apk", "pacman", "brew"]
                .some((manager) => command.endsWith(`/${manager}`))),
            shellProfileMutated: [".profile", ".bashrc", ".zshrc"].some((profile) =>
              protectedConfigurationBefore[profile] !== protectedConfigurationAfter[profile]),
            serviceConfigured: ["sandking-protected.service", "dev.sandking.protected.plist"]
              .some((service) =>
                protectedConfigurationBefore[service] !== protectedConfigurationAfter[service])
              || invokedProhibitedCommands.some((command) =>
                ["systemctl", "launchctl", "service"]
                  .some((manager) => command.endsWith(`/${manager}`))),
          },
          sanitizedDiagnostics: [
            ...browserMismatchEvidence.map((result) => result.code),
            "csrf_rejected",
            "origin_mismatch",
            "host_mismatch",
            expiredBootstrapOutcome.code,
            staleSessionEndOutcome.code,
          ],
        }, null, 2)}\n`, { mode: 0o600 });
      }
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise((resolve) => hostileOrigin?.server.close(resolve) ?? resolve(undefined));
    await execFileAsync(installed.command, ["stop", "--data-dir", dataDir, "--json"], {
      cwd: executionDirectory,
      env: { ...process.env, HOME: userHome },
    }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
