import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/**
 * Build the narrow environment used by destination-local Harness Workers.
 * Values are derived by the Host account rather than copied from a Controller
 * environment, so provider credential variables and process injection options
 * never cross the Controller-to-Host boundary.
 *
 * @param {{
 *   appDataDirectory?: string | null,
 *   executablePath?: string,
 *   githubConfigDirectory?: string | null,
 *   homeDirectory?: string,
 *   commandInterpreter?: string | null,
 *   pathValue?: string,
 *   pathExtensions?: string | null,
 *   platform?: NodeJS.Platform,
 *   systemRoot?: string | null,
 *   xdgConfigHome?: string | null,
 * }} [options]
 */
export const createDestinationWorkerEnvironment = (options = {}) => {
  const executablePath = options.executablePath ?? process.execPath;
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  const appDataDirectory = options.appDataDirectory === undefined
    ? platform === "win32" ? process.env.APPDATA ?? null : null
    : options.appDataDirectory;
  const githubConfigDirectory = options.githubConfigDirectory === undefined
    ? process.env.GH_CONFIG_DIR ?? null
    : options.githubConfigDirectory;
  const xdgConfigHome = options.xdgConfigHome === undefined
    ? process.env.XDG_CONFIG_HOME ?? null
    : options.xdgConfigHome;
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const systemRoot = options.systemRoot
    ?? (platform === "win32" ? process.env.SystemRoot ?? null : null);
  const commandInterpreter = options.commandInterpreter
    ?? (platform === "win32"
      ? process.env.ComSpec ?? (systemRoot ? `${systemRoot}\\System32\\cmd.exe` : null)
      : null);
  const pathExtensions = options.pathExtensions
    ?? (platform === "win32" ? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD" : null);
  const path = platform === "win32" ? win32 : posix;
  const executableDirectory = path.dirname(executablePath);
  const destinationPathEntries = pathValue.split(path.delimiter).filter(Boolean);
  const pathEntries = platform === "win32"
    ? [
        ...destinationPathEntries,
        executableDirectory,
        ...(systemRoot ? [
          `${systemRoot}\\System32`,
          systemRoot,
        ] : []),
      ]
    : [
        ...destinationPathEntries,
        executableDirectory,
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ];
  const seenPathEntries = new Set();
  const uniquePathEntries = pathEntries.filter((entry) => {
    const identity = platform === "win32" ? entry.toLowerCase() : entry;
    if (seenPathEntries.has(identity)) return false;
    seenPathEntries.add(identity);
    return true;
  });
  const environment = {
    LANG: "C.UTF-8",
    ...(platform === "win32"
      ? {
          HOME: homeDirectory,
          USERPROFILE: homeDirectory,
          ...(appDataDirectory ? { APPDATA: appDataDirectory } : {}),
        }
      : { HOME: homeDirectory }),
    ...(githubConfigDirectory ? { GH_CONFIG_DIR: githubConfigDirectory } : {}),
    ...(xdgConfigHome ? { XDG_CONFIG_HOME: xdgConfigHome } : {}),
    PATH: uniquePathEntries.join(path.delimiter),
    ...(systemRoot ? { SystemRoot: systemRoot } : {}),
    ...(commandInterpreter ? { ComSpec: commandInterpreter } : {}),
    ...(pathExtensions ? { PATHEXT: pathExtensions } : {}),
  };
  return environment;
};
