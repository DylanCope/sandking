import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import vm from "node:vm";

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

type Listener = (event: { preventDefault(): void; target: FakeElement }) => unknown;

class FakeElement {
  readonly listeners = new Map<string, Listener[]>();
  textContent = "";
  value = "";

  constructor(readonly id: string) {}

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async dispatch(type: string) {
    const listeners = this.listeners.get(type) ?? [];
    for (const listener of listeners) {
      await listener({
        preventDefault() {},
        target: this,
      });
    }
  }
}

export async function loadCockpit(cockpitUrl: string) {
  const response = await fetch(cockpitUrl);
  assert.equal(response.status, 200);
  const html = await response.text();
  const scriptMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "expected the Cockpit HTML to include a module script");
  const sessionToken = html.match(/<meta name="sandking-session" content="([^"]+)"/)?.[1];
  assert.ok(sessionToken, "expected the Cockpit HTML to publish a session token");

  const elements = new Map<string, FakeElement>();
  const getElement = (id: string) => {
    let element = elements.get(id);
    if (!element) {
      element = new FakeElement(id);
      elements.set(id, element);
    }
    return element;
  };

  const context = vm.createContext({
    console,
    window: {},
    document: {
      getElementById(id: string) {
        return getElement(id);
      },
      querySelector(selector: string) {
        if (selector === 'meta[name="sandking-session"]') {
          return {
            getAttribute(name: string) {
              return name === "content" ? sessionToken : null;
            },
          };
        }
        return null;
      },
    },
    fetch(input: string | URL, init?: RequestInit) {
      const url = new URL(typeof input === "string" ? input : input.toString(), cockpitUrl);
      return fetch(url, init);
    },
    URL,
    setTimeout,
    clearTimeout,
  });
  Object.assign(context.window as object, context);

  await vm.runInContext(scriptMatch[1], context);

  return {
    html,
    sessionToken,
    elements: {
      runtimeStatus: getElement("runtime-status"),
      runtimeSnapshot: getElement("runtime-snapshot"),
      refreshRuntime: getElement("refresh-runtime"),
      sessionForm: getElement("controller-session-form"),
      projectRegistration: getElement("project-registration"),
      provider: getElement("provider"),
      sessionStatus: getElement("controller-session-status"),
      sessionResult: getElement("controller-session-result"),
    },
    async waitFor(predicate: () => boolean, message: string) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (predicate()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(message);
    },
  };
}
