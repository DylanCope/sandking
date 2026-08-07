#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { openBrowser } from "./browser-launch.mjs";
import {
  requestControllerDescription,
  requestControllerLaunch,
} from "./controller-cli.mjs";
import { RuntimeStartupError, launchRuntime, stopRuntime } from "./runtime.mjs";

const harnessLaunchHelp = `Usage:
  sandking launch [<project-id>] --issue <number> [--target-branch sandcastle/issue-<number>] [--idempotency-key <key>] [--json]

Launches one Harness run immediately. Inside a Controller session, <project-id>
defaults to the focused Controller Project.
`;

/** @param {string[]} argv */
const parseArgs = (argv) => {
  const [command = "launch", ...rest] = argv;
  /** @type {{command: string, help: boolean, noOpen: boolean, json: boolean, projectId?: string, issueNumber?: number, targetBranch?: string, dataDir?: string, hostMode?: string, startupTimeoutMs?: number, bootstrapTtlMs?: number, browserSessionTtlMs?: number, idempotencyKey?: string, expectedRevision?: number}} */
  const options = { command, help: false, noOpen: false, json: false };

  if ((command === "--help" || command === "-h") && rest.length === 0) {
    options.help = true;
    return options;
  }
  if (command === "help") {
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== "launch")) {
      throw new Error(`Unsupported help topic: ${rest.join(" ")}`);
    }
    options.help = true;
    return options;
  }

  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    if (current === "--help" || current === "-h") {
      options.help = true;
    } else if (current === "--data-dir") {
      options.dataDir = rest[index + 1];
      index += 1;
    } else if (current === "--no-open") {
      options.noOpen = true;
    } else if (current === "--json") {
      options.json = true;
    } else if (current === "--host-mode") {
      options.hostMode = rest[index + 1];
      index += 1;
    } else if (current === "--startup-timeout-ms") {
      options.startupTimeoutMs = Number(rest[index + 1]);
      index += 1;
      if (!Number.isSafeInteger(options.startupTimeoutMs) || options.startupTimeoutMs < 100) {
        throw new Error("Invalid --startup-timeout-ms value.");
      }
    } else if (current === "--bootstrap-ttl-ms") {
      options.bootstrapTtlMs = Number(rest[index + 1]);
      index += 1;
      if (
        !Number.isSafeInteger(options.bootstrapTtlMs)
        || options.bootstrapTtlMs < 1
        || options.bootstrapTtlMs > 60_000
      ) {
        throw new Error("Invalid --bootstrap-ttl-ms value.");
      }
    } else if (current === "--browser-session-ttl-ms") {
      options.browserSessionTtlMs = Number(rest[index + 1]);
      index += 1;
      if (
        !Number.isSafeInteger(options.browserSessionTtlMs)
        || options.browserSessionTtlMs < 1
        || options.browserSessionTtlMs > 15 * 60_000
      ) {
        throw new Error("Invalid --browser-session-ttl-ms value.");
      }
    } else if (current === "--idempotency-key") {
      options.idempotencyKey = rest[index + 1];
      index += 1;
    } else if (current === "--issue") {
      options.issueNumber = Number(rest[index + 1]);
      index += 1;
      if (!Number.isSafeInteger(options.issueNumber) || options.issueNumber < 1) {
        throw new Error("Invalid --issue value.");
      }
    } else if (current === "--target-branch") {
      options.targetBranch = rest[index + 1];
      index += 1;
    } else if (current === "--expected-revision") {
      options.expectedRevision = Number(rest[index + 1]);
      index += 1;
    } else if (command === "launch" && !current.startsWith("-") && !options.projectId) {
      options.projectId = current;
    } else {
      throw new Error(`Unsupported option: ${current}`);
    }
  }

  return options;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.command === "help" || options.command === "--help") {
    if (process.env.SANDKING_CONTROLLER_ENDPOINT) {
      await requestControllerDescription();
    }
    process.stdout.write(harnessLaunchHelp);
    return;
  }
  let output;

  const controllerLaunchRequested = options.command === "launch"
    && (options.projectId !== undefined
      || options.issueNumber !== undefined
      || options.targetBranch !== undefined);
  if (controllerLaunchRequested) {
    if (!options.issueNumber) {
      throw new Error("Harness launch requires --issue.");
    }
    if (options.expectedRevision !== undefined) {
      throw new Error("Harness launch does not accept --expected-revision.");
    }
    const projectId = options.projectId ?? process.env.SANDKING_WORK_CONTEXT_ID;
    if (!projectId) {
      throw new Error("Harness launch requires a Project ID or focused Controller Project.");
    }
    output = await requestControllerLaunch({
      projectId,
      parameters: {
        issueNumber: options.issueNumber,
        targetBranch: options.targetBranch ?? `sandcastle/issue-${options.issueNumber}`,
      },
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
    });
  } else if (options.command === "launch") {
    output = await launchRuntime({
      dataDir: options.dataDir,
      hostMode: options.hostMode,
      startupTimeoutMs: options.startupTimeoutMs,
      bootstrapTtlMs: options.bootstrapTtlMs,
      browserSessionTtlMs: options.browserSessionTtlMs,
      idempotencyKey: options.idempotencyKey,
      expectedRevision: options.expectedRevision,
    });
    if (!options.noOpen && "bootstrapUrl" in output) {
      await openBrowser(output.bootstrapUrl).catch(() => undefined);
    }
  } else if (options.command === "stop") {
    output = await stopRuntime({
      dataDir: options.dataDir,
      idempotencyKey: options.idempotencyKey,
      expectedRevision: options.expectedRevision,
    });
  } else {
    throw new Error(`Unsupported command: ${options.command}`);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } else if ("bootstrapUrl" in output && output.bootstrapUrl) {
    process.stdout.write(`${output.bootstrapUrl}\n`);
  } else if ("stopped" in output) {
    process.stdout.write(`${output.stopped ? "stopped" : "not-running"}\n`);
  } else if ("run" in output && output.run?.harnessRunId) {
    process.stdout.write(`${output.run.harnessRunId}\n`);
  } else if ("code" in output) {
    process.stdout.write(`${output.code}\n`);
  }
};

main().catch((error) => {
  if (error instanceof RuntimeStartupError) {
    if (process.argv.slice(2).includes("--json")) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        diagnosis: error.diagnosis,
      })}\n`);
    } else {
      process.stderr.write(
        `${error.diagnosis.code}: ${error.diagnosis.explanation}\n`
        + `Retry: ${error.diagnosis.retryGuidance}\n`,
      );
    }
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
