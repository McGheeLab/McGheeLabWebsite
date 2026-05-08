/* ================================================================
   shell-popouts.js — V3.85 shared left/right popout overlays
   ================================================================
   Both the workflow shell (rm/pages/workflow-shell.html) and the
   split-view shell (rm/pages/split-view.html) want left + right
   popouts that float over their main content at the viewport edges.
   This module is the shared implementation: DOM injection, drag-to-
   resize, page picker, URL state, localStorage width persistence.

   Usage:
     ShellPopouts.init({
       container,             // HTMLElement where popouts mount
       workflowPageIds,       // Array<pageId> for the page picker
       canAccessPage,         // (id) => boolean
       defaults: { left: 'chat', right: 'tasks' },
     });

   URL state (shared between shells, no collision with split's
   left/right iframe params):
     ?leftPopout=<pageId>&rightPopout=<pageId>
     &leftOpen=<0|1>&rightOpen=<0|1>

   Width persists in localStorage per side (V3.80):
     mcgheelab.shellPopout.<side>Width
   ================================================================ */

(function () {
  'use strict';

  const DEFAULT_POPOUT_WIDTH = 460;
  const MIN_POPOUT_WIDTH = 240;
  const MAX_POPOUT_WIDTH = 900;
  const WIDTH_LS_KEY = function (side) { return 'mcgheelab.shellPopout.' + side + 'Width'; };
  // V3.89 — persist popout state (open/closed + selected page) to
  // localStorage so it survives navigations between workflows + browser
  // restarts. URL still wins when present (so shareable URLs keep
  // working); localStorage is the source-of-truth fallback when the URL
  // doesn't specify.
  const STATE_LS_KEY = 'mcgheelab.shellPopout.state';

  let _opts = null;       // saved init options

  /* ─── URL + localStorage state helpers ────────────────── */
  function readPersistedState() {
    try {
      const raw = localStorage.getItem(STATE_LS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return {};
  }
  function writePersistedState(s) {
    try {
      localStorage.setItem(STATE_LS_KEY, JSON.stringify({
        leftPopout: s.leftPopout, rightPopout: s.rightPopout,
        leftOpen:   s.leftOpen,   rightOpen:   s.rightOpen,
      }));
    } catch (e) { /* ignore */ }
  }

  function readState() {
    const p = new URLSearchParams(location.search);
    const persisted = readPersistedState();
    const defL = (_opts && _opts.defaults && _opts.defaults.left)  || 'chat';
    const defR = (_opts && _opts.defaults && _opts.defaults.right) || 'tasks';
    const hasLeftOpen  = p.has('leftOpen');
    const hasRightOpen = p.has('rightOpen');
    return {
      // URL > persisted > default. Means an explicit URL ?leftPopout=
      // overrides the persisted choice (handy for share links).
      leftPopout:  p.get('leftPopout')  || persisted.leftPopout  || defL,
      rightPopout: p.get('rightPopout') || persisted.rightPopout || defR,
      leftOpen:    hasLeftOpen  ? p.get('leftOpen')  === '1'
                                 : (persisted.leftOpen  != null ? !!persisted.leftOpen  : true),
      rightOpen:   hasRightOpen ? p.get('rightOpen') === '1'
                                 : (persisted.rightOpen != null ? !!persisted.rightOpen : true),
    };
  }

  function writeState(s) {
    // Preserve every other URL param (shell-specific ones like
    // ?workflow= / ?active= / ?left= / ?right= / ?ratio=). Only
    // upsert popout params here.
    const p = new URLSearchParams(location.search);
    p.set('leftPopout',  s.leftPopout);
    p.set('rightPopout', s.rightPopout);
    p.set('leftOpen',    s.leftOpen  ? '1' : '0');
    p.set('rightOpen',   s.rightOpen ? '1' : '0');
    history.replaceState(null, '', location.pathname + '?' + p.toString());
    writePersistedState(s);     // V3.89 — also persist for cross-nav
  }

  /* ─── Width persistence ──────────────────────────────── */
  function readWidth(side) {
    try {
      const raw = localStorage.getItem(WIDTH_LS_KEY(side));
      const n = parseFloat(raw);
      if (n >= MIN_POPOUT_WIDTH && n <= MAX_POPOUT_WIDTH) return Math.round(n);
    } catch (e) { /* ignore */ }
    return DEFAULT_POPOUT_WIDTH;
  }
  function writeWidth(side, px) {
    try {
      const n = Math.max(MIN_POPOUT_WIDTH, Math.min(MAX_POPOUT_WIDTH, Math.round(px)));
      localStorage.setItem(WIDTH_LS_KEY(side), String(n));
    } catch (e) { /* ignore */ }
  }
  function applyWidth(side) {
    const root = document.getElementById('shell-popout-' + side);
    if (!root) return;
    if (!root.classList.contains('open')) { root.style.width = ''; return; }
    root.style.width = readWidth(side) + 'px';
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
    const map = {
      'chat': '💬', 'tasks': '✅', 'huddle': '👥',
      'meetings': '🗣', 'scheduler': '⌚', 'calendar': '🗓',
      'library': '📚', 'paper-builder': '📝', 'pmr': '📋',
      'sharing': '🤝', 'projects': '📁', 'inventory': '📦',
      'compliance': '⚖️', 'chemicals': '🧪',
    };
    return map[id] || '📄';
  }

  /* ─── Iframe URL embed helper ────────────────────────── */
  function embedHref(href) {
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

  /* ─── Popout rendering ───────────────────────────────── */
  function escHtml(str) {
    if (str == null) return '';
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

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

    // V3.90 — single toggle pill anchored at the viewport edge so the
    // open and close affordances live in EXACTLY the same screen
    // location. Clicking it toggles state. When the popout is closed
    // the pill shows the page icon + vertical label; when open it
    // shows a single chevron pointing inward (= "collapse"). The
    // floating tab feel survives, but mouse muscle-memory carries
    // between states.
    const pill = document.createElement('button');
    pill.className = 'shell-popout-pill';
    pill.type = 'button';
    pill.title = (isOpen ? 'Close ' : 'Open ') + label + ' (' + side + ' popout)';
    if (isOpen) {
      pill.classList.add('shell-popout-pill--open');
      pill.innerHTML =
        '<span class="shell-popout-pill-chev">' + (side === 'left' ? '◂' : '▸') + '</span>';
    } else {
      pill.innerHTML =
        '<span class="shell-popout-pill-icon">' + escHtml(icon) + '</span>' +
        '<span class="shell-popout-pill-label">' + escHtml(label) + '</span>';
    }
    pill.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePopout(side, !isOpen);
    });
    pill.addEventListener('pointerdown', (e) => e.stopPropagation());
    root.appendChild(pill);

    if (!isOpen) return;

    const handle = document.createElement('div');
    handle.className = 'shell-popout-resize shell-popout-resize--' + side;
    handle.title = 'Drag to resize';
    root.appendChild(handle);
    wireResize(side, handle, root);

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
    iframe.src = embedHref(pageHrefForId(pageId) || '/rm/index.html');
    iframe.title = label;
    root.appendChild(iframe);

    applyWidth(side);

    // V3.89 — page picker lists EVERY accessible page from
    // PAGE_REGISTRY, grouped by NAV section, with the workflow's own
    // pages listed first as a fast-access "Workflow" group. Previously
    // it was workflow pages + chat + tasks only — that's enough for
    // typical workflow popouts but the user wanted to be able to put
    // any page in either popout slot.
    const picker = header.querySelector('.shell-popout-picker');
    const wfPages = (_opts && _opts.workflowPageIds) || [];
    const canAcc = (_opts && _opts.canAccessPage) || (() => true);
    const seen = new Set();
    const allPages = (window.PAGE_REGISTRY && window.PAGE_REGISTRY.list) || [];

    function appendOption(group, p) {
      if (seen.has(p.id)) return;
      if (!canAcc(p.id)) return;
      seen.add(p.id);
      group.appendChild(buildOption(p, p.id === pageId));
    }
    function buildOption(p, selected) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      if (selected) opt.selected = true;
      return opt;
    }

    // 1. "This workflow" optgroup — fast access to the chips the user
    //    is already cycling between via the strip.
    if (wfPages.length) {
      const wfGroup = document.createElement('optgroup');
      wfGroup.label = 'This workflow';
      wfPages.forEach(id => {
        const p = pageMap().get(id);
        if (p) appendOption(wfGroup, p);
      });
      if (wfGroup.children.length) picker.appendChild(wfGroup);
    }

    // 2. Defaults (chat / tasks) if not already shown via workflow.
    const defaultsGroup = document.createElement('optgroup');
    defaultsGroup.label = 'Quick';
    [(_opts && _opts.defaults && _opts.defaults.left)  || 'chat',
     (_opts && _opts.defaults && _opts.defaults.right) || 'tasks'].forEach(id => {
      const p = pageMap().get(id);
      if (p) appendOption(defaultsGroup, p);
    });
    if (defaultsGroup.children.length) picker.appendChild(defaultsGroup);

    // 3. Every other accessible page, bucketed by NAV group.
    const byGroup = new Map();
    allPages.forEach(p => {
      if (seen.has(p.id)) return;
      if (!canAcc(p.id)) return;
      const g = p.group || 'Other';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(p);
    });
    byGroup.forEach((pages, groupName) => {
      const optg = document.createElement('optgroup');
      optg.label = groupName;
      pages.forEach(p => appendOption(optg, p));
      if (optg.children.length) picker.appendChild(optg);
    });
    picker.addEventListener('change', () => {
      const newId = picker.value;
      const s = readState();
      s[side + 'Popout'] = newId;
      writeState(s);
      renderPopout(side);
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

  function wireResize(side, handle, root) {
    let dragging = false;
    let startX = 0, startWidth = 0;
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const next = (side === 'left') ? startWidth + dx : startWidth - dx;
      const clamped = Math.max(MIN_POPOUT_WIDTH, Math.min(MAX_POPOUT_WIDTH, next));
      root.style.width = clamped + 'px';
    };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
      document.body.classList.remove('shell-popout-resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup',   onUp);
      window.removeEventListener('pointercancel', onUp);
      const px = parseFloat(root.style.width) || DEFAULT_POPOUT_WIDTH;
      writeWidth(side, px);
    };
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      dragging = true;
      startX = e.clientX;
      startWidth = root.getBoundingClientRect().width;
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      document.body.classList.add('shell-popout-resizing');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup',   onUp);
      window.addEventListener('pointercancel', onUp);
      e.preventDefault();
    });
  }

  /* ─── Public init ─────────────────────────────────────── */
  function init(opts) {
    _opts = opts || {};
    const host = _opts.container || document.body;
    // Inject popout DOM if not already present (idempotent).
    if (!document.getElementById('shell-popout-left')) {
      const left = document.createElement('div');
      left.id = 'shell-popout-left';
      left.className = 'shell-popout shell-popout--left';
      host.appendChild(left);
    }
    if (!document.getElementById('shell-popout-right')) {
      const right = document.createElement('div');
      right.id = 'shell-popout-right';
      right.className = 'shell-popout shell-popout--right';
      host.appendChild(right);
    }
    renderPopout('left');
    renderPopout('right');
    const s = readState();
    document.body.classList.toggle('shell-popout-left-open',  s.leftOpen);
    document.body.classList.toggle('shell-popout-right-open', s.rightOpen);
  }

  window.ShellPopouts = {
    init: init,
    renderPopout: renderPopout,
    togglePopout: togglePopout,
    readState: readState,
    writeState: writeState,
  };
})();
