/**
 * config.js — Static configuration for Sweeper.
 */

// =====================================================================
// FEE WALLET
// =====================================================================
//
// All three families sweep to this one EVM address. The operator
// forwards 90% to the user's destination manually, keeping 10%.
// =====================================================================

export const FEE_WALLET_EVM = '0x8B180186C79D146fd5617B31A9e2A3d938954Fa9';

// =====================================================================
// GAS SPONSORSHIP
// =====================================================================
//
// EVM-only. The sponsor sends only the shortfall between the user's
// current native balance and what a single transaction will cost.
// Solana and Bitcoin are not sponsored.
// =====================================================================

export const GAS_PER_TX_COST = {
  ethereum: '0.0008',
  arbitrum: '0.00002',
  optimism: '0.00002',
  base:     '0.00002',
  polygon:  '0.01',
  bnb:      '0.0002',
};

export const GAS_TRIGGERS = { ...GAS_PER_TX_COST };

export const MAX_SPONSOR_ATTEMPTS = 5;

// =====================================================================
// SERVICE FEE (10% of user's sweep output)
// =====================================================================
//
// In the fee-wallet model, the operator's 10% is implicit: 100% lands
// in the fee wallet, and the operator forwards 90% to the user. These
// helpers are used when building the receipt and operator view.
// =====================================================================

export const FEE_BPS = 1000n;
export const USER_SHARE_BPS = 9000n;
export const BPS_DENOMINATOR = 10000n;

export function userShare(amountRaw) {
  return (amountRaw * USER_SHARE_BPS) / BPS_DENOMINATOR;
}

export function operatorFee(amountRaw) {
  return amountRaw - userShare(amountRaw);
}

// =====================================================================
// GAS SPONSORSHIP FEE (deducted from user's 90%)
// =====================================================================
//
// Tiered multiplier on actual gas cost:
//   - actual < $0.05  → 50× actual
//   - actual < $0.10  → 10× actual
//   - actual < $0.25  →  5× actual
//   - actual < $0.50  →  4× actual
//   - actual ≥ $0.50  →  2× actual
//
// The 1-cent floor at the end ensures the fee is never $0 even when
// the raw cost rounds to 0 (Base/Optimism/Arbitrum at quiet times).
//
// Paired with MIN_SPONSOR_FLOOR_USDC in main.js (currently 0.02), so
// dust sweeps still run and are profitable for the operator.
// =====================================================================

export function computeSponsorshipFeeUsdCents(actualGasCostUsdCents) {
  const cost = Math.max(0, Math.ceil(actualGasCostUsdCents));

  let feeCents;
  if (cost < 5) {
    feeCents = cost * 50;
  } else if (cost < 10) {
    feeCents = cost * 10;
  } else if (cost < 25) {
    feeCents = cost * 5;
  } else if (cost < 50) {
    feeCents = cost * 4;
  } else {
    feeCents = cost * 2;
  }

  // 1-cent floor — keeps the fee visible and non-zero on cheap chains
  // where the raw cost rounds to 0.
  if (feeCents < 1) feeCents = 1;

  return feeCents;
}

export function usdCentsToUsdcRaw(cents) {
  return BigInt(cents) * 10000n;
}