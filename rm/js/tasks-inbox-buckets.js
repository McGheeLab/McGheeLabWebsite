/* tasks-inbox-buckets.js — Flat inbox view of all subtasks across data/tasks/buckets.json.
 *
 * Two tabs (Active / Completed), text search, and sort by due / priority / hours / project.
 * Click a row → toggle done; "Open in adder" → jump to /pages/tasks-add.html.
 */

(function () {
  const DATA_PATH = 'tasks/buckets.json';
  const YR = window.YR_SHARED || {};
  const CAT_COLOR = YR.CAT_COLOR || {};
  const escapeHtml = YR.escapeHtml || (s => String(s || ''));

  const SORT_KEY = 'tasksInbox.sort';
  const HIDDEN_CATS_KEY = 'tasksInbox.hiddenCategories';
  const PRI_ORDER = { urgent: 4, high: 3, normal: 2, low: 1 };
  const CAT_ORDER = (YR.CAT_ORDER) || ['research', 'teaching', 'service', 'admin', 'personal', 'noise', 'unknown'];
  const CAT_LABEL = YR.CAT_LABEL || {};

  const state = {
    doc: null,
    sort: localStorage.getItem(SORT_KEY) || 'due',      // due | priority | hours | project | created
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
      console.error('[tasks-inbox-buckets] save failed:', err);
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
      console.warn('[tasks-inbox-buckets] live sync failed to attach:', err.message);
    }
  }

  /* ---------- helpers ---------- */
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function isoNow() { return new Date().toISOString(); }

  function sumHours(node) {
    let h = Number(node.hours_estimate) || 0;
    for (const c of node.children || []) h += sumHours(c);
    return h;
  }
  function aggregateDue(node) {
    let earliest = null;
    function walk(n) {
      if (!n.done && n.due_date && n.due_date !== 'TBD') {
        if (!earliest || n.due_date < earliest) earliest = n.due_date;
      }
      for (const c of n.children || []) walk(c);
    }
    walk(node);
    return earliest;
  }
  function pacingFor(node) {
    if (node.done) return null;
    const due = aggregateDue(node);
    if (!due) return null;
    const hours = sumHours(node);
    if (hours <= 0) return null;
    const today = new Date(todayStr());
    const dueD = new Date(due);
    const days = Math.max(1, Math.floor((dueD - today) / 86400000));
    if (dueD < today) return { level: 'red', label: '↯ overdue', load: Infinity };
    const load = hours / days;
    let level;
    if (load >= 5) level = 'red';
    else if (load >= 3) level = 'orange';
    else if (load >= 1) level = 'yellow';
    else level = 'green';
    return { level, label: `${load.toFixed(1)}h/d`, load };
  }
  function duePrefix(date) {
    if (!date || date === 'TBD') return '';
    const today = todayStr();
    if (date < today) return 'due-overdue';
    const d = new Date(date).getTime(), t = new Date(today).getTime();
    if ((d - t) / 86400000 <= 3) return 'due-soon';
    return '';
  }

  /* ---------- flat index ---------- */
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
      if (r.subtask.done) return false;             // completed lives in the Archive
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
      due: (a, b) => {
        const ad = aggregateDue(a.subtask) || (a.subtask.due_date && a.subtask.due_date !== 'TBD' ? a.subtask.due_date : '9999-99-99');
        const bd = aggregateDue(b.subtask) || (b.subtask.due_date && b.subtask.due_date !== 'TBD' ? b.subtask.due_date : '9999-99-99');
        return String(ad).localeCompare(String(bd));
      },
      priority: (a, b) => (PRI_ORDER[b.subtask.priority] || 0) - (PRI_ORDER[a.subtask.priority] || 0),
      hours:    (a, b) => sumHours(b.subtask) - sumHours(a.subtask),
      project:  (a, b) => String(a.project.title).localeCompare(String(b.project.title)),
      created:  (a, b) => String(b.subtask.id).localeCompare(String(a.subtask.id)),
      done:     (a, b) => String(b.subtask.done_at || '').localeCompare(String(a.subtask.done_at || '')),
    };
    const fn = cmp[state.sort] || cmp.due;
    return rows.slice().sort(fn);
  }

  /* ---------- rendering ---------- */
  const root = () => document.getElementById('content');

  function render() {
    const el = root();
    if (!el) return;
    el.innerHTML = '';
    el.appendChild(renderCategoryFilters());
    el.appendChild(renderToolbar());
    el.appendChild(renderList());

    if (_pendingDoc && (!state.expanded || state.expanded.size === 0)) {
      const queued = _pendingDoc;
      _pendingDoc = null;
      state.doc = queued;
      el.innerHTML = '';
      el.appendChild(renderCategoryFilters());
      el.appendChild(renderToolbar());
      el.appendChild(renderList());
    }
  }

  function renderCategoryFilters() {
    const bar = document.createElement('div');
    bar.className = 'inbox-cat-filters';
    // Per-category counts of open tasks (so chips show what's actually here).
    const counts = {};
    for (const r of buildFlat()) {
      if (r.subtask.done) continue;
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
      reset.title = 'Show every category';
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
    search.placeholder = 'Search title, description, project…';
    search.value = state.query;
    search.addEventListener('input', () => {
      state.query = search.value.trim();
      renderListOnly();
    });
    bar.appendChild(search);

    const sort = document.createElement('select');
    sort.className = 'inbox-sort';
    const sortOpts = [
      ['due', 'due date'],
      ['priority', 'priority'],
      ['hours', 'hours'],
      ['project', 'project'],
      ['created', 'newest'],
    ];
    for (const [val, label] of sortOpts) {
      const o = document.createElement('option');
      o.value = val; o.textContent = `Sort: ${label}`;
      if (state.sort === val) o.selected = true;
      sort.appendChild(o);
    }
    sort.addEventListener('change', () => {
      state.sort = sort.value;
      localStorage.setItem(SORT_KEY, state.sort);
      renderListOnly();
    });
    bar.appendChild(sort);

    const adder = document.createElement('a');
    adder.href = '/rm/pages/tasks-add.html';
    adder.className = 'btn btn-sm btn-primary';
    adder.style.textDecoration = 'none';
    adder.style.marginLeft = 'auto';
    adder.textContent = '+ Add Task';
    bar.appendChild(adder);

    return bar;
  }

  function renderListOnly() {
    const old = document.querySelector('.inbox-list');
    if (!old) { render(); return; }
    const wrap = old.parentElement;
    const fresh = renderList();
    wrap.replaceChild(fresh, old);
  }

  function renderList() {
    const wrap = document.createElement('div');
    wrap.className = 'inbox-list';
    const rows = applySort(applyFilter(buildFlat()));
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'inbox-empty';
      empty.textContent = state.query
        ? `No active tasks match "${state.query}".`
        : 'No active tasks. Completed tasks live in the Archive.';
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
    r.className = 'inbox-row' + (state.expanded.has(st.id) ? ' expanded' : '');

    const caret = document.createElement('button');
    caret.className = 'inbox-caret';
    caret.textContent = state.expanded.has(st.id) ? '▾' : '▸';
    caret.addEventListener('click', (ev) => { ev.stopPropagation(); toggleExpand(st.id); });
    r.appendChild(caret);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!st.done;
    cb.title = 'Quick mark complete';
    cb.addEventListener('click', (ev) => ev.stopPropagation());
    cb.addEventListener('change', () => {
      st.done = cb.checked;
      st.done_at = cb.checked ? isoNow() : null;
      scheduleSave();
      render();
    });
    r.appendChild(cb);

    const dot = document.createElement('span');
    dot.className = 'inbox-dot';
    dot.style.background = CAT_COLOR[row.bucket.category] || '#d1d5db';
    r.appendChild(dot);

    const main = document.createElement('div');
    main.className = 'inbox-main';
    main.style.cursor = 'pointer';
    main.addEventListener('click', () => toggleExpand(st.id));
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
    r.appendChild(main);

    const meta = document.createElement('div');
    meta.className = 'inbox-meta';
    const due = aggregateDue(st);
    if (due) {
      const c = document.createElement('span');
      const cls = duePrefix(due);
      c.className = 'inbox-chip ' + cls;
      c.textContent = due.slice(5);
      meta.appendChild(c);
    }
    if (st.priority && st.priority !== 'normal') {
      const c = document.createElement('span');
      c.className = 'inbox-chip pri-' + st.priority;
      c.textContent = st.priority;
      meta.appendChild(c);
    }
    const hrs = sumHours(st);
    if (hrs > 0) {
      const c = document.createElement('span');
      c.className = 'inbox-chip hrs';
      c.textContent = `${hrs.toFixed(2).replace(/\.?0+$/, '')}h`;
      meta.appendChild(c);
    }
    const pace = pacingFor(st);
    if (pace) {
      const c = document.createElement('span');
      c.className = 'inbox-chip pace-' + pace.level;
      c.textContent = pace.label;
      meta.appendChild(c);
    }
    r.appendChild(meta);

    wrap.appendChild(r);
    if (state.expanded.has(st.id)) wrap.appendChild(renderEditBody(row));
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
    body.className = 'completed-body';     // reuse the completed-page edit-body styles

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
      inp.type = 'text'; inp.value = st.text || ''; inp.style.fontWeight = '500';
      inp.addEventListener('change', () => { st.text = inp.value.trim() || st.text; scheduleSave(); render(); });
      return inp;
    }));
    grid.appendChild(field('Hours estimate', () => {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = '0.25'; inp.min = '0';
      inp.value = Number(st.hours_estimate) || 0;
      inp.addEventListener('change', () => { st.hours_estimate = Number(inp.value) || 0; scheduleSave(); render(); });
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
    grid.appendChild(field('Due date', () => {
      const inp = document.createElement('input');
      inp.type = 'date';
      inp.value = (st.due_date && st.due_date !== 'TBD') ? st.due_date : '';
      inp.addEventListener('change', () => { st.due_date = inp.value || 'TBD'; scheduleSave(); render(); });
      return inp;
    }));
    body.appendChild(grid);

    const notesField = field('Notes', () => {
      const ta = document.createElement('textarea');
      ta.value = st.notes || ''; ta.rows = 2;
      ta.addEventListener('blur', () => { st.notes = ta.value; scheduleSave(); });
      return ta;
    });
    notesField.style.gridColumn = '1 / -1';
    body.appendChild(notesField);

    const actions = document.createElement('div');
    actions.className = 'completed-actions';
    const complete = document.createElement('button');
    complete.className = 'btn btn-primary btn-sm';
    complete.textContent = '✓ Mark complete';
    complete.addEventListener('click', () => {
      st.done = true;
      st.done_at = isoNow();
      state.expanded.delete(st.id);
      scheduleSave(); render();
    });
    actions.appendChild(complete);

    const open = document.createElement('a');
    open.className = 'btn btn-sm';
    open.href = '/rm/pages/tasks-add.html';
    open.style.textDecoration = 'none';
    open.textContent = 'Open in adder';
    actions.appendChild(open);

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

  /* ---------- boot ---------- */
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
      if (el) el.innerHTML = `<div class="inbox-empty">Failed to load buckets.json — ${escapeHtml(err.message)}<br>Run <code>python3 scripts/migrate_inbox_to_buckets.py</code>.</div>`;
      console.error(err);
    }
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
