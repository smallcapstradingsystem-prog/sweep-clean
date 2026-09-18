import { describe, it, expect, afterEach } from 'vitest';
import { getFingerprint } from '../../fingerprint.js';

const originalNavigator = globalThis.navigator;
const originalScreen = globalThis.screen;
const originalWindow = globalThis.window;

let restoreIntl = null;

function setEnv({ ua, lang, platform, cores, tz, screenW, screenH, colorDepth, dpr } = {}) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      userAgent: ua ?? 'test-ua',
      language: lang ?? 'en-US',
      platform: platform ?? 'TestPlatform',
      hardwareConcurrency: cores ?? 8,
    },
  });

  Object.defineProperty(globalThis, 'screen', {
    configurable: true,
    writable: true,
    value: {
      width: screenW ?? 1920,
      height: screenH ?? 1080,
      colorDepth: colorDepth ?? 24,
    },
  });

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { devicePixelRatio: dpr ?? 1 },
  });

  const origResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
  Intl.DateTimeFormat.prototype.resolvedOptions = function () {
    return { timeZone: tz ?? 'America/New_York' };
  };
  restoreIntl = () => {
    Intl.DateTimeFormat.prototype.resolvedOptions = origResolved;
  };
}

describe('getFingerprint', () => {
  afterEach(() => {
    if (restoreIntl) { restoreIntl(); restoreIntl = null; }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: originalNavigator });
    Object.defineProperty(globalThis, 'screen', { configurable: true, writable: true, value: originalScreen });
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
  });

  it('returns a 16-char hex string', async () => {
    setEnv({});
    const fp = await getFingerprint();
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable across two calls with the same signals', async () => {
    setEnv({});
    const a = await getFingerprint();
    const b = await getFingerprint();
    expect(a).toBe(b);
  });

  it('changes when userAgent changes', async () => {
    setEnv({ ua: 'ua-A' });
    const a = await getFingerprint();
    setEnv({ ua: 'ua-B' });
    const b = await getFingerprint();
    expect(a).not.toBe(b);
  });

  it('changes when screen size changes', async () => {
    setEnv({ screenW: 1920, screenH: 1080 });
    const a = await getFingerprint();
    setEnv({ screenW: 2560, screenH: 1440 });
    const b = await getFingerprint();
    expect(a).not.toBe(b);
  });

  it('changes when timezone changes', async () => {
    setEnv({ tz: 'America/New_York' });
    const a = await getFingerprint();
    setEnv({ tz: 'Europe/London' });
    const b = await getFingerprint();
    expect(a).not.toBe(b);
  });

  it('changes when language changes', async () => {
    setEnv({ lang: 'en-US' });
    const a = await getFingerprint();
    setEnv({ lang: 'fr-FR' });
    const b = await getFingerprint();
    expect(a).not.toBe(b);
  });
});