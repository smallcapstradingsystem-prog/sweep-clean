/**
 * rpc-proxy.js — Cloudflare Worker
 * =====================================================================
 * Three responsibilities:
 *   1. /rpc/:chain              — proxy JSON-RPC calls, hide the API key
 *   2. /tokens/:chain/:address  — return ERC-20 holdings for a wallet
 *   3. /0x/*                    — proxy 0x Swap API, inject the API key
 *
 * Deploy:
 *   wrangler secret put ALCHEMY_KEY
 *   wrangler secret put HELIUS_KEY
 *   wrangler secret put ZERO_EX_API_KEY
 *   wrangler deploy -c wrangler.toml
 *
 * No logging of payloads. Only: timestamp, IP, route, status.
 */

const RPC_ENDPOINTS = {
  ethereum: (env) => `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`,
  arbitrum: (env) => `https://arb-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`,
  optimism: (env) => `https://opt-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`,
  base:     (env) => `https://base-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`,
  polygon:  (env) => `https://polygon-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`,
  bnb:      (env) => `https://bnb-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`,
  solana:   (env) => `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_KEY}`,
};

const ALCHEMY_NETWORKS = {
  ethereum: 'eth-mainnet',
  arbitrum: 'arb-mainnet',
  optimism: 'opt-mainnet',
  base:     'base-mainnet',
  polygon:  'polygon-mainnet',
  bnb:      'bnb-mainnet',
};

// 0x Swap API base. All requests are proxied through here so the
// ZERO_EX_API_KEY never reaches the client bundle.
const ZERO_EX_BASE = 'https://api.0x.org';
const ZERO_EX_VERSION = 'v2';

const rateLimitMap = new Map();
const RATE_WINDOW_MS = 60_000;

// Per-IP request budget. The client fans out aggressively: the
// preview estimate fires up to ESTIMATE_CONCURRENCY tokens at once,
// and each token quotes every Uniswap fee tier in parallel. On a
// wallet with many tokens across many chains, the request rate gets
// high. 120/min was too low and produced 429s during preview, which
// caused ethers to retry with backoff and stall the estimate.
//
// Alchemy's own rate limits are far above this — the free tier allows
// hundreds of requests per second — so the proxy is not the bottleneck
// at 600/min. If a single client ever legitimately needs more, raise
// this rather than lowering the client's concurrency, because the
// proxy has no other consumers to protect.
const RATE_MAX = 600;

function checkRate(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, reset: now + RATE_WINDOW_MS };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + RATE_WINDOW_MS;
  }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return entry.count <= RATE_MAX;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, solana-client, x-client-info, x-sdk-version, authorization',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (!checkRate(ip)) {
      return jsonResponse({ error: 'rate limited' }, 429);
    }

    try {
      const rpcMatch = pathname.match(/^\/rpc\/(\w+)$/);
      if (rpcMatch) {
        if (request.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);
        return await handleRpc(rpcMatch[1], request, env, ip);
      }

      const tokensMatch = pathname.match(/^\/tokens\/(\w+)\/(.+)$/);
      if (tokensMatch) {
        if (request.method !== 'GET') return jsonResponse({ error: 'GET required' }, 405);
        return await handleTokens(tokensMatch[1], tokensMatch[2], env, ip);
      }

      // 0x proxy: /0x/<path>?... → https://api.0x.org/<path>?...
      const zeroExMatch = pathname.match(/^\/0x\/(.+)$/);
      if (zeroExMatch) {
        return await handleZeroEx(zeroExMatch[1], request, env, ip, url.search);
      }

      return jsonResponse({ error: 'not found' }, 404);
    } catch (err) {
      console.error('worker error', { ip, pathname, message: err.message });
      return jsonResponse({ error: 'internal error' }, 500);
    }
  },
};

async function handleRpc(chain, request, env, ip) {
  const endpointFn = RPC_ENDPOINTS[chain];
  if (!endpointFn) return jsonResponse({ error: `unknown chain: ${chain}` }, 400);

  const body = await request.text();
  const target = endpointFn(env);

  const resp = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    ip,
    route: 'rpc',
    chain,
    status: resp.status,
  }));

  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function handleTokens(chain, address, env, ip) {
  const network = ALCHEMY_NETWORKS[chain];
  if (!network) {
    return jsonResponse({ error: `token discovery not supported for ${chain}` }, 400);
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return jsonResponse({ error: 'invalid address' }, 400);
  }

  const endpoint = `https://${network}.g.alchemy.com/v2/${env.ALCHEMY_KEY}`;

  const balancesResp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'alchemy_getTokenBalances',
      params: [address, 'erc20'],
    }),
  });

  const balancesJson = await balancesResp.json();
  const rawTokens = balancesJson?.result?.tokenBalances || [];

  const nonZero = rawTokens.filter((t) => {
    if (!t.tokenBalance || t.tokenBalance === '0x') return false;
    try {
      return BigInt(t.tokenBalance) > 0n;
    } catch {
      return false;
    }
  });

  const metadata = [];
  const BATCH = 50;
  for (let i = 0; i < nonZero.length; i += BATCH) {
    const chunk = nonZero.slice(i, i + BATCH);
    const results = await Promise.all(chunk.map(async (t) => {
      try {
        const metaResp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'alchemy_getTokenMetadata',
            params: [t.contractAddress],
          }),
        });
        const metaJson = await metaResp.json();
        const m = metaJson?.result || {};
        return {
          contractAddress: t.contractAddress,
          balance: t.tokenBalance,
          decimals: m.decimals ?? 18,
          symbol: m.symbol || '???',
          name: m.name || '',
          logo: m.logo || null,
        };
      } catch {
        return null;
      }
    }));
    metadata.push(...results.filter(Boolean));
  }

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    ip,
    route: 'tokens',
    chain,
    count: metadata.length,
  }));

  return jsonResponse({ tokens: metadata });
}

/**
 * Proxy a request to the 0x Swap API.
 *
 * The path after /0x/ is passed through verbatim (e.g.
 * "swap/allowance-holder/quote"), and the query string is preserved.
 * The API key is injected from the worker environment, so it never
 * appears in client-side code or network logs.
 */
async function handleZeroEx(subPath, request, env, ip, search) {
  if (!env.ZERO_EX_API_KEY) {
    return jsonResponse({ error: '0x proxy not configured' }, 503);
  }

  // Only allow safe methods — 0x quote endpoints are GET.
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'GET required for 0x proxy' }, 405);
  }

  const target = `${ZERO_EX_BASE}/${subPath}${search}`;

  const resp = await fetch(target, {
    method: 'GET',
    headers: {
      '0x-api-key': env.ZERO_EX_API_KEY,
      '0x-version': ZERO_EX_VERSION,
      accept: 'application/json',
    },
  });

  // Log path up to the third segment (e.g. "swap/allowance-holder/quote")
  // but never the query params.
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    ip,
    route: '0x',
    subPath: subPath.split('/').slice(0, 3).join('/'),
    status: resp.status,
  }));

  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}