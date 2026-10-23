/* ================================================================
   split-view.js — RM Split View shell (V3.75 redesign, V3.632 panes)
   ================================================================
   Two RM pages side-by-side via iframes. The ONE bar on the parent IS
   the navigation — panes never render chrome of their own. That bar is
   the workflow strip inside a workflow (pills for every workflow page;
   the two matching the open panes styled "open", the active pane's
   pill red-bordered) and, outside a workflow, the regular top nav
   carrying a page picker per pane (V3.632, both built by nav.js).

   URL state is the single source of truth:
     /rm/pages/split-view.html
       ?left=<url>&right=<url>&active=<left|right>&ratio=<0..1>
       [&workflow=<id>]   — adopted into sessionStorage by THIS file
                            (see _adoptWorkflowFromUrl — nav.js runs too
                            late to catch it)

   Events bridged from the parent bar's controls (strip pills or pane
   pickers — same events either way):
     - 'rm:split:swap'     { side, href }   — replace one pane's URL
     - 'rm:split:set-active' { side }       — flip which pane is active
     - 'rm:split:close'    { keep }         — exit split; navigate to
                                              keep ('left'|'right'|'active')

   Iframes share Firebase IndexedDB persistence with the parent (same
   origin), so auth resolves automatically in each pane. Iframes are
   loaded with `?embed=1` AND `name="rm-embed-<side>"` so their nav.js
   suppresses its own top nav (V3.73/V3.76) — the name is what keeps a
   pane suppressed after an in-pane link click drops the query param.
   ================================================================ */

