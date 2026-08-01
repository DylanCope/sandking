#!/usr/bin/env node

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
]);
const identifierPattern = /^[a-zA-Z0-9._:-]{1,160}$/;
const providerSessionPattern = /^conformance-provider-session-[a-f0-9]{24}$/;
const canonicalReferencePattern = /^github:fixture:issue:[0-9]+$/;
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

/** @param {string} endpoint @param {unknown} message */
const reportReady = async (endpoint, message) => new Promise((resolve, reject) => {
  const socket = createConnection(endpoint);
  let settled = false;
  /** @param {Error | null} error */
  const finish = (error) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timeout);
    if (error) {
      reject(error);
    } else {
      resolve(undefined);
    }
  };
  const timeout = setTimeout(() => {
    socket.destroy();
    finish(new Error("provider_control_timeout"));
  }, 2_000);
  socket.once("connect", () => {
    socket.end(`${JSON.stringify(message)}\n`);
  });
  socket.once("error", () => finish(new Error("provider_control_unavailable")));
  socket.once("close", (hadError) => {
    if (!hadError) {
      finish(null);
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

  await reportReady(controlEndpoint, {
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
  process.stdin.on("data", (chunk) => {
    pending += chunk;
    while (/\r|\n/.test(pending)) {
      const match = /\r\n|\r|\n/.exec(pending);
      if (!match) {
        break;
      }
      const line = pending.slice(0, match.index).trim();
      pending = pending.slice(match.index + match[0].length);
      if (line === "inspect") {
        process.stdout.write(
          `Inspected ${canonicalReference} for ${workContextId}.\r\ncontroller> `,
        );
      } else if (line === "exit") {
        process.stdout.write("Conformance Controller session ended.\r\n");
        process.exit(0);
      } else if (line.length > 0) {
        process.stdout.write("Conformance Controller did not recognize that request.\r\ncontroller> ");
      }
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
