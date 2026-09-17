import { describe, it, expect, beforeEach } from 'vitest';
import { handleSweepCommit } from '../payment-worker.js';
import { createFakeEnv } from './helpers/fake-env.js';
import { makeRequest, readResponse } from './helpers/call-worker.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const CLIENT_A = 'clientaaa00000000000000000000000';
const CLIENT_B = 'clientbbb00000000000000000000000';
const DEST_1 = '0x1111111111111111111111111111111111111111';
const DEST_2 = '0x2222222222222222222222222222222222222222';
const SWEEP_ID = 'sweep-commit-0001';

describe('sweep commit', () => {
  let env;
  beforeEach(() => { env = createFakeEnv(); });

  it('stores a commit and returns ok', async () => {
    const req = makeRequest({ body: { clientId: CLIENT_A, sweepId: SWEEP_ID, userDestination: DEST_1 } });
    const resp = await readResponse(await handleSweepCommit(req, env, CORS));
    expect(resp.status).toBe(200);
    expect(resp.body.ok).toBe(true);
    expect(env.CREDITS._has(`sweep:${SWEEP_ID}`)).toBe(true);
  });

  it('is idempotent for the same destination', async () => {
    const body = { clientId: CLIENT_A, sweepId: SWEEP_ID, userDestination: DEST_1 };
    await handleSweepCommit(makeRequest({ body }), env, CORS);
    const resp = await readResponse(await handleSweepCommit(makeRequest({ body }), env, CORS));
    expect(resp.status).toBe(200);
    expect(resp.body.alreadyCommitted).toBe(true);
  });

  it('refuses a different destination for the same sweepId', async () => {
    await handleSweepCommit(
      makeRequest({ body: { clientId: CLIENT_A, sweepId: SWEEP_ID, userDestination: DEST_1 } }),
      env, CORS,
    );
    const resp = await readResponse(await handleSweepCommit(
      makeRequest({ body: { clientId: CLIENT_A, sweepId: SWEEP_ID, userDestination: DEST_2 } }),
      env, CORS,
    ));
    expect(resp.status).toBe(409);
    expect(resp.body.error).toMatch(/different destination/);
  });

  it('refuses a different client for the same sweepId', async () => {
    await handleSweepCommit(
      makeRequest({ body: { clientId: CLIENT_A, sweepId: SWEEP_ID, userDestination: DEST_1 } }),
      env, CORS,
    );
    const resp = await readResponse(await handleSweepCommit(
      makeRequest({ body: { clientId: CLIENT_B, sweepId: SWEEP_ID, userDestination: DEST_1 } }),
      env, CORS,
    ));
    expect(resp.status).toBe(409);
    expect(resp.body.error).toMatch(/different client/);
  });

  it('rejects a malformed destination', async () => {
    const resp = await readResponse(await handleSweepCommit(
      makeRequest({ body: { clientId: CLIENT_A, sweepId: SWEEP_ID, userDestination: 'not-hex' } }),
      env, CORS,
    ));
    expect(resp.status).toBe(400);
  });

  it('rejects a too-short sweepId', async () => {
    const resp = await readResponse(await handleSweepCommit(
      makeRequest({ body: { clientId: CLIENT_A, sweepId: 'x', userDestination: DEST_1 } }),
      env, CORS,
    ));
    expect(resp.status).toBe(400);
  });

  it('rejects a missing clientId', async () => {
    const resp = await readResponse(await handleSweepCommit(
      makeRequest({ body: { sweepId: SWEEP_ID, userDestination: DEST_1 } }),
      env, CORS,
    ));
    expect(resp.status).toBe(400);
  });
});