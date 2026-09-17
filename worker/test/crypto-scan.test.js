import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleCryptoVerify } from '../payment-worker.js';
import { createFakeEnv } from './helpers/fake-env.js';
import { makeRequest, readResponse, installFetchMock, jsonResponse } from './helpers/call-worker.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const CLIENT_ID = 'clientaaa00000000000000000000000';

// Seed a pending payment directly into KV so we can control the shape
// the scanner sees.
async function seedPending(env, {
  paymentId = 'pay-1',
  chain,
  token,
  address = '0xfeed000000000000000000000000000000000000',
  expectedRaw = '5000000',
  decimals = 6,
  credits = 1,
  expiresAt = new Date(Date.now() + 60_000).toISOString(),
} = {}) {
  await env.PENDING_PAYMENTS.put(
    `crypto:${paymentId}`,
    JSON.stringify({
      method: 'test', chain, token, clientId: CLIENT_ID,
      bundle: 'single', credits,
      expectedRaw, decimals, address, expiresAt,
      createdAt: new Date().toISOString(),
    }),
    { expirationTtl: 3600 },
  );
}

describe('crypto verify — EVM scan', () => {
  let env;
  let mock;

  beforeEach(() => { env = createFakeEnv(); });
  afterEach(() => { if (mock) { mock.restore(); mock = null; } });

  it('credits the account when a matching ERC-20 transfer is found', async () => {
    const address = '0xfeed000000000000000000000000000000000000';
    const expectedRaw = '5000000';
    await seedPending(env, { chain: 'base', token: 'USDC', address, expectedRaw });

    mock = installFetchMock((url) => {
      if (url.includes('etherscan.io')) {
        return jsonResponse({
          status: '1',
          result: [
            { to: address, value: expectedRaw, hash: '0xmatch', blockNumber: '1' },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const resp = await readResponse(await handleCryptoVerify(
      makeRequest({ body: { payment_id: 'pay-1' } }),
      env, CORS,
    ));
    expect(resp.status).toBe(200);
    expect(resp.body.ok).toBe(true);
    expect(resp.body.creditsAdded).toBe(1);
    expect(resp.body.txHash).toBe('0xmatch');
  });

  it('returns pending when no matching transfer is present', async () => {
    await seedPending(env, { chain: 'base', token: 'USDC' });
    mock = installFetchMock(() => jsonResponse({ status: '1', result: [] }));

    const resp = await readResponse(await handleCryptoVerify(
      makeRequest({ body: { payment_id: 'pay-1' } }),
      env, CORS,
    ));
    expect(resp.body.status).toBe('pending');
    expect(resp.body.ok).toBeUndefined();
  });

  it('ignores a transfer to a different address', async () => {
    await seedPending(env, {
      chain: 'base', token: 'USDC',
      address: '0xfeed000000000000000000000000000000000000',
      expectedRaw: '5000000',
    });
    mock = installFetchMock(() => jsonResponse({
      status: '1',
      result: [
        { to: '0xotheraddress00000000000000000000000000', value: '5000000', hash: '0xnope' },
      ],
    }));

    const resp = await readResponse(await handleCryptoVerify(
      makeRequest({ body: { payment_id: 'pay-1' } }),
      env, CORS,
    ));
    expect(resp.body.status).toBe('pending');
  });

  it('ignores a transfer with a different amount', async () => {
    await seedPending(env, {
      chain: 'base', token: 'USDC',
      address: '0xfeed000000000000000000000000000000000000',
      expectedRaw: '5000000',
    });
    mock = installFetchMock(() => jsonResponse({
      status: '1',
      result: [
        { to: '0xfeed000000000000000000000000000000000000', value: '4999999', hash: '0xwrong' },
      ],
    }));

    const resp = await readResponse(await handleCryptoVerify(
      makeRequest({ body: { payment_id: 'pay-1' } }),
      env, CORS,
    ));
    expect(resp.body.status).toBe('pending');
  });

  it('scans native ETH transfers', async () => {
    const address = '0xfeed000000000000000000000000000000000000';
    const expectedRaw = '1670000000000000';  // 0.00167 ETH
    await seedPending(env, {
      chain: 'base', token: 'ETH', address, expectedRaw, decimals: 18,
    });
    mock = installFetchMock(() => jsonResponse({
      status: '1',
      result: [
        { to: address, value: expectedRaw, hash: '0xethmatch', blockNumber: '1' },
      ],
    }));

    const resp = await readResponse(await handleCryptoVerify(
      makeRequest({ body: { payment_id: 'pay-1' } }),
      env, CORS,
    ));
    expect(resp.body.ok).toBe(true);
    expect(resp.body.txHash).toBe('0xethmatch');
  });

  it('returns pending when Etherscan reports no API key', async () => {
    env = createFakeEnv({ ETHERSCAN_API_KEY: '' });
    await seedPending(env, { chain: 'base', token: 'USDC' });

    // No fetch mock — the code should bail before hitting the network.
    mock = installFetchMock(() => {
      throw new Error('should not fetch without API key');
    });

    const resp = await readResponse(await handleCryptoVerify(
      makeRequest({ body: { payment_id: 'pay-1' } }),
      env, CORS,
    ));
    expect(resp.body.status).toBe('pending');
  });

  it('returns pending when Etherscan returns a non-array result', async () => {
    await seedPending(env, { chain: 'base', token: 'USDC' });
    mock = installFetchMock(() => jsonResponse({ status: '0', result: 'error' }));

    const resp = await readResponse(await handleCryptoVerify(
      makeRequest({ body: { payment_id: 'pay-1' } }),
      env, CORS,
    ));
    expect(resp.body.status).toBe('pending');
  });
});

describe('crypto verify — Solana scan', () => {
  let env;
  let mock;

  beforeEach(() => { env = createFakeEnv(); });
  afterEach(() => { if (mock) { mock.restore(); mock = null; } });

  it('credits the account when a matching SOL transfer is found', async () => {
    const address = 'So11111111111111111111111111111111111111112';
    const expectedRaw = '1000000000';  // 1 SOL in lamports
    await seedPending(env, {
      chain: 'solana', token: 'SOL', address, expectedRaw, decimals: 9,
    });

    mock = installFetchMock((url) => {
      if (url.includes('helius.xyz')) {
        return jsonResponse([
          {
            signature: 'sol-tx-hash',
            nativeTransfers: [
              { toUserAccount: address, amount: expectedRaw },
            ],
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const resp = await readResponse(await handleCryptoVerify(
      makeRequest({ body: { payment_id: 'pay-1' } }),
      env, CORS,
    ));
    expect(resp.body.ok).toBe(true);
    expect(resp.body.txHash).toBe('sol-tx-hash');
  });

  it('returns pending when no matching transfer', async () => {
    await seedPending(env, {
      chain: 'solana', token: 'SOL',
      address: 'So11111111111111111111111111111111111111112',
      expectedRaw: '1000000000', decimals: 9,
    });
    mock = installFetchMock(() => jsonResponse([]));

    const resp = await readResponse(await handleCryptoVerify(
      makeRequest({ body: { payment_id: 'pay-1' } }),
      env, CORS,
    ));
    expect(resp.body.status).toBe('pending');
  });

  it('returns pending when Helius is unreachable', async () => {
    await seedPending(env, {
      chain: 'solana', token: 'SOL',
      address: 'So11111111111111111111111111111111111111112',
      expectedRaw: '1000000000', decimals: 9,
    });
    mock = installFetchMock(() => ({
      ok: false, status: 500,
      async json() { return {}; },
      async text() { return ''; },
    }));

    const resp = await readResponse(await handleCryptoVerify(
      makeRequest({ body: { payment_id: 'pay-1' } }),
      env, CORS,
    ));
    expect(resp.body.status).toBe('pending');
  });
});

describe('crypto verify — Bitcoin scan', () => {
  let env;
  let mock;

  beforeEach(() => { env = createFakeEnv(); });
  afterEach(() => { if (mock) { mock.restore(); mock = null; } });

  it('credits the account when a matching BTC output is found', async () => {
    const address = 'bc1qtest';
    const expectedRaw = '100000';   // 0.001 BTC in sats
    await seedPending(env, {
      chain: 'bitcoin', token: 'BTC', address, expectedRaw, decimals: 8,
    });

    mock = installFetchMock((url) => {
      if (url.includes('mempool.space')) {
        return jsonResponse([
          {
            txid: 'btc-tx-hash',
            vout: [
              { scriptpubkey_address: 'bc1qother', value: 999 },
              { scriptpubkey_address: address, value: 100000 },
            ],
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const resp = await readResponse(await handleCryptoVerify(
      makeRequest({ body: { payment_id: 'pay-1' } }),
      env, CORS,
    ));
    expect(resp.body.ok).toBe(true);
    expect(resp.body.txHash).toBe('btc-tx-hash');
  });

  it('returns pending when no matching output', async () => {
    await seedPending(env, {
      chain: 'bitcoin', token: 'BTC', address: 'bc1qtest',
      expectedRaw: '100000', decimals: 8,
    });
    mock = installFetchMock(() => jsonResponse([]));

    const resp = await readResponse(await handleCryptoVerify(
      makeRequest({ body: { payment_id: 'pay-1' } }),
      env, CORS,
    ));
    expect(resp.body.status).toBe('pending');
  });

  it('returns pending when mempool.space is unreachable', async () => {
    await seedPending(env, {
      chain: 'bitcoin', token: 'BTC', address: 'bc1qtest',
      expectedRaw: '100000', decimals: 8,
    });
    mock = installFetchMock(() => ({
      ok: false, status: 503,
      async json() { return {}; },
      async text() { return ''; },
    }));

    const resp = await readResponse(await handleCryptoVerify(
      makeRequest({ body: { payment_id: 'pay-1' } }),
      env, CORS,
    ));
    expect(resp.body.status).toBe('pending');
  });
});