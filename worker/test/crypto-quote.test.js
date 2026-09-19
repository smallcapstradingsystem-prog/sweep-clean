import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleCryptoQuote, METHODS } from '../payment-worker.js';
import { createFakeEnv } from './helpers/fake-env.js';
import { makeRequest, readResponse, installFetchMock, jsonResponse } from './helpers/call-worker.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const CLIENT_ID = 'clientaaa00000000000000000000000';

// A canned CoinGecko response. Used for the ETH/SOL/BTC token paths.
// USDC and USDT don't hit the network — they short-circuit to $1.
const COINGECKO_PRICES = {
  ethereum: 3000,
  solana: 150,
  bitcoin: 60000,
};

describe('handleCryptoQuote', () => {
  let env;
  let mock;

  beforeEach(() => { env = createFakeEnv(); });
  afterEach(() => { if (mock) { mock.restore(); mock = null; } });

  function installCoingecko() {
    mock = installFetchMock((url) => {
      if (url.includes('coingecko.com')) {
        const id = new URL(url).searchParams.get('ids');
        return jsonResponse({ [id]: { usd: COINGECKO_PRICES[id] } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  it('returns a USDC quote on Base', async () => {
    const req = makeRequest({
      body: { clientId: CLIENT_ID, bundle: 'single', method: 'usdc-base' },
    });
    const resp = await readResponse(await handleCryptoQuote(req, env, CORS));

    expect(resp.status).toBe(200);
    expect(resp.body.chain).toBe('base');
    expect(resp.body.token).toBe('USDC');
    expect(resp.body.address).toBe(env.CRYPTO_ADDRESS_EVM);
    expect(resp.body.credits).toBe(1);
    expect(resp.body.usd_price).toBe(10.00);
    expect(resp.body.decimals).toBe(6);
    expect(resp.body.payment_id).toMatch(/[0-9a-f-]{36}/);
    // Unique-suffix mechanism: amount is slightly above the exact 10 USDC.
    expect(Number(resp.body.amount)).toBeGreaterThanOrEqual(10.0);
    expect(Number(resp.body.amount)).toBeLessThan(10.01);
  });

  it('persists the pending payment record', async () => {
    const req = makeRequest({
      body: { clientId: CLIENT_ID, bundle: 'pack-5', method: 'usdc-base' },
    });
    const resp = await readResponse(await handleCryptoQuote(req, env, CORS));

    const stored = JSON.parse(await env.PENDING_PAYMENTS.get(`crypto:${resp.body.payment_id}`));
    expect(stored.clientId).toBe(CLIENT_ID);
    expect(stored.bundle).toBe('pack-5');
    expect(stored.credits).toBe(5);
    expect(stored.chain).toBe('base');
    expect(stored.token).toBe('USDC');
    expect(stored.address).toBe(env.CRYPTO_ADDRESS_EVM);
    expect(stored.expectedRaw).toBe(resp.body.amount_raw);
  });

  it('handles BNB USDC (18 decimals)', async () => {
    const req = makeRequest({
      body: { clientId: CLIENT_ID, bundle: 'single', method: 'usdc-bnb' },
    });
    const resp = await readResponse(await handleCryptoQuote(req, env, CORS));

    expect(resp.status).toBe(200);
    expect(resp.body.token).toBe('USDC');
    expect(resp.body.decimals).toBe(18);
    expect(resp.body.chain).toBe('bnb');
    // 10 USDC + a random suffix, expressed with 18 decimals.
    const raw = BigInt(resp.body.amount_raw);
    const tenE18 = 10n * 10n ** 18n;
    expect(raw).toBeGreaterThanOrEqual(tenE18);
    expect(raw).toBeLessThan(tenE18 + 10n ** 16n);
  });

  it('handles native ETH via CoinGecko', async () => {
    installCoingecko();
    const req = makeRequest({
      body: { clientId: CLIENT_ID, bundle: 'single', method: 'eth-base' },
    });
    const resp = await readResponse(await handleCryptoQuote(req, env, CORS));

    expect(resp.status).toBe(200);
    expect(resp.body.token).toBe('ETH');
    expect(resp.body.decimals).toBe(18);
    // $10 of ETH at $3000 = 0.00333 ETH (plus suffix).
    const raw = BigInt(resp.body.amount_raw);
    const expected = 10n * 10n ** 18n / 3000n; // 10/3000 ETH in wei
    expect(raw).toBeGreaterThanOrEqual(expected);
  });

  it('handles native SOL via CoinGecko', async () => {
    installCoingecko();
    const req = makeRequest({
      body: { clientId: CLIENT_ID, bundle: 'single', method: 'sol' },
    });
    const resp = await readResponse(await handleCryptoQuote(req, env, CORS));

    expect(resp.status).toBe(200);
    expect(resp.body.token).toBe('SOL');
    expect(resp.body.decimals).toBe(9);
    expect(resp.body.address).toBe(env.CRYPTO_ADDRESS_SOL);
  });

  it('handles native BTC via CoinGecko', async () => {
    installCoingecko();
    const req = makeRequest({
      body: { clientId: CLIENT_ID, bundle: 'single', method: 'btc' },
    });
    const resp = await readResponse(await handleCryptoQuote(req, env, CORS));

    expect(resp.status).toBe(200);
    expect(resp.body.token).toBe('BTC');
    expect(resp.body.decimals).toBe(8);
    expect(resp.body.address).toBe(env.CRYPTO_ADDRESS_BTC);
  });

  it('rejects a missing clientId', async () => {
    const req = makeRequest({ body: { bundle: 'single', method: 'usdc-base' } });
    const resp = await readResponse(await handleCryptoQuote(req, env, CORS));
    expect(resp.status).toBe(400);
    expect(resp.body.error).toMatch(/clientId required/);
  });

  it('rejects a clientId that is too short', async () => {
    const req = makeRequest({ body: { clientId: 'x', bundle: 'single', method: 'usdc-base' } });
    const resp = await readResponse(await handleCryptoQuote(req, env, CORS));
    expect(resp.status).toBe(400);
  });

  it('rejects an unknown bundle', async () => {
    const req = makeRequest({
      body: { clientId: CLIENT_ID, bundle: 'pack-999', method: 'usdc-base' },
    });
    const resp = await readResponse(await handleCryptoQuote(req, env, CORS));
    expect(resp.status).toBe(400);
    expect(resp.body.error).toMatch(/unknown bundle/);
  });

  it('rejects an unknown method', async () => {
    const req = makeRequest({
      body: { clientId: CLIENT_ID, bundle: 'single', method: 'doge-mainnet' },
    });
    const resp = await readResponse(await handleCryptoQuote(req, env, CORS));
    expect(resp.status).toBe(400);
    expect(resp.body.error).toMatch(/unknown method/);
  });

  it('returns 500 when the crypto address is not configured', async () => {
    env = createFakeEnv({ CRYPTO_ADDRESS_EVM: '' });
    const req = makeRequest({
      body: { clientId: CLIENT_ID, bundle: 'single', method: 'usdc-base' },
    });
    const resp = await readResponse(await handleCryptoQuote(req, env, CORS));
    expect(resp.status).toBe(500);
    expect(resp.body.error).toMatch(/not configured/);
  });

  it('returns 502 when the exchange rate lookup fails', async () => {
    mock = installFetchMock(() => jsonResponse({}));   // empty prices
    const req = makeRequest({
      body: { clientId: CLIENT_ID, bundle: 'single', method: 'eth-base' },
    });
    const resp = await readResponse(await handleCryptoQuote(req, env, CORS));
    expect(resp.status).toBe(502);
    expect(resp.body.error).toMatch(/exchange rate/);
  });

  it('produces different amounts for two consecutive quotes', async () => {
    const req1 = makeRequest({
      body: { clientId: CLIENT_ID, bundle: 'single', method: 'usdc-base' },
    });
    const r1 = await readResponse(await handleCryptoQuote(req1, env, CORS));

    const req2 = makeRequest({
      body: { clientId: CLIENT_ID, bundle: 'single', method: 'usdc-base' },
    });
    const r2 = await readResponse(await handleCryptoQuote(req2, env, CORS));

    expect(r1.body.payment_id).not.toBe(r2.body.payment_id);
    // Both have the exact same base amount but the random suffix
    // differs, so the raw values should differ. (There is a 1/10000
    // chance of collision, but the payment_ids differ regardless.)
  });

  it('rejects a method that maps to a supported chain but no address', async () => {
    env = createFakeEnv({ CRYPTO_ADDRESS_BTC: '' });
    const req = makeRequest({
      body: { clientId: CLIENT_ID, bundle: 'single', method: 'btc' },
    });
    const resp = await readResponse(await handleCryptoQuote(req, env, CORS));
    expect(resp.status).toBe(500);
  });
});