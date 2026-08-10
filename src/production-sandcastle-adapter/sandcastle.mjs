import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const adapterProtocol = "1.0.0";
const adapterId = "sandcastle-harness-adapter-v1";
const capabilities = ["harness.launch.prepare.v1", "harness.run.v1"];
const fixtureManifestName = "sandcastle.worker-fixture.json";
const controlledProviderKind = "controlled-worker-fixture";
const supportedScenarios = new Set([
  "succeeded",
  "succeeded-nonzero",
  "failed",
  "malformed-output",
  "nonzero-exit",
  "zero-exit",
  "duplicate-result",
  "diagnostic-only",
  "cancellable",
]);
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

const parseExecution = (encoded) => {
  let value;
  try {
    value = JSON.parse(Buffer.from(encoded ?? "", "base64url").toString("utf8"));
  } catch {
    throw new Error("harness_execution_invalid");
  }
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !/^harness-run-[a-f0-9]{24}$/.test(value.harnessRunId ?? "")
  ) {
    throw new Error("harness_execution_invalid");
  }
  return { harnessRunId: value.harnessRunId, parameters: parseParameters(
    Buffer.from(JSON.stringify(value.parameters ?? {}), "utf8").toString("base64url"),
  ) };
};

const projectRoot = () => execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: { LANG: "C.UTF-8" },
  timeout: 3_000,
}).trim();

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const inspectRuntime = () => {
  const workerEnvironment = readJson(join(process.cwd(), "worker-environment.json"));
  const runtimeReady = workerEnvironment?.schemaVersion === 1
    && workerEnvironment?.harness?.adapterId === adapterId
    && /^sha256:[a-f0-9]{64}$/.test(workerEnvironment?.skillSetLockDigest ?? "")
    && Array.isArray(workerEnvironment?.skills)
    && workerEnvironment.skills.length > 0
    && Array.isArray(workerEnvironment?.executionRuntimeInputs)
    && workerEnvironment.executionRuntimeInputs.length > 0;
  if (!runtimeReady) {
    return {
      ready: false,
      code: "harness_execution_runtime_unavailable",
      explanation: "The pinned execution runtime is unavailable or failed verification.",
    };
  }
  let root;
  try {
    root = projectRoot();
  } catch {
    return {
      ready: false,
      code: "harness_execution_runtime_unavailable",
      explanation: "The pinned execution runtime cannot resolve its Project.",
    };
  }
  const fixture = readJson(join(root, fixtureManifestName));
  if (fixture?.runtime?.ready === false) {
    return {
      ready: false,
      code: "harness_execution_runtime_unavailable",
      explanation: "The pinned execution runtime is unavailable or not ready.",
    };
  }
  const providerReady = fixture?.schemaVersion === 1
    && fixture?.provider?.kind === controlledProviderKind
    && fixture.provider.ready === true
    && supportedScenarios.has(fixture.scenario)
    && (fixture.artifact === undefined || (
      fixture.artifact
      && typeof fixture.artifact === "object"
      && !Array.isArray(fixture.artifact)
      && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(fixture.artifact.path ?? "")
      && typeof fixture.artifact.content === "string"
      && Buffer.byteLength(fixture.artifact.content, "utf8") <= 4_096
    ));
  if (!providerReady) {
    return {
      ready: false,
      code: "harness_worker_provider_unavailable",
      explanation: "The selected Worker provider is unavailable or not ready.",
    };
  }
  return { ready: true, root, fixture };
};

const writePreparationFailure = (failure) => writeFrame({
  type: "harness.launch.failure",
  adapterProtocol,
  adapterId,
  code: failure.code,
  retryable: true,
  sanitizedExplanation: failure.explanation,
  sideEffects: {
    delegatedWorkStarted: false,
    projectWrite: false,
    harnessWorkspaceWrite: false,
  },
});

const stableId = (prefix, ...parts) => `${prefix}-${createHash("sha256")
  .update(parts.join("\0"))
  .digest("hex")
  .slice(0, 24)}`;

