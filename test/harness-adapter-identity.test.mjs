import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import test from "node:test";
import { runtimeControlEnvelopeSchema } from "../src/browser-protocol.mjs";
import {
  CONFORMANCE_HARNESS_ADAPTER_ID,
  SANDCASTLE_HARNESS_ADAPTER_ID,
} from "../src/harness-adapter-identity.mjs";
import {
  harnessRegistrationSchema,
  projectPreparationProjection,
  projectRegistrationSchema,
} from "../src/project-registration.mjs";
import {
  createHarnessRunManager,
  harnessRunExecutionSnapshotSchema,
  harnessRunOutcomeSchema,
  harnessRunSchema,
  retainedLegacyHarnessRunSchema,
} from "../src/harness-runs.mjs";
import { validateHarnessLaunch } from "../src/harness-launch.mjs";
import { ProtocolError, writeFrame } from "../src/protocol.mjs";

const execFileAsync = promisify(execFile);

const harnessId = `harness-${"1".repeat(24)}`;
const projectId = `project-${"2".repeat(24)}`;
const hostId = `host-${"3".repeat(24)}`;
const controllerId = `runtime-${"4".repeat(24)}`;
const pinnedRevision = "5".repeat(40);
const launchAuditId = `audit-${"6".repeat(24)}`;
const createdAt = "2026-08-10T11:00:00.000Z";

const productionPreparation = () => ({
  status: "ready",
  harness: {
    harnessId,
    adapterId: SANDCASTLE_HARNESS_ADAPTER_ID,
    pinnedRevision,
  },
  skillSetLockDigest: `sha256:${"a".repeat(64)}`,
  resolvedSkills: [{
    identity: "sandking.issue-implementation",
    revision: pinnedRevision,
    contentIntegrity: `sha256:${"b".repeat(64)}`,
  }],
  executionRuntimeInputs: [{
    identity: "openai.codex-cli",
    package: "@openai/codex",
    version: "0.146.0",
    resolved: "https://registry.npmjs.org/@openai/codex/-/codex-0.146.0.tgz",
    integrity: "sha512-YWJjZA==",
    skillExposure: "versioned-with-runtime-package",
  }],
  projection: {
    path: `.sandking/harnesses/${harnessId}`,
    digest: `sha256:${"c".repeat(64)}`,
    ignored: true,
    trackedContentPreserved: true,
  },
});

const harnessRegistration = (adapterId, kind, includeLaunchParameters = true) => ({
  harnessId,
  revision: 1,
  name: kind === "conformance"
    ? "Sand-King Conformance Harness"
    : "Bundled Sandcastle Harness",
  adapterId,
  kind,
  immutableRevision: pinnedRevision,
  ...(includeLaunchParameters ? { launchParameters: { kind: "none" } } : {}),
  workspace: {
    kind: "harness-workspace",
    versionControl: "git",
    independent: true,
    headRevision: pinnedRevision,
  },
});

const projectRegistration = (adapterId) => ({
  projectId,
  revision: 2,
  displayName: "Identity fixture",
  canonicalPath: "/tmp/identity-fixture",
  status: "active",
  versionControl: { kind: "git", detected: true },
  configuration: {
    issueWorkflow: { provider: "github", kind: "issues" },
    checks: [{ checkId: "test", command: "npm test" }],
  },
  harness: {
    harnessId,
    name: "Bundled Harness",
    adapterId,
    pinnedRevision,
    boundedConfiguration: {
      adapterProtocol: "1.0.0",
      launchProfile: "delegated-work",
    },
    ...(adapterId === SANDCASTLE_HARNESS_ADAPTER_ID
      ? { preparation: productionPreparation() }
      : {}),
  },
  readiness: {
    issueWorkflow: "ready",
    checks: "ready",
    configuration: "ready",
    harness: "ready",
    pin: "ready",
    launchRequest: "ready",
    diagnostics: [],
  },
});

