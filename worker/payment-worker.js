/**
 * payment-worker.js — Cloudflare Worker
 * =====================================================================
 * Endpoints:
 *   POST /crypto/quote          — generate a payment address + amount
 *   POST /crypto/verify         — check if crypto payment arrived
 *   POST /credits/balance       — get credit balance for a client ID
 *   POST /credits/consume       — consume one credit
 *   POST /credits/claim-info    — read free-credit claim window state
 *   POST /credits/claim-free    — grant 2 free credits if within window
 *   POST /gas/sponsor           — fund a user wallet with native gas
 *   POST /sweep/commit          — commit a sweep's destination (server-authoritative)
 *   POST /fee/record            — record sweep receipts
 *   GET  /fee/pending           — operator view: pending forwards
 *   GET  /fee/summary           — operator view: totals by chain
 *   POST /fee/mark-forwarded    — operator view: mark a sweep forwarded
 *   POST /admin/credits/grant   — grant credits to a client (operator)
 *   POST /admin/credits/lookup  — read balance + history for a client (operator)
 *   GET  /admin/credits/list    — enumerate client balances (operator)
 *   POST /admin/clients/lookup-by-fingerprint — find clients by fingerprint (operator)
 *   GET  /health                — health check
 *
 * Required secrets:
 *   CRYPTO_ADDRESS_EVM       — 0x... receiving address (all EVM chains)
 *   CRYPTO_ADDRESS_SOL       — base58 receiving address on Solana
 *   CRYPTO_ADDRESS_BTC       — bc1q... receiving address on Bitcoin
 *   ETHERSCAN_API_KEY        — unified Etherscan V2 key
 *   HELIUS_API_KEY
 *   GAS_SPONSOR_KEY          — EVM gas sponsor wallet. Accepts EITHER:
 *                              - a 0x-prefixed 64-char hex private key, OR
 *                              - a BIP-39 mnemonic (12/15/18/21/24 words)
 *                              The wallet address is derived at runtime.
 *   OPERATOR_SECRET          — password for /fee/* and /admin/* endpoints.
 *                              Must be strong (32+ random bytes) since there
 *                              is no Cloudflare Access layer in front of the
 *                              operator dashboard.
 *
 * KV namespaces:
 *   CREDITS             — paid balances, free-credit pool, history, free-claim
 *                         state, rate limits, fee records, sweep commits,
 *                         idempotency keys, admin rate limits, client metadata
 *   PENDING_PAYMENTS    — crypto payment records
 *
 * Free-credit model:
 *   The launch bonus grants 2 free credits with two 24h clocks: 24h to
 *   claim, then 24h to use. Free credits live in their own record
 *   (`free_credits:{clientId}`) with an `expiresAt` field and a KV TTL
 *   one minute longer. They are consumed before paid credits.
 *
 * Receipt families:
 *   evm, solana, bitcoin, tron. The tron family carries TRC-20 USDT
 *   sweeps bridged to USDC on Ethereum via deBridge. Its receipts use
 *   the same shape as solana (txids + orderIds), just with a different
 *   sourceChain string.
 */

import { ethers } from 'ethers';

// =====================================================================
// CONFIG
// =====================================================================

const BUNDLES = {
  'single':    { credits: 1,  priceCents: 500 },
  'pack-5':    { credits: 5,  priceCents: 2250 },
  'pack-10':   { credits: 10, priceCents: 4000 },
  'pack-25':   { credits: 25, priceCents: 8000 },
  'pack-50':   { credits: 50, priceCents: 15000 },
};

const CHAIN_IDS = {
  ethereum: 1, optimism: 10, bnb: 56, polygon: 137, base: 8453, arbitrum: 42161,
};

const TOKEN_ADDRESSES = {
  ethereum: {
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  },
  optimism: {
    USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    USDT: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
  },
  bnb: {
    USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    USDT: '0x55d398326f99059fF775485246999027B3197955',
  },
  polygon: {
    USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  },
  base: {
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  },
  arbitrum: {
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  },
};

const METHODS = {
  'usdc-base':     { chain: 'base',     token: 'USDC', decimals: 6,  envAddress: 'CRYPTO_ADDRESS_EVM' },
  'usdc-arbitrum': { chain: 'arbitrum', token: 'USDC', decimals: 6,  envAddress: 'CRYPTO_ADDRESS_EVM' },
  'usdc-optimism': { chain: 'optimism', token: 'USDC', decimals: 6,  envAddress: 'CRYPTO_ADDRESS_EVM' },
  'usdc-polygon':  { chain: 'polygon',  token: 'USDC', decimals: 6,  envAddress: 'CRYPTO_ADDRESS_EVM' },
  'usdc-bnb':      { chain: 'bnb',      token: 'USDC', decimals: 18, envAddress: 'CRYPTO_ADDRESS_EVM' },
  'usdc-ethereum': { chain: 'ethereum', token: 'USDC', decimals: 6,  envAddress: 'CRYPTO_ADDRESS_EVM' },
  'usdt-base':     { chain: 'base',     token: 'USDT', decimals: 6,  envAddress: 'CRYPTO_ADDRESS_EVM' },
  'usdt-arbitrum': { chain: 'arbitrum', token: 'USDT', decimals: 6,  envAddress: 'CRYPTO_ADDRESS_EVM' },
  'usdt-optimism': { chain: 'optimism', token: 'USDT', decimals: 6,  envAddress: 'CRYPTO_ADDRESS_EVM' },
  'usdt-polygon':  { chain: 'polygon',  token: 'USDT', decimals: 6,  envAddress: 'CRYPTO_ADDRESS_EVM' },
  'usdt-bnb':      { chain: 'bnb',      token: 'USDT', decimals: 18, envAddress: 'CRYPTO_ADDRESS_EVM' },
  'usdt-ethereum': { chain: 'ethereum', token: 'USDT', decimals: 6,  envAddress: 'CRYPTO_ADDRESS_EVM' },
  'eth-base':      { chain: 'base',     token: 'ETH',  decimals: 18, envAddress: 'CRYPTO_ADDRESS_EVM' },
  'sol':           { chain: 'solana',   token: 'SOL',  decimals: 9,  envAddress: 'CRYPTO_ADDRESS_SOL' },
  'btc':           { chain: 'bitcoin',  token: 'BTC',  decimals: 8,  envAddress: 'CRYPTO_ADDRESS_BTC' },
};

const SPONSOR_RPC = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  base:     'https://base-rpc.publicnode.com',
  polygon:  'https://polygon-bor-rpc.publicnode.com',
  bnb:      'https://bsc-rpc.publicnode.com',
};

const SPONSOR_TARGET_WEI = {
  ethereum: '0.0008',
  arbitrum: '0.00002',
  optimism: '0.00002',
  base:     '0.00002',
  polygon:  '0.01',
  bnb:      '0.0002',
};

const SPONSOR_MAX_WEI = {
  ethereum: '0.005', arbitrum: '0.0005', optimism: '0.0005',
  base: '0.0005', polygon: '0.2', bnb: '0.005',
};

const SPONSOR_RATE_MAX = 20;
const SPONSOR_RATE_WINDOW_MS = 10 * 60 * 1000;
const SPONSOR_IDEM_TTL = 60 * 5;
const CONSUME_IDEM_TTL = 60 * 60 * 24 * 30;
const CRYPTO_VERIFY_LOCK_TTL = 30;

