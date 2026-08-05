// Sandcastle quick job
//
// A lightweight, GitHub-free alternative to the full issue-delivery loop in
// main.mts. Give it a plain-language prompt; it runs Codex against a fresh
// throwaway branch (its own git worktree, so your checked-out branch and
// working tree are never touched) and leaves you with a branch to review or
// discard — no issue, no pull request, no independent review pass.
//
// Usage:
//   npm run sandcastle:quick -- "Rename foo to bar everywhere" [--branch <name>] [--max-iterations <n>]

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { readFile } from "node:fs/promises";
import {
  createCodexSandboxSettings,
  createRunSettings,
} from "./sandbox-settings.mjs";
import { generateQuickBranchName, runQuickJob } from "./quick-job.mjs";

const parseArgs = (argv: string[]) => {
  const positional: string[] = [];
  let branch: string | undefined;
  let maxIterations = 20;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--branch") {
      branch = argv[index + 1];
      index += 1;
    } else if (arg === "--max-iterations") {
      maxIterations = Number(argv[index + 1]);
      index += 1;
    } else {
      positional.push(arg);
    }
  }

  const prompt = positional.join(" ").trim();
  if (!prompt) {
    throw new Error(
      'Usage: npm run sandcastle:quick -- "<prompt>" [--branch <name>] [--max-iterations <n>]',
    );
  }
  if (!Number.isFinite(maxIterations) || maxIterations <= 0) {
    throw new Error("--max-iterations must be a positive number.");
  }
  return { prompt, branch, maxIterations };
};

const { prompt, branch, maxIterations } = parseArgs(process.argv.slice(2));

const sandboxSettings = createCodexSandboxSettings();
const runSettings = createRunSettings();
const promptTemplate = await readFile(
  new URL("./quick-prompt.md", import.meta.url),
  "utf8",
);

const resolvedBranch = branch ?? generateQuickBranchName();
const renderedPrompt = promptTemplate
  .replace("{{PROMPT}}", prompt)
  .replaceAll("{{BRANCH}}", resolvedBranch);

const createSandbox = async (targetBranch: string) => {
  const sandbox = await sandcastle.createSandbox({
    branch: targetBranch,
    sandbox: docker(sandboxSettings.docker),
    hooks: sandboxSettings.hooks,
    copyToWorktree: ["node_modules"],
  });

  return {
    run: (renderedPromptForRun: string) =>
      sandbox.run({
        ...runSettings,
        name: "quick",
        maxIterations,
        agent: sandcastle.codex("gpt-5.6-sol", { effort: "xhigh" }),
        prompt: renderedPromptForRun,
      }),
    close: () => sandbox.close(),
  };
};

console.log(`Running quick job on throwaway branch ${resolvedBranch} ...`);

const result = await runQuickJob({
  prompt: renderedPrompt,
  branch: resolvedBranch,
  createSandbox,
});

if (result.succeeded) {
  console.log(`\n✓ Done. Review with: git diff main...${result.branch}`);
  console.log(`  Discard with: git branch -D ${result.branch}`);
} else {
  console.error(`\n✗ Quick job failed: ${result.error}`);
  console.error(`  Whatever was committed before the failure is on ${result.branch}.`);
  console.error(`  Discard with: git branch -D ${result.branch}`);
  process.exitCode = 1;
}
