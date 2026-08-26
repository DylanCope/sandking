import { createConnection, createServer } from "node:net";

export const WINDOWS_DOCKER_NAMED_PIPE = "\\\\.\\pipe\\docker_engine";
export const MAIN_CONTAINER_PATHS = Object.freeze({
  execution: "/workspace/harness",
  project: "/workspace/project",
  codexAuth: "/run/secrets/codex-auth.json",
  githubCredential: "/run/secrets/github-token",
});

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
  dockerSocketPath = null,
  dockerRelayPort = null,
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
    ...(dockerRelayPort === null ? {} : {
      DOCKER_HOST: `tcp://host.docker.internal:${dockerRelayPort}`,
    }),
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
      ...(dockerSocketPath ? [`${dockerSocketPath}:${dockerSocketPath}:rw`] : []),
    ].flatMap((mount) => ["--volume", mount]),
  };
};

/**
 * Docker Desktop exposes its Engine through a Windows named pipe, while the
 * pinned Worker image contains a Linux Docker client. Bridge that byte stream
 * only for the lifetime of the outer delegation container.
 *
 * @param {string} namedPipePath
 * @param {{
 *   createTcpServer?: typeof createServer,
 *   connectNamedPipe?: typeof createConnection,
 * }} [options]
 */
export const createWindowsDockerPipeRelay = async (
  namedPipePath,
  options = {},
) => {
  const connectNamedPipe = options.connectNamedPipe ?? createConnection;
  const sockets = new Set();
  const server = (options.createTcpServer ?? createServer)((downstream) => {
    const upstream = connectNamedPipe(namedPipePath);
    sockets.add(downstream);
    sockets.add(upstream);
    const discard = () => {
      sockets.delete(downstream);
      sockets.delete(upstream);
    };
    downstream.once("close", discard);
    upstream.once("close", discard);
    downstream.once("error", () => upstream.destroy());
    upstream.once("error", () => downstream.destroy());
    downstream.pipe(upstream).pipe(downstream);
  });
  await new Promise((resolve, reject) => {
    const failed = (error) => reject(error);
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", failed);
      resolve(undefined);
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("docker_named_pipe_relay_invalid");
  }
  let closed = false;
  return {
    port: address.port,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise((resolve) => {
        server.close(() => resolve(undefined));
        for (const socket of sockets) socket.destroy();
      });
    },
  };
};
