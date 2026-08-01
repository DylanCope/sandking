import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  appendPrivateJsonLine,
  ensurePrivateDirectory,
  hasErrorCode,
  PRIVATE_FILE_MODE,
  readJson,
  removePrivateFile,
  writePrivateJson,
} from "./private-state.mjs";
import { ensureHostIdentity } from "./host-identity.mjs";
import { capabilitySetSchema, framingSchema, releaseVersion, versionSchema } from "./protocol.mjs";

const COMPATIBILITY_KEY = "runtime-v1";
export const BOOTSTRAP_TTL_MS = 60_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;
const daemonPath = fileURLToPath(new URL("./runtime-daemon.mjs", import.meta.url));

/**
 * @typedef {{
 *   type: "host_negotiation_failure" | "runtime_startup_failure",
 *   code: string,
 *   retryable: boolean,
 *   explanation: string,
 *   retryGuidance: string,
 *   auditId?: string,
 * }} StartupDiagnosis
 */

/** @type {Readonly<Record<string, Omit<StartupDiagnosis, "code">>>} */
const startupDiagnosisDetails = Object.freeze({
  host_protocol_error: {
    type: "host_negotiation_failure",
    retryable: true,
    explanation: "The local Host returned an unexpected negotiation response.",
    retryGuidance: "Restart the local Host with a compatible Sand-King release, then retry the launch.",
  },
  host_protocol_major_mismatch: {
    type: "host_negotiation_failure",
    retryable: true,
    explanation: "The Controller and local Host use incompatible protocol major versions.",
    retryGuidance: "Install matching Sand-King Controller and Host releases, then retry the launch.",
  },
  host_identity_mismatch: {
    type: "host_negotiation_failure",
    retryable: true,
    explanation: "The local Host reported an unexpected identity.",
    retryGuidance: "Verify the local Host installation and expected identity, then retry the launch.",
  },
  host_capability_unsupported: {
    type: "host_negotiation_failure",
    retryable: true,
    explanation: "The Controller and local Host could not agree on required capabilities.",
    retryGuidance: "Install compatible Sand-King Controller and Host releases, then retry the launch.",
  },
  host_schema_mismatch: {
    type: "host_negotiation_failure",
    retryable: true,
    explanation: "The Controller and local Host use incompatible control schemas.",
    retryGuidance: "Install matching Sand-King Controller and Host releases, then retry the launch.",
  },
  host_framing_invalid: {
    type: "host_negotiation_failure",
    retryable: true,
    explanation: "The local Host proposed unsupported framing limits.",
    retryGuidance: "Restart the local Host with a compatible Sand-King release, then retry the launch.",
  },
  host_protocol_invalid_frame: {
    type: "host_negotiation_failure",
    retryable: true,
    explanation: "The local Host sent malformed framed protocol data during negotiation.",
    retryGuidance: "Restart or update the local Host, then retry the launch.",
  },
  host_unavailable: {
    type: "host_negotiation_failure",
    retryable: true,
    explanation: "The local Host became unavailable during negotiation.",
    retryGuidance: "Restart the local Host, then retry the launch.",
  },
  controller_identity_invalid: {
    type: "host_negotiation_failure",
    retryable: true,
    explanation: "The local Host rejected the Controller identity.",
    retryGuidance: "Verify the Controller and Host installation identities, then retry the launch.",
  },
  controller_host_identity_mismatch: {
    type: "host_negotiation_failure",
    retryable: true,
    explanation: "The local Host rejected the expected durable Host identity.",
    retryGuidance: "Verify or explicitly adopt the intended local Host identity, then retry the launch.",
  },
  controller_protocol_major_mismatch: {
    type: "host_negotiation_failure",
    retryable: true,
    explanation: "The local Host rejected the Controller protocol major version as incompatible.",
    retryGuidance: "Install matching Sand-King Controller and Host releases, then retry the launch.",
  },
  controller_capability_unsupported: {
    type: "host_negotiation_failure",
    retryable: true,
    explanation: "The local Host rejected a required Controller capability.",
    retryGuidance: "Install compatible Sand-King Controller and Host releases, then retry the launch.",
  },
  controller_schema_mismatch: {
    type: "host_negotiation_failure",
    retryable: true,
    explanation: "The local Host rejected the Controller control schema as incompatible.",
    retryGuidance: "Install matching Sand-King Controller and Host releases, then retry the launch.",
  },
  runtime_start_timeout: {
    type: "runtime_startup_failure",
    retryable: true,
    explanation: "The Controller runtime did not become ready before the startup deadline.",
    retryGuidance: "Check the local Host installation and retry the launch.",
  },
  runtime_start_failed: {
    type: "runtime_startup_failure",
    retryable: true,
    explanation: "The Controller runtime could not start safely.",
    retryGuidance: "Check the local Sand-King installation and retry the launch.",
  },
});