const executionSnapshot = (adapterId) => ({
  schemaVersion: 1,
  capture: "launch",
  hostId,
  projectRegistration: { projectId, revision: 2, displayName: "Identity fixture" },
  harness: {
    harnessId,
    revision: 1,
    name: "Bundled Harness",
    pinnedRevision,
  },
  adapter: {
    adapterId,
    protocol: "1.0.0",
    entryPoint: "adapters/bundled.mjs",
  },
  parameters: {},
  source: "controller-cli",
  attribution: { controllerId, controllerSessionId: null },
  createdAt,
  credentialCapabilityReferences: ["project.git.read"],
  launchAuditId,
});

const harnessRun = (adapterId) => ({
  harnessRunId: `harness-run-${"7".repeat(24)}`,
  revision: 1,
  status: "starting",
  hostId,
  projectId,
  harnessId,
  harnessPinnedRevision: pinnedRevision,
  adapterId,
  adapterProtocol: "1.0.0",
  adapterEntryPoint: "adapters/bundled.mjs",
  parameters: {},
  source: "controller-cli",
  controllerId,
  controllerSessionId: null,
  createdAt,
  adapterReadyAt: null,
  completedAt: null,
  launchAuditId,
  executionSnapshot: executionSnapshot(adapterId),
  cancellation: null,
  recovery: null,
  launchIdempotencyKeyHash: null,
});

const retainedLegacyHarnessRun = (adapterId) => {
  const run = harnessRun(adapterId);
  delete run.parameters;
  delete run.source;
  delete run.launchAuditId;
  delete run.launchIdempotencyKeyHash;
  return {
    ...run,
    launchRequestId: `launch-request-${"8".repeat(24)}`,
    launchRequestRevision: 2,
    controllerSessionId: `controller-session-${"9".repeat(24)}`,
    startAuditId: `audit-${"a".repeat(24)}`,
  };
};

const harnessRunOutcome = (adapterId) => ({
  outcomeId: `harness-outcome-${"b".repeat(24)}`,
  status: "succeeded",
  code: "conformance_run_succeeded",
  completedAt: "2026-08-10T11:00:01.000Z",
  incompleteResult: false,
  result: { kind: "bounded-result" },
  diagnosticReferences: ["stdout", "stderr"].map((producer, index) => ({
    streamId: `harness-log-${String(index + 1).repeat(24)}`,
    producer,
    range: { start: 0, end: 0 },
    explicitRetrievalRequired: true,
    insertedIntoControllerConversation: false,
  })),
  terminalEnvelope: {
    terminalId: `harness-terminal-${"c".repeat(24)}`,
    status: "succeeded",
    adapterId,
    adapterProtocol: "1.0.0",
  },
  outcomeAuditId: null,
  interruption: null,
});

const harnessRunObservation = (runAdapterId, outcomeAdapterId) => ({
  type: "harness.run.observe.result",
  requestId: "observe-bundled-adapter-identity",
  code: "harness_run_observed",
  mode: "snapshot",
  resynchronization: null,
  run: harnessRun(runAdapterId),
  events: [],
  nextSequence: 0,
  outcome: harnessRunOutcome(outcomeAdapterId),
  logStreams: [],
  terminalEnvelopeValidation: null,
});

const retainedLegacyStartOutcome = (run) => ({
  type: "harness.run.start.result",
  requestId: "retained-legacy-bundled-adapter",
  code: "harness_run_created",
  authorizationClass: "approved_launch_request_execution",
  idempotencyKeyHash: `sha256:${"d".repeat(64)}`,
  expectedRevision: 2,
  launchRequestRevision: 2,
  revision: 3,
  idempotentReplay: false,
  auditId: `audit-${"e".repeat(24)}`,
  run,
});

const retainedHarnessRunLookupResult = (launchOutcome) => ({
  type: "harness.run.lookup.result",
  requestId: "lookup-retained-bundled-adapter",
  code: "harness_run_launch_outcome_found",
  idempotencyKeyHash: launchOutcome.idempotencyKeyHash,
  found: true,
  launchOutcome,
});

