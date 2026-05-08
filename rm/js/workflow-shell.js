/* ================================================================
   workflow-shell.js — V3.78 RM workflow shell
   ================================================================
   Single-page host for an entire workflow. All workflow pages live
   as same-origin iframes inside this shell. The strip's chip clicks
   swap WHICH iframe is visible without a full-page navigation, so
   each page's state (scroll position, in-progress edits, paper-id
   being edited, etc.) survives chip switching.

   Side popouts: two collapsible panels (left + right) at the edges,
   each holding an iframe of a user-chosen workflow page. Default
   left = chat, right = tasks. Configurable via a gear button inside
   each popout's header. Each popout's iframe is also same-origin
   and shares Firebase IndexedDB with the parent + main iframes.

   URL state — single source of truth, persisted via replaceState:
     /rm/pages/workflow-shell.html
       ?workflow=<id>
       &active=<pageId>
       &leftPopout=<pageId>
       &rightPopout=<pageId>
       &leftOpen=<0|1>
       &rightOpen=<0|1>

   Lazy iframe loading: only the active page's iframe is created up
   front; other workflow pages' iframes are created on first chip
   click and stay mounted (display:none) thereafter. Memory cost is
   ~5MB per iframe; typical workflow has 5-7 pages so peak footprint
   is ~25-35MB beyond the parent — manageable on modern devices.

   Cross-iframe state coordination: handled by Firestore's existing
   live-sync (LIVE_SYNC.attach in each renderer). When iframe A writes
   to Firestore, iframe B's listener fires the same way it would for
   cross-tab updates. No new mechanism needed.

   Embedded iframes get name="rm-shell-<pageId>" so nav.js inside
   them suppresses its own top nav (V3.76 mechanism, extended to
   recognize 'rm-shell-' prefix alongside 'rm-embed-').
   ================================================================ */

