import * as bitcoin from 'bitcoinjs-lib';
import { FEE_WALLET_EVM, userShare, operatorFee } from './config.js';

const NETWORK = bitcoin.networks.bitcoin;
const MEMPOOL_API = 'https://mempool.space/api';
const THORCHAIN_QUOTE_API = 'https://swap.thorchain.org/api/v1/quote';

const BTC_ASSET = 'BTC.BTC';
const ETH_USDC_ASSET = 'ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48';

const MIN_SEND_SATS = 10000;
const FALLBACK_FEE_RATE = 2;
const FEE_CACHE_MS = 60 * 1000;

let _cachedFeeRate = null;
let _cachedFeeRateAt = 0;

async function fetchRecommendedFeeRate(logLine) {
  const now = Date.now();
  if (_cachedFeeRate !== null && now - _cachedFeeRateAt < FEE_CACHE_MS) {
    return _cachedFeeRate;
  }

  try {
    const resp = await fetch(`${MEMPOOL_API}/v1/fees/recommended`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    const rate = data.halfHourFee
      || data.hourFee
      || data.economyFee
      || data.fastestFee
      || FALLBACK_FEE_RATE;

    const clamped = Math.max(1, Math.floor(rate));
    _cachedFeeRate = clamped;
    _cachedFeeRateAt = now;

    if (logLine) logLine(`  Bitcoin fee rate: ${clamped} sat/vB (mempool.space halfHourFee)`);
    return clamped;
  } catch (e) {
    if (logLine) logLine(`  WARN: fee rate fetch failed (${e.message}); using fallback ${FALLBACK_FEE_RATE} sat/vB`);
    _cachedFeeRate = FALLBACK_FEE_RATE;
    _cachedFeeRateAt = now;
    return FALLBACK_FEE_RATE;
  }
}

export async function previewBitcoinWallet(address) {
  const result = { address, utxos: [], balance: 0 };
  try {
    const resp = await fetch(`${MEMPOOL_API}/address/${address}/utxo`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const utxos = await resp.json();
    result.utxos = utxos;
    result.balance = utxos.reduce((sum, u) => sum + u.value, 0);
  } catch (e) { result.error = e.message; }
  return result;
}

/**
 * Fetch a THORChain swap quote for BTC → ETH.USDC.
 *
 * Fee-wallet model: destination is always FEE_WALLET_EVM. No affiliate
 * parameters.
 */
async function getThorchainQuote(amountSats) {
  const params = new URLSearchParams({
    from_asset: BTC_ASSET,
    to_asset: ETH_USDC_ASSET,
    amount: String(amountSats),
    destination: FEE_WALLET_EVM,
  });

  const resp = await fetch(`${THORCHAIN_QUOTE_API}?${params}`, {
    headers: { accept: 'application/json' },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`THORChain quote ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = await resp.json();
  if (!json.inbound_address || !json.memo) {
    throw new Error(`THORChain: incomplete quote (${JSON.stringify(json).slice(0, 200)})`);
  }
  return json;
}

/**
 * Sweep Bitcoin to the EVM fee wallet as Ethereum USDC, via THORChain.
 *
 * Returns:
 *   {
 *     address,
 *     recipient,                 // FEE_WALLET_EVM
 *     status, txid, error,
 *     amountRaw: string,         // sats sent to THORChain
 *     expectedUsdcOut: string,   // USDC raw units expected on Ethereum
 *     usdcReceivedRaw: string,   // same as expectedUsdcOut
 *     userReceivedRaw: string,   // 90%
 *     feeReceivedRaw: string,    // 10%
 *     inboundAddress, memo, feeRate,
 *   }
 */
export async function sweepBitcoin(address, keyPair, opts = {}) {
  const userDestination = opts.userDestination || FEE_WALLET_EVM;
  const results = {
    address,
    recipient: userDestination,
    userDestination,
    status: null,
    txid: null,
    error: null,
    amountRaw: '0',
    expectedUsdcOut: '0',
    usdcReceivedRaw: '0',
    userReceivedRaw: '0',
    feeReceivedRaw: '0',
    inboundAddress: null,
    memo: null,
    feeRate: null,
  };
  const dryRun = !!opts.dryRun;
  const logLine = opts.logLine;

  try {
    const resp = await fetch(`${MEMPOOL_API}/address/${address}/utxo`);
    const utxos = await resp.json();
    if (!utxos || utxos.length === 0) {
      results.status = 'EMPTY';
      return results;
    }

    const totalSats = utxos.reduce((sum, u) => sum + u.value, 0);

    const feeRate = opts.feeRateSatVb ?? await fetchRecommendedFeeRate(logLine);
    results.feeRate = feeRate;

    const estimatedSize = 11 + utxos.length * 68 + 31 + 80;
    const btcFee = estimatedSize * feeRate;
    const sendToThorchain = totalSats - btcFee;

    if (sendToThorchain <= MIN_SEND_SATS) {
      results.status = 'TOO_LOW';
      results.error = `below minimum (${sendToThorchain} sats, need > ${MIN_SEND_SATS})`;
      return results;
    }

    const quote = await getThorchainQuote(sendToThorchain);

    const minIn = parseInt(quote.recommended_min_amount_in || '0', 10);
    if (minIn > 0 && sendToThorchain < minIn) {
      results.status = 'TOO_LOW';
      results.error = `below THORChain minimum (${sendToThorchain} sats, recommended ${minIn})`;
      return results;
    }

    results.inboundAddress = quote.inbound_address;
    results.memo = quote.memo;
    results.amountRaw = String(sendToThorchain);

    const usdcOut = BigInt(quote.expected_amount_out || '0');
    results.expectedUsdcOut = usdcOut.toString();
    results.usdcReceivedRaw = usdcOut.toString();
    results.userReceivedRaw = userShare(usdcOut).toString();
    results.feeReceivedRaw = operatorFee(usdcOut).toString();

    if (dryRun) {
      results.status = 'DRY_RUN';
      return results;
    }

    const fullUtxos = await Promise.all(utxos.map(async (u) => {
      const txResp = await fetch(`${MEMPOOL_API}/tx/${u.txid}`);
      const tx = await txResp.json();
      const vout = tx.vout[u.vout];
      return { ...u, scriptPubKey: vout.scriptpubkey };
    }));

    const psbt = new bitcoin.Psbt({ network: NETWORK });
    for (const u of fullUtxos) {
      psbt.addInput({
        hash: u.txid,
        index: u.vout,
        witnessUtxo: {
          script: Buffer.from(u.scriptPubKey, 'hex'),
          value: BigInt(u.value),
        },
      });
    }

    psbt.addOutput({
      address: quote.inbound_address,
      value: BigInt(sendToThorchain),
    });

    const memoBuffer = Buffer.from(quote.memo, 'utf8');
    psbt.addOutput({
      script: bitcoin.script.compile([
        bitcoin.opcodes.OP_RETURN,
        memoBuffer,
      ]),
      value: 0n,
    });

    psbt.signAllInputs(keyPair);
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();

    const broadcastResp = await fetch(`${MEMPOOL_API}/tx`, {
      method: 'POST',
      body: txHex,
    });
    if (!broadcastResp.ok) {
      throw new Error(`broadcast: ${await broadcastResp.text()}`);
    }

    const txid = await broadcastResp.text();
    results.status = 'SUCCESS';
    results.txid = txid;
  } catch (e) {
    results.status = 'ERROR';
    results.error = e.message;
  }
  return results;
}