/* tasks-archive-buckets.js — Completed Tasks page.
 *
 * Same look as the Task List (category filter chips, search, sort, flat list)
 * but filters to done==true and adds a top "Recently completed" section
 * grouped by Today / This week / This month / This year.
 */

(function () {
  const DATA_PATH = 'tasks/buckets.json';
  const YR = window.YR_SHARED || {};
  const CAT_COLOR = YR.CAT_COLOR || {};
  const escapeHtml = YR.escapeHtml || (s => String(s || ''));

  const SORT_KEY = 'tasksCompleted.sort';
  const HIDDEN_CATS_KEY = 'tasksCompleted.hiddenCategories';
  const PRI_ORDER = { urgent: 4, high: 3, normal: 2, low: 1 };
  const CAT_ORDER = (YR.CAT_ORDER) || ['research', 'teaching', 'service', 'admin', 'personal', 'noise', 'unknown'];
  const CAT_LABEL = YR.CAT_LABEL || {};

  const state = {
    doc: null,
    sort: localStorage.getItem(SORT_KEY) || 'done',  // done | priority | hours | project
    query: '',
    hiddenCats: new Set(JSON.parse(localStorage.getItem(HIDDEN_CATS_KEY) || '[]')),
    expanded: new Set(),
    saveTimer: null,
  };
  function persistHiddenCats() {
    localStorage.setItem(HIDDEN_CATS_KEY, JSON.stringify([...state.hiddenCats]));
  }

  /* ---------- io (multi-tenant via api adapter, live via Firestore) ---------- */
  var _suppressUntil = 0;
  var _liveUnsub = null;
  var _pendingDoc = null;
  var _savePending = false;

  async function loadDoc() {
    state.doc = await api.load(DATA_PATH);
    if (!state.doc.projects) state.doc.projects = [];
  }
  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    _savePending = true;
    state.saveTimer = setTimeout(() => saveDoc().catch(err => console.error('save failed', err)), 400);
  }
  async function saveDoc() {
    state.doc.updated_at = new Date().toISOString();
    _suppressUntil = Date.now() + 2500;
    state.saveTimer = null;
    try {
      await api.save(DATA_PATH, state.doc);
      _savePending = false;
    } catch (err) {
      console.error('[tasks-archive-buckets] save failed:', err);
      throw err;
    }
  }
  function attachLiveSync() {
    if (_liveUnsub || typeof api.subscribe !== 'function') return;
    try {
      _liveUnsub = api.subscribe(DATA_PATH, function (data) {
        if (Date.now() < _suppressUntil) return;
        if (_savePending) return;
        if (!data || !Array.isArray(data.projects)) return;
        if (state.expanded && state.expanded.size > 0) {
          _pendingDoc = data;
          return;
        }
        state.doc = data;
        render();
      });
    } catch (err) {
      console.warn('[tasks-archive-buckets] live sync failed to attach:', err.message);
    }
  }

  /* ---------- helpers ---------- */
  function sumHours(node) {
    let h = Number(node.hours_estimate) || 0;
    for (const c of node.children || []) h += sumHours(c);
    return h;
  }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  function buildFlat() {
    const out = [];
    for (const p of state.doc.projects || []) {
      for (const b of p.buckets || []) {
        function walk(arr, parentPath) {
          for (const st of arr || []) {
            out.push({ subtask: st, project: p, bucket: b, parentPath });
            if ((st.children || []).length) walk(st.children, parentPath.concat(st.text));
          }
        }
        walk(b.subtasks, []);
      }
    }
    return out;
  }

  function applyFilter(rows) {
    const q = state.query.toLowerCase();
    return rows.filter(r => {
      if (!r.subtask.done) return false;
      const cat = r.bucket.category || 'unknown';
      if (state.hiddenCats.has(cat)) return false;
      if (!q) return true;
      const hay = [
        r.subtask.text, r.subtask.description, r.subtask.notes,
        r.project.title, r.bucket.title, r.bucket.sub_category,
      ].map(s => String(s || '').toLowerCase()).join(' ');
      return hay.includes(q);
    });
  }

  function applySort(rows) {
    const cmp = {
      done:     (a, b) => String(b.subtask.done_at || '').localeCompare(String(a.subtask.done_at || '')),
      priority: (a, b) => (PRI_ORDER[b.subtask.priority] || 0) - (PRI_ORDER[a.subtask.priority] || 0),
      hours:    (a, b) => sumHours(b.subtask) - sumHours(a.subtask),
      project:  (a, b) => String(a.project.title).localeCompare(String(b.project.title)),
    };
    return rows.slice().sort(cmp[state.sort] || cmp.done);
  }

  /* Bucket a row into a recency window. Returns 'today' | 'week' | 'month' | 'year' | 'older'. */
  function recencyBucket(row, now) {
    const at = row.subtask.done_at;
    if (!at) return 'older';
    const d = new Date(at);
    if (isNaN(d)) return 'older';
    const today = startOfDay(now);
    const startThisWeek  = new Date(today); startThisWeek.setDate(today.getDate() - today.getDay()); // Sunday
    const startThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const startThisYear  = new Date(today.getFullYear(), 0, 1);
    if (d >= today)            return 'today';
    if (d >= startThisWeek)    return 'week';
    if (d >= startThisMonth)   return 'month';
    if (d >= startThisYear)    return 'year';
    return 'older';
  }

  /* ---------- rendering ---------- */
  const root = () => document.getElementById('content');

  function render() {
    const el = root();
    if (!el) return;
    el.innerHTML = '';
    el.appendChild(renderCategoryFilters());
    el.appendChild(renderToolbar());
    if (!state.query && state.sort === 'done') {
      el.appendChild(renderRecentSections());
    }
    el.appendChild(renderList());

    if (_pendingDoc && (!state.expanded || state.expanded.size === 0)) {
      const queued = _pendingDoc;
      _pendingDoc = null;
      state.doc = queued;
      el.innerHTML = '';
      el.appendChild(renderCategoryFilters());
      el.appendChild(renderToolbar());
      if (!state.query && state.sort === 'done') {
        el.appendChild(renderRecentSections());
      }
      el.appendChild(renderList());
    }
  }

  function renderCategoryFilters() {
    const bar = document.createElement('div');
    bar.className = 'inbox-cat-filters';
    const counts = {};
    for (const r of buildFlat()) {
      if (!r.subtask.done) continue;
      const c = r.bucket.category || 'unknown';
      counts[c] = (counts[c] || 0) + 1;
    }
    const cats = CAT_ORDER.filter(c => counts[c] > 0);
    for (const c of cats) {
      const chip = document.createElement('button');
      const off = state.hiddenCats.has(c);
      chip.className = `yr-cat-toggle cat-toggle-${c}` + (off ? ' off' : '');
      chip.innerHTML = `${escapeHtml(CAT_LABEL[c] || c)} <span style="opacity:.7;font-weight:500;margin-left:4px">${counts[c]}</span>`;
      chip.addEventListener('click', () => {
        if (state.hiddenCats.has(c)) state.hiddenCats.delete(c);
        else state.hiddenCats.add(c);
        persistHiddenCats();
        render();
      });
      bar.appendChild(chip);
    }
    if (state.hiddenCats.size) {
      const reset = document.createElement('button');
      reset.className = 'btn btn-sm';
      reset.textContent = 'All';
      reset.style.marginLeft = 'auto';
      reset.addEventListener('click', () => {
        state.hiddenCats = new Set();
        persistHiddenCats();
        render();
      });
      bar.appendChild(reset);
    }
    return bar;
  }

  function renderToolbar() {
    const bar = document.createElement('div');
    bar.className = 'inbox-toolbar';
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search completed tasks…';
    search.value = state.query;
    search.addEventListener('input', () => {
      state.query = search.value.trim();
      render();   // toggle recent-sections visibility based on query
    });
    bar.appendChild(search);

    const sort = document.createElement('select');
    sort.className = 'inbox-sort';
    for (const [val, label] of [
      ['done', 'most recently done'],
      ['priority', 'priority'],
      ['hours', 'hours'],
      ['project', 'project'],
    ]) {
      const o = document.createElement('option');
      o.value = val; o.textContent = `Sort: ${label}`;
      if (state.sort === val) o.selected = true;
      sort.appendChild(o);
    }
    sort.addEventListener('change', () => {
      state.sort = sort.value;
      localStorage.setItem(SORT_KEY, state.sort);
      render();
    });
    bar.appendChild(sort);
    return bar;
  }

  function renderRecentSections() {
    const wrap = document.createElement('div');
    wrap.className = 'recent-sections';
    const now = new Date();
    const groups = { today: [], week: [], month: [], year: [] };
    const rows = applySort(applyFilter(buildFlat()));
    for (const row of rows) {
      const b = recencyBucket(row, now);
      if (b === 'older') continue;
      groups[b].push(row);
    }
    const sections = [
      { id: 'today', label: 'Today',      rows: groups.today },
      { id: 'week',  label: 'This week',  rows: groups.week },
      { id: 'month', label: 'This month', rows: groups.month },
      { id: 'year',  label: 'This year',  rows: groups.year },
    ];
    let any = false;
    for (const s of sections) {
      if (!s.rows.length) continue;
      any = true;
      const sec = document.createElement('div');
      sec.className = 'recent-section';
      const head = document.createElement('div');
      head.className = 'recent-section-head';
      const totalH = s.rows.reduce((acc, r) => acc + sumHours(r.subtask), 0);
      head.innerHTML = `<strong>${s.label}</strong> <span class="recent-section-meta">${s.rows.length} task${s.rows.length===1?'':'s'}${totalH ? ' · ' + totalH.toFixed(1) + 'h' : ''}</span>`;
      sec.appendChild(head);
      const list = document.createElement('div');
      list.className = 'inbox-list';
      for (const r of s.rows.slice(0, 50)) list.appendChild(renderRow(r));
      if (s.rows.length > 50) {
        const more = document.createElement('div');
        more.className = 'inbox-empty';
        more.textContent = `…and ${s.rows.length - 50} more from ${s.label.toLowerCase()}`;
        list.appendChild(more);
      }
      sec.appendChild(list);
      wrap.appendChild(sec);
    }
    if (!any) {
      const p = document.createElement('div');
      p.className = 'inbox-empty';
      p.style.cssText = 'padding:14px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:14px';
      p.textContent = 'Nothing completed in the last year.';
      wrap.appendChild(p);
    }
    // Divider before the older / full list
    const div = document.createElement('div');
    div.className = 'recent-divider';
    div.textContent = 'Older';
    wrap.appendChild(div);
    return wrap;
  }

  function renderList() {
    const wrap = document.createElement('div');
    wrap.className = 'inbox-list';
    let rows = applySort(applyFilter(buildFlat()));
    // When the recent-sections panel is showing, only render OLDER rows down here.
    if (!state.query && state.sort === 'done') {
      const now = new Date();
      rows = rows.filter(r => recencyBucket(r, now) === 'older');
    }
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'inbox-empty';
      empty.textContent = state.query ? `No completed tasks match "${state.query}".` : 'Nothing older.';
      wrap.appendChild(empty);
      return wrap;
    }
    for (const row of rows.slice(0, 1000)) wrap.appendChild(renderRow(row));
    if (rows.length > 1000) {
      const more = document.createElement('div');
      more.className = 'inbox-empty';
      more.textContent = `…and ${rows.length - 1000} more (refine search).`;
      wrap.appendChild(more);
    }
    return wrap;
  }

  function renderRow(row) {
    const st = row.subtask;
    const wrap = document.createElement('div');
    wrap.className = 'inbox-row-wrap';

    const r = document.createElement('div');
    r.className = 'inbox-row completed-row' + (state.expanded.has(st.id) ? ' expanded' : '');

    const caret = document.createElement('button');
    caret.className = 'inbox-caret';
    caret.textContent = state.expanded.has(st.id) ? '▾' : '▸';
    caret.addEventListener('click', (ev) => { ev.stopPropagation(); toggleExpand(st.id); });
    r.appendChild(caret);

    // Subtle "done" indicator (replaces the old front checkbox)
    const mark = document.createElement('span');
    mark.className = 'inbox-done-mark';
    mark.title = st.done_at ? `Completed ${st.done_at.slice(0, 10)}` : 'Completed';
    mark.textContent = '✓';
    r.appendChild(mark);

    const dot = document.createElement('span');
    dot.className = 'inbox-dot';
    dot.style.background = CAT_COLOR[row.bucket.category] || '#d1d5db';
    r.appendChild(dot);

    const main = document.createElement('div');
    main.className = 'inbox-main';
    const title = document.createElement('div');
    title.className = 'inbox-title';
    title.textContent = st.text || '(untitled)';
    main.appendChild(title);
    const crumb = document.createElement('div');
    crumb.className = 'inbox-crumb';
    const parts = [row.project.title, row.bucket.title];
    if (row.parentPath.length) parts.push('… ' + row.parentPath.join(' › '));
    crumb.textContent = parts.join(' › ');
    main.appendChild(crumb);
    main.style.cursor = 'pointer';
    main.addEventListener('click', () => toggleExpand(st.id));
    r.appendChild(main);

    const meta = document.createElement('div');
    meta.className = 'inbox-meta';
    if (st.done_at) {
      const c = document.createElement('span');
      c.className = 'inbox-chip done-at';
      c.textContent = st.done_at.slice(0, 10);
      meta.appendChild(c);
    }
    const hrs = sumHours(st);
    if (hrs > 0) {
      const c = document.createElement('span');
      c.className = 'inbox-chip hrs';
      c.textContent = `${hrs.toFixed(2).replace(/\.?0+$/, '')}h`;
      meta.appendChild(c);
    }
    if (st.priority && st.priority !== 'normal') {
      const c = document.createElement('span');
      c.className = 'inbox-chip pri-' + st.priority;
      c.textContent = st.priority;
      meta.appendChild(c);
    }
    r.appendChild(meta);

    wrap.appendChild(r);
    if (state.expanded.has(st.id)) {
      wrap.appendChild(renderEditBody(row));
    }
    return wrap;
  }

  function toggleExpand(id) {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    render();
  }

  function renderEditBody(row) {
    const st = row.subtask;
    const body = document.createElement('div');
    body.className = 'completed-body';

    if (st.description) {
      const d = document.createElement('div');
      d.className = 'completed-desc';
      d.textContent = st.description;
      body.appendChild(d);
    }

    const grid = document.createElement('div');
    grid.className = 'completed-edit-grid';

    grid.appendChild(field('Title', () => {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = st.text || '';
      inp.style.fontWeight = '500';
      inp.addEventListener('change', () => {
        st.text = inp.value.trim() || st.text;
        scheduleSave(); render();
      });
      return inp;
    }));
    grid.appendChild(field('Hours spent', () => {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = '0.25'; inp.min = '0';
      inp.value = Number(st.hours_estimate) || 0;
      inp.addEventListener('change', () => {
        st.hours_estimate = Number(inp.value) || 0;
        scheduleSave(); render();
      });
      return inp;
    }));
    grid.appendChild(field('Priority', () => {
      const sel = document.createElement('select');
      for (const p of ['low', 'normal', 'high', 'urgent']) {
        const o = document.createElement('option');
        o.value = p; o.textContent = p;
        if (p === (st.priority || 'normal')) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { st.priority = sel.value; scheduleSave(); render(); });
      return sel;
    }));
    grid.appendChild(field('Original due', () => {
      const inp = document.createElement('input');
      inp.type = 'date';
      inp.value = (st.due_date && st.due_date !== 'TBD') ? st.due_date : '';
      inp.addEventListener('change', () => {
        st.due_date = inp.value || 'TBD';
        scheduleSave(); render();
      });
      return inp;
    }));
    grid.appendChild(field('Completed on', () => {
      const inp = document.createElement('input');
      inp.type = 'date';
      inp.value = (st.done_at || '').slice(0, 10);
      inp.addEventListener('change', () => {
        if (inp.value) {
          // Preserve any existing time-of-day component if there was one.
          const t = (st.done_at || '').slice(10) || 'T12:00:00';
          st.done_at = inp.value + t;
        } else {
          st.done_at = null;
        }
        scheduleSave(); render();
      });
      return inp;
    }));
    body.appendChild(grid);

    const notesField = field('Notes', () => {
      const ta = document.createElement('textarea');
      ta.value = st.notes || '';
      ta.rows = 2;
      ta.addEventListener('blur', () => { st.notes = ta.value; scheduleSave(); });
      return ta;
    });
    notesField.style.gridColumn = '1 / -1';
    body.appendChild(notesField);

    const actions = document.createElement('div');
    actions.className = 'completed-actions';
    const undo = document.createElement('button');
    undo.className = 'btn btn-primary btn-sm';
    undo.textContent = '↶ Undo completion';
    undo.title = 'Restore this task to the active list';
    undo.addEventListener('click', () => {
      st.done = false;
      st.done_at = null;
      state.expanded.delete(st.id);
      scheduleSave(); render();
    });
    actions.appendChild(undo);

    const close = document.createElement('button');
    close.className = 'btn btn-sm';
    close.textContent = 'Close';
    close.addEventListener('click', () => { state.expanded.delete(st.id); render(); });
    actions.appendChild(close);
    body.appendChild(actions);

    return body;
  }

  function field(label, makeInput) {
    const wrap = document.createElement('div');
    wrap.className = 'completed-field';
    const lbl = document.createElement('div');
    lbl.className = 'completed-field-label';
    lbl.textContent = label;
    wrap.appendChild(lbl);
    wrap.appendChild(makeInput());
    return wrap;
  }

  async function boot() {
    try {
      // Wait for auth to resolve so user-scope reads hit Firestore (not the
      // legacy single-tenant JSON fallback). Without this, first paint reads
      // empty and the user sees a blank workspace until they refresh.
      if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
        await firebridge.whenAuthResolved();
      }
      await loadDoc();
      render();
      attachLiveSync();
    } catch (err) {
      const el = root();
      if (el) el.innerHTML = `<div class="inbox-empty">Failed to load buckets.json — ${escapeHtml(err.message)}</div>`;
      console.error(err);
    }
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
