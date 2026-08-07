import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
        outcome: request.operation === "describe" ? {
          type: "controller.cli.description",
          protocol: "1.0.0",
          command: "sandking launch",
          focusedProjectId: request.projectId,
          projectArgumentOptional: true,
          pluginRequired: false,
        } : {
          type: "harness.run.launch.result",
          code: "harness_run_created",
          authorizationClass: "harness_run_launch",
          idempotencyKeyHash: `sha256:${createHash("sha256")
            .update(request.idempotencyKey).digest("hex")}`,
          run: {
            harnessRunId: `harness-run-${"5".repeat(24)}`,
            projectId: request.projectId,
            controllerSessionId: request.controllerSessionId,
            source: "controller-cli",
            parameters: request.parameters,
          },
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

    const controllerHelpInvocations = [
      ["--help"],
      ["-h"],
      ["help", "launch"],
    ];
    for (const invocation of controllerHelpInvocations) {
      const { stdout: controllerHelp } = await execFileAsync(process.execPath, [
        cliPath,
        ...invocation,
      ], { env: controllerEnvironment });
      assert.equal(controllerHelp, help);
    }

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
    assert.equal(requests.length, 4);
    for (const request of requests.slice(0, 3)) {
      assert.equal(request.operation, "describe");
      assert.equal(request.projectId, projectId);
      assert.equal("parameters" in request, false);
      assert.equal("idempotencyKey" in request, false);
    }
    assert.equal(requests[3].operation, "harness-run.launch");
    assert.equal(requests[3].projectId, projectId);
    assert.deepEqual(requests[3].parameters, {
      issueNumber: 152,
      targetBranch: "sandcastle/issue-152",
    });
    assert.equal("expectedRevision" in requests[3], false);
    assert.doesNotMatch(JSON.stringify(requests), /approve|prepare|plugin|skill/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("sandking self-description rejects a plugin-gated runtime contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandking-controller-cli-describe-"));
  const endpoint = join(directory, "controller.sock");
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.slice(0, input.indexOf("\n")));
      socket.end(`${JSON.stringify({
        type: "sandking.cli.result",
        protocol: "1.0.0",
        requestId: request.requestId,
        ok: true,
        outcome: {
          type: "controller.cli.description",
          protocol: "1.0.0",
          command: "sandking launch",
          focusedProjectId: request.projectId,
          projectArgumentOptional: true,
          pluginRequired: true,
        },
      })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  try {
    const projectId = `project-${"3".repeat(24)}`;
    await assert.rejects(execFileAsync(process.execPath, [cliPath, "--help"], {
      env: {
        LANG: "C.UTF-8",
        PATH: process.env.PATH,
        SANDKING_CONTROLLER_ENDPOINT: endpoint,
        SANDKING_CONTROLLER_SESSION_ID: `controller-session-${"4".repeat(24)}`,
        SANDKING_WORK_CONTEXT_ID: projectId,
      },
    }), (error) => {
      assert.match(error.stderr, /controller_cli_protocol_invalid/);
      return true;
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("sandking launch rejects uncorrelated success responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandking-controller-cli-correlation-"));
  const endpoint = join(directory, "controller.sock");
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.slice(0, input.indexOf("\n")));
      const mismatchedParameters = {
        issueNumber: 153,
        targetBranch: "sandcastle/issue-153",
      };
      socket.end(`${JSON.stringify({
        type: "sandking.cli.result",
        protocol: "1.0.0",
        requestId: request.requestId,
        ok: true,
        outcome: {
          type: "harness.run.launch.result",
          code: "harness_run_created",
          authorizationClass: "harness_run_launch",
          idempotencyKeyHash: `sha256:${createHash("sha256")
            .update(request.idempotencyKey === "wrong-idempotency"
              ? "another-idempotency-key"
              : request.idempotencyKey).digest("hex")}`,
          run: {
            harnessRunId: `harness-run-${"5".repeat(24)}`,
            projectId: request.idempotencyKey === "wrong-project"
              ? `project-${"9".repeat(24)}`
              : request.projectId,
            controllerSessionId: request.idempotencyKey === "wrong-session"
              ? `controller-session-${"9".repeat(24)}`
              : request.controllerSessionId,
            source: "controller-cli",
            parameters: request.idempotencyKey === "wrong-parameters"
              ? mismatchedParameters
              : request.parameters,
          },
        },
      })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  try {
    const projectId = `project-${"7".repeat(24)}`;
    for (const idempotencyKey of [
      "wrong-project",
      "wrong-session",
      "wrong-parameters",
      "wrong-idempotency",
    ]) {
      await assert.rejects(execFileAsync(process.execPath, [
        cliPath,
        "launch",
        "--issue", "152",
        "--idempotency-key", idempotencyKey,
        "--json",
      ], {
        env: {
          LANG: "C.UTF-8",
          PATH: process.env.PATH,
          SANDKING_CONTROLLER_ENDPOINT: endpoint,
          SANDKING_CONTROLLER_SESSION_ID: `controller-session-${"8".repeat(24)}`,
          SANDKING_WORK_CONTEXT_ID: projectId,
        },
      }), (error) => {
        assert.match(error.stderr, /controller_cli_protocol_invalid/);
        return true;
      });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
