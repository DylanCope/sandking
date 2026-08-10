import assert from "node:assert/strict";
import test from "node:test";
import {
  harnessAdapterMessageSchema,
  conformanceHarnessLaunchParametersDeclaration,
  harnessCancellationRequestSchema,
  harnessCompatibilityManifestSchema,
  harnessAdapterProbeSchema,
  harnessLaunchParametersDeclarationSchema,
  harnessPreparedEnvelopeSchema,
  harnessProgressEnvelopeSchema,
  harnessReadyEnvelopeSchema,
  harnessTerminalEnvelopeSchema,
  legacyConformanceHarnessLaunchParametersDeclaration,
} from "../src/harness-adapter-protocol.mjs";
import {
  CONFORMANCE_HARNESS_ADAPTER_ID,
  SANDCASTLE_HARNESS_ADAPTER_ID,
  harnessAdapterIdSchema,
} from "../src/harness-adapter-identity.mjs";
import { validateDeclaredLaunchParameters } from "../src/harness-launch.mjs";

const fieldsDeclaration = {
  kind: "fields",
  fields: [
    {
      name: "issueNumber",
      label: "Issue number",
      valueType: "integer",
      required: false,
      minimum: 1,
      maximum: 999_999_999,
    },
    {
      name: "targetBranch",
      label: "Target branch",
      valueType: "string",
      required: false,
      minLength: 1,
      maxLength: 128,
    },
  ],
};

test("one bounded identity vocabulary governs every Harness adapter contract", () => {
  assert.deepEqual(harnessAdapterIdSchema.options, [
    "conformance-harness-adapter-v1",
    "sandcastle-harness-adapter-v1",
  ]);

  const harnessRunId = `harness-run-${"1".repeat(24)}`;
  const messages = [
    {
      schema: harnessAdapterProbeSchema,
      value: {
        type: "harness.adapter.probe",
        adapterProtocol: "1.0.0",
        capabilities: ["harness.launch.prepare.v1", "harness.run.v1"],
        launchParameters: { kind: "none" },
      },
    },
    {
      schema: harnessPreparedEnvelopeSchema,
      value: {
        type: "harness.launch.prepared",
        adapterProtocol: "1.0.0",
        negotiatedCapabilities: ["harness.launch.prepare.v1"],
        suppliedCapabilities: ["project.git.read"],
        sanitizedPreview: { summary: "Bounded adapter preparation", secretFree: true },
        sideEffects: {
          delegatedWorkStarted: false,
          projectWrite: false,
          harnessWorkspaceWrite: false,
        },
      },
    },
    {
      schema: harnessReadyEnvelopeSchema,
      value: {
        type: "harness.run.ready",
        adapterProtocol: "1.0.0",
        harnessRunId,
        capabilities: ["harness.run.v1"],
        readyAt: "2026-08-10T10:00:00.000Z",
      },
    },
    {
      schema: harnessCancellationRequestSchema,
      value: {
        type: "harness.run.cancel",
        adapterProtocol: "1.0.0",
        harnessRunId,
        cooperativeDeadlineAt: "2026-08-10T10:00:01.000Z",
      },
    },
    {
      schema: harnessProgressEnvelopeSchema,
      value: {
        type: "harness.run.progress",
        adapterProtocol: "1.0.0",
        harnessRunId,
        record: {
          recordId: `progress-${"2".repeat(24)}`,
          schemaVersion: "1.0.0",
          type: "bounded.step",
          parentRecordId: null,
          label: "Exercise identity contract",
          summary: "The bounded identity crossed the shared protocol seam.",
          status: "complete",
          timestamp: "2026-08-10T10:00:00.500Z",
          payload: {},
        },
      },
    },
    {
      schema: harnessTerminalEnvelopeSchema,
      value: {
        type: "harness.run.terminal",
        adapterProtocol: "1.0.0",
        harnessRunId,
        terminalId: `harness-terminal-${"3".repeat(24)}`,
        status: "succeeded",
        completedAt: "2026-08-10T10:00:02.000Z",
        result: { kind: "bounded-result" },
      },
    },
  ];

  for (const adapterId of [
    CONFORMANCE_HARNESS_ADAPTER_ID,
    SANDCASTLE_HARNESS_ADAPTER_ID,
  ]) {
    assert.equal(harnessAdapterIdSchema.parse(adapterId), adapterId);
    assert.equal(harnessCompatibilityManifestSchema.parse({
      schemaVersion: 1,
      name: "Bundled Harness",
      compatibility: {
        adapterId,
        adapterProtocol: "1.0.0",
        entryPoint: "adapters/bundled.mjs",
      },
    }).compatibility.adapterId, adapterId);
    for (const { schema, value } of messages) {
      assert.equal(schema.parse({ ...value, adapterId }).adapterId, adapterId);
      if (schema !== harnessCancellationRequestSchema) {
        assert.equal(harnessAdapterMessageSchema.parse({
          ...value,
          adapterId,
        }).adapterId, adapterId);
      }
    }
  }

  const unknownAdapterId = "third-party-harness-adapter-v1";
  assert.equal(harnessAdapterIdSchema.safeParse(unknownAdapterId).success, false);
  assert.equal(harnessCompatibilityManifestSchema.safeParse({
    schemaVersion: 1,
    name: "Unknown Harness",
    compatibility: {
      adapterId: unknownAdapterId,
      adapterProtocol: "1.0.0",
      entryPoint: "adapters/unknown.mjs",
    },
  }).success, false);
  for (const { schema, value } of messages) {
    assert.equal(schema.safeParse({ ...value, adapterId: unknownAdapterId }).success, false);
  }
});

