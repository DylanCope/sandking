const { existsSync } = require("node:fs");

const markerPath = process.env.SANDKING_WINDOWS_JOB_BARRIER;
delete process.env.SANDKING_WINDOWS_JOB_BARRIER;
if (typeof markerPath !== "string" || markerPath.length === 0) {
  throw new Error("windows_process_tree_barrier_invalid");
}
const deadline = Date.now() + 10_000;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(markerPath)) {
  if (Date.now() >= deadline) {
    throw new Error("windows_process_tree_barrier_timeout");
  }
  Atomics.wait(waitBuffer, 0, 0, 10);
}