const projectHarnessPinResult = (projectAdapterId, harnessAdapterId, harnessKind) => ({
  type: "project.harness.pin.result",
  requestId: "pin-bundled-adapter-identity",
  code: "project_harness_pinned",
  authorizationClass: "host_local_project_configuration",
  idempotencyKeyHash: `sha256:${"f".repeat(64)}`,
  expectedRevision: 1,
  revision: 2,
  idempotentReplay: false,
  auditId: `audit-${"1".repeat(24)}`,
  project: projectRegistration(projectAdapterId),
  harness: harnessRegistration(harnessAdapterId, harnessKind),
});

const harnessRunRecoveryResult = (observation) => ({
  type: "harness.run.recover.result",
  requestId: "recover-bundled-adapter-identity",
  code: "harness_recovery_finalized",
  authorizationClass: "harness_run_recovery",
  idempotencyKeyHash: `sha256:${"2".repeat(64)}`,
  idempotentReplay: false,
  auditId: `audit-${"3".repeat(24)}`,
  harnessRunId: observation.run.harnessRunId,
  action: "finalize",
  run: observation.run,
  recovery: null,
  outcome: observation.outcome,
});

const runtimeHarnessRunObservation = (observation) => ({
  channel: "control",
  message: {
    type: "runtime.harness-run.observation",
    requestId: "runtime-observe-bundled-adapter-identity",
    observation,
  },
});

const runtimeHarnessRunRecoveryResult = (observation) => ({
  channel: "control",
  message: {
    type: "runtime.harness-run.recover-result",
    requestId: "runtime-recover-bundled-adapter-identity",
    outcome: harnessRunRecoveryResult(observation),
  },
});

test("Project, retained run, and browser-boundary models preserve either bundled identity", () => {
  for (const [adapterId, kind] of [
    [CONFORMANCE_HARNESS_ADAPTER_ID, "conformance"],
    [SANDCASTLE_HARNESS_ADAPTER_ID, "production"],
  ]) {
    const harness = harnessRegistrationSchema.parse(harnessRegistration(adapterId, kind));
    const project = projectRegistrationSchema.parse(projectRegistration(adapterId));
    const snapshot = harnessRunExecutionSnapshotSchema.parse(executionSnapshot(adapterId));
    const run = harnessRunSchema.parse(harnessRun(adapterId));
    const projection = projectPreparationProjection(project, harness);
    const outcome = harnessRunOutcomeSchema.parse({
      outcomeId: `harness-outcome-${"8".repeat(24)}`,
      status: "succeeded",
      code: "conformance_run_succeeded",
      completedAt: "2026-08-10T11:00:01.000Z",
      incompleteResult: false,
      result: { kind: "bounded-result" },
      diagnosticReferences: ["stdout", "stderr"].map((producer, index) => ({
        streamId: `harness-log-${String(index + 1).repeat(24)}`,
        producer,
        range: { start: 0, end: 0 },
        explicitRetrievalRequired: true,
        insertedIntoControllerConversation: false,
      })),
      terminalEnvelope: {
        terminalId: `harness-terminal-${"9".repeat(24)}`,
        status: "succeeded",
        adapterId,
        adapterProtocol: "1.0.0",
      },
      outcomeAuditId: null,
      interruption: null,
    });

    assert.equal(harness.adapterId, adapterId);
    assert.equal(project.harness.adapterId, adapterId);
    assert.equal(snapshot.adapter.adapterId, adapterId);
    assert.equal(run.adapterId, adapterId);
    assert.equal(run.executionSnapshot.adapter.adapterId, adapterId);
    assert.equal(projection.current.harness.adapterId, adapterId);
    assert.equal(outcome.terminalEnvelope.adapterId, adapterId);
  }

  const retainedConformance = harnessRegistrationSchema.parse(harnessRegistration(
    CONFORMANCE_HARNESS_ADAPTER_ID,
    "conformance",
    false,
  ));
  assert.equal(retainedConformance.launchParameters.kind, "fields");
  assert.equal(harnessRegistrationSchema.safeParse(harnessRegistration(
    SANDCASTLE_HARNESS_ADAPTER_ID,
    "production",
    false,
  )).success, false);
  assert.equal(harnessRegistrationSchema.safeParse(harnessRegistration(
    SANDCASTLE_HARNESS_ADAPTER_ID,
    "conformance",
  )).success, false);

  for (const unknownAdapterId of ["unknown-adapter-v1", ""]) {
    assert.equal(projectRegistrationSchema.safeParse(
      projectRegistration(unknownAdapterId),
    ).success, false);
    assert.equal(harnessRunSchema.safeParse(harnessRun(unknownAdapterId)).success, false);
  }

  const mismatchedSnapshot = harnessRun(CONFORMANCE_HARNESS_ADAPTER_ID);
  mismatchedSnapshot.executionSnapshot.adapter.adapterId = SANDCASTLE_HARNESS_ADAPTER_ID;
  assert.equal(harnessRunSchema.safeParse(mismatchedSnapshot).success, false);
});

