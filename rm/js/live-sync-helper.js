/* live-sync-helper.js — shared Firestore live-sync wiring for RM pages.
 *
 * Most RM pages follow the same shape: load JSON paths via api.load, write
 * back via api.save, render with one function (loadAndRender). To make tab-
 * to-tab live sync work, each page needs:
 *   1. api.save wrapped with savePending + suppressUntil gates
 *   2. api.subscribe on each mutating path
 *   3. Debounced + scroll-preserving re-render on remote update
 *   4. First-fire suppression so the boot-time initial sync doesn't blink
 *
 * This module exposes ONE function that does all four. Reference impls that
 * inline the same logic (for pages with custom render strategies) are in
 * tasks-buckets.js, email-review.js, calendar.js — the helper just packages
 * those identically for the simpler "loadAndRender once on remote change"
 * pattern.
 *
 * Usage:
 *   document.addEventListener('DOMContentLoaded', async () => {
 *     await loadAndRender();
 *     LIVE_SYNC.attach({
 *       paths: ['people/roster.json', 'people/alumni.json'],
 *       refresh: loadAndRender,
 *       tag: 'people',
 *     });
 *   });
 *
 * Memory: see feedback_live_sync_recipe.md and feedback_live_sync_pending_save.md.
 */

// Phase I — process-wide registry of paths already attached by any prior
// LIVE_SYNC.attach() call. Guards against the SPA-style nav case where a
// page calls attach() twice with overlapping paths and ends up double-
// subscribing (each path then fires two refresh() calls per snapshot).
// The api-firestore-adapter's beforeunload detachAll() clears tracked
// listeners on real page unload, so this set lives only for the lifetime
// of the JS execution context — fresh page nav resets it.
var _LIVE_SYNC_ATTACHED_PATHS = new Set();

window.LIVE_SYNC = {
  /**
   * @param {object} opts
   * @param {string[]} opts.paths         JSON paths to wrap+subscribe
   * @param {() => Promise} opts.refresh  page's reload function (typically loadAndRender)
   * @param {string} [opts.tag]           short page name for log warnings
   * @param {number} [opts.debounceMs=200] re-render debounce after a remote update
   * @param {number} [opts.suppressMs=2500] window after each save during which
   *                                          incoming snapshots are treated as our own echo
   * @param {(path:string, data:any) => void} [opts.onApply] optional hook to
   *                                          mutate page state from the snapshot
   *                                          BEFORE refresh fires
   * @returns {object} live state (handle for tests / unattach later if needed)
   */
  attach: function (opts) {
    if (!opts || !Array.isArray(opts.paths) || typeof opts.refresh !== 'function') {
      console.warn('[live-sync] attach() needs { paths, refresh }');
      return null;
    }
    var live = {
      suppressUntil: 0,
      savePending: false,
      refreshTimer: null,
      unsubs: [],
    };
    var pathSet = new Set(opts.paths);
    var tag = opts.tag || 'live-sync';
    var debounceMs = opts.debounceMs || 200;
    var suppressMs = opts.suppressMs || 2500;

    // Phase I: filter out paths already attached by a prior call this page-
    // load. Double-attach would result in each path firing refresh() twice
    // per snapshot (one per wrap layer). Explicit detach via the returned
    // handle's `live.unsubs.forEach(u => u())` removes from the registry —
    // see the registry-tracked unsub at line below.
    var newPaths = [];
    var skipped = [];
    opts.paths.forEach(function (p) {
      if (_LIVE_SYNC_ATTACHED_PATHS.has(p)) skipped.push(p);
      else { _LIVE_SYNC_ATTACHED_PATHS.add(p); newPaths.push(p); }
    });
    if (skipped.length) {
      console.warn('[' + tag + '] LIVE_SYNC.attach: skipping already-attached paths:', skipped);
    }
    if (!newPaths.length) {
      // Every requested path was already attached — nothing to do.
      return live;
    }
    // Replace pathSet so the api.save wrap below only matches paths we're
    // actually subscribing to here.
    pathSet = new Set(newPaths);

    // Wrap api.save once. Subsequent attach() calls chain (each wrap checks its
    // own pathSet; saves to a path go through every wrap that matches).
    if (typeof api !== 'undefined' && typeof api.save === 'function') {
      var origSave = api.save.bind(api);
      api.save = async function (path, data) {
        var isOurs = pathSet.has(path);
        if (isOurs) {
          live.savePending = true;
          live.suppressUntil = Date.now() + suppressMs;
        }
        try {
          return await origSave(path, data);
        } finally {
          if (isOurs) live.savePending = false;
        }
      };
    }

    function scheduleRefresh() {
      if (live.refreshTimer) return;
      live.refreshTimer = setTimeout(function () {
        live.refreshTimer = null;
        var scrollY = window.scrollY;
        var active = document.activeElement;
        var activeId = active && active.id;
        var activeSel = (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'))
          ? { start: active.selectionStart, end: active.selectionEnd }
          : null;
        Promise.resolve(opts.refresh())
          .catch(function (err) { console.warn('[' + tag + '] refresh failed:', err); })
          .finally(function () {
            window.scrollTo({ top: scrollY, left: 0, behavior: 'instant' });
            if (activeId) {
              var el = document.getElementById(activeId);
              if (el) {
                try { el.focus(); } catch (e) {}
                if (activeSel && el.setSelectionRange) {
                  try { el.setSelectionRange(activeSel.start, activeSel.end); } catch (e) {}
                }
              }
            }
          });
      }, debounceMs);
    }

    if (typeof api === 'undefined' || typeof api.subscribe !== 'function') {
      console.warn('[' + tag + '] api.subscribe unavailable — live sync inactive');
      // Roll back the registry entries we added above, since we never
      // actually subscribed.
      newPaths.forEach(function (p) { _LIVE_SYNC_ATTACHED_PATHS.delete(p); });
      return live;
    }
    newPaths.forEach(function (path) {
      try {
        var firstFireConsumed = false;
        var rawUnsub = api.subscribe(path, function (data) {
          if (Date.now() < live.suppressUntil) return;
          if (live.savePending) return;
          if (opts.onApply) {
            try { opts.onApply(path, data); }
            catch (e) { console.warn('[' + tag + '] onApply failed for', path, e.message); }
          }
          if (!firstFireConsumed) { firstFireConsumed = true; return; }
          scheduleRefresh();
        });
        // Wrap the unsub so calling it also frees the path from the
        // process-wide registry — that way a future attach() with the
        // same path can succeed instead of being skipped.
        var trackedUnsub = function () {
          _LIVE_SYNC_ATTACHED_PATHS.delete(path);
          try { rawUnsub(); } catch (_) {}
        };
        live.unsubs.push(trackedUnsub);
      } catch (err) {
        // Subscribe failed — release the registry entry so a future retry
        // can re-attempt.
        _LIVE_SYNC_ATTACHED_PATHS.delete(path);
        console.warn('[' + tag + '] subscribe failed for', path, err.message);
      }
    });

    return live;
  },
};
