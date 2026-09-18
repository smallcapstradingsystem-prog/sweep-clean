import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleClaimInfo,
  handleClaimFree,
  FREE_CLAIM_IP_MAX,
  FREE_CLAIM_FINGERPRINT_MAX,
  getBalance,
} from '../payment-worker.js';
import { createFakeEnv } from './helpers/fake-env.js';
import { makeRequest, readResponse } from './helpers/call-worker.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };

describe('free claim', () => {
  let env;
  beforeEach(() => { env = createFakeEnv(); });

  it('grants 3 credits on the first claim', async () => {
    const clientId = 'claimclient0000000000000000000001';
    const req = makeRequest({ body: { clientId }, headers: { 'cf-connecting-ip': '10.0.0.1' } });
    const resp = await readResponse(await handleClaimFree(req, env, CORS));
    expect(resp.status).toBe(200);
    expect(resp.body.creditsGranted).toBe(3);
    expect(resp.body.newBalance).toBe(3);
    expect(await getBalance(env, clientId)).toBe(3);
  });

  it('is idempotent per client', async () => {
    const clientId = 'claimclient0000000000000000000001';
    const headers = { 'cf-connecting-ip': '10.0.0.1' };

    await handleClaimFree(makeRequest({ body: { clientId }, headers }), env, CORS);
    const resp = await readResponse(await handleClaimFree(makeRequest({ body: { clientId }, headers }), env, CORS));
    expect(resp.body.alreadyClaimed).toBe(true);
    expect(resp.body.creditsGranted).toBe(0);
    expect(await getBalance(env, clientId)).toBe(3);
  });

  it('blocks the 3rd client from the same IP', async () => {
    const headers = { 'cf-connecting-ip': '10.0.0.1' };
    for (let i = 0; i < FREE_CLAIM_IP_MAX; i++) {
      const clientId = `claimclient000000000000000000000${i}`;
      const resp = await readResponse(await handleClaimFree(
        makeRequest({ body: { clientId }, headers }), env, CORS,
      ));
      expect(resp.body.creditsGranted).toBe(3);
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
  });

  it('claim-info reports claimed after a grant', async () => {
    const clientId = 'claimclient0000000000000000000001';
    const headers = { 'cf-connecting-ip': '10.0.0.1' };
    await handleClaimFree(makeRequest({ body: { clientId }, headers }), env, CORS);
    const resp = await readResponse(await handleClaimInfo(
      makeRequest({ body: { clientId }, headers }), env, CORS,
    ));
    expect(resp.body.claimed).toBe(true);
    expect(resp.body.creditsGranted).toBe(3);
  });

  it('claim-info does not write to KV', async () => {
    const clientId = 'claimclient0000000000000000000001';
    const beforeSize = env.CREDITS._size();
    await handleClaimInfo(makeRequest({ body: { clientId } }), env, CORS);
    expect(env.CREDITS._size()).toBe(beforeSize);
  });

  it('blocks the 3rd claim from the same fingerprint', async () => {
    const fp = 'abcd1234abcd1234';
    // Different clientIds, different IPs, same fingerprint.
    for (let i = 0; i < FREE_CLAIM_FINGERPRINT_MAX; i++) {
      const clientId = `fpclient00000000000000000000000${i}`;
      const resp = await readResponse(await handleClaimFree(
        makeRequest({
          body: { clientId, fingerprint: fp },
          headers: { 'cf-connecting-ip': `10.0.0.${i + 1}` },
        }),
        env, CORS,
      ));
      expect(resp.body.creditsGranted).toBe(3);
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

    // First claim succeeds.
    await handleClaimFree(
      makeRequest({ body: { clientId, fingerprint: fp }, headers }),
      env, CORS,
    );

    // Second claim with the same clientId is alreadyClaimed — should
    // not consume a second fingerprint slot.
    await handleClaimFree(
      makeRequest({ body: { clientId, fingerprint: fp }, headers }),
      env, CORS,
    );

    const stored = await env.CREDITS.get(`free_claim:fp:${fp}`);
    expect(parseInt(stored, 10)).toBe(1);
  });

  it('releases the fingerprint slot when the offer has expired', async () => {
    const fp = 'cafebabecafebabe';
    // Seed an already-expired start window for a different client.
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

    // releaseSlots() restores the pre-reserve value (0) rather than
    // deleting the key. Asserting '0' documents that behavior; if
    // releaseSlots is ever changed to delete, this test will catch it.
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
    // Two clients, no fingerprint, same IP window: each should get
    // one claim from the fingerprint side (shared bucket), and the
    // IP cap should stop the third.
    const headers = { 'cf-connecting-ip': '10.0.0.7' };
    const a = await readResponse(await handleClaimFree(
      makeRequest({ body: { clientId: 'nofpclient000000000000000000001' }, headers }), env, CORS,
    ));
    expect(a.body.creditsGranted).toBe(3);

    const b = await readResponse(await handleClaimFree(
      makeRequest({ body: { clientId: 'nofpclient000000000000000000002' }, headers }), env, CORS,
    ));
    expect(b.body.creditsGranted).toBe(3);

    // Third claim from the same IP is blocked by the IP cap, not by
    // the fingerprint cap.
    const c = await readResponse(await handleClaimFree(
      makeRequest({ body: { clientId: 'nofpclient000000000000000000003' }, headers }), env, CORS,
    ));
    expect(c.body.blockedByIp).toBe(true);
  });
});