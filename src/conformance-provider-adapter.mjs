#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const adapterPath = fileURLToPath(import.meta.url);
const adapterProtocol = Object.freeze({
  major: 1,
  minor: 0,
  patch: 0,
  version: "1.0.0",
});
const adapterId = "conformance-controller-adapter-v1";
const provider = Object.freeze({
  providerId: "conformance-controller-v1",
  kind: "conformance",
  fixture: true,
});
const capabilities = Object.freeze([
  "controller.session.start",
  "controller.session.interactive",
  "controller.session.terminate",
  "controller.work-context.inspect",
  "controller.launch-request.prepare",
  "controller.launch-request.decide",
  "controller.harness-run.start",
]);
const identifierPattern = /^[a-zA-Z0-9._:-]{1,160}$/;
const providerSessionPattern = /^conformance-provider-session-[a-f0-9]{24}$/;
const canonicalReferencePattern = /^(?:github:fixture:issue:[0-9]+|sandking:project:project-[a-f0-9]{24})$/;
const controlEndpointPattern = /^.{1,512}$/;

/** @param {string[]} argv */
const parseFlags = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("provider_adapter_arguments_invalid");
    }
    values.set(flag.slice(2), value);
  }
  return values;
};

/** @param {unknown} value */
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const probe = () => send({
  type: "provider.adapter.probe",
  adapterProtocol,
  adapterId,
  provider,
  capabilities,
  terminal: {
    ptyRequired: true,
    runtimeOwnershipRequired: true,
  },
});

/** @param {string[]} argv */
const prepare = (argv) => {
  const flags = parseFlags(argv);
  const sessionId = flags.get("session-id") ?? "";
  const providerSessionId = flags.get("provider-session-id") ?? "";
  const workContextId = flags.get("work-context-id") ?? "";
  const canonicalReference = flags.get("canonical-reference") ?? "";
  const controlEndpoint = flags.get("control-endpoint") ?? "";
  if (
    !/^controller-session-[a-f0-9]{24}$/.test(sessionId)
    || !providerSessionPattern.test(providerSessionId)
    || !identifierPattern.test(workContextId)
    || !canonicalReferencePattern.test(canonicalReference)
    || !controlEndpointPattern.test(controlEndpoint)
  ) {
    throw new Error("provider_session_contract_invalid");
  }
  send({
    type: "provider.session.prepared",
    adapterProtocol,
    adapterId,
    provider,
    providerSessionId,
    capabilities,
    terminal: {
      ptyRequired: true,
      columns: 80,
      rows: 24,
    },
    control: {
      protocol: adapterProtocol,
      readySignal: "provider.session.ready",
      endpoint: controlEndpoint,
    },
    command: {
      executable: process.execPath,
      args: [
        adapterPath,
        "run",
        "--session-id", sessionId,
        "--provider-session-id", providerSessionId,
        "--work-context-id", workContextId,
        "--canonical-reference", canonicalReference,
        "--control-endpoint", controlEndpoint,
      ],
      environment: {
        LANG: "C.UTF-8",
        TERM: "xterm-256color",
      },
    },
  });
};

