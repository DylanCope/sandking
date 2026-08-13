import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { canonicalJson } from "./common/canonical-json.mjs";
import { digest } from "./common/digest.mjs";
import { identifierSchemas } from "./common/identifiers.mjs";
import {
  conformanceHarnessLaunchParametersDeclaration as conformanceLaunchParameters,
  harnessAdapterProbeSchema,
  harnessLaunchParametersDeclarationSchema,
  invokePinnedHarnessAdapter,
  legacyConformanceHarnessLaunchParametersDeclaration as legacyConformanceLaunchParameters,
  loadPinnedHarnessAdapter,
  sandcastleHarnessLaunchParametersDeclaration as sandcastleLaunchParameters,
} from "./harness-adapter-protocol.mjs";
import {
  CONFORMANCE_HARNESS_ADAPTER_ID,
  SANDCASTLE_HARNESS_ADAPTER_ID,
  harnessAdapterIdSchema,
} from "./harness-adapter-identity.mjs";
import { readJson, writePrivateJson } from "./private-state.mjs";
import {
  ProductionHarnessSeedError,
  initializeProductionHarnessWorkspace,
} from "./production-harness-seed.mjs";
import {
  ProductionHarnessPreparationError,
  prepareProductionHarness,
  productionHarnessPreparationSchema,
} from "./production-harness-preparation.mjs";

const execFileAsync = promisify(execFile);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const { auditIdSchema, projectIdSchema, harnessIdSchema } = identifierSchemas(z);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const pathSchema = z.string().min(1).max(4_096).refine((value) => !value.includes("\0"));
const commandSchema = z.string().min(1).max(256)
  .refine((value) => !/[\r\n\0]/.test(value));
const checkIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/);
const conformanceAdapterEntryPoint = "adapters/conformance.mjs";
const conformanceAdapterSourcePath = new URL(
  "./conformance-harness-adapter/conformance.mjs",
  import.meta.url,
);

export const projectConfigurationSchema = z.object({
  issueWorkflow: z.object({
    provider: z.literal("github"),
    kind: z.literal("issues"),
  }).strict(),
  checks: z.array(z.object({
    checkId: checkIdSchema,
    command: commandSchema,
  }).strict()).min(1).max(8),
}).strict().superRefine((configuration, context) => {
  if (new Set(configuration.checks.map((check) => check.checkId)).size
      !== configuration.checks.length) {
    context.addIssue({ code: "custom", message: "check identifiers must be unique" });
  }
});

export const boundedHarnessConfigurationSchema = z.object({
  adapterProtocol: z.literal("1.0.0"),
  launchProfile: z.literal("delegated-work"),
}).strict();

export const projectReadinessSchema = z.object({
  issueWorkflow: z.literal("ready"),
  checks: z.literal("ready"),
  configuration: z.literal("ready"),
  harness: z.enum(["missing", "ready"]),
  pin: z.enum(["missing", "ready"]),
  launchRequest: z.enum(["blocked", "ready"]),
  diagnostics: z.array(z.enum([
    "harness_not_registered",
    "harness_pin_missing",
  ])).max(2),
}).strict();

const projectHarnessLinkBaseShape = {
  harnessId: harnessIdSchema,
  name: z.string().min(1).max(120),
  pinnedRevision: commitSchema,
  boundedConfiguration: boundedHarnessConfigurationSchema,
};
const projectHarnessLinkSchema = z.discriminatedUnion("adapterId", [
  z.object({
    ...projectHarnessLinkBaseShape,
    adapterId: z.literal(CONFORMANCE_HARNESS_ADAPTER_ID),
  }).strict(),
  z.object({
    ...projectHarnessLinkBaseShape,
    adapterId: z.literal(SANDCASTLE_HARNESS_ADAPTER_ID),
    preparation: productionHarnessPreparationSchema,
  }).strict(),
]);
const retainedProjectHarnessLinkSchema = z.discriminatedUnion("adapterId", [
  z.object({
    ...projectHarnessLinkBaseShape,
    adapterId: z.literal(CONFORMANCE_HARNESS_ADAPTER_ID),
  }).strict(),
  z.object({
    ...projectHarnessLinkBaseShape,
    adapterId: z.literal(SANDCASTLE_HARNESS_ADAPTER_ID),
    // Schema-v1 production links predate retained preparation metadata.
    preparation: productionHarnessPreparationSchema.optional(),
  }).strict(),
]);

const projectRegistrationBaseShape = {
  projectId: projectIdSchema,
  revision: z.number().int().positive(),
  displayName: z.string().min(1).max(255),
  canonicalPath: pathSchema,
  status: z.enum(["active", "tombstoned"]),
  versionControl: z.object({
    kind: z.enum(["git", "none"]),
    detected: z.boolean(),
  }).strict(),
  configuration: projectConfigurationSchema,
  readiness: projectReadinessSchema,
};

/** @param {any} project @param {z.RefinementCtx} context */
const preparationMatchesProjectPin = (project, context) => {
  if (
    project.harness?.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID
    && project.harness.preparation
    && (
      project.harness.preparation.harness.harnessId !== project.harness.harnessId
      || project.harness.preparation.harness.adapterId !== project.harness.adapterId
      || project.harness.preparation.harness.pinnedRevision !== project.harness.pinnedRevision
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "production Harness preparation does not match its Project pin",
      path: ["harness", "preparation"],
    });
  }
};

export const projectRegistrationSchema = z.object({
  ...projectRegistrationBaseShape,
  harness: projectHarnessLinkSchema.nullable(),
}).strict().superRefine(preparationMatchesProjectPin);
const retainedProjectRegistrationSchema = z.object({
  ...projectRegistrationBaseShape,
  harness: retainedProjectHarnessLinkSchema.nullable(),
}).strict().superRefine(preparationMatchesProjectPin);

const harnessRegistrationBaseShape = {
  harnessId: harnessIdSchema,
  revision: z.number().int().positive(),
  name: z.string().min(1).max(120),
  immutableRevision: commitSchema,
  workspace: z.object({
    kind: z.literal("harness-workspace"),
    versionControl: z.literal("git"),
    independent: z.literal(true),
    headRevision: commitSchema,
  }).strict(),
};
const conformanceHarnessRegistrationSchema = z.object({
  ...harnessRegistrationBaseShape,
  adapterId: z.literal(CONFORMANCE_HARNESS_ADAPTER_ID),
  kind: z.literal("conformance"),
  // Schema-v1 conformance registrations predate adapter-declared parameters.
  // Their immutable adapter bytes still require this known historical shape;
  // fresh registrations retain the explicit value observed from the pinned probe.
  launchParameters: harnessLaunchParametersDeclarationSchema
    .default(legacyConformanceLaunchParameters),
}).strict();
const sandcastleHarnessRegistrationSchema = z.object({
  ...harnessRegistrationBaseShape,
  adapterId: z.literal(SANDCASTLE_HARNESS_ADAPTER_ID),
  kind: z.literal("production"),
  // Production registrations have no conformance-era representation to
  // inherit. Their pinned probe must declare the exact parameter contract.
  launchParameters: harnessLaunchParametersDeclarationSchema,
}).strict();
export const harnessRegistrationSchema = z.discriminatedUnion("adapterId", [
  conformanceHarnessRegistrationSchema,
  sandcastleHarnessRegistrationSchema,
]);

