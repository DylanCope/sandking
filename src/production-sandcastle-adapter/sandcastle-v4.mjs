import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const adapterProtocol = "1.0.0";
const adapterId = "sandcastle-harness-adapter-v1";
const capabilities = ["harness.launch.prepare.v1", "harness.run.v1"];
const controlledManifestName = "sandcastle.worker-fixture.json";
const realManifestName = "sandcastle.real-provider.json";
const controlledProviderKind = "controlled-worker-fixture";
const realProviderKind = "openai-codex";
const controlledWorkerRuntimePath = ".sandcastle/controlled-worker-fixture.mjs";
const realWorkerRuntimePath = ".sandcastle/real-worker-v2.mjs";
const codexVersion = "0.146.0";
const realSandboxImage = "sandcastle:sandking-real-worker";
const realSkillIdentities = [
  "sandking.issue-implementation",
  "sandking.issue-planning",
  "sandking.pull-request-review",
  "sandking.real-delegation",
];
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
      maximum: 999999999,
    },
    {
      name: "targetBranch",
      label: "Target branch",
      description: "Optional canonical sandcastle branch for the issue.",
      cliFlag: "--target-branch",
      valueType: "string",
      required: false,
      minLength: 1,
      maxLength: 128,
    },
  ],
};

const writeFrame = (message) => {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.byteLength, 0);
  writeSync(3, header);
  writeSync(3, body);
};

const readExact = (byteLength) => {
  const buffer = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const bytesRead = readSync(3, buffer, offset, byteLength - offset);
    if (bytesRead === 0) throw new Error("harness_run_start_invalid");
    offset += bytesRead;
  }
  return buffer;
};

const readRunStart = (execution) => {
  const header = readExact(4);
  const frameLength = header.readUInt32BE(0);
  if (frameLength < 1 || frameLength > 32_768) {
    throw new Error("harness_run_start_invalid");
  }
  let message;
  try {
    message = JSON.parse(readExact(frameLength).toString("utf8"));
  } catch {
    throw new Error("harness_run_start_invalid");
  }
  if (
    !message
    || typeof message !== "object"
    || Array.isArray(message)
    || Object.keys(message).some((key) => ![
      "type",
      "adapterProtocol",
      "adapterId",
      "harnessRunId",
      "retainedExecutionInputs",
    ].includes(key))
    || message.type !== "harness.run.start"
    || message.adapterProtocol !== adapterProtocol
    || message.adapterId !== adapterId
    || message.harnessRunId !== execution.harnessRunId
    || !Array.isArray(message.retainedExecutionInputs)
    || message.retainedExecutionInputs.length > 8
  ) {
    throw new Error("harness_run_start_invalid");
  }
  const retainedExecutionInputs = new Map();
  for (const input of message.retainedExecutionInputs) {
    if (
      !input
      || typeof input !== "object"
      || Array.isArray(input)
      || Object.keys(input).some((key) => !["path", "integrity", "source"].includes(key))
      || typeof input.path !== "string"
      || !/^[a-zA-Z0-9._/-]+$/.test(input.path)
      || input.path.startsWith("/")
      || input.path.split("/").some((segment) =>
        segment === "" || segment === "." || segment === "..")
      || !/^sha256:[a-f0-9]{64}$/.test(input.integrity ?? "")
      || typeof input.source !== "string"
      || Buffer.byteLength(input.source, "utf8") > 12_000
      || retainedExecutionInputs.has(input.path)
      || `sha256:${createHash("sha256").update(input.source).digest("hex")}`
        !== input.integrity
    ) {
      throw new Error("harness_run_start_invalid");
    }
    retainedExecutionInputs.set(input.path, input.source);
  }
  return retainedExecutionInputs;
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
  return {
    harnessRunId: value.harnessRunId,
    parameters: parseParameters(Buffer.from(
      JSON.stringify(value.parameters ?? {}),
      "utf8",
    ).toString("base64url")),
  };
};

const projectRoot = () => execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: { LANG: "C.UTF-8", ...(process.env.PATH ? { PATH: process.env.PATH } : {}) },
  timeout: 3_000,
}).trim();

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const hasExactKeys = (value, keys) => value
  && typeof value === "object"
  && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

const realProviderAvailable = () => {
  try {
    const version = execFileSync("codex", ["--version"], {
      encoding: "utf8",
      env: process.env,
      shell: process.platform === "win32",
      timeout: 5_000,
    }).trim();
    const authentication = spawnSync("codex", ["login", "status"], {
      encoding: "utf8",
      env: process.env,
      shell: process.platform === "win32",
      timeout: 5_000,
    });
    execFileSync("npm", ["--version"], {
      encoding: "utf8",
      env: process.env,
      shell: process.platform === "win32",
      timeout: 5_000,
    });
    return version === `codex-cli ${codexVersion}`
      && authentication.error === undefined
      && authentication.status === 0
      && /^Logged in\b/m.test(`${authentication.stdout}\n${authentication.stderr}`);
  } catch {
    return false;
  }
};

