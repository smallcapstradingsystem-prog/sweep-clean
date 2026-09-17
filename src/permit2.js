/**
 * permit2.js — Uniswap Permit2 integration (kept for future use).
 * =====================================================================
 * Permit2 lets a user authorize a spender to pull tokens with an
 * off-chain signature instead of an on-chain `approve` transaction.
 *
 * IMPORTANT: Permit2 only helps when the ROUTER natively supports it.
 * SwapRouter02 (used in evm.js today) does NOT — it pulls tokens via
 * `transferFrom`, which requires a normal `approve`. The current EVM
 * path routes through 0x's AllowanceHolder, which has its own approval
 * flow and does not use Permit2.
 *
 * To actually benefit from Permit2, the app would need to swap through
 * Universal Router, which accepts a PERMIT2_PERMIT command bundled with
 * the swap. That migration is a separate project.
 *
 * ETHERS VERSION NOTE
 * --------------------
 * The upstream `@uniswap/permit2-sdk` is built against ethers v5 and
 * returns objects containing v5 BigNumber instances. This app uses
 * ethers v6, which requires native BigInt. Passing v5 BigNumbers into
 * ethers v6's `signTypedData` throws a type error:
 *
 *   Type 'BigNumber' is not assignable to type 'BigNumberish | null | undefined'
 *
 * Two ways to resolve this when you wire Permit2 up:
 *
 *   1. Install the community v6 fork instead of the upstream package:
 *        npm install @ericxstone/permit2-sdk
 *      and change the import below accordingly.
 *
 *   2. Keep the upstream package and rely on the `sanitizeForV6()`
 *      helper in this file, which walks the permit data and converts
 *      any v5 BigNumber instances to native BigInt before signing.
 *
 * This file currently uses option 2 (upstream package + sanitization)
 * so it works with whatever is in package.json today, but the import
 * is structured so switching to option 1 is a one-line change.
 *
 * Reference:
 *   https://docs.uniswap.org/contracts/permit2/overview
 *   https://github.com/Uniswap/sdks/issues/141
 */

import { ethers } from 'ethers';

// ---------------------------------------------------------------------
// SDK import — switch this to the v6 fork when you migrate to Universal
// Router. The rest of the file works with either.
// ---------------------------------------------------------------------
import {
  AllowanceTransfer,
  PERMIT2_ADDRESS,
  MaxAllowanceTransferAmount,
  MaxAllowanceExpiration,
} from '@uniswap/permit2-sdk';

// =====================================================================
// CONSTANTS
// =====================================================================
//
// The SDK exports MaxAllowanceTransferAmount and MaxAllowanceExpiration
// as ethers v5 BigNumber objects. Convert once at module load.
//
function toBigInt(x) {
  if (typeof x === 'bigint') return x;
  if (typeof x === 'number') return BigInt(x);
  if (typeof x === 'string') return BigInt(x);
  if (x == null) throw new Error('Cannot convert to BigInt: ' + x);
  // ethers v5 BigNumber
  if (typeof x.toHexString === 'function') return BigInt(x.toHexString());
  if (typeof x._hex === 'string') return BigInt(x._hex);
  // Last resort — string coercion
  return BigInt(String(x));
}

const MAX_AMOUNT = toBigInt(MaxAllowanceTransferAmount);
const MAX_EXPIRATION = Number(toBigInt(MaxAllowanceExpiration));

if (MAX_AMOUNT !== (2n ** 160n) - 1n) {
  console.warn('[permit2] MAX_AMOUNT has unexpected value:', MAX_AMOUNT.toString());
}
if (MAX_EXPIRATION !== Number((2n ** 48n) - 1n)) {
  console.warn('[permit2] MAX_EXPIRATION has unexpected value:', MAX_EXPIRATION);
}

// Permit2 canonical deployment — same address on every supported EVM chain.
const PERMIT2_DEPLOYED = {
  1: PERMIT2_ADDRESS,
  10: PERMIT2_ADDRESS,
  137: PERMIT2_ADDRESS,
  8453: PERMIT2_ADDRESS,
  42161: PERMIT2_ADDRESS,
};

// =====================================================================
// ABIs
// =====================================================================

const PERMIT2_ABI = [
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function permit(address owner, tuple(tuple(address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes calldata signature)',
  'function permit(address owner, tuple(tuple(address token, uint160 amount, uint48 expiration, uint48 nonce)[] details, address spender, uint256 sigDeadline) permitBatch, bytes calldata signature)',
  'function transferFrom(address from, address to, uint160 amount, address token)',
];

const ERC20_ABI = [
  'function approve(address, uint256) returns (bool)',
  'function allowance(address, address) view returns (uint256)',
];

// =====================================================================
// HELPERS
// =====================================================================

function getPermit2Address(chainId) {
  const addr = PERMIT2_DEPLOYED[Number(chainId)];
  if (!addr) {
    throw new Error(`Permit2 is not deployed at a known address on chain ${chainId}`);
  }
  return addr;
}

export function isPermit2Supported(chainId) {
  return typeof PERMIT2_DEPLOYED[Number(chainId)] === 'string';
}

/**
 * Walk a permit data object and convert any ethers v5 BigNumber instances
 * to native BigInt, so the result can be passed to ethers v6's
 * `signTypedData`.
 *
 * Recursive: handles nested objects and arrays. Leaves strings, numbers,
 * booleans, and existing BigInts untouched.
 */
function sanitizeForV6(value) {
  if (value == null) return value;

  // Already a BigInt
  if (typeof value === 'bigint') return value;

  // ethers v5 BigNumber detection
  if (typeof value === 'object' && typeof value.toHexString === 'function' && value._hex !== undefined) {
    return BigInt(value._hex);
  }

  // Alternative v5 BigNumber shape
  if (typeof value === 'object' && typeof value._hex === 'string' && Object.keys(value).length <= 2) {
    return BigInt(value._hex);
  }

  // Arrays — sanitize each element
  if (Array.isArray(value)) {
    return value.map(sanitizeForV6);
  }

  // Plain objects — sanitize each field
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeForV6(v);
    }
    return out;
  }

  return value;
}

