// Submission to the IndexNow API (https://www.indexnow.org/documentation).

import { withRetry } from "./retry.mjs";

/** IndexNow accepts up to 10,000 URLs per request. */
export const MAX_BATCH_SIZE = 10_000;

/**
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
export function batch(items, size = MAX_BATCH_SIZE) {
  if (!(size > 0)) throw new Error(`Invalid batch size: ${size}`);
  /** @type {T[][]} */
  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/**
 * @typedef {object} SubmitOptions
 * @property {string} endpoint
 * @property {string} host
 * @property {string} key
 * @property {string} keyLocation
 * @property {string[]} urls
 * @property {typeof fetch} [fetch]
 * @property {number} [batchSize]
 * @property {number} [retries]
 * @property {number} [retryDelayMs]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {(message: string) => void} [log]
 */

/**
 * @typedef {object} BatchResult
 * @property {number} count number of URLs in the batch
 * @property {number} status HTTP status of the successful response (200 or 202)
 */

/**
 * Submits URLs in batches. Retries 429, 5xx and network errors; any other non-2xx
 * response throws. Resolves only when every batch was accepted.
 * @param {SubmitOptions} options
 * @returns {Promise<BatchResult[]>}
 */
export async function submitUrls(options) {
  const {
    endpoint,
    host,
    key,
    keyLocation,
    urls,
    fetch: fetchFn = fetch,
    batchSize = MAX_BATCH_SIZE,
    retries = 3,
    retryDelayMs = 5000,
    sleep,
    log = () => {},
  } = options;

  /** @type {BatchResult[]} */
  const results = [];
  for (const urlList of batch(urls, batchSize)) {
    const status = await withRetry(
      async () => {
        const res = await fetchFn(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ host, key, keyLocation, urlList }),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.status === 200 || res.status === 202) return res.status;

        const body = (await res.text()).trim();
        const error = new Error(
          `IndexNow responded ${res.status} ${res.statusText}${describeStatus(res.status)}${body ? `: ${body}` : ""}`,
        );
        const retryable = res.status === 429 || res.status >= 500;
        const retryAfter = Number(res.headers.get("retry-after"));
        Object.assign(error, {
          retryable,
          retryAfterMs: retryAfter > 0 ? Math.min(retryAfter, 300) * 1000 : undefined,
        });
        throw error;
      },
      { retries, delayMs: retryDelayMs, sleep, log },
    );
    log(`Submitted ${urlList.length} URLs: ${status}${status === 202 ? " (accepted, key validation pending)" : " OK"}`);
    results.push({ count: urlList.length, status });
  }
  return results;
}

/** @param {number} status */
function describeStatus(status) {
  switch (status) {
    case 400:
      return " (bad request)";
    case 403:
      return " (key not valid: check that keyLocation serves the key)";
    case 422:
      return " (URLs don't belong to the host or the key doesn't match the schema)";
    case 429:
      return " (too many requests)";
    default:
      return "";
  }
}