/**
 * @param {z.infer<typeof projectHarnessLinkSchema>} projectHarness
 * @param {z.infer<typeof harnessRegistrationSchema>} harness
 */
export const projectHarnessAdapterIdentityAgrees = (projectHarness, harness) =>
  projectHarness.harnessId === harness.harnessId
  && projectHarness.adapterId === harness.adapterId;

const storedProjectFields = {
  filesystemIdentityDigest: digestSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
};
const storedProjectSchema = projectRegistrationSchema.extend(storedProjectFields);
const legacyStoredProjectSchema = retainedProjectRegistrationSchema.extend(storedProjectFields);
const storedHarnessFields = {
  workspacePath: pathSchema,
  createdAt: z.string().datetime(),
};
const storedHarnessSchema = z.discriminatedUnion("adapterId", [
  conformanceHarnessRegistrationSchema.extend(storedHarnessFields),
  sandcastleHarnessRegistrationSchema.extend(storedHarnessFields),
]);
const outcomeSchema = z.object({
  idempotencyKeyHash: digestSchema,
  requestFingerprint: digestSchema,
  response: z.object({}).passthrough(),
}).strict();
const projectStateSchema = z.object({
  schemaVersion: z.literal(2),
  projects: z.array(storedProjectSchema).max(256),
  registrationOutcomes: z.array(outcomeSchema).max(256),
  pinOutcomes: z.array(outcomeSchema).max(256),
}).strict();
const legacyProjectStateSchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.array(legacyStoredProjectSchema).max(256),
  registrationOutcomes: z.array(outcomeSchema).max(256),
  pinOutcomes: z.array(outcomeSchema).max(256),
}).strict();
const harnessStateSchema = z.object({
  schemaVersion: z.literal(1),
  harnesses: z.array(storedHarnessSchema).max(32),
  registrationOutcomes: z.array(outcomeSchema).max(256),
}).strict();

export const projectPreparationProjectionSchema = z.object({
  kind: z.literal("cockpit.project-preparation"),
  selection: z.object({
    mode: z.literal("explicit-host-path"),
    directoryScanning: z.literal(false),
  }).strict(),
  conformanceHarness: z.object({
    name: z.literal("Sand-King Conformance Harness"),
    adapterId: z.literal(CONFORMANCE_HARNESS_ADAPTER_ID),
    permittedTestDouble: z.literal(true),
    launchParameters: harnessLaunchParametersDeclarationSchema,
  }).strict(),
  productionHarness: z.object({
    name: z.literal("Sand-King Sandcastle Harness"),
    adapterId: z.literal(SANDCASTLE_HARNESS_ADAPTER_ID),
    permittedTestDouble: z.literal(false),
    launchParameters: harnessLaunchParametersDeclarationSchema,
  }).strict(),
  defaultHarnessAdapterId: z.literal(SANDCASTLE_HARNESS_ADAPTER_ID),
  current: z.object({
    projectId: projectIdSchema,
    displayName: z.string().min(1).max(255),
    revision: z.number().int().positive(),
    issueWorkflow: z.object({
      provider: z.literal("github"),
      kind: z.literal("issues"),
      readiness: z.literal("ready"),
    }).strict(),
    checks: z.array(z.object({
      checkId: checkIdSchema,
      readiness: z.literal("ready"),
    }).strict()).min(1).max(8),
    harness: z.discriminatedUnion("adapterId", [
      z.object({
        harnessId: harnessIdSchema,
        name: z.string().min(1).max(120),
        adapterId: z.literal(CONFORMANCE_HARNESS_ADAPTER_ID),
        pinnedRevision: commitSchema,
        launchParameters: harnessLaunchParametersDeclarationSchema,
      }).strict(),
      z.object({
        harnessId: harnessIdSchema,
        name: z.string().min(1).max(120),
        adapterId: z.literal(SANDCASTLE_HARNESS_ADAPTER_ID),
        pinnedRevision: commitSchema,
        launchParameters: harnessLaunchParametersDeclarationSchema,
        preparation: productionHarnessPreparationSchema,
      }).strict(),
    ]).nullable(),
    readiness: projectReadinessSchema,
    canPrepareLaunchRequest: z.boolean(),
  }).strict().nullable(),
  excludedCapabilities: z.tuple([
    z.literal("production-harness-lifecycle"),
    z.literal("harness-import-update-rollback-switching"),
    z.literal("drift-recovery"),
  ]),
}).strict();

const initialProjectState = () => ({
  schemaVersion: 2,
  projects: [],
  registrationOutcomes: [],
  pinOutcomes: [],
});
const initialHarnessState = () => ({
  schemaVersion: 1,
  harnesses: [],
  registrationOutcomes: [],
});

/** @param {any} project */
const publicProject = (project) => {
  const { filesystemIdentityDigest, createdAt, updatedAt, ...publicFields } = project;
  void filesystemIdentityDigest;
  void createdAt;
  void updatedAt;
  return projectRegistrationSchema.parse(publicFields);
};
/** @param {any} harness */
const publicHarness = (harness) => {
  const { workspacePath, createdAt, ...publicFields } = harness;
  void workspacePath;
  void createdAt;
  return harnessRegistrationSchema.parse(publicFields);
};

/** @param {unknown} value */
const fingerprint = (value) => digest(canonicalJson(value));
/** @param {string} key */
const idempotencyHash = (key) => digest(key);

/**
 * @param {{projectId: unknown, harnessId: unknown, boundedConfiguration: unknown, authorizationClass: unknown, expectedRevision: unknown}} request
 * @param {unknown} immutableRevision
 */
const pinRequestFingerprint = (request, immutableRevision) => fingerprint({
  projectId: request.projectId,
  harnessId: request.harnessId,
  immutableRevision,
  boundedConfiguration: request.boundedConfiguration,
  authorizationClass: request.authorizationClass,
  expectedRevision: request.expectedRevision,
});

/** @param {string} dataDir */
const projectStatePath = (dataDir) => join(dataDir, "project-registrations.json");
/** @param {string} dataDir */
const harnessStatePath = (dataDir) => join(dataDir, "harness-registry.json");
/** @param {string} dataDir */
const harnessWorkspaceRoot = (dataDir) => {
  const stateRoot = resolve(dataDir);
  return join(dirname(stateRoot), `${basename(stateRoot)}-harness-workspaces`);
};

/** @param {string} dataDir */
const readProjectState = async (dataDir) => {
  const retained = await readJson(projectStatePath(dataDir), initialProjectState());
  const parsed = z.union([projectStateSchema, legacyProjectStateSchema]).safeParse(retained);
  if (!parsed.success) {
    throw new Error("project_registration_state_invalid");
  }
  return parsed.data;
};
/**
 * Promote retained state only when every production Project satisfies the
 * schema-v2 preparation invariant. Unrelated writes keep partial migrations
 * in their truthful schema-v1 envelope.
 * @param {string} dataDir
 * @param {z.infer<typeof projectStateSchema> | z.infer<typeof legacyProjectStateSchema>} state
 */
