import { spawn } from "node:child_process";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  HOST_SCHEMA_DIGEST,
  MAX_BULK_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  hostCapabilities,
  protocolVersion,
  readFrame,
  releaseVersion,
  writeFrame,
} from "../src/protocol.mjs";

const configureInstalledProjectPat = (installed, registration) => new Promise(
  (resolve, reject) => {
    const child = spawn(installed.command, [
      "github-credentials",
      "set-project-pat",
      registration.project.project.projectId,
      "--data-dir",
      registration.dataDir,
      "--json",
    ], {
      cwd: registration.projectPath,
      env: process.env,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let diagnostic = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      diagnostic += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(new Error(
        `installed_github_credential_configuration_failed:${code ?? signal ?? "unknown"}`
        + `:${diagnostic}`,
      ));
    });
    child.stdin.end("github_pat_installed_production_fixture_262\n");
  },
);

export const startInstalledProductionHost = async ({
  endpoint,
  installed,
  nodePath,
  preloadPath,
  registration,
}) => {
  // Issue-driven installed launches establish their GitHub precondition through
  // the same person-facing Host action used outside this behavioral fixture.
  await configureInstalledProjectPat(installed, registration);
  const controllerId = `runtime-${"8".repeat(24)}`;
  const hostIdentity = JSON.parse(await readFile(
    join(registration.dataDir, "host-identity.json"),
    "utf8",
  ));
  const localHostPath = join(installed.packageDirectory, "src", "local-host.mjs");
  const child = spawn(nodePath, [
    ...(preloadPath ? ["--import", pathToFileURL(preloadPath).href] : []),
    localHostPath,
    "--data-dir",
    registration.dataDir,
  ], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let diagnostic = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    diagnostic += chunk;
  });
  writeFrame(child.stdin, {
    type: "hello",
    protocol: protocolVersion,
    release: releaseVersion,
    identity: "controller-runtime",
    controllerId,
    expectedPeerIdentity: "local-host",
    expectedHostId: hostIdentity.hostId,
    capabilities: { required: [...hostCapabilities], optional: [] },
    schemaDigest: HOST_SCHEMA_DIGEST,
    framing: {
      maxFrameBytes: MAX_FRAME_BYTES,
      maxBulkChunkBytes: MAX_BULK_CHUNK_BYTES,
    },
    observationCursor: null,
  });
  let handshakeTimer;
  const handshake = await Promise.race([
    readFrame(child.stdout),
    new Promise((_, reject) => {
      handshakeTimer = setTimeout(() => reject(new Error(
        `installed_readiness_host_timeout: ${diagnostic}`,
      )), 10_000);
    }),
  ]).finally(() => clearTimeout(handshakeTimer));
  if (
    handshake.type !== "hello-ack"
    || handshake.identity !== "local-host"
    || handshake.hostId !== hostIdentity.hostId
    || handshake.peerControllerId !== controllerId
  ) {
    child.kill("SIGKILL");
    throw new Error(`installed_readiness_host_handshake_failed: ${diagnostic}`);
  }

  let hostOperationQueue = Promise.resolve();
  const requestHostOperation = (message) => {
    const operation = hostOperationQueue.then(async () => {
      writeFrame(child.stdin, message);
      return readFrame(child.stdout);
    });
    hostOperationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const projectId = registration.project.project.projectId;
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      void (async () => {
        const request = JSON.parse(input.slice(0, input.indexOf("\n")));
        const outcome = request.operation === "describe"
          ? {
              type: "controller.cli.description",
              protocol: "1.0.0",
              command: "sandking launch",
              focusedProjectId: projectId,
              projectArgumentOptional: true,
              pluginRequired: false,
              launchParameters: registration.harness.harness.launchParameters,
            }
          : await requestHostOperation({
              type: "harness.run.launch",
              requestId: request.requestId,
              projectId,
              parameters: request.parameters ?? {},
              controllerId,
              controllerSessionId: request.controllerSessionId,
              source: "controller-cli",
              authorizationClass: "harness_run_launch",
              idempotencyKeyHash: request.idempotencyKeyHash,
            });
        const succeeded = outcome.type === "controller.cli.description"
          || outcome.type === "harness.run.launch.result";
        socket.end(`${JSON.stringify({
          type: "sandking.cli.result",
          protocol: "1.0.0",
          requestId: request.requestId,
          ok: succeeded,
          ...(succeeded ? { outcome } : { failure: { code: outcome.code } }),
        })}\n`);
      })().catch(() => socket.destroy());
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  const closeServer = () => new Promise((resolve, reject) => server.close((error) => {
    if (error) reject(error);
    else resolve(undefined);
  }));
  const terminate = async (signal) => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("close", resolve));
      child.kill(signal);
      await exited;
    }
    await closeServer();
  };
  return {
    diagnostic: () => diagnostic,
    pid: child.pid,
    kill: () => terminate("SIGKILL"),
    stop: () => terminate("SIGTERM"),
  };
};

