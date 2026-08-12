import assert from "node:assert/strict";
import test from "node:test";
import { waitForTestCheckpoint } from "./test-checkpoint.mjs";

test("a stalled checkpoint fails at its named bound", async () => {
  await waitForTestCheckpoint(
    new Promise(() => undefined),
    "deliberately_stalled_checkpoint",
    25,
  );
});

test("the test runner continues after a checkpoint timeout", () => {
  assert.ok(true);
});
