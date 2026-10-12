// Ties fetching, diffing, submitting and state together. Kept free of GitHub
// Actions specifics (env, outputs, summary) so it can be tested directly.

import { readFile } from "node:fs/promises";
import { diffUrls, partitionByHost, sameUrls } from "./diff.mjs";
import { submitUrls } from "./indexnow.mjs";
import { fetchSitemap } from "./sitemap.mjs";

/** @typedef {import("./sitemap.mjs").UrlMap} UrlMap */

export const STATE_VERSION = 1;

/**
 * @typedef {object} Config
 * @property {string} siteUrl
 * @property {string} host
 * @property {string} key
 * @property {string} sitemapUrl
 * @property {string} keyLocation
 * @property {"changed" | "all"} mode
 * @property {"baseline" | "all"} onMissingState
 * @property {string} endpoint
 * @property {boolean} dryRun
 * @property {string} cacheKeyPrefix
 */

/**
 * @typedef {object} State
 * @property {number} version
 * @property {string} host
 * @property {string} savedAt
 * @property {Record<string, string | null>} urls
 */

/**
 * @param {string} name
 * @param {string | undefined} value
 * @param {string[]} allowed
 */
function oneOf(name, value, allowed) {
  if (!value || !allowed.includes(value)) {
    throw new Error(`Input ${name} must be one of ${allowed.join(", ")}, got "${value ?? ""}"`);
  }
  return value;
}

/**
 * @param {string} name
 * @param {string} value
 */
function parseUrl(name, value) {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url;
  } catch {}
  throw new Error(`Input ${name} must be an http(s) URL, got "${value}"`);
}

/**
 * Builds and validates the configuration from the action inputs.
 * @param {Record<string, string | undefined>} inputs keyed by input name
 * @returns {Config}
 */
export function parseConfig(inputs) {
  const siteUrl = (inputs["site-url"] ?? "").trim().replace(/\/+$/, "");
  if (!siteUrl) throw new Error("Input site-url is required");
  const host = parseUrl("site-url", siteUrl).host;

  const key = (inputs.key ?? "").trim();
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(key)) {
    throw new Error("Input key must be 8-128 characters of a-z, A-Z, 0-9 and dashes (see indexnow.org)");
  }

  const sitemapUrl = inputs["sitemap-url"]?.trim() || `${siteUrl}/sitemap.xml`;
  parseUrl("sitemap-url", sitemapUrl);
  const keyLocation = inputs["key-location"]?.trim() || `${siteUrl}/${key}.txt`;
  parseUrl("key-location", keyLocation);
  const endpoint = inputs.endpoint?.trim() || "https://api.indexnow.org/indexnow";
  parseUrl("endpoint", endpoint);

  return {
    siteUrl,
    host,
    key,
    sitemapUrl,
    keyLocation,
    mode: /** @type {Config["mode"]} */ (oneOf("mode", inputs.mode?.trim() || "changed", ["changed", "all"])),
    onMissingState: /** @type {Config["onMissingState"]} */ (
      oneOf("on-missing-state", inputs["on-missing-state"]?.trim() || "baseline", ["baseline", "all"])
    ),
    endpoint,
    dryRun: oneOf("dry-run", inputs["dry-run"]?.trim() || "false", ["true", "false"]) === "true",
    cacheKeyPrefix: inputs["cache-key-prefix"]?.trim() || "indexnow-state",
  };
}

/**
 * Cache key naming. Keys are immutable, so every save gets a unique key and the
 * restore picks the most recent one by prefix. The host is part of the key so
 * several sites can share a repository; `_` separates it from the run id so
 * `example.com` doesn't prefix-match `example.com-foo`. The timestamp keeps keys
 * unique when the action runs more than once per job.
 * @param {Config} config
 * @param {{ runId: string, runAttempt: string, now?: number }} run
 */
export function cacheKeys(config, { runId, runAttempt, now = Date.now() }) {
  const safeHost = config.host.toLowerCase().replace(/[^a-z0-9.-]/g, "-");
  const restoreKey = `${config.cacheKeyPrefix}-${safeHost}_`;
  return { safeHost, restoreKey, saveKey: `${restoreKey}${runId}-${runAttempt}-${now}` };
}

/**
 * Reads the state file. Returns null (with a warning) when it is missing or unusable.
 * @param {string} file
 * @param {string} host
 * @param {(message: string) => void} warn
 * @returns {Promise<UrlMap | null>}
 */