export const waitForPathState = async (path, exists) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await access(path).then(() => true, () => false);
    if (current === exists) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`production_provider_race_timeout:${path}:${exists}`);
};

export const installedProductionLaunchArguments = (projectId) => [
  "launch", projectId,
  "--issue", "256",
  "--target-branch", "sandcastle/issue-256",
  "--json",
];

export const installedProductionLaunchEnvironment = ({
  endpoint,
  projectId,
  retryDirectory,
  userHome,
}) => ({
  ...process.env,
  HOME: userHome,
  SANDKING_CONTROLLER_ENDPOINT: endpoint,
  SANDKING_CONTROLLER_SESSION_ID: `controller-session-${"5".repeat(24)}`,
  SANDKING_CONTROLLER_RETRY_DIRECTORY: retryDirectory,
  SANDKING_WORK_CONTEXT_ID: projectId,
});

export const listProjectPreparationDebris = async (projectPath) => {
  const [projectEntries, gitInfoEntries] = await Promise.all([
    readdir(projectPath),
    readdir(join(projectPath, ".git", "info")),
  ]);
  return [
    ...projectEntries.map((name) => `Project/${name}`),
    ...gitInfoEntries.map((name) => `.git/info/${name}`),
  ].filter((name) => name.includes(".sandking-") || name.includes("sandking-capture-"));
};