const writeProjectState = async (dataDir, state) => {
  const current = projectStateSchema.safeParse({ ...state, schemaVersion: 2 });
  if (current.success) {
    await writePrivateJson(projectStatePath(dataDir), current.data);
    return;
  }
  const legacy = legacyProjectStateSchema.safeParse({ ...state, schemaVersion: 1 });
  if (!legacy.success) {
    throw new Error("project_registration_state_invalid");
  }
  await writePrivateJson(projectStatePath(dataDir), legacy.data);
};
/** @param {string} dataDir */
const readHarnessState = async (dataDir) => {
  const parsed = harnessStateSchema.safeParse(
    await readJson(harnessStatePath(dataDir), initialHarnessState()),
  );
  if (!parsed.success) {
    throw new Error("harness_registry_state_invalid");
  }
  return parsed.data;
};

/**
 * Add schema-v2 preparation metadata only to retained success envelopes for
 * the same production pin. Historical registration and pin responses keep
 * their accepted Project snapshots and request fingerprints.
 * @param {z.infer<typeof projectStateSchema> | z.infer<typeof legacyProjectStateSchema>} state
 * @param {z.infer<typeof legacyStoredProjectSchema>} project
 */
const refreshRetainedProjectReferences = (state, project) => {
  if (
    project.harness?.adapterId !== SANDCASTLE_HARNESS_ADAPTER_ID
    || !project.harness.preparation
  ) {
    return;
  }
  for (const outcome of [...state.registrationOutcomes, ...state.pinOutcomes]) {
    const response = /** @type {any} */ (outcome.response);
    const retainedProject = response.project;
    const retainedHarness = retainedProject?.harness;
    if (
      retainedProject
      && typeof retainedProject === "object"
      && retainedProject.projectId === project.projectId
      && retainedHarness
      && typeof retainedHarness === "object"
      && retainedHarness.harnessId === project.harness.harnessId
      && retainedHarness.adapterId === project.harness.adapterId
      && retainedHarness.pinnedRevision === project.harness.pinnedRevision
    ) {
      retainedProject.harness = {
        ...retainedHarness,
        preparation: structuredClone(project.harness.preparation),
      };
    }
  }
};

const readinessWithoutHarness = () => projectReadinessSchema.parse({
  issueWorkflow: "ready",
  checks: "ready",
  configuration: "ready",
  harness: "missing",
  pin: "missing",
  launchRequest: "blocked",
  diagnostics: ["harness_not_registered", "harness_pin_missing"],
});
const readinessWithHarness = () => projectReadinessSchema.parse({
  issueWorkflow: "ready",
  checks: "ready",
  configuration: "ready",
  harness: "ready",
  pin: "ready",
  launchRequest: "ready",
  diagnostics: [],
});