(function () {
  'use strict';

  const root = document.getElementById('split-root');
  if (!root) {
    console.warn('[split-view] #split-root container missing');
    return;
  }

  const FALLBACK_HREF = '/rm/index.html';

  /* ─── URL state ────────────────────────────────────────── */
  function readState() {
    const p = new URLSearchParams(window.location.search);
    let left = p.get('left') || FALLBACK_HREF;
    let right = p.get('right') || FALLBACK_HREF;
    let ratio = parseFloat(p.get('ratio'));
    if (!(ratio >= 0.15 && ratio <= 0.85)) ratio = 0.5;
    let active = p.get('active') === 'right' ? 'right' : 'left';
    if (!_isAllowedHref(left)) left = FALLBACK_HREF;
    if (!_isAllowedHref(right)) right = FALLBACK_HREF;
    return { left, right, active, ratio };
  }

  function writeState(state) {
    // V3.76 — normalize URLs before persisting so the artifact `?embed=1`
    // never leaks into state.left / state.right. Without this, in-iframe
    // navigations that land on URLs with `embed=1` (rare but possible)
    // would carry the artifact into the parent's URL bar and into the
    // survivor URL when the user closes split.
    state.left  = _stripEmbed(state.left);
    state.right = _stripEmbed(state.right);
    const p = new URLSearchParams({
      left: state.left,
      right: state.right,
      active: state.active,
      ratio: state.ratio.toFixed(2),
    });
    history.replaceState(null, '', '/rm/pages/split-view.html?' + p.toString());
    // Expose state to nav.js's strip render (which reads the URL).
    window.__SPLIT_STATE = state;
    // Notify any listeners (nav.js's strip refresh hook).
    window.dispatchEvent(new CustomEvent('rm:split:state-change', { detail: state }));
  }

  /* V3.76 — strip the `?embed=1` artifact from a URL string. Used in
   * writeState (persistence boundary) and in the iframe-load sync
   * handler (read boundary) so state.left / state.right always reflect
   * the user-meaningful URL, never the iframe-internal artifact. */
  function _stripEmbed(href) {
    if (typeof href !== 'string' || !href) return href;
    const hashIdx = href.indexOf('#');
    const hash = hashIdx >= 0 ? href.slice(hashIdx) : '';
    const path = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
    const qIdx = path.indexOf('?');
    if (qIdx < 0) return href;
    const base = path.slice(0, qIdx);
    const qp = new URLSearchParams(path.slice(qIdx + 1));
    if (!qp.has('embed')) return href;
    qp.delete('embed');
    const qs = qp.toString();
    return base + (qs ? '?' + qs : '') + hash;
  }

  function _isAllowedHref(href) {
    if (typeof href !== 'string') return false;
    if (!href.startsWith('/rm/')) return false;
    if (href.indexOf('..') !== -1) return false;
    return true;
  }

  /* Adopt `?workflow=<id>` into sessionStorage.
   *
   * V3.618 — this must happen HERE, not in nav.js. This IIFE runs at
   * parse time, before nav.js's DOMContentLoaded `_wfAdoptFromUrl`, and
   * writeState() below rewrites the URL without `?workflow=` on the very
   * first tick — so by the time nav.js looks, the param is gone. Without
   * this call, entering split with a decorated URL would leave the parent
   * showing the plain nav instead of the workflow strip. */
  const _WF_STORAGE_KEY = 'mcgheelab.activeWorkflow';   // keep in sync with nav.js / workflow-state.js
  (function _adoptWorkflowFromUrl() {
    try {
      const wfId = new URLSearchParams(location.search).get('workflow');
      if (!wfId) return;
      let existing = null;
      try { existing = JSON.parse(sessionStorage.getItem(_WF_STORAGE_KEY) || 'null'); } catch (e) {}
      if (existing && existing.id === wfId) return;   // preserve dirty edits
      // Mirror nav.js's _wfAdoptFromUrl fresh-state shape.
      sessionStorage.setItem(_WF_STORAGE_KEY, JSON.stringify({
        id: wfId, kind: 'default', addedPageIds: [], removedPageIds: [],
        orderOverride: null, pageState: {},
      }));
    } catch (e) { /* sessionStorage unavailable — strip just won't render */ }
  })();

  /* V3.73 — append `?embed=1` to the iframe src so nav.js inside the
   * iframe suppresses its top nav / workflow strip.
   *
   * V3.632 — panes are now ALWAYS embedded. V3.75 embedded only inside a
   * workflow, on the reasoning that outside one the parent had no strip
   * and so the pane's own nav was the only way to navigate that pane.
   * The cost was three stacked navigation bars (parent + one per pane),
   * which is what Alex actually saw. nav.js now renders per-pane page
   * pickers into the parent nav when splitting outside a workflow, so
   * the pane's own nav is no longer load-bearing and can go. */
  function _embedHref(href) {
    if (typeof href !== 'string') return href;
    const idx = href.indexOf('#');
    const hash = idx >= 0 ? href.slice(idx) : '';
    const path = idx >= 0 ? href.slice(0, idx) : href;
    const qIdx = path.indexOf('?');
    const base = qIdx >= 0 ? path.slice(0, qIdx) : path;
    const qs = qIdx >= 0 ? path.slice(qIdx + 1) : '';
    const qp = new URLSearchParams(qs);
    qp.set('embed', '1');
    return base + '?' + qp.toString() + hash;
  }

  /* ─── Render ───────────────────────────────────────────── */
  let state = readState();
  let dragging = false;

  render();
  writeState(state);

  // V3.85 — initialize the shared shell popouts so split mode also has
  // chat/tasks (or user-chosen pages) available at the screen edges.
  // Init after a tick so workflow-state has been adopted into
  // sessionStorage by nav.js (which fires on DOMContentLoaded — the
  // split-view IIFE runs before that, so we defer to next tick).
  setTimeout(function () {
    if (window.ShellPopouts && ShellPopouts.init) {
      // Pull workflow page list (if any) for the popout's page picker.
      let wfPageIds = [];
      const wfState = (typeof WorkflowState !== 'undefined' && WorkflowState.read)
        ? WorkflowState.read() : null;
      if (wfState && wfState.id && window.PAGE_REGISTRY && PAGE_REGISTRY.DEFAULT_WORKFLOWS) {
        const wf = (PAGE_REGISTRY.DEFAULT_WORKFLOWS || []).find(w => w.id === wfState.id);
        if (wf) wfPageIds = wf.pageIds || [];
      }
      ShellPopouts.init({
        container: document.getElementById('shell-root') || document.body,
        workflowPageIds: wfPageIds,
        canAccessPage: (id) => {
          if (typeof firebridge === 'undefined' || !firebridge.canAccessPage) return true;
          return firebridge.canAccessPage(id);
        },
        defaults: { left: 'chat', right: 'tasks' },
      });
    }
  }, 0);

  function render() {
    root.innerHTML =
      '<div class="split-shell">' +
        paneHTML('left', state.left, state.ratio, state.active === 'left') +
        '<div class="split-divider" id="split-divider" title="Drag to resize">' +
          '<div class="split-divider-grip"></div>' +
        '</div>' +
        paneHTML('right', state.right, 1 - state.ratio, state.active === 'right') +
      '</div>';

    wirePaneFocus('left');
    wirePaneFocus('right');
    wireIframeLoad('left');
    wireIframeLoad('right');
    wireDivider();
    applyRatio();
  }

  /* No more pane header — just a thin "active" border via .split-pane.active.
   * The workflow strip handles label / swap / close.
   *
   * V3.76 — `name="rm-embed-<side>"` on the iframe element is a durable
   * embed signal: the HTML spec says window.name (the browsing context
   * name) survives navigations within the same frame. nav.js inside the
   * iframe checks window.name and short-circuits regardless of URL
   * params — so even after an in-iframe `<a href>` click strips the
   * `?embed=1` query, the new document still inherits the name and
   * suppresses its top nav. Without this, library → paper navigation
   * inside the iframe would render a second nav inside the pane.
   *
   * V3.632 — set unconditionally (see _embedHref). */
  function paneHTML(side, href, basisRatio, isActive) {
    return (
      '<div class="split-pane split-pane--' + side + (isActive ? ' active' : '') + '" data-side="' + side + '" style="flex-basis:' + (basisRatio * 100).toFixed(2) + '%;">' +
        '<iframe class="split-pane-frame" data-side="' + side + '" name="rm-embed-' + side + '" src="' + _esc(_embedHref(href)) + '" title="' + _esc(_labelFromHref(href)) + '"></iframe>' +
      '</div>'
    );
  }

  /* V3.76 — sync iframe URL into parent split state. When the user
   * clicks a link inside the iframe, the iframe navigates within
   * itself; the parent has no idea unless we listen to its `load`
   * event. After every load, read iframe.contentWindow.location, strip
   * the `?embed=1` artifact, and update state[side] if it differs.
   * writeState() dispatches `rm:split:state-change` (V3.75), which
   * nav.js's strip refresh-listener uses to re-render — so chip
   * "open" markers stay accurate to whatever's actually in the pane. */
  function wireIframeLoad(side) {
    const frame = root.querySelector('.split-pane-frame[data-side="' + side + '"]');
    if (!frame) return;
    frame.addEventListener('load', () => {
      try {
        const win = frame.contentWindow;
        if (!win) return;
        const path = win.location.pathname;
        const sp = new URLSearchParams(win.location.search);
        sp.delete('embed');
        const qs = sp.toString();
        const newURL = path + (qs ? '?' + qs : '') + (win.location.hash || '');
        if (newURL && newURL !== state[side]) {
          state[side] = newURL;
          writeState(state);    // dispatches state-change → strip refresh
        }
      } catch (e) {
        // Cross-origin (shouldn't happen for /rm/* internal pages); ignore.
      }
    });
  }

  /* Click anywhere in a pane's iframe wrapper → make that pane active.
   * Mousedown on the iframe doesn't bubble to parent (cross-document
   * boundary), so we listen on the wrapper element via mousedown
   * capture and a focus-bridge: nav.js can also fire setActive events
   * directly. */
  function wirePaneFocus(side) {
    const pane = root.querySelector('.split-pane--' + side);
    if (!pane) return;
    pane.addEventListener('mousedown', () => setActive(side), true);
  }

  function setActive(side) {
    if (side !== 'left' && side !== 'right') return;
    if (state.active === side) return;
    state.active = side;
    writeState(state);
    root.querySelectorAll('.split-pane').forEach(el => {
      el.classList.toggle('active', el.dataset.side === side);
    });
  }

  function swapPane(side, newHref) {
    if (side !== 'left' && side !== 'right') return;
    if (!_isAllowedHref(newHref)) return;
    state[side] = newHref;
    state.active = side;     // swapping a pane focuses it
    writeState(state);
    const frame = root.querySelector('.split-pane-frame[data-side="' + side + '"]');
    if (frame) frame.src = _embedHref(newHref);
    root.querySelectorAll('.split-pane').forEach(el => {
      el.classList.toggle('active', el.dataset.side === side);
    });
  }

  function closeSplit(keep) {
    let survivor;
    if (keep === 'left')  survivor = state.left;
    else if (keep === 'right') survivor = state.right;
    else                  survivor = (state.active === 'left') ? state.left : state.right;
    if (!survivor) survivor = FALLBACK_HREF;
    window.location.href = survivor;
  }

  /* ─── Event bridge from nav.js's workflow strip ──────────── */
  window.addEventListener('rm:split:swap', (e) => {
    const d = e && e.detail; if (!d) return;
    swapPane(d.side, d.href);
  });
  window.addEventListener('rm:split:set-active', (e) => {
    const d = e && e.detail; if (!d) return;
    setActive(d.side);
  });
  window.addEventListener('rm:split:close', (e) => {
    const keep = (e && e.detail && e.detail.keep) || 'active';
    closeSplit(keep);
  });

  /* ─── Divider drag ────────────────────────────────────── */
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
      writeState(state);
    });
    divider.addEventListener('pointercancel', () => {
      dragging = false;
      document.body.classList.remove('split-dragging');
    });
  }

  function applyRatio() {
    const left  = root.querySelector('.split-pane--left');
    const right = root.querySelector('.split-pane--right');
    if (left)  left.style.flexBasis  = (state.ratio * 100).toFixed(2) + '%';
    if (right) right.style.flexBasis = ((1 - state.ratio) * 100).toFixed(2) + '%';
  }

  /* ─── Tiny helpers ────────────────────────────────────── */
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
