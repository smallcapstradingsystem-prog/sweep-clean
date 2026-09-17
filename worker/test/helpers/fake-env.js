/**
 * fake-env.js — Builds the `env` object the worker expects, with
 * in-memory KV bindings and stub secrets.
 */

import { createFakeKV } from './fake-kv.js';

export function createFakeEnv(overrides = {}) {
  return {
    CREDITS: createFakeKV(),
    PENDING_PAYMENTS: createFakeKV(),

    // Secrets the worker reads. Tests can override per-case.
    CRYPTO_ADDRESS_EVM: '0x0000000000000000000000000000000000000001',
    CRYPTO_ADDRESS_SOL: 'So11111111111111111111111111111111111111112',
    CRYPTO_ADDRESS_BTC: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',

    ETHERSCAN_API_KEY: 'fake-etherscan-key',
    HELIUS_API_KEY: 'fake-helius-key',
    GAS_SPONSOR_KEY: '0x' + '00'.repeat(32),
    OPERATOR_SECRET: 'test-operator-secret',

    ...overrides,
  };
}