import { describe, it, expect } from 'vitest';

// These imports pull from config.js, which has no DOM deps. Good.
import {
  AUTO_LIVE_THRESHOLD_USDC,
  AUTO_LIVE_REQUIRE_CONFIRM,
  AUTO_LIVE_COUNTDOWN_SECONDS,
} from '../../config.js';

/**
 * The auto-live partition logic lives in main.js as collectEligible(),
 * which reads state.previews and cannot be imported directly in a Node
 * test without a DOM. Instead we test the pure predicate here, and the
 * main.js call sites are covered by manual smoke tests.
 *
 * IMPORTANT: isEligible takes exactly ONE parameter. If it took a
 * second optional `threshold`, Array.prototype.filter would pass the
 * element INDEX as that second argument, and the comparison would be
 * against 0, 1, 2, ... instead of the real threshold. That footgun
 * shipped once; the signature stays unary on purpose.
 */
function isEligible(value) {
  return (value || 0) >= AUTO_LIVE_THRESHOLD_USDC;
}

describe('auto-live thresholds', () => {
  it('threshold is 10', () => {
    expect(AUTO_LIVE_THRESHOLD_USDC).toBe(10);
  });

  it('require-confirm defaults to true', () => {
    expect(AUTO_LIVE_REQUIRE_CONFIRM).toBe(true);
  });

  it('countdown is a positive integer', () => {
    expect(Number.isInteger(AUTO_LIVE_COUNTDOWN_SECONDS)).toBe(true);
    expect(AUTO_LIVE_COUNTDOWN_SECONDS).toBeGreaterThan(0);
  });

  it('marks 9.99 as not eligible', () => {
    expect(isEligible(9.99)).toBe(false);
  });

  it('marks 10.00 as eligible', () => {
    expect(isEligible(10)).toBe(true);
  });

  it('marks 10.01 as eligible', () => {
    expect(isEligible(10.01)).toBe(true);
  });

  it('treats missing values as not eligible', () => {
    expect(isEligible(undefined)).toBe(false);
    expect(isEligible(null)).toBe(false);
    expect(isEligible(0)).toBe(false);
  });

  it('per-wallet: three wallets at $9 do not trigger on aggregate', () => {
    const perWallet = [9, 9, 9];
    const eligible = perWallet.filter(isEligible);
    expect(eligible).toHaveLength(0);
  });

  it('per-wallet: one wallet at $10 among $9s triggers', () => {
    const perWallet = [9, 10, 9];
    const eligible = perWallet.filter(isEligible);
    expect(eligible).toHaveLength(1);
  });
});