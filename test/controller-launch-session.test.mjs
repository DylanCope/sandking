import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createControllerSessionManager } from "../src/controller-sessions.mjs";

const waitFor = async (predicate) => {
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("provider_operation_timeout");
};

test("a project-focused conformance Controller launches in one revision-free action", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-controller-launch-"));
  const audits = [];
  const operations = [];
  const projectId = `project-${"2".repeat(24)}`;
  const harnessRunId = `harness-run-${"6".repeat(24)}`;
  let launchOutcome = null;
  let launchAttempts = 0;
  let manager;
  try {
    manager = await createControllerSessionManager({
      dataDir,
      recordAudit: async (action, outcome, details = {}) => {
        const auditId = `audit-${String(audits.length + 1).padStart(24, "0")}`;
        audits.push({ auditId, action, outcome, details });
        return auditId;
      },
      handleProviderOperation: async (request) => {
        operations.push(request);
        if (request.operation === "harness-run.launch") {
          launchAttempts += 1;
          launchOutcome = {
            type: "harness.run.launch.result",
            code: "harness_run_created",
            idempotentReplay: false,
            run: { harnessRunId },
          };
          // Exercise ambiguous-response recovery without issuing a second launch.
          await new Promise((resolve) => setTimeout(resolve, 3_250));
          return launchOutcome;
        }
        if (request.operation === "harness-run.lookup") {
          return {
            type: "harness.run.lookup.result",
            code: launchOutcome
              ? "harness_run_launch_outcome_found"
              : "harness_run_launch_outcome_absent",
            found: Boolean(launchOutcome),
            launchOutcome,
          };
        }
        throw new Error("unexpected_provider_operation");
      },
    });
    const session = await manager.start({
      workContextId: projectId,
      kind: "project",
      canonicalReference: `sandking:project:${projectId}`,
    });
    assert.ok(session.provider.capabilities.includes("controller.harness-run.launch"));
    assert.equal(session.provider.capabilities.some((capability) =>
      /launch-request|approve|skill/.test(capability)), false);

    const output = [];
    const socket = { readyState: 1 };
    const attached = await manager.attach({
      socket,
      sessionId: session.sessionId,
      streamId: session.terminal.streamId,
      attachmentId: session.terminal.writableAttachment.attachmentId,
      mode: "read-write",
      outputCursor: 0,
      onOutput: (_socket, frame) => output.push(frame.data.toString("utf8")),
    });
    assert.equal(attached.activate(), true);
    let sequence = 0;
    const enter = (line) => manager.write({
      socket,
      streamId: session.terminal.streamId,
      sequence: sequence++,
      eof: false,
      data: Buffer.from(`${line}\n`),
    });

    await waitFor(() => output.join("").includes("Conformance Controller ready"));
    await enter("prepare 152 sandcastle/issue-152");
    await waitFor(() => output.join("").includes("did not recognize"));
    assert.equal(operations.length, 0);

    await enter("launch 152 sandcastle/issue-152");
    await waitFor(() => output.join("").includes(
      `Harness run ${harnessRunId} created`,
    ));
    assert.equal(launchAttempts, 1);
    assert.deepEqual(operations.map((operation) => operation.operation), [
      "harness-run.launch",
      "harness-run.lookup",
    ]);
    assert.deepEqual(operations[0].input.parameters, {
      issueNumber: 152,
      targetBranch: "sandcastle/issue-152",
    });
    assert.equal("expectedRevision" in operations[0].input, false);
    assert.equal(operations[0].input.idempotencyKey, operations[1].input.idempotencyKey);
    assert.doesNotMatch(output.join(""), /Launch request|approve|reject|--plugin-dir/i);
    assert.ok(audits.some((audit) => audit.action === "controller.provider.operation"
      && audit.details.operation === "harness-run.launch"));
  } finally {
    await manager?.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});
