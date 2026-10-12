// Local stand-in for a website and the IndexNow API, used by tests and CI.
//
//   node test/stub-server.mjs <port> <site-dir> <requests-file>
//
// - GET /<path> serves files from <site-dir>; /<name>.gz is the gzipped <name>.
// - POST /indexnow records the JSON body as a line in <requests-file> and
//   responds 200, or the status given by the `status` query parameter.

import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, normalize } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * @param {{ port?: number, siteDir?: string, onSubmit?: (body: any, status: number) => void }} options
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startServer({ port = 0, siteDir, onSubmit = () => {} }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "POST" && url.pathname === "/indexnow") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const status = Number(url.searchParams.get("status") ?? 200);
      onSubmit(JSON.parse(body), status);
      res.writeHead(status, { "Content-Type": "text/plain" }).end(status >= 400 ? `stub error ${status}` : "");
      return;
    }

    if (req.method === "GET" && siteDir) {
      const path = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
      try {
        if (path.endsWith(".gz")) {
          const xml = await readFile(join(siteDir, path.slice(0, -3)));
          res.writeHead(200, { "Content-Type": "application/gzip" }).end(gzipSync(xml));
        } else {
          res.writeHead(200, { "Content-Type": "application/xml" }).end(await readFile(join(siteDir, path)));
        }
      } catch {
        res.writeHead(404).end("not found");
      }
      return;
    }

    res.writeHead(404).end("not found");
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      const address = /** @type {import("node:net").AddressInfo} */ (server.address());
      resolve({
        url: `http://localhost:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [port, siteDir, requestsFile] = process.argv.slice(2);
  const { url } = await startServer({
    port: Number(port),
    siteDir,
    onSubmit: (body, status) => appendFileSync(requestsFile, JSON.stringify({ status, body }) + "\n"),
  });
  console.log(`Stub server listening on ${url}, serving ${siteDir}`);
}
