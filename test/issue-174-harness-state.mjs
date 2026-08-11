const productionAdapterId = "sandcastle-harness-adapter-v1";

export const waitForIssue174ProductionHarness = async ({
  readState,
  pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = 90_000,
}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readState().catch(() => null);
    const harness = state?.harnesses?.find((candidate) =>
      candidate.adapterId === productionAdapterId);
    if (harness) return harness;
    await pause(100);
  }
  throw new Error("issue_174_default_production_harness_missing");
};
