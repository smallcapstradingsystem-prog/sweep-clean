/**
 * concurrency.js — Shared concurrency helper.
 *
 * Runs an async function over a list of items with a bounded number
 * of concurrent calls. Preserves input order in the result array.
 *
 * Used to parallelize preview RPC calls (one per chain, one per
 * mnemonic) without blowing past RPC provider rate limits. The cap
 * is intentionally small because most providers rate-limit at 5-10
 * requests per second per IP.
 *
 * If a worker function throws, the error propagates and the returned
 * promise rejects. Callers that want per-item error isolation should
 * catch inside the worker function and return a sentinel value.
 */

export async function runWithConcurrency(items, limit, fn) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const cap = Math.max(1, Math.min(Number(limit) || 1, items.length));

  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = [];
  for (let i = 0; i < cap; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// The one number that matters. Tuned for public RPC endpoints, which
// typically rate-limit at 5-10 req/s per IP. If you switch to a
// dedicated Alchemy/Helius plan, you can raise this. If you start
// seeing 429s from the RPC proxy, lower it.
export const ESTIMATE_CONCURRENCY = 4;

// Alias for the preview loop's naming convention. Same value, same
// intent — kept as a separate name because "preview" and "estimate"
// are conceptually different phases even though they share a budget.
export const PREVIEW_CONCURRENCY = ESTIMATE_CONCURRENCY;