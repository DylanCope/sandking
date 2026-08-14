import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createControllerSessionManager } from "../controller-sessions.mjs";
import {
  ensurePrivateDirectory,
  readJson,
  removePrivateFile,
  writePrivateJson,
} from "../private-state.mjs";
import { projectPreparationProjection } from "../project-registration.mjs";
import { releaseVersion } from "../protocol.mjs";
import { createBootstrap } from "./bootstrap.mjs";
import { createBrowserSessionRegistry } from "./browser-sessions/index.mjs";
import { createControllerSessionRoutes } from "./controller-session-routes.mjs";
import { createHostMutations } from "./host-mutations.mjs";
import { createLocalHostTransport } from "./host-transport/local.mjs";
import { createHttpService } from "./http/index.mjs";
import { loadHttpAssets } from "./http/assets.mjs";
import { createProjectPreparation } from "./project-preparation.mjs";
import { createSecurity } from "./security.mjs";
import { createWebSocketRouter } from "./websocket-router.mjs";

const initialHarnessRunObservation = () => ({
  type: "harness.run.observe.result",
  requestId: "harness-observe-cached",
  code: "harness_run_absent",
  mode: "snapshot",
  resynchronization: null,
  run: null,
  events: [],
  nextSequence: 0,
  outcome: null,
  logStreams: [],
  terminalEnvelopeValidation: null,
});

/**
 * Wire the Controller runtime's bounded modules behind the historical daemon
 * executable. The shared object contains coordination state only; each module
 * retains ownership of its queues and registries.
 * @param {any} options
 */