const FREE_CLAIM_CREDITS = 2;
const FREE_CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;
const FREE_CLAIM_USE_WINDOW_MS = 24 * 60 * 60 * 1000;
const FREE_CLAIM_START_TTL = 48 * 60 * 60;
const FREE_CLAIM_GRANTED_TTL = 60 * 60 * 24 * 365;
const FREE_CLAIM_IP_MAX = 2;
const FREE_CLAIM_IP_TTL = 60 * 60 * 24 * 7;

const FREE_CLAIM_FINGERPRINT_MAX = 2;
const FREE_CLAIM_FINGERPRINT_TTL = 60 * 60 * 24 * 7;

const FREE_CREDITS_TTL = Math.ceil(FREE_CLAIM_USE_WINDOW_MS / 1000) + 60;

const SWEEP_COMMIT_TTL = 60 * 60 * 24 * 30;

const ADMIN_AUTH_FAIL_MAX = 10;
const ADMIN_AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000;

const ADMIN_CALL_MAX = 120;
const ADMIN_RATE_WINDOW_MS = 10 * 60 * 1000;

const HEX_KEY_RE = /^0x[a-fA-F0-9]{64}$/;
const MNEMONIC_RE = /^(\S+\s+){11,23}\S+$/;
const VALID_MNEMONIC_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

export function buildSponsorWallet(secret, provider) {
  if (typeof secret !== 'string') {
    throw new Error('GAS_SPONSOR_KEY must be a string');
  }
  const trimmed = secret.trim();

  if (HEX_KEY_RE.test(trimmed)) {
    return new ethers.Wallet(trimmed, provider);
  }

  if (MNEMONIC_RE.test(trimmed)) {
    const words = trimmed.split(/\s+/);
    if (!VALID_MNEMONIC_WORD_COUNTS.has(words.length)) {
      throw new Error(`GAS_SPONSOR_KEY mnemonic has ${words.length} words; expected 12/15/18/21/24`);
    }
    return ethers.HDNodeWallet.fromPhrase(trimmed, undefined, "m/44'/60'/0'/0/0").connect(provider);
  }

  throw new Error('GAS_SPONSOR_KEY is neither a 0x-prefixed 64-char hex private key nor a BIP-39 mnemonic');
}

// =====================================================================
// ROUTER
// =====================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Operator-Secret',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    try {
      if (path === '/health') return json({ ok: true, time: new Date().toISOString() }, 200, cors);

      if (path === '/crypto/quote'  && request.method === 'POST') return await handleCryptoQuote(request, env, cors);
      if (path === '/crypto/verify' && request.method === 'POST') return await handleCryptoVerify(request, env, cors);

      if (path === '/credits/balance'    && request.method === 'POST') return await handleCreditsBalance(request, env, cors);
      if (path === '/credits/consume'    && request.method === 'POST') return await handleCreditsConsume(request, env, cors);
      if (path === '/credits/claim-info' && request.method === 'POST') return await handleClaimInfo(request, env, cors);
      if (path === '/credits/claim-free' && request.method === 'POST') return await handleClaimFree(request, env, cors);

      if (path === '/gas/sponsor' && request.method === 'POST') return await handleGasSponsor(request, env, cors);

      if (path === '/sweep/commit' && request.method === 'POST') return await handleSweepCommit(request, env, cors);

      if (path === '/fee/record'          && request.method === 'POST') return await handleFeeRecord(request, env, cors);
      if (path === '/fee/pending'         && request.method === 'GET')  return await handleFeePending(request, env, cors);
      if (path === '/fee/mark-forwarded'  && request.method === 'POST') return await handleFeeMarkForwarded(request, env, cors);
      if (path === '/fee/summary'         && request.method === 'GET')  return await handleFeeSummary(request, env, cors);

      if (path === '/admin/credits/grant'  && request.method === 'POST') return await handleAdminCreditsGrant(request, env, cors);
      if (path === '/admin/credits/lookup' && request.method === 'POST') return await handleAdminCreditsLookup(request, env, cors);
      if (path === '/admin/credits/list'   && request.method === 'GET')  return await handleAdminCreditsList(request, env, cors);
      if (path === '/admin/clients/lookup-by-fingerprint' && request.method === 'POST') return await handleAdminClientLookupByFingerprint(request, env, cors);

      return json({ error: 'not found' }, 404, cors);
    } catch (err) {
      if (err.status === 401) return json({ error: 'unauthorized' }, 401, cors);
      if (err.status === 429) return json({ error: 'rate limited' }, 429, cors);
      if (err.status === 500 && err.message.includes('OPERATOR_SECRET')) {
        return json({ error: 'operator secret not configured' }, 500, cors);
      }
      const firstFrame = String(err?.stack || '').split('\n')[0];
      console.error('Worker error:', err?.name || 'Error', '—', firstFrame);
      return json({ error: 'internal error' }, 500, cors);
    }
  },
};

// =====================================================================
// CRYPTO — QUOTE
// =====================================================================

export async function handleCryptoQuote(request, env, cors) {
  const { clientId, bundle = 'single', method = 'usdc-base' } = await request.json();

  if (!clientId || typeof clientId !== 'string' || clientId.length < 16) {
    return json({ error: 'clientId required' }, 400, cors);
  }

  const bundleConfig = BUNDLES[bundle];
  if (!bundleConfig) return json({ error: `unknown bundle: ${bundle}` }, 400, cors);

  const methodConfig = METHODS[method];
  if (!methodConfig) return json({ error: `unknown method: ${method}` }, 400, cors);

  const address = env[methodConfig.envAddress];
  if (!address) return json({ error: `crypto address not configured for ${method}` }, 500, cors);

  const rate = await getCryptoRate(methodConfig);
  if (!rate) return json({ error: 'could not fetch exchange rate' }, 502, cors);

  const usdAmount = bundleConfig.priceCents / 100;
  const cryptoAmount = usdAmount / rate.price;
  const cryptoAmountRaw = BigInt(Math.round(cryptoAmount * Math.pow(10, rate.decimals)));
  const uniqueSuffix = BigInt(Math.floor(Math.random() * 10000));
  const finalRaw = cryptoAmountRaw + uniqueSuffix;

  const paymentId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  await env.PENDING_PAYMENTS.put(
    `crypto:${paymentId}`,
    JSON.stringify({
      method, chain: methodConfig.chain, token: methodConfig.token,
      clientId, bundle, credits: bundleConfig.credits,
      expectedRaw: finalRaw.toString(), decimals: rate.decimals,
      address, expiresAt, createdAt: new Date().toISOString(),
    }),
    { expirationTtl: 60 * 60 }
  );

  return json({
    payment_id: paymentId,
    chain: methodConfig.chain,
    token: methodConfig.token,
    address,
    amount: Number(finalRaw) / Math.pow(10, rate.decimals),
    amount_raw: finalRaw.toString(),
    decimals: rate.decimals,
    usd_price: usdAmount,
    credits: bundleConfig.credits,
    expires_at: expiresAt,
  }, 200, cors);
}

export async function getCryptoRate(methodConfig) {
  if (methodConfig.token === 'USDC' || methodConfig.token === 'USDT') {
    return { price: 1.0, decimals: methodConfig.decimals };
  }
  const coinIds = { ETH: 'ethereum', SOL: 'solana', BTC: 'bitcoin' };
  const id = coinIds[methodConfig.token];
  if (!id) return null;
  try {
    const resp = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    const data = await resp.json();
    const price = data[id]?.usd;
    if (!price) return null;
    return { price, decimals: methodConfig.decimals };
  } catch { return null; }
}

