const { spawn } = require("node:child_process");
const { existsSync, lstatSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const markerPath = process.env.SANDKING_WINDOWS_JOB_BARRIER;
const terminationEvidencePath = process.env.SANDKING_HOST_LOSS_TERMINATION_EVIDENCE;
delete process.env.SANDKING_WINDOWS_JOB_BARRIER;
delete process.env.SANDKING_HOST_LOSS_TERMINATION_EVIDENCE;
if (typeof markerPath !== "string" || markerPath.length === 0) {
  throw new Error("windows_process_tree_barrier_invalid");
}
if (typeof terminationEvidencePath === "string" && terminationEvidencePath.length > 0) {
  const evidenceFile = lstatSync(terminationEvidencePath);
  if (
    !evidenceFile.isFile()
    || evidenceFile.isSymbolicLink()
    || evidenceFile.size !== 0
  ) {
    throw new Error("windows_process_tree_evidence_path_invalid");
  }
}
const terminationWitness = typeof terminationEvidencePath === "string"
  && terminationEvidencePath.length > 0
  ? spawn(process.execPath, [
      join(__dirname, "windows-host-loss-witness.cjs"),
      terminationEvidencePath,
      markerPath,
    ], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    })
  : null;
terminationWitness?.unref();
const deadline = Date.now() + 10_000;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(markerPath)) {
  if (Date.now() >= deadline) {
    throw new Error("windows_process_tree_barrier_timeout");
  }
  Atomics.wait(waitBuffer, 0, 0, 10);
}
if (readFileSync(markerPath, "utf8") !== "assigned\n") {
  throw new Error("windows_process_tree_barrier_aborted");
}
terminationWitness?.stdin?.end("assigned\n");
