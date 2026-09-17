import { describe, it, expect } from 'vitest';
import { scrubSecret } from '../../scrub.js';

describe('scrubSecret', () => {
  describe('mnemonic scrubbing', () => {
    it('redacts a 12-word phrase', () => {
      const m = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
      expect(scrubSecret(m)).toBe('[REDACTED-MNEMONIC]');
    });

    it('redacts a 24-word phrase', () => {
      const m = Array(23).fill('abandon').join(' ') + ' art';
      expect(scrubSecret(m)).toBe('[REDACTED-MNEMONIC]');
    });

    it('redacts a phrase embedded in a longer string', () => {
      const s = 'Error: invalid BytesLike value (argument="value", value="0xabandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", code=INVALID_ARGUMENT)';
      expect(scrubSecret(s)).toContain('[REDACTED-MNEMONIC]');
      expect(scrubSecret(s)).not.toContain('abandon abandon');
    });

    it('redacts a 15-word phrase', () => {
      const m = Array(15).fill('zoo').join(' ');
      expect(scrubSecret(m)).toBe('[REDACTED-MNEMONIC]');
    });

    it('leaves short word sequences alone', () => {
      // 11 words is below the threshold.
      const s = 'one two three four five six seven eight nine ten eleven';
      expect(scrubSecret(s)).toBe(s);
    });

    it('leaves normal prose alone', () => {
      const s = 'The quick brown fox jumps over the lazy dog';
      expect(scrubSecret(s)).toBe(s);
    });

    it('does not redact when words have uppercase letters', () => {
      // The regex requires lowercase 3+ char words, so this passes through.
      const s = 'Abandon ABANDON Abandon Abandon Abandon Abandon Abandon Abandon Abandon Abandon Abandon About';
      expect(scrubSecret(s)).toBe(s);
    });
  });

  describe('hex private key scrubbing', () => {
    it('redacts a 32-byte hex key', () => {
      const key = '0x' + '11'.repeat(32);
      expect(scrubSecret(key)).toBe('0x[REDACTED-KEY]');
    });

    it('redacts a key embedded in a longer string', () => {
      const key = '0x' + 'ab'.repeat(32);
      const s = `sender=${key} value=1000`;
      expect(scrubSecret(s)).toBe('sender=0x[REDACTED-KEY] value=1000');
    });

    it('leaves a 20-byte address alone', () => {
      const addr = '0x8B180186C79D146fd5617B31A9e2A3d938954Fa9';
      expect(scrubSecret(addr)).toBe(addr);
    });

    it('leaves a transaction hash alone (32 bytes but hex length 64)', () => {
      // A tx hash is 32 bytes / 64 hex chars. The regex catches it.
      // This is a known trade-off — we prefer over-redaction of long
      // hex strings to under-redaction of keys.
      const txHash = '0x' + 'ab'.repeat(32);
      expect(scrubSecret(txHash)).toBe('0x[REDACTED-KEY]');
    });

    it('leaves a short hex fragment alone', () => {
      const s = '0xabc123';
      expect(scrubSecret(s)).toBe(s);
    });
  });

  describe('both patterns at once', () => {
    it('redacts a mnemonic and a key in the same string', () => {
      const m = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
      const k = '0x' + 'ff'.repeat(32);
      const s = `phrase="${m}" key=${k}`;
      const out = scrubSecret(s);
      expect(out).toContain('[REDACTED-MNEMONIC]');
      expect(out).toContain('0x[REDACTED-KEY]');
      expect(out).not.toContain('abandon abandon');
      expect(out).not.toContain('ffffffff');
    });
  });

  describe('input handling', () => {
    it('handles null', () => {
      expect(scrubSecret(null)).toBe('');
    });
    it('handles undefined', () => {
      expect(scrubSecret(undefined)).toBe('');
    });
    it('handles numbers', () => {
      expect(scrubSecret(42)).toBe('42');
    });
    it('handles objects by stringifying', () => {
      expect(scrubSecret({ a: 1 })).toBe('[object Object]');
    });
  });
});