// =====================================================================
// CRYPTO — VERIFY
// =====================================================================

export async function handleCryptoVerify(request, env, cors) {
  const { payment_id } = await request.json();
  if (!payment_id) return json({ error: 'payment_id required' }, 400, cors);

  const pendingRaw = await env.PENDING_PAYMENTS.get(`crypto:${payment_id}`);
  if (!pendingRaw) return json({ error: 'payment not found or expired' }, 404, cors);
  const pending = JSON.parse(pendingRaw);

  if (pending.verified) return json({ ok: true, alreadyVerified: true, credits: pending.credits }, 200, cors);
  if (new Date(pending.expiresAt) < new Date()) return json({ error: 'payment expired' }, 410, cors);

  const lockKey = `crypto:lock:${payment_id}`;
  const lock = await env.CREDITS.get(lockKey);
  if (lock) {
    return json({ status: 'pending', message: 'verification in progress' }, 200, cors);
  }
  await env.CREDITS.put(lockKey, '1', { expirationTtl: CRYPTO_VERIFY_LOCK_TTL });

  try {
    const found = await scanForPayment(env, pending);
    if (!found) return json({ status: 'pending', message: 'No matching transaction found yet' }, 200, cors);

    const refreshedRaw = await env.PENDING_PAYMENTS.get(`crypto:${payment_id}`);
    if (refreshedRaw) {
      const refreshed = JSON.parse(refreshedRaw);
      if (refreshed.verified) {
        return json({ ok: true, alreadyVerified: true, credits: refreshed.credits }, 200, cors);
      }
    }

    const balance = await addCredits(env, pending.clientId, pending.credits, {
      type: 'crypto', method: pending.method, chain: pending.chain,
      token: pending.token, txHash: found.txHash, credits: pending.credits,
    });

    pending.verified = true;
    pending.txHash = found.txHash;
    await env.PENDING_PAYMENTS.put(`crypto:${payment_id}`, JSON.stringify(pending), {
      expirationTtl: 60 * 60 * 24 * 7,
    });

    return json({ ok: true, creditsAdded: pending.credits, newBalance: balance, txHash: found.txHash }, 200, cors);
  } finally {
    await env.CREDITS.delete(lockKey).catch(() => {});
  }
}

export async function scanForPayment(env, pending) {
  const { chain, token, address, expectedRaw } = pending;
  if (chain === 'solana') return await scanSolana(env, address, expectedRaw);
  if (chain === 'bitcoin') return await scanBitcoin(env, address, expectedRaw);
  return await scanEvmChain(env, chain, token, address, expectedRaw);
}

export async function scanEvmChain(env, chain, token, address, expectedRaw) {
  const apiKey = env.ETHERSCAN_API_KEY;
  if (!apiKey) return null;
  const chainId = CHAIN_IDS[chain];
  if (!chainId) return null;

  const baseUrl = `https://api.etherscan.io/v2/api?chainid=${chainId}`;

  if (token === 'USDC' || token === 'USDT') {
    const contract = TOKEN_ADDRESSES[chain]?.[token];
    if (!contract) return null;
    const url = `${baseUrl}&module=account&action=tokentx&contractaddress=${contract}&address=${address}&sort=desc&apikey=${apiKey}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.result || !Array.isArray(data.result)) return null;
    for (const tx of data.result.slice(0, 20)) {
      if (tx.to?.toLowerCase() === address.toLowerCase() && tx.value === expectedRaw) {
        return { txHash: tx.hash, blockNumber: tx.blockNumber };
      }
    }
    return null;
  }

  if (token === 'ETH') {
    const url = `${baseUrl}&module=account&action=txlist&address=${address}&sort=desc&apikey=${apiKey}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.result || !Array.isArray(data.result)) return null;
    for (const tx of data.result.slice(0, 20)) {
      if (tx.to?.toLowerCase() === address.toLowerCase() && tx.value === expectedRaw) {
        return { txHash: tx.hash, blockNumber: tx.blockNumber };
      }
    }
    return null;
  }

  return null;
}

export async function scanSolana(env, address, expectedRaw) {
  const resp = await fetch(`https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${env.HELIUS_API_KEY}&limit=20`);
  if (!resp.ok) return null;
  const txs = await resp.json();
  if (!Array.isArray(txs)) return null;
  const expected = BigInt(expectedRaw);
  for (const tx of txs) {
    for (const t of tx.nativeTransfers || []) {
      if (t.toUserAccount === address && BigInt(t.amount) === expected) return { txHash: tx.signature };
    }
  }
  return null;
}

export async function scanBitcoin(env, address, expectedRaw) {
  const resp = await fetch(`https://mempool.space/api/address/${address}/txs`);
  if (!resp.ok) return null;
  const txs = await resp.json();
  if (!Array.isArray(txs)) return null;
  const expected = parseInt(expectedRaw, 10);
  for (const tx of txs.slice(0, 20)) {
    for (const vout of tx.vout || []) {
      if (vout.scriptpubkey_address === address && vout.value === expected) return { txHash: tx.txid };
    }
  }
  return null;
}

// =====================================================================
// FREE-CREDIT POOL
// =====================================================================

export async function readFreeCredits(env, clientId) {
  const raw = await env.CREDITS.get(`free_credits:${clientId}`);
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed.amount !== 'number' || parsed.amount <= 0) return null;
  if (!parsed.expiresAt) return null;
  const expiresMs = new Date(parsed.expiresAt).getTime();
  if (!Number.isFinite(expiresMs)) return null;
  if (Date.now() >= expiresMs) return null;
  return parsed;
}

export async function writeFreeCredits(env, clientId, amount, grantedAtMs) {
  if (amount <= 0) {
    await env.CREDITS.delete(`free_credits:${clientId}`).catch(() => {});
    return;
  }
  const grantedAt = new Date(grantedAtMs).toISOString();
  const expiresAt = new Date(grantedAtMs + FREE_CLAIM_USE_WINDOW_MS).toISOString();
  await env.CREDITS.put(`free_credits:${clientId}`, JSON.stringify({
    amount, grantedAt, expiresAt,
  }), { expirationTtl: FREE_CREDITS_TTL });
}

async function writeFreeCreditsWithExpiry(env, clientId, amount, grantedAt, expiresAt) {
  if (amount <= 0) {
    await env.CREDITS.delete(`free_credits:${clientId}`).catch(() => {});
    return;
  }
  const expiresMs = new Date(expiresAt).getTime();
  const remainingSec = Math.max(60, Math.ceil((expiresMs - Date.now()) / 1000) + 60);
  await env.CREDITS.put(`free_credits:${clientId}`, JSON.stringify({
    amount, grantedAt, expiresAt,
  }), { expirationTtl: remainingSec });
}

export async function getEffectiveBalance(env, clientId) {
  const [paidRaw, free] = await Promise.all([
    env.CREDITS.get(`balance:${clientId}`),
    readFreeCredits(env, clientId),
  ]);
  const paid = paidRaw ? parseInt(paidRaw, 10) : 0;
  const freeAmount = free ? free.amount : 0;
  return { paid, free: freeAmount, effective: paid + freeAmount, freeExpiresAt: free?.expiresAt || null };
}

