import { launchBrowser } from "./browser-launch.mjs";

// The pretest gate launches the exact repository-declared browser runtime. It
// cannot pass merely because a Chromium archive downloaded successfully.
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.setContent("<main id='browser-gate'>real-browser-ready</main>");
  const marker = await page.textContent("#browser-gate");
  if (marker !== "real-browser-ready") {
    throw new Error("real_browser_gate_failed");
  }
} finally {
  await browser.close();
}
