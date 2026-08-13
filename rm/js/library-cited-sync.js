/* library-cited-sync.js — V3.366
 *
 * Keeps items/{id}.meta.library.cited_in_drafts (a field that existed in
 * the schema since buildPaperItem but had ZERO writers) in sync with what
 * the open draft actually cites. The association pills (LIBRARY_ASSOC,
 * V3.365) use it for the "linked but not yet cited" dot on the reader
 * and library pages — surfaces that can't scan the draft's Yjs doc.
 *
 * How it works (diff loop, not a log):
 *   desired = getCitedKeysInPaper()          — live [@key] scan of Yjs
 *             → mapped through the citation index to library item ids
 *   current = each index entry's citedInDrafts (projection, V3.366)
 *   diff    → LIBRARY_LINKS.setCitedInDraft(itemId, paperId, add/remove)
 *             — idempotent atomic arrayUnion/arrayRemove per item; ONLY
 *             this draft's membership is ever touched.
 *
 * Triggers: debounced 30 s after a LOCAL Yjs update (paper-editor.js
 * registers the yDoc listener); one backfill pass ~15 s after connect so
 * pre-V3.366 drafts populate without an edit; best-effort runNow() on
 * pagehide. Steady state = zero ops (reopening a synced draft writes
 * nothing). Read-only viewers never write. No migration: old drafts
 * backfill organically the next time they're opened.
 *
 * Multi-editor convergence: two editors compute the same desired set
 * from the same converged Yjs doc, and the ops are idempotent, so
 * duplicates are no-ops. Before applying REMOVALS we re-scan the doc —
 * shrinking the race window where an in-flight edit re-cites a key —
 * and any transient wrong state self-heals on the next debounced run.
 *
 * Public API (window.CITED_SYNC):
 *   init({editable})  — call once after the editor connects
 *   schedule()        — debounced sync (local Yjs update handler)
 *   runNow()          — immediate best-effort pass (pagehide)
 */
(function () {
  'use strict';

  var DEBOUNCE_MS = 30 * 1000;
  var BACKFILL_DELAY_MS = 15 * 1000;
  var INDEX_MAX_AGE_MS = 10 * 60 * 1000;
  var MAX_OPS_PER_RUN = 50;

  var _editable = false;
  var _inited = false;
  var _timer = null;
  var _running = false;

  function _pe() { return window.PaperEditor || null; }

  function init(opts) {
    if (_inited) return;
    _inited = true;
    _editable = !!(opts && opts.editable);
    if (!_editable) return;
    // Backfill pass — populates cited_in_drafts for drafts written
    // before V3.366 without requiring an edit.
    setTimeout(function () { schedule(1000); }, BACKFILL_DELAY_MS);
  }

  function schedule(delayMs) {
    if (!_inited || !_editable) return;
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(function () {
      _timer = null;
      _run().catch(function (e) {
        console.warn('[cited-sync] run failed:', e.message || e);
      });
    }, typeof delayMs === 'number' ? delayMs : DEBOUNCE_MS);
  }

  function runNow() {
    if (!_inited || !_editable || _running) return;
    if (_timer) { clearTimeout(_timer); _timer = null; }
    _run().catch(function () { /* best effort on pagehide */ });
  }

  // Desired cited-item-id set from the live doc. Returns null when the
  // scan can't be trusted (index never loaded) — callers must then
  // write NOTHING rather than treat it as "cites nothing".
  function _desiredItemIds() {
    var pe = _pe();
    if (!pe || !pe.getCitationByKey || !pe.getCitedKeysInPaper) return null;
    var byKey = pe.getCitationByKey();
    if (!byKey) return null;
    var ids = new Set();
    pe.getCitedKeysInPaper().forEach(function (key) {
      var entry = byKey[key];
      if (entry && entry.itemId) ids.add(entry.itemId);
      // Unknown keys (not in the library yet) are ignored — nothing to
      // stamp until the paper is added via the References tab.
    });
    return ids;
  }

  async function _run() {
    if (_running || !_editable) return;
    var pe = _pe();
    if (!pe || !window.LIBRARY_LINKS || !window.LIBRARY_LINKS.setCitedInDraft) return;
    var paperId = pe.getPaperId && pe.getPaperId();
    if (!paperId) return;
    _running = true;
    try {
      // Bounded-staleness index; abort the whole run on fetch failure
      // (never diff against unknown state).
      try {
        await pe.ensureFreshCitationIndex(INDEX_MAX_AGE_MS);
      } catch (e) {
        console.warn('[cited-sync] index refresh failed, skipping run:', e.message || e);
        return;
      }
      var list = pe.getCitationList && pe.getCitationList();
      if (!list || !list.length) return;
      var desired = _desiredItemIds();
      if (!desired) return;

      var adds = [];
      var removes = [];
      list.forEach(function (entry) {
        if (!entry.itemId) return;
        var has = Array.isArray(entry.citedInDrafts) && entry.citedInDrafts.indexOf(paperId) >= 0;
        var want = desired.has(entry.itemId);
        if (want && !has) adds.push(entry);
        else if (!want && has) removes.push(entry);
      });
      if (!adds.length && !removes.length) return;

      // Removal race guard: re-scan immediately before applying, and drop
      // any removal whose key came back in the meantime.
      if (removes.length) {
        var recheck = _desiredItemIds();
        if (!recheck) return;
        removes = removes.filter(function (entry) { return !recheck.has(entry.itemId); });
      }

      var ops = adds.map(function (e) { return { entry: e, cited: true }; })
        .concat(removes.map(function (e) { return { entry: e, cited: false }; }));
      var capped = ops.slice(0, MAX_OPS_PER_RUN);
      var failed = 0;
      for (const op of capped) {
        try {
          await window.LIBRARY_LINKS.setCitedInDraft(op.entry.itemId, paperId, op.cited);
          // Patch the cached projection in place so the next diff sees
          // the post-write state without a refetch.
          var arr = Array.isArray(op.entry.citedInDrafts) ? op.entry.citedInDrafts : (op.entry.citedInDrafts = []);
          var idx = arr.indexOf(paperId);
          if (op.cited && idx < 0) arr.push(paperId);
          if (!op.cited && idx >= 0) arr.splice(idx, 1);
        } catch (e) {
          failed++;
          console.warn('[cited-sync] op failed for', op.entry.itemId, ':', e.message || e);
        }
      }
      if (ops.length > capped.length || failed) {
        // Overflow / failures: idempotent ops, so just re-arm.
        schedule();
      } else if (capped.length) {
        console.info('[cited-sync] stamped ' + capped.length + ' item(s) for draft ' + paperId);
      }
    } finally {
      _running = false;
    }
  }

  window.CITED_SYNC = {
    init: init,
    schedule: schedule,
    runNow: runNow,
  };
})();
