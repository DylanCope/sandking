import { homedir } from "node:os";
import { delimiter, dirname } from "node:path";

/**
 * Build the narrow environment used by destination-local Harness Workers.
 * Values are derived by the Host account rather than copied from a Controller
 * environment, so provider credential variables and process injection options
 * never cross the Controller-to-Host boundary.
 *
 * @param {{
 *   executablePath?: string,
 *   homeDirectory?: string,
 *   platform?: NodeJS.Platform,
 *   systemRoot?: string | null,
 * }} [options]
 */
export const createDestinationWorkerEnvironment = (options = {}) => {
  const executablePath = options.executablePath ?? process.execPath;
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  const systemRoot = options.systemRoot
    ?? (platform === "win32" ? process.env.SystemRoot ?? null : null);
  const executableDirectory = dirname(executablePath);
  const pathEntries = platform === "win32"
    ? [
        executableDirectory,
        ...(systemRoot ? [
          `${systemRoot}\\System32`,
          systemRoot,
        ] : []),
      ]
    : [executableDirectory, "/usr/local/bin", "/usr/bin", "/bin"];
  const environment = {
    LANG: "C.UTF-8",
    ...(platform === "win32"
      ? { USERPROFILE: homeDirectory }
      : { HOME: homeDirectory }),
    PATH: [...new Set(pathEntries)].join(delimiter),
    ...(systemRoot ? { SystemRoot: systemRoot } : {}),
  };
  return environment;
};