const realSandboxAvailable = () => {
  try {
    const version = execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8",
      env: process.env,
      timeout: 5_000,
    }).trim();
    const imageId = execFileSync("docker", [
      "image", "inspect", realSandboxImage, "--format={{.Id}}",
    ], {
      encoding: "utf8",
      env: process.env,
      timeout: 5_000,
    }).trim();
    return /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)
      && /^sha256:[a-f0-9]{64}$/.test(imageId);
  } catch {
    return false;
  }
};

const inspectRuntime = (retainedExecutionInputs = null) => {
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
  const controlled = readJson(join(root, controlledManifestName));
  const real = readJson(join(root, realManifestName));
  if (Boolean(controlled) === Boolean(real)) {
    return {
      ready: false,
      code: "harness_worker_provider_unavailable",
      explanation: "Exactly one supported Worker provider must be configured.",
    };
  }
  if (real) {
    const runtime = workerEnvironment.executionRuntimeInputs.find(({ identity }) =>
      identity === "openai.codex-cli");
    const providerReady = hasExactKeys(real, ["schemaVersion", "provider", "scenario"])
      && real.schemaVersion === 1
      && hasExactKeys(real.provider, ["kind", "ready"])
      && real.provider.kind === realProviderKind
      && real.provider.ready === true
      && real.scenario === "project-commit"
      && runtime?.version === codexVersion
      && workerEnvironment.skillDiscovery?.ambient === "disabled"
      && workerEnvironment.skillDiscovery?.unlisted === "reject"
      && JSON.stringify(workerEnvironment.skills.map(({ identity }) => identity))
        === JSON.stringify(realSkillIdentities)
      && realProviderAvailable()
      && realSandboxAvailable()
      && (retainedExecutionInputs === null
        || retainedExecutionInputs.has(realWorkerRuntimePath));
    return providerReady
      ? {
          ready: true,
          root,
          providerKind: realProviderKind,
          workerPath: realWorkerRuntimePath,
          workerSource: retainedExecutionInputs?.get(realWorkerRuntimePath) ?? null,
          realProvider: true,
        }
      : {
          ready: false,
          code: "harness_worker_provider_unavailable",
          explanation: "The configured real Worker provider is unavailable or not ready.",
        };
  }
  if (controlled?.runtime?.ready === false) {
    return {
      ready: false,
      code: "harness_execution_runtime_unavailable",
      explanation: "The pinned execution runtime is unavailable or not ready.",
    };
  }
  const providerReady = controlled?.schemaVersion === 1
    && controlled?.provider?.kind === controlledProviderKind
    && controlled.provider.ready === true
    && supportedScenarios.has(controlled.scenario)
    && (controlled.artifact === undefined || (
      controlled.artifact
      && typeof controlled.artifact === "object"
      && !Array.isArray(controlled.artifact)
      && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(controlled.artifact.path ?? "")
      && typeof controlled.artifact.content === "string"
      && Buffer.byteLength(controlled.artifact.content, "utf8") <= 4_096
    ))
    && (retainedExecutionInputs === null
      || retainedExecutionInputs.has(controlledWorkerRuntimePath));
  return providerReady
    ? {
        ready: true,
        root,
        providerKind: controlledProviderKind,
        workerPath: controlledWorkerRuntimePath,
        workerSource: retainedExecutionInputs?.get(controlledWorkerRuntimePath) ?? null,
        realProvider: false,
      }
    : {
        ready: false,
        code: "harness_worker_provider_unavailable",
        explanation: "The selected Worker provider is unavailable or not ready.",
      };
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

const waitForExit = (child) => new Promise((resolve) => {
  child.once("error", () => resolve({ code: null, startFailed: true }));
  child.once("close", (code) => resolve({ code, startFailed: false }));
});

const runWorker = async (execution, readiness) => {
  const now = () => new Date().toISOString();
  writeFrame({
    type: "harness.run.ready",
    adapterProtocol,
    adapterId,
    harnessRunId: execution.harnessRunId,
    capabilities: ["harness.run.v1"],
    readyAt: now(),
  });

  let diagnosticBytes = 0;
  const diagnostic = (chunk) => {
    if (diagnosticBytes >= 16_384) return;
    const sanitized = Buffer.from(sanitizeDiagnostic(Buffer.from(chunk).toString("utf8")));
    const bounded = sanitized.subarray(0, 16_384 - diagnosticBytes);
    diagnosticBytes += bounded.byteLength;
    process.stderr.write(bounded);
  };
  let activeChild = null;
  let cancelled = false;
  const cancelWorker = () => {
    if (cancelled) return;
    cancelled = true;
    activeChild?.kill("SIGTERM");
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

  let progressSequence = 0;
  const progress = ({ label, summary, status }) => {
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
        label,
        summary,
        status,
        timestamp: now(),
        payload: { provider: readiness.providerKind, sequence: progressSequence },
      },
    });
  };

  let dependencyFailure = false;
  let dependencyCleanupFailure = false;
  let outputInvalid = false;
  let workerExit = { code: null, startFailed: false };
  const results = [];
  try {
    if (readiness.realProvider) {
      progress({
        label: "Pinned Sandcastle dependencies",
        summary: "Installing the exact dependency lock before real Worker execution.",
        status: "running",
      });
      activeChild = spawn("npm", [
        "ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
      ], {
      cwd: process.cwd(),
      env: process.env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      });
      activeChild.stdout?.on("data", diagnostic);
      activeChild.stderr?.on("data", diagnostic);
      const installExit = await waitForExit(activeChild);
      dependencyFailure = !cancelled
        && (installExit.startFailed || installExit.code !== 0);
    }

    workerExit = { code: null, startFailed: dependencyFailure };
    if (!cancelled && !dependencyFailure) {
      const workerPath = join(process.cwd(), ...readiness.workerPath.split("/"));
      const workerArguments = readiness.realProvider
        ? [workerPath, readiness.root]
        : [
            workerPath,
            Buffer.from(JSON.stringify(execution.parameters), "utf8").toString("base64url"),
          ];
      activeChild = spawn(process.execPath, [
        "--input-type=module",
        "--eval",
        readiness.workerSource,
        ...workerArguments,
      ], {
        cwd: readiness.realProvider ? process.cwd() : readiness.root,
        env: readiness.realProvider ? process.env : { LANG: "C.UTF-8" },
        stdio: readiness.realProvider
          ? ["ignore", "pipe", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe"],
      });
      activeChild.stderr?.on("data", diagnostic);
      if (readiness.realProvider) activeChild.stdout?.resume();
      const protocolStream = readiness.realProvider ? activeChild.stdio[3] : activeChild.stdout;
      let outputBytes = 0;
      const lines = createInterface({ input: protocolStream, crlfDelay: Infinity });
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
          progress(message);
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
      workerExit = await waitForExit(activeChild);
      lines.close();
    }
  } finally {
    if (readiness.realProvider) {
      try {
        rmSync(join(process.cwd(), "node_modules"), { recursive: true, force: true });
      } catch {
        dependencyCleanupFailure = true;
      }
    }
  }
  process.removeListener("SIGTERM", cancelWorker);
  process.removeListener("message", handleCancellationMessage);
  if (process.connected) process.disconnect();

  let status;
  let result;
  if (cancelled) {
    status = "cancelled";
    result = { schemaVersion: 1, kind: "sandcastle.delegation", code: "cancelled" };
  } else if (dependencyCleanupFailure) {
    status = "failed";
    result = {
      schemaVersion: 1,
      kind: "sandcastle.delegation",
      code: "pinned_dependency_cleanup_failed",
      provider: { kind: readiness.providerKind },
    };
  } else if (dependencyFailure) {
    status = "failed";
    result = {
      schemaVersion: 1,
      kind: "sandcastle.delegation",
      code: "pinned_dependency_install_failed",
      provider: { kind: readiness.providerKind },
    };
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
  if (workerExit.startFailed && !dependencyFailure) {
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
      retainedExecutionInputs: [readiness.workerPath],
      sanitizedPreview: {
        summary: readiness.realProvider
          ? "Delegate one real Project commit through the pinned Sandcastle Harness."
          : parameters.issueNumber
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
  const retainedExecutionInputs = readRunStart(execution);
  const readiness = inspectRuntime(retainedExecutionInputs);
  if (!readiness.ready) {
    const completedAt = new Date().toISOString();
    writeFrame({
      type: "harness.run.ready",
      adapterProtocol,
      adapterId,
      harnessRunId: execution.harnessRunId,
      capabilities: ["harness.run.v1"],
      readyAt: completedAt,
    });
    writeFrame({
      type: "harness.run.terminal",
      adapterProtocol,
      adapterId,
      harnessRunId: execution.harnessRunId,
      terminalId: stableId("harness-terminal", execution.harnessRunId),
      status: "failed",
      completedAt,
      result: {
        schemaVersion: 1,
        kind: "sandcastle.delegation",
        code: readiness.code,
      },
    });
  } else {
    await runWorker(execution, readiness);
  }
} else {
  throw new Error("harness_adapter_command_invalid");
}
