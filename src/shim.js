import { Buffer as BufferPolyfill } from 'buffer';
import processPolyfill from 'process';

// Set globals IMMEDIATELY when this module loads.
// esbuild runs injected files at the very top of the bundle, so this
// happens before any other module code executes.
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = BufferPolyfill;
}
if (typeof globalThis.process === 'undefined') {
  globalThis.process = processPolyfill || { env: {}, browser: true };
}
if (typeof globalThis.global === 'undefined') {
  globalThis.global = globalThis;
}

// Export for `inject` to wire into any imports of `Buffer` / `process`
export { BufferPolyfill as Buffer };
export const process = processPolyfill || { env: {}, browser: true };