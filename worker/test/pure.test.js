import { describe, it, expect } from 'vitest';
import {
  formatAmount,
  buildOperatorView,
  scaleUsdcToDecimals,
  buildSponsorWallet,
} from '../payment-worker.js';

describe('formatAmount', () => {
  it('formats 1 USDC', () => {
    expect(formatAmount(1000000n, 6)).toBe('1.000000');
  });
  it('formats fractions', () => {
    expect(formatAmount(1234n, 6)).toBe('0.001234');
  });
  it('formats 0', () => {
    expect(formatAmount(0n, 6)).toBe('0.000000');
  });
  it('formats BNB (18 decimals)', () => {
    expect(formatAmount(1000000000000000000n, 18)).toBe('1.000000000000000000');
  });
});

describe('scaleUsdcToDecimals', () => {
  it('is identity at 6 decimals', () => {
    expect(scaleUsdcToDecimals('1000000', 6)).toBe(1000000n);
  });
  it('scales up to 18 decimals', () => {
    expect(scaleUsdcToDecimals('1000000', 18)).toBe(1000000000000000000n);
  });
  it('scales down to fewer decimals', () => {
    expect(scaleUsdcToDecimals('1500000', 4)).toBe(15000n);
  });
});

describe('buildOperatorView', () => {
  it('includes send-to-user line with committed destination', () => {
    const dest = '0x1111111111111111111111111111111111111111';
    const view = buildOperatorView([{
      family: 'evm', chain: 'base', symbol: 'USDC', decimals: 6,
      amountRaw: '1000000', userShareRaw: '900000', operatorFeeRaw: '100000',
      recipient: '0x8B180186C79D146fd5617B31A9e2A3d938954Fa9',
      userDestination: dest,
    }], []);
    expect(view).toContain(`→ ${dest}`);
    expect(view).toContain('1.000000');
    expect(view).toContain('0.900000');
  });

  it('subtracts sponsorship fee when present', () => {
    const view = buildOperatorView([{
      family: 'evm', chain: 'base', symbol: 'USDC', decimals: 6,
      amountRaw: '1000000', userShareRaw: '900000', operatorFeeRaw: '100000',
      recipient: '0x8B180186C79D146fd5617B31A9e2A3d938954Fa9',
      userDestination: '0x1111111111111111111111111111111111111111',
    }], [{
      chain: 'base',
      sponsorshipFeeUsdcRaw: '100000', // 0.10 USDC
    }]);
    expect(view).toContain('Sponsorship fee');
    expect(view).toContain('0.100000');
  });
});

describe('buildSponsorWallet', () => {
  it('accepts a hex private key', () => {
    const w = buildSponsorWallet('0x' + '11'.repeat(32), null);
    expect(w).toBeDefined();
  });
  it('accepts a 12-word mnemonic', () => {
    const m = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const w = buildSponsorWallet(m, null);
    expect(w).toBeDefined();
  });
  it('rejects an invalid secret', () => {
    expect(() => buildSponsorWallet('not-a-key', null)).toThrow(/neither/);
  });
  it('rejects a mnemonic with the wrong word count', () => {
    expect(() => buildSponsorWallet('one two three four five six seven eight nine ten eleven twelve thirteen', null))
      .toThrow(/words/);
  });
});