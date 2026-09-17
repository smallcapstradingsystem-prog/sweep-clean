import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------
// Mock `ethers` BEFORE importing anything that uses it.
//
// The worker does `import { ethers } from 'ethers'` then calls
// `ethers.parseEther`, `ethers.JsonRpcProvider`, `ethers.Wallet`.
// Because ESM module namespaces are frozen we can't reassign those
// after import. `vi.mock` swaps the whole module out instead.
//
// The factory returns a mutable object with the same shape. Tests flip
// `behavior` to change what the fake provider/wallet does per case.
// ---------------------------------------------------------------------

// Derived from private key 0x1111...1111 (32 bytes of 0x11). This is
// the well-known test key used across the ethers / Foundry test suites;
// the address is deterministic and identical on every machine.
const SPONSOR_ADDRESS = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';

const behavior = {
  userBalance: 0n,
  sponsorBalance: 0n,
  gasPrice: 1_000_000_000n,
  sendTxHash: '0xabc',
  sendThrows: null,
  sponsorAddress: SPONSOR_ADDRESS,
};

vi.mock('ethers', async () => {
  const actual = await vi.importActual('ethers');

  class FakeProvider {
    constructor() {}
    async getBalance(addr) {
      if (addr.toLowerCase() === behavior.sponsorAddress.toLowerCase()) {
        return behavior.sponsorBalance;
      }
      return behavior.userBalance;
    }
    async getFeeData() {
      return { gasPrice: behavior.gasPrice };
    }
    async getNetwork() { return { chainId: 1n }; }
    async broadcastTransaction() {
      if (behavior.sendThrows) throw behavior.sendThrows;
      return { hash: behavior.sendTxHash };
    }
  }

  class FakeWallet {
    constructor(key, provider) {
      this.privateKey = key;
      this.provider = provider;
    }
    async getAddress() {
      return behavior.sponsorAddress;
    }
    connect(provider) { this.provider = provider; return this; }
    async sendTransaction() {
      if (behavior.sendThrows) throw behavior.sendThrows;
      return {
        hash: behavior.sendTxHash,
        async wait() { return { status: 1 }; },
      };
    }
  }

  return {
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: FakeProvider,
      Wallet: FakeWallet,
    },
  };
});

// ---------------------------------------------------------------------
// Now safe to import the worker and its helpers.
// ---------------------------------------------------------------------

import {
  handleGasSponsor,
  checkSponsorRate,
  SPONSOR_MAX_WEI,
  SPONSOR_TARGET_WEI,
  SPONSOR_RATE_MAX,
} from '../payment-worker.js';
import { createFakeEnv } from './helpers/fake-env.js';
import { makeRequest, readResponse } from './helpers/call-worker.js';
import { ethers } from 'ethers';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const TO_ADDR = '0x1111111111111111111111111111111111111111';
const SPONSOR_KEY = '0x' + '11'.repeat(32);

function setBehavior(partial) {
  Object.assign(behavior, {
    userBalance: 0n,
    sponsorBalance: 0n,
    gasPrice: 1_000_000_000n,
    sendTxHash: '0xabc',
    sendThrows: null,
    ...partial,
  });
}

