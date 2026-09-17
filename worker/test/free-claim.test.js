import { describe, it, expect, beforeEach } from 'vitest';
import { handleClaimInfo, handleClaimFree, FREE_CLAIM_IP_MAX, getBalance } from '../payment-worker.js';
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

  it('blocks the 4th client from the same IP', async () => {
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
});