export const writeProviderMutationPause = async ({
  excludePath,
  mode,
  root,
  manifestPath,
}) => {
  const armPath = join(root, "arm-provider-mutation");
  const blockedPath = join(root, "provider-mutation-blocked");
  const claimedPath = join(root, "claimed-provider-mutation");
  const releasePath = join(root, "release-provider-mutation");
  const capturedPath = join(root, "provider-mutation-captured");
  const capturedReleasePath = join(root, "release-captured-provider-mutation");
  const reconciliationBlockedPath = join(root, "provider-reconciliation-blocked");
  const reconciliationReleasePath = join(root, "release-provider-reconciliation");
  const preloadPath = join(root, "pause-provider-mutation.mjs");
  await writeFile(preloadPath, `
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const manifestPath = ${JSON.stringify(manifestPath)};
const excludePath = ${JSON.stringify(excludePath)};
const selectorCapturePrefix = ${JSON.stringify(excludePath
    ? join(dirname(excludePath), ".sandking-capture-")
    : "")};
const mode = ${JSON.stringify(mode)};
const originalAccess = fsPromises.access.bind(fsPromises);
const originalLink = fsPromises.link.bind(fsPromises);
const originalOpen = fsPromises.open.bind(fsPromises);
const originalReadFile = fsPromises.readFile.bind(fsPromises);
const originalRename = fsPromises.rename.bind(fsPromises);
const originalRm = fsPromises.rm.bind(fsPromises);
const originalWriteFile = fsPromises.writeFile.bind(fsPromises);
const pause = async () => {
  try {
    await originalRename(${JSON.stringify(armPath)}, ${JSON.stringify(claimedPath)});
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await originalWriteFile(${JSON.stringify(blockedPath)}, "blocked\\n");
  while (await originalAccess(${JSON.stringify(releasePath)}).then(
    () => false,
    () => true,
  )) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
let excludeCaptureCount = 0;
let manifestRollbackCaptureFailed = false;
let reconciliationPaused = false;
const pauseReconciliation = async () => {
  if (reconciliationPaused) return;
  reconciliationPaused = true;
  await originalWriteFile(
    ${JSON.stringify(reconciliationBlockedPath)},
    "blocked\\n",
  );
  while (await originalAccess(${JSON.stringify(reconciliationReleasePath)}).then(
    () => false,
    () => true,
  )) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
fsPromises.link = async (from, to, ...rest) => {
  if (mode === "creation" && String(to) === manifestPath) await pause();
  if (
    [
      "exclude-after-capture",
      "exclude-open-descriptor-rollback-crash",
      "exclude-reconciliation-rebase",
    ].includes(mode)
    && String(to) === excludePath
  ) await pause();
  if (mode === "exclude-cleanup-after-capture" && String(to) === excludePath) {
    const candidate = await originalReadFile(from, "utf8").catch(() => "");
    if (!candidate.includes("# Sand-King temporary production provider")) await pause();
  }
  return originalLink(from, to, ...rest);
};
fsPromises.open = async (path, flags, ...rest) => {
  const handle = await originalOpen(path, flags, ...rest);
  const selectorCaptureRead = mode === "selector-open-descriptor"
    && String(path).startsWith(${JSON.stringify(
      excludePath ? `${dirname(excludePath)}/.sandking-capture-` : "",
    )})
    && String(path).endsWith("/captured")
    && flags === "r"
    && !reconciliationPaused;
  if (
    selectorCaptureRead
    || (
      mode === "exclude-reconciliation-rebase"
      && String(path) === excludePath
      && ["a", "a+"].includes(flags)
      && !reconciliationPaused
    )
  ) {
    const originalHandleReadFile = handle.readFile.bind(handle);
    handle.readFile = async (...readArguments) => {
      const source = await originalHandleReadFile(...readArguments);
      await pauseReconciliation();
      return source;
    };
  }
  return handle;
};
fsPromises.rename = async (from, to, ...rest) => {
  let pauseForExcludeCommit = false;
  if (String(from) === excludePath) {
    excludeCaptureCount += 1;
    pauseForExcludeCommit = (mode === "exclude-append" && excludeCaptureCount === 1)
      || (mode === "exclude-cleanup" && excludeCaptureCount === 2);
  } else if (String(to) === excludePath) {
    const candidate = await originalReadFile(from, "utf8").catch(() => "");
    const appending = candidate.includes("# Sand-King temporary production provider");
    pauseForExcludeCommit = (mode === "exclude-append" && appending)
      || (mode === "exclude-cleanup" && !appending);
  }
  if (pauseForExcludeCommit) await pause();
  if (
    mode === "rollback-retry"
    && String(from).startsWith(\`${manifestPath}.sandking-\`)
    && String(from).endsWith(".tmp")
  ) await pause();
  if (
    (mode === "creation" && String(to) === manifestPath)
    || (
      (mode === "cleanup" || mode === "capture-crash")
      && String(from) === manifestPath
      && await originalAccess(manifestPath).then(() => true, () => false)
    )
    || (
      [
        "selector-open-descriptor",
        "selector-long-lived-descriptor",
        "selector-post-refresh-descriptor",
        "selector-release-guard-crash",
      ].includes(mode)
      && String(from) === manifestPath
    )
  ) await pause();
  if (
    mode === "rollback-retry"
    && String(from) === manifestPath
    && !manifestRollbackCaptureFailed
  ) {
    manifestRollbackCaptureFailed = true;
    const error = new Error("transient provider rollback denial");
    error.code = "EACCES";
    throw error;
  }
  const result = await originalRename(from, to, ...rest);
  if (mode === "selector-long-lived-descriptor" && String(from) === manifestPath) {
    await originalWriteFile(${JSON.stringify(capturedPath)}, "captured\\n");
  }
  if (mode === "capture-crash" && String(from) === manifestPath) {
    await originalWriteFile(${JSON.stringify(capturedPath)}, "captured\\n");
    while (await originalAccess(${JSON.stringify(capturedReleasePath)}).then(
      () => false,
      () => true,
    )) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (
    mode === "exclude-open-descriptor-rollback-crash"
    && String(from) === excludePath
    && String(to).includes(".sandking-capture-rollback-")
  ) {
    await originalWriteFile(${JSON.stringify(capturedPath)}, "captured\\n");
    while (await originalAccess(${JSON.stringify(capturedReleasePath)}).then(
      () => false,
      () => true,
    )) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return result;
};
fsPromises.rm = async (path, ...rest) => {
  if (mode === "cleanup" && String(path) === manifestPath) await pause();
  if (
    mode === "exclude-post-refresh-descriptor"
    && String(path).startsWith(\`\${excludePath}.sandking-capture-replace-\`)
    && String(path).endsWith("/captured")
  ) await pause();
  if (
    mode === "selector-post-refresh-descriptor"
    && String(path).startsWith(selectorCapturePrefix)
    && String(path).endsWith("/captured")
  ) await pauseReconciliation();
  const result = await originalRm(path, ...rest);
  if (
    mode === "selector-release-directory-crash"
    && String(path).startsWith(selectorCapturePrefix)
    && String(path).endsWith(".released/release")
  ) {
    await originalWriteFile(${JSON.stringify(capturedPath)}, "captured\\n");
    while (await originalAccess(${JSON.stringify(capturedReleasePath)}).then(
      () => false,
      () => true,
    )) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (
    mode === "selector-release-guard-crash"
    && String(path).startsWith(selectorCapturePrefix)
    && String(path).endsWith("/captured")
  ) {
    await originalWriteFile(${JSON.stringify(capturedPath)}, "captured\\n");
    while (await originalAccess(${JSON.stringify(capturedReleasePath)}).then(
      () => false,
      () => true,
    )) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return result;
};
syncBuiltinESMExports();
`);
  return {
    armPath,
    blockedPath,
    capturedPath,
    capturedReleasePath,
    preloadPath,
    reconciliationBlockedPath,
    reconciliationReleasePath,
    releasePath,
  };
};
