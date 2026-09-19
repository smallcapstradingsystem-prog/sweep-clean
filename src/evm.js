import { ethers } from 'ethers';
import { getRpcUrl, discoverTokens } from './rpc.js';
import { FEE_WALLET_EVM, userShare, operatorFee } from './config.js';
import { WORKER_SUBDOMAIN } from './env.js';
import { runWithConcurrency, ESTIMATE_CONCURRENCY } from './concurrency.js';

// =====================================================================
// SWAP ENGINE SELECTION
// =====================================================================
//
// Two paths are implemented:
//
//   'uniswap'  — SwapRouter02 via the Uniswap Quoter. This is the live
//                path. Approves the router per token, then swaps.
//
//   '0x'       — 0x Swap API, routed through the /0x/ proxy on the
//                rpc-proxy worker. The worker injects the API key so
//                it never reaches the client. Requires the
//                ZERO_EX_API_KEY secret on the rpc-proxy worker.
//
// Flip this to '0x' to switch. Everything downstream (fee-wallet
// recipient, return shape, receipt) is identical either way.
// =====================================================================

const SWAP_ENGINE = 'uniswap';   // 'uniswap' | '0x'

// =====================================================================
// CONSTANTS
// =====================================================================

const USDC_ADDRESSES = {
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  base:     '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  polygon:  '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  bnb:      '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
};

