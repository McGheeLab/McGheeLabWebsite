/* nav-palette.js — V3.809 "Go to…" command palette.
 *
 * Lazy-loaded by nav.js on the first ⌘K / Ctrl+K / "/" / click of the
 * Go to… button (and prefetched on idle). nav.js hands over everything
 * page-specific in the `ctx` object passed to open(), so this file is
 * DOM + search only:
 *
 *   ctx.pageMap          Map<pageId, {id,label,href,group,gate,icon}>  (NAV_ITEMS)
 *   ctx.descriptions     { pageId: blurb }
 *   ctx.currentPageId    the page the browser is on, or null
 *   ctx.allowed(p)       gate + access check for one page entry
 *   ctx.pins             NavPins  (effective(), has(), toggle())
 *   ctx.recents          NavRecents (list())
 *   ctx.workflowState    active workflow state or null
 *   ctx.workflowPageIds  ids currently shown as workflow chips
 *   ctx.onShell / ctx.onSplit / ctx.isMac
 *   ctx.loadWorkflows()  → Promise<{defaults:[], customs:[]}>
 *   ctx.navigate(p, newTab)        open a page
 *   ctx.addToWorkflow(pageId)      mode 'add'
 *   ctx.switchWorkflow(wf, kind)   a workflow row was chosen
 *   ctx.mode             'go' (default) | 'add'  (add a page to the workflow)
 *   ctx.hint             'pin' — opened from the + chip; footer says how
 *
 * Keyboard: ↑ ↓ move, Enter opens, ⌘/Ctrl+Enter opens in a new tab,
 * Esc closes. The star on a row pins/unpins without closing. */
