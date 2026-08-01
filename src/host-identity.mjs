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
const controllerBindingPath = "controller-host-binding.json";

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

/** @param {string} dataDir */
export const readControllerHostBinding = async (dataDir) => {
  const value = await readJson(join(dataDir, controllerBindingPath), null);
  return value === null ? null : validateHostIdentity(value);
};

/**
 * Pin the first accepted local Host identity in Controller-owned state. Later
 * launches read this binding independently from the Host-owned identity file,
 * so replacing the Host identity cannot silently change Controller trust.
 * @param {string} dataDir
 */
export const ensureControllerHostBinding = async (dataDir) => {
  await ensurePrivateDirectory(dataDir);
  const existing = await readControllerHostBinding(dataDir);
  if (existing) {
    return existing;
  }

  const hostIdentity = await ensureHostIdentity(dataDir);
  const binding = {
    hostId: hostIdentity.hostId,
    createdAt: new Date().toISOString(),
  };
  const bindingFile = join(dataDir, controllerBindingPath);
  try {
    const handle = await open(bindingFile, "wx", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(binding, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(bindingFile, PRIVATE_FILE_MODE);
    return binding;
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
    const racedBinding = await readControllerHostBinding(dataDir);
    if (!racedBinding) {
      throw new Error("controller_host_binding_state_invalid");
    }
    return racedBinding;
  }
};
