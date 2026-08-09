import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceRoot = new URL("..", import.meta.url);

/** @param {string} root */
export const installCurrentPackage = async (root) => {
  const installDirectory = join(root, "installed-package");
  await mkdir(installDirectory, { recursive: true });
  const { stdout: packOutput } = await execFileAsync("npm", [
    "pack",
    "--json",
    "--pack-destination",
    root,
  ], { cwd: sourceRoot });
  const [{ filename }] = JSON.parse(packOutput);
  const tarball = join(root, filename);
  await execFileAsync("npm", [
    "install",
    "--ignore-scripts",
    "--omit=dev",
    "--prefix",
    installDirectory,
    tarball,
  ], { cwd: root });
  const tarballSha256 = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
  return {
    command: join(installDirectory, "node_modules", ".bin", "sandking"),
    packageDirectory: join(installDirectory, "node_modules", "sandking"),
    observation: {
      command: "sandking",
      installed: true,
      launchedOutsideCheckout: true,
      tarballSha256,
    },
  };
};

/**
 * Add one deterministic process pause to a temporary installed test copy. The
 * helper and injected source are excluded from the production tarball.
 * @param {{packageDirectory: string}} installed
 * @param {string} faultPoint
 */
export const pauseInstalledHostAtHarnessRunFault = async (installed, faultPoint) => {
  const localHostPath = join(installed.packageDirectory, "src", "local-host.mjs");
  const source = await readFile(localHostPath, "utf8");
  const anchor = "    loadLaunchContext: projectRegistry.loadLaunchContext,\n";
  if (source.split(anchor).length !== 2) {
    throw new Error("installed_host_fault_instrumentation_anchor_invalid");
  }
  const instrumented = source.replace(anchor, `${anchor}    faultInjector: (point) => {\n`
    + `      if (point === ${JSON.stringify(faultPoint)}) {\n`
    + "        process.kill(process.pid, \"SIGSTOP\");\n"
    + "      }\n"
    + "    },\n");
  await writeFile(localHostPath, instrumented, { mode: 0o755 });
};
