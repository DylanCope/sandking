import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { launchBrowser } from "./browser-launch.mjs";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "src", "cli.mjs");

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
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-browser-"));
  const protectedFixture = join(dataDir, "prohibited-side-effect.fixture");
  const controllerSecret = "browser-visible-secret-must-never-appear";
  await writeFile(protectedFixture, "unchanged\n");
  let hostileOrigin;

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath, "launch", "--data-dir", dataDir, "--json", "--no-open",
    ], {
      cwd: tmpdir(),
      env: { ...process.env, SANDKING_CONTROLLER_SECRET: controllerSecret },
    });
    const launch = JSON.parse(stdout);
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
      assert.deepEqual(await capabilityMismatchPage.evaluate(() => ({
        reloadRequired: document.documentElement.dataset.reloadRequired,
        protocolError: document.documentElement.dataset.protocolError,
        text: document.querySelector("#app")?.textContent,
      })), {
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

      const hostilePage = await browser.newPage();
      await hostilePage.goto(hostileOrigin.url, { waitUntil: "domcontentloaded" });
      await hostilePage.waitForFunction(() =>
        document.querySelector("#cors")?.textContent === "blocked"
        && document.querySelector("#websocket")?.textContent === "blocked");
      assert.equal(await hostilePage.textContent("#cors"), "blocked");
      assert.equal(await hostilePage.textContent("#websocket"), "blocked");

      const hostMismatch = await page.goto(`http://localhost:${launch.runtime.port}/`);
      assert.equal(hostMismatch?.status(), 403);

      assert.equal(await readFile(protectedFixture, "utf8"), "unchanged\n");
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
          })),
          securityAssertions: {
            exactHostRejected: true,
            hostileOriginRejected: true,
            corsAbsent: true,
            csrfRejected: true,
            sanitizedBrowserModel: true,
            controllerSecretAbsent: true,
            bootstrapCredentialAbsent: true,
          },
          prohibitedSideEffectAssertions: {
            remoteListenerCreated: false,
            controllerCredentialForwarded: false,
            protectedFixtureMutated: false,
            sudoUsed: false,
            systemPackageInstalled: false,
            shellProfileMutated: false,
            serviceConfigured: false,
          },
          sanitizedDiagnostics: [
            "browser_protocol_major_mismatch",
            "csrf_rejected",
            "origin_mismatch",
            "host_mismatch"
          ],
        }, null, 2)}\n`, { mode: 0o600 });
      }
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise((resolve) => hostileOrigin?.server.close(resolve) ?? resolve(undefined));
    await execFileAsync(process.execPath, [cliPath, "stop", "--data-dir", dataDir, "--json"], {
      cwd: tmpdir(),
      env: process.env,
    }).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});
