import { randomBytes } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname } from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** @param {unknown} error @param {string} code */
export const hasErrorCode = (error, code) =>
  error instanceof Error && "code" in error && error.code === code;

/** @param {string} directory */
export const ensurePrivateDirectory = async (directory) => {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(directory, PRIVATE_DIRECTORY_MODE);
};

/**
 * JSON files are untrusted persistence boundaries. Callers validate or narrow
 * the parsed value before using it.
 * @param {string} filePath
 * @param {any} fallback
 * @returns {Promise<any>}
 */
export const readJson = async (filePath, fallback) => {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return fallback;
    }
    throw error;
  }
};

/** @param {string} filePath @param {unknown} value */
export const writePrivateJson = async (filePath, value) => {
  await ensurePrivateDirectory(dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, filePath);
  await chmod(filePath, PRIVATE_FILE_MODE);
};

/** @param {string} filePath @param {unknown} value */
export const appendPrivateJsonLine = async (filePath, value) => {
  await ensurePrivateDirectory(dirname(filePath));
  await appendFile(filePath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  });
  await chmod(filePath, PRIVATE_FILE_MODE);
};

/** @param {string} filePath */
export const removePrivateFile = async (filePath) => {
  await rm(filePath, { force: true });
};
