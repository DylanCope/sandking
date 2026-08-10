import { z } from "zod";

export const CONFORMANCE_HARNESS_ADAPTER_ID = "conformance-harness-adapter-v1";
export const SANDCASTLE_HARNESS_ADAPTER_ID = "sandcastle-harness-adapter-v1";

export const harnessAdapterIds = Object.freeze([
  CONFORMANCE_HARNESS_ADAPTER_ID,
  SANDCASTLE_HARNESS_ADAPTER_ID,
]);

export const harnessAdapterIdSchema = z.enum(harnessAdapterIds);
