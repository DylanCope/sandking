import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createControllerSessionManager } from "../src/controller-sessions.mjs";

const waitFor = async (predicate) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("claude_controller_contract_timeout");
};

test("the public provider boundary preserves an authentication probe adapter failure", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "sandking-claude-auth-boundary-"));
  const dataDir = join(fixtureDirectory, "state");
  const projectDir = join(fixtureDirectory, "project");
  const fakeClaudePath = join(fixtureDirectory, "claude");
  await Promise.all([mkdir(dataDir), mkdir(projectDir)]);
  await writeFile(fakeClaudePath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("2.1.141 (Claude Code)\\n");
else if (args[0] === "--help") process.stdout.write("--session-id <uuid> --plugin-dir <path>\\n");
else if (args[0] === "plugin" && args[1] === "validate" && args.at(-1) === "--strict") {
  process.stdout.write("Validated plugin\\n");
} else if (args[0] === "--plugin-dir" && args.slice(2).join(" ") === "plugin list --json") {
  process.stdout.write('[{"name":"sandking-controller","version":"1.0.0"}]');
} else if (args.join(" ") === "auth status") process.stdout.write('{"loggedIn":');
else process.exitCode = 97;
`, { mode: 0o700 });

  const audits = [];
  let manager;
  try {
    manager = await createControllerSessionManager({
      dataDir,
      providerEnvironment: {
        HOME: fixtureDirectory,
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        SANDKING_CLAUDE_EXECUTABLE: fakeClaudePath,
      },
      recordAudit: async (action, outcome, details = {}) => {
        audits.push({ action, outcome, details });
        return `audit-${String(audits.length).padStart(24, "0")}`;
      },
    });
    const probe = await manager.probeProvider("claude-code");
    assert.equal(probe.availability.status, "unavailable");
    assert.equal(probe.availability.authentication.status, "unknown");
    assert.deepEqual(probe.availability.failure, {
      code: "provider_adapter_failed",
      retryable: true,
    });
    const projectId = `project-${"9".repeat(24)}`;
    await assert.rejects(manager.start({
      workContextId: projectId,
      kind: "project",
      canonicalReference: `sandking:project:${projectId}`,
    }, {
      providerId: "claude-code",
      workingDirectory: projectDir,
    }), (error) => error.code === "provider_adapter_failed");
    assert.ok(audits.some((entry) => entry.action === "controller.session.start"
      && entry.outcome === "rejected"
      && entry.details.code === "provider_adapter_failed"));
  } finally {
    await manager?.shutdown();
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("an installed Claude Controller uses the shared PTY, work-context, and approval seams", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "sandking-claude-session-"));
  const dataDir = join(fixtureDirectory, "state");
  const projectDir = join(fixtureDirectory, "project");
  const fakeClaudePath = join(fixtureDirectory, "claude");
  await Promise.all([mkdir(dataDir), mkdir(projectDir)]);
  await writeFile(fakeClaudePath, `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const args = process.argv.slice(2);
await new Promise((resolve) => setTimeout(resolve, 700));
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("2.1.141 (Claude Code)\\n");
} else if (args.length === 1 && args[0] === "--help") {
  process.stdout.write("--session-id <uuid> --plugin-dir <path>\\n");
} else if (args[0] === "plugin" && args[1] === "validate" && args.at(-1) === "--strict") {
  process.stdout.write("Validated plugin\\n");
} else if (args[0] === "--plugin-dir" && args.slice(2).join(" ") === "plugin list --json") {
  process.stdout.write('[{"name":"sandking-controller","version":"1.0.0"}]');
} else if (args.join(" ") === "auth status") {
  process.stdout.write('{"loggedIn":true}');
} else {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.NODE_OPTIONS) {
    process.stderr.write("unsafe environment reached Claude\\n");
    process.exit(88);
  }
  const sessionIndex = args.indexOf("--session-id");
  const pluginIndex = args.indexOf("--plugin-dir");
  const sessionId = args[sessionIndex + 1];
  const pluginDir = args[pluginIndex + 1];
  const shim = join(pluginDir, "bin", "sandking-controller");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const sessionContext = execFileSync(process.execPath, [shim, "session-start"], {
    encoding: "utf8",
    env: process.env,
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      source: "startup",
    }),
  });
  process.stdout.write("SESSION_CONTEXT " + sessionContext.trim() + "\\r\\n");
  process.stdout.write("Fake installed Claude Controller ready.\\r\\nclaude> ");
  process.stdin.setEncoding("utf8");
  let input = "";
  process.stdin.on("data", (chunk) => {
    input += chunk;
    while (/\\r|\\n/.test(input)) {
      const match = /\\r\\n|\\r|\\n/.exec(input);
      const line = input.slice(0, match.index).trim();
      input = input.slice(match.index + match[0].length);
      if (line === "inspect") {
        const output = execFileSync(process.execPath, [shim, "inspect"], {
          encoding: "utf8", env: process.env,
        });
        process.stdout.write("INSPECTED " + output.trim() + "\\r\\nclaude> ");
      } else if (line.startsWith("prepare ")) {
        const output = execFileSync(process.execPath, [shim, ...line.split(" ")], {
          encoding: "utf8", env: process.env,
        });
        process.stdout.write("PREPARED " + output.trim() + "\\r\\nclaude> ");
      } else if (line.startsWith("approve ")) {
        const output = execFileSync(process.execPath, [shim, ...line.split(" ")], {
          encoding: "utf8", env: process.env,
        });
        process.stdout.write("DECIDED " + output.trim() + "\\r\\nclaude> ");
      } else if (line.startsWith("start ")) {
        const output = execFileSync(process.execPath, [shim, ...line.split(" ")], {
          encoding: "utf8", env: process.env,
        });
        process.stdout.write("STARTED " + output.trim() + "\\r\\nclaude> ");
      } else if (line === "network-fail") {
        execFileSync(process.execPath, [shim, "stop-failure"], {
          encoding: "utf8",
          env: process.env,
          input: JSON.stringify({
            hook_event_name: "StopFailure",
            session_id: sessionId,
            error: "unknown",
            error_details: "DNS lookup failed",
          }),
        });
        process.exit(9);
      }
    }
  });
}
`, { mode: 0o700 });

  const audits = [];
  const operations = [];
  const projectId = `project-${"1".repeat(24)}`;
  const launchRequestId = `launch-request-${"2".repeat(24)}`;
  let manager;
  try {
    manager = await createControllerSessionManager({
      dataDir,
      providerEnvironment: {
        HOME: fixtureDirectory,
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        SANDKING_CLAUDE_EXECUTABLE: fakeClaudePath,
        ANTHROPIC_API_KEY: "manager-secret-must-not-cross",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-must-not-cross",
        NODE_OPTIONS: "--no-warnings",
      },
      recordAudit: async (action, outcome, details = {}) => {
        const auditId = `audit-${String(audits.length + 1).padStart(24, "0")}`;
        audits.push({ auditId, action, outcome, details });
        return auditId;
      },
      handleProviderOperation: async (request) => {
        operations.push(request);
        if (request.operation === "work-context.inspect") {
          return {
            type: "project.work-context",
            projectId,
            revision: 3,
            displayName: "fixture-project",
            harnessId: `harness-${"3".repeat(24)}`,
            pinnedRevision: "4".repeat(40),
          };
        }
        if (request.operation === "launch-request.decide") {
          return {
            type: "launch.request.decision.result",
            code: "launch_request_approved",
            revision: 2,
            launchRequest: {
              launchRequestId,
              status: "approved",
              revision: 2,
              execution: { status: "not_started" },
            },
          };
        }
        if (request.operation === "launch-request.prepare") {
          return {
            type: "launch.request.prepare.result",
            code: "launch_request_prepared",
            revision: 1,
            launchRequest: { launchRequestId, revision: 1, status: "prepared" },
          };
        }
        if (request.operation === "harness-run.start") {
          return {
            type: "harness.run.start.result",
            code: "harness_run_created",
            harnessRunId: `harness-run-${"5".repeat(24)}`,
          };
        }
        throw new Error("unexpected_provider_operation");
      },
    });
    const probe = await manager.probeProvider("claude-code");
    assert.equal(probe.availability.status, "available");
    assert.equal(probe.availability.version, "2.1.141");
    const session = await manager.start({
      workContextId: projectId,
      kind: "project",
      canonicalReference: `sandking:project:${projectId}`,
    }, {
      providerId: "claude-code",
      workingDirectory: projectDir,
    });
    assert.equal(session.provider.providerId, "claude-code");
    assert.equal(session.provider.fixture, false);
    assert.match(session.provider.providerSessionId,
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.deepEqual(session.provider.sessionIdentity, {
      stable: true,
      source: "controller-assigned-supported-cli-flag",
    });
    assert.equal(session.terminal.runtimeOwned, true);

    const output = [];
    const writer = { readyState: 1 };
    const observer = { readyState: 1 };
    const attachment = {
      sessionId: session.sessionId,
      streamId: session.terminal.streamId,
      attachmentId: session.terminal.writableAttachment.attachmentId,
      outputCursor: 0,
      onOutput: (_socket, frame) => output.push(frame.data.toString("utf8")),
    };
    await manager.attach({ ...attachment, socket: writer, mode: "read-write" });
    await manager.attach({ ...attachment, socket: observer, mode: "read-only" });
    await assert.rejects(manager.attach({
      ...attachment,
      socket: observer,
      mode: "read-write",
    }), (error) => error.code === "terminal_write_attachment_conflict");
    let sequence = 0;
    const enter = (line) => manager.write({
      socket: writer,
      streamId: session.terminal.streamId,
      sequence: sequence++,
      eof: false,
      data: Buffer.from(`${line}\n`),
    });
    await waitFor(() => output.join("").includes(
      "SESSION_CONTEXT {\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\"",
    ));
    await enter("inspect");
    await waitFor(() => output.join("").includes(`INSPECTED {"type":"project.work-context"`));
    await enter("prepare 124 sandcastle/issue-124");
    await waitFor(() => output.join("").includes(`PREPARED {"type":"launch.request.prepare.result"`));
    await enter(`approve ${launchRequestId} 1`);
    await waitFor(() => output.join("").includes(`DECIDED {"type":"launch.request.decision.result"`));
    await enter(`start ${launchRequestId} 2`);
    await waitFor(() => output.join("").includes(`STARTED {"type":"harness.run.start.result"`));
    manager.detach(writer);
    assert.equal(manager.inspect(session.sessionId).terminal.status, "running");
    await manager.attach({ ...attachment, socket: writer, mode: "read-write" });
    await enter("network-fail");
    await waitFor(() => manager.inspect(session.sessionId).terminal.status === "exited");
    assert.deepEqual(manager.inspect(session.sessionId).terminal.exitReason, {
      code: "provider_network_unavailable",
      retryable: true,
      source: "claude-stop-failure",
    });
    assert.deepEqual(operations.map((operation) => operation.operation), [
      "work-context.inspect",
      "work-context.inspect",
      "launch-request.prepare",
      "launch-request.decide",
      "harness-run.start",
    ]);
    assert.deepEqual(operations[2].input.parameters, {
      issueNumber: 124,
      targetBranch: "sandcastle/issue-124",
    });
    assert.equal(operations[2].input.expiresInSeconds, 300);
    assert.match(operations[2].input.idempotencyKey,
      new RegExp(`^provider:${session.sessionId}:prepare:[a-f0-9]{64}$`));
    assert.equal(operations[3].input.launchRequestId, launchRequestId);
    assert.equal(operations[3].input.expectedRevision, 1);
    assert.equal(operations[3].input.decision, "approved");
    assert.match(operations[3].input.idempotencyKey,
      new RegExp(`^provider:${session.sessionId}:decision:${launchRequestId}:1:approved$`));
    assert.equal(operations[4].input.launchRequestId, launchRequestId);
    assert.equal(operations[4].input.expectedRevision, 2);
    assert.match(operations[4].input.idempotencyKey,
      new RegExp(`^provider:${session.sessionId}:harness-run:start:${launchRequestId}:2$`));
    const sessionStartAudit = audits.find((audit) =>
      audit.action === "controller.session.start"
      && audit.outcome === "accepted"
      && audit.details.sessionId === session.sessionId);
    assert.equal(sessionStartAudit?.details.controllerSessionId, session.sessionId);
    assert.ok(audits.some((audit) =>
      audit.action === "controller.session.failure"
      && audit.details.code === "provider_network_unavailable"));
    assert.doesNotMatch(JSON.stringify(audits) + JSON.stringify(operations) + output.join(""),
      /manager-secret-must-not-cross|oauth-secret-must-not-cross/);
  } finally {
    await manager?.shutdown();
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});
