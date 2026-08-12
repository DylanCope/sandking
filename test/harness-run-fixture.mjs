import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHarnessRunManager } from "../src/harness-runs.mjs";
import { createProjectRegistry } from "../src/project-registration.mjs";

const execFileAsync = promisify(execFile);

export const createHarnessRunFixture = async (
  prefix,
  hostId,
  managerOptions = {},
) => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const dataDir = join(root, "host-state");
  const projectPath = join(root, "selected-project");
  const audits = [];
  const recordAudit = async (action, outcome, details = {}, requestedAuditId) => {
    if (requestedAuditId && audits.some((audit) => audit.auditId === requestedAuditId)) {
      return requestedAuditId;
    }
    const auditId = requestedAuditId
      ?? `audit-${String(audits.length + 1).padStart(24, "0")}`;
    audits.push({ auditId, action, outcome, details });
    return auditId;
  };
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
  await writeFile(join(projectPath, "README.md"), "ordinary Project content\n");
  const registry = await createProjectRegistry({ dataDir, recordAudit });
  const registered = await registry.registerProject({
    requestId: "register-run-project",
    path: projectPath,
    configuration: {
      issueWorkflow: { provider: "github", kind: "issues" },
      checks: [
        { checkId: "typecheck", command: "npm run typecheck" },
        { checkId: "test", command: "npm run test" },
      ],
    },
    authorizationClass: "host_local_project_registration",
    idempotencyKey: "register-run-project",
    expectedRevision: 0,
  });
  const harness = await registry.registerConformanceHarness({
    requestId: "register-run-harness",
    name: "Sand-King Conformance Harness",
    authorizationClass: "host_local_harness_registration",
    idempotencyKey: "register-run-harness",
    expectedRevision: 0,
  });
  await registry.pinConformanceHarness({
    requestId: "pin-run-harness",
    projectId: registered.project.projectId,
    harnessId: harness.harness.harnessId,
    immutableRevision: harness.harness.immutableRevision,
    boundedConfiguration: {
      adapterProtocol: "1.0.0",
      launchProfile: "delegated-work",
    },
    authorizationClass: "host_local_project_configuration",
    idempotencyKey: "pin-run-harness",
    expectedRevision: 1,
  });
  const manager = await createHarnessRunManager({
    dataDir,
    hostId,
    recordAudit,
    loadLaunchContext: registry.loadLaunchContext,
    ...managerOptions,
  });
  return {
    root,
    dataDir,
    projectPath,
    audits,
    registry,
    registered,
    harness,
    manager,
    recordAudit,
  };
};
