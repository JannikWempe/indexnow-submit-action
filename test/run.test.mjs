import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cacheKeys, joinWithinLimit, parseConfig, readState, run, serializeState } from "../src/run.mjs";
import { fakeFetch } from "./helpers.mjs";

const config = parseConfig({ "site-url": "https://example.com/", key: "abcdef123456" });
const ENDPOINT = "https://api.indexnow.org/indexnow";
const SITEMAP = `<urlset>
  <url><loc>https://example.com/</loc><lastmod>2026-01-01</lastmod></url>
  <url><loc>https://example.com/updated</loc><lastmod>2026-02-01</lastmod></url>
  <url><loc>https://example.com/added</loc></url>
  <url><loc>https://other.example.com/skipped</loc></url>
</urlset>`;
const PREVIOUS = new Map([
  ["https://example.com/", "2026-01-01"],
  ["https://example.com/updated", "2026-01-01"],
  ["https://example.com/removed", null],
]);

/** @param {Record<string, import("./helpers.mjs").Route>} [routes] */
function setup(routes = {}) {
  /** @type {any[]} */
  const submitted = [];
  const fetch = fakeFetch({
    "https://example.com/sitemap.xml": SITEMAP,
    [ENDPOINT]: (init) => {
      submitted.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    },
    ...routes,
  });
  /** @type {string[]} */
  const warnings = [];
  return { fetch, submitted, warnings, deps: { fetch, warn: (/** @type {string} */ m) => void warnings.push(m), retryDelayMs: 0 } };
}

describe("parseConfig", () => {
  it("applies defaults", () => {
    assert.deepEqual(config, {
      siteUrl: "https://example.com",
      host: "example.com",
      key: "abcdef123456",
      sitemapUrl: "https://example.com/sitemap.xml",
      keyLocation: "https://example.com/abcdef123456.txt",
      mode: "changed",
      onMissingState: "baseline",
      endpoint: ENDPOINT,
      dryRun: false,
      cacheKeyPrefix: "indexnow-state",
    });
  });

  it("rejects invalid inputs", () => {
    const base = { "site-url": "https://example.com", key: "abcdef123456" };
    assert.throws(() => parseConfig({ ...base, "site-url": "" }), /site-url is required/);
    assert.throws(() => parseConfig({ ...base, "site-url": "example.com" }), /site-url must be an http/);
    assert.throws(() => parseConfig({ ...base, key: "short" }), /key must be/);
    assert.throws(() => parseConfig({ ...base, mode: "everything" }), /mode must be one of/);
    assert.throws(() => parseConfig({ ...base, "on-missing-state": "skip" }), /on-missing-state must be one of/);
    assert.throws(() => parseConfig({ ...base, "dry-run": "yes" }), /dry-run must be one of/);
  });
});

describe("cacheKeys", () => {
  it("includes the host and keeps the restore key from prefix-matching other hosts", () => {
    const keys = cacheKeys(parseConfig({ "site-url": "http://localhost:8080", key: "abcdef123456" }), {
      runId: "42",
      runAttempt: "2",
      now: 1700000000000,
    });
    assert.deepEqual(keys, {
      safeHost: "localhost-8080",
      restoreKey: "indexnow-state-localhost-8080_",
      saveKey: "indexnow-state-localhost-8080_42-2-1700000000000",
    });
    const other = cacheKeys(parseConfig({ "site-url": "http://localhost", key: "abcdef123456" }), keys);
    assert.equal(keys.saveKey.startsWith(other.restoreKey), false);
  });
});

describe("readState", () => {
  it("round-trips the state and rejects state for another host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "indexnow-"));
    const file = join(dir, "state.json");
    /** @type {string[]} */
    const warnings = [];
    const warn = (/** @type {string} */ m) => void warnings.push(m);

    assert.equal(await readState(file, "example.com", warn), null);

    await writeFile(file, JSON.stringify(serializeState("example.com", PREVIOUS)));
    assert.deepEqual(await readState(file, "example.com", warn), PREVIOUS);
    assert.equal(await readState(file, "other.com", warn), null);

    await writeFile(file, "{not json");
    assert.equal(await readState(file, "example.com", warn), null);
    assert.equal(warnings.length, 2);
  });
});

