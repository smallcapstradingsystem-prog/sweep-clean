import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleClaimInfo,
  handleClaimFree,
  handleCreditsConsume,
  handleCreditsBalance,
  FREE_CLAIM_IP_MAX,
  FREE_CLAIM_FINGERPRINT_MAX,
  FREE_CLAIM_CREDITS,
  getBalance,
  getEffectiveBalance,
  readFreeCredits,
} from '../payment-worker.js';
import { createFakeEnv } from './helpers/fake-env.js';
import { makeRequest, readResponse } from './helpers/call-worker.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };

describe('free claim', () => {
  let env;
  beforeEach(() => { env = createFakeEnv(); });

  it('grants 2 credits into the free pool on the first claim', async () => {
    const clientId = 'claimclient0000000000000000000001';
    const req = makeRequest({ body: { clientId }, headers: { 'cf-connecting-ip': '10.0.0.1' } });
    const resp = await readResponse(await handleClaimFree(req, env, CORS));
    expect(resp.status).toBe(200);
    expect(resp.body.creditsGranted).toBe(FREE_CLAIM_CREDITS);
    expect(resp.body.creditsGranted).toBe(2);
    expect(resp.body.newBalance).toBe(2);

    // Paid balance stays at 0; the 2 credits live in the free pool.
    expect(await getBalance(env, clientId)).toBe(0);
    const { effective, free } = await getEffectiveBalance(env, clientId);
    expect(effective).toBe(2);
    expect(free).toBe(2);
  });

  it('writes a free_credits record with a 24h expiry', async () => {
    const clientId = 'claimclient0000000000000000000001';
    const before = Date.now();
    await handleClaimFree(
      makeRequest({ body: { clientId }, headers: { 'cf-connecting-ip': '10.0.0.1' } }),
      env, CORS,
    );

    const rec = await readFreeCredits(env, clientId);
    expect(rec).not.toBeNull();
    expect(rec.amount).toBe(2);

    const expiresMs = new Date(rec.expiresAt).getTime();
    const windowMs = 24 * 60 * 60 * 1000;
    // Expiry is within a couple seconds of grant + 24h.
    expect(expiresMs - before).toBeGreaterThanOrEqual(windowMs - 2000);
    expect(expiresMs - before).toBeLessThanOrEqual(windowMs + 5000);
  });

  it('is idempotent per client', async () => {
    const clientId = 'claimclient0000000000000000000001';
    const headers = { 'cf-connecting-ip': '10.0.0.1' };

    await handleClaimFree(makeRequest({ body: { clientId }, headers }), env, CORS);
    const resp = await readResponse(await handleClaimFree(makeRequest({ body: { clientId }, headers }), env, CORS));
    expect(resp.body.alreadyClaimed).toBe(true);
    expect(resp.body.creditsGranted).toBe(0);

    const { effective } = await getEffectiveBalance(env, clientId);
    expect(effective).toBe(2);
  });

  it('blocks the 3rd client from the same IP', async () => {
    const headers = { 'cf-connecting-ip': '10.0.0.1' };
    for (let i = 0; i < FREE_CLAIM_IP_MAX; i++) {
      const clientId = `claimclient000000000000000000000${i}`;
      const resp = await readResponse(await handleClaimFree(
        makeRequest({ body: { clientId }, headers }), env, CORS,
      ));
      expect(resp.body.creditsGranted).toBe(2);
    }
    const resp = await readResponse(await handleClaimFree(
      makeRequest({ body: { clientId: 'claimclient0000000000000000000099' }, headers }), env, CORS,
    ));
    expect(resp.body.blockedByIp).toBe(true);
    expect(resp.body.creditsGranted).toBe(0);
  });

  it('claim-info reports notStarted before any claim', async () => {
    const clientId = 'claimclient0000000000000000000001';
    const resp = await readResponse(await handleClaimInfo(
      makeRequest({ body: { clientId }, headers: { 'cf-connecting-ip': '10.0.0.1' } }),
      env, CORS,
    ));
    expect(resp.body.notStarted).toBe(true);
    expect(resp.body.claimed).toBe(false);
    expect(resp.body.freeAmount).toBe(0);
    expect(resp.body.useExpiresAt).toBeNull();
    expect(resp.body.useMsRemaining).toBe(0);
  });

  it('claim-info reports claimed and exposes the use window after a grant', async () => {
    const clientId = 'claimclient0000000000000000000001';
    const headers = { 'cf-connecting-ip': '10.0.0.1' };
    await handleClaimFree(makeRequest({ body: { clientId }, headers }), env, CORS);
    const resp = await readResponse(await handleClaimInfo(
      makeRequest({ body: { clientId }, headers }), env, CORS,
    ));
    expect(resp.body.claimed).toBe(true);
    expect(resp.body.creditsGranted).toBe(2);
    expect(resp.body.freeAmount).toBe(2);
    expect(resp.body.useExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    // ~24h remaining, give or take.
    expect(resp.body.useMsRemaining).toBeGreaterThan(23 * 60 * 60 * 1000);
  });

  it('claim-info does not write to KV', async () => {
    const clientId = 'claimclient0000000000000000000001';
    const beforeSize = env.CREDITS._size();
    await handleClaimInfo(makeRequest({ body: { clientId } }), env, CORS);
    expect(env.CREDITS._size()).toBe(beforeSize);
  });

  it('blocks the 3rd claim from the same fingerprint', async () => {
    const fp = 'abcd1234abcd1234';
    for (let i = 0; i < FREE_CLAIM_FINGERPRINT_MAX; i++) {
      const clientId = `fpclient00000000000000000000000${i}`;
      const resp = await readResponse(await handleClaimFree(
        makeRequest({
          body: { clientId, fingerprint: fp },
          headers: { 'cf-connecting-ip': `10.0.0.${i + 1}` },
        }),
        env, CORS,
      ));
      expect(resp.body.creditsGranted).toBe(2);
    }

    const resp = await readResponse(await handleClaimFree(
      makeRequest({
        body: { clientId: 'fpclient000000000000000000000099', fingerprint: fp },
        headers: { 'cf-connecting-ip': '10.0.0.99' },
      }),
      env, CORS,
    ));
    expect(resp.body.blockedByFingerprint).toBe(true);
    expect(resp.body.creditsGranted).toBe(0);
  });

  it('does not increment the fingerprint counter on a no-op claim', async () => {
    const fp = 'feedfacefeedface';
    const clientId = 'fpclient00000000000000000000000X';
    const headers = { 'cf-connecting-ip': '10.0.0.1' };

    await handleClaimFree(
      makeRequest({ body: { clientId, fingerprint: fp }, headers }),
      env, CORS,
    );

    await handleClaimFree(
      makeRequest({ body: { clientId, fingerprint: fp }, headers }),
      env, CORS,
    );

    const stored = await env.CREDITS.get(`free_claim:fp:${fp}`);
    expect(parseInt(stored, 10)).toBe(1);
  });

  it('releases the fingerprint slot when the offer has expired', async () => {
    const fp = 'cafebabecafebabe';
    await env.CREDITS.put('free_claim:start:expiredclient0000000000000',
      new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());

    const resp = await readResponse(await handleClaimFree(
      makeRequest({
        body: { clientId: 'expiredclient0000000000000', fingerprint: fp },
        headers: { 'cf-connecting-ip': '10.0.0.1' },
      }),
      env, CORS,
    ));
    expect(resp.body.offerExpired).toBe(true);

    const stored = await env.CREDITS.get(`free_claim:fp:${fp}`);
    expect(stored).toBe('0');
  });

  it('writes client_meta on a successful claim', async () => {
    const fp = 'deadbeefdeadbeef';
    const clientId = 'metaclient0000000000000000000001';
    await handleClaimFree(
      makeRequest({
        body: { clientId, fingerprint: fp },
        headers: { 'cf-connecting-ip': '10.0.0.5', host: 'test.local' },
      }),
      env, CORS,
    );

    const meta = JSON.parse(await env.CREDITS.get(`client_meta:${clientId}`));
    expect(meta.fingerprint).toBe(fp);
    expect(meta.ip).toBe('10.0.0.5');
    expect(meta.host).toBe('test.local');
    expect(meta.firstSeen).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('treats a missing fingerprint as its own bucket', async () => {
    const headers = { 'cf-connecting-ip': '10.0.0.7' };
    const a = await readResponse(await handleClaimFree(
      makeRequest({ body: { clientId: 'nofpclient000000000000000000001' }, headers }), env, CORS,
    ));
    expect(a.body.creditsGranted).toBe(2);

    const b = await readResponse(await handleClaimFree(
      makeRequest({ body: { clientId: 'nofpclient000000000000000000002' }, headers }), env, CORS,
    ));
    expect(b.body.creditsGranted).toBe(2);

    const c = await readResponse(await handleClaimFree(
      makeRequest({ body: { clientId: 'nofpclient000000000000000000003' }, headers }), env, CORS,
    ));
    expect(c.body.blockedByIp).toBe(true);
  });
});

// =====================================================================
// FREE POOL — consumption order, expiry, history
// =====================================================================

describe('free credit pool', () => {
  let env;
  const CLIENT_ID = 'poolclient0000000000000000000001';
  const HEADERS = { 'cf-connecting-ip': '10.0.0.9' };

  beforeEach(() => { env = createFakeEnv(); });

  it('consumes free credits before paid credits', async () => {
    // Seed 2 free (from a claim) and 5 paid (from an admin grant).
    await handleClaimFree(makeRequest({ body: { clientId: CLIENT_ID }, headers: HEADERS }), env, CORS);
    await env.CREDITS.put(`balance:${CLIENT_ID}`, '5');

    const resp = await readResponse(await handleCreditsConsume(
      makeRequest({ body: { clientId: CLIENT_ID, reason: 'test' } }),
      env, CORS,
    ));
    expect(resp.body.pool).toBe('free');
    expect(resp.body.newBalance).toBe(6); // 5 paid + 1 free remaining

    const after = await getEffectiveBalance(env, CLIENT_ID);
    expect(after.paid).toBe(5);
    expect(after.free).toBe(1);
    expect(after.effective).toBe(6);
  });

  it('falls through to paid credits when the free pool is empty', async () => {
    await env.CREDITS.put(`balance:${CLIENT_ID}`, '5');

    const resp = await readResponse(await handleCreditsConsume(
      makeRequest({ body: { clientId: CLIENT_ID, reason: 'test' } }),
      env, CORS,
    ));
    expect(resp.body.pool).toBe('paid');
    expect(resp.body.newBalance).toBe(4);
    expect(await getBalance(env, CLIENT_ID)).toBe(4);
  });

  it('deletes the free_credits key when the pool hits zero', async () => {
    await handleClaimFree(makeRequest({ body: { clientId: CLIENT_ID }, headers: HEADERS }), env, CORS);
    // Free amount is 2; consume twice.
    await handleCreditsConsume(makeRequest({ body: { clientId: CLIENT_ID } }), env, CORS);
    await handleCreditsConsume(makeRequest({ body: { clientId: CLIENT_ID } }), env, CORS);

    const rec = await env.CREDITS.get(`free_credits:${CLIENT_ID}`);
    expect(rec).toBeNull();
  });

  it('rejects consumption when both pools are empty', async () => {
    const resp = await readResponse(await handleCreditsConsume(
      makeRequest({ body: { clientId: CLIENT_ID } }),
      env, CORS,
    ));
    expect(resp.status).toBe(402);
    expect(resp.body.error).toMatch(/insufficient/);
  });

  it('treats an expired free pool as empty', async () => {
    // Seed a free pool with an expiry in the past. readFreeCredits
    // must return null; consume must fall through to paid.
    await env.CREDITS.put(`free_credits:${CLIENT_ID}`, JSON.stringify({
      amount: 2,
      grantedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
    }));
    await env.CREDITS.put(`balance:${CLIENT_ID}`, '5');

    const rec = await readFreeCredits(env, CLIENT_ID);
    expect(rec).toBeNull();

    const resp = await readResponse(await handleCreditsConsume(
      makeRequest({ body: { clientId: CLIENT_ID } }),
      env, CORS,
    ));
    expect(resp.body.pool).toBe('paid');
    expect(resp.body.newBalance).toBe(4);
  });

  it('returns effective balance with free and paid components', async () => {
    await handleClaimFree(makeRequest({ body: { clientId: CLIENT_ID }, headers: HEADERS }), env, CORS);
    await env.CREDITS.put(`balance:${CLIENT_ID}`, '7');

    const resp = await readResponse(await handleCreditsBalance(
      makeRequest({ body: { clientId: CLIENT_ID } }),
      env, CORS,
    ));
    expect(resp.body.balance).toBe(9);
    expect(resp.body.paid).toBe(7);
    expect(resp.body.free).toBe(2);
    expect(resp.body.freeExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('records pool and effective balance in the history entry', async () => {
    await handleClaimFree(makeRequest({ body: { clientId: CLIENT_ID }, headers: HEADERS }), env, CORS);
    await env.CREDITS.put(`balance:${CLIENT_ID}`, '5');

    await handleCreditsConsume(makeRequest({ body: { clientId: CLIENT_ID } }), env, CORS);

    const history = JSON.parse(await env.CREDITS.get(`history:${CLIENT_ID}`));
    expect(history[0].pool).toBe('free');
    expect(history[0].balance).toBe(6); // 5 paid + 1 free remaining
    expect(history[0].delta).toBe(-1);
  });

  it('idempotency key on consume returns the prior result including pool', async () => {
    await handleClaimFree(makeRequest({ body: { clientId: CLIENT_ID }, headers: HEADERS }), env, CORS);
    const sweepId = 'sweep0000000000000000000000000000';

    const first = await readResponse(await handleCreditsConsume(
      makeRequest({ body: { clientId: CLIENT_ID, sweepId } }),
      env, CORS,
    ));
    expect(first.body.pool).toBe('free');
    expect(first.body.newBalance).toBe(1);

    const second = await readResponse(await handleCreditsConsume(
      makeRequest({ body: { clientId: CLIENT_ID, sweepId } }),
      env, CORS,
    ));
    expect(second.body.alreadyConsumed).toBe(true);
    expect(second.body.pool).toBe('free');
    expect(second.body.newBalance).toBe(1);

    // Verify only one consumption actually happened.
    const after = await getEffectiveBalance(env, CLIENT_ID);
    expect(after.free).toBe(1);
  });
});