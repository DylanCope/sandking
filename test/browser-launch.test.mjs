import assert from "node:assert/strict";
import test from "node:test";
import { selectBrowserLaunch } from "../src/browser-launch.mjs";

const bootstrapUrl = "http://127.0.0.1:4321/bootstrap?token=one-use";

test("WSL opens the one-use Cockpit bootstrap through the Windows browser bridge", () => {
  assert.deepEqual(selectBrowserLaunch(bootstrapUrl, {
    platform: "linux",
    environment: { WSL_DISTRO_NAME: "Ubuntu" },
  }), {
    command: "/mnt/c/Windows/System32/rundll32.exe",
    args: ["url.dll,FileProtocolHandler", bootstrapUrl],
  });
});

test("native platforms keep their standard browser launch commands", () => {
  assert.deepEqual(selectBrowserLaunch(bootstrapUrl, {
    platform: "linux",
    environment: {},
  }), { command: "xdg-open", args: [bootstrapUrl] });
  assert.deepEqual(selectBrowserLaunch(bootstrapUrl, {
    platform: "darwin",
    environment: {},
  }), { command: "open", args: [bootstrapUrl] });
  assert.deepEqual(selectBrowserLaunch(bootstrapUrl, {
    platform: "win32",
    environment: {},
  }), { command: "cmd", args: ["/c", "start", "", bootstrapUrl] });
});
