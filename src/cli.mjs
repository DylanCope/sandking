#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RuntimeStartupError, launchRuntime, stopRuntime } from "./runtime.mjs";

const execFileAsync = promisify(execFile);

/** @param {string[]} argv */
const parseArgs = (argv) => {
  const [command = "launch", ...rest] = argv;
  /** @type {{command: string, noOpen: boolean, json: boolean, dataDir?: string, hostMode?: string, startupTimeoutMs?: number}} */
  const options = { command, noOpen: false, json: false };

  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    if (current === "--data-dir") {
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
    } else {
      throw new Error(`Unsupported option: ${current}`);
    }
  }

  return options;
};

/** @param {string} url */
const openBrowser = async (url) => {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  try {
    await execFileAsync(command, args);
  } catch {
    // Best-effort open only; the bootstrap URL is still printed.
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  let output;

  if (options.command === "launch") {
    output = await launchRuntime({
      dataDir: options.dataDir,
      hostMode: options.hostMode,
      startupTimeoutMs: options.startupTimeoutMs,
    });
    if (!options.noOpen) {
      await openBrowser(output.bootstrapUrl);
    }
  } else if (options.command === "stop") {
    output = await stopRuntime({ dataDir: options.dataDir });
  } else {
    throw new Error(`Unsupported command: ${options.command}`);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } else if ("bootstrapUrl" in output && output.bootstrapUrl) {
    process.stdout.write(`${output.bootstrapUrl}\n`);
  } else if ("stopped" in output) {
    process.stdout.write(`${output.stopped ? "stopped" : "not-running"}\n`);
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