const sanitizeDiagnostic = (source) => source
  .replace(/\b(token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

const runControlledWorker = async (execution, readiness) => {
  const now = () => new Date().toISOString();
  writeFrame({
    type: "harness.run.ready",
    adapterProtocol,
    adapterId,
    harnessRunId: execution.harnessRunId,
    capabilities: ["harness.run.v1"],
    readyAt: now(),
  });

  const workerPath = join(process.cwd(), ".sandcastle", "controlled-worker-fixture.mjs");
  const encodedWorkerParameters = Buffer.from(
    JSON.stringify(execution.parameters),
    "utf8",
  ).toString("base64url");
  const worker = spawn(process.execPath, [workerPath, encodedWorkerParameters], {
    cwd: readiness.root,
    env: { LANG: "C.UTF-8" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let cancelled = false;
  const cancelWorker = () => {
    if (cancelled) return;
    cancelled = true;
    worker.kill("SIGTERM");
  };
  process.on("SIGTERM", cancelWorker);
  const handleCancellationMessage = (message) => {
    if (
      message?.type === "harness.run.cancel"
      && message.adapterId === adapterId
      && message.adapterProtocol === adapterProtocol
      && message.harnessRunId === execution.harnessRunId
    ) {
      cancelWorker();
    }
  };
  process.on("message", handleCancellationMessage);

  let diagnosticBytes = 0;
  worker.stderr.on("data", (chunk) => {
    if (diagnosticBytes >= 16_384) return;
    const sanitized = Buffer.from(sanitizeDiagnostic(Buffer.from(chunk).toString("utf8")));
    const bounded = sanitized.subarray(0, 16_384 - diagnosticBytes);
    diagnosticBytes += bounded.byteLength;
    process.stderr.write(bounded);
  });
  let outputBytes = 0;
  let outputInvalid = false;
  let progressSequence = 0;
  const results = [];
  const lines = createInterface({ input: worker.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    outputBytes += Buffer.byteLength(line, "utf8") + 1;
    if (outputBytes > 65_536 || Buffer.byteLength(line, "utf8") > 32_768) {
      outputInvalid = true;
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      outputInvalid = true;
      return;
    }
    if (message?.type === "sandcastle.worker.progress") {
      if (
        results.length > 0
        || typeof message.label !== "string"
        || message.label.length < 1
        || message.label.length > 160
        || typeof message.summary !== "string"
        || message.summary.length < 1
        || message.summary.length > 512
        || typeof message.status !== "string"
        || message.status.length < 1
        || message.status.length > 64
      ) {
        outputInvalid = true;
        return;
      }
      progressSequence += 1;
      writeFrame({
        type: "harness.run.progress",
        adapterProtocol,
        adapterId,
        harnessRunId: execution.harnessRunId,
        record: {
          recordId: stableId("progress", execution.harnessRunId, String(progressSequence)),
          schemaVersion: "1.0.0",
          type: "sandcastle.worker",
          parentRecordId: null,
          label: message.label,
          summary: message.summary,
          status: message.status,
          timestamp: now(),
          payload: {
            provider: controlledProviderKind,
            sequence: progressSequence,
          },
        },
      });
      return;
    }
    if (
      message?.type !== "sandcastle.worker.result"
      || !["succeeded", "failed"].includes(message.status)
      || !message.result
      || typeof message.result !== "object"
      || Array.isArray(message.result)
      || Buffer.byteLength(JSON.stringify(message.result), "utf8") > 8_192
    ) {
      outputInvalid = true;
      return;
    }
    results.push(message);
  });
  const exit = await new Promise((resolve) => {
    worker.once("error", () => resolve({ code: null, startFailed: true }));
    worker.once("close", (code) => resolve({ code, startFailed: false }));
  });
  lines.close();
  process.removeListener("SIGTERM", cancelWorker);
  process.removeListener("message", handleCancellationMessage);
  if (process.connected) process.disconnect();

  let status;
  let result;
  if (cancelled) {
    status = "cancelled";
    result = { schemaVersion: 1, kind: "sandcastle.delegation", code: "cancelled" };
  } else if (outputInvalid) {
    status = "failed";
    result = {
      schemaVersion: 1,
      kind: "sandcastle.delegation",
      code: "worker_output_invalid",
    };
  } else if (results.length !== 1) {
    status = "failed";
    result = {
      schemaVersion: 1,
      kind: "sandcastle.delegation",
      code: results.length > 1 ? "worker_result_ambiguous" : "worker_result_missing",
    };
  } else {
    status = results[0].status;
    result = results[0].result;
  }
  if (exit.startFailed) {
    status = "failed";
    result = {
      schemaVersion: 1,
      kind: "sandcastle.delegation",
      code: "worker_start_failed",
    };
  }
  if (typeof result?.code === "string" && [
    "worker_output_invalid",
    "worker_result_ambiguous",
    "worker_result_missing",
    "worker_start_failed",
  ].includes(result.code)) {
    process.stderr.write(`sandcastle_${result.code}\n`);
  }
  writeFrame({
    type: "harness.run.terminal",
    adapterProtocol,
    adapterId,
    harnessRunId: execution.harnessRunId,
    terminalId: stableId("harness-terminal", execution.harnessRunId),
    status,
    completedAt: now(),
    result,
  });
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
  const readiness = inspectRuntime();
  if (!readiness.ready) {
    writePreparationFailure(readiness);
  } else {
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
  }
} else if (command === "run") {
  const execution = parseExecution(encodedParameters);
  const readiness = inspectRuntime();
  if (!readiness.ready) {
    const now = new Date().toISOString();
    writeFrame({
      type: "harness.run.ready",
      adapterProtocol,
      adapterId,
      harnessRunId: execution.harnessRunId,
      capabilities: ["harness.run.v1"],
      readyAt: now,
    });
    writeFrame({
      type: "harness.run.terminal",
      adapterProtocol,
      adapterId,
      harnessRunId: execution.harnessRunId,
      terminalId: stableId("harness-terminal", execution.harnessRunId),
      status: "failed",
      completedAt: now,
      result: {
        schemaVersion: 1,
        kind: "sandcastle.delegation",
        code: readiness.code,
      },
    });
  } else {
    await runControlledWorker(execution, readiness);
  }
} else {
  throw new Error("harness_adapter_command_invalid");
}
