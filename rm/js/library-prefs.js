/* library-prefs.js — per-user library view preferences.
 *
 * Lives on Firestore at userSettings/{uid}.library so the same prefs follow
 * a lab member across devices. Same collection that calendar / schedule /
 * notification prefs already use; the rule on userSettings/{userId} grants
 * owner read/write + admin read.
 *
 * Public API (window.LIBRARY_PREFS):
 *   load()              → Promise<prefs>     (returns DEFAULTS if no doc)
 *   save(prefs)         → Promise<void>      (debounced; merges)
 *   get()               → prefs              (synchronous cached value)
 *   subscribe(cb)       → unsubscribe        (notified on save)
 *   DEFAULTS            → object             (reference for resetting)
 *
 * The prefs object intentionally has stable, named widget keys so the
 * library page can do `if (prefs.widgets_enabled.stars) renderStars()`
 * without dynamic dispatch.
 */

(function () {
  const DEFAULTS = Object.freeze({
    visibility: { mode: 'all', uids: [] },          // 'all' | 'mine' | 'selected'
    default_sort: 'year-desc',                      // 'year-desc' | 'title' | 'date_added' | 'starred'
    // Only widgets that have a real UI affordance live here. Adding a key
    // means committing to a UI gate in js/library.js too — orphan keys
    // would just be a confusing checkbox. More widgets land as their UIs
    // are built (year-range filter, has-pdf filter, etc).
    widgets_enabled: {
      search: true,    // hides #library-search via body.lib-hide-search
      stars: true,     // hides .lib-col-star via body.lib-hide-stars
      tags: true,      // hides #library-tag-strip via _renderTagStrip
    },
    pinned_tags: [],                                // colon-paths shown as fixed chips
    comments_feed: {
      default_authors: [],
      default_tags: [],
      default_stance: 'all',                        // 'all' | 'for' | 'against' | 'plain'
    },
  });

  let _cached = _clone(DEFAULTS);
  let _saveTimer = null;
  const _subs = [];

  function _clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Deep-merge user-stored partial prefs onto DEFAULTS so the in-memory
  // object always has every expected key — important so that adding a
  // new widget key in DEFAULTS doesn't break old prefs docs.
  function _hydrate(stored) {
    const out = _clone(DEFAULTS);
    if (!stored || typeof stored !== 'object') return out;
    for (const k of Object.keys(DEFAULTS)) {
      const v = stored[k];
      if (v === undefined || v === null) continue;
      if (Array.isArray(DEFAULTS[k])) {
        out[k] = Array.isArray(v) ? v.slice() : DEFAULTS[k].slice();
      } else if (typeof DEFAULTS[k] === 'object') {
        // Object-valued: shallow-merge keys from stored over defaults.
        out[k] = Object.assign(_clone(DEFAULTS[k]), typeof v === 'object' ? v : {});
        // Specifically for widgets_enabled, force boolean-ish values.
        if (k === 'widgets_enabled') {
          for (const wk of Object.keys(out.widgets_enabled)) {
            out.widgets_enabled[wk] = !!out.widgets_enabled[wk];
          }
        }
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function _userSettingsDocRef() {
    if (typeof firebase === 'undefined' || !firebase.firestore || !firebase.auth) return null;
    const user = firebase.auth().currentUser;
    if (!user) return null;
    return firebase.firestore().collection('userSettings').doc(user.uid);
  }

  async function load() {
    const ref = _userSettingsDocRef();
    if (!ref) {
      _cached = _clone(DEFAULTS);
      _notify();
      return _cached;
    }
    try {
      const snap = await ref.get();
      const data = snap.exists ? (snap.data() || {}) : {};
      _cached = _hydrate(data.library);
    } catch (e) {
      console.warn('[library-prefs] load failed:', e.message);
      _cached = _clone(DEFAULTS);
    }
    _notify();
    return _cached;
  }

  function get() { return _cached; }

  // Save is debounced — toggling several widget checkboxes in a row coalesces
  // into one Firestore write. Pass through synchronously updates the cache so
  // the UI reads fresh values immediately.
  function save(prefs) {
    if (prefs && typeof prefs === 'object') {
      _cached = _hydrate(prefs);
      _notify();
    }
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(_flushSave, 500);
  }

  async function _flushSave() {
    _saveTimer = null;
    const ref = _userSettingsDocRef();
    if (!ref) return;
    try {
      await ref.set({
        library: Object.assign({}, _cached, {
          updated_at: firebase.firestore.FieldValue.serverTimestamp(),
        }),
      }, { merge: true });
    } catch (e) {
      console.warn('[library-prefs] save failed:', e.message);
    }
  }

  function subscribe(cb) {
    if (typeof cb !== 'function') return () => {};
    _subs.push(cb);
    try { cb(_cached); } catch (_) {}
    return () => {
      const i = _subs.indexOf(cb);
      if (i >= 0) _subs.splice(i, 1);
    };
  }

  function _notify() {
    for (const cb of _subs.slice()) {
      try { cb(_cached); } catch (e) { console.error(e); }
    }
  }

  // Test hook — replace the cached value without persisting (useful for
  // smoke tests where we don't have Firestore but want to inspect _hydrate).
  function _setCacheForTesting(prefs) {
    _cached = _hydrate(prefs);
    _notify();
  }

  window.LIBRARY_PREFS = {
    DEFAULTS,
    load,
    save,
    get,
    subscribe,
    _internals: { _hydrate, _setCacheForTesting },
  };
})();
