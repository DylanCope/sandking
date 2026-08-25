import { spawn } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const startInstalledProductionHost = async ({
  endpoint,
  installed,
  nodePath,
  preloadPath,
  registration,
}) => {
  const harnessRunsUrl = pathToFileURL(join(
    installed.packageDirectory,
    "src",
    "harness-runs.mjs",
  )).href;
  const projectRegistrationUrl = pathToFileURL(join(
    installed.packageDirectory,
    "src",
    "project-registration.mjs",
  )).href;
  const source = `
import { createServer } from "node:net";
import { createHarnessRunManager } from ${JSON.stringify(harnessRunsUrl)};
import { createProjectRegistry } from ${JSON.stringify(projectRegistrationUrl)};
const dataDir = ${JSON.stringify(registration.dataDir)};
const endpoint = ${JSON.stringify(endpoint)};
const projectId = ${JSON.stringify(registration.project.project.projectId)};
let auditSequence = 0;
const recordAudit = async (_action, _outcome, _details, requestedAuditId) =>
  requestedAuditId ?? \`audit-\${String(++auditSequence).padStart(24, "0")}\`;
const registry = await createProjectRegistry({ dataDir, recordAudit });
const manager = await createHarnessRunManager({
  dataDir,
  hostId: \`host-\${"7".repeat(24)}\`,
  recordAudit,
  loadLaunchContext: registry.loadLaunchContext,
});
const server = createServer((socket) => {
  socket.setEncoding("utf8");
  let input = "";
  socket.on("data", async (chunk) => {
    input += chunk;
    if (!input.includes("\\n")) return;
    try {
      const request = JSON.parse(input.slice(0, input.indexOf("\\n")));
      const outcome = request.operation === "describe"
        ? {
            type: "controller.cli.description",
            protocol: "1.0.0",
            command: "sandking launch",
            focusedProjectId: projectId,
            projectArgumentOptional: true,
            pluginRequired: false,
            launchParameters: ${JSON.stringify(registration.harness.harness.launchParameters)},
          }
        : await manager.launch({
            requestId: request.requestId,
            projectId,
            parameters: request.parameters ?? {},
            controllerId: \`runtime-\${"8".repeat(24)}\`,
            controllerSessionId: request.controllerSessionId,
            source: "controller-cli",
            authorizationClass: "harness_run_launch",
            idempotencyKeyHash: request.idempotencyKeyHash,
          });
      const succeeded = outcome.type === "controller.cli.description"
        || outcome.type === "harness.run.launch.result";
      socket.end(\`\${JSON.stringify({
        type: "sandking.cli.result",
        protocol: "1.0.0",
        requestId: request.requestId,
        ok: succeeded,
        ...(succeeded ? { outcome } : { failure: { code: outcome.code } }),
      })}\\n\`);
    } catch (error) {
      socket.destroy(error instanceof Error ? error : undefined);
    }
  });
});
process.once("SIGTERM", async () => {
  await manager.waitForIdle();
  server.close(() => process.exit(0));
});
server.listen(endpoint, () => process.stdout.write("ready\\n"));
`;
  const child = spawn(nodePath, [
    ...(preloadPath ? ["--import", pathToFileURL(preloadPath).href] : []),
    "--input-type=module",
    "--eval",
    source,
  ], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostic = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    diagnostic += chunk;
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`installed_readiness_host_timeout: ${diagnostic}`));
    }, 10_000);
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes("ready\n")) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (output.includes("ready\n")) return;
      clearTimeout(timeout);
      reject(new Error(
        `installed_readiness_host_exited: ${code ?? signal ?? "unknown"}: ${diagnostic}`,
      ));
    });
  });
  return {
    diagnostic: () => diagnostic,
    kill: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGKILL");
      await exited;
    },
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGTERM");
      await exited;
    },
  };
};

export const waitForPathState = async (path, exists) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await access(path).then(() => true, () => false);
    if (current === exists) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`production_provider_race_timeout:${path}:${exists}`);
};

export const writeProviderMutationPause = async ({
  excludePath,
  mode,
  root,
  manifestPath,
}) => {
  const armPath = join(root, "arm-provider-mutation");
  const blockedPath = join(root, "provider-mutation-blocked");
  const claimedPath = join(root, "claimed-provider-mutation");
  const releasePath = join(root, "release-provider-mutation");
  const capturedPath = join(root, "provider-mutation-captured");
  const capturedReleasePath = join(root, "release-captured-provider-mutation");
  const preloadPath = join(root, "pause-provider-mutation.mjs");
  await writeFile(preloadPath, `
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const manifestPath = ${JSON.stringify(manifestPath)};
const excludePath = ${JSON.stringify(excludePath)};
const mode = ${JSON.stringify(mode)};
const originalAccess = fsPromises.access.bind(fsPromises);
const originalLink = fsPromises.link.bind(fsPromises);
const originalReadFile = fsPromises.readFile.bind(fsPromises);
const originalRename = fsPromises.rename.bind(fsPromises);
const originalRm = fsPromises.rm.bind(fsPromises);
const originalWriteFile = fsPromises.writeFile.bind(fsPromises);
const pause = async () => {
  try {
    await originalRename(${JSON.stringify(armPath)}, ${JSON.stringify(claimedPath)});
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await originalWriteFile(${JSON.stringify(blockedPath)}, "blocked\\n");
  while (await originalAccess(${JSON.stringify(releasePath)}).then(
    () => false,
    () => true,
  )) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
let excludeCaptureCount = 0;
fsPromises.link = async (from, to, ...rest) => {
  if (mode === "creation" && String(to) === manifestPath) await pause();
  return originalLink(from, to, ...rest);
};
fsPromises.rename = async (from, to, ...rest) => {
  let pauseForExcludeCommit = false;
  if (String(from) === excludePath) {
    excludeCaptureCount += 1;
    pauseForExcludeCommit = (mode === "exclude-append" && excludeCaptureCount === 1)
      || (mode === "exclude-cleanup" && excludeCaptureCount === 2);
  } else if (String(to) === excludePath) {
    const candidate = await originalReadFile(from, "utf8").catch(() => "");
    const appending = candidate.includes("# Sand-King temporary production provider");
    pauseForExcludeCommit = (mode === "exclude-append" && appending)
      || (mode === "exclude-cleanup" && !appending);
  }
  if (pauseForExcludeCommit) await pause();
  if (
    (mode === "creation" && String(to) === manifestPath)
    || (
      (mode === "cleanup" || mode === "capture-crash")
      && String(from) === manifestPath
      && await originalAccess(manifestPath).then(() => true, () => false)
    )
  ) await pause();
  const result = await originalRename(from, to, ...rest);
  if (mode === "capture-crash" && String(from) === manifestPath) {
    await originalWriteFile(${JSON.stringify(capturedPath)}, "captured\\n");
    while (await originalAccess(${JSON.stringify(capturedReleasePath)}).then(
      () => false,
      () => true,
    )) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return result;
};
fsPromises.rm = async (path, ...rest) => {
  if (mode === "cleanup" && String(path) === manifestPath) await pause();
  return originalRm(path, ...rest);
};
syncBuiltinESMExports();
`);
  return {
    armPath,
    blockedPath,
    capturedPath,
    capturedReleasePath,
    preloadPath,
    releasePath,
  };
};
