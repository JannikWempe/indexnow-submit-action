/** @typedef {import("./sitemap.mjs").UrlMap} UrlMap */

/**
 * @typedef {object} Diff
 * @property {string[]} added URLs not in the previous state
 * @property {string[]} updated URLs whose lastmod changed (including missing <-> present)
 * @property {string[]} removed URLs in the previous state but no longer in the sitemap
 */

/**
 * @param {UrlMap} previous
 * @param {UrlMap} current
 * @returns {Diff}
 */
export function diffUrls(previous, current) {
  /** @type {Diff} */
  const diff = { added: [], updated: [], removed: [] };
  for (const [url, lastmod] of current) {
    if (!previous.has(url)) diff.added.push(url);
    else if (previous.get(url) !== lastmod) diff.updated.push(url);
  }
  for (const url of previous.keys()) {
    if (!current.has(url)) diff.removed.push(url);
  }
  return diff;
}

/**
 * @param {UrlMap} a
 * @param {UrlMap} b
 * @returns {boolean}
 */
export function sameUrls(a, b) {
  if (a.size !== b.size) return false;
  for (const [url, lastmod] of a) {
    if (!b.has(url) || b.get(url) !== lastmod) return false;
  }
  return true;
}

/**
 * Splits URLs into those on `host` and the rest. IndexNow rejects URLs whose host
 * doesn't match the submitted host (422).
 * @param {UrlMap} urls
 * @param {string} host
 * @returns {{ onHost: UrlMap, offHost: string[] }}
 */
export function partitionByHost(urls, host) {
  /** @type {UrlMap} */
  const onHost = new Map();
  /** @type {string[]} */
  const offHost = [];
  for (const [url, lastmod] of urls) {
    let urlHost;
    try {
      urlHost = new URL(url).host;
    } catch {
      urlHost = null;
    }
    if (urlHost === host) onHost.set(url, lastmod);
    else offHost.push(url);
  }
  return { onHost, offHost };
}
