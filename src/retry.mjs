/**
 * @typedef {object} RetryOptions
 * @property {number} retries number of retries after the first attempt
 * @property {number} delayMs delay before the first retry, doubled for each further retry
 * @property {(message: string) => void} [log]
 * @property {(ms: number) => Promise<void>} [sleep]
 */

/** @param {number} ms */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying network errors and errors flagged with `retryable: true`.
 * Errors flagged with `retryable: false` are thrown immediately. An error's
 * `retryAfterMs` overrides the backoff delay.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {RetryOptions} options
 * @returns {Promise<T>}
 */
export async function withRetry(fn, { retries, delayMs, log = () => {}, sleep: sleepFn = sleep }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const { retryable = true, retryAfterMs } = /** @type {{ retryable?: boolean, retryAfterMs?: number }} */ (error);
      if (!retryable || attempt >= retries) throw error;
      const delay = retryAfterMs ?? delayMs * 2 ** attempt;
      log(`${/** @type {Error} */ (error).message}; retrying in ${Math.round(delay / 1000)}s`);
      await sleepFn(delay);
    }
  }
}
