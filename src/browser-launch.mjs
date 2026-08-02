import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * @param {string} url
 * @param {{platform?: NodeJS.Platform, environment?: NodeJS.ProcessEnv}} [options]
 */
export const selectBrowserLaunch = (url, options = {}) => {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  if (environment.WSL_INTEROP || environment.WSL_DISTRO_NAME) {
    return {
      command: "/mnt/c/Windows/System32/rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    };
  }
  return { command: "xdg-open", args: [url] };
};

/** @param {string} url */
export const openBrowser = async (url) => {
  const launch = selectBrowserLaunch(url);
  await execFileAsync(launch.command, launch.args);
};
