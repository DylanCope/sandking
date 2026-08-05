import assert from "node:assert/strict";
import test from "node:test";
import { generateQuickBranchName, runQuickJob } from "./quick-job.mjs";

test("a quick branch name is namespaced, chronological, and unique per call", () => {
  const name = generateQuickBranchName({
    now: () => 1234567890000,
    randomSuffix: () => "abc123",
  });

  assert.equal(name, "sandcastle/quick-1234567890000-abc123");
  assert.notEqual(generateQuickBranchName(), generateQuickBranchName());
});

test("a quick job rejects a missing or blank prompt before creating any sandbox", async () => {
  let sandboxesCreated = 0;
  const createSandbox = async () => {
    sandboxesCreated += 1;
    return { run: async () => "unused", close: async () => {} };
  };

  await assert.rejects(
    () => runQuickJob({ prompt: "  ", createSandbox }),
    /prompt is required/i,
  );
  assert.equal(sandboxesCreated, 0);
});

test("a quick job runs the prompt in a throwaway branch and reports success without any GitHub interaction", async () => {
  const calls = [];
  const createSandbox = async (branch) => {
    calls.push({ step: "create", branch });
    return {
      run: async (prompt) => {
        calls.push({ step: "run", prompt });
        return "did the thing";
      },
      close: async () => {
        calls.push({ step: "close" });
      },
    };
  };

  const result = await runQuickJob({
    prompt: "Rename foo to bar",
    branch: "sandcastle/quick-fixed-branch",
    createSandbox,
  });

  assert.deepEqual(result, {
    branch: "sandcastle/quick-fixed-branch",
    succeeded: true,
    output: "did the thing",
  });
  assert.deepEqual(calls, [
    { step: "create", branch: "sandcastle/quick-fixed-branch" },
    { step: "run", prompt: "Rename foo to bar" },
    { step: "close" },
  ]);
});

test("a quick job generates a throwaway branch name when none is supplied", async () => {
  let capturedBranch;
  const createSandbox = async (branch) => {
    capturedBranch = branch;
    return { run: async () => "ok", close: async () => {} };
  };

  const result = await runQuickJob({ prompt: "Do a thing", createSandbox });

  assert.match(capturedBranch, /^sandcastle\/quick-\d+-[0-9a-f]+$/);
  assert.equal(result.branch, capturedBranch);
});

test("a quick job always closes the sandbox even when the run fails, and reports failure instead of throwing", async () => {
  let closed = false;
  const createSandbox = async () => ({
    run: async () => {
      throw new Error("codex blew up");
    },
    close: async () => {
      closed = true;
    },
  });

  const result = await runQuickJob({
    prompt: "Do a thing",
    branch: "sandcastle/quick-will-fail",
    createSandbox,
  });

  assert.equal(closed, true);
  assert.deepEqual(result, {
    branch: "sandcastle/quick-will-fail",
    succeeded: false,
    error: "codex blew up",
  });
});

test("a quick job does not attempt to close a sandbox that never finished creating", async () => {
  const createSandbox = async () => {
    throw new Error("docker daemon unavailable");
  };

  await assert.rejects(
    () => runQuickJob({ prompt: "Do a thing", createSandbox }),
    /docker daemon unavailable/,
  );
});
