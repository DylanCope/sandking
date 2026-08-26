import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { digest as sha256 } from "../src/common/digest.mjs";
import { createHarnessRunManager } from "../src/harness-runs.mjs";
import { createProjectRegistry } from "../src/project-registration.mjs";

export const execFileAsync = promisify(execFile);

export const commitProductionProject = async (projectPath, message) => {
  await execFileAsync("git", ["-C", projectPath, "add", "--all"]);
  await execFileAsync("git", [
    "-C", projectPath,
    "-c", "user.name=Production Adapter Fixture",
    "-c", "user.email=production-adapter@sandking.invalid",
    "-c", "commit.gpgSign=false",
    "commit", "--quiet", "-m", message,
  ]);
};

export const writeControlledFixture = (projectPath, value) => writeFile(
  join(projectPath, "sandcastle.worker-fixture.json"),
  `${JSON.stringify(value, null, 2)}\n`,
);

export const writeExecutable = async (path, source) => {
  await writeFile(path, source);
  await chmod(path, 0o700);
};

const bundledMainScenarioPath = (root) => join(root, "bundled-main-scenario.txt");
const bundledMainStatePath = (root) => join(root, "bundled-main-state.json");

export const setBundledMainScenario = (root, scenario) => writeFile(
  bundledMainScenarioPath(root),
  `${scenario}\n`,
);

export const readBundledMainState = async (root) => JSON.parse(await readFile(
  bundledMainStatePath(root),
  "utf8",
));

