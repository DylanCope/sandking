import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  conformanceHarnessLaunchParametersDeclaration as conformanceLaunchParameters,
  harnessAdapterProbeSchema,
  harnessLaunchParametersDeclarationSchema,
  invokePinnedHarnessAdapter,
  legacyConformanceHarnessLaunchParametersDeclaration as legacyConformanceLaunchParameters,
  loadPinnedHarnessAdapter,
} from "./harness-adapter-protocol.mjs";
import { readJson, writePrivateJson } from "./private-state.mjs";

const execFileAsync = promisify(execFile);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const auditIdSchema = z.string().regex(/^audit-[a-f0-9]{24}$/);
const projectIdSchema = z.string().regex(/^project-[a-f0-9]{24}$/);
const harnessIdSchema = z.string().regex(/^harness-[a-f0-9]{24}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const pathSchema = z.string().min(1).max(4_096).refine((value) => !value.includes("\0"));
const commandSchema = z.string().min(1).max(256)
  .refine((value) => !/[\r\n\0]/.test(value));
const checkIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/);
const conformanceAdapterEntryPoint = "adapters/conformance.mjs";

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

const projectHarnessLinkSchema = z.object({
  harnessId: harnessIdSchema,
  name: z.string().min(1).max(120),
  adapterId: z.literal("conformance-harness-adapter-v1"),
  pinnedRevision: commitSchema,
  boundedConfiguration: boundedHarnessConfigurationSchema,
}).strict();

export const projectRegistrationSchema = z.object({
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
  harness: projectHarnessLinkSchema.nullable(),
  readiness: projectReadinessSchema,
}).strict();

export const harnessRegistrationSchema = z.object({
  harnessId: harnessIdSchema,
  revision: z.number().int().positive(),
  name: z.string().min(1).max(120),
  adapterId: z.literal("conformance-harness-adapter-v1"),
  kind: z.literal("conformance"),
  immutableRevision: commitSchema,
  // Schema-v1 conformance registrations predate adapter-declared parameters.
  // Their immutable adapter bytes still require this known historical shape;
  // fresh registrations retain the explicit value observed from the pinned probe.
  launchParameters: harnessLaunchParametersDeclarationSchema
    .default(legacyConformanceLaunchParameters),
  workspace: z.object({
    kind: z.literal("harness-workspace"),
    versionControl: z.literal("git"),
    independent: z.literal(true),
    headRevision: commitSchema,
  }).strict(),
}).strict();

const storedProjectSchema = projectRegistrationSchema.extend({
  filesystemIdentityDigest: digestSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const storedHarnessSchema = harnessRegistrationSchema.extend({
  workspacePath: pathSchema,
  createdAt: z.string().datetime(),
});
const outcomeSchema = z.object({
  idempotencyKeyHash: digestSchema,
  requestFingerprint: digestSchema,
  response: z.object({}).passthrough(),
}).strict();
const projectStateSchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.array(storedProjectSchema).max(256),
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
    adapterId: z.literal("conformance-harness-adapter-v1"),
    permittedTestDouble: z.literal(true),
    launchParameters: harnessLaunchParametersDeclarationSchema,
  }).strict(),
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
    harness: z.object({
      harnessId: harnessIdSchema,
      name: z.string().min(1).max(120),
      adapterId: z.literal("conformance-harness-adapter-v1"),
      pinnedRevision: commitSchema,
      launchParameters: harnessLaunchParametersDeclarationSchema,
    }).strict().nullable(),
    readiness: projectReadinessSchema,
    canPrepareLaunchRequest: z.boolean(),
  }).strict().nullable(),
  excludedCapabilities: z.tuple([
    z.literal("full-harness-projection"),
    z.literal("production-harness-lifecycle"),
    z.literal("harness-import-update-rollback-switching"),
    z.literal("drift-recovery"),
  ]),
}).strict();

