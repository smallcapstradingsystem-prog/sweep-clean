import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleFeeRecord, handleSweepCommit } from '../payment-worker.js';
import { createFakeEnv } from './helpers/fake-env.js';
import { makeRequest, readResponse } from './helpers/call-worker.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const CLIENT_ID = 'clientaaa00000000000000000000000';
const DEST = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const SWEEP_ID = 'sweep-feerecord-0001';
const RECIPIENT = '0x8B180186C79D146fd5617B31A9e2A3d938954Fa9'; // FEE_WALLET_EVM

function validReceipt(overrides = {}) {
  return {
    family: 'evm',
    chain: 'base',
    sourceAddress: '0x3333333333333333333333333333333333333333',
    amountRaw: '1000000',
    decimals: 6,
    symbol: 'USDC',
    recipient: RECIPIENT,
    userDestination: DEST,
    userShareRaw: '900000',
    operatorFeeRaw: '100000',
    ...overrides,
  };
}

describe('fee record', () => {
  let env;
  beforeEach(async () => {
    env = createFakeEnv();
    // Pre-commit so tests focus on the record path.
    await handleSweepCommit(
      makeRequest({ body: { clientId: CLIENT_ID, sweepId: SWEEP_ID, userDestination: DEST } }),
      env, CORS,
    );
  });

  it('records a valid receipt', async () => {
    const req = makeRequest({
      body: {
        clientId: CLIENT_ID, sweepId: SWEEP_ID,
        receipts: [validReceipt()],
        gasSponsorships: [],
        sweepDurationMs: 1234,
        successes: 1, failures: 0,
      },
    });
    const resp = await readResponse(await handleFeeRecord(req, env, CORS));
    expect(resp.status).toBe(200);
    expect(resp.body.status).toBe('pending');
    expect(env.CREDITS._has(`fee:sweep:${SWEEP_ID}`)).toBe(true);
  });

  it('is idempotent on sweepId', async () => {
    const body = { clientId: CLIENT_ID, sweepId: SWEEP_ID, receipts: [validReceipt()] };
    await handleFeeRecord(makeRequest({ body }), env, CORS);
    const resp = await readResponse(await handleFeeRecord(makeRequest({ body }), env, CORS));
    expect(resp.status).toBe(200);
    expect(resp.body.alreadyRecorded).toBe(true);
  });

  it('rejects an uncommitted sweepId', async () => {
    const resp = await readResponse(await handleFeeRecord(
      makeRequest({ body: { clientId: CLIENT_ID, sweepId: 'uncommitted-0001', receipts: [validReceipt()] } }),
      env, CORS,
    ));
    expect(resp.status).toBe(400);
    expect(resp.body.error).toMatch(/not committed/);
  });

  it('rejects when clientId does not match the commit', async () => {
    const resp = await readResponse(await handleFeeRecord(
      makeRequest({ body: { clientId: 'otherclient0000000000000000000000', sweepId: SWEEP_ID, receipts: [validReceipt()] } }),
      env, CORS,
    ));
    expect(resp.status).toBe(403);
  });

  it('overwrites a client-supplied destination with the committed one', async () => {
    const receipt = validReceipt({ userDestination: OTHER });
    await handleFeeRecord(
      makeRequest({ body: { clientId: CLIENT_ID, sweepId: SWEEP_ID, receipts: [receipt] } }),
      env, CORS,
    );
    const stored = JSON.parse(await env.CREDITS.get(`fee:sweep:${SWEEP_ID}`));
    expect(stored.receipts[0].userDestination).toBe(DEST);
    expect(stored.operatorView).toContain(`→ ${DEST}`);
    expect(stored.operatorView).not.toContain(OTHER);
  });

  it('warns on a destination mismatch but still uses the committed one', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const receipt = validReceipt({ userDestination: OTHER });
      await handleFeeRecord(
        makeRequest({ body: { clientId: CLIENT_ID, sweepId: SWEEP_ID, receipts: [receipt] } }),
        env, CORS,
      );
      const calls = warnSpy.mock.calls.map((c) => c.join(' '));
      expect(calls.some((s) => s.includes('Destination mismatch'))).toBe(true);
      const stored = JSON.parse(await env.CREDITS.get(`fee:sweep:${SWEEP_ID}`));
      expect(stored.receipts[0].userDestination).toBe(DEST);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rejects a bad receipt shape', async () => {
    const resp = await readResponse(await handleFeeRecord(
      makeRequest({ body: {
        clientId: CLIENT_ID, sweepId: SWEEP_ID,
        receipts: [validReceipt({ amountRaw: 'not-a-number' })],
      } }),
      env, CORS,
    ));
    expect(resp.status).toBe(400);
  });

  it('rejects an empty receipts array', async () => {
    const resp = await readResponse(await handleFeeRecord(
      makeRequest({ body: { clientId: CLIENT_ID, sweepId: SWEEP_ID, receipts: [] } }),
      env, CORS,
    ));
    expect(resp.status).toBe(400);
  });
});