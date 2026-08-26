import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { digest as sha256 } from "../common/digest.mjs";
import {
  destinationCodexAuthPath,
  isMountableCodexAuthFile,
} from "../destination-worker-environment.mjs";
import {
  hasExactKeys,
  isValidIssueNumber,
  parseRealDelegationMessage,
  parseProductionProviderRuntime,
} from "../real-delegation-protocol.mjs";
import {
  createDockerEndpointRelay,
  createMainContainerConfiguration,
  createMainContainerPathMappings,
  MAIN_CONTAINER_PATHS,
} from "./docker-transport.mjs";
import { materializeGitHubCredential } from "./github-credential-v1.mjs";

const execFileAsync = promisify(execFile);
export const REAL_PROVIDER_KIND = "openai-codex";
export const REAL_PROVIDER_MODEL = "gpt-5.6-sol";
export const REAL_PROVIDER_EFFORT = "xhigh";
export const REAL_SANDBOX_IMAGE = "sandcastle:sandking-real-worker";
export const REAL_SANDBOX_CONFIGURATION = ".sandcastle/Dockerfile";
export const REAL_DELEGATION_TIMEOUT_MS = 72 * 60 * 60 * 1_000;
const CANCELLATION_GRACE_MS = 30_000;
const SANDCASTLE_VERSION = "0.12.0";
const SANDCASTLE_RESOLVED =
  "https://registry.npmjs.org/@ai-hero/sandcastle/-/sandcastle-0.12.0.tgz";
const SANDCASTLE_INTEGRITY =
  "sha512-kdQ414rM8t1QiWeqZ3Klz4KSd0PqQG4bRVuqGpRDUomWhojSZkEAc1tbcEcThVmBEaHkCt8LmYR49vqEPNIoYQ==";
const CODEX_VERSION = "0.146.0";
const PINNED_SKILL_IDENTITIES = Object.freeze([
  "sandking.issue-implementation",
  "sandking.issue-planning",
  "sandking.pull-request-review",
  "sandking.real-delegation",
]);
const MAIN_WORKFLOW_SKILL_IDENTITIES = Object.freeze(
  PINNED_SKILL_IDENTITIES.filter((identity) => identity !== "sandking.real-delegation"),
);
const DELEGATION_FAILURE_CODES = new Set([
  "delivery_cancelled",
  "delivery_execution_failed",
  "real_delegation_github_credential_required",
  "real_delegation_interrupted",
  "real_delegation_main_result_invalid",
  "real_delegation_main_result_missing",
  "real_delegation_timed_out",
  "scoped_issue_incomplete",
]);

const delegationError = (code) => Object.assign(new Error(code), { code });

const loadPinnedInputs = async (executionPath) => {
  const [workerEnvironment, dependencyLock, sandboxConfiguration] = await Promise.all([
    readFile(join(executionPath, "worker-environment.json"), "utf8").then(JSON.parse),
    readFile(join(executionPath, "package-lock.json"), "utf8").then(JSON.parse),
    readFile(join(executionPath, ...REAL_SANDBOX_CONFIGURATION.split("/"))),
  ]);
  const runtime = workerEnvironment.executionRuntimeInputs?.find(({ identity }) =>
    identity === "openai.codex-cli");
  const sandcastle = dependencyLock.packages?.["node_modules/@ai-hero/sandcastle"];
  if (
    workerEnvironment.schemaVersion !== 1
    || workerEnvironment.skillDiscovery?.ambient !== "disabled"
    || workerEnvironment.skillDiscovery?.unlisted !== "reject"
    || !/^sha256:[a-f0-9]{64}$/.test(workerEnvironment.skillSetLockDigest ?? "")
    || !Array.isArray(workerEnvironment.skills)
    || workerEnvironment.skills.length !== PINNED_SKILL_IDENTITIES.length
    || JSON.stringify(workerEnvironment.skills.map(({ identity }) => identity))
      !== JSON.stringify(PINNED_SKILL_IDENTITIES)
    || runtime?.version !== CODEX_VERSION
    || sandcastle?.version !== SANDCASTLE_VERSION
    || sandcastle?.resolved !== SANDCASTLE_RESOLVED
    || sandcastle?.integrity !== SANDCASTLE_INTEGRITY
  ) {
    throw new Error("pinned_real_worker_inputs_invalid");
  }
  for (const skill of workerEnvironment.skills) {
    const expectedPath = `worker-skills/${skill.identity}/SKILL.md`;
    if (
      skill.path !== expectedPath
      || !/^[a-f0-9]{40}$/.test(skill.revision ?? "")
      || !/^sha256:[a-f0-9]{64}$/.test(skill.contentIntegrity ?? "")
    ) {
      throw new Error("pinned_real_worker_inputs_invalid");
    }
    const source = await readFile(join(executionPath, ...skill.path.split("/")), "utf8");
    if (sha256(source) !== skill.contentIntegrity) {
      throw new Error("pinned_real_worker_inputs_invalid");
    }
  }
  return {
    skillSetLockDigest: workerEnvironment.skillSetLockDigest,
    sandboxConfigurationIntegrity: sha256(sandboxConfiguration),
  };
};