// =====================================================================
// CREDITS
// =====================================================================

export async function handleCreditsBalance(request, env, cors) {
  const { clientId } = await request.json();
  if (!clientId) return json({ error: 'clientId required' }, 400, cors);

  const { paid, free, effective, freeExpiresAt } = await getEffectiveBalance(env, clientId);

  return json({
    clientId,
    balance: effective,
    paid,
    free,
    freeExpiresAt,
  }, 200, cors);
}

export async function handleCreditsConsume(request, env, cors) {
  const { clientId, reason, sweepId } = await request.json();
  if (!clientId) return json({ error: 'clientId required' }, 400, cors);

  if (sweepId && typeof sweepId === 'string' && sweepId.length >= 8) {
    const idemKey = `consume:${sweepId}`;
    const prior = await env.CREDITS.get(idemKey);
    if (prior) {
      try {
        const parsed = JSON.parse(prior);
        if (parsed.clientId === clientId) {
          return json({
            ok: true, consumed: 1, newBalance: parsed.newBalance,
            pool: parsed.pool, alreadyConsumed: true,
          }, 200, cors);
        }
      } catch {
        // Corrupt record — treat as not-yet-consumed and overwrite below.
      }
    }
  }

  const free = await readFreeCredits(env, clientId);
  const paidRaw = await env.CREDITS.get(`balance:${clientId}`);
  const paid = paidRaw ? parseInt(paidRaw, 10) : 0;

  const freeAmount = free ? free.amount : 0;
  const effective = paid + freeAmount;
  if (effective < 1) {
    return json({ error: 'insufficient credits', balance: 0 }, 402, cors);
  }

  let pool;
  let newEffective;

  if (freeAmount > 0) {
    pool = 'free';
    const remaining = freeAmount - 1;
    await writeFreeCreditsWithExpiry(env, clientId, remaining, free.grantedAt, free.expiresAt);
    newEffective = paid + remaining;
  } else {
    pool = 'paid';
    newEffective = paid - 1;
    await env.CREDITS.put(`balance:${clientId}`, String(newEffective));
  }

  const historyRaw = await env.CREDITS.get(`history:${clientId}`);
  const history = historyRaw ? JSON.parse(historyRaw) : [];
  history.unshift({
    delta: -1,
    balance: newEffective,
    at: new Date().toISOString(),
    type: 'consume',
    reason: reason || 'sweep',
    pool,
  });
  await env.CREDITS.put(`history:${clientId}`, JSON.stringify(history.slice(0, 50)));

  if (sweepId && typeof sweepId === 'string' && sweepId.length >= 8) {
    await env.CREDITS.put(`consume:${sweepId}`, JSON.stringify({
      clientId, newBalance: newEffective, pool, consumedAt: new Date().toISOString(),
    }), { expirationTtl: CONSUME_IDEM_TTL });
  }

  return json({ ok: true, consumed: 1, newBalance: newEffective, pool }, 200, cors);
}

export async function getBalance(env, clientId) {
  const raw = await env.CREDITS.get(`balance:${clientId}`);
  return raw ? parseInt(raw, 10) : 0;
}

export async function addCredits(env, clientId, delta, metadata = {}) {
  const current = await getBalance(env, clientId);
  const next = current + delta;
  await env.CREDITS.put(`balance:${clientId}`, next.toString());
  const historyRaw = await env.CREDITS.get(`history:${clientId}`);
  const history = historyRaw ? JSON.parse(historyRaw) : [];
  history.unshift({ delta, balance: next, at: new Date().toISOString(), ...metadata });
  await env.CREDITS.put(`history:${clientId}`, JSON.stringify(history.slice(0, 50)));
  return next;
}

// =====================================================================
// FREE CREDITS — CLAIM WINDOW
// =====================================================================

export async function handleClaimInfo(request, env, cors) {
  const { clientId } = await request.json();
  if (!clientId || typeof clientId !== 'string' || clientId.length < 16) {
    return json({ error: 'clientId required' }, 400, cors);
  }

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const startKey = `free_claim:start:${clientId}`;
  const grantedKey = `free_claim:granted:${clientId}`;
  const ipKey = `free_claim:ip:${ip}`;

  const [startRaw, grantedRaw, ipClaimsRaw, free] = await Promise.all([
    env.CREDITS.get(startKey),
    env.CREDITS.get(grantedKey),
    env.CREDITS.get(ipKey),
    readFreeCredits(env, clientId),
  ]);

  const now = Date.now();
  const ipClaims = ipClaimsRaw ? parseInt(ipClaimsRaw, 10) : 0;
  const blockedByIp = ipClaims >= FREE_CLAIM_IP_MAX;

  const freeAmount = free ? free.amount : 0;
  const useExpiresAt = free?.expiresAt || null;
  let useMsRemaining = 0;
  if (useExpiresAt) {
    const ms = new Date(useExpiresAt).getTime();
    useMsRemaining = Number.isFinite(ms) ? Math.max(0, ms - now) : 0;
  }

  if (grantedRaw) {
    const startMs = startRaw ? new Date(startRaw).getTime() : null;
    return json({
      ok: true, claimed: true, expired: false, blockedByIp, notStarted: false,
      windowStart: startRaw || null,
      windowEnd: startMs ? new Date(startMs + FREE_CLAIM_WINDOW_MS).toISOString() : null,
      msRemaining: 0, creditsGranted: FREE_CLAIM_CREDITS,
      ipClaims, ipMax: FREE_CLAIM_IP_MAX,
      freeAmount, useExpiresAt, useMsRemaining,
    }, 200, cors);
  }

  if (!startRaw) {
    return json({
      ok: true, claimed: false, expired: false, blockedByIp, notStarted: true,
      windowStart: null, windowEnd: null,
      msRemaining: FREE_CLAIM_WINDOW_MS, creditsGranted: 0,
      ipClaims, ipMax: FREE_CLAIM_IP_MAX,
      freeAmount, useExpiresAt, useMsRemaining,
    }, 200, cors);
  }

  const windowStart = new Date(startRaw).getTime();
  const windowEnd = windowStart + FREE_CLAIM_WINDOW_MS;
  const msRemaining = Math.max(0, windowEnd - now);

  return json({
    ok: true, claimed: false, expired: msRemaining === 0, blockedByIp, notStarted: false,
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: new Date(windowEnd).toISOString(),
    msRemaining, creditsGranted: 0,
    ipClaims, ipMax: FREE_CLAIM_IP_MAX,
    freeAmount, useExpiresAt, useMsRemaining,
  }, 200, cors);
}

