import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  cleanupProductionProviderPreparation,
  productionProviderGitExcludeMarker,
} from "../production-provider-preparation.mjs";
import {
  readJson,
  removePrivateFile,
  writePrivateJson,
} from "../private-state.mjs";
import { projectIdSchema } from "./schemas.mjs";

const preparationIdSchema = z.string()
  .regex(/^provider-preparation-[a-f0-9]{24}$/);
const manifestIdentitySchema = z.object({
  birthtimeNanoseconds: z.string().regex(/^\d+$/),
  device: z.string().regex(/^\d+$/),
  inode: z.string().regex(/^\d+$/),
}).strict();
const retainedPreparationSchema = z.object({
  preparationId: preparationIdSchema,
  projectId: projectIdSchema,
  manifestIdentity: manifestIdentitySchema.optional(),
}).strict();
const preparationStateSchema = z.object({
  schemaVersion: z.literal(1),
  preparations: z.array(retainedPreparationSchema),
}).strict();

/** @param {string} dataDir */
const preparationStatePath = (dataDir) =>
  join(dataDir, "production-provider-preparations.json");

export const createProductionProviderPreparationId = () =>
  `provider-preparation-${randomBytes(12).toString("hex")}`;

/**
 * Journal temporary Project preparation before it begins, and retain ownership
 * until exact cleanup succeeds. This state is independent of run acceptance so
 * startup can recover the pre-commit window where no run exists yet.
 *
 * @param {{dataDir: string, loadLaunchContext: (
 *   projectId: string,
 *   options?: {prepareProductionHarness?: boolean},
 * ) => Promise<any>}} options
 */
export const createProductionProviderPreparationStore = (options) => {
  const path = preparationStatePath(options.dataDir);
  let mutationQueue = Promise.resolve();

  const readState = async () => preparationStateSchema.parse(await readJson(path, {
    schemaVersion: 1,
    preparations: [],
  }));

  /** @template T @param {() => Promise<T>} operation */
  const withMutationLock = (operation) => {
    const current = mutationQueue.catch(() => undefined).then(operation);
    mutationQueue = current.then(() => undefined, () => undefined);
    return current;
  };

  /** @param {{preparationId: string, projectId: string}} preparation */
  const retain = (preparation) => withMutationLock(async () => {
    const parsed = retainedPreparationSchema.parse(preparation);
    const state = await readState();
    if (state.preparations.some((candidate) =>
      candidate.preparationId === parsed.preparationId
      || candidate.projectId === parsed.projectId)) {
      throw new Error("production_provider_preparation_conflict");
    }
    state.preparations.push(parsed);
    await writePrivateJson(path, state);
  });

  /** @param {string} preparationId */
  const release = (preparationId) => withMutationLock(async () => {
    preparationIdSchema.parse(preparationId);
    const state = await readState();
    const retained = state.preparations.filter((candidate) =>
      candidate.preparationId !== preparationId);
    if (retained.length === state.preparations.length) return;
    if (retained.length === 0) {
      await removePrivateFile(path);
      return;
    }
    await writePrivateJson(path, { ...state, preparations: retained });
  });

  /**
   * @param {string} preparationId
   * @param {{birthtimeNanoseconds: string, device: string, inode: string}} manifestIdentity
   */
  const retainManifestIdentity = (preparationId, manifestIdentity) =>
    withMutationLock(async () => {
      preparationIdSchema.parse(preparationId);
      const parsedIdentity = manifestIdentitySchema.parse(manifestIdentity);
      const state = await readState();
      const retained = state.preparations.find((candidate) =>
        candidate.preparationId === preparationId);
      if (!retained) throw new Error("production_provider_preparation_missing");
      if (retained.manifestIdentity) {
        if (
          retained.manifestIdentity.birthtimeNanoseconds
            !== parsedIdentity.birthtimeNanoseconds
          || retained.manifestIdentity.device !== parsedIdentity.device
          || retained.manifestIdentity.inode !== parsedIdentity.inode
        ) {
          throw new Error("production_provider_preparation_conflict");
        }
        return;
      }
      retained.manifestIdentity = parsedIdentity;
      await writePrivateJson(path, state);
    });

  const reconcile = () => withMutationLock(async () => {
    const state = await readState();
    const retained = [];
    for (const preparation of state.preparations) {
      try {
        const context = await options.loadLaunchContext(preparation.projectId, {
          prepareProductionHarness: false,
        });
        await cleanupProductionProviderPreparation({
          projectPath: context.project.canonicalPath,
          preparationId: preparation.preparationId,
          ownershipMarker: productionProviderGitExcludeMarker(
            preparation.preparationId,
          ),
          manifestIdentity: preparation.manifestIdentity,
        });
      } catch {
        retained.push(preparation);
      }
    }
    if (retained.length === state.preparations.length) return;
    if (retained.length === 0) {
      await removePrivateFile(path);
      return;
    }
    await writePrivateJson(path, { ...state, preparations: retained });
  });

  return { reconcile, release, retain, retainManifestIdentity };
};
