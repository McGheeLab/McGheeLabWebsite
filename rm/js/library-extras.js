/* library-extras.js — heavy library-paper fields stored in a per-item subdoc.
 *
 * V3.206 motivation: the library list page reads every items.json row to
 * render a table that needs ~8 fields. Inline `meta.library.abstract`,
 * `references`, `tldr`, and `cited_by` can each be tens of KB per paper —
 * fine to fetch one at a time when a paper opens, but multiplying that
 * across the full library on every list load is the dominant cost.
 *
 * Solution: split heavy fields into `items/{itemId}/details/main`. The
 * main doc keeps the light identification / display fields; details
 * holds the bulk. Paper-reader-style call sites load extras on demand
 * via `LIBRARY_EXTRAS.load(itemId)`; new writes go through
 * `LIBRARY_EXTRAS.savePatch(itemId, patch)` which merges into the
 * subdoc (no full-collection rewrite).
 *
 * Backward compat: if the subdoc doesn't exist yet, `load` falls back to
 * the inline `meta.library.*` fields on the main item doc — so existing
 * data keeps working until a one-shot migration moves it. Writes still
 * go to the subdoc; callers should clear inline fields when migrating
 * (separate concern — `LIBRARY_EXTRAS.stripInline(item)` is provided as
 * a helper for that path but not used automatically here).
 *
 * Public API (window.LIBRARY_EXTRAS):
 *   load(itemId)            → Promise<{abstract, tldr, references, ...}>
 *   savePatch(itemId, patch)→ Promise<void>   (Firestore .set({...}, {merge:true}))
 *   delete(itemId)          → Promise<void>   (used when a paper is removed)
 *   stripInline(item)       → mutates item, removes heavy fields from
 *                             meta.library so the main doc stays light
 *
 * Schema (`items/{itemId}/details/main`):
 *   { abstract, tldr,
 *     references, references_source, references_parsed_at, references_parser_version,
 *     cited_by, cited_by_fetched_at,
 *     semantic_scholar_id, semantic_scholar_fetched_at,
 *     updated_at }
 */
(function () {
  // Fields that live in the subdoc. Any other meta.library.* field is
  // "light" and stays on the main item doc.
  const EXTRA_FIELDS = [
    'abstract',
    'tldr',
    'references',
    'references_source',
    'references_parsed_at',
    'references_parser_version',
    'cited_by',
    'cited_by_fetched_at',
    'semantic_scholar_id',
    'semantic_scholar_fetched_at',
  ];

  function _db() {
    if (typeof firebase === 'undefined' || !firebase.firestore) return null;
    try { return firebase.firestore(); } catch (_) { return null; }
  }

  function _ref(itemId) {
    const db = _db();
    if (!db) return null;
    return db.collection('items').doc(itemId).collection('details').doc('main');
  }

  // Returns the heavy fields. Order of resolution:
  //   1. items/{itemId}/details/main (new home)
  //   2. itemInline (passed in) → meta.library.* (back-compat fallback)
  // Pass `itemInline` so a single page that already has the items.json
  // row in memory can avoid an extra read when extras hasn't been
  // populated yet. Returns an object — never null — even on failure.
  async function load(itemId, itemInline) {
    if (!itemId) return {};
    const ref = _ref(itemId);
    if (ref) {
      try {
        const snap = await ref.get();
        if (snap.exists) return snap.data() || {};
      } catch (e) {
        console.warn('[library-extras] load failed for', itemId, ':', e.message || e);
        // Fall through to inline.
      }
    }
    // Back-compat: read from inline meta.library.* fields. Project to
    // the same shape callers expect from the subdoc.
    const lib = (itemInline && itemInline.meta && itemInline.meta.library) || {};
    const out = {};
    for (const k of EXTRA_FIELDS) {
      if (lib[k] != null) out[k] = lib[k];
    }
    return out;
  }

  // Merge-write a patch onto items/{itemId}/details/main. Only keys in
  // EXTRA_FIELDS are accepted; unknown keys are dropped so callers can't
  // accidentally accumulate unrelated data here. Always stamps
  // updated_at via server timestamp for the route cache's MAX-probe.
  async function savePatch(itemId, patch) {
    if (!itemId || !patch || typeof patch !== 'object') return;
    const ref = _ref(itemId);
    if (!ref) throw new Error('[library-extras] Firestore unavailable');
    const clean = {};
    for (const k of EXTRA_FIELDS) {
      if (patch[k] !== undefined) clean[k] = patch[k];
    }
    if (!Object.keys(clean).length) return;
    clean.updated_at = firebase.firestore.FieldValue.serverTimestamp();
    await ref.set(clean, { merge: true });
  }

  async function remove(itemId) {
    if (!itemId) return;
    const ref = _ref(itemId);
    if (!ref) return;
    try { await ref.delete(); } catch (_) { /* best-effort */ }
  }

  // Mutates the passed-in item: removes any EXTRA_FIELDS from
  // item.meta.library so the main items doc stays light. Call this
  // before persisting a main-doc write whose heavy fields have already
  // been mirrored to the subdoc via savePatch.
  function stripInline(item) {
    const lib = item && item.meta && item.meta.library;
    if (!lib) return;
    for (const k of EXTRA_FIELDS) {
      if (k in lib) delete lib[k];
    }
  }

  window.LIBRARY_EXTRAS = {
    EXTRA_FIELDS,
    load,
    savePatch,
    delete: remove,
    stripInline,
  };
})();