export async function handleClaimFree(request, env, cors) {
  const { clientId, fingerprint } = await request.json();
  if (!clientId || typeof clientId !== 'string' || clientId.length < 16) {
    return json({ error: 'clientId required' }, 400, cors);
  }

  const fp = (typeof fingerprint === 'string' && fingerprint.length > 0)
    ? fingerprint.slice(0, 64)
    : '';

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const now = Date.now();

  const startKey = `free_claim:start:${clientId}`;
  const grantedKey = `free_claim:granted:${clientId}`;
  const ipKey = `free_claim:ip:${ip}`;
  const fpKey = `free_claim:fp:${fp}`;

  const grantedRaw = await env.CREDITS.get(grantedKey);
  if (grantedRaw) {
    const { effective } = await getEffectiveBalance(env, clientId);
    return json({
      ok: true, alreadyClaimed: true, creditsGranted: 0,
      newBalance: effective,
    }, 200, cors);
  }

  // ---- IP reserve ----
  const ipClaimsRaw = await env.CREDITS.get(ipKey);
  const ipClaims = ipClaimsRaw ? parseInt(ipClaimsRaw, 10) : 0;
  if (ipClaims >= FREE_CLAIM_IP_MAX) {
    const { effective } = await getEffectiveBalance(env, clientId);
    return json({
      ok: true, blockedByIp: true, creditsGranted: 0,
      ipClaims, ipMax: FREE_CLAIM_IP_MAX,
      newBalance: effective,
    }, 200, cors);
  }

  // ---- Fingerprint reserve ----
  const fpClaimsRaw = await env.CREDITS.get(fpKey);
  const fpClaims = fpClaimsRaw ? parseInt(fpClaimsRaw, 10) : 0;
  if (fpClaims >= FREE_CLAIM_FINGERPRINT_MAX) {
    const { effective } = await getEffectiveBalance(env, clientId);
    return json({
      ok: true, blockedByFingerprint: true, creditsGranted: 0,
      fpClaims, fpMax: FREE_CLAIM_FINGERPRINT_MAX,
      newBalance: effective,
    }, 200, cors);
  }

  await env.CREDITS.put(ipKey, String(ipClaims + 1), {
    expirationTtl: FREE_CLAIM_IP_TTL,
  });
  await env.CREDITS.put(fpKey, String(fpClaims + 1), {
    expirationTtl: FREE_CLAIM_FINGERPRINT_TTL,
  });

  const releaseSlots = async () => {
    await env.CREDITS.put(ipKey, String(ipClaims), {
      expirationTtl: FREE_CLAIM_IP_TTL,
    }).catch(() => {});
    await env.CREDITS.put(fpKey, String(fpClaims), {
      expirationTtl: FREE_CLAIM_FINGERPRINT_TTL,
    }).catch(() => {});
  };

  const startRaw = await env.CREDITS.get(startKey);
  if (startRaw) {
    const windowStart = new Date(startRaw).getTime();
    if (now - windowStart > FREE_CLAIM_WINDOW_MS) {
      await releaseSlots();
      const { effective } = await getEffectiveBalance(env, clientId);
      return json({
        ok: true, offerExpired: true, creditsGranted: 0,
        newBalance: effective,
      }, 200, cors);
    }
  } else {
    await env.CREDITS.put(startKey, new Date(now).toISOString(), {
      expirationTtl: FREE_CLAIM_START_TTL,
    });
  }

  const grantedAtMs = now;
  const preGrant = await getEffectiveBalance(env, clientId);

  try {
    await writeFreeCredits(env, clientId, FREE_CLAIM_CREDITS, grantedAtMs);

    const historyRaw = await env.CREDITS.get(`history:${clientId}`);
    const history = historyRaw ? JSON.parse(historyRaw) : [];
    history.unshift({
      delta: FREE_CLAIM_CREDITS,
      balance: preGrant.effective + FREE_CLAIM_CREDITS,
      at: new Date(grantedAtMs).toISOString(),
      type: 'free_claim',
      source: 'launch_bonus',
      credits: FREE_CLAIM_CREDITS,
      ip,
      fingerprint: fp,
      expiresAt: new Date(grantedAtMs + FREE_CLAIM_USE_WINDOW_MS).toISOString(),
    });
    await env.CREDITS.put(`history:${clientId}`, JSON.stringify(history.slice(0, 50)));
  } catch (e) {
    await releaseSlots();
    throw e;
  }

  await env.CREDITS.put(`client_meta:${clientId}`, JSON.stringify({
    fingerprint: fp || null,
    ip,
    host: request.headers.get('host') || 'unknown',
    firstSeen: new Date(now).toISOString(),
  }), { expirationTtl: 60 * 60 * 24 * 365 }).catch(() => {});

  await env.CREDITS.put(grantedKey, new Date().toISOString(), {
    expirationTtl: FREE_CLAIM_GRANTED_TTL,
  });

  return json({
    ok: true, creditsGranted: FREE_CLAIM_CREDITS,
    newBalance: preGrant.effective + FREE_CLAIM_CREDITS,
    freeAmount: FREE_CLAIM_CREDITS,
    useExpiresAt: new Date(grantedAtMs + FREE_CLAIM_USE_WINDOW_MS).toISOString(),
    useMsRemaining: FREE_CLAIM_USE_WINDOW_MS,
    windowEnd: new Date(now + FREE_CLAIM_WINDOW_MS).toISOString(),
    ipClaims: ipClaims + 1, ipMax: FREE_CLAIM_IP_MAX,
    fpClaims: fpClaims + 1, fpMax: FREE_CLAIM_FINGERPRINT_MAX,
  }, 200, cors);
}

// =====================================================================
// GAS SPONSORSHIP
// =====================================================================

export async function handleGasSponsor(request, env, cors) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!(await checkSponsorRate(env, ip))) {
    return json({ error: 'rate limited — too many sponsor requests' }, 429, cors);
  }

  const { chain, toAddress, shortfallWei } = await request.json();

  if (!chain || !SPONSOR_RPC[chain]) return json({ error: `unsupported chain: ${chain}` }, 400, cors);
  if (!toAddress || !/^0x[a-fA-F0-9]{40}$/.test(toAddress)) return json({ error: 'valid toAddress required' }, 400, cors);
  if (!shortfallWei || !/^\d+$/.test(String(shortfallWei))) return json({ error: 'shortfallWei required (decimal string)' }, 400, cors);

  const clientHint = BigInt(shortfallWei);
  if (clientHint === 0n) return json({ ok: true, sent: '0', reason: 'no shortfall' }, 200, cors);

  const maxSend = ethers.parseEther(SPONSOR_MAX_WEI[chain]);
  if (clientHint > maxSend) return json({ error: `shortfall exceeds safe maximum for ${chain}` }, 400, cors);

  if (!env.GAS_SPONSOR_KEY) return json({ error: 'sponsor not configured' }, 500, cors);

  const idemKey = `sponsor:idem:${chain}:${toAddress.toLowerCase()}`;
  const prior = await env.CREDITS.get(idemKey);
  if (prior) {
    try {
      const parsed = JSON.parse(prior);
      return json({
        ok: true, sent: parsed.sent, txHash: parsed.txHash, alreadySent: true,
      }, 200, cors);
    } catch {
      // Corrupt record — fall through and try to send again below.
    }
  }

  let sponsorWallet;
  try {
    sponsorWallet = buildSponsorWallet(env.GAS_SPONSOR_KEY, new ethers.JsonRpcProvider(SPONSOR_RPC[chain]));
  } catch (e) {
    console.error('Sponsor wallet construction failed:', e.message);
    return json({ error: 'sponsor wallet is misconfigured' }, 500, cors);
  }

  const provider = sponsorWallet.provider;
  const sponsorAddress = await sponsorWallet.getAddress();

  const target = ethers.parseEther(SPONSOR_TARGET_WEI[chain]);
  const userBalance = await provider.getBalance(toAddress);
  if (userBalance >= target) {
    return json({ ok: true, sent: '0', reason: 'user already funded' }, 200, cors);
  }
  let shortfall = target - userBalance;
  if (shortfall > maxSend) shortfall = maxSend;

  const sponsorBalance = await provider.getBalance(sponsorAddress);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 0n;
  const gasCost = gasPrice * 21000n;
  const required = shortfall + gasCost;
  if (sponsorBalance < required) {
    return json({
      error: 'sponsor wallet is low on native gas',
      chain, sponsorAddress,
      sponsorBalance: sponsorBalance.toString(),
      required: required.toString(),
    }, 503, cors);
  }

  try {
    const tx = await sponsorWallet.sendTransaction({ to: toAddress, value: shortfall });
    await tx.wait(1);

    await env.CREDITS.put(idemKey, JSON.stringify({
      sent: shortfall.toString(), txHash: tx.hash, at: new Date().toISOString(),
    }), { expirationTtl: SPONSOR_IDEM_TTL }).catch(() => {});

    return json({ ok: true, sent: shortfall.toString(), txHash: tx.hash }, 200, cors);
  } catch (e) {
    console.error('Sponsor send failed for chain', chain);
    return json({ error: 'sponsor send failed' }, 500, cors);
  }
}

