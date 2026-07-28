export const retryOperation = async ({
  label,
  operation,
  attempts = 3,
  initialDelayMs = 5_000,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  log = console.error,
}) => {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      if (attempt === attempts) {
        break;
      }

      const delayMs = initialDelayMs * 2 ** (attempt - 1);
      log(
        `${label} failed (attempt ${attempt}/${attempts}). Retrying in ${delayMs / 1_000}s...`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
};
