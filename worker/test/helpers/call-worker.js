/**
 * call-worker.js — Utilities for invoking individual handlers the
 * way the router would, plus a fake `fetch` installer for stubbing
 * outbound calls (Etherscan, Helius, mempool.space, RPC).
 */

const DEFAULT_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Operator-Secret',
};

/**
 * Build a Request-like object the handlers can consume. The handlers
 * only ever call `request.json()`, `request.method`, and
 * `request.headers.get(...)`, so a minimal object is enough.
 */
export function makeRequest({ method = 'POST', body = null, headers = {} } = {}) {
  return {
    method,
    headers: {
      get(name) { return headers[name] || headers[name.toLowerCase()] || null; },
    },
    async json() {
      if (body === null) throw new Error('No JSON body');
      return body;
    },
  };
}

/**
 * Parse the Response returned by a handler. Handlers always return
 * JSON, so this is trivial.
 */
export async function readResponse(response) {
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

/**
 * Install a `fetch` mock. Caller passes a function `(url, init) => Response`
 * and gets back a handle with `.calls` (array of { url, init }) and
 * `.restore()`.
 *
 * By default any URL not covered throws — that way a test that forgot
 * to stub an outbound call fails loudly instead of silently hitting
 * the network.
 */
export function installFetchMock(handler) {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, init = {}) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    calls.push({ url: urlStr, init });

    const result = await handler(urlStr, init, calls);
    if (result === undefined) {
      throw new Error(`fetch mock: unhandled URL ${urlStr}`);
    }
    return result;
  };

  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

/**
 * Build a fake fetch Response from a plain object. Handlers use
 * `resp.ok`, `resp.status`, `resp.json()`, and `resp.text()`.
 */
export function jsonResponse(body, { status = 200 } = {}) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return JSON.parse(text); },
    async text() { return text; },
  };
}

/**
 * Build a Response that returns raw text (used by scanEvmChain's
 * error paths, mempool.space, etc).
 */
export function textResponse(text, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return JSON.parse(text); },
    async text() { return text; },
  };
}

export { DEFAULT_CORS };