export async function checkSponsorRate(env, ip) {
  const key = `sponsor:rl:${ip}`;
  const raw = await env.CREDITS.get(key);
  const now = Date.now();

  if (!raw) {
    await env.CREDITS.put(key, JSON.stringify({ count: 1, reset: now + SPONSOR_RATE_WINDOW_MS }), {
      expirationTtl: Math.ceil(SPONSOR_RATE_WINDOW_MS / 1000),
    });
    return true;
  }

  try {
    const entry = JSON.parse(raw);
    if (now > entry.reset) {
      await env.CREDITS.put(key, JSON.stringify({ count: 1, reset: now + SPONSOR_RATE_WINDOW_MS }), {
        expirationTtl: Math.ceil(SPONSOR_RATE_WINDOW_MS / 1000),
      });
      return true;
    }
    if (entry.count >= SPONSOR_RATE_MAX) return false;
    entry.count += 1;
    await env.CREDITS.put(key, JSON.stringify(entry), {
      expirationTtl: Math.ceil((entry.reset - now) / 1000),
    });
    return true;
  } catch { return true; }
}

// =====================================================================
// SWEEP COMMIT
// =====================================================================

export async function handleSweepCommit(request, env, cors) {
  const { clientId, sweepId, userDestination } = await request.json();

  if (!clientId || typeof clientId !== 'string' || clientId.length < 16) {
    return json({ error: 'clientId required' }, 400, cors);
  }
  if (!sweepId || typeof sweepId !== 'string' || sweepId.length < 8) {
    return json({ error: 'sweepId required (min 8 chars)' }, 400, cors);
  }
  if (!userDestination || typeof userDestination !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(userDestination)) {
    return json({ error: 'userDestination must be a 0x address' }, 400, cors);
  }

  const key = `sweep:${sweepId}`;
  const existing = await env.CREDITS.get(key);
  if (existing) {
    const parsed = JSON.parse(existing);
    if (parsed.clientId !== clientId) {
      return json({ error: 'sweep already committed by a different client' }, 409, cors);
    }
    if (parsed.userDestination.toLowerCase() !== userDestination.toLowerCase()) {
      return json({ error: 'sweep already committed with a different destination' }, 409, cors);
    }
    return json({ ok: true, alreadyCommitted: true }, 200, cors);
  }

  await env.CREDITS.put(key, JSON.stringify({
    clientId,
    userDestination,
    committedAt: new Date().toISOString(),
  }), { expirationTtl: SWEEP_COMMIT_TTL });

  return json({ ok: true }, 200, cors);
}

// =====================================================================
// FEE RECORDING
// =====================================================================

export async function handleFeeRecord(request, env, cors) {
  const body = await request.json();
  const {
    clientId,
    sweepId,
    receipts = [],
    gasSponsorships = [],
    sweepDurationMs = 0,
    successes = 0,
    failures = 0,
  } = body;

  if (!clientId) return json({ error: 'clientId required' }, 400, cors);
  if (!sweepId || typeof sweepId !== 'string' || sweepId.length < 8) {
    return json({ error: 'sweepId required (min 8 chars)' }, 400, cors);
  }
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return json({ error: 'receipts required (non-empty array)' }, 400, cors);
  }

  const existingRaw = await env.CREDITS.get(`fee:sweep:${sweepId}`);
  if (existingRaw) {
    return json({ ok: true, sweepId, alreadyRecorded: true, status: 'pending' }, 200, cors);
  }

  const commitRaw = await env.CREDITS.get(`sweep:${sweepId}`);
  if (!commitRaw) {
    return json({ error: 'sweepId not committed — call /sweep/commit before sweeping' }, 400, cors);
  }
  let commit;
  try { commit = JSON.parse(commitRaw); }
  catch { return json({ error: 'sweep commit is corrupt' }, 500, cors); }
  if (commit.clientId !== clientId) {
    return json({ error: 'sweepId belongs to a different client' }, 403, cors);
  }
  const authoritativeDestination = commit.userDestination;

  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    if (!r || typeof r !== 'object') {
      return json({ error: `receipt[${i}] is not an object` }, 400, cors);
    }
    if (typeof r.family !== 'string' || !['evm', 'solana', 'bitcoin', 'tron'].includes(r.family)) {
      return json({ error: `receipt[${i}].family must be evm, solana, bitcoin, or tron` }, 400, cors);
    }
    if (typeof r.amountRaw !== 'string' || !/^\d+$/.test(r.amountRaw)) {
      return json({ error: `receipt[${i}].amountRaw must be a decimal string` }, 400, cors);
    }
    if (typeof r.userShareRaw !== 'string' || !/^\d+$/.test(r.userShareRaw)) {
      return json({ error: `receipt[${i}].userShareRaw must be a decimal string` }, 400, cors);
    }
    if (typeof r.operatorFeeRaw !== 'string' || !/^\d+$/.test(r.operatorFeeRaw)) {
      return json({ error: `receipt[${i}].operatorFeeRaw must be a decimal string` }, 400, cors);
    }
    if (typeof r.decimals !== 'number' || r.decimals < 0 || r.decimals > 30) {
      return json({ error: `receipt[${i}].decimals must be 0-30` }, 400, cors);
    }
    if (typeof r.recipient !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(r.recipient)) {
      return json({ error: `receipt[${i}].recipient must be a 0x address` }, 400, cors);
    }
    if (typeof r.userDestination !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(r.userDestination)) {
      return json({ error: `receipt[${i}].userDestination must be a 0x address` }, 400, cors);
    }

    if (r.userDestination.toLowerCase() !== authoritativeDestination.toLowerCase()) {
      console.warn('Destination mismatch on fee record', {
        sweepId,
        clientId,
        clientSent: r.userDestination,
        committed: authoritativeDestination,
      });
    }

    r.userDestination = authoritativeDestination;
  }

  const operatorView = buildOperatorView(receipts, gasSponsorships);

  const record = {
    sweepId, clientId, receipts, gasSponsorships, operatorView,
    sweepDurationMs, successes, failures,
    status: 'pending',
    recordedAt: new Date().toISOString(),
    forwardedAt: null,
    forwardedTxHashes: null,
    sentAmounts: null,
  };

  await env.CREDITS.put(`fee:sweep:${sweepId}`, JSON.stringify(record));

  const pendingRaw = await env.CREDITS.get('fee:pending');
  const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
  if (!pending.includes(sweepId)) {
    pending.unshift(sweepId);
    await env.CREDITS.put('fee:pending', JSON.stringify(pending));
  }

  return json({ ok: true, sweepId, status: 'pending' }, 200, cors);
}

