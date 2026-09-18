import { state } from './state.js';

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function $$(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (typeof child === 'string') node.appendChild(document.createTextNode(child));
    else if (child) node.appendChild(child);
  }
  return node;
}

export function show(sel) {
  const node = typeof sel === 'string' ? $(sel) : sel;
  if (node) node.style.display = '';
}

export function hide(sel) {
  const node = typeof sel === 'string' ? $(sel) : sel;
  if (node) node.style.display = 'none';
}

export function logLine(msg) {
  const out = $('#run-log');
  if (!out) return;
  const line = `[${new Date().toISOString()}] ${msg}`;
  out.textContent += line + '\n';
  out.scrollTop = out.scrollHeight;
}

export function clearLog() {
  const out = $('#run-log');
  if (out) out.textContent = '';
}

// =====================================================================
// AUTO-LIVE CONFIRM MODAL
// =====================================================================
//
// Returns a Promise<boolean>:
//   resolve(true)  → proceed with the live sweep
//   resolve(false) → user cancelled, or countdown not used
//
// Renders a fixed overlay with a countdown. Cleanly removes itself on
// resolve. If `seconds` is 0 or negative, the modal resolves(true)
// immediately — used by the AUTO_LIVE_REQUIRE_CONFIRM=false zero-click
// path so the caller has a single code path either way.
//
// `modeWasDryRun` is passed by the caller (main.js) so the copy can
// acknowledge that the user had selected dry-run. When true, the
// modal offers a two-line pitch: "you were in dry-run, but this
// wallet is worth $X; sweep live now?" — with the same countdown
// semantics. When false, it's the plain "sweep now" version.
// =====================================================================

export function showAutoLiveConfirm({ totalUsd, walletCount, seconds, modeWasDryRun = false }) {
  return new Promise((resolve) => {
    if (!seconds || seconds <= 0) {
      resolve(true);
      return;
    }

    let remaining = Math.ceil(seconds);
    let timer = null;
    let resolved = false;

    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearInterval(timer);
      overlay.remove();
      resolve(value);
    };

    const walletWord = walletCount === 1 ? 'wallet' : 'wallets';
    const totalStr = totalUsd.toFixed(2);

    const countdownEl = el('div', {
      class: 'auto-live-countdown',
      text: String(remaining),
    });

    const cancelBtn = el('button', {
      class: 'btn btn-secondary',
      text: 'Cancel',
      onclick: () => finish(false),
    });

    const nowBtn = el('button', {
      class: 'btn btn-danger',
      text: 'Sweep now',
      onclick: () => finish(true),
    });

    // Body copy varies based on whether the user was in dry-run. The
    // dry-run variant acknowledges the mode radio so it doesn't look
    // like the app ignored the user's selection.
    const bodyText = modeWasDryRun
      ? `${walletCount} ${walletWord} above the $50 threshold. You selected dry-run, but this wallet is worth sweeping live. Live sweep begins in ${remaining}s — press Cancel to stay in dry-run. No credit is used; the 10% service fee applies.`
      : `${walletCount} ${walletWord} above the $50 threshold. Live sweep will begin automatically. No credit is used — the 10% service fee applies.`;

    const bodyEl = el('p', { class: 'auto-live-body', text: bodyText });

    const card = el('div', { class: 'auto-live-card' }, [
      el('div', { class: 'auto-live-eyebrow', text: 'Auto-live sweep' }),
      el('h2', { class: 'auto-live-title', text: `$${totalStr} ready to sweep` }),
      bodyEl,
      countdownEl,
      el('div', { class: 'auto-live-actions' }, [cancelBtn, nowBtn]),
    ]);

    const overlay = el('div', {
      class: 'auto-live-overlay',
      onclick: (e) => {
        // Click outside the card cancels — matches the Cancel button.
        if (e.target === overlay) finish(false);
      },
    }, [card]);

    document.body.appendChild(overlay);

    timer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        finish(true);
        return;
      }
      countdownEl.textContent = String(remaining);
      // Keep the body copy's countdown reference in sync when in
      // dry-run mode.
      if (modeWasDryRun) {
        bodyEl.textContent = `${walletCount} ${walletWord} above the $50 threshold. You selected dry-run, but this wallet is worth sweeping live. Live sweep begins in ${remaining}s — press Cancel to stay in dry-run. No credit is used; the 10% service fee applies.`;
      }
    }, 1000);
  });
}