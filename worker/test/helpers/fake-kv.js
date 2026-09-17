/**
 * fake-kv.js — In-memory KVNamespace for tests.
 *
 * Mirrors the shape of Cloudflare's KVNamespace binding:
 *   get(key)            → string | null
 *   put(key, value, opts)  → void
 *   delete(key)         → void
 *
 * `opts.expirationTtl` is honored on read: if a key's expiry has
 * passed, get() returns null. We do not actually wait — tests can
 * manipulate time with `vi.useFakeTimers()` or by setting
 * `_now()` directly.
 *
 * Not emulated:
 *   - Eventual consistency (KV's read-after-write delay)
 *   - Metadata
 *   - Cursor-based list()
 *   - Bulk operations
 *
 * None of those matter for the worker's logic.
 */

export function createFakeKV({ now = () => Date.now() } = {}) {
  // Map<string, { value: string, expiresAt: number | null }>
  const store = new Map();

  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && now() >= entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },

    async put(key, value, opts = {}) {
      const expiresAt = opts.expirationTtl
        ? now() + opts.expirationTtl * 1000
        : null;
      store.set(key, { value: String(value), expiresAt });
    },

    async delete(key) {
      store.delete(key);
    },

    // Test-only helpers. Not part of the Cloudflare KV API.
    _size() { return store.size; },
    _keys() { return [...store.keys()]; },
    _has(key) { return store.has(key); },
    _clear() { store.clear(); },
  };
}