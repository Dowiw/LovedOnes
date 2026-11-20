export const USER_FEEDBACK_MIN_DELAY_MS = 650;

/**
 * Ensures user-facing saves and actions remain in a visible loading state for at least `minMs`,
 * even when the self-hosted backend responds and logs in a few milliseconds.
 */
export async function withMinDelay<T>(
  work: Promise<T> | (() => Promise<T>),
  minMs: number = USER_FEEDBACK_MIN_DELAY_MS,
): Promise<T> {
  const start = Date.now();
  const promise = typeof work === 'function' ? work() : work;
  const waitRemaining = async () => {
    const remaining = minMs - (Date.now() - start);
    if (remaining > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    }
  };
  try {
    const result = await promise;
    await waitRemaining();
    return result;
  } catch (err) {
    await waitRemaining();
    throw err;
  }
}
