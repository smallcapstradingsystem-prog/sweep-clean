/**
 * wallet.js — Signing backends: mnemonic, WalletConnect, Ledger, Trezor, Browser Extension.
 */

import { ethers } from 'ethers';
import { deriveEvm } from './derive.js';

// =====================================================================
// HELPERS
// =====================================================================

/**
 * Normalize a signature `v` value to 0 or 1 (yParity).
 *
 * Different signers return `v` in different conventions:
 *   - 0 or 1        → already yParity (some Ledger firmware, Trezor)
 *   - 27 or 28      → legacy EIP-155 (most Ledger firmware)
 *   - 25, 26        → EIP-1559 with chain-id encoding in some firmwares
 *   - 35+           → EIP-155 with chain id (rare, shouldn't appear here)
 *
 * Ethers v6 expects 0 or 1 on `Signature.v` for typed transactions.
 */
function normalizeV(rawV) {
  const v = typeof rawV === 'string' ? parseInt(rawV, 16) : Number(rawV);
  if (v === 0 || v === 1) return v;
  if (v === 27 || v === 28) return v - 27;
  if (v === 25 || v === 26) return v - 25;  // some Ledger firmware
  throw new Error(`Unexpected signature v value: ${v} (raw: ${rawV})`);
}

// =====================================================================
// MNEMONIC BACKEND
// =====================================================================
//
// EVM-only. Solana and Bitcoin derivation happens in main.js via
// deriveAll(), which supports multiple candidate paths and picks the
// right one based on on-chain activity. This backend does not expose
// Solana or Bitcoin keypairs — see main.js for those flows.
// =====================================================================

export class MnemonicWallet {
  constructor(phrase) {
    this.phrase = phrase;
    this._evm = null;
  }

  async getAddress() {
    if (!this._evm) this._evm = deriveEvm(this.phrase);
    return this._evm.address;
  }

  async getEthersSigner(provider) {
    if (!this._evm) this._evm = deriveEvm(this.phrase);
    return this._evm.wallet.connect(provider);
  }

  async dispose() {
    this.phrase = null;
    this._evm = null;
  }
}

// =====================================================================
// BROWSER EXTENSION BACKEND
// =====================================================================

export class BrowserExtensionBackend {
  constructor(ethersProvider, rawProvider, address, chainId) {
    this.provider = ethersProvider;
    this.rawProvider = rawProvider;
    this.address = address;
    this.chainId = chainId;
  }

  async getAddress() {
    return this.address;
  }

  async getEthersSigner(_provider) {
    return this.provider.getSigner();
  }

