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
// resolve. The countdown is paused while the mouse is over the modal
// so a user who's reading doesn't get swept out from under them.
//
// If `seconds` is 0 or negative, the modal resolves(true) immediately
// — used by the AUTO_LIVE_REQUIRE_CONFIRM=false zero-click path so
// the caller has a single code path either way.
// =====================================================================

export function showAutoLiveConfirm({ totalUsd, walletCount, seconds }) {
  return new Promise((resolve) => {
    if (!seconds || seconds <= 0) {
      resolve(true);
      return;
    }

    let remaining = Math.ceil(seconds);
    let paused = false;
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

    const card = el('div', { class: 'auto-live-card' }, [
      el('div', { class: 'auto-live-eyebrow', text: 'Auto-live sweep' }),
      el('h2', { class: 'auto-live-title', text: `$${totalStr} ready to sweep` }),
      el('p', {
        class: 'auto-live-body',
        text: `${walletCount} ${walletWord} above the $50 threshold. Live sweep will begin automatically. No credit is used — the 10% service fee applies.`,
      }),
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

    overlay.addEventListener('mouseenter', () => { paused = true; });
    overlay.addEventListener('mouseleave', () => { paused = false; });

    document.body.appendChild(overlay);

    timer = setInterval(() => {
      if (paused) return;
      remaining -= 1;
      if (remaining <= 0) {
        finish(true);
        return;
      }
      countdownEl.textContent = String(remaining);
    }, 1000);
  });
}