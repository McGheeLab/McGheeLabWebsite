/* tasks-dashboard-buckets.js — Dashboard view for the bucket+subtask model.
 *
 * Renders data/tasks/buckets.json using the existing pin-grid / pin-box / pin-card
 * styling so the dashboard look-and-feel matches the previous version, but each
 * pin-box is now a *project bucket* (user-created), not a category:sub_category pin.
 *
 * Subtasks are flattened across the project's sub-buckets and rendered as pin-cards
 * inside each pin-box. Sub-bucket appears as a small chip on each row.
 *
 * Add task → routes to /pages/tasks-add.html (the adder/search workspace).
 */

(function () {
  const DATA_PATH = 'tasks/buckets.json';
  const YR = window.YR_SHARED || {};
  const CAT_COLOR = YR.CAT_COLOR || {};
  const CAT_LABEL = YR.CAT_LABEL || {};
  const escapeHtml = YR.escapeHtml || (s => String(s || ''));
  const CG = window.CARD_GRID;

  const SHOW_DONE_KEY    = 'tasksDash.showDone';
  const HIDDEN_KEY       = 'tasksDash.hiddenProjects';
  const DISMISSED_SUG_KEY = 'tasksDash.dismissedSuggestions';
  const MAX_DEPTH = 3;   // depths 0,1,2 — no children at depth 2

  const PROJECT_COLORS = CG.PROJECT_COLORS;

  const COMPLETED_OPEN_KEY = 'tasksDash.expandedCompleted';
  const PINNED_TODAY_KEY = 'tasksDash.pinnedToday';
  const state = {
    doc: null,
    hidden: new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]')),
    dismissedSuggestions: new Set(JSON.parse(localStorage.getItem(DISMISSED_SUG_KEY) || '[]')),
    expandedCompleted: new Set(JSON.parse(localStorage.getItem(COMPLETED_OPEN_KEY) || '[]')),
    pinnedToday: new Set(JSON.parse(localStorage.getItem(PINNED_TODAY_KEY) || '[]')),
    expandedCards: new Set(),
    focusedProjectId: null,
    saveTimer: null,
    assignedTasks: [],
    tasksISent: [],
  };
  function persistPinnedToday() {
    localStorage.setItem(PINNED_TODAY_KEY, JSON.stringify([...state.pinnedToday]));
  }
  function togglePinnedToday(stId) {
    if (state.pinnedToday.has(stId)) state.pinnedToday.delete(stId);
    else state.pinnedToday.add(stId);
    persistPinnedToday();
  }
  function persistExpandedCompleted() {
    localStorage.setItem(COMPLETED_OPEN_KEY, JSON.stringify([...state.expandedCompleted]));
  }

  const projectColor = CG.itemColor;
  function persistDismissedSuggestions() {
    localStorage.setItem(DISMISSED_SUG_KEY, JSON.stringify([...state.dismissedSuggestions]));
  }

  /* ---------- io (multi-tenant via api adapter, live via Firestore) ----------
   * See js/tasks-buckets.js for full pattern docs. Briefly:
   *   _suppressUntil — skip our own write echo for 2.5s after each save
   *   _savePending   — skip while a debounced save is queued, so a remote
   *                    snapshot can't clobber a typed-but-unsaved edit
   *   _pendingDoc    — stash remote update while user has expandedCards open;
   *                    drained at the tail of render() once no cards expanded
   */
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
      console.error('[tasks-dashboard-buckets] save failed:', err);
      throw err;
    }
  }
  var _assignedUnsub = null;
  function attachLiveSync() {
    if (typeof api.subscribe !== 'function') return;
    if (!_liveUnsub) {
      try {
        _liveUnsub = api.subscribe(DATA_PATH, function (data) {
          if (Date.now() < _suppressUntil) return;
          if (_savePending) return;
          if (!data || !Array.isArray(data.projects)) return;
          if (state.expandedCards && state.expandedCards.size > 0) {
            _pendingDoc = data;
            return;
          }
          state.doc = data;
          render();
        });
      } catch (err) {
        console.warn('[tasks-dashboard-buckets] live sync failed to attach:', err.message);
      }
    }
    // Phase 8: subscribe to tasks assigned by teammates so the receiver sees
    // new incoming assignments without reload. Skip the first fire (initial
    // sync — same data loadAssignedTasks just gave us at boot).
    if (!_assignedUnsub) {
      try {
        var firstFire = true;
        _assignedUnsub = api.subscribe('tasks/assigned.json', function (data) {
          if (!data) return;
          state.assignedTasks = (data && data.tasks) || [];
          if (firstFire) { firstFire = false; return; }
          render();
        });
      } catch (err) {
        console.warn('[tasks-dashboard-buckets] assigned-tasks live sync failed:', err.message);
      }
    }
  }
  function persistHidden() {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...state.hidden]));
  }

  /* ---------- helpers ---------- */
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function isoNow() { return new Date().toISOString(); }
  function newId(p) { return `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }
  function emptyEvidence() { return { email_ids: [], event_ids: [], item_ids: [] }; }

  function flattenSubtasks(project) {
    // Returns [{subtask, bucket, depth, parent, path}], depth-first across all sub-buckets and their nested children.
    const out = [];
    function walk(arr, bucket, depth, parent, path) {
      for (const st of arr || []) {
        out.push({ subtask: st, bucket, depth, parent, path });
        if ((st.children || []).length) {
          walk(st.children, bucket, depth + 1, st, path.concat(st));
        }
      }
    }
    for (const b of project.buckets || []) walk(b.subtasks, b, 0, null, []);
    return out;
  }

  function rollupProject(project) {
    let open = 0, done = 0, hours = Number(project.hours_estimate) || 0, earliest = null, worst = null;
    const priOrder = { urgent: 4, high: 3, normal: 2, low: 1 };
    for (const row of flattenSubtasks(project)) {
      const st = row.subtask;
      if (st.done) done++; else open++;
      hours += Number(st.hours_estimate) || 0;
      if (!st.done && st.due_date && st.due_date !== 'TBD') {
        if (!earliest || st.due_date < earliest) earliest = st.due_date;
      }
      if (!st.done && st.priority && (!worst || (priOrder[st.priority] || 0) > (priOrder[worst] || 0))) worst = st.priority;
    }
    return { open, done, hours, earliest, worst };
  }

  const duePrefix = CG.duePrefix;
  const sumHours = CG.sumHours;
  const aggregateDue = CG.aggregateDue;
  const pacingFor = CG.pacingFor;

  /* ---------- rendering ---------- */
  const root = () => document.getElementById('dash-content');

  function render() {
    const el = root();
    if (!el) return;
    el.innerHTML = '';

    el.appendChild(renderToolbar());
    el.appendChild(renderAssignedByOthers());
    el.appendChild(renderAssignedByMe());
    el.appendChild(renderTodayPinned());
    el.appendChild(renderProposed());
    el.appendChild(renderSuggestions());
    el.appendChild(renderPinGrid());
    el.appendChild(renderHidden());

    // Drain a deferred remote update if no card is expanded mid-edit.
    if (_pendingDoc && (!state.expandedCards || state.expandedCards.size === 0)) {
      const queued = _pendingDoc;
      _pendingDoc = null;
      state.doc = queued;
      el.innerHTML = '';
      el.appendChild(renderToolbar());
      el.appendChild(renderAssignedByOthers());
      el.appendChild(renderAssignedByMe());
      el.appendChild(renderTodayPinned());
      el.appendChild(renderProposed());
      el.appendChild(renderSuggestions());
      el.appendChild(renderPinGrid());
      el.appendChild(renderHidden());
    }
  }

  /* Phase 8: tasks assigned to me by teammates. Reads state.assignedTasks
   * (loaded via tasks/assigned.json route → userData/{uid}/tasks where
   * bucket=='assigned'). Each row shows the assigner's name + due date and
   * lets the assignee mark complete (which sets done:true; the task stays
   * in their queue for record-keeping). */
  function renderAssignedByOthers() {
    const wrap = document.createElement('div');
    const tasks = (state.assignedTasks || []).filter(t => !t.done);
    if (!tasks.length) return wrap;
    wrap.style.cssText = 'margin-bottom:18px;';
    wrap.innerHTML = '<div style="font-weight:600;font-size:13px;color:#374151;margin-bottom:8px;">' +
      'Assigned to me (' + tasks.length + ')</div>';
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    tasks
      .slice()
      .sort((a, b) => (a.due_date || 'zzz').localeCompare(b.due_date || 'zzz'))
      .forEach(t => {
        const row = document.createElement('div');
        row.style.cssText =
          'display:flex;align-items:center;gap:10px;padding:8px 12px;' +
          'background:#fff;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;';
        const due = (t.due_date && t.due_date !== 'TBD')
          ? `<span style="color:#6b7280;font-size:12px;">due ${escapeHtml(t.due_date)}</span>` : '';
        const from = t.createdByName ? `from <strong>${escapeHtml(t.createdByName)}</strong>` : 'from teammate';
        row.innerHTML =
          '<button type="button" class="ta-done" data-id="' + escapeHtml(t.id) + '" ' +
            'style="width:18px;height:18px;border-radius:50%;border:1.5px solid #9ca3af;background:#fff;cursor:pointer;flex:0 0 auto;" ' +
            'title="Mark complete"></button>' +
          '<div style="flex:1;">' +
            '<div>' + escapeHtml(t.text || '(untitled)') + '</div>' +
            '<div style="font-size:11px;color:#6b7280;">' + from + (due ? ' · ' + due : '') + '</div>' +
          '</div>';
        list.appendChild(row);
      });
    wrap.appendChild(list);
    list.querySelectorAll('.ta-done').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tid = btn.dataset.id;
        const task = (state.assignedTasks || []).find(x => x.id === tid);
        if (!task) return;
        task.done = true; task.done_at = new Date().toISOString();
        state.assignedTasks = (state.assignedTasks || []).filter(x => x.id !== tid);
        render();
        try {
          const me = firebridge.getUser();
          if (!me) return;
          await firebridge.db()
            .collection('userData').doc(me.uid)
            .collection('tasks').doc(tid)
            .set({ done: true, done_at: task.done_at, status: 'completed' }, { merge: true });
        } catch (err) {
          console.error('[tasks-dashboard] mark-complete failed:', err);
        }
      });
    });
    return wrap;
  }


  /* Phase 8 polish: tasks I've assigned to teammates. Reads state.tasksISent
   * (loaded via collectionGroup('tasks') filtered by createdByUid==me.uid).
   * Read-only summary — the assignee owns the lifecycle. Hidden if empty. */
  function renderAssignedByMe() {
    const wrap = document.createElement('div');
    const tasks = (state.tasksISent || []).filter(t => !t.done);
    if (!tasks.length) return wrap;
    wrap.style.cssText = 'margin-bottom:18px;';
    wrap.innerHTML = '<div style="font-weight:600;font-size:13px;color:#374151;margin-bottom:8px;">' +
      'Assigned by me (' + tasks.length + ')</div>';
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    tasks
      .slice()
      .sort((a, b) => (a.due_date || 'zzz').localeCompare(b.due_date || 'zzz'))
      .forEach(t => {
        const row = document.createElement('div');
        row.style.cssText =
          'display:flex;align-items:center;gap:10px;padding:8px 12px;' +
          'background:#fff;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;';
        const due = (t.due_date && t.due_date !== 'TBD')
          ? `<span style="color:#6b7280;font-size:12px;">due ${escapeHtml(t.due_date)}</span>` : '';
        const to = t.assignedToName ? `to <strong>${escapeHtml(t.assignedToName)}</strong>` : 'to teammate';
        const status = t.status === 'completed' ? '✓' : '○';
        row.innerHTML =
          '<span style="width:18px;flex:0 0 auto;color:#9ca3af;">' + status + '</span>' +
          '<div style="flex:1;">' +
            '<div>' + escapeHtml(t.text || '(untitled)') + '</div>' +
            '<div style="font-size:11px;color:#6b7280;">' + to + (due ? ' · ' + due : '') + '</div>' +
          '</div>';
        list.appendChild(row);
      });
    wrap.appendChild(list);
    return wrap;
  }

  function renderToolbar() {
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap';

    const newProj = document.createElement('button');
    newProj.className = 'btn btn-sm';
    newProj.textContent = '+ New project';
    newProj.addEventListener('click', () => {
      const title = prompt('Project name:');
      if (!title || !title.trim()) return;
      const id = `proj-${slugify(title.trim())}-${Date.now().toString(36)}`;
      state.doc.projects.push({
        id, title: title.trim(), status: 'active', category: '',
        due_date: 'TBD', hours_estimate: 0, tracker_entry_id: null,
        evidence: emptyEvidence(), notes: '',
        created_at: todayStr(), completed_at: null, buckets: [],
      });
      scheduleSave();
      render();
    });
    bar.appendChild(newProj);


    const adder = document.createElement('a');
    adder.href = '/rm/pages/tasks-add.html';
    adder.className = 'btn btn-sm';
    adder.style.textDecoration = 'none';
    adder.style.marginLeft = 'auto';
    adder.textContent = 'Search / add tasks →';
    bar.appendChild(adder);

    return bar;
  }

  function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  /* ----- Today I Must (user-pinned subtasks) ----- */
  // Walk the doc to find each pinned subtask + locate its project/bucket. Drops
  // any IDs in the pinned set that no longer exist in buckets.json so the panel
  // stays clean.
  function findPinnedTodayRows() {
    const want = state.pinnedToday;
    if (!want.size) return [];
    const out = [];
    const seen = new Set();
    function walk(arr, project, bucket, parentPath) {
      for (const st of arr || []) {
        if (want.has(st.id)) { out.push({ subtask: st, project, bucket, parentPath }); seen.add(st.id); }
        if ((st.children || []).length) walk(st.children, project, bucket, parentPath.concat(st.text));
      }
    }
    for (const p of state.doc.projects || []) {
      for (const b of p.buckets || []) walk(b.subtasks, p, b, []);
    }
    // Prune stale ids
    for (const id of [...want]) if (!seen.has(id)) state.pinnedToday.delete(id);
    if (state.pinnedToday.size !== want.size) persistPinnedToday();
    return out;
  }

  function renderTodayPinned() {
    const wrap = document.createElement('div');
    const rows = findPinnedTodayRows();
    if (!rows.length) return wrap;
    wrap.style.marginBottom = '14px';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:6px;font-size:12px;color:#7c2d12;font-weight:600;text-transform:uppercase;letter-spacing:.4px';
    let totalH = 0;
    for (const r of rows) totalH += sumHours(r.subtask);
    head.innerHTML =
      `<span style="background:#fee2e2;padding:2px 10px;border-radius:10px">📌 Today I Must (${rows.length})</span>` +
      `<span style="font-weight:400;text-transform:none;color:#6b7280">${totalH ? '— Σ ' + totalH.toFixed(1) + 'h' : ''}</span>`;
    wrap.appendChild(head);

    const list = document.createElement('div');
    list.className = 'pin-box';
    list.style.borderColor = '#fecaca';
    list.style.borderLeft = '5px solid #ef4444';
    // Sort by aggregated due, soonest first
    rows.sort((a, b) => {
      const ad = aggregateDue(a.subtask) || (a.subtask.due_date && a.subtask.due_date !== 'TBD' ? a.subtask.due_date : '9999-99-99');
      const bd = aggregateDue(b.subtask) || (b.subtask.due_date && b.subtask.due_date !== 'TBD' ? b.subtask.due_date : '9999-99-99');
      return String(ad).localeCompare(String(bd));
    });
    for (const r of rows) list.appendChild(renderTodayRow(r));
    wrap.appendChild(list);
    return wrap;
  }

  function renderTodayRow(row) {
    const st = row.subtask;
    const card = document.createElement('div');
    card.className = 'pin-card' + (st.done ? ' completed' : '');
    const r = document.createElement('div');
    r.className = 'pin-card-row';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!st.done;
    cb.addEventListener('click', ev => ev.stopPropagation());
    cb.addEventListener('change', () => {
      st.done = cb.checked;
      st.done_at = cb.checked ? isoNow() : null;
      // Auto-unpin once completed (keeps the section focused on actionable work)
      if (cb.checked) state.pinnedToday.delete(st.id);
      persistPinnedToday();
      scheduleSave();
      render();
    });
    r.appendChild(cb);

    const dot = document.createElement('span');
    const taskColor = CAT_COLOR[row.bucket && row.bucket.category] || '#d1d5db';
    dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${taskColor};flex-shrink:0`;
    r.appendChild(dot);

    const titleWrap = document.createElement('div');
    titleWrap.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column';
    const t = document.createElement('span');
    t.className = 'pin-title';
    t.textContent = st.text || '(untitled)';
    titleWrap.appendChild(t);
    const crumb = document.createElement('span');
    crumb.style.cssText = 'font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const parts = [row.project.title, row.bucket.title];
    if (row.parentPath.length) parts.push('… ' + row.parentPath.join(' › '));
    crumb.textContent = parts.join(' › ');
    titleWrap.appendChild(crumb);
    r.appendChild(titleWrap);

    const unpin = document.createElement('button');
    unpin.className = 'pin-today-btn active';
    unpin.title = 'Unpin from Today';
    unpin.textContent = '📌';
    unpin.addEventListener('click', (ev) => {
      ev.stopPropagation();
      state.pinnedToday.delete(st.id);
      persistPinnedToday();
      render();
    });
    r.appendChild(unpin);
    card.appendChild(r);

    const chips = document.createElement('div');
    chips.className = 'pin-card-chips';
    appendChips(chips, st);
    card.appendChild(chips);
    return card;
  }

  /* ----- proposed queue panel (proj-inbox) ----- */
  function renderProposed() {
    const wrap = document.createElement('div');
    wrap.style.marginBottom = '14px';
    const inbox = (state.doc.projects || []).find(p => p.id === 'proj-inbox');
    if (!inbox) return wrap;
    const proposed = flattenSubtasks(inbox).filter(r => r.subtask.proposed);
    if (!proposed.length) return wrap;
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:6px;font-size:12px;color:#92400e;font-weight:600;text-transform:uppercase;letter-spacing:.4px';
    head.innerHTML = `<span style="background:#fef3c7;padding:2px 10px;border-radius:10px">Proposed (${proposed.length})</span> <span style="font-weight:400;text-transform:none;color:#6b7280">— pin to a project below</span>`;
    wrap.appendChild(head);
    const list = document.createElement('div');
    list.className = 'pin-box';
    list.style.borderColor = '#fde68a';
    for (const row of proposed.slice(0, 12)) {
      list.appendChild(renderProposedRow(inbox, row));
    }
    if (proposed.length > 12) {
      const more = document.createElement('div');
      more.style.cssText = 'padding:6px 12px;font-size:11px;color:#9ca3af';
      more.innerHTML = `<a href="/rm/pages/tasks-add.html">View all ${proposed.length} proposed →</a>`;
      list.appendChild(more);
    }
    wrap.appendChild(list);
    return wrap;
  }

  function renderProposedRow(inbox, row) {
    const card = document.createElement('div');
    card.className = 'pin-card';
    const r = document.createElement('div');
    r.className = 'pin-card-row';
    const t = document.createElement('span');
    t.className = 'pin-title';
    t.textContent = row.subtask.text || '(untitled)';
    r.appendChild(t);
    const pin = document.createElement('button');
    pin.className = 'btn btn-sm btn-primary';
    pin.textContent = 'Pin to…';
    pin.addEventListener('click', (ev) => { ev.stopPropagation(); openPinMenu(pin, row.subtask, inbox, row.bucket); });
    r.appendChild(pin);
    card.appendChild(r);
    const chips = document.createElement('div');
    chips.className = 'pin-card-chips';
    appendChips(chips, row.subtask);
    card.appendChild(chips);
    return card;
  }

  /* ----- suggested projects ----- */
  // Auto-seeded category projects + reserved inbox aren't "real" user projects.
  const SEEDED_RE = /^proj-(research|teaching|service|admin|noise|personal|unknown|mentorship|uncategorized)$/;
  function isUserProject(p) {
    return p && p.id !== 'proj-inbox' && !SEEDED_RE.test(p.id);
  }

  function buildSuggestions() {
    // Sub_categories already covered by a visible USER project (so we don't re-suggest them).
    const covered = new Set();
    for (const p of state.doc.projects || []) {
      if (!isUserProject(p)) continue;
      if (state.hidden.has(p.id)) continue;
      for (const b of p.buckets || []) {
        const key = `${b.category || ''}:${b.sub_category || ''}`;
        if (key !== ':') covered.add(key);
      }
    }
    // Tally open subtask counts by sub_category across the whole doc.
    const tally = {};   // key -> { count, samples: [{subtask, project, bucket}], category, sub_category }
    for (const p of state.doc.projects || []) {
      if (p.id === 'proj-inbox') continue;
      for (const b of p.buckets || []) {
        const key = `${b.category || ''}:${b.sub_category || ''}`;
        if (key === ':') continue;
        if (covered.has(key)) continue;
        if (state.dismissedSuggestions.has(key)) continue;
        for (const row of flattenSubtasks({ buckets: [b] })) {
          if (row.subtask.done) continue;
          const t = tally[key] || { count: 0, samples: [], category: b.category, sub_category: b.sub_category };
          t.count++;
          if (t.samples.length < 3) t.samples.push({ subtask: row.subtask, project: p, bucket: b });
          tally[key] = t;
        }
      }
    }
    return Object.entries(tally)
      .filter(([, v]) => v.count >= 3)             // ignore tiny one-offs
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 6)
      .map(([key, v]) => ({ key, ...v }));
  }

  function suggestionTitle(s) {
    // Pick the most specific colon segment as the human-readable name.
    const seg = (s.sub_category || '').split(':').filter(Boolean);
    const last = seg[seg.length - 1] || s.sub_category || s.category || 'Untitled';
    return last.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function renderSuggestions() {
    const wrap = document.createElement('div');
    const list = buildSuggestions();
    if (!list.length) return wrap;
    wrap.style.marginBottom = '14px';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:6px;font-size:12px;color:#0e7490;font-weight:600;text-transform:uppercase;letter-spacing:.4px';
    head.innerHTML = `<span style="background:#cffafe;padding:2px 10px;border-radius:10px">Suggested projects</span> <span style="font-weight:400;text-transform:none;color:#6b7280">— based on open tasks not yet in a project you made</span>`;
    wrap.appendChild(head);
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px';
    for (const s of list) grid.appendChild(renderSuggestionCard(s));
    wrap.appendChild(grid);
    return wrap;
  }

  function renderSuggestionCard(s) {
    const c = document.createElement('div');
    const color = CAT_COLOR[s.category] || '#6b7280';
    c.style.cssText = `background:#fff;border:1px solid #e5e7eb;border-left:4px solid ${color};border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px`;
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;font-size:13px;color:#111827';
    title.textContent = suggestionTitle(s);
    c.appendChild(title);
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.3px';
    sub.textContent = `${s.category || '—'} · ${s.sub_category}`;
    c.appendChild(sub);
    const count = document.createElement('div');
    count.style.cssText = 'font-size:11px;color:#374151';
    count.textContent = `${s.count} open task${s.count === 1 ? '' : 's'}`;
    c.appendChild(count);
    if (s.samples.length) {
      const ex = document.createElement('div');
      ex.style.cssText = 'font-size:11px;color:#6b7280;line-height:1.3';
      ex.textContent = '· ' + s.samples.map(x => x.subtask.text).slice(0, 2).join('\n· ');
      ex.style.whiteSpace = 'pre-line';
      c.appendChild(ex);
    }
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:6px;margin-top:4px';
    const create = document.createElement('button');
    create.className = 'btn btn-sm btn-primary';
    create.textContent = 'Create project';
    create.addEventListener('click', () => createProjectFromSuggestion(s));
    btns.appendChild(create);
    const dismiss = document.createElement('button');
    dismiss.className = 'btn btn-sm';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => {
      state.dismissedSuggestions.add(s.key);
      persistDismissedSuggestions();
      render();
    });
    btns.appendChild(dismiss);
    c.appendChild(btns);
    return c;
  }

  function createProjectFromSuggestion(s) {
    const defaultName = suggestionTitle(s);
    const title = prompt(`New project name (will move ${s.count} matching open tasks into it):`, defaultName);
    if (!title || !title.trim()) return;
    const id = `proj-${slugify(title.trim())}-${Date.now().toString(36)}`;
    const newProject = {
      id, title: title.trim(), status: 'active',
      category: s.category || '',
      color: projectColor({ category: s.category }),
      due_date: 'TBD', hours_estimate: 0, tracker_entry_id: null,
      evidence: emptyEvidence(), notes: '',
      created_at: todayStr(), completed_at: null,
      buckets: [{
        id: `buk-${id}-default`,
        category: s.category || '', sub_category: s.sub_category || '',
        title: 'General',
        due_date: 'TBD', hours_estimate: 0, tracker_entry_id: null,
        evidence: emptyEvidence(), notes: '', subtasks: [],
      }],
    };
    state.doc.projects.push(newProject);
    const dest = newProject.buckets[0];
    // Move matching open subtasks (any sub-bucket whose key matches) into the new project's bucket.
    for (const p of state.doc.projects || []) {
      if (p === newProject) continue;
      if (p.id === 'proj-inbox') continue;
      for (const b of p.buckets || []) {
        if ((b.category || '') !== (s.category || '')) continue;
        if ((b.sub_category || '') !== (s.sub_category || '')) continue;
        const keep = [];
        for (const st of b.subtasks || []) {
          if (!st.done) { dest.subtasks.push(st); }
          else keep.push(st);
        }
        b.subtasks = keep;
      }
    }
    if (state.hidden.has(newProject.id)) { state.hidden.delete(newProject.id); persistHidden(); }
    scheduleSave();
    render();
  }

  /* ----- pin grid (one pin-box per project) ----- */
  // Score a project by how urgently its open work needs attention.
  // Each open top-level subtask contributes by pacing level:
  //   red = 1000 + load   (overdue or >=5h/day required)
  //   orange = 100 + load (>=3h/day)
  //   yellow = 10 + load  (>=1h/day)
  //   green  = load       (<1h/day)
  // Tasks without a due date don't contribute. Higher score = sort earlier.
  function projectUrgency(project) {
    let score = 0;
    for (const row of flattenSubtasks(project)) {
      if (row.depth !== 0) continue;
      if (row.subtask.done) continue;
      const pace = pacingFor(row.subtask);
      if (!pace) continue;
      const load = isFinite(pace.load) ? pace.load : 24;
      if (pace.level === 'red')         score += 1000 + load;
      else if (pace.level === 'orange') score += 100  + load;
      else if (pace.level === 'yellow') score += 10   + load;
      else                              score += load;
    }
    return score;
  }

  function renderPinGrid() {
    const grid = document.createElement('div');
    grid.className = 'pin-grid' + (state.focusedProjectId ? ' focusing' : '');
    const visible = (state.doc.projects || [])
      .filter(p => p.id !== 'proj-inbox' && !state.hidden.has(p.id));
    visible.sort((a, b) => projectUrgency(b) - projectUrgency(a));
    for (const p of visible) {
      const box = renderProjectBox(p);
      if (p.id === state.focusedProjectId) box.classList.add('focused');
      grid.appendChild(box);
    }
    return grid;
  }

  function renderProjectBox(project) {
    const box = document.createElement('div');
    box.className = 'pin-box';
    box.style.borderLeft = `5px solid ${projectColor(project)}`;
    // Header
    const head = document.createElement('div');
    head.className = 'pin-box-head';

    // Color swatch (click to change)
    const swatch = document.createElement('button');
    swatch.title = 'Change project color';
    swatch.style.cssText = `width:14px;height:14px;border-radius:4px;border:1px solid rgba(0,0,0,.15);background:${projectColor(project)};cursor:pointer;flex-shrink:0;padding:0`;
    swatch.addEventListener('click', (ev) => { ev.stopPropagation(); openColorMenu(swatch, project); });
    head.appendChild(swatch);

    const titleWrap = document.createElement('div');
    titleWrap.className = 'pin-box-title';
    const cat = document.createElement('div');
    cat.className = 'pin-box-cat';
    cat.style.color = CAT_COLOR[project.category] || '#6b7280';
    cat.textContent = CAT_LABEL[project.category] || (project.category || 'Project');
    titleWrap.appendChild(cat);
    const sub = document.createElement('div');
    sub.className = 'pin-box-sub';
    sub.contentEditable = 'false';
    sub.textContent = project.title;
    sub.title = 'Double-click to rename';
    sub.addEventListener('dblclick', () => {
      sub.contentEditable = 'true'; sub.focus();
      document.getSelection().selectAllChildren(sub);
    });
    sub.addEventListener('blur', () => {
      if (sub.contentEditable === 'true') {
        sub.contentEditable = 'false';
        const v = sub.textContent.trim();
        if (v && v !== project.title) { project.title = v; scheduleSave(); }
      }
    });
    sub.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && sub.contentEditable === 'true') { ev.preventDefault(); sub.blur(); }
    });
    titleWrap.appendChild(sub);
    head.appendChild(titleWrap);

    const meta = document.createElement('div');
    meta.className = 'pin-box-meta';
    const r = rollupProject(project);
    const count = document.createElement('span');
    count.className = 'pin-box-count';
    count.textContent = String(r.open);
    meta.appendChild(count);
    if (r.earliest) {
      const due = document.createElement('span');
      due.style.color = duePrefix(r.earliest) === 'due-overdue' ? '#b91c1c' : '#6b7280';
      due.textContent = `due ${r.earliest.slice(5)}`;
      meta.appendChild(due);
    }
    if (r.hours) {
      const h = document.createElement('span');
      h.style.color = '#6b7280';
      h.textContent = `${r.hours.toFixed(1)}h`;
      meta.appendChild(h);
    }
    const menu = document.createElement('button');
    menu.className = 'pin-expand';
    menu.title = 'Hide from dashboard';
    menu.style.fontSize = '14px';
    menu.textContent = '×';
    menu.addEventListener('click', () => {
      state.hidden.add(project.id);
      persistHidden();
      render();
    });
    meta.appendChild(menu);
    head.appendChild(meta);
    box.appendChild(head);

    // Linked-items chip row — small links to research/teaching/service pages
    // for any items.json entries this bucket is linked to.
    const linkedItemIds = (project.linked_item_ids || []);
    if (linkedItemIds.length && state.itemsIndex) {
      const linkRow = document.createElement('div');
      linkRow.style.cssText = 'padding:4px 14px 6px 14px;display:flex;flex-wrap:wrap;gap:6px;font-size:11px';
      for (const itemId of linkedItemIds) {
        const it = state.itemsIndex[itemId];
        if (!it) continue;
        const a = document.createElement('a');
        const page = (it.category === 'teaching') ? '/rm/pages/teaching.html'
                  : (it.category === 'service')   ? '/rm/pages/service.html'
                                                   : '/rm/pages/projects.html';
        a.href = `${page}?item=${encodeURIComponent(it.id)}`;
        a.style.cssText = 'font-size:11px;padding:1px 8px;border-radius:10px;background:#dbeafe;color:#1e3a8a;text-decoration:none';
        a.textContent = '↗ ' + (it.title || it.id);
        a.title = `Open ${it.type || 'item'} on ${it.category || 'research'} page`;
        linkRow.appendChild(a);
      }
      if (linkRow.children.length) box.appendChild(linkRow);
    }

    // Body — top-level rows only; their hours/pacing aggregate children via sumHours.
    const list = document.createElement('div');
    list.className = 'pin-box-list';
    const allRows = flattenSubtasks(project).filter(r => r.depth === 0);
    const sortByDue = (a, b) => {
      const ad = (a.subtask.due_date && a.subtask.due_date !== 'TBD') ? a.subtask.due_date : '9999-99-99';
      const bd = (b.subtask.due_date && b.subtask.due_date !== 'TBD') ? b.subtask.due_date : '9999-99-99';
      return ad.localeCompare(bd);
    };
    const openRows = allRows.filter(r => !r.subtask.done).sort(sortByDue);
    const doneRows = allRows.filter(r =>  r.subtask.done).sort((a, b) =>
      (b.subtask.done_at || '').localeCompare(a.subtask.done_at || ''));

    if (!openRows.length && !doneRows.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:14px 14px;color:#9ca3af;font-size:12px';
      empty.textContent = 'No subtasks yet.';
      list.appendChild(empty);
    } else {
      for (const row of openRows.slice(0, 100)) list.appendChild(renderSubtaskCard(project, row));
    }

    if (doneRows.length) {
      list.appendChild(renderCompletedSection(project, doneRows));
    }
    box.appendChild(list);

    // Footer — quick add + focus-view button
    const foot = document.createElement('div');
    foot.className = 'pin-box-foot';
    foot.style.justifyContent = 'space-between';
    foot.style.gap = '8px';
    const addInput = document.createElement('input');
    addInput.placeholder = '+ Add task';
    addInput.style.cssText = 'flex:1;padding:5px 8px;border:1px dashed #d1d5db;border-radius:6px;font-size:12px;background:transparent';
    addInput.addEventListener('focus', () => { addInput.style.background = '#fff'; addInput.style.borderStyle = 'solid'; });
    addInput.addEventListener('blur',  () => { addInput.style.background = 'transparent'; addInput.style.borderStyle = 'dashed'; });
    addInput.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || !addInput.value.trim()) return;
      addSubtaskToProject(project, addInput.value.trim());
      addInput.value = '';
    });
    foot.appendChild(addInput);

    // Focus toggle (bottom-right). Click to enter focus mode (this card grows
    // to full width and the others animate out of the way); click again to exit.
    const isFocused = state.focusedProjectId === project.id;
    const focusBtn = document.createElement('button');
    focusBtn.className = 'btn btn-sm' + (isFocused ? ' btn-primary' : '');
    focusBtn.textContent = isFocused ? '× Exit focus' : 'Focus view →';
    focusBtn.title = isFocused ? 'Restore the dashboard grid' : 'Expand this card to full width';
    focusBtn.addEventListener('click', () => {
      if (isFocused) {
        state.focusedProjectId = null;
      } else {
        state.focusedProjectId = project.id;
      }
      render();
      // Bring the focused card into view; CSS handles the animation.
      requestAnimationFrame(() => {
        const focused = document.querySelector('.pin-box.focused');
        if (focused) focused.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    foot.appendChild(focusBtn);

    box.appendChild(foot);

    return box;
  }

  function renderCompletedSection(project, doneRows) {
    const wrap = document.createElement('div');
    wrap.className = 'pin-completed' + (state.expandedCompleted.has(project.id) ? ' open' : '');
    const head = document.createElement('div');
    head.className = 'pin-completed-head';
    const expanded = state.expandedCompleted.has(project.id);
    head.innerHTML = `<span class="pin-completed-caret">${expanded ? '▾' : '▸'}</span> Completed (${doneRows.length})`;
    head.addEventListener('click', () => {
      if (expanded) state.expandedCompleted.delete(project.id);
      else state.expandedCompleted.add(project.id);
      persistExpandedCompleted();
      render();
    });
    wrap.appendChild(head);
    if (expanded) {
      for (const row of doneRows.slice(0, 200)) wrap.appendChild(renderSubtaskCard(project, row));
    }
    return wrap;
  }

  function ensureDefaultBucket(project) {
    let b = (project.buckets || []).find(x => x.id === `buk-${project.id}-default`);
    if (b) return b;
    b = {
      id: `buk-${project.id}-default`,
      category: project.category || '',
      sub_category: '',
      title: 'General',
      due_date: 'TBD', hours_estimate: 0, tracker_entry_id: null,
      evidence: emptyEvidence(), notes: '',
      subtasks: [],
    };
    project.buckets = project.buckets || [];
    project.buckets.unshift(b);
    return b;
  }

  function addSubtaskToProject(project, text) {
    const bucket = ensureDefaultBucket(project);
    const me = (typeof firebridge !== 'undefined' && firebridge.getUser) ? (firebridge.getUser() || {}) : {};
    const nowIso = new Date().toISOString();
    const node = {
      id: newId('sub'), text, description: '',
      done: false, done_at: null,
      due_date: 'TBD', priority: 'normal',
      hours_estimate: 0, tracker_entry_id: null,
      evidence: emptyEvidence(), notes: '',
      assignee_uid: me.uid || null,
      assignees_uids: [],
      assigned_at: nowIso,
      assigned_by_uid: me.uid || null,
      block_status: null,
      proposed: false,
      children: [],
    };
    bucket.subtasks = bucket.subtasks || [];
    bucket.subtasks.push(node);
    scheduleSave();
    render();
  }

  function renderSubtaskCard(project, row) {
    const st = row.subtask;
    const depth = row.depth || 0;
    const card = document.createElement('div');
    card.className = 'pin-card' + (st.done ? ' completed' : '') + (depth > 0 ? ' nested' : '');
    if (state.expandedCards.has(st.id)) card.classList.add('expanded');
    const r = document.createElement('div');
    r.className = 'pin-card-row';

    const exp = document.createElement('button');
    exp.className = 'pin-expand';
    exp.textContent = state.expandedCards.has(st.id) ? '▾' : '▸';
    exp.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (state.expandedCards.has(st.id)) state.expandedCards.delete(st.id);
      else state.expandedCards.add(st.id);
      render();
    });
    r.appendChild(exp);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!st.done;
    cb.addEventListener('click', ev => ev.stopPropagation());
    cb.addEventListener('change', () => {
      st.done = cb.checked;
      st.done_at = cb.checked ? isoNow() : null;
      scheduleSave();
      render();
    });
    r.appendChild(cb);

    // Category color dot for the task (uses sub-bucket category, not project color)
    const dot = document.createElement('span');
    const taskColor = CAT_COLOR[row.bucket && row.bucket.category] || '#d1d5db';
    dot.title = (CAT_LABEL[row.bucket && row.bucket.category] || row.bucket && row.bucket.category || '');
    dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${taskColor};flex-shrink:0`;
    r.appendChild(dot);

    const t = document.createElement('span');
    t.className = 'pin-title';
    t.textContent = st.text || '(untitled)';
    t.addEventListener('click', () => {
      if (state.expandedCards.has(st.id)) state.expandedCards.delete(st.id);
      else state.expandedCards.add(st.id);
      render();
    });
    r.appendChild(t);

    // Pin to "Today I Must" — toggles top-of-page pinning.
    const pin = document.createElement('button');
    const pinned = state.pinnedToday.has(st.id);
    pin.className = 'pin-today-btn' + (pinned ? ' active' : '');
    pin.title = pinned ? 'Unpin from Today' : 'Pin to Today I Must';
    pin.textContent = '📌';
    pin.addEventListener('click', (ev) => {
      ev.stopPropagation();
      togglePinnedToday(st.id);
      render();
    });
    r.appendChild(pin);

    card.appendChild(r);

    const isExpanded = state.expandedCards.has(st.id);

    // Children FIRST — directly under the title:
    //  - collapsed parent  → simple bullet list of all descendants
    //  - expanded parent   → full subtask cards (each with their own chips/expand)
    if ((st.children || []).length) {
      if (isExpanded && depth + 1 < MAX_DEPTH) {
        const childWrap = document.createElement('div');
        childWrap.className = 'pin-children';
        const sortByDue = (a, b) => {
          const ad = aggregateDue(a.subtask) || (a.subtask.due_date && a.subtask.due_date !== 'TBD' ? a.subtask.due_date : '9999-99-99');
          const bd = aggregateDue(b.subtask) || (b.subtask.due_date && b.subtask.due_date !== 'TBD' ? b.subtask.due_date : '9999-99-99');
          return String(ad).localeCompare(String(bd));
        };
        const childRows = st.children
          .map(ch => ({ subtask: ch, bucket: row.bucket, depth: depth + 1 }))
          .sort(sortByDue);
        for (const cr of childRows) childWrap.appendChild(renderSubtaskCard(project, cr));
        card.appendChild(childWrap);
      } else {
        card.appendChild(renderBulletList(st));
      }
    }

    // Chips row AFTER subtasks: aggregated due, priority, hours, pacing, sub-bucket label.
    const chips = document.createElement('div');
    chips.className = 'pin-card-chips';
    appendChips(chips, st);
    if (row.bucket && row.bucket.title && row.bucket.title !== 'General' && depth === 0) {
      const sb = document.createElement('span');
      sb.style.cssText = 'font-size:10px;color:#6b7280;background:#f3f4f6;padding:1px 6px;border-radius:8px;text-transform:uppercase;letter-spacing:.3px';
      sb.textContent = row.bucket.sub_category || row.bucket.title.replace(/^[^\/]+\/\s*/, '');
      chips.appendChild(sb);
    }
    card.appendChild(chips);

    if (isExpanded) {
      card.appendChild(renderCardBody(project, row));
    }

    // Inline "+ Add subtask" input — only when this task is EXPANDED and depth allows.
    if (isExpanded && depth + 1 < MAX_DEPTH) {
      const addRow = document.createElement('div');
      addRow.className = 'pin-add-child';
      const inp = document.createElement('input');
      inp.placeholder = '+ Add subtask';
      inp.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' || !inp.value.trim()) return;
        st.children = st.children || [];
        st.children.push({
          id: newId('sub'), text: inp.value.trim(), description: '',
          done: false, done_at: null,
          due_date: 'TBD', priority: 'normal',
          hours_estimate: 0, tracker_entry_id: null,
          evidence: emptyEvidence(), notes: '',
          proposed: false, children: [],
        });
        inp.value = '';
        scheduleSave();
        render();
      });
      addRow.appendChild(inp);
      card.appendChild(addRow);
    }

    return card;
  }

  // Flat bullet list of all descendants of `node`, indented by depth, with a
  // checkbox per item. Used when the parent task is COLLAPSED so the user can
  // still see and tick off subtasks at a glance.
  function renderBulletList(node) {
    const wrap = document.createElement('div');
    wrap.className = 'pin-bullets';
    function add(arr, depth) {
      for (const ch of arr || []) {
        const li = document.createElement('div');
        li.className = 'pin-bullet' + (ch.done ? ' done' : '');
        li.style.paddingLeft = (depth * 14) + 'px';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!ch.done;
        cb.addEventListener('click', ev => ev.stopPropagation());
        cb.addEventListener('change', () => {
          ch.done = cb.checked;
          ch.done_at = cb.checked ? isoNow() : null;
          scheduleSave();
          render();
        });
        li.appendChild(cb);
        const t = document.createElement('span');
        t.textContent = ch.text || '(untitled)';
        li.appendChild(t);
        wrap.appendChild(li);
        if ((ch.children || []).length) add(ch.children, depth + 1);
      }
    }
    add(node.children, 0);
    return wrap;
  }

  const appendChips = CG.appendChips;

  function renderCardBody(project, row) {
    const st = row.subtask;
    const body = document.createElement('div');
    body.className = 'pin-card-body';
    if (st.description) {
      const d = document.createElement('div');
      d.className = 'pin-desc';
      d.textContent = st.description;
      body.appendChild(d);
    }
    const grid = document.createElement('div');
    grid.className = 'pin-meta-grid';
    grid.innerHTML = `
      <div><span class="meta-k">Due</span><input type="date" value="${(st.due_date && st.due_date !== 'TBD') ? st.due_date : ''}" data-field="due_date" style="font-size:12px;padding:2px 4px;border:1px solid #e5e7eb;border-radius:4px"></div>
      <div><span class="meta-k">Hours</span><input type="number" value="${Number(st.hours_estimate) || 0}" step="0.25" min="0" data-field="hours_estimate" style="font-size:12px;padding:2px 4px;border:1px solid #e5e7eb;border-radius:4px;width:70px"></div>
      <div><span class="meta-k">Priority</span><select data-field="priority" style="font-size:12px;padding:2px 4px;border:1px solid #e5e7eb;border-radius:4px"><option ${st.priority==='low'?'selected':''}>low</option><option ${st.priority==='normal'||!st.priority?'selected':''}>normal</option><option ${st.priority==='high'?'selected':''}>high</option><option ${st.priority==='urgent'?'selected':''}>urgent</option></select></div>
    `;
    grid.querySelectorAll('input[data-field], select[data-field]').forEach(el => {
      el.addEventListener('change', () => {
        const f = el.dataset.field;
        if (f === 'due_date') st.due_date = el.value || 'TBD';
        else if (f === 'hours_estimate') st.hours_estimate = Number(el.value) || 0;
        else if (f === 'priority') st.priority = el.value;
        scheduleSave();
        render();
      });
    });
    body.appendChild(grid);

    const btns = document.createElement('div');
    btns.className = 'pin-card-btns';
    const open = document.createElement('a');
    open.className = 'btn btn-sm';
    open.textContent = 'Open in adder';
    open.style.textDecoration = 'none';
    open.href = `/pages/tasks-add.html#${encodeURIComponent(st.id)}`;
    btns.appendChild(open);
    const del = document.createElement('button');
    del.className = 'btn btn-sm btn-danger';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      if (!confirm('Delete subtask?')) return;
      removeSubtask(row.bucket, st);
      scheduleSave();
      render();
    });
    btns.appendChild(del);
    body.appendChild(btns);
    return body;
  }

  function removeSubtask(bucket, st) {
    function trim(arr) {
      const i = arr.indexOf(st);
      if (i >= 0) { arr.splice(i, 1); return true; }
      for (const s of arr) if (trim(s.children || [])) return true;
      return false;
    }
    trim(bucket.subtasks || []);
  }

  /* ----- pin menu (proposed → real bucket) ----- */
  function openPinMenu(anchor, node, fromProject, fromBucket) {
    closePinMenu();
    const menu = document.createElement('div');
    menu.className = 'buk-pin-menu';
    menu.id = 'buk-pin-menu';
    const rect = anchor.getBoundingClientRect();
    menu.style.left = (rect.left + window.scrollX) + 'px';
    menu.style.top  = (rect.bottom + window.scrollY + 4) + 'px';
    for (const p of state.doc.projects || []) {
      if (p.id === 'proj-inbox') continue;
      const opt = document.createElement('div');
      opt.className = 'pin-opt';
      opt.textContent = p.title;
      opt.addEventListener('click', () => {
        // Move node into the project's default bucket
        fromBucket.subtasks = (fromBucket.subtasks || []).filter(x => x !== node);
        node.proposed = false;
        const dest = ensureDefaultBucket(p);
        dest.subtasks.push(node);
        if (state.hidden.has(p.id)) { state.hidden.delete(p.id); persistHidden(); }
        closePinMenu();
        scheduleSave();
        render();
      });
      menu.appendChild(opt);
    }
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', pinMenuOutside, { once: true }), 0);
  }
  function pinMenuOutside(ev) {
    if (ev.target.closest('#buk-pin-menu')) return;
    closePinMenu();
  }

  /* ----- color menu ----- */
  function openColorMenu(anchor, project) {
    closeColorMenu();
    const menu = document.createElement('div');
    menu.className = 'buk-pin-menu';
    menu.id = 'buk-color-menu';
    const rect = anchor.getBoundingClientRect();
    menu.style.left = (rect.left + window.scrollX) + 'px';
    menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';
    const swatchRow = document.createElement('div');
    swatchRow.style.cssText = 'display:grid;grid-template-columns:repeat(5,1fr);gap:6px;padding:8px';
    for (const color of PROJECT_COLORS) {
      const sw = document.createElement('button');
      sw.style.cssText = `width:24px;height:24px;border-radius:6px;border:2px solid ${color === projectColor(project) ? '#111827' : 'rgba(0,0,0,.15)'};background:${color};cursor:pointer;padding:0`;
      sw.addEventListener('click', () => {
        project.color = color;
        closeColorMenu();
        scheduleSave();
        render();
      });
      swatchRow.appendChild(sw);
    }
    menu.appendChild(swatchRow);
    const reset = document.createElement('div');
    reset.className = 'pin-opt';
    reset.style.fontSize = '11px';
    reset.style.color = '#6b7280';
    reset.textContent = 'Reset to category default';
    reset.addEventListener('click', () => {
      delete project.color;
      closeColorMenu();
      scheduleSave();
      render();
    });
    menu.appendChild(reset);
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', colorMenuOutside, { once: true }), 0);
  }
  function colorMenuOutside(ev) {
    if (ev.target.closest('#buk-color-menu')) return;
    closeColorMenu();
  }
  function closeColorMenu() {
    const m = document.getElementById('buk-color-menu');
    if (m) m.remove();
  }
  function closePinMenu() {
    const m = document.getElementById('buk-pin-menu');
    if (m) m.remove();
  }

  /* ----- hidden projects panel ----- */
  function renderHidden() {
    const wrap = document.createElement('div');
    if (!state.hidden.size) return wrap;
    wrap.style.cssText = 'margin-top:14px;padding:10px;border-top:1px dashed #e5e7eb;font-size:11px;color:#6b7280';
    const hiddenProjs = (state.doc.projects || []).filter(p => state.hidden.has(p.id));
    wrap.textContent = `Hidden from dashboard (${hiddenProjs.length}): `;
    for (const p of hiddenProjs) {
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = p.title;
      a.style.marginRight = '10px';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        state.hidden.delete(p.id);
        persistHidden();
        render();
      });
      wrap.appendChild(a);
    }
    return wrap;
  }

  /* ---------- boot ---------- */
  async function loadItemsIndex() {
    try {
      const doc = await api.load('items.json');
      const idx = {};
      for (const it of (doc.items || [])) idx[it.id] = it;
      state.itemsIndex = idx;
    } catch {}
  }

  // Phase 8: pull tasks assigned to me by teammates from
  // userData/{currentUid}/tasks where bucket=='assigned'.
  async function loadAssignedTasks() {
    try {
      const doc = await api.load('tasks/assigned.json');
      state.assignedTasks = (doc && doc.tasks) || [];
    } catch (err) {
      state.assignedTasks = [];
      console.warn('[tasks-dashboard] assigned-tasks load failed:', err.message);
    }
  }

  // Phase 8 polish: pull tasks the current user has dropped into other lab
  // members' queues. Lives across all userData/*/tasks subcollections, so
  // requires a collectionGroup query. Firestore rules already permit reading
  // any task where createdByUid == request.auth.uid.
  async function loadTasksISent() {
    state.tasksISent = [];
    try {
      if (typeof firebridge === 'undefined' || !firebridge.db) return;
      const me = firebridge.getUser && firebridge.getUser();
      if (!me) return;
      const snap = await firebridge.db()
        .collectionGroup('tasks')
        .where('createdByUid', '==', me.uid)
        .where('bucket', '==', 'assigned')
        .get();
      state.tasksISent = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
    } catch (err) {
      // Most common failure: missing composite index. Surface a console hint
      // with the link Firestore prints — the user can click through to create
      // the index and the section starts working on the next page load.
      console.warn('[tasks-dashboard] tasks-i-sent load failed:', err.message);
    }
  }

  /* Phase 8 polish: live-sync for "Assigned by me" via a collectionGroup
   * onSnapshot. When the assignee marks complete (or any other field changes),
   * the assigner sees it without a reload. First fire suppressed so the
   * boot-time snapshot doesn't double-render — loadTasksISent already painted
   * with the same data. */
  var _tasksISentUnsub = null;
  function attachTasksISentLive() {
    if (_tasksISentUnsub) return;
    if (typeof firebridge === 'undefined' || !firebridge.db) return;
    const me = firebridge.getUser && firebridge.getUser();
    if (!me) return;
    try {
      var firstFire = true;
      _tasksISentUnsub = firebridge.db()
        .collectionGroup('tasks')
        .where('createdByUid', '==', me.uid)
        .where('bucket', '==', 'assigned')
        .onSnapshot(function (snap) {
          state.tasksISent = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
          if (firstFire) { firstFire = false; return; }
          render();
        }, function (err) {
          // Same composite-index caveat as loadTasksISent — the user has to
          // click through the index-create link in the console once.
          console.warn('[tasks-dashboard] tasks-i-sent live sync failed:', err.message);
        });
    } catch (err) {
      console.warn('[tasks-dashboard] tasks-i-sent attach failed:', err.message);
    }
  }

  function applyProjectQueryParam() {
    try {
      const params = new URLSearchParams(window.location.search);
      const target = params.get('project');
      if (!target) return;
      // Unhide if hidden, focus the box.
      if (state.hidden.has(target)) {
        state.hidden.delete(target);
        persistHidden();
      }
      state.focusedProjectId = target;
    } catch {}
  }

  async function boot() {
    try {
      // Wait for auth to resolve so user-scope reads hit Firestore (not the
      // legacy single-tenant JSON fallback). Without this, first paint reads
      // empty and the user sees a blank workspace until they refresh.
      if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
        await firebridge.whenAuthResolved();
      }
      await Promise.all([loadDoc(), loadItemsIndex(), loadAssignedTasks(), loadTasksISent()]);
      // First-run: hide auto-migrated category projects by default so the dashboard starts clean.
      // User can unhide via the bottom panel or via tasks-add.html.
      if (!localStorage.getItem('tasksDash.firstRunSeeded')) {
        for (const p of state.doc.projects || []) {
          // Only auto-hide auto-seeded category projects (their id matches `proj-<category>` exactly).
          // Keep user-created ones (which have a timestamp suffix).
          if (/^proj-(research|teaching|service|admin|noise|personal|unknown|mentorship|uncategorized)$/.test(p.id)) {
            state.hidden.add(p.id);
          }
        }
        persistHidden();
        localStorage.setItem('tasksDash.firstRunSeeded', '1');
      }
      applyProjectQueryParam();
      render();
      attachLiveSync();
      attachTasksISentLive();
      if (state.focusedProjectId) {
        requestAnimationFrame(() => {
          const focused = document.querySelector('.pin-box.focused');
          if (focused) focused.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    } catch (err) {
      root().innerHTML = `<div style="padding:40px;text-align:center;color:#9ca3af">Failed to load buckets.json — ${escapeHtml(err.message)}<br>Run <code>python3 scripts/migrate_inbox_to_buckets.py</code> first.</div>`;
      console.error(err);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