export function scaleUsdcToDecimals(amount6, targetDecimals) {
  const a = BigInt(amount6);
  if (targetDecimals === 6) return a;
  if (targetDecimals > 6) return a * (10n ** BigInt(targetDecimals - 6));
  return a / (10n ** BigInt(6 - targetDecimals));
}

export function buildOperatorView(receipts, gasSponsorships) {
  const lines = [];
  lines.push('MANUAL FORWARD REQUIRED');
  lines.push('═'.repeat(60));
  lines.push('Swept value has landed in the fee wallet. Send 90% (minus');
  lines.push('any sponsorship fees) to the user and keep the rest.');
  lines.push('');

  for (const r of receipts) {
    const chainLabel = r.family === 'evm' ? `EVM ${r.chain}` : r.family;
    const received = BigInt(r.amountRaw);
    const userAmount = BigInt(r.userShareRaw || '0');
    const est = r.estimated ? ' (est.)' : '';

    let sponsorFee = 0n;
    if (r.family === 'evm') {
      for (const gs of gasSponsorships) {
        if (gs.chain === r.chain) {
          sponsorFee += scaleUsdcToDecimals(gs.sponsorshipFeeUsdcRaw, r.decimals);
        }
      }
    }

    const netUserAmount = userAmount > sponsorFee ? userAmount - sponsorFee : 0n;

    lines.push(`[${chainLabel}]`);
    lines.push(`  Fee wallet:        ${r.recipient}`);
    lines.push(`  ${r.symbol} received:  ${formatAmount(received, r.decimals)}${est}`);
    lines.push(`  90% share:         ${formatAmount(userAmount, r.decimals)} ${r.symbol}${est}`);
    if (sponsorFee > 0n) {
      lines.push(`  Sponsorship fee:  -${formatAmount(sponsorFee, r.decimals)} ${r.symbol}`);
    }
    lines.push(`  Send to user:      ${formatAmount(netUserAmount, r.decimals)} ${r.symbol} on ${chainLabel} → ${r.userDestination}`);
    lines.push(`  Keep as fee:       ${formatAmount(received - netUserAmount, r.decimals)} ${r.symbol}`);
    if (r.estimated) {
      lines.push(`  NOTE:              Verify against ${r.bridge} settlement before forwarding.`);
    }
    lines.push('');
  }

  lines.push('═'.repeat(60));
  return lines.join('\n');
}

export function formatAmount(raw, decimals) {
  const s = raw.toString();
  const neg = s.startsWith('-');
  const digits = neg ? s.slice(1) : s;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals);
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

export async function handleFeePending(request, env, cors) {
  requireOperator(request, env);

  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') || '100', 10);
  const pendingRaw = await env.CREDITS.get('fee:pending');
  const pendingIds = pendingRaw ? JSON.parse(pendingRaw) : [];

  const items = [];
  for (const id of pendingIds.slice(0, limit)) {
    const raw = await env.CREDITS.get(`fee:sweep:${id}`);
    if (!raw) continue;
    try { items.push(JSON.parse(raw)); } catch {}
  }

  return json({ ok: true, count: items.length, totalPending: pendingIds.length, items }, 200, cors);
}

export async function handleFeeMarkForwarded(request, env, cors) {
  requireOperator(request, env);

  const body = await request.json();
  const { sweepId, txHashes, note, sentAmounts } = body;
  if (!sweepId) return json({ error: 'sweepId required' }, 400, cors);

  const raw = await env.CREDITS.get(`fee:sweep:${sweepId}`);
  if (!raw) return json({ error: 'sweep not found' }, 404, cors);

  const record = JSON.parse(raw);
  if (record.status === 'forwarded') return json({ ok: true, alreadyForwarded: true, record }, 200, cors);

  record.status = 'forwarded';
  record.forwardedAt = new Date().toISOString();
  record.forwardedTxHashes = txHashes || null;
  record.forwardedNote = note || null;
  record.sentAmounts = sentAmounts || null;

  await env.CREDITS.put(`fee:forwarded:${sweepId}`, JSON.stringify(record), {
    expirationTtl: 60 * 60 * 24 * 365,
  });

  const pendingRaw = await env.CREDITS.get('fee:pending');
  const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
  await env.CREDITS.put('fee:pending', JSON.stringify(pending.filter((id) => id !== sweepId)));

  await env.CREDITS.delete(`fee:sweep:${sweepId}`);

  return json({ ok: true, sweepId, status: 'forwarded', record }, 200, cors);
}

export async function handleFeeSummary(request, env, cors) {
  requireOperator(request, env);

  const pendingRaw = await env.CREDITS.get('fee:pending');
  const pendingIds = pendingRaw ? JSON.parse(pendingRaw) : [];

  const totalsByChain = {};
  let totalPendingSweeps = 0;

  for (const id of pendingIds) {
    const raw = await env.CREDITS.get(`fee:sweep:${id}`);
    if (!raw) continue;
    let record;
    try { record = JSON.parse(raw); } catch { continue; }
    totalPendingSweeps++;
    for (const r of record.receipts || []) {
      const key = r.family === 'evm' ? `evm:${r.chain}` : r.family;
      if (!totalsByChain[key]) totalsByChain[key] = { symbol: r.symbol, decimals: r.decimals, raw: 0n, count: 0 };
      totalsByChain[key].raw += BigInt(r.amountRaw);
      totalsByChain[key].count += 1;
    }
  }

  const totals = {};
  for (const [key, v] of Object.entries(totalsByChain)) {
    totals[key] = {
      symbol: v.symbol,
      decimals: v.decimals,
      amount: Number(v.raw) / Math.pow(10, v.decimals),
      amountRaw: v.raw.toString(),
      count: v.count,
    };
  }

  return json({ ok: true, totalPendingSweeps, totals }, 200, cors);
}

function requireOperator(request, env) {
  const provided = request.headers.get('X-Operator-Secret') || '';
  const expected = env.OPERATOR_SECRET || '';
  if (!expected) {
    const err = new Error('OPERATOR_SECRET not configured');
    err.status = 500;
    throw err;
  }
  if (provided !== expected) {
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  }
}

// =====================================================================
// ADMIN
// =====================================================================

async function checkAdminAuthFailRate(env, ip) {
  const key = `admin:authfail:${ip}`;
  const raw = await env.CREDITS.get(key);
  const now = Date.now();

  if (!raw) return { ok: true, count: 0 };

  try {
    const entry = JSON.parse(raw);
    if (now > entry.reset) {
      await env.CREDITS.delete(key).catch(() => {});
      return { ok: true, count: 0 };
    }
    if (entry.count >= ADMIN_AUTH_FAIL_MAX) {
      return { ok: false, count: entry.count, reset: entry.reset };
    }
    return { ok: true, count: entry.count };
  } catch {
    return { ok: true, count: 0 };
  }
}

