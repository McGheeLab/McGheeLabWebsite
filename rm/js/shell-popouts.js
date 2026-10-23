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
       // V3.810 — PAGE MODE (nav.js mounts the popouts on every ordinary
       // RM page as "quick contexts"):
       pageMode: true,        // body.rm-page-popouts: fixed under the bar, closed by default
       urlState: false,       // keep state in localStorage only — no ?leftPopout= on page urls
       stateKey: 'mcgheelab.pagePopout.state',   // separate from the shells' (default-open) state
       hideFor: 'chat',       // the current page's id — a popout showing THIS page is pointless
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
  /* V3.836 — "open further": a second, wider state. The stored width is the
   * BASE width; wide adds this much (chat shows its people/groups list in
   * the extra room). Dragging while wide re-derives the base. */
  const WIDE_EXTRA_PX = 300;
  const WIDTH_LS_KEY = function (side) { return 'mcgheelab.shellPopout.' + side + 'Width'; };
  // V3.89 — persist popout state (open/closed + selected page) to
  // localStorage so it survives navigations between workflows + browser
  // restarts. URL still wins when present (so shareable URLs keep
  // working); localStorage is the source-of-truth fallback when the URL
  // doesn't specify.
  const STATE_LS_KEY_DEFAULT = 'mcgheelab.shellPopout.state';

  let _opts = null;       // saved init options
  function stateKey() { return (_opts && _opts.stateKey) || STATE_LS_KEY_DEFAULT; }
  function useUrl() { return !(_opts && _opts.urlState === false); }
  function defaultOpen() { return !(_opts && _opts.pageMode); }

  /* ─── URL + localStorage state helpers ────────────────── */
  function readPersistedState() {
    try {
      const raw = localStorage.getItem(stateKey());
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return {};
  }
  function writePersistedState(s) {
    try {
      localStorage.setItem(stateKey(), JSON.stringify({
        leftPopout: s.leftPopout, rightPopout: s.rightPopout,
        leftOpen:   s.leftOpen,   rightOpen:   s.rightOpen,
        leftWide:   !!s.leftWide, rightWide:   !!s.rightWide,   // V3.836
      }));
    } catch (e) { /* ignore */ }
  }

  function readState() {
    // V3.810 — page mode ignores the url entirely (a stray ?leftOpen=1 on
    // some bookmark must not pop a panel open on an unrelated page).
    const p = useUrl() ? new URLSearchParams(location.search) : new URLSearchParams();
    const persisted = readPersistedState();
    const defL = (_opts && _opts.defaults && _opts.defaults.left)  || 'chat';
    const defR = (_opts && _opts.defaults && _opts.defaults.right) || 'tasks';
    const hasLeftOpen  = p.has('leftOpen');
    const hasRightOpen = p.has('rightOpen');
    const dflt = defaultOpen();
    return {
      // URL > persisted > default. Means an explicit URL ?leftPopout=
      // overrides the persisted choice (handy for share links).
      leftPopout:  p.get('leftPopout')  || persisted.leftPopout  || defL,
      rightPopout: p.get('rightPopout') || persisted.rightPopout || defR,
      leftOpen:    hasLeftOpen  ? p.get('leftOpen')  === '1'
                                 : (persisted.leftOpen  != null ? !!persisted.leftOpen  : dflt),
      rightOpen:   hasRightOpen ? p.get('rightOpen') === '1'
                                 : (persisted.rightOpen != null ? !!persisted.rightOpen : dflt),
      // V3.836 — wide ("open further") lives in localStorage only; a share
      // link never forces the wider panel.
      leftWide:    !!persisted.leftWide,
      rightWide:   !!persisted.rightWide,
    };
  }

  function writeState(s) {
    if (useUrl()) {
      // Preserve every other URL param (shell-specific ones like
      // ?workflow= / ?active= / ?left= / ?right= / ?ratio=). Only
      // upsert popout params here.
      const p = new URLSearchParams(location.search);
      p.set('leftPopout',  s.leftPopout);
      p.set('rightPopout', s.rightPopout);
      p.set('leftOpen',    s.leftOpen  ? '1' : '0');
      p.set('rightOpen',   s.rightOpen ? '1' : '0');
      history.replaceState(null, '', location.pathname + '?' + p.toString());
    }
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
  function wideExtra(side) {
    return readState()[side + 'Wide'] ? WIDE_EXTRA_PX : 0;
  }
  function applyWidth(side) {
    const root = document.getElementById('shell-popout-' + side);
    if (!root) return;
    if (!root.classList.contains('open')) { root.style.width = ''; return; }
    root.style.width = (readWidth(side) + wideExtra(side)) + 'px';
  }

  /* ─── V3.836 iframe bridge ───────────────────────────────
   * The page inside a popout can take part in the panel's chrome:
   *   host → frame  {type:'rm-popout-state', side, open, wide, label}
   *                 on iframe load, on every wide toggle, and on request
   *   frame → host  {type:'rm-popout-caps', wideLabel, wideIcon}
   *                 names the "open further" tab (chat: "People & groups")
   *                 {type:'rm-popout-request', wide:bool | close:true | state:true}
   * Same origin only; the sending side is found by comparing e.source with
   * each popout's iframe window, so a stray message can't drive a panel. */
  const _caps = { left: {}, right: {} };
  let _onMessage = null;

  function frameWin(side) {
    const root = document.getElementById('shell-popout-' + side);
    const f = root && root.querySelector('.shell-popout-frame');
    try { return (f && f.contentWindow) || null; } catch (e) { return null; }
  }
  function sideOf(source) {
    if (!source) return null;
    if (frameWin('left') === source) return 'left';
    if (frameWin('right') === source) return 'right';
    return null;
  }
  function postState(side) {
    const w = frameWin(side);
    if (!w) return;
    const s = readState();
    try {
      w.postMessage({
        type: 'rm-popout-state', side: side,
        open: !!s[side + 'Open'], wide: !!s[side + 'Wide'],
        label: pageLabelForId(s[side + 'Popout']),
      }, location.origin);
    } catch (e) { /* frame gone */ }
  }
  function wireMessages() {
    if (_onMessage) return;
    _onMessage = function (e) {
      if (e.origin !== location.origin) return;
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      const side = sideOf(e.source);
      if (!side) return;
      if (d.type === 'rm-popout-caps') {
        _caps[side] = {
          wideLabel: typeof d.wideLabel === 'string' ? d.wideLabel.slice(0, 40) : '',
          wideIcon:  typeof d.wideIcon  === 'string' ? d.wideIcon.slice(0, 40)  : '',
        };
        refreshTabs(side);
      } else if (d.type === 'rm-popout-request') {
        if (d.close === true) { togglePopout(side, false); return; }
        if (typeof d.wide === 'boolean') setWide(side, d.wide);
        if (d.state === true) postState(side);
      }
    };
    window.addEventListener('message', _onMessage);
  }
  function tabIcon(name) {
    return (window.ICON && ICON.svg) ? ICON.svg(name) : '';
  }
  /* The open-state side tabs, in place (never rebuilds the iframe). */
  function refreshTabs(side) {
    const root = document.getElementById('shell-popout-' + side);
    if (!root) return;
    const s = readState();
    const wide = !!s[side + 'Wide'];
    const caps = _caps[side] || {};
    const wideLabel = caps.wideLabel || 'Wider';
    root.classList.toggle('shell-popout--wide', wide);
    const wideBtn = root.querySelector('.shell-popout-tab--wide');
    if (wideBtn) {
      wideBtn.classList.toggle('is-on', wide);
      wideBtn.setAttribute('aria-pressed', wide ? 'true' : 'false');
      wideBtn.title = (wide ? 'Hide ' : 'Show ') + wideLabel.toLowerCase() + ' (open the panel further)';
      wideBtn.innerHTML =
        '<span class="shell-popout-tab-icon">' + tabIcon(caps.wideIcon || 'queue-list') + '</span>' +   /* icon markup — trusted */
        '<span class="shell-popout-tab-label">' + escHtml(wideLabel) + '</span>';
    }
  }
  function setWide(side, wide) {
    const s = readState();
    if (!!s[side + 'Wide'] === !!wide) return;
    s[side + 'Wide'] = !!wide;
    writeState(s);
    refreshTabs(side);
    applyWidth(side);
    postState(side);
  }

  /* ─── Page registry helpers ──────────────────────────── */
  /* page-registry.js is loaded by the two shells only; on an ordinary page
   * (V3.810 page mode) fall back to nav.js's own flattening of NAV_ITEMS,
   * which every page has. Same ids, same labels, plus `icon`. */
  function pageMap() {
    if (window.PAGE_REGISTRY && window.PAGE_REGISTRY.byId) return window.PAGE_REGISTRY.byId;
    if (typeof _wfBuildPageMap === 'function') return _wfBuildPageMap();
    return new Map();
  }
  function allPagesList() {
    if (window.PAGE_REGISTRY && window.PAGE_REGISTRY.list) return window.PAGE_REGISTRY.list;
    return Array.from(pageMap().values());
  }
  function pageHrefForId(id) {
    const p = pageMap().get(id);
    return p && p.href || null;
  }
  function pageLabelForId(id) {
    const p = pageMap().get(id);
    return p && p.label || id;
  }
  /* V3.810 — the page's Heroicon from NAV_ITEMS (as markup), so the pill
   * and header match the bar's chips; the icon-name map is the fallback for
   * an id the nav doesn't know. */
  function pageIconForId(id) {
    const p = pageMap().get(id);
    if (p && p.icon && window.ICON && ICON.svg) return ICON.svg(p.icon);
    const map = {
      'chat': 'chat-bubble-left-right', 'tasks': 'check-circle', 'huddle': 'users',
      'meetings': 'megaphone', 'scheduler': 'clock', 'calendar': 'calendar-days',
      'library': 'books', 'paper-builder': 'pencil-square', 'pmr': 'clipboard-document-list',
      'sharing': 'user-group', 'projects': 'folder', 'inventory': 'cube',
      'compliance': 'scale', 'chemicals': 'test-tube',
    };
    return (window.ICON && ICON.render) ? ICON.render(map[id] || 'document-text') : '';
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

    // V3.810 — page mode: a popout showing the page we are ON is pointless
    // (Chat inside Chat). Hide that side entirely; the other side stays.
    if (_opts && _opts.hideFor && _opts.hideFor === pageId) {
      root.classList.remove('open');
      root.innerHTML = '';
      root.style.display = 'none';
      return;
    }
    root.style.display = '';

    root.classList.toggle('open', isOpen);
    root.innerHTML = '';

    // V3.90 — single toggle pill anchored at the viewport edge so the
    // open and close affordances live in EXACTLY the same screen
    // location. Clicking it toggles state. When the popout is closed
    // the pill shows the page icon + vertical label; when open it
    // shows a single chevron pointing inward (= "collapse"). The
    // floating tab feel survives, but mouse muscle-memory carries
    // between states.
    // V3.836 — OPEN state is no longer one chevron: the same anchor holds a
    // vertical cluster of side tabs — "open further" (wide) and "close".
    // Alex: "i need a side tab for open further to reveal people, groups etc.
    // another button to close the chat panel."
    const pill = document.createElement(isOpen ? 'div' : 'button');
    pill.className = 'shell-popout-pill' + (isOpen ? ' shell-popout-pill--open' : '');
    if (!isOpen) {
      pill.type = 'button';
      pill.title = 'Open ' + label + ' (' + side + ' popout)';
      pill.innerHTML =
        '<span class="shell-popout-pill-icon">' + icon + '</span>' +      /* icon markup from pageIconForId — trusted */
        '<span class="shell-popout-pill-label">' + escHtml(label) + '</span>';
      pill.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        togglePopout(side, true);
      });
    } else {
      const wideBtn = document.createElement('button');
      wideBtn.type = 'button';
      wideBtn.className = 'shell-popout-tab shell-popout-tab--wide';
      wideBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setWide(side, !readState()[side + 'Wide']);
      });
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'shell-popout-tab shell-popout-tab--close';
      closeBtn.title = 'Close ' + label;
      closeBtn.innerHTML =
        '<span class="shell-popout-tab-icon">' + tabIcon('x-mark') + '</span>' +
        '<span class="shell-popout-tab-label">Close</span>';
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        togglePopout(side, false);
      });
      pill.appendChild(wideBtn);
      pill.appendChild(closeBtn);
    }
    pill.addEventListener('pointerdown', (e) => e.stopPropagation());
    root.appendChild(pill);

    if (!isOpen) { root.classList.remove('shell-popout--wide'); return; }
    refreshTabs(side);

    const handle = document.createElement('div');
    handle.className = 'shell-popout-resize shell-popout-resize--' + side;
    handle.title = 'Drag to resize';
    root.appendChild(handle);
    wireResize(side, handle, root);

    const header = document.createElement('div');
    header.className = 'shell-popout-header';
    header.innerHTML =
      '<div class="shell-popout-title">' +
      '  <span class="shell-popout-icon">' + icon + '</span>' +      /* trusted markup */
      '  <span>' + escHtml(label) + '</span>' +
      '</div>' +
      '<div class="shell-popout-actions">' +
      '  <select class="shell-popout-picker" title="Pick a page for this popout"></select>' +
      '  <button class="shell-popout-close" type="button" title="Close popout">' + ICON.svg('x-mark') + '</button>' +
      '</div>';
    root.appendChild(header);

    const iframe = document.createElement('iframe');
    iframe.className = 'shell-popout-frame';
    iframe.name = 'rm-shell-popout-' + side;
    iframe.src = embedHref(pageHrefForId(pageId) || '/rm/index.html');
    iframe.title = label;
    // V3.836 — a freshly loaded page learns the panel state (open/wide) at
    // once; it may also ask later via {type:'rm-popout-request', state:true}.
    iframe.addEventListener('load', () => postState(side));
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
    const allPages = allPagesList();

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
      const extra = wideExtra(side);   // V3.836 — wide panels drag over a shifted range
      const clamped = Math.max(MIN_POPOUT_WIDTH + extra, Math.min(MAX_POPOUT_WIDTH + extra, next));
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
      writeWidth(side, px - wideExtra(side));   // V3.836 — store the BASE width
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
    document.body.classList.toggle('rm-page-popouts', !!_opts.pageMode);
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
    wireMessages();                       // V3.836 — iframe bridge
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
    setWide: setWide,                     // V3.836
    readState: readState,
    writeState: writeState,
  };
})();