(function () {
  'use strict';

  let _ctx = null;
  let _root = null, _input = null, _list = null, _foot = null, _hint = null;
  let _rows = [];          // flat list of renderable items, in DOM order
  let _sel = 0;
  let _workflows = null;   // {defaults, customs} once loaded
  let _lastQuery = '';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function icon(name, opts) {
    return (window.ICON && ICON.svg) ? ICON.svg(name, opts) : '';
  }
  function renderIcon(value) {
    return (window.ICON && ICON.render) ? ICON.render(value) : esc(value);
  }

  /* ── DOM ── */
  function build() {
    if (_root) return;
    _root = document.createElement('div');
    _root.className = 'nav-palette-back';
    _root.innerHTML =
      '<div class="nav-palette" role="dialog" aria-modal="true" aria-label="Go to a page">' +
      '  <div class="nav-palette-head">' +
      '    <span class="nav-palette-head-icon">' + icon('magnifying-glass') + '</span>' +
      '    <input type="text" class="nav-palette-input" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Go to a page…">' +
      '    <span class="nav-palette-mode" hidden></span>' +
      '  </div>' +
      '  <div class="nav-palette-list" role="listbox"></div>' +
      '  <div class="nav-palette-hint" hidden></div>' +
      '  <div class="nav-palette-foot">' +
      '    <span><kbd>↑</kbd><kbd>↓</kbd> move</span>' +
      '    <span><kbd>↵</kbd> open</span>' +
      '    <span class="nav-palette-foot-newtab"><kbd>⌘</kbd><kbd>↵</kbd> new tab</span>' +
      '    <span><kbd>esc</kbd> close</span>' +
      '    <span class="nav-palette-foot-star">' + icon('star') + ' pin / unpin</span>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(_root);
    _input = _root.querySelector('.nav-palette-input');
    _list  = _root.querySelector('.nav-palette-list');
    _foot  = _root.querySelector('.nav-palette-foot');
    _hint  = _root.querySelector('.nav-palette-hint');

    _root.addEventListener('mousedown', (e) => { if (e.target === _root) close(); });
    _input.addEventListener('input', () => render(_input.value));
    _input.addEventListener('keydown', onKey);
    _list.addEventListener('click', (e) => {
      const star = e.target.closest('.nav-palette-star');
      if (star) {
        e.preventDefault(); e.stopPropagation();
        const row = star.closest('.nav-palette-row');
        const item = row && _rows[Number(row.dataset.idx)];
        if (item && item.kind === 'page') {
          _ctx.pins.toggle(item.id);
          render(_input.value, Number(row.dataset.idx));
        }
        return;
      }
      const row = e.target.closest('.nav-palette-row');
      if (!row) return;
      e.preventDefault();
      choose(_rows[Number(row.dataset.idx)], e.metaKey || e.ctrlKey);
    });
    _list.addEventListener('mousemove', (e) => {
      const row = e.target.closest('.nav-palette-row');
      if (!row) return;
      const i = Number(row.dataset.idx);
      if (i !== _sel) { _sel = i; paintSelection(false); }
    });
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(_rows[_sel], e.metaKey || e.ctrlKey); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') { e.preventDefault(); move(e.shiftKey ? -1 : 1); }
  }
  function move(d) {
    if (!_rows.length) return;
    _sel = (_sel + d + _rows.length) % _rows.length;
    paintSelection(true);
  }
  function paintSelection(scroll) {
    _list.querySelectorAll('.nav-palette-row').forEach(r => {
      const on = Number(r.dataset.idx) === _sel;
      r.classList.toggle('selected', on);
      r.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on && scroll && r.scrollIntoView) r.scrollIntoView({ block: 'nearest' });
    });
  }

  /* ── Search ── */

  /* 100 prefix · 80 word start · 60 substring · 20+ subsequence · -1 none.
   * Subsequence matching is only sane on SHORT text (a label): on a blurb
   * almost any four letters are a subsequence of something, which made
   * "note" surface Teaching via "pla(n)ning + (o)u(t)lin(e)s". */
  function scoreText(q, text, allowSubseq) {
    if (!text) return -1;
    const t = String(text).toLowerCase();
    if (!q) return 0;
    if (t.indexOf(q) === 0) return 100;
    if ((' ' + t).indexOf(' ' + q) >= 0) return 80;
    const sub = t.indexOf(q);
    if (sub >= 0) return 60 - Math.min(20, sub / 4);
    if (!allowSubseq) return -1;
    // subsequence, rewarding tight spans
    let i = 0, first = -1, last = -1;
    for (let j = 0; j < t.length && i < q.length; j++) {
      if (t[j] === q[i]) { if (first < 0) first = j; last = j; i++; }
    }
    if (i < q.length) return -1;
    const span = last - first + 1;
    return Math.max(5, 30 - (span - q.length));
  }
  function scorePage(q, p) {
    const desc = (_ctx.descriptions && _ctx.descriptions[p.id]) || '';
    const s = Math.max(
      scoreText(q, p.label, true),
      scoreText(q, p.group, false) * 0.5,
      scoreText(q, desc, false) * 0.45,
      scoreText(q, p.id.replace(/__tab__/g, ' ').replace(/-/g, ' '), true) * 0.6
    );
    return s;
  }

  function allowedPages() {
    const out = [];
    _ctx.pageMap.forEach(p => {
      if (p.id === 'dashboard') return;              // the brand is Home
      if (_ctx.onSplit && p.id === 'split-view') return;
      if (!_ctx.allowed(p)) return;
      out.push(p);
    });
    return out;
  }

  function pageItem(p, meta) {
    return { kind: 'page', id: p.id, page: p, label: p.label, group: p.group,
             icon: p.icon || 'document-text',
             desc: (_ctx.descriptions && _ctx.descriptions[p.id]) || '', meta: meta || '' };
  }
  function workflowItem(w, kind) {
    const n = (w.pageIds || []).length;
    return { kind: 'workflow', id: w.id, wf: w, wfKind: kind, label: w.label || w.id,
             group: kind === 'custom' ? 'My workflow' : 'Workflow',
             icon: w.icon || (kind === 'custom' ? 'star' : 'rectangle-stack'),
             desc: w.description || '', meta: n + ' page' + (n === 1 ? '' : 's') };
  }
  function ago(ms) {
    if (!ms) return '';
    const d = Date.now() - ms;
    if (d < 3600000) return Math.max(1, Math.round(d / 60000)) + 'm ago';
    if (d < 86400000) return Math.round(d / 3600000) + 'h ago';
    const days = Math.round(d / 86400000);
    return days === 1 ? 'yesterday' : days + 'd ago';
  }

  /* Empty query → curated sections. Query → one ranked list. */
  function render(q, keepSel) {
    q = String(q || '').trim().toLowerCase();
    _lastQuery = q;
    const pages = allowedPages();
    const byId = new Map(pages.map(p => [p.id, p]));
    const sections = [];
    const isAdd = _ctx.mode === 'add';

    if (!q) {
      if (isAdd) {
        const inWf = new Set(_ctx.workflowPageIds || []);
        const groups = groupPages(pages.filter(p => !inWf.has(p.id)));
        groups.forEach(g => sections.push(g));
      } else {
        const pinned = _ctx.pins.effective().map(id => byId.get(id)).filter(Boolean);
        if (pinned.length) sections.push({ title: 'Pinned', items: pinned.map(p => pageItem(p, 'pinned')) });
        const pinSet = new Set(pinned.map(p => p.id));
        const recent = _ctx.recents.list().map(r => ({ p: byId.get(r.id), r }))
          .filter(x => x.p && !pinSet.has(x.p.id)).slice(0, 8);
        if (recent.length) sections.push({ title: 'Recent', items: recent.map(x => pageItem(x.p, ago(x.r.last))) });
        if (_ctx.workflowState && (_ctx.workflowPageIds || []).length) {
          const wfPages = _ctx.workflowPageIds.map(id => byId.get(id)).filter(Boolean);
          if (wfPages.length) sections.push({ title: 'This workflow', items: wfPages.map(p => pageItem(p, '')) });
        }
        if (_workflows) {
          const items = _workflows.defaults.map(w => workflowItem(w, 'default'))
            .concat(_workflows.customs.map(w => workflowItem(w, 'custom')));
          if (items.length) sections.push({ title: 'Workflows', items });
        }
        groupPages(pages).forEach(g => sections.push(g));
      }
    } else {
      const scored = [];
      const inWf = new Set(_ctx.workflowPageIds || []);
      pages.forEach(p => {
        if (isAdd && inWf.has(p.id)) return;
        const s = scorePage(q, p);
        if (s > 0) {
          const bonus = _ctx.pins.has(p.id) ? 6 : 0;
          scored.push({ s: s + bonus, item: pageItem(p, _ctx.pins.has(p.id) ? 'pinned' : '') });
        }
      });
      if (!isAdd && _workflows) {
        _workflows.defaults.forEach(w => {
          const s = Math.max(scoreText(q, w.label, true), scoreText(q, w.description, false) * 0.4);
          if (s > 0) scored.push({ s: s * 0.95, item: workflowItem(w, 'default') });
        });
        _workflows.customs.forEach(w => {
          const s = Math.max(scoreText(q, w.label, true), scoreText(q, w.description, false) * 0.4);
          if (s > 0) scored.push({ s: s * 0.95, item: workflowItem(w, 'custom') });
        });
      }
      scored.sort((a, b) => b.s - a.s || a.item.label.localeCompare(b.item.label));
      sections.push({ title: '', items: scored.slice(0, 40).map(x => x.item) });
    }

    // Paint
    _rows = [];
    const html = [];
    sections.forEach(sec => {
      if (!sec.items.length) return;
      if (sec.title) html.push('<div class="nav-palette-section">' + esc(sec.title) + '</div>');
      sec.items.forEach(it => {
        const idx = _rows.length;
        _rows.push(it);
        const isCur = it.kind === 'page' && it.id === _ctx.currentPageId;
        const pinned = it.kind === 'page' && _ctx.pins.has(it.id);
        html.push(
          '<div class="nav-palette-row' + (isCur ? ' is-current' : '') + '" role="option" data-idx="' + idx + '" aria-selected="false">' +
          '  <span class="nav-palette-row-icon">' + renderIcon(it.icon) + '</span>' +
          '  <span class="nav-palette-row-main">' +
          '    <span class="nav-palette-row-label">' + esc(it.label) +
                 (isCur ? ' <span class="nav-palette-row-cur">you are here</span>' : '') + '</span>' +
          '    <span class="nav-palette-row-sub">' + esc(it.group) + (it.desc ? ' · ' + esc(it.desc) : '') + '</span>' +
          '  </span>' +
          (it.meta ? '  <span class="nav-palette-row-meta">' + esc(it.meta) + '</span>' : '') +
          (it.kind === 'page' && !isAdd
            ? '  <button type="button" class="nav-palette-star' + (pinned ? ' on' : '') + '" tabindex="-1" title="' + (pinned ? 'Unpin' : (isCur ? 'Pin this page to the bar' : 'Pin to the bar')) + '">'
              + icon('star', { variant: pinned ? 'solid' : 'outline' }) + '</button>'
            : '') +
          '</div>');
      });
    });
    if (!_rows.length) {
      html.push('<div class="nav-palette-empty">' +
        (q ? 'Nothing matches “' + esc(q) + '”.' : (isAdd ? 'Every page you can open is already in this workflow.' : 'No pages available.')) +
        '</div>');
    }
    _list.innerHTML = html.join('');
    _sel = (typeof keepSel === 'number' && keepSel < _rows.length) ? keepSel : 0;
    paintSelection(false);
  }

  /* Group pages by NAV section, in NAV_ITEMS order (Map insertion order). */
  function groupPages(pages) {
    const order = [];
    const byGroup = new Map();
    pages.forEach(p => {
      const g = p.group || 'Other';
      if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
      byGroup.get(g).push(pageItem(p, ''));
    });
    return order.map(g => ({ title: g, items: byGroup.get(g) }));
  }

  /* ── Choose ── */
  function choose(item, newTab) {
    if (!item) return;
    if (item.kind === 'workflow') {
      close();
      _ctx.switchWorkflow(item.wf, item.wfKind);
      return;
    }
    if (_ctx.mode === 'add') {
      close();
      _ctx.addToWorkflow(item.id);
      return;
    }
    close();
    _ctx.navigate(item.page, !!newTab);
  }

  /* ── Open / close ── */
  function open(ctx) {
    if (!ctx || !ctx.pageMap) return;
    _ctx = ctx;
    _ctx.mode = ctx.mode === 'add' ? 'add' : 'go';
    build();
    _workflows = null;
    const modeEl = _root.querySelector('.nav-palette-mode');
    if (_ctx.mode === 'add') {
      _input.placeholder = 'Add a page to this workflow…';
      modeEl.textContent = 'Add to workflow';
      modeEl.hidden = false;
    } else {
      _input.placeholder = 'Go to a page…  (type to search)';
      modeEl.hidden = true;
    }
    _root.querySelector('.nav-palette-foot-newtab').innerHTML =
      '<kbd>' + (_ctx.isMac ? '⌘' : 'Ctrl') + '</kbd><kbd>↵</kbd> new tab';
    _root.querySelector('.nav-palette-foot-star').hidden = (_ctx.mode === 'add');
    if (_ctx.hint === 'pin') {
      _hint.innerHTML = icon('star') + ' Star a page here and it stays in your bar, on every device.';
      _hint.hidden = false;
    } else {
      _hint.hidden = true;
    }
    _input.value = '';
    _root.classList.add('open');
    document.body.classList.add('nav-palette-open');
    render('');
    _input.focus();
    if (_ctx.mode === 'go' && typeof _ctx.loadWorkflows === 'function') {
      _ctx.loadWorkflows().then(w => {
        if (!isOpen() || !w) return;
        _workflows = w;
        render(_input.value, _sel);
      }).catch(() => {});
    }
  }
  function close() {
    if (!_root) return;
    _root.classList.remove('open');
    document.body.classList.remove('nav-palette-open');
  }
  function isOpen() { return !!(_root && _root.classList.contains('open')); }

  window.NavPalette = { open: open, close: close, isOpen: isOpen,
    /* exposed for tests */ _scoreText: scoreText };
})();
