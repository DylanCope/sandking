import { writeSync } from "node:fs";

const adapterProtocol = "1.0.0";
const adapterId = "sandcastle-harness-adapter-v1";
const capabilities = ["harness.launch.prepare.v1", "harness.run.v1"];
const launchParameters = {
  kind: "fields",
  fields: [
    {
      name: "issueNumber",
      label: "Issue number",
      description: "Optional GitHub issue identifier for Sandcastle delivery.",
      cliFlag: "--issue",
      valueType: "integer",
      required: false,
      minimum: 1,
      maximum: 999999999
    },
    {
      name: "targetBranch",
      label: "Target branch",
      description: "Optional canonical sandcastle branch for the issue.",
      cliFlag: "--target-branch",
      valueType: "string",
      required: false,
      minLength: 1,
      maxLength: 128
    }
  ]
};

const writeFrame = (message) => {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.byteLength, 0);
  writeSync(3, header);
  writeSync(3, body);
};

const parseParameters = (encoded) => {
  let value;
  try {
    value = JSON.parse(Buffer.from(encoded ?? "", "base64url").toString("utf8"));
  } catch {
    throw new Error("bounded_configuration_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("bounded_configuration_invalid");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "issueNumber" && key !== "targetBranch")) {
    throw new Error("bounded_configuration_invalid");
  }
  if (value.issueNumber !== undefined && (
    !Number.isSafeInteger(value.issueNumber)
    || value.issueNumber < 1
    || value.issueNumber > 999999999
  )) {
    throw new Error("bounded_configuration_invalid");
  }
  if (value.targetBranch !== undefined && (
    typeof value.targetBranch !== "string"
    || value.targetBranch.length < 1
    || value.targetBranch.length > 128
  )) {
    throw new Error("bounded_configuration_invalid");
  }
  return value;
};

const [command, encodedParameters] = process.argv.slice(2);
if (command === "probe") {
  writeFrame({
    type: "harness.adapter.probe",
    adapterProtocol,
    adapterId,
    capabilities,
    launchParameters,
  });
} else if (command === "prepare") {
  const parameters = parseParameters(encodedParameters);
  writeFrame({
    type: "harness.launch.prepared",
    adapterProtocol,
    adapterId,
    negotiatedCapabilities: ["harness.launch.prepare.v1"],
    suppliedCapabilities: ["github.issues.read", "project.git.read"],
    sanitizedPreview: {
      summary: parameters.issueNumber
        ? `Delegate GitHub issue #${parameters.issueNumber} through the pinned Sandcastle Harness.`
        : "Delegate work through the pinned Sandcastle Harness.",
      secretFree: true,
    },
    sideEffects: {
      delegatedWorkStarted: false,
      projectWrite: false,
      harnessWorkspaceWrite: false,
    },
  });
} else {
  // Production run translation is delivered by issue #173. This seed still
  // crosses the established Host-facing probe and preparation boundary.
  throw new Error("production_sandcastle_delegation_unavailable");
}