/** @param {string} code @param {string | undefined} auditId @returns {StartupDiagnosis} */
const startupDiagnosisForCode = (code, auditId) => {
  const sanitizedCode = Object.hasOwn(startupDiagnosisDetails, code)
    ? code
    : "runtime_start_failed";
  return {
    code: sanitizedCode,
    ...startupDiagnosisDetails[sanitizedCode],
    ...(auditId ? { auditId } : {}),
  };
};

export class RuntimeStartupError extends Error {
  /** @param {string} code @param {string | undefined} [auditId] */
  constructor(code, auditId) {
    const diagnosis = startupDiagnosisForCode(code, auditId);
    super(diagnosis.code);
    this.name = "RuntimeStartupError";
    this.diagnosis = diagnosis;
  }
}

/** @param {unknown} error */
const asRuntimeStartupError = (error) => error instanceof RuntimeStartupError
  ? error
  : new RuntimeStartupError(error instanceof Error ? error.message : "runtime_start_failed");

const runtimeStateSchema = z.object({
  pid: z.number().int().positive(),
  runtimeId: z.string().min(1).max(128),
  revision: z.number().int().positive(),
  port: z.number().int().min(1).max(65_535),
  readinessToken: z.string().regex(/^[a-f0-9]{48}$/),
  compatibilityKey: z.string().min(1).max(128),
  version: z.string().min(1),
  identity: z.literal("controller-runtime"),
  host: z.object({
    identity: z.string().min(1).max(128),
    hostId: z.string().regex(/^host-[a-f0-9]{24}$/),
    capabilities: capabilitySetSchema,
    negotiatedCapabilities: z.array(z.string()).max(32),
    schemaDigest: z.string(),
    framing: framingSchema,
    observationCursor: z.string().nullable(),
    release: z.string(),
  }).strict(),
  protocol: versionSchema,
  listener: z.object({
    address: z.literal("127.0.0.1"),
    class: z.literal("loopback"),
  }).strict(),
  negotiationAuditId: z.string().min(1).max(128),
  startedAt: z.string(),
}).strict();

const runtimeLifecycleSchema = z.object({
  revision: z.number().int().nonnegative(),
  status: z.enum(["running", "stopped"]),
  runtimeId: z.string().regex(/^runtime-[a-f0-9]{24}$/),
}).strict();

/** @typedef {{idempotencyKeyHash: string, expectedRevision: number, response: Record<string, any>}} StopOutcome */

/** @param {string} dataDir @param {string} action @param {"accepted" | "rejected" | "observed"} outcome @param {Record<string, unknown>} details */
const recordLifecycleAudit = async (dataDir, action, outcome, details) => {
  const auditId = `audit-${randomBytes(12).toString("hex")}`;
  await appendPrivateJsonLine(join(dataDir, "audit.jsonl"), {
    auditId,
    action,
    outcome,
    details,
    recordedAt: new Date().toISOString(),
  });
  return auditId;
};

