import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { fakeFetch } from "./helpers.mjs";
import { decodeBody, decodeXml, fetchSitemap, parseSitemap } from "../src/sitemap.mjs";

describe("decodeXml", () => {
  it("decodes predefined and numeric entities", () => {
    assert.equal(decodeXml("a&amp;b&lt;c&gt;&quot;&apos;&#39;&#x27;&#228;"), "a&b<c>\"'''ä");
  });

  it("decodes &amp; only once", () => {
    assert.equal(decodeXml("&amp;lt;"), "&lt;");
  });

  it("leaves unknown entities alone", () => {
    assert.equal(decodeXml("&nbsp;"), "&nbsp;");
  });
});

describe("parseSitemap", () => {
  it("parses a urlset with lastmod", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/</loc><lastmod>2026-01-01</lastmod></url>
        <url>
          <loc>
            https://example.com/about
          </loc>
          <lastmod> 2026-02-01T10:00:00+00:00 </lastmod>
          <changefreq>daily</changefreq>
        </url>
      </urlset>`;
    assert.deepEqual(parseSitemap(xml), {
      type: "urlset",
      urls: new Map([
        ["https://example.com/", "2026-01-01"],
        ["https://example.com/about", "2026-02-01T10:00:00+00:00"],
      ]),
    });
  });

  it("records a missing lastmod as null", () => {
    const parsed = parseSitemap("<urlset><url><loc>https://example.com/a</loc></url></urlset>");
    assert.deepEqual(parsed, { type: "urlset", urls: new Map([["https://example.com/a", null]]) });
  });

  it("decodes entities and CDATA in loc", () => {
    const xml = `<urlset>
      <url><loc>https://example.com/?a=1&amp;b=2</loc></url>
      <url><loc><![CDATA[https://example.com/?c=3&d=4]]></loc></url>
    </urlset>`;
    const parsed = parseSitemap(xml);
    assert.equal(parsed.type, "urlset");
    assert.deepEqual([...parsed.urls.keys()], ["https://example.com/?a=1&b=2", "https://example.com/?c=3&d=4"]);
  });

  it("tolerates attributes and ignores extension tags like image:loc", () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
      <url id="1">
        <image:image><image:loc>https://cdn.example.com/a.png</image:loc></image:image>
        <loc type="x">https://example.com/a</loc>
        <lastmod >2026-01-01</lastmod >
      </url>
    </urlset>`;
    const parsed = parseSitemap(xml);
    assert.deepEqual(parsed, { type: "urlset", urls: new Map([["https://example.com/a", "2026-01-01"]]) });
  });

  it("ignores commented-out entries and entries without loc", () => {
    const xml = `<urlset>
      <!-- <url><loc>https://example.com/commented</loc></url> -->
      <url><lastmod>2026-01-01</lastmod></url>
      <url><loc>  </loc></url>
      <url><loc>https://example.com/a</loc></url>
    </urlset>`;
    const parsed = parseSitemap(xml);
    assert.equal(parsed.type, "urlset");
    assert.deepEqual([...parsed.urls.keys()], ["https://example.com/a"]);
  });

  it("returns an empty map for an empty urlset", () => {
    assert.deepEqual(parseSitemap('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>'), {
      type: "urlset",
      urls: new Map(),
    });
    assert.deepEqual(parseSitemap("<urlset></urlset>"), { type: "urlset", urls: new Map() });
  });

  it("parses a sitemap index", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://example.com/sitemap-1.xml</loc><lastmod>2026-01-01</lastmod></sitemap>
        <sitemap><loc>https://example.com/sitemap-2.xml.gz</loc></sitemap>
      </sitemapindex>`;
    assert.deepEqual(parseSitemap(xml), {
      type: "sitemapindex",
      sitemaps: ["https://example.com/sitemap-1.xml", "https://example.com/sitemap-2.xml.gz"],
    });
  });

  it("rejects documents that aren't sitemaps", () => {
    assert.throws(() => parseSitemap("<!doctype html><html><body>Not found</body></html>"), /Not a sitemap/);
  });
});

describe("decodeBody", () => {
  it("passes plain text through and gunzips gzip data", () => {
    const xml = "<urlset></urlset>";
    assert.equal(decodeBody(new TextEncoder().encode(xml)), xml);
    assert.equal(decodeBody(gzipSync(xml)), xml);
  });
});

describe("fetchSitemap", () => {
  it("follows sitemap indexes, resolves relative locs and gunzips children", async () => {
    const fetch = fakeFetch({
      "https://example.com/sitemap.xml": `<sitemapindex>
          <sitemap><loc>https://example.com/pages.xml</loc></sitemap>
          <sitemap><loc>/blog.xml.gz</loc></sitemap>
        </sitemapindex>`,
      "https://example.com/pages.xml": "<urlset><url><loc>https://example.com/</loc></url></urlset>",
      "https://example.com/blog.xml.gz": gzipSync(
        "<urlset><url><loc>https://example.com/blog</loc><lastmod>2026-01-01</lastmod></url></urlset>",
      ),
    });
    const urls = await fetchSitemap("https://example.com/sitemap.xml", { fetch });
    assert.deepEqual(
      urls,
      new Map([
        ["https://example.com/", null],
        ["https://example.com/blog", "2026-01-01"],
      ]),
    );
  });

  it("doesn't loop on cyclic sitemap indexes", async () => {
    const fetch = fakeFetch({
      "https://example.com/a.xml": "<sitemapindex><sitemap><loc>https://example.com/b.xml</loc></sitemap></sitemapindex>",
      "https://example.com/b.xml": "<sitemapindex><sitemap><loc>https://example.com/a.xml</loc></sitemap></sitemapindex>",
    });
    assert.deepEqual(await fetchSitemap("https://example.com/a.xml", { fetch }), new Map());
    assert.deepEqual(fetch.requested, ["https://example.com/a.xml", "https://example.com/b.xml"]);
  });

  it("limits the nesting depth", async () => {
    const fetch = fakeFetch({
      "https://example.com/1.xml": "<sitemapindex><sitemap><loc>https://example.com/2.xml</loc></sitemap></sitemapindex>",
      "https://example.com/2.xml": "<sitemapindex><sitemap><loc>https://example.com/3.xml</loc></sitemap></sitemapindex>",
    });
    await assert.rejects(fetchSitemap("https://example.com/1.xml", { fetch, maxDepth: 2 }), /nested deeper than 2/);
  });

  it("limits the number of sitemaps", async () => {
    const children = Array.from({ length: 3 }, (_, i) => `<sitemap><loc>https://example.com/${i}.xml</loc></sitemap>`);
    const fetch = fakeFetch({
      "https://example.com/sitemap.xml": `<sitemapindex>${children.join("")}</sitemapindex>`,
      "https://example.com/0.xml": "<urlset></urlset>",
      "https://example.com/1.xml": "<urlset></urlset>",
    });
    await assert.rejects(fetchSitemap("https://example.com/sitemap.xml", { fetch, maxSitemaps: 3 }), /More than 3 sitemaps/);
  });

  it("fails on 404 without retrying", async () => {
    const fetch = fakeFetch({});
    await assert.rejects(fetchSitemap("https://example.com/sitemap.xml", { fetch, retryDelayMs: 0 }), /404/);
    assert.equal(fetch.requested.length, 1);
  });

  it("retries 5xx", async () => {
    const fetch = fakeFetch({ "https://example.com/sitemap.xml": 503 });
    await assert.rejects(fetchSitemap("https://example.com/sitemap.xml", { fetch, retryDelayMs: 0 }), /503/);
    assert.equal(fetch.requested.length, 3);
  });
});
