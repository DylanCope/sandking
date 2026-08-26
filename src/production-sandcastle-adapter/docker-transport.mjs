import { createConnection, createServer } from "node:net";

export const WINDOWS_DOCKER_NAMED_PIPE = "\\\\.\\pipe\\docker_engine";

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
