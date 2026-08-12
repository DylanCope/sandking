import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const stalledCheckpointFixture = new URL(
  "./stalled-test-checkpoint.fixture.mjs",
  import.meta.url,
);
const childEnvironment = { ...process.env };
delete childEnvironment.NODE_TEST_CONTEXT;

test("one stalled checkpoint fails boundedly without cancelling later tests", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["--test", fileURLToPath(stalledCheckpointFixture)], {
      env: childEnvironment,
      timeout: 2_000,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(
        error.stdout,
        /harness_run_test_checkpoint_timeout:deliberately_stalled_checkpoint/,
      );
      assert.match(error.stdout, /not ok 1 - a stalled checkpoint fails at its named bound/);
      assert.match(error.stdout, /ok 2 - the test runner continues after a checkpoint timeout/);
      assert.match(error.stdout, /# fail 1/);
      assert.match(error.stdout, /# cancelled 0/);
      return true;
    },
  );
});
