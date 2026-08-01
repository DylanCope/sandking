import chromiumBundle, { inflate } from "@sparticuz/chromium";
import { chromium } from "playwright";
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

export const launchBrowser = async () => {
  const runtime = await prepareBrowserRuntime();
  return chromium.launch({
    headless: true,
    executablePath: runtime.executablePath,
    args: runtime.args,
    env: runtime.env,
  });
};
