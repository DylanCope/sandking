import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createWindowsDockerPipeRelay,
  MAIN_CONTAINER_PATHS,
} from "../src/production-sandcastle-adapter/docker-transport.mjs";

const request = (port, source) => new Promise((resolve, reject) => {
  const socket = createConnection({ host: "127.0.0.1", port });
  const chunks = [];
  socket.once("error", reject);
  socket.on("data", (chunk) => {
    chunks.push(chunk);
    const response = Buffer.concat(chunks);
    const headerEnd = response.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = response.subarray(0, headerEnd).toString("utf8");
    const length = Number(/\r\nContent-Length:\s*(\d+)/i.exec(`\r\n${header}`)?.[1] ?? 0);
    if (response.byteLength < headerEnd + 4 + length) return;
    resolve(response.subarray(0, headerEnd + 4 + length).toString("utf8"));
    socket.destroy();
  });
  socket.once("connect", () => socket.write(source));
});

test("the Windows Docker relay authenticates its caller and rewrites Host bind sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-docker-pipe-relay-"));
  const pipePath = process.platform === "win32"
    ? `\\\\.\\pipe\\sandking-docker-relay-${randomUUID()}`
    : join(root, "docker-engine.sock");
  const upstreamRequests = [];
  const pipeServer = createServer((socket) => {
    const chunks = [];
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const source = Buffer.concat(chunks);
      const headerEnd = source.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = source.subarray(0, headerEnd).toString("utf8");
      const length = Number(/\r\nContent-Length:\s*(\d+)/i.exec(`\r\n${header}`)?.[1] ?? 0);
      if (source.byteLength < headerEnd + 4 + length) return;
      upstreamRequests.push({
        header,
        body: JSON.parse(source.subarray(headerEnd + 4, headerEnd + 4 + length)),
      });
      const response = '{"Id":"controlled-container"}';
      socket.end(
        `HTTP/1.1 201 Created\r\nContent-Length: ${Buffer.byteLength(response)}\r\nConnection: close\r\n\r\n${response}`,
      );
    });
  });
  let relay;
  try {
    pipeServer.listen(pipePath);
    await once(pipeServer, "listening");
    relay = await createWindowsDockerPipeRelay(pipePath, {
      pathMappings: [
        { containerPath: MAIN_CONTAINER_PATHS.project, hostPath: "C:\\Projects\\sandking" },
        { containerPath: MAIN_CONTAINER_PATHS.codexAuth, hostPath: "C:\\Secrets\\auth.json" },
      ],
    });

    const unauthorized = await request(
      relay.port,
      "GET /_ping HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n",
    );
    assert.match(unauthorized, /^HTTP\/1\.1 403 Forbidden/);
    assert.equal(upstreamRequests.length, 0);

    const dockerConfiguration = JSON.parse(await readFile(
      join(relay.dockerConfigDirectory, "config.json"),
      "utf8",
    ));
    const [[headerName, capability]] = Object.entries(dockerConfiguration.HttpHeaders);
    const body = JSON.stringify({
      HostConfig: {
        Binds: [
          `${MAIN_CONTAINER_PATHS.project}/.sandcastle-worktrees/issue-262:/home/agent/workspace:rw`,
          `${MAIN_CONTAINER_PATHS.codexAuth}:/home/agent/.codex/auth.json:ro`,
        ],
      },
    });
    const authorized = await request(relay.port, [
      "POST /v1.47/containers/create?name=worker HTTP/1.1",
      "Host: docker",
      `${headerName}: ${capability}`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n"));
    assert.match(authorized, /^HTTP\/1\.1 201 Created/);
    assert.equal(upstreamRequests.length, 1);
    assert.doesNotMatch(upstreamRequests[0].header, /Sandking-Docker-Capability/i);
    assert.deepEqual(upstreamRequests[0].body.HostConfig.Binds, [
      "C:/Projects/sandking/.sandcastle-worktrees/issue-262:/home/agent/workspace:rw",
      "C:/Secrets/auth.json:/home/agent/.codex/auth.json:ro",
    ]);
  } finally {
    await relay?.close();
    await new Promise((resolve) => pipeServer.close(() => resolve(undefined)));
    await rm(root, { recursive: true, force: true });
  }
});
