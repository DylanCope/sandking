import { execFile } from "node:child_process";
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
