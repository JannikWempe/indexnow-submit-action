/**
 * @typedef {string | Uint8Array | number | ((init: RequestInit | undefined) => Response)} Route
 * A body, a status code, or a handler.
 */

/**
 * Fake fetch serving the given URL -> route map; records every request.
 * @param {Record<string, Route>} routes
 */
export function fakeFetch(routes) {
  /** @type {string[]} */
  const requested = [];
  const fn = /** @type {typeof fetch} */ (
    async (input, init) => {
      const url = String(input);
      requested.push(url);
      const route = routes[url];
      if (route === undefined) return new Response("not found", { status: 404 });
      if (typeof route === "function") return route(init);
      if (typeof route === "number") return new Response("error", { status: route });
      return new Response(route, { status: 200 });
    }
  );
  return Object.assign(fn, { requested });
}
