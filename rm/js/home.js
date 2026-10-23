/* home.js — V3.809 RM Home glue.
 *
 * The home page is one scrolling page: My Lab Today feed (home-feed.js)
 * → Jump back in (this file) → Workflows (workflow-chooser.js) → All
 * pages (all-pages.js). This file:
 *   - renders "Jump back in": the user's pinned pages, then recent pages
 *     by frecency — the same NavPins / NavRecents stores the bar's chips
 *     read (nav.js), so what's here IS what's in the bar
 *   - wires the header's "Find a page…" button to the Go to… palette
 *   - honours the old URLs: ?view=all-pages (and #all-pages) scroll to the
 *     All pages section and focus its filter; #workflows scrolls to the
 *     Workflows section. (#new-workflow is handled by workflow-chooser.js.)
 *
 * Depends on nav.js globals: _wfBuildPageMap, NavPins, NavRecents,
 * _splitPageAllowed, _navOpenPalette, NAV_PAGE_DESCRIPTIONS. */
(function () {
  'use strict';

  var MAX_TILES = 10;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function ago(ms) {
    if (!ms) return '';
    var d = Date.now() - ms;
    if (d < 3600000) return 'opened ' + Math.max(1, Math.round(d / 60000)) + ' min ago';
    if (d < 86400000) return 'opened ' + Math.round(d / 3600000) + ' h ago';
    var days = Math.round(d / 86400000);
    return days === 1 ? 'opened yesterday' : 'opened ' + days + ' days ago';
  }

  var _grantReady = false;

  function allowed(p) {
    if (typeof firebridge === 'undefined') return !p.gate;
    if (!_grantReady) return !p.gate || p.gate === 'lab-member';   // optimistic until the grant loads
    var isAdmin = firebridge.isAdmin && firebridge.isAdmin();
    var isLabMember = firebridge.isLabMember && firebridge.isLabMember();
    return (typeof _splitPageAllowed === 'function') ? _splitPageAllowed(p, isAdmin, isLabMember) : true;
  }

  function renderJump() {
    var grid = document.getElementById('home-jump-grid');
    if (!grid || typeof _wfBuildPageMap !== 'function' || !window.NavPins || !window.NavRecents) return;
    var pageMap = _wfBuildPageMap();
    var skip = function (id) { return !pageMap.has(id) || id === 'dashboard' || id === 'split-view'; };
    var tiles = [];
    var seen = {};
    NavPins.effective().forEach(function (id) {
      if (skip(id) || seen[id]) return;
      var p = pageMap.get(id);
      if (!allowed(p)) return;
      seen[id] = true;
      tiles.push({ p: p, meta: 'pinned', pinned: true });
    });
    NavRecents.list().forEach(function (r) {
      if (tiles.length >= MAX_TILES) return;
      if (skip(r.id) || seen[r.id]) return;
      var p = pageMap.get(r.id);
      if (!allowed(p)) return;
      seen[r.id] = true;
      tiles.push({ p: p, meta: ago(r.last), pinned: false });
    });
    if (!tiles.length) {
      grid.innerHTML = '<div class="home-jump-empty">Pages you pin (★) or open often will collect here — and in the bar at the top of every page.</div>';
      return;
    }
    grid.innerHTML = tiles.slice(0, MAX_TILES).map(function (t) {
      var desc = (typeof NAV_PAGE_DESCRIPTIONS !== 'undefined' && NAV_PAGE_DESCRIPTIONS[t.p.id]) || '';
      return '<a class="home-jump' + (t.pinned ? ' home-jump--pinned' : '') + '" href="' + esc(t.p.href) + '" title="' + esc(desc) + '">' +
        '<span class="home-jump-icon">' + ICON.svg(t.p.icon || 'document-text') + '</span>' +
        '<span class="home-jump-main">' +
        '  <span class="home-jump-label">' + esc(t.p.label) + '</span>' +
        '  <span class="home-jump-meta">' + esc(t.meta) + '</span>' +
        '</span></a>';
    }).join('');
  }

  function scrollTo(id, focusId) {
    var el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
    if (focusId) {
      var f = document.getElementById(focusId);
      if (f) setTimeout(function () { try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); } }, 60);
    }
  }

  function boot() {
    var btn = document.getElementById('home-search-btn');
    if (btn) {
      btn.addEventListener('click', function () {
        if (typeof _navOpenPalette === 'function') _navOpenPalette({ mode: 'go' });
        else scrollTo('home-all-pages', 'home-pages-filter');
      });
      var kbd = btn.querySelector('kbd');
      if (kbd) kbd.textContent = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘K' : 'Ctrl K';
    }

    renderJump();
    window.addEventListener('rm:nav:pins-change', renderJump);

    if (typeof firebridge !== 'undefined') {
      var refine = function () { _grantReady = true; renderJump(); };
      firebridge.whenAuthResolved().then(function () {
        if (firebridge.loadAccessGrant) return firebridge.loadAccessGrant().then(refine, refine);
        refine();
      }, refine);
    }

    var view = new URLSearchParams(location.search).get('view');
    if (view === 'all-pages' || location.hash === '#all-pages') scrollTo('home-all-pages', 'home-pages-filter');
    else if (location.hash === '#workflows' || location.hash === '#new-workflow') scrollTo('home-workflows');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
