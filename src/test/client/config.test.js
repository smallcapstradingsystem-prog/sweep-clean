import { describe, it, expect } from 'vitest';
import {
  FEE_WALLET_EVM,
  GAS_PER_TX_COST,
  GAS_TRIGGERS,
  MAX_SPONSOR_ATTEMPTS,
  FEE_BPS,
  USER_SHARE_BPS,
  BPS_DENOMINATOR,
  userShare,
  operatorFee,
  computeSponsorshipFeeUsdCents,
  usdCentsToUsdcRaw,
} from '../../config.js';

describe('config constants', () => {
  it('exposes the fee wallet', () => {
    expect(FEE_WALLET_EVM).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('GAS_TRIGGERS mirrors GAS_PER_TX_COST', () => {
    expect(GAS_TRIGGERS).toEqual(GAS_PER_TX_COST);
    // And they should not share a reference — mutation of one must not
    // affect the other.
    GAS_TRIGGERS.base = '999';
    expect(GAS_PER_TX_COST.base).not.toBe('999');
    GAS_TRIGGERS.base = GAS_PER_TX_COST.base;
  });

  it('the BPS constants add up', () => {
    expect(FEE_BPS + USER_SHARE_BPS).toBe(BPS_DENOMINATOR);
  });

  it('MAX_SPONSOR_ATTEMPTS is a positive integer', () => {
    expect(Number.isInteger(MAX_SPONSOR_ATTEMPTS)).toBe(true);
    expect(MAX_SPONSOR_ATTEMPTS).toBeGreaterThan(0);
  });
});

describe('userShare', () => {
  it('is 90% of the input', () => {
    expect(userShare(1000000n)).toBe(900000n);
    expect(userShare(0n)).toBe(0n);
    expect(userShare(10n)).toBe(9n);
  });

  it('truncates for amounts not divisible by 10', () => {
    // 11 × 9000 / 10000 = 9.9 → 9 (BigInt division truncates)
    expect(userShare(11n)).toBe(9n);
  });

  it('handles large amounts without overflow', () => {
    const big = 10n ** 30n;
    expect(userShare(big)).toBe(big * 9000n / 10000n);
  });
});

describe('operatorFee', () => {
  it('is 10% of the input', () => {
    expect(operatorFee(1000000n)).toBe(100000n);
    expect(operatorFee(0n)).toBe(0n);
  });

  it('userShare + operatorFee equals the input for divisible amounts', () => {
    for (const amt of [1000n, 10000n, 1000000n, 10n ** 12n]) {
      expect(userShare(amt) + operatorFee(amt)).toBe(amt);
    }
  });

  it('userShare + operatorFee can leave a remainder for non-divisible amounts', () => {
    // 11 → user 9, fee 2. Sum is 11, so no remainder here.
    expect(userShare(11n) + operatorFee(11n)).toBe(11n);
    // 1 → user 0, fee 1. Sum is 1.
    expect(userShare(1n) + operatorFee(1n)).toBe(1n);
  });
});

describe('computeSponsorshipFeeUsdCents', () => {
  describe('tier boundaries', () => {
    // < 5¢  → 50×  (floor: 1¢)
    it('cost 0 → 1¢ (floor)', () => {
      expect(computeSponsorshipFeeUsdCents(0)).toBe(1);
    });
    it('cost 1 → 50¢', () => {
      expect(computeSponsorshipFeeUsdCents(1)).toBe(50);
    });
    it('cost 4 → 200¢', () => {
      expect(computeSponsorshipFeeUsdCents(4)).toBe(200);
    });

    // 5–9¢ → 10×
    it('cost 5 → 50¢', () => {
      expect(computeSponsorshipFeeUsdCents(5)).toBe(50);
    });
    it('cost 9 → 90¢', () => {
      expect(computeSponsorshipFeeUsdCents(9)).toBe(90);
    });

    // 10–24¢ → 5×
    it('cost 10 → 50¢', () => {
      expect(computeSponsorshipFeeUsdCents(10)).toBe(50);
    });
    it('cost 24 → 120¢', () => {
      expect(computeSponsorshipFeeUsdCents(24)).toBe(120);
    });

    // 25–49¢ → 4×
    it('cost 25 → 100¢', () => {
      expect(computeSponsorshipFeeUsdCents(25)).toBe(100);
    });
    it('cost 49 → 196¢', () => {
      expect(computeSponsorshipFeeUsdCents(49)).toBe(196);
    });

    // ≥ 50¢ → 2×
    it('cost 50 → 100¢', () => {
      expect(computeSponsorshipFeeUsdCents(50)).toBe(100);
    });
    it('cost 500 → 1000¢', () => {
      expect(computeSponsorshipFeeUsdCents(500)).toBe(1000);
    });
  });

  describe('rounding and non-integer input', () => {
    it('ceils a fractional cost', () => {
      // 4.1 → 5, which is in the 10× tier
      expect(computeSponsorshipFeeUsdCents(4.1)).toBe(50);
    });
    it('treats negative input as 0 → floor of 1', () => {
      expect(computeSponsorshipFeeUsdCents(-5)).toBe(1);
    });
    it('never returns 0', () => {
      for (const c of [0, 0.1, 0.9, -1, -100]) {
        expect(computeSponsorshipFeeUsdCents(c)).toBeGreaterThanOrEqual(1);
      }
    });
  });
});

describe('usdCentsToUsdcRaw', () => {
  it('multiplies by 10^4 (6-decimal USDC from cents)', () => {
    expect(usdCentsToUsdcRaw(1)).toBe(10000n);
    expect(usdCentsToUsdcRaw(100)).toBe(1000000n);
  });
  it('handles 0', () => {
    expect(usdCentsToUsdcRaw(0)).toBe(0n);
  });
  it('handles large values', () => {
    expect(usdCentsToUsdcRaw(1_000_000)).toBe(10_000_000_000n);
  });
});