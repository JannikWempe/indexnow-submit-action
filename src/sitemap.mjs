// Fetching and parsing of sitemaps (https://www.sitemaps.org/protocol.html).

import { gunzipSync } from "node:zlib";
import { withRetry } from "./retry.mjs";

/**
 * URL -> lastmod (null when the sitemap entry has none)
 * @typedef {Map<string, string | null>} UrlMap
 */

/**
 * @typedef {{ type: "urlset", urls: UrlMap } | { type: "sitemapindex", sitemaps: string[] }} ParsedSitemap
 */

const ENTITIES = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

/**
 * Decodes the predefined XML entities and numeric character references.
 * @param {string} value
 * @returns {string}
 */
export function decodeXml(value) {
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(lt|gt|quot|apos|amp));/gi, (match, hex, dec, name) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (dec) return String.fromCodePoint(parseInt(dec, 10));
    return ENTITIES[/** @type {keyof typeof ENTITIES} */ (name.toLowerCase())] ?? match;
  });
}

/**
 * Returns the trimmed, decoded text content of the first `<tag>` child in `xml`.
 * Only unprefixed tags match, so `<image:loc>` is ignored when looking for `<loc>`.
 * @param {string} xml
 * @param {string} tag
 * @returns {string | null}
 */
function childText(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`));
  if (!match) return null;
  const cdata = match[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  const text = cdata ? cdata[1].trim() : decodeXml(match[1].trim());
  return text === "" ? null : text;
}

/**
 * Returns the inner XML of every unprefixed `<tag>` element.
 * @param {string} xml
 * @param {string} tag
 * @returns {string[]}
 */
function elements(xml, tag) {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, "g");
  return Array.from(xml.matchAll(pattern), (match) => match[1]);
}

/**
 * Parses a `<urlset>` or `<sitemapindex>` document.
 * @param {string} xml
 * @returns {ParsedSitemap}
 */
export function parseSitemap(xml) {
  const body = xml.replace(/<!--[\s\S]*?-->/g, "");

  if (/<sitemapindex[\s>]/.test(body)) {
    const sitemaps = elements(body, "sitemap")
      .map((entry) => childText(entry, "loc"))
      .filter((loc) => loc !== null);
    return { type: "sitemapindex", sitemaps };
  }

  if (!/<urlset[\s>]/.test(body)) {
    throw new Error("Not a sitemap: expected a <urlset> or <sitemapindex> root element");
  }

  /** @type {UrlMap} */
  const urls = new Map();
  for (const entry of elements(body, "url")) {
    const loc = childText(entry, "loc");
    if (loc) urls.set(loc, childText(entry, "lastmod"));
  }
  return { type: "urlset", urls };
}

/**
 * Decodes a response body, gunzipping it when it is gzip data (`.xml.gz` files are
 * usually served without a Content-Encoding header, so fetch doesn't decompress them).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeBody(bytes) {
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return new TextDecoder().decode(gzipped ? gunzipSync(bytes) : bytes);
}

/**
 * @typedef {object} FetchSitemapOptions
 * @property {typeof fetch} [fetch]
 * @property {number} [maxDepth] how many levels of sitemap indexes to follow
 * @property {number} [maxSitemaps] maximum number of sitemap documents to fetch
 * @property {number} [retryDelayMs]
 * @property {(message: string) => void} [log]
 */

/**
 * Fetches a sitemap and, for sitemap indexes, all child sitemaps.
 * @param {string} sitemapUrl
 * @param {FetchSitemapOptions} [options]
 * @returns {Promise<UrlMap>}
 */
export async function fetchSitemap(sitemapUrl, options = {}) {
  const { fetch: fetchFn = fetch, maxDepth = 3, maxSitemaps = 1000, retryDelayMs = 2000, log = () => {} } = options;
  /** @type {UrlMap} */
  const urls = new Map();
  const visited = new Set();

  /**
   * @param {string} url
   * @param {number} depth
   */
  async function visit(url, depth) {
    if (visited.has(url)) return;
    if (visited.size >= maxSitemaps) {
      throw new Error(`More than ${maxSitemaps} sitemaps, refusing to fetch ${url}`);
    }
    visited.add(url);

    const bytes = await withRetry(
      async () => {
        const res = await fetchFn(url, {
          headers: { "User-Agent": "indexnow-submit-action" },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          const error = new Error(`Failed to fetch sitemap ${url}: ${res.status} ${res.statusText}`);
          Object.assign(error, { retryable: res.status === 429 || res.status >= 500 });
          throw error;
        }
        return new Uint8Array(await res.arrayBuffer());
      },
      { retries: 2, delayMs: retryDelayMs, log },
    );

    let parsed;
    try {
      parsed = parseSitemap(decodeBody(bytes));
    } catch (error) {
      throw new Error(`Failed to parse sitemap ${url}: ${/** @type {Error} */ (error).message}`);
    }

    if (parsed.type === "urlset") {
      log(`${url}: ${parsed.urls.size} URLs`);
      for (const [loc, lastmod] of parsed.urls) urls.set(loc, lastmod);
      return;
    }

    log(`${url}: sitemap index with ${parsed.sitemaps.length} sitemaps`);
    if (depth >= maxDepth) {
      throw new Error(`Sitemap indexes nested deeper than ${maxDepth} levels at ${url}`);
    }
    for (const child of parsed.sitemaps) {
      await visit(new URL(child, url).href, depth + 1);
    }
  }

  await visit(sitemapUrl, 1);
  return urls;
}
