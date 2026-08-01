import { chromium } from "playwright";

export const launchBrowser = async () => {
  return chromium.launch({ headless: true });
};
