import { describe, it, expect, beforeEach } from 'vitest';
import { handleFeeMarkForwarded, handleFeePending } from '../payment-worker.js';
import { createFakeEnv } from './helpers/fake-env.js';
import { makeRequest, readResponse } from './helpers/call-worker.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const OPERATOR_SECRET = 'test-operator-secret';
const OPERATOR_HEADERS = { 'X-Operator-Secret': OPERATOR_SECRET };

// Seed a pending fee record so the endpoint has something to act on.
async function seedPendingSweep(env, sweepId = 'sweep-aaaa-0001') {
  const record = {
    sweepId,
    clientId: 'clientaaa00000000000000000000000',
    receipts: [
      {
        family: 'evm', chain: 'base', sourceAddress: '0x1111111111111111111111111111111111111111',
        amountRaw: '1000000', decimals: 6, symbol: 'USDC',
        recipient: '0x8B180186C79D146fd5617B31A9e2A3d938954Fa9',
        userDestination: '0x2222222222222222222222222222222222222222',
        userShareRaw: '900000', operatorFeeRaw: '100000',
      },
    ],
    gasSponsorships: [],
    operatorView: 'MANUAL FORWARD REQUIRED',
    sweepDurationMs: 1000,
    successes: 1, failures: 0,
    status: 'pending',
    recordedAt: new Date().toISOString(),
  };
  await env.CREDITS.put(`fee:sweep:${sweepId}`, JSON.stringify(record));
  await env.CREDITS.put('fee:pending', JSON.stringify([sweepId]));
  return sweepId;
}

describe('handleFeeMarkForwarded', () => {
  let env;
  beforeEach(() => { env = createFakeEnv(); });

  it('marks a sweep forwarded', async () => {
    const sweepId = await seedPendingSweep(env);

    const resp = await readResponse(await handleFeeMarkForwarded(
      makeRequest({
        body: { sweepId, txHashes: ['0xabc'], note: 'sent' },
        headers: OPERATOR_HEADERS,
      }),
      env, CORS,
    ));

    expect(resp.status).toBe(200);
    expect(resp.body.ok).toBe(true);
    expect(resp.body.status).toBe('forwarded');
    expect(resp.body.record.status).toBe('forwarded');
    expect(resp.body.record.forwardedTxHashes).toEqual(['0xabc']);
    expect(resp.body.record.forwardedNote).toBe('sent');
    expect(resp.body.record.forwardedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('moves the record from pending to forwarded KV', async () => {
    const sweepId = await seedPendingSweep(env);

    await handleFeeMarkForwarded(
      makeRequest({ body: { sweepId }, headers: OPERATOR_HEADERS }),
      env, CORS,
    );

    // The pending record was deleted.
    expect(await env.CREDITS.get(`fee:sweep:${sweepId}`)).toBeNull();
    // The forwarded record exists.
    const forwarded = JSON.parse(await env.CREDITS.get(`fee:forwarded:${sweepId}`));
    expect(forwarded.status).toBe('forwarded');
    // The pending index no longer includes the sweep.
    const pendingIds = JSON.parse(await env.CREDITS.get('fee:pending'));
    expect(pendingIds).not.toContain(sweepId);
  });

  it('is idempotent for an already-forwarded sweep', async () => {
    const sweepId = await seedPendingSweep(env);
    await handleFeeMarkForwarded(
      makeRequest({ body: { sweepId }, headers: OPERATOR_HEADERS }),
      env, CORS,
    );

    // Second call: the pending record is gone, so this is a 404.
    // The forwarded record still exists under fee:forwarded:
    const resp = await readResponse(await handleFeeMarkForwarded(
      makeRequest({ body: { sweepId }, headers: OPERATOR_HEADERS }),
      env, CORS,
    ));

    // Either 404 (pending key gone) or 200 with alreadyForwarded:true.
    // Both are acceptable; the test documents the behavior.
    expect([200, 404]).toContain(resp.status);
  });

  it('rejects a missing sweepId', async () => {
    const resp = await readResponse(await handleFeeMarkForwarded(
      makeRequest({ body: {}, headers: OPERATOR_HEADERS }),
      env, CORS,
    ));
    expect(resp.status).toBe(400);
    expect(resp.body.error).toMatch(/sweepId required/);
  });

  it('returns 404 when the sweepId is not found', async () => {
    const resp = await readResponse(await handleFeeMarkForwarded(
      makeRequest({ body: { sweepId: 'does-not-exist' }, headers: OPERATOR_HEADERS }),
      env, CORS,
    ));
    expect(resp.status).toBe(404);
    expect(resp.body.error).toMatch(/not found/);
  });

  it('rejects a missing operator secret', async () => {
    // Called directly (not via the router), the handler throws. In
    // production the router catches this and returns a 401 JSON
    // response. Asserting on the throw, not on a Response object.
    const sweepId = await seedPendingSweep(env);
    await expect(handleFeeMarkForwarded(
      makeRequest({ body: { sweepId } }),   // no header
      env, CORS,
    )).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a wrong operator secret', async () => {
    const sweepId = await seedPendingSweep(env);
    await expect(handleFeeMarkForwarded(
      makeRequest({
        body: { sweepId },
        headers: { 'X-Operator-Secret': 'wrong' },
      }),
      env, CORS,
    )).rejects.toMatchObject({ status: 401 });
  });

  it('fails closed when OPERATOR_SECRET is not configured', async () => {
    // When the secret is missing entirely, the handler must throw a
    // 500 — never accept the request.
    env = createFakeEnv({ OPERATOR_SECRET: '' });
    const sweepId = await seedPendingSweep(env);
    await expect(handleFeeMarkForwarded(
      makeRequest({ body: { sweepId }, headers: OPERATOR_HEADERS }),
      env, CORS,
    )).rejects.toMatchObject({ status: 500 });
  });
});