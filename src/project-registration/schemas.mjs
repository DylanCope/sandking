import { z } from "zod";
import { identifierSchemas } from "../common/identifiers.mjs";
import {
  harnessLaunchParametersDeclarationSchema,
  legacyConformanceHarnessLaunchParametersDeclaration as legacyConformanceLaunchParameters,
} from "../harness-adapter-protocol.mjs";
import {
  CONFORMANCE_HARNESS_ADAPTER_ID,
  SANDCASTLE_HARNESS_ADAPTER_ID,
} from "../harness-adapter-identity.mjs";
import { productionHarnessPreparationSchema } from "../production-harness-preparation.mjs";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const { projectIdSchema, harnessIdSchema } = identifierSchemas(z);
export const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const pathSchema = z.string().min(1).max(4_096).refine((value) => !value.includes("\0"));
const commandSchema = z.string().min(1).max(256)
  .refine((value) => !/[\r\n\0]/.test(value));
const checkIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/);

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
export const storedProjectSchema = projectRegistrationSchema.extend(storedProjectFields);
export const legacyStoredProjectSchema = retainedProjectRegistrationSchema.extend(storedProjectFields);
const storedHarnessFields = {
  workspacePath: pathSchema,
  createdAt: z.string().datetime(),
};
export const storedHarnessSchema = z.discriminatedUnion("adapterId", [
  conformanceHarnessRegistrationSchema.extend(storedHarnessFields),
  sandcastleHarnessRegistrationSchema.extend(storedHarnessFields),
]);
const outcomeSchema = z.object({
  idempotencyKeyHash: digestSchema,
  requestFingerprint: digestSchema,
  response: z.object({}).passthrough(),
}).strict();
export const projectStateSchema = z.object({
  schemaVersion: z.literal(2),
  projects: z.array(storedProjectSchema).max(256),
  registrationOutcomes: z.array(outcomeSchema).max(256),
  pinOutcomes: z.array(outcomeSchema).max(256),
}).strict();
export const legacyProjectStateSchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.array(legacyStoredProjectSchema).max(256),
  registrationOutcomes: z.array(outcomeSchema).max(256),
  pinOutcomes: z.array(outcomeSchema).max(256),
}).strict();
export const harnessStateSchema = z.object({
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

export const readinessWithoutHarness = () => projectReadinessSchema.parse({
  issueWorkflow: "ready",
  checks: "ready",
  configuration: "ready",
  harness: "missing",
  pin: "missing",
  launchRequest: "blocked",
  diagnostics: ["harness_not_registered", "harness_pin_missing"],
});

export const readinessWithHarness = () => projectReadinessSchema.parse({
  issueWorkflow: "ready",
  checks: "ready",
  configuration: "ready",
  harness: "ready",
  pin: "ready",
  launchRequest: "ready",
  diagnostics: [],
});
