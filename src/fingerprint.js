/**
 * fingerprint.js — Soft browser fingerprint.
 *
 * Combines a handful of low-entropy navigator/screen signals into a
 * single hash. Stable across page reloads and incognito windows on
 * the same device; varies across devices and browsers.
 *
 * The intent is NOT to identify individuals — it's to make the
 * free-credit launch bonus rate-limit on something other than
 * clientId (which the user controls) and IP (which NATs share).
 *
 * Signals (soft — all immediately available, none prompt):
 *   - navigator.userAgent
 *   - navigator.language
 *   - Intl.DateTimeFormat().resolvedOptions().timeZone
 *   - screen.width × screen.height × screen.colorDepth
 *   - window.devicePixelRatio
 *   - navigator.platform
 *   - navigator.hardwareConcurrency
 *
 * NOT included:
 *   - Canvas / WebGL / AudioContext hashes. More stable across minor
 *     browser updates, but heavier, may trigger permission prompts,
 *     and are more invasive. Not warranted for a launch-bonus rate
 *     limit.
 *   - Any cookie or storage value. The fingerprint is computed from
 *     ambient signals so clearing storage doesn't change it.
 *
 * Output: 16 hex characters (SHA-256, truncated to 64 bits).
 */

function rawSignals() {
  const parts = [];

  if (typeof navigator !== 'undefined') {
    parts.push(String(navigator.userAgent || ''));
    parts.push(String(navigator.language || ''));
    parts.push(String(navigator.platform || ''));
    parts.push(String(navigator.hardwareConcurrency || ''));
  } else {
    parts.push('', '', '', '');
  }

  try {
    parts.push(Intl.DateTimeFormat().resolvedOptions().timeZone || '');
  } catch {
    parts.push('');
  }

  if (typeof screen !== 'undefined') {
    parts.push(`${screen.width}x${screen.height}x${screen.colorDepth}`);
  } else {
    parts.push('');
  }

  if (typeof window !== 'undefined') {
    parts.push(String(window.devicePixelRatio || 1));
  } else {
    parts.push('');
  }

  return parts.join('|');
}

async function sha256Hex(input) {
  // Browser path: Web Crypto is available on HTTPS or localhost.
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = new TextEncoder().encode(input);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // Node fallback for tests. The dynamic import keeps the client
  // bundle from trying to bundle node:crypto.
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Return a 16-character hex fingerprint for the current browser.
 * Async because SHA-256 is async in the browser.
 *
 * On any failure returns the literal string 'unknown'. The worker
 * treats that as its own bucket so a broken fingerprint can't bypass
 * the cap — it just shares a rate limit with other broken clients.
 */
export async function getFingerprint() {
  try {
    const raw = rawSignals();
    const hash = await sha256Hex(raw);
    return hash.slice(0, 16);
  } catch {
    return 'unknown';
  }
}