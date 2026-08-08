import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

const supervisorPath = fileURLToPath(import.meta.url);
const containmentPreloadPath = fileURLToPath(
  new URL("./darwin-process-containment.cjs", import.meta.url),
);
const lsappinfoPath = "/usr/bin/lsappinfo";

/** @typedef {{code: number | null, signal: string | null, startFailed: boolean}} AdapterExitResult */
/** @typedef {{sent: boolean, sentAt: string | null}} SignalResult */

/** @param {string} value */
const escapeXml = (value) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

/** @param {string} value */
const quoteShellArgument = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** @param {string} path */
const connect = (path) => new Promise((resolve, reject) => {
  const socket = createConnection(path);
  socket.once("connect", () => resolve(socket));
  socket.once("error", reject);
});

/** @param {NodeJS.ProcessEnv} env */
const darwinContainedEnvironment = (env) => {
  const preloadOption = `--require=${JSON.stringify(containmentPreloadPath)}`;
  const existingNodeOptions = typeof env.NODE_OPTIONS === "string"
    ? env.NODE_OPTIONS.trim()
    : "";
  return {
    ...env,
    NODE_OPTIONS: existingNodeOptions
      ? `${existingNodeOptions} ${preloadOption}`
      : preloadOption,
  };
};

/**
 * The application coalition is the Darwin force-containment boundary. The
 * adapter leads its own cooperative process group, while the wrapper stays
 * outside that group to retain the coalition control identity.
 *
 * @param {{cwd: string, env: NodeJS.ProcessEnv, stdio: import("node:child_process").StdioOptions}} options
 */
export const darwinAdapterSpawnOptions = (options) => ({
  cwd: options.cwd,
  env: options.env,
  detached: true,
  stdio: options.stdio,
});

const runDarwinSupervisor = async () => {
  const configurationPath = process.argv[3];
  if (!configurationPath) process.exit(1);
  let configuration;
  try {
    configuration = JSON.parse(readFileSync(configurationPath, "utf8"));
  } catch {
    process.exit(1);
  }
  const [stdoutSocket, stderrSocket, adapterSocket, controlSocket] = await Promise.all([
    connect(configuration.channels.stdout),
    connect(configuration.channels.stderr),
    connect(configuration.channels.adapter),
    connect(configuration.channels.control),
  ]).catch(() => []);
  if (!stdoutSocket || !stderrSocket || !adapterSocket || !controlSocket) process.exit(1);

  /** @param {Record<string, unknown>} message */
  const report = (message) => {
    try {
      controlSocket.write(`${JSON.stringify(message)}\n`);
    } catch {
      // The Host disappeared. The control-close path asks LaunchServices to
      // terminate the still-identifiable application coalition.
    }
  };
  let adapterExited = false;
  const terminateCoalition = () => {
    try {
      const termination = spawn(lsappinfoPath, [
        "kill",
        "-coalition",
        "-launchdjobs",
        "-hard",
        configuration.applicationSpecifier,
      ], { stdio: "ignore" });
      termination.unref();
    } catch {
      // Host restart reconciliation retains uncertainty if launchservicesd is unavailable.
    }
  };
  let adapter;
  try {
    adapter = spawn(configuration.executable, configuration.args,
      darwinAdapterSpawnOptions({
        cwd: configuration.cwd,
        env: configuration.env,
        stdio: ["ignore", stdoutSocket, stderrSocket, adapterSocket],
      }));
  } catch {
    report({ type: "darwin-process-tree.adapter-error" });
    process.exit(1);
  }
  stdoutSocket.destroy();
  stderrSocket.destroy();
  adapterSocket.destroy();
  report({
    type: "darwin-process-tree.adapter-spawned",
    wrapperPid: process.pid,
    adapterPid: adapter.pid ?? null,
  });

  let controlBuffer = "";
  // The wrapper stays outside the adapter-led cooperative group so it can
  // retain the non-reused application identity through coalition escalation.
  process.on("SIGTERM", () => undefined);
  controlSocket.setEncoding("utf8");
  controlSocket.on("data", (/** @type {string} */ chunk) => {
    controlBuffer += chunk;
    while (controlBuffer.includes("\n")) {
      const newline = controlBuffer.indexOf("\n");
      const line = controlBuffer.slice(0, newline);
      controlBuffer = controlBuffer.slice(newline + 1);
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        request?.type !== "darwin-process-tree.signal"
        || !Number.isSafeInteger(request.requestId)
        || !["SIGTERM", "SIGKILL"].includes(request.signal)
        || typeof adapter.pid !== "number"
      ) {
        continue;
      }
      let sent = false;
      try {
        process.kill(-adapter.pid, request.signal);
        sent = true;
      } catch {
        // The process group may already have exited cooperatively.
      }
      report({
        type: "darwin-process-tree.signal-result",
        requestId: request.requestId,
        sent,
        sentAt: sent ? new Date().toISOString() : null,
      });
    }
  });
  controlSocket.once("close", () => {
    if (!adapterExited) terminateCoalition();
    process.exit(0);
  });
  adapter.once("error", () => report({ type: "darwin-process-tree.adapter-error" }));
  adapter.once("exit", (code, signal) => {
    adapterExited = true;
    controlSocket.end(`${JSON.stringify({
      type: "darwin-process-tree.adapter-exit",
      code,
      signal,
    })}\n`);
  });
};

