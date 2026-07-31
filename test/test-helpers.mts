import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";

export async function launchCli({ runtimeRoot }: { runtimeRoot: string }) {
  const child = spawn(join(process.cwd(), "node_modules", ".bin", "tsx"), ["src/cli.mts", "--json"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SANDKING_RUNTIME_ROOT: runtimeRoot,
      SANDKING_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const launch = await new Promise<{
    cockpitUrl: string;
    sessionToken: string;
    pid: number;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(`Timed out waiting for Sand-King launch output.\nstdout:\n${stdout}\nstderr:\n${stderr}`),
      );
    }, 15_000);

    const onData = () => {
      const line = stdout
        .split(/\r?\n/)
        .map((value) => value.trim())
        .find((value) => value.startsWith("{") && value.endsWith("}"));
      if (!line) {
        return;
      }
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    };

    child.stdout.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(`Sand-King exited before launch completed with code ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`),
      );
    });
  });

  assert.ok(launch.cockpitUrl.startsWith("http://127.0.0.1:"));
  assert.ok(launch.sessionToken.length > 10);

  return {
    ...launch,
    async stop() {
      if (child.exitCode !== null) {
        return;
      }
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
    },
  };
}
