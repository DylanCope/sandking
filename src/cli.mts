import { launchSandKing } from "./runtime.mts";

const options = parseArgs(process.argv.slice(2));
const launch = await launchSandKing({
  runtimeRoot: process.env.SANDKING_RUNTIME_ROOT,
  port: parsePort(process.env.SANDKING_PORT),
});

if (options.json) {
  process.stdout.write(
    `${JSON.stringify({
      cockpitUrl: launch.cockpitUrl,
      sessionToken: launch.sessionToken,
      pid: process.pid,
    })}\n`,
  );
} else {
  process.stdout.write(`Sand-King Cockpit: ${launch.cockpitUrl}\n`);
}

let closing = false;
const close = async () => {
  if (closing) {
    return;
  }
  closing = true;
  await launch.close();
};

process.on("SIGINT", () => {
  void close().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});

function parseArgs(args: string[]) {
  return {
    json: args.includes("--json"),
  };
}

function parsePort(port: string | undefined) {
  if (!port) {
    return 0;
  }
  const parsed = Number.parseInt(port, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}
