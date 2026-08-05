import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createControllerSessionManager } from "../src/controller-sessions.mjs";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "src", "cli.mjs");

const waitFor = async (predicate) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("claude_controller_contract_timeout");
};

const matchingProviderProcesses = async (executable) => {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="]);
  return stdout.trim().split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    return match && match[2].includes(executable)
      ? [{ pid: Number(match[1]), command: match[2] }]
      : [];
  });
};

test("a timed-out provider adapter terminates its metadata process tree", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "sandking-claude-timeout-tree-"));
  const dataDir = join(fixtureDirectory, "state");
  const fakeClaudePath = join(fixtureDirectory, "claude");
  await mkdir(dataDir);
  await writeFile(fakeClaudePath, `#!/usr/bin/env node
process.on("SIGTERM", () => undefined);
setInterval(() => undefined, 1_000);
`, { mode: 0o700 });

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
      recordAudit: async () => `audit-${"0".repeat(24)}`,
    });
    await assert.rejects(
      manager.probeProvider("claude-code"),
      (error) => error.code === "provider_adapter_timeout",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await matchingProviderProcesses(fakeClaudePath), []);
  } finally {
    await manager?.shutdown();
    for (const child of await matchingProviderProcesses(fakeClaudePath)) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // The scoped provider process exited before fallback cleanup.
      }
    }
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("the public provider boundary preserves an authentication probe adapter failure", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "sandking-claude-auth-boundary-"));
  const dataDir = join(fixtureDirectory, "state");
  const projectDir = join(fixtureDirectory, "project");
  const fakeClaudePath = join(fixtureDirectory, "claude");
  await Promise.all([mkdir(dataDir), mkdir(projectDir)]);
  await writeFile(fakeClaudePath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("2.1.141 (Claude Code)\\n");
else if (args[0] === "--help") process.stdout.write("--session-id <uuid>\\n");
else if (args.join(" ") === "auth status") process.stdout.write('{"loggedIn":');
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

test("an installed Claude Controller launches through the ordinary sandking CLI without a plugin", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "sandking-claude-session-"));
  const dataDir = join(fixtureDirectory, "state");
  const projectDir = join(fixtureDirectory, "project");
  const fakeClaudePath = join(fixtureDirectory, "claude");
  const sandkingPath = join(fixtureDirectory, "sandking");
  await Promise.all([mkdir(dataDir), mkdir(projectDir)]);
  await writeFile(sandkingPath, `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} "$@"
`, { mode: 0o700 });
  await writeFile(fakeClaudePath, `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("2.1.141 (Claude Code)\\n");
} else if (args.length === 1 && args[0] === "--help") {
  process.stdout.write("--session-id <uuid>\\n");
} else if (args.join(" ") === "auth status") {
  process.stdout.write('{"loggedIn":true}');
} else {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.NODE_OPTIONS) {
    process.stderr.write("unsafe environment reached Claude\\n");
    process.exit(88);
  }
  if (args.includes("--plugin-dir")) {
    process.stderr.write("plugin argument reached Claude\\n");
    process.exit(89);
  }
  process.stdout.write("CLAUDE_ARGS " + JSON.stringify(args) + "\\r\\n");
  process.stdout.write("Fake installed Claude Controller ready.\\r\\nclaude> ");
  process.stdin.setEncoding("utf8");
  let input = "";
  process.stdin.on("data", (chunk) => {
    input += chunk;
    while (/\\r|\\n/.test(input)) {
      const match = /\\r\\n|\\r|\\n/.exec(input);
      const line = input.slice(0, match.index).trim();
      input = input.slice(match.index + match[0].length);
      if (line.startsWith("launch ")) {
        const issue = line.split(" ")[1];
        const output = execFileSync("sandking", [
          "launch", process.env.SANDKING_WORK_CONTEXT_ID,
          "--issue", issue,
          "--target-branch", "sandcastle/issue-" + issue,
          "--json",
        ], { encoding: "utf8", env: process.env });
        process.stdout.write("LAUNCHED " + output.trim() + "\\r\\nclaude> ");
      } else if (line === "exit") {
        process.exit(0);
      }
    }
  });
}
`, { mode: 0o700 });

  const audits = [];
  const operations = [];
  const projectId = `project-${"1".repeat(24)}`;
  let manager;
  try {
    manager = await createControllerSessionManager({
      dataDir,
      providerEnvironment: {
        HOME: fixtureDirectory,
        PATH: `${fixtureDirectory}:${process.env.PATH}`,
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
        if (request.operation === "harness-run.launch") {
          return {
            type: "harness.run.launch.result",
            code: "harness_run_created",
            run: { harnessRunId: `harness-run-${"5".repeat(24)}` },
          };
        }
        throw new Error("unexpected_provider_operation");
      },
    });
    const probe = await manager.probeProvider("claude-code");
    assert.equal(probe.availability.status, "available");
    assert.deepEqual(probe.capabilities, [
      "controller.session.start",
      "controller.session.interactive",
      "controller.session.terminate",
      "controller.harness-run.launch",
      "controller.session.stable-identity",
    ]);
    assert.equal("integration" in probe, false);
    const session = await manager.start({
      workContextId: projectId,
      kind: "project",
      canonicalReference: `sandking:project:${projectId}`,
    }, {
      providerId: "claude-code",
      workingDirectory: projectDir,
    });
    assert.equal(session.provider.providerId, "claude-code");
    assert.equal("integration" in session.provider, false);

    const output = [];
    const writer = { readyState: 1 };
    const attachment = {
      socket: writer,
      sessionId: session.sessionId,
      streamId: session.terminal.streamId,
      attachmentId: session.terminal.writableAttachment.attachmentId,
      mode: "read-write",
      outputCursor: 0,
      onOutput: (_socket, frame) => output.push(frame.data.toString("utf8")),
    };
    const attached = await manager.attach(attachment);
    assert.equal(attached.activate(), true);
    let sequence = 0;
    const enter = (line) => manager.write({
      socket: writer,
      streamId: session.terminal.streamId,
      sequence: sequence++,
      eof: false,
      data: Buffer.from(`${line}\n`),
    });
    await waitFor(() => output.join("").includes("Fake installed Claude Controller ready"));
    await enter("launch 152");
    await waitFor(() => output.join("").includes(`LAUNCHED {"type":"harness.run.launch.result"`))
      .catch(() => assert.fail(`ordinary CLI launch output missing:\n${output.join("")}`));
    assert.equal(operations.length, 1);
    assert.equal(operations[0].operation, "harness-run.launch");
    assert.deepEqual(operations[0].input.parameters, {
      issueNumber: 152,
      targetBranch: "sandcastle/issue-152",
    });
    assert.equal("expectedRevision" in operations[0].input, false);
    assert.doesNotMatch(output.join(""), /--plugin-dir|sandking-controller|approve|prepare/i);
    await enter("exit");
    await waitFor(() => manager.inspect(session.sessionId).terminal.status === "exited");
    assert.ok(audits.some((audit) =>
      audit.action === "controller.provider.operation"
      && audit.details.operation === "harness-run.launch"));
    assert.doesNotMatch(JSON.stringify(audits) + JSON.stringify(operations) + output.join(""),
      /manager-secret-must-not-cross|oauth-secret-must-not-cross/);
  } finally {
    await manager?.shutdown();
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});