export const installReadyProbeCommands = async (
  root,
  { mainScenario = "incomplete" } = {},
) => {
  const binPath = join(root, "bin");
  const fakeSandcastlePath = join(root, "fake-sandcastle");
  const containerHomePath = join(root, "container-home");
  const scenarioPath = bundledMainScenarioPath(root);
  const statePath = bundledMainStatePath(root);
  const originalPath = process.env.PATH;
  const dependencyRoot = join(new URL("../node_modules", import.meta.url).pathname);
  const sandboxConfigurationIntegrity = sha256(await readFile(
    new URL("../.sandcastle/Dockerfile", import.meta.url),
  ));
  await Promise.all([
    mkdir(binPath, { recursive: true }),
    mkdir(containerHomePath, { recursive: true }),
    mkdir(join(fakeSandcastlePath, "sandboxes"), { recursive: true }),
    setBundledMainScenario(root, mainScenario),
    writeFile(statePath, `${JSON.stringify({
      authenticatedCalls: 0,
      agentConfigurations: [],
      issues: {},
      pullRequests: [],
      reviewStarted: false,
    })}\n`),
  ]);
  await Promise.all([
    writeFile(join(fakeSandcastlePath, "package.json"), `${JSON.stringify({
      name: "@ai-hero/sandcastle",
      version: "0.12.0",
      type: "module",
      exports: {
        ".": "./index.mjs",
        "./sandboxes/docker": "./sandboxes/docker.mjs",
      },
    })}\n`),
    writeFile(join(fakeSandcastlePath, "sandboxes", "docker.mjs"), `
export const docker = (settings) => {
  if (settings?.imageName !== "sha256:${"d".repeat(64)}") {
    throw new Error("fixture_pinned_image_missing");
  }
  if (
    settings.env?.GH_TOKEN !== ""
    || settings.env?.GITHUB_TOKEN !== ""
    || !settings.mounts?.some(({ sandboxPath, readonly }) =>
      sandboxPath === "/home/agent/.sandcastle-secrets/github-token"
      && readonly === true)
  ) {
    throw new Error("fixture_github_credential_boundary_invalid");
  }
  return { kind: "controlled-docker", settings };
};
`),
    writeFile(join(fakeSandcastlePath, "index.mjs"), `
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const scenarioPath = ${JSON.stringify(scenarioPath)};
const statePath = ${JSON.stringify(statePath)};
const scenario = () => readFileSync(scenarioPath, "utf8").trim();
const issueNumber = () => {
  const index = process.argv.indexOf("--issue");
  const value = Number(process.argv[index + 1]);
  if (index < 0 || !Number.isSafeInteger(value)) throw new Error("fixture_issue_missing");
  return value;
};
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const commitIssueChange = (issueId, branch) => {
  git("switch", branch);
  const artifactName = "issue-" + issueId + "-delivered.txt";
  const artifact = join(process.cwd(), artifactName);
  appendFileSync(artifact, "implemented issue " + issueId + " at " + Date.now() + "\\n");
  git("add", artifactName);
  git("-c", "user.name=Bundled Main Fixture", "-c",
    "user.email=bundled-main@sandking.invalid", "-c", "commit.gpgSign=false",
    "commit", "--quiet", "-m", "Implement issue " + issueId);
  git("switch", "main");
};

export const Output = { object: (options) => options };
export const codex = (model, options) => ({ model, options });
export const run = async (options) => {
  const id = issueNumber();
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.agentConfigurations.push({
    phase: "planning",
    model: options?.agent?.model,
    effort: options?.agent?.options?.effort,
  });
  writeFileSync(statePath, JSON.stringify(state) + "\\n");
  return {
    output: {
      issues: scenario() === "incomplete" ? [] : [{
        id: String(id),
        title: "Controlled delivery for issue " + id,
        branch: "sandcastle/issue-" + id,
      }],
    },
  };
};
export const createSandbox = async ({ branch }) => ({
  async run(options) {
    const id = String(options.promptArgs?.TASK_ID ?? issueNumber());
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.agentConfigurations.push({
      phase: options.promptFile.endsWith("implement-prompt.md")
        ? "implementation"
        : "review",
      model: options.agent?.model,
      effort: options.agent?.options?.effort,
    });
    writeFileSync(statePath, JSON.stringify(state) + "\\n");
    if (options.promptFile.endsWith("implement-prompt.md")) {
      commitIssueChange(id, branch);
      return { stdout: "implementation completed" };
    }
    if (!options.promptFile.endsWith("pr-review-prompt.md")) {
      throw new Error("fixture_prompt_unexpected");
    }
    if (scenario() === "cancellable") {
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state.reviewStarted = true;
      writeFileSync(statePath, JSON.stringify(state) + "\\n");
      const keepAlive = setInterval(() => undefined, 50);
      try {
        await new Promise((resolve, reject) => {
          const signal = options.signal;
          const abort = () => reject(signal.reason ?? new Error("delivery_cancelled"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      } finally {
        clearInterval(keepAlive);
      }
    }
    const approved = scenario() !== "review-exhausted";
    return { stdout: "<review>" + JSON.stringify({
      approved,
      blockingFindings: approved ? [] : [{
        summary: "Controlled review rejection",
        requirement: "Exercise the real review-attempt budget",
        evidence: "The controlled reviewer requested another implementation pass.",
        materialImpact: "The pull request cannot merge yet.",
        cannotDefer: "The active review loop must reach its configured terminal outcome.",
      }],
      followUps: [],
      resolvedFindings: [],
    }) + "</review>" };
  },
  async close() {},
});
`),
  ]);
  await Promise.all([
    writeExecutable(join(binPath, "codex"), `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 0.146.0'; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then printf '%s\\n' 'Logged in using fixture'; exit 0; fi
exit 91
`),
    writeExecutable(join(binPath, "npm"), `#!/usr/bin/env node
import { cpSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
const command = process.argv[2];
if (command === "--version") {
  process.stdout.write("10.9.8\\n");
  process.exit(0);
}
if (command !== "ci") process.exit(92);
const modules = join(process.cwd(), "node_modules");
mkdirSync(join(modules, "@ai-hero"), { recursive: true });
for (const dependency of ["tsx", "esbuild", "zod"]) {
  symlinkSync(
    join(${JSON.stringify(dependencyRoot)}, dependency),
    join(modules, dependency),
    process.platform === "win32" ? "junction" : "dir",
  );
}
cpSync(${JSON.stringify(fakeSandcastlePath)}, join(modules, "@ai-hero", "sandcastle"), {
  recursive: true,
});
`),
    writeExecutable(join(binPath, "gh"), `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const statePath = ${JSON.stringify(statePath)};
const args = process.argv.slice(2);
const load = () => JSON.parse(readFileSync(statePath, "utf8"));
const save = (state) => writeFileSync(statePath, JSON.stringify(state) + "\\n");
const option = (name) => args[args.indexOf(name) + 1];
const issue = (state, number) => state.issues[number] ??= {
  number: Number(number), title: "Controlled issue " + number, state: "open", comments: [],
};
if (args[0] === "auth" && args[1] === "token") {
  process.stdout.write((process.env.GH_TOKEN ?? "") + "\\n");
  process.exit(process.env.GH_TOKEN ? 0 : 90);
}
if (!process.env.GH_TOKEN) process.exit(90);
const state = load();
state.authenticatedCalls += 1;
if (args[0] === "api" && args[1] === "user") {
  process.stdout.write("fixture-user\\n");
} else if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write("fixture/controlled-main\\n");
} else if (args[0] === "issue" && args[1] === "view") {
  const value = issue(state, args[2]);
  process.stdout.write(JSON.stringify(args.includes("comments")
    ? { comments: value.comments.map((body) => ({ body })) }
    : { number: value.number, title: value.title, state: value.state }));
} else if (args[0] === "issue" && args[1] === "comment") {
  issue(state, args[2]).comments.push(option("--body"));
} else if (args[0] === "issue" && args[1] === "close") {
  issue(state, args[2]).state = "closed";
} else if (args[0] === "issue" && args[1] === "list") {
  process.stdout.write("[]");
} else if (args[0] === "pr" && args[1] === "list") {
  const head = option("--head");
  process.stdout.write(JSON.stringify(state.pullRequests.filter((pullRequest) =>
    pullRequest.state === "OPEN" && pullRequest.headRefName === head)));
} else if (args[0] === "pr" && args[1] === "create") {
  const head = option("--head");
  const pullRequest = {
    number: 700 + state.pullRequests.length,
    url: "https://github.test/fixture/controlled-main/pull/"
      + (700 + state.pullRequests.length),
    baseRefName: option("--base"),
    headRefName: head,
    state: "OPEN",
    mergedAt: null,
    comments: [],
  };
  state.pullRequests.push(pullRequest);
  process.stdout.write(pullRequest.url + "\\n");
} else if (args[0] === "pr" && args[1] === "view") {
  const selector = args[2];
  const pullRequest = state.pullRequests.find((candidate) =>
    String(candidate.number) === selector || candidate.headRefName === selector);
  if (!pullRequest) process.exit(91);
  process.stdout.write(JSON.stringify(args.includes("comments")
    ? { comments: pullRequest.comments.map((body) => ({ body })) }
    : pullRequest));
} else if (args[0] === "pr" && args[1] === "comment") {
  const pullRequest = state.pullRequests.find(({ number }) => String(number) === args[2]);
  pullRequest.comments.push(option("--body"));
} else if (args[0] === "pr" && args[1] === "diff") {
  const pullRequest = state.pullRequests.find(({ number }) => String(number) === args[2]);
  process.stdout.write("diff for " + execFileSync("git", ["rev-parse", pullRequest.headRefName], {
    encoding: "utf8",
  }).trim() + "\\n");
} else if (args[0] === "pr" && args[1] === "checks") {
  process.stdout.write("all controlled checks passed\\n");
} else if (args[0] === "pr" && args[1] === "merge") {
  const pullRequest = state.pullRequests.find(({ number }) => String(number) === args[2]);
  execFileSync("git", [
    "-c", "user.name=Controlled GitHub",
    "-c", "user.email=controlled-github@sandking.invalid",
    "-c", "commit.gpgSign=false",
    "merge", "--no-ff", "--no-edit", pullRequest.headRefName,
  ]);
  execFileSync("git", ["push", "origin", "main"]);
  pullRequest.state = "MERGED";
  pullRequest.mergedAt = new Date().toISOString();
} else if (args[0] === "api" && args[1].endsWith("/sub_issues")) {
  process.stdout.write("[]");
} else if (args[0] === "api" && args[1].endsWith("/parent")) {
  process.exit(1);
} else {
  process.exit(92);
}
save(state);
`),
    writeExecutable(join(binPath, "docker"), `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const args = process.argv.slice(2);
if (args[0] === "version" && args[1] === "--format") {
  process.stdout.write("27.5.1\\n");
  process.exit(0);
}
if (
  args[0] === "image"
  && args[1] === "inspect"
  && args[2] === "sandcastle:sandking-real-worker"
) {
    process.stdout.write(args[3]?.includes("json .Config")
      ? JSON.stringify({
          Labels: {
            "org.sandking.production-sandbox.configuration-integrity":
              ${JSON.stringify(sandboxConfigurationIntegrity)},
            "org.sandking.production-sandbox.agent-uid": String(process.getuid?.() ?? 1000),
            "org.sandking.production-sandbox.agent-gid": String(process.getgid?.() ?? 1000),
          },
          User: String(process.getuid?.() ?? 1000) + ":" + String(process.getgid?.() ?? 1000),
        }) + "\\n"
      : "sha256:${"d".repeat(64)}\\n");
  process.exit(0);
}
if (args[0] !== "run" || args[1] !== "--rm") process.exit(93);
const imageIndex = args.findIndex((value) =>
  value === "sandcastle:sandking-real-worker" || /^sha256:[a-f0-9]{64}$/.test(value));
const entrypointIndex = args.indexOf("--entrypoint");
const workdirIndex = args.indexOf("--workdir");
if (
  imageIndex < 0
  || entrypointIndex < 0
  || args[entrypointIndex + 1] !== "/usr/local/bin/node"
  || workdirIndex < 0
  || JSON.stringify(args).includes("github_pat_production_fixture_delivery")
) process.exit(94);
const mounts = new Map();
for (let index = 0; index < imageIndex; index += 1) {
  if (args[index] !== "--volume") continue;
  const mount = args[index + 1].replace(/:(?:ro|rw)$/, "");
  const targetIndex = mount.lastIndexOf(":/");
  if (targetIndex < 0) process.exit(97);
  mounts.set(mount.slice(targetIndex + 1), mount.slice(0, targetIndex));
}
const translatePath = (value) => {
  for (const [containerPath, hostPath] of mounts) {
    if (value === containerPath) return hostPath;
    if (value.startsWith(containerPath + "/")) {
      return hostPath + value.slice(containerPath.length);
    }
  }
  return value;
};
const translateArgument = (value) => value.startsWith("file://")
  ? (() => {
      const containerPath = fileURLToPath(value);
      const hostPath = translatePath(containerPath);
      return hostPath === containerPath
        ? value
        : pathToFileURL(hostPath).href;
    })()
  : translatePath(value);
const environment = { ...process.env };
for (const name of [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
]) delete environment[name];
for (let index = 0; index < imageIndex; index += 1) {
  if (args[index] !== "--env") continue;
  const [name, ...value] = args[index + 1].split("=");
  environment[name] = translatePath(value.join("="));
}
if (environment.HOME !== "/home/agent") process.exit(96);
environment.HOME = ${JSON.stringify(containerHomePath)};
const child = spawn(process.execPath, args.slice(imageIndex + 1).map(translateArgument), {
  cwd: translatePath(args[workdirIndex + 1]),
  env: environment,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.once("error", () => process.exit(95));
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 95);
});
`),
  ]);
  process.env.PATH = `${binPath}${delimiter}${originalPath ?? ""}`;
  return () => {
    process.env.PATH = originalPath;
  };
};

