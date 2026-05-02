/* tasks-buckets.js — Bucket + Subtask workspace (three-tier model).
 *
 * Reads/writes data/tasks/buckets.json.
 *
 * Schema (see scripts/migrate_inbox_to_buckets.py):
 *   { projects: [{ id, title, status, category, due_date, hours_estimate,
 *                  tracker_entry_id, evidence:{email_ids,event_ids,item_ids},
 *                  notes, created_at, completed_at, reserved?,
 *                  buckets: [{ id, category, sub_category, title, due_date,
 *                              hours_estimate, tracker_entry_id, evidence,
 *                              notes, reserved?,
 *                              subtasks: [ Subtask ] }] }],
 *     updated_at: iso }
 *   Subtask: { id, text, description?, done, done_at, due_date, priority,
 *              hours_estimate, tracker_entry_id, evidence, notes,
 *              assignee_uid?, assignees_uids?, assigned_at?, assigned_by_uid?,
 *              block_status?,                   // null | 'need' | 'waiting'
 *              proposed?, proposed_source?, proposed_at?,
 *              legacy_task_id?, snoozed_until?, children: [Subtask] }
 *
 *   assignee_uid is the primary owner (uid → users/{uid}); assignees_uids is an
 *   optional secondary list. The PMR page reads these to roll up "open tasks
 *   for student X". block_status surfaces in PMR's discussion suggestions.
 */

