import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  CONFORMANCE_HARNESS_ADAPTER_ID,
  SANDCASTLE_HARNESS_ADAPTER_ID,
} from "../harness-adapter-identity.mjs";
import { readJson, writePrivateJson } from "../private-state.mjs";
import {
  commitSchema,
  harnessRegistrationSchema,
  harnessStateSchema,
  legacyProjectStateSchema,
  legacyStoredProjectSchema,
  projectRegistrationSchema,
  projectStateSchema,
} from "./schemas.mjs";

const execFileAsync = promisify(execFile);
const conformanceAdapterEntryPoint = "adapters/conformance.mjs";
const conformanceAdapterSourcePath = new URL(
  "../conformance-harness-adapter/conformance.mjs",
  import.meta.url,
);

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
export const publicProject = (project) => {
  const { filesystemIdentityDigest, createdAt, updatedAt, ...publicFields } = project;
  void filesystemIdentityDigest;
  void createdAt;
  void updatedAt;
  return projectRegistrationSchema.parse(publicFields);
};

/** @param {any} harness */
export const publicHarness = (harness) => {
  const { workspacePath, createdAt, ...publicFields } = harness;
  void workspacePath;
  void createdAt;
  return harnessRegistrationSchema.parse(publicFields);
};

/** @param {string} dataDir */
export const projectStatePath = (dataDir) => join(dataDir, "project-registrations.json");
/** @param {string} dataDir */
export const harnessStatePath = (dataDir) => join(dataDir, "harness-registry.json");
/** @param {string} dataDir */
export const harnessWorkspaceRoot = (dataDir) => {
  const stateRoot = resolve(dataDir);
  return join(dirname(stateRoot), `${basename(stateRoot)}-harness-workspaces`);
};

/** @param {string} dataDir */
export const readProjectState = async (dataDir) => {
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
export const writeProjectState = async (dataDir, state) => {
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
export const readHarnessState = async (dataDir) => {
  const parsed = harnessStateSchema.safeParse(
    await readJson(harnessStatePath(dataDir), initialHarnessState()),
  );
  if (!parsed.success) {
    throw new Error("harness_registry_state_invalid");
  }
  return parsed.data;
};

/**
 * @param {string} dataDir
 * @param {z.infer<typeof harnessStateSchema>} state
 */
export const writeHarnessState = async (dataDir, state) =>
  writePrivateJson(harnessStatePath(dataDir), state);

/**
 * Add schema-v2 preparation metadata only to retained success envelopes for
 * the same production pin. Historical registration and pin responses keep
 * their accepted Project snapshots and request fingerprints.
 * @param {z.infer<typeof projectStateSchema> | z.infer<typeof legacyProjectStateSchema>} state
 * @param {z.infer<typeof legacyStoredProjectSchema>} project
 */
export const refreshRetainedProjectReferences = (state, project) => {
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

/** @param {string} workspacePath */
export const initializeConformanceWorkspace = async (workspacePath) => {
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
