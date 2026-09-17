import { describe, it, expect, vi } from 'vitest';
import {
  isRetryableFeeError,
  recordFeeWithRetry,
  commitSweepWithRetry,
  ensureWalletGasOnce,
  withGasSponsorship,
} from '../../retry.js';

// A no-op sleep so tests don't actually wait.
const noSleep = async () => {};

describe('isRetryableFeeError', () => {
  it('treats 4xx (except 429) as permanent', () => {
    expect(isRetryableFeeError(new Error('HTTP 400'))).toBe(false);
    expect(isRetryableFeeError(new Error('HTTP 403'))).toBe(false);
    expect(isRetryableFeeError(new Error('HTTP 404'))).toBe(false);
  });

  it('treats 429 as retryable', () => {
    expect(isRetryableFeeError(new Error('HTTP 429'))).toBe(true);
  });

  it('treats 5xx as retryable', () => {
    expect(isRetryableFeeError(new Error('HTTP 500'))).toBe(true);
    expect(isRetryableFeeError(new Error('HTTP 503'))).toBe(true);
  });

  it('treats known validation errors as permanent', () => {
    expect(isRetryableFeeError(new Error('receipts required'))).toBe(false);
    expect(isRetryableFeeError(new Error('receipt[0] bad'))).toBe(false);
    expect(isRetryableFeeError(new Error('sweepId required'))).toBe(false);
    expect(isRetryableFeeError(new Error('clientId required'))).toBe(false);
    expect(isRetryableFeeError(new Error('sweepId not committed'))).toBe(false);
    expect(isRetryableFeeError(new Error('different client'))).toBe(false);
  });

  it('treats generic errors as retryable', () => {
    expect(isRetryableFeeError(new Error('NetworkError'))).toBe(true);
    expect(isRetryableFeeError(new Error('timeout'))).toBe(true);
    expect(isRetryableFeeError(new Error(''))).toBe(true);
  });

  it('handles null/undefined', () => {
    expect(isRetryableFeeError(null)).toBe(true);
    expect(isRetryableFeeError(undefined)).toBe(true);
  });
});

