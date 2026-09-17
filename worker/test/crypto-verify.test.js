import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleCryptoQuote, handleCryptoVerify } from '../payment-worker.js';
import { createFakeEnv } from './helpers/fake-env.js';
import { makeRequest, readResponse, installFetchMock, jsonResponse } from './helpers/call-worker.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const CLIENT_ID = 'clientaaa00000000000000000000000';

describe('crypto quote + verify', () => {
  let env;
  let mock;

  beforeEach(() => { env = createFakeEnv(); });
  afterEach(() => { if (mock) { mock.restore(); mock = null; } });

  async function quoteAndGetPaymentId() {
    const req = makeRequest({ body: { clientId: CLIENT_ID, bundle: 'single', method: 'usdc-base' } });
    const resp = await readResponse(await handleCryptoQuote(req, env, CORS));
    expect(resp.status).toBe(200);
    return resp.body;
  }

  it('produces a quote with the expected shape', async () => {
    const quote = await quoteAndGetPaymentId();
    expect(quote.chain).toBe('base');
    expect(quote.token).toBe('USDC');
    expect(quote.address).toBe(env.CRYPTO_ADDRESS_EVM);
    expect(quote.credits).toBe(1);
    expect(quote.payment_id).toMatch(/[0-9a-f-]{36}/);
  });

  it('returns 404 for an unknown payment_id', async () => {
    const resp = await readResponse(await handleCryptoVerify(
      makeRequest({ body: { payment_id: 'nope' } }),
      env, CORS,
    ));
    expect(resp.status).toBe(404);
  });

  it('returns pending when the scan finds nothing', async () => {
    const quote = await quoteAndGetPaymentId();
    // Etherscan returns an empty result set.
    mock = installFetchMock((url) => {
      if (url.includes('etherscan.io')) return jsonResponse({ status: '0', result: [] });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const resp = await readResponse(await handleCryptoVerify(
      makeRequest({ body: { payment_id: quote.payment_id } }),
      env, CORS,
    ));
    expect(resp.status).toBe(200);
    expect(resp.body.status).toBe('pending');
  });

  it('credits the account when the scan finds a matching transfer', async () => {
    const quote = await quoteAndGetPaymentId();
    const stored = JSON.parse(await env.PENDING_PAYMENTS.get(`crypto:${quote.payment_id}`));

    mock = installFetchMock((url) => {
      if (url.includes('etherscan.io')) {
        return jsonResponse({
          status: '1',
          result: [{
            to: stored.address,
            value: stored.expectedRaw,
            hash: '0xtxhash',
            blockNumber: '100',
          }],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const resp = await readResponse(await handleCryptoVerify(
      makeRequest({ body: { payment_id: quote.payment_id } }),
      env, CORS,
    ));
    expect(resp.status).toBe(200);
    expect(resp.body.ok).toBe(true);
    expect(resp.body.creditsAdded).toBe(1);
    expect(resp.body.newBalance).toBe(1);
  });

  it('short-circuits on already verified', async () => {
    const quote = await quoteAndGetPaymentId();
    const pending = JSON.parse(await env.PENDING_PAYMENTS.get(`crypto:${quote.payment_id}`));
    pending.verified = true;
    await env.PENDING_PAYMENTS.put(`crypto:${quote.payment_id}`, JSON.stringify(pending));

    // Install a fetch that throws if anything tries to scan.
    mock = installFetchMock(() => { throw new Error('should not fetch'); });

    const resp = await readResponse(await handleCryptoVerify(
      makeRequest({ body: { payment_id: quote.payment_id } }),
      env, CORS,
    ));
    expect(resp.status).toBe(200);
    expect(resp.body.alreadyVerified).toBe(true);
  });

  it('returns 410 for an expired payment', async () => {
    const quote = await quoteAndGetPaymentId();
    const pending = JSON.parse(await env.PENDING_PAYMENTS.get(`crypto:${quote.payment_id}`));
    pending.expiresAt = new Date(Date.now() - 60_000).toISOString();
    await env.PENDING_PAYMENTS.put(`crypto:${quote.payment_id}`, JSON.stringify(pending));

    const resp = await readResponse(await handleCryptoVerify(
      makeRequest({ body: { payment_id: quote.payment_id } }),
      env, CORS,
    ));
    expect(resp.status).toBe(410);
  });

  it('lock: a second call while the first is scanning returns pending', async () => {
    const quote = await quoteAndGetPaymentId();
    const stored = JSON.parse(await env.PENDING_PAYMENTS.get(`crypto:${quote.payment_id}`));

    // Pre-populate the lock to simulate a concurrent verification.
    await env.CREDITS.put(`crypto:lock:${quote.payment_id}`, '1', { expirationTtl: 30 });

    mock = installFetchMock(() => {
      // The lock path should never reach the scan.
      throw new Error('should not scan while locked');
    });

    const resp = await readResponse(await handleCryptoVerify(
      makeRequest({ body: { payment_id: quote.payment_id } }),
      env, CORS,
    ));
    expect(resp.status).toBe(200);
    expect(resp.body.status).toBe('pending');
    expect(resp.body.message).toMatch(/in progress/);
  });
});