async function recordAdminAuthFail(env, ip) {
  const key = `admin:authfail:${ip}`;
  const raw = await env.CREDITS.get(key);
  const now = Date.now();

  let entry;
  if (!raw) {
    entry = { count: 1, reset: now + ADMIN_AUTH_FAIL_WINDOW_MS };
  } else {
    try {
      entry = JSON.parse(raw);
      if (now > entry.reset) {
        entry = { count: 1, reset: now + ADMIN_AUTH_FAIL_WINDOW_MS };
      } else {
        entry.count += 1;
      }
    } catch {
      entry = { count: 1, reset: now + ADMIN_AUTH_FAIL_WINDOW_MS };
    }
  }

  await env.CREDITS.put(key, JSON.stringify(entry), {
    expirationTtl: Math.ceil((entry.reset - now) / 1000) + 1,
  }).catch(() => {});
}

async function checkAdminCallRate(env, ip) {
  const key = `admin:rl:${ip}`;
  const raw = await env.CREDITS.get(key);
  const now = Date.now();

  if (!raw) {
    await env.CREDITS.put(key, JSON.stringify({ count: 1, reset: now + ADMIN_RATE_WINDOW_MS }), {
      expirationTtl: Math.ceil(ADMIN_RATE_WINDOW_MS / 1000),
    });
    return true;
  }

  try {
    const entry = JSON.parse(raw);
    if (now > entry.reset) {
      await env.CREDITS.put(key, JSON.stringify({ count: 1, reset: now + ADMIN_RATE_WINDOW_MS }), {
        expirationTtl: Math.ceil(ADMIN_RATE_WINDOW_MS / 1000),
      });
      return true;
    }
    if (entry.count >= ADMIN_CALL_MAX) return false;
    entry.count += 1;
    await env.CREDITS.put(key, JSON.stringify(entry), {
      expirationTtl: Math.ceil((entry.reset - now) / 1000),
    });
    return true;
  } catch {
    return true;
  }
}

async function requireAdmin(request, env, ip) {
  const callOk = await checkAdminCallRate(env, ip);
  if (!callOk) {
    const err = new Error('rate limited');
    err.status = 429;
    throw err;
  }

  const failCheck = await checkAdminAuthFailRate(env, ip);
  if (!failCheck.ok) {
    const err = new Error('too many failed auth attempts');
    err.status = 429;
    throw err;
  }

  const provided = request.headers.get('X-Operator-Secret') || '';
  const expected = env.OPERATOR_SECRET || '';
  if (!expected) {
    const err = new Error('OPERATOR_SECRET not configured');
    err.status = 500;
    throw err;
  }
  if (provided !== expected) {
    await recordAdminAuthFail(env, ip);
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  }
}

export async function handleAdminCreditsGrant(request, env, cors) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  await requireAdmin(request, env, ip);

  const body = await request.json();
  const { clientId, amount, reason, note } = body || {};

  if (!clientId || typeof clientId !== 'string' || clientId.length < 16) {
    return json({ error: 'clientId required (min 16 chars)' }, 400, cors);
  }
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount === 0) {
    return json({ error: 'amount must be a non-zero integer' }, 400, cors);
  }
  if (Math.abs(amount) > 100000) {
    return json({ error: 'amount exceeds sanity cap (100000)' }, 400, cors);
  }

  const newBalance = await addCredits(env, clientId, amount, {
    type: 'admin_grant',
    reason: reason || 'manual',
    note: note || null,
    ip,
  });

  return json({
    ok: true,
    clientId,
    amount,
    newBalance,
    grantedAt: new Date().toISOString(),
  }, 200, cors);
}

export async function handleAdminCreditsLookup(request, env, cors) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  await requireAdmin(request, env, ip);

  const body = await request.json();
  const { clientId } = body || {};

  if (!clientId || typeof clientId !== 'string') {
    return json({ error: 'clientId required' }, 400, cors);
  }

  const { paid, free, effective } = await getEffectiveBalance(env, clientId);
  const balance = effective;
  const historyRaw = await env.CREDITS.get(`history:${clientId}`);
  let history = [];
  try { history = historyRaw ? JSON.parse(historyRaw) : []; } catch { history = []; }

  return json({ ok: true, clientId, balance, paid, free, history }, 200, cors);
}

export async function handleAdminCreditsList(request, env, cors) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  await requireAdmin(request, env, ip);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

  const listed = await env.CREDITS.list({ prefix: 'balance:', limit });

  const items = [];
  for (const key of listed.keys) {
    const clientId = key.name.slice('balance:'.length);
    const raw = await env.CREDITS.get(key.name);
    const paid = raw ? parseInt(raw, 10) : 0;

    const free = await readFreeCredits(env, clientId);
    const freeAmount = free ? free.amount : 0;
    const balance = paid + freeAmount;

    const metaRaw = await env.CREDITS.get(`client_meta:${clientId}`);
    let meta = { fingerprint: null, ip: null, host: null, firstSeen: null };
    if (metaRaw) {
      try {
        const parsed = JSON.parse(metaRaw);
        meta = {
          fingerprint: parsed.fingerprint || null,
          ip: parsed.ip || null,
          host: parsed.host || null,
          firstSeen: parsed.firstSeen || null,
        };
      } catch { /* leave defaults */ }
    }

    items.push({ clientId, balance, paid, free: freeAmount, ...meta });
  }

  return json({
    ok: true,
    count: items.length,
    cursor: listed.cursor || null,
    list_complete: listed.list_complete ?? true,
    items,
  }, 200, cors);
}

export async function handleAdminClientLookupByFingerprint(request, env, cors) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  await requireAdmin(request, env, ip);

  const body = await request.json();
  const { fingerprint } = body || {};
  if (!fingerprint || typeof fingerprint !== 'string') {
    return json({ error: 'fingerprint required' }, 400, cors);
  }

  const listed = await env.CREDITS.list({ prefix: 'client_meta:', limit: 1000 });
  const matches = [];

  for (const key of listed.keys) {
    const clientId = key.name.slice('client_meta:'.length);
    const raw = await env.CREDITS.get(key.name);
    if (!raw) continue;
    let meta;
    try { meta = JSON.parse(raw); } catch { continue; }
    if (meta.fingerprint === fingerprint) {
      const { effective } = await getEffectiveBalance(env, clientId);
      matches.push({ clientId, balance: effective, ...meta });
    }
  }

  return json({ ok: true, fingerprint, count: matches.length, matches }, 200, cors);
}

// =====================================================================
// HELPERS
// =====================================================================

export function json(data, status = 200, cors = { 'Access-Control-Allow-Origin': '*' }) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

export {
  BUNDLES,
  CHAIN_IDS,
  TOKEN_ADDRESSES,
  METHODS,
  SPONSOR_RPC,
  SPONSOR_TARGET_WEI,
  SPONSOR_MAX_WEI,
  SPONSOR_RATE_MAX,
  SPONSOR_RATE_WINDOW_MS,
  SPONSOR_IDEM_TTL,
  CONSUME_IDEM_TTL,
  CRYPTO_VERIFY_LOCK_TTL,
  FREE_CLAIM_CREDITS,
  FREE_CLAIM_WINDOW_MS,
  FREE_CLAIM_USE_WINDOW_MS,
  FREE_CLAIM_IP_MAX,
  FREE_CLAIM_FINGERPRINT_MAX,
  FREE_CLAIM_FINGERPRINT_TTL,
  FREE_CREDITS_TTL,
  SWEEP_COMMIT_TTL,
  ADMIN_AUTH_FAIL_MAX,
  ADMIN_AUTH_FAIL_WINDOW_MS,
  ADMIN_CALL_MAX,
  ADMIN_RATE_WINDOW_MS,
};