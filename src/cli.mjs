import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { launchRuntime, stopRuntime } from "./runtime.mjs";

const execFileAsync = promisify(execFile);

const parseArgs = (argv) => {
  const [command = "launch", ...rest] = argv;
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
    }
  }

  return options;
};

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
    output = await launchRuntime({ dataDir: options.dataDir });
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
  } else if (output.bootstrapUrl) {
    process.stdout.write(`${output.bootstrapUrl}\n`);
  } else {
    process.stdout.write(`${output.stopped ? "stopped" : "not-running"}\n`);
  }
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
