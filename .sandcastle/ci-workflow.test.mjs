import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);

async function readQuarantineJobs() {
  const lines = (await readFile(workflowUrl, "utf8")).split("\n");
  const jobStarts = lines.flatMap((line, index) =>
    /^  [a-z0-9-]+:$/.test(line) ? [index] : []);
  const jobs = jobStarts.map((start, index) =>
    lines.slice(start, jobStarts[index + 1] ?? lines.length));
  return jobs.filter((job) =>
    job.some((line) => /^    name: Quarantine - /.test(line)));
}

test("quarantined test failures do not fail their pull request checks", async () => {
  const quarantineJobs = await readQuarantineJobs();
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

test("successful quarantine checks still disclose absorbed test failures", async () => {
  const quarantineJobs = await readQuarantineJobs();
  assert.ok(quarantineJobs.length > 0, "expected at least one quarantine job");
  for (const job of quarantineJobs) {
    const quarantineStep = job.findIndex((line) =>
      /^      - name: Run quarantined /.test(line));
    assert.notEqual(quarantineStep, -1, "expected a quarantined test step");
    assert.equal(
      job[quarantineStep + 1],
      "        id: quarantined-tests",
      "the quarantined test outcome must be addressable by its reporting step",
    );

    const reportStep = job.findIndex((line) =>
      line === "      - name: Report allowed quarantine failure");
    assert.notEqual(reportStep, -1, "expected an allowed-failure report step");
    assert.equal(
      job[reportStep + 1],
      "        if: steps.quarantined-tests.outcome == 'failure'",
      "the report must use the absorbed test outcome",
    );
    assert.ok(
      job.slice(reportStep).some((line) => line.includes("GITHUB_STEP_SUMMARY")),
      "the passing check must summarize its allowed failure",
    );
  }
});
