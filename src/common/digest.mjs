import { createHash } from "node:crypto";

/**
 * Produce the prefixed SHA-256 digest used by Sand-King integrity and
 * idempotency contracts.
 * @param {string | NodeJS.ArrayBufferView} value
 */
export const digest = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** @param {string | NodeJS.ArrayBufferView} value */
export const digestHex = (value) => digest(value).slice("sha256:".length);
