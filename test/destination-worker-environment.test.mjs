import assert from "node:assert/strict";
import test from "node:test";
import { delimiter } from "node:path";
import {
  createDestinationWorkerEnvironment,
  destinationCodexAuthPath,
  isMountableCodexAuthFile,
} from "../src/destination-worker-environment.mjs";

test("the Worker resolves and verifies only its destination-local Codex auth file", () => {
  assert.equal(destinationCodexAuthPath({
    environment: { HOME: "/srv/destination-user" },
    platform: "linux",
  }), "/srv/destination-user/.codex/auth.json");
  assert.equal(destinationCodexAuthPath({
    environment: {
      HOME: "C:\\Users\\destination",
      CODEX_HOME: "D:\\Codex",
    },
    platform: "win32",
  }), "D:\\Codex\\auth.json");
  assert.equal(isMountableCodexAuthFile("/auth.json", {
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
  }), true);
  assert.equal(isMountableCodexAuthFile("/auth.json", {
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => true }),
  }), false);
  assert.equal(isMountableCodexAuthFile("/missing.json", {
    lstatSync: () => { throw new Error("ENOENT"); },
  }), false);
});

test("the Host derives a minimal destination-local Worker environment", () => {
  const environment = createDestinationWorkerEnvironment({
    executablePath: "/opt/sandking-node/bin/node",
    githubConfigDirectory: null,
    homeDirectory: "/srv/destination-user",
    pathValue: "/srv/destination-user/.local/bin:/opt/provider/bin:/usr/bin",
    platform: "linux",
    systemRoot: null,
    xdgConfigHome: null,
  });

  assert.deepEqual(environment, {
    LANG: "C.UTF-8",
    HOME: "/srv/destination-user",
    PATH: [
      "/srv/destination-user/.local/bin",
      "/opt/provider/bin",
      "/usr/bin",
      "/opt/sandking-node/bin",
      "/usr/local/bin",
      "/bin",
    ].join(delimiter),
  });
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.CODEX_HOME, undefined);
});

test("the Host preserves GitHub CLI configuration locators without token variables", () => {
  const environment = createDestinationWorkerEnvironment({
    executablePath: "/opt/sandking-node/bin/node",
    githubConfigDirectory: "/srv/destination-user/private-gh",
    homeDirectory: "/srv/destination-user",
    pathValue: "/usr/bin",
    platform: "linux",
    systemRoot: null,
    xdgConfigHome: "/srv/destination-user/config",
  });

  assert.equal(environment.GH_CONFIG_DIR, "/srv/destination-user/private-gh");
  assert.equal(environment.XDG_CONFIG_HOME, "/srv/destination-user/config");
  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
});

test("the Windows destination keeps configured Git, Codex, and npm locations", () => {
  const originalAppData = process.env.APPDATA;
  process.env.APPDATA = "D:\\Destination Profile\\Roaming";
  let environment;
  try {
    environment = createDestinationWorkerEnvironment({
      executablePath: "C:\\Program Files\\nodejs\\node.exe",
      githubConfigDirectory: null,
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
      xdgConfigHome: null,
    });
  } finally {
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
  }

  assert.deepEqual(environment, {
    LANG: "C.UTF-8",
    HOME: "C:\\Users\\destination",
    USERPROFILE: "C:\\Users\\destination",
    APPDATA: "D:\\Destination Profile\\Roaming",
    PATH: [
      "C:\\Users\\destination\\AppData\\Roaming\\npm",
      "C:\\Program Files\\Git\\cmd",
      "C:\\Program Files\\nodejs",
      "C:\\Windows\\System32",
      "C:\\Windows",
    ].join(";"),
    SystemRoot: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  });
});
