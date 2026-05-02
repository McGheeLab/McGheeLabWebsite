/* item-explorer.js — flat, search-first item browser.
 *
 * Partners with the Category Explorer on activity-overview.html. That one
 * starts from categories and drills down; this one starts from a keyword
 * ("AACR", "cason", "pond") and pulls every matching item across all stores
 * into one flat list. Multi-select any subset and bulk-retag them to a single
 * destination via /api/retag-item. No dialogs gate the action — the result
 * surfaces with a toast (match the Category Explorer's cxUndoable pattern
 * without duplicating it here; item-explorer is lean on purpose).
 */
(function () {
  const IX = {
    q: '',
    kind: '',                 // '' = all kinds; 'task' | 'activity' | 'email' | 'event'
    items: [],
    truncated: false,
    selected: new Map(),       // key "kind|id" → full item object (used for destination retag)
    loading: false,
    debounce: null,
    lastRequestedQ: null,
    // Inline-expansion state. `expanded` is the set of item keys currently
    // showing a full-detail panel; `detailCache` memoizes /api/item-detail
    // responses so re-expanding the same item is free.
    expanded: new Set(),
    detailCache: new Map(),    // key → {state:'loading'|'ok'|'err', detail?, error?}
  };

  const CAT_COLOR = (window.YR_SHARED?.CAT_COLOR) || {
    service: '#5b21b6', research: '#1e40af', teaching: '#92400e',
    admin: '#374151', personal: '#991b1b', noise: '#64748b', unknown: '#78350f',
  };

  function key(it) { return `${it.kind}\u00A7${it.id}`; }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // Highlight every substring hit of `q` inside `text` so the user can
  // instantly see why a result surfaced. Case-insensitive; returns safe HTML.
  function highlight(text, q) {
    const s = String(text || '');
    if (!q) return escapeHtml(s);
    const low = s.toLowerCase();
    const qLow = q.toLowerCase();
    let out = '';
    let i = 0;
    while (i < s.length) {
      const j = low.indexOf(qLow, i);
      if (j === -1) { out += escapeHtml(s.slice(i)); break; }
      out += escapeHtml(s.slice(i, j));
      out += `<span class="ix-hit">${escapeHtml(s.slice(j, j + q.length))}</span>`;
      i = j + q.length;
    }
    return out;
  }

  async function runSearch(q) {
    IX.loading = true;
    IX.lastRequestedQ = q;
    const countsEl = document.getElementById('ix-counts');
    if (countsEl) countsEl.textContent = q ? 'searching…' : 'type to search';

    if (!q) {
      IX.items = [];
      IX.truncated = false;
      IX.loading = false;
      render();
      return;
    }
    try {
      const res = await fetch(`/api/item-search?q=${encodeURIComponent(q)}&limit=500`);
      const j = await res.json();
      // Drop the response if the user has typed more since we dispatched —
      // otherwise stale results can flicker on top of the current query.
      if (IX.lastRequestedQ !== q) return;
      IX.items = j.items || [];
      IX.truncated = !!j.truncated;
    } catch (e) {
      if (countsEl) countsEl.textContent = `error: ${e.message || e}`;
      IX.items = [];
      IX.truncated = false;
    } finally {
      IX.loading = false;
      render();
    }
  }

  function render() {
    const list = document.getElementById('ix-list');
    const countsEl = document.getElementById('ix-counts');
    if (!list || !countsEl) return;

    const visible = IX.kind
      ? IX.items.filter(it => it.kind === IX.kind)
      : IX.items;

    if (!IX.q) {
      list.innerHTML = '<div class="ix-empty">Start typing above to search across every task, activity, email, and event.<br><br>Example: <code>AACR</code>, <code>cason</code>, <code>r01</code>, <code>f25</code></div>';
      countsEl.textContent = 'type to search';
      renderBulkbar();
      return;
    }
    if (IX.loading) {
      countsEl.textContent = 'searching…';
      return;
    }
    if (!visible.length) {
      list.innerHTML = `<div class="ix-empty">No items matched <strong>${escapeHtml(IX.q)}</strong>${IX.kind ? ` in kind: <strong>${IX.kind}</strong>` : ''}.</div>`;
      countsEl.textContent = '0 items';
      renderBulkbar();
      return;
    }

    list.innerHTML = '';
    for (const it of visible) list.appendChild(renderItem(it));

    const total = IX.items.length;
    const kindPart = IX.kind ? ` (${visible.length} ${IX.kind})` : '';
    countsEl.textContent = IX.truncated
      ? `${total} items${kindPart} — truncated at 500, refine your query`
      : `${total} items${kindPart}`;

    renderBulkbar();
  }

  function renderItem(it) {
    const k = key(it);
    const isSelected = IX.selected.has(k);
    const isExpanded = IX.expanded.has(k);
    const color = CAT_COLOR[it.category] || '#6b7280';

    // Wrapper holds the row + (when expanded) the detail panel. Returned to
    // the caller so the list-level loop stays a one-liner.
    const wrap = document.createElement('div');
    wrap.className = 'ix-item-wrap';
    wrap.dataset.key = k;

    const row = document.createElement('div');
    row.className = 'ix-item' + (isSelected ? ' row-selected' : '');
    row.style.setProperty('--cat-color', color);
    row.dataset.key = k;
    // Clicking the row toggles selection. The chevron and checkbox stop
    // propagation so they don't double-fire selection/expand.
    row.addEventListener('click', (ev) => {
      if (ev.target.tagName === 'INPUT' || ev.target.classList.contains('ix-item-chev')) return;
      toggleSelect(it, !isSelected);
    });

    const chev = document.createElement('button');
    chev.type = 'button';
    chev.className = 'ix-item-chev' + (isExpanded ? ' open' : '');
    chev.textContent = isExpanded ? '▾' : '▸';
    chev.title = isExpanded ? 'Collapse details' : 'Expand to read full content';
    chev.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleExpand(it);
    });
    row.appendChild(chev);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'ix-item-check';
    cb.checked = isSelected;
    cb.addEventListener('click', (ev) => ev.stopPropagation());
    cb.addEventListener('change', () => toggleSelect(it, cb.checked));
    row.appendChild(cb);

    const kind = document.createElement('div');
    kind.className = `ix-item-kind ${it.kind}`;
    kind.textContent = it.kind;
    row.appendChild(kind);

    const when = document.createElement('div');
    when.className = 'ix-item-when';
    when.textContent = (it.when || '').slice(0, 10);
    row.appendChild(when);

    const body = document.createElement('div');
    body.className = 'ix-item-body';
    const title = document.createElement('div');
    title.className = 'ix-item-title';
    title.title = it.title || '';
    title.innerHTML = highlight(it.title || '(no title)', IX.q);
    body.appendChild(title);
    if (it.description) {
      const desc = document.createElement('div');
      desc.className = 'ix-item-desc';
      desc.innerHTML = highlight(it.description, IX.q);
      body.appendChild(desc);
    }
    row.appendChild(body);

    const extra = document.createElement('div');
    extra.className = 'ix-item-extra';
    extra.title = it.extra || '';
    extra.innerHTML = highlight(it.extra || '', IX.q);
    row.appendChild(extra);

    const idCol = document.createElement('div');
    idCol.className = 'ix-item-when';
    idCol.textContent = (it.id || '').slice(0, 10) + ((it.id || '').length > 10 ? '…' : '');
    idCol.title = it.id || '';
    idCol.style.textAlign = 'right';
    row.appendChild(idCol);

    // Source path ribbon — spans the full width and carries the category
    // color so drift is obvious when scanning many results.
    const path = document.createElement('div');
    path.className = 'ix-item-path';
    path.style.setProperty('--cat-color', color);
    const cat = escapeHtml(it.category || '—');
    const sub = escapeHtml(it.sub_category || '(no sub-category)');
    path.innerHTML = `<strong>${cat}</strong> ${sub}`;
    row.appendChild(path);

    wrap.appendChild(row);
    if (isExpanded) wrap.appendChild(buildDetailPanel(it));

    return wrap;
  }

  // ---- Inline detail expansion -----------------------------------------
  // Toggles a per-row detail panel that fetches /api/item-detail on first
  // open, then memoizes the response so subsequent opens are instant. Only
  // the affected row is re-rendered — the rest of the list stays put so the
  // user doesn't lose their scroll position while reading.

  function toggleExpand(it) {
    const k = key(it);
    if (IX.expanded.has(k)) {
      IX.expanded.delete(k);
    } else {
      IX.expanded.add(k);
      if (!IX.detailCache.has(k)) {
        IX.detailCache.set(k, { state: 'loading' });
        fetchDetail(it);
      }
    }
    rerenderRow(it);
  }

  async function fetchDetail(it) {
    const k = key(it);
    try {
      const res = await fetch(`/api/item-detail?kind=${encodeURIComponent(it.kind)}&id=${encodeURIComponent(it.id)}`);
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      IX.detailCache.set(k, { state: 'ok', detail: j.detail });
    } catch (e) {
      IX.detailCache.set(k, { state: 'err', error: e.message || String(e) });
    }
    if (IX.expanded.has(k)) rerenderRow(it);
  }

  function rerenderRow(it) {
    const k = key(it);
    const old = document.querySelector(`.ix-item-wrap[data-key="${CSS.escape(k)}"]`);
    if (!old) return;
    old.replaceWith(renderItem(it));
  }

  function buildDetailPanel(it) {
    const k = key(it);
    const panel = document.createElement('div');
    panel.className = 'ix-item-detail';
    const cached = IX.detailCache.get(k);
    if (!cached || cached.state === 'loading') {
      panel.innerHTML = '<div class="ix-detail-loading">Loading…</div>';
      return panel;
    }
    if (cached.state === 'err') {
      panel.innerHTML = `<div class="ix-detail-err">Failed to load details: ${escapeHtml(cached.error)}</div>`;
      return panel;
    }
    if (window.EXPLORER_DETAIL) {
      panel.appendChild(window.EXPLORER_DETAIL.render(it.kind, cached.detail, {
        onTaskChange: () => rerenderRow(it),
      }));
    } else {
      // Module not loaded — surface raw JSON so the user still sees content.
      const pre = document.createElement('pre');
      pre.className = 'expdet-text';
      pre.textContent = JSON.stringify(cached.detail, null, 2);
      panel.appendChild(pre);
    }
    return panel;
  }

  function toggleSelect(it, on) {
    const k = key(it);
    if (on) IX.selected.set(k, it); else IX.selected.delete(k);
    // Update the row in place without re-rendering the whole list so scroll
    // position stays put while building a large selection.
    const row = document.querySelector(`.ix-item[data-key="${CSS.escape(k)}"]`);
    if (row) {
      row.classList.toggle('row-selected', on);
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = on;
    }
    renderBulkbar();
  }

  function renderBulkbar() {
    const bar = document.getElementById('ix-bulkbar');
    if (!bar) return;
    const n = IX.selected.size;
    if (n === 0) {
      bar.style.display = 'none';
      bar.innerHTML = '';
      return;
    }
    bar.style.display = 'flex';
    bar.innerHTML = '';

    const count = document.createElement('span');
    count.innerHTML = `<strong>${n}</strong> item${n === 1 ? '' : 's'} selected`;
    bar.appendChild(count);

    // Quick breakdown by kind so the user sees what's in the selection.
    const byKind = {};
    for (const it of IX.selected.values()) byKind[it.kind] = (byKind[it.kind] || 0) + 1;
    const kinds = Object.keys(byKind).sort().map(k => `${byKind[k]} ${k}${byKind[k] === 1 ? '' : 's'}`).join(' · ');
    const kindsEl = document.createElement('span');
    kindsEl.style.cssText = 'font-size:11.5px;color:#1e3a8a;opacity:.85;margin-left:10px';
    kindsEl.textContent = '— ' + kinds;
    bar.appendChild(kindsEl);

    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    bar.appendChild(spacer);

    const mergeBtn = document.createElement('button');
    mergeBtn.className = 'btn btn-sm btn-primary';
    mergeBtn.textContent = 'Merge into\u2026';
    mergeBtn.addEventListener('click', openDestinationPicker);
    bar.appendChild(mergeBtn);

    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn btn-sm';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => {
      IX.selected.clear();
      render();
    });
    bar.appendChild(clearBtn);
  }

  // Destination picker modal. Reuses YR_SHARED.renderPicker so the category
  // chip + drill-down + search UX matches everywhere else in the app.
  function openDestinationPicker() {
    const srcItems = Array.from(IX.selected.values());
    if (!srcItems.length) return;

    const back = document.createElement('div');
    back.className = 'ix-dialog-back';
    const dlg = document.createElement('div');
    dlg.className = 'ix-dialog';

    const header = document.createElement('h3');
    header.textContent = `Merge ${srcItems.length} item${srcItems.length === 1 ? '' : 's'} into…`;
    dlg.appendChild(header);

    const body = document.createElement('div');
    body.className = 'ix-dialog-body';

    // Pre-seed the picker with the first item's current (cat, sub) so the
    // common "fix a typo at the same path" case is 2 clicks away.
    const seed = srcItems[0];
    const picker = window.YR_SHARED.renderPicker({
      ctx: { category: seed.category || '', sub_category: seed.sub_category || '' },
      tree: {},       // filled below
      counts: {},
      mode: 'full',
      mruKey: 'item-explorer',
    });
    body.appendChild(picker);

    // Preview line so the destination isn't a mystery until click.
    const preview = document.createElement('div');
    preview.className = 'ix-preview';
    const updatePreview = () => {
      const r = window.YR_SHARED.getPickerResult(picker);
      const cat = r.category || '—';
      const sub = r.sub_category || '(no sub-category)';
      preview.innerHTML = `<strong>Destination:</strong> ${escapeHtml(cat)} / ${escapeHtml(sub)}`
        + ` &nbsp;·&nbsp; <strong>${srcItems.length}</strong> item${srcItems.length === 1 ? '' : 's'} will be retagged.`;
    };
    updatePreview();
    picker.addEventListener('click', updatePreview);
    picker.addEventListener('input', updatePreview);
    body.appendChild(preview);

    dlg.appendChild(body);

    const foot = document.createElement('div');
    foot.className = 'ix-dialog-foot';
    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => back.remove());
    const spacer = document.createElement('div'); spacer.className = 'spacer';
    const go = document.createElement('button');
    go.className = 'btn btn-primary';
    go.textContent = `Merge ${srcItems.length}`;
    go.addEventListener('click', async () => {
      const r = window.YR_SHARED.getPickerResult(picker);
      if (!r.category) {
        preview.innerHTML = '<span style="color:#dc2626">Pick a destination category first.</span>';
        return;
      }
      go.disabled = true; cancel.disabled = true;
      go.textContent = 'Merging…';
      const { moved, failed } = await mergeItems(srcItems, r.category || '', r.sub_category || '');
      back.remove();
      renderToast(
        failed ? `Merged ${moved} items (${failed} failed).` : `Merged ${moved} items → ${r.category}${r.sub_category ? ':' + r.sub_category : ''}`,
        failed ? 'warn' : 'info',
      );
      // Drop moved items from the selection AND the results list (they
      // probably no longer match the query in their new home).
      IX.selected.clear();
      // Cheap: re-run the current search to refresh the results.
      runSearch(IX.q);
    });

    foot.appendChild(cancel); foot.appendChild(spacer); foot.appendChild(go);
    dlg.appendChild(foot);
    back.appendChild(dlg);
    document.body.appendChild(back);
    back.addEventListener('click', (ev) => { if (ev.target === back) back.remove(); });
  }

  async function mergeItems(items, toCategory, toSub) {
    let moved = 0, failed = 0;
    for (const it of items) {
      try {
        const res = await fetch('/api/retag-item', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: it.kind, id: it.id,
            category: toCategory, sub_category: toSub || '',
          }),
        });
        const j = await res.json();
        if (j.ok && j.updated) moved++; else failed++;
      } catch { failed++; }
    }
    return { moved, failed };
  }

  // Minimal top-right toast — no undo here (the Category Explorer has the
  // heavy version). For the Item Explorer, running the search again after
  // a merge is the natural way to inspect results.
  function renderToast(msg, kind = 'info') {
    let host = document.getElementById('ix-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'ix-toast-host';
      host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:6px;pointer-events:none';
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    const bg = kind === 'error' ? '#dc2626' : kind === 'warn' ? '#d97706' : '#16a34a';
    t.style.cssText = `background:${bg};color:#fff;padding:8px 14px;border-radius:6px;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,.15);max-width:360px`;
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .25s'; t.style.opacity = '0'; }, 2800);
    setTimeout(() => t.remove(), 3100);
  }

  function wire() {
    const input = document.getElementById('ix-search');
    input.addEventListener('input', () => {
      IX.q = input.value.trim();
      clearTimeout(IX.debounce);
      // 200ms debounce keeps the server endpoint from getting a POST per
      // keystroke; feels responsive for most typing speeds.
      IX.debounce = setTimeout(() => runSearch(IX.q), 200);
    });
    // Enter fires immediately — power users who know the exact query
    // shouldn't have to wait for the debounce.
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        clearTimeout(IX.debounce);
        runSearch(IX.q);
      }
    });

    const kindBar = document.getElementById('ix-kind-filter');
    kindBar.addEventListener('click', (ev) => {
      if (ev.target.tagName !== 'BUTTON') return;
      IX.kind = ev.target.dataset.kind || '';
      for (const b of kindBar.querySelectorAll('button')) {
        b.classList.toggle('active', b.dataset.kind === IX.kind);
      }
      render();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    wire();
    render();  // initial empty state
  });
})();
