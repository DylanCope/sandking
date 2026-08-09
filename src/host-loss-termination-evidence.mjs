import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

const supportedPlatforms = new Set(["linux", "win32", "darwin"]);

/**
 * Reserve the durable evidence directory entry before a detached guardian can
 * outlive the Host. Guardians update this inode in place, so concurrent state
 * teardown can unlink it without racing a newly-created directory entry.
 *
 * @param {string} evidencePath
 */
export const prepareHostLossTerminationEvidence = (evidencePath) => {
  let created = false;
  try {
    writeFileSync(evidencePath, Buffer.alloc(0), { mode: 0o600, flag: "wx" });
    created = true;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error
      && error.code === "EEXIST")) {
      throw error;
    }
    const retained = lstatSync(evidencePath);
    if (!retained.isFile() || retained.isSymbolicLink() || retained.size !== 0) {
      throw new Error("host_loss_termination_evidence_path_invalid");
    }
  }
  if (!created) return;
  const file = openSync(evidencePath, "r");
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  try {
    const directory = openSync(dirname(evidencePath), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch {
    // Windows filesystems do not uniformly expose directory fsync.
  }
};

/**
 * @typedef {{
 *   schemaVersion: 2,
 *   platform: "linux" | "win32" | "darwin",
 *   status: "termination_confirmed" | "termination_unconfirmed",
 *   terminationScope: "complete_process_tree",
 *   launchSettled: boolean,
 *   treeEmpty: boolean,
 *   observedAt: string,
 * } & Record<string, unknown>} HostLossTerminationEvidence
 */

/** @param {unknown} value @returns {HostLossTerminationEvidence | null} */
export const parseHostLossTerminationEvidence = (value) => {
  if (!value || typeof value !== "object") return null;
  const record = /** @type {Record<string, any>} */ (value);
  if (
    record.schemaVersion !== 2
    || !supportedPlatforms.has(record.platform)
    || !["termination_confirmed", "termination_unconfirmed"].includes(record.status)
    || record.terminationScope !== "complete_process_tree"
    || typeof record.launchSettled !== "boolean"
    || typeof record.treeEmpty !== "boolean"
    || Number.isNaN(Date.parse(record.observedAt ?? ""))
    || (record.status === "termination_confirmed"
      && (record.launchSettled !== true || record.treeEmpty !== true))
  ) {
    return null;
  }
  return /** @type {HostLossTerminationEvidence} */ (record);
};

/** @param {string} evidencePath */
export const readHostLossTerminationEvidence = async (evidencePath) => {
  try {
    return parseHostLossTerminationEvidence(
      JSON.parse(await readFile(evidencePath, "utf8")),
    );
  } catch {
    return null;
  }
};

/**
 * Startup waits at this boundary before it classifies an interrupted run. A
 * missing, malformed, pre-v2, or wrong-platform record is never termination
 * proof and therefore times out to recovery-required truth.
 *
 * @param {string} evidencePath
 * @param {{expectedPlatform: "linux" | "win32" | "darwin", timeoutMs?: number, delay?: (milliseconds: number) => Promise<void>}} options
 */
export const waitForHostLossTerminationEvidence = async (evidencePath, options) => {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const delay = options.delay ?? ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  while (Date.now() < deadline) {
    const evidence = await readHostLossTerminationEvidence(evidencePath);
    if (evidence?.platform === options.expectedPlatform) return evidence;
    await delay(25);
  }
  return null;
};
