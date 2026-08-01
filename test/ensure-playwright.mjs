import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);

const browserPath = chromium.executablePath();

try {
  await access(browserPath, constants.X_OK);
} catch (error) {
  if (!(error && typeof error === "object" && error.code === "ENOENT")) {
    throw error;
  }

  await execFileAsync(process.execPath, ["node_modules/playwright/cli.js", "install", "chromium"], {
    cwd: process.cwd(),
    env: process.env,
  });
}
