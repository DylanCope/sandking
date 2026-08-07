import assert from "node:assert/strict";
import test from "node:test";
import {
  harnessAdapterProbeSchema,
  harnessLaunchParametersDeclarationSchema,
} from "../src/harness-adapter-protocol.mjs";
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
