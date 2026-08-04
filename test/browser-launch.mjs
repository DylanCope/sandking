import chromiumBundle, { inflate } from "@sparticuz/chromium";
import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@sparticuz/chromium"))));
const bundleDirectory = join(packageRoot, "bin");

let preparedRuntime;

export const prepareBrowserRuntime = async () => {
  if (!preparedRuntime) {
    preparedRuntime = (async () => {
      const libraryDirectory = join(
        await inflate(join(bundleDirectory, "al2023.tar.br")),
        "lib",
      );
      const executablePath = await chromiumBundle.executablePath(bundleDirectory);
      const args = chromiumBundle.args.filter((argument) => ![
        "--allow-running-insecure-content",
        "--disable-site-isolation-trials",
        "--disable-web-security",
      ].includes(argument));
      return {
        executablePath,
        args,
        env: {
          ...process.env,
          FONTCONFIG_PATH: join(tmpdir(), "fonts"),
          LD_LIBRARY_PATH: [libraryDirectory, process.env.LD_LIBRARY_PATH]
            .filter(Boolean)
            .join(":"),
        },
      };
    })();
  }
  return preparedRuntime;
};

export const launchBrowser = async ({ niceAdjustment = 0 } = {}) => {
  const runtime = await prepareBrowserRuntime();
  if (!Number.isSafeInteger(niceAdjustment) || niceAdjustment < 0 || niceAdjustment > 19) {
    throw new Error("browser_nice_adjustment_invalid");
  }
  let executablePath = runtime.executablePath;
  if (niceAdjustment > 0) {
    executablePath = join(
      tmpdir(),
      `sandking-chromium-nice-${process.pid}-${niceAdjustment}`,
    );
    await writeFile(
      executablePath,
      `#!/bin/sh\nexec /usr/bin/nice -n ${niceAdjustment} ${JSON.stringify(runtime.executablePath)} "$@"\n`,
      { mode: 0o700 },
    );
  }
  return chromium.launch({
    headless: true,
    executablePath,
    args: runtime.args,
    env: runtime.env,
  });
};