  async getChainId() {
    const hex = await this.rawProvider.request({ method: 'eth_chainId' });
    const parsed = parseInt(hex, 16);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Wallet returned an invalid chain id: ${hex}`);
    }
    this.chainId = parsed;
    return parsed;
  }

  getSolanaKeypair() {
    throw new Error('Browser extensions do not support Solana in this build');
  }

  getBitcoinKeyPair() {
    throw new Error('Browser extensions do not support Bitcoin in this build');
  }

  async switchChain(chainId, _extra = {}) {
    const target = Number(chainId);

    try {
      const current = await this.getChainId();
      if (current === target) return true;
    } catch {
      // Couldn't read current chain — attempt the switch below.
    }

    const hex = '0x' + target.toString(16);
    try {
      await this.rawProvider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: hex }],
      });
      await this.getChainId();
      return true;
    } catch (e) {
      if (e.code === 4902 || (e.message && e.message.includes('Unrecognized chain ID'))) {
        throw new Error(`Wallet does not have chain ${chainId} configured. Add it to the wallet and try again.`);
      }
      throw e;
    }
  }

  async dispose() {
    // Browser extensions don't have a "disconnect" concept.
  }
}

export async function connectBrowserExtension() {
  if (typeof window === 'undefined' || !window.ethereum) {
    throw new Error(
      'No browser wallet detected. Install MetaMask, Rabby, or another EIP-1193 wallet extension and reload the page.'
    );
  }

  const raw = window.ethereum;

  let target = raw;
  if (Array.isArray(raw.providers) && raw.providers.length > 0) {
    target = raw.providers.find((p) => p.isMetaMask) || raw.providers[0];
  }

  const accounts = await target.request({ method: 'eth_requestAccounts' });
  if (!accounts || accounts.length === 0) {
    throw new Error('No accounts returned by the browser wallet');
  }
  const address = accounts[0];

  const chainIdHex = await target.request({ method: 'eth_chainId' });
  const chainId = parseInt(chainIdHex, 16);

  const ethersProvider = new ethers.BrowserProvider(target);

  return new BrowserExtensionBackend(ethersProvider, target, address, chainId);
}

// =====================================================================
// WALLETCONNECT BACKEND
// =====================================================================

export class WalletConnectBackend {
  constructor(wcProvider, ethersProvider, address, chainId) {
    this.wcProvider = wcProvider;
    this.provider = ethersProvider;
    this.address = address;
    this.chainId = chainId;
  }

  async getAddress() {
    return this.address;
  }

  async getEthersSigner(_provider) {
    return this.provider.getSigner();
  }

  async getChainId() {
    const cid = this.wcProvider.chainId;
    if (typeof cid === 'number' && cid > 0) {
      this.chainId = cid;
      return cid;
    }
    const hex = await this.wcProvider.request({ method: 'eth_chainId' });
    const parsed = parseInt(hex, 16);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`WalletConnect returned an invalid chain id: ${hex}`);
    }
    this.chainId = parsed;
    return parsed;
  }

  getSolanaKeypair() {
    throw new Error('WalletConnect does not support Solana in this build');
  }

  getBitcoinKeyPair() {
    throw new Error('WalletConnect does not support Bitcoin in this build');
  }

  async switchChain(chainId, extra = {}) {
    const target = Number(chainId);

    try {
      const current = await this.getChainId();
      if (current === target) return true;
    } catch {
      // Couldn't read current chain — attempt the switch below.
    }

    const hex = '0x' + target.toString(16);
    try {
      await this.wcProvider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: hex }],
      });
      await this.getChainId();
      return true;
    } catch (e) {
      const code = e?.code ?? e?.data?.originalError?.code;
      const msg = String(e?.message || '');
      const isMissingChain =
        code === 4902 ||
        msg.includes('Unrecognized chain ID') ||
        (msg.includes('chainId') && msg.includes('not') && msg.includes('added'));

      if (isMissingChain && extra.rpcUrls) {
        try {
          await this.wcProvider.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: hex,
              chainName: extra.chainName || `Chain ${target}`,
              rpcUrls: extra.rpcUrls,
              nativeCurrency: extra.nativeCurrency || { name: 'ETH', symbol: 'ETH', decimals: 18 },
              blockExplorerUrls: extra.blockExplorerUrls || [],
            }],
          });
          await this.getChainId();
          return true;
        } catch (addErr) {
          throw new Error(`WalletConnect could not add chain ${target}: ${addErr.message || addErr}`);
        }
      }

      throw new Error(`WalletConnect could not switch to chain ${target}: ${msg || e}`);
    }
  }

  async dispose() {
    try {
      await this.wcProvider.disconnect?.();
    } catch {}
  }
}

export async function connectWalletConnect({
  projectId,
  chains = [1, 42161, 10, 8453, 137],
  onUri,
  onConnect,
  onDisconnect,
}) {
  if (!projectId) throw new Error('WalletConnect requires a projectId');

  const { EthereumProvider } = await import('@walletconnect/ethereum-provider');

  const wcProvider = await EthereumProvider.init({
    projectId,
    chains: chains,
    optionalChains: chains,
    showQrModal: false,
    methods: [
      'eth_sendTransaction',
      'eth_signTransaction',
      'eth_sign',
      'personal_sign',
      'eth_signTypedData',
      'eth_signTypedData_v4',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
    ],
    events: ['chainChanged', 'accountsChanged'],
    metadata: {
      name: 'Sweeper',
      description: 'Non-custodial cross-chain wallet sweeper',
      url: window.location.origin,
      icons: [`${window.location.origin}/favicon.ico`],
    },
  });

  wcProvider.on('display_uri', (uri) => {
    if (onUri) onUri(uri);
  });

  await wcProvider.connect();

  if (onConnect) onConnect(wcProvider);

  wcProvider.on('disconnect', () => {
    if (onDisconnect) onDisconnect();
  });

  const accounts = wcProvider.accounts || [];
  if (accounts.length === 0) throw new Error('No accounts returned by WalletConnect');
  const address = accounts[0];

  const ethersProvider = new ethers.BrowserProvider(wcProvider);

  return new WalletConnectBackend(wcProvider, ethersProvider, address, wcProvider.chainId);
}

// =====================================================================
// LEDGER BACKEND
// =====================================================================

export class LedgerBackend {
  constructor(transport, ethApp, address, derivationPath) {
    this.transport = transport;
    this.ethApp = ethApp;
    this.address = address;
    this.derivationPath = derivationPath;
  }

  async getAddress() {
    return this.address;
  }

  async getEthersSigner(provider) {
    const address = this.address;
    const ethApp = this.ethApp;
    const path = this.derivationPath;

    class LedgerSigner extends ethers.AbstractSigner {
      constructor(provider) {
        super(provider);
        this.address = address;
      }

      async getAddress() {
        return this.address;
      }

      connect(provider) {
        return new LedgerSigner(provider);
      }

      async signTransaction(tx) {
        const unsignedTx = ethers.Transaction.from(tx);
        const unsignedHex = unsignedTx.unsignedSerialized.slice(2);

        const sig = await ethApp.signTransaction(path, unsignedHex);

        const v = normalizeV(sig.v);

        unsignedTx.signature = ethers.Signature.from({
          r: '0x' + sig.r,
          s: '0x' + sig.s,
          v,
        });

        return unsignedTx.serialized;
      }

      async signMessage(message) {
        const messageHex = typeof message === 'string'
          ? Buffer.from(message, 'utf8').toString('hex')
          : Buffer.from(message).toString('hex');
        const sig = await ethApp.signPersonalMessage(path, messageHex);
        const v = normalizeV(sig.v);
        return ethers.Signature.from({ r: '0x' + sig.r, s: '0x' + sig.s, v }).serialized;
      }

      async signTypedData(domain, types, value) {
        const sig = await ethApp.signEIP712Message(path, { domain, types, message: value });
        const v = normalizeV(sig.v);
        return ethers.Signature.from({ r: '0x' + sig.r, s: '0x' + sig.s, v }).serialized;
      }

      async sendTransaction(tx) {
        const signed = await this.signTransaction(tx);
        return this.provider.broadcastTransaction(signed);
      }
    }

    return new LedgerSigner(provider);
  }

  getSolanaKeypair() {
    throw new Error('Ledger Solana support not implemented in this build');
  }

  getBitcoinKeyPair() {
    throw new Error('Ledger Bitcoin support not implemented in this build');
  }

  async dispose() {
    try {
      await this.transport.close();
    } catch {}
  }
}

export async function connectLedger({ derivationPath = "44'/60'/0'/0/0" } = {}) {
  if (!navigator.hid) {
    throw new Error('WebHID is not supported in this browser. Use Chrome or Edge.');
  }

  const [{ default: TransportWebHID }, { default: Eth }] = await Promise.all([
    import('@ledgerhq/hw-transport-webhid'),
    import('@ledgerhq/hw-app-eth'),
  ]);

  const transport = await TransportWebHID.create();
  const ethApp = new Eth(transport);

  const result = await ethApp.getAddress(derivationPath, false, false);

  return new LedgerBackend(transport, ethApp, result.address, derivationPath);
}

// =====================================================================
// TREZOR BACKEND
// =====================================================================

export class TrezorBackend {
  constructor(address, derivationPath) {
    this.address = address;
    this.derivationPath = derivationPath;
  }

  async getAddress() {
    return this.address;
  }

  async getEthersSigner(provider) {
    const address = this.address;
    const path = this.derivationPath;

    class TrezorSigner extends ethers.AbstractSigner {
      constructor(provider) {
        super(provider);
        this.address = address;
      }

      async getAddress() {
        return this.address;
      }

      connect(provider) {
        return new TrezorSigner(provider);
      }

      async signTransaction(tx) {
        const { default: TrezorConnect } = await import('@trezor/connect-web');

        const resolved = await ethers.resolveProperties(tx);

        const result = await TrezorConnect.ethereumSignTransaction({
          path: path,
          transaction: {
            to: resolved.to || '',
            value: ethers.toQuantity(resolved.value || 0n),
            data: resolved.data || '0x',
            chainId: resolved.chainId,
            nonce: ethers.toQuantity(resolved.nonce),
            gasLimit: ethers.toQuantity(resolved.gasLimit),
            gasPrice: resolved.gasPrice ? ethers.toQuantity(resolved.gasPrice) : undefined,
            maxFeePerGas: resolved.maxFeePerGas ? ethers.toQuantity(resolved.maxFeePerGas) : undefined,
            maxPriorityFeePerGas: resolved.maxPriorityFeePerGas ? ethers.toQuantity(resolved.maxPriorityFeePerGas) : undefined,
          },
        });

        if (!result.success) throw new Error(result.payload.error);

        const { v, r, s } = result.payload;
        const vNum = normalizeV(v);

        const unsignedTx = ethers.Transaction.from(tx);
        unsignedTx.signature = ethers.Signature.from({ r, s, v: vNum });
        return unsignedTx.serialized;
      }

      async signMessage(message) {
        const { default: TrezorConnect } = await import('@trezor/connect-web');
        const messageHex = typeof message === 'string'
          ? Buffer.from(message, 'utf8').toString('hex')
          : Buffer.from(message).toString('hex');

        const result = await TrezorConnect.ethereumSignMessage({
          path: path,
          message: messageHex,
          hex: true,
        });

        if (!result.success) throw new Error(result.payload.error);
        const { v, r, s } = result.payload;
        const vNum = normalizeV(v);
        return ethers.Signature.from({ r, s, v: vNum }).serialized;
      }

      async signTypedData(domain, types, value) {
        const { default: TrezorConnect } = await import('@trezor/connect-web');
        const result = await TrezorConnect.ethereumSignTypedData({
          path: path,
          data: { domain, types, primaryType: Object.keys(types)[0], message: value },
          metamask_v4_compat: true,
        });

        if (!result.success) throw new Error(result.payload.error);
        const { v, r, s } = result.payload;
        const vNum = normalizeV(v);
        return ethers.Signature.from({ r, s, v: vNum }).serialized;
      }

      async sendTransaction(tx) {
        const signed = await this.signTransaction(tx);
        return this.provider.broadcastTransaction(signed);
      }
    }

    return new TrezorSigner(provider);
  }

  getSolanaKeypair() {
    throw new Error('Trezor Solana support not implemented in this build');
  }

  getBitcoinKeyPair() {
    throw new Error('Trezor Bitcoin support not implemented in this build');
  }

  async dispose() {}
}

export async function connectTrezor({ derivationPath = "m/44'/60'/0'/0/0" } = {}) {
  const { default: TrezorConnect } = await import('@trezor/connect-web');

  await TrezorConnect.init({
    lazyLoad: true,
    manifest: {
      email: 'support@sweeper.cloud',
      appUrl: window.location.origin,
    },
  });

  const result = await TrezorConnect.ethereumGetAddress({
    path: derivationPath,
    showOnTrezor: true,
  });

  if (!result.success) {
    throw new Error(result.payload.error);
  }

  return new TrezorBackend(result.payload.address, derivationPath);
}

// =====================================================================
// UNIFIED CONSTRUCTOR
// =====================================================================

export async function createWallet(config) {
  switch (config.type) {
    case 'mnemonic':
      if (!config.phrase) throw new Error('Mnemonic requires a phrase');
      return new MnemonicWallet(config.phrase);

    case 'extension':
      return await connectBrowserExtension();

    case 'walletconnect':
      return await connectWalletConnect({
        projectId: config.wcProjectId,
        onUri: config.wcOnUri,
      });

    case 'ledger':
      return await connectLedger({
        derivationPath: config.derivationPath,
      });

    case 'trezor':
      return await connectTrezor({
        derivationPath: config.derivationPath,
      });

    default:
      throw new Error(`Unknown wallet type: ${config.type}`);
  }
}