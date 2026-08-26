import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";

export const WINDOWS_DOCKER_NAMED_PIPE = "\\\\.\\pipe\\docker_engine";
const DOCKER_SOCKET_PATH = "/var/run/docker.sock";
const DOCKER_RELAY_HEADER = "X-Sandking-Docker-Capability";
const DOCKER_CONFIG_CONTAINER_PATH = "/run/sandking-docker-config";
const MAXIMUM_HTTP_HEADER_BYTES = 64 * 1024;
const MAXIMUM_CONTAINER_CREATE_BYTES = 1024 * 1024;

export const MAIN_CONTAINER_PATHS = Object.freeze({
  execution: "/workspace/harness",
  project: "/workspace/project",
  codexAuth: "/run/secrets/codex-auth.json",
  githubCredential: "/run/secrets/github-token",
});

export const createMainContainerPathMappings = ({
  executionPath,
  projectPath,
  authPath,
  githubCredentialPath,
}) => [
  { containerPath: MAIN_CONTAINER_PATHS.project, hostPath: projectPath },
  { containerPath: MAIN_CONTAINER_PATHS.execution, hostPath: executionPath },
  { containerPath: MAIN_CONTAINER_PATHS.codexAuth, hostPath: authPath },
  {
    containerPath: MAIN_CONTAINER_PATHS.githubCredential,
    hostPath: githubCredentialPath,
  },
];

const translatedHostPath = (value, pathMappings) => {
  for (const { containerPath, hostPath } of pathMappings) {
    if (value !== containerPath && !value.startsWith(`${containerPath}/`)) continue;
    return `${hostPath.replaceAll("\\", "/")}${value.slice(containerPath.length)}`;
  }
  return value;
};

const translateBind = (bind, pathMappings) => {
  for (const { containerPath } of pathMappings) {
    if (bind.startsWith(`${containerPath}:`)) {
      return `${translatedHostPath(containerPath, pathMappings)}${bind.slice(containerPath.length)}`;
    }
    if (!bind.startsWith(`${containerPath}/`)) continue;
    const sourceEnd = bind.indexOf(":/", containerPath.length);
    if (sourceEnd < 0) continue;
    const source = bind.slice(0, sourceEnd);
    return `${translatedHostPath(source, pathMappings)}${bind.slice(sourceEnd)}`;
  }
  return bind;
};

const rewriteContainerCreateBody = (source, pathMappings) => {
  const request = JSON.parse(source.toString("utf8"));
  const hostConfiguration = request?.HostConfig;
  if (Array.isArray(hostConfiguration?.Binds)) {
    hostConfiguration.Binds = hostConfiguration.Binds.map((bind) =>
      typeof bind === "string" ? translateBind(bind, pathMappings) : bind);
  }
  if (Array.isArray(hostConfiguration?.Mounts)) {
    hostConfiguration.Mounts = hostConfiguration.Mounts.map((mount) =>
      mount?.Type === "bind" && typeof mount.Source === "string"
        ? { ...mount, Source: translatedHostPath(mount.Source, pathMappings) }
        : mount);
  }
  return Buffer.from(JSON.stringify(request), "utf8");
};

