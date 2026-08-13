/** Shared shapes for durable Sand-King identities at process and protocol boundaries. */
export const auditIdPattern = /^audit-[a-f0-9]{24}$/;
export const projectIdPattern = /^project-[a-f0-9]{24}$/;
export const harnessIdPattern = /^harness-[a-f0-9]{24}$/;
export const hostIdPattern = /^host-[a-f0-9]{24}$/;
export const runtimeIdPattern = /^runtime-[a-f0-9]{24}$/;

/** @type {WeakMap<object, Readonly<Record<string, import("zod").ZodString>>>} */
const schemasByZod = new WeakMap();

/**
 * Share one schema family without making the browser-facing regex module load
 * Zod. Schemas are cached per Zod instance for all server-side consumers.
 * @param {typeof import("zod").z} zod
 */
export const identifierSchemas = (zod) => {
  const retained = schemasByZod.get(zod);
  if (retained) return retained;
  const schemas = Object.freeze({
    auditIdSchema: zod.string().regex(auditIdPattern),
    projectIdSchema: zod.string().regex(projectIdPattern),
    harnessIdSchema: zod.string().regex(harnessIdPattern),
    hostIdSchema: zod.string().regex(hostIdPattern),
    runtimeIdSchema: zod.string().regex(runtimeIdPattern),
  });
  schemasByZod.set(zod, schemas);
  return schemas;
};
