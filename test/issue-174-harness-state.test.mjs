import assert from "node:assert/strict";
import test from "node:test";
import { waitForIssue174ProductionHarness } from "./issue-174-harness-state.mjs";

test("the gated runner waits for the default production Harness registry", async () => {
  let reads = 0;
  const harness = await waitForIssue174ProductionHarness({
    readState: async () => {
      reads += 1;
      if (reads < 3) throw new Error("registry_not_published_yet");
      return {
        harnesses: [{
          harnessId: "harness-111111111111111111111111",
          adapterId: "sandcastle-harness-adapter-v1",
          workspacePath: "/host/harness",
        }],
      };
    },
    pause: async () => undefined,
    timeoutMs: 1_000,
  });

  assert.equal(reads, 3);
  assert.equal(harness.adapterId, "sandcastle-harness-adapter-v1");
});
