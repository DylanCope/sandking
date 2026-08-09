import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

const supervisorPath = fileURLToPath(import.meta.url);
const containmentPreloadPath = fileURLToPath(
  new URL("./darwin-process-containment.cjs", import.meta.url),
);
const lsappinfoPath = "/usr/bin/lsappinfo";
const applicationSpecifierPattern = /^dev\.sandking\.harness\.[a-f0-9]{16,64}$/;

/** @typedef {{code: number | null, signal: string | null, startFailed: boolean}} AdapterExitResult */
/** @typedef {{sent: boolean, sentAt: string | null}} SignalResult */
/** @typedef {{schemaVersion: 1, platform: "darwin", applicationSpecifier: string, status: "termination_confirmed" | "termination_unconfirmed", killAccepted: boolean, coalitionAbsent: boolean, observedAt: string}} DarwinHostLossTerminationEvidence */

/**
 * The detached supervisor, not the adapter, owns the cooperative process-group
 * identity. It remains a live member until the Host releases the containment,
 * so the kernel cannot reassign this numeric group id between adapter exit and
 * a queued request. Recording adapter exit also erases the only signal target.
 *
 * @param {{
 *   groupLeaderPid: number,
 *   kill?: (processId: number, signal: NodeJS.Signals) => boolean,
 *   now?: () => Date,
 * }} options
 */
export const createDarwinSupervisorSignalController = (options) => {
  let cooperativeGroupId = Number.isSafeInteger(options.groupLeaderPid)
    && options.groupLeaderPid > 0
    ? options.groupLeaderPid
    : null;
  return {
    recordAdapterExit: () => {
      cooperativeGroupId = null;
    },
    /** @param {any} request */
    handleRequest: (request) => {
      if (
        request?.type !== "darwin-process-tree.signal"
        || !Number.isSafeInteger(request.requestId)
        || request.signal !== "SIGTERM"
      ) {
        return null;
      }
      let sent = false;
      let sentAt = null;
      if (cooperativeGroupId !== null) {
        try {
          (options.kill ?? process.kill)(-cooperativeGroupId, "SIGTERM");
          sent = true;
          sentAt = (options.now ?? (() => new Date()))().toISOString();
        } catch {
          // The retained group may already contain only the supervisor.
        }
      }
      return {
        type: "darwin-process-tree.signal-result",
        requestId: request.requestId,
        sent,
        sentAt,
      };
    },
  };
};

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
 * adapter inherits the detached supervisor's retained cooperative process
 * group instead of creating a reusable adapter-PID group.
 *
 * @param {{cwd: string, env: NodeJS.ProcessEnv, stdio: import("node:child_process").StdioOptions}} options
 */
export const darwinAdapterSpawnOptions = (options) => ({
  cwd: options.cwd,
  env: options.env,
  detached: false,
  stdio: options.stdio,
});

export const darwinSupervisorSpawnOptions = () => ({
  detached: true,
  stdio: /** @type {const} */ ("ignore"),
});

