import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
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

export const installReadyProbeCommands = async (root) => {
  const binPath = join(root, "bin");
  const originalPath = process.env.PATH;
  await mkdir(binPath, { recursive: true });
  await Promise.all([
    writeExecutable(join(binPath, "codex"), `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 0.146.0'; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then printf '%s\\n' 'Logged in using fixture'; exit 0; fi
exit 91
`),
    writeExecutable(join(binPath, "npm"), `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' '10.9.8'; exit 0; fi
if [ "$1" = "ci" ]; then exit 0; fi
exit 92
`),
    writeExecutable(join(binPath, "docker"), `#!/bin/sh
if [ "$1" = "version" ] && [ "$2" = "--format" ]; then printf '%s\\n' '27.5.1'; exit 0; fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ] && [ "$3" = "sandcastle:sandking-real-worker" ]; then
  printf '%s\\n' 'sha256:${"d".repeat(64)}'
  exit 0
fi
exit 93
`),
  ]);
  process.env.PATH = `${binPath}:${originalPath ?? ""}`;
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
  await mkdir(projectPath, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
  await writeFile(join(projectPath, "README.md"), "production Project\n");
  if (controlledFixture) await writeControlledFixture(projectPath, controlledFixture);
  await commitProductionProject(projectPath, "Initialize production Project");

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
    ...runManagerOptions,
  });
  return { ...registration, manager, recordAudit };
};

export const productionLaunchRequest = (projectId, overrides = {}) => ({
  requestId: "launch-production-work",
  projectId,
  parameters: {},
  controllerId: `runtime-${"2".repeat(24)}`,
  controllerSessionId: `controller-session-${"3".repeat(24)}`,
  source: "controller-cli",
  authorizationClass: "harness_run_launch",
  idempotencyKeyHash: `sha256:${"4".repeat(64)}`,
  ...overrides,
});

export const observeProductionTerminal = async (manager, harnessRunId) => {
  const deadline = Date.now() + 10_000;
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