/** @param {string} dataDir */
const readLifecycle = async (dataDir) => {
  const raw = await readJson(join(dataDir, "runtime-lifecycle.json"), null);
  if (raw === null) {
    return null;
  }
  const parsed = runtimeLifecycleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("runtime_lifecycle_state_invalid");
  }
  return parsed.data;
};

/** @param {string} dataDir @returns {Promise<StopOutcome[]>} */
const readStopOutcomes = async (dataDir) => {
  const raw = await readJson(join(dataDir, "runtime-stop-outcomes.json"), { outcomes: [] });
  if (!raw || typeof raw !== "object" || !("outcomes" in raw) || !Array.isArray(raw.outcomes)) {
    throw new Error("runtime_stop_outcomes_invalid");
  }
  /** @type {StopOutcome[]} */
  const outcomes = [];
  for (const outcome of /** @type {unknown[]} */ (raw.outcomes)) {
    if (
      outcome
      && typeof outcome === "object"
      && "idempotencyKeyHash" in outcome
      && /^sha256:[a-f0-9]{64}$/.test(String(outcome.idempotencyKeyHash))
      && "expectedRevision" in outcome
      && Number.isSafeInteger(outcome.expectedRevision)
      && "response" in outcome
      && outcome.response
      && typeof outcome.response === "object"
    ) {
      outcomes.push(/** @type {StopOutcome} */ (outcome));
    }
  }
  return outcomes;
};

/** @param {string} dataDir @param {StopOutcome[]} outcomes */
const writeStopOutcomes = async (dataDir, outcomes) => {
  await writePrivateJson(join(dataDir, "runtime-stop-outcomes.json"), {
    outcomes: outcomes.slice(-128),
  });
};

