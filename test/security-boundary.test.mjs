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
    assert.equal(replay.status, 410);

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
    assert.deepEqual(responses.map((response) => response.status).sort(), [302, 410]);

    const tokenFiles = await readdir(join(dataDir, "bootstrap-tokens"));
    const retained = await Promise.all(tokenFiles.map(async (file) =>
      readFile(join(dataDir, "bootstrap-tokens", file), "utf8")));
    const persistedState = [
      await readFile(join(dataDir, "runtime-state.json"), "utf8"),
      await readFile(join(dataDir, "audit.jsonl"), "utf8"),
      ...retained,
    ].join("\n");
    assert.doesNotMatch(persistedState, new RegExp(plaintextToken));
  } finally {
    await runCli(["stop", "--data-dir", dataDir, "--json"]).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});
