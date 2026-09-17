const SENTRY_DSN = '';
const PLAUSIBLE_DOMAIN = '';

let sentryLoaded = false;
let Sentry = null;
let plausibleLoaded = false;

export async function initSentry() {
  if (!SENTRY_DSN || sentryLoaded) return;
  const mod = await import('@sentry/browser');
  Sentry = mod;
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: 'production',
    release: window.__SWEEP_RELEASE__ || 'dev',
    sendDefaultPii: false,
    tracesSampleRate: 0,
    sampleRate: 1.0,
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'User rejected the request',
      'User denied transaction signature',
      'User rejected transaction',
    ],
    beforeSend(event) { return scrubEvent(event); },
    beforeBreadcrumb(bc) { return scrubBreadcrumb(bc); },
  });
  sentryLoaded = true;
}

function scrubEvent(event) {
  if (event.request?.url) event.request.url = event.request.url.split('?')[0];
  if (event.request?.data) event.request.data = '[scrubbed]';
  if (event.extra) {
    delete event.extra.phrase;
    delete event.extra.mnemonic;
    delete event.extra.privateKey;
    delete event.extra.destination;
  }
  if (event.message) {
    event.message = event.message.replace(/0x[a-fA-F0-9]{20,}/g, '0x[REDACTED]');
  }
  return event;
}

function scrubBreadcrumb(bc) {
  if (bc.category === 'fetch' || bc.category === 'xhr') {
    if (bc.data?.url) bc.data.url = bc.data.url.split('?')[0];
    if (bc.data?.body) bc.data.body = '[scrubbed]';
  }
  return bc;
}

export function reportError(err, context = {}) {
  if (!sentryLoaded || !Sentry) { console.error(err); return; }
  Sentry.captureException(err, { extra: scrubExtra(context) });
}

function scrubExtra(context) {
  const out = {};
  for (const [k, v] of Object.entries(context || {})) {
    if (/phrase|mnemonic|private|secret|seed/i.test(k)) continue;
    out[k] = typeof v === 'string' ? v.replace(/0x[a-fA-F0-9]{20,}/g, '0x[REDACTED]') : v;
  }
  return out;
}

export function initPlausible() {
  if (!PLAUSIBLE_DOMAIN || plausibleLoaded) return;
  if (document.querySelector('script[data-domain]')) { plausibleLoaded = true; return; }
  const s = document.createElement('script');
  s.async = true;
  s.defer = true;
  s.setAttribute('data-domain', PLAUSIBLE_DOMAIN);
  s.src = 'https://plausible.io/js/script.js';
  document.head.appendChild(s);
  plausibleLoaded = true;
}

export function trackEvent(name, props = {}) {
  if (!window.plausible) return;
  const safeProps = {};
  for (const [k, v] of Object.entries(props)) {
    if (/address|phrase|key|hash|txid/i.test(k)) continue;
    safeProps[k] = v;
  }
  window.plausible(name, { props: safeProps });
}

export const track = {
  walletSelected: (type) => trackEvent('wallet_selected', { type }),
  previewStarted: (d) => trackEvent('preview_started', {
    wallet_type: d.walletType, families: d.families.join(','),
    chain_count: d.chainCount, mnemonic_count: d.mnemonicCount,
  }),
  previewCompleted: (d) => trackEvent('preview_completed', {
    wallet_type: d.walletType, duration_ms: d.durationMs, tokens_found: d.tokensFound,
  }),
  sweepStarted: (live) => trackEvent('sweep_started', { mode: live ? 'live' : 'dry-run' }),
  sweepCompleted: (d) => trackEvent('sweep_completed', {
    mode: d.live ? 'live' : 'dry-run', duration_ms: d.durationMs,
    successes: d.successes, failures: d.failures,
  }),
  paymentStarted: (method) => trackEvent('payment_started', { method }),
  paymentCompleted: (method) => trackEvent('payment_completed', { method }),
  error: (kind) => trackEvent('error', { kind }),
};