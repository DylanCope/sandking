import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
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
const launchctlPath = "/bin/launchctl";
const psPath = "/bin/ps";

/** @typedef {{code: number | null, signal: string | null, startFailed: boolean}} AdapterExitResult */
/** @typedef {{sent: boolean, sentAt: string | null}} SignalResult */

/** @param {string} value */
const escapeXml = (value) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

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
 * The launchd job's process group is the Darwin containment boundary. The
 * adapter must inherit that group; creating a detached session here would put
 * the entire Harness tree outside the group which bootout terminates.
 *
 * @param {{cwd: string, env: NodeJS.ProcessEnv, stdio: import("node:child_process").StdioOptions}} options
 */
export const darwinAdapterSpawnOptions = (options) => ({
  cwd: options.cwd,
  env: options.env,
  detached: false,
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
      // The Host disappeared. launchd retains ownership of this job and kills
      // the remaining descendants when its controlling process exits.
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
  // The wrapper is the live launchd process-group leader. It survives the
  // cooperative group signal so it can retain that non-reusable identity
  // through either clean tree exit or launchd escalation.
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
        process.kill(-process.pid, request.signal);
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
  controlSocket.once("close", () => process.exit(0));
  adapter.once("error", () => report({ type: "darwin-process-tree.adapter-error" }));
  adapter.once("exit", (code, signal) => report({
    type: "darwin-process-tree.adapter-exit",
    code,
    signal,
  }));
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
 * Launch one Harness adapter in a launchd-owned process group. The wrapper is
 * the retained group leader, and the adapter deliberately inherits its group.
 * Removing the job is the Darwin force boundary; job removal plus direct
 * confirmation that neither the group nor adapter remains is the termination
 * boundary.
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
  const label = `dev.sandking.harness.${randomBytes(16).toString("hex")}`;
  const domain = `user/${process.getuid()}`;
  const serviceTarget = `${domain}/${label}`;
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
  })}\n`, { mode: 0o600 });
  const plistPath = join(directory, "job.plist");
  writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${escapeXml(label)}</string>
<key>ProgramArguments</key><array>
<string>${escapeXml(process.execPath)}</string>
<string>${escapeXml(supervisorPath)}</string>
<string>darwin-supervise</string>
<string>${escapeXml(configurationPath)}</string>
</array>
<key>RunAtLoad</key><true/>
<key>AbandonProcessGroup</key><false/>
<key>ProcessType</key><string>Background</string>
</dict></plist>
`, { mode: 0o600 });

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
  let containmentRemoved = false;
  let released = false;
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

  execFile(launchctlPath, ["bootstrap", domain, plistPath], {
    timeout: 10_000,
    windowsHide: true,
  }, (error) => {
    if (error) {
      failLaunch();
      return;
    }
    containmentAvailable = true;
  });

  const jobExists = () => new Promise((resolve) => {
    execFile(launchctlPath, ["print", serviceTarget], {
      timeout: 5_000,
      windowsHide: true,
    }, (error) => resolve(error === null));
  });

  /** @returns {Promise<Array<{pid: number, processGroupId: number, state: string}> | null>} */
  const readProcessGroups = () => new Promise((resolve) => {
    execFile(psPath, ["-axo", "pid=,pgid=,stat="], {
      timeout: 5_000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const processes = [];
      for (const line of stdout.split("\n")) {
        if (line.trim() === "") continue;
        const match = /^\s*([0-9]+)\s+([0-9]+)\s+(\S+)\s*$/.exec(line);
        if (!match) {
          resolve(null);
          return;
        }
        processes.push({
          pid: Number(match[1]),
          processGroupId: Number(match[2]),
          state: match[3],
        });
      }
      resolve(processes);
    });
  });
  /** @param {number} processId */
  const processExists = (processId) => {
    try {
      process.kill(processId, 0);
      return true;
    } catch (error) {
      return !(error && typeof error === "object" && "code" in error
        && error.code === "ESRCH");
    }
  };
  const supervisedTreeAlive = async () => {
    if (wrapperPid === null || adapterPid === null) return true;
    const processes = await readProcessGroups();
    if (!processes) return true;
    const groupMemberAlive = processes.some((processEntry) =>
      processEntry.pid !== wrapperPid
      && processEntry.processGroupId === wrapperPid
      && !["X", "Z"].includes(processEntry.state[0]));
    // Adapter PID reuse can only cause a safe false-positive here. An ESRCH
    // observation cannot hide the original adapter, while a replacement keeps
    // cancellation unconfirmed and is never signalled by numeric PID.
    return groupMemberAlive || processExists(adapterPid);
  };
  const waitForSupervisedTreeExit = async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (!(await supervisedTreeAlive())) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  };
  const removeContainment = () => new Promise((resolve) => {
    if (containmentRemoved) {
      resolve(false);
      return;
    }
    const sentAt = new Date().toISOString();
    execFile(launchctlPath, ["bootout", serviceTarget], {
      timeout: 10_000,
      windowsHide: true,
    }, async (_error) => {
      const exists = await jobExists();
      if (exists) {
        containmentAvailable = false;
        resolve(false);
        return;
      }
      containmentRemoved = true;
      if (!(await waitForSupervisedTreeExit())) {
        containmentAvailable = false;
      }
      // The job was present when this controller was created, is now absent,
      // so retain the dispatch time even if subsequent tree confirmation stays
      // uncertain. processTreeAlive remains the separate terminal-state gate.
      resolve(sentAt);
    });
  });
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
    captureDescendants: async () => containmentAvailable && !containmentRemoved,
    prepareCancellation: async () => containmentAvailable && !containmentRemoved,
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