describe('recordFeeWithRetry', () => {
  it('returns on first success', async () => {
    const recordFn = vi.fn().mockResolvedValue({ ok: true });
    const r = await recordFeeWithRetry({
      recordFn, payload: {}, sleep: noSleep,
    });
    expect(r).toEqual({ ok: true });
    expect(recordFn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient errors and succeeds', async () => {
    const recordFn = vi.fn()
      .mockRejectedValueOnce(new Error('HTTP 500'))
      .mockRejectedValueOnce(new Error('HTTP 500'))
      .mockResolvedValueOnce({ ok: true });

    const r = await recordFeeWithRetry({
      recordFn, payload: {}, sleep: noSleep,
    });
    expect(r).toEqual({ ok: true });
    expect(recordFn).toHaveBeenCalledTimes(3);
  });

  it('bails immediately on a permanent error', async () => {
    const recordFn = vi.fn().mockRejectedValue(new Error('HTTP 400'));
    await expect(recordFeeWithRetry({
      recordFn, payload: {}, sleep: noSleep,
    })).rejects.toThrow('HTTP 400');
    expect(recordFn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting attempts on persistent 5xx', async () => {
    const recordFn = vi.fn().mockRejectedValue(new Error('HTTP 503'));
    await expect(recordFeeWithRetry({
      recordFn, payload: {}, sleep: noSleep,
    })).rejects.toThrow('HTTP 503');
    expect(recordFn).toHaveBeenCalledTimes(3);  // FEE_RECORD_MAX_ATTEMPTS
  });

  it('logs a retry line on attempt 2', async () => {
    const recordFn = vi.fn()
      .mockRejectedValueOnce(new Error('HTTP 500'))
      .mockResolvedValueOnce({ ok: true });
    const logLine = vi.fn();
    await recordFeeWithRetry({ recordFn, payload: {}, logLine, sleep: noSleep });
    expect(logLine).toHaveBeenCalledWith(expect.stringContaining('attempt 1/3'));
    expect(logLine).toHaveBeenCalledWith(expect.stringContaining('attempt 2/3'));
  });

  it('uses the configured backoff sequence', async () => {
    const sleeps = [];
    const sleep = async (ms) => { sleeps.push(ms); };
    const recordFn = vi.fn().mockRejectedValue(new Error('HTTP 500'));
    await expect(recordFeeWithRetry({
      recordFn, payload: {}, sleep,
      config: { maxAttempts: 3, backoffMs: [100, 200] },
    })).rejects.toThrow();
    expect(sleeps).toEqual([100, 200]);
  });

  it('falls back to the last backoff value when maxAttempts exceeds backoffMs.length', async () => {
    // When the attempt index runs past the end of the backoffMs array,
    // the code reuses the last entry rather than crashing on `undefined`.
    const sleeps = [];
    const sleep = async (ms) => { sleeps.push(ms); };
    const recordFn = vi.fn().mockRejectedValue(new Error('HTTP 500'));

    await expect(recordFeeWithRetry({
      recordFn, payload: {}, sleep,
      config: { maxAttempts: 4, backoffMs: [100, 200] },
    })).rejects.toThrow('HTTP 500');

    expect(sleeps).toEqual([100, 200, 200]);
  });
});

describe('commitSweepWithRetry', () => {
  it('returns on first success', async () => {
    const commitFn = vi.fn().mockResolvedValue({ ok: true });
    const r = await commitSweepWithRetry({
      commitFn, sweepId: 'sweep-aaa', userDestination: '0x11', sleep: noSleep,
    });
    expect(r).toEqual({ ok: true });
    expect(commitFn).toHaveBeenCalledWith('sweep-aaa', '0x11');
  });

  it('retries on 5xx and succeeds', async () => {
    const commitFn = vi.fn()
      .mockRejectedValueOnce(new Error('HTTP 502'))
      .mockResolvedValueOnce({ ok: true });
    const r = await commitSweepWithRetry({
      commitFn, sweepId: 's', userDestination: '0x', sleep: noSleep,
    });
    expect(r).toEqual({ ok: true });
    expect(commitFn).toHaveBeenCalledTimes(2);
  });

  it('bails on 4xx immediately', async () => {
    const commitFn = vi.fn().mockRejectedValue(new Error('HTTP 409'));
    await expect(commitSweepWithRetry({
      commitFn, sweepId: 's', userDestination: '0x', sleep: noSleep,
    })).rejects.toThrow('HTTP 409');
    expect(commitFn).toHaveBeenCalledTimes(1);
  });

  it('bails on worker validation errors', async () => {
    const commitFn = vi.fn().mockRejectedValue(new Error('sweepId required'));
    await expect(commitSweepWithRetry({
      commitFn, sweepId: 's', userDestination: '0x', sleep: noSleep,
    })).rejects.toThrow('sweepId required');
    expect(commitFn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting attempts', async () => {
    const commitFn = vi.fn().mockRejectedValue(new Error('HTTP 500'));
    await expect(commitSweepWithRetry({
      commitFn, sweepId: 's', userDestination: '0x', sleep: noSleep,
    })).rejects.toThrow('HTTP 500');
    expect(commitFn).toHaveBeenCalledTimes(2);  // COMMIT_MAX_ATTEMPTS
  });

  it('accepts a scalar (number) backoffMs', async () => {
    // When config.backoffMs is a plain number, the retry uses that
    // value directly rather than indexing into an array.
    const sleeps = [];
    const sleep = async (ms) => { sleeps.push(ms); };
    const commitFn = vi.fn()
      .mockRejectedValueOnce(new Error('HTTP 502'))
      .mockResolvedValueOnce({ ok: true });

    const r = await commitSweepWithRetry({
      commitFn, sweepId: 's', userDestination: '0x', sleep,
      config: { maxAttempts: 2, backoffMs: 75 },
    });

    expect(r).toEqual({ ok: true });
    expect(sleeps).toEqual([75]);
  });

  it('does not crash when logLine is omitted on retry', async () => {
    // The `if (logLine)` guard around the retry log line. Exercising
    // the retry path without a logLine argument proves the guard is
    // in place.
    const commitFn = vi.fn()
      .mockRejectedValueOnce(new Error('HTTP 502'))
      .mockResolvedValueOnce({ ok: true });

    const r = await commitSweepWithRetry({
      commitFn, sweepId: 's', userDestination: '0x', sleep: noSleep,
      // No logLine
    });

    expect(r).toEqual({ ok: true });
    expect(commitFn).toHaveBeenCalledTimes(2);
  });
});

describe('ensureWalletGasOnce', () => {
  const parseEther = (str) => {
    // Minimal decimal-ETH parser good enough for these tests.
    const [whole, frac = ''] = String(str).split('.');
    const padded = (frac + '0'.repeat(18)).slice(0, 18);
    return BigInt(whole) * 10n ** 18n + BigInt(padded);
  };
  const formatEther = (wei) => {
    const s = wei.toString().padStart(19, '0');
    const whole = s.slice(0, s.length - 18);
    const frac = s.slice(s.length - 18);
    return `${whole}.${frac}`;
  };

  const perTxCost = { base: '0.00002' };

  it('returns ok when the wallet already has enough gas', async () => {
    const sponsorFn = vi.fn();
    const getBalance = vi.fn().mockResolvedValue(parseEther('0.001'));
    const r = await ensureWalletGasOnce({
      sponsorFn, getBalance, parseEther, formatEther,
      chain: 'base', walletAddress: '0xabc', perTxCost,
    });
    expect(r).toEqual({ ok: true });
    expect(sponsorFn).not.toHaveBeenCalled();
  });

  it('requests the shortfall when the wallet is low', async () => {
    const sponsorFn = vi.fn().mockResolvedValue({ ok: true, sent: '10000000000000', txHash: '0x1' });
    const getBalance = vi.fn().mockResolvedValue(parseEther('0.00001'));
    const r = await ensureWalletGasOnce({
      sponsorFn, getBalance, parseEther, formatEther,
      chain: 'base', walletAddress: '0xabc', perTxCost,
    });
    expect(r.ok).toBe(true);
    expect(r.sponsoredWei).toBe(10000000000000n);
    expect(sponsorFn).toHaveBeenCalledWith('base', '0xabc', expect.any(String));
  });

  it('returns ok with no sponsored amount when sponsor sends 0', async () => {
    const sponsorFn = vi.fn().mockResolvedValue({ ok: true, sent: '0' });
    const getBalance = vi.fn().mockResolvedValue(0n);
    const r = await ensureWalletGasOnce({
      sponsorFn, getBalance, parseEther, formatEther,
      chain: 'base', walletAddress: '0xabc', perTxCost,
    });
    expect(r.ok).toBe(true);
    expect(r.sponsoredWei).toBeUndefined();
  });

  it('returns not-ok when the sponsor rejects', async () => {
    const sponsorFn = vi.fn().mockResolvedValue({ ok: false, error: 'rate limited' });
    const getBalance = vi.fn().mockResolvedValue(0n);
    const r = await ensureWalletGasOnce({
      sponsorFn, getBalance, parseEther, formatEther,
      chain: 'base', walletAddress: '0xabc', perTxCost,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('rate limited');
  });

  it('returns not-ok when the sponsor call throws', async () => {
    const sponsorFn = vi.fn().mockRejectedValue(new Error('network down'));
    const getBalance = vi.fn().mockResolvedValue(0n);
    const r = await ensureWalletGasOnce({
      sponsorFn, getBalance, parseEther, formatEther,
      chain: 'base', walletAddress: '0xabc', perTxCost,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('network down');
  });

  it('returns ok when the chain has no configured per-tx cost', async () => {
    const r = await ensureWalletGasOnce({
      sponsorFn: vi.fn(), getBalance: vi.fn(), parseEther, formatEther,
      chain: 'dogecoin', walletAddress: '0xabc', perTxCost,
    });
    expect(r).toEqual({ ok: true });
  });

  it('works without a logLine argument', async () => {
    // The `if (logLine)` guard around the "Sponsored …" line. Passing
    // a successful sponsor response without a logLine verifies the
    // guard does not throw.
    const sponsorFn = vi.fn().mockResolvedValue({
      ok: true, sent: '10000000000000', txHash: '0x1',
    });
    const getBalance = vi.fn().mockResolvedValue(0n);

    const r = await ensureWalletGasOnce({
      sponsorFn, getBalance, parseEther, formatEther,
      chain: 'base', walletAddress: '0xabc', perTxCost,
      // No logLine
    });

    expect(r.ok).toBe(true);
    expect(r.sponsoredWei).toBe(10000000000000n);
  });
});

describe('withGasSponsorship', () => {
  it('returns the action result on first try', async () => {
    const ensureGas = vi.fn().mockResolvedValue({ ok: true });
    const action = vi.fn().mockResolvedValue({ status: 'SUCCESS' });
    const r = await withGasSponsorship({ ensureGas, action, maxAttempts: 5, sleep: noSleep });
    expect(r.result).toEqual({ status: 'SUCCESS' });
    expect(r.sponsoredTotal).toBe(0n);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('accumulates sponsoredWei across attempts', async () => {
    const ensureGas = vi.fn()
      .mockResolvedValueOnce({ ok: true, sponsoredWei: 1000n })
      .mockResolvedValueOnce({ ok: true, sponsoredWei: 2000n });
    const action = vi.fn()
      .mockRejectedValueOnce(new Error('insufficient funds'))
      .mockResolvedValueOnce({ status: 'SUCCESS' });

    const r = await withGasSponsorship({ ensureGas, action, maxAttempts: 5, sleep: noSleep });
    expect(r.sponsoredTotal).toBe(3000n);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('retries when the action reports insufficient gas', async () => {
    const ensureGas = vi.fn().mockResolvedValue({ ok: true });
    const action = vi.fn()
      .mockRejectedValueOnce(new Error('insufficient funds for gas'))
      .mockResolvedValueOnce({ status: 'SUCCESS' });
    const r = await withGasSponsorship({ ensureGas, action, maxAttempts: 5, sleep: noSleep });
    expect(r.result.status).toBe('SUCCESS');
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('bails immediately on a non-gas error', async () => {
    const ensureGas = vi.fn().mockResolvedValue({ ok: true });
    const action = vi.fn().mockRejectedValue(new Error('user rejected'));
    await expect(withGasSponsorship({
      ensureGas, action, maxAttempts: 5, sleep: noSleep,
    })).rejects.toThrow('user rejected');
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('throws a sponsorUnavailable error when the sponsor is down', async () => {
    const ensureGas = vi.fn().mockResolvedValue({ ok: false, reason: 'rate limited' });
    const action = vi.fn();
    try {
      await withGasSponsorship({ ensureGas, action, maxAttempts: 5, sleep: noSleep });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.sponsorUnavailable).toBe(true);
      expect(e.message).toMatch(/gas sponsor unavailable/);
    }
    expect(action).not.toHaveBeenCalled();
  });

  it('throws after exhausting attempts on persistent insufficient gas', async () => {
    const ensureGas = vi.fn().mockResolvedValue({ ok: true });
    const action = vi.fn().mockRejectedValue(new Error('insufficient funds'));
    await expect(withGasSponsorship({
      ensureGas, action, maxAttempts: 3, sleep: noSleep,
    })).rejects.toThrow(/Exhausted 3 sponsorship attempts/);
    expect(action).toHaveBeenCalledTimes(3);
  });
});