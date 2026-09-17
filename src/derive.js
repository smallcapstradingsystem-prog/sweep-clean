import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@solana/web3.js';
import { BIP32Factory } from 'bip32';
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from '@bitcoinerlab/secp256k1';
import { HDNodeWallet } from 'ethers';

const ECPair = ECPairFactory(ecc);
const bip32 = BIP32Factory(ecc);
const BTC_NETWORK = bitcoin.networks.bitcoin;

const BITCOIN_PATH = "m/84'/0'/0'/0/0";

// Solana derivation paths used by major wallets. We derive all of them
// and let the sweep loop pick whichever address has on-chain activity.
const SOLANA_PATHS = {
  phantom:    "m/44'/501'/0'/0'",   // Phantom, Solflare, Backpack, Exodus
  trust:      "m/44'/501'/0'",       // Trust Wallet, Ledger (native)
  ledgerLive: "m/44'/501'/0'/0'/0'", // Ledger Live
};

export function validateMnemonic(phrase) {
  return bip39.validateMnemonic(phrase.trim().replace(/\s+/g, ' '));
}

export function deriveEvm(phrase) {
  const clean = phrase.trim().replace(/\s+/g, ' ');
  if (!bip39.validateMnemonic(clean)) throw new Error('Invalid BIP-39 mnemonic');
  const wallet = HDNodeWallet.fromPhrase(clean);
  return { address: wallet.address, privateKey: wallet.privateKey, wallet };
}

/**
 * Derive all known Solana addresses for a mnemonic.
 * Returns an array of candidates: [{ name, path, address, keypair }, ...]
 * Order is stable (phantom first, then trust, then ledgerLive).
 */
export function deriveSolanaCandidates(phrase) {
  const clean = phrase.trim().replace(/\s+/g, ' ');
  if (!bip39.validateMnemonic(clean)) throw new Error('Invalid BIP-39 mnemonic');
  const seed = bip39.mnemonicToSeedSync(clean);

  const candidates = [];
  for (const [name, path] of Object.entries(SOLANA_PATHS)) {
    try {
      const derived = derivePath(path, seed.toString('hex'));
      const keypair = Keypair.fromSeed(derived.key);
      candidates.push({
        name,
        path,
        address: keypair.publicKey.toBase58(),
        keypair,
      });
    } catch (e) {
      // Skip paths that fail — shouldn't happen, but be defensive.
    }
  }
  if (candidates.length === 0) {
    throw new Error('No Solana derivation paths succeeded');
  }
  return candidates;
}

/**
 * Backwards-compatible single-keypair derivation (Phantom path).
 * Kept for any callers that still expect the old shape.
 */
export function deriveSolana(phrase) {
  const candidates = deriveSolanaCandidates(phrase);
  const phantom = candidates.find((c) => c.name === 'phantom') || candidates[0];
  return { address: phantom.address, keypair: phantom.keypair };
}

export function deriveBitcoin(phrase) {
  const clean = phrase.trim().replace(/\s+/g, ' ');
  if (!bip39.validateMnemonic(clean)) throw new Error('Invalid BIP-39 mnemonic');
  const seed = bip39.mnemonicToSeedSync(clean);
  const root = bip32.fromSeed(seed, BTC_NETWORK);
  const child = root.derivePath(BITCOIN_PATH);
  if (!child.privateKey) throw new Error('BIP-32 derivation produced no key');
  const keyPair = ECPair.fromPrivateKey(child.privateKey, { network: BTC_NETWORK });
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: keyPair.publicKey,
    network: BTC_NETWORK,
  });
  return { address, wif: keyPair.toWIF(), keyPair };
}

export function deriveAll(phrases, families) {
  const result = { evm: [], solana: [], bitcoin: [], errors: [] };
  for (let i = 0; i < phrases.length; i++) {
    const phrase = phrases[i];
    if (families.evm) {
      try { result.evm.push({ index: i, ...deriveEvm(phrase) }); }
      catch (e) { result.errors.push(`evm[${i}]: ${e.message}`); }
    }
    if (families.solana) {
      try {
        const candidates = deriveSolanaCandidates(phrase);
        result.solana.push({ index: i, candidates });
      } catch (e) { result.errors.push(`solana[${i}]: ${e.message}`); }
    }
    if (families.bitcoin) {
      try { result.bitcoin.push({ index: i, ...deriveBitcoin(phrase) }); }
      catch (e) { result.errors.push(`bitcoin[${i}]: ${e.message}`); }
    }
  }
  return result;
}