test("retained and public composite models preserve agreements and reject every disagreement", () => {
  for (const [adapterId, kind] of [
    [CONFORMANCE_HARNESS_ADAPTER_ID, "conformance"],
    [SANDCASTLE_HARNESS_ADAPTER_ID, "production"],
  ]) {
    const legacyRun = retainedLegacyHarnessRun(adapterId);
    assert.equal(retainedLegacyHarnessRunSchema.parse(legacyRun).adapterId, adapterId);
    assert.doesNotThrow(() => writeFrame(
      new PassThrough(),
      retainedHarnessRunLookupResult(retainedLegacyStartOutcome(legacyRun)),
    ));
    assert.equal(
      projectPreparationProjection(
        projectRegistration(adapterId),
        harnessRegistration(adapterId, kind),
      ).current.harness.adapterId,
      adapterId,
    );
    assert.doesNotThrow(() => writeFrame(
      new PassThrough(),
      projectHarnessPinResult(adapterId, adapterId, kind),
    ));
    const observation = harnessRunObservation(adapterId, adapterId);
    assert.doesNotThrow(() => writeFrame(new PassThrough(), observation));
    assert.equal(runtimeControlEnvelopeSchema.safeParse(
      runtimeHarnessRunObservation(observation),
    ).success, true);
    assert.doesNotThrow(() => writeFrame(
      new PassThrough(),
      harnessRunRecoveryResult(observation),
    ));
    assert.equal(runtimeControlEnvelopeSchema.safeParse(
      runtimeHarnessRunRecoveryResult(observation),
    ).success, true);
  }

  for (const [retainedAdapterId, nestedAdapterId, nestedKind] of [
    [CONFORMANCE_HARNESS_ADAPTER_ID, SANDCASTLE_HARNESS_ADAPTER_ID, "production"],
    [SANDCASTLE_HARNESS_ADAPTER_ID, CONFORMANCE_HARNESS_ADAPTER_ID, "conformance"],
  ]) {
    const legacyRun = retainedLegacyHarnessRun(retainedAdapterId);
    legacyRun.executionSnapshot.adapter.adapterId = nestedAdapterId;
    assert.equal(retainedLegacyHarnessRunSchema.safeParse(legacyRun).success, false);

    assert.throws(
      () => writeFrame(
        new PassThrough(),
        retainedHarnessRunLookupResult(retainedLegacyStartOutcome(legacyRun)),
      ),
      (error) => error instanceof ProtocolError && error.code === "frame_schema_invalid",
    );

    assert.throws(
      () => projectPreparationProjection(
        projectRegistration(retainedAdapterId),
        harnessRegistration(nestedAdapterId, nestedKind),
      ),
      /Harness adapter identities disagree/,
    );

    assert.throws(
      () => writeFrame(
        new PassThrough(),
        projectHarnessPinResult(retainedAdapterId, nestedAdapterId, nestedKind),
      ),
      (error) => error instanceof ProtocolError && error.code === "frame_schema_invalid",
    );

    const observation = harnessRunObservation(retainedAdapterId, nestedAdapterId);
    assert.throws(
      () => writeFrame(new PassThrough(), observation),
      (error) => error instanceof ProtocolError && error.code === "frame_schema_invalid",
    );
    assert.equal(runtimeControlEnvelopeSchema.safeParse(
      runtimeHarnessRunObservation(observation),
    ).success, false);

    assert.throws(
      () => writeFrame(new PassThrough(), harnessRunRecoveryResult(observation)),
      (error) => error instanceof ProtocolError && error.code === "frame_schema_invalid",
    );
    assert.equal(runtimeControlEnvelopeSchema.safeParse(
      runtimeHarnessRunRecoveryResult(observation),
    ).success, false);
  }
});