/** @param {string} endpoint @param {any} readyMessage */
const openControl = async (endpoint, readyMessage) => new Promise((resolve, reject) => {
  const socket = createConnection(endpoint);
  let settled = false;
  let input = "";
  let operationSequence = 0;
  const pending = new Map();
  const timedOutOperationIds = new Set();
  /** @param {Error | null} error @param {unknown} [value] */
  const finish = (error, value) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timeout);
    if (error) {
      reject(error);
    } else {
      resolve(value);
    }
  };
  const timeout = setTimeout(() => {
    socket.destroy();
    finish(new Error("provider_control_timeout"));
  }, 2_000);
  socket.once("connect", () => {
    socket.write(`${JSON.stringify(readyMessage)}\n`);
    finish(null, {
      /** @param {string} operation @param {unknown} operationInput */
      request: (operation, operationInput) => new Promise((resolveOperation, rejectOperation) => {
        const operationId = `provider-operation-${operationSequence}`;
        operationSequence += 1;
        const operationTimeoutMs = operation === "harness-run.start" ? 3_000 : 30_000;
        const timeout = setTimeout(() => {
          pending.delete(operationId);
          timedOutOperationIds.add(operationId);
          rejectOperation(new Error("provider_operation_timeout"));
        }, operationTimeoutMs);
        pending.set(operationId, {
          /** @param {unknown} value */
          resolve: (value) => {
            clearTimeout(timeout);
            resolveOperation(value);
          },
          /** @param {Error} error */
          reject: (error) => {
            clearTimeout(timeout);
            rejectOperation(error);
          },
        });
        socket.write(`${JSON.stringify({
          type: "provider.operation.request",
          controlProtocol: adapterProtocol,
          operationId,
          sessionId: readyMessage.sessionId,
          providerSessionId: readyMessage.providerSessionId,
          operation,
          input: operationInput,
        })}\n`);
      }),
    });
  });
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    input += chunk;
    while (input.includes("\n")) {
      const newline = input.indexOf("\n");
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        socket.destroy(new Error("provider_control_protocol_invalid"));
        return;
      }
      if (response?.type !== "provider.operation.result") {
        socket.destroy(new Error("provider_control_protocol_invalid"));
        return;
      }
      const pendingOperation = pending.get(response.operationId);
      if (!pendingOperation) {
        if (timedOutOperationIds.delete(response.operationId)) {
          continue;
        }
        socket.destroy(new Error("provider_control_protocol_invalid"));
        return;
      }
      pending.delete(response.operationId);
      if (response.ok === true) {
        pendingOperation.resolve(response.outcome);
      } else {
        pendingOperation.reject(new Error(response?.failure?.code
          ?? "provider_operation_failed"));
      }
    }
  });
  socket.once("error", () => finish(new Error("provider_control_unavailable")));
  socket.once("close", () => {
    for (const operation of pending.values()) {
      operation.reject(new Error("provider_control_unavailable"));
    }
    pending.clear();
    timedOutOperationIds.clear();
    if (!settled) {
      finish(new Error("provider_control_unavailable"));
    }
  });
});

