/* ================================================================
   split-view.js — RM Split View shell
   ================================================================
   Two RM pages side-by-side via iframes. Adapted from the
   _splitAppId / _splitRatio harness in /lab-apps.js (preserved in
   the repo through the V3.53 cleanup specifically as reference for
   this work).

   URL state is the single source of truth:
     /rm/pages/split-view.html?left=<url>&right=<url>&ratio=<0..1>

   Defaults (when query params are absent):
     left  = /rm/index.html
     right = /rm/index.html (so the user picks something via the
             dropdown rather than seeing the same page twice — the
             shell biases the right pane to a different page when
             possible).
     ratio = 0.5

   Each pane has a small header bar with:
     - The page label (read from rm/js/nav.js's NAV_ITEMS registry)
     - A dropdown to swap to a different page
     - A "Close" (×) button that collapses to the other pane's URL
       (i.e. exits split view, reloading the survivor as a normal
       single-page navigation)

   Iframes share Firebase IndexedDB persistence with the parent (same
   origin), so auth resolves automatically in each pane — no
   postMessage handshake needed. Each iframe loads its own copy of
   firebase-bridge / api-firestore-adapter / nav etc., which is some
   wasted bandwidth (~500KB per iframe) but works without changes
   to any RM page renderer.
   ================================================================ */

