#!/usr/bin/env node

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
  if (
    !/^controller-session-[a-f0-9]{24}$/.test(sessionId)
    || !providerSessionPattern.test(providerSessionId)
    || !identifierPattern.test(workContextId)
    || !canonicalReferencePattern.test(canonicalReference)
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
    command: {
      executable: process.execPath,
      args: [
        adapterPath,
        "run",
        "--session-id", sessionId,
        "--provider-session-id", providerSessionId,
        "--work-context-id", workContextId,
        "--canonical-reference", canonicalReference,
      ],
      environment: {
        LANG: "C.UTF-8",
        TERM: "xterm-256color",
      },
    },
  });
};

/** @param {string[]} argv */
const run = (argv) => {
  const flags = parseFlags(argv);
  const sessionId = flags.get("session-id") ?? "";
  const providerSessionId = flags.get("provider-session-id") ?? "";
  const workContextId = flags.get("work-context-id") ?? "";
  const canonicalReference = flags.get("canonical-reference") ?? "";
  if (
    !/^controller-session-[a-f0-9]{24}$/.test(sessionId)
    || !providerSessionPattern.test(providerSessionId)
    || !identifierPattern.test(workContextId)
    || !canonicalReferencePattern.test(canonicalReference)
  ) {
    throw new Error("provider_session_contract_invalid");
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("provider_pty_required");
  }

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

try {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "probe") {
    probe();
  } else if (command === "prepare") {
    prepare(rest);
  } else if (command === "run") {
    run(rest);
  } else {
    throw new Error("provider_adapter_command_invalid");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "provider_adapter_failed"}\n`);
  process.exitCode = 1;
}
