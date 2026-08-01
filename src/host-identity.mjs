import { randomBytes } from "node:crypto";
import { chmod, open } from "node:fs/promises";
import { join } from "node:path";
import {
  PRIVATE_FILE_MODE,
  ensurePrivateDirectory,
  hasErrorCode,
  readJson,
} from "./private-state.mjs";

const hostIdPattern = /^host-[a-f0-9]{24}$/;

/** @param {unknown} value */
const validateHostIdentity = (value) => {
  if (
    !value
    || typeof value !== "object"
    || !("hostId" in value)
    || !("createdAt" in value)
    || !hostIdPattern.test(String(value.hostId))
    || Number.isNaN(Date.parse(String(value.createdAt)))
  ) {
    throw new Error("host_identity_state_invalid");
  }
  return {
    hostId: String(value.hostId),
    createdAt: String(value.createdAt),
  };
};

/** @param {string} dataDir */
export const readHostIdentity = async (dataDir) => {
  const value = await readJson(join(dataDir, "host-identity.json"), null);
  return value === null ? null : validateHostIdentity(value);
};

/**
 * Create the Host-owned durable identity once. A partial write fails closed on
 * the next launch rather than silently adopting another Host identity.
 * @param {string} dataDir
 */
export const ensureHostIdentity = async (dataDir) => {
  await ensurePrivateDirectory(dataDir);
  const existing = await readHostIdentity(dataDir);
  if (existing) {
    return existing;
  }

  const identityPath = join(dataDir, "host-identity.json");
  const identity = {
    hostId: `host-${randomBytes(12).toString("hex")}`,
    createdAt: new Date().toISOString(),
  };
  try {
    const handle = await open(identityPath, "wx", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(identity, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(identityPath, PRIVATE_FILE_MODE);
    return identity;
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
    const racedIdentity = await readHostIdentity(dataDir);
    if (!racedIdentity) {
      throw new Error("host_identity_state_invalid");
    }
    return racedIdentity;
  }
};