/** @param {number} pid */
export const pidIsRunning = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      try {
        const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ");
        if (fields[2] === "Z") {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
};

const defaultDataDir = () => join(homedir(), ".sandking");

/** @param {string} lockPath */
const inspectLaunchLock = async (lockPath) => {
  try {
    return {
      owner: await readJson(lockPath, null),
      recentlyIncomplete: false,
    };
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    const lockStat = await stat(lockPath).catch(() => null);
    return {
      owner: null,
      recentlyIncomplete: Boolean(lockStat && Date.now() - lockStat.mtimeMs < 1_000),
    };
  }
};

/** @param {string} lockPath @param {string} lockId */
const releaseOwnedLock = async (lockPath, lockId) => {
  const { owner: current } = await inspectLaunchLock(lockPath);
  if (current && typeof current === "object" && current.lockId === lockId) {
    await removePrivateFile(lockPath);
  }
};

/**
 * @template T
 * @param {string} dataDir
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
const withRuntimeLock = async (dataDir, operation) => {
  const lockPath = join(dataDir, "runtime.lock");
  const recoveryPath = join(dataDir, "runtime.lock.recovery");
  const lockId = randomBytes(12).toString("hex");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const recoveryText = await readFile(recoveryPath, "utf8").catch(() => null);
    if (recoveryText !== null) {
      let recoveryPid = Number.NaN;
      try {
        recoveryPid = Number(JSON.parse(recoveryText).pid);
      } catch {
        const recoveryStat = await stat(recoveryPath).catch(() => null);
        if (recoveryStat && Date.now() - recoveryStat.mtimeMs < 1_000) {
          await delay(25);
          continue;
        }
      }
      if (pidIsRunning(recoveryPid)) {
        await delay(25);
        continue;
      }
      await removePrivateFile(recoveryPath);
      continue;
    }
    try {
      const handle = await open(lockPath, "wx", PRIVATE_FILE_MODE);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, lockId })}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(lockPath, PRIVATE_FILE_MODE);

      try {
        return await operation();
      } finally {
        await releaseOwnedLock(lockPath, lockId);
      }
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }

      const inspectedOwner = await inspectLaunchLock(lockPath);
      if (inspectedOwner.recentlyIncomplete) {
        await delay(25);
        continue;
      }
      const owner = inspectedOwner.owner;
      const ownerPid = owner && typeof owner === "object" && "pid" in owner
        ? Number(owner.pid)
        : Number.NaN;
      if (!pidIsRunning(ownerPid)) {
        let recoveryHandle;
        try {
          recoveryHandle = await open(recoveryPath, "wx", PRIVATE_FILE_MODE);
          await recoveryHandle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`, "utf8");
          await recoveryHandle.sync();
          const confirmedInspection = await inspectLaunchLock(lockPath);
          const confirmedOwner = confirmedInspection.owner;
          const confirmedPid = confirmedOwner
            && typeof confirmedOwner === "object"
            && "pid" in confirmedOwner
            ? Number(confirmedOwner.pid)
            : Number.NaN;
          if (!confirmedInspection.recentlyIncomplete && !pidIsRunning(confirmedPid)) {
            await removePrivateFile(lockPath);
          }
        } catch (recoveryError) {
          if (!hasErrorCode(recoveryError, "EEXIST")) {
            throw recoveryError;
          }
        } finally {
          await recoveryHandle?.close();
          if (recoveryHandle) {
            await removePrivateFile(recoveryPath);
          }
        }
        continue;
      }
      await delay(50);
    }
  }

  throw new Error("runtime_lock_timeout");
};

/**
 * @param {string} dataDir
 * @param {z.infer<typeof runtimeStateSchema>} state
 * @param {number} ttlMs
 */
const createBootstrap = async (dataDir, state, ttlMs) => {
  const tokenDirectory = join(dataDir, "bootstrap-tokens");
  await ensurePrivateDirectory(tokenDirectory);
  const token = randomBytes(32).toString("hex");
  const idempotencyKey = randomBytes(32).toString("hex");
  const tokenId = createHash("sha256").update(token).digest("hex");
  const idempotencyKeyHash = `sha256:${createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")}`;
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ttlMs;
  await writePrivateJson(join(tokenDirectory, `${tokenId}.json`), {
    issuedAt,
    expiresAt,
    ttlMs,
    runtimeId: state.runtimeId,
    revision: 0,
    idempotencyKeyHash,
  });
  const url = new URL(`http://127.0.0.1:${state.port}/bootstrap`);
  url.searchParams.set("token", token);
  url.searchParams.set("idempotencyKey", idempotencyKey);
  url.searchParams.set("expectedRevision", "0");
  return {
    url: url.href,
    metadata: {
      ttlMs,
      expectedRevision: 0,
      expiresAt: new Date(expiresAt).toISOString(),
    },
  };
};

/** @param {z.infer<typeof runtimeStateSchema>} state */
const probeRuntime = async (state) => {
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, {
      headers: {
        host: `127.0.0.1:${state.port}`,
        "x-sandking-readiness": state.readinessToken,
      },
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) {
      return false;
    }
    const health = await response.json();
    return health?.ready === true
      && health.runtimeId === state.runtimeId
      && health.identity === "controller-runtime"
      && health.version === releaseVersion;
  } catch {
    return false;
  }
};

/** @param {number} pid @param {NodeJS.Signals} signal */
const signalProcessTree = (pid, signal) => {
  if (!pidIsRunning(pid)) {
    return;
  }
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
    } else {
      process.kill(pid, signal);
    }
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process exited between the liveness probe and signal.
    }
  }
};

/** @param {number} pid */
const terminateProcessTree = async (pid) => {
  signalProcessTree(pid, "SIGTERM");
  for (let attempt = 0; attempt < 20 && pidIsRunning(pid); attempt += 1) {
    await delay(25);
  }
  if (pidIsRunning(pid)) {
    signalProcessTree(pid, "SIGKILL");
  }
};

/**
 * @param {string} dataDir
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} startupTimeoutMs
 */
