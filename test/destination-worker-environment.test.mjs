import assert from "node:assert/strict";
import test from "node:test";
import { delimiter } from "node:path";
import { createDestinationWorkerEnvironment } from "../src/destination-worker-environment.mjs";

test("the Host derives a minimal destination-local Worker environment", () => {
  const environment = createDestinationWorkerEnvironment({
    executablePath: "/opt/sandking-node/bin/node",
    homeDirectory: "/srv/destination-user",
    pathValue: "/srv/destination-user/.local/bin:/opt/provider/bin:/usr/bin",
    platform: "linux",
    systemRoot: null,
  });

  assert.deepEqual(environment, {
    LANG: "C.UTF-8",
    HOME: "/srv/destination-user",
    PATH: [
      "/opt/sandking-node/bin",
      "/srv/destination-user/.local/bin",
      "/opt/provider/bin",
      "/usr/bin",
      "/usr/local/bin",
      "/bin",
    ].join(delimiter),
  });
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.CODEX_HOME, undefined);
});

test("the Windows destination keeps configured Git, Codex, and npm locations", () => {
  const environment = createDestinationWorkerEnvironment({
    executablePath: "C:\\Program Files\\nodejs\\node.exe",
    homeDirectory: "C:\\Users\\destination",
    commandInterpreter: "C:\\Windows\\System32\\cmd.exe",
    pathValue: [
      "C:\\Users\\destination\\AppData\\Roaming\\npm",
      "C:\\Program Files\\Git\\cmd",
      "C:\\Program Files\\nodejs",
    ].join(";"),
    platform: "win32",
    pathExtensions: ".COM;.EXE;.BAT;.CMD",
    systemRoot: "C:\\Windows",
  });

  assert.deepEqual(environment, {
    LANG: "C.UTF-8",
    USERPROFILE: "C:\\Users\\destination",
    PATH: [
      "C:\\Program Files\\nodejs",
      "C:\\Users\\destination\\AppData\\Roaming\\npm",
      "C:\\Program Files\\Git\\cmd",
      "C:\\Windows\\System32",
      "C:\\Windows",
    ].join(";"),
    SystemRoot: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  });
});