export async function readState(file, host, warn) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
    throw error;
  }
  try {
    /** @type {State} */
    const state = JSON.parse(text);
    if (state.version !== STATE_VERSION) throw new Error(`unsupported version ${state.version}`);
    if (state.host !== host) throw new Error(`state is for host ${state.host}`);
    return new Map(Object.entries(state.urls));
  } catch (error) {
    warn(`Ignoring unusable state file ${file}: ${/** @type {Error} */ (error).message}`);
    return null;
  }
}

/**
 * @param {string} host
 * @param {UrlMap} urls
 * @returns {State}
 */
export function serializeState(host, urls) {
  return { version: STATE_VERSION, host, savedAt: new Date().toISOString(), urls: Object.fromEntries(urls) };
}

/**
 * @typedef {object} Result
 * @property {"baseline" | "changed" | "all"} kind what was done
 * @property {UrlMap} current URLs from the sitemap on the site's host
 * @property {string[]} offHost URLs skipped because they're on another host
 * @property {string[]} added
 * @property {string[]} updated
 * @property {string[]} removed
 * @property {string[]} urls URLs submitted (or, in dry-run, that would have been)
 * @property {import("./indexnow.mjs").BatchResult[]} responses
 * @property {boolean} saveState whether the caller should persist `current`
 */

/**
 * @typedef {object} Deps
 * @property {typeof fetch} [fetch]
 * @property {(message: string) => void} [log]
 * @property {(message: string) => void} [warn]
 * @property {number} [retryDelayMs]
 * @property {(ms: number) => Promise<void>} [sleep]
 */

/**
 * @param {Config} config
 * @param {UrlMap | null} previous state from the last successful run, null if none
 * @param {Deps} [deps]
 * @returns {Promise<Result>}
 */
export async function run(config, previous, deps = {}) {
  const { fetch: fetchFn = fetch, log = () => {}, warn = log, retryDelayMs, sleep } = deps;

  log(`Fetching ${config.sitemapUrl}`);
  const all = await fetchSitemap(config.sitemapUrl, { fetch: fetchFn, log, retryDelayMs });
  if (all.size === 0) {
    throw new Error(`No URLs found in ${config.sitemapUrl}; refusing to treat an empty sitemap as "no changes"`);
  }

  const { onHost: current, offHost } = partitionByHost(all, config.host);
  if (offHost.length > 0) {
    warn(
      `Skipping ${offHost.length} sitemap URLs not on ${config.host} (IndexNow would reject them): ` +
        offHost.slice(0, 5).join(", ") +
        (offHost.length > 5 ? ", ..." : ""),
    );
  }
  if (current.size === 0) throw new Error(`None of the ${all.size} sitemap URLs are on ${config.host}`);
  log(`Sitemap has ${current.size} URLs on ${config.host}`);

  /** @type {Result["kind"]} */
  let kind;
  let diff = { added: /** @type {string[]} */ ([]), updated: /** @type {string[]} */ ([]), removed: /** @type {string[]} */ ([]) };
  /** @type {string[]} */
  let urls;

  if (previous) {
    diff = diffUrls(previous, current);
    kind = config.mode;
    urls = config.mode === "all" ? [...current.keys(), ...diff.removed] : [...diff.added, ...diff.updated, ...diff.removed];
  } else if (config.mode === "all" || config.onMissingState === "all") {
    log("No previous state found; submitting all URLs");
    kind = "all";
    diff.added = [...current.keys()];
    urls = diff.added;
  } else {
    log("No previous state found; recording a baseline without submitting (on-missing-state: baseline)");
    kind = "baseline";
    urls = [];
  }

  /** @type {import("./indexnow.mjs").BatchResult[]} */
  let responses = [];
  if (urls.length > 0 && !config.dryRun) {
    responses = await submitUrls({
      endpoint: config.endpoint,
      host: config.host,
      key: config.key,
      keyLocation: config.keyLocation,
      urls,
      fetch: fetchFn,
      log,
      sleep,
      ...(retryDelayMs !== undefined && { retryDelayMs }),
    });
  }

  // Reached only when every batch was accepted; a failed submission throws and
  // leaves the old state in place so the next run retries.
  const saveState = !config.dryRun && (!previous || !sameUrls(previous, current));
  return { kind, current, offHost, ...diff, urls, responses, saveState };
}
