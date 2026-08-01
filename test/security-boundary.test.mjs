import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import net from "node:net";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "src", "cli.mjs");

const runCli = async (args, options = {}) => {
  const result = await execFileAsync("node", [cliPath, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...options.env },
  });
  return JSON.parse(result.stdout);
};

const request = async ({ method = "GET", url, headers = {} }) => {
  const response = await fetch(url, {
    method,
    redirect: "manual",
    headers,
  });
  return response;
};

const openWebSocketHandshake = async ({ port, cookie, origin, host }) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";

    socket.on("connect", () => {
      socket.write(
        [
          "GET /ws HTTP/1.1",
          `Host: ${host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Origin: ${origin}`,
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          `Cookie: ${cookie}`,
          "",
          "",
        ].join("\r\n"),
      );
    });

    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (response.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(response);
      }
    });
    socket.on("error", reject);
  });

const openHttpRequest = async ({ port, cookie, host }) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.on("connect", () => {
      socket.write([
        "GET / HTTP/1.1",
        `Host: ${host}`,
        `Cookie: ${cookie}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });

test("bootstrap URLs exchange once into a session and same-origin WebSockets require exact headers", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-security-"));

  try {
    const launch = await runCli(["launch", "--data-dir", dataDir, "--json", "--no-open"]);
    const bootstrap = await request({ url: launch.bootstrapUrl });
    const setCookie = bootstrap.headers.get("set-cookie");
    const cookie = setCookie?.split(";")[0];

    assert.equal(bootstrap.status, 302);
    assert.match(setCookie, /sandking_session=/);
    assert.match(
      bootstrap.headers.get("content-security-policy"),
      /default-src 'self'/,
    );
    assert.equal(bootstrap.headers.get("access-control-allow-origin"), null);

    const cockpit = await request({
      url: `http://127.0.0.1:${launch.runtime.port}/`,
      headers: { cookie },
    });
    assert.equal(cockpit.status, 200);
    const cockpitHtml = await cockpit.text();
    assert.match(cockpit.headers.get("content-security-policy"), /script-src 'self'/);
    assert.match(cockpitHtml, /<script type="module" src="\/cockpit\.js"><\/script>/);
    assert.doesNotMatch(cockpitHtml, /<script type="module">/);
    assert.match(cockpitHtml, /Connecting to local Host/);
    assert.match(cockpitHtml, /id="reload-cockpit"/);

    const cockpitScript = await request({
      url: `http://127.0.0.1:${launch.runtime.port}/cockpit.js`,
      headers: { cookie },
    });
    assert.equal(cockpitScript.status, 200);
    assert.match(cockpitScript.headers.get("content-type"), /text\/javascript/);
    assert.match(await cockpitScript.text(), /new WebSocket/);

    const csrfRejected = await request({
      method: "POST",
      url: `http://127.0.0.1:${launch.runtime.port}/session/end`,
      headers: { cookie },
    });
    assert.equal(csrfRejected.status, 403);
    assert.deepEqual(await csrfRejected.json(), { code: "csrf_rejected" });
    assert.equal(csrfRejected.headers.get("access-control-allow-origin"), null);

    const hostRejected = await openHttpRequest({
      port: launch.runtime.port,
      cookie,
      host: `localhost:${launch.runtime.port}`,
    });
    assert.match(hostRejected, /403 Forbidden/);
    assert.match(hostRejected, /host_mismatch/);

    const replay = await request({ url: launch.bootstrapUrl });
    assert.equal(replay.status, 302);
    assert.equal(replay.headers.get("set-cookie")?.split(";")[0], cookie);

    const staleBootstrap = new URL(launch.bootstrapUrl);
    staleBootstrap.searchParams.set("expectedRevision", "1");
    const staleResponse = await request({ url: staleBootstrap.href });
    assert.equal(staleResponse.status, 409);
    assert.deepEqual(await staleResponse.json(), {
      type: "mutation_failure",
      code: "mutation_revision_conflict",
      retryable: true,
      expectedRevision: 1,
      actualRevision: 1,
    });

    const rejected = await openWebSocketHandshake({
      port: launch.runtime.port,
      cookie,
      origin: "http://malicious.example",
      host: `127.0.0.1:${launch.runtime.port}`,
    });
    assert.match(rejected, /403 Forbidden/);

    const accepted = await openWebSocketHandshake({
      port: launch.runtime.port,
      cookie,
      origin: `http://127.0.0.1:${launch.runtime.port}`,
      host: `127.0.0.1:${launch.runtime.port}`,
    });
    assert.match(accepted, /101 Switching Protocols/);
  } finally {
    await runCli(["stop", "--data-dir", dataDir, "--json"]);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("bootstrap-token redemption is atomic and the plaintext token is never retained", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-token-race-"));

  try {
    const launch = await runCli(["launch", "--data-dir", dataDir, "--json", "--no-open"]);
    const plaintextToken = new URL(launch.bootstrapUrl).searchParams.get("token");
    assert.ok(plaintextToken);

    const responses = await Promise.all([
      request({ url: launch.bootstrapUrl }),
      request({ url: launch.bootstrapUrl }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [302, 302]);
    assert.equal(
      responses[0].headers.get("set-cookie")?.split(";")[0],
      responses[1].headers.get("set-cookie")?.split(";")[0],
    );

    const invalidTokenUrl = new URL(launch.bootstrapUrl);
    invalidTokenUrl.searchParams.set("token", "0".repeat(64));
    assert.equal((await request({ url: invalidTokenUrl.href })).status, 410);

    const tokenFiles = await readdir(join(dataDir, "bootstrap-tokens"));
    assert.deepEqual(tokenFiles, [], "redemption and invalid probes must not retain claims");
    const persistedState = [
      await readFile(join(dataDir, "runtime-state.json"), "utf8"),
      await readFile(join(dataDir, "audit.jsonl"), "utf8"),
    ].join("\n");
    assert.doesNotMatch(persistedState, new RegExp(plaintextToken));
    const idempotencyKey = new URL(launch.bootstrapUrl).searchParams.get("idempotencyKey");
    assert.ok(idempotencyKey);
    assert.doesNotMatch(persistedState, new RegExp(idempotencyKey));
  } finally {
    await runCli(["stop", "--data-dir", dataDir, "--json"]).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("expired bootstrap tokens return a typed retryable outcome without creating a session", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-token-expiry-"));

  try {
    const launch = await runCli([
      "launch",
      "--data-dir",
      dataDir,
      "--bootstrap-ttl-ms",
      "25",
      "--json",
      "--no-open",
    ]);
    assert.equal(launch.bootstrap.ttlMs, 25);
    await new Promise((resolve) => setTimeout(resolve, 75));

    const expired = await request({ url: launch.bootstrapUrl });
    assert.equal(expired.status, 410);
    assert.deepEqual(await expired.json(), {
      type: "mutation_failure",
      code: "bootstrap_token_expired",
      retryable: true,
      expectedRevision: 0,
      actualRevision: 0,
    });

    const redeemedLaunch = await runCli([
      "launch",
      "--data-dir",
      dataDir,
      "--bootstrap-ttl-ms",
      "50",
      "--json",
      "--no-open",
    ]);
    assert.equal((await request({ url: redeemedLaunch.bootstrapUrl })).status, 302);
    await new Promise((resolve) => setTimeout(resolve, 75));
    const expiredReplay = await request({ url: redeemedLaunch.bootstrapUrl });
    assert.equal(expiredReplay.status, 410);
    assert.deepEqual(await expiredReplay.json(), {
      type: "mutation_failure",
      code: "bootstrap_token_expired",
      retryable: true,
      expectedRevision: 0,
      actualRevision: 1,
    });

    const audits = (await readFile(join(dataDir, "audit.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const rejection = audits.find((entry) =>
      entry.action === "browser.session.create"
      && entry.details.code === "bootstrap_token_expired");
    assert.ok(rejection);
    assert.deepEqual({
      authorizationClass: rejection.details.authorizationClass,
      expectedRevision: rejection.details.expectedRevision,
      actualRevision: rejection.details.actualRevision,
    }, {
      authorizationClass: "bootstrap_token",
      expectedRevision: 0,
      actualRevision: 0,
    });
    assert.match(rejection.details.idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
  } finally {
    await runCli(["stop", "--data-dir", dataDir, "--json"]).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});