describe('gas sponsor', () => {
  let env;

  beforeEach(() => {
    env = createFakeEnv({ GAS_SPONSOR_KEY: SPONSOR_KEY });
    setBehavior({});
  });

  it('rejects unknown chain', async () => {
    const req = makeRequest({
      body: { chain: 'dogecoin', toAddress: TO_ADDR, shortfallWei: '1000' },
      headers: { 'cf-connecting-ip': '1.1.1.1' },
    });
    const resp = await readResponse(await handleGasSponsor(req, env, CORS));
    expect(resp.status).toBe(400);
  });

  it('rejects a bad toAddress', async () => {
    const req = makeRequest({
      body: { chain: 'base', toAddress: 'not-an-address', shortfallWei: '1000' },
      headers: { 'cf-connecting-ip': '1.1.1.1' },
    });
    const resp = await readResponse(await handleGasSponsor(req, env, CORS));
    expect(resp.status).toBe(400);
  });

  it('returns sent:0 when client hint is 0', async () => {
    const req = makeRequest({
      body: { chain: 'base', toAddress: TO_ADDR, shortfallWei: '0' },
      headers: { 'cf-connecting-ip': '1.1.1.1' },
    });
    const resp = await readResponse(await handleGasSponsor(req, env, CORS));
    expect(resp.status).toBe(200);
    expect(resp.body.sent).toBe('0');
  });

  it('rejects a client hint above the max', async () => {
    const max = ethers.parseEther(SPONSOR_MAX_WEI.base);
    const req = makeRequest({
      body: { chain: 'base', toAddress: TO_ADDR, shortfallWei: (max + 1n).toString() },
      headers: { 'cf-connecting-ip': '1.1.1.1' },
    });
    const resp = await readResponse(await handleGasSponsor(req, env, CORS));
    expect(resp.status).toBe(400);
  });

  it('returns sent:0 when the user is already at target', async () => {
    const target = ethers.parseEther(SPONSOR_TARGET_WEI.base);
    setBehavior({
      userBalance: target,
      sponsorBalance: ethers.parseEther('1'),
    });

    const req = makeRequest({
      body: { chain: 'base', toAddress: TO_ADDR, shortfallWei: '1000' },
      headers: { 'cf-connecting-ip': '1.1.1.1' },
    });
    const resp = await readResponse(await handleGasSponsor(req, env, CORS));
    expect(resp.status).toBe(200);
    expect(resp.body.sent).toBe('0');
    expect(resp.body.reason).toBe('user already funded');
  });

  it('sends exactly target - balance when the user is short', async () => {
    const target = ethers.parseEther(SPONSOR_TARGET_WEI.base);
    const userBal = target - 5_000_000_000_000n;
    setBehavior({
      userBalance: userBal,
      sponsorBalance: ethers.parseEther('1'),
      sendTxHash: '0xfeed',
    });

    const req = makeRequest({
      body: { chain: 'base', toAddress: TO_ADDR, shortfallWei: '5000000000000' },
      headers: { 'cf-connecting-ip': '1.1.1.1' },
    });
    const resp = await readResponse(await handleGasSponsor(req, env, CORS));
    expect(resp.status).toBe(200);
    expect(resp.body.sent).toBe('5000000000000');
    expect(resp.body.txHash).toBe('0xfeed');
  });

  it('caps the send at the max even if the computed shortfall exceeds it', async () => {
    const target = ethers.parseEther(SPONSOR_TARGET_WEI.base);
    const max = ethers.parseEther(SPONSOR_MAX_WEI.base);
    setBehavior({
      userBalance: 0n,
      sponsorBalance: ethers.parseEther('1'),
    });

    const req = makeRequest({
      body: { chain: 'base', toAddress: TO_ADDR, shortfallWei: target.toString() },
      headers: { 'cf-connecting-ip': '1.1.1.1' },
    });
    const resp = await readResponse(await handleGasSponsor(req, env, CORS));
    expect(resp.status).toBe(200);
    expect(BigInt(resp.body.sent)).toBeLessThanOrEqual(max);
  });

  it('returns 503 when the sponsor wallet is low', async () => {
    const target = ethers.parseEther(SPONSOR_TARGET_WEI.base);
    setBehavior({
      userBalance: 0n,
      sponsorBalance: 1n,
    });

    const req = makeRequest({
      body: { chain: 'base', toAddress: TO_ADDR, shortfallWei: target.toString() },
      headers: { 'cf-connecting-ip': '1.1.1.1' },
    });
    const resp = await readResponse(await handleGasSponsor(req, env, CORS));
    expect(resp.status).toBe(503);
    expect(resp.body.error).toMatch(/low on native gas/);
  });

  it('is idempotent on (chain, toAddress)', async () => {
    const target = ethers.parseEther(SPONSOR_TARGET_WEI.base);
    const userBal = target - 5_000_000_000_000n;
    setBehavior({
      userBalance: userBal,
      sponsorBalance: ethers.parseEther('1'),
      sendTxHash: '0xfirst',
    });

    const body = { chain: 'base', toAddress: TO_ADDR, shortfallWei: '5000000000000' };
    const headers = { 'cf-connecting-ip': '1.1.1.1' };

    const resp1 = await readResponse(await handleGasSponsor(makeRequest({ body, headers }), env, CORS));
    expect(resp1.status).toBe(200);
    expect(resp1.body.txHash).toBe('0xfirst');

    // Second call within TTL should hit the idempotency key and NOT
    // touch the RPC again.
    setBehavior({
      userBalance: 0n,
      sponsorBalance: ethers.parseEther('1'),
      sendTxHash: '0xsecond',
    });

    const resp2 = await readResponse(await handleGasSponsor(makeRequest({ body, headers }), env, CORS));
    expect(resp2.status).toBe(200);
    expect(resp2.body.alreadySent).toBe(true);
    expect(resp2.body.txHash).toBe('0xfirst');
    expect(resp2.body.sent).toBe(resp1.body.sent);
  });

  it('returns 500 when the secret is not a valid key', async () => {
    env = createFakeEnv({ GAS_SPONSOR_KEY: 'not-a-key' });
    const req = makeRequest({
      body: { chain: 'base', toAddress: TO_ADDR, shortfallWei: '1000' },
      headers: { 'cf-connecting-ip': '1.1.1.1' },
    });
    const resp = await readResponse(await handleGasSponsor(req, env, CORS));
    expect(resp.status).toBe(500);
    expect(resp.body.error).toMatch(/misconfigured/);
  });

  it('returns 429 when rate limited', async () => {
    const ip = '9.9.9.9';
    for (let i = 0; i < SPONSOR_RATE_MAX; i++) {
      expect(await checkSponsorRate(env, ip)).toBe(true);
    }
    const req = makeRequest({
      body: { chain: 'base', toAddress: TO_ADDR, shortfallWei: '1000' },
      headers: { 'cf-connecting-ip': ip },
    });
    const resp = await readResponse(await handleGasSponsor(req, env, CORS));
    expect(resp.status).toBe(429);
  });

  it('returns 500 when sendTransaction throws', async () => {
    // The catch block around sponsorWallet.sendTransaction. A failure
    // here must return a static error — never echo the secret.
    const target = ethers.parseEther(SPONSOR_TARGET_WEI.base);
    setBehavior({
      userBalance: 0n,
      sponsorBalance: ethers.parseEther('1'),
      sendThrows: new Error('nonce too low'),
    });

    const req = makeRequest({
      body: { chain: 'base', toAddress: TO_ADDR, shortfallWei: target.toString() },
      headers: { 'cf-connecting-ip': '1.1.1.1' },
    });
    const resp = await readResponse(await handleGasSponsor(req, env, CORS));
    expect(resp.status).toBe(500);
    expect(resp.body.error).toBe('sponsor send failed');
    // The error message from the underlying throw must not leak.
    expect(JSON.stringify(resp.body)).not.toContain('nonce');
  });
});