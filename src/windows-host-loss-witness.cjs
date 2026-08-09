const {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} = require("node:fs");

const terminationEvidencePath = process.argv[2];
const launchBarrierMarkerPath = process.argv[3];
if (
  typeof terminationEvidencePath !== "string"
  || terminationEvidencePath.length === 0
  || typeof launchBarrierMarkerPath !== "string"
  || launchBarrierMarkerPath.length === 0
) {
  process.exit(1);
}

let barrierDecision = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { barrierDecision += chunk; });
process.stdin.once("end", () => {
  if (
    barrierDecision === "assigned\n"
    || (existsSync(launchBarrierMarkerPath)
      && readFileSync(launchBarrierMarkerPath, "utf8") === "assigned\n")
  ) {
    process.exit(0);
  }
  try {
    const file = openSync(
      terminationEvidencePath,
      constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      writeFileSync(file, `${JSON.stringify({
        schemaVersion: 2,
        platform: "win32",
        status: "termination_confirmed",
        terminationScope: "complete_process_tree",
        launchSettled: true,
        treeEmpty: true,
        terminationBoundary: "launch_barrier_exit",
        observedAt: new Date().toISOString(),
      })}\n`);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    process.exit(0);
  } catch {
    // Missing evidence is uncertainty; startup will never treat it as proof.
    process.exit(2);
  }
});
process.stdin.resume();
