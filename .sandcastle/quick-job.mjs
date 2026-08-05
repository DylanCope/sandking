import { randomBytes } from "node:crypto";

export const generateQuickBranchName = ({
  now = () => Date.now(),
  randomSuffix = () => randomBytes(3).toString("hex"),
} = {}) => `sandcastle/quick-${now()}-${randomSuffix()}`;

export async function runQuickJob({ prompt, branch, createSandbox }) {
  if (!prompt || !prompt.trim()) {
    throw new Error("A prompt is required for a quick job.");
  }

  const resolvedBranch = branch ?? generateQuickBranchName();
  const sandbox = await createSandbox(resolvedBranch);

  try {
    const output = await sandbox.run(prompt);
    return { branch: resolvedBranch, succeeded: true, output };
  } catch (error) {
    return {
      branch: resolvedBranch,
      succeeded: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await sandbox.close();
  }
}
