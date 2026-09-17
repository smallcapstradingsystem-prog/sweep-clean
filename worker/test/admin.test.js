import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleAdminCreditsGrant,
  handleAdminCreditsLookup,
  handleAdminCreditsList,
  handleCreditsBalance,
  getBalance,
} from '../payment-worker.js';
import { createFakeEnv } from './helpers/fake-env.js';
import { makeRequest, readResponse } from './helpers/call-worker.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const OPERATOR_HEADERS = {
  'X-Operator-Secret': 'test-operator-secret',
  'cf-connecting-ip': '10.0.0.1',
};
const CLIENT_ID = 'clientaaa00000000000000000000000';

describe('admin credits grant', () => {
  let env;
  beforeEach(() => { env = createFakeEnv(); });

  it('grants credits to a client', async () => {
    const resp = await readResponse(await handleAdminCreditsGrant(
      makeRequest({
        body: { clientId: CLIENT_ID, amount: 5, reason: 'test' },
        headers: OPERATOR_HEADERS,
      }),
      env, CORS,
    ));

    expect(resp.status).toBe(200);
    expect(resp.body.ok).toBe(true);
    expect(resp.body.amount).toBe(5);
    expect(resp.body.newBalance).toBe(5);
    expect(resp.body.grantedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(await getBalance(env, CLIENT_ID)).toBe(5);
  });

  it('allows negative amounts', async () => {
    await handleAdminCreditsGrant(
      makeRequest({
        body: { clientId: CLIENT_ID, amount: 5 },
        headers: OPERATOR_HEADERS,
      }),
      env, CORS,
    );

    const resp = await readResponse(await handleAdminCreditsGrant(
      makeRequest({
        body: { clientId: CLIENT_ID, amount: -2, reason: 'refund' },
        headers: OPERATOR_HEADERS,
      }),
      env, CORS,
    ));
    expect(resp.body.newBalance).toBe(3);
  });

  it('records an admin_grant entry in history', async () => {
    await handleAdminCreditsGrant(
      makeRequest({
        body: { clientId: CLIENT_ID, amount: 5, reason: 'bonus', note: 'manual top-up' },
        headers: OPERATOR_HEADERS,
      }),
      env, CORS,
    );

    const history = JSON.parse(await env.CREDITS.get(`history:${CLIENT_ID}`));
    expect(history[0].delta).toBe(5);
    expect(history[0].type).toBe('admin_grant');
    expect(history[0].reason).toBe('bonus');
    expect(history[0].note).toBe('manual top-up');
  });

  it('rejects a missing clientId', async () => {
    const resp = await readResponse(await handleAdminCreditsGrant(
      makeRequest({ body: { amount: 5 }, headers: OPERATOR_HEADERS }),
      env, CORS,
    ));
    expect(resp.status).toBe(400);
    expect(resp.body.error).toMatch(/clientId/);
  });

  it('rejects a clientId shorter than 16 chars', async () => {
    const resp = await readResponse(await handleAdminCreditsGrant(
      makeRequest({ body: { clientId: 'short', amount: 5 }, headers: OPERATOR_HEADERS }),
      env, CORS,
    ));
    expect(resp.status).toBe(400);
  });

  it('rejects a missing amount', async () => {
    const resp = await readResponse(await handleAdminCreditsGrant(
      makeRequest({ body: { clientId: CLIENT_ID }, headers: OPERATOR_HEADERS }),
      env, CORS,
    ));
    expect(resp.status).toBe(400);
    expect(resp.body.error).toMatch(/amount/);
  });

  it('rejects a non-integer amount', async () => {
    const resp = await readResponse(await handleAdminCreditsGrant(
      makeRequest({ body: { clientId: CLIENT_ID, amount: 1.5 }, headers: OPERATOR_HEADERS }),
      env, CORS,
    ));
    expect(resp.status).toBe(400);
  });

  it('rejects amount = 0', async () => {
    const resp = await readResponse(await handleAdminCreditsGrant(
      makeRequest({ body: { clientId: CLIENT_ID, amount: 0 }, headers: OPERATOR_HEADERS }),
      env, CORS,
    ));
    expect(resp.status).toBe(400);
  });

  it('rejects amounts above the sanity cap', async () => {
    const resp = await readResponse(await handleAdminCreditsGrant(
      makeRequest({ body: { clientId: CLIENT_ID, amount: 1_000_000 }, headers: OPERATOR_HEADERS }),
      env, CORS,
    ));
    expect(resp.status).toBe(400);
    expect(resp.body.error).toMatch(/sanity cap/);
  });

  it('rejects a missing secret', async () => {
    await expect(handleAdminCreditsGrant(
      makeRequest({
        body: { clientId: CLIENT_ID, amount: 5 },
        headers: { 'cf-connecting-ip': '10.0.0.1' },
      }),
      env, CORS,
    )).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a wrong secret', async () => {
    await expect(handleAdminCreditsGrant(
      makeRequest({
        body: { clientId: CLIENT_ID, amount: 5 },
        headers: { 'X-Operator-Secret': 'wrong', 'cf-connecting-ip': '10.0.0.1' },
      }),
      env, CORS,
    )).rejects.toMatchObject({ status: 401 });
  });

  it('fails closed when OPERATOR_SECRET is not configured', async () => {
    env = createFakeEnv({ OPERATOR_SECRET: '' });
    await expect(handleAdminCreditsGrant(
      makeRequest({ body: { clientId: CLIENT_ID, amount: 5 }, headers: OPERATOR_HEADERS }),
      env, CORS,
    )).rejects.toMatchObject({ status: 500 });
  });

  it('records each failed auth attempt and rate-limits after 10', async () => {
    const ip = '5.5.5.5';
    const badHeaders = { 'X-Operator-Secret': 'wrong', 'cf-connecting-ip': ip };

    for (let i = 0; i < 10; i++) {
      await expect(handleAdminCreditsGrant(
        makeRequest({ body: { clientId: CLIENT_ID, amount: 1 }, headers: badHeaders }),
        env, CORS,
      )).rejects.toMatchObject({ status: 401 });
    }

    // 11th attempt: rate limited before the auth check.
    await expect(handleAdminCreditsGrant(
      makeRequest({ body: { clientId: CLIENT_ID, amount: 1 }, headers: badHeaders }),
      env, CORS,
    )).rejects.toMatchObject({ status: 429 });
  });

  it('leaves the balance unchanged after a rejected grant', async () => {
    await handleAdminCreditsGrant(
      makeRequest({ body: { clientId: CLIENT_ID, amount: 3 }, headers: OPERATOR_HEADERS }),
      env, CORS,
    );
    expect(await getBalance(env, CLIENT_ID)).toBe(3);

    // A grant with a bad secret must not change the balance.
    await expect(handleAdminCreditsGrant(
      makeRequest({
        body: { clientId: CLIENT_ID, amount: 5 },
        headers: { 'X-Operator-Secret': 'wrong', 'cf-connecting-ip': '10.0.0.1' },
      }),
      env, CORS,
    )).rejects.toMatchObject({ status: 401 });

    expect(await getBalance(env, CLIENT_ID)).toBe(3);
  });
});

describe('admin credits lookup', () => {
  let env;
  beforeEach(() => { env = createFakeEnv(); });

  it('returns balance and history for an existing client', async () => {
    await handleAdminCreditsGrant(
      makeRequest({ body: { clientId: CLIENT_ID, amount: 7 }, headers: OPERATOR_HEADERS }),
      env, CORS,
    );

    const resp = await readResponse(await handleAdminCreditsLookup(
      makeRequest({ body: { clientId: CLIENT_ID }, headers: OPERATOR_HEADERS }),
      env, CORS,
    ));

    expect(resp.status).toBe(200);
    expect(resp.body.clientId).toBe(CLIENT_ID);
    expect(resp.body.balance).toBe(7);
    expect(resp.body.history.length).toBeGreaterThan(0);
    expect(resp.body.history[0].delta).toBe(7);
  });

  it('returns balance 0 and empty history for an unknown client', async () => {
    const resp = await readResponse(await handleAdminCreditsLookup(
      makeRequest({ body: { clientId: 'unknownclient0000000000000000000' }, headers: OPERATOR_HEADERS }),
      env, CORS,
    ));
    expect(resp.status).toBe(200);
    expect(resp.body.balance).toBe(0);
    expect(resp.body.history).toEqual([]);
  });

  it('rejects a missing clientId', async () => {
    const resp = await readResponse(await handleAdminCreditsLookup(
      makeRequest({ body: {}, headers: OPERATOR_HEADERS }),
      env, CORS,
    ));
    expect(resp.status).toBe(400);
  });
});

describe('admin credits list', () => {
  let env;
  beforeEach(() => { env = createFakeEnv(); });

  it('returns an empty list when no balances exist', async () => {
    const resp = await readResponse(await handleAdminCreditsList(
      makeRequest({
        method: 'GET',
        headers: OPERATOR_HEADERS,
        url: 'https://test.local/admin/credits/list',
      }),
      env, CORS,
    ));
    expect(resp.status).toBe(200);
    expect(resp.body.items).toEqual([]);
    expect(resp.body.count).toBe(0);
  });

  it('returns all balances', async () => {
    await env.CREDITS.put('balance:clientaaa00000000000000000000001', '5');
    await env.CREDITS.put('balance:clientaaa00000000000000000000002', '10');

    const resp = await readResponse(await handleAdminCreditsList(
      makeRequest({
        method: 'GET',
        headers: OPERATOR_HEADERS,
        url: 'https://test.local/admin/credits/list',
      }),
      env, CORS,
    ));
    expect(resp.body.count).toBe(2);
    const ids = resp.body.items.map((i) => i.clientId).sort();
    expect(ids).toEqual([
      'clientaaa00000000000000000000001',
      'clientaaa00000000000000000000002',
    ]);
  });

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await env.CREDITS.put(`balance:clientaaa0000000000000000000000${i}`, '1');
    }
    const resp = await readResponse(await handleAdminCreditsList(
      makeRequest({
        method: 'GET',
        headers: OPERATOR_HEADERS,
        url: 'https://test.local/admin/credits/list?limit=2',
      }),
      env, CORS,
    ));
    expect(resp.body.count).toBe(2);
  });

  it('requires the operator secret', async () => {
    await expect(handleAdminCreditsList(
      makeRequest({
        method: 'GET',
        headers: { 'cf-connecting-ip': '10.0.0.1' },
        url: 'https://test.local/admin/credits/list',
      }),
      env, CORS,
    )).rejects.toMatchObject({ status: 401 });
  });
});