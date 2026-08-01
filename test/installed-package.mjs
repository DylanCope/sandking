import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
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
    observation: {
      command: "sandking",
      installed: true,
      launchedOutsideCheckout: true,
      tarballSha256,
    },
  };
};