(function () {
  'use strict';

  const root = document.getElementById('split-root');
  if (!root) {
    console.warn('[split-view] #split-root container missing');
    return;
  }

  /* ─── Page registry ──────────────────────────────────────
   * Read NAV_ITEMS from rm/js/nav.js (same IIFE-less script-tag
   * scope, loaded before this file). Flatten children into a single
   * list; skip group-only entries (no href). Skip the Dashboard
   * top-level entry's duplicate href once it appears as a child.
   * ──────────────────────────────────────────────────────── */
  function flattenNav() {
    const out = [];
    const seen = new Set();
    function add(label, href, gate) {
      if (!href || seen.has(href)) return;
      // Skip the Split View page itself — having it inside another
      // split would be confusing (and break URL state nesting).
      if (href.indexOf('/rm/pages/split-view.html') === 0) return;
      seen.add(href);
      out.push({ label, href, gate });
    }
    if (typeof NAV_ITEMS === 'undefined') return [];
    NAV_ITEMS.forEach(item => {
      if (item.href) add(item.label, item.href, item.gate);
      (item.children || []).forEach(child => add(child.label, child.href, child.gate || item.gate));
    });
    return out;
  }

  /* ─── URL state ──────────────────────────────────────────
   * Single source of truth: parse from window.location.search;
   * write back via history.replaceState so reload survives state
   * changes without filling browser history.
   * ──────────────────────────────────────────────────────── */
  const PAGES = flattenNav();
  const FALLBACK_HREF = '/rm/index.html';

  function readState() {
    const p = new URLSearchParams(window.location.search);
    let left = p.get('left') || FALLBACK_HREF;
    let right = p.get('right') || FALLBACK_HREF;
    let ratio = parseFloat(p.get('ratio'));
    if (!(ratio >= 0.15 && ratio <= 0.85)) ratio = 0.5;
    // Sanitize: only same-origin /rm/pages/ or /rm/index.html targets.
    if (!_isAllowedHref(left)) left = FALLBACK_HREF;
    if (!_isAllowedHref(right)) right = FALLBACK_HREF;
    return { left, right, ratio };
  }

  function writeState(state) {
    const p = new URLSearchParams({
      left: state.left,
      right: state.right,
      ratio: state.ratio.toFixed(2),
    });
    history.replaceState(null, '', '/rm/pages/split-view.html?' + p.toString());
  }

  function _isAllowedHref(href) {
    if (typeof href !== 'string') return false;
    if (!href.startsWith('/rm/')) return false;
    if (href.indexOf('..') !== -1) return false;
    return true;
  }

  /* ─── Render ─────────────────────────────────────────────── */
  let state = readState();
  let dragging = false;

  render();
  writeState(state);

  function render() {
    root.innerHTML =
      '<div class="split-shell">' +
        paneHTML('left', state.left, state.ratio) +
        '<div class="split-divider" id="split-divider" title="Drag to resize">' +
          '<div class="split-divider-grip"></div>' +
        '</div>' +
        paneHTML('right', state.right, 1 - state.ratio) +
      '</div>';

    wireHeaders('left');
    wireHeaders('right');
    wireDivider();
    applyRatio();
  }

  function paneHTML(side, href, ratio) {
    const label = (PAGES.find(p => p.href === href) || {}).label || _labelFromHref(href);
    const opts = PAGES.map(p =>
      '<option value="' + _esc(p.href) + '"' +
      (p.href === href ? ' selected' : '') + '>' +
      _esc(p.label) + '</option>'
    ).join('');
    return (
      '<div class="split-pane split-pane--' + side + '" data-side="' + side + '" style="flex-basis:' + (ratio * 100).toFixed(2) + '%;">' +
        '<div class="split-pane-header">' +
          '<select class="split-pane-select" data-side="' + side + '">' +
            opts +
          '</select>' +
          '<span class="split-pane-label">' + _esc(label) + '</span>' +
          '<div class="split-pane-actions">' +
            '<button class="split-pane-btn" data-act="reload" data-side="' + side + '" title="Reload pane">↻</button>' +
            '<button class="split-pane-btn" data-act="open-full" data-side="' + side + '" title="Open in full window">⤢</button>' +
            '<button class="split-pane-btn split-pane-btn--close" data-act="close" data-side="' + side + '" title="Close pane (exit split view)">×</button>' +
          '</div>' +
        '</div>' +
        '<iframe class="split-pane-frame" data-side="' + side + '" src="' + _esc(href) + '" title="' + _esc(label) + '"></iframe>' +
      '</div>'
    );
  }

  function wireHeaders(side) {
    const sel = root.querySelector('.split-pane-select[data-side="' + side + '"]');
    if (sel) sel.addEventListener('change', () => {
      const newHref = sel.value;
      if (!_isAllowedHref(newHref)) return;
      state[side] = newHref;
      writeState(state);
      // Swap just this pane's iframe src instead of full re-render so the
      // OTHER pane doesn't reload (preserves its scroll, its in-progress
      // edits, etc).
      const frame = root.querySelector('.split-pane-frame[data-side="' + side + '"]');
      if (frame) frame.src = newHref;
      const labelEl = root.querySelector('.split-pane[data-side="' + side + '"] .split-pane-label');
      if (labelEl) labelEl.textContent = (PAGES.find(p => p.href === newHref) || {}).label || _labelFromHref(newHref);
    });

    root.querySelectorAll('.split-pane-btn[data-side="' + side + '"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'reload') {
          const frame = root.querySelector('.split-pane-frame[data-side="' + side + '"]');
          if (frame) frame.src = frame.src; // assignment triggers reload
        } else if (act === 'open-full') {
          window.location.href = state[side];
        } else if (act === 'close') {
          // Exit split view; survivor pane becomes the next page.
          const survivor = side === 'left' ? state.right : state.left;
          window.location.href = survivor;
        }
      });
    });
  }

  /* ─── Divider drag ───────────────────────────────────────── */
  function wireDivider() {
    const divider = document.getElementById('split-divider');
    if (!divider) return;
    divider.addEventListener('pointerdown', (e) => {
      dragging = true;
      divider.setPointerCapture(e.pointerId);
      document.body.classList.add('split-dragging');
    });
    divider.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      // Compute new ratio from pointer X within the shell rect.
      const shell = root.querySelector('.split-shell');
      if (!shell) return;
      const rect = shell.getBoundingClientRect();
      const newRatio = (e.clientX - rect.left) / rect.width;
      const clamped = Math.max(0.15, Math.min(0.85, newRatio));
      state.ratio = clamped;
      applyRatio();
    });
    divider.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      try { divider.releasePointerCapture(e.pointerId); } catch (err) {}
      document.body.classList.remove('split-dragging');
      writeState(state); // persist final ratio
    });
    divider.addEventListener('pointercancel', () => {
      dragging = false;
      document.body.classList.remove('split-dragging');
    });
  }

  function applyRatio() {
    const left = root.querySelector('.split-pane--left');
    const right = root.querySelector('.split-pane--right');
    if (left)  left.style.flexBasis  = (state.ratio * 100).toFixed(2) + '%';
    if (right) right.style.flexBasis = ((1 - state.ratio) * 100).toFixed(2) + '%';
  }

  /* ─── Tiny helpers ───────────────────────────────────────── */
  function _esc(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function _labelFromHref(href) {
    if (!href) return 'Page';
    const m = href.match(/\/rm\/pages\/([^.?]+)\.html/);
    if (m) return m[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    if (href === '/rm/index.html') return 'Dashboard';
    return href;
  }
})();