// =====================================================================
// ALLOWANCE CHECKS
// =====================================================================

export async function isApprovedToPermit2(provider, owner, token, neededAmount) {
  const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);
  const [amount, expiration] = await permit2.allowance(owner, token, PERMIT2_ADDRESS);

  const now = Math.floor(Date.now() / 1000);
  const notExpired = Number(expiration) === 0 || Number(expiration) > now;
  const enoughAmount = BigInt(amount) >= BigInt(neededAmount);

  return {
    approved: notExpired && enoughAmount,
    current: BigInt(amount),
    expiration: Number(expiration),
  };
}

export async function approveTokenToPermit2(signer, token) {
  const erc20 = new ethers.Contract(token, ERC20_ABI, signer);
  const tx = await erc20.approve(PERMIT2_ADDRESS, ethers.MaxUint256);
  return tx;
}

// =====================================================================
// PERMIT SIGNING
// =====================================================================

export async function signPermitSingle(signer, { token, amount, spender, expirationSeconds = 3600 }) {
  const owner = await signer.getAddress();
  const provider = signer.provider;
  const chainId = Number((await provider.getNetwork()).chainId);

  getPermit2Address(chainId);

  const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);
  const [, , nonce] = await permit2.allowance(owner, token, PERMIT2_ADDRESS);

  const sigDeadline = Math.floor(Date.now() / 1000) + expirationSeconds;

  const permitSingle = {
    details: {
      token,
      amount: amount ?? MAX_AMOUNT,
      expiration: MAX_EXPIRATION,
      nonce: Number(nonce),
    },
    spender,
    sigDeadline,
  };

  const { domain, types, values } = AllowanceTransfer.getPermitData(
    permitSingle,
    PERMIT2_ADDRESS,
    chainId
  );

  // Convert any residual v5 BigNumbers in the SDK's output to native
  // BigInt so ethers v6's signTypedData can handle them.
  const safeValues = sanitizeForV6(values);
  const safeDomain = sanitizeForV6(domain);

  const signature = await signer.signTypedData(safeDomain, types, safeValues);

  return { permitData: permitSingle, signature };
}

export async function signPermitBatch(signer, tokens, spender, expirationSeconds = 3600) {
  const owner = await signer.getAddress();
  const provider = signer.provider;
  const chainId = Number((await provider.getNetwork()).chainId);

  getPermit2Address(chainId);

  const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);

  const details = await Promise.all(
    tokens.map(async (t) => {
      const [, , nonce] = await permit2.allowance(owner, t.address, PERMIT2_ADDRESS);
      return {
        token: t.address,
        amount: t.amount ?? MAX_AMOUNT,
        expiration: MAX_EXPIRATION,
        nonce: Number(nonce),
      };
    })
  );

  const sigDeadline = Math.floor(Date.now() / 1000) + expirationSeconds;

  const permitBatch = {
    details,
    spender,
    sigDeadline,
  };

  const { domain, types, values } = AllowanceTransfer.getPermitData(
    permitBatch,
    PERMIT2_ADDRESS,
    chainId
  );

  const safeValues = sanitizeForV6(values);
  const safeDomain = sanitizeForV6(domain);

  const signature = await signer.signTypedData(safeDomain, types, safeValues);

  return { permitData: permitBatch, signature };
}

// =====================================================================
// PERMIT SUBMISSION
// =====================================================================

export async function submitPermitSingle(signer, { permitData, signature }) {
  const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, signer);
  const owner = await signer.getAddress();
  const tx = await permit2[
    'permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)'
  ](owner, permitData, signature);
  return tx;
}

export async function submitPermitBatch(signer, { permitData, signature }) {
  const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, signer);
  const owner = await signer.getAddress();
  const tx = await permit2[
    'permit(address,((address,uint160,uint48,uint48)[],address,uint256),bytes)'
  ](owner, permitData, signature);
  return tx;
}

// =====================================================================
// HIGH-LEVEL
// =====================================================================

export async function ensurePermit2BatchApproval(signer, tokens, spender, opts = {}) {
  if (tokens.length === 0) return { txs: 0, skipped: true };

  const owner = await signer.getAddress();
  const provider = signer.provider;

  const needApproval = [];
  for (const t of tokens) {
    const { approved } = await isApprovedToPermit2(provider, owner, t.address, t.amount ?? 1n);
    if (!approved) needApproval.push(t);
  }

  if (opts.dryRun) {
    return {
      txs: needApproval.length + 1,
      dryRun: true,
      needApproval: needApproval.length,
    };
  }

  let approveTxs = 0;
  for (const t of needApproval) {
    const tx = await approveTokenToPermit2(signer, t.address);
    await tx.wait();
    approveTxs++;
  }

  let permitTxs = 0;
  if (needApproval.length > 0) {
    const { permitData, signature } = await signPermitBatch(signer, needApproval, spender);
    const tx = await submitPermitBatch(signer, { permitData, signature });
    await tx.wait();
    permitTxs = 1;
  }

  return { txs: approveTxs + permitTxs, tokens: tokens.length, needApproval: needApproval.length };
}

// =====================================================================
// EXPORTS
// =====================================================================

export { PERMIT2_ADDRESS, MAX_AMOUNT, MAX_EXPIRATION, sanitizeForV6 };