describe("run", () => {
  it("submits added, updated and removed URLs on the host", async () => {
    const { submitted, warnings, deps } = setup();
    const result = await run(config, PREVIOUS, deps);
    assert.equal(result.kind, "changed");
    assert.deepEqual(result.added, ["https://example.com/added"]);
    assert.deepEqual(result.updated, ["https://example.com/updated"]);
    assert.deepEqual(result.removed, ["https://example.com/removed"]);
    assert.deepEqual(submitted, [
      {
        host: "example.com",
        key: "abcdef123456",
        keyLocation: "https://example.com/abcdef123456.txt",
        urlList: ["https://example.com/added", "https://example.com/updated", "https://example.com/removed"],
      },
    ]);
    assert.equal(result.saveState, true);
    assert.equal(result.current.has("https://other.example.com/skipped"), false);
    assert.deepEqual(result.offHost, ["https://other.example.com/skipped"]);
    assert.match(warnings[0], /Skipping 1 sitemap URLs/);
  });

  it("submits and saves nothing when nothing changed", async () => {
    const { submitted, deps } = setup();
    const unchanged = new Map(PREVIOUS);
    unchanged.delete("https://example.com/removed");
    unchanged.set("https://example.com/updated", "2026-02-01");
    unchanged.set("https://example.com/added", null);
    const result = await run(config, unchanged, deps);
    assert.deepEqual(result.urls, []);
    assert.deepEqual(submitted, []);
    assert.equal(result.saveState, false);
  });

  it("records a baseline without submitting when there is no state", async () => {
    const { submitted, warnings, deps } = setup();
    const result = await run(config, null, deps);
    assert.equal(result.kind, "baseline");
    assert.deepEqual(result.urls, []);
    assert.deepEqual(submitted, []);
    assert.equal(result.saveState, true);
    assert.match(warnings.at(-1) ?? "", /No previous state found/);
  });

  it("submits everything when there is no state and on-missing-state is all", async () => {
    const { submitted, deps } = setup();
    const result = await run({ ...config, onMissingState: "all" }, null, deps);
    assert.equal(result.kind, "all");
    assert.equal(submitted[0].urlList.length, 3);
    assert.equal(result.added.length, 3);
  });

  it("submits every URL plus removed ones in mode all", async () => {
    const { submitted, deps } = setup();
    const result = await run({ ...config, mode: "all" }, PREVIOUS, deps);
    assert.equal(result.kind, "all");
    assert.deepEqual(submitted[0].urlList, [
      "https://example.com/",
      "https://example.com/updated",
      "https://example.com/added",
      "https://example.com/removed",
    ]);
    assert.equal(result.saveState, true);
  });

  it("neither submits nor saves in dry-run", async () => {
    const { submitted, deps } = setup();
    const result = await run({ ...config, dryRun: true }, PREVIOUS, deps);
    assert.equal(result.urls.length, 3);
    assert.deepEqual(submitted, []);
    assert.equal(result.saveState, false);
  });

  it("fails on an empty sitemap", async () => {
    const { deps } = setup({ "https://example.com/sitemap.xml": "<urlset></urlset>" });
    await assert.rejects(run(config, PREVIOUS, deps), /No URLs found/);
  });

  it("fails when no URL is on the host", async () => {
    const { deps } = setup({
      "https://example.com/sitemap.xml": "<urlset><url><loc>https://www.example.com/</loc></url></urlset>",
    });
    await assert.rejects(run(config, PREVIOUS, deps), /None of the 1 sitemap URLs are on example.com/);
  });

  it("propagates submission failures so state isn't saved", async () => {
    const { deps } = setup({ [ENDPOINT]: () => new Response("invalid key", { status: 403 }) });
    await assert.rejects(run(config, PREVIOUS, deps), /403.*invalid key/);
  });
});

describe("joinWithinLimit", () => {
  it("joins everything that fits", () => {
    assert.deepEqual(joinWithinLimit(["ab", "cd"], 5), { text: "ab\ncd", count: 2 });
  });

  it("keeps only whole lines", () => {
    assert.deepEqual(joinWithinLimit(["ab", "cd", "ef"], 6), { text: "ab\ncd", count: 2 });
    assert.deepEqual(joinWithinLimit(["abc"], 2), { text: "", count: 0 });
  });
});
