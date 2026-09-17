import { describe, it, expect, beforeEach } from 'vitest';
import { handleFeeSummary, handleFeePending } from '../payment-worker.js';
import { createFakeEnv } from './helpers/fake-env.js';
import { makeRequest, readResponse } from './helpers/call-worker.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const OPERATOR_HEADERS = { 'X-Operator-Secret': 'test-operator-secret' };

async function seedSweep(env, sweepId, receipts) {
  const record = {
    sweepId,
    clientId: 'clientaaa00000000000000000000000',
    receipts,
    gasSponsorships: [],
    operatorView: '',
    sweepDurationMs: 0, successes: 0, failures: 0,
    status: 'pending',
    recordedAt: new Date().toISOString(),
  };
  await env.CREDITS.put(`fee:sweep:${sweepId}`, JSON.stringify(record));
  const pending = JSON.parse(await env.CREDITS.get('fee:pending') || '[]');
  pending.push(sweepId);
  await env.CREDITS.put('fee:pending', JSON.stringify(pending));
}

const baseReceipt = {
  family: 'evm', chain: 'base',
  sourceAddress: '0x1111111111111111111111111111111111111111',
  amountRaw: '1000000', decimals: 6, symbol: 'USDC',
  recipient: '0x8B180186C79D146fd5617B31A9e2A3d938954Fa9',
  userDestination: '0x2222222222222222222222222222222222222222',
  userShareRaw: '900000', operatorFeeRaw: '100000',
};

describe('handleFeeSummary', () => {
  let env;
  beforeEach(() => { env = createFakeEnv(); });

  it('returns zero totals when there is no pending work', async () => {
    const resp = await readResponse(await handleFeeSummary(
      makeRequest({ method: 'GET', headers: OPERATOR_HEADERS }),
      env, CORS,
    ));
    expect(resp.status).toBe(200);
    expect(resp.body.totalPendingSweeps).toBe(0);
    expect(resp.body.totals).toEqual({});
  });

  it('aggregates a single sweep', async () => {
    await seedSweep(env, 'sweep-1', [baseReceipt]);

    const resp = await readResponse(await handleFeeSummary(
      makeRequest({ method: 'GET', headers: OPERATOR_HEADERS }),
      env, CORS,
    ));
    expect(resp.body.totalPendingSweeps).toBe(1);
    expect(resp.body.totals['evm:base']).toEqual({
      symbol: 'USDC',
      decimals: 6,
      amount: 1,
      amountRaw: '1000000',
      count: 1,
    });
  });

  it('aggregates receipts across multiple chains', async () => {
    await seedSweep(env, 'sweep-1', [baseReceipt]);
    await seedSweep(env, 'sweep-2', [
      { ...baseReceipt, chain: 'optimism' },
      { ...baseReceipt, amountRaw: '2000000' },
    ]);

    const resp = await readResponse(await handleFeeSummary(
      makeRequest({ method: 'GET', headers: OPERATOR_HEADERS }),
      env, CORS,
    ));
    expect(resp.body.totalPendingSweeps).toBe(2);
    expect(resp.body.totals['evm:base'].amountRaw).toBe('3000000');
    expect(resp.body.totals['evm:base'].count).toBe(2);
    expect(resp.body.totals['evm:optimism'].amountRaw).toBe('1000000');
    expect(resp.body.totals['evm:optimism'].count).toBe(1);
  });

  it('aggregates Solana and Bitcoin as separate buckets', async () => {
    await seedSweep(env, 'sweep-1', [
      { ...baseReceipt, family: 'solana', chain: undefined, decimals: 6 },
    ]);
    await seedSweep(env, 'sweep-2', [
      { ...baseReceipt, family: 'bitcoin', chain: undefined, decimals: 6 },
    ]);

    const resp = await readResponse(await handleFeeSummary(
      makeRequest({ method: 'GET', headers: OPERATOR_HEADERS }),
      env, CORS,
    ));
    expect(resp.body.totals.solana).toBeDefined();
    expect(resp.body.totals.bitcoin).toBeDefined();
    expect(resp.body.totals.solana.amountRaw).toBe('1000000');
    expect(resp.body.totals.bitcoin.amountRaw).toBe('1000000');
  });

  it('skips sweeps whose KV record is missing', async () => {
    await seedSweep(env, 'sweep-1', [baseReceipt]);
    const pending = JSON.parse(await env.CREDITS.get('fee:pending'));
    pending.push('sweep-missing');
    await env.CREDITS.put('fee:pending', JSON.stringify(pending));

    const resp = await readResponse(await handleFeeSummary(
      makeRequest({ method: 'GET', headers: OPERATOR_HEADERS }),
      env, CORS,
    ));
    expect(resp.body.totalPendingSweeps).toBe(1);
  });

  it('skips sweeps with corrupt JSON', async () => {
    await seedSweep(env, 'sweep-1', [baseReceipt]);
    await env.CREDITS.put(`fee:sweep:sweep-corrupt`, '{not valid json');
    const pending = JSON.parse(await env.CREDITS.get('fee:pending'));
    pending.push('sweep-corrupt');
    await env.CREDITS.put('fee:pending', JSON.stringify(pending));

    const resp = await readResponse(await handleFeeSummary(
      makeRequest({ method: 'GET', headers: OPERATOR_HEADERS }),
      env, CORS,
    ));
    expect(resp.body.totalPendingSweeps).toBe(1);
  });

  it('requires the operator secret', async () => {
    // Called directly, the handler throws. The router wraps this
    // into a 401 JSON response.
    await expect(handleFeeSummary(
      makeRequest({ method: 'GET' }),
      env, CORS,
    )).rejects.toMatchObject({ status: 401 });
  });

  it('fails closed when OPERATOR_SECRET is not configured', async () => {
    // When the secret is missing entirely, the handler must throw a
    // 500 — never accept the request.
    env = createFakeEnv({ OPERATOR_SECRET: '' });
    await expect(handleFeeSummary(
      makeRequest({ method: 'GET', headers: OPERATOR_HEADERS }),
      env, CORS,
    )).rejects.toMatchObject({ status: 500 });
  });
});