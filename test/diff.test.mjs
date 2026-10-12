import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffUrls, partitionByHost, sameUrls } from "../src/diff.mjs";

describe("diffUrls", () => {
  it("detects added, updated and removed URLs", () => {
    const previous = new Map([
      ["https://example.com/", "2026-01-01"],
      ["https://example.com/same-null", null],
      ["https://example.com/changed", "2026-01-01"],
      ["https://example.com/gains-lastmod", null],
      ["https://example.com/loses-lastmod", "2026-01-01"],
      ["https://example.com/removed", "2026-01-01"],
    ]);
    const current = new Map([
      ["https://example.com/", "2026-01-01"],
      ["https://example.com/same-null", null],
      ["https://example.com/changed", "2026-02-01"],
      ["https://example.com/gains-lastmod", "2026-02-01"],
      ["https://example.com/loses-lastmod", null],
      ["https://example.com/added", null],
    ]);
    assert.deepEqual(diffUrls(previous, current), {
      added: ["https://example.com/added"],
      updated: ["https://example.com/changed", "https://example.com/gains-lastmod", "https://example.com/loses-lastmod"],
      removed: ["https://example.com/removed"],
    });
  });

  it("returns nothing for identical maps", () => {
    const urls = new Map([["https://example.com/", "2026-01-01"]]);
    assert.deepEqual(diffUrls(urls, new Map(urls)), { added: [], updated: [], removed: [] });
  });
});

describe("sameUrls", () => {
  it("compares URLs and lastmods regardless of order", () => {
    const a = new Map([
      ["https://example.com/a", "1"],
      ["https://example.com/b", null],
    ]);
    assert.equal(sameUrls(a, new Map([...a].reverse())), true);
    assert.equal(sameUrls(a, new Map([...a, ["https://example.com/c", null]])), false);
    assert.equal(sameUrls(a, new Map([["https://example.com/a", "1"], ["https://example.com/b", "2"]])), false);
  });
});

describe("partitionByHost", () => {
  it("keeps URLs on the host and returns the others", () => {
    const urls = new Map([
      ["https://example.com/a", null],
      ["https://www.example.com/b", null],
      ["https://example.com:8443/c", null],
      ["not a url", null],
      ["http://example.com/d", "1"],
    ]);
    const { onHost, offHost } = partitionByHost(urls, "example.com");
    assert.deepEqual(
      onHost,
      new Map([
        ["https://example.com/a", null],
        ["http://example.com/d", "1"],
      ]),
    );
    assert.deepEqual(offHost, ["https://www.example.com/b", "https://example.com:8443/c", "not a url"]);
  });
});
