export const retryOperation = async ({
  label,
  operation,
  attempts = 3,
  initialDelayMs = 5_000,
  signal,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  log = console.error,
}) => {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    signal?.throwIfAborted();
    try {
      return await operation(attempt);
    } catch (error) {
      signal?.throwIfAborted();
      lastError = error;

      if (attempt === attempts) {
        break;
      }

      const delayMs = initialDelayMs * 2 ** (attempt - 1);
      log(
        `${label} failed (attempt ${attempt}/${attempts}). Retrying in ${delayMs / 1_000}s...`,
      );
      if (!signal) {
        await sleep(delayMs);
        continue;
      }
      let handleAbort;
      try {
        await Promise.race([
          sleep(delayMs),
          new Promise((_, reject) => {
            handleAbort = () => reject(signal.reason);
            signal.addEventListener("abort", handleAbort, { once: true });
          }),
        ]);
      } finally {
        signal.removeEventListener("abort", handleAbort);
      }
    }
  }

  throw lastError;
};