const waitForChild = (child) => new Promise((resolve) => {
  child.once("error", () => resolve({ exitCode: null, signal: null, startFailed: true }));
  child.once("close", (exitCode, signal) => resolve({ exitCode, signal, startFailed: false }));
});

/**
 * `main.mts` owns per-agent idle and completion timeouts. This outer 72-hour
 * wall bound exists only to stop an abandoned multi-round delivery eventually;
 * ordinary cancellation remains the primary control path.
 */
export const runPinnedMain = async ({
  executionPath,
  projectPath,
  issueNumber,
  authPath,
  githubCredentialPath,
  dockerEndpoint,
  sandboxImage = REAL_SANDBOX_IMAGE,
  signal,
  timeoutMs = REAL_DELEGATION_TIMEOUT_MS,
  onProgress = () => undefined,
  spawnProcess = spawn,
  platform = process.platform,
  createDockerRelay = createDockerEndpointRelay,
}) => {
  const mainPath = `${MAIN_CONTAINER_PATHS.execution}/.sandcastle/main.mts`;
  const tsxLoaderUrl =
    `file://${MAIN_CONTAINER_PATHS.execution}/node_modules/tsx/dist/loader.mjs`;
  const dockerEnvironment = { ...process.env };
  dockerEnvironment.DOCKER_HOST = dockerEndpoint;
  delete dockerEnvironment.DOCKER_CONTEXT;
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
  ]) {
    delete dockerEnvironment[name];
  }
  const containerName = `sandking-real-delegation-${randomUUID()}`;
  const pathMappings = createMainContainerPathMappings({
    executionPath,
    projectPath,
    authPath,
    githubCredentialPath,
  });
  const dockerRelay = await createDockerRelay(dockerEndpoint, {
    platform,
    pathMappings,
  });
  const { environmentArguments, mountArguments } = createMainContainerConfiguration({
    executionPath,
    projectPath,
    authPath,
    githubCredentialPath,
    sandboxImage,
    dockerRelay,
  });
  try {
    const child = spawnProcess("docker", [
      "run",
      "--rm",
      "--init",
      "--name",
      containerName,
      "--stop-timeout",
      String(CANCELLATION_GRACE_MS / 1_000),
      "--user",
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "--workdir",
      MAIN_CONTAINER_PATHS.project,
      ...mountArguments,
      ...environmentArguments,
      "--entrypoint",
      "/usr/local/bin/node",
      sandboxImage,
      "--import",
      tsxLoaderUrl,
      mainPath,
      "--issue",
      String(issueNumber),
    ], {
      cwd: projectPath,
      env: dockerEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputInvalid = false;
    child.stderr?.once("error", () => undefined);
    child.stderr?.pipe(process.stderr, { end: false });

    const messages = [];
    const protocolStream = child.stdout;
    if (!protocolStream) {
      child.kill("SIGKILL");
      throw delegationError("real_delegation_main_result_invalid");
    }
    protocolStream.once("error", () => undefined);
    const lines = createInterface({ input: protocolStream, crlfDelay: Infinity });
    const linesClosed = new Promise((resolve) => lines.once("close", resolve));
    lines.on("line", (line) => {
      let message;
      try {
        message = parseRealDelegationMessage(line);
      } catch {
        outputInvalid = true;
        return;
      }
      if (message.issueNumber !== issueNumber || messages.some(({ type }) =>
        type === "sandcastle.delivery.result")) {
        outputInvalid = true;
        return;
      }
      messages.push(message);
      if (message.type === "sandcastle.delivery.progress") onProgress(message);
    });

    let requestedTermination = null;
    let forcedTimer;
    const signalContainer = (signalName) => execFileAsync("docker", [
      "kill", "--signal", signalName, containerName,
    ], {
      env: dockerEnvironment,
      timeout: 10_000,
      maxBuffer: 64_000,
    }).catch(() => undefined);
    const requestTermination = (reason) => {
      if (requestedTermination) return;
      requestedTermination = reason;
      child.kill("SIGTERM");
      void signalContainer("SIGTERM");
      forcedTimer = setTimeout(() => {
        void signalContainer("SIGKILL");
        child.kill("SIGKILL");
      }, CANCELLATION_GRACE_MS);
      forcedTimer.unref?.();
    };
    const handleAbort = () => requestTermination("cancelled");
    if (signal?.aborted) handleAbort();
    else signal?.addEventListener("abort", handleAbort, { once: true });
    const timeout = setTimeout(() => requestTermination("timed-out"), timeoutMs);
    timeout.unref?.();

    const childResult = await waitForChild(child);
    await linesClosed;
    clearTimeout(timeout);
    clearTimeout(forcedTimer);
    signal?.removeEventListener("abort", handleAbort);
    lines.close();
    const results = messages.filter(({ type }) => type === "sandcastle.delivery.result");
    return {
      ...childResult,
      termination: requestedTermination
        ?? (childResult.signal ? "interrupted" : "completed"),
      outputInvalid,
      result: results.length === 1 ? results[0] : null,
      resultCount: results.length,
    };
  } finally {
    await dockerRelay.close();
  }
};

export const runRealDelegation = async ({
  executionPath,
  projectPath,
  issueNumber,
  signal,
  authPath = destinationCodexAuthPath(),
  githubCredential = null,
  productionProviderRuntime,
  runMain = runPinnedMain,
  onProgress = () => undefined,
}) => {
  if (!isValidIssueNumber(issueNumber)) {
    throw delegationError("real_delegation_issue_required");
  }
  const providerRuntime = parseProductionProviderRuntime(productionProviderRuntime);
  const pinned = await loadPinnedInputs(executionPath);
  if (!isMountableCodexAuthFile(authPath)) {
    throw new Error("pinned_real_worker_auth_invalid");
  }
  const materializedGitHubCredential = await materializeGitHubCredential(githubCredential);
  if (!materializedGitHubCredential) {
    throw delegationError("real_delegation_github_credential_required");
  }
  try {
    const main = await runMain({
      executionPath,
      projectPath,
      issueNumber,
      authPath,
      githubCredentialPath: materializedGitHubCredential.path,
      dockerEndpoint: providerRuntime.dockerEndpoint,
      sandboxImage: providerRuntime.sandboxImageId,
      signal,
      onProgress,
    });
    if (main.termination === "timed-out") {
      throw delegationError("real_delegation_timed_out");
    }
    if (main.termination === "cancelled") {
      throw delegationError("delivery_cancelled");
    }
    if (main.termination === "interrupted") {
      throw delegationError("real_delegation_interrupted");
    }
    if (main.outputInvalid || main.resultCount > 1) {
      throw delegationError("real_delegation_main_result_invalid");
    }
    if (!main.result) {
      throw delegationError("real_delegation_main_result_missing");
    }
    if (
      main.startFailed
      || main.exitCode !== 0
      || main.result.status !== "succeeded"
    ) {
      throw delegationError(
        main.result.status === "failed" ? main.result.code : "delivery_execution_failed",
      );
    }
    return {
      schemaVersion: 1,
      kind: "sandcastle.delegation",
      code: "issue_delivery_completed",
      issueNumber,
      completion: main.result.completion,
      provider: {
        kind: REAL_PROVIDER_KIND,
        model: REAL_PROVIDER_MODEL,
        effort: REAL_PROVIDER_EFFORT,
      },
      upstream: {
        package: "@ai-hero/sandcastle",
        version: SANDCASTLE_VERSION,
      },
      skillSetLockDigest: pinned.skillSetLockDigest,
      resolvedSkillCount: PINNED_SKILL_IDENTITIES.length,
      skillDelivery: {
        ambient: "disabled",
        method: "pinned-main-orchestration-files",
        deliveredIdentities: MAIN_WORKFLOW_SKILL_IDENTITIES,
      },
      sandbox: {
        provider: "docker",
        image: REAL_SANDBOX_IMAGE,
        imageId: providerRuntime.sandboxImageId,
        configurationSource: REAL_SANDBOX_CONFIGURATION,
        configurationIntegrity: pinned.sandboxConfigurationIntegrity,
        destinationIsolation: true,
      },
      completionContract: {
        kind: "structured-main-attestation",
        timeoutSeconds: REAL_DELEGATION_TIMEOUT_MS / 1_000,
      },
    };
  } finally {
    await materializedGitHubCredential.cleanup();
  }
};

export const executeRealDelegation = async ({ runDelegation = runRealDelegation, ...options }) => {
  try {
    return {
      type: "sandcastle.worker.result",
      status: "succeeded",
      result: await runDelegation(options),
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      && DELEGATION_FAILURE_CODES.has(error.code)
      ? error.code
      : "real_provider_execution_failed";
    return {
      type: "sandcastle.worker.result",
      status: "failed",
      result: {
        schemaVersion: 1,
        kind: "sandcastle.delegation",
        code,
        provider: { kind: REAL_PROVIDER_KIND },
      },
    };
  }
};

const publish = (message) => {
  writeSync(3, `${JSON.stringify(message)}\n`);
};

export const parseRealDelegationInvocationParameters = (encoded) => {
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || !hasExactKeys(value, ["issueNumber", "productionProviderRuntime"])
      || !isValidIssueNumber(value.issueNumber)
    ) {
      throw new Error("invalid");
    }
    return {
      issueNumber: value.issueNumber,
      productionProviderRuntime: parseProductionProviderRuntime(
        value.productionProviderRuntime,
        "real_delegation_parameters_invalid",
      ),
    };
  } catch {
    throw new Error("real_delegation_parameters_invalid");
  }
};