export const createProductionRegistration = async (
  root,
  controlledFixture = null,
) => {
  const dataDir = join(root, "host-state");
  const projectPath = join(root, "project");
  const originPath = join(root, "origin.git");
  await mkdir(projectPath, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", "--bare", originPath]);
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
  await writeFile(join(projectPath, "README.md"), "production Project\n");
  if (controlledFixture) await writeControlledFixture(projectPath, controlledFixture);
  await commitProductionProject(projectPath, "Initialize production Project");
  await execFileAsync("git", ["-C", projectPath, "remote", "add", "origin", originPath]);
  await execFileAsync("git", ["-C", projectPath, "push", "--quiet", "-u", "origin", "main"]);

  const audits = [];
  const recordAudit = async (action, outcome, details, requestedAuditId) => {
    const auditId = requestedAuditId
      ?? `audit-${String(audits.length + 1).padStart(24, "0")}`;
    audits.push({ auditId, action, outcome, details });
    return auditId;
  };
  const registry = await createProjectRegistry({ dataDir, recordAudit });
  const harness = await registry.registerSandcastleHarness({
    requestId: "register-production-harness",
    name: "Sand-King Sandcastle Harness",
    authorizationClass: "host_local_harness_registration",
    idempotencyKey: "register-production-harness",
    expectedRevision: 0,
  });
  if (!("harness" in harness)) {
    throw new Error(`production_harness_registration_failed:${JSON.stringify(harness)}`);
  }
  const project = await registry.registerProject({
    requestId: "register-production-project",
    path: projectPath,
    configuration: {
      issueWorkflow: { provider: "github", kind: "issues" },
      checks: [{ checkId: "test", command: "npm test" }],
    },
    authorizationClass: "host_local_project_registration",
    idempotencyKey: "register-production-project",
    expectedRevision: 0,
  });
  const pinned = await registry.pinHarness({
    requestId: "pin-production-harness",
    projectId: project.project.projectId,
    harnessId: harness.harness.harnessId,
    boundedConfiguration: {
      adapterProtocol: "1.0.0",
      launchProfile: "delegated-work",
    },
    authorizationClass: "host_local_project_configuration",
    idempotencyKey: "pin-production-harness",
    expectedRevision: 1,
  });
  return {
    audits,
    dataDir,
    harness,
    pinned,
    project,
    projectPath,
    recordAudit,
    registry,
  };
};

export const createProductionFixture = async (
  root,
  controlledFixture = null,
  managerOptions = {},
) => {
  const registration = await createProductionRegistration(root, controlledFixture);
  const { onAudit, ...runManagerOptions } = managerOptions;
  const recordAudit = async (action, outcome, details, requestedAuditId) => {
    const auditId = await registration.recordAudit(
      action,
      outcome,
      details,
      requestedAuditId,
    );
    await onAudit?.(action, outcome, details);
    return auditId;
  };
  const manager = await createHarnessRunManager({
    dataDir: registration.dataDir,
    hostId: `host-${"1".repeat(24)}`,
    recordAudit,
    loadLaunchContext: registration.registry.loadLaunchContext,
    resolveGitHubCredential: async () => ({
      mode: "project-pat",
      token: "github_pat_production_fixture_delivery",
    }),
    ...runManagerOptions,
  });
  return { ...registration, manager, recordAudit };
};

export const productionLaunchRequest = (projectId, overrides = {}) => ({
  requestId: "launch-production-work",
  projectId,
  parameters: { issueNumber: 173 },
  controllerId: `runtime-${"2".repeat(24)}`,
  controllerSessionId: `controller-session-${"3".repeat(24)}`,
  source: "controller-cli",
  authorizationClass: "harness_run_launch",
  idempotencyKeyHash: `sha256:${"4".repeat(64)}`,
  ...overrides,
});

export const observeProductionTerminal = async (manager, harnessRunId, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observation = await manager.observe({
      requestId: "observe-production-work",
      harnessRunId,
      afterSequence: 0,
    });
    if (["succeeded", "failed", "cancelled"].includes(observation.run.status)) {
      await manager.waitForIdle();
      return observation;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("production_terminal_timeout");
};

export const observeProductionRunning = async (manager, harnessRunId) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const observation = await manager.observe({
      requestId: "observe-running-production-work",
      harnessRunId,
      afterSequence: 0,
    });
    if (observation.run.status === "running") return observation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("production_running_timeout");
};

export const readRetainedProductionRuns = async (fixture) => JSON.parse(await readFile(
  join(fixture.dataDir, "harness-runs.json"),
  "utf8",
));