export const runRuntimeDaemon = async (options) => {
  const args = options.args;
  const runtime = {
    ...options,
    args,
    publicOrigin: process.env.SANDKING_PUBLIC_ORIGIN
      ? new URL(process.env.SANDKING_PUBLIC_ORIGIN)
      : null,
    sessionCookieName: "sandking_session",
    paths: {
      state: join(args.dataDir, "runtime-state.json"),
      tokenDirectory: join(args.dataDir, "bootstrap-tokens"),
      startupError: join(args.dataDir, "startup-error.json"),
      runtimeError: join(args.dataDir, "runtime-error.log"),
      audit: join(args.dataDir, "audit.jsonl"),
    },
    state: null,
    currentProjectPreparation: projectPreparationProjection(),
    currentProjectPath: null,
    controllerProviderProjection: [],
    controllerSessions: undefined,
    currentHarnessRunObservation: initialHarnessRunObservation(),
    currentProjectControllerSession: null,
    shuttingDown: false,
    startupCommitted: false,
  };

  Object.assign(runtime, createSecurity(runtime));
  Object.assign(runtime, createHostMutations(runtime));
  Object.assign(runtime, createBrowserSessionRegistry(runtime));
  Object.assign(runtime, createBootstrap(runtime));
  Object.assign(runtime, createLocalHostTransport(runtime));
  Object.assign(runtime, createProjectPreparation(runtime));
  Object.assign(runtime, createControllerSessionRoutes(runtime));
  Object.assign(runtime, createWebSocketRouter(runtime));

  const shutdown = async () => {
    if (runtime.shuttingDown) return;
    runtime.shuttingDown = true;
    runtime.shutdownBrowserSessions();
    await runtime.stopHttpServer?.();
    await runtime.controllerSessions?.shutdown();
    await runtime.stopHost();
    const recorded = await readJson(runtime.paths.state, null);
    if (recorded && typeof recorded === "object" && recorded.pid === process.pid) {
      await removePrivateFile(runtime.paths.state);
    }
  };

  process.on("SIGTERM", async () => {
    await shutdown();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    await shutdown();
    process.exit(0);
  });
  process.on("message", (/** @type {unknown} */ message) => {
    if (
      !message
      || typeof message !== "object"
      || !("type" in message)
      || !("startupId" in message)
      || message.type !== "runtime.start.commit"
      || message.startupId !== args.startupId
      || runtime.startupCommitted
    ) return;
    runtime.startupCommitted = true;
    process.send?.({ type: "runtime.start.committed", startupId: args.startupId });
  });
  process.on("disconnect", async () => {
    if (runtime.startupCommitted) return;
    await shutdown();
    process.exit(1);
  });
  process.on("uncaughtException", async (error) => {
    await runtime.logSanitizedRuntimeError(error);
    await shutdown();
    process.exit(1);
  });
  process.on("unhandledRejection", async (error) => {
    await runtime.logSanitizedRuntimeError(error);
    await shutdown();
    process.exit(1);
  });

  await ensurePrivateDirectory(args.dataDir);
  await ensurePrivateDirectory(runtime.paths.tokenDirectory);
  const assets = await loadHttpAssets();
  Object.assign(runtime, createHttpService(runtime, assets));

  try {
    const runtimeId = `runtime-${randomBytes(12).toString("hex")}`;
    const negotiation = await runtime.launchHost(runtimeId);
    const host = negotiation.host;
    runtime.controllerSessions = await createControllerSessionManager({
      dataDir: args.dataDir,
      recordAudit: runtime.recordAudit,
      handleProviderOperation: runtime.handleProviderOperation,
    });
    const [conformanceProvider, claudeProvider] = await Promise.all([
      runtime.controllerSessions.probeProvider("conformance-controller-v1"),
      runtime.controllerSessions.probeProvider("claude-code"),
    ]);
    if (!conformanceProvider || !claudeProvider) {
      throw new Error("controller_provider_probe_invalid");
    }
    runtime.controllerProviderProjection = [conformanceProvider, claudeProvider].map((probe) => ({
      ...probe.provider,
      adapterId: probe.adapterId,
      adapterProtocol: probe.adapterProtocol.version,
      capabilities: probe.capabilities,
      availability: probe.availability ? {
        status: probe.availability.status,
        version: probe.availability.version,
        authentication: probe.availability.authentication.status,
        source: probe.availability.authentication.source,
        failureCode: probe.availability.failure?.code ?? null,
      } : {
        status: "available",
        version: probe.adapterProtocol.version,
        authentication: "not-applicable",
        source: "packaged-conformance",
        failureCode: null,
      },
      terminal: probe.terminal,
    }));
    const negotiationAuditId = await runtime.recordAudit("host.negotiate", "accepted", {
      controllerIdentity: "controller-runtime",
      controllerId: runtimeId,
      expectedHostId: args.expectedHostId,
      hostIdentity: host.identity,
      hostId: host.hostId,
      protocolVersion: host.protocol.version,
      capabilities: host.negotiatedCapabilities,
      schemaDigest: host.schemaDigest,
      framing: host.framing,
      hostIdentityMutation: negotiation.hostIdentityOutcome ? {
        authorizationClass: negotiation.hostIdentityOutcome.authorizationClass,
        expectedRevision: negotiation.hostIdentityOutcome.expectedRevision,
        revision: negotiation.hostIdentityOutcome.revision,
        idempotentReplay: negotiation.hostIdentityOutcome.idempotentReplay,
        auditId: negotiation.hostIdentityOutcome.auditId,
      } : null,
    });

    const address = await runtime.startHttpServer();
    runtime.state = {
      pid: process.pid,
      runtimeId,
      revision: args.lifecycleRevision,
      port: address.port,
      readinessToken: randomBytes(24).toString("hex"),
      compatibilityKey: "runtime-v3-controller-terminal",
      version: releaseVersion,
      identity: "controller-runtime",
      host: {
        identity: host.identity,
        hostId: host.hostId,
        capabilities: host.capabilities,
        negotiatedCapabilities: host.negotiatedCapabilities,
        schemaDigest: host.schemaDigest,
        framing: host.framing,
        observationCursor: host.observationCursor,
        release: host.release,
        status: "connected",
        freshness: "current",
        failure: null,
      },
      protocol: host.protocol,
      listener: runtime.publicOrigin
        ? { address: "0.0.0.0", class: "public" }
        : { address: "127.0.0.1", class: "loopback" },
      negotiationAuditId,
      hostIdentityAuditId: negotiation.hostIdentityOutcome?.auditId ?? null,
      startedAt: new Date().toISOString(),
    };
    const startupObservation = await runtime.requestHostOperation({
      type: "harness.run.observe",
      requestId: `harness-observe-startup-${randomBytes(8).toString("hex")}`,
      harnessRunId: null,
      afterSequence: 0,
    });
    if (startupObservation.type !== "harness.run.observe.result") {
      throw new Error("harness_run_startup_observation_failed");
    }
    runtime.retainCanonicalHarnessRunObservation(startupObservation);
    await writePrivateJson(runtime.paths.state, runtime.state);

    runtime.getHostProcess()?.once("exit", async () => {
      if (!runtime.shuttingDown) {
        await runtime.logSanitizedRuntimeError(new Error("host_disconnected"));
        await runtime.markHostDisconnected("host_disconnected");
      }
    });
  } catch (error) {
    const code = runtime.sanitizedRuntimeCode(error);
    const negotiationAuditId = await runtime.recordAudit("host.negotiate", "rejected", {
      code,
      controllerIdentity: "controller-runtime",
      expectedHostIdentity: "local-host",
      expectedHostId: args.expectedHostId,
      ...(error instanceof Error && "controllerId" in error
        ? { controllerId: error.controllerId }
        : {}),
      ...(error instanceof Error && "observedHostId" in error
        ? { observedHostId: error.observedHostId }
        : {}),
    });
    await writePrivateJson(runtime.paths.startupError, { code, auditId: negotiationAuditId });
    await runtime.stopHost();
    await removePrivateFile(runtime.paths.state);
    process.exit(1);
  }
};
