import { describe, it, expect } from 'vitest';
import { ChainVerifyError, verifySignerChain } from '../../chain-verify.js';

const ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const CFG = { chainId: 8453, router: ROUTER, name: 'Base' };
const SIGNER_ADDR = '0x1111111111111111111111111111111111111111';
const OTHER_ADDR = '0x2222222222222222222222222222222222222222';

// Minimal fakes. The function only calls:
//   provider.getNetwork()   → { chainId }
//   provider.getCode(addr)  → hex string
//   signer.getAddress()     → hex address
//   signer.provider.getNetwork() (optional)
function makeProvider({ chainId = 8453, code = '0x60016001' } = {}) {
  return {
    async getNetwork() { return { chainId: BigInt(chainId) }; },
    async getCode() { return code; },
  };
}

function makeSigner({ address = SIGNER_ADDR, provider = null, providerThrows = null } = {}) {
  const sp = provider === null ? null : {
    async getNetwork() {
      if (providerThrows) throw providerThrows;
      return { chainId: BigInt(provider) };
    },
  };
  return {
    provider: sp,
    async getAddress() { return address; },
  };
}

describe('verifySignerChain', () => {
  it('passes when everything matches', async () => {
    const r = await verifySignerChain('base', makeProvider(), makeSigner(), CFG, SIGNER_ADDR);
    expect(r.chainId).toBe(8453);
    expect(r.router).toBe(ROUTER);
  });

  it('passes when expectedAddress is omitted', async () => {
    const r = await verifySignerChain('base', makeProvider(), makeSigner(), CFG);
    expect(r.chainId).toBe(8453);
  });

  it('throws when the RPC chainId does not match', async () => {
    const p = makeProvider({ chainId: 1 }); // Ethereum instead of Base
    await expect(verifySignerChain('base', p, makeSigner(), CFG))
      .rejects.toThrow(ChainVerifyError);
    await expect(verifySignerChain('base', p, makeSigner(), CFG))
      .rejects.toThrow(/RPC chain mismatch/);
  });

  it('throws when the signer provider chainId does not match', async () => {
    const signer = makeSigner({ provider: 1 }); // wallet on Ethereum
    await expect(verifySignerChain('base', makeProvider(), signer, CFG))
      .rejects.toThrow(/Wallet is on chain/);
  });

  it('throws when the signer address does not match expected', async () => {
    const signer = makeSigner({ address: OTHER_ADDR });
    await expect(verifySignerChain('base', makeProvider(), signer, CFG, SIGNER_ADDR))
      .rejects.toThrow(/Signer returned/);
  });

  it('compares addresses case-insensitively', async () => {
    const signer = makeSigner({ address: SIGNER_ADDR.toUpperCase() });
    const r = await verifySignerChain('base', makeProvider(), signer, CFG, SIGNER_ADDR.toLowerCase());
    expect(r.chainId).toBe(8453);
  });

  it('throws when the router is not deployed (code = 0x)', async () => {
    const p = makeProvider({ code: '0x' });
    await expect(verifySignerChain('base', p, makeSigner(), CFG))
      .rejects.toThrow(/Router .* is not deployed/);
  });

  it('throws when the router is not deployed (code = 0x0)', async () => {
    const p = makeProvider({ code: '0x0' });
    await expect(verifySignerChain('base', p, makeSigner(), CFG))
      .rejects.toThrow(/Router .* is not deployed/);
  });

  it('throws when the router is empty string', async () => {
    const p = makeProvider({ code: '' });
    await expect(verifySignerChain('base', p, makeSigner(), CFG))
      .rejects.toThrow(/Router .* is not deployed/);
  });

  it('ignores a signer provider that throws on getNetwork', async () => {
    // Some hardware shims don't expose getNetwork. That should not be
    // fatal — the RPC check above already ran.
    const signer = makeSigner({ provider: 8453, providerThrows: new Error('no network') });
    const r = await verifySignerChain('base', makeProvider(), signer, CFG);
    expect(r.chainId).toBe(8453);
  });

  it('throws when cfg is missing', async () => {
    await expect(verifySignerChain('base', makeProvider(), makeSigner(), null))
      .rejects.toThrow(ChainVerifyError);
  });

  it('surfaces an RPC error on getCode as a ChainVerifyError', async () => {
    const p = {
      async getNetwork() { return { chainId: 8453n }; },
      async getCode() { throw new Error('RPC unreachable'); },
    };
    await expect(verifySignerChain('base', p, makeSigner(), CFG))
      .rejects.toThrow(/Could not verify router/);
  });
});