test("the adapter handshake declares no parameters or its exact optional fields", () => {
  for (const launchParameters of [{ kind: "none" }, fieldsDeclaration]) {
    const probe = harnessAdapterProbeSchema.parse({
      type: "harness.adapter.probe",
      adapterProtocol: "1.0.0",
      adapterId: "conformance-harness-adapter-v1",
      capabilities: ["harness.launch.prepare.v1", "harness.run.v1"],
      launchParameters,
    });
    assert.deepEqual(probe.launchParameters, launchParameters);
  }

  assert.deepEqual(validateDeclaredLaunchParameters({ kind: "none" }, undefined), {});
  assert.deepEqual(validateDeclaredLaunchParameters(fieldsDeclaration, undefined), {});
  assert.deepEqual(validateDeclaredLaunchParameters(fieldsDeclaration, {
    issueNumber: 155,
    targetBranch: "sandcastle/issue-155",
  }), {
    issueNumber: 155,
    targetBranch: "sandcastle/issue-155",
  });
  assert.throws(
    () => validateDeclaredLaunchParameters({ kind: "none" }, { issueNumber: 155 }),
    /bounded_configuration_invalid/,
  );
  assert.equal(harnessLaunchParametersDeclarationSchema.safeParse({
    kind: "fields",
    fields: [fieldsDeclaration.fields[0], fieldsDeclaration.fields[0]],
  }).success, false);
});

test("a legacy conformance probe retains its required historical parameter declaration", () => {
  const probe = harnessAdapterProbeSchema.parse({
    type: "harness.adapter.probe",
    adapterProtocol: "1.0.0",
    adapterId: "conformance-harness-adapter-v1",
    capabilities: ["harness.launch.prepare.v1", "harness.run.v1"],
  });

  assert.deepEqual(
    probe.launchParameters,
    legacyConformanceHarnessLaunchParametersDeclaration,
  );
  assert.deepEqual(
    probe.launchParameters.fields.map(({ name, required }) => ({ name, required })),
    [
      { name: "issueNumber", required: true },
      { name: "targetBranch", required: true },
    ],
  );
  assert.notDeepEqual(
    probe.launchParameters,
    conformanceHarnessLaunchParametersDeclaration,
  );
});

test("only retained conformance probes receive the historical parameter default", () => {
  const probeWithoutDeclaration = {
    type: "harness.adapter.probe",
    adapterProtocol: "1.0.0",
    capabilities: ["harness.launch.prepare.v1", "harness.run.v1"],
  };
  assert.deepEqual(harnessAdapterProbeSchema.parse({
    ...probeWithoutDeclaration,
    adapterId: CONFORMANCE_HARNESS_ADAPTER_ID,
  }).launchParameters, legacyConformanceHarnessLaunchParametersDeclaration);
  assert.equal(harnessAdapterProbeSchema.safeParse({
    ...probeWithoutDeclaration,
    adapterId: SANDCASTLE_HARNESS_ADAPTER_ID,
  }).success, false);
});