const waitForStartup = async (dataDir, child, startupTimeoutMs) => {
  const statePath = join(dataDir, "runtime-state.json");
  const errorPath = join(dataDir, "startup-error.json");
  const deadline = Date.now() + startupTimeoutMs;
  let exitCode = null;
  child.once("exit", (code) => {
    exitCode = code ?? 1;
  });

  while (Date.now() < deadline) {
    const errorState = await readJson(errorPath, null);
    if (errorState && typeof errorState === "object" && "code" in errorState) {
      throw new RuntimeStartupError(
        String(errorState.code),
        typeof errorState.auditId === "string" ? errorState.auditId : undefined,
      );
    }

    const rawState = await readJson(statePath, null);
    const parsedState = runtimeStateSchema.safeParse(rawState);
    if (parsedState.success && parsedState.data.pid === child.pid) {
      if (await probeRuntime(parsedState.data)) {
        return parsedState.data;
      }
    }

    if (exitCode !== null) {
      await delay(25);
      const finalError = await readJson(errorPath, null);
      throw new RuntimeStartupError(
        finalError && typeof finalError === "object" && "code" in finalError
          ? String(finalError.code)
          : "runtime_start_failed",
        finalError && typeof finalError === "object" && typeof finalError.auditId === "string"
          ? finalError.auditId
          : undefined,
      );
    }
    await delay(50);
  }

  throw new RuntimeStartupError("runtime_start_timeout");
};

/**
 * @param {string} dataDir
 * @param {{hostMode?: string, startupTimeoutMs?: number, expectedHostId: string, lifecycleRevision: number}} options
 */
const spawnRuntime = async (dataDir, options) => {
  const statePath = join(dataDir, "runtime-state.json");
  const errorPath = join(dataDir, "startup-error.json");
  await Promise.all([removePrivateFile(statePath), removePrivateFile(errorPath)]);

  const daemonArgs = [daemonPath, "--data-dir", dataDir];
  daemonArgs.push("--expected-host-id", options.expectedHostId);
  daemonArgs.push("--lifecycle-revision", String(options.lifecycleRevision));
  if (options.hostMode) {
    daemonArgs.push("--host-mode", options.hostMode);
  }
  const child = spawn(process.execPath, daemonArgs, {
    cwd: dataDir,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });

  try {
    const runtimeState = await waitForStartup(
      dataDir,
      child,
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    );
    child.unref();
    await removePrivateFile(errorPath);
    return runtimeState;
  } catch (error) {
    const startupError = asRuntimeStartupError(error);
    if (typeof child.pid === "number") {
      await terminateProcessTree(child.pid);
    }
    await writePrivateJson(join(dataDir, "last-startup-error.json"), {
      ...startupError.diagnosis,
      recordedAt: new Date().toISOString(),
    });
    await removePrivateFile(statePath);
    await removePrivateFile(errorPath);
    throw startupError;
  }
};

/** @param {string | undefined} provided */
export const resolveDataDir = (provided) => resolve(provided ?? defaultDataDir());

/**
 * @param {{dataDir?: string, hostMode?: string, startupTimeoutMs?: number, bootstrapTtlMs?: number}} options
 */
