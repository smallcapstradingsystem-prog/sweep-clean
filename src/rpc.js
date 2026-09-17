/**
 * rpc.js — RPC client for the sweep app.
 *
 * Uses the Cloudflare Worker proxy when configured, falling back to
 * PublicNode endpoints otherwise. The Alchemy key lives only on the
 * worker, never in the client bundle.
 */

import { WORKER_SUBDOMAIN } from './env.js';

const PROXY_URL = `https://sweep-rpc.${WORKER_SUBDOMAIN}.workers.dev`;

const PUBLIC_RPCS = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  base:     'https://base-rpc.publicnode.com',
  polygon:  'https://polygon-bor-rpc.publicnode.com',
  bnb:      'https://bsc-rpc.publicnode.com',
  solana:   'https://api.mainnet-beta.solana.com',
};

export function getProxyUrl() {
  return PROXY_URL;
}

export function hasProxy() {
  return PROXY_URL.length > 0;
}

export function getRpcUrl(chain) {
  if (PROXY_URL) {
    return `${PROXY_URL}/rpc/${chain}`;
  }
  return PUBLIC_RPCS[chain];
}

export async function jsonRpc(chain, method, params = []) {
  const url = getRpcUrl(chain);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!resp.ok) throw new Error(`RPC ${chain} ${method}: HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.error) throw new Error(`RPC ${chain} ${method}: ${json.error.message}`);
  return json.result;
}

/**
 * Fetch ERC-20 token holdings for a wallet address.
 * Uses the Cloudflare proxy which calls alchemy_getTokenBalances.
 */
export async function discoverTokens(chain, address) {
  if (!PROXY_URL) {
    return [];
  }
  const resp = await fetch(`${PROXY_URL}/tokens/${chain}/${address}`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(`token discovery failed: ${err.error || resp.status}`);
  }
  const json = await resp.json();
  return json.tokens || [];
}

/**
 * Convenience: fetch USDC's decimals from the chain.
 */
export async function getUsdcMetadata(chain, usdcAddress) {
  try {
    const result = await jsonRpc(chain, 'eth_call', [
      {
        to: usdcAddress,
        data: '0x313ce567',
      },
      'latest',
    ]);
    return { decimals: parseInt(result, 16) };
  } catch {
    return { decimals: 6 };
  }
}