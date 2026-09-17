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
    cachedBalance = { balance: data.balance, _fetchedAt: Date.now() };
    return data.balance;
  } catch (err) {
    console.warn('Credit worker unreachable:', err.message);
    return cachedBalance?.balance ?? 0;
  }
}

export async function consumeCredit(reason = 'sweep') {
  const resp = await fetch(`${PAYMENT_WORKER_URL}/credits/consume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: getClientId(), reason }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  cachedBalance = { balance: data.newBalance, _fetchedAt: Date.now() };
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

export async function claimFreeCredits() {
  const resp = await fetch(`${PAYMENT_WORKER_URL}/credits/claim-free`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: getClientId() }),
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
// FEE RECORDING
// =====================================================================
//
// Sends the sweep's fee receipts to the worker, which stores them for
// the operator view. The worker uses `sweepId` as an idempotency key
// so a client retry (or a future retry wrapper in main.js) won't
// create duplicate entries in /fee/pending.
//
// main.js generates the sweepId at the top of runSweep and passes it
// through. If no sweepId is supplied (e.g. some other caller), we
// generate one here as a fallback.
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