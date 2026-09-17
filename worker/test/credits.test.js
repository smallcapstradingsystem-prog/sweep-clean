import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleCreditsBalance, handleCreditsConsume, getBalance, addCredits } from '../payment-worker.js';
import { createFakeEnv } from './helpers/fake-env.js';
import { makeRequest, readResponse } from './helpers/call-worker.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const CLIENT_ID = 'testclient000000000000000000';

describe('credits', () => {
  let env;

  beforeEach(() => { env = createFakeEnv(); });

  describe('handleCreditsBalance', () => {
    it('returns 0 for an unknown client', async () => {
      const req = makeRequest({ body: { clientId: CLIENT_ID } });
      const resp = await readResponse(await handleCreditsBalance(req, env, CORS));
      expect(resp.status).toBe(200);
      expect(resp.body).toEqual({ clientId: CLIENT_ID, balance: 0 });
    });

    it('returns the stored balance', async () => {
      await env.CREDITS.put(`balance:${CLIENT_ID}`, '7');
      const req = makeRequest({ body: { clientId: CLIENT_ID } });
      const resp = await readResponse(await handleCreditsBalance(req, env, CORS));
      expect(resp.body.balance).toBe(7);
    });

    it('rejects a missing clientId', async () => {
      const req = makeRequest({ body: {} });
      const resp = await readResponse(await handleCreditsBalance(req, env, CORS));
      expect(resp.status).toBe(400);
    });
  });

  describe('handleCreditsConsume', () => {
    it('decrements on a normal call', async () => {
      await env.CREDITS.put(`balance:${CLIENT_ID}`, '5');
      const req = makeRequest({ body: { clientId: CLIENT_ID, reason: 'sweep', sweepId: 'sweep-aaaa-0001' } });
      const resp = await readResponse(await handleCreditsConsume(req, env, CORS));
      expect(resp.status).toBe(200);
      expect(resp.body.ok).toBe(true);
      expect(resp.body.newBalance).toBe(4);
      expect(resp.body.alreadyConsumed).toBeUndefined();
    });

    it('is idempotent on the same sweepId', async () => {
      await env.CREDITS.put(`balance:${CLIENT_ID}`, '5');

      const req1 = makeRequest({ body: { clientId: CLIENT_ID, sweepId: 'sweep-aaaa-0001' } });
      const resp1 = await readResponse(await handleCreditsConsume(req1, env, CORS));
      expect(resp1.body.newBalance).toBe(4);

      const req2 = makeRequest({ body: { clientId: CLIENT_ID, sweepId: 'sweep-aaaa-0001' } });
      const resp2 = await readResponse(await handleCreditsConsume(req2, env, CORS));
      expect(resp2.status).toBe(200);
      expect(resp2.body.newBalance).toBe(4);
      expect(resp2.body.alreadyConsumed).toBe(true);

      // Balance in KV should still be 4, not 3.
      expect(await getBalance(env, CLIENT_ID)).toBe(4);
    });

    it('treats different sweepIds as separate consumes', async () => {
      await env.CREDITS.put(`balance:${CLIENT_ID}`, '5');

      await handleCreditsConsume(
        makeRequest({ body: { clientId: CLIENT_ID, sweepId: 'sweep-aaaa-0001' } }),
        env, CORS,
      );
      const resp2 = await readResponse(await handleCreditsConsume(
        makeRequest({ body: { clientId: CLIENT_ID, sweepId: 'sweep-aaaa-0002' } }),
        env, CORS,
      ));
      expect(resp2.body.newBalance).toBe(3);
      expect(resp2.body.alreadyConsumed).toBeUndefined();
    });

    it('returns 402 when the balance is 0', async () => {
      const req = makeRequest({ body: { clientId: CLIENT_ID, sweepId: 'sweep-aaaa-0001' } });
      const resp = await readResponse(await handleCreditsConsume(req, env, CORS));
      expect(resp.status).toBe(402);
      expect(resp.body.error).toMatch(/insufficient/);
    });

    it('rejects a missing clientId', async () => {
      const req = makeRequest({ body: {} });
      const resp = await readResponse(await handleCreditsConsume(req, env, CORS));
      expect(resp.status).toBe(400);
    });

    it('falls back to non-idempotent when no sweepId is supplied', async () => {
      await env.CREDITS.put(`balance:${CLIENT_ID}`, '5');
      await handleCreditsConsume(makeRequest({ body: { clientId: CLIENT_ID } }), env, CORS);
      const resp = await readResponse(await handleCreditsConsume(
        makeRequest({ body: { clientId: CLIENT_ID } }), env, CORS,
      ));
      expect(resp.body.newBalance).toBe(3);
      expect(resp.body.alreadyConsumed).toBeUndefined();
    });
  });

  describe('getBalance / addCredits', () => {
    it('addCredits writes balance and history', async () => {
      const next = await addCredits(env, CLIENT_ID, 5, { type: 'test' });
      expect(next).toBe(5);
      expect(await getBalance(env, CLIENT_ID)).toBe(5);
      const history = JSON.parse(await env.CREDITS.get(`history:${CLIENT_ID}`));
      expect(history[0].delta).toBe(5);
      expect(history[0].balance).toBe(5);
    });

    it('addCredits decrements', async () => {
      await addCredits(env, CLIENT_ID, 5);
      const next = await addCredits(env, CLIENT_ID, -1);
      expect(next).toBe(4);
    });
  });
});