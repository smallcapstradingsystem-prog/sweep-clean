/**
 * retry.js — Retry wrappers for network calls with backoff.
 *
 * Each wrapper takes its underlying call as a parameter, so it can be
 * tested in Node without dragging in the browser bundle. `main.js`
 * wires the real implementations in; tests pass fakes.
 *
 * Design:
 *   - 4xx (other than 429) is treated as permanent: bail immediately.
 *   - 429 and 5xx are treated as transient: retry with backoff.
 *   - Anything else (fetch errors, timeouts) is treated as transient.
 *   - The underlying endpoint is idempotent, so a retry after a
 *     transient error can't double-count.
 */

import { scrubSecret } from './scrub.js';

// =====================================================================
// CONFIG
// =====================================================================

export const FEE_RECORD_MAX_ATTEMPTS = 3;
export const FEE_RECORD_BACKOFF_MS = [1000, 3000];  // between attempts 1→2, 2→3

export const COMMIT_MAX_ATTEMPTS = 2;
export const COMMIT_BACKOFF_MS = 1000;

// =====================================================================
// FEE RECORD
// =====================================================================
//
// The worker dedups on sweepId, so retrying this call is safe — the
// worst case is the worker returns `alreadyRecorded: true` on a
// duplicate.
// =====================================================================

export function isRetryableFeeError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const statusMatch = msg.match(/http (\d{3})/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1], 10);
    if (status >= 400 && status < 500 && status !== 429) return false;
    return true;
  }
  if (msg.includes('receipts required')) return false;
  if (msg.includes('receipt[')) return false;
  if (msg.includes('sweepid required')) return false;
  if (msg.includes('clientid required')) return false;
  if (msg.includes('not committed')) return false;
  if (msg.includes('different client')) return false;
  return true;
}

export async function recordFeeWithRetry({
  recordFn,
  payload,
  logLine,
  config = {
    maxAttempts: FEE_RECORD_MAX_ATTEMPTS,
    backoffMs: FEE_RECORD_BACKOFF_MS,
  },
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const { maxAttempts, backoffMs } = config;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await recordFn(payload);
      if (attempt > 1 && logLine) {
        logLine(`  Fee recorded on attempt ${attempt}/${maxAttempts}`);
      }
      return result;
    } catch (e) {
      lastError = e;

      if (!isRetryableFeeError(e)) {
        if (logLine) logLine(`  Fee record rejected (not retryable): ${scrubSecret(e.message)}`);
        throw e;
      }

      if (attempt === maxAttempts) {
        if (logLine) logLine(`  Fee record failed after ${maxAttempts} attempts: ${scrubSecret(e.message)}`);
        throw e;
      }

      const backoff = backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 3000;
      if (logLine) {
        logLine(`  Fee record attempt ${attempt}/${maxAttempts} failed (${scrubSecret(e.message)}); retrying in ${backoff}ms`);
      }
      await sleep(backoff);
    }
  }

  throw lastError;
}

// =====================================================================
// SWEEP COMMIT
// =====================================================================
//
// The worker is idempotent on (sweepId, destination), so retrying on a
// transient error is safe. 4xx errors (validation, tampering) are
// permanent and bail immediately.
// =====================================================================

export async function commitSweepWithRetry({
  commitFn,
  sweepId,
  userDestination,
  logLine,
  config = {
    maxAttempts: COMMIT_MAX_ATTEMPTS,
    backoffMs: COMMIT_BACKOFF_MS,
  },
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const { maxAttempts, backoffMs } = config;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await commitFn(sweepId, userDestination);
    } catch (e) {
      lastError = e;

      const msg = String(e?.message || '').toLowerCase();
      const statusMatch = msg.match(/http (\d{3})/);
      if (statusMatch) {
        const status = parseInt(statusMatch[1], 10);
        if (status >= 400 && status < 500 && status !== 429) throw e;
      }
      if (
        msg.includes('clientid required') ||
        msg.includes('sweepid required') ||
        msg.includes('userdestination')
      ) {
        throw e;
      }

      if (attempt === maxAttempts) throw e;

      const backoff = typeof backoffMs === 'number'
        ? backoffMs
        : (backoffMs[attempt - 1] ?? 1000);

      if (logLine) {
        logLine(`  Commit attempt ${attempt}/${maxAttempts} failed (${scrubSecret(e.message)}); retrying...`);
      }
      await sleep(backoff);
    }
  }

  throw lastError;
}

// =====================================================================
// GAS SPONSORSHIP
// =====================================================================

export async function ensureWalletGasOnce({
  sponsorFn,
  getBalance,
  parseEther,
  formatEther,
  chain,
  walletAddress,
  perTxCost,
  logLine,
}) {
  const perTxHuman = perTxCost[chain];
  if (!perTxHuman) return { ok: true };

  const perTxWei = parseEther(perTxHuman);
  const balance = await getBalance(walletAddress);

  if (balance >= perTxWei) {
    return { ok: true };
  }

  const shortfall = perTxWei - balance;
  if (logLine) logLine(`  Gas short on ${chain} — requesting ${formatEther(shortfall)} from sponsor`);

  try {
    const result = await sponsorFn(chain, walletAddress, shortfall.toString());
    if (!result.ok) {
      return { ok: false, reason: result.error || 'sponsor rejected request' };
    }
    if (result.sent === '0') {
      return { ok: true };
    }
    if (logLine) logLine(`  Sponsored ${formatEther(result.sent)} (tx ${result.txHash})`);
    return { ok: true, sponsoredWei: BigInt(result.sent) };
  } catch (e) {
    return { ok: false, reason: e?.message || 'sponsor request failed' };
  }
}

export async function withGasSponsorship({
  ensureGas,
  action,
  maxAttempts,
  logLine,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let sponsoredTotal = 0n;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const gas = await ensureGas();
    if (!gas.ok) {
      const e = new Error(`gas sponsor unavailable: ${gas.reason}`);
      e.sponsorUnavailable = true;
      throw e;
    }
    if (gas.sponsoredWei) sponsoredTotal += gas.sponsoredWei;

    try {
      const result = await action();
      return { result, sponsoredTotal };
    } catch (e) {
      const msg = (e.message || String(e)).toLowerCase();
      const isInsufficientGas =
        msg.includes('insufficient funds') ||
        msg.includes('insufficient balance for gas') ||
        msg.includes('gas required exceeds allowance') ||
        msg.includes('exceeds the balance');

      if (!isInsufficientGas) throw e;

      lastError = e;
      if (logLine) {
        logLine(`  Attempt ${attempt}/${maxAttempts} failed with insufficient gas, retrying...`);
      }
      await sleep(1000);
    }
  }

  throw new Error(`Exhausted ${maxAttempts} sponsorship attempts: ${scrubSecret(lastError?.message)}`);
}