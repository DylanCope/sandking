import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "src", "cli.mjs");
const launchParameters = {
  kind: "fields",
  fields: [
    {
      name: "issueNumber",
      label: "Issue number",
      cliFlag: "--issue",
      valueType: "integer",
      required: false,
      minimum: 1,
      maximum: 999_999_999,
    },
    {
      name: "targetBranch",
      label: "Target branch",
      cliFlag: "--target-branch",
      valueType: "string",
      required: false,
      minLength: 1,
      maxLength: 128,
    },
  ],
};

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
          launchParameters,
        } : {
          type: "harness.run.launch.result",
          code: "harness_run_created",
          authorizationClass: "harness_run_launch",
          idempotencyKeyHash: request.idempotencyKeyHash,
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
      SANDKING_CONTROLLER_RETRY_DIRECTORY: join(directory, "retry-state"),
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
    assert.match(help, /sandking launch \[<project-id>\] \[--parameters <json-object>\]/);
    assert.match(help, /defaults to the focused Controller Project/);
    assert.doesNotMatch(help,
      /approve|prepare|plugin|skill|expected-revision|idempotency/i);

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

    const { stdout: parameterlessStdout } = await execFileAsync(process.execPath, [
      cliPath,
      "launch",
      "--json",
    ], {
      env: controllerEnvironment,
    });
    const parameterlessOutcome = JSON.parse(parameterlessStdout);
    assert.equal(parameterlessOutcome.type, "harness.run.launch.result");

    const { stdout: directParameterlessStdout } = await execFileAsync(process.execPath, [
      cliPath,
      "launch",
      projectId,
      "--json",
    ], {
      env: controllerEnvironment,
    });
    assert.equal(JSON.parse(directParameterlessStdout).type, "harness.run.launch.result");

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
    assert.equal(requests.length, 7);
    for (const request of requests.slice(0, 3)) {
      assert.equal(request.operation, "describe");
      assert.equal(request.projectId, projectId);
      assert.equal("parameters" in request, false);
      assert.equal("idempotencyKey" in request, false);
    }
    assert.equal(requests[3].operation, "harness-run.launch");
    assert.equal(requests[3].projectId, projectId);
    assert.equal("parameters" in requests[3], false);
    assert.match(requests[3].idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal("idempotencyKey" in requests[3], false);
    assert.equal(requests[4].operation, "harness-run.launch");
    assert.equal(requests[4].projectId, projectId);
    assert.equal("parameters" in requests[4], false);
    assert.equal(requests[5].operation, "describe");
    assert.equal(requests[5].projectId, projectId);
    assert.equal(requests[6].operation, "harness-run.launch");
    assert.equal(requests[6].projectId, projectId);
    assert.deepEqual(requests[6].parameters, {
      issueNumber: 152,
      targetBranch: "sandcastle/issue-152",
    });
    assert.match(requests[6].idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal("idempotencyKey" in requests[6], false);
    assert.equal("expectedRevision" in requests[6], false);
    assert.doesNotMatch(JSON.stringify(requests), /approve|prepare|plugin|skill/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("sandking cancel uses the ordinary Controller CLI channel without exposing a retry key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandking-controller-cancel-cli-"));
  const endpoint = join(directory, "controller.sock");
  const harnessRunId = `harness-run-${"6".repeat(24)}`;
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
          type: "harness.run.cancel.result",
          code: "harness_run_cancellation_accepted",
          authorizationClass: "harness_run_cancellation",
          idempotencyKeyHash: request.idempotencyKeyHash,
          idempotentReplay: false,
          auditId: `audit-${"7".repeat(24)}`,
          harnessRunId: request.harnessRunId,
          acceptedAt: "2026-08-07T10:00:00.000Z",
          cooperativeDeadlineAt: "2026-08-07T10:00:01.000Z",
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
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      "cancel",
      harnessRunId,
      "--json",
    ], {
      env: {
        LANG: "C.UTF-8",
        PATH: process.env.PATH,
        SANDKING_CONTROLLER_ENDPOINT: endpoint,
        SANDKING_CONTROLLER_RETRY_DIRECTORY: join(directory, "retry-state"),
        SANDKING_CONTROLLER_SESSION_ID: `controller-session-${"2".repeat(24)}`,
        SANDKING_WORK_CONTEXT_ID: projectId,
      },
    });
    const outcome = JSON.parse(stdout);
    assert.equal(outcome.type, "harness.run.cancel.result");
    assert.equal(outcome.harnessRunId, harnessRunId);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].operation, "harness-run.cancel");
    assert.equal(requests[0].projectId, projectId);
    assert.equal(requests[0].harnessRunId, harnessRunId);
    assert.match(requests[0].idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal("idempotencyKey" in requests[0], false);
    assert.equal("expectedRevision" in requests[0], false);
    await assert.rejects(execFileAsync(process.execPath, [
      cliPath,
      "cancel",
      harnessRunId,
      "--idempotency-key", "recognizable-user-cancellation-key",
      "--json",
    ], {
      env: {
        LANG: "C.UTF-8",
        PATH: process.env.PATH,
        SANDKING_CONTROLLER_ENDPOINT: endpoint,
        SANDKING_CONTROLLER_RETRY_DIRECTORY: join(directory, "retry-state"),
        SANDKING_CONTROLLER_SESSION_ID: `controller-session-${"2".repeat(24)}`,
        SANDKING_WORK_CONTEXT_ID: projectId,
      },
    }), (error) => {
      assert.match(error.stderr, /generates its own private retry identity/);
      return true;
    });
    assert.equal(requests.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("sandking recover uses the ordinary Controller CLI channel with one bounded action", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandking-controller-recover-cli-"));
  const endpoint = join(directory, "controller.sock");
  const harnessRunId = `harness-run-${"8".repeat(24)}`;
  const requests = [];
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.slice(0, input.indexOf("\n")));
      requests.push(request);
      if (requests.length === 1) {
        socket.destroy();
        return;
      }
      socket.end(`${JSON.stringify({
        type: "sandking.cli.result",
        protocol: "1.0.0",
        requestId: request.requestId,
        ok: true,
        outcome: {
          type: "harness.run.recover.result",
          code: "harness_recovery_rechecked",
          authorizationClass: "harness_run_recovery",
          idempotencyKeyHash: request.idempotencyKeyHash,
          idempotentReplay: false,
          auditId: `audit-${"9".repeat(24)}`,
          harnessRunId: request.harnessRunId,
          action: request.action,
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
    const environment = {
      LANG: "C.UTF-8",
      PATH: process.env.PATH,
      SANDKING_CONTROLLER_ENDPOINT: endpoint,
      SANDKING_CONTROLLER_RETRY_DIRECTORY: join(directory, "retry-state"),
      SANDKING_CONTROLLER_SESSION_ID: `controller-session-${"2".repeat(24)}`,
      SANDKING_WORK_CONTEXT_ID: projectId,
    };
    const invocation = [
      cliPath, "recover", harnessRunId, "recheck", "--json",
    ];
    await assert.rejects(execFileAsync(process.execPath, invocation, { env: environment }),
      (error) => {
        assert.match(error.stderr, /controller_cli_unavailable/);
        return true;
      });
    const retainedRetry = await readFile(
      join(directory, "retry-state", "harness-recovery-retries.json"),
      "utf8",
    );
    assert.match(retainedRetry, /sha256:[a-f0-9]{64}/);
    assert.doesNotMatch(retainedRetry, /recognizable|idempotencyKey|harness-run-/);
    const { stdout } = await execFileAsync(process.execPath, invocation, { env: environment });
    const outcome = JSON.parse(stdout);
    assert.equal(outcome.type, "harness.run.recover.result");
    assert.equal(outcome.action, "recheck");
    assert.equal(requests.length, 2);
    assert.deepEqual({
      operation: requests[0].operation,
      projectId: requests[0].projectId,
      harnessRunId: requests[0].harnessRunId,
      action: requests[0].action,
    }, {
      operation: "harness-run.recover",
      projectId,
      harnessRunId,
      action: "recheck",
    });
    assert.match(requests[0].idempotencyKeyHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(requests[1].idempotencyKeyHash, requests[0].idempotencyKeyHash);
    assert.equal("idempotencyKey" in requests[0], false);
    assert.equal("expectedRevision" in requests[0], false);
    await assert.rejects(execFileAsync(process.execPath, [
      cliPath, "recover", harnessRunId, "signal-pid", "--json",
    ], { env: environment }), /Command failed/);
    assert.equal(requests.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("sandking cancel reuses its private hash after an ambiguous response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandking-controller-cancel-retry-"));
  const endpoint = join(directory, "controller.sock");
  const retryDirectory = join(directory, "retry-state");
  const projectId = `project-${"a".repeat(24)}`;
  const harnessRunId = `harness-run-${"b".repeat(24)}`;
  const requests = [];
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.slice(0, input.indexOf("\n")));
      requests.push(request);
      if (requests.length === 1) {
        socket.destroy();
        return;
      }
      socket.end(`${JSON.stringify({
        type: "sandking.cli.result",
        protocol: "1.0.0",
        requestId: request.requestId,
        ok: true,
        outcome: {
          type: "harness.run.cancel.result",
          code: "harness_run_cancellation_accepted",
          authorizationClass: "harness_run_cancellation",
          idempotencyKeyHash: request.idempotencyKeyHash,
          idempotentReplay: true,
          auditId: `audit-${"c".repeat(24)}`,
          harnessRunId,
          acceptedAt: "2026-08-07T10:00:00.000Z",
          cooperativeDeadlineAt: "2026-08-07T10:00:01.000Z",
        },
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
    SANDKING_CONTROLLER_ENDPOINT: endpoint,
    SANDKING_CONTROLLER_RETRY_DIRECTORY: retryDirectory,
    SANDKING_CONTROLLER_SESSION_ID: `controller-session-${"d".repeat(24)}`,
    SANDKING_WORK_CONTEXT_ID: projectId,
  };
  const invocation = [cliPath, "cancel", harnessRunId, "--json"];
  try {
    await assert.rejects(execFileAsync(process.execPath, invocation, { env: environment }),
      (error) => {
        assert.match(error.stderr, /controller_cli_unavailable/);
        return true;
      });
    const pending = await readFile(
      join(retryDirectory, "harness-cancellation-retries.json"),
      "utf8",
    );
    assert.match(pending, /sha256:[a-f0-9]{64}/);
    assert.doesNotMatch(pending, /idempotencyKey|recognizable/);

    const { stdout } = await execFileAsync(process.execPath, invocation, { env: environment });
    assert.equal(JSON.parse(stdout).harnessRunId, harnessRunId);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].idempotencyKeyHash, requests[0].idempotencyKeyHash);
    await assert.rejects(readFile(
      join(retryDirectory, "harness-cancellation-retries.json"),
      "utf8",
    ));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("sandking cancel retains its private hash across indeterminate Host and provider failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandking-controller-cancel-failure-retry-"));
  const endpoint = join(directory, "controller.sock");
  const retryDirectory = join(directory, "retry-state");
  const projectId = `project-${"e".repeat(24)}`;
  const harnessRunId = `harness-run-${"f".repeat(24)}`;
  const requests = [];
  const failures = ["host_disconnected", "provider_operation_timeout"];
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.slice(0, input.indexOf("\n")));
      requests.push(request);
      const failure = failures[requests.length - 1];
      socket.end(`${JSON.stringify({
        type: "sandking.cli.result",
        protocol: "1.0.0",
        requestId: request.requestId,
        ...(failure ? {
          ok: false,
          failure: { code: failure },
        } : {
          ok: true,
          outcome: {
            type: "harness.run.cancel.result",
            code: "harness_run_cancellation_accepted",
            authorizationClass: "harness_run_cancellation",
            idempotencyKeyHash: request.idempotencyKeyHash,
            idempotentReplay: true,
            auditId: `audit-${"1".repeat(24)}`,
            harnessRunId,
            acceptedAt: "2026-08-07T10:00:00.000Z",
            cooperativeDeadlineAt: "2026-08-07T10:00:01.000Z",
          },
        }),
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
    SANDKING_CONTROLLER_ENDPOINT: endpoint,
    SANDKING_CONTROLLER_RETRY_DIRECTORY: retryDirectory,
    SANDKING_CONTROLLER_SESSION_ID: `controller-session-${"2".repeat(24)}`,
    SANDKING_WORK_CONTEXT_ID: projectId,
  };
  const invocation = [cliPath, "cancel", harnessRunId, "--json"];
  try {
    for (const failure of failures) {
      await assert.rejects(execFileAsync(process.execPath, invocation, { env: environment }),
        (error) => {
          assert.match(error.stderr, new RegExp(failure));
          return true;
        });
      const pending = await readFile(
        join(retryDirectory, "harness-cancellation-retries.json"),
        "utf8",
      );
      assert.match(pending, /sha256:[a-f0-9]{64}/);
    }

    const { stdout } = await execFileAsync(process.execPath, invocation, { env: environment });
    assert.equal(JSON.parse(stdout).harnessRunId, harnessRunId);
    assert.equal(requests.length, 3);
    assert.equal(new Set(requests.map((request) => request.idempotencyKeyHash)).size, 1);
    await assert.rejects(readFile(
      join(retryDirectory, "harness-cancellation-retries.json"),
      "utf8",
    ));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("an ordinary Controller CLI retry reuses its pending launch identity after a lost response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandking-controller-cli-retry-"));
  const endpoint = join(directory, "controller.sock");
  const retryDirectory = join(directory, "retry-state");
  const projectId = `project-${"a".repeat(24)}`;
  const controllerSessionId = `controller-session-${"b".repeat(24)}`;
  const requests = [];
  const acceptedRuns = new Map();
  let adapterStarts = 0;
  let lifecycleTransitions = 0;
  let projectWrites = 0;
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.slice(0, input.indexOf("\n")));
      requests.push(request);
      let harnessRunId = acceptedRuns.get(request.idempotencyKeyHash);
      if (!harnessRunId) {
        harnessRunId = `harness-run-${String(acceptedRuns.size + 1).repeat(24)}`;
        acceptedRuns.set(request.idempotencyKeyHash, harnessRunId);
        adapterStarts += 1;
        lifecycleTransitions += 1;
      }
      if (requests.length === 1) {
        // The Controller accepted the launch, but its response never reached
        // the ordinary CLI process.
        socket.destroy();
        return;
      }
      socket.end(`${JSON.stringify({
        type: "sandking.cli.result",
        protocol: "1.0.0",
        requestId: request.requestId,
        ok: true,
        outcome: {
          type: "harness.run.launch.result",
          code: "harness_run_created",
          authorizationClass: "harness_run_launch",
          idempotencyKeyHash: request.idempotencyKeyHash,
          run: {
            harnessRunId,
            projectId: request.projectId,
            controllerSessionId: request.controllerSessionId,
            source: "controller-cli",
            parameters: request.parameters ?? {},
          },
        },
      })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  const controllerEnvironment = {
    LANG: "C.UTF-8",
    PATH: process.env.PATH,
    SANDKING_CONTROLLER_ENDPOINT: endpoint,
    SANDKING_CONTROLLER_RETRY_DIRECTORY: retryDirectory,
    SANDKING_CONTROLLER_SESSION_ID: controllerSessionId,
    SANDKING_WORK_CONTEXT_ID: projectId,
  };
  const invocation = [cliPath, "launch", "--json"];
  try {
    await assert.rejects(execFileAsync(process.execPath, invocation, {
      env: controllerEnvironment,
    }), (error) => {
      assert.match(error.stderr, /controller_cli_unavailable/);
      return true;
    });
    const pendingState = await readFile(
      join(retryDirectory, "harness-launch-retries.json"),
      "utf8",
    );
    assert.match(pendingState, /sha256:[a-f0-9]{64}/);
    assert.doesNotMatch(pendingState, /idempotencyKey/);

    const { stdout: replayOutput } = await execFileAsync(process.execPath, invocation, {
      env: controllerEnvironment,
    });
    const replay = JSON.parse(replayOutput);
    assert.equal(replay.code, "harness_run_created");
    assert.equal(replay.run.harnessRunId, `harness-run-${"1".repeat(24)}`);
    assert.equal(requests[1].idempotencyKeyHash, requests[0].idempotencyKeyHash);
    assert.equal(acceptedRuns.size, 1);
    assert.equal(adapterStarts, 1);
    assert.equal(lifecycleTransitions, 1);
    assert.equal(projectWrites, 0);

    const { stdout: deliberateOutput } = await execFileAsync(process.execPath, invocation, {
      env: controllerEnvironment,
    });
    const deliberate = JSON.parse(deliberateOutput);
    assert.equal(deliberate.code, "harness_run_created");
    assert.equal(deliberate.run.harnessRunId, `harness-run-${"2".repeat(24)}`);
    assert.notEqual(requests[2].idempotencyKeyHash, requests[1].idempotencyKeyHash);
    assert.equal(acceptedRuns.size, 2);
    assert.equal(adapterStarts, 2);
    assert.equal(lifecycleTransitions, 2);
    assert.equal(projectWrites, 0);

    const requestCount = requests.length;
    const { SANDKING_CONTROLLER_RETRY_DIRECTORY: _retryDirectory, ...unsafeEnvironment } =
      controllerEnvironment;
    await assert.rejects(execFileAsync(process.execPath, invocation, {
      env: unsafeEnvironment,
    }), (error) => {
      assert.match(error.stderr, /controller_cli_retry_state_unavailable/);
      return true;
    });
    assert.equal(requests.length, requestCount);
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
          launchParameters,
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
        outcome: request.operation === "describe" ? {
          type: "controller.cli.description",
          protocol: "1.0.0",
          command: "sandking launch",
          focusedProjectId: request.projectId,
          projectArgumentOptional: true,
          pluginRequired: false,
          launchParameters,
        } : {
          type: "harness.run.launch.result",
          code: "harness_run_created",
          authorizationClass: "harness_run_launch",
          idempotencyKeyHash: request.idempotencyKeyHash === `sha256:${createHash("sha256")
            .update("wrong-idempotency").digest("hex")}`
            ? `sha256:${createHash("sha256").update("another-idempotency-key").digest("hex")}`
            : request.idempotencyKeyHash,
          run: {
            harnessRunId: `harness-run-${"5".repeat(24)}`,
            projectId: request.idempotencyKeyHash === `sha256:${createHash("sha256")
              .update("wrong-project").digest("hex")}`
              ? `project-${"9".repeat(24)}`
              : request.projectId,
            controllerSessionId: request.idempotencyKeyHash === `sha256:${createHash("sha256")
              .update("wrong-session").digest("hex")}`
              ? `controller-session-${"9".repeat(24)}`
              : request.controllerSessionId,
            source: "controller-cli",
            parameters: request.idempotencyKeyHash === `sha256:${createHash("sha256")
              .update("wrong-parameters").digest("hex")}`
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
