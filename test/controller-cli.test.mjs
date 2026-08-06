import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "src", "cli.mjs");

test("sandking self-description and launch use the ordinary Controller CLI channel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandking-controller-cli-"));
  const endpoint = join(directory, "controller.sock");
  const requests = [];
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.slice(0, input.indexOf("\n")));
      requests.push(request);
      socket.end(`${JSON.stringify({
        type: "sandking.cli.result",
        protocol: "1.0.0",
        requestId: request.requestId,
        ok: true,
        outcome: {
          type: "harness.run.launch.result",
          code: "harness_run_created",
          run: { harnessRunId: `harness-run-${"5".repeat(24)}` },
        },
      })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  try {
    const projectId = `project-${"1".repeat(24)}`;
    const controllerEnvironment = {
      LANG: "C.UTF-8",
      PATH: process.env.PATH,
      SANDKING_CONTROLLER_ENDPOINT: endpoint,
      SANDKING_CONTROLLER_SESSION_ID: `controller-session-${"2".repeat(24)}`,
      SANDKING_WORK_CONTEXT_ID: projectId,
    };
    const { stdout: help } = await execFileAsync(process.execPath, [
      cliPath,
      "launch",
      "--help",
    ], {
      env: { LANG: "C.UTF-8", PATH: process.env.PATH },
    });
    assert.match(help, /sandking launch \[<project-id>\] --issue <number>/);
    assert.match(help, /defaults to the focused Controller Project/);
    assert.doesNotMatch(help, /approve|prepare|plugin|skill|expected-revision/i);

    const { stdout: controllerHelp } = await execFileAsync(process.execPath, [
      cliPath,
      "--help",
    ], { env: controllerEnvironment });
    assert.equal(controllerHelp, help);

    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      "launch",
      "--issue", "152",
      "--target-branch", "sandcastle/issue-152",
      "--json",
    ], {
      env: controllerEnvironment,
    });
    const outcome = JSON.parse(stdout);
    assert.equal(outcome.type, "harness.run.launch.result");
    assert.equal(outcome.run.harnessRunId, `harness-run-${"5".repeat(24)}`);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].operation, "describe");
    assert.equal(requests[0].projectId, projectId);
    assert.equal("parameters" in requests[0], false);
    assert.equal("idempotencyKey" in requests[0], false);
    assert.equal(requests[1].operation, "harness-run.launch");
    assert.equal(requests[1].projectId, projectId);
    assert.deepEqual(requests[1].parameters, {
      issueNumber: 152,
      targetBranch: "sandcastle/issue-152",
    });
    assert.equal("expectedRevision" in requests[1], false);
    assert.doesNotMatch(JSON.stringify(requests), /approve|prepare|plugin|skill/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
