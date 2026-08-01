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

/** @param {string} filePath @param {{hostId: string, createdAt: string}} identity @param {() => Promise<{hostId: string, createdAt: string} | null>} readRacedIdentity @param {string} invalidCode */
const writeIdentityOnce = async (filePath, identity, readRacedIdentity, invalidCode) => {
  try {
    const handle = await open(filePath, "wx", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(identity, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(filePath, PRIVATE_FILE_MODE);
    return identity;
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
    const racedIdentity = await readRacedIdentity();
    if (!racedIdentity || racedIdentity.hostId !== identity.hostId) {
      throw new Error(invalidCode);
    }
    return racedIdentity;
  }
};

/**
 * Commit a Host identity proposed during negotiation. The local Host calls this
 * only after the Controller validates its hello acknowledgement and sends the
 * first authenticated protocol request.
 * @param {string} dataDir
 * @param {string} hostId
 */
export const acceptHostIdentity = async (dataDir, hostId) => {
  await ensurePrivateDirectory(dataDir);
  const identity = validateHostIdentity({ hostId, createdAt: new Date().toISOString() });
  const existing = await readHostIdentity(dataDir);
  if (existing) {
    if (existing.hostId !== identity.hostId) {
      throw new Error("host_identity_state_invalid");
    }
    return existing;
  }
  return writeIdentityOnce(
    join(dataDir, "host-identity.json"),
    identity,
    () => readHostIdentity(dataDir),
    "host_identity_state_invalid",
  );
};

/** @param {string} dataDir */
export const readControllerHostBinding = async (dataDir) => {
  const value = await readJson(join(dataDir, controllerBindingPath), null);
  return value === null ? null : validateHostIdentity(value);
};

/**
 * Resolve the expected Host identity without accepting new durable state.
 * A new identity remains an in-memory proposal until negotiation succeeds.
 * @param {string} dataDir
 */
export const prepareControllerHostBinding = async (dataDir) => {
  await ensurePrivateDirectory(dataDir);
  const binding = await readControllerHostBinding(dataDir);
  if (binding) {
    return { hostId: binding.hostId, allowHostIdentityCreate: false };
  }
  const hostIdentity = await readHostIdentity(dataDir);
  if (hostIdentity) {
    return { hostId: hostIdentity.hostId, allowHostIdentityCreate: false };
  }
  return {
    hostId: `host-${randomBytes(12).toString("hex")}`,
    allowHostIdentityCreate: true,
  };
};

/**
 * Pin a Host identity only after the full local negotiation has succeeded.
 * @param {string} dataDir
 * @param {string} hostId
 */
export const acceptControllerHostBinding = async (dataDir, hostId) => {
  await ensurePrivateDirectory(dataDir);
  const binding = validateHostIdentity({ hostId, createdAt: new Date().toISOString() });
  const existing = await readControllerHostBinding(dataDir);
  if (existing) {
    if (existing.hostId !== binding.hostId) {
      throw new Error("controller_host_binding_state_invalid");
    }
    return existing;
  }
  return writeIdentityOnce(
    join(dataDir, controllerBindingPath),
    binding,
    () => readControllerHostBinding(dataDir),
    "controller_host_binding_state_invalid",
  );
};
