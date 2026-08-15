import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SANDCASTLE_HARNESS_ADAPTER_ID } from "../../harness-adapter-identity.mjs";
import {
  launchParametersSchema,
  validateHarnessLaunch,
} from "../../harness-launch.mjs";
import { materializeProductionHarnessExecutionSnapshot } from "../../production-harness-preparation.mjs";
import {
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
} from "../../private-state.mjs";
import {
  launchRequestFingerprint,
  requestIdempotencyKeyHash,
} from "../fingerprints.mjs";
import {
  appendEvent,
  controllerIdSchema,
  controllerSessionIdSchema,
  projectIdSchema,
  publicRun,
  storedRunSchema,
} from "../schemas.mjs";
import { logPath, retainedLaunchOutcome } from "../store.mjs";

/** @param {any} runtime */
export const createLaunchOperation = (runtime) => {
  const { cancellationGraceMs, now, options, parsedHostId } = runtime;

  /** @param {any} request */
  const launch = (request) => runtime.withMutationLock(async () => {
    const authorizationClass = "harness_run_launch";
    const idempotencyKeyHash = requestIdempotencyKeyHash(request);
    const requestFingerprint = launchRequestFingerprint(request);
    const retained = await runtime.readState();
    const existing = retainedLaunchOutcome(retained, idempotencyKeyHash);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        const auditId = await options.recordAudit("harness.run.launch", "rejected", {
          code: "idempotency_key_conflict",
          authorizationClass,
          idempotencyKeyHash,
          harnessRunCreated: false,
          adapterStarted: false,
        });
        return {
          type: "harness.run.launch.failure",
          requestId: request.requestId,
          code: "idempotency_key_conflict",
          retryable: false,
          authorizationClass,
          idempotencyKeyHash,
          idempotentReplay: false,
          auditId,
          prohibitedSideEffects: {
            harnessRunCreated: false,
            adapterStarted: false,
            projectWrite: false,
          },
        };
      }
      await options.recordAudit("harness.run.launch", "observed", {
        authorizationClass,
        idempotencyKeyHash,
        idempotentReplay: true,
        originalAuditId: existing.response.auditId,
        harnessRunId: /** @type {any} */ (existing.response).run?.harnessRunId ?? null,
      });
      return {
        ...structuredClone(existing.response),
        requestId: request.requestId,
        idempotentReplay: true,
      };
    }

    const parameters = launchParametersSchema.safeParse(request.parameters);
    let code = null;
    if (
      request.authorizationClass !== authorizationClass
      || !idempotencyKeyHash
      || !projectIdSchema.safeParse(request.projectId).success
      || !controllerIdSchema.safeParse(request.controllerId).success
      || !["controller-cli", "cockpit"].includes(request.source)
      || (request.source === "controller-cli"
        ? !controllerSessionIdSchema.safeParse(request.controllerSessionId).success
        : request.controllerSessionId !== null)
    ) {
      code = "mutation_contract_invalid";
    } else if (!parameters.success) {
      code = "bounded_configuration_invalid";
    }

    let context;
    let prepared;
    if (!code && parameters.success) {
      try {
        context = await options.loadLaunchContext(request.projectId);
        prepared = await validateHarnessLaunch(context, parameters.data);
        if (
          context.project.projectId !== request.projectId
          || context.harness.harnessId !== context.project.harness.harnessId
          || context.harness.immutableRevision !== context.project.harness.pinnedRevision
          || prepared.adapterId !== context.harness.adapterId
          || prepared.adapterProtocol
            !== context.project.harness.boundedConfiguration.adapterProtocol
        ) {
          code = "harness_pin_invalid";
        }
      } catch (error) {
        const typedCode = error instanceof Error ? error.message : "";
        code = new Set([
          "project_not_found",
          "harness_not_found",
          "harness_pin_missing",
          "harness_pin_invalid",
          "harness_workspace_invalid",
          "harness_pin_unreadable",
          "harness_adapter_bytes_mismatch",
          "harness_compatibility_unsupported",
          "harness_skill_lock_missing",
          "harness_skill_lock_invalid",
          "harness_locked_skill_unavailable",
          "harness_skill_integrity_mismatch",
          "harness_projection_collision",
          "harness_projection_failed",
          "harness_execution_runtime_unavailable",
          "harness_worker_provider_unavailable",
          "bounded_configuration_invalid",
          "harness_capability_unsupported",
          "harness_adapter_protocol_invalid",
          "harness_preparation_side_effect_detected",
        ]).has(typedCode) ? typedCode : "harness_workspace_invalid";
      }
    }

    let harnessRunId = null;
    let harnessExecutionPath = null;
    /** @type {Array<{path: string, integrity: string, source: string}>} */
    let retainedHarnessExecutionInputs = [];
    if (!code && context && prepared && parameters.success && idempotencyKeyHash) {
      harnessRunId = `harness-run-${randomBytes(12).toString("hex")}`;
      if (
        context.project.harness.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID
        && context.project.harness.preparation
      ) {
        const logsDirectory = join(options.dataDir, "harness-runs", harnessRunId);
        harnessExecutionPath = join(logsDirectory, "execution");
        try {
          if (typeof context.productionHarnessProjectionPath !== "string") {
            throw new Error("harness_projection_failed");
          }
          const executionSnapshot = await materializeProductionHarnessExecutionSnapshot({
            sourcePath: context.productionHarnessProjectionPath,
            destinationPath: harnessExecutionPath,
            projectPath: context.project.canonicalPath,
            preparation: context.project.harness.preparation,
            retainedInputPaths: prepared.retainedExecutionInputs,
          });
          harnessExecutionPath = executionSnapshot.path;
          retainedHarnessExecutionInputs = executionSnapshot.retainedExecutionInputs;
        } catch (error) {
          const typedCode = error instanceof Error ? error.message : "";
          code = new Set([
            "harness_projection_collision",
            "harness_projection_failed",
          ]).has(typedCode) ? typedCode : "harness_projection_failed";
          harnessExecutionPath = null;
          retainedHarnessExecutionInputs = [];
          await rm(logsDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }

    if (code || !context || !prepared || !parameters.success || !idempotencyKeyHash) {
      const failureCode = code ?? "mutation_contract_invalid";
      const retryablePreparationFailures = new Set([
        "project_not_found",
        "harness_pin_unreadable",
        "harness_adapter_bytes_mismatch",
        "harness_compatibility_unsupported",
        "harness_skill_lock_missing",
        "harness_skill_lock_invalid",
        "harness_locked_skill_unavailable",
        "harness_skill_integrity_mismatch",
        "harness_projection_collision",
        "harness_projection_failed",
        "harness_execution_runtime_unavailable",
        "harness_worker_provider_unavailable",
      ]);
      const auditId = await options.recordAudit("harness.run.launch", "rejected", {
        code: failureCode,
        authorizationClass,
        idempotencyKeyHash,
        hostId: parsedHostId,
        projectId: projectIdSchema.safeParse(request.projectId).success
          ? request.projectId
          : null,
        harnessId: context?.harness?.harnessId ?? null,
        source: ["controller-cli", "cockpit"].includes(request.source)
          ? request.source
          : null,
        harnessRunCreated: false,
        adapterStarted: false,
        projectWrite: false,
      });
      const response = {
        type: "harness.run.launch.failure",
        requestId: typeof request.requestId === "string"
          ? request.requestId
          : "invalid-request",
        code: failureCode,
        retryable: retryablePreparationFailures.has(failureCode),
        authorizationClass,
        idempotencyKeyHash,
        idempotentReplay: false,
        auditId,
        prohibitedSideEffects: {
          harnessRunCreated: false,
          adapterStarted: false,
          projectWrite: false,
        },
      };
      if (idempotencyKeyHash) {
        retained.launchOutcomes.push({ idempotencyKeyHash, requestFingerprint, response });
        await runtime.persist(retained);
      }
      return response;
    }

    harnessRunId ??= `harness-run-${randomBytes(12).toString("hex")}`;
    const createdAt = now().toISOString();
    const auditId = `audit-${randomBytes(12).toString("hex")}`;
    const run = storedRunSchema.parse({
      harnessRunId,
      revision: 1,
      status: "starting",
      hostId: parsedHostId,
      projectId: context.project.projectId,
      harnessId: context.harness.harnessId,
      harnessPinnedRevision: context.harness.immutableRevision,
      adapterId: prepared.adapterId,
      adapterProtocol: prepared.adapterProtocol,
      adapterEntryPoint: prepared.adapterEntryPoint,
      parameters: parameters.data,
      source: request.source,
      controllerId: request.controllerId,
      controllerSessionId: request.controllerSessionId,
      createdAt,
      adapterReadyAt: null,
      completedAt: null,
      launchAuditId: auditId,
      launchIdempotencyKeyHash: idempotencyKeyHash,
      cancellation: null,
      recovery: null,
      executionSnapshot: {
        schemaVersion: 1,
        capture: "launch",
        hostId: parsedHostId,
        projectRegistration: {
          projectId: context.project.projectId,
          revision: context.project.revision,
          displayName: context.project.displayName,
        },
        harness: {
          harnessId: context.harness.harnessId,
          revision: context.harness.revision,
          name: context.harness.name,
          pinnedRevision: context.harness.immutableRevision,
        },
        adapter: {
          adapterId: prepared.adapterId,
          protocol: prepared.adapterProtocol,
          entryPoint: prepared.adapterEntryPoint,
        },
        parameters: parameters.data,
        source: request.source,
        attribution: {
          controllerId: request.controllerId,
          controllerSessionId: request.controllerSessionId,
        },
        createdAt,
        credentialCapabilityReferences: prepared.suppliedCapabilities,
        productionHarness: context.project.harness.adapterId
          === SANDCASTLE_HARNESS_ADAPTER_ID
          && context.project.harness.preparation
          ? {
              skillSetLockDigest:
                context.project.harness.preparation.skillSetLockDigest,
              resolvedSkills: structuredClone(
                context.project.harness.preparation.resolvedSkills,
              ),
              executionRuntimeInputs: structuredClone(
                context.project.harness.preparation.executionRuntimeInputs,
              ),
              projectionDigest: context.project.harness.preparation.projection.digest,
            }
          : null,
        launchAuditId: auditId,
      },
      events: [],
      outcome: null,
      terminalEnvelopeValidation: {
        adapterReadyObserved: false,
        validTerminalEnvelopeCount: 0,
        exactlyOne: false,
        adapterChannelClosedObserved: false,
        processExitObserved: false,
      },
      logStreams: [
        {
          streamId: `harness-log-${randomBytes(12).toString("hex")}`,
          producer: "stdout",
          availableStart: 0,
          availableEnd: 0,
          explicitRetrievalRequired: true,
          insertedIntoControllerConversation: false,
        },
        {
          streamId: `harness-log-${randomBytes(12).toString("hex")}`,
          producer: "stderr",
          availableStart: 0,
          availableEnd: 0,
          explicitRetrievalRequired: true,
          insertedIntoControllerConversation: false,
        },
      ],
    });
    appendEvent(run, "harness_run_created");
    const logsDirectory = join(options.dataDir, "harness-runs", harnessRunId);
    await ensurePrivateDirectory(logsDirectory);
    await Promise.all([
      writeFile(logPath(options.dataDir, harnessRunId, "stdout"), Buffer.alloc(0), {
        mode: PRIVATE_FILE_MODE,
      }),
      writeFile(logPath(options.dataDir, harnessRunId, "stderr"), Buffer.alloc(0), {
        mode: PRIVATE_FILE_MODE,
      }),
    ]);
    retained.runs.push(run);
    const response = {
      type: "harness.run.launch.result",
      requestId: request.requestId,
      code: "harness_run_created",
      authorizationClass,
      idempotencyKeyHash,
      revision: run.revision,
      idempotentReplay: false,
      auditId,
      run: publicRun(run),
    };
    retained.launchOutcomes.push({ idempotencyKeyHash, requestFingerprint, response });
    // Everything needed to replay the accepted result and repair its audit is
    // now present in one atomic Host-private snapshot. No accepted audit is
    // published before this canonical commit.
    await options.faultInjector?.("harness_run_launch.before_commit");
    await runtime.persist(retained);
    // The Host-private snapshot is already sufficient for exact replay here,
    // but the accepted audit may still need idempotent publication after an
    // interruption. Keep this repairable window distinct from the completed
    // launch commit boundary.
    await options.faultInjector?.("harness_run_launch.after_state_commit");
    await runtime.ensureAcceptedLaunchAudits(retained);
    await options.faultInjector?.("harness_run_launch.after_commit");
    setImmediate(() => {
      const operation = runtime.supervise(structuredClone(run), {
        ...context,
        parameters: structuredClone(parameters.data),
        harnessExecutionPath,
        retainedHarnessExecutionInputs,
        cancellationGraceMs,
        hostLossTerminationEvidencePath: join(
          options.dataDir,
          "harness-runs",
          run.harnessRunId,
          "host-loss-termination.json",
        ),
      });
      runtime.supervisionOperations.add(operation);
      void operation.then(
        () => runtime.supervisionOperations.delete(operation),
        () => runtime.supervisionOperations.delete(operation),
      );
      void operation.catch(() => undefined);
    });
    return response;
  });

  return { launch };
};