(function () {
  'use strict';

  const POPOUT_WIDTH_PX = 380;
  const DEFAULT_LEFT_POPOUT = 'chat';
  const DEFAULT_RIGHT_POPOUT = 'tasks';

  /* ─── URL state ────────────────────────────────────────── */
  function readState() {
    const p = new URLSearchParams(window.location.search);
    return {
      workflow:     p.get('workflow') || '',
      active:       p.get('active') || '',
      leftPopout:   p.get('leftPopout')  || DEFAULT_LEFT_POPOUT,
      rightPopout:  p.get('rightPopout') || DEFAULT_RIGHT_POPOUT,
      leftOpen:     p.get('leftOpen')  === '1',
      rightOpen:    p.get('rightOpen') === '1',
    };
  }

  function writeState(s) {
    const p = new URLSearchParams();
    if (s.workflow)    p.set('workflow', s.workflow);
    if (s.active)      p.set('active', s.active);
    if (s.leftPopout)  p.set('leftPopout', s.leftPopout);
    if (s.rightPopout) p.set('rightPopout', s.rightPopout);
    if (s.leftOpen)    p.set('leftOpen', '1');
    if (s.rightOpen)   p.set('rightOpen', '1');
    history.replaceState(null, '', '/rm/pages/workflow-shell.html?' + p.toString());
  }

  /* ─── Page registry helpers ──────────────────────────── */
  function pageMap() {
    return (window.PAGE_REGISTRY && window.PAGE_REGISTRY.byId) || new Map();
  }

  function pageHrefForId(id) {
    const p = pageMap().get(id);
    return p && p.href || null;
  }

  function pageLabelForId(id) {
    const p = pageMap().get(id);
    return p && p.label || id;
  }

  function pageIconForId(id) {
    // Mirror common icons from all-pages.js — keep small inline list
    // for the popout pill default labels. Falls back to 📄.
    const map = {
      'chat': '💬', 'tasks': '✅', 'huddle': '👥',
      'meetings': '🗣', 'scheduler': '⌚', 'calendar': '🗓',
      'library': '📚', 'paper-builder': '📝', 'pmr': '📋',
      'sharing': '🤝', 'projects': '📁', 'inventory': '📦',
      'compliance': '⚖️', 'chemicals': '🧪',
    };
    return map[id] || '📄';
  }

  /* ─── Workflow page list ─────────────────────────────── */
  let _wf = null;            // cached workflow record
  async function loadWorkflow(workflowId) {
    if (_wf && _wf.id === workflowId) return _wf;
    if (typeof firebridge === 'undefined' || !firebridge.db) return null;
    // Try Firestore first; fall back to PAGE_REGISTRY.DEFAULT_WORKFLOWS.
    try {
      const snap = await firebridge.db().collection('labConfig').doc('defaultWorkflows').get();
      if (snap.exists) {
        const arr = (snap.data() || {}).workflows || [];
        const hit = arr.find(w => w.id === workflowId);
        if (hit) { _wf = hit; return hit; }
      }
    } catch (e) { /* ignore */ }
    // Fall back to seeded defaults exposed by page-registry.js.
    const seeds = (window.PAGE_REGISTRY && window.PAGE_REGISTRY.DEFAULT_WORKFLOWS) || [];
    let hit = seeds.find(w => w.id === workflowId);
    if (hit) { _wf = hit; return hit; }
    // Custom workflow under userData/{uid}/customWorkflows/{id}.
    const u = firebridge.getUser && firebridge.getUser();
    if (u) {
      try {
        const doc = await firebridge.db()
          .collection('userData').doc(u.uid)
          .collection('customWorkflows').doc(workflowId).get();
        if (doc.exists) { _wf = Object.assign({ id: doc.id }, doc.data() || {}); return _wf; }
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  /* ─── Iframe manager ─────────────────────────────────── */
  // Tracks lazy-loaded main-area iframes. Map<pageId, { wrapper, frame }>.
  const _frames = new Map();

  function _embedHref(href, slot) {
    // Add ?embed=1 (V3.73) and rely on window.name (V3.76) to keep the
    // signal durable across in-iframe navigations. slot drives
    // window.name so each iframe has a distinct browsing-context name.
    if (!href) return href;
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

  function ensureFrame(pageId) {
    if (_frames.has(pageId)) return _frames.get(pageId);
    const href = pageHrefForId(pageId);
    if (!href) return null;
    const main = document.getElementById('shell-main');
    if (!main) return null;
    const wrapper = document.createElement('div');
    wrapper.className = 'shell-frame-wrap';
    wrapper.dataset.pageId = pageId;
    wrapper.style.display = 'none';   // hidden until activated
    const frame = document.createElement('iframe');
    frame.className = 'shell-frame';
    frame.name = 'rm-shell-' + pageId;
    frame.src = _embedHref(href);
    frame.title = pageLabelForId(pageId);
    wrapper.appendChild(frame);
    main.appendChild(wrapper);
    const rec = { wrapper, frame };
    _frames.set(pageId, rec);
    return rec;
  }

  function showActiveFrame(pageId) {
    // Lazy-create on first activation; flip display on the rest.
    ensureFrame(pageId);
    _frames.forEach((rec, id) => {
      rec.wrapper.style.display = (id === pageId) ? '' : 'none';
    });
  }

  /* ─── Popout rendering ───────────────────────────────── */
  function renderPopout(side) {
    const root = document.getElementById('shell-popout-' + side);
    if (!root) return;
    const state = readState();
    const pageId = state[side + 'Popout'];
    const isOpen = state[side + 'Open'];
    const label = pageLabelForId(pageId);
    const icon = pageIconForId(pageId);

    root.classList.toggle('open', isOpen);
    root.innerHTML = '';

    if (!isOpen) {
      // Collapsed pill — vertical bar with icon + rotated label.
      const pill = document.createElement('button');
      pill.className = 'shell-popout-pill';
      pill.type = 'button';
      pill.title = 'Open ' + label + ' (' + side + ' popout)';
      pill.innerHTML =
        '<span class="shell-popout-pill-icon">' + escHtml(icon) + '</span>' +
        '<span class="shell-popout-pill-label">' + escHtml(label) + '</span>';
      pill.addEventListener('click', () => togglePopout(side, true));
      root.appendChild(pill);
      return;
    }

    // Expanded panel: header (icon + label + page picker + close) + iframe.
    const header = document.createElement('div');
    header.className = 'shell-popout-header';
    header.innerHTML =
      '<div class="shell-popout-title">' +
      '  <span class="shell-popout-icon">' + escHtml(icon) + '</span>' +
      '  <span>' + escHtml(label) + '</span>' +
      '</div>' +
      '<div class="shell-popout-actions">' +
      '  <select class="shell-popout-picker" title="Pick a page for this popout"></select>' +
      '  <button class="shell-popout-close" type="button" title="Close popout">×</button>' +
      '</div>';
    root.appendChild(header);

    const iframe = document.createElement('iframe');
    iframe.className = 'shell-popout-frame';
    iframe.name = 'rm-shell-popout-' + side;
    iframe.src = _embedHref(pageHrefForId(pageId) || '/rm/index.html');
    iframe.title = label;
    root.appendChild(iframe);

    // Populate page picker with workflow pages (so popout is restricted
    // to pages the user already has access to in this workflow).
    const picker = header.querySelector('.shell-popout-picker');
    const options = (_wf && _wf.pageIds) || [];
    options.forEach(id => {
      const p = pageMap().get(id);
      if (!p) return;
      if (typeof firebridge !== 'undefined' && firebridge.canAccessPage && !firebridge.canAccessPage(id)) return;
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = p.label;
      if (id === pageId) opt.selected = true;
      picker.appendChild(opt);
    });
    // Always include defaults even if not in this workflow's pageIds —
    // chat + tasks should be reachable regardless.
    [DEFAULT_LEFT_POPOUT, DEFAULT_RIGHT_POPOUT].forEach(id => {
      if (Array.from(picker.options).some(o => o.value === id)) return;
      const p = pageMap().get(id);
      if (!p) return;
      if (typeof firebridge !== 'undefined' && firebridge.canAccessPage && !firebridge.canAccessPage(id)) return;
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = p.label;
      if (id === pageId) opt.selected = true;
      picker.appendChild(opt);
    });

    picker.addEventListener('change', () => {
      const newId = picker.value;
      const s = readState();
      s[side + 'Popout'] = newId;
      writeState(s);
      renderPopout(side);    // re-render to swap iframe + label
    });
    header.querySelector('.shell-popout-close').addEventListener('click', () => togglePopout(side, false));
  }

  function togglePopout(side, open) {
    const s = readState();
    s[side + 'Open'] = !!open;
    writeState(s);
    renderPopout(side);
    document.body.classList.toggle('shell-popout-' + side + '-open', !!open);
  }

  /* ─── Strip integration ──────────────────────────────── */
  // nav.js dispatches rm:shell:set-active when a chip is clicked in
  // shell mode (detected by location.pathname).
  window.addEventListener('rm:shell:set-active', (e) => {
    const d = e && e.detail; if (!d) return;
    const pageId = d.pageId;
    const s = readState();
    if (!pageId || pageId === s.active) return;
    s.active = pageId;
    writeState(s);
    showActiveFrame(pageId);
  });

  /* ─── Boot ────────────────────────────────────────────── */
  async function boot() {
    if (typeof firebridge === 'undefined') return;
    await firebridge.whenAuthResolved();
    if (!firebridge.getUser()) {
      const main = document.getElementById('shell-main');
      if (main) main.innerHTML = '<div class="empty-state">Sign in to use workflows.</div>';
      return;
    }
    if (firebridge.loadAccessGrant) {
      try { await firebridge.loadAccessGrant(); } catch (e) { /* ignore */ }
    }

    let s = readState();
    if (!s.workflow) {
      // Adopt from sessionStorage if present (entry from chooser).
      const wfState = (typeof WorkflowState !== 'undefined' && WorkflowState.read)
        ? WorkflowState.read() : null;
      if (wfState && wfState.id) {
        s.workflow = wfState.id;
      } else {
        // No workflow specified — bounce back to chooser.
        location.href = '/rm/index.html';
        return;
      }
    }

    // Make sure sessionStorage workflow matches URL workflow (so the
    // strip + canAccessPage filtering work consistently).
    if (typeof WorkflowState !== 'undefined' && WorkflowState.read) {
      const cur = WorkflowState.read();
      if (!cur || cur.id !== s.workflow) {
        WorkflowState.setActive(s.workflow, 'default');  // best-guess kind
      }
    }

    const wf = await loadWorkflow(s.workflow);
    if (!wf) {
      const main = document.getElementById('shell-main');
      if (main) main.innerHTML = '<div class="empty-state">Workflow not found.</div>';
      return;
    }

    // Pick initial active page: URL ?active=, else workflow.landingPageId,
    // else first accessible workflow page.
    if (!s.active || !pageHrefForId(s.active)) {
      let landing = wf.landingPageId;
      const isAccessible = (id) => {
        if (!pageHrefForId(id)) return false;
        if (typeof firebridge === 'undefined' || !firebridge.canAccessPage) return true;
        return firebridge.canAccessPage(id);
      };
      if (!landing || !isAccessible(landing)) {
        landing = (wf.pageIds || []).find(isAccessible);
      }
      s.active = landing;
    }
    writeState(s);

    if (s.active) showActiveFrame(s.active);
    renderPopout('left');
    renderPopout('right');
    document.body.classList.toggle('shell-popout-left-open',  s.leftOpen);
    document.body.classList.toggle('shell-popout-right-open', s.rightOpen);
  }

  function escHtml(str) {
    if (str == null) return '';
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
