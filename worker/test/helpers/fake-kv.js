/**
 * fake-kv.js — In-memory KVNamespace for tests.
 *
 * Mirrors the shape of Cloudflare's KVNamespace binding:
 *   get(key)               → string | null
 *   put(key, value, opts)  → void
 *   delete(key)            → void
 *   list({ prefix, limit }) → { keys, list_complete, cursor }
 *
 * `opts.expirationTtl` is honored on read: if a key's expiry has
 * passed, get() returns null. We do not actually wait — tests can
 * manipulate time with `vi.useFakeTimers()` or by setting
 * `_now()` directly.
 *
 * Not emulated:
 *   - Eventual consistency (KV's read-after-write delay)
 *   - Metadata
 *   - Cursor-based pagination across calls (list() returns
 *     `list_complete: true` when everything fits under the limit;
 *     the cursor is not persisted between calls)
 *   - Bulk operations (getMultiple, putMultiple, deleteMultiple)
 *
 * None of those matter for the worker's logic today. If a future
 * handler needs paginated list(), extend this file.
 */

export function createFakeKV({ now = () => Date.now() } = {}) {
  // Map<string, { value: string, expiresAt: number | null }>
  const store = new Map();

  function _isExpired(entry) {
    return entry.expiresAt !== null && now() >= entry.expiresAt;
  }

  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (_isExpired(entry)) {
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

    /**
     * List keys, optionally filtered by prefix, optionally capped by
     * limit. Returns the same shape Cloudflare returns:
     *   { keys: [{ name, expiration?, metadata? }], list_complete: bool, cursor? }
     *
     * Expired entries are skipped and lazily deleted, matching what
     * the real service does on read.
     *
     * The cursor is only meaningful if you call list() with the same
     * cursor on a subsequent call. We don't persist state between
     * calls, so `list_complete` is true whenever the result fits under
     * `limit`. If a test needs multi-page behavior, it should pass a
     * small limit and walk the result, accepting that our cursor is
     * opaque-but-unusable.
     */
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const keys = [];
      for (const [name, entry] of store.entries()) {
        if (_isExpired(entry)) {
          store.delete(name);
          continue;
        }
        if (prefix && !name.startsWith(prefix)) continue;
        keys.push({ name });
      }

      keys.sort((a, b) => a.name.localeCompare(b.name));

      const limited = keys.slice(0, limit);
      const list_complete = keys.length <= limit;

      return {
        keys: limited,
        list_complete,
        cursor: list_complete ? undefined : 'next-page-placeholder',
      };
    },

    // Test-only helpers. Not part of the Cloudflare KV API.
    _size() { return store.size; },
    _keys() { return [...store.keys()]; },
    _has(key) { return store.has(key); },
    _clear() { store.clear(); },
  };
}