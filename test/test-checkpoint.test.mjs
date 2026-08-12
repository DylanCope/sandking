import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const harnessRunTests = new URL(
  "./harness-run.test.mjs",
  import.meta.url,
);
const childEnvironment = { ...process.env };
delete childEnvironment.NODE_TEST_CONTEXT;
childEnvironment.SANDKING_TEST_STALL_CANCELLATION_CONFIRMATION = "1";

test("one stalled Harness-run checkpoint fails boundedly without cancelling later tests", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      "--test",
      "--test-name-pattern",
      "uncertain termination confirmation|a valid terminal outcome committed before cancellation",
      fileURLToPath(harnessRunTests),
    ], {
      env: childEnvironment,
      // The nested run executes two real process-supervision tests. Give the
      // regression the same terminal budget as the Harness-run suite itself.
      timeout: 60_000,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(
        error.stdout,
        /harness_run_test_checkpoint_timeout:cancellation_termination_confirmation_not_attempted/,
      );
      assert.match(
        error.stdout,
        /not ok \d+ - uncertain termination confirmation never invents a cancelled outcome/,
      );
      assert.match(
        error.stdout,
        /ok \d+ - a valid terminal outcome committed before cancellation remains the one outcome/,
      );
      assert.match(error.stdout, /# fail 1/);
      assert.match(error.stdout, /# cancelled 0/);
      return true;
    },
  );
});
