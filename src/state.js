export const state = {
  // Inputs
  walletType: 'mnemonic',
  mnemonics: [],
  destinations: { evm: '', solana: '', bitcoin: '', tron: '' },
  families: { evm: true, solana: false, bitcoin: false, tron: false },
  evmChains: ['base', 'optimism', 'arbitrum'],
  mode: 'dry-run',

  // Client identity (pseudonymous)
  clientId: null,

  // Credits
  credits: 0,

  // Derived keys (in-memory only, never persisted)
  derivedKeys: null,
  wallet: null,

  // Preview / results
  previews: null,
  results: null,
};

export function resetState() {
  state.derivedKeys = null;
  state.previews = null;
  state.results = null;
}

export function clearAll() {
  state.mnemonics = [];
  state.destinations = { evm: '', solana: '', bitcoin: '', tron: '' };
  state.families = { evm: true, solana: false, bitcoin: false, tron: false };
  state.wallet = null;
  resetState();
}