import { access, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { digest } from "../common/digest.mjs";
import { harnessWorkspaceRoot } from "./state.mjs";
import {
  legacyProjectStateSchema,
  projectStateSchema,
} from "./schemas.mjs";

export const failureGuidance = Object.freeze({
  mutation_contract_invalid: ["retry_with_valid_mutation_contract"],
  idempotency_key_conflict: ["retry_with_original_request_or_new_key"],
  mutation_revision_conflict: ["refresh_project_and_retry"],
  bounded_configuration_invalid: ["revise_bounded_configuration"],
  project_configuration_conflict: ["keep_existing_configuration_or_open_another_project"],
  project_path_invalid: ["select_existing_host_directory"],
  project_path_missing: ["update_registration", "forget_registration"],
  project_path_moved: ["update_registration", "forget_registration", "register_as_new"],
  project_path_replaced: ["replace_registration", "register_as_new", "select_another_path"],
  project_path_conflict: ["resolve_conflicting_registrations"],
  project_path_tombstoned: ["restore_registration", "register_as_new"],
  project_not_found: ["open_registered_project"],
  harness_not_found: ["register_conformance_harness"],
  harness_pin_missing: ["register_project_harness_and_retry"],
  harness_pin_invalid: ["repair_or_reregister_harness_workspace"],
  harness_workspace_invalid: ["repair_or_reregister_harness_workspace"],
  harness_pin_unreadable: ["repair_or_reregister_harness_workspace"],
  harness_adapter_bytes_mismatch: ["restore_pinned_harness_adapter_bytes"],
  harness_compatibility_unsupported: ["repair_or_reregister_harness_workspace"],
  harness_skill_lock_missing: ["restore_pinned_harness_skill_lock"],
  harness_locked_skill_unavailable: ["restore_locked_skill_source"],
  harness_skill_integrity_mismatch: ["restore_locked_skill_source"],
  harness_projection_collision: ["move_conflicting_project_content_and_retry"],
  harness_projection_failed: ["repair_project_projection_and_retry"],
  harness_seed_missing: ["repair_or_reinstall_bundled_harness_seed"],
  harness_seed_provenance_invalid: ["repair_or_reinstall_bundled_harness_seed"],
  harness_dependency_lock_invalid: ["repair_or_reinstall_bundled_harness_seed"],
  harness_skill_lock_invalid: ["repair_or_reinstall_bundled_harness_seed"],
});

/**
 * @param {{
 *   requestId: string,
 *   operation: string,
 *   code: keyof typeof failureGuidance,
 *   authorizationClass?: string | null,
 *   idempotencyKeyHash?: string | null,
 *   expectedRevision?: number | null,
 *   actualRevision: number,
 *   auditId: string,
 *   retryable?: boolean,
 * }} input
 */
export const operationFailure = (input) => ({
  type: "project.operation.failure",
  requestId: input.requestId,
  operation: input.operation,
  code: input.code,
  retryable: input.retryable ?? true,
  authorizationClass: input.authorizationClass ?? null,
  idempotencyKeyHash: input.idempotencyKeyHash ?? null,
  expectedRevision: Number.isSafeInteger(input.expectedRevision)
    ? input.expectedRevision
    : null,
  actualRevision: input.actualRevision,
  auditId: input.auditId,
  resolution: {
    summary: input.code,
    actions: failureGuidance[input.code],
  },
  prohibitedSideEffects: {
    directoryScan: false,
    projectFileWrite: false,
    harnessWorkspaceWrite: false,
    harnessPinWrite: false,
    approvalRequest: false,
  },
});

/** @param {string} path */
const gitMetadataDetected = async (path) => access(join(path, ".git"))
  .then(() => true, () => false);

/** @param {string} parent @param {string} child */
const containsPath = (parent, child) => {
  const pathFromParent = relative(parent, child);
  return pathFromParent === ""
    || (pathFromParent !== ".."
      && !pathFromParent.startsWith(`..${sep}`)
      && !isAbsolute(pathFromParent));
};

/** @param {string} left @param {string} right */
const pathsOverlap = (left, right) => containsPath(left, right) || containsPath(right, left);

/** @param {string} path */
const canonicalManagedPath = async (path) => realpath(path).catch(async () => {
  const resolvedPath = resolve(path);
  const canonicalParent = await realpath(dirname(resolvedPath)).catch(() => dirname(resolvedPath));
  return join(canonicalParent, basename(resolvedPath));
});

/**
 * Resolve only the supplied path. The function never enumerates a parent or
 * sibling directory; stored filesystem evidence is the only cross-registration lookup.
 * @param {z.infer<typeof projectStateSchema> | z.infer<typeof legacyProjectStateSchema>} state
 * @param {unknown} selectedPath
 * @param {string} dataDir
 */
export const resolveProjectLocation = async (state, selectedPath, dataDir) => {
  const rawPath = typeof selectedPath === "string" ? selectedPath : "";
  const normalizedPath = isAbsolute(rawPath) ? resolve(rawPath) : null;
  if (!normalizedPath || rawPath.includes("\0") || rawPath.length > 4_096) {
    return { kind: "failure", code: "project_path_invalid", actualRevision: 0 };
  }

  let canonicalPath;
  let details;
  try {
    canonicalPath = await realpath(normalizedPath);
    details = await stat(canonicalPath);
    if (!details.isDirectory()) {
      return { kind: "failure", code: "project_path_invalid", actualRevision: 0 };
    }
    const hostStateRoot = await canonicalManagedPath(resolve(dataDir));
    const workspaceRoot = await canonicalManagedPath(harnessWorkspaceRoot(dataDir));
    if (
      pathsOverlap(canonicalPath, hostStateRoot)
      || pathsOverlap(canonicalPath, workspaceRoot)
    ) {
      return { kind: "failure", code: "project_path_invalid", actualRevision: 0 };
    }
  } catch {
    const stored = state.projects.filter((project) => project.canonicalPath === normalizedPath);
    if (stored.length > 1) {
      return {
        kind: "failure",
        code: "project_path_conflict",
        actualRevision: Math.max(...stored.map((project) => project.revision)),
      };
    }
    if (stored[0]?.status === "tombstoned") {
      return {
        kind: "failure",
        code: "project_path_tombstoned",
        actualRevision: stored[0].revision,
      };
    }
    if (stored[0]) {
      return {
        kind: "failure",
        code: "project_path_missing",
        actualRevision: stored[0].revision,
      };
    }
    return { kind: "failure", code: "project_path_invalid", actualRevision: 0 };
  }

  const identityDigest = digest(`${details.dev}:${details.ino}:${details.birthtimeMs}`);
  const atPath = state.projects.filter((project) => project.canonicalPath === canonicalPath);
  if (atPath.length > 1) {
    return {
      kind: "failure",
      code: "project_path_conflict",
      actualRevision: Math.max(...atPath.map((project) => project.revision)),
    };
  }
  if (atPath[0]?.status === "tombstoned") {
    return {
      kind: "failure",
      code: "project_path_tombstoned",
      actualRevision: atPath[0].revision,
    };
  }
  if (atPath[0] && atPath[0].filesystemIdentityDigest !== identityDigest) {
    return {
      kind: "failure",
      code: "project_path_replaced",
      actualRevision: atPath[0].revision,
    };
  }
  if (atPath[0]) {
    return { kind: "registered", project: atPath[0], actualRevision: atPath[0].revision };
  }

  const matchingIdentity = state.projects.filter((project) =>
    project.filesystemIdentityDigest === identityDigest && project.status === "active");
  if (matchingIdentity.length > 1) {
    return {
      kind: "failure",
      code: "project_path_conflict",
      actualRevision: Math.max(...matchingIdentity.map((project) => project.revision)),
    };
  }
  if (matchingIdentity[0]) {
    return {
      kind: "failure",
      code: "project_path_moved",
      actualRevision: matchingIdentity[0].revision,
    };
  }
  const gitDetected = await gitMetadataDetected(canonicalPath);
  return {
    kind: "unregistered",
    canonicalPath,
    identityDigest,
    displayName: basename(canonicalPath),
    versionControl: { kind: gitDetected ? "git" : "none", detected: gitDetected },
    actualRevision: 0,
  };
};