/** @param {string[]} argv */
const run = async (argv) => {
  const flags = parseFlags(argv);
  const sessionId = flags.get("session-id") ?? "";
  const providerSessionId = flags.get("provider-session-id") ?? "";
  const workContextId = flags.get("work-context-id") ?? "";
  const canonicalReference = flags.get("canonical-reference") ?? "";
  const controlEndpoint = flags.get("control-endpoint") ?? "";
  if (
    !/^controller-session-[a-f0-9]{24}$/.test(sessionId)
    || !providerSessionPattern.test(providerSessionId)
    || !identifierPattern.test(workContextId)
    || !canonicalReferencePattern.test(canonicalReference)
    || !controlEndpointPattern.test(controlEndpoint)
  ) {
    throw new Error("provider_session_contract_invalid");
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("provider_pty_required");
  }

  const control = await openControl(controlEndpoint, {
    type: "provider.session.ready",
    controlProtocol: adapterProtocol,
    adapterId,
    sessionId,
    providerSessionId,
    workContext: {
      workContextId,
      canonicalReference,
    },
    process: { pid: process.pid },
    terminal: {
      stdinTty: process.stdin.isTTY,
      stdoutTty: process.stdout.isTTY,
    },
  });

  process.stdout.write(
    `Conformance Controller ready (${providerSessionId}).\r\n`
      + "Provider terminal: stdin TTY=true; stdout TTY=true.\r\n"
      + `Focused work context: ${workContextId} (${canonicalReference}).\r\n`
      + "Enter inspect to inspect the selected work context.\r\ncontroller> ",
  );
  process.stdin.setEncoding("utf8");
  let pending = "";
  let processing = Promise.resolve();
  /** @param {string} line */
  const handleLine = async (line) => {
    if (line === "dimensions") {
      process.stdout.write(
        `PTY DIMENSIONS: ${process.stdout.columns} × ${process.stdout.rows}.\r\ncontroller> `,
      );
      return;
    }
    if (line === "ansi-fixture") {
      process.stdout.write("\u001b[?1049h\u001b[2");
      await new Promise((resolve) => setTimeout(resolve, 10));
      process.stdout.write("J\u001b[H\u001b[31mALT-SCREEN-DECOY\u001b[0m");
      await new Promise((resolve) => setTimeout(resolve, 10));
      process.stdout.write("\u001b[4;1HERASED-LINE");
      await new Promise((resolve) => setTimeout(resolve, 10));
      process.stdout.write("\u001b[?1049l\u001b[2J\u001b[H\u001b[35mWORKBENCH VT FIXTURE\u001b[0m");
      process.stdout.write("\u001b[3;1HCursor movement: passed");
      process.stdout.write("\u001b[4;1Hobsolete\u001b[2K\r\u001b[32mFINAL STATUS: READY\u001b[0m");
      process.stdout.write("\u001b[5;1Hcontroller> ");
      return;
    }
    if (line === "inspect") {
      const inspected = await control.request("work-context.inspect", {});
      if (inspected?.type === "project.work-context") {
        process.stdout.write(
          `Project identity: ${inspected.projectId} (revision ${inspected.revision}).\r\n`
            + `Harness: ${inspected.harnessId} @ ${inspected.pinnedRevision}.\r\ncontroller> `,
        );
      } else {
        process.stdout.write(
          `Inspected ${canonicalReference} for ${workContextId}.\r\ncontroller> `,
        );
      }
      return;
    }
    const prepareMatch = /^prepare ([1-9][0-9]{0,4095}) (sandcastle\/issue-[1-9][0-9]{0,4095})$/
      .exec(line);
    if (prepareMatch) {
      const issueDigits = prepareMatch[1];
      const parsedIssueNumber = Number(issueDigits);
      const issueNumber = Number.isSafeInteger(parsedIssueNumber)
        ? parsedIssueNumber
        : issueDigits;
      const targetBranch = prepareMatch[2];
      const inputDigest = createHash("sha256")
        .update(`${issueDigits}\0${targetBranch}`)
        .digest("hex");
      const outcome = await control.request("launch-request.prepare", {
        parameters: { issueNumber, targetBranch },
        expiresInSeconds: 300,
        idempotencyKey: `provider:${sessionId}:prepare:${inputDigest}`,
      });
      if (outcome?.type !== "launch.request.prepare.result") {
        process.stdout.write(
          `Launch preparation failed safely: ${outcome?.code ?? "provider_operation_failed"}.\r\ncontroller> `,
        );
        return;
      }
      const request = outcome.launchRequest;
      const preview = request.preview;
      process.stdout.write(
        `Launch request: ${request.launchRequestId} (revision ${request.revision}).\r\n`
          + `Host: ${preview.hostId}.\r\n`
          + `Project: ${preview.projectId}.\r\n`
          + `Harness: ${preview.harnessId} @ ${preview.harnessPinnedRevision}.\r\n`
          + `Parameters: issue #${preview.parameters.issueNumber}; branch ${preview.parameters.targetBranch}.\r\n`
          + `Supplied capabilities: ${preview.suppliedCapabilities.join(", ")}.\r\n`
          + `Authorization: ${preview.authorizationClass}; expires ${preview.expiresAt}.\r\n`
          + `Preview: ${preview.summary}\r\n`
          + `Secret-free preview: ${preview.secretFree ? "yes" : "no"}.\r\n`
          + `Delegated work started: ${preview.delegatedWorkStarted ? "yes" : "no"}.\r\n`
          + `Reply exactly: approve ${request.launchRequestId} ${request.revision} or reject ${request.launchRequestId} ${request.revision}.\r\ncontroller> `,
      );
      return;
    }
    const decisionMatch = /^(approve|reject) (launch-request-[a-f0-9]{24}) ([1-9][0-9]*)$/.exec(line);
    if (decisionMatch) {
      const decision = decisionMatch[1] === "approve" ? "approved" : "rejected";
      const launchRequestId = decisionMatch[2];
      const expectedRevision = Number(decisionMatch[3]);
      const outcome = await control.request("launch-request.decide", {
        launchRequestId,
        decision,
        expectedRevision,
        idempotencyKey:
          `provider:${sessionId}:decision:${launchRequestId}:${expectedRevision}:${decision}`,
      });
      if (outcome?.type !== "launch.request.decision.result") {
        process.stdout.write(
          `Launch decision failed safely: ${outcome?.code ?? "provider_operation_failed"}`
            + `${outcome?.current ? `; current revision ${outcome.current.revision} (${outcome.current.status})` : ""}.\r\ncontroller> `,
        );
        return;
      }
      process.stdout.write(
        `Launch request ${launchRequestId} ${decision} at revision ${outcome.revision}. `
          + "No Harness run was started. "
          + (decision === "approved"
            ? `Start it exactly: start ${launchRequestId} ${outcome.revision}.`
            : "")
          + "\r\ncontroller> ",
      );
      return;
    }
    const startMatch = /^start (launch-request-[a-f0-9]{24}) ([1-9][0-9]*)$/.exec(line);
    if (startMatch) {
      const launchRequestId = startMatch[1];
      const expectedRevision = Number(startMatch[2]);
      const idempotencyKey =
        `provider:${sessionId}:harness-run:start:${launchRequestId}:${expectedRevision}`;
      let outcome;
      let recoveredFromAmbiguousResponse = false;
      try {
        outcome = await control.request("harness-run.start", {
          launchRequestId,
          expectedRevision,
          idempotencyKey,
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "provider_operation_timeout") {
          process.stdout.write(
            `Harness run did not start: ${error instanceof Error ? error.message : "provider_operation_failed"}.\r\ncontroller> `,
          );
          return;
        }
        const lookup = await control.request("harness-run.lookup", { idempotencyKey });
        outcome = lookup?.found ? lookup.startOutcome : null;
        recoveredFromAmbiguousResponse = Boolean(lookup?.found);
      }
      if (outcome?.type !== "harness.run.start.result") {
        process.stdout.write(
          `Harness run did not start: ${outcome?.code ?? "harness_run_start_indeterminate"}.\r\ncontroller> `,
        );
        return;
      }
      process.stdout.write(
        `Harness run ${outcome.run.harnessRunId} ${outcome.code === "harness_run_created" ? "created" : "found"}. `
          + (recoveredFromAmbiguousResponse
            ? "Recovered the accepted outcome by exact idempotency-key lookup after the start response timed out. "
            : "")
          + "Terminal observation continues asynchronously in the Cockpit.\r\ncontroller> ",
      );
      return;
    }
    if (line === "exit") {
      process.stdout.write("Conformance Controller session ended.\r\n");
      process.exit(0);
      return;
    }
    if (line.length > 0) {
      process.stdout.write("Conformance Controller did not recognize that request.\r\ncontroller> ");
    }
  };
  process.stdin.on("data", (chunk) => {
    pending += chunk;
    while (/\r|\n/.test(pending)) {
      const match = /\r\n|\r|\n/.exec(pending);
      if (!match) {
        break;
      }
      const line = pending.slice(0, match.index).trim();
      pending = pending.slice(match.index + match[0].length);
      processing = processing.then(() => handleLine(line)).catch((error) => {
        process.stdout.write(
          `Controller operation failed safely: ${error instanceof Error ? error.message : "provider_operation_failed"}.\r\ncontroller> `,
        );
      });
    }
  });
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "probe") {
    probe();
  } else if (command === "prepare") {
    prepare(rest);
  } else if (command === "run") {
    await run(rest);
  } else {
    throw new Error("provider_adapter_command_invalid");
  }
};

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "provider_adapter_failed"}\n`);
  process.exitCode = 1;
}
