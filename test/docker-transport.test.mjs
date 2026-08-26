import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWindowsDockerPipeRelay } from
  "../src/production-sandcastle-adapter/docker-transport.mjs";

test("the Docker named-pipe relay forwards bytes and closes with the delegation", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-docker-pipe-relay-"));
  const pipePath = process.platform === "win32"
    ? `\\\\.\\pipe\\sandking-docker-relay-${randomUUID()}`
    : join(root, "docker-engine.sock");
  const pipeServer = createServer((socket) => socket.pipe(socket));
  let relay;
  let client;
  try {
    pipeServer.listen(pipePath);
    await once(pipeServer, "listening");
    relay = await createWindowsDockerPipeRelay(pipePath);
    client = createConnection({ host: "127.0.0.1", port: relay.port });
    await once(client, "connect");
    client.write("docker-engine-frame");
    const [frame] = await once(client, "data");

    assert.equal(frame.toString("utf8"), "docker-engine-frame");
    await relay.close();
    relay = null;
    await once(client, "close");
  } finally {
    client?.destroy();
    await relay?.close();
    await new Promise((resolve) => pipeServer.close(() => resolve(undefined)));
    await rm(root, { recursive: true, force: true });
  }
});
