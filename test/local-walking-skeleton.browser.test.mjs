import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "src", "cli.mjs");

const loadPlaywright = async () => {
  try {
    return await import("playwright");
  } catch {
    return null;
  }
};

test("local-walking-skeleton browser path opens the Cockpit and completes the entry handshake", async (t) => {
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    t.skip("playwright is not installed in this checkout");
    return;
  }

  const dataDir = await mkdtemp(join(tmpdir(), "sandking-browser-"));

  try {
    const { stdout } = await execFileAsync("node", [cliPath, "launch", "--data-dir", dataDir, "--json", "--no-open"], {
      cwd: process.cwd(),
      env: process.env,
    });
    const launch = JSON.parse(stdout);
    const browser = await playwright.chromium.launch({ headless: true });

    try {
      const page = await browser.newPage();
      await page.goto(launch.bootstrapUrl, { waitUntil: "networkidle" });
      await page.waitForFunction(
        () => document.querySelector("#app")?.textContent?.includes("Connected to local-host"),
      );
      const text = await page.textContent("#app");
      assert.match(text, /Connected to local-host with protocol 1\.0\.0/);
    } finally {
      await browser.close();
    }
  } finally {
    await execFileAsync("node", [cliPath, "stop", "--data-dir", dataDir, "--json"], {
      cwd: process.cwd(),
      env: process.env,
    });
    await rm(dataDir, { recursive: true, force: true });
  }
});