const failureGuidance = Object.freeze({
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
const operationFailure = (input) => ({
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
const resolveProjectLocation = async (state, selectedPath, dataDir) => {
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

/** @param {string} workspacePath */
const initializeConformanceWorkspace = async (workspacePath) => {
  await mkdir(workspacePath, { recursive: true, mode: 0o700 });
  const hasRepository = await access(join(workspacePath, ".git"))
    .then(() => true, () => false);
  if (!hasRepository) {
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", workspacePath]);
    await writeFile(join(workspacePath, "harness.json"), `${JSON.stringify({
      schemaVersion: 1,
      name: "Sand-King Conformance Harness",
      compatibility: {
        adapterId: CONFORMANCE_HARNESS_ADAPTER_ID,
        adapterProtocol: "1.0.0",
        entryPoint: conformanceAdapterEntryPoint,
      },
    }, null, 2)}\n`, { mode: 0o600 });
    await mkdir(join(workspacePath, "adapters"), { mode: 0o700 });
    const adapterSource = await readFile(conformanceAdapterSourcePath);
    await writeFile(
      join(workspacePath, conformanceAdapterEntryPoint),
      adapterSource,
      { mode: 0o700 },
    );
    await execFileAsync("git", [
      "-C", workspacePath,
      "add", "--", "harness.json", conformanceAdapterEntryPoint,
    ]);
    await execFileAsync("git", [
      "-C", workspacePath,
      "-c", "user.name=Sand-King Conformance",
      "-c", "user.email=conformance@sandking.invalid",
      "-c", "commit.gpgSign=false",
      "commit", "--quiet", "-m", "Initialize conformance Harness",
    ], {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      },
    });
  }
  const { stdout } = await execFileAsync("git", ["-C", workspacePath, "rev-parse", "HEAD"]);
  const revision = stdout.trim();
  if (!commitSchema.safeParse(revision).success) {
    throw new Error("harness_workspace_invalid");
  }
  return revision;
};

/**
 * @param {z.infer<typeof projectRegistrationSchema> | null} project
 * @param {z.infer<typeof harnessRegistrationSchema> | null} harness
 */
export const projectPreparationProjection = (project = null, harness = null) => {
  if (
    project?.harness
    && harness
    && !projectHarnessAdapterIdentityAgrees(project.harness, harness)
  ) {
    throw new Error("Project and Harness adapter identities disagree");
  }
  if (project?.harness?.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID && !harness) {
    throw new Error("Project and Harness adapter identities disagree");
  }
  return projectPreparationProjectionSchema.parse({
    kind: "cockpit.project-preparation",
    selection: { mode: "explicit-host-path", directoryScanning: false },
    conformanceHarness: {
      name: "Sand-King Conformance Harness",
      adapterId: CONFORMANCE_HARNESS_ADAPTER_ID,
      permittedTestDouble: true,
      launchParameters: conformanceLaunchParameters,
    },
    productionHarness: {
      name: "Sand-King Sandcastle Harness",
      adapterId: SANDCASTLE_HARNESS_ADAPTER_ID,
      permittedTestDouble: false,
      launchParameters: sandcastleLaunchParameters,
    },
    defaultHarnessAdapterId: SANDCASTLE_HARNESS_ADAPTER_ID,
    current: project ? {
      projectId: project.projectId,
      displayName: project.displayName,
      revision: project.revision,
      issueWorkflow: {
        ...project.configuration.issueWorkflow,
        readiness: project.readiness.issueWorkflow,
      },
      checks: project.configuration.checks.map((check) => ({
        checkId: check.checkId,
        readiness: project.readiness.checks,
      })),
      harness: project.harness ? {
        harnessId: project.harness.harnessId,
        name: project.harness.name,
        adapterId: project.harness.adapterId,
        pinnedRevision: project.harness.pinnedRevision,
        launchParameters: harness?.launchParameters ?? conformanceLaunchParameters,
        ...(project.harness.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID
          ? { preparation: project.harness.preparation }
          : {}),
      } : null,
      readiness: project.readiness,
      canPrepareLaunchRequest: project.readiness.launchRequest === "ready",
    } : null,
    excludedCapabilities: [
      "production-harness-lifecycle",
      "harness-import-update-rollback-switching",
      "drift-recovery",
    ],
  });
};

/**
 * @param {{
 *   dataDir: string,
 *   recordAudit: (action: string, outcome: "accepted" | "rejected" | "observed", details?: Record<string, unknown>, auditId?: string) => Promise<string>,
 *   productionSeedRoot?: string,
 * }} options
 */
export const createProjectRegistry = async (options) => {
  let mutationQueue = Promise.resolve();
  /** @template T @param {() => Promise<T>} operation */
  const withMutationLock = (operation) => {
    const current = mutationQueue.catch(() => undefined).then(operation);
    mutationQueue = current.then(() => undefined, () => undefined);
    return current;
  };

  /** @param {unknown} error */
  const preparationFailureCode = (error) => {
    if (error instanceof ProductionHarnessPreparationError) return error.code;
    if (error instanceof Error && error.message in failureGuidance) return error.message;
    return "harness_projection_failed";
  };

  /**
   * Re-resolve a retained Project before any operation can prepare or pin it.
   * The canonical path is only a lookup key; the retained filesystem identity
   * remains the authority for whether that path is still the same Project.
   * @param {z.infer<typeof projectStateSchema> | z.infer<typeof legacyProjectStateSchema>} projectState
   * @param {z.infer<typeof legacyStoredProjectSchema>} project
   */
  const requireRegisteredProjectLocation = async (projectState, project) => {
    const location = await resolveProjectLocation(
      projectState,
      project.canonicalPath,
      options.dataDir,
    );
    if (location.kind === "failure") throw new Error(location.code);
    if (
      location.kind !== "registered"
      || !location.project
      || location.project.projectId !== project.projectId
    ) {
      throw new Error("project_path_conflict");
    }
    return location;
  };

  /**
   * Lazily upgrade only the selected schema-v1 production Project. A broken
   * retained registration therefore cannot make unrelated registrations
   * unavailable, while every public success still carries verified readiness.
   * @param {z.infer<typeof projectStateSchema> | z.infer<typeof legacyProjectStateSchema>} projectState
   * @param {z.infer<typeof harnessStateSchema>} harnessState
   * @param {z.infer<typeof legacyStoredProjectSchema>} project
   */
  const prepareRetainedProductionProject = async (projectState, harnessState, project) => {
    if (project.harness?.adapterId !== SANDCASTLE_HARNESS_ADAPTER_ID) {
      return project;
    }
    await requireRegisteredProjectLocation(projectState, project);
    const harness = harnessState.harnesses.find((candidate) =>
      candidate.harnessId === project.harness?.harnessId);
    if (!harness) throw new Error("harness_not_found");
    if (
      harness.adapterId !== SANDCASTLE_HARNESS_ADAPTER_ID
      || harness.immutableRevision !== project.harness.pinnedRevision
    ) {
      throw new Error("harness_pin_invalid");
    }
    const preparation = await prepareProductionHarness({
      projectPath: project.canonicalPath,
      harnessId: harness.harnessId,
      workspacePath: harness.workspacePath,
      pinnedRevision: harness.immutableRevision,
    });
    if (project.harness.preparation) {
      if (JSON.stringify(project.harness.preparation) !== JSON.stringify(preparation)) {
        throw new Error("harness_pin_invalid");
      }
      return project;
    }
    project.harness = {
      ...project.harness,
      preparation: productionHarnessPreparationSchema.parse(preparation),
    };
    refreshRetainedProjectReferences(projectState, project);
    await writeProjectState(options.dataDir, projectState);
    return project;
  };

  /** @param {{requestId: string, path: string}} request */
  const inspectProject = (request) => withMutationLock(async () => {
    const state = await readProjectState(options.dataDir);
    const location = await resolveProjectLocation(state, request.path, options.dataDir);
    if (location.kind === "failure") {
      const auditId = await options.recordAudit("project.inspect", "rejected", {
        code: location.code,
        selectedPathHash: digest(typeof request.path === "string" ? request.path : ""),
        actualRevision: location.actualRevision,
        directoryScanPerformed: false,
      });
      return operationFailure({
        requestId: request.requestId,
        operation: "project.inspect",
        code: /** @type {keyof typeof failureGuidance} */ (location.code),
        actualRevision: location.actualRevision,
        auditId,
      });
    }
    if (
      location.kind === "registered"
      && location.project?.harness?.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID
    ) {
      try {
        await prepareRetainedProductionProject(
          state,
          await readHarnessState(options.dataDir),
          location.project,
        );
      } catch (error) {
        const code = preparationFailureCode(error);
        const auditId = await options.recordAudit("project.inspect", "rejected", {
          code,
          actualRevision: location.actualRevision,
          projectId: location.project.projectId,
          harnessId: location.project.harness.harnessId,
          directoryScanPerformed: false,
          projectFileWrite: false,
          pinWrite: false,
          harnessRunCreated: false,
          adapterStarted: false,
        });
        return operationFailure({
          requestId: request.requestId,
          operation: "project.inspect",
          code: /** @type {keyof typeof failureGuidance} */ (code),
          actualRevision: location.actualRevision,
          auditId,
        });
      }
    }
    return {
      type: "project.inspect.result",
      requestId: request.requestId,
      code: location.kind === "registered" ? "project_registered" : "project_unregistered",
      actualRevision: location.actualRevision,
      project: location.kind === "registered"
        ? publicProject(location.project)
        : null,
    };
  });

  /** @param {{requestId: string, path: string, configuration: unknown, authorizationClass: string, idempotencyKey: string, expectedRevision: number}} request */
  const registerProject = (request) => withMutationLock(async () => {
    const action = "project.register";
    const authorizationClass = "host_local_project_registration";
    const state = await readProjectState(options.dataDir);
    const keyValid = typeof request.idempotencyKey === "string"
      && request.idempotencyKey.length > 0
      && request.idempotencyKey.length <= 256;
    const keyHash = keyValid ? idempotencyHash(request.idempotencyKey) : null;
    const requestFingerprint = fingerprint({
      path: request.path,
      configuration: request.configuration,
      authorizationClass: request.authorizationClass,
      expectedRevision: request.expectedRevision,
    });
    /** @param {unknown} error @param {z.infer<typeof legacyStoredProjectSchema>} project */
    const rejectPreparation = async (error, project) => {
      const code = preparationFailureCode(error);
      const auditId = await options.recordAudit(action, "rejected", {
        code,
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: project.revision,
        projectId: project.projectId,
        harnessId: project.harness?.harnessId ?? null,
        directoryScanPerformed: false,
        projectFileWrite: false,
        pinWrite: false,
        harnessRunCreated: false,
        adapterStarted: false,
      });
      return operationFailure({
        requestId: request.requestId,
        operation: action,
        code: /** @type {keyof typeof failureGuidance} */ (code),
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: project.revision,
        auditId,
      });
    };
    const existing = keyHash
      ? state.registrationOutcomes.find((outcome) => outcome.idempotencyKeyHash === keyHash)
      : null;
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        const auditId = await options.recordAudit(action, "rejected", {
          code: "idempotency_key_conflict",
          authorizationClass,
          idempotencyKeyHash: keyHash,
          expectedRevision: Number.isSafeInteger(request.expectedRevision)
            ? request.expectedRevision
            : null,
          actualRevision: Number(existing.response.revision ?? 0),
          directoryScanPerformed: false,
          projectFileWrite: false,
        });
        return operationFailure({
          requestId: request.requestId,
          operation: action,
          code: "idempotency_key_conflict",
          authorizationClass,
          idempotencyKeyHash: keyHash,
          expectedRevision: request.expectedRevision,
          actualRevision: Number(existing.response.revision ?? 0),
          auditId,
          retryable: false,
        });
      }
      const existingResponse = /** @type {any} */ (existing.response);
      const retainedProjectId = existingResponse.project?.projectId;
      const retainedProject = typeof retainedProjectId === "string"
        ? state.projects.find((project) => project.projectId === retainedProjectId)
        : null;
      if (retainedProject?.harness?.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID) {
        try {
          await prepareRetainedProductionProject(
            state,
            await readHarnessState(options.dataDir),
            retainedProject,
          );
        } catch (error) {
          return rejectPreparation(error, retainedProject);
        }
        await writeProjectState(options.dataDir, state);
      }
      await options.recordAudit(action, "observed", {
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        idempotentReplay: true,
        originalAuditId: existing.response.auditId,
        directoryScanPerformed: false,
        projectFileWrite: false,
      });
      return {
        ...structuredClone(existing.response),
        requestId: request.requestId,
        idempotentReplay: true,
      };
    }

    const configuration = projectConfigurationSchema.safeParse(request.configuration);
    if (
      request.authorizationClass !== authorizationClass
      || !keyHash
      || !Number.isSafeInteger(request.expectedRevision)
      || request.expectedRevision < 0
      || !configuration.success
    ) {
      const code = configuration.success
        ? "mutation_contract_invalid"
        : "bounded_configuration_invalid";
      const auditId = await options.recordAudit(action, "rejected", {
        code,
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: Number.isSafeInteger(request.expectedRevision)
          ? request.expectedRevision
          : null,
        actualRevision: 0,
        selectedPathHash: digest(typeof request.path === "string" ? request.path : ""),
        directoryScanPerformed: false,
        projectFileWrite: false,
      });
      return operationFailure({
        requestId: request.requestId,
        operation: action,
        code,
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: 0,
        auditId,
        retryable: false,
      });
    }

    const location = await resolveProjectLocation(state, request.path, options.dataDir);
    if (location.kind === "failure") {
      const auditId = await options.recordAudit(action, "rejected", {
        code: location.code,
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: location.actualRevision,
        selectedPathHash: digest(request.path),
        directoryScanPerformed: false,
        projectFileWrite: false,
      });
      return operationFailure({
        requestId: request.requestId,
        operation: action,
        code: /** @type {keyof typeof failureGuidance} */ (location.code),
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: location.actualRevision,
        auditId,
      });
    }

    if (request.expectedRevision !== location.actualRevision) {
      const auditId = await options.recordAudit(action, "rejected", {
        code: "mutation_revision_conflict",
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: location.actualRevision,
        directoryScanPerformed: false,
        projectFileWrite: false,
      });
      return operationFailure({
        requestId: request.requestId,
        operation: action,
        code: "mutation_revision_conflict",
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: location.actualRevision,
        auditId,
      });
    }

    if (location.kind === "registered" && location.project) {
      if (JSON.stringify(location.project.configuration) !== JSON.stringify(configuration.data)) {
        const auditId = await options.recordAudit(action, "rejected", {
          code: "project_configuration_conflict",
          authorizationClass,
          idempotencyKeyHash: keyHash,
          expectedRevision: request.expectedRevision,
          actualRevision: location.actualRevision,
          projectId: location.project.projectId,
          directoryScanPerformed: false,
          projectFileWrite: false,
        });
        return operationFailure({
          requestId: request.requestId,
          operation: action,
          code: "project_configuration_conflict",
          authorizationClass,
          idempotencyKeyHash: keyHash,
          expectedRevision: request.expectedRevision,
          actualRevision: location.actualRevision,
          auditId,
          retryable: false,
        });
      }
      if (location.project.harness?.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID) {
        try {
          await prepareRetainedProductionProject(
            state,
            await readHarnessState(options.dataDir),
            location.project,
          );
        } catch (error) {
          return rejectPreparation(error, location.project);
        }
      }
      const auditId = await options.recordAudit(action, "observed", {
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision: location.actualRevision,
        resultingRevision: location.actualRevision,
        projectId: location.project.projectId,
        registrationReused: true,
        directoryScanPerformed: false,
        projectFileWrite: false,
      });
      const response = {
        type: "project.register.result",
        requestId: request.requestId,
        code: "project_registration_reused",
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        revision: location.actualRevision,
        idempotentReplay: false,
        auditId,
        project: publicProject(location.project),
      };
      state.registrationOutcomes.push({
        idempotencyKeyHash: keyHash,
        requestFingerprint,
        response,
      });
      state.registrationOutcomes = state.registrationOutcomes.slice(-256);
      await writeProjectState(options.dataDir, state);
      return response;
    }

    const now = new Date().toISOString();
    const project = storedProjectSchema.parse({
      projectId: `project-${randomBytes(12).toString("hex")}`,
      revision: 1,
      displayName: location.displayName,
      canonicalPath: location.canonicalPath,
      filesystemIdentityDigest: location.identityDigest,
      status: "active",
      versionControl: location.versionControl,
      configuration: configuration.data,
      harness: null,
      readiness: readinessWithoutHarness(),
      createdAt: now,
      updatedAt: now,
    });
    const auditId = await options.recordAudit(action, "accepted", {
      authorizationClass,
      idempotencyKeyHash: keyHash,
      expectedRevision: request.expectedRevision,
      actualRevision: 0,
      resultingRevision: 1,
      projectId: project.projectId,
      versionControlDetected: project.versionControl.detected,
      issueWorkflowReady: true,
      checkCount: project.configuration.checks.length,
      directoryScanPerformed: false,
      projectFileWrite: false,
      separateApprovalRequired: false,
    });
    const response = {
      type: "project.register.result",
      requestId: request.requestId,
      code: "project_registered",
      authorizationClass,
      idempotencyKeyHash: keyHash,
      expectedRevision: request.expectedRevision,
      revision: 1,
      idempotentReplay: false,
      auditId,
      project: publicProject(project),
    };
    state.projects.push(project);
    state.registrationOutcomes.push({
      idempotencyKeyHash: keyHash,
      requestFingerprint,
      response,
    });
    state.registrationOutcomes = state.registrationOutcomes.slice(-256);
    await writeProjectState(options.dataDir, state);
    return response;
  });

  /** @param {z.infer<typeof harnessAdapterIdSchema>} adapterId */
  const readRegisteredHarness = async (adapterId) => {
    const state = await readHarnessState(options.dataDir);
    return state.harnesses.find((candidate) => candidate.adapterId === adapterId) ?? null;
  };

  /** @param {{requestId: string}} request */
  const inspectConformanceHarness = async (request) => {
    const harness = await readRegisteredHarness(CONFORMANCE_HARNESS_ADAPTER_ID);
    return {
      type: "harness.conformance.inspect.result",
      requestId: request.requestId,
      code: harness ? "conformance_harness_registered" : "conformance_harness_unregistered",
      actualRevision: harness?.revision ?? 0,
      harness: harness ? publicHarness(harness) : null,
    };
  };

  /** @param {{requestId: string}} request */
  const inspectSandcastleHarness = async (request) => {
    const harness = await readRegisteredHarness(SANDCASTLE_HARNESS_ADAPTER_ID);
    return {
      type: "harness.sandcastle.inspect.result",
      requestId: request.requestId,
      code: harness ? "sandcastle_harness_registered" : "sandcastle_harness_unregistered",
      actualRevision: harness?.revision ?? 0,
      harness: harness ? publicHarness(harness) : null,
    };
  };

  /**
   * @param {{requestId: string, name: string, authorizationClass: string, idempotencyKey: string, expectedRevision: number}} request
   * @param {{
   *   action: "harness.conformance.register" | "harness.sandcastle.register",
   *   adapterId: z.infer<typeof harnessAdapterIdSchema>,
   *   name: string,
   *   kind: "conformance" | "production",
   *   responseType: "harness.conformance.register.result" | "harness.sandcastle.register.result",
   *   registeredCode: "conformance_harness_registered" | "sandcastle_harness_registered",
   *   reusedCode: "conformance_harness_registration_reused" | "sandcastle_harness_registration_reused",
   * }} descriptor
   */
  const registerBundledHarness = (request, descriptor) => withMutationLock(async () => {
    const action = descriptor.action;
    const authorizationClass = "host_local_harness_registration";
    const state = await readHarnessState(options.dataDir);
    const keyValid = typeof request.idempotencyKey === "string"
      && request.idempotencyKey.length > 0
      && request.idempotencyKey.length <= 256;
    const keyHash = keyValid ? idempotencyHash(request.idempotencyKey) : null;
    const requestFingerprint = fingerprint({
      name: request.name,
      adapterId: descriptor.adapterId,
      authorizationClass: request.authorizationClass,
      expectedRevision: request.expectedRevision,
    });
    const existingOutcome = keyHash
      ? state.registrationOutcomes.find((outcome) => outcome.idempotencyKeyHash === keyHash)
      : null;
    if (existingOutcome) {
      if (existingOutcome.requestFingerprint !== requestFingerprint) {
        const auditId = await options.recordAudit(action, "rejected", {
          code: "idempotency_key_conflict",
          authorizationClass,
          idempotencyKeyHash: keyHash,
          expectedRevision: request.expectedRevision,
          actualRevision: Number(existingOutcome.response.revision ?? 0),
          projectFileWrite: false,
          workspaceWrite: false,
        });
        return operationFailure({
          requestId: request.requestId,
          operation: action,
          code: "idempotency_key_conflict",
          authorizationClass,
          idempotencyKeyHash: keyHash,
          expectedRevision: request.expectedRevision,
          actualRevision: Number(existingOutcome.response.revision ?? 0),
          auditId,
          retryable: false,
        });
      }
      await options.recordAudit(action, "observed", {
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        idempotentReplay: true,
        originalAuditId: existingOutcome.response.auditId,
        projectFileWrite: false,
        workspaceWrite: false,
      });
      return {
        ...structuredClone(existingOutcome.response),
        requestId: request.requestId,
        idempotentReplay: true,
      };
    }
    const registeredHarness = state.harnesses.find((candidate) =>
      candidate.adapterId === descriptor.adapterId);
    const actualRevision = registeredHarness?.revision ?? 0;
    if (
      request.authorizationClass !== authorizationClass
      || !keyHash
      || !Number.isSafeInteger(request.expectedRevision)
      || request.expectedRevision < 0
      || request.name !== descriptor.name
    ) {
      const auditId = await options.recordAudit(action, "rejected", {
        code: "mutation_contract_invalid",
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: Number.isSafeInteger(request.expectedRevision)
          ? request.expectedRevision
          : null,
        actualRevision,
        projectFileWrite: false,
        workspaceWrite: false,
      });
      return operationFailure({
        requestId: request.requestId,
        operation: action,
        code: "mutation_contract_invalid",
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision,
        auditId,
        retryable: false,
      });
    }
    if (request.expectedRevision !== actualRevision) {
      const auditId = await options.recordAudit(action, "rejected", {
        code: "mutation_revision_conflict",
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision,
        projectFileWrite: false,
        workspaceWrite: false,
      });
      return operationFailure({
        requestId: request.requestId,
        operation: action,
        code: "mutation_revision_conflict",
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision,
        auditId,
      });
    }

    let harness;
    /** @type {"accepted" | "observed"} */
    let outcome = "accepted";
    /** @type {string} */
    let code = descriptor.registeredCode;
    if (registeredHarness) {
      harness = registeredHarness;
      outcome = "observed";
      code = descriptor.reusedCode;
    } else {
      const harnessId = `harness-${randomBytes(12).toString("hex")}`;
      const workspacePath = join(
        harnessWorkspaceRoot(options.dataDir),
        harnessId,
      );
      try {
        const immutableRevision = descriptor.kind === "conformance"
          ? await initializeConformanceWorkspace(workspacePath)
          : (await initializeProductionHarnessWorkspace(workspacePath, {
              sourceRoot: options.productionSeedRoot,
            })).revision;
        const pinnedAdapter = await loadPinnedHarnessAdapter({
          workspacePath,
          pinnedRevision: immutableRevision,
        });
        const probed = await invokePinnedHarnessAdapter(pinnedAdapter, ["probe"]);
        const probe = harnessAdapterProbeSchema.safeParse(probed.message);
        if (
          !probe.success
          || probe.data.adapterId !== descriptor.adapterId
          || probe.data.adapterId !== pinnedAdapter.compatibility.adapterId
          || probe.data.adapterProtocol !== pinnedAdapter.compatibility.adapterProtocol
        ) {
          throw new Error("harness_adapter_protocol_invalid");
        }
        harness = storedHarnessSchema.parse({
          harnessId,
          revision: 1,
          name: request.name,
          adapterId: descriptor.adapterId,
          kind: descriptor.kind,
          immutableRevision,
          launchParameters: probe.data.launchParameters,
          workspace: {
            kind: "harness-workspace",
            versionControl: "git",
            independent: true,
            headRevision: immutableRevision,
          },
          workspacePath,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        await rm(workspacePath, { recursive: true, force: true });
        const seedError = error instanceof ProductionHarnessSeedError
          ? error
          : descriptor.kind === "production"
            ? new ProductionHarnessSeedError("harness_seed_missing")
            : null;
        if (seedError) {
          const auditId = await options.recordAudit(action, "rejected", {
            code: seedError.code,
            authorizationClass,
            idempotencyKeyHash: keyHash,
            expectedRevision: request.expectedRevision,
            actualRevision,
            projectFileWrite: false,
            workspaceWrite: false,
            falselyReadyHarnessRetained: false,
          });
          return operationFailure({
            requestId: request.requestId,
            operation: action,
            code: seedError.code,
            authorizationClass,
            idempotencyKeyHash: keyHash,
            expectedRevision: request.expectedRevision,
            actualRevision,
            auditId,
            retryable: false,
          });
        }
        throw error;
      }
    }
    const auditId = await options.recordAudit(action, outcome, {
      authorizationClass,
      idempotencyKeyHash: keyHash,
      expectedRevision: request.expectedRevision,
      actualRevision,
      resultingRevision: harness.revision,
      harnessId: harness.harnessId,
      immutableRevision: harness.immutableRevision,
      independentWorkspace: true,
      workspaceOutsideProject: true,
      executionStateOutsideWorkspace: true,
    });
    const response = {
      type: descriptor.responseType,
      requestId: request.requestId,
      code,
      authorizationClass,
      idempotencyKeyHash: keyHash,
      expectedRevision: request.expectedRevision,
      revision: harness.revision,
      idempotentReplay: false,
      auditId,
      harness: publicHarness(harness),
    };
    if (!registeredHarness) {
      state.harnesses.push(harness);
    }
    state.registrationOutcomes.push({
      idempotencyKeyHash: keyHash,
      requestFingerprint,
      response,
    });
    state.registrationOutcomes = state.registrationOutcomes.slice(-256);
    await writePrivateJson(harnessStatePath(options.dataDir), state);
    return response;
  });

  /** @param {{requestId: string, name: string, authorizationClass: string, idempotencyKey: string, expectedRevision: number}} request */
  const registerConformanceHarness = (request) => registerBundledHarness(request, {
    action: "harness.conformance.register",
    adapterId: CONFORMANCE_HARNESS_ADAPTER_ID,
    name: "Sand-King Conformance Harness",
    kind: "conformance",
    responseType: "harness.conformance.register.result",
    registeredCode: "conformance_harness_registered",
    reusedCode: "conformance_harness_registration_reused",
  });

  /** @param {{requestId: string, name: string, authorizationClass: string, idempotencyKey: string, expectedRevision: number}} request */
  const registerSandcastleHarness = (request) => registerBundledHarness(request, {
    action: "harness.sandcastle.register",
    adapterId: SANDCASTLE_HARNESS_ADAPTER_ID,
    name: "Sand-King Sandcastle Harness",
    kind: "production",
    responseType: "harness.sandcastle.register.result",
    registeredCode: "sandcastle_harness_registered",
    reusedCode: "sandcastle_harness_registration_reused",
  });

  /** @param {{requestId: string, projectId: string, harnessId: string, boundedConfiguration: unknown, authorizationClass: string, idempotencyKey: string, expectedRevision: number}} request */
  const pinConformanceHarness = (request) => withMutationLock(async () => {
    const action = "project.harness.pin";
    const authorizationClass = "host_local_project_configuration";
    const projectState = await readProjectState(options.dataDir);
    const harnessState = await readHarnessState(options.dataDir);
    const project = projectState.projects.find((candidate) =>
      candidate.projectId === request.projectId);
    const harness = harnessState.harnesses.find((candidate) =>
      candidate.harnessId === request.harnessId);
    const actualRevision = project?.revision ?? 0;
    const keyValid = typeof request.idempotencyKey === "string"
      && request.idempotencyKey.length > 0
      && request.idempotencyKey.length <= 256;
    const keyHash = keyValid ? idempotencyHash(request.idempotencyKey) : null;
    const existing = keyHash
      ? projectState.pinOutcomes.find((outcome) => outcome.idempotencyKeyHash === keyHash)
      : null;
    const existingResponse = existing
      ? /** @type {any} */ (existing.response)
      : null;
    const retainedImmutableRevision = commitSchema.safeParse(
      existingResponse?.harness?.immutableRevision,
    ).success
      ? existingResponse.harness.immutableRevision
      : project?.harness?.pinnedRevision;
    const requestFingerprint = pinRequestFingerprint(
      request,
      retainedImmutableRevision ?? harness?.immutableRevision,
    );
    /** @param {unknown} error */
    const rejectPreparation = async (error) => {
      const code = preparationFailureCode(error);
      const auditId = await options.recordAudit(action, "rejected", {
        code,
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision,
        projectId: project?.projectId ?? null,
        harnessId: harness?.harnessId ?? null,
        immutableRevision: harness?.immutableRevision ?? null,
        projectFileWrite: false,
        pinWrite: false,
        harnessRunCreated: false,
        adapterStarted: false,
      });
      return operationFailure({
        requestId: request.requestId,
        operation: action,
        code: /** @type {keyof typeof failureGuidance} */ (code),
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision,
        auditId,
      });
    };
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        const auditId = await options.recordAudit(action, "rejected", {
          code: "idempotency_key_conflict",
          authorizationClass,
          idempotencyKeyHash: keyHash,
          expectedRevision: request.expectedRevision,
          actualRevision,
          projectFileWrite: false,
          pinWrite: false,
        });
        return operationFailure({
          requestId: request.requestId,
          operation: action,
          code: "idempotency_key_conflict",
          authorizationClass,
          idempotencyKeyHash: keyHash,
          expectedRevision: request.expectedRevision,
          actualRevision,
          auditId,
          retryable: false,
        });
      }
      try {
        if (project) await requireRegisteredProjectLocation(projectState, project);
        if (project?.harness?.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID) {
          await prepareRetainedProductionProject(projectState, harnessState, project);
        }
      } catch (error) {
        return rejectPreparation(error);
      }
      existing.requestFingerprint = requestFingerprint;
      await writeProjectState(options.dataDir, projectState);
      await options.recordAudit(action, "observed", {
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        idempotentReplay: true,
        originalAuditId: existing.response.auditId,
        projectFileWrite: false,
        pinWrite: false,
      });
      return {
        ...structuredClone(existing.response),
        requestId: request.requestId,
        idempotentReplay: true,
      };
    }

    const boundedConfiguration = boundedHarnessConfigurationSchema.safeParse(
      request.boundedConfiguration,
    );
    let code = null;
    if (
      request.authorizationClass !== authorizationClass
      || !keyHash
      || !Number.isSafeInteger(request.expectedRevision)
      || request.expectedRevision < 0
    ) {
      code = "mutation_contract_invalid";
    } else if (!project) {
      code = "project_not_found";
    } else if (!harness) {
      code = "harness_not_found";
    } else if (!boundedConfiguration.success) {
      code = "bounded_configuration_invalid";
    }
    if (code) {
      const auditId = await options.recordAudit(action, "rejected", {
        code,
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: Number.isSafeInteger(request.expectedRevision)
          ? request.expectedRevision
          : null,
        actualRevision,
        projectId: project?.projectId ?? null,
        harnessId: harness?.harnessId ?? null,
        projectFileWrite: false,
        pinWrite: false,
      });
      return operationFailure({
        requestId: request.requestId,
        operation: action,
        code: /** @type {keyof typeof failureGuidance} */ (code),
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision,
        auditId,
        retryable: code !== "bounded_configuration_invalid",
      });
    }
    if (!project || !harness || !boundedConfiguration.success || !keyHash) {
      throw new Error("project_harness_pin_validation_invariant_failed");
    }
    if (request.expectedRevision !== actualRevision) {
      const auditId = await options.recordAudit(action, "rejected", {
        code: "mutation_revision_conflict",
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision,
        projectId: project.projectId,
        harnessId: harness.harnessId,
        projectFileWrite: false,
        pinWrite: false,
      });
      return operationFailure({
        requestId: request.requestId,
        operation: action,
        code: "mutation_revision_conflict",
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision,
        auditId,
      });
    }

    try {
      await requireRegisteredProjectLocation(projectState, project);
    } catch (error) {
      return rejectPreparation(error);
    }

    let productionPreparation = null;
    if (harness.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID) {
      try {
        await prepareRetainedProductionProject(projectState, harnessState, project);
        productionPreparation = await prepareProductionHarness({
          projectPath: project.canonicalPath,
          harnessId: harness.harnessId,
          workspacePath: harness.workspacePath,
          pinnedRevision: harness.immutableRevision,
        });
      } catch (error) {
        return rejectPreparation(error);
      }
    } else {
      const observedHead = await execFileAsync(
        "git",
        ["-C", harness.workspacePath, "rev-parse", "HEAD"],
      ).then(({ stdout }) => stdout.trim(), () => null);
      if (observedHead !== harness.immutableRevision) {
        const auditId = await options.recordAudit(action, "rejected", {
          code: "harness_workspace_invalid",
          authorizationClass,
          idempotencyKeyHash: keyHash,
          expectedRevision: request.expectedRevision,
          actualRevision,
          projectId: project.projectId,
          harnessId: harness.harnessId,
          projectFileWrite: false,
          pinWrite: false,
        });
        return operationFailure({
          requestId: request.requestId,
          operation: action,
          code: "harness_workspace_invalid",
          authorizationClass,
          idempotencyKeyHash: keyHash,
          expectedRevision: request.expectedRevision,
          actualRevision,
          auditId,
        });
      }
    }
    if (
      harness.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID
      && !productionPreparation
    ) {
      throw new Error("production_harness_preparation_invariant_failed");
    }

    const alreadyPinned = project.harness?.harnessId === harness.harnessId
      && project.harness.pinnedRevision === harness.immutableRevision
      && JSON.stringify(project.harness.boundedConfiguration)
        === JSON.stringify(boundedConfiguration.data)
      && (harness.adapterId !== SANDCASTLE_HARNESS_ADAPTER_ID
        || (project.harness.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID
          && JSON.stringify(project.harness.preparation)
            === JSON.stringify(productionPreparation)));
    const resultingRevision = alreadyPinned ? actualRevision : actualRevision + 1;
    const auditId = await options.recordAudit(
      action,
      alreadyPinned ? "observed" : "accepted",
      {
        authorizationClass,
        idempotencyKeyHash: keyHash,
        expectedRevision: request.expectedRevision,
        actualRevision,
        resultingRevision,
        projectId: project.projectId,
        harnessId: harness.harnessId,
        immutableRevision: harness.immutableRevision,
        projectFileWrite: false,
        pinWrite: !alreadyPinned,
        launchRequestReady: true,
        productionPreparation,
      },
    );
    if (!alreadyPinned) {
      project.revision = resultingRevision;
      if (harness.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID) {
        project.harness = {
          harnessId: harness.harnessId,
          name: harness.name,
          adapterId: harness.adapterId,
          pinnedRevision: harness.immutableRevision,
          boundedConfiguration: boundedConfiguration.data,
          preparation: productionHarnessPreparationSchema.parse(productionPreparation),
        };
      } else {
        project.harness = {
          harnessId: harness.harnessId,
          name: harness.name,
          adapterId: harness.adapterId,
          pinnedRevision: harness.immutableRevision,
          boundedConfiguration: boundedConfiguration.data,
        };
      }
      project.readiness = readinessWithHarness();
      project.updatedAt = new Date().toISOString();
    }
    const response = {
      type: "project.harness.pin.result",
      requestId: request.requestId,
      code: alreadyPinned ? "project_harness_pin_reused" : "project_harness_pinned",
      authorizationClass,
      idempotencyKeyHash: keyHash,
      expectedRevision: request.expectedRevision,
      revision: resultingRevision,
      idempotentReplay: false,
      auditId,
      project: publicProject(project),
      harness: publicHarness(harness),
    };
    projectState.pinOutcomes.push({
      idempotencyKeyHash: keyHash,
      requestFingerprint,
      response,
    });
    projectState.pinOutcomes = projectState.pinOutcomes.slice(-256);
    await writeProjectState(options.dataDir, projectState);
    return response;
  });

  /** @param {string} projectId */
  const loadLaunchContext = (projectId) => withMutationLock(async () => {
    const projectState = await readProjectState(options.dataDir);
    const harnessState = await readHarnessState(options.dataDir);
    const project = projectState.projects.find((candidate) =>
      candidate.projectId === projectId && candidate.status === "active");
    if (!project) {
      throw new Error("project_not_found");
    }
    const location = await resolveProjectLocation(
      projectState,
      project.canonicalPath,
      options.dataDir,
    );
    if (location.kind !== "registered") {
      throw new Error(location.kind === "failure" ? location.code : "launch_precondition_invalid");
    }
    if (!location.project || location.project.projectId !== project.projectId) {
      throw new Error("launch_precondition_invalid");
    }
    if (!project.harness) {
      throw new Error("harness_pin_missing");
    }
    const harness = harnessState.harnesses.find((candidate) =>
      candidate.harnessId === project.harness?.harnessId);
    if (!harness) {
      throw new Error("harness_not_found");
    }
    if (harness.immutableRevision !== project.harness.pinnedRevision) {
      throw new Error("harness_pin_invalid");
    }
    let productionHarnessProjectionPath = null;
    if (harness.adapterId === SANDCASTLE_HARNESS_ADAPTER_ID) {
      let preparation;
      try {
        await prepareRetainedProductionProject(projectState, harnessState, project);
        preparation = await prepareProductionHarness({
          projectPath: project.canonicalPath,
          harnessId: harness.harnessId,
          workspacePath: harness.workspacePath,
          pinnedRevision: harness.immutableRevision,
        });
      } catch (error) {
        if (error instanceof ProductionHarnessPreparationError) {
          throw new Error(error.code);
        }
        throw error;
      }
      if (
        project.harness.adapterId !== SANDCASTLE_HARNESS_ADAPTER_ID
        || JSON.stringify(project.harness.preparation) !== JSON.stringify(preparation)
      ) {
        throw new Error("harness_pin_invalid");
      }
      productionHarnessProjectionPath = join(
        project.canonicalPath,
        ...preparation.projection.path.split("/"),
      );
    }
    return {
      project: publicProject(project),
      harness: publicHarness(harness),
      harnessWorkspacePath: harness.workspacePath,
      productionHarnessProjectionPath,
    };
  });

  return {
    inspectProject,
    registerProject,
    inspectConformanceHarness,
    registerConformanceHarness,
    inspectSandcastleHarness,
    registerSandcastleHarness,
    pinHarness: pinConformanceHarness,
    pinConformanceHarness,
    loadLaunchContext,
  };
};

export const projectRegistrationInternals = Object.freeze({
  projectStatePath,
  harnessStatePath,
  auditIdSchema,
});
