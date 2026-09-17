/**
 * chain-verify.js — Pre-signing chain and signer verification.
 *
 * Before signing an EVM transaction, confirm that BOTH the ethers
 * provider and the underlying wallet agree on the chain id. A
 * mismatch usually means:
 *   - the extension/WC session is on a different chain than the RPC
 *     we're building the tx against
 *   - the user switched networks between the switchChain call and now
 *   - getRpcUrl() returned a stale endpoint
 *
 * Throwing here is better than broadcasting a tx on the wrong chain.
 *
 * Also checks that the router contract is deployed at the configured
 * address — catches chain-id collisions and misconfigured RPCs — and
 * that the signer's address matches the connected account, so a user
 * who switched accounts in the extension can't sign the wrong tx.
 */

import { scrubSecret } from './scrub.js';

// Custom error so we can distinguish our verification failures from
// unrelated errors raised inside getNetwork()/getCode(). A flag or a
// regex would be brittle; a proper error class is not.
export class ChainVerifyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChainVerifyError';
  }
}

/**
 * Verify the signer is on the expected chain before signing.
 *
 * @param {string} chain   - chain key (e.g. 'base')
 * @param {object} provider - ethers provider for the target chain
 * @param {object} signer   - ethers signer (may be wallet-backed)
 * @param {object} cfg      - chain config with chainId and router
 * @param {string} [expectedAddress] - if set, signer.getAddress() must match
 * @returns {{ chainId: number, router: string }}
 * @throws {ChainVerifyError} on any mismatch
 */
export async function verifySignerChain(chain, provider, signer, cfg, expectedAddress) {
  if (!cfg) throw new ChainVerifyError(`verifySignerChain: unknown chain ${chain}`);
  const expected = Number(cfg.chainId);

  // (a) RPC's view of the chain id.
  const net = await provider.getNetwork();
  const rpcChainId = Number(net.chainId);
  if (rpcChainId !== expected) {
    throw new ChainVerifyError(
      `RPC chain mismatch: provider reports ${rpcChainId}, expected ${expected} (${chain}). ` +
      `Check the RPC URL for this chain.`
    );
  }

  // (b) Signer provider's view — for extension/WC this is the wallet.
  // For mnemonic/hardware it's the same JsonRpcProvider, so this is a
  // no-op sanity check in those cases.
  try {
    const sp = signer.provider;
    if (sp && typeof sp.getNetwork === 'function') {
      const signerNet = await sp.getNetwork();
      const signerChainId = Number(signerNet.chainId);
      if (signerChainId !== expected) {
        throw new ChainVerifyError(
          `Wallet is on chain ${signerChainId}, expected ${expected} (${chain}). ` +
          `Switch the wallet to the correct network and retry.`
        );
      }
    }
  } catch (e) {
    if (e instanceof ChainVerifyError) throw e;
    // Some hardware signer shims don't expose getNetwork. That's fine —
    // the RPC check above already passed. Any other error from the
    // signer's provider is non-fatal here for the same reason.
  }

  // (c) Signer address matches the address we think we're sweeping.
  // Catches the case where the user changed accounts in the extension
  // between connecting and pressing Run.
  if (expectedAddress) {
    const signerAddr = await signer.getAddress();
    if (signerAddr.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new ChainVerifyError(
        `Signer returned ${signerAddr}, expected ${expectedAddress}. ` +
        `Switch back to the originally connected account.`
      );
    }
  }

  // (d) Router deployment check. A correctly-deployed contract returns
  // non-empty bytecode. On a fork or a wrong chain with the same id,
  // this is '0x'.
  let code;
  try {
    code = await provider.getCode(cfg.router);
  } catch (e) {
    throw new ChainVerifyError(`Could not verify router on ${chain}: ${scrubSecret(e.message)}`);
  }
  if (!code || code === '0x' || code === '0x0') {
    throw new ChainVerifyError(
      `Router ${cfg.router} is not deployed on ${chain} (chainId ${expected}). ` +
      `The RPC may be pointing at a fork or testnet.`
    );
  }

  return { chainId: expected, router: cfg.router };
}