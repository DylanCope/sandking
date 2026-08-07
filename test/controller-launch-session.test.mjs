import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const secondHarnessRunId = `harness-run-${"7".repeat(24)}`;
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
            run: {
              harnessRunId: launchAttempts === 1 ? harnessRunId : secondHarnessRunId,
            },
          };
          // Exercise ambiguous-response recovery without issuing a second launch.
          if (launchAttempts === 1) {
            await new Promise((resolve) => setTimeout(resolve, 3_250));
          }
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

    await enter("launch");
    await waitFor(() => output.join("").includes(
      `Harness run ${harnessRunId} created`,
    ));
    assert.equal(launchAttempts, 1);
    assert.deepEqual(operations.map((operation) => operation.operation), [
      "harness-run.launch",
      "harness-run.lookup",
    ]);
    assert.equal("parameters" in operations[0].input, false);
    assert.equal("expectedRevision" in operations[0].input, false);
    assert.match(operations[0].input.idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(
      operations[0].input.idempotencyKeyHash,
      operations[1].input.idempotencyKeyHash,
    );
    assert.equal("idempotencyKey" in operations[0].input, false);
    assert.equal("idempotencyKey" in operations[1].input, false);

    await enter("launch");
    await waitFor(() => output.join("").includes(
      `Harness run ${secondHarnessRunId} created`,
    ));
    assert.equal(launchAttempts, 2);
    assert.deepEqual(operations.map((operation) => operation.operation), [
      "harness-run.launch",
      "harness-run.lookup",
      "harness-run.launch",
    ]);
    assert.notEqual(
      operations[2].input.idempotencyKeyHash,
      operations[0].input.idempotencyKeyHash,
    );
    assert.equal("idempotencyKey" in operations[2].input, false);
    assert.doesNotMatch(output.join(""), /Launch request|approve|reject|--plugin-dir/i);
    assert.ok(audits.some((audit) => audit.action === "controller.provider.operation"
      && audit.details.operation === "harness-run.launch"));
  } finally {
    await manager?.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("retained Controller sessions distinguish main-era capabilities from invalid hybrids", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sandking-controller-v1-upgrade-"));
  const sessionId = `controller-session-${"7".repeat(24)}`;
  const capabilities = [
    "controller.session.start",
    "controller.session.interactive",
    "controller.session.terminate",
    "controller.work-context.inspect",
    "controller.launch-request.prepare",
    "controller.launch-request.decide",
    "controller.harness-run.start",
    "controller.session.stable-identity",
    "controller.session.typed-exit",
  ];
  const retainedSession = {
    sessionId,
    providerSessionId: "550e8400-e29b-41d4-a716-446655440000",
    providerId: "claude-code",
    providerAdapterId: "claude-code-controller-adapter-v1",
    adapterProtocol: "1.0.0",
    capabilities,
    providerAvailability: {
      status: "available",
      command: "claude",
      version: "2.1.141",
      authentication: { status: "authenticated", source: "destination-local" },
      failure: null,
    },
    sessionIdentity: {
      stable: true,
      source: "controller-assigned-supported-cli-flag",
    },
    workContextId: "planning-stage-upgrade",
    workContextKind: "planning-stage",
    canonicalReference: "github:fixture:issue:119",
    providerControl: {
      protocol: "1.0.0",
      readySignal: "provider.session.ready",
      readyObservedAt: "2026-08-01T10:00:00.000Z",
      providerObservedTty: true,
    },
    terminal: {
      streamId: `controller-terminal-${"9".repeat(24)}`,
      runtimeOwned: true,
      kind: "pty",
      status: "exited",
      startedAt: "2026-08-01T10:00:00.000Z",
      exitedAt: "2026-08-01T10:01:00.000Z",
      exitCode: 0,
      signal: null,
      exitReason: {
        code: "provider_session_completed",
        retryable: false,
        source: "claude-cli",
      },
    },
  };
  const writeRetainedSession = (session) => writeFile(
    join(dataDir, "controller-sessions.json"),
    `${JSON.stringify({ schemaVersion: 1, sessions: [session] })}\n`,
  );
  await writeRetainedSession(retainedSession);

  let manager;
  try {
    manager = await createControllerSessionManager({
      dataDir,
      recordAudit: async () => `audit-${"0".repeat(24)}`,
    });
    assert.deepEqual(manager.inspect(sessionId)?.capabilities, capabilities);
    await manager.shutdown();
    manager = null;

    await writeRetainedSession({
      ...retainedSession,
      capabilities: [
        "controller.session.start",
        "controller.session.interactive",
        "controller.session.terminate",
        "controller.harness-run.launch",
        "controller.launch-request.prepare",
      ],
    });
    await assert.rejects(
      createControllerSessionManager({
        dataDir,
        recordAudit: async () => `audit-${"0".repeat(24)}`,
      }).then(async (invalidManager) => {
        await invalidManager.shutdown();
        return invalidManager;
      }),
      (error) => error?.name === "ZodError",
    );
  } finally {
    await manager?.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});
