import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { launchCli } from "./test-helpers.mts";

test("launching Sand-King serves a loopback Cockpit and an isolated local Controller runtime", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "sandking-runtime-"));
  const cli = await launchCli({ runtimeRoot });
  t.after(async () => {
    await cli.stop();
  });

  const cockpit = await fetch(cli.cockpitUrl);
  assert.equal(cockpit.status, 200);
  const html = await cockpit.text();
  assert.match(html, /Sand-King Cockpit/);
  assert.match(html, new RegExp(`content="${cli.sessionToken}"`));

  const unauthorized = await fetch(`${cli.cockpitUrl}api/runtime`);
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), {
    error: "controller_session_required",
    message: "Provide the local Controller session token from the Cockpit.",
  });

  const runtime = await fetch(`${cli.cockpitUrl}api/runtime`, {
    headers: {
      authorization: `Bearer ${cli.sessionToken}`,
    },
  });
  assert.equal(runtime.status, 200);

  const snapshot = await runtime.json();
  assert.equal(snapshot.runtime.listenAddress, "127.0.0.1");
  assert.equal(snapshot.runtime.loopbackOnly, true);
  assert.equal(snapshot.runtime.revision, 0);
  assert.equal(snapshot.controller.sessions.length, 0);
  assert.equal(snapshot.runtime.root, runtimeRoot);
  assert.deepEqual(snapshot.audit.map((entry: { type: string }) => entry.type), [
    "runtime_launched",
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-token-forbidden/);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(cli.sessionToken));

  const start = await fetch(`${cli.cockpitUrl}api/controller-sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cli.sessionToken}`,
      "content-type": "application/json",
      "idempotency-key": "start-1",
      "if-match": "0",
    },
    body: JSON.stringify({
      projectRegistration: "local-sandbox",
      provider: "claude-code",
    }),
  });
  assert.equal(start.status, 201);
  const started = await start.json();
  assert.equal(started.idempotentReplay, false);
  assert.equal(started.controllerSession.projectRegistration, "local-sandbox");
  assert.equal(started.controllerSession.provider, "claude-code");
  assert.equal(started.controllerSession.runtime, "local");
  assert.equal(started.revision, 1);

  const replay = await fetch(`${cli.cockpitUrl}api/controller-sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cli.sessionToken}`,
      "content-type": "application/json",
      "idempotency-key": "start-1",
      "if-match": "0",
    },
    body: JSON.stringify({
      projectRegistration: "local-sandbox",
      provider: "claude-code",
    }),
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), {
    ...started,
    idempotentReplay: true,
  });

  const staleRevision = await fetch(`${cli.cockpitUrl}api/controller-sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cli.sessionToken}`,
      "content-type": "application/json",
      "idempotency-key": "start-2",
      "if-match": "0",
    },
    body: JSON.stringify({
      projectRegistration: "local-sandbox",
      provider: "claude-code",
    }),
  });
  assert.equal(staleRevision.status, 409);
  assert.deepEqual(await staleRevision.json(), {
    error: "revision_conflict",
    message: "Refresh the runtime snapshot and retry with the current revision.",
    revision: 1,
  });

  const runtimeFiles = await readdir(runtimeRoot);
  assert.deepEqual(runtimeFiles.sort(), ["audit.log", "runtime-state.json"]);
});

test("the Controller runtime recovers durable state after a restart without leaking prior session secrets", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "sandking-runtime-recovery-"));
  const first = await launchCli({ runtimeRoot });
  t.after(async () => {
    await first.stop().catch(() => {});
  });

  await fetch(`${first.cockpitUrl}api/controller-sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${first.sessionToken}`,
      "content-type": "application/json",
      "idempotency-key": "resume-1",
      "if-match": "0",
    },
    body: JSON.stringify({
      projectRegistration: "project-26",
      provider: "claude-code",
    }),
  });

  await first.stop();

  const second = await launchCli({ runtimeRoot });
  t.after(async () => {
    await second.stop();
  });

  const staleSecret = await fetch(`${second.cockpitUrl}api/runtime`, {
    headers: {
      authorization: `Bearer ${first.sessionToken}`,
    },
  });
  assert.equal(staleSecret.status, 401);

  const recovered = await fetch(`${second.cockpitUrl}api/runtime`, {
    headers: {
      authorization: `Bearer ${second.sessionToken}`,
    },
  });
  assert.equal(recovered.status, 200);
  const snapshot = await recovered.json();

  assert.equal(snapshot.runtime.revision, 1);
  assert.equal(snapshot.controller.sessions.length, 1);
  assert.equal(snapshot.controller.sessions[0].projectRegistration, "project-26");
  assert.equal(snapshot.controller.sessions[0].provider, "claude-code");
  assert.deepEqual(snapshot.audit.map((entry: { type: string }) => entry.type), [
    "runtime_launched",
    "controller_session_started",
    "runtime_recovered",
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(first.sessionToken));
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(second.sessionToken));
});
