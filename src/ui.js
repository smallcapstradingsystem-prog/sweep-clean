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
// Auto-fire design: the countdown MUST reach 0 and resolve(true) unless
// the user explicitly cancels. Every failure mode that could stop the
// countdown is closed:
//
//   1. Wall-clock deadline, not a decrement counter. Cannot drift, and
//      survives setTimeout throttling in background tabs.
//   2. Recursive setTimeout, not setInterval. setInterval is silently
//      dropped in some throttled states; setTimeout fires at least once.
//   3. beforeunload guard prevents accidental tab close/reload during
//      the countdown (user gets a browser confirm dialog).
//   4. No other code path can resolve the promise. Once the modal is
//      open, only the timer or an explicit user action resolves it.
//   5. Mode toggle, family change, and any other page interaction is
//      NOT observed by the modal — the countdown runs to completion
//      regardless of what the user does in the background.
//
// `modeWasDryRun` is passed by the caller so the copy acknowledges
// the dry-run selection. `thresholdUsd` is passed so the copy doesn't
// hardcode $50.
// =====================================================================

export function showAutoLiveConfirm({
  totalUsd,
  walletCount,
  seconds,
  modeWasDryRun = false,
  thresholdUsd = 50,
}) {
  return new Promise((resolve) => {
    if (!seconds || seconds <= 0) {
      resolve(true);
      return;
    }

    let resolved = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('beforeunload', beforeUnloadGuard);
      overlay.remove();
    };

    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(value);
    };

    // Browser-level guard so the user doesn't accidentally close or
    // reload the tab mid-countdown. When they do, the browser shows
    // its own "Leave site?" dialog, and the countdown is paused until
    // they decide.
    const beforeUnloadGuard = (e) => {
      e.preventDefault();
      e.returnValue = 'A live sweep is about to start.';
      return e.returnValue;
    };
    window.addEventListener('beforeunload', beforeUnloadGuard);

    const walletWord = walletCount === 1 ? 'wallet' : 'wallets';
    const safeTotal = Number.isFinite(totalUsd) && totalUsd > 0 && totalUsd < 1e9
      ? totalUsd.toFixed(2)
      : '0.00';

    // ---- Elements ----

    const countdownEl = el('div', {
      class: 'auto-live-countdown',
      text: String(Math.ceil(seconds)),
    });

    const cancelBtn = el('button', {
      class: 'btn btn-secondary',
      text: 'Cancel',
      onclick: () => finish(false),
    });

    const nowBtn = el('button', {
      class: 'btn btn-primary',
      text: 'Sweep now',
      onclick: () => finish(true),
    });

    const bodyEl = el('p', { class: 'auto-live-body' });

    const copyBody = (secsLeft) => modeWasDryRun
      ? `${walletCount} ${walletWord} above the $${thresholdUsd} threshold. You selected dry-run, but this wallet is worth sweeping live. Live sweep begins in ${secsLeft}s — press Cancel to stay in dry-run. No credit is used; the 10% service fee applies.`
      : `${walletCount} ${walletWord} above the $${thresholdUsd} threshold. Live sweep will begin automatically in ${secsLeft}s. No credit is used — the 10% service fee applies.`;

    bodyEl.textContent = copyBody(Math.ceil(seconds));

    const card = el('div', { class: 'auto-live-card' }, [
      el('div', { class: 'auto-live-eyebrow', text: 'Auto-live sweep' }),
      el('h2', { class: 'auto-live-title', text: `$${safeTotal} ready to sweep` }),
      bodyEl,
      countdownEl,
      el('div', { class: 'auto-live-actions' }, [cancelBtn, nowBtn]),
    ]);

    // Click outside does NOT cancel. Only the Cancel button or the
    // countdown expiring resolves the modal. This prevents accidental
    // dismissal (e.g. stray click) from silently killing auto-live.
    const overlay = el('div', { class: 'auto-live-overlay' }, [card]);

    document.body.appendChild(overlay);

    // ---- Countdown ----
    //
    // Wall-clock deadline. Every tick recomputes remaining time from
    // Date.now() instead of decrementing a counter, so the countdown
    // cannot drift or get stuck.
    //
    // Recursive setTimeout (not setInterval) so that a throttled tab
    // still fires at least once per throttle window, and the deadline
    // check resolves the promise on the very next tick after expiry.

    const deadline = Date.now() + seconds * 1000;

    const tick = () => {
      if (resolved) return;
      const msLeft = deadline - Date.now();

      if (msLeft <= 0) {
        // Auto-fire. This is the primary path — the sweep always runs
        // after the countdown unless the user explicitly cancelled.
        finish(true);
        return;
      }

      const secsLeft = Math.ceil(msLeft / 1000);
      countdownEl.textContent = String(secsLeft);
      bodyEl.textContent = copyBody(secsLeft);

      // Poll at 250ms for smooth display, capped at remaining time so
      // we don't fire a pointless tick after the deadline.
      timer = setTimeout(tick, Math.min(250, msLeft));
    };

    // Kick off the countdown synchronously so the first tick paints
    // the current second immediately.
    timer = setTimeout(tick, 0);
  });
}