/* pmr.js — Project Management Report workspace.
 *
 * One PMR doc per (researcher, period). PMRs are the per-student
 * structured plan that the PI uses to prep + run 1:1 discussions. They
 * preserve the canonical shape of the existing Google-Doc PMRs:
 *
 *   reference_links[]   notebooks, running notes, past PMRs, protocols
 *   project_overview[]  rows of {project_id, description, lead, status}
 *   weekly_entries[]    week-of with subsections (Experimental update,
 *                       Reading/Writing, Sidequests, Trainings, ...)
 *   discussion[]        blockers + next-step proposals (the 1:1 launchpad)
 *
 * Routing: per-user Firestore at userData/{uid}/pmr/{periodId}. The
 * `_index` doc per user lists the user's known periods cheaply.
 *
 * Save recipe matches js/tasks-buckets.js:
 *   - 400ms debounce
 *   - _suppressUntil = now + 2500 to skip own write echo
 *   - _savePending guards api.subscribe so a remote snapshot can't
 *     clobber an in-memory edit (per memory: feedback_live_sync_pending_save)
 *
 * Phase 1 scope (this file): structured form + period picker + admin
 * student-picker rail + live-sync. Phase 2 (live data pull-in) and
 * Phase 3 (discussion suggestions) are stubbed below.
 */

