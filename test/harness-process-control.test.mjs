import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { sendHarnessCancellationRequest } from "../src/harness-process-control.mjs";

test("the Windows cooperative interval uses a typed adapter request without killing the adapter", async () => {
  const child = spawn(process.execPath, ["--eval", `
    process.channel?.unref();
    process.once("message", (message) => {
      process.send?.({ type: "observed", message });
      process.exit(0);
    });
    setInterval(() => undefined, 1000);
  `], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let killCalled = false;
  child.kill = () => {
    killCalled = true;
    return true;
  };
  const observed = new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
  });
  try {
    const request = {
      type: "harness.run.cancel",
      adapterProtocol: "1.0.0",
      adapterId: "conformance-harness-adapter-v1",
      harnessRunId: `harness-run-${"a".repeat(24)}`,
      cooperativeDeadlineAt: "2026-08-07T10:00:01.000Z",
    };
    assert.equal(sendHarnessCancellationRequest(child, request), true);
    assert.deepEqual(await observed, { type: "observed", message: request });
    assert.equal(killCalled, false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(child.pid, "SIGKILL");
    }
  }
});