/** @param {string} evidencePath @param {Record<string, unknown>} evidence */
const publishDarwinHostLossTerminationEvidence = (evidencePath, evidence) => {
  const temporaryPath = `${evidencePath}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(evidence)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  const file = openSync(temporaryPath, "r");
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporaryPath, evidencePath);
  const directory = openSync(dirname(evidencePath), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
};

/** @param {string[]} arguments_ */
const runLsappinfo = (arguments_) => new Promise((resolve) => {
  execFile(lsappinfoPath, arguments_, {
    timeout: arguments_[0] === "kill" ? 4_000 : 500,
    windowsHide: true,
  }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? "") }));
});

/** @param {unknown} value @returns {DarwinHostLossTerminationEvidence | null} */
const parseDarwinHostLossTerminationEvidence = (value) => {
  const record = /** @type {Record<string, any>} */ (value);
  if (
    !value
    || typeof value !== "object"
    || record.schemaVersion !== 1
    || record.platform !== "darwin"
    || !applicationSpecifierPattern.test(record.applicationSpecifier ?? "")
    || !["termination_confirmed", "termination_unconfirmed"].includes(record.status)
    || typeof record.killAccepted !== "boolean"
    || typeof record.coalitionAbsent !== "boolean"
    || Number.isNaN(Date.parse(record.observedAt ?? ""))
    || (record.status === "termination_confirmed" && record.coalitionAbsent !== true)
    || (record.status === "termination_unconfirmed" && record.coalitionAbsent !== false)
  ) {
    return null;
  }
  return /** @type {DarwinHostLossTerminationEvidence} */ (record);
};

/**
 * Ask LaunchServices to terminate the retained application coalition, then
 * durably publish proof only after its non-reused bundle identity disappears.
 * A failed kill invocation can still converge to confirmed absence; an
 * unreadable or live coalition always remains explicitly unconfirmed.
 *
 * @param {{applicationSpecifier: string, terminationEvidencePath: string}} configuration
 * @param {{runLsappinfo?: (arguments_: string[]) => Promise<{ok: boolean, stdout: string}>, now?: () => Date, delay?: (milliseconds: number) => Promise<void>, maxObservationAttempts?: number}} [options]
 */
export const terminateDarwinCoalitionAfterHostLoss = async (configuration, options = {}) => {
  if (
    !applicationSpecifierPattern.test(configuration.applicationSpecifier)
    || typeof configuration.terminationEvidencePath !== "string"
    || configuration.terminationEvidencePath.length === 0
  ) {
    throw new Error("darwin_host_loss_termination_configuration_invalid");
  }
  const invoke = options.runLsappinfo ?? runLsappinfo;
  const delay = options.delay ?? ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const maxObservationAttempts = options.maxObservationAttempts ?? 16;
  const termination = await invoke([
    "kill",
    "-coalition",
    "-launchdjobs",
    "-hard",
    configuration.applicationSpecifier,
  ]).catch(() => ({ ok: false, stdout: "" }));
  let coalitionAbsent = false;
  for (let attempt = 0; attempt < maxObservationAttempts; attempt += 1) {
    const observation = await invoke([
      "find",
      "--includeExitedApplications",
      `bundleid=${configuration.applicationSpecifier}`,
    ]).catch(() => ({ ok: false, stdout: "" }));
    if (observation.ok
      && !/ASN:0x[0-9a-f]+[-:]0x[0-9a-f]+:/i.test(observation.stdout)) {
      coalitionAbsent = true;
      break;
    }
    if (attempt + 1 < maxObservationAttempts) await delay(100);
  }
  const evidence = {
    schemaVersion: 1,
    platform: "darwin",
    applicationSpecifier: configuration.applicationSpecifier,
    status: coalitionAbsent ? "termination_confirmed" : "termination_unconfirmed",
    killAccepted: termination.ok,
    coalitionAbsent,
    observedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  publishDarwinHostLossTerminationEvidence(configuration.terminationEvidencePath, evidence);
  return evidence;
};

/** @param {string} evidencePath */
export const readDarwinHostLossTerminationEvidence = async (evidencePath) => {
  try {
    return parseDarwinHostLossTerminationEvidence(JSON.parse(await readFile(evidencePath, "utf8")));
  } catch {
    return null;
  }
};

/**
 * Startup is serialized behind this bounded wait so it cannot classify a run
 * while the detached supervisor is still proving coalition removal.
 * @param {string} evidencePath
 * @param {{timeoutMs?: number, delay?: (milliseconds: number) => Promise<void>}} [options]
 */
export const waitForDarwinHostLossTerminationEvidence = async (
  evidencePath,
  options = {},
) => {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const delay = options.delay ?? ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  while (Date.now() < deadline) {
    const evidence = await readDarwinHostLossTerminationEvidence(evidencePath);
    if (evidence) return evidence.status;
    await delay(25);
  }
  return "termination_unconfirmed";
};

const runDarwinLauncher = async () => {
  const configurationPath = process.argv[3];
  if (!configurationPath) process.exit(1);
  try {
    const supervisor = spawn(process.execPath, [
      supervisorPath,
      "darwin-supervise",
      configurationPath,
    ], darwinSupervisorSpawnOptions());
    await new Promise((resolve, reject) => {
      supervisor.once("spawn", resolve);
      supervisor.once("error", reject);
    });
    supervisor.unref();
  } catch {
    process.exit(1);
  }
};

const runDarwinTerminationWitness = async () => {
  const configurationPath = process.argv[3];
  if (!configurationPath) process.exit(1);
  let configuration;
  try {
    configuration = JSON.parse(readFileSync(configurationPath, "utf8"));
  } catch {
    process.exit(1);
  }
  if (
    !applicationSpecifierPattern.test(configuration.applicationSpecifier ?? "")
    || typeof configuration.hostLossTerminationEvidencePath !== "string"
  ) {
    process.exit(1);
  }
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    };
    process.stdin.once("end", finish);
    process.stdin.once("close", finish);
    process.stdin.once("error", finish);
    process.stdin.resume();
  });
  const evidence = await terminateDarwinCoalitionAfterHostLoss({
    applicationSpecifier: configuration.applicationSpecifier,
    terminationEvidencePath: configuration.hostLossTerminationEvidencePath,
  }).catch(() => null);
  process.exit(evidence?.status === "termination_confirmed" ? 0 : 2);
};

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
      // The Host disappeared. Its external termination witness owns the
      // LaunchServices coalition removal and durable evidence boundary.
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
  // This detached supervisor retains the process-group identity and survives
  // cooperative signalling until the Host commits the terminal outcome.
  process.on("SIGTERM", () => undefined);
  const signalController = createDarwinSupervisorSignalController({
    groupLeaderPid: process.pid,
  });
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
      const signalResult = signalController.handleRequest(request);
      if (signalResult) report(signalResult);
    }
  });
  controlSocket.once("close", () => {
    process.exit(0);
  });
  let adapterExitReported = false;
  /** @param {Record<string, unknown>} message */
  const finishAdapter = (message) => {
    if (adapterExitReported) return;
    adapterExitReported = true;
    signalController.recordAdapterExit();
    report(message);
  };
  adapter.once("error", () => finishAdapter({
    type: "darwin-process-tree.adapter-error",
  }));
  adapter.once("exit", (code, signal) => {
    finishAdapter({
      type: "darwin-process-tree.adapter-exit",
      code,
      signal,
    });
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
 * Launch one Harness adapter in a LaunchServices application coalition. A
 * detached Host-owned supervisor leads the ordinary cooperative process
 * group and the adapter inherits it. The supervisor remains alive through the
 * terminal commit, so its process-group id cannot be reused. Every native
 * descendant remains in the application coalition across fork, exec,
 * posix_spawn, setsid, and parent exit.
 * Coalition termination is the Darwin force boundary and removal of its
 * LaunchServices record is the complete-tree confirmation boundary.
 *
 * @param {string} executable
 * @param {string[]} args
 * @param {{cwd: string, env: NodeJS.ProcessEnv, hostLossTerminationEvidencePath?: string}} options
 * @returns {{child: import("node:child_process").ChildProcess, adapterChannel: PassThrough, adapterStarted: Promise<boolean>, adapterExit: Promise<AdapterExitResult>, adapterExited: () => boolean, captureDescendants: () => Promise<boolean>, prepareCancellation: () => Promise<boolean>, processTreeAlive: () => Promise<boolean>, signal: (signal: "SIGTERM" | "SIGKILL") => Promise<SignalResult>, release: () => Promise<void>}}
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
exec ${quoteShellArgument(process.execPath)} ${quoteShellArgument(supervisorPath)} darwin-launch ${quoteShellArgument(join(directory, "configuration.json"))}
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
    hostLossTerminationEvidencePath: options.hostLossTerminationEvidencePath ?? null,
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
  let adapterStartSettled = false;
  /** @type {(started: boolean) => void} */
  let resolveAdapterStarted = () => {};
  /** @type {Promise<boolean>} */
  const adapterStarted = new Promise((resolve) => {
    resolveAdapterStarted = resolve;
  });
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
  /** @param {boolean} started */
  const settleAdapterStarted = (started) => {
    if (adapterStartSettled) return;
    adapterStartSettled = true;
    resolveAdapterStarted(started);
  };
  const failLaunch = () => {
    containmentAvailable = false;
    settleAdapterStarted(false);
    settleAdapterExit({ code: null, signal: null, startFailed: true });
  };
  /** @type {import("node:child_process").ChildProcess | null} */
  let terminationWitness = null;
  let terminationWitnessClosed = Promise.resolve();
  if (typeof options.hostLossTerminationEvidencePath === "string") {
    terminationWitness = spawn(process.execPath, [
      supervisorPath,
      "darwin-termination-witness",
      configurationPath,
    ], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    terminationWitnessClosed = new Promise((resolve) => {
      terminationWitness?.once("exit", () => resolve(undefined));
      terminationWitness?.once("error", () => {
        failLaunch();
        resolve(undefined);
      });
    });
    terminationWitness.unref();
  }
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
          settleAdapterStarted(true);
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
      settleAdapterStarted(adapterSpawned);
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
    // The wrapper independently enforces the same boundary for requests that
    // were already queued when exit arrived. This Host-side check also avoids
    // creating any new cooperative request after the exit record is observed.
    if (adapterExitResult) {
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
      terminationWitness?.stdin?.end();
      await terminationWitnessClosed;
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
    adapterStarted,
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

if (process.platform === "darwin" && process.argv[1] === supervisorPath) {
  if (process.argv[2] === "darwin-launch") await runDarwinLauncher();
  if (process.argv[2] === "darwin-supervise") await runDarwinSupervisor();
  if (process.argv[2] === "darwin-termination-witness") {
    await runDarwinTerminationWitness();
  }
}
