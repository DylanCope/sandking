import { accessSync, constants, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** @type {Record<string, string>} */
const packagedLinuxHelpers = {
  x64: fileURLToPath(new URL("./native/linux-x64/posix-process-tree-helper", import.meta.url)),
  arm64: fileURLToPath(new URL("./native/linux-arm64/posix-process-tree-helper", import.meta.url)),
};
/** @type {string | null} */
let retainedLinuxHelperPath = null;

export const ensureLinuxNativeHelper = () => {
  if (retainedLinuxHelperPath) return retainedLinuxHelperPath;
  const helperPath = packagedLinuxHelpers[process.arch];
  if (!helperPath) throw new Error("posix_process_tree_helper_unsupported_architecture");
  const helperStat = lstatSync(helperPath);
  if (!helperStat.isFile() || helperStat.isSymbolicLink()) {
    throw new Error("posix_process_tree_helper_invalid");
  }
  accessSync(helperPath, constants.X_OK);
  retainedLinuxHelperPath = helperPath;
  return helperPath;
};
