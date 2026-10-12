import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { batch, submitUrls } from "../src/indexnow.mjs";
import { startServer } from "./stub-server.mjs";

describe("batch", () => {
  it("splits into batches of at most the given size", () => {
    assert.deepEqual(batch([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(batch([1, 2], 2), [[1, 2]]);
    assert.deepEqual(batch([], 2), []);
  });

  it("defaults to 10,000 URLs per batch", () => {
    const batches = batch(Array.from({ length: 20_001 }, (_, i) => i));
    assert.deepEqual(
      batches.map((b) => b.length),
      [10_000, 10_000, 1],
    );
  });
});

describe("submitUrls", () => {
  /** @type {{ status: number, body: any }[]} */
  let requests = [];
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let server;

  before(async () => {
    server = await startServer({ onSubmit: (body, status) => requests.push({ status, body }) });
  });
  after(() => server.close());

  const options = (/** @type {Partial<import("../src/indexnow.mjs").SubmitOptions>} */ overrides) => ({
    endpoint: `${server.url}/indexnow`,
    host: "example.com",
    key: "abcdef123456",
    keyLocation: "https://example.com/abcdef123456.txt",
    urls: ["https://example.com/a", "https://example.com/b", "https://example.com/c"],
    retryDelayMs: 0,
    ...overrides,
  });

  it("posts the IndexNow payload in batches", async () => {
    requests = [];
    const results = await submitUrls(options({ batchSize: 2 }));
    assert.deepEqual(results, [
      { count: 2, status: 200 },
      { count: 1, status: 200 },
    ]);
    assert.deepEqual(
      requests.map((r) => r.body),
      [
        {
          host: "example.com",
          key: "abcdef123456",
          keyLocation: "https://example.com/abcdef123456.txt",
          urlList: ["https://example.com/a", "https://example.com/b"],
        },
        {
          host: "example.com",
          key: "abcdef123456",
          keyLocation: "https://example.com/abcdef123456.txt",
          urlList: ["https://example.com/c"],
        },
      ],
    );
  });

  it("sends JSON with a UTF-8 content type", async () => {
    /** @type {RequestInit | undefined} */
    let init;
    const fetch = /** @type {typeof globalThis.fetch} */ (
      async (_url, requestInit) => {
        init = requestInit;
        return new Response(null, { status: 200 });
      }
    );
    await submitUrls(options({ fetch }));
    assert.equal(init?.method, "POST");
    assert.deepEqual(init?.headers, { "Content-Type": "application/json; charset=utf-8" });
  });

  it("treats 202 as success", async () => {
    const results = await submitUrls(options({ endpoint: `${server.url}/indexnow?status=202` }));
    assert.deepEqual(results, [{ count: 3, status: 202 }]);
  });

  for (const status of [400, 403, 422]) {
    it(`fails on ${status} without retrying`, async () => {
      requests = [];
      await assert.rejects(
        submitUrls(options({ endpoint: `${server.url}/indexnow?status=${status}` })),
        new RegExp(`IndexNow responded ${status}.*stub error ${status}`),
      );
      assert.equal(requests.length, 1);
    });
  }

  it("retries 429 and 5xx with backoff, then fails", async () => {
    requests = [];
    /** @type {number[]} */
    const delays = [];
    await assert.rejects(
      submitUrls(
        options({
          endpoint: `${server.url}/indexnow?status=429`,
          retries: 3,
          retryDelayMs: 100,
          sleep: async (ms) => void delays.push(ms),
        }),
      ),
      /429/,
    );
    assert.equal(requests.length, 4);
    assert.deepEqual(delays, [100, 200, 400]);
  });

  it("recovers when a retry succeeds", async () => {
    const statuses = [503, 200];
    const fetch = /** @type {typeof globalThis.fetch} */ (
      async () => new Response(null, { status: statuses.shift() })
    );
    assert.deepEqual(await submitUrls(options({ fetch })), [{ count: 3, status: 200 }]);
  });

  it("retries network errors", async () => {
    let calls = 0;
    const fetch = /** @type {typeof globalThis.fetch} */ (
      async () => {
        if (calls++ === 0) throw new TypeError("fetch failed");
        return new Response(null, { status: 200 });
      }
    );
    assert.deepEqual(await submitUrls(options({ fetch })), [{ count: 3, status: 200 }]);
    assert.equal(calls, 2);
  });

  it("honors Retry-After", async () => {
    /** @type {number[]} */
    const delays = [];
    const statuses = [429, 200];
    const fetch = /** @type {typeof globalThis.fetch} */ (
      async () => new Response(null, { status: statuses.shift(), headers: { "Retry-After": "7" } })
    );
    await submitUrls(options({ fetch, sleep: async (ms) => void delays.push(ms) }));
    assert.deepEqual(delays, [7000]);
  });
});