const createPinnedAdapterFixture = async (root, name, {
  declaredAdapterId,
  retainedAdapterId = declaredAdapterId,
  projectAdapterId = retainedAdapterId,
  probeAdapterId = declaredAdapterId,
  preparedAdapterId = declaredAdapterId,
  declaredProtocol = "1.0.0",
  probeProtocol = declaredProtocol,
  preparedProtocol = declaredProtocol,
  entryPoint = "adapters/bundled.mjs",
  preparedType = "harness.launch.prepared",
  readyAdapterId = declaredAdapterId,
  progressAdapterId = declaredAdapterId,
  terminalAdapterId = declaredAdapterId,
}) => {
  const workspacePath = join(root, name);
  const invocationMarker = join(workspacePath, "probe-invoked");
  const preparationMarker = join(workspacePath, "prepare-invoked");
  const runMarker = join(workspacePath, "run-invoked");
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", workspacePath]);
  await writeFile(
    join(workspacePath, ".git", "info", "exclude"),
    "probe-invoked\nprepare-invoked\nrun-invoked\n",
  );
  await mkdir(join(workspacePath, "adapters"), { recursive: true });
  await writeFile(join(workspacePath, "harness.json"), `${JSON.stringify({
    schemaVersion: 1,
    name: "Bundled identity fixture",
    compatibility: {
      adapterId: declaredAdapterId,
      adapterProtocol: declaredProtocol,
      entryPoint,
    },
  }, null, 2)}\n`);
  await writeFile(join(workspacePath, "adapters", "bundled.mjs"), `
import { appendFileSync, writeSync } from "node:fs";
const writeFrame = (message) => {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.byteLength, 0);
  writeSync(3, header);
  writeSync(3, body);
};
const [command, encodedExecution] = process.argv.slice(2);
if (command === "probe") {
  appendFileSync("probe-invoked", "probe\\n");
  writeFrame({
    type: "harness.adapter.probe",
    adapterProtocol: ${JSON.stringify(probeProtocol)},
    adapterId: ${JSON.stringify(probeAdapterId)},
    capabilities: ["harness.launch.prepare.v1", "harness.run.v1"],
    launchParameters: { kind: "none" },
  });
} else if (command === "prepare") {
  appendFileSync("prepare-invoked", "prepare\\n");
  writeFrame({
    type: ${JSON.stringify(preparedType)},
    adapterProtocol: ${JSON.stringify(preparedProtocol)},
    adapterId: ${JSON.stringify(preparedAdapterId)},
    negotiatedCapabilities: ["harness.launch.prepare.v1"],
    suppliedCapabilities: ["project.git.read"],
    sanitizedPreview: { summary: "Prepare the bounded fixture", secretFree: true },
    sideEffects: {
      delegatedWorkStarted: false,
      projectWrite: false,
      harnessWorkspaceWrite: false,
    },
  });
} else if (command === "run") {
  appendFileSync("run-invoked", "run\\n");
  const execution = JSON.parse(Buffer.from(encodedExecution, "base64url").toString("utf8"));
  const now = () => new Date().toISOString();
  writeFrame({
    type: "harness.run.ready",
    adapterProtocol: ${JSON.stringify(declaredProtocol)},
    adapterId: ${JSON.stringify(readyAdapterId)},
    harnessRunId: execution.harnessRunId,
    capabilities: ["harness.run.v1"],
    readyAt: now(),
  });
  writeFrame({
    type: "harness.run.progress",
    adapterProtocol: ${JSON.stringify(declaredProtocol)},
    adapterId: ${JSON.stringify(progressAdapterId)},
    harnessRunId: execution.harnessRunId,
    record: {
      recordId: "progress-${"c".repeat(24)}",
      schemaVersion: "1.0.0",
      type: "bounded.step",
      parentRecordId: null,
      label: "Exercise ordinary launch",
      summary: "The retained bundled identity crossed the public launch seam.",
      status: "complete",
      timestamp: now(),
      payload: { adapterId: ${JSON.stringify(progressAdapterId)} },
    },
  });
  writeFrame({
    type: "harness.run.terminal",
    adapterProtocol: ${JSON.stringify(declaredProtocol)},
    adapterId: ${JSON.stringify(terminalAdapterId)},
    harnessRunId: execution.harnessRunId,
    terminalId: "harness-terminal-${"d".repeat(24)}",
    status: "succeeded",
    completedAt: now(),
    result: { kind: "bounded-result" },
  });
}
`);
  await execFileAsync("git", ["-C", workspacePath, "add", "."]);
  await execFileAsync("git", [
    "-C", workspacePath,
    "-c", "user.name=Sand-King Test",
    "-c", "user.email=sandking-test@example.invalid",
    "commit", "--quiet", "-m", "fixture",
  ]);
  const { stdout } = await execFileAsync("git", ["-C", workspacePath, "rev-parse", "HEAD"]);
  const pinned = stdout.trim();
  return {
    workspacePath,
    invocationMarker,
    preparationMarker,
    runMarker,
    context: {
      harnessWorkspacePath: workspacePath,
      project: {
        projectId,
        revision: 2,
        displayName: "Identity fixture",
        harness: {
          harnessId,
          name: "Bundled Harness",
          adapterId: projectAdapterId,
          pinnedRevision: pinned,
          boundedConfiguration: {
            adapterProtocol: declaredProtocol,
            launchProfile: "delegated-work",
          },
        },
      },
      harness: {
        harnessId,
        revision: 1,
        name: "Bundled Harness",
        adapterId: retainedAdapterId,
        immutableRevision: pinned,
        launchParameters: { kind: "none" },
      },
    },
  };
};

