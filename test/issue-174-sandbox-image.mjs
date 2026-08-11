import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const inspectIssue174SandboxImage = async (
  imageName,
  executeFile = execFileAsync,
) => {
  try {
    const imageId = (await executeFile("docker", [
      "image", "inspect", imageName, "--format={{.Id}}",
    ], { env: process.env, timeout: 10_000 })).stdout.trim();
    return /^sha256:[a-f0-9]{64}$/.test(imageId) ? imageId : null;
  } catch {
    return null;
  }
};

export const prepareIssue174SandboxImage = async ({
  projectionPath,
  imageName,
  dockerfilePath,
  executeFile = execFileAsync,
  inspectImage = inspectIssue174SandboxImage,
}) => {
  try {
    await executeFile("npm", [
      "ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
    ], {
      cwd: projectionPath,
      env: process.env,
      shell: process.platform === "win32",
      timeout: 10 * 60_000,
      maxBuffer: 1024 * 1024,
    });
    await executeFile(process.execPath, [
      join(
        projectionPath,
        "node_modules",
        "@ai-hero",
        "sandcastle",
        "dist",
        "main.js",
      ),
      "docker",
      "build-image",
      "--image-name", imageName,
      "--dockerfile", dockerfilePath,
    ], {
      cwd: projectionPath,
      env: process.env,
      timeout: 20 * 60_000,
      maxBuffer: 1024 * 1024,
    });
  } finally {
    await rm(join(projectionPath, "node_modules"), { recursive: true, force: true });
  }
  const imageId = await inspectImage(imageName);
  if (!imageId) throw new Error("issue_174_real_sandbox_image_invalid");
  return imageId;
};

export const restoreIssue174SandboxImage = async ({
  fixedImageName,
  fixedImageBefore,
  fixedTagChanged,
  temporaryImageName,
  temporaryImageOwned,
  executeFile = execFileAsync,
  inspectImage = inspectIssue174SandboxImage,
}) => {
  if (fixedTagChanged) {
    if (fixedImageBefore) {
      await executeFile("docker", ["tag", fixedImageBefore, fixedImageName], {
        env: process.env,
      });
    } else {
      await executeFile("docker", ["image", "rm", fixedImageName], {
        env: process.env,
      });
    }
  }
  if (temporaryImageOwned && await inspectImage(temporaryImageName)) {
    await executeFile("docker", ["image", "rm", temporaryImageName], {
      env: process.env,
    });
  }
  if (
    await inspectImage(fixedImageName) !== fixedImageBefore
    || (temporaryImageOwned && await inspectImage(temporaryImageName) !== null)
  ) {
    throw new Error("issue_174_real_sandbox_cleanup_failed");
  }
};