/** @param {string} path @param {PassThrough} output */
const createOutputServer = (path, output) => {
  const server = createServer((socket) => {
    server.close();
    socket.pipe(output);
  });
  server.listen(path);
  return server;
};

/**
 * Launch one Harness adapter in a LaunchServices application coalition. The
 * adapter leads the ordinary cooperative process group, while the wrapper
 * retains the immutable application identity. Every native descendant remains
 * in that coalition across fork, exec, posix_spawn, setsid, and parent exit.
 * Coalition termination is the Darwin force boundary and removal of its
 * LaunchServices record is the complete-tree confirmation boundary.
 *
 * @param {string} executable
 * @param {string[]} args
 * @param {{cwd: string, env: NodeJS.ProcessEnv}} options
 * @returns {{child: import("node:child_process").ChildProcess, adapterChannel: PassThrough, adapterExit: Promise<AdapterExitResult>, adapterExited: () => boolean, captureDescendants: () => Promise<boolean>, prepareCancellation: () => Promise<boolean>, processTreeAlive: () => Promise<boolean>, signal: (signal: "SIGTERM" | "SIGKILL") => Promise<SignalResult>, release: () => Promise<void>}}
 */
export const spawnDarwinProcessTree = (executable, args, options) => {
  if (typeof process.getuid !== "function") {
    throw new Error("darwin_process_tree_user_unavailable");
  }
  const directory = mkdtempSync(join(tmpdir(), "sandking-darwin-tree-"));
  chmodSync(directory, 0o700);
  const applicationSpecifier = `dev.sandking.harness.${randomBytes(16).toString("hex")}`;
  const applicationPath = join(directory, "SandKingHarness.app");
  const applicationContentsPath = join(applicationPath, "Contents");
  const applicationExecutablesPath = join(applicationContentsPath, "MacOS");
  const applicationExecutableName = "sandking-darwin-supervisor";
  mkdirSync(applicationExecutablesPath, { recursive: true, mode: 0o700 });
  const applicationExecutablePath = join(
    applicationExecutablesPath,
    applicationExecutableName,
  );
  writeFileSync(applicationExecutablePath, `#!/bin/sh
exec ${quoteShellArgument(process.execPath)} ${quoteShellArgument(supervisorPath)} darwin-supervise ${quoteShellArgument(join(directory, "configuration.json"))}
`, { mode: 0o700 });
  writeFileSync(join(applicationContentsPath, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${escapeXml(applicationSpecifier)}</string>
<key>CFBundleExecutable</key><string>${applicationExecutableName}</string>
<key>CFBundleName</key><string>Sand-King Harness supervision</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>
`, { mode: 0o600 });
  const channels = {
    stdout: join(directory, "stdout.sock"),
    stderr: join(directory, "stderr.sock"),
    adapter: join(directory, "adapter.sock"),
    control: join(directory, "control.sock"),
  };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const adapterChannel = new PassThrough();
  const outputServers = [
    createOutputServer(channels.stdout, stdout),
    createOutputServer(channels.stderr, stderr),
    createOutputServer(channels.adapter, adapterChannel),
  ];
  const controlServer = createServer();
  controlServer.listen(channels.control);

  const configurationPath = join(directory, "configuration.json");
  writeFileSync(configurationPath, `${JSON.stringify({
    executable,
    args,
    cwd: options.cwd,
    env: darwinContainedEnvironment(options.env),
    channels,
    applicationSpecifier,
  })}\n`, { mode: 0o600 });

  const child = /** @type {any} */ (new EventEmitter());
  child.pid = undefined;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdio = [null, stdout, stderr, adapterChannel];
  child.exitCode = null;
  child.signalCode = null;
  child.connected = true;

  let adapterSpawned = false;
  /** @type {number | null} */
  let wrapperPid = null;
  /** @type {number | null} */
  let adapterPid = null;
  /** @type {AdapterExitResult | null} */
  let adapterExitResult = null;
  /** @type {(result: AdapterExitResult) => void} */
  let resolveAdapterExit = () => {};
  const adapterExit = new Promise((resolve) => { resolveAdapterExit = resolve; });
  /** @type {import("node:net").Socket | null} */
  let controlSocket = null;
  let controlBuffer = "";
  let nextSignalRequestId = 1;
  /** @type {Map<number, (result: SignalResult) => void>} */
  const pendingSignals = new Map();
  let containmentAvailable = false;
  let coalitionIdentityEstablished = false;
  let containmentRemoved = false;
  let released = false;
  /** @type {Promise<string | false> | null} */
  let removalOperation = null;
  /** @type {Promise<void> | null} */
  let releaseOperation = null;

  /** @param {AdapterExitResult} result */
  const settleAdapterExit = (result) => {
    if (adapterExitResult) return;
    adapterExitResult = result;
    resolveAdapterExit(result);
  };
  const failLaunch = () => {
    containmentAvailable = false;
    settleAdapterExit({ code: null, signal: null, startFailed: true });
  };
  controlServer.once("connection", (socket) => {
    controlServer.close();
    controlSocket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (/** @type {string} */ chunk) => {
      controlBuffer += chunk;
      while (controlBuffer.includes("\n")) {
        const newline = controlBuffer.indexOf("\n");
        const line = controlBuffer.slice(0, newline);
        controlBuffer = controlBuffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          containmentAvailable = false;
          continue;
        }
        if (message.type === "darwin-process-tree.adapter-spawned") {
          adapterSpawned = true;
          containmentAvailable = true;
          wrapperPid = Number.isSafeInteger(message.wrapperPid) && message.wrapperPid > 0
            ? message.wrapperPid
            : null;
          child.pid = wrapperPid ?? undefined;
          if (!Number.isSafeInteger(message.adapterPid) || message.adapterPid <= 0) {
            failLaunch();
          } else {
            adapterPid = message.adapterPid;
          }
          continue;
        }
        if (message.type === "darwin-process-tree.adapter-error") {
          failLaunch();
          continue;
        }
        if (message.type === "darwin-process-tree.adapter-exit") {
          settleAdapterExit({
            code: typeof message.code === "number" ? message.code : null,
            signal: typeof message.signal === "string" ? message.signal : null,
            startFailed: false,
          });
          continue;
        }
        if (message.type === "darwin-process-tree.signal-result") {
          const pending = pendingSignals.get(message.requestId);
          if (!pending) continue;
          pendingSignals.delete(message.requestId);
          pending({
            sent: message.sent === true,
            sentAt: typeof message.sentAt === "string" ? message.sentAt : null,
          });
        }
      }
    });
    socket.once("close", () => {
      child.connected = false;
      child.exitCode = containmentRemoved ? null : 1;
      child.signalCode = containmentRemoved ? "SIGKILL" : null;
      child.emit("exit", child.exitCode, child.signalCode);
      child.emit("close", child.exitCode, child.signalCode);
      if (!adapterExitResult) {
        settleAdapterExit({
          code: null,
          signal: containmentRemoved ? "SIGKILL" : null,
          startFailed: !adapterSpawned,
        });
      }
      for (const settle of pendingSignals.values()) {
        settle({ sent: false, sentAt: null });
      }
      pendingSignals.clear();
    });
  });
  controlServer.once("error", failLaunch);

  execFile(lsappinfoPath, [
    "launch",
    "nofront=true",
    "async=true",
    applicationPath,
  ], {
    timeout: 10_000,
    windowsHide: true,
  }, (error) => {
    if (error && !adapterSpawned) {
      failLaunch();
      return;
    }
    containmentAvailable = true;
  });

  /**
   * LaunchServices preserves an exited application record while its coalition
   * still contains processes. The random bundle identifier is a stable,
   * non-reused control identity, so this query neither samples nor signals a
   * numeric PID.
   *
   * @returns {Promise<boolean | null>}
   */
  const coalitionHasProcesses = () => new Promise((resolve) => {
    execFile(lsappinfoPath, [
      "find",
      "--includeExitedApplications",
      `bundleid=${applicationSpecifier}`,
    ], {
      timeout: 5_000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(/ASN:0x[0-9a-f]+[-:]0x[0-9a-f]+:/i.test(stdout));
    });
  });

  const establishCoalitionIdentity = async () => {
    if (coalitionIdentityEstablished) return true;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const containsProcesses = await coalitionHasProcesses();
      if (containsProcesses === true) {
        coalitionIdentityEstablished = true;
        return true;
      }
      if (adapterExitResult && containsProcesses === false) return false;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    containmentAvailable = false;
    return false;
  };

  const supervisedTreeAlive = async () => {
    if (!adapterSpawned && !adapterExitResult) return true;
    if (!coalitionIdentityEstablished) return true;
    return await coalitionHasProcesses() !== false;
  };
  const waitForSupervisedTreeExit = async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (!(await supervisedTreeAlive())) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  };
  const removeContainment = () => {
    if (containmentRemoved) {
      return Promise.resolve(false);
    }
    if (removalOperation) return removalOperation;
    removalOperation = new Promise((resolve) => {
      const sentAt = new Date().toISOString();
      execFile(lsappinfoPath, [
        "kill",
        "-coalition",
        "-launchdjobs",
        "-hard",
        applicationSpecifier,
      ], {
        timeout: 10_000,
        windowsHide: true,
      }, async (error) => {
        const exited = await waitForSupervisedTreeExit();
        if (!exited) {
          containmentAvailable = false;
          resolve(error ? false : sentAt);
          return;
        }
        containmentRemoved = true;
        containmentAvailable = false;
        resolve(error ? false : sentAt);
      });
    });
    void removalOperation.then(() => {
      if (!containmentRemoved) removalOperation = null;
    }, () => {
      containmentAvailable = false;
      removalOperation = null;
    });
    return removalOperation;
  };
  /** @param {"SIGTERM" | "SIGKILL"} signalName */
  const signal = (signalName) => {
    if (signalName === "SIGKILL") {
      return removeContainment().then((sentAt) => ({
        sent: sentAt !== false && sentAt !== null,
        sentAt: typeof sentAt === "string" ? sentAt : null,
      }));
    }
    if (!controlSocket || !containmentAvailable || containmentRemoved) {
      return Promise.resolve({ sent: false, sentAt: null });
    }
    const activeControlSocket = controlSocket;
    const requestId = nextSignalRequestId;
    nextSignalRequestId += 1;
    return new Promise((resolve) => {
      pendingSignals.set(requestId, resolve);
      activeControlSocket.write(`${JSON.stringify({
        type: "darwin-process-tree.signal",
        requestId,
        signal: signalName,
      })}\n`, (/** @type {Error | null | undefined} */ error) => {
        if (!error) return;
        const settle = pendingSignals.get(requestId);
        pendingSignals.delete(requestId);
        settle?.({ sent: false, sentAt: null });
      });
    });
  };
  const release = () => {
    if (releaseOperation) return releaseOperation;
    releaseOperation = (async () => {
      if (!containmentRemoved) await removeContainment();
      released = true;
      controlSocket?.destroy();
      for (const server of [...outputServers, controlServer]) {
        try { server.close(); } catch { /* already closed */ }
      }
      stdout.end();
      stderr.end();
      adapterChannel.end();
      rmSync(directory, { recursive: true, force: true });
    })();
    return releaseOperation;
  };

  return {
    child: /** @type {import("node:child_process").ChildProcess} */ (child),
    adapterChannel,
    adapterExit,
    adapterExited: () => adapterExitResult !== null,
    captureDescendants: async () => containmentAvailable
      && !containmentRemoved
      && await establishCoalitionIdentity(),
    prepareCancellation: async () => containmentAvailable
      && !containmentRemoved
      && await establishCoalitionIdentity(),
    processTreeAlive: async () => !released && await supervisedTreeAlive(),
    signal,
    release,
  };
};

if (process.platform === "darwin"
  && process.argv[1] === supervisorPath
  && process.argv[2] === "darwin-supervise") {
  await runDarwinSupervisor();
}
