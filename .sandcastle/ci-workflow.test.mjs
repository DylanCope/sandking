import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);

test("quarantined test failures do not fail their pull request checks", async () => {
  const lines = (await readFile(workflowUrl, "utf8")).split("\n");
  const jobStarts = lines.flatMap((line, index) =>
    /^  [a-z0-9-]+:$/.test(line) ? [index] : []);
  const jobs = jobStarts.map((start, index) =>
    lines.slice(start, jobStarts[index + 1] ?? lines.length));
  const quarantineJobs = jobs.filter((job) =>
    job.some((line) => /^    name: Quarantine - /.test(line)));

  assert.ok(quarantineJobs.length > 0, "expected at least one quarantine job");
  for (const job of quarantineJobs) {
    assert.ok(
      !job.some((line) => /^    continue-on-error:/.test(line)),
      "job-level allowed failures still produce a failed pull request check",
    );

    const quarantineStep = job.findIndex((line) =>
      /^      - name: Run quarantined /.test(line));
    assert.notEqual(quarantineStep, -1, "expected a quarantined test step");
    const followingStep = job.findIndex((line, index) =>
      index > quarantineStep && /^      - name: /.test(line));
    const quarantineStepLines = job.slice(
      quarantineStep,
      followingStep === -1 ? job.length : followingStep,
    );
    assert.ok(
      quarantineStepLines.includes("        continue-on-error: true"),
      "the quarantined test step must absorb its failure inside a passing job",
    );
  }
});
