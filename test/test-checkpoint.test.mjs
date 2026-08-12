import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const stalledHarnessRunFixture = new URL(
  "./stalled-harness-run-checkpoint.fixture.mjs",
  import.meta.url,
);
const childEnvironment = { ...process.env };
delete childEnvironment.NODE_TEST_CONTEXT;

test("one source-stalled Harness-run checkpoint fails boundedly without cancelling later tests", {
  skip: process.platform !== "linux"
    ? "the source-created cancellation-confirmation stall is Linux-specific"
    : false,
}, async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      "--test",
      fileURLToPath(stalledHarnessRunFixture),
    ], {
      env: childEnvironment,
      // The second nested case receives the ordinary Harness-run terminal
      // budget after the source-stalled case has failed boundedly.
      timeout: 75_000,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(
        error.stdout,
        /harness_run_test_checkpoint_timeout:cancellation_terminal_outcome_not_reached/,
      );
      assert.match(
        error.stdout,
        /not ok \d+ - a source-created Linux termination-confirmation stall fails boundedly/,
      );
      assert.match(
        error.stdout,
        /ok \d+ - a later Harness-run test still reaches its terminal outcome/,
      );
      assert.match(error.stdout, /# fail 1/);
      assert.match(error.stdout, /# cancelled 0/);
      return true;
    },
  );
});