const relayDockerConnection = ({
  downstream,
  connectUpstream,
  upstreamEndpoint,
  pathMappings,
  capability,
  sockets,
}) => {
  const upstream = connectUpstream(upstreamEndpoint);
  sockets.add(downstream);
  sockets.add(upstream);
  let buffer = Buffer.alloc(0);
  let bodyBytesRemaining = 0;
  let raw = false;
  let authorized = capability === null;

  const discard = () => {
    sockets.delete(downstream);
    sockets.delete(upstream);
  };
  downstream.once("close", () => {
    discard();
    upstream.destroy();
  });
  upstream.once("close", () => {
    discard();
    downstream.destroy();
  });
  downstream.once("error", () => upstream.destroy());
  upstream.once("error", () => downstream.destroy());
  upstream.pipe(downstream);

  const processBuffer = () => {
    while (buffer.byteLength > 0) {
      if (raw) {
        upstream.write(buffer);
        buffer = Buffer.alloc(0);
        return;
      }
      if (bodyBytesRemaining > 0) {
        const consumed = Math.min(bodyBytesRemaining, buffer.byteLength);
        upstream.write(buffer.subarray(0, consumed));
        buffer = buffer.subarray(consumed);
        bodyBytesRemaining -= consumed;
        continue;
      }
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (buffer.byteLength > MAXIMUM_HTTP_HEADER_BYTES) downstream.destroy();
        return;
      }
      const headerLines = buffer.subarray(0, headerEnd).toString("latin1").split("\r\n");
      const requestLine = headerLines.shift() ?? "";
      const headers = headerLines.map((line) => {
        const separator = line.indexOf(":");
        return separator < 0
          ? { name: line, value: "" }
          : { name: line.slice(0, separator), value: line.slice(separator + 1).trim() };
      });
      if (!authorized) {
        authorized = headers.some(({ name, value }) =>
          name.toLowerCase() === DOCKER_RELAY_HEADER.toLowerCase()
          && value === capability);
        if (!authorized) {
          downstream.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
          upstream.destroy();
          return;
        }
      }
      const forwardedHeaders = headers.filter(({ name }) =>
        name.toLowerCase() !== DOCKER_RELAY_HEADER.toLowerCase());
      const contentLengthHeader = headers.find(({ name }) =>
        name.toLowerCase() === "content-length");
      const contentLength = contentLengthHeader
        ? Number(contentLengthHeader.value)
        : 0;
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        downstream.destroy();
        upstream.destroy();
        return;
      }
      const bodyOffset = headerEnd + 4;
      const containerCreate = /^POST\s+\S*\/containers\/create(?:[?\s])/i.test(requestLine);
      if (containerCreate) {
        if (contentLength > MAXIMUM_CONTAINER_CREATE_BYTES) {
          downstream.destroy();
          upstream.destroy();
          return;
        }
        if (buffer.byteLength < bodyOffset + contentLength) return;
        let body;
        try {
          body = rewriteContainerCreateBody(
            buffer.subarray(bodyOffset, bodyOffset + contentLength),
            pathMappings,
          );
        } catch {
          downstream.destroy();
          upstream.destroy();
          return;
        }
        const rewrittenHeaders = forwardedHeaders
          .filter(({ name }) => name.toLowerCase() !== "content-length")
          .map(({ name, value }) => `${name}: ${value}`);
        rewrittenHeaders.push(`Content-Length: ${body.byteLength}`);
        upstream.write(`${requestLine}\r\n${rewrittenHeaders.join("\r\n")}\r\n\r\n`);
        upstream.write(body);
        buffer = buffer.subarray(bodyOffset + contentLength);
        continue;
      }
      upstream.write(`${requestLine}\r\n${forwardedHeaders
        .map(({ name, value }) => `${name}: ${value}`).join("\r\n")}\r\n\r\n`);
      buffer = buffer.subarray(bodyOffset);
      bodyBytesRemaining = contentLength;
      raw = headers.some(({ name, value }) =>
        name.toLowerCase() === "upgrade"
        || (name.toLowerCase() === "transfer-encoding" && /chunked/i.test(value)));
    }
  };
  downstream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    processBuffer();
  });
};

const listen = (server, endpoint) => new Promise((resolve, reject) => {
  const failed = (error) => reject(error);
  server.once("error", failed);
  server.listen(endpoint, () => {
    server.removeListener("error", failed);
    resolve(undefined);
  });
});