const initialProjectState = () => ({
  schemaVersion: 1,
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
const sha256 = (value) => `sha256:${createHash("sha256")
  .update(typeof value === "string" ? value : JSON.stringify(value))
  .digest("hex")}`;
/** @param {unknown} value @returns {string} */
const canonicalJson = (value) => {
  if (value === undefined) {
    return '"<undefined>"';
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};
/** @param {unknown} value */
const fingerprint = (value) => sha256(canonicalJson(value));
/** @param {string} key */
const idempotencyHash = (key) => sha256(key);

/** @param {string} dataDir */
const projectStatePath = (dataDir) => join(dataDir, "project-registrations.json");
/** @param {string} dataDir */
const harnessStatePath = (dataDir) => join(dataDir, "harness-registry.json");

/** @param {string} dataDir */
const readProjectState = async (dataDir) => {
  const parsed = projectStateSchema.safeParse(
    await readJson(projectStatePath(dataDir), initialProjectState()),
  );
  if (!parsed.success) {
    throw new Error("project_registration_state_invalid");
  }
  return parsed.data;
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
  harness_pin_missing: ["select_immutable_revision"],
  harness_pin_invalid: ["select_registered_immutable_revision"],
  harness_workspace_invalid: ["repair_or_reregister_harness_workspace"],
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

/**
 * Resolve only the supplied path. The function never enumerates a parent or
 * sibling directory; stored filesystem evidence is the only cross-registration lookup.
 * @param {z.infer<typeof projectStateSchema>} state
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
    if (containsPath(canonicalPath, resolve(dataDir))) {
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

  const identityDigest = sha256(`${details.dev}:${details.ino}:${details.birthtimeMs}`);
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
        adapterId: "conformance-harness-adapter-v1",
        adapterProtocol: "1.0.0",
        entryPoint: conformanceAdapterEntryPoint,
      },
    }, null, 2)}\n`, { mode: 0o600 });
    await mkdir(join(workspacePath, "adapters"), { mode: 0o700 });
    await writeFile(
      join(workspacePath, conformanceAdapterEntryPoint),
      `import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeSync } from "node:fs";

const adapterProtocol = "1.0.0";
const adapterId = "conformance-harness-adapter-v1";
const capabilities = ["harness.launch.prepare.v1", "harness.run.v1"];
const launchParameters = ${JSON.stringify(conformanceLaunchParameters)};
const writeFrame = (message) => {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.byteLength, 0);
  writeSync(3, header);
  writeSync(3, body);
};
const normalizeParameters = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("bounded_configuration_invalid");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "issueNumber" && key !== "targetBranch")) {
    throw new Error("bounded_configuration_invalid");
  }
  if (keys.length === 0) {
    return {
      issueNumber: null,
      targetBranch: null,
      placeholderIdentifier: \`conformance-placeholder-\${randomBytes(12).toString("hex")}\`,
    };
  }
  let issueNumber = value.issueNumber;
  let targetBranch = value.targetBranch;
  if (issueNumber === undefined && typeof targetBranch === "string") {
    const matchedIssue = /^sandcastle\\/issue-([1-9][0-9]*)$/.exec(targetBranch);
    issueNumber = matchedIssue ? Number(matchedIssue[1]) : null;
  }
  if (
    !Number.isSafeInteger(issueNumber)
    || issueNumber < 1
    || issueNumber > 999999999
  ) {
    throw new Error("bounded_configuration_invalid");
  }
  targetBranch ??= \`sandcastle/issue-\${issueNumber}\`;
  if (targetBranch !== \`sandcastle/issue-\${issueNumber}\`) {
    throw new Error("bounded_configuration_invalid");
  }
  return { issueNumber, targetBranch, placeholderIdentifier: null };
};
const [command, encodedParameters] = process.argv.slice(2);
if (command === "probe") {
  writeFrame({
    type: "harness.adapter.probe",
    adapterProtocol,
    adapterId,
    capabilities,
    launchParameters,
  });
} else if (command === "prepare") {
  let parameters;
  try {
    parameters = JSON.parse(Buffer.from(encodedParameters ?? "", "base64url").toString("utf8"));
  } catch {
    throw new Error("bounded_configuration_invalid");
  }
  const normalized = normalizeParameters(parameters);
  writeFrame({
    type: "harness.launch.prepared",
    adapterProtocol,
    adapterId,
    negotiatedCapabilities: ["harness.launch.prepare.v1"],
    suppliedCapabilities: ["github.issues.read", "project.git.read"],
    sanitizedPreview: {
      summary: normalized.placeholderIdentifier
        ? \`Delegate generated conformance work \${normalized.placeholderIdentifier} using the pinned Harness.\`
        : \`Delegate GitHub issue #\${normalized.issueNumber} on \${normalized.targetBranch} using the pinned conformance Harness.\`,
      secretFree: true,
    },
    sideEffects: {
      delegatedWorkStarted: false,
      projectWrite: false,
      harnessWorkspaceWrite: false,
    },
  });
} else if (command === "run") {
  let execution;
  try {
    execution = JSON.parse(Buffer.from(encodedParameters ?? "", "base64url").toString("utf8"));
  } catch {
    throw new Error("bounded_configuration_invalid");
  }
  if (!/^harness-run-[a-f0-9]{24}$/.test(execution?.harnessRunId ?? "")) {
    throw new Error("bounded_configuration_invalid");
  }
  const normalized = normalizeParameters(execution.parameters);
  const now = () => new Date().toISOString();
  if (normalized.issueNumber === 999999992) {
    const descendant = spawn(process.execPath, ["--eval", "process.on('SIGTERM', () => undefined); process.send?.('ready'); setInterval(() => {}, 1000);"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    await new Promise((resolve, reject) => {
      descendant.once("message", resolve);
      descendant.once("error", reject);
    });
    descendant.disconnect();
    descendant.unref();
  }
  const handleCancellation = () => {
    writeFrame({
      type: "harness.run.terminal",
      adapterProtocol,
      adapterId,
      harnessRunId: execution.harnessRunId,
      terminalId: \`harness-terminal-\${"4".repeat(24)}\`,
      status: "cancelled",
      completedAt: now(),
      result: { kind: "conformance-cancellation" },
    });
    process.exit(0);
  };
  const handleCancellationRequest = (message) => {
    if (
      message?.type !== "harness.run.cancel"
      || message.adapterProtocol !== adapterProtocol
      || message.adapterId !== adapterId
      || message.harnessRunId !== execution.harnessRunId
      || !Number.isFinite(Date.parse(message.cooperativeDeadlineAt ?? ""))
    ) {
      return;
    }
    handleCancellation();
  };
  if (normalized.issueNumber === 999999994) {
    process.on("SIGTERM", () => undefined);
    process.on("message", () => undefined);
  } else {
    process.once("SIGTERM", handleCancellation);
    process.once("message", handleCancellationRequest);
  }
  process.channel?.unref();
  process.stdout.write(
    normalized.placeholderIdentifier
      ? \`Conformance diagnostic stdout for \${normalized.placeholderIdentifier}.\\n\`
      : \`Conformance diagnostic stdout for issue #\${normalized.issueNumber}.\\n\`,
  );
  process.stderr.write(
    normalized.placeholderIdentifier
      ? "Conformance diagnostic stderr for generated work.\\n"
      : \`Conformance diagnostic stderr for \${normalized.targetBranch}.\\n\`,
  );
  writeFrame({
    type: "harness.run.ready",
    adapterProtocol,
    adapterId,
    harnessRunId: execution.harnessRunId,
    capabilities: ["harness.run.v1"],
    readyAt: now(),
  });
  if (normalized.issueNumber === 999999999) {
    process.stdout.write("SUCCESS: process exited cleanly without a terminal envelope.\\n");
  } else {
    const progressRecordCount = normalized.issueNumber === 999999997 ? 1023 : 1;
    if (progressRecordCount === 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    for (let index = 0; index < progressRecordCount; index += 1) {
      writeFrame({
        type: "harness.run.progress",
        adapterProtocol,
        adapterId,
        harnessRunId: execution.harnessRunId,
        record: {
          recordId: normalized.issueNumber === 999999997
            ? \`progress-\${index.toString(16).padStart(24, "0")}\`
            : \`progress-\${"1".repeat(24)}\`,
          schemaVersion: "1.0.0",
          type: "conformance.step",
          parentRecordId: normalized.issueNumber === 999999998
            ? \`progress-\${"9".repeat(24)}\`
            : null,
          label: "Exercise approved conformance Launch",
          summary: "The deterministic conformance workflow crossed its pinned adapter boundary.",
          status: "complete",
          timestamp: now(),
          payload: normalized.placeholderIdentifier
            ? { placeholderIdentifier: normalized.placeholderIdentifier, index }
            : { issueNumber: normalized.issueNumber, index },
        },
      });
    }
    if (progressRecordCount === 1) {
      await new Promise((resolve) => setTimeout(resolve, 140));
    }
    if (normalized.issueNumber === 999999993) {
      // This reserved packaged-Cockpit fixture remains live until the selected
      // run is cancelled. Wall-clock completion made the public Cancel control
      // depend on launch, reload, and browser scheduling speed.
      setInterval(() => undefined, 1000);
    } else {
      const terminal = {
        type: "harness.run.terminal",
        adapterProtocol,
        adapterId,
        harnessRunId: execution.harnessRunId,
        terminalId: \`harness-terminal-\${"2".repeat(24)}\`,
        status: "succeeded",
        completedAt: now(),
        result: normalized.placeholderIdentifier ? {
          kind: "conformance-result",
          placeholderIdentifier: normalized.placeholderIdentifier,
        } : {
          kind: "conformance-result",
          issueNumber: normalized.issueNumber,
          targetBranch: normalized.targetBranch,
        },
      };
      if (normalized.issueNumber === 999999995) {
        writeFrame({ ...terminal, terminalId: "invalid-terminal-id" });
      } else {
        writeFrame(terminal);
        if (normalized.issueNumber === 999999996) {
          writeFrame({
            ...terminal,
            terminalId: \`harness-terminal-\${"3".repeat(24)}\`,
          });
        }
      }
    }
  }
} else {
  throw new Error("harness_adapter_command_invalid");
}
`,
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
export const projectPreparationProjection = (project = null, harness = null) =>
  projectPreparationProjectionSchema.parse({
    kind: "cockpit.project-preparation",
    selection: { mode: "explicit-host-path", directoryScanning: false },
    conformanceHarness: {
      name: "Sand-King Conformance Harness",
      adapterId: "conformance-harness-adapter-v1",
      permittedTestDouble: true,
      launchParameters: conformanceLaunchParameters,
    },
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
        launchParameters: harness?.harnessId === project.harness.harnessId
          ? harness.launchParameters
          : conformanceLaunchParameters,
      } : null,
      readiness: project.readiness,
      canPrepareLaunchRequest: project.readiness.launchRequest === "ready",
    } : null,
    excludedCapabilities: [
      "full-harness-projection",
      "production-harness-lifecycle",
      "harness-import-update-rollback-switching",
      "drift-recovery",
    ],
  });

/**
 * @param {{
 *   dataDir: string,
 *   recordAudit: (action: string, outcome: "accepted" | "rejected" | "observed", details?: Record<string, unknown>, auditId?: string) => Promise<string>,
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

  /** @param {{requestId: string, path: string}} request */
  const inspectProject = async (request) => {
    const state = await readProjectState(options.dataDir);
    const location = await resolveProjectLocation(state, request.path, options.dataDir);
    if (location.kind === "failure") {
      const auditId = await options.recordAudit("project.inspect", "rejected", {
        code: location.code,
        selectedPathHash: sha256(typeof request.path === "string" ? request.path : ""),
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
    return {
      type: "project.inspect.result",
      requestId: request.requestId,
      code: location.kind === "registered" ? "project_registered" : "project_unregistered",
      actualRevision: location.actualRevision,
      project: location.kind === "registered"
        ? publicProject(location.project)
        : null,
    };
  };

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
        selectedPathHash: sha256(typeof request.path === "string" ? request.path : ""),
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
        selectedPathHash: sha256(request.path),
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
      await writePrivateJson(projectStatePath(options.dataDir), state);
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
    await writePrivateJson(projectStatePath(options.dataDir), state);
    return response;
  });

  /** @param {{requestId: string}} request */
  const inspectConformanceHarness = async (request) => {
    const state = await readHarnessState(options.dataDir);
    const harness = state.harnesses[0] ?? null;
    return {
      type: "harness.conformance.inspect.result",
      requestId: request.requestId,
      code: harness ? "conformance_harness_registered" : "conformance_harness_unregistered",
      actualRevision: harness?.revision ?? 0,
      harness: harness ? publicHarness(harness) : null,
    };
  };

  /** @param {{requestId: string, name: string, authorizationClass: string, idempotencyKey: string, expectedRevision: number}} request */
  const registerConformanceHarness = (request) => withMutationLock(async () => {
    const action = "harness.conformance.register";
    const authorizationClass = "host_local_harness_registration";
    const state = await readHarnessState(options.dataDir);
    const keyValid = typeof request.idempotencyKey === "string"
      && request.idempotencyKey.length > 0
      && request.idempotencyKey.length <= 256;
    const keyHash = keyValid ? idempotencyHash(request.idempotencyKey) : null;
    const requestFingerprint = fingerprint({
      name: request.name,
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
    const actualRevision = state.harnesses[0]?.revision ?? 0;
    if (
      request.authorizationClass !== authorizationClass
      || !keyHash
      || !Number.isSafeInteger(request.expectedRevision)
      || request.expectedRevision < 0
      || request.name !== "Sand-King Conformance Harness"
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
    let code = "conformance_harness_registered";
    if (state.harnesses[0]) {
      harness = state.harnesses[0];
      outcome = "observed";
      code = "conformance_harness_registration_reused";
    } else {
      const harnessId = `harness-${randomBytes(12).toString("hex")}`;
      const stateRoot = resolve(options.dataDir);
      const workspacePath = join(
        dirname(stateRoot),
        `${basename(stateRoot)}-harness-workspaces`,
        harnessId,
      );
      const immutableRevision = await initializeConformanceWorkspace(workspacePath);
      const pinnedAdapter = await loadPinnedHarnessAdapter({
        workspacePath,
        pinnedRevision: immutableRevision,
      });
      const probed = await invokePinnedHarnessAdapter(pinnedAdapter, ["probe"]);
      const probe = harnessAdapterProbeSchema.safeParse(probed.message);
      if (
        !probe.success
        || probe.data.adapterId !== pinnedAdapter.compatibility.adapterId
        || probe.data.adapterProtocol !== pinnedAdapter.compatibility.adapterProtocol
      ) {
        throw new Error("harness_adapter_protocol_invalid");
      }
      harness = storedHarnessSchema.parse({
        harnessId,
        revision: 1,
        name: request.name,
        adapterId: "conformance-harness-adapter-v1",
        kind: "conformance",
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
      type: "harness.conformance.register.result",
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
    if (state.harnesses.length === 0) {
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

  /** @param {{requestId: string, projectId: string, harnessId: string, immutableRevision: string, boundedConfiguration: unknown, authorizationClass: string, idempotencyKey: string, expectedRevision: number}} request */
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
    const requestFingerprint = fingerprint({
      projectId: request.projectId,
      harnessId: request.harnessId,
      immutableRevision: request.immutableRevision,
      boundedConfiguration: request.boundedConfiguration,
      authorizationClass: request.authorizationClass,
      expectedRevision: request.expectedRevision,
    });
    const existing = keyHash
      ? projectState.pinOutcomes.find((outcome) => outcome.idempotencyKeyHash === keyHash)
      : null;
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
    } else if (typeof request.immutableRevision !== "string"
      || request.immutableRevision.length === 0) {
      code = "harness_pin_missing";
    } else if (!commitSchema.safeParse(request.immutableRevision).success
      || request.immutableRevision !== harness.immutableRevision) {
      code = "harness_pin_invalid";
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

    const observedHead = (await execFileAsync(
      "git",
      ["-C", harness.workspacePath, "rev-parse", "HEAD"],
    )).stdout.trim();
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

    const alreadyPinned = project.harness?.harnessId === harness.harnessId
      && project.harness.pinnedRevision === request.immutableRevision
      && JSON.stringify(project.harness.boundedConfiguration)
        === JSON.stringify(boundedConfiguration.data);
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
        immutableRevision: request.immutableRevision,
        projectFileWrite: false,
        pinWrite: !alreadyPinned,
        launchRequestReady: true,
      },
    );
    if (!alreadyPinned) {
      project.revision = resultingRevision;
      project.harness = {
        harnessId: harness.harnessId,
        name: harness.name,
        adapterId: harness.adapterId,
        pinnedRevision: request.immutableRevision,
        boundedConfiguration: boundedConfiguration.data,
      };
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
    await writePrivateJson(projectStatePath(options.dataDir), projectState);
    return response;
  });

  /** @param {string} projectId */
  const loadLaunchContext = async (projectId) => {
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
    return {
      project: publicProject(project),
      harness: publicHarness(harness),
      harnessWorkspacePath: harness.workspacePath,
    };
  };

  return {
    inspectProject,
    registerProject,
    inspectConformanceHarness,
    registerConformanceHarness,
    pinConformanceHarness,
    loadLaunchContext,
  };
};

export const projectRegistrationInternals = Object.freeze({
  projectStatePath,
  harnessStatePath,
  auditIdSchema,
});