(function () {
  const DATA_PATH = 'tasks/buckets.json';
  const MAX_DEPTH = 3;                  // 0, 1, 2 — no children at depth 2
  const YR = window.YR_SHARED || {};
  const CAT_COLOR = YR.CAT_COLOR || {};
  const CAT_LABEL = YR.CAT_LABEL || {};
  const escapeHtml = YR.escapeHtml || (s => String(s || ''));

  /* ---------- state ---------- */
  const SHOW_COMPLETED_KEY = 'tasksAdd.showCompleted';
  const DASH_HIDDEN_KEY    = 'tasksDash.hiddenProjects'; // shared with tasks-dashboard-buckets.js

  function dashHiddenSet() {
    try { return new Set(JSON.parse(localStorage.getItem(DASH_HIDDEN_KEY) || '[]')); }
    catch { return new Set(); }
  }
  function dashUnhide(projectId) {
    const s = dashHiddenSet();
    if (s.has(projectId)) {
      s.delete(projectId);
      localStorage.setItem(DASH_HIDDEN_KEY, JSON.stringify([...s]));
    }
  }
  const state = {
    doc: null,
    activeProjectId: null,
    selectedNode: null,          // { kind, id, parentRef? } for detail pane
    searchQuery: '',
    showCompleted: localStorage.getItem(SHOW_COMPLETED_KEY) === '1',
    expandedBuckets: new Set(),  // bucket ids currently expanded
    expandedSubtasks: new Set(), // subtask ids whose children are visible
    expandedEdit: new Set(),     // subtask ids whose inline edit body is open
    collapsedProjects: new Set(),
    saveTimer: null,
  };

  /* ---------- io ----------
   * Routed through the firestore adapter (js/api-firestore-adapter.js +
   * js/api-routes.js) — `tasks/buckets.json` maps to userData/{uid}/buckets,
   * one Firestore doc per project. Multi-tenant isolation is enforced by
   * the adapter: each lab member's reads return their own buckets, not Alex's.
   *
   * Live sync via api.subscribe — a second tab of the same user (or, once
   * Phase 8 ships, a teammate dropping a task into your inbox) propagates
   * here without refresh. Self-write suppression: each saveDoc bumps
   * `_suppressUntil` so the immediate Firestore snapshot echo is ignored.
   * In-flight inline edits are preserved — if state.expandedEdit has any
   * open form, the incoming doc is stashed and applied once edits close.
   */
  var _suppressUntil = 0;
  var _liveUnsub = null;
  var _pendingDoc = null;
  var _savePending = false;   // true between scheduleSave() and saveDoc() resolving;
                              // gates the live-sync callback so a remote snapshot
                              // can't clobber an in-memory edit before it's persisted.

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
      // Leave _savePending true so a subsequent edit (via scheduleSave) will
      // retry. If that never happens, the in-memory state is still preserved
      // until the user takes another action.
      console.error('[tasks-buckets] save failed:', err);
      throw err;
    }
  }

  function attachLiveSync() {
    if (_liveUnsub || typeof api.subscribe !== 'function') return;
    try {
      _liveUnsub = api.subscribe(DATA_PATH, function (data) {
        // Skip our own write echo (just-saved → snapshot incoming).
        if (Date.now() < _suppressUntil) return;
        // Skip while a local edit is pending — replacing state.doc here would
        // wipe the user's typed-but-not-yet-saved content.
        if (_savePending) return;
        if (!data || !Array.isArray(data.projects)) return;
        // Defer when an inline-edit form is open so typing isn't disrupted.
        if (state.expandedEdit && state.expandedEdit.size > 0) {
          _pendingDoc = data;
          return;
        }
        state.doc = data;
        render();
      });
    } catch (err) {
      console.warn('[tasks-buckets] live sync failed to attach:', err.message);
    }
  }

  /* ---------- helpers ---------- */
  function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  function newId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function isoNow() { return new Date().toISOString(); }

  function emptyEvidence() { return { email_ids: [], event_ids: [], item_ids: [] }; }

  /* ---------- lab member cache ----------
   * Loaded once on boot from Firestore users collection so the assignee
   * picker + chip can render synchronously from the bucket detail pane.
   * Keyed by uid; { uid, name, email, category, color }.
   */
  var _labMembers = [];
  var _labMembersByUid = {};
  var _labMembersLoaded = false;
  var ASSIGNEE_CATEGORIES = ['pi', 'postdoc', 'grad', 'undergrad', 'highschool'];
  // Stable per-uid color from a 9-slot palette so chips/initials are
  // recognizable across the page without needing a profile lookup.
  var ASSIGNEE_COLORS = ['#1e40af','#16a34a','#b45309','#7c3aed','#0e7490','#be185d','#15803d','#92400e','#1f2937'];

  async function loadLabMembers() {
    if (typeof firebridge === 'undefined' || !firebridge.getAll) return;
    try {
      var d = await api.load('lab/users.json');
      var users = (d && d.users) || [];
      _labMembers = users
        .filter(function (u) { return ASSIGNEE_CATEGORIES.indexOf(u.category) !== -1; })
        .map(function (u, i) {
          return {
            uid: u.uid || u.id,
            name: u.name || u.displayName || u.email || u.uid || u.id,
            email: u.email || '',
            category: u.category,
            color: ASSIGNEE_COLORS[i % ASSIGNEE_COLORS.length],
          };
        })
        .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
      _labMembersByUid = {};
      _labMembers.forEach(function (m) { _labMembersByUid[m.uid] = m; });
      _labMembersLoaded = true;
    } catch (err) {
      console.warn('[tasks-buckets] lab members load failed:', err && err.message);
    }
  }

  function memberByUid(uid) { return uid && _labMembersByUid[uid] || null; }

  function assigneeChipEl(uid) {
    if (!uid) return null;
    var m = memberByUid(uid);
    var label = m ? (m.name || m.email || uid) : uid;
    var bg = m ? m.color : '#6b7280';
    var c = document.createElement('span');
    c.className = 'buk-st-chip assignee';
    c.title = 'Assigned to ' + label;
    c.style.background = bg;
    c.style.color = '#fff';
    c.style.fontWeight = '600';
    c.textContent = (typeof initials === 'function') ? initials(m ? m.name : uid) : String(label).slice(0, 2).toUpperCase();
    return c;
  }

  function findProject(pid) {
    return (state.doc.projects || []).find(p => p.id === pid);
  }
  function findBucket(project, bid) {
    return (project.buckets || []).find(b => b.id === bid);
  }
  function walkSubtasks(bucket, fn, depth = 0, parent = null, path = []) {
    for (const st of bucket.subtasks || []) {
      fn(st, depth, parent, path);
      if (st.children && st.children.length) {
        walkSubtasks({ subtasks: st.children }, fn, depth + 1, st, path.concat(st));
      }
    }
  }
  function findSubtaskById(bucket, id) {
    let found = null;
    walkSubtasks(bucket, (st, _d, parent) => {
      if (st.id === id) found = { node: st, parent };
    });
    return found;
  }

  /* ---------- rollups ---------- */
  function rollupBucket(bucket) {
    let open = 0, done = 0, hours = Number(bucket.hours_estimate) || 0, earliest = null;
    let worst = null;
    const priOrder = { urgent: 4, high: 3, normal: 2, low: 1 };
    walkSubtasks(bucket, (st) => {
      if (st.done) { done++; } else { open++; }
      hours += Number(st.hours_estimate) || 0;
      if (!st.done && st.due_date && st.due_date !== 'TBD') {
        if (!earliest || st.due_date < earliest) earliest = st.due_date;
      }
      const p = st.priority;
      if (!st.done && p && (!worst || (priOrder[p] || 0) > (priOrder[worst] || 0))) worst = p;
    });
    return { open, done, hours, earliest, worst };
  }
  function rollupProject(project) {
    let open = 0, done = 0, hours = Number(project.hours_estimate) || 0, earliest = null, worst = null;
    const priOrder = { urgent: 4, high: 3, normal: 2, low: 1 };
    for (const b of project.buckets || []) {
      const r = rollupBucket(b);
      open += r.open;
      done += r.done;
      hours += r.hours; // rollupBucket already includes bucket.hours_estimate + all descendants
      if (r.earliest && (!earliest || r.earliest < earliest)) earliest = r.earliest;
      if (r.worst && (!worst || (priOrder[r.worst] || 0) > (priOrder[worst] || 0))) worst = r.worst;
    }
    return { open, done, hours, earliest, worst };
  }

  function duePrefix(date) {
    if (!date || date === 'TBD') return '';
    const today = todayStr();
    if (date < today) return 'due-overdue';
    const d = new Date(date).getTime(), t = new Date(today).getTime();
    const days = (d - t) / 86400000;
    if (days <= 3) return 'due-soon';
    return '';
  }

  /* ---------- flat index (for search) ---------- */
  function buildFlatIndex() {
    const out = [];
    for (const p of state.doc.projects || []) {
      for (const b of p.buckets || []) {
        walkSubtasks(b, (st, depth, parent, path) => {
          out.push({
            subtask: st,
            project: p,
            bucket: b,
            depth,
            parent,
            path,
          });
        });
      }
    }
    return out;
  }

  function matchesSearch(row, q) {
    if (!q) return true;
    const ql = q.toLowerCase();
    const t = (row.subtask.text || '').toLowerCase();
    if (t.includes(ql)) return true;
    const d = (row.subtask.description || '').toLowerCase();
    if (d.includes(ql)) return true;
    const n = (row.subtask.notes || '').toLowerCase();
    if (n.includes(ql)) return true;
    if ((row.bucket.title || '').toLowerCase().includes(ql)) return true;
    if ((row.project.title || '').toLowerCase().includes(ql)) return true;
    return false;
  }

  /* ---------- rendering ---------- */
  const root = () => document.getElementById('dash-content');

  function render() {
    const el = root();
    if (!el) return;
    el.innerHTML = '';
    el.appendChild(renderLayout());
    // Drain a deferred remote update if no inline edit is open. Live-sync
    // stashes incoming snapshots while the user is typing into an inline
    // form; once they close the edit (clearing expandedEdit), the next
    // render here picks up the queued doc transparently.
    if (_pendingDoc && (!state.expandedEdit || state.expandedEdit.size === 0)) {
      const queued = _pendingDoc;
      _pendingDoc = null;
      state.doc = queued;
      el.innerHTML = '';
      el.appendChild(renderLayout());
    }
  }

  function renderLayout() {
    const wrap = document.createElement('div');
    wrap.className = 'buk-layout' + (state.selectedNode ? ' has-detail' : '');
    wrap.appendChild(renderProjectCol());
    wrap.appendChild(renderMain());
    if (state.selectedNode) wrap.appendChild(renderDetail());
    return wrap;
  }

  /* ----- project column ----- */
  function renderProjectCol() {
    const col = document.createElement('div');
    col.className = 'buk-proj-col';
    const projects = state.doc.projects || [];
    for (const p of projects) {
      const row = document.createElement('div');
      row.className = 'buk-proj-row' + (p.id === state.activeProjectId ? ' active' : '') + (p.reserved ? ' reserved' : '');
      const dot = document.createElement('span');
      dot.className = 'buk-proj-dot';
      dot.style.background = CAT_COLOR[p.category] || '#9ca3af';
      row.appendChild(dot);
      const title = document.createElement('span');
      title.className = 'buk-proj-title';
      title.textContent = p.title;
      row.appendChild(title);
      const r = rollupProject(p);
      const count = document.createElement('span');
      count.className = 'buk-proj-count';
      count.textContent = r.open ? `${r.open}` : '';
      row.appendChild(count);
      row.addEventListener('click', () => {
        state.activeProjectId = p.id;
        state.searchQuery = '';
        state.selectedNode = null;
        state.expandedBuckets = new Set();   // start fresh — all sub-buckets collapsed
        state.expandedSubtasks = new Set();
        render();
      });
      col.appendChild(row);
    }
    // Add project
    const add = document.createElement('div');
    add.className = 'buk-proj-new';
    const inp = document.createElement('input');
    inp.placeholder = '+ New project';
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && inp.value.trim()) {
        const title = inp.value.trim();
        const id = `proj-${slugify(title)}-${Date.now().toString(36)}`;
        state.doc.projects.push({
          id, title, status: 'active', category: '',
          due_date: 'TBD', hours_estimate: 0, tracker_entry_id: null,
          evidence: emptyEvidence(), notes: '',
          created_at: todayStr(), completed_at: null, buckets: [],
        });
        state.activeProjectId = id;
        scheduleSave();
        render();
      }
    });
    add.appendChild(inp);
    col.appendChild(add);
    return col;
  }

  /* ----- main pane ----- */
  function renderMain() {
    const main = document.createElement('div');
    main.className = 'buk-main';
    main.appendChild(renderSearchBar());
    if (state.searchQuery) {
      main.appendChild(renderSearchResults());
    } else {
      const p = findProject(state.activeProjectId);
      if (!p) {
        const hint = document.createElement('div');
        hint.className = 'buk-search-empty';
        hint.textContent = 'Pick a project from the left, or create a new one.';
        main.appendChild(hint);
      } else {
        main.appendChild(renderProjectHead(p));
        for (const b of p.buckets || []) {
          // Hide buckets that have no visible subtasks (after the show-completed filter)
          if (!state.showCompleted) {
            const anyOpen = bucketHasOpenSubtask(b);
            if (!anyOpen) continue;
          }
          main.appendChild(renderBucket(p, b));
        }
        main.appendChild(renderAddBucket(p));
      }
    }
    return main;
  }

  function renderSearchBar() {
    const bar = document.createElement('div');
    bar.className = 'buk-search-row';
    const inp = document.createElement('input');
    inp.placeholder = 'Search all subtasks…';
    inp.value = state.searchQuery;
    inp.addEventListener('input', () => {
      state.searchQuery = inp.value.trim();
      renderMainOnly();
    });
    bar.appendChild(inp);

    // Show-completed toggle
    const cbWrap = document.createElement('label');
    cbWrap.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:12px;color:#374151;cursor:pointer;white-space:nowrap';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.showCompleted;
    cb.addEventListener('change', () => {
      state.showCompleted = cb.checked;
      localStorage.setItem(SHOW_COMPLETED_KEY, cb.checked ? '1' : '0');
      render();
    });
    cbWrap.appendChild(cb);
    cbWrap.appendChild(document.createTextNode(' show completed'));
    bar.appendChild(cbWrap);

    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = state.searchQuery ? '(across all projects)' : '';
    bar.appendChild(hint);
    return bar;
  }

  function renderMainOnly() {
    // Rerender just the main column without losing input focus.
    // Easiest: full re-render but then restore focus to search box.
    const activeInSearch = document.activeElement && document.activeElement.closest('.buk-search-row');
    render();
    if (activeInSearch) {
      const inp = document.querySelector('.buk-search-row input');
      if (inp) {
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
      }
    }
  }

  function renderSearchResults() {
    const box = document.createElement('div');
    box.className = 'buk-search-results';
    const flat = buildFlatIndex();
    const matches = flat
      .filter(row => state.showCompleted || !row.subtask.done)
      .filter(row => matchesSearch(row, state.searchQuery))
      .slice(0, 200);
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'buk-search-empty';
      empty.textContent = 'No matching subtasks.';
      box.appendChild(empty);
      return box;
    }
    for (const row of matches) {
      const item = document.createElement('div');
      item.style.padding = '6px 4px';
      item.style.borderBottom = '1px solid #f3f4f6';
      item.style.cursor = 'pointer';
      const crumb = document.createElement('div');
      crumb.className = 'buk-crumb';
      const pathCrumbs = row.path.map(x => escapeHtml(x.text)).join(' › ');
      crumb.innerHTML = `${escapeHtml(row.project.title)} › ${escapeHtml(row.bucket.title)}${pathCrumbs ? ' › ' + pathCrumbs : ''}`;
      item.appendChild(crumb);
      item.appendChild(renderSubtaskRow(row.project, row.bucket, row.subtask, 0, { inSearch: true }));
      item.addEventListener('click', (ev) => {
        if (ev.target.closest('button, input')) return;
        state.activeProjectId = row.project.id;
        state.searchQuery = '';
        state.expandedBuckets.add(row.bucket.id);
        for (const a of row.path) state.expandedSubtasks.add(a.id);
        state.selectedNode = { kind: 'subtask', projectId: row.project.id, bucketId: row.bucket.id, subtaskId: row.subtask.id };
        render();
      });
      box.appendChild(item);
    }
    return box;
  }

  function renderProjectHead(p) {
    const head = document.createElement('div');
    head.className = 'buk-proj-head';
    const h2 = document.createElement('h2');
    h2.textContent = p.title;
    h2.title = 'Double-click to rename';
    h2.style.cursor = 'text';
    h2.addEventListener('dblclick', () => {
      const v = prompt('Project title:', p.title);
      if (v != null && v.trim()) { p.title = v.trim(); scheduleSave(); render(); }
    });
    head.appendChild(h2);
    const r = rollupProject(p);
    const roll = document.createElement('span');
    roll.className = 'buk-rollup';
    roll.textContent = `Σ ${r.hours.toFixed(1)}h · ${r.open} open · ${r.done} done${r.earliest ? ' · next ' + r.earliest.slice(5) : ''}`;
    head.appendChild(roll);

    // Expand-all / Collapse-all
    const expandAll = document.createElement('button');
    expandAll.className = 'btn btn-sm';
    expandAll.textContent = 'Expand all';
    expandAll.style.marginLeft = '8px';
    expandAll.addEventListener('click', () => {
      for (const b of p.buckets || []) state.expandedBuckets.add(b.id);
      render();
    });
    head.appendChild(expandAll);
    const collapseAll = document.createElement('button');
    collapseAll.className = 'btn btn-sm';
    collapseAll.textContent = 'Collapse all';
    collapseAll.addEventListener('click', () => {
      state.expandedBuckets = new Set();
      state.expandedSubtasks = new Set();
      render();
    });
    head.appendChild(collapseAll);

    const linkBtn = document.createElement('button');
    linkBtn.className = 'btn btn-sm';
    linkBtn.textContent = 'Edit';
    linkBtn.title = 'Edit project metadata';
    linkBtn.addEventListener('click', () => {
      state.selectedNode = { kind: 'project', projectId: p.id };
      render();
    });
    head.appendChild(linkBtn);
    return head;
  }

  function bucketHasOpenSubtask(bucket) {
    let any = false;
    walkSubtasks(bucket, (st) => { if (!st.done) any = true; });
    return any;
  }

  function renderBucket(project, bucket) {
    const acc = document.createElement('div');
    const expanded = state.expandedBuckets.has(bucket.id);
    acc.className = 'buk-accordion' + (expanded ? '' : ' collapsed');
    const head = document.createElement('div');
    head.className = 'buk-accordion-head';
    head.innerHTML = `<span class="buk-caret">${expanded ? '▾' : '▸'}</span>`;
    if (bucket.category) {
      const chip = document.createElement('span');
      chip.className = 'buk-cat-chip';
      chip.style.background = CAT_COLOR[bucket.category] || '#6b7280';
      chip.textContent = (CAT_LABEL[bucket.category] || bucket.category).slice(0, 8);
      head.appendChild(chip);
    }
    const title = document.createElement('span');
    title.className = 'buk-accordion-title';
    title.textContent = bucket.title;
    head.appendChild(title);
    if (bucket.sub_category) {
      const sub = document.createElement('span');
      sub.className = 'buk-accordion-sub';
      sub.textContent = bucket.sub_category;
      head.appendChild(sub);
    }
    const r = rollupBucket(bucket);
    const pill = document.createElement('span');
    pill.className = 'buk-rollup-pill';
    const bits = [];
    if (r.hours) bits.push(`Σ ${r.hours.toFixed(1)}h`);
    bits.push(`${r.open} open`);
    if (r.earliest) bits.push(`next ${r.earliest.slice(5)}`);
    pill.textContent = bits.join(' · ');
    head.appendChild(pill);
    head.addEventListener('click', (ev) => {
      if (ev.target.closest('button, input')) return;
      if (state.expandedBuckets.has(bucket.id)) state.expandedBuckets.delete(bucket.id);
      else state.expandedBuckets.add(bucket.id);
      render();
    });
    acc.appendChild(head);

    const body = document.createElement('div');
    body.className = 'buk-accordion-body';
    body.appendChild(renderSubtaskTree(project, bucket));
    body.appendChild(renderAddSubtask(project, bucket, null));
    acc.appendChild(body);
    return acc;
  }

  function renderSubtaskTree(project, bucket) {
    const wrap = document.createElement('div');
    wrap.className = 'buk-tree';
    for (const st of bucket.subtasks || []) {
      if (!state.showCompleted && st.done) continue;
      wrap.appendChild(renderSubtaskRow(project, bucket, st, 0));
      if (state.expandedEdit.has(st.id)) {
        wrap.appendChild(renderInlineEditBody(project, bucket, st, 0));
      }
      if (state.expandedSubtasks.has(st.id) && st.children && st.children.length) {
        wrap.appendChild(renderSubtaskChildren(project, bucket, st, 1));
      }
    }
    return wrap;
  }

  function renderSubtaskChildren(project, bucket, parent, depth) {
    const wrap = document.createElement('div');
    for (const ch of parent.children || []) {
      if (!state.showCompleted && ch.done) continue;
      wrap.appendChild(renderSubtaskRow(project, bucket, ch, depth, { parent }));
      if (state.expandedEdit.has(ch.id)) {
        wrap.appendChild(renderInlineEditBody(project, bucket, ch, depth));
      }
      if (state.expandedSubtasks.has(ch.id) && ch.children && ch.children.length && depth + 1 < MAX_DEPTH) {
        wrap.appendChild(renderSubtaskChildren(project, bucket, ch, depth + 1));
      }
    }
    return wrap;
  }

  function renderInlineEditBody(project, bucket, st, depth) {
    const body = document.createElement('div');
    body.className = 'buk-inline-edit';
    body.style.marginLeft = ((depth * 18) + 24) + 'px';

    if (st.description) {
      const d = document.createElement('div');
      d.className = 'completed-desc';
      d.textContent = st.description;
      body.appendChild(d);
    }
    const grid = document.createElement('div');
    grid.className = 'completed-edit-grid';
    grid.appendChild(buildField('Title', () => {
      const inp = document.createElement('input');
      inp.type = 'text'; inp.value = st.text || ''; inp.style.fontWeight = '500';
      inp.addEventListener('change', () => { st.text = inp.value.trim() || st.text; scheduleSave(); render(); });
      return inp;
    }));
    grid.appendChild(buildField('Hours estimate', () => {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = '0.25'; inp.min = '0';
      inp.value = Number(st.hours_estimate) || 0;
      inp.addEventListener('change', () => { st.hours_estimate = Number(inp.value) || 0; scheduleSave(); render(); });
      return inp;
    }));
    grid.appendChild(buildField('Priority', () => {
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
    grid.appendChild(buildField('Due date', () => {
      const inp = document.createElement('input');
      inp.type = 'date';
      inp.value = (st.due_date && st.due_date !== 'TBD') ? st.due_date : '';
      inp.addEventListener('change', () => { st.due_date = inp.value || 'TBD'; scheduleSave(); render(); });
      return inp;
    }));
    body.appendChild(grid);

    const notesField = buildField('Notes', () => {
      const ta = document.createElement('textarea');
      ta.value = st.notes || ''; ta.rows = 2;
      ta.addEventListener('blur', () => { st.notes = ta.value; scheduleSave(); });
      return ta;
    });
    notesField.style.gridColumn = '1 / -1';
    body.appendChild(notesField);

    const actions = document.createElement('div');
    actions.className = 'completed-actions';
    if (!st.done) {
      const complete = document.createElement('button');
      complete.className = 'btn btn-primary btn-sm';
      complete.textContent = '✓ Mark complete';
      complete.addEventListener('click', () => {
        st.done = true;
        st.done_at = isoNow();
        state.expandedEdit.delete(st.id);
        scheduleSave(); render();
      });
      actions.appendChild(complete);
    } else {
      const undo = document.createElement('button');
      undo.className = 'btn btn-primary btn-sm';
      undo.textContent = '↶ Undo completion';
      undo.addEventListener('click', () => {
        st.done = false; st.done_at = null;
        scheduleSave(); render();
      });
      actions.appendChild(undo);
    }
    const close = document.createElement('button');
    close.className = 'btn btn-sm';
    close.textContent = 'Close';
    close.addEventListener('click', () => { state.expandedEdit.delete(st.id); render(); });
    actions.appendChild(close);
    body.appendChild(actions);
    return body;
  }

  function buildField(label, makeInput) {
    const wrap = document.createElement('div');
    wrap.className = 'completed-field';
    const lbl = document.createElement('div');
    lbl.className = 'completed-field-label';
    lbl.textContent = label;
    wrap.appendChild(lbl);
    wrap.appendChild(makeInput());
    return wrap;
  }

  function renderSubtaskRow(project, bucket, st, depth, opts = {}) {
    const row = document.createElement('div');
    row.className = 'buk-subtask' + (st.done ? ' done' : '');
    if (state.selectedNode && state.selectedNode.kind === 'subtask' && state.selectedNode.subtaskId === st.id)
      row.classList.add('selected');
    row.style.marginLeft = (depth * 18) + 'px';

    // caret to expand/collapse children
    const caret = document.createElement('button');
    caret.className = 'buk-st-caret';
    const hasChildren = (st.children || []).length > 0;
    caret.textContent = hasChildren ? (state.expandedSubtasks.has(st.id) ? '▾' : '▸') : '·';
    if (hasChildren) {
      caret.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (state.expandedSubtasks.has(st.id)) state.expandedSubtasks.delete(st.id);
        else state.expandedSubtasks.add(st.id);
        render();
      });
    }
    row.appendChild(caret);

    // checkbox
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'buk-st-check';
    cb.checked = !!st.done;
    cb.addEventListener('click', ev => ev.stopPropagation());
    cb.addEventListener('change', () => {
      st.done = cb.checked;
      st.done_at = cb.checked ? isoNow() : null;
      scheduleSave();
      render();
    });
    row.appendChild(cb);

    // proposed badge
    if (st.proposed) {
      const pb = document.createElement('span');
      pb.className = 'buk-propose-badge';
      pb.textContent = 'proposed';
      row.appendChild(pb);
    }

    // text (inline-editable on click if not already editing)
    const txt = document.createElement('span');
    txt.className = 'buk-st-text';
    txt.textContent = st.text || '(untitled)';
    txt.contentEditable = 'false';
    txt.addEventListener('click', (ev) => {
      if (opts.inSearch) return;
      ev.stopPropagation();
      // Single click → toggle the inline edit body. Double-click still rename.
      if (state.expandedEdit.has(st.id)) state.expandedEdit.delete(st.id);
      else state.expandedEdit.add(st.id);
      render();
    });
    txt.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      txt.contentEditable = 'true';
      txt.focus();
      document.getSelection().selectAllChildren(txt);
    });
    txt.addEventListener('blur', () => {
      if (txt.contentEditable === 'true') {
        txt.contentEditable = 'false';
        const v = txt.textContent.trim();
        if (v && v !== st.text) { st.text = v; scheduleSave(); }
      }
    });
    txt.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && txt.contentEditable === 'true') { ev.preventDefault(); txt.blur(); }
      if (ev.key === 'Escape' && txt.contentEditable === 'true') { ev.preventDefault(); txt.textContent = st.text || ''; txt.blur(); }
    });
    row.appendChild(txt);

    // due-date chip
    if (st.due_date && st.due_date !== 'TBD') {
      const c = document.createElement('span');
      c.className = 'buk-st-chip ' + duePrefix(st.due_date);
      c.textContent = st.due_date.slice(5);
      row.appendChild(c);
    }

    // priority chip
    if (st.priority && st.priority !== 'normal') {
      const c = document.createElement('span');
      c.className = 'buk-st-chip';
      c.textContent = st.priority;
      row.appendChild(c);
    }

    // assignee chip (initials; color from the lab-roster cache)
    if (st.assignee_uid) {
      const c = assigneeChipEl(st.assignee_uid);
      if (c) row.appendChild(c);
    }

    // block-status chip (need / waiting) — surfaced loud since PMR
    // discussion suggestions key off this.
    if (st.block_status) {
      const c = document.createElement('span');
      c.className = 'buk-st-chip block';
      c.style.background = '#fee2e2';
      c.style.color = '#991b1b';
      c.textContent = st.block_status;
      row.appendChild(c);
    }

    // hours chip
    if (Number(st.hours_estimate) > 0) {
      const c = document.createElement('span');
      c.className = 'buk-st-chip hours';
      c.textContent = `${Number(st.hours_estimate).toFixed(2).replace(/\.?0+$/, '')}h`;
      row.appendChild(c);
    }

    // evidence chips
    const ev = st.evidence || emptyEvidence();
    const evCount = (ev.email_ids || []).length + (ev.event_ids || []).length + (ev.item_ids || []).length;
    if (evCount) {
      const c = document.createElement('span');
      c.className = 'buk-st-chip ev';
      const parts = [];
      if ((ev.email_ids || []).length) parts.push(`${ev.email_ids.length}m`);
      if ((ev.event_ids || []).length) parts.push(`${ev.event_ids.length}e`);
      if ((ev.item_ids || []).length) parts.push(`${ev.item_ids.length}i`);
      c.textContent = parts.join(' ');
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        state.selectedNode = { kind: 'subtask', projectId: project.id, bucketId: bucket.id, subtaskId: st.id };
        render();
      });
      row.appendChild(c);
    }

    // add-to-project button (always shown — moves/pins this subtask onto the dashboard)
    const pinBtn = document.createElement('button');
    pinBtn.className = 'btn btn-sm';
    pinBtn.style.padding = '0 8px';
    pinBtn.style.background = '#dbeafe';
    pinBtn.style.borderColor = '#93c5fd';
    pinBtn.style.color = '#1e40af';
    pinBtn.textContent = '→ project';
    pinBtn.title = 'Add this task to a project bucket on the dashboard';
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPinMenu(pinBtn, st, project, bucket);
    });
    row.appendChild(pinBtn);

    // add-child button (if depth allows)
    if (depth + 1 < MAX_DEPTH && !opts.inSearch) {
      const addBtn = document.createElement('button');
      addBtn.className = 'btn btn-sm';
      addBtn.style.padding = '0 6px';
      addBtn.textContent = '+';
      addBtn.title = 'Add sub-subtask';
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.expandedSubtasks.add(st.id);
        promptAddChild(st);
      });
      row.appendChild(addBtn);
    }

    return row;
  }

  function promptAddChild(parentNode) {
    const text = prompt('Child subtask text:');
    if (!text || !text.trim()) return;
    const me = (typeof firebridge !== 'undefined' && firebridge.getUser) ? (firebridge.getUser() || {}) : {};
    const node = {
      id: newId('sub'),
      text: text.trim(),
      description: '',
      done: false, done_at: null,
      due_date: 'TBD', priority: 'normal',
      hours_estimate: 0, tracker_entry_id: null,
      evidence: emptyEvidence(),
      notes: '',
      assignee_uid: parentNode.assignee_uid || me.uid || null,
      assignees_uids: [],
      assigned_at: isoNow(),
      assigned_by_uid: me.uid || null,
      block_status: null,
      proposed: false,
      children: [],
    };
    parentNode.children = parentNode.children || [];
    parentNode.children.push(node);
    scheduleSave();
    render();
  }

  function renderAddSubtask(project, bucket, parent) {
    const wrap = document.createElement('div');
    wrap.className = 'buk-st-add';
    const inp = document.createElement('input');
    inp.placeholder = '+ Add subtask';
    inp.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || !inp.value.trim()) return;
      const me = (typeof firebridge !== 'undefined' && firebridge.getUser) ? (firebridge.getUser() || {}) : {};
      const node = {
        id: newId('sub'),
        text: inp.value.trim(),
        description: '',
        done: false, done_at: null,
        due_date: 'TBD', priority: 'normal',
        hours_estimate: 0, tracker_entry_id: null,
        evidence: emptyEvidence(), notes: '',
        assignee_uid: me.uid || null,
        assignees_uids: [],
        assigned_at: isoNow(),
        assigned_by_uid: me.uid || null,
        block_status: null,
        proposed: false,
        children: [],
      };
      bucket.subtasks = bucket.subtasks || [];
      bucket.subtasks.push(node);
      scheduleSave();
      inp.value = '';
      render();
    });
    wrap.appendChild(inp);
    return wrap;
  }

  function renderAddBucket(project) {
    const wrap = document.createElement('div');
    wrap.style.marginTop = '6px';
    const inp = document.createElement('input');
    inp.placeholder = '+ Add bucket (free-form title)';
    inp.style.width = '100%';
    inp.style.padding = '8px 10px';
    inp.style.border = '1px dashed #d1d5db';
    inp.style.borderRadius = '8px';
    inp.style.fontSize = '13px';
    inp.style.background = 'transparent';
    inp.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || !inp.value.trim()) return;
      const title = inp.value.trim();
      const b = {
        id: `buk-${slugify(project.id)}-${slugify(title)}-${Date.now().toString(36)}`,
        category: project.category || '',
        sub_category: '',
        title,
        due_date: 'TBD', hours_estimate: 0, tracker_entry_id: null,
        evidence: emptyEvidence(), notes: '',
        subtasks: [],
      };
      project.buckets = project.buckets || [];
      project.buckets.push(b);
      state.expandedBuckets.add(b.id);
      scheduleSave();
      inp.value = '';
      render();
    });
    wrap.appendChild(inp);
    return wrap;
  }

  /* ----- detail pane ----- */
  function renderDetail() {
    const pane = document.createElement('div');
    pane.className = 'buk-detail';
    const close = document.createElement('button');
    close.className = 'buk-detail-close';
    close.textContent = '×';
    close.addEventListener('click', () => { state.selectedNode = null; render(); });
    pane.appendChild(close);

    const sel = state.selectedNode;
    if (!sel) return pane;

    let node = null, bucket = null, project = null, kind = sel.kind;
    project = findProject(sel.projectId);
    if (!project) { pane.innerHTML += '<p>Project not found.</p>'; return pane; }
    if (kind === 'project') {
      node = project;
    } else if (kind === 'bucket') {
      bucket = findBucket(project, sel.bucketId);
      node = bucket;
    } else if (kind === 'subtask') {
      bucket = findBucket(project, sel.bucketId);
      if (!bucket) { pane.innerHTML += '<p>Bucket not found.</p>'; return pane; }
      const f = findSubtaskById(bucket, sel.subtaskId);
      node = f ? f.node : null;
    }
    if (!node) { pane.innerHTML += '<p>Not found.</p>'; return pane; }

    const title = document.createElement('h3');
    title.textContent = node.text || node.title || '(untitled)';
    pane.appendChild(title);

    // fields: due_date, hours_estimate
    const fields = document.createElement('div');
    fields.className = 'buk-detail-fields';
    fields.appendChild(labeledInput('Due date', 'date', (node.due_date && node.due_date !== 'TBD') ? node.due_date : '', v => {
      node.due_date = v || 'TBD'; scheduleSave(); render();
    }));
    fields.appendChild(labeledInput('Hours estimate', 'number', node.hours_estimate || 0, v => {
      node.hours_estimate = Number(v) || 0; scheduleSave(); render();
    }, { step: '0.25', min: '0' }));
    if (kind === 'subtask') {
      fields.appendChild(labeledSelect('Priority', ['low', 'normal', 'high', 'urgent'], node.priority || 'normal', v => {
        node.priority = v; scheduleSave(); render();
      }));
      // Assignee + secondary block_status. Options pulled from the lab roster
      // (loaded once on boot). Empty option = unassigned.
      var assigneeOpts = [{ value: '', label: '— unassigned —' }]
        .concat(_labMembers.map(function (m) { return { value: m.uid, label: (m.name || m.email || m.uid) + (m.category ? ' · ' + m.category : '') }; }));
      fields.appendChild(labeledOptionSelect('Assignee', assigneeOpts, node.assignee_uid || '', v => {
        var me = (typeof firebridge !== 'undefined' && firebridge.getUser) ? (firebridge.getUser() || {}) : {};
        node.assignee_uid = v || null;
        node.assigned_at = isoNow();
        node.assigned_by_uid = me.uid || null;
        scheduleSave(); render();
      }));
      fields.appendChild(labeledSelect('Block status', ['none', 'need', 'waiting'], node.block_status || 'none', v => {
        node.block_status = (v === 'none') ? null : v; scheduleSave(); render();
      }));
    }
    const sec1 = document.createElement('div');
    sec1.className = 'buk-detail-section';
    sec1.appendChild(fields);
    pane.appendChild(sec1);

    // description / notes
    pane.appendChild(labeledTextarea(kind === 'subtask' ? 'Description' : 'Notes',
      kind === 'subtask' ? (node.description || '') : (node.notes || ''),
      v => { if (kind === 'subtask') node.description = v; else node.notes = v; scheduleSave(); }));
    if (kind === 'subtask') {
      pane.appendChild(labeledTextarea('Notes', node.notes || '', v => { node.notes = v; scheduleSave(); }));
    }

    // evidence
    const evSec = document.createElement('div');
    evSec.className = 'buk-detail-section';
    const lbl = document.createElement('div');
    lbl.className = 'lbl'; lbl.textContent = 'Linked evidence';
    evSec.appendChild(lbl);
    const ev = node.evidence = node.evidence || emptyEvidence();
    const chips = document.createElement('div');
    chips.className = 'buk-detail-evidence';
    for (const kind2 of ['email_ids', 'event_ids', 'item_ids']) {
      for (const id of ev[kind2] || []) {
        chips.appendChild(evidenceChip(kind2, id, () => {
          ev[kind2] = ev[kind2].filter(x => x !== id);
          scheduleSave();
          render();
        }));
      }
    }
    evSec.appendChild(chips);
    evSec.appendChild(addEvidenceRow(ev));
    pane.appendChild(evSec);

    // pin/move to a project bucket (shown for every subtask, not just proposed)
    if (kind === 'subtask') {
      const pinBtn = document.createElement('button');
      pinBtn.className = 'btn btn-primary btn-sm';
      pinBtn.style.marginTop = '8px';
      pinBtn.textContent = node.proposed ? 'Pin to project…' : 'Move to project…';
      pinBtn.addEventListener('click', (ev2) => {
        ev2.stopPropagation();
        openPinMenu(pinBtn, node, project, bucket);
      });
      pane.appendChild(pinBtn);
    }

    // delete / archive
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.style.marginTop = '8px';
    delBtn.style.float = 'right';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => {
      if (!confirm('Delete this ' + kind + '?')) return;
      if (kind === 'subtask') deleteSubtask(bucket, node);
      else if (kind === 'bucket') project.buckets = project.buckets.filter(x => x.id !== node.id);
      else if (kind === 'project') state.doc.projects = state.doc.projects.filter(x => x.id !== node.id);
      state.selectedNode = null;
      scheduleSave();
      render();
    });
    pane.appendChild(delBtn);

    return pane;
  }

  function labeledInput(label, type, value, onCommit, extraAttrs = {}) {
    const wrap = document.createElement('div');
    const lbl = document.createElement('div');
    lbl.className = 'lbl'; lbl.textContent = label;
    wrap.appendChild(lbl);
    const inp = document.createElement('input');
    inp.type = type;
    inp.value = value || '';
    for (const [k, v] of Object.entries(extraAttrs)) inp.setAttribute(k, v);
    inp.addEventListener('change', () => onCommit(inp.value));
    wrap.appendChild(inp);
    return wrap;
  }

  function labeledSelect(label, options, value, onCommit) {
    const wrap = document.createElement('div');
    const lbl = document.createElement('div');
    lbl.className = 'lbl'; lbl.textContent = label;
    wrap.appendChild(lbl);
    const sel = document.createElement('select');
    sel.style.cssText = 'width:100%;padding:6px;border:1px solid #e5e7eb;border-radius:6px;font-size:12px';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o; opt.textContent = o;
      if (o === value) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => onCommit(sel.value));
    wrap.appendChild(sel);
    return wrap;
  }

  // Same as labeledSelect but each option is { value, label } so display text
  // can differ from the stored value (e.g. uid → "Alex McGhee · pi").
  function labeledOptionSelect(label, options, value, onCommit) {
    const wrap = document.createElement('div');
    const lbl = document.createElement('div');
    lbl.className = 'lbl'; lbl.textContent = label;
    wrap.appendChild(lbl);
    const sel = document.createElement('select');
    sel.style.cssText = 'width:100%;padding:6px;border:1px solid #e5e7eb;border-radius:6px;font-size:12px';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value; opt.textContent = o.label;
      if (String(o.value) === String(value)) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => onCommit(sel.value));
    wrap.appendChild(sel);
    return wrap;
  }

  function labeledTextarea(label, value, onCommit) {
    const wrap = document.createElement('div');
    wrap.className = 'buk-detail-section';
    const lbl = document.createElement('div');
    lbl.className = 'lbl'; lbl.textContent = label;
    wrap.appendChild(lbl);
    const ta = document.createElement('textarea');
    ta.value = value || '';
    ta.addEventListener('blur', () => onCommit(ta.value));
    wrap.appendChild(ta);
    return wrap;
  }

  function evidenceChip(kind, id, onRemove) {
    const c = document.createElement('span');
    c.className = 'ev-item';
    const label = kind === 'email_ids' ? '📧' : kind === 'event_ids' ? '📅' : '📦';
    c.innerHTML = `${label} <code style="font-family:inherit">${escapeHtml(id.slice(0, 12))}</code>`;
    const x = document.createElement('button');
    x.textContent = '×';
    x.title = 'Unlink';
    x.addEventListener('click', onRemove);
    c.appendChild(x);
    return c;
  }

  function addEvidenceRow(evidence) {
    const row = document.createElement('div');
    row.className = 'buk-detail-add-ev';
    const sel = document.createElement('select');
    sel.style.cssText = 'padding:3px 4px;border:1px solid #e5e7eb;border-radius:4px;font-size:11px';
    for (const [val, label] of [['email_ids', 'email'], ['event_ids', 'event'], ['item_ids', 'item']]) {
      const opt = document.createElement('option'); opt.value = val; opt.textContent = label;
      sel.appendChild(opt);
    }
    const inp = document.createElement('input');
    inp.placeholder = 'paste id…';
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = 'Link';
    btn.addEventListener('click', () => {
      const id = inp.value.trim();
      if (!id) return;
      evidence[sel.value] = evidence[sel.value] || [];
      if (!evidence[sel.value].includes(id)) evidence[sel.value].push(id);
      scheduleSave();
      render();
    });
    row.appendChild(sel);
    row.appendChild(inp);
    row.appendChild(btn);
    return row;
  }

  function deleteSubtask(bucket, node) {
    const deleteFrom = (arr) => {
      const i = arr.indexOf(node);
      if (i >= 0) { arr.splice(i, 1); return true; }
      for (const s of arr) if (deleteFrom(s.children || [])) return true;
      return false;
    };
    deleteFrom(bucket.subtasks || []);
  }

  /* ----- pin menu ----- */
  function openPinMenu(anchor, node, fromProject, fromBucket) {
    closePinMenu();
    const menu = document.createElement('div');
    menu.className = 'buk-pin-menu';
    menu.id = 'buk-pin-menu';
    const rect = anchor.getBoundingClientRect();
    menu.style.left = (rect.left + window.scrollX) + 'px';
    menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';

    // Header
    const header = document.createElement('div');
    header.className = 'pin-group';
    header.textContent = 'Add to project on dashboard';
    menu.appendChild(header);

    // "New project" entry — always at top
    const newOpt = document.createElement('div');
    newOpt.className = 'pin-opt';
    newOpt.style.fontWeight = '700';
    newOpt.style.color = '#1e40af';
    newOpt.textContent = '+ New project…';
    newOpt.addEventListener('click', () => {
      const title = prompt('New project name:');
      if (!title || !title.trim()) return;
      const id = `proj-${slugify(title.trim())}-${Date.now().toString(36)}`;
      const proj = {
        id, title: title.trim(), status: 'active', category: '',
        due_date: 'TBD', hours_estimate: 0, tracker_entry_id: null,
        evidence: emptyEvidence(), notes: '',
        created_at: todayStr(), completed_at: null,
        buckets: [{
          id: `buk-${id}-default`, category: '', sub_category: '', title: 'General',
          due_date: 'TBD', hours_estimate: 0, tracker_entry_id: null,
          evidence: emptyEvidence(), notes: '', subtasks: [],
        }],
      };
      state.doc.projects.push(proj);
      moveNodeTo(node, fromBucket, proj, proj.buckets[0]);
      closePinMenu();
    });
    menu.appendChild(newOpt);

    // Existing dashboard-visible projects only
    const hidden = dashHiddenSet();
    const visible = (state.doc.projects || [])
      .filter(p => p.id !== 'proj-inbox' && !hidden.has(p.id));
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:10px;font-size:11px;color:#9ca3af;text-align:center';
      empty.textContent = 'No projects on the dashboard yet.';
      menu.appendChild(empty);
    } else {
      const existingHdr = document.createElement('div');
      existingHdr.className = 'pin-group';
      existingHdr.style.marginTop = '4px';
      existingHdr.textContent = 'Existing projects';
      menu.appendChild(existingHdr);
      for (const p of visible) {
        const opt = document.createElement('div');
        opt.className = 'pin-opt';
        opt.textContent = p.title;
        opt.addEventListener('click', () => {
          const dest = ensureDefaultBucket(p);
          moveNodeTo(node, fromBucket, p, dest);
          closePinMenu();
        });
        menu.appendChild(opt);
      }
    }
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', pinMenuOutside, { once: true }), 0);
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

  function moveNodeTo(node, fromBucket, toProject, toBucket) {
    fromBucket.subtasks = (fromBucket.subtasks || []).filter(x => x !== node);
    node.proposed = false;
    toBucket.subtasks = toBucket.subtasks || [];
    toBucket.subtasks.push(node);
    dashUnhide(toProject.id);                        // make sure it shows on the dashboard
    state.activeProjectId = toProject.id;
    state.expandedBuckets.add(toBucket.id);
    state.selectedNode = { kind: 'subtask', projectId: toProject.id, bucketId: toBucket.id, subtaskId: node.id };
    scheduleSave();
    render();
  }
  function pinMenuOutside(ev) {
    if (ev.target.closest('#buk-pin-menu')) return;
    closePinMenu();
  }
  function closePinMenu() {
    const m = document.getElementById('buk-pin-menu');
    if (m) m.remove();
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
      // Lab roster powers the assignee picker + chips. Run in parallel
      // with loadDoc — non-fatal if it fails.
      const rosterP = loadLabMembers();
      await loadDoc();
      await rosterP;
      // Default to first non-inbox project
      if (!state.activeProjectId) {
        const firstNonInbox = (state.doc.projects || []).find(p => p.id !== 'proj-inbox');
        state.activeProjectId = firstNonInbox ? firstNonInbox.id : (state.doc.projects[0] && state.doc.projects[0].id);
      }
      render();
      attachLiveSync();
    } catch (err) {
      root().innerHTML = `<div class="buk-search-empty">Failed to load buckets.json — ${escapeHtml(err.message)}<br>Run <code>python3 scripts/migrate_inbox_to_buckets.py</code> first.</div>`;
      console.error(err);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
