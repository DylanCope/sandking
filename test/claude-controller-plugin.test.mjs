import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const shimPath = fileURLToPath(new URL(
  "../src/claude-controller-plugin/bin/sandking-controller",
  import.meta.url,
));
const pluginRoot = fileURLToPath(new URL(
  "../src/claude-controller-plugin/",
  import.meta.url,
));

test("the bundled Claude plugin declares only the minimal Controller skills and lifecycle hooks", async () => {
  const manifest = JSON.parse(await readFile(
    join(pluginRoot, ".claude-plugin", "plugin.json"),
    "utf8",
  ));
  const hooks = JSON.parse(await readFile(join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const inspectSkill = await readFile(
    join(pluginRoot, "skills", "inspect-work-context", "SKILL.md"),
    "utf8",
  );
  const approvalSkill = await readFile(
    join(pluginRoot, "skills", "approve-launch", "SKILL.md"),
    "utf8",
  );
  assert.deepEqual(manifest, {
    $schema: "https://json.schemastore.org/claude-code-plugin-manifest.json",
    name: "sandking-controller",
    version: "1.0.0",
    description: "Minimal typed Sand-King Controller integration.",
  });
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["SessionStart", "StopFailure"]);
  assert.equal(hooks.hooks.SessionStart.length, 1);
  assert.equal(hooks.hooks.StopFailure.length, 1);
  assert.equal(
    hooks.hooks.SessionStart[0].hooks[0].command,
    "node \"${CLAUDE_PLUGIN_ROOT}/bin/sandking-controller\" session-start",
  );
  assert.equal(
    hooks.hooks.StopFailure[0].hooks[0].command,
    "node \"${CLAUDE_PLUGIN_ROOT}/bin/sandking-controller\" stop-failure",
  );
  assert.equal("args" in hooks.hooks.SessionStart[0].hooks[0], false);
  assert.match(inspectSkill,
    /node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/sandking-controller" inspect/);
  assert.match(inspectSkill, /sanitized selected work context/i);
  assert.match(approvalSkill, /disable-model-invocation: true/);
  assert.match(approvalSkill,
    /node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/sandking-controller" approve/);
  assert.match(approvalSkill, /exact Launch-request ID and expected revision/i);
  assert.doesNotMatch(
    JSON.stringify(manifest) + JSON.stringify(hooks) + inspectSkill + approvalSkill,
    /credential|oauth|api[_ -]?key|token value/i,
  );
});

test("the Claude plugin shim exposes typed work-context inspection and exact approval", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "sandking-claude-shim-"));
  const endpoint = join(fixtureDirectory, "shim.sock");
  const requests = [];
  const outcomes = [
    {
      type: "project.work-context",
      projectId: `project-${"2".repeat(24)}`,
      revision: 3,
      displayName: "fixture-project",
      harnessId: `harness-${"3".repeat(24)}`,
      pinnedRevision: "4".repeat(40),
    },
    {
      type: "launch.request.decision.result",
      code: "launch_request_approved",
      revision: 2,
      launchRequest: {
        launchRequestId: `launch-request-${"5".repeat(24)}`,
        status: "approved",
        revision: 2,
        execution: { status: "not_started" },
      },
    },
  ];
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.slice(0, input.indexOf("\n")));
      requests.push(request);
      socket.end(`${JSON.stringify({
        type: "claude.plugin.operation.result",
        protocol: "1.0.0",
        operationId: request.operationId,
        ok: true,
        outcome: outcomes[requests.length - 1],
      })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  const environment = {
    LANG: "C.UTF-8",
    PATH: process.env.PATH,
    SANDKING_CLAUDE_SHIM_ENDPOINT: endpoint,
    SANDKING_CLAUDE_SESSION_ID: "550e8400-e29b-41d4-a716-446655440000",
    SANDKING_CONTROLLER_SESSION_ID: `controller-session-${"1".repeat(24)}`,
    ANTHROPIC_API_KEY: "shim-secret-must-not-cross",
  };

  try {
    const inspected = await execFileAsync(process.execPath, [shimPath, "inspect"], {
      env: environment,
    });
    const launchRequestId = `launch-request-${"5".repeat(24)}`;
    const approved = await execFileAsync(process.execPath, [
      shimPath,
      "approve",
      launchRequestId,
      "1",
    ], { env: environment });
    assert.deepEqual(JSON.parse(inspected.stdout), outcomes[0]);
    assert.deepEqual(JSON.parse(approved.stdout), outcomes[1]);
    assert.deepEqual(requests.map(({ operationId, ...request }) => request), [
      {
        type: "claude.plugin.operation.request",
        protocol: "1.0.0",
        controllerSessionId: environment.SANDKING_CONTROLLER_SESSION_ID,
        providerSessionId: environment.SANDKING_CLAUDE_SESSION_ID,
        operation: "work-context.inspect",
        input: {},
      },
      {
        type: "claude.plugin.operation.request",
        protocol: "1.0.0",
        controllerSessionId: environment.SANDKING_CONTROLLER_SESSION_ID,
        providerSessionId: environment.SANDKING_CLAUDE_SESSION_ID,
        operation: "launch-request.decide",
        input: {
          launchRequestId,
          decision: "approved",
          expectedRevision: 1,
        },
      },
    ]);
    assert.doesNotMatch(JSON.stringify(requests) + inspected.stdout + approved.stdout,
      /shim-secret-must-not-cross/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});
