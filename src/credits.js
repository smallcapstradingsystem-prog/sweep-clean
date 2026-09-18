/**
 * credits.js — Client-side credit management + fee recording + gas sponsorship.
 */

import { WORKER_SUBDOMAIN } from './env.js';

const PAYMENT_WORKER_URL = `https://sweep-payment.${WORKER_SUBDOMAIN}.workers.dev`;
const CLIENT_ID_KEY = 'sweep_client_id';
const CACHE_MS = 30 * 1000;

let cachedBalance = null;

// =====================================================================
// CLIENT IDENTITY
// =====================================================================

export function getClientId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id || id.length < 16) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

export function resetClientId() {
  localStorage.removeItem(CLIENT_ID_KEY);
  cachedBalance = null;
}

// =====================================================================
// CREDIT BALANCE
// =====================================================================
//
// The cached shape is now { balance, free, freeExpiresAt, _fetchedAt }.
// `balance` is the effective total (paid + live free pool), which is
// what the badge and every gate should check. `free` and
// `freeExpiresAt` are for the badge copy ("2 credits · 23h left") and
// for anything that needs to distinguish free from paid.
// =====================================================================

export async function fetchBalance(opts = {}) {
  if (!opts.force && cachedBalance !== null) {
    const age = Date.now() - cachedBalance._fetchedAt;
    if (age < CACHE_MS) return cachedBalance.balance;
  }
  try {
    const resp = await fetch(`${PAYMENT_WORKER_URL}/credits/balance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: getClientId() }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    cachedBalance = {
      balance: data.balance,
      free: data.free ?? 0,
      freeExpiresAt: data.freeExpiresAt ?? null,
      _fetchedAt: Date.now(),
    };
    return data.balance;
  } catch (err) {
    console.warn('Credit worker unreachable:', err.message);
    return cachedBalance?.balance ?? 0;
  }
}

/**
 * Full snapshot of the current balance state: effective total, paid
 * count, free count, and the free-pool expiry timestamp. Prefer this
 * over fetchBalance() when you need any field other than `balance`.
 */
export async function fetchBalanceSnapshot(opts = {}) {
  await fetchBalance(opts);
  return cachedBalance ? { ...cachedBalance } : null;
}

export async function consumeCredit(reason = 'sweep', sweepId = null) {
  const body = { clientId: getClientId(), reason };
  if (sweepId) body.sweepId = sweepId;

  const resp = await fetch(`${PAYMENT_WORKER_URL}/credits/consume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  // The consume response carries pool info; mirror it into the cache
  // so a subsequent render doesn't need a round-trip to reflect the
  // decremented state.
  cachedBalance = {
    balance: data.newBalance,
    free: cachedBalance ? Math.max(0, (cachedBalance.free || 0) - (data.pool === 'free' ? 1 : 0)) : 0,
    freeExpiresAt: cachedBalance?.freeExpiresAt ?? null,
    _fetchedAt: Date.now(),
  };
  return data.newBalance;
}

export function invalidateBalanceCache() {
  cachedBalance = null;
}

// =====================================================================
// FREE CREDITS
// =====================================================================

export async function fetchClaimInfo() {
  const resp = await fetch(`${PAYMENT_WORKER_URL}/credits/claim-info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: getClientId() }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

export async function claimFreeCredits(fingerprint) {
  const body = { clientId: getClientId() };
  if (fingerprint) body.fingerprint = fingerprint;

  const resp = await fetch(`${PAYMENT_WORKER_URL}/credits/claim-free`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  if (data.creditsGranted > 0) invalidateBalanceCache();
  return data;
}

// =====================================================================
// CRYPTO PAYMENT
// =====================================================================

export async function requestCryptoQuote(bundle, method) {
  const resp = await fetch(`${PAYMENT_WORKER_URL}/crypto/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: getClientId(), bundle, method }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

export async function verifyCryptoPayment(paymentId) {
  const resp = await fetch(`${PAYMENT_WORKER_URL}/crypto/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payment_id: paymentId }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  if (data.ok) invalidateBalanceCache();
  return data;
}

export async function pollCryptoPayment(paymentId, { timeoutMs = 30 * 60 * 1000, intervalMs = 5000, onTick } = {}) {
  const start = Date.now();
  let attempt = 0;
  const total = Math.floor(timeoutMs / intervalMs);
  while (Date.now() - start < timeoutMs) {
    attempt++;
    if (onTick) onTick(attempt, total);
    try {
      const result = await verifyCryptoPayment(paymentId);
      if (result.ok) return result;
    } catch (err) {
      console.warn('Polling error:', err.message);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Payment verification timed out');
}

// =====================================================================
// GAS SPONSORSHIP
// =====================================================================

export async function requestGasSponsorship(chain, toAddress, shortfallWei) {
  const resp = await fetch(`${PAYMENT_WORKER_URL}/gas/sponsor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chain, toAddress, shortfallWei }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

// =====================================================================
// SWEEP COMMIT
// =====================================================================

export async function commitSweep(sweepId, userDestination) {
  const resp = await fetch(`${PAYMENT_WORKER_URL}/sweep/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: getClientId(),
      sweepId,
      userDestination,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

// =====================================================================
// FEE RECORDING
// =====================================================================

export async function recordFee(sweepRecord) {
  const sweepId = sweepRecord.sweepId || crypto.randomUUID();

  const resp = await fetch(`${PAYMENT_WORKER_URL}/fee/record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: getClientId(),
      sweepId,
      receipts: sweepRecord.receipts,
      gasSponsorships: sweepRecord.gasSponsorships || [],
      sweepDurationMs: sweepRecord.sweepDurationMs || 0,
      successes: sweepRecord.successes || 0,
      failures: sweepRecord.failures || 0,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

export { PAYMENT_WORKER_URL };