const invokedPath = (process.argv[1] ?? "").replaceAll("\\", "/");
if (invokedPath.endsWith("/.sandcastle/real-worker-v2.mjs")) {
  const invocationPaths = process.argv.slice(2);
  if (invocationPaths.length !== 3) {
    throw new Error("real_delegation_invocation_invalid");
  }
  const [executionPath, encodedParameters, projectPath] = invocationPaths;
  const parameters = parseRealDelegationInvocationParameters(encodedParameters);
  let githubCredential;
  try {
    githubCredential = JSON.parse(readFileSync(4, "utf8"));
  } catch {
    throw new Error("github_credential_channel_invalid");
  }
  const controller = new AbortController();
  const handleTermination = () => controller.abort(delegationError("delivery_cancelled"));
  process.on("SIGTERM", handleTermination);
  publish({
    type: "sandcastle.worker.progress",
    label: `Deliver GitHub issue #${parameters.issueNumber}`,
    summary: "The pinned Harness is starting its scoped plan, implementation, review, and merge loop.",
    status: "running",
  });
  const outcome = await executeRealDelegation({
    executionPath,
    projectPath,
    issueNumber: parameters.issueNumber,
    productionProviderRuntime: parameters.productionProviderRuntime,
    githubCredential,
    signal: controller.signal,
    onProgress: ({ label, summary, status }) => publish({
      type: "sandcastle.worker.progress",
      label,
      summary,
      status,
    }),
  });
  if (outcome.status === "failed") {
    process.stderr.write(`sandcastle_${outcome.result.code}\n`);
  }
  publish(outcome);
  process.removeListener("SIGTERM", handleTermination);
}