const EXTRA_TOKENS = {
  ethereum: [
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
    { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI',  decimals: 18 },
  ],
  arbitrum: [
    { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', decimals: 6 },
  ],
  optimism: [
    { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', symbol: 'USDT', decimals: 6 },
  ],
  polygon: [
    { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT',   decimals: 6 },
    { address: '0x9417669fBF23357D2774e9D4234219952D36CA5B', symbol: 'USDT.e', decimals: 6 },
  ],
  base: [
    { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', symbol: 'USDT', decimals: 6 },
  ],
  bnb: [
    { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 },
    { address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', symbol: 'BUSD', decimals: 18 },
  ],
};

const CHAINS = {
  ethereum: {
    name: 'Ethereum', chainId: 1,
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    feeTiers: [100, 500, 3000, 10000],
    reserveMultiplier: 4n,
    baseReserveWei: ethers.parseEther('0.002'),
  },
  arbitrum: {
    name: 'Arbitrum', chainId: 42161,
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    feeTiers: [100, 500, 3000],
    reserveMultiplier: 3n,
    baseReserveWei: ethers.parseEther('0.0001'),
  },
  optimism: {
    name: 'Optimism', chainId: 10,
    weth: '0x4200000000000000000000000000000000000006',
    router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    feeTiers: [100, 500, 3000],
    reserveMultiplier: 3n,
    baseReserveWei: ethers.parseEther('0.0001'),
  },
  base: {
    name: 'Base', chainId: 8453,
    weth: '0x4200000000000000000000000000000000000006',
    router: '0x2626664c2603336E57B271c5C0b26F421741e481',
    quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    feeTiers: [100, 500, 3000],
    reserveMultiplier: 3n,
    baseReserveWei: ethers.parseEther('0.0001'),
  },
  polygon: {
    name: 'Polygon', chainId: 137,
    weth: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    feeTiers: [100, 500, 3000],
    reserveMultiplier: 3n,
    baseReserveWei: ethers.parseEther('0.1'),
  },
  bnb: {
    name: 'BNB Smart Chain', chainId: 56,
    weth: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    router: '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2',
    quoter: '0x78D78E420Da98ad378D7799bE8f4AF69033EB077',
    feeTiers: [100, 500, 3000],
    reserveMultiplier: 3n,
    baseReserveWei: ethers.parseEther('0.002'),
  },
};

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address, uint256) returns (bool)',
  'function allowance(address, address) view returns (uint256)',
  'function transfer(address, uint256) returns (bool)',
];
const WETH_ABI = [...ERC20_ABI, 'function deposit() payable'];

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];

const ZERO_EX_ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734';

const ZERO_EX_PROXY = `https://sweep-rpc.${WORKER_SUBDOMAIN}.workers.dev/0x`;

const MIN_SWAP_VALUE_USDC = ethers.parseUnits('0.50', 6);

const providerCache = {};

export function getProvider(chain) {
  if (!providerCache[chain]) {
    providerCache[chain] = new ethers.JsonRpcProvider(getRpcUrl(chain));
  }
  return providerCache[chain];
}

async function computeReserve(chain, provider) {
  const cfg = CHAINS[chain];
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? ethers.parseUnits('1', 'gwei');

  const estimatedCost = gasPrice * 300000n;
  const scaled = estimatedCost * cfg.reserveMultiplier;

  return scaled > cfg.baseReserveWei ? scaled : cfg.baseReserveWei;
}

export async function previewWallet(chain, walletAddress) {
  const cfg = CHAINS[chain];
  if (!cfg) throw new Error(`Unknown chain: ${chain}`);
  const provider = getProvider(chain);
  const usdc = USDC_ADDRESSES[chain];
  const result = { chain, chainName: cfg.name, address: walletAddress, native: null, tokens: [], gasPrice: null, error: null };

  try {
    const feeData = await provider.getFeeData();
    result.gasPrice = feeData.gasPrice?.toString() ?? '0';
  } catch (e) { result.error = `fee data: ${e.message}`; }

  try {
    const bal = await provider.getBalance(walletAddress);
    if (bal > 0n) {
      result.native = {
        symbol: chain === 'polygon' ? 'POL' : chain === 'bnb' ? 'BNB' : 'ETH',
        raw: bal.toString(),
        formatted: ethers.formatEther(bal),
      };
    }
  } catch (e) { result.error = (result.error ? result.error + '; ' : '') + `native: ${e.message}`; }

  const usdcDecimals = chain === 'bnb' ? 18 : 6;

  try {
    const token = new ethers.Contract(usdc, ERC20_ABI, provider);
    const bal = await token.balanceOf(walletAddress);
    if (bal > 0n) {
      result.tokens.push({
        address: usdc,
        symbol: 'USDC',
        decimals: usdcDecimals,
        raw: bal.toString(),
        formatted: ethers.formatUnits(bal, usdcDecimals),
        isUsdc: true,
      });
    }
  } catch (e) {}

  const extras = EXTRA_TOKENS[chain] || [];
  for (const extra of extras) {
    try {
      const token = new ethers.Contract(extra.address, ERC20_ABI, provider);
      const bal = await token.balanceOf(walletAddress);
      if (bal > 0n) {
        result.tokens.push({
          address: extra.address,
          symbol: extra.symbol,
          decimals: extra.decimals,
          raw: bal.toString(),
          formatted: ethers.formatUnits(bal, extra.decimals),
          isUsdc: false,
        });
      }
    } catch (e) {}
  }

  try {
    const discovered = await discoverTokens(chain, walletAddress);
    for (const t of discovered) {
      if (t.contractAddress.toLowerCase() === usdc.toLowerCase()) continue;
      if (extras.some((x) => x.address.toLowerCase() === t.contractAddress.toLowerCase())) continue;
      result.tokens.push({
        address: t.contractAddress,
        symbol: t.symbol || '???',
        decimals: t.decimals ?? 18,
        raw: t.balance,
        formatted: ethers.formatUnits(BigInt(t.balance), t.decimals ?? 18),
        logo: t.logo,
        isUsdc: false,
      });
    }
  } catch (e) {}

  return result;
}

/**
 * Find the best Uniswap quote for a token → USDC swap.
 *
 * All fee tiers are queried in parallel. Previously they were queried
 * sequentially, which meant a token with no pool paid the full cost of
 * four failed eth_call round-trips before being marked NO_ROUTE. On
 * wallets with many dust tokens that compounded into minutes of
 * estimation time. Parallel means one round-trip's worth of latency
 * regardless of how many tiers exist, and the best (highest out)
 * result still wins.
 *
 * The RPC proxy has a per-IP rate limit of 120 req/min. With
 * ESTIMATE_CONCURRENCY = 4 tokens in flight and up to 4 fee tiers per
 * token, that's ~16 concurrent requests per batch — under the limit,
 * but close enough that a rate-limit warning here means tuning
 * ESTIMATE_CONCURRENCY down.
 *
 * Failures across all tiers are collected and exposed on
 * `findBestQuote.lastFailures` for the caller to report as a
 * NO_ROUTE note.
 */
async function findBestQuote(quoter, tokenIn, tokenOut, amountIn, feeTiers) {
  const settled = await Promise.all(
    feeTiers.map(async (fee) => {
      try {
        const q = await quoter.quoteExactInputSingle.staticCall({
          tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0,
        });
        const out = q[0] ?? q.amountOut;
        if (out === undefined || out === null) {
          return { fee, out: null, reason: 'no amountOut in response' };
        }
        return { fee, out };
      } catch (e) {
        return { fee, out: null, reason: shortError(e) };
      }
    })
  );

  const successes = settled.filter((r) => r.out !== null && r.out !== undefined);
  if (successes.length === 0) {
    findBestQuote.lastFailures = settled.map((r) => ({ fee: r.fee, reason: r.reason }));
    return null;
  }

  successes.sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
  findBestQuote.lastFailures = null;
  return successes[0];
}

async function ensureApproval(tokenContract, owner, spender, amount, signer) {
  const allowance = await tokenContract.allowance(owner, spender);
  if (allowance >= amount) return null;
  // Approve the exact amount needed. MaxUint256 leaves a standing
  // approval that survives the sweep, which is a security footgun for
  // a wallet the user is about to abandon. One-shot approves cost a
  // few extra cents of gas but don't leave a live approval behind.
  return await tokenContract.connect(signer).approve(spender, amount);
}

function failureNote(failures) {
  if (!failures || failures.length === 0) return null;
  return failures.map((f) => `${f.fee / 10000}%: ${f.reason}`).join('; ');
}

async function simulateSwap(router, params, signer) {
  try {
    await router.connect(signer).exactInputSingle.staticCall(params);
    return { ok: true };
  } catch (e) {
    const msg = e.message || String(e);
    if (msg.includes('STF')) return { ok: false, reason: 'transfer restricted or fee-on-transfer' };
    if (msg.includes('Too little received')) return { ok: false, reason: 'slippage exceeded' };
    if (msg.includes('TransferHelper')) return { ok: false, reason: 'token transfer rejected' };
    if (msg.includes('SafeERC20')) return { ok: false, reason: 'token transfer rejected' };
    if (msg.includes('balance')) return { ok: false, reason: 'insufficient balance' };
    if (msg.includes('allowance')) return { ok: false, reason: 'approval missing' };
    if (msg.includes('reverted')) return { ok: false, reason: 'swap would revert' };
    return { ok: false, reason: shortError(e) };
  }
}

// =====================================================================
// USD ESTIMATE for the auto-live threshold
// =====================================================================
//
// Two behaviors differ from the previous version:
//
// 1. Native balance is priced MINUS the gas reserve the sweep leaves
//    behind, not the raw balance. On Ethereum the reserve is 0.008
//    ETH, so the old version overcounted by up to 5x on small wallets.
//
// 2. Per-token quotes are parallelized with a concurrency cap of 4,
//    so a wallet with many tokens doesn't stall the estimate. The cap
//    keeps us within RPC provider rate limits.
//
// Stablecoins are still priced at face value, and any token without
// a route counts as $0 (fail-closed).
// =====================================================================

export async function estimateChainValueUsdc(chain, preview) {
  const cfg = CHAINS[chain];
  if (!cfg || !preview) return 0;

  const provider = getProvider(chain);
  const usdc = USDC_ADDRESSES[chain];
  const usdcDecimals = chain === 'bnb' ? 18 : 6;
  const quoter = new ethers.Contract(cfg.quoter, QUOTER_ABI, provider);

  let total = 0;

  // ---- ERC-20 tokens ----
  const tokens = preview.tokens || [];
  const tokenQuotes = await runWithConcurrency(tokens, ESTIMATE_CONCURRENCY, async (t) => {
    const sym = (t.symbol || '').toUpperCase();

    if (sym.includes('USD') || sym === 'DAI') {
      const amt = parseFloat(t.formatted || '0');
      return Number.isFinite(amt) && amt > 0 ? amt : 0;
    }

    let raw;
    try { raw = BigInt(t.raw || '0'); } catch { return 0; }
    if (raw <= 0n) return 0;

    try {
      const best = await findBestQuote(quoter, t.address, usdc, raw, cfg.feeTiers);
      if (!best) return 0;
      if (best.out < MIN_SWAP_VALUE_USDC) return 0;
      const usdcValue = Number(ethers.formatUnits(best.out, usdcDecimals));
      return Number.isFinite(usdcValue) ? usdcValue : 0;
    } catch {
      return 0;
    }
  });
  for (const v of tokenQuotes) total += v;

  // ---- Native balance, minus the reserve the sweep would leave ----
  if (preview.native && preview.native.raw && BigInt(preview.native.raw) > 0n) {
    try {
      const nativeBal = BigInt(preview.native.raw);
      const reserve = await computeReserve(chain, provider);
      const sweepable = nativeBal > reserve ? nativeBal - reserve : 0n;
      if (sweepable > 0n) {
        const best = await findBestQuote(quoter, cfg.weth, usdc, sweepable, cfg.feeTiers);
        if (best && best.out >= MIN_SWAP_VALUE_USDC) {
          const usdcValue = Number(ethers.formatUnits(best.out, usdcDecimals));
          if (Number.isFinite(usdcValue)) total += usdcValue;
        }
      }
    } catch {
      // Skip native pricing on failure.
    }
  }

  return total;
}

// =====================================================================
// 0X — Swap API (kept for future use)
// =====================================================================

async function getZeroExQuote({
  chain,
  sellToken,
  buyToken,
  sellAmount,
  takerAddress,
  recipient,
  feeRecipient,
  feeBps,
}) {
  const cfg = CHAINS[chain];
  if (!cfg) throw new Error(`Unknown chain: ${chain}`);

  const params = new URLSearchParams({
    chainId: String(cfg.chainId),
    sellToken,
    buyToken,
    sellAmount: sellAmount.toString(),
    taker: takerAddress,
    recipient,
    swapFeeRecipient: feeRecipient,
    swapFeeBps: String(feeBps),
    swapFeeToken: buyToken,
  });

  const url = `${ZERO_EX_PROXY}/swap/allowance-holder/quote?${params}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`0x quote ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function swapViaZeroEx({
  chain,
  signer,
  sellToken,
  buyToken,
  sellAmount,
  recipient,
  feeRecipient,
  feeBps,
}) {
  const taker = await signer.getAddress();

  const quote = await getZeroExQuote({
    chain, sellToken, buyToken, sellAmount, takerAddress: taker,
    recipient, feeRecipient, feeBps,
  });

  const tokenWrite = new ethers.Contract(sellToken, ERC20_ABI, signer);
  const approveTx = await ensureApproval(tokenWrite, taker, ZERO_EX_ALLOWANCE_HOLDER, sellAmount, signer);
  if (approveTx) await approveTx.wait();

  const tx = await signer.sendTransaction({
    to: quote.transaction.to,
    data: quote.transaction.data,
    value: quote.transaction.value || '0x0',
    gasLimit: quote.transaction.gas ? ethers.toBigInt(quote.transaction.gas) : undefined,
  });
  const receipt = await tx.wait();

  const buyAmount = BigInt(quote.buyAmount || '0');
  const feeAmount = BigInt(quote.fees?.integratorFee?.amount || '0');

  return { tx, receipt, buyAmount, feeAmount, quote };
}

// =====================================================================
// SWEEP
// =====================================================================

export async function sweepEvm(chain, signerOrWallet, opts = {}) {
  const cfg = CHAINS[chain];
  if (!cfg) throw new Error(`Unknown chain: ${chain}`);
  const provider = getProvider(chain);
  const signer = signerOrWallet.connect
    ? (signerOrWallet.provider ? signerOrWallet : signerOrWallet.connect(provider))
    : signerOrWallet;
  const address = await signer.getAddress();
  const usdc = USDC_ADDRESSES[chain];
  const usdcDecimals = chain === 'bnb' ? 18 : 6;
  const dryRun = !!opts.dryRun;
  const slippageBps = BigInt(opts.slippageBps ?? 100);

  const recipient = FEE_WALLET_EVM;

  const results = {
    chain,
    address,
    recipient,
    swaps: [],
    transfers: [],
    errors: [],
    usdcReceivedRaw: '0',
    userReceivedRaw: '0',
    feeReceivedRaw: '0',
  };

  let totalReceived = 0n;

  const usdcContractRead = new ethers.Contract(usdc, ERC20_ABI, provider);
  const readFeeBalance = async () => {
    try { return await usdcContractRead.balanceOf(recipient); }
    catch { return 0n; }
  };

  // ---- USDC direct transfer ----
  try {
    const bal = await usdcContractRead.balanceOf(address);
    if (bal > 0n) {
      if (dryRun) {
        results.transfers.push({
          symbol: 'USDC',
          amount: ethers.formatUnits(bal, usdcDecimals),
          status: 'DRY_RUN',
        });
        totalReceived += bal;
      } else {
        const before = await readFeeBalance();
        const usdcWrite = new ethers.Contract(usdc, ERC20_ABI, signer);
        const tx = await usdcWrite.transfer(recipient, bal);
        const receipt = await tx.wait();
        const after = await readFeeBalance();
        const received = after > before ? after - before : 0n;
        totalReceived += received;
        results.transfers.push({
          symbol: 'USDC',
          amount: ethers.formatUnits(bal, usdcDecimals),
          received: ethers.formatUnits(received, usdcDecimals),
          txHash: tx.hash,
          status: receipt.status === 1 ? 'SUCCESS' : 'FAILED',
        });
      }
    }
  } catch (e) { results.errors.push(`USDC transfer: ${shortError(e)}`); }

  // ---- ERC-20 tokens ----
  if (opts.tokens && opts.tokens.length > 0) {
    const quoter = new ethers.Contract(cfg.quoter, QUOTER_ABI, provider);
    const routerRead = new ethers.Contract(cfg.router, ROUTER_ABI, provider);
    const router = new ethers.Contract(cfg.router, ROUTER_ABI, signer);

    for (const token of opts.tokens) {
      if (token.address.toLowerCase() === usdc.toLowerCase()) continue;
      try {
        const tokenRead = new ethers.Contract(token.address, ERC20_ABI, provider);
        const bal = await tokenRead.balanceOf(address);
        if (bal === 0n) continue;

        if (SWAP_ENGINE === '0x') {
          if (dryRun) {
            try {
              const taker = address;
              const quote = await getZeroExQuote({
                chain, sellToken: token.address, buyToken: usdc, sellAmount: bal,
                takerAddress: taker, recipient, feeRecipient: recipient, feeBps: 0,
              });
              const buyAmount = BigInt(quote.buyAmount || '0');
              results.swaps.push({
                symbol: token.symbol,
                amountIn: ethers.formatUnits(bal, token.decimals),
                amountOutExpected: ethers.formatUnits(buyAmount, usdcDecimals),
                mode: '0x',
                status: 'DRY_RUN',
              });
              totalReceived += buyAmount;
            } catch (e) {
              results.swaps.push({ symbol: token.symbol, status: 'NO_ROUTE', note: `0x quote failed: ${e.message}` });
            }
            continue;
          }

          try {
            const { tx, receipt, buyAmount } = await swapViaZeroEx({
              chain, signer,
              sellToken: token.address, buyToken: usdc, sellAmount: bal,
              recipient, feeRecipient: recipient, feeBps: 0,
            });
            totalReceived += buyAmount;
            results.swaps.push({
              symbol: token.symbol,
              txHash: tx.hash,
              received: ethers.formatUnits(buyAmount, usdcDecimals),
              mode: '0x',
              status: receipt.status === 1 ? 'SUCCESS' : 'FAILED',
            });
          } catch (e) {
            results.swaps.push({ symbol: token.symbol, status: 'ERROR', error: shortError(e) });
          }
          continue;
        }

        // Uniswap path
        const best = await findBestQuote(quoter, token.address, usdc, bal, cfg.feeTiers);
        if (!best) {
          results.swaps.push({
            symbol: token.symbol,
            status: 'NO_ROUTE',
            note: failureNote(findBestQuote.lastFailures),
          });
          continue;
        }

        if (best.out < MIN_SWAP_VALUE_USDC) {
          results.swaps.push({
            symbol: token.symbol,
            status: 'SKIPPED',
            note: `value too low (~$${ethers.formatUnits(best.out, usdcDecimals)} USDC)`,
          });
          continue;
        }

        const minOut = best.out - (best.out * slippageBps) / 10000n;

        if (dryRun) {
          results.swaps.push({
            symbol: token.symbol,
            amountIn: ethers.formatUnits(bal, token.decimals),
            amountOutExpected: ethers.formatUnits(best.out, usdcDecimals),
            amountOutMinimum: ethers.formatUnits(minOut, usdcDecimals),
            feeTier: best.fee,
            mode: 'uniswap',
            status: 'DRY_RUN',
          });
          totalReceived += best.out;
          continue;
        }

        const tokenWrite = new ethers.Contract(token.address, ERC20_ABI, signer);
        const approveTx = await ensureApproval(tokenWrite, address, cfg.router, bal, signer);
        if (approveTx) await approveTx.wait();

        const simParams = {
          tokenIn: token.address,
          tokenOut: usdc,
          fee: best.fee,
          recipient,
          amountIn: bal,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0,
        };

        const sim = await simulateSwap(routerRead, simParams, signer);
        if (!sim.ok) {
          results.swaps.push({ symbol: token.symbol, status: 'SKIPPED', note: sim.reason });
          continue;
        }

        const before = await readFeeBalance();
        const tx = await router.exactInputSingle(simParams);
        const receipt = await tx.wait();
        const after = await readFeeBalance();
        const received = after > before ? after - before : 0n;
        totalReceived += received;

        results.swaps.push({
          symbol: token.symbol,
          txHash: tx.hash,
          received: ethers.formatUnits(received, usdcDecimals),
          mode: 'uniswap',
          status: receipt.status === 1 ? 'SUCCESS' : 'FAILED',
        });
      } catch (e) {
        results.swaps.push({ symbol: token.symbol, status: 'ERROR', error: shortError(e) });
      }
    }
  }

  // ---- Native token → USDC ----
  //
  // NOTE: The wrap step is irreversible once broadcast. If the swap
  // that follows fails or is rejected, WETH is left in the user's
  // wallet. They can unwrap it manually. Batching wrap+swap would
  // require a custom router that we don't have.
  try {
    const nativeBal = await provider.getBalance(address);
    const minSwap = ethers.parseEther('0.00005');
    const nativeSym = chain === 'polygon' ? 'WPOL' : chain === 'bnb' ? 'WBNB' : 'WETH';

    if (nativeBal <= minSwap) {
      // nothing
    } else if (dryRun) {
      const reserve = await computeReserve(chain, provider);
      const sweepable = nativeBal > reserve ? nativeBal - reserve : 0n;
      if (sweepable > minSwap) {
        const quoter = new ethers.Contract(cfg.quoter, QUOTER_ABI, provider);
        const best = await findBestQuote(quoter, cfg.weth, usdc, sweepable, cfg.feeTiers);
        if (!best) {
          results.swaps.push({ symbol: nativeSym, status: 'NO_ROUTE', note: failureNote(findBestQuote.lastFailures) });
        } else if (best.out < MIN_SWAP_VALUE_USDC) {
          results.swaps.push({ symbol: nativeSym, status: 'SKIPPED', note: `value too low` });
        } else {
          results.swaps.push({
            symbol: nativeSym,
            amountIn: ethers.formatEther(sweepable),
            amountOutExpected: ethers.formatUnits(best.out, usdcDecimals),
            feeTier: best.fee,
            mode: SWAP_ENGINE === '0x' ? '0x' : 'uniswap',
            status: 'DRY_RUN',
          });
          totalReceived += best.out;
        }
      }
    } else {
      const reserve = await computeReserve(chain, provider);
      if (nativeBal > reserve + minSwap) {
        const wrapAmount = nativeBal - reserve;

        const weth = new ethers.Contract(cfg.weth, WETH_ABI, signer);
        const wrapTx = await weth.deposit({ value: wrapAmount });
        await wrapTx.wait();

        if (SWAP_ENGINE === '0x') {
          try {
            const { tx, receipt, buyAmount } = await swapViaZeroEx({
              chain, signer,
              sellToken: cfg.weth, buyToken: usdc, sellAmount: wrapAmount,
              recipient, feeRecipient: recipient, feeBps: 0,
            });
            totalReceived += buyAmount;
            results.swaps.push({
              symbol: nativeSym,
              txHash: tx.hash,
              received: ethers.formatUnits(buyAmount, usdcDecimals),
              mode: '0x',
              status: receipt.status === 1 ? 'SUCCESS' : 'FAILED',
            });
          } catch (e) {
            results.swaps.push({ symbol: nativeSym, status: 'ERROR', error: shortError(e) });
          }
        } else {
          const quoter = new ethers.Contract(cfg.quoter, QUOTER_ABI, provider);
          const best = await findBestQuote(quoter, cfg.weth, usdc, wrapAmount, cfg.feeTiers);
          if (!best) {
            results.swaps.push({ symbol: nativeSym, status: 'NO_ROUTE', note: failureNote(findBestQuote.lastFailures) });
          } else if (best.out < MIN_SWAP_VALUE_USDC) {
            results.swaps.push({ symbol: nativeSym, status: 'SKIPPED', note: `value too low` });
          } else {
            const approveTx = await ensureApproval(weth, address, cfg.router, wrapAmount, signer);
            if (approveTx) await approveTx.wait();
            const minOut = best.out - (best.out * slippageBps) / 10000n;
            const router = new ethers.Contract(cfg.router, ROUTER_ABI, signer);
            const before = await readFeeBalance();
            const tx = await router.exactInputSingle({
              tokenIn: cfg.weth, tokenOut: usdc, fee: best.fee,
              recipient, amountIn: wrapAmount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0,
            });
            const receipt = await tx.wait();
            const after = await readFeeBalance();
            const received = after > before ? after - before : 0n;
            totalReceived += received;
            results.swaps.push({
              symbol: nativeSym,
              txHash: tx.hash,
              received: ethers.formatUnits(received, usdcDecimals),
              mode: 'uniswap',
              status: receipt.status === 1 ? 'SUCCESS' : 'FAILED',
            });
          }
        }
      } else if (nativeBal > 0n) {
        results.swaps.push({ symbol: nativeSym, status: 'SKIPPED', note: `below reserve` });
      }
    }
  } catch (e) { results.errors.push(`native: ${shortError(e)}`); }

  results.usdcReceivedRaw = totalReceived.toString();
  results.userReceivedRaw = userShare(totalReceived).toString();
  results.feeReceivedRaw = operatorFee(totalReceived).toString();
  return results;
}

function shortError(e) {
  const msg = e.message || String(e);
  if (msg.includes('insufficient funds')) return 'insufficient gas';
  if (msg.includes('user rejected')) return 'rejected';
  if (msg.includes('nonce has already been used')) return 'nonce conflict';
  if (msg.includes('replacement transaction underpriced')) return 'nonce conflict';
  if (msg.includes('CALL_EXCEPTION')) return 'reverted';
  if (msg.includes('could not detect network')) return 'RPC unreachable';
  if (msg.includes('missing revert data')) return 'no pool';
  if (msg.includes('STF')) return 'no pool or insufficient liquidity';
  if (msg.includes('cannot use object value with unnamed components')) return 'ABI mismatch';
  return msg.length > 120 ? msg.slice(0, 120) + '...' : msg;
}

export { CHAINS, USDC_ADDRESSES, ERC20_ABI };