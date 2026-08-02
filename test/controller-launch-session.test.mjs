import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createControllerSessionManager } from "../src/controller-sessions.mjs";

const waitFor = async (predicate) => {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("provider_operation_timeout");
};

test("a project-focused conformance Controller invokes typed Launch operations", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-controller-launch-"));
  const audits = [];
  const operations = [];
  const launchRequestId = `launch-request-${"1".repeat(24)}`;
  const harnessRunId = `harness-run-${"6".repeat(24)}`;
  const projectId = `project-${"2".repeat(24)}`;
  const harnessId = `harness-${"3".repeat(24)}`;
  const pinnedRevision = "4".repeat(40);
  const overlongIssueNumber = "9".repeat(400);
  let canonicalStartOutcome = null;
  let startAttempts = 0;
  const recordAudit = async (action, outcome, details) => {
    const auditId = `audit-${String(audits.length + 1).padStart(24, "0")}`;
    audits.push({ auditId, action, outcome, details });
    return auditId;
  };
  const handleProviderOperation = async (request) => {
    operations.push(request);
    if (request.operation === "work-context.inspect") {
      return {
        type: "project.work-context",
        projectId,
        revision: 2,
        displayName: "selected-project",
        harnessId,
        pinnedRevision,
      };
    }
    if (request.operation === "launch-request.prepare") {
      if (request.input.parameters.issueNumber === overlongIssueNumber) {
        return {
          type: "launch.request.prepare.failure",
          code: "bounded_configuration_invalid",
          idempotentReplay: false,
        };
      }
      return {
        type: "launch.request.prepare.result",
        code: "launch_request_prepared",
        revision: 1,
        launchRequest: {
          launchRequestId,
          revision: 1,
          preview: {
            summary: "Delegate GitHub issue #119 on sandcastle/issue-119.",
            hostId: `host-${"5".repeat(24)}`,
            projectId,
            harnessId,
            harnessPinnedRevision: pinnedRevision,
            parameters: { issueNumber: 119, targetBranch: "sandcastle/issue-119" },
            suppliedCapabilities: ["github.issues.read", "project.git.read"],
            authorizationClass: "focused_controller_launch",
            expiresAt: "2026-08-01T12:05:00.000Z",
            secretFree: true,
            delegatedWorkStarted: false,
          },
        },
      };
    }
    if (request.operation === "launch-request.decide") {
      return {
        type: "launch.request.decision.result",
        code: "launch_request_approved",
        revision: 2,
        idempotentReplay: false,
        launchRequest: {
          launchRequestId,
          status: "approved",
          revision: 2,
          execution: { status: "not_started" },
        },
      };
    }
    if (request.operation === "harness-run.start") {
      startAttempts += 1;
      canonicalStartOutcome = {
        type: "harness.run.start.result",
        code: "harness_run_created",
        idempotentReplay: false,
        run: { harnessRunId },
      };
      await new Promise((resolve) => setTimeout(resolve, 3_250));
      return canonicalStartOutcome;
    }
    if (request.operation === "harness-run.lookup") {
      return {
        type: "harness.run.lookup.result",
        code: canonicalStartOutcome
          ? "harness_run_start_outcome_found"
          : "harness_run_start_outcome_absent",
        found: Boolean(canonicalStartOutcome),
        startOutcome: canonicalStartOutcome,
      };
    }
    throw new Error("unexpected_provider_operation");
  };

  let manager;
  try {
    manager = await createControllerSessionManager({
      dataDir,
      recordAudit,
      handleProviderOperation,
    });
    const session = await manager.start({
      workContextId: projectId,
      kind: "project",
      canonicalReference: `sandking:project:${projectId}`,
    });
    assert.equal(session.workContext.kind, "project");
    assert.ok(session.provider.capabilities.includes("controller.launch-request.prepare"));
    assert.ok(session.provider.capabilities.includes("controller.launch-request.decide"));

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
    output.push(...attached.frames.map((frame) => frame.data.toString("utf8")));
    assert.equal(attached.activate(), true);
    const readOnlyOutput = [];
    const readOnlySocket = { readyState: 1 };
    const readOnly = await manager.attach({
      socket: readOnlySocket,
      sessionId: session.sessionId,
      streamId: session.terminal.streamId,
      attachmentId: session.terminal.writableAttachment.attachmentId,
      mode: "read-only",
      outputCursor: 0,
      onOutput: (_socket, frame) => readOnlyOutput.push(frame.data.toString("utf8")),
    });
    readOnlyOutput.push(...readOnly.frames.map((frame) => frame.data.toString("utf8")));
    assert.equal(readOnly.activate(), true);
    assert.equal(readOnly.mode, "read-only");
    assert.equal(readOnly.exclusive, false);
    assert.equal(typeof manager.resize, "function");
    assert.deepEqual(await manager.resize({
      socket,
      sessionId: session.sessionId,
      streamId: session.terminal.streamId,
      attachmentId: session.terminal.writableAttachment.attachmentId,
      sequence: 0,
      columns: 120,
      rows: 40,
    }), {
      sessionId: session.sessionId,
      streamId: session.terminal.streamId,
      attachmentId: session.terminal.writableAttachment.attachmentId,
      sequence: 0,
      columns: 120,
      rows: 40,
    });
    await assert.rejects(manager.resize({
      socket: readOnlySocket,
      sessionId: session.sessionId,
      streamId: session.terminal.streamId,
      attachmentId: session.terminal.writableAttachment.attachmentId,
      sequence: 1,
      columns: 100,
      rows: 30,
    }), (error) => error.code === "terminal_resize_attachment_required");
    await assert.rejects(manager.resize({
      socket,
      sessionId: session.sessionId,
      streamId: session.terminal.streamId,
      attachmentId: session.terminal.writableAttachment.attachmentId,
      sequence: 0,
      columns: 100,
      rows: 30,
    }), (error) => error.code === "terminal_resize_sequence_conflict");
    await assert.rejects(manager.resize({
      socket,
      sessionId: session.sessionId,
      streamId: session.terminal.streamId,
      attachmentId: `terminal-attachment-${"9".repeat(24)}`,
      sequence: 1,
      columns: 100,
      rows: 30,
    }), (error) => error.code === "controller_terminal_not_found");
    await assert.rejects(manager.resize({
      socket,
      sessionId: `controller-session-${"8".repeat(24)}`,
      streamId: session.terminal.streamId,
      attachmentId: session.terminal.writableAttachment.attachmentId,
      sequence: 1,
      columns: 100,
      rows: 30,
    }), (error) => error.code === "controller_terminal_not_found");
    await assert.rejects(manager.resize({
      socket,
      sessionId: session.sessionId,
      streamId: session.terminal.streamId,
      attachmentId: session.terminal.writableAttachment.attachmentId,
      sequence: 1,
      columns: 501,
      rows: 30,
    }), (error) => error.code === "terminal_resize_dimensions_invalid");
    await assert.rejects(manager.write({
      socket: readOnlySocket,
      streamId: session.terminal.streamId,
      sequence: 0,
      eof: false,
      data: Buffer.from("approve anything\n", "utf8"),
    }), (error) => error.code === "terminal_write_attachment_required");
    let inputSequence = 0;
    const enter = async (line) => manager.write({
      socket,
      streamId: session.terminal.streamId,
      sequence: inputSequence++,
      eof: false,
      data: Buffer.from(`${line}\n`, "utf8"),
    });

    await enter("inspect");
    await waitFor(() => output.join("").includes(`Project identity: ${projectId} (revision 2)`));
    await waitFor(() => readOnlyOutput.join("").includes(`Project identity: ${projectId}`));
    await enter(`prepare ${overlongIssueNumber} sandcastle/issue-${overlongIssueNumber}`);
    await waitFor(() => output.join("").includes(
      "Launch preparation failed safely: bounded_configuration_invalid",
    ));
    await enter("prepare 119 sandcastle/issue-119");
    await waitFor(() => output.join("").includes(`Launch request: ${launchRequestId} (revision 1)`));
    const previewOutput = output.join("");
    assert.match(previewOutput, new RegExp(`Host: host-${"5".repeat(24)}`));
    assert.match(previewOutput, new RegExp(`Harness: ${harnessId} @ ${pinnedRevision}`));
    assert.match(previewOutput, /Secret-free preview: yes/);
    assert.match(previewOutput, /Delegated work started: no/);
    assert.match(previewOutput,
      new RegExp(`approve ${launchRequestId} 1|reject ${launchRequestId} 1`));

    await enter(`approve ${launchRequestId} 1`);
    await waitFor(() => output.join("").includes(
      `Launch request ${launchRequestId} approved at revision 2.`,
    ));
    await enter(`start ${launchRequestId} 2`);
    await waitFor(() => output.join("").includes(
      "Recovered the accepted outcome by exact idempotency-key lookup",
    ));
    assert.match(output.join(""), new RegExp(`Harness run ${harnessRunId} created`));
    assert.match(output.join(""), /Recovered the accepted outcome by exact idempotency-key lookup/);
    assert.equal(startAttempts, 1);
    const downgraded = await manager.attach({
      socket,
      sessionId: session.sessionId,
      streamId: session.terminal.streamId,
      attachmentId: session.terminal.writableAttachment.attachmentId,
      mode: "read-only",
      outputCursor: 0,
      onOutput: (_socket, frame) => output.push(frame.data.toString("utf8")),
    });
    assert.equal(downgraded.activate(), true);
    assert.equal(downgraded.mode, "read-only");
    assert.equal(downgraded.exclusive, false);
    await assert.rejects(manager.write({
      socket,
      streamId: session.terminal.streamId,
      sequence: inputSequence,
      eof: false,
      data: Buffer.from("approve after read-only downgrade\n", "utf8"),
    }), (error) => error.code === "terminal_write_attachment_required");
    assert.deepEqual(operations.map((operation) => operation.operation), [
      "work-context.inspect",
      "launch-request.prepare",
      "launch-request.prepare",
      "launch-request.decide",
      "harness-run.start",
      "harness-run.lookup",
    ]);
    assert.ok(operations.every((operation) =>
      operation.sessionId === session.sessionId
      && operation.providerSessionId === session.provider.providerSessionId
      && operation.workContext.projectId === undefined
      && operation.workContext.workContextId === projectId));
    assert.deepEqual(operations[1].input.parameters, {
      issueNumber: overlongIssueNumber,
      targetBranch: `sandcastle/issue-${overlongIssueNumber}`,
    });
    assert.ok(operations[1].input.idempotencyKey.length <= 256);
    assert.deepEqual(operations[2].input, {
      parameters: { issueNumber: 119, targetBranch: "sandcastle/issue-119" },
      expiresInSeconds: 300,
      idempotencyKey: operations[2].input.idempotencyKey,
    });
    assert.deepEqual(operations[3].input, {
      launchRequestId,
      decision: "approved",
      expectedRevision: 1,
      idempotencyKey: operations[3].input.idempotencyKey,
    });
    assert.equal(
      operations[4].input.idempotencyKey,
      operations[5].input.idempotencyKey,
    );
    manager.detach(socket);
    const reconnectSocket = { readyState: 1 };
    const reattached = await manager.attach({
      socket: reconnectSocket,
      sessionId: session.sessionId,
      streamId: session.terminal.streamId,
      attachmentId: session.terminal.writableAttachment.attachmentId,
      mode: "read-write",
      outputCursor: 0,
      onOutput: (_socket, frame) => output.push(frame.data.toString("utf8")),
    });
    assert.equal(reattached.activate(), true);
    assert.equal(reattached.resizeSequence, 1);
    assert.deepEqual(await manager.resize({
      socket: reconnectSocket,
      sessionId: session.sessionId,
      streamId: session.terminal.streamId,
      attachmentId: session.terminal.writableAttachment.attachmentId,
      sequence: reattached.resizeSequence,
      columns: 100,
      rows: 32,
    }), {
      sessionId: session.sessionId,
      streamId: session.terminal.streamId,
      attachmentId: session.terminal.writableAttachment.attachmentId,
      sequence: 1,
      columns: 100,
      rows: 32,
    });
    const resizeAudits = audits.filter((entry) =>
      entry.action === "controller.terminal.resize" && entry.outcome === "observed");
    assert.deepEqual(resizeAudits.map((entry) => ({
      sequence: entry.details.sequence,
      columns: entry.details.columns,
      rows: entry.details.rows,
      contentRetained: entry.details.contentRetained,
    })), [
      { sequence: 0, columns: 120, rows: 40, contentRetained: false },
      { sequence: 1, columns: 100, rows: 32, contentRetained: false },
    ]);
    const sessionStartAudit = audits.find((entry) =>
      entry.action === "controller.session.start"
      && entry.outcome === "accepted"
      && entry.details.sessionId === session.sessionId);
    assert.equal(sessionStartAudit?.details.controllerSessionId, session.sessionId);
    assert.ok(audits.some((entry) =>
      entry.action === "controller.provider.operation"
      && entry.outcome === "accepted"
      && entry.details.operation === "launch-request.decide"
      && entry.details.sessionId === session.sessionId));
  } finally {
    await manager?.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});
