import { z } from "zod";
import {
  conformanceHarnessLaunchParametersDeclaration as conformanceLaunchParameters,
  sandcastleHarnessLaunchParametersDeclaration as sandcastleLaunchParameters,
} from "../harness-adapter-protocol.mjs";
import {
  CONFORMANCE_HARNESS_ADAPTER_ID,
  SANDCASTLE_HARNESS_ADAPTER_ID,
} from "../harness-adapter-identity.mjs";
import {
  harnessRegistrationSchema,
  projectHarnessAdapterIdentityAgrees,
  projectPreparationProjectionSchema,
  projectRegistrationSchema,
} from "./schemas.mjs";

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