export const launchRuntime = async (options = {}) => {
  const resolvedDataDir = resolveDataDir(options.dataDir);
  const bootstrapTtlMs = options.bootstrapTtlMs ?? BOOTSTRAP_TTL_MS;
  if (!Number.isSafeInteger(bootstrapTtlMs) || bootstrapTtlMs < 1 || bootstrapTtlMs > BOOTSTRAP_TTL_MS) {
    throw new Error("bootstrap_ttl_invalid");
  }
  await ensurePrivateDirectory(resolvedDataDir);

  return withRuntimeLock(resolvedDataDir, async () => {
    const hostIdentity = await ensureHostIdentity(resolvedDataDir);
    const lifecyclePath = join(resolvedDataDir, "runtime-lifecycle.json");
    const lifecycle = await readLifecycle(resolvedDataDir);
    const statePath = join(resolvedDataDir, "runtime-state.json");
    const rawExisting = await readJson(statePath, null);
    const rawPid = rawExisting && typeof rawExisting === "object" && "pid" in rawExisting
      ? Number(rawExisting.pid)
      : Number.NaN;
    const existing = runtimeStateSchema.safeParse(rawExisting);

    let runtimeState;
    let reused = false;
    if (pidIsRunning(rawPid)) {
      if (!existing.success) {
        throw new Error("runtime_state_invalid");
      }
      if (
        existing.data.compatibilityKey !== COMPATIBILITY_KEY
        || existing.data.version !== releaseVersion
        || existing.data.host.hostId !== hostIdentity.hostId
      ) {
        throw new Error("runtime_incompatible");
      }
      if (!(await probeRuntime(existing.data))) {
        throw new Error("runtime_not_ready");
      }
      runtimeState = existing.data;
      reused = true;
      if (
        !lifecycle
        || lifecycle.revision !== runtimeState.revision
        || lifecycle.status !== "running"
        || lifecycle.runtimeId !== runtimeState.runtimeId
      ) {
        await writePrivateJson(lifecyclePath, {
          revision: runtimeState.revision,
          status: "running",
          runtimeId: runtimeState.runtimeId,
        });
      }
    } else {
      await removePrivateFile(statePath);
      const lifecycleRevision = (lifecycle?.revision ?? 0) + 1;
      runtimeState = await spawnRuntime(resolvedDataDir, {
        ...options,
        expectedHostId: hostIdentity.hostId,
        lifecycleRevision,
      });
      await writePrivateJson(lifecyclePath, {
        revision: lifecycleRevision,
        status: "running",
        runtimeId: runtimeState.runtimeId,
      });
    }

    const bootstrap = await createBootstrap(resolvedDataDir, runtimeState, bootstrapTtlMs);
    return {
      runtime: {
        identity: runtimeState.identity,
        runtimeId: runtimeState.runtimeId,
        revision: runtimeState.revision,
        reused,
        pid: runtimeState.pid,
        port: runtimeState.port,
        listener: runtimeState.listener,
      },
      host: runtimeState.host,
      protocol: runtimeState.protocol,
      audit: { negotiationId: runtimeState.negotiationAuditId },
      bootstrapUrl: bootstrap.url,
      bootstrap: bootstrap.metadata,
    };
  });
};

