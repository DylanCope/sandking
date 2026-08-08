import { harnessCancellationRequestSchema } from "./harness-adapter-protocol.mjs";

/**
 * Dispatch the typed cooperative cancellation request over Node's native IPC
 * channel. On Windows this is the catchable request that precedes taskkill;
 * ChildProcess.kill cannot provide a cooperative POSIX-signal interval there.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {import("zod").infer<typeof harnessCancellationRequestSchema>} request
 */
export const sendHarnessCancellationRequest = (child, request) => {
  const parsed = harnessCancellationRequestSchema.safeParse(request);
  if (!parsed.success || typeof child.send !== "function" || child.connected !== true) {
    return false;
  }
  try {
    child.send(parsed.data, () => undefined);
    return true;
  } catch {
    return false;
  }
};
