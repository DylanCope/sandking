export const waitForTestCheckpoint = async (checkpoint, name, timeoutMs) => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`harness_run_test_checkpoint_timeout_invalid:${name}`);
  }
  let timeout;
  try {
    return await Promise.race([
      checkpoint,
      new Promise((_, reject) => {
        // This timer must stay referenced: it keeps Node's test runner alive
        // long enough to fail this test instead of cancelling later tests too.
        timeout = setTimeout(() => reject(
          new Error(`harness_run_test_checkpoint_timeout:${name}`),
        ), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};
