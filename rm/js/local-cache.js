/* local-cache.js — Phase 9: tiny IndexedDB cache for Firestore reads.
 *
 * Some pages (email-review, calendar, year-review) need to scan thousands of
 * docs to render. The synced collections aren't paginated yet, so each page
 * load re-fetches the whole list — ~3 MB and 5-10s of stall on slow networks.
 *
 * This wrapper stores per-key payloads in IndexedDB with a TTL. The recipe:
 *
 *     const cache = LOCAL_CACHE.scope('emailMessages', 5 * 60_000);
 *     const cached = await cache.get();           // null if missing/expired
 *     if (cached) renderImmediately(cached);
 *     const fresh = await api.load('email_archive/messages.json');
 *     cache.put(fresh);                           // fire and forget
 *     if (!cached || changed(fresh, cached)) re-render with fresh
 *
 * The cache is per-user (key prefixed with the signed-in uid) so signing out
 * and back in as a different account doesn't leak data between scopes. On
 * sign-out, LOCAL_CACHE.clearAll() wipes everything.
 *
 * Failure modes:
 *   - IndexedDB unavailable (Safari private mode, etc.): every method becomes
 *     a no-op so callers fall through to the network without errors.
 *   - Quota exceeded: put() catches and logs.
 */
(function () {
  if (typeof window === 'undefined') return;
  const DB_NAME = 'rm-cache';
  const DB_VERSION = 1;
  const STORE = 'kv';
  let _dbPromise = null;

  function _openDb() {
    if (_dbPromise) return _dbPromise;
    if (typeof indexedDB === 'undefined') {
      _dbPromise = Promise.resolve(null);
      return _dbPromise;
    }
    _dbPromise = new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (err) { console.warn('[local-cache] open threw:', err.message); resolve(null); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { console.warn('[local-cache] open error:', req.error); resolve(null); };
      req.onblocked = () => { console.warn('[local-cache] open blocked'); resolve(null); };
    });
    return _dbPromise;
  }

  function _uid() {
    try {
      return (typeof firebridge !== 'undefined' && firebridge.getUser
        && firebridge.getUser() && firebridge.getUser().uid) || 'anon';
    } catch { return 'anon'; }
  }

  async function _get(key) {
    const db = await _openDb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readonly');
        const r = tx.objectStore(STORE).get(key);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      } catch (err) { console.warn('[local-cache] get failed:', err.message); resolve(null); }
    });
  }

  async function _put(key, value) {
    const db = await _openDb();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const r = tx.objectStore(STORE).put(value, key);
        r.onsuccess = () => resolve();
        r.onerror = () => { console.warn('[local-cache] put error:', r.error); resolve(); };
      } catch (err) { console.warn('[local-cache] put failed:', err.message); resolve(); }
    });
  }

  async function _del(key) {
    const db = await _openDb();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const r = tx.objectStore(STORE).delete(key);
        r.onsuccess = () => resolve();
        r.onerror = () => resolve();
      } catch { resolve(); }
    });
  }

  async function _clearAll() {
    const db = await _openDb();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const r = tx.objectStore(STORE).clear();
        r.onsuccess = () => resolve();
        r.onerror = () => resolve();
      } catch { resolve(); }
    });
  }

  /**
   * Build a scoped accessor for one cache namespace.
   *
   * @param {string} name   per-page namespace (e.g. 'emailMessages')
   * @param {number} ttlMs  freshness window — older entries are returned but
   *                        flagged as stale via the wrapper
   */
  function scope(name, ttlMs) {
    function key() { return _uid() + '::' + name; }
    return {
      // Returns { data, age, stale } or null when missing.
      async get() {
        const entry = await _get(key());
        if (!entry || !entry.data) return null;
        const age = Date.now() - (entry.savedAt || 0);
        return { data: entry.data, age, stale: age > (ttlMs || Infinity) };
      },
      async put(data) {
        try { await _put(key(), { data, savedAt: Date.now() }); }
        catch (err) { console.warn('[local-cache] put quota?', err.message); }
      },
      async clear() { await _del(key()); },
    };
  }

  window.LOCAL_CACHE = {
    scope,
    clearAll: _clearAll,
    deleteKey: async function (fullKey) { await _del(fullKey); },
  };

  // One-time cleanup of the legacy bulk emailMessages key — superseded by
  // per-year keys (emailMessages-2024, -2025, etc.). Wastes ~3MB if left.
  // Removed via a single delete; safe to leave running on every page load
  // (the key won't exist after the first cleanup).
  setTimeout(async () => {
    try {
      const me = (typeof firebridge !== 'undefined' && firebridge.getUser
        && firebridge.getUser());
      if (!me) return;
      await _del(me.uid + '::emailMessages');
    } catch {}
  }, 1500);

  // Wipe cache on sign-out (different user might sign in next).
  if (typeof firebridge !== 'undefined' && firebridge.onAuth) {
    let lastUid = null;
    firebridge.onAuth(() => {
      const me = firebridge.getUser && firebridge.getUser();
      const uid = me ? me.uid : null;
      if (lastUid && lastUid !== uid) {
        // Different user (or sign-out) — clear cache so we don't serve the
        // previous account's data on the next sign-in.
        _clearAll();
      }
      lastUid = uid;
    });
  }
})();