const createRelayServer = async ({
  listenEndpoint,
  upstreamEndpoint,
  pathMappings,
  capability = null,
  serverFactory = createServer,
  connectUpstream = createConnection,
}) => {
  const sockets = new Set();
  const server = serverFactory((downstream) => relayDockerConnection({
    downstream,
    connectUpstream,
    upstreamEndpoint,
    pathMappings,
    capability,
    sockets,
  }));
  await listen(server, listenEndpoint);
  let closed = false;
  return {
    server,
    closeServer: async () => {
      if (closed) return;
      closed = true;
      await new Promise((resolve) => {
        server.close(() => resolve(undefined));
        for (const socket of sockets) socket.destroy();
      });
    },
  };
};

export const createPosixDockerSocketRelay = async (
  dockerSocketPath,
  options = {},
) => {
  const directory = await mkdtemp(join(tmpdir(), "sandking-docker-relay-"));
  await chmod(directory, 0o700);
  const relaySocketPath = join(directory, "docker.sock");
  try {
    const relay = await createRelayServer({
      listenEndpoint: relaySocketPath,
      upstreamEndpoint: dockerSocketPath,
      pathMappings: options.pathMappings ?? [],
      serverFactory: options.createSocketServer,
      connectUpstream: options.connectDockerSocket,
    });
    return {
      environment: { DOCKER_HOST: `unix://${DOCKER_SOCKET_PATH}` },
      mountArguments: [`${relaySocketPath}:${DOCKER_SOCKET_PATH}:rw`],
      close: async () => {
        await relay.closeServer();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
};

/**
 * Docker Desktop exposes its Engine through a Windows named pipe, while the
 * pinned Worker image contains a Linux Docker client. The per-delegation TCP
 * endpoint requires an unguessable Docker-config header and rewrites outer
 * Linux bind paths into the daemon's Host namespace.
 */
export const createWindowsDockerPipeRelay = async (
  namedPipePath,
  options = {},
) => {
  const capability = randomBytes(32).toString("hex");
  const configurationDirectory = await mkdtemp(join(tmpdir(), "sandking-docker-config-"));
  await chmod(configurationDirectory, 0o700);
  await writeFile(join(configurationDirectory, "config.json"), `${JSON.stringify({
    HttpHeaders: { [DOCKER_RELAY_HEADER]: capability },
  })}\n`, { mode: 0o600 });
  try {
    const relay = await createRelayServer({
      listenEndpoint: { host: "127.0.0.1", port: 0 },
      upstreamEndpoint: namedPipePath,
      pathMappings: options.pathMappings ?? [],
      capability,
      serverFactory: options.createTcpServer,
      connectUpstream: options.connectNamedPipe,
    });
    const address = relay.server.address();
    if (!address || typeof address === "string") {
      await relay.closeServer();
      throw new Error("docker_named_pipe_relay_invalid");
    }
    return {
      port: address.port,
      dockerConfigDirectory: configurationDirectory,
      environment: {
        DOCKER_HOST: `tcp://host.docker.internal:${address.port}`,
        DOCKER_CONFIG: DOCKER_CONFIG_CONTAINER_PATH,
      },
      mountArguments: [
        `${configurationDirectory}:${DOCKER_CONFIG_CONTAINER_PATH}:ro`,
      ],
      close: async () => {
        await relay.closeServer();
        await rm(configurationDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(configurationDirectory, { recursive: true, force: true });
    throw error;
  }
};

const createDockerCliConnection = (dockerEndpoint, options = {}) => {
  const environment = { ...process.env, DOCKER_HOST: dockerEndpoint };
  delete environment.DOCKER_CONTEXT;
  const child = (options.spawnDockerCli ?? spawn)("docker", [
    "system", "dial-stdio",
  ], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.stdin || !child.stdout) {
    child.kill?.("SIGKILL");
    throw new Error("docker_endpoint_relay_invalid");
  }
  child.stderr?.resume();
  const connection = Duplex.from({
    readable: child.stdout,
    writable: child.stdin,
  });
  child.once("error", (error) => connection.destroy(error));
  child.once("close", (code) => {
    if (code !== 0 && !connection.destroyed) {
      connection.destroy(new Error("docker_endpoint_relay_closed"));
    }
  });
  connection.once("close", () => {
    if (child.exitCode === null && child.signalCode === null) child.kill?.("SIGTERM");
  });
  return connection;
};

const dockerNamedPipePath = (endpoint) => {
  const pathname = decodeURIComponent(new URL(endpoint).pathname);
  const pipeName = pathname.replace(/^\/{2}(?:\.\/)?pipe\//, "");
  if (!pipeName || pipeName.includes("\0")) {
    throw new Error("docker_endpoint_invalid");
  }
  return `\\\\.\\pipe\\${pipeName.replaceAll("/", "\\")}`;
};

/**
 * Relay the exact endpoint that passed Host readiness into the Linux outer
 * container. Local sockets and named pipes connect directly; remote context
 * transports use Docker's own endpoint dialer while retaining the same
 * capability and bind-rewrite boundaries.
 */
export const createDockerEndpointRelay = async (
  dockerEndpoint,
  options = {},
) => {
  const parsed = new URL(dockerEndpoint);
  const pathMappings = options.pathMappings ?? [];
  if (parsed.protocol === "unix:") {
    return createPosixDockerSocketRelay(decodeURIComponent(parsed.pathname), {
      pathMappings,
      createSocketServer: options.createSocketServer,
      connectDockerSocket: options.connectDockerSocket,
    });
  }
  if (parsed.protocol === "npipe:" && options.platform === "win32") {
    return createWindowsDockerPipeRelay(dockerNamedPipePath(dockerEndpoint), {
      pathMappings,
      createTcpServer: options.createTcpServer,
      connectNamedPipe: options.connectNamedPipe,
    });
  }
  const connectDockerEndpoint = options.connectDockerEndpoint
    ?? ((endpoint) => createDockerCliConnection(endpoint, options));
  if (options.platform === "win32") {
    return createWindowsDockerPipeRelay(dockerEndpoint, {
      pathMappings,
      createTcpServer: options.createTcpServer,
      connectNamedPipe: connectDockerEndpoint,
    });
  }
  return createPosixDockerSocketRelay(dockerEndpoint, {
    pathMappings,
    createSocketServer: options.createSocketServer,
    connectDockerSocket: connectDockerEndpoint,
  });
};

/**
 * Builds Linux-container paths and Docker arguments without retaining this
 * platform-neutral configuration in the size-bounded Worker source.
 */
export const createMainContainerConfiguration = ({
  executionPath,
  projectPath,
  authPath,
  githubCredentialPath,
  sandboxImage,
  dockerRelay,
}) => {
  const environment = {
    HOME: "/home/agent",
    LANG: "C.UTF-8",
    SANDCASTLE_CODEX_AUTH_PATH: MAIN_CONTAINER_PATHS.codexAuth,
    SANDKING_GITHUB_CREDENTIAL_PATH: MAIN_CONTAINER_PATHS.githubCredential,
    SANDKING_REAL_DELEGATION_CONTAINER: "1",
    SANDKING_REAL_DELEGATION_PROTOCOL: "1",
    SANDKING_REAL_DELEGATION_PROTOCOL_FD: "1",
    SANDKING_REAL_DELEGATION_SANDBOX_IMAGE: sandboxImage,
    ...dockerRelay.environment,
  };
  return {
    environmentArguments: Object.entries(environment).flatMap(
      ([name, value]) => ["--env", `${name}=${value}`],
    ),
    mountArguments: [
      `${projectPath}:${MAIN_CONTAINER_PATHS.project}:rw`,
      `${executionPath}:${MAIN_CONTAINER_PATHS.execution}:ro`,
      `${authPath}:${MAIN_CONTAINER_PATHS.codexAuth}:ro`,
      `${githubCredentialPath}:${MAIN_CONTAINER_PATHS.githubCredential}:ro`,
      ...dockerRelay.mountArguments,
    ].flatMap((mount) => ["--volume", mount]),
  };
};