const pathExists = (path) => access(path).then(() => true, () => false);

test("pinned launch compatibility accepts agreement and rejects every identity disagreement", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-adapter-identities-"));
  try {
    for (const adapterId of [
      CONFORMANCE_HARNESS_ADAPTER_ID,
      SANDCASTLE_HARNESS_ADAPTER_ID,
    ]) {
      const fixture = await createPinnedAdapterFixture(root, `accepted-${adapterId}`, {
        declaredAdapterId: adapterId,
      });
      const prepared = await validateHarnessLaunch(fixture.context, {});
      assert.equal(prepared.adapterId, adapterId);
      assert.equal(await pathExists(fixture.invocationMarker), true);
      assert.equal(await pathExists(fixture.preparationMarker), true);
    }

    for (const [declaredAdapterId, retainedAdapterId] of [
      [CONFORMANCE_HARNESS_ADAPTER_ID, SANDCASTLE_HARNESS_ADAPTER_ID],
      [SANDCASTLE_HARNESS_ADAPTER_ID, CONFORMANCE_HARNESS_ADAPTER_ID],
    ]) {
      const fixture = await createPinnedAdapterFixture(
        root,
        `retained-mismatch-${declaredAdapterId}`,
        { declaredAdapterId, retainedAdapterId },
      );
      await assert.rejects(
        validateHarnessLaunch(fixture.context, {}),
        /harness_adapter_protocol_invalid/,
      );
      assert.equal(await pathExists(fixture.invocationMarker), false);
      assert.equal(await pathExists(fixture.preparationMarker), false);
    }

    for (const [retainedAdapterId, projectAdapterId] of [
      [CONFORMANCE_HARNESS_ADAPTER_ID, SANDCASTLE_HARNESS_ADAPTER_ID],
      [SANDCASTLE_HARNESS_ADAPTER_ID, CONFORMANCE_HARNESS_ADAPTER_ID],
    ]) {
      const fixture = await createPinnedAdapterFixture(
        root,
        `project-mismatch-${retainedAdapterId}`,
        { declaredAdapterId: retainedAdapterId, retainedAdapterId, projectAdapterId },
      );
      await assert.rejects(
        validateHarnessLaunch(fixture.context, {}),
        /harness_adapter_protocol_invalid/,
      );
      assert.equal(await pathExists(fixture.invocationMarker), false);
      assert.equal(await pathExists(fixture.preparationMarker), false);
    }

    for (const [declaredAdapterId, messageAdapterId] of [
      [CONFORMANCE_HARNESS_ADAPTER_ID, SANDCASTLE_HARNESS_ADAPTER_ID],
      [SANDCASTLE_HARNESS_ADAPTER_ID, CONFORMANCE_HARNESS_ADAPTER_ID],
    ]) {
      const probeMismatch = await createPinnedAdapterFixture(
        root,
        `probe-mismatch-${declaredAdapterId}`,
        { declaredAdapterId, probeAdapterId: messageAdapterId },
      );
      await assert.rejects(
        validateHarnessLaunch(probeMismatch.context, {}),
        /harness_adapter_protocol_invalid/,
      );
      assert.equal(await pathExists(probeMismatch.invocationMarker), true);
      assert.equal(await pathExists(probeMismatch.preparationMarker), false);

      const preparedMismatch = await createPinnedAdapterFixture(
        root,
        `prepared-mismatch-${declaredAdapterId}`,
        { declaredAdapterId, preparedAdapterId: messageAdapterId },
      );
      await assert.rejects(
        validateHarnessLaunch(preparedMismatch.context, {}),
        /harness_adapter_protocol_invalid/,
      );
      assert.equal(await pathExists(preparedMismatch.preparationMarker), true);
    }

    for (const [name, overrides] of [
      ["unknown", { declaredAdapterId: "third-party-harness-adapter-v1" }],
      ["protocol", {
        declaredAdapterId: SANDCASTLE_HARNESS_ADAPTER_ID,
        declaredProtocol: "2.0.0",
      }],
      ["entry-point", {
        declaredAdapterId: SANDCASTLE_HARNESS_ADAPTER_ID,
        entryPoint: "../outside.mjs",
      }],
    ]) {
      const fixture = await createPinnedAdapterFixture(root, `invalid-${name}`, overrides);
      await assert.rejects(
        validateHarnessLaunch(fixture.context, {}),
        /harness_adapter_protocol_invalid/,
      );
      assert.equal(await pathExists(fixture.invocationMarker), false);
      assert.equal(await pathExists(fixture.preparationMarker), false);
    }


    for (const [name, overrides, preparationExpected] of [
      ["probe-protocol", {
        declaredAdapterId: SANDCASTLE_HARNESS_ADAPTER_ID,
        probeProtocol: "1.1.0",
      }, false],
      ["prepared-protocol", {
        declaredAdapterId: SANDCASTLE_HARNESS_ADAPTER_ID,
        preparedProtocol: "1.1.0",
      }, true],
    ]) {
      const fixture = await createPinnedAdapterFixture(root, name, overrides);
      await assert.rejects(
        validateHarnessLaunch(fixture.context, {}),
        /harness_adapter_protocol_invalid/,
      );
      assert.equal(await pathExists(fixture.preparationMarker), preparationExpected);
    }

    const wrongPreparedType = await createPinnedAdapterFixture(root, "wrong-prepared-type", {
      declaredAdapterId: SANDCASTLE_HARNESS_ADAPTER_ID,
      preparedType: "harness.adapter.probe",
    });
    await assert.rejects(
      validateHarnessLaunch(wrongPreparedType.context, {}),
      /harness_adapter_protocol_invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const observeTerminalRun = async (manager, harnessRunId) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const observation = await manager.observe({
      requestId: `observe-${harnessRunId}`,
      harnessRunId,
      afterSequence: 0,
    });
    if (["succeeded", "failed", "cancelled"].includes(observation.run?.status)) {
      await manager.waitForIdle();
      return observation;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("harness_run_terminal_timeout");
};

test("ordinary launch and observation retain both identities and reject mismatched run messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandking-adapter-run-identities-"));
  try {
    for (const adapterId of [
      CONFORMANCE_HARNESS_ADAPTER_ID,
      SANDCASTLE_HARNESS_ADAPTER_ID,
    ]) {
      const fixture = await createPinnedAdapterFixture(root, `run-${adapterId}`, {
        declaredAdapterId: adapterId,
      });
      const manager = await createHarnessRunManager({
        dataDir: join(root, `state-${adapterId}`),
        hostId,
        recordAudit: async (_action, _outcome, _details, requestedAuditId) =>
          requestedAuditId ?? `audit-${"a".repeat(24)}`,
        loadLaunchContext: async () => fixture.context,
      });
      const launched = await manager.launch({
        requestId: `launch-${adapterId}`,
        projectId,
        parameters: {},
        controllerId,
        controllerSessionId: null,
        source: "cockpit",
        authorizationClass: "harness_run_launch",
        idempotencyKey: `launch-${adapterId}`,
      });
      assert.equal(launched.type, "harness.run.launch.result");
      const observed = await observeTerminalRun(manager, launched.run.harnessRunId);
      assert.equal(observed.run.status, "succeeded");
      assert.equal(observed.run.adapterId, adapterId);
      assert.equal(observed.run.executionSnapshot.adapter.adapterId, adapterId);
      assert.equal(observed.outcome.terminalEnvelope.adapterId, adapterId);
      assert.deepEqual(observed.events.map((event) => event.type), [
        "harness_run_created",
        "harness_adapter_ready",
        "harness_progress_published",
        "harness_run_succeeded",
      ]);
    }

    for (const [declaredAdapterId, mismatchedAdapterId] of [
      [CONFORMANCE_HARNESS_ADAPTER_ID, SANDCASTLE_HARNESS_ADAPTER_ID],
      [SANDCASTLE_HARNESS_ADAPTER_ID, CONFORMANCE_HARNESS_ADAPTER_ID],
    ]) {
      for (const messageType of ["ready", "progress", "terminal"]) {
        const fixture = await createPinnedAdapterFixture(
          root,
          `${messageType}-mismatch-${declaredAdapterId}`,
          {
            declaredAdapterId,
            [`${messageType}AdapterId`]: mismatchedAdapterId,
          },
        );
        const manager = await createHarnessRunManager({
          dataDir: join(root, `state-${messageType}-${declaredAdapterId}`),
          hostId,
          recordAudit: async (_action, _outcome, _details, requestedAuditId) =>
            requestedAuditId ?? `audit-${"b".repeat(24)}`,
          loadLaunchContext: async () => fixture.context,
        });
        const launched = await manager.launch({
          requestId: `launch-${messageType}-${declaredAdapterId}`,
          projectId,
          parameters: {},
          controllerId,
          controllerSessionId: null,
          source: "cockpit",
          authorizationClass: "harness_run_launch",
          idempotencyKey: `launch-${messageType}-${declaredAdapterId}`,
        });
        assert.equal(launched.type, "harness.run.launch.result");
        const observed = await observeTerminalRun(manager, launched.run.harnessRunId);
        assert.equal(observed.run.status, "failed");
        assert.equal(observed.outcome.code, "harness_adapter_protocol_invalid");
        assert.equal(observed.outcome.terminalEnvelope, null);
        assert.equal(observed.run.adapterId, declaredAdapterId);
        assert.equal(observed.events.some((event) =>
          event.progressRecord?.payload.adapterId === mismatchedAdapterId), false);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
