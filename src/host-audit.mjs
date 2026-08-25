import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { appendPrivateJsonLine } from "./private-state.mjs";

/**
 * Serialize Host-operation audit writes and preserve caller-reserved audit IDs
 * across process restarts without ever retaining request secrets.
 *
 * @param {string} dataDir
 */
export const createHostOperationAuditRecorder = (dataDir) => {
  const auditPath = join(dataDir, "audit.jsonl");
  const recordedAudits = new Map();
  let recordedAuditIdsLoaded = false;
  let auditQueue = Promise.resolve();

  const loadRecordedAuditIds = async () => {
    if (recordedAuditIdsLoaded) return;
    const source = await readFile(auditPath, "utf8").catch((error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return "";
      }
      throw error;
    });
    for (const line of source.split("\n")) {
      if (!line) continue;
      try {
        const audit = JSON.parse(line);
        if (typeof audit?.auditId === "string") recordedAudits.set(audit.auditId, audit);
      } catch {
        // A malformed historical line is not a match for a reserved audit ID.
      }
    }
    recordedAuditIdsLoaded = true;
  };

  /**
   * @param {string} action
   * @param {"accepted" | "rejected" | "observed"} outcome
   * @param {Record<string, unknown>} details
   * @param {string} [auditId]
   */
  return (action, outcome, details = {}, auditId) => {
    const operation = auditQueue.catch(() => undefined).then(async () => {
      if (auditId) {
        await loadRecordedAuditIds();
        const existing = recordedAudits.get(auditId);
        if (existing) {
          if (!isDeepStrictEqual({
            action: existing.action,
            outcome: existing.outcome,
            details: existing.details,
          }, { action, outcome, details })) {
            throw new Error("audit_id_conflict");
          }
          return auditId;
        }
      }
      const resolvedAuditId = auditId ?? `audit-${randomBytes(12).toString("hex")}`;
      await appendPrivateJsonLine(auditPath, {
        auditId: resolvedAuditId,
        action,
        outcome,
        details,
        recordedAt: new Date().toISOString(),
      });
      recordedAudits.set(resolvedAuditId, {
        auditId: resolvedAuditId,
        action,
        outcome,
        details,
      });
      return resolvedAuditId;
    });
    auditQueue = operation.then(() => undefined, () => undefined);
    return operation;
  };
};