/** @param {{dataDir?: string, idempotencyKey?: string, expectedRevision?: number}} options */
export const stopRuntime = async (options = {}) => {
  const resolvedDataDir = resolveDataDir(options.dataDir);
  await ensurePrivateDirectory(resolvedDataDir);
  return withRuntimeLock(resolvedDataDir, async () => {
    const statePath = join(resolvedDataDir, "runtime-state.json");
    const rawState = await readJson(statePath, null);
    const parsed = runtimeStateSchema.safeParse(rawState);
    const lifecycle = await readLifecycle(resolvedDataDir);
    const actualRevision = parsed.success
      ? parsed.data.revision
      : lifecycle?.revision ?? 0;
    const expectedRevision = options.expectedRevision ?? actualRevision;
    const idempotencyKey = options.idempotencyKey ?? randomBytes(32).toString("hex");
    const validContract = idempotencyKey.length > 0
      && idempotencyKey.length <= 256
      && Number.isSafeInteger(expectedRevision)
      && expectedRevision >= 0;
    const idempotencyKeyHash = validContract
      ? `sha256:${createHash("sha256").update(idempotencyKey).digest("hex")}`
      : null;
    const auditDetails = {
      authorizationClass: "user_runtime_lifecycle",
      idempotencyKeyHash,
      expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
      actualRevision,
    };

    if (!validContract || !idempotencyKeyHash) {
      const auditId = await recordLifecycleAudit(
        resolvedDataDir,
        "runtime.stop",
        "rejected",
        { ...auditDetails, code: "mutation_contract_invalid" },
      );
      return {
        type: "mutation_failure",
        code: "mutation_contract_invalid",
        retryable: true,
        stopped: false,
        expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : -1,
        actualRevision,
        auditId,
      };
    }

    const outcomes = await readStopOutcomes(resolvedDataDir);
    const existing = outcomes.find((outcome) =>
      outcome.idempotencyKeyHash === idempotencyKeyHash);
    if (existing) {
      if (existing.expectedRevision !== expectedRevision) {
        const auditId = await recordLifecycleAudit(
          resolvedDataDir,
          "runtime.stop",
          "rejected",
          { ...auditDetails, code: "idempotency_key_conflict" },
        );
        return {
          type: "mutation_failure",
          code: "idempotency_key_conflict",
          retryable: true,
          stopped: false,
          expectedRevision,
          actualRevision,
          auditId,
        };
      }
      await recordLifecycleAudit(resolvedDataDir, "runtime.stop", "observed", {
        ...auditDetails,
        idempotentReplay: true,
        originalAuditId: existing.response.auditId,
      });
      return { ...existing.response, idempotentReplay: true };
    }

    if (expectedRevision !== actualRevision) {
      const auditId = await recordLifecycleAudit(
        resolvedDataDir,
        "runtime.stop",
        "rejected",
        { ...auditDetails, code: "mutation_revision_conflict" },
      );
      const response = {
        type: "mutation_failure",
        code: "mutation_revision_conflict",
        retryable: true,
        stopped: false,
        expectedRevision,
        actualRevision,
        auditId,
      };
      outcomes.push({ idempotencyKeyHash, expectedRevision, response });
      await writeStopOutcomes(resolvedDataDir, outcomes);
      return response;
    }

    if (!parsed.success || !pidIsRunning(parsed.data.pid)) {
      await removePrivateFile(statePath);
      const auditId = await recordLifecycleAudit(
        resolvedDataDir,
        "runtime.stop",
        "observed",
        { ...auditDetails, resultingRevision: actualRevision, code: "runtime_not_running" },
      );
      const response = {
        type: "mutation_result",
        code: "runtime_not_running",
        stopped: false,
        revision: actualRevision,
        idempotentReplay: false,
        auditId,
      };
      outcomes.push({ idempotencyKeyHash, expectedRevision, response });
      await writeStopOutcomes(resolvedDataDir, outcomes);
      return response;
    }
    if (!(await probeRuntime(parsed.data))) {
      const auditId = await recordLifecycleAudit(
        resolvedDataDir,
        "runtime.stop",
        "rejected",
        { ...auditDetails, code: "runtime_not_ready" },
      );
      const response = {
        type: "mutation_failure",
        code: "runtime_not_ready",
        retryable: true,
        stopped: false,
        expectedRevision,
        actualRevision,
        auditId,
      };
      outcomes.push({ idempotencyKeyHash, expectedRevision, response });
      await writeStopOutcomes(resolvedDataDir, outcomes);
      return response;
    }

    await terminateProcessTree(parsed.data.pid);
    await removePrivateFile(statePath);
    const resultingRevision = actualRevision + 1;
    await writePrivateJson(join(resolvedDataDir, "runtime-lifecycle.json"), {
      revision: resultingRevision,
      status: "stopped",
      runtimeId: parsed.data.runtimeId,
    });
    const auditId = await recordLifecycleAudit(
      resolvedDataDir,
      "runtime.stop",
      "accepted",
      {
        ...auditDetails,
        resultingRevision,
        runtimeId: parsed.data.runtimeId,
      },
    );
    const response = {
      type: "mutation_result",
      code: "runtime_stopped",
      stopped: true,
      runtimeId: parsed.data.runtimeId,
      revision: resultingRevision,
      idempotentReplay: false,
      auditId,
    };
    outcomes.push({ idempotencyKeyHash, expectedRevision, response });
    await writeStopOutcomes(resolvedDataDir, outcomes);
    return response;
  });
};