(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
   * Constants
   * ───────────────────────────────────────────────────────────── */
  const INDEX_PATH = 'pmr/_index.json';
  const ASSIGNEE_CATEGORIES = ['pi', 'postdoc', 'grad', 'undergrad', 'highschool'];
  const ASSIGNEE_COLORS = ['#1e40af','#16a34a','#b45309','#7c3aed','#0e7490','#be185d','#15803d','#92400e','#1f2937'];

  // Default subsection names from analyzing existing PMRs (Ally/Cris/Alia/Ethan).
  // Free-form — students can rename / add / delete.
  const DEFAULT_SUBSECTIONS = ['Experimental update', 'Reading/Writing', 'Sidequests'];
  const ITEM_STATUSES = ['done', 'in_progress', 'postponed', 'need'];

  // Project status enum (table-level — was Good/Behind/Delayed/Paused in the
  // Google-Doc PMRs).
  const PROJ_STATUSES = ['good', 'behind', 'delayed', 'paused'];

  // Reference-link categories from existing PMRs.
  const REF_KINDS = ['notes', 'notebook', 'past_pmr', 'protocol', 'fellowship', 'other'];

  /* ─────────────────────────────────────────────────────────────
   * State
   * ───────────────────────────────────────────────────────────── */
  const state = {
    user: null,
    isAdmin: false,
    viewAsUid: null,             // admin can pick any lab member; non-admin = self only
    labMembers: [],              // [{uid, name, email, category, color}]
    labMembersByUid: {},
    projectsByUid: {},           // member_uid → [project rows] from projects collection
    indexDoc: null,              // { periods: [{id,label,status,updated_at}] }
    currentPeriodId: null,
    doc: null,                   // the PMR doc currently shown
    saveTimer: null,
    // Phase 2 — live data pull-in
    openTasks: [],               // [{subtask, bucket, project, ageDays, isOverdue, isStale, isBlocked}]
    openTasksLoaded: false,      // null while loading, true once attempted
    openTasksError: null,
  };

  const STALE_DAYS = 14;

  // Live-sync gates (mirrors tasks-buckets.js recipe).
  let _suppressUntil = 0;
  let _liveUnsub = null;
  let _savePending = false;

  /* ─────────────────────────────────────────────────────────────
   * Helpers
   * ───────────────────────────────────────────────────────────── */
  function isoNow() { return new Date().toISOString(); }
  function todayStr() { return new Date().toISOString().slice(0, 10); }

  function newId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function viewedUid() {
    return state.viewAsUid || (state.user && state.user.uid) || null;
  }

  function periodPathFor(periodId) { return 'pmr/' + periodId + '.json'; }

  /* Period IDs:
   *   "<year>-<term>"           e.g. "2025-fall"
   *   "<year>-<term>-rot1"      rotation suffix
   *   "custom-<slug>"           custom date range (slug from start_date)
   */
  function semesterFromDate(d) {
    // Aug-Dec → fall; Jan-May → spring; Jun-Jul → summer
    const m = d.getMonth() + 1;
    const y = d.getFullYear();
    if (m >= 8) return { year: y, term: 'fall' };
    if (m >= 6) return { year: y, term: 'summer' };
    return { year: y, term: 'spring' };
  }

  function semesterDates(year, term) {
    if (term === 'fall')   return { start: year + '-08-25', end: year + '-12-15' };
    if (term === 'spring') return { start: year + '-01-10', end: year + '-05-15' };
    if (term === 'summer') return { start: year + '-06-01', end: year + '-08-15' };
    return { start: year + '-01-01', end: year + '-12-31' };
  }

  function buildSemesterPeriod(year, term, rotationSuffix) {
    const dates = semesterDates(year, term);
    return {
      kind: 'semester',
      term: term, year: year,
      rotation_suffix: rotationSuffix || null,
      start_date: dates.start, end_date: dates.end,
      custom_label: null,
    };
  }

  function periodIdFor(period) {
    if (period.kind === 'custom') {
      return 'custom-' + (period.custom_label || period.start_date || newId('p'))
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }
    return period.year + '-' + period.term + (period.rotation_suffix ? '-' + period.rotation_suffix : '');
  }

  function periodLabel(period) {
    if (!period) return '(unknown)';
    if (period.kind === 'custom') return period.custom_label || (period.start_date + ' → ' + period.end_date);
    const term = period.term ? period.term[0].toUpperCase() + period.term.slice(1) : '';
    return term + ' ' + period.year + (period.rotation_suffix ? ' (' + period.rotation_suffix + ')' : '');
  }

  // Suggest the current + previous 4 semesters as default options.
  function suggestedPeriods() {
    const now = new Date();
    const cur = semesterFromDate(now);
    const out = [];
    let y = cur.year, t = cur.term;
    for (let i = 0; i < 5; i++) {
      out.push(buildSemesterPeriod(y, t, null));
      // Step back one term: fall → summer → spring → (year-1) fall
      if (t === 'fall')   { t = 'summer'; }
      else if (t === 'summer') { t = 'spring'; }
      else                { t = 'fall'; y -= 1; }
    }
    return out;
  }

  /* Lazy route registration — periodIds are unbounded so we register on
   * demand instead of enumerating up front. */
  function ensurePmrRoute(periodId) {
    const path = periodPathFor(periodId);
    if (api.getRoute && api.getRoute(path)) return;
    api.registerRoute(path, { scope: 'user', subcollection: 'pmr', doc: periodId });
  }

  /* ─────────────────────────────────────────────────────────────
   * Lab roster cache (also drives the admin student picker)
   * ───────────────────────────────────────────────────────────── */
  async function loadLabMembers() {
    if (typeof firebridge === 'undefined' || !firebridge.getAll) return;
    try {
      const d = await api.load('lab/users.json');
      const users = (d && d.users) || [];
      state.labMembers = users
        .filter(u => ASSIGNEE_CATEGORIES.indexOf(u.category) !== -1)
        .map((u, i) => ({
          uid: u.uid || u.id,
          name: u.name || u.displayName || u.email || u.uid || u.id,
          email: u.email || '',
          category: u.category,
          color: ASSIGNEE_COLORS[i % ASSIGNEE_COLORS.length],
        }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      state.labMembersByUid = {};
      state.labMembers.forEach(m => { state.labMembersByUid[m.uid] = m; });
    } catch (err) {
      console.warn('[pmr] lab member load failed:', err && err.message);
    }
  }

  function memberByUid(uid) { return uid && state.labMembersByUid[uid] || null; }

  function memberLabel(uid) {
    const m = memberByUid(uid);
    return m ? (m.name || m.email || uid) : (uid || '—');
  }

  /* ─────────────────────────────────────────────────────────────
   * Project lookup (Phase 2 will use this for live rollups)
   * ───────────────────────────────────────────────────────────── */
  async function loadProjectsForUser(uid) {
    if (!uid) return [];
    if (state.projectsByUid[uid]) return state.projectsByUid[uid];
    try {
      // The `projects` Firestore collection is the union of papers/courses/
      // infrastructure/tools, discriminated by `type`. Phase 0b's
      // member_uids index lets us pull "projects involving X" cheaply.
      const rows = await firebridge.queryWhere('projects', 'member_uids', 'array-contains', uid);
      state.projectsByUid[uid] = rows || [];
      return rows || [];
    } catch (err) {
      console.warn('[pmr] projects-for-user load failed:', err && err.message);
      state.projectsByUid[uid] = [];
      return [];
    }
  }

  /* ─────────────────────────────────────────────────────────────
   * Phase 2 — Open tasks pull-in
   *
   * Walks the user's tasks/buckets.json tree and surfaces every subtask
   * where assignee_uid === viewedUid and !done. Powers both the
   * "Open tasks" panel below the project overview AND the auto-suggested
   * Discussion items (Phase 3 lite).
   *
   * Cross-user limitation: the adapter routes user-scope reads via the
   * signed-in user's uid, so an admin viewing another lab member's PMR
   * cannot pull THEIR tasks. We no-op in that case.
   * ───────────────────────────────────────────────────────────── */
  function ageDaysOf(iso) {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }

  async function loadOpenTasks() {
    state.openTasksError = null;
    state.openTasks = [];
    const uid = viewedUid();
    if (!uid) { state.openTasksLoaded = true; return; }
    if (uid !== (state.user && state.user.uid)) {
      // Admin viewing another user — adapter can't reach their buckets.
      state.openTasksLoaded = true;
      state.openTasksError = 'cross-user read not yet supported';
      return;
    }
    try {
      const doc = await api.load('tasks/buckets.json');
      const rows = [];
      function walk(node, bucket, project, depth) {
        if (!node) return;
        const isDone = !!node.done;
        const matches = !isDone && (node.assignee_uid === uid);
        if (matches) {
          const upd = node.updated_at || node.assigned_at || bucket && bucket.updated_at || project && project.created_at;
          const age = ageDaysOf(upd);
          const today = todayStr();
          rows.push({
            subtask: node, bucket: bucket, project: project,
            ageDays: age,
            isOverdue: !!(node.due_date && node.due_date !== 'TBD' && node.due_date < today),
            isStale:   age != null && age >= STALE_DAYS,
            isBlocked: !!node.block_status,
          });
        }
        (node.children || []).forEach(c => walk(c, bucket, project, depth + 1));
      }
      (doc.projects || []).forEach(p => {
        (p.buckets || []).forEach(b => {
          (b.subtasks || []).forEach(st => walk(st, b, p, 0));
        });
      });
      // Sort: blockers first, then overdue, then stale, then by due date.
      rows.sort((a, b) => {
        const sa = (a.isBlocked ? 4 : 0) + (a.isOverdue ? 2 : 0) + (a.isStale ? 1 : 0);
        const sb = (b.isBlocked ? 4 : 0) + (b.isOverdue ? 2 : 0) + (b.isStale ? 1 : 0);
        if (sa !== sb) return sb - sa;
        const da = a.subtask.due_date || 'zzzz';
        const db = b.subtask.due_date || 'zzzz';
        return da.localeCompare(db);
      });
      state.openTasks = rows;
      state.openTasksLoaded = true;
    } catch (err) {
      console.warn('[pmr] open-tasks load failed:', err && err.message);
      state.openTasksError = err && err.message || 'load failed';
      state.openTasksLoaded = true;
    }
  }

  /* Refresh the auto-suggested Discussion cards from state.openTasks.
   * Each suggestion has source_ref=subtask.id so we don't duplicate.
   * Honors per-card dismissed_at — once you dismiss, it doesn't return.
   */
  function refreshDiscussionSuggestions() {
    if (!state.doc) return 0;
    const dismissed = new Set();
    const present = new Set();
    (state.doc.discussion || []).forEach(c => {
      if (c.source_ref) present.add(c.source_ref);
      if (c.dismissed_at && c.source_ref) dismissed.add(c.source_ref);
    });
    let added = 0;
    state.openTasks.forEach(row => {
      const stId = row.subtask.id;
      if (!stId) return;
      if (present.has(stId)) return;          // already surfaced
      if (dismissed.has(stId)) return;        // user said no
      let kind = null, source = null;
      if (row.isBlocked)      { kind = 'blocker';     source = 'blocked'; }
      else if (row.isOverdue) { kind = 'blocker';     source = 'overdue'; }
      else if (row.isStale)   { kind = 'next_action'; source = 'stale_subtask'; }
      if (!kind) return;
      state.doc.discussion = state.doc.discussion || [];
      state.doc.discussion.push({
        id: newId('disc'),
        project_id: '',
        kind: kind,
        text: (row.subtask.text || '') +
              (source === 'overdue' ? '  (due ' + row.subtask.due_date + ')' :
               source === 'blocked' ? '  (' + row.subtask.block_status + ')' :
               source === 'stale_subtask' ? '  (no progress in ' + row.ageDays + 'd)' : ''),
        source: source,
        source_ref: stId,
        status: 'open',
        created_at: isoNow(),
      });
      added++;
    });
    if (added) scheduleSave();
    return added;
  }

  /* "Pull into week" — copy a subtask into a chosen weekly entry as a
   * PMR item with source_subtask_id set. Uses a tiny inline picker.
   */
  function openPullIntoWeek(rowMeta, anchorEl) {
    const weeks = state.doc.weekly_entries || [];
    if (!weeks.length) {
      alert('Add a weekly entry first ("+ Add week" in the Weekly entries block).');
      return;
    }
    closePullMenu();
    const menu = document.createElement('div');
    menu.id = 'pmr-pull-menu';
    menu.style.cssText = 'position:absolute;background:#fff;border:1px solid #d1d5db;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);padding:6px;min-width:240px;max-height:320px;overflow:auto;z-index:50;font-size:13px';
    const r = anchorEl.getBoundingClientRect();
    menu.style.top  = (r.bottom + window.scrollY + 4) + 'px';
    menu.style.left = (r.left + window.scrollX) + 'px';

    const hint = document.createElement('div');
    hint.style.cssText = 'padding:4px 8px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px';
    hint.textContent = 'Pull into …';
    menu.appendChild(hint);

    weeks.forEach(wk => {
      (wk.subsections || [{ name: '(default)', items: [] }]).forEach(sub => {
        const opt = document.createElement('div');
        opt.style.cssText = 'padding:6px 10px;cursor:pointer;border-radius:4px';
        opt.textContent = (wk.date_range_start || '?') + '  →  ' + (sub.name || '(unnamed)');
        opt.addEventListener('mouseenter', () => opt.style.background = '#f3f4f6');
        opt.addEventListener('mouseleave', () => opt.style.background = '');
        opt.addEventListener('click', () => {
          sub.items = sub.items || [];
          // Don't double-pull: if an item already has this source_subtask_id, skip.
          if (sub.items.find(it => it.source_subtask_id === rowMeta.subtask.id)) {
            alert('Already pulled into this section.');
            return;
          }
          sub.items.push({
            id: newId('it'),
            status: rowMeta.subtask.done ? 'done' : (rowMeta.isBlocked ? 'need' : 'in_progress'),
            text: rowMeta.subtask.text || '',
            links: [],
            source_subtask_id: rowMeta.subtask.id,
          });
          scheduleSave();
          closePullMenu();
          renderBody();
        });
        menu.appendChild(opt);
      });
    });
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', closePullMenuOnce, { once: true }), 0);
  }
  function closePullMenu() {
    const m = document.getElementById('pmr-pull-menu');
    if (m) m.remove();
  }
  function closePullMenuOnce(ev) {
    const m = document.getElementById('pmr-pull-menu');
    if (m && !m.contains(ev.target)) m.remove();
  }

  /* ─────────────────────────────────────────────────────────────
   * Load / Save
   * ───────────────────────────────────────────────────────────── */
  function emptyDoc(periodId, period, researcherUid) {
    return {
      id: periodId,
      period: period,
      researcher_uids: researcherUid ? [researcherUid] : [],
      status: 'draft',
      submitted_at: null,
      discussed_at: null,
      reference_links: [],
      project_overview: [],
      weekly_entries: [],
      discussion: [],
      legacy_archive: null,
      created_at: isoNow(),
      updated_at: isoNow(),
    };
  }

  async function loadIndex() {
    try {
      state.indexDoc = await api.load(INDEX_PATH);
      if (!state.indexDoc.periods) state.indexDoc.periods = [];
    } catch (err) {
      // 404 / not-yet-created → blank index
      state.indexDoc = { periods: [] };
    }
  }

  async function saveIndexEntry(periodId, label, status) {
    if (!state.indexDoc) state.indexDoc = { periods: [] };
    const arr = state.indexDoc.periods = state.indexDoc.periods || [];
    let row = arr.find(p => p.id === periodId);
    if (!row) {
      row = { id: periodId, label: label, status: status || 'draft', updated_at: isoNow() };
      arr.push(row);
    } else {
      row.label = label;
      row.status = status || row.status || 'draft';
      row.updated_at = isoNow();
    }
    await api.save(INDEX_PATH, state.indexDoc);
  }

  async function loadPmrDoc(periodId) {
    ensurePmrRoute(periodId);
    try {
      const doc = await api.load(periodPathFor(periodId));
      // The adapter returns `{}` (not null) when a user-scope doc-route
      // points to a non-existent doc. Detect "fresh empty" by the absence
      // of the canonical `period` field; tell caller to make a blank one.
      if (!doc || !doc.period) return null;
      return hydrateDoc(doc);
    } catch (err) {
      return null;
    }
  }

  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    _savePending = true;
    state.saveTimer = setTimeout(() => {
      saveDoc().catch(err => console.error('[pmr] save failed:', err));
    }, 400);
  }

  async function saveDoc() {
    if (!state.doc || !state.currentPeriodId) { _savePending = false; return; }
    state.doc.updated_at = isoNow();
    _suppressUntil = Date.now() + 2500;
    state.saveTimer = null;
    setSavingHint('saving…');
    try {
      await api.save(periodPathFor(state.currentPeriodId), state.doc);
      // Mirror status + label into the index so the period dropdown stays fresh.
      await saveIndexEntry(state.currentPeriodId, periodLabel(state.doc.period), state.doc.status);
      _savePending = false;
      setSavingHint('saved ' + new Date().toLocaleTimeString());
    } catch (err) {
      setSavingHint('save failed');
      console.error('[pmr] save failed:', err);
      throw err;
    }
  }

  function hydrateDoc(d) {
    if (!d || typeof d !== 'object') return d;
    d.reference_links  = Array.isArray(d.reference_links)  ? d.reference_links  : [];
    d.project_overview = Array.isArray(d.project_overview) ? d.project_overview : [];
    d.weekly_entries   = Array.isArray(d.weekly_entries)   ? d.weekly_entries   : [];
    d.discussion       = Array.isArray(d.discussion)       ? d.discussion       : [];
    d.researcher_uids  = Array.isArray(d.researcher_uids)  ? d.researcher_uids  : [];
    return d;
  }

  function attachLiveSync() {
    if (_liveUnsub || typeof api.subscribe !== 'function' || !state.currentPeriodId) return;
    try {
      _liveUnsub = api.subscribe(periodPathFor(state.currentPeriodId), function (data) {
        if (Date.now() < _suppressUntil) return;
        if (_savePending) return;
        if (!data || !data.id) return;
        state.doc = hydrateDoc(data);
        renderBody();
      });
    } catch (err) {
      console.warn('[pmr] live sync failed to attach:', err && err.message);
    }
  }

  function detachLiveSync() {
    if (_liveUnsub) { try { _liveUnsub(); } catch (_) {} _liveUnsub = null; }
  }

  /* ─────────────────────────────────────────────────────────────
   * Period switching
   * ───────────────────────────────────────────────────────────── */
  async function switchToPeriod(periodId) {
    detachLiveSync();
    state.currentPeriodId = periodId;
    state.doc = await loadPmrDoc(periodId);
    if (!state.doc) {
      // Build a blank doc from the period definition.
      const idxRow = (state.indexDoc.periods || []).find(p => p.id === periodId);
      let period;
      if (idxRow && idxRow.period) {
        period = idxRow.period;
      } else {
        // Reconstruct from id (semester-style "YYYY-term[-suffix]" or "custom-...")
        period = inferPeriodFromId(periodId);
      }
      state.doc = emptyDoc(periodId, period, viewedUid());
    }
    renderBody();
    attachLiveSync();
    // Reload open tasks alongside the period switch — they don't depend on
    // which period is active (the user's open queue is global), but a refresh
    // here picks up any edits made on the Tasks page since boot.
    if (state.openTasksLoaded) {
      loadOpenTasks().then(() => renderBody()).catch(() => {});
    }
  }

  function inferPeriodFromId(periodId) {
    if (periodId.indexOf('custom-') === 0) {
      return { kind: 'custom', custom_label: periodId.slice(7), start_date: todayStr(), end_date: todayStr() };
    }
    const parts = periodId.split('-');
    const year = parseInt(parts[0], 10) || new Date().getFullYear();
    const term = parts[1] || 'fall';
    const rot  = parts[2] || null;
    return buildSemesterPeriod(year, term, rot);
  }

  /* ─────────────────────────────────────────────────────────────
   * Render — toolbar + status pill
   * ───────────────────────────────────────────────────────────── */
  function setSavingHint(text) {
    const el = document.getElementById('pmr-saving');
    if (el) el.textContent = text || '';
  }

  function renderToolbar() {
    const sel = document.getElementById('pmr-period');
    if (!sel) return;
    sel.innerHTML = '';

    // Combine known periods (from the index) + the suggested default semesters.
    const known = (state.indexDoc.periods || []);
    const suggested = suggestedPeriods().map(p => ({
      id: periodIdFor(p), label: periodLabel(p), suggested: true, period: p,
    }));
    const seen = {};
    const opts = [];
    known.concat(suggested).forEach(row => {
      if (seen[row.id]) return;
      seen[row.id] = true;
      opts.push(row);
    });
    opts.sort((a, b) => (b.id || '').localeCompare(a.id || ''));   // newest first by id

    opts.forEach(row => {
      const opt = document.createElement('option');
      opt.value = row.id;
      const stat = row.status ? ' · ' + row.status : (row.suggested ? ' · new' : '');
      opt.textContent = row.label + stat;
      if (row.id === state.currentPeriodId) opt.selected = true;
      sel.appendChild(opt);
    });

    sel.onchange = () => switchToPeriod(sel.value);

    const statusEl = document.getElementById('pmr-status-pill');
    if (statusEl && state.doc) {
      statusEl.className = 'status-pill ' + (state.doc.status || 'draft');
      statusEl.textContent = state.doc.status || 'draft';
    }
  }

  /* ─────────────────────────────────────────────────────────────
   * Render — left rail (admin student picker)
   * ───────────────────────────────────────────────────────────── */
  function renderRail(container) {
    if (!state.isAdmin) {
      container.classList.add('no-rail');
      return null;
    }
    const rail = document.createElement('aside');
    rail.className = 'pmr-rail';
    const h = document.createElement('h3');
    h.textContent = 'Lab members';
    rail.appendChild(h);

    const me = state.user && state.user.uid;
    const ordered = state.labMembers.slice().sort((a, b) => {
      // self first, then by category then name
      if (a.uid === me) return -1;
      if (b.uid === me) return 1;
      const ca = ASSIGNEE_CATEGORIES.indexOf(a.category || '');
      const cb = ASSIGNEE_CATEGORIES.indexOf(b.category || '');
      if (ca !== cb) return ca - cb;
      return (a.name || '').localeCompare(b.name || '');
    });

    ordered.forEach(m => {
      const row = document.createElement('div');
      row.className = 'person' + (m.uid === viewedUid() ? ' active' : '');
      row.title = m.email || m.uid;
      const av = document.createElement('span');
      av.className = 'avatar';
      av.style.background = m.color;
      av.textContent = (typeof initials === 'function') ? initials(m.name || m.email) : (m.name || '??').slice(0, 2).toUpperCase();
      row.appendChild(av);
      const name = document.createElement('span');
      name.textContent = m.name + (m.uid === me ? ' (you)' : '');
      name.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      row.appendChild(name);
      const role = document.createElement('span');
      role.className = 'role';
      role.textContent = m.category || '';
      row.appendChild(role);
      row.addEventListener('click', () => switchToUser(m.uid));
      rail.appendChild(row);
    });
    return rail;
  }

  async function switchToUser(uid) {
    if (uid === viewedUid()) return;
    state.viewAsUid = uid;
    detachLiveSync();
    state.indexDoc = null;
    state.currentPeriodId = null;
    state.doc = null;
    // The api adapter routes user-scope docs by current Firebase user id,
    // not by the uid we want to view. To read another lab member's PMR
    // (admin view), we need a uid override — Phase 1 punts on this:
    // we still call api.load, but it returns the admin's own data. The
    // proper read-as-other-user path needs adapter support (scope:'user'
    // with uidOverride) and firestore.rules allowing admin reads. Until
    // that lands, the rail is wired UI-only and clicking a non-self
    // person shows a placeholder note.
    if (uid !== state.user.uid) {
      renderUnsupportedAdminView(uid);
      return;
    }
    await loadIndex();
    pickInitialPeriod();
    renderAll();
  }

  function renderUnsupportedAdminView(uid) {
    const host = document.getElementById('pmr-content');
    if (!host) return;
    host.innerHTML = '';
    const layout = document.createElement('div');
    layout.className = 'pmr-layout';
    const rail = renderRail(layout);
    if (rail) layout.appendChild(rail);
    const body = document.createElement('div');
    body.className = 'pmr-body';
    const note = document.createElement('div');
    note.className = 'pmr-block';
    note.innerHTML = '<h2>Cross-user PMR view</h2>' +
      '<p style="font-size:13px;color:#374151;line-height:1.5">' +
      'Viewing <strong>' + escapeHtml(memberLabel(uid)) + "</strong>'s PMR " +
      'requires an admin read across user-scoped data. The Firestore ' +
      'rule + adapter override land alongside Phase 1 of the rollout. ' +
      'For now, sign in as that lab member, or ask them to share their ' +
      'PMR via "Submit for 1:1" once that flow is wired up.</p>' +
      '<p style="font-size:12px;color:#9ca3af;margin-top:8px">Tracked in: PMR plan, Phase 1 firestore.rules deploy.</p>';
    body.appendChild(note);
    layout.appendChild(body);
    host.appendChild(layout);
  }

  /* ─────────────────────────────────────────────────────────────
   * Render — body (the 5 canonical blocks)
   * ───────────────────────────────────────────────────────────── */
  function renderAll() {
    renderToolbar();
    const host = document.getElementById('pmr-content');
    if (!host) return;
    host.innerHTML = '';
    const layout = document.createElement('div');
    layout.className = 'pmr-layout';
    layout.id = 'pmr-layout';
    const rail = renderRail(layout);
    if (rail) layout.appendChild(rail);
    const body = document.createElement('div');
    body.className = 'pmr-body';
    body.id = 'pmr-body';
    layout.appendChild(body);
    host.appendChild(layout);
    renderBody();
  }

  function renderBody() {
    try { renderToolbar(); } catch (err) { console.error('[pmr] toolbar render failed:', err); }
    const body = document.getElementById('pmr-body');
    if (!body) return;
    body.innerHTML = '';
    if (!state.doc) {
      body.innerHTML = '<div class="pmr-empty">No PMR loaded.</div>';
      return;
    }
    // Each block is wrapped so one bad doc field can't blank the whole
    // page. The first time this fires you'll get a visible error card
    // naming the failing block instead of an empty viewport.
    const blocks = [
      ['Project overview', renderProjectOverviewBlock],
      ['Open tasks',       renderOpenTasksBlock],
      ['Reference links',  renderReferenceLinksBlock],
      ['Weekly entries',   renderWeeklyEntriesBlock],
      ['Discussion',       renderDiscussionBlock],
      ['Past PMRs',        renderPastPmrsBlock],
    ];
    for (const [name, fn] of blocks) {
      try {
        body.appendChild(fn());
      } catch (err) {
        console.error('[pmr] ' + name + ' block render failed:', err);
        const errCard = document.createElement('section');
        errCard.className = 'pmr-block';
        errCard.style.borderColor = '#fecaca';
        errCard.style.background = '#fef2f2';
        errCard.innerHTML = '<h2 style="color:#991b1b">' + name + ' — render error</h2>' +
          '<pre style="font-size:11px;color:#7f1d1d;white-space:pre-wrap;margin:0">' +
          escapeHtml(err && (err.stack || err.message) || String(err)) +
          '</pre>' +
          '<p style="font-size:11px;color:#6b7280;margin-top:6px">' +
          'Other blocks should still render below. Open DevTools for the full stack.</p>';
        body.appendChild(errCard);
      }
    }
  }

  /* ── Block: Open tasks (Phase 2) ───────────────────────────── */
  function renderOpenTasksBlock() {
    const block = document.createElement('section');
    block.className = 'pmr-block';
    const head = document.createElement('h2');
    const counts = state.openTasks.reduce((acc, r) => {
      if (r.isBlocked) acc.blocked++;
      else if (r.isOverdue) acc.overdue++;
      else if (r.isStale) acc.stale++;
      else acc.ok++;
      return acc;
    }, { blocked: 0, overdue: 0, stale: 0, ok: 0 });
    const total = state.openTasks.length;
    head.innerHTML = 'Open tasks <span class="pmr-help">your assigned subtasks across all projects · ' +
      total + ' open' +
      (counts.blocked ? ' · <span style="color:#991b1b">' + counts.blocked + ' blocked</span>' : '') +
      (counts.overdue ? ' · <span style="color:#dc2626">' + counts.overdue + ' overdue</span>' : '') +
      (counts.stale   ? ' · <span style="color:#92400e">' + counts.stale + ' stale</span>' : '') +
      '</span>';
    block.appendChild(head);

    if (!state.openTasksLoaded) {
      const loading = document.createElement('div');
      loading.className = 'pmr-empty';
      loading.textContent = 'Loading…';
      block.appendChild(loading);
      return block;
    }
    if (state.openTasksError) {
      const err = document.createElement('div');
      err.className = 'pmr-empty';
      err.textContent = 'Could not load open tasks: ' + state.openTasksError;
      block.appendChild(err);
      return block;
    }
    if (!total) {
      const empty = document.createElement('div');
      empty.className = 'pmr-empty';
      empty.textContent = 'No open tasks assigned to you. Add some on the Tasks page or run the assignee backfill script.';
      block.appendChild(empty);
      return block;
    }

    // Group by buckets-project title for visual structure.
    const byProject = {};
    const projOrder = [];
    state.openTasks.forEach(r => {
      const key = (r.project && r.project.id) || '_';
      if (!byProject[key]) {
        byProject[key] = { project: r.project, rows: [] };
        projOrder.push(key);
      }
      byProject[key].rows.push(r);
    });

    projOrder.forEach(key => {
      const grp = byProject[key];
      const projTitle = (grp.project && (grp.project.title || grp.project.id)) || '(no project)';
      const ph = document.createElement('div');
      ph.style.cssText = 'font-size:12px;font-weight:600;color:#374151;margin:8px 0 4px 0;padding:4px 0;border-bottom:1px solid #e5e7eb';
      ph.textContent = projTitle + '  ·  ' + grp.rows.length;
      block.appendChild(ph);
      grp.rows.forEach(r => block.appendChild(renderOpenTaskRow(r)));
    });

    // Action footer
    const actions = document.createElement('div');
    actions.style.cssText = 'margin-top:10px;display:flex;gap:8px;align-items:center';
    const refresh = document.createElement('button');
    refresh.className = 'pmr-add-btn';
    refresh.textContent = '↻ Refresh';
    refresh.title = 'Re-read tasks/buckets.json';
    refresh.onclick = async () => {
      state.openTasksLoaded = false;
      renderBody();
      await loadOpenTasks();
      renderBody();
    };
    actions.appendChild(refresh);

    const sugBtn = document.createElement('button');
    sugBtn.className = 'pmr-add-btn';
    sugBtn.textContent = '✨ Suggest discussion items';
    sugBtn.title = 'Auto-add Discussion cards for blocked / overdue / stale tasks';
    sugBtn.onclick = () => {
      const added = refreshDiscussionSuggestions();
      if (added) {
        renderBody();
      } else {
        alert('No new suggestions — every flagged task is already on the Discussion list (or dismissed).');
      }
    };
    actions.appendChild(sugBtn);

    block.appendChild(actions);
    return block;
  }

  function renderOpenTaskRow(rowMeta) {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:1fr auto auto auto;gap:8px;align-items:center;padding:5px 0;font-size:13px;border-bottom:1px solid #f3f4f6';

    // Title + chips
    const main = document.createElement('div');
    main.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const txt = document.createElement('span');
    txt.textContent = rowMeta.subtask.text || '(untitled)';
    txt.style.color = '#1f2937';
    main.appendChild(txt);

    function chip(label, bg, fg, title) {
      const c = document.createElement('span');
      c.textContent = label;
      c.title = title || '';
      c.style.cssText = 'display:inline-block;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.3px;padding:1px 6px;border-radius:8px;margin-left:6px';
      c.style.background = bg; c.style.color = fg;
      return c;
    }
    if (rowMeta.isBlocked) main.appendChild(chip(rowMeta.subtask.block_status || 'blocked', '#fee2e2', '#991b1b', 'Block status'));
    if (rowMeta.isOverdue) main.appendChild(chip('overdue', '#fee2e2', '#991b1b', 'Past due ' + rowMeta.subtask.due_date));
    if (rowMeta.isStale)   main.appendChild(chip(rowMeta.ageDays + 'd', '#fef3c7', '#92400e', 'No update in ' + rowMeta.ageDays + ' days'));
    if (rowMeta.subtask.priority && rowMeta.subtask.priority !== 'normal') {
      main.appendChild(chip(rowMeta.subtask.priority, '#e0e7ff', '#1e3a8a'));
    }
    row.appendChild(main);

    // Due date (compact)
    const due = document.createElement('span');
    due.style.cssText = 'font-size:12px;color:#6b7280;font-variant-numeric:tabular-nums';
    due.textContent = (rowMeta.subtask.due_date && rowMeta.subtask.due_date !== 'TBD') ? rowMeta.subtask.due_date : '';
    row.appendChild(due);

    // Open in Tasks
    const opn = document.createElement('a');
    opn.href = '/rm/pages/tasks-add.html';
    opn.target = '_self';
    opn.textContent = '→ tasks';
    opn.title = 'Jump to the bucket workspace';
    opn.style.cssText = 'font-size:11px;color:#2563eb;text-decoration:none;padding:2px 6px;border:1px solid #dbeafe;border-radius:4px;background:#eff6ff';
    row.appendChild(opn);

    // Pull into week
    const pull = document.createElement('button');
    pull.textContent = '⤓ pull';
    pull.title = 'Copy as an item into a weekly entry';
    pull.style.cssText = 'font-size:11px;padding:2px 8px;border:1px solid #d1d5db;border-radius:4px;background:#fff;cursor:pointer';
    pull.onclick = (ev) => { ev.stopPropagation(); openPullIntoWeek(rowMeta, pull); };
    row.appendChild(pull);

    return row;
  }

  /* ── Block: Project overview ───────────────────────────────── */
  function renderProjectOverviewBlock() {
    const block = document.createElement('section');
    block.className = 'pmr-block';
    const head = document.createElement('h2');
    head.innerHTML = 'Project overview <span class="pmr-help">status snapshot per active project</span>';
    block.appendChild(head);

    const tbl = document.createElement('table');
    tbl.className = 'pmr-proj-table';
    tbl.innerHTML = '<thead><tr>' +
      '<th style="width:160px">Project</th>' +
      '<th>Description</th>' +
      '<th style="width:100px">Lead</th>' +
      '<th style="width:120px">Status</th>' +
      '<th>Status note</th>' +
      '<th style="width:30px"></th>' +
      '</tr></thead>';
    const tbody = document.createElement('tbody');
    tbl.appendChild(tbody);

    const rows = state.doc.project_overview || [];
    rows.forEach((row, idx) => tbody.appendChild(renderProjectRow(row, idx)));
    if (!rows.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="6" class="pmr-empty">No projects added yet. Click "Auto-fill from my projects" or "+ Add row" below.</td>';
      tbody.appendChild(tr);
    }
    block.appendChild(tbl);

    const actions = document.createElement('div');
    actions.style.cssText = 'margin-top:8px;display:flex;gap:8px;align-items:center';
    const addBtn = document.createElement('button');
    addBtn.className = 'pmr-add-btn';
    addBtn.textContent = '+ Add row';
    addBtn.onclick = () => {
      state.doc.project_overview.push({
        project_id: '', description: '', lead_uid: viewedUid() || '',
        status: 'good', status_note: '',
      });
      scheduleSave();
      renderBody();
    };
    actions.appendChild(addBtn);

    const fillBtn = document.createElement('button');
    fillBtn.className = 'pmr-add-btn';
    fillBtn.textContent = '⤓ Auto-fill from my projects';
    fillBtn.title = 'Pull projects where I am listed in members[] (papers/courses/infrastructure/tools)';
    fillBtn.onclick = autoFillProjectRows;
    actions.appendChild(fillBtn);

    block.appendChild(actions);
    return block;
  }

  function renderProjectRow(row, idx) {
    const tr = document.createElement('tr');

    // Project id picker (combobox: pick existing OR free-text).
    const projTd = document.createElement('td');
    const projInput = document.createElement('input');
    projInput.type = 'text';
    projInput.value = row.project_id || '';
    projInput.placeholder = 'project-slug';
    projInput.setAttribute('list', 'pmr-proj-list-' + idx);
    projInput.addEventListener('input', () => { row.project_id = projInput.value; scheduleSave(); });
    projTd.appendChild(projInput);
    // Datalist of known projects for current user
    const dl = document.createElement('datalist');
    dl.id = 'pmr-proj-list-' + idx;
    const ps = state.projectsByUid[viewedUid()] || [];
    ps.forEach(p => {
      const o = document.createElement('option');
      o.value = p.id;
      o.label = p.title || p.name || p.id;
      dl.appendChild(o);
    });
    projTd.appendChild(dl);
    tr.appendChild(projTd);

    // Description
    const descTd = document.createElement('td');
    const descTa = document.createElement('textarea');
    descTa.rows = 2;
    descTa.value = row.description || '';
    descTa.addEventListener('input', () => { row.description = descTa.value; scheduleSave(); });
    descTd.appendChild(descTa);
    tr.appendChild(descTd);

    // Lead (uid select)
    const leadTd = document.createElement('td');
    const leadSel = document.createElement('select');
    const optBlank = document.createElement('option');
    optBlank.value = ''; optBlank.textContent = '—';
    leadSel.appendChild(optBlank);
    state.labMembers.forEach(m => {
      const o = document.createElement('option');
      o.value = m.uid; o.textContent = m.name;
      if (m.uid === row.lead_uid) o.selected = true;
      leadSel.appendChild(o);
    });
    leadSel.addEventListener('change', () => { row.lead_uid = leadSel.value; scheduleSave(); });
    leadTd.appendChild(leadSel);
    tr.appendChild(leadTd);

    // Status pill
    const statTd = document.createElement('td');
    const statSel = document.createElement('select');
    PROJ_STATUSES.forEach(s => {
      const o = document.createElement('option');
      o.value = s; o.textContent = s;
      if (s === row.status) o.selected = true;
      statSel.appendChild(o);
    });
    statSel.addEventListener('change', () => { row.status = statSel.value; scheduleSave(); });
    statTd.appendChild(statSel);
    const pill = document.createElement('span');
    pill.className = 'pmr-status-pill ' + (row.status || 'good');
    pill.textContent = row.status || 'good';
    pill.style.marginTop = '4px';
    pill.style.display = 'inline-block';
    statTd.appendChild(pill);
    tr.appendChild(statTd);

    // Status note
    const noteTd = document.createElement('td');
    const noteIn = document.createElement('input');
    noteIn.type = 'text';
    noteIn.value = row.status_note || '';
    noteIn.placeholder = 'e.g. WEKA classifier converging';
    noteIn.addEventListener('input', () => { row.status_note = noteIn.value; scheduleSave(); });
    noteTd.appendChild(noteIn);
    tr.appendChild(noteTd);

    // Delete
    const delTd = document.createElement('td');
    const del = document.createElement('span');
    del.className = 'del';
    del.textContent = '✕';
    del.style.cursor = 'pointer';
    del.style.color = '#dc2626';
    del.title = 'Remove row';
    del.onclick = () => {
      if (!confirm('Remove this project row?')) return;
      state.doc.project_overview.splice(idx, 1);
      scheduleSave();
      renderBody();
    };
    delTd.appendChild(del);
    tr.appendChild(delTd);

    return tr;
  }

  async function autoFillProjectRows() {
    const uid = viewedUid();
    if (!uid) return;
    const projects = await loadProjectsForUser(uid);
    if (!projects.length) {
      alert('No projects link to this lab member yet. Add members[] entries to a project first.');
      return;
    }
    const existing = new Set((state.doc.project_overview || []).map(r => r.project_id).filter(Boolean));
    let added = 0;
    projects.forEach(p => {
      if (existing.has(p.id)) return;
      state.doc.project_overview.push({
        project_id: p.id,
        description: p.title || p.name || p.id,
        lead_uid: ((p.members || []).find(m => m.role === 'lead') || {}).uid || uid,
        status: 'good',
        status_note: '',
      });
      added++;
    });
    if (added === 0) {
      alert('All your projects are already in the overview.');
      return;
    }
    scheduleSave();
    renderBody();
  }

  /* ── Block: Reference links ────────────────────────────────── */
  function renderReferenceLinksBlock() {
    const block = document.createElement('section');
    block.className = 'pmr-block';
    block.innerHTML = '<h2>Reference links <span class="pmr-help">running notes, lab notebook, past PMRs, protocols, fellowship docs</span></h2>';

    const list = document.createElement('div');
    (state.doc.reference_links || []).forEach((row, idx) => list.appendChild(renderRefRow(row, idx)));
    block.appendChild(list);

    const add = document.createElement('button');
    add.className = 'pmr-add-btn';
    add.textContent = '+ Add link';
    add.onclick = () => {
      state.doc.reference_links.push({ kind: 'notes', label: '', url: '' });
      scheduleSave();
      renderBody();
    };
    block.appendChild(add);
    return block;
  }

  function renderRefRow(row, idx) {
    const div = document.createElement('div');
    div.className = 'pmr-ref-row';
    const sel = document.createElement('select');
    REF_KINDS.forEach(k => {
      const o = document.createElement('option');
      o.value = k; o.textContent = k.replace('_', ' ');
      if (k === row.kind) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => { row.kind = sel.value; scheduleSave(); });

    const lbl = document.createElement('input');
    lbl.type = 'text';
    lbl.value = row.label || '';
    lbl.placeholder = 'label (e.g. Ally Lab Notebook)';
    lbl.addEventListener('input', () => { row.label = lbl.value; scheduleSave(); });

    const url = document.createElement('input');
    url.type = 'url';
    url.value = row.url || '';
    url.placeholder = 'https://…';
    url.addEventListener('input', () => { row.url = url.value; scheduleSave(); });

    const del = document.createElement('span');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Remove';
    del.onclick = () => {
      state.doc.reference_links.splice(idx, 1);
      scheduleSave();
      renderBody();
    };
    div.appendChild(sel);
    div.appendChild(lbl);
    div.appendChild(url);
    div.appendChild(del);
    return div;
  }

  /* ── Block: Weekly entries ─────────────────────────────────── */
  function renderWeeklyEntriesBlock() {
    const block = document.createElement('section');
    block.className = 'pmr-block';
    block.innerHTML = '<h2>Weekly entries <span class="pmr-help">date-ranged log of experimental updates, reading, sidequests</span></h2>';

    (state.doc.weekly_entries || []).forEach((wk, idx) => block.appendChild(renderWeek(wk, idx)));

    const add = document.createElement('button');
    add.className = 'pmr-add-btn';
    add.textContent = '+ Add week';
    add.onclick = () => addWeek();
    block.appendChild(add);
    return block;
  }

  function addWeek() {
    // Default to next-after-last week, or start = today.
    const last = (state.doc.weekly_entries || [])[state.doc.weekly_entries.length - 1];
    let start = todayStr();
    let end = todayStr();
    if (last && last.date_range_end) {
      const d = new Date(last.date_range_end + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      start = d.toISOString().slice(0, 10);
      const d2 = new Date(start + 'T00:00:00');
      d2.setDate(d2.getDate() + 6);
      end = d2.toISOString().slice(0, 10);
    } else {
      const d2 = new Date();
      d2.setDate(d2.getDate() + 6);
      end = d2.toISOString().slice(0, 10);
    }
    state.doc.weekly_entries.push({
      id: newId('wk'),
      date_range_start: start,
      date_range_end: end,
      subsections: DEFAULT_SUBSECTIONS.map(name => ({
        name: name, items: [],
      })),
    });
    scheduleSave();
    renderBody();
  }

  function renderWeek(wk, idx) {
    const div = document.createElement('div');
    div.className = 'pmr-week';
    const head = document.createElement('div');
    head.className = 'pmr-week-head';
    const startIn = document.createElement('input');
    startIn.type = 'date'; startIn.value = wk.date_range_start || '';
    startIn.addEventListener('change', () => { wk.date_range_start = startIn.value; scheduleSave(); });
    head.appendChild(startIn);
    const dash = document.createElement('span'); dash.className = 'dash'; dash.textContent = '→';
    head.appendChild(dash);
    const endIn = document.createElement('input');
    endIn.type = 'date'; endIn.value = wk.date_range_end || '';
    endIn.addEventListener('change', () => { wk.date_range_end = endIn.value; scheduleSave(); });
    head.appendChild(endIn);

    const del = document.createElement('span');
    del.className = 'del'; del.textContent = '✕'; del.title = 'Remove week';
    del.onclick = () => {
      if (!confirm('Remove this week?')) return;
      state.doc.weekly_entries.splice(idx, 1);
      scheduleSave();
      renderBody();
    };
    head.appendChild(del);
    div.appendChild(head);

    (wk.subsections || []).forEach((sub, si) => div.appendChild(renderSubsection(wk, sub, si)));

    const addSub = document.createElement('button');
    addSub.className = 'pmr-add-btn';
    addSub.textContent = '+ Subsection';
    addSub.onclick = () => {
      wk.subsections = wk.subsections || [];
      wk.subsections.push({ name: 'New section', items: [] });
      scheduleSave();
      renderBody();
    };
    div.appendChild(addSub);
    return div;
  }

  function renderSubsection(wk, sub, si) {
    const div = document.createElement('div');
    div.className = 'pmr-section';
    const head = document.createElement('div');
    head.className = 'pmr-section-head';
    const nameIn = document.createElement('input');
    nameIn.type = 'text'; nameIn.value = sub.name || '';
    nameIn.addEventListener('input', () => { sub.name = nameIn.value; scheduleSave(); });
    head.appendChild(nameIn);
    const del = document.createElement('span');
    del.className = 'del'; del.textContent = '✕';
    del.onclick = () => {
      if (!confirm('Remove subsection "' + (sub.name || '') + '"?')) return;
      wk.subsections.splice(si, 1);
      scheduleSave();
      renderBody();
    };
    head.appendChild(del);
    div.appendChild(head);

    (sub.items || []).forEach((item, ii) => div.appendChild(renderItem(sub, item, ii)));

    // Quick-add: enter to append
    const add = document.createElement('div');
    add.className = 'pmr-item';
    const stat = document.createElement('select');
    stat.className = 's-in_progress';
    ITEM_STATUSES.forEach(s => {
      const o = document.createElement('option');
      o.value = s; o.textContent = s.replace('_', ' ');
      if (s === 'in_progress') o.selected = true;
      stat.appendChild(o);
    });
    add.appendChild(stat);
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = '+ Add item (Enter)';
    inp.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' || !inp.value.trim()) return;
      sub.items = sub.items || [];
      sub.items.push({
        id: newId('it'),
        status: stat.value,
        text: inp.value.trim(),
        links: [],
      });
      inp.value = '';
      scheduleSave();
      renderBody();
    });
    add.appendChild(inp);
    add.appendChild(document.createElement('span'));
    div.appendChild(add);
    return div;
  }

  function renderItem(sub, item, ii) {
    const row = document.createElement('div');
    row.className = 'pmr-item';
    const stat = document.createElement('select');
    stat.className = 's-' + (item.status || 'in_progress');
    ITEM_STATUSES.forEach(s => {
      const o = document.createElement('option');
      o.value = s; o.textContent = s.replace('_', ' ');
      if (s === (item.status || 'in_progress')) o.selected = true;
      stat.appendChild(o);
    });
    stat.addEventListener('change', () => {
      item.status = stat.value;
      stat.className = 's-' + stat.value;
      scheduleSave();
    });
    row.appendChild(stat);

    const txt = document.createElement('input');
    txt.type = 'text';
    txt.value = item.text || '';
    txt.addEventListener('input', () => { item.text = txt.value; scheduleSave(); });
    row.appendChild(txt);

    const del = document.createElement('span');
    del.className = 'del'; del.textContent = '✕';
    del.onclick = () => {
      sub.items.splice(ii, 1);
      scheduleSave();
      renderBody();
    };
    row.appendChild(del);
    return row;
  }

  /* ── Block: Discussion / next steps ─────────────────────────── */
  function renderDiscussionBlock() {
    const block = document.createElement('section');
    block.className = 'pmr-block';
    block.innerHTML = '<h2>Discussion / next steps <span class="pmr-help">launchpad for the 1:1 — blockers + proposed next actions</span></h2>';
    const list = document.createElement('div');
    (state.doc.discussion || []).forEach((card, idx) => list.appendChild(renderDiscCard(card, idx)));
    if (!(state.doc.discussion || []).length) {
      const empty = document.createElement('div');
      empty.className = 'pmr-empty';
      empty.style.padding = '14px';
      empty.textContent = 'No discussion items yet. Click "+ Blocker", "+ Next action", or "+ Idea" below.';
      list.appendChild(empty);
    }
    block.appendChild(list);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-top:6px';
    ['blocker', 'next_action', 'idea'].forEach(kind => {
      const b = document.createElement('button');
      b.className = 'pmr-add-btn';
      b.textContent = '+ ' + kind.replace('_', ' ');
      b.onclick = () => {
        state.doc.discussion.push({
          id: newId('disc'),
          project_id: '', kind: kind, text: '',
          source: 'manual', source_ref: null, status: 'open',
        });
        scheduleSave();
        renderBody();
      };
      actions.appendChild(b);
    });
    block.appendChild(actions);
    return block;
  }

  function renderDiscCard(card, idx) {
    const div = document.createElement('div');
    div.className = 'pmr-disc-card kind-' + (card.kind || 'idea');
    if (card.dismissed_at) div.style.opacity = '0.5';

    // Left column — project + auto-source chip if any
    const left = document.createElement('div');
    left.style.cssText = 'display:flex;flex-direction:column;gap:4px';
    const projSel = document.createElement('select');
    const opt0 = document.createElement('option');
    opt0.value = ''; opt0.textContent = '— project —';
    projSel.appendChild(opt0);
    (state.doc.project_overview || []).forEach(p => {
      if (!p.project_id) return;
      const o = document.createElement('option');
      o.value = p.project_id; o.textContent = p.project_id;
      if (p.project_id === card.project_id) o.selected = true;
      projSel.appendChild(o);
    });
    projSel.addEventListener('change', () => { card.project_id = projSel.value; scheduleSave(); });
    left.appendChild(projSel);
    if (card.source && card.source !== 'manual') {
      const srcChip = document.createElement('span');
      srcChip.textContent = card.source.replace('_', ' ');
      srcChip.title = 'Auto-suggested from open tasks';
      srcChip.style.cssText = 'font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;padding:2px 6px;border-radius:8px;text-align:center;background:#fef3c7;color:#92400e';
      left.appendChild(srcChip);
    }
    div.appendChild(left);

    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.value = card.text || '';
    ta.placeholder = card.kind === 'blocker' ? 'What is blocking progress?' :
                     card.kind === 'next_action' ? 'What should we do next?' :
                                                   'Idea or open question';
    ta.addEventListener('input', () => { card.text = ta.value; scheduleSave(); });
    div.appendChild(ta);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const discBtn = document.createElement('button');
    discBtn.textContent = card.status === 'discussed' ? '✓ discussed' : 'Mark discussed';
    discBtn.onclick = () => {
      card.status = card.status === 'discussed' ? 'open' : 'discussed';
      card.discussed_at = (card.status === 'discussed') ? isoNow() : null;
      scheduleSave();
      renderBody();
    };
    actions.appendChild(discBtn);
    // Dismiss is a soft-delete for auto-suggested cards: keeps source_ref so
    // refreshDiscussionSuggestions() doesn't re-add the same task.
    if (card.source_ref) {
      const dismissBtn = document.createElement('button');
      dismissBtn.textContent = card.dismissed_at ? '↺ undo' : '⊘ dismiss';
      dismissBtn.title = card.dismissed_at ? 'Restore this suggestion' : 'Dismiss this suggestion (won\'t reappear)';
      dismissBtn.onclick = () => {
        card.dismissed_at = card.dismissed_at ? null : isoNow();
        scheduleSave();
        renderBody();
      };
      actions.appendChild(dismissBtn);
    }
    const delBtn = document.createElement('button');
    delBtn.textContent = '✕';
    delBtn.title = 'Remove permanently';
    delBtn.onclick = () => {
      state.doc.discussion.splice(idx, 1);
      scheduleSave();
      renderBody();
    };
    actions.appendChild(delBtn);
    div.appendChild(actions);
    return div;
  }

  /* ── Block: Past PMRs (legacy archive) ──────────────────────── */
  function renderPastPmrsBlock() {
    const block = document.createElement('section');
    block.className = 'pmr-block';
    block.innerHTML = '<h2>Past PMRs <span class="pmr-help">historical Google-Doc exports in /data/PMR/ — read-only</span></h2>';
    const list = document.createElement('div');
    list.id = 'pmr-archive-list';
    list.innerHTML = '<div class="pmr-empty" style="padding:10px">Loading archive…</div>';
    block.appendChild(list);
    // Populate asynchronously from server.py /api/data/PMR/ directory listing.
    populatePastPmrsList(list).catch(err => {
      list.innerHTML = '<div class="pmr-empty" style="padding:10px">Could not list /data/PMR/ — ' + escapeHtml(err.message || 'error') + '</div>';
    });
    return block;
  }

  async function populatePastPmrsList(host) {
    // Live listing from server.py /api/pmr-archive (Phase 4). Falls back
    // to a hardcoded list if the endpoint is unreachable (e.g. someone
    // opening pages/pmr.html through a different webserver). The
    // endpoint also returns a best-effort filename parse so we can group
    // by researcher.
    let files = null;
    // Skip the live listing on the static deploy — /api/pmr-archive is a
    // server.py endpoint that doesn't exist at mcgheelab.com/rm/. We fall
    // through to the hardcoded list below.
    if (!window.RM_RUNTIME || window.RM_RUNTIME.isLocal) {
      try {
        const res = await fetch('/api/pmr-archive');
        if (res.ok) {
          const j = await res.json();
          if (j && j.ok) files = j.files || [];
        }
      } catch (_) { /* fall through */ }
    }
    if (!files) {
      files = [
        'Alia PMR AS Spring 2026.zip',
        'Ally PMR AF Fall 2025.zip',
        'Gabe 2025-26 Project Management Report - Gabriel Declercq.zip',
        'alia PMR AS Aug-Oct 2024 rotation.docx.zip',
        'alia PMR AS Fall 2025.zip',
        'alia PMR AS Spring 2025.zip',
        'alia PMR AS Summer 2025.zip',
        'cris PMR CA Fall 2025.zip',
        'cris PMR CA Spring 2026.zip',
        'cris PMR CA Summer.zip',
        'ethan PMR Ethan Fall.zip',
        'ethan PMR Ethan Spring 2026.zip',
        'ethan PMR Ethan Summer.epub',
        'suraj and alex PMR AM+SB Fall 2025.zip',
      ].map(name => ({ name: name, url: '/data/PMR/' + encodeURIComponent(name), size: null, parsed: {} }));
    }

    host.innerHTML = '';
    if (!files.length) {
      const empty = document.createElement('div');
      empty.className = 'pmr-empty';
      empty.style.padding = '10px';
      empty.textContent = 'No archive files in data/PMR/.';
      host.appendChild(empty);
      return;
    }

    // Group by researcher (best-effort first-name from the parse).
    const byWho = {};
    const order = [];
    files.forEach(f => {
      const who = ((f.parsed && f.parsed.researcher) || '?').toLowerCase();
      if (!byWho[who]) { byWho[who] = []; order.push(who); }
      byWho[who].push(f);
    });

    order.sort().forEach(who => {
      const head = document.createElement('div');
      head.style.cssText = 'font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;margin:6px 0 2px 0;padding:4px 0';
      head.textContent = who;
      host.appendChild(head);
      byWho[who].forEach(f => {
        const a = document.createElement('a');
        a.href = f.url || ('/data/PMR/' + encodeURIComponent(f.name));
        a.target = '_blank';
        a.rel = 'noopener';
        const sizeMb = f.size ? '  ·  ' + (f.size / 1048576).toFixed(1) + ' MB' : '';
        const term = (f.parsed && f.parsed.term) ? f.parsed.term : '';
        const year = (f.parsed && f.parsed.year) ? f.parsed.year : '';
        const tag  = (term || year) ? '  ·  ' + [term, year].filter(Boolean).join(' ') : '';
        a.textContent = f.name + tag + sizeMb;
        a.style.cssText = 'display:block;padding:4px 8px 4px 16px;font-size:12px;color:#2563eb;text-decoration:none;border-bottom:1px solid #f3f4f6';
        a.addEventListener('mouseenter', () => a.style.background = '#f9fafb');
        a.addEventListener('mouseleave', () => a.style.background = '');
        host.appendChild(a);
      });
    });
  }

  /* ─────────────────────────────────────────────────────────────
   * "Submit for 1:1" — flips status draft → submitted
   * ───────────────────────────────────────────────────────────── */
  function wireSubmitButton() {
    const btn = document.getElementById('pmr-submit');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (!state.doc) return;
      const next = state.doc.status === 'submitted' ? 'draft' : 'submitted';
      state.doc.status = next;
      state.doc.submitted_at = (next === 'submitted') ? isoNow() : null;
      scheduleSave();
      renderBody();
    });
  }

  function wireNewPeriodButton() {
    const btn = document.getElementById('pmr-new');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const choice = prompt(
        'Period id (semester format like 2025-fall, 2025-spring-rot1, or "custom-<slug>"):',
        ''
      );
      if (!choice) return;
      const id = choice.trim();
      // Make sure index has it; switchToPeriod will create the doc.
      const period = inferPeriodFromId(id);
      if (!state.indexDoc) state.indexDoc = { periods: [] };
      if (!state.indexDoc.periods.find(p => p.id === id)) {
        state.indexDoc.periods.push({ id: id, label: periodLabel(period), status: 'draft', updated_at: isoNow(), period: period });
      }
      await switchToPeriod(id);
    });
  }

  /* ─────────────────────────────────────────────────────────────
   * Boot
   * ───────────────────────────────────────────────────────────── */
  function pickInitialPeriod() {
    // Prefer the most-recently-updated period; else current semester id.
    const idx = (state.indexDoc.periods || []).slice()
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    if (idx.length) {
      state.currentPeriodId = idx[0].id;
      return;
    }
    const cur = semesterFromDate(new Date());
    state.currentPeriodId = cur.year + '-' + cur.term;
  }

  function showBootError(label, err) {
    const host = document.getElementById('pmr-content');
    if (!host) return;
    const msg = err && (err.stack || err.message) || String(err);
    host.innerHTML = '<div class="pmr-block" style="border-color:#fecaca;background:#fef2f2">' +
      '<h2 style="color:#991b1b">PMR failed to start — ' + escapeHtml(label) + '</h2>' +
      '<pre style="font-size:11px;color:#7f1d1d;white-space:pre-wrap;margin:0">' + escapeHtml(msg) + '</pre>' +
      '<p style="font-size:11px;color:#6b7280;margin-top:8px">Open DevTools console for the full trace. ' +
      'If the failure is in a saved doc, you can reset by running this in the console:</p>' +
      '<code style="display:block;font-size:11px;background:#fff;border:1px solid #fecaca;padding:6px;margin-top:4px;border-radius:4px;color:#1f2937">' +
      "await api.save('pmr/_index.json', { periods: [] });" +
      '</code></div>';
  }

  async function boot() {
    try {
      if (typeof firebridge === 'undefined' || !firebridge.gateSignedIn) {
        document.getElementById('pmr-content').innerHTML = '<div class="pmr-empty">firebridge missing — load order issue.</div>';
        return;
      }
      const gate = await firebridge.gateSignedIn('PMR is for lab members. Sign in with your @arizona.edu (or admin Google) account.');
      if (!gate.allowed) return;

      // Refuse access to guest accounts.
      if (firebridge.isLabMember && !firebridge.isLabMember()) {
        document.getElementById('pmr-content').innerHTML =
          '<div class="pmr-empty">Your account is pending lab-member approval. Ask the admin to grant access.</div>';
        return;
      }

      state.user = firebridge.getUser();
      state.isAdmin = !!(firebridge.isAdmin && firebridge.isAdmin());
      state.viewAsUid = state.user.uid;

      // Boot reads in one parallel batch — pickInitialPeriod is sync and
      // doesn't gate loadProjectsForUser / loadOpenTasks (they only depend on
      // state.user.uid, set above). Single Promise.all collapses two RTT gaps.
      await Promise.all([
        loadLabMembers(),
        loadIndex(),
        loadProjectsForUser(state.user.uid),
        loadOpenTasks(),
      ]);
      pickInitialPeriod();

      wireSubmitButton();
      wireNewPeriodButton();

      renderAll();
      await switchToPeriod(state.currentPeriodId);
    } catch (err) {
      console.error('[pmr] boot failed:', err);
      showBootError('boot', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
