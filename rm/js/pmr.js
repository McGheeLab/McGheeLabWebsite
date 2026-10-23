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

  // V3.157 — Barriers lifecycle (open → discussing → resolved).
  // Lets the conversation between admin and student have a concrete state.
  const BARRIER_STATUSES = ['open', 'discussing', 'resolved'];
  // Paper-writing draft status (mirrors papers/{id}.status).
  const PAPER_WRITING_STATUSES = ['drafting', 'review', 'submitted', 'in_revision', 'published'];

  // V3.190 — canonical section order for the PMR body. state.doc.section_order
  // (a list of these keys) overrides this; any key not in section_order is
  // appended to the end so future-added sections surface for older docs.
  // V3.625 — project_health leads: the first thing a student (or the PI)
  // should see is which projects they have and how each is doing.
  // project_overview left the default order the same release — the health
  // header supersedes its hand-set good/behind/delayed/paused pill — but
  // stays renderable (LEGACY_SECTIONS) for docs that pinned it.
  const DEFAULT_SECTION_ORDER = [
    'project_health', 'goals', 'focus_review', 'myday_ledger', 'open_tasks',
    'reference_links', 'weekly_entries', 'activity', 'stats', 'barriers',
    'paper_writing', 'figure_reviews', 'discussion', 'past_pmrs',
  ];
  const LEGACY_SECTIONS = ['project_overview'];
  // Friendly labels per key (used for the block header H2 + the reorder UI).
  const SECTION_LABELS = {
    project_health: 'My projects',
    goals: 'Goals',
    focus_review: 'Weekly focus review',
    myday_ledger: 'My Week ledger',
    project_overview: 'Project overview (legacy)',
    open_tasks: 'Open tasks',
    reference_links: 'Reference links',
    weekly_entries: 'Weekly entries',
    activity: 'Activity',
    stats: 'Stats',
    barriers: 'Barriers',
    paper_writing: 'Paper writing',
    figure_reviews: 'Figure reviews',
    discussion: 'Discussion',
    past_pmrs: 'Past PMRs',
  };

  // V3.624 — My Week item-outcome vocabulary + type icons, mirrored from
  // day-distribute.js (ITEM_OUTCOME_META / my-week.js TYPE_ICONS — keep in
  // sync; day-distribute is not loaded on pmr.html and pulling in the whole
  // fan-out engine for two lookup tables would be worse).
  const MYDAY_OUTCOME_META = {
    result:    { icon: 'check-circle', label: 'Result' },
    barrier:   { icon: 'construction', label: 'Barrier' },
    no_result: { icon: '◌',  label: 'No result' },
  };
  const MYDAY_TYPE_ICONS = { work: 'target', equipment: 'microscope', task: 'check-circle', meeting: 'users', reading: 'book-open', order: 'shopping-cart', help: 'lifebuoy' };

  // V3.185 — Goal horizons. Four time scales from "this semester" out to
  // "after the PhD". Each gets its own rich-text card + per-horizon
  // comment thread so admin and student can talk about each separately.
  const GOAL_HORIZONS = [
    { key: 'short_term',  label: 'This semester',
      hint: 'Concrete deliverables for the current term — what you want to have done by the end of this period.',
      placeholder: 'e.g. Submit MEBP paper for review; finish microfluidic device prototype v2; pass quals.' },
    { key: 'this_year',   label: 'This year',
      hint: 'Year-scale milestones across all your projects.',
      placeholder: 'e.g. Two first-author papers; presented at GRC; mentored a rotation student.' },
    { key: 'phd',         label: 'PhD journey',
      hint: 'The thesis-scale vision — the body of work you want to graduate with.',
      placeholder: 'e.g. Build a microfluidic platform for X; publish 4 first-author papers; defend by Y.' },
    { key: 'beyond_phd',  label: 'Beyond PhD',
      hint: 'What comes after — career direction, skills to build, who you want to become.',
      placeholder: 'e.g. Industry R&D in regenerative medicine; postdoc with X; build a teaching portfolio.' },
  ];

  /* ─────────────────────────────────────────────────────────────
   * State
   * ───────────────────────────────────────────────────────────── */
  const state = {
    user: null,
    isAdmin: false,
    viewAsUid: null,             // admin can pick any lab member; non-admin = self only
    // V3.243 — non-admin mentors can view the PMR of any mentee they oversee.
    // Populated at boot from a single users-collection query (single-field
    // array-contains, no composite index needed).
    menteeUids: new Set(),
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
    // Phase 9 — comments-under-paper-assignment surfacing.
    // Key = paperId + '|' + assigneeUid → array of annotation docs (lab-vis).
    paperAnnotations: {},
    paperAnnotationsUnsubs: {},
    // V3.157 — paper drafts for the new "Paper writing" block. Populated by
    // loadPaperDraftsFor(viewedUid()) — pulls papers where the student is in
    // authorUids AND is_library_entry !== true (drafts only).
    paperDrafts: [],
    paperDraftsLoaded: false,
    paperDraftsError: null,
    // V3.187 — per-bucket roll-up. Populated alongside state.openTasks so the
    // Open Tasks block can render bucket-first (project → bucket → subtasks)
    // and surface the "Mark complete" + archived-buckets affordances even
    // for buckets with zero open subtasks. Each entry:
    //   { projectId, projectTitle, bucketId, bucketTitle, bucketCategory,
    //     totalSubtasks, doneSubtasks, allDone, archived, completedAt }
    bucketSummaries: [],
    // Mounted comment threads — every block can mount one or more
    // SectionComments instances. We track them so renderBody() can unmount
    // before re-rendering (otherwise live-sync would create ghost panes).
    commentMounts: [],
    // V3.517 — the viewed user's lab-notebook index rows, loaded cross-user
    // via direct firebridge.db() refs (the api adapter hard-codes the
    // signed-in uid). Filtered by date into each PMR week; full entry bodies
    // are lazy-loaded + cached on expand, keyed by `uid|entryId`.
    notebookIndexRows: [],
    notebookEntryCache: {},
  };

  const STALE_DAYS = 14;

  // Live-sync gates (mirrors tasks-buckets.js recipe).
  let _suppressUntil = 0;
  let _liveUnsub = null;
  let _savePending = false;
  // V3.199 — tasks/assigned.json live subscription so new admin-assigned
  // tasks appear in the Open Tasks "Assigned by teammates" group without
  // a page reload (api.load is cached for 30 min by default).
  let _assignedTasksUnsub = null;

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
  // V3.624 bug fix — renderFocusReviewBlock has referenced `escHTML` since
  // V3.541 but nothing on pmr.html ever defined it, so the block's async
  // body threw ReferenceError and degraded to "Focus areas unavailable."
  const escHTML = escapeHtml;

  function viewedUid() {
    return state.viewAsUid || (state.user && state.user.uid) || null;
  }

  // V3.157 — when an admin is viewing another lab member's PMR via the rail.
  // In that mode, the student owns the doc; admin can read it + post comments
  // + assign tasks, but cannot edit weekly entries / project overview / etc.
  function isReadOnlyView() {
    return !!(state.viewAsUid && state.user && state.viewAsUid !== state.user.uid);
  }

  // V3.157 — Firestore path strings for the cross-user case. PMR's
  // canonical storage is userData/{ownerUid}/pmr/{periodId}; the api adapter
  // hard-codes scope:'user' to the signed-in uid, so for admin-view-as-other
  // we bypass it and read directly via firebridge.db().
  function pmrIndexDocRef(uid) {
    return firebridge.db().collection('userData').doc(uid).collection('pmr').doc('_index');
  }
  function pmrPeriodDocRef(uid, periodId) {
    return firebridge.db().collection('userData').doc(uid).collection('pmr').doc(periodId);
  }
  function pmrCommentsCollPath(uid, periodId) {
    return 'userData/' + uid + '/pmr/' + periodId + '/comments';
  }

  // V3.517 — cross-user lab-notebook refs. Same rationale as the pmr refs
  // above: the api adapter hard-codes the signed-in uid, so to read a
  // student's notebook while an admin/mentor views their PMR we go direct
  // via firebridge.db(). Gated server-side by the notebook read rule
  // (owner || mentor || admin) added in V3.517.
  function notebookIndexDocRef(uid) {
    return firebridge.db().collection('userData').doc(uid)
      .collection('notebook').doc('_index');
  }
  function notebookEntryDocRef(uid, entryId) {
    return firebridge.db().collection('userData').doc(uid)
      .collection('notebook').doc(entryId);
  }

  // V3.624 — cross-user My Week refs for the ledger block. Same rationale:
  // the adapter is self-only, reviewers go direct. Gated server-side by the
  // dayPlans read rule (owner || mentor || admin) added in V3.624.
  function dayPlansCollRef(uid) {
    return firebridge.db().collection('userData').doc(uid).collection('dayPlans');
  }
  // V3.625 — barrier-acceptance records (owner-readable, reviewer-written).
  function healthReviewsCollRef(uid) {
    return firebridge.db().collection('userData').doc(uid).collection('healthReviews');
  }

  // Monday of a YYYY-MM-DD, local math (same as my-week.js mondayOf).
  function mondayStr(dateStr) {
    if (!dateStr) return '';
    const p = dateStr.split('-');
    const d = new Date(+p[0], +p[1] - 1, +p[2]);
    const dow = d.getDay();
    d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function shiftDateStr(dateStr, days) {
    const p = dateStr.split('-');
    const d = new Date(+p[0], +p[1] - 1, +p[2]);
    d.setDate(d.getDate() + days);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function weekRangeLabel(mon) {
    const a = mon.split('-'), bStr = shiftDateStr(mon, 6), b = bStr.split('-');
    const f = x => new Date(+x[0], +x[1] - 1, +x[2]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return f(a) + ' – ' + f(b);
  }

  // V3.624 — period-scoped dayPlans, cached per uid+period so the ledger
  // doesn't re-query on every keystroke-triggered renderBody(). The ↻
  // button and a period/user switch invalidate it.
  let _ledgerCache = { key: null, rows: null };
  async function loadDayPlansForPeriod(force) {
    const uid = viewedUid();
    const period = (state.doc && state.doc.period) || {};
    const from = period.start_date || shiftDateStr(mondayStr(todayStr()), -7 * 12);
    const to = period.end_date || todayStr();
    const key = uid + '|' + (state.currentPeriodId || '') + '|' + from + '|' + to;
    if (!force && _ledgerCache.key === key && _ledgerCache.rows) return _ledgerCache.rows;
    const snap = await dayPlansCollRef(uid)
      .where('date', '>=', from).where('date', '<=', to).get();
    const rows = snap.docs
      .filter(d => d.id !== '_prefs')
      .map(d => Object.assign({ id: d.id }, d.data()))
      .filter(it => it && it.status !== 'cancelled')
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') ||
                      (a.startTime || '').localeCompare(b.startTime || ''));
    _ledgerCache = { key, rows };
    return rows;
  }

  // An item whose day has passed with no verdict recorded — the ◇ state
  // the My Week nudge (V3.623) chases. Mirrors loadOutcomeQueue's filter.
  function isUnaccounted(it) {
    if (it.outcome) return false;
    // V3.853 — done/skipped without a result counts the same day (My Week's
    // needsResult agrees), so the student and the mentor see one number.
    if (it.status === 'done' || it.status === 'skipped') return it.date <= todayStr();
    return it.status === 'planned' && it.date < todayStr();
  }

  // V3.626 — one-flight activity fetch for the period. The ledger's
  // presence dots and the Activity/Stats blocks all consume the same
  // query; whoever asks first fetches, everyone else awaits the same
  // promise (renderBody mounts them near-simultaneously).
  let _activityPromise = null;
  function ensureActivityForPeriod() {
    const period = state.doc && state.doc.period;
    const fromDate = period && period.start_date;
    const toDate = period && period.end_date;
    const uid = viewedUid();
    if (!window.ActivitySignals || !fromDate || !toDate || !uid) return Promise.resolve([]);
    const key = uid + '|' + fromDate + '|' + toDate;
    if (state._activityCache && state._activityCache.uid === uid &&
        state._activityCache.from === fromDate && state._activityCache.to === toDate) {
      return Promise.resolve(state._activityCache.entries);
    }
    if (_activityPromise && _activityPromise._key === key) return _activityPromise;
    const p = window.ActivitySignals.listForPeriod(uid, { from: fromDate, to: toDate })
      .then(entries => {
        state._activityCache = { uid, from: fromDate, to: toDate, entries };
        return entries;
      });
    p._key = key;
    _activityPromise = p;
    return p;
  }

  // Dates (YYYY-MM-DD) with at least one real WORK event — schedule
  // markers and legacy pending docs don't count as presence.
  function activeDaySet(entries) {
    const set = new Set();
    (entries || []).forEach(e => {
      if (!e || !e.date) return;
      if (e.kind === 'schedule' || (!e.kind && e.scheduled_for && e.status === 'pending')) return;
      set.add(e.date);
    });
    return set;
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
        .filter(u => ASSIGNEE_CATEGORIES.indexOf(u.category) !== -1 && LAB_USERS.isVisible(u))
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

  /* V3.243 — load every user who lists the signed-in user as a mentor.
   * Single-field array-contains query — no composite index required.
   * Admin users skip this (they already see every lab member in the rail).
   * Errors swallowed: if the query fails we just don't render the rail. */
  async function loadMyMentees() {
    if (!state.user || !state.user.uid) return;
    if (state.isAdmin) return;
    try {
      const snap = await firebridge.db().collection('users')
        .where('mentor_uids', 'array-contains', state.user.uid).get();
      const uids = new Set();
      snap.forEach(d => { uids.add(d.id); });
      state.menteeUids = uids;
    } catch (err) {
      console.warn('[pmr] mentee lookup failed:', err && err.message);
      state.menteeUids = new Set();
    }
  }

  /* True if the signed-in user is allowed to view the given uid's PMR. */
  function canViewUid(uid) {
    if (!state.user || !uid) return false;
    if (uid === state.user.uid) return true;
    if (state.isAdmin) return true;
    return state.menteeUids.has(uid);
  }

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
   * V3.517 — Lab notebook pull-in (read-only, under Weekly entries)
   *
   * Loads the viewed user's notebook `_index` (one doc) so each weekly
   * block can surface the entries dated within its range. Works cross-user
   * (admin/mentor viewing a student) thanks to the V3.517 notebook read
   * rule + the direct db refs above. Full entry bodies are fetched lazily
   * on expand and cached. Errors are swallowed → the section just stays
   * empty, matching how the other cross-user pulls degrade.
   * ───────────────────────────────────────────────────────────── */
  async function loadNotebookIndex() {
    state.notebookIndexRows = [];
    state.notebookEntryCache = {};
    const uid = viewedUid();
    if (!uid) return;
    try {
      const snap = await notebookIndexDocRef(uid).get();
      if (snap.exists) {
        const data = snap.data() || {};
        state.notebookIndexRows = Array.isArray(data.entries) ? data.entries : [];
      }
    } catch (err) {
      console.warn('[pmr] notebook index load failed:', err && err.message);
      state.notebookIndexRows = [];
    }
  }

  /* Entries whose `date` (YYYY-MM-DD) falls inside a week's range.
   * Lexicographic string compare is safe for the repo's canonical date
   * format. Undated entries can't be placed in a week, so they're skipped. */
  function notebookEntriesForWeek(wk) {
    const rows = state.notebookIndexRows || [];
    const start = wk && wk.date_range_start;
    const end = wk && wk.date_range_end;
    if (!start && !end) return [];
    return rows.filter(e => {
      const d = e && e.date;
      if (!d) return false;
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    }).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  }

  /* Lazy-load + cache one full notebook entry (for the expand view). */
  async function loadNotebookEntry(entryId) {
    const uid = viewedUid();
    const key = uid + '|' + entryId;
    if (state.notebookEntryCache[key]) return state.notebookEntryCache[key];
    const snap = await notebookEntryDocRef(uid, entryId).get();
    const data = snap.exists ? (snap.data() || {}) : {};
    state.notebookEntryCache[key] = data;
    return data;
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
    state.bucketSummaries = [];
    const uid = viewedUid();
    if (!uid) { state.openTasksLoaded = true; return; }
    if (uid !== (state.user && state.user.uid)) {
      // Admin viewing another user — buckets/tasks are blocked by Firestore
      // rules (per-user privacy on tasks/buckets is intentional). Surface a
      // "limited cross-user view" message instead of an error; admin can
      // still comment + assign tasks via the +Assign Task buttons.
      state.openTasksLoaded = true;
      state.openTasksError = 'limited cross-user view — tasks not visible to admin';
      return;
    }
    try {
      const doc = await api.load('tasks/buckets.json');
      const rows = [];
      // V3.187 — count subtasks in a bucket (across the children tree) and
      // capture how many are done. Used to decide when to surface the
      // "Mark complete" button. Skips the synthetic 'proj-inbox' / 'Proposed'
      // bucket (proposed:true subtasks aren't real work).
      function countSubtasks(node, counts) {
        if (!node) return;
        if (node.proposed) return;        // suggestions, not real work
        counts.total++;
        if (node.done) counts.done++;
        (node.children || []).forEach(c => countSubtasks(c, counts));
      }
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
      (doc.taskBuilders || []).forEach(p => {
        (p.buckets || []).forEach(b => {
          (b.subtasks || []).forEach(st => walk(st, b, p, 0));
          // V3.187 — bucket-level summary, used by renderOpenTasksBlock to
          // group by bucket and to surface the Mark-complete + archive
          // affordances. Includes every bucket (archived or not) so the
          // archived section can render too.
          if (p.id === 'proj-inbox' || b.id === 'buk-inbox-unfiled') return;
          const counts = { total: 0, done: 0 };
          (b.subtasks || []).forEach(st => countSubtasks(st, counts));
          state.bucketSummaries.push({
            projectId: p.id,
            projectTitle: p.title || p.id,
            bucketId: b.id,
            bucketTitle: b.title || '(untitled bucket)',
            bucketCategory: b.category || null,
            bucketSubCategory: b.sub_category || null,
            totalSubtasks: counts.total,
            doneSubtasks: counts.done,
            allDone: counts.total > 0 && counts.done === counts.total,
            archived: !!b.archived,
            completedAt: b.completed_at || null,
          });
        });
      });

      // Phase 9 — also surface cross-user assigned tasks (Phase 8 model).
      // These live in userData/{me}/tasks where bucket=='assigned'; another
      // lab member dropped them in via task-assign.js. Treated as a synthetic
      // project so they group under "Assigned by teammates" in the open-tasks
      // panel. Suggested-reading rows skip overdue/stale chips per spec.
      try {
        const assignedDoc = await api.load('tasks/assigned.json');
        const assignedTasks = (assignedDoc && assignedDoc.tasks) || [];
        const today = todayStr();
        const synthProject = { id: '_assigned', title: 'Assigned by teammates' };
        const synthBucket  = { id: '_assigned', title: 'Assigned' };
        assignedTasks.forEach(t => {
          if (t.done) return;
          const upd = t.updatedAt || t.created_at || (t.paper_ref && t.paper_ref.assignedAt);
          const age = ageDaysOf(upd);
          const isSuggested = !!(t.paper_ref && t.paper_ref.kind === 'suggested');
          rows.push({
            subtask: t,
            bucket:  synthBucket,
            project: synthProject,
            ageDays: age,
            isOverdue: !isSuggested && !!(t.due_date && t.due_date !== 'TBD' && t.due_date < today),
            isStale:   !isSuggested && age != null && age >= STALE_DAYS,
            isBlocked: false,
            isAssignedFromOthers: true,
          });
        });
      } catch (err) {
        console.warn('[pmr] assigned-tasks load failed:', err && err.message);
        // Non-fatal — buckets-tree rows still render.
      }

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
      // Phase 9 — kick a paper-annotation listener for every paper-bearing
      // assignment so the comment count & comments expand inline.
      ensurePaperAnnotationSubs();
    } catch (err) {
      console.warn('[pmr] open-tasks load failed:', err && err.message);
      state.openTasksError = err && err.message || 'load failed';
      state.openTasksLoaded = true;
    }
  }

  /* V3.157 — Load draft papers where the viewed student is in authorUids.
   * Drafts = is_library_entry !== true (library entries are read-only literature
   * imports; drafts are papers we are writing). Renders into the new
   * "Paper writing" block with a comment thread per paper.
   *
   * Cross-user: papers are lab-readable per existing firestore.rules
   * (papers/{paperId} allow read: if isLabMember()), so admin can view the
   * student's drafts without any rule change.
   */
  async function loadPaperDraftsFor(uid) {
    state.paperDraftsError = null;
    state.paperDrafts = [];
    if (!uid) { state.paperDraftsLoaded = true; return; }
    try {
      const snap = await firebridge.db()
        .collection('papers')
        .where('authorUids', 'array-contains', uid)
        .get();
      const rows = [];
      snap.forEach(d => {
        const data = d.data() || {};
        // Exclude library entries (read-only literature imports). Drafts have
        // is_library_entry omitted or set to false.
        if (data.is_library_entry === true) return;
        rows.push({
          id: d.id,
          title: data.title || data.meta_title || '(untitled draft)',
          status: data.status || 'drafting',
          updatedAt: data.updated_at || (data.updatedAt && data.updatedAt.toDate && data.updatedAt.toDate().toISOString()) || '',
          authorUids: data.authorUids || [],
        });
      });
      rows.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      state.paperDrafts = rows;
      state.paperDraftsLoaded = true;
    } catch (err) {
      console.warn('[pmr] paper-drafts load failed:', err && err.message);
      state.paperDraftsError = err && err.message || 'load failed';
      state.paperDraftsLoaded = true;
    }
  }

  /* V3.157 — Comment thread mounting helper. Wraps SECTION_COMMENTS.mount()
   * with PMR-specific defaults (Firestore path, scope keys). Tracks the
   * mount handle in state.commentMounts so renderBody() can unmount stale
   * panes before re-rendering. Section + target ids are the identity of
   * the conversation: e.g. ('barriers', 'barr-abc') = the thread for
   * barrier abc. Both arguments are required even when target is null.
   */
  function mountCommentsFor(containerEl, sectionId, targetId, label) {
    if (!window.SECTION_COMMENTS) return null;
    const uid = viewedUid();
    if (!uid || !state.currentPeriodId) return null;
    const collPath = pmrCommentsCollPath(uid, state.currentPeriodId);
    const scope = { section_id: sectionId };
    if (targetId) scope.target_id = targetId;
    try {
      const handle = window.SECTION_COMMENTS.mount({
        container: containerEl,
        collectionPath: collPath,
        scope: scope,
        label: label || 'Discussion',
      });
      if (handle) state.commentMounts.push(handle);
      return handle;
    } catch (err) {
      console.warn('[pmr] mount comments failed:', err && err.message);
      return null;
    }
  }

  /* Build a "💬 N" toggle button that lazily mounts a comment thread under
   * the parent block. Avoids mounting all threads up front (lots of
   * onSnapshot listeners) — only fires when user clicks expand.
   */
  function buildCommentToggle(parentBlock, sectionId, targetId, label) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:6px';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmr-add-btn';
    btn.style.cssText = 'font-size:11px;color:#475569;background:none;border:none;padding:2px 0;cursor:pointer';
    ICON.label(btn, 'chat-bubble-left-right', ' conversation');
    btn.title = 'Toggle the admin↔student thread for this section';
    let mountHandle = null;
    btn.addEventListener('click', () => {
      if (mountHandle) {
        try { mountHandle.unmount(); } catch (_) {}
        mountHandle = null;
        ICON.label(btn, 'chat-bubble-left-right', ' conversation');
        return;
      }
      mountHandle = mountCommentsFor(wrap, sectionId, targetId, label);
      if (mountHandle) btn.textContent = '✕ close conversation';
    });
    wrap.appendChild(btn);
    parentBlock.appendChild(wrap);
    return wrap;
  }

  function unmountAllComments() {
    state.commentMounts.forEach(h => { try { h.unmount(); } catch (_) {} });
    state.commentMounts = [];
  }

  /* ─────────────────────────────────────────────────────────────
   * V3.190 — archive pattern shared helpers
   *
   * Every archivable item across the PMR sections carries a single
   * `discussed_at: ISO | null` field. When set, the item drops into the
   * collapsed "Archive (N)" section at the bottom of its block. Restore
   * clears `discussed_at` and the item re-appears at the top.
   * ───────────────────────────────────────────────────────────── */

  function splitArchive(items) {
    const active = [], archived = [];
    (items || []).forEach(it => {
      if (it && it.discussed_at) archived.push(it);
      else                       active.push(it);
    });
    return { active: active, archived: archived };
  }

  /* Build a "✓ discussed" / "↶ restore" toggle button bound to an item.
   * onChange is called after the mutation so the caller can scheduleSave
   * + re-render. Hidden in read-only view. */
  function buildDiscussedToggle(item, onChange) {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isArchived = !!(item && item.discussed_at);
    btn.textContent = isArchived ? '↶ restore' : '✓ discussed';
    btn.title = isArchived
      ? 'Move back to the active list'
      : 'Mark this item as discussed — it will move to the Archive section below';
    btn.style.cssText = isArchived
      ? 'font-size:11px;padding:3px 8px;border:1px solid #d1d5db;border-radius:4px;background:#fff;cursor:pointer;color:#374151'
      : 'font-size:11px;padding:3px 8px;border:1px solid #16a34a;color:#fff;background:#16a34a;border-radius:4px;cursor:pointer;font-weight:500';
    if (isReadOnlyView()) {
      btn.disabled = true;
      btn.style.opacity = '0.5';
      btn.title = 'Only the student can move items to the archive.';
    }
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (isReadOnlyView()) return;
      item.discussed_at = isArchived ? null : isoNow();
      if (typeof onChange === 'function') onChange(item);
    });
    return btn;
  }

  /* Collapsed `<details>` containing the archived items for a section.
   * Provides a free-text search input that filters by stringified item
   * content. Caller supplies a per-item renderer (the same one used for
   * active items, ideally — restore toggle is already in the row).
   *
   * Always renders even when archived is empty — the visible "Archive (0)"
   * summary lets the user discover that the system exists. Empty state
   * inside shows a short hint instead of the search input.
   */
  function renderItemArchive(label, archived, renderItemFn) {
    const det = document.createElement('details');
    det.style.cssText = 'margin-top:12px;padding:8px 10px;background:#f9fafb;border:1px dashed #d1d5db;border-radius:6px';
    const sum = document.createElement('summary');
    sum.style.cssText = 'cursor:pointer;font-size:12px;color:#4b5563;font-weight:600';
    sum.textContent = (label || 'Archive') + ' (' + archived.length + ')';
    det.appendChild(sum);

    if (!archived.length) {
      const hint = document.createElement('div');
      hint.style.cssText = 'margin-top:6px;font-size:11px;color:#9ca3af;font-style:italic';
      hint.textContent = 'Nothing here yet. Click "✓ discussed" on any item above to move it here once you and the PI have talked through it.';
      det.appendChild(hint);
      return det;
    }

    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Filter archive…';
    search.style.cssText = 'margin-top:6px;width:100%;font-size:12px;padding:4px 8px;border:1px solid #e5e7eb;border-radius:4px';
    det.appendChild(search);

    const list = document.createElement('div');
    list.style.cssText = 'margin-top:6px;display:grid;gap:6px';
    const rowEls = archived.map((item, i) => {
      const wrap = document.createElement('div');
      wrap.appendChild(renderItemFn(item, i));
      list.appendChild(wrap);
      return wrap;
    });
    det.appendChild(list);

    search.addEventListener('input', () => {
      const q = (search.value || '').trim().toLowerCase();
      archived.forEach((item, i) => {
        const matches = !q || JSON.stringify(item).toLowerCase().indexOf(q) !== -1;
        rowEls[i].style.display = matches ? '' : 'none';
      });
    });
    return det;
  }

  /* V3.190 — up/down arrows on each block header that reorder
   * state.doc.section_order. Hidden in read-only view. Falls back to
   * DEFAULT_SECTION_ORDER if section_order is empty (which is the
   * initial state for fresh PMR docs).
   */
  function effectiveSectionOrder() {
    // V3.625 — LEGACY_SECTIONS are renderable when a stored section_order
    // pins them, but never appended by default for new/unordered docs.
    const known = new Set(DEFAULT_SECTION_ORDER.concat(LEGACY_SECTIONS));
    const out = [];
    const seen = new Set();
    (state.doc && state.doc.section_order || []).forEach(k => {
      if (!known.has(k) || seen.has(k)) return;
      out.push(k);
      seen.add(k);
    });
    DEFAULT_SECTION_ORDER.forEach(k => {
      if (!seen.has(k)) out.push(k);
    });
    return out;
  }

  /* Apply a new section order, persist it, and re-render. Centralized so
   * V3.203's moveSection / moveSectionToTop / moveSectionToBottom all
   * share the same persistence path. Reorders bypass the normal 400ms
   * debounce and call saveDoc directly so a quick reload after clicking
   * doesn't lose the change (the debounce was eating reorders on users
   * who immediately closed the tab). saveDoc writes the whole PMR doc
   * (including section_order) to userData/{uid}/pmr/{periodId} via
   * api.save's user-scope doc-route branch (set + merge:true). On next
   * load, hydrateDoc preserves section_order as-is, so reorders survive
   * reload.
   */
  function _applyOrder(order, toastMsg) {
    state.doc.section_order = order;
    // Cancel any pending debounced save so we don't double-fire, then
    // commit immediately. Failures fall back to the next scheduleSave.
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    _savePending = true;
    saveDoc().catch(err => console.error('[pmr] reorder save failed:', err));
    renderBody();
    if (toastMsg && window.TOAST) TOAST.success(toastMsg, { ttl: 1500 });
  }

  function moveSection(key, delta) {
    if (isReadOnlyView()) return;
    if (!state.doc) return;
    const order = effectiveSectionOrder();
    const idx = order.indexOf(key);
    if (idx < 0) return;
    const swap = idx + delta;
    if (swap < 0 || swap >= order.length) return;
    const tmp = order[swap];
    order[swap] = order[idx];
    order[idx] = tmp;
    _applyOrder(order, null);
  }

  function moveSectionToTop(key) {
    if (isReadOnlyView() || !state.doc) return;
    const order = effectiveSectionOrder();
    const idx = order.indexOf(key);
    if (idx <= 0) return;
    order.splice(idx, 1);
    order.unshift(key);
    _applyOrder(order, (SECTION_LABELS[key] || key) + ' moved to top');
  }

  function moveSectionToBottom(key) {
    if (isReadOnlyView() || !state.doc) return;
    const order = effectiveSectionOrder();
    const idx = order.indexOf(key);
    if (idx < 0 || idx >= order.length - 1) return;
    order.splice(idx, 1);
    order.push(key);
    _applyOrder(order, (SECTION_LABELS[key] || key) + ' moved to bottom');
  }

  function buildReorderControls(sectionKey) {
    if (isReadOnlyView()) return null;
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex;gap:2px;align-items:center;margin-left:6px';
    const order = effectiveSectionOrder();
    const idx = order.indexOf(sectionKey);
    const lastIdx = order.length - 1;
    function _btn(label, title, disabled, onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.style.cssText = 'font-size:10px;padding:2px 5px;border:1px solid #e5e7eb;border-radius:3px;background:#fff;cursor:pointer;color:#6b7280';
      if (disabled) { b.disabled = true; b.style.opacity = '0.3'; b.style.cursor = 'default'; }
      b.addEventListener('click', onClick);
      return b;
    }
    // V3.203 — four-button reorder cluster: top, up, down, bottom.
    wrap.appendChild(_btn('⤒', 'Move this section to top',    idx <= 0,             () => moveSectionToTop(sectionKey)));
    wrap.appendChild(_btn('▲', 'Move this section up',        idx <= 0,             () => moveSection(sectionKey, -1)));
    wrap.appendChild(_btn('▼', 'Move this section down',      idx < 0 || idx >= lastIdx, () => moveSection(sectionKey, +1)));
    wrap.appendChild(_btn('⤓', 'Move this section to bottom', idx < 0 || idx >= lastIdx, () => moveSectionToBottom(sectionKey)));
    return wrap;
  }

  /* Decorate a block's H2 with reorder controls. Block-level helper so
   * each renderXxxBlock function adds one line: decorateBlockHead(block, 'barriers').
   * The H2 is expected to already exist as the first child of the block.
   */
  function decorateBlockHead(block, sectionKey) {
    const h2 = block.querySelector('h2');
    if (!h2) return;
    const reorder = buildReorderControls(sectionKey);
    if (reorder) h2.appendChild(reorder);
  }

  /* Phase 9 — ensure a Firestore listener is attached for every paper-bearing
   * assignment in state.openTasks. Listener pulls annotations from
   * papers/{paperId}/annotations filtered by creator.uid == viewedUid (the
   * assignee). The lab-visibility annotation rule already permits this read
   * for all signed-in lab members. Listeners are keyed by paperId|uid so we
   * don't double-attach when the open-tasks list re-renders.
   */
  function ensurePaperAnnotationSubs() {
    if (typeof firebase === 'undefined' || !firebase.firestore) return;
    const wantedKeys = new Set();
    state.openTasks.forEach(r => {
      const ref = r.subtask && r.subtask.paper_ref;
      if (!ref || !ref.paperId) return;
      const uid = r.subtask.assignedToUid || viewedUid();
      if (!uid) return;
      const key = ref.paperId + '|' + uid;
      wantedKeys.add(key);
      if (state.paperAnnotationsUnsubs[key]) return;
      try {
        state.paperAnnotationsUnsubs[key] = firebase.firestore()
          .collection('papers').doc(ref.paperId)
          .collection('annotations').where('creator.uid', '==', uid)
          .onSnapshot(function (snap) {
            const list = [];
            snap.forEach(d => list.push(d.data()));
            // Only annotations that actually carry a comment surface here.
            // Lab-visibility filter is enforced by the rule; private ones
            // are excluded for the assigner, included for the assignee.
            state.paperAnnotations[key] = list.filter(a => a && a.comment);
            renderBody();
          }, function (err) {
            console.warn('[pmr] paper-annotation listener failed for', key, err && err.message);
          });
      } catch (err) {
        console.warn('[pmr] could not attach paper-annotation listener:', err && err.message);
      }
    });
    // Tear down listeners for paper-rows that disappeared.
    Object.keys(state.paperAnnotationsUnsubs).forEach(k => {
      if (!wantedKeys.has(k)) {
        try { state.paperAnnotationsUnsubs[k](); } catch (_) {}
        delete state.paperAnnotationsUnsubs[k];
        delete state.paperAnnotations[k];
      }
    });
  }

  function detachAllPaperAnnotationSubs() {
    Object.keys(state.paperAnnotationsUnsubs).forEach(k => {
      try { state.paperAnnotationsUnsubs[k](); } catch (_) {}
    });
    state.paperAnnotationsUnsubs = {};
    state.paperAnnotations = {};
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
    // V3.322 — capture the anchor position first: auto-creating a week
    // re-renders the body, which can detach anchorEl.
    const r = anchorEl.getBoundingClientRect();
    if (!isReadOnlyView() && !(state.doc.weekly_entries || []).length) {
      // The old "Add a weekly entry first" alert is gone — just make one.
      addWeek();
    }
    const weeks = state.doc.weekly_entries || [];
    if (!weeks.length) return;   // read-only view can't create weeks
    closePullMenu();
    const menu = document.createElement('div');
    menu.id = 'pmr-pull-menu';
    menu.style.cssText = 'position:absolute;background:#fff;border:1px solid #d1d5db;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);padding:6px;min-width:240px;max-height:320px;overflow:auto;z-index:50;font-size:13px';
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
  function emptyGoals() {
    const g = {};
    GOAL_HORIZONS.forEach(h => { g[h.key] = { text_html: '', last_updated: null }; });
    return g;
  }

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
      // V3.157 — first-class barrier section (open → discussing → resolved)
      // and paper-writing drafts (cached pointers; canonical status from papers/{id}).
      barriers: [],
      paper_writing: [],
      // V3.161 — lab notebook figures the student flagged for review here.
      // Written by the notebook page (dual-write with notebook.pmr_review_figures).
      figure_reviews: [],
      // V3.185 — Goals across four time horizons (this-semester through
      // beyond-PhD). Each horizon carries an HTML rich-text body and a
      // last_updated timestamp. Per-horizon comment threads live in the
      // same pmr/{periodId}/comments subcollection scoped by section_id =
      // 'goals' and target_id = horizon key.
      goals: emptyGoals(),
      // V3.190 — student-controlled ordering of the section blocks.
      // Empty / missing → renderBody falls back to DEFAULT_SECTION_ORDER.
      // Unknown / new section keys are appended to the end on load so
      // future-added sections surface without a migration.
      section_order: [],
      // V3.195 — per-week discussed_at for the Activity block. Keyed by the
      // ISO week string (e.g. "2026-W19") because tracker entries live in
      // trackerEntries/{uid}/entries — not on this PMR doc — so we can't
      // hang discussed_at on the row itself.
      activity_archive: {},
      // V3.625 — student-editable one-liner per project on the health
      // header ([{foci_id, description}]). The health itself is derived
      // (project-health.js) and never stored.
      project_health: [],
      legacy_archive: null,
      created_at: isoNow(),
      updated_at: isoNow(),
    };
  }

  async function loadIndex() {
    const uid = viewedUid();
    if (!uid) { state.indexDoc = { periods: [] }; return; }
    try {
      if (uid === state.user.uid) {
        state.indexDoc = await api.load(INDEX_PATH);
      } else {
        // Cross-user (admin viewing another lab member). Bypass the adapter
        // — its scope:'user' resolution hard-codes the signed-in uid. We
        // read straight from Firestore; rules at firestore.rules already
        // grant admin read on userData/{any}/pmr/_index via the recursive
        // userData/{userId}/{document=**} rule.
        const snap = await pmrIndexDocRef(uid).get();
        state.indexDoc = snap.exists ? snap.data() : { periods: [] };
      }
      if (!state.indexDoc.periods) state.indexDoc.periods = [];
    } catch (err) {
      // 404 / not-yet-created → blank index
      console.warn('[pmr] index load failed for ' + uid + ':', err && err.message);
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
    const uid = viewedUid();
    if (!uid) return null;
    try {
      let doc;
      if (uid === state.user.uid) {
        ensurePmrRoute(periodId);
        doc = await api.load(periodPathFor(periodId));
      } else {
        // Admin cross-user read.
        const snap = await pmrPeriodDocRef(uid, periodId).get();
        doc = snap.exists ? Object.assign({ id: snap.id }, snap.data()) : null;
      }
      // The adapter returns `{}` (not null) when a user-scope doc-route
      // points to a non-existent doc. Detect "fresh empty" by the absence
      // of the canonical `period` field; tell caller to make a blank one.
      if (!doc || !doc.period) return null;
      return hydrateDoc(doc);
    } catch (err) {
      console.warn('[pmr] period load failed for ' + uid + '/' + periodId + ':', err && err.message);
      return null;
    }
  }

  function scheduleSave() {
    // V3.157 — Admin viewing another user's PMR: scope decision was
    // "comment + assign only" so we MUST NOT write to the doc. The UI
    // hides edit affordances in this mode, but mark this as a guard rail.
    if (isReadOnlyView()) return;
    if (state.saveTimer) clearTimeout(state.saveTimer);
    _savePending = true;
    state.saveTimer = setTimeout(() => {
      saveDoc().catch(err => console.error('[pmr] save failed:', err));
    }, 400);
  }

  async function saveDoc() {
    if (isReadOnlyView()) { _savePending = false; return; }
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
    // V3.157 — backfill new arrays for docs created before V3.157 ran.
    d.barriers         = Array.isArray(d.barriers)         ? d.barriers         : [];
    d.paper_writing    = Array.isArray(d.paper_writing)    ? d.paper_writing    : [];
    // V3.161 — notebook figures flagged for review in this PMR period.
    d.figure_reviews   = Array.isArray(d.figure_reviews)   ? d.figure_reviews   : [];
    // V3.185 — Goals object backfill. Missing horizons get blank cards.
    if (!d.goals || typeof d.goals !== 'object') d.goals = emptyGoals();
    GOAL_HORIZONS.forEach(h => {
      if (!d.goals[h.key] || typeof d.goals[h.key] !== 'object') {
        d.goals[h.key] = { text_html: '', last_updated: null };
      }
    });
    // V3.190 — student-controlled section order. Always materialize as an
    // array; renderBody falls back to DEFAULT_SECTION_ORDER when this is
    // empty so older docs without the field render in the canonical order.
    d.section_order = Array.isArray(d.section_order) ? d.section_order : [];
    // V3.195 — activity-week archive map (weekKey → discussed_at iso).
    if (!d.activity_archive || typeof d.activity_archive !== 'object') d.activity_archive = {};
    // V3.625 — per-project description lines on the health header.
    d.project_health = Array.isArray(d.project_health) ? d.project_health : [];
    // V3.323 — optional 1:1 meeting date (YYYY-MM-DD | null). Feeds
    // FuturePlan 05's meeting-reminder push.
    if (d.meeting_date === undefined) d.meeting_date = null;
    return d;
  }

  function attachLiveSync() {
    if (_liveUnsub || !state.currentPeriodId) return;
    const uid = viewedUid();
    if (!uid) return;
    try {
      if (uid === state.user.uid) {
        if (typeof api.subscribe !== 'function') return;
        _liveUnsub = api.subscribe(periodPathFor(state.currentPeriodId), function (data) {
          if (Date.now() < _suppressUntil) return;
          if (_savePending) return;
          if (!data || !data.id) return;
          state.doc = hydrateDoc(data);
          renderBody();
        });
      } else {
        // Cross-user — direct Firestore listener on userData/{uid}/pmr/{periodId}.
        _liveUnsub = pmrPeriodDocRef(uid, state.currentPeriodId).onSnapshot(function (snap) {
          if (!snap.exists) return;
          const data = Object.assign({ id: snap.id }, snap.data());
          if (!data.period) return;
          state.doc = hydrateDoc(data);
          renderBody();
        }, function (err) {
          console.warn('[pmr] cross-user live sync error:', err && err.message);
        });
      }
    } catch (err) {
      console.warn('[pmr] live sync failed to attach:', err && err.message);
    }
  }

  function detachLiveSync() {
    if (_liveUnsub) { try { _liveUnsub(); } catch (_) {} _liveUnsub = null; }
    detachAllPaperAnnotationSubs();
  }

  /* V3.199 — subscribe live to the student's own `tasks/assigned.json`
   * (= userData/{me}/tasks where bucket=='assigned'). The api adapter
   * routes user-scope subscriptions to the signed-in uid, so this only
   * works for self-view; admin viewing a student via the rail doesn't
   * reach the student's tasks (rules block it). We re-run loadOpenTasks
   * on every snapshot so the openTasks rollup picks up new rows.
   * No-op for cross-user view.
   */
  function attachAssignedTasksLiveSync() {
    if (_assignedTasksUnsub) return;
    if (isReadOnlyView()) return;
    if (typeof api.subscribe !== 'function') return;
    try {
      let firstFire = true;
      _assignedTasksUnsub = api.subscribe('tasks/assigned.json', function (data) {
        // Skip the first snapshot fire (boot's loadOpenTasks already
        // pulled the same data); fire reloadOpenTasks on subsequent
        // updates so the Open Tasks block re-renders.
        if (firstFire) { firstFire = false; return; }
        loadOpenTasks().then(() => renderBody()).catch(function () {});
      });
    } catch (err) {
      console.warn('[pmr] assigned-tasks live sync failed:', err && err.message);
    }
  }
  function detachAssignedTasksLiveSync() {
    if (_assignedTasksUnsub) { try { _assignedTasksUnsub(); } catch (_) {} _assignedTasksUnsub = null; }
  }

  /* ─────────────────────────────────────────────────────────────
   * Period switching
   * ───────────────────────────────────────────────────────────── */
  async function switchToPeriod(periodId) {
    // V3.322 review-fix — flush any pending debounced save against the
    // CURRENT period BEFORE repointing currentPeriodId. saveDoc resolves
    // its target lazily (periodPathFor(state.currentPeriodId) + state.doc),
    // so a timer firing mid-switch would write the OLD doc to the NEW
    // period's path and corrupt it. V3.322's auto-week arms a save on
    // every period open, so quickly clicking through periods reaches this
    // without any editing. Flush now, while both still point at the old
    // period, then switch.
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    if (_savePending) { try { await saveDoc(); } catch (e) { console.warn('[pmr] pre-switch flush failed:', e && e.message); } }
    detachLiveSync();
    state.currentPeriodId = periodId;
    state.doc = await loadPmrDoc(periodId);
    // V3.322 — was this a REAL period (existing doc, or one deliberately
    // created via the guided dialog, which pushes an index row before
    // calling us) — vs a transient "suggested" semester the user only
    // clicked to peek at from the dropdown? Auto-week must not persist
    // the latter (see the guard below).
    const wasLoaded = !!state.doc;
    const inIndex = (state.indexDoc.periods || []).some(p => p.id === periodId);
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
    // V3.322 — auto-create the current week so task-pull and weekly
    // logging never dead-end on an empty period. Only for editable,
    // still-running periods (never pollutes a closed archive) — and only
    // for periods that actually exist or were just created, NEVER for a
    // suggested semester being previewed (else clicking a dropdown
    // suggestion would silently persist it + a week into the index).
    if ((wasLoaded || inIndex) &&
        !isReadOnlyView() && state.doc &&
        (state.doc.weekly_entries || []).length === 0 &&
        (!state.doc.period || !state.doc.period.end_date || state.doc.period.end_date >= todayStr())) {
      addWeek();   // pushes the week + scheduleSave + renderBody
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

    // V3.323 — archived periods stay hidden unless toggled; the open
    // period always stays listed so the select never loses its value.
    const archivedCount = opts.filter(r => r.archived).length;
    const visible = opts.filter(r =>
      !r.archived || state.showArchivedPeriods || r.id === state.currentPeriodId);

    visible.forEach(row => {
      const opt = document.createElement('option');
      opt.value = row.id;
      const stat = row.archived ? ' · archived'
        : row.status ? ' · ' + row.status : (row.suggested ? ' · new' : '');
      opt.textContent = row.label + stat;
      if (row.id === state.currentPeriodId) opt.selected = true;
      sel.appendChild(opt);
    });

    sel.onchange = () => switchToPeriod(sel.value);

    const showArchBtn = document.getElementById('pmr-show-archived');
    if (showArchBtn) {
      showArchBtn.style.display = archivedCount ? '' : 'none';
      if (state.showArchivedPeriods) showArchBtn.textContent = 'hide archived';
      else ICON.label(showArchBtn, 'archive-box', ' ' + archivedCount + ' archived');
      showArchBtn.onclick = () => {
        state.showArchivedPeriods = !state.showArchivedPeriods;
        renderToolbar();
      };
    }

    const statusEl = document.getElementById('pmr-status-pill');
    if (statusEl && state.doc) {
      statusEl.className = 'status-pill ' + (state.doc.status || 'draft');
      statusEl.textContent = state.doc.status || 'draft';
    }

    // V3.323 — archive action (self-view only) next to Submit-for-1:1.
    const archBtn = document.getElementById('pmr-archive');
    if (archBtn) {
      const idxRow = known.find(p => p.id === state.currentPeriodId);
      if (isReadOnlyView() || !idxRow) {
        archBtn.style.display = 'none';
      } else {
        archBtn.style.display = '';
        if (idxRow.archived) archBtn.textContent = '↶ Unarchive';
        else ICON.label(archBtn, 'archive-box', ' Archive');
        archBtn.title = idxRow.archived
          ? 'Bring this period back into the period list'
          : 'Archive this period — hides it from the period list';
        archBtn.onclick = () => setPeriodArchived(state.currentPeriodId, !idxRow.archived);
      }
    }

    // V3.323 — optional 1:1 meeting date on the period doc.
    const meetWrap = document.getElementById('pmr-meeting-wrap');
    const meetInput = document.getElementById('pmr-meeting-date');
    if (meetWrap && meetInput) {
      if (!state.doc) {
        meetWrap.style.display = 'none';
      } else {
        meetWrap.style.display = 'inline-flex';
        meetInput.value = state.doc.meeting_date || '';
        meetInput.disabled = isReadOnlyView();
        meetInput.onchange = () => {
          state.doc.meeting_date = meetInput.value || null;
          scheduleSave();
        };
      }
    }
  }

  /* V3.323 — flip the archived flag on an _index period row. */
  async function setPeriodArchived(periodId, flag) {
    if (isReadOnlyView()) return;
    const row = (state.indexDoc && state.indexDoc.periods || []).find(p => p.id === periodId);
    if (!row) return;
    row.archived = !!flag;
    // V3.323 review-fix — do NOT bump updated_at here. pickInitialPeriod
    // lands on the most-recently-updated period, so bumping would make a
    // just-archived period the default on reload (and the current-period
    // filter would then re-reveal it), defeating the archive.
    try {
      await api.save(INDEX_PATH, state.indexDoc);
      if (window.TOAST) TOAST.success(flag ? 'Period archived' : 'Period restored', { ttl: 2000 });
    } catch (err) {
      console.error('[pmr] archive toggle failed:', err);
      if (window.TOAST) TOAST.error('Could not update the period', { detail: err.message });
    }
    renderToolbar();
  }

  /* ─────────────────────────────────────────────────────────────
   * Render — left rail (admin / mentor student picker)
   * ───────────────────────────────────────────────────────────── */
  function renderRail(container) {
    // V3.243 — non-admin mentors also get a rail, but filtered to self + their
    // mentees. Admins see every lab member.
    if (!state.isAdmin && !state.menteeUids.size) {
      container.classList.add('no-rail');
      return null;
    }
    const rail = document.createElement('aside');
    rail.className = 'pmr-rail';
    const h = document.createElement('h3');
    h.textContent = state.isAdmin ? 'Lab members' : 'Mentees';
    rail.appendChild(h);

    const me = state.user && state.user.uid;
    let pool = state.labMembers.slice();
    if (!state.isAdmin) {
      // Mentor view: keep self + only the mentees they oversee.
      pool = pool.filter(m => m.uid === me || state.menteeUids.has(m.uid));
    }
    const ordered = pool.sort((a, b) => {
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
    // V3.157 — load index + drafts for the target user (works for self and
    // for admin cross-user via direct firebridge.db calls bypassing the
    // adapter's hard-coded uid). loadOpenTasks short-circuits cross-user
    // since per-user buckets/tasks aren't admin-readable.
    // V3.243 — non-admin mentors may also view their mentees' PMRs.
    if (!canViewUid(uid)) {
      // Defensive: bounce back to self if the target isn't allowed.
      state.viewAsUid = state.user.uid;
      uid = state.user.uid;
    }
    await Promise.all([
      loadIndex(),
      loadPaperDraftsFor(uid),
      loadOpenTasks(),
      // V3.517 — the viewed user's notebook index. loadOpenTasks above
      // no-ops cross-user (buckets aren't admin-readable), but the V3.517
      // notebook read rule lets this one succeed for admins/mentors.
      loadNotebookIndex(),
    ]);
    pickInitialPeriod();
    renderAll();
    if (state.currentPeriodId) {
      await switchToPeriod(state.currentPeriodId);
    }
    // V3.199 — re-establish assigned-tasks live sync. The adapter only
    // subscribes to the signed-in uid's data, so we only attach when
    // viewing self (cross-user admin view doesn't see the student's
    // assigned-tasks queue either way — rules block it).
    detachAssignedTasksLiveSync();
    if (uid === state.user.uid) attachAssignedTasksLiveSync();
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
    // V3.157 — unmount stale comment threads before re-render to avoid
    // duplicate listeners and orphaned panes.
    unmountAllComments();
    body.innerHTML = '';
    if (!state.doc) {
      body.innerHTML = '<div class="pmr-empty">No PMR loaded.</div>';
      return;
    }
    // V3.157 — show a "viewing as" banner when admin is reading another lab
    // member's PMR, so it's obvious you're in cross-user mode.
    if (isReadOnlyView()) {
      const banner = document.createElement('div');
      banner.style.cssText =
        'background:#eff6ff;border:1px solid #bfdbfe;border-left:4px solid #2563eb;' +
        'border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:#1e3a8a';
      banner.innerHTML = '<strong>Viewing as admin:</strong> ' +
        escapeHtml(memberLabel(viewedUid())) +
        '’s PMR. You can <em>read</em> sections, <em>post comments</em>, and <em>assign tasks</em>. ' +
        'You cannot edit barriers, weekly entries, or project overview — only the student can.';
      body.appendChild(banner);
    }
    // V3.190 — render in the student-controlled section_order. Each key
    // resolves to a (label, renderFn) via SECTION_RENDERERS. Unknown keys
    // are skipped; missing keys are appended via effectiveSectionOrder().
    const SECTION_RENDERERS = {
      project_health:   renderProjectHealthBlock, // V3.625
      goals:            renderGoalsBlock,
      focus_review:     renderFocusReviewBlock,
      myday_ledger:     renderMyWeekLedgerBlock,  // V3.624 (key is stored; not migrated)
      project_overview: renderProjectOverviewBlock,
      open_tasks:       renderOpenTasksBlock,
      reference_links:  renderReferenceLinksBlock,
      weekly_entries:   renderWeeklyEntriesBlock,
      activity:         renderActivityBlock,
      stats:            renderStatsBlock,
      barriers:         renderBarriersBlock,
      paper_writing:    renderPaperWritingBlock,
      figure_reviews:   renderFigureReviewsBlock,
      discussion:       renderDiscussionBlock,
      past_pmrs:        renderPastPmrsBlock,
    };
    const order = effectiveSectionOrder();
    for (const key of order) {
      const fn = SECTION_RENDERERS[key];
      if (!fn) continue;
      const label = SECTION_LABELS[key] || key;
      try {
        const blockEl = fn();
        // V3.190 — decorate the block's H2 with up/down reorder arrows
        // (no-op in read-only view).
        try { decorateBlockHead(blockEl, key); } catch (_) {}
        body.appendChild(blockEl);
      } catch (err) {
        console.error('[pmr] ' + label + ' block render failed:', err);
        const errCard = document.createElement('section');
        errCard.className = 'pmr-block';
        errCard.style.borderColor = '#fecaca';
        errCard.style.background = '#fef2f2';
        errCard.innerHTML = '<h2 style="color:#991b1b">' + label + ' — render error</h2>' +
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
    head.innerHTML = 'Open tasks <span class="pmr-help">your assigned subtasks across all task builders · ' +
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
    // V3.187 — bucket-first organization. Group state.openTasks rows by
    // bucketId (so subtasks render under their bucket header), and walk
    // state.bucketSummaries to surface buckets with no open subtasks too
    // (zero-open is what triggers the Mark-complete affordance).
    const rowsByBucket = {};
    state.openTasks.forEach(r => {
      const bid = (r.bucket && r.bucket.id) || '_';
      (rowsByBucket[bid] = rowsByBucket[bid] || []).push(r);
    });

    // Group buckets by project; preserve project order from first-seen.
    // bucketSummaries does not include the synthetic 'Assigned by teammates'
    // project, so render that one separately at the bottom from rowsByBucket.
    const bucketsByProject = {};
    const projectOrder = [];
    const activeSummaries = state.bucketSummaries.filter(s => !s.archived);
    const archivedSummaries = state.bucketSummaries.filter(s =>  s.archived);
    activeSummaries.forEach(s => {
      if (!bucketsByProject[s.projectId]) {
        bucketsByProject[s.projectId] = { projectId: s.projectId, projectTitle: s.projectTitle, summaries: [] };
        projectOrder.push(s.projectId);
      }
      bucketsByProject[s.projectId].summaries.push(s);
    });

    let renderedActiveBuckets = 0;
    projectOrder.forEach(pid => {
      const grp = bucketsByProject[pid];
      // Skip projects whose only buckets have zero open subtasks AND aren't
      // all-done (i.e. completely empty buckets just clutter the view).
      const visibleBuckets = grp.summaries.filter(s => {
        const openRows = rowsByBucket[s.bucketId] || [];
        return openRows.length > 0 || s.allDone;
      });
      if (!visibleBuckets.length) return;

      // V3.195 — each project group is a <details> collapsed by default,
      // so a student with 5+ projects sees a tidy list of headers rather
      // than a wall of rows. Summary line shows project title + open count.
      const det = document.createElement('details');
      det.style.cssText = 'margin:10px 0 4px 0';
      const sum = document.createElement('summary');
      sum.style.cssText = 'cursor:pointer;font-size:12px;font-weight:600;color:#374151;padding:4px 0;border-bottom:1px solid #e5e7eb';
      const openCount = visibleBuckets.reduce((acc, s) => acc + (rowsByBucket[s.bucketId] || []).length, 0);
      sum.textContent = grp.projectTitle + '  ·  ' + openCount + ' open';
      det.appendChild(sum);

      visibleBuckets.forEach(s => {
        renderedActiveBuckets++;
        det.appendChild(renderBucketGroup(s, rowsByBucket[s.bucketId] || []));
      });
      block.appendChild(det);
    });

    // Assigned-by-teammates rows live under a synthetic project not in
    // bucketSummaries — render them directly so they still show up.
    const assignedRows = rowsByBucket['_assigned'] || [];
    if (assignedRows.length) {
      // V3.199 — expanded by default since assignments from teammates are
      // time-sensitive (newly-arrived tasks would otherwise hide behind a
      // collapsed header the student doesn't notice). Other project groups
      // stay collapsed.
      const det = document.createElement('details');
      det.open = true;
      det.style.cssText = 'margin:10px 0 4px 0;background:#fef3c7;border:1px solid #fde68a;border-radius:6px;padding:6px 10px';
      const sum = document.createElement('summary');
      sum.style.cssText = 'cursor:pointer;font-size:12px;font-weight:700;color:#92400e;padding:4px 0';
      ICON.label(sum, 'arrow-down-tray', ' Assigned by teammates  ·  ' + assignedRows.length + ' open');
      det.appendChild(sum);
      assignedRows.forEach(r => det.appendChild(renderOpenTaskRow(r)));
      block.appendChild(det);
    }

    if (!total && !renderedActiveBuckets && !archivedSummaries.length) {
      const empty = document.createElement('div');
      empty.className = 'pmr-empty';
      empty.textContent = 'No open tasks assigned to you. Add some on the Tasks page or run the assignee backfill script.';
      block.appendChild(empty);
    }

    // V3.187 — Archived buckets collapsed section.
    if (archivedSummaries.length) {
      block.appendChild(renderArchivedBucketsSection(archivedSummaries));
    }

    // Action footer
    const actions = document.createElement('div');
    actions.style.cssText = 'margin-top:10px;display:flex;gap:8px;align-items:center';
    const refresh = document.createElement('button');
    refresh.className = 'pmr-add-btn';
    ICON.label(refresh, 'arrow-path', ' Refresh');
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
    ICON.label(sugBtn, 'sparkles', ' Suggest discussion items');
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
    // V3.157 — section-level conversation for "what's blocking my open tasks"
    buildCommentToggle(block, 'open_tasks', null, 'Open-tasks discussion');
    return block;
  }

  /* V3.187 — render one bucket group inside the Open Tasks block.
   * Header shows N/M progress; if everything in the bucket is done (and
   * the bucket has at least one real subtask), surface a "✓ Mark
   * complete" button that flips bucket.archived=true. Subtask rows
   * render beneath; an all-done bucket renders with no rows but the
   * header + button (cross-user view doesn't reach here today).
   */
  function renderBucketGroup(summary, rows) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin:6px 0 10px 0;border:1px solid #e5e7eb;border-radius:6px;padding:6px 10px;background:#fafbfc';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;color:#374151;margin-bottom:4px';

    const title = document.createElement('span');
    title.textContent = summary.bucketTitle;
    title.style.cssText = 'font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    head.appendChild(title);

    if (summary.bucketSubCategory) {
      const sub = document.createElement('span');
      sub.textContent = summary.bucketSubCategory;
      sub.style.cssText = 'font-size:10px;color:#6b7280;padding:1px 6px;background:#f3f4f6;border-radius:8px';
      head.appendChild(sub);
    }

    const progress = document.createElement('span');
    progress.style.cssText = 'font-size:11px;color:#6b7280;font-variant-numeric:tabular-nums';
    progress.textContent = summary.doneSubtasks + ' / ' + summary.totalSubtasks + ' done';
    head.appendChild(progress);

    if (summary.allDone && !isReadOnlyView()) {
      const mark = document.createElement('button');
      mark.type = 'button';
      ICON.label(mark, 'check', ' Mark complete');
      mark.title = 'Archive this bucket — every subtask is done.';
      mark.style.cssText = 'font-size:11px;padding:3px 10px;border:1px solid #16a34a;color:#fff;background:#16a34a;border-radius:4px;cursor:pointer;font-weight:600';
      mark.addEventListener('click', () => markBucketComplete(summary.projectId, summary.bucketId, summary.bucketTitle));
      head.appendChild(mark);
    } else if (summary.allDone && isReadOnlyView()) {
      const note = document.createElement('span');
      ICON.label(note, 'check', ' all done — student can archive');
      note.style.cssText = 'font-size:10px;color:#16a34a;font-weight:600';
      head.appendChild(note);
    }

    wrap.appendChild(head);

    if (rows.length) {
      rows.forEach(r => wrap.appendChild(renderOpenTaskRow(r)));
    } else if (summary.allDone) {
      const note = document.createElement('div');
      note.style.cssText = 'font-size:11px;color:#9ca3af;padding:4px 0;font-style:italic';
      note.textContent = 'All subtasks complete — ready to archive.';
      wrap.appendChild(note);
    }
    return wrap;
  }

  /* V3.187 — collapsed `<details>` listing archived buckets with their
   * completion date + a Restore button. Restore flips archived back to
   * false so the bucket re-appears in the active list (and re-surfaces
   * its subtasks too if any were re-opened in the meantime).
   */
  function renderArchivedBucketsSection(archivedSummaries) {
    const det = document.createElement('details');
    det.style.cssText = 'margin-top:14px;padding:8px 10px;background:#f9fafb;border:1px dashed #d1d5db;border-radius:6px';
    const sum = document.createElement('summary');
    sum.style.cssText = 'cursor:pointer;font-size:12px;color:#4b5563;font-weight:600';
    sum.textContent = 'Archived buckets (' + archivedSummaries.length + ')';
    det.appendChild(sum);

    // Sort newest-completed first so recent archives are easy to find.
    archivedSummaries.slice().sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''))
      .forEach(s => det.appendChild(renderArchivedBucketRow(s)));
    return det;
  }

  function renderArchivedBucketRow(summary) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:12px;color:#374151';
    const title = document.createElement('span');
    title.textContent = summary.bucketTitle;
    title.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500';
    row.appendChild(title);
    const proj = document.createElement('span');
    proj.textContent = summary.projectTitle;
    proj.style.cssText = 'font-size:10px;color:#9ca3af';
    row.appendChild(proj);
    const when = document.createElement('span');
    when.textContent = summary.completedAt ? 'completed ' + summary.completedAt.slice(0, 10) : 'archived';
    when.style.cssText = 'font-size:10px;color:#6b7280;font-variant-numeric:tabular-nums';
    row.appendChild(when);
    if (!isReadOnlyView()) {
      const restore = document.createElement('button');
      restore.type = 'button';
      ICON.label(restore, 'arrow-uturn-left', ' restore');
      restore.title = 'Un-archive this bucket';
      restore.style.cssText = 'font-size:10px;padding:2px 8px;border:1px solid #d1d5db;border-radius:4px;background:#fff;cursor:pointer;color:#374151';
      restore.addEventListener('click', () => unarchiveBucket(summary.projectId, summary.bucketId, summary.bucketTitle));
      row.appendChild(restore);
    }
    return row;
  }

  /* V3.187 — write archive=true on a bucket inside a project doc at
   * userData/{uid}/buckets/{projectId}. Targeted read-modify-write so we
   * don't rewrite the whole subcollection; the wrap-key route's full
   * rewrite would be heavy and would race with other tasks-buckets edits.
   * Owner-only today (rules block cross-user writes to userData/{uid}/
   * {**}); admin-side mark-complete needs a follow-up rule change.
   */
  async function markBucketComplete(projectId, bucketId, bucketTitle) {
    if (isReadOnlyView()) {
      alert('Admin cross-user mark-complete is not enabled yet. Ask the student to archive this bucket from their own PMR.');
      return;
    }
    if (!confirm('Archive bucket "' + (bucketTitle || bucketId) + '"? You can restore it from the Archived buckets section.')) return;
    await updateBucketArchived(projectId, bucketId, true);
  }

  async function unarchiveBucket(projectId, bucketId, bucketTitle) {
    if (isReadOnlyView()) return;
    await updateBucketArchived(projectId, bucketId, false);
  }

  async function updateBucketArchived(projectId, bucketId, archived) {
    const uid = state.user && state.user.uid;
    if (!uid) return;
    try {
      const ref = firebridge.db().collection('userData').doc(uid).collection('buckets').doc(projectId);
      const snap = await ref.get();
      if (!snap.exists) {
        alert('Could not find this task builder — it may have been deleted.');
        return;
      }
      const data = snap.data() || {};
      const list = (data.buckets || []).map(b => {
        if (b.id !== bucketId) return b;
        return Object.assign({}, b, {
          archived: !!archived,
          completed_at: archived ? isoNow() : null,
        });
      });
      await ref.update({ buckets: list, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      // Refresh the open-tasks roll-up so the bucket moves between active
      // and archived sections without a manual refresh click.
      await loadOpenTasks();
      renderBody();
    } catch (err) {
      console.error('[pmr] updateBucketArchived failed:', err);
      alert('Failed to ' + (archived ? 'archive' : 'restore') + ' bucket: ' + (err.message || err));
    }
  }

  function renderOpenTaskRow(rowMeta) {
    // Paper-reading assignments get a dedicated row template that links to
    // the library viewer + lazily expands to show the assignee's lab-visible
    // comments on that paper.
    if (rowMeta.subtask && rowMeta.subtask.paper_ref) {
      return renderPaperAssignmentRow(rowMeta);
    }
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
    opn.href = '/rm/pages/tasks.html?tab=add';
    opn.target = '_self';
    opn.textContent = '→ tasks';
    opn.title = 'Jump to the bucket workspace';
    opn.style.cssText = 'font-size:11px;color:#2563eb;text-decoration:none;padding:2px 6px;border:1px solid #dbeafe;border-radius:4px;background:#eff6ff';
    row.appendChild(opn);

    // Pull into week
    const pull = document.createElement('button');
    ICON.label(pull, 'arrow-down-tray', ' pull');
    pull.title = 'Copy as an item into a weekly entry';
    pull.style.cssText = 'font-size:11px;padding:2px 8px;border:1px solid #d1d5db;border-radius:4px;background:#fff;cursor:pointer';
    pull.onclick = (ev) => { ev.stopPropagation(); openPullIntoWeek(rowMeta, pull); };
    row.appendChild(pull);

    return row;
  }

  /* Phase 9 — render a paper-assignment row.
   *  - paper title (link to library viewer)
   *  - kind chip ("assigned" red / "suggested" blue) + assigner attribution
   *  - due date + overdue/stale chips (suppressed for suggested rows in loadOpenTasks)
   *  - <details> expander with the assignee's lab-visible comments on this paper
   */
  function renderPaperAssignmentRow(rowMeta) {
    const t = rowMeta.subtask;
    const ref = t.paper_ref || {};
    const uid = t.assignedToUid || viewedUid();
    const key = ref.paperId + '|' + uid;
    const annotations = state.paperAnnotations[key] || [];
    const annLoaded = !!state.paperAnnotationsUnsubs[key];

    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:8px 0;border-bottom:1px solid #f3f4f6';

    // Header row
    const head = document.createElement('div');
    head.style.cssText = 'display:grid;grid-template-columns:1fr auto auto auto;gap:8px;align-items:center;font-size:13px';

    const main = document.createElement('div');
    main.style.cssText = 'min-width:0;overflow:hidden';

    const kindChip = document.createElement('span');
    const isSuggested = ref.kind === 'suggested';
    kindChip.textContent = isSuggested ? 'suggested' : 'assigned';
    kindChip.style.cssText = 'display:inline-block;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;padding:2px 6px;border-radius:8px;margin-right:6px;vertical-align:middle';
    if (isSuggested) {
      kindChip.style.background = '#dbeafe';
      kindChip.style.color = '#1e3a8a';
    } else {
      kindChip.style.background = '#fee2e2';
      kindChip.style.color = '#991b1b';
    }
    main.appendChild(kindChip);

    const link = document.createElement('a');
    link.href = '/rm/pages/library-paper.html?id=' + encodeURIComponent(ref.paperId);
    link.target = '_self';
    link.textContent = ref.paperTitle || ref.paperId || '(untitled paper)';
    link.style.cssText = 'color:#1f2937;text-decoration:none;font-weight:500;border-bottom:1px dotted #9ca3af';
    main.appendChild(link);

    if (rowMeta.isOverdue) {
      const c = document.createElement('span');
      c.textContent = 'overdue';
      c.title = 'Past due ' + t.due_date;
      c.style.cssText = 'display:inline-block;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.3px;padding:1px 6px;border-radius:8px;margin-left:6px;background:#fee2e2;color:#991b1b';
      main.appendChild(c);
    }
    if (rowMeta.isStale) {
      const c = document.createElement('span');
      c.textContent = rowMeta.ageDays + 'd';
      c.title = 'No update in ' + rowMeta.ageDays + ' days';
      c.style.cssText = 'display:inline-block;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.3px;padding:1px 6px;border-radius:8px;margin-left:6px;background:#fef3c7;color:#92400e';
      main.appendChild(c);
    }

    if (t.createdByName) {
      const from = document.createElement('div');
      from.style.cssText = 'font-size:11px;color:#6b7280;margin-top:2px';
      from.textContent = 'from ' + t.createdByName + (t.notes ? '  ·  ' + t.notes : '');
      main.appendChild(from);
    }
    head.appendChild(main);

    const due = document.createElement('span');
    due.style.cssText = 'font-size:12px;color:#6b7280;font-variant-numeric:tabular-nums';
    due.textContent = (t.due_date && t.due_date !== 'TBD') ? t.due_date : '';
    head.appendChild(due);

    const opn = document.createElement('a');
    opn.href = '/rm/pages/library-paper.html?id=' + encodeURIComponent(ref.paperId);
    opn.textContent = '→ open';
    opn.title = 'Open the paper viewer';
    opn.style.cssText = 'font-size:11px;color:#5b21b6;text-decoration:none;padding:2px 6px;border:1px solid #ddd6fe;border-radius:4px;background:#f5f3ff';
    head.appendChild(opn);

    // Spacer to align with the grid (matching the regular row's 4-col layout).
    head.appendChild(document.createElement('span'));

    wrap.appendChild(head);

    // Comments expander
    const det = document.createElement('details');
    det.style.cssText = 'margin-top:6px;padding-left:8px;border-left:2px solid #ede9fe';
    const sum = document.createElement('summary');
    const count = annotations.length;
    sum.textContent = annLoaded
      ? (count === 0 ? 'No comments yet' : 'Comments by assignee (' + count + ')')
      : 'Comments…';
    sum.style.cssText = 'font-size:11px;color:#6d28d9;cursor:pointer;list-style:none';
    det.appendChild(sum);

    if (count) {
      const list = document.createElement('div');
      list.style.cssText = 'margin-top:6px;display:grid;gap:6px';
      // Roots first, then replies threaded under their parent.
      const byParent = {};
      annotations.forEach(a => {
        const p = a.parent_id || '_root';
        (byParent[p] = byParent[p] || []).push(a);
      });
      function renderAnn(a, depth) {
        const card = document.createElement('div');
        card.style.cssText = 'background:#fafaf9;border:1px solid #e7e5e4;border-radius:6px;padding:6px 8px;font-size:12px;color:#1f2937;margin-left:' + (depth * 12) + 'px';
        const text = document.createElement('div');
        text.textContent = a.comment;
        text.style.whiteSpace = 'pre-wrap';
        card.appendChild(text);
        const meta = document.createElement('div');
        const pages = (a.target && a.target.pages) || [];
        const pageStr = pages.length ? 'p.' + pages.map(p => (p && p.page) || p).filter(Boolean).slice(0, 3).join(',') : '';
        const when = (a.modified && a.modified.toDate) ? a.modified.toDate().toISOString().slice(0, 10) :
                     (a.created  && a.created.toDate)  ? a.created.toDate().toISOString().slice(0, 10) : '';
        meta.style.cssText = 'font-size:10px;color:#9ca3af;margin-top:2px';
        meta.textContent = [pageStr, when].filter(Boolean).join('  ·  ');
        card.appendChild(meta);
        return card;
      }
      function emit(parentKey, depth) {
        (byParent[parentKey] || []).forEach(a => {
          list.appendChild(renderAnn(a, depth));
          emit(a.id, depth + 1);
        });
      }
      emit('_root', 0);
      det.appendChild(list);
    }
    wrap.appendChild(det);

    return wrap;
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
    const split = splitArchive(rows);
    split.active.forEach((row) => {
      const origIdx = rows.indexOf(row);
      tbody.appendChild(renderProjectRow(row, origIdx));
    });
    if (!split.active.length && !split.archived.length) {
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
    ICON.label(fillBtn, 'arrow-down-tray', ' Auto-fill from my projects');
    fillBtn.title = 'Pull projects where I am listed in members[] (papers/courses/infrastructure/tools)';
    fillBtn.onclick = autoFillProjectRows;
    actions.appendChild(fillBtn);

    block.appendChild(actions);

    // V3.190 — discussed/archived rows render in a collapsed table at the
    // bottom. Reuses renderProjectRow but wraps each in a single-row table
    // for grid alignment. Always rendered so the system is discoverable.
    block.appendChild(renderItemArchive('Discussed projects', split.archived, (row) => {
      const origIdx = rows.indexOf(row);
      const t = document.createElement('table');
      t.className = 'pmr-proj-table';
      const tb = document.createElement('tbody');
      tb.appendChild(renderProjectRow(row, origIdx));
      t.appendChild(tb);
      return t;
    }));

    // V3.157 — section-level conversation
    buildCommentToggle(block, 'project_overview', null, 'Project overview discussion');
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

    // Status note (V3.190 — also hosts the discussed toggle below)
    const noteTd = document.createElement('td');
    const noteIn = document.createElement('input');
    noteIn.type = 'text';
    noteIn.value = row.status_note || '';
    noteIn.placeholder = 'e.g. WEKA classifier converging';
    noteIn.addEventListener('input', () => { row.status_note = noteIn.value; scheduleSave(); });
    noteTd.appendChild(noteIn);
    const toggleWrap = document.createElement('div');
    toggleWrap.style.cssText = 'margin-top:4px';
    toggleWrap.appendChild(buildDiscussedToggle(row, () => { scheduleSave(); renderBody(); }));
    noteTd.appendChild(toggleWrap);
    tr.appendChild(noteTd);

    // Delete
    const delTd = document.createElement('td');
    const del = document.createElement('span');
    del.className = 'del';
    ICON.label(del, 'x-mark');
    del.style.cursor = 'pointer';
    del.style.color = '#dc2626';
    del.title = 'Remove row';
    del.onclick = () => {
      if (!confirm('Remove this project row?')) return;
      const targetIdx = (idx != null && idx >= 0) ? idx : state.doc.project_overview.indexOf(row);
      if (targetIdx >= 0) state.doc.project_overview.splice(targetIdx, 1);
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

    // V3.190 — split active vs archived (discussed). Active rows render
    // inline; archived rows live in a collapsed search-filtered section
    // at the bottom of the block.
    const split = splitArchive(state.doc.reference_links || []);
    const list = document.createElement('div');
    split.active.forEach((row, idx) => {
      // idx here is the active-list index; we need the original index in
      // reference_links[] for splice on delete. Find it.
      const origIdx = (state.doc.reference_links || []).indexOf(row);
      list.appendChild(renderRefRow(row, origIdx));
    });
    block.appendChild(list);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-top:6px;flex-wrap:wrap';
    const add = document.createElement('button');
    add.className = 'pmr-add-btn';
    add.textContent = '+ Add link';
    add.onclick = () => {
      state.doc.reference_links.push({ kind: 'notes', label: '', url: '', id: newId('ref') });
      scheduleSave();
      renderBody();
    };
    actions.appendChild(add);
    if (!isReadOnlyView()) {
      const auto = document.createElement('button');
      auto.className = 'pmr-add-btn';
      ICON.label(auto, 'arrow-down-tray', ' Auto-fill from my work');
      auto.title = 'Pull in notebook entries, protocols, paper drafts, past PMRs, and grant drafts you have created';
      auto.onclick = autoFillReferenceLinks;
      actions.appendChild(auto);
    }
    block.appendChild(actions);

    block.appendChild(renderItemArchive('Discussed reference links', split.archived, (row) => {
      const origIdx = (state.doc.reference_links || []).indexOf(row);
      return renderRefRow(row, origIdx);
    }));
    // V3.157 — section-level conversation
    buildCommentToggle(block, 'reference_links', null, 'Reference-links discussion');
    return block;
  }

  /* V3.190 — Pull all of the student's created artifacts into
   * reference_links[]. Dedup by URL so re-runs are idempotent. Sources:
   *   - Lab notebook entries (userData/{uid}/notebookIndex/index)
   *   - Protocols (protocols where authorUids array-contains uid)
   *   - Paper drafts (already loaded in state.paperDrafts)
   *   - Past PMR periods (state.indexDoc.periods, excluding current)
   *   - Grant drafts (grantDrafts where authorUids array-contains uid)
   * Owner-only (admin viewing a student doesn't auto-pull into the
   * student's PMR — they'd lose the choice of what to include).
   */
  async function autoFillReferenceLinks() {
    if (isReadOnlyView()) return;
    const uid = viewedUid();
    if (!uid || !state.doc) return;
    const existing = state.doc.reference_links || [];
    const seenUrls = new Set(existing.map(r => (r.url || '').trim()).filter(Boolean));
    const seenLabels = new Set(existing.map(r => (r.label || '').trim().toLowerCase()).filter(Boolean));
    const candidates = [];
    function pushCandidate(kind, label, url) {
      const u = (url || '').trim();
      const l = (label || '').trim();
      if (!u && !l) return;
      if (u && seenUrls.has(u)) return;
      if (!u && seenLabels.has(l.toLowerCase())) return;
      candidates.push({ id: newId('ref'), kind: kind, label: l, url: u });
      if (u) seenUrls.add(u);
      if (l) seenLabels.add(l.toLowerCase());
    }

    // 1. Notebook entries — load the per-user index.
    try {
      const nb = await firebridge.db().collection('userData').doc(uid)
        .collection('notebook').doc('_index').get();
      if (nb.exists) {
        const data = nb.data() || {};
        (data.entries || []).forEach(e => {
          const label = (e.title || e.id || 'Notebook entry') + (e.date ? ' (' + e.date + ')' : '');
          pushCandidate('notebook', label, '/rm/pages/notebook.html?entry=' + encodeURIComponent(e.id));
        });
      }
    } catch (err) { console.warn('[pmr] auto-fill notebook failed:', err && err.message); }

    // 2. Protocols where the user is in authorUids.
    try {
      const ps = await firebridge.db().collection('protocols')
        .where('authorUids', 'array-contains', uid).get();
      ps.forEach(d => {
        const data = d.data() || {};
        pushCandidate('protocol', data.title || '(untitled protocol)',
                      '/rm/pages/protocols.html?id=' + encodeURIComponent(d.id));
      });
    } catch (err) { console.warn('[pmr] auto-fill protocols failed:', err && err.message); }

    // 3. Paper drafts — already loaded into state.paperDrafts by loadPaperDraftsFor.
    (state.paperDrafts || []).forEach(p => {
      pushCandidate('other', 'Paper: ' + p.title,
                    '/rm/pages/paper-builder.html?id=' + encodeURIComponent(p.id));
    });

    // 4. Past PMR periods (excluding the current one).
    ((state.indexDoc && state.indexDoc.periods) || []).forEach(p => {
      if (!p || !p.id || p.id === state.currentPeriodId) return;
      pushCandidate('past_pmr', p.label || p.id,
                    '/rm/pages/pmr.html?period=' + encodeURIComponent(p.id));
    });

    // 5. Grant drafts (V3.179 — grantDrafts collection).
    try {
      const gs = await firebridge.db().collection('grantDrafts')
        .where('authorUids', 'array-contains', uid).get();
      gs.forEach(d => {
        const data = d.data() || {};
        pushCandidate('fellowship', 'Grant: ' + (data.title || '(untitled grant)'),
                      '/rm/pages/grant-builder.html?grant=' + encodeURIComponent(d.id));
      });
    } catch (err) { /* grants collection may not exist yet — silent */ }

    if (!candidates.length) {
      alert('No new references found — your notebook/protocols/papers/PMRs/grants are already linked.');
      return;
    }
    state.doc.reference_links = (state.doc.reference_links || []).concat(candidates);
    scheduleSave();
    renderBody();
    if (window.TOAST) TOAST.success('Auto-imported ' + candidates.length + ' reference' + (candidates.length === 1 ? '' : 's'), { ttl: 2500 });
  }

  function renderRefRow(row, idx) {
    const outer = document.createElement('div');
    outer.style.cssText = 'display:grid;gap:2px;margin-bottom:6px';
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
    ICON.label(del, 'x-mark');
    del.title = 'Remove';
    del.onclick = () => {
      // V3.190 — idx is from the original reference_links[] (not from the
      // split active/archive view), so splice still hits the right row.
      const targetIdx = (idx != null && idx >= 0) ? idx : state.doc.reference_links.indexOf(row);
      if (targetIdx >= 0) state.doc.reference_links.splice(targetIdx, 1);
      scheduleSave();
      renderBody();
    };
    div.appendChild(sel);
    div.appendChild(lbl);
    div.appendChild(url);
    div.appendChild(del);
    outer.appendChild(div);

    // V3.190 — discussed toggle in a small footer row.
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;padding-right:36px';
    footer.appendChild(buildDiscussedToggle(row, () => { scheduleSave(); renderBody(); }));
    outer.appendChild(footer);
    return outer;
  }

  /* ── Block: Weekly focus review (V3.541) ─────────────────────
   * Derived, read-only rollup of the mentor↔mentee weekly focus loop
   * (userData/{uid}/focusAreas via window.FOCUS_AREAS). Grouped by week
   * with month subheads, so it serves the weekly 1:1 AND the monthly
   * review in one block. Source of truth stays the focus docs — edits
   * happen on Team Focus / My Week; here the PI and student review
   * expectations vs outcomes (with linked notebook entries carrying the
   * narrative). Exempt from scheduleSave. */
  function renderFocusReviewBlock() {
    const block = document.createElement('section');
    block.className = 'pmr-block';
    block.innerHTML = '<h2>Weekly focus review <span class="pmr-help">mentor-agreed focus areas vs outcomes — weekly + monthly</span></h2>';
    const host = document.createElement('div');
    host.className = 'pmr-focus-review';
    host.innerHTML = '<div style="color:#9ca3af;font-size:13px">Loading focus areas…</div>';
    block.appendChild(host);
    buildCommentToggle(block, 'focus_review', null, 'Weekly focus discussion');

    (async () => {
      try {
        if (!window.FOCUS_AREAS) { host.innerHTML = ''; return; }
        const uid = viewedUid();
        // Week range from the period's weekly entries; fallback = the
        // last 12 weeks up to the current one.
        const weeks = (state.doc && state.doc.weekly_entries) || [];
        let fromWk = null, toWk = null;
        weeks.forEach(wk => {
          if (wk.date_range_start) {
            const w = FOCUS_AREAS.weekIdFor(wk.date_range_start);
            if (!fromWk || w < fromWk) fromWk = w;
            if (!toWk || w > toWk) toWk = w;
          }
        });
        const nowWk = FOCUS_AREAS.weekIdFor();
        if (!fromWk) fromWk = FOCUS_AREAS.weekIdForOffset(-12);
        if (!toWk || toWk < nowWk) toWk = nowWk;

        const focuses = await FOCUS_AREAS.listForRange(uid, fromWk, toWk);
        if (!focuses.length) {
          host.innerHTML = '<div style="color:#9ca3af;font-size:13px">No focus areas in this period yet — set them up on <a href="/rm/pages/team-focus.html?uid=' + encodeURIComponent(uid) + '">Team Focus</a>.</div>';
          return;
        }

        // V3.550 — optional group-by-research-focus view. Focus areas carry
        // focus_ref {id,title} (the researchFoci card they advance); when any
        // do, offer a toggle that buckets the period's weeks under each
        // research thrust instead of chronologically.
        const hasRefs = focuses.some(f => f.focus_ref && f.focus_ref.id);
        let groupByThrust = false;
        const renderBody = () => {
          const toggle = hasRefs
            ? '<div class="pmr-fr-toggle"><label><input type="checkbox" data-fr-group' + (groupByThrust ? ' checked' : '') + '> group by research focus</label></div>'
            : '';
          host.innerHTML = toggle + (groupByThrust ? renderByThrust() : renderByWeek());
          const cb = host.querySelector('[data-fr-group]');
          if (cb) cb.addEventListener('change', () => { groupByThrust = cb.checked; renderBody(); });
        };

        const focusCard = f => {
          const meta = FOCUS_AREAS.STATUS_META[f.status] || {};
          const om = f.report ? (FOCUS_AREAS.OUTCOME_META[f.report.outcome] || {}) : null;
          const tasks = f.tasks || [];
          const done = tasks.filter(t => t.done).length;
          return '<div class="pmr-fr-card">' +
            '<div class="pmr-fr-head">' +
              '<span class="pmr-fr-title">' + ICON.svg('target') + ' ' + escHTML(f.title) + '</span>' +
              '<span class="pmr-fr-chip" style="color:' + meta.color + ';background:' + meta.bg + '">' + escHTML(meta.label || f.status) + '</span>' +
              (om ? '<span class="pmr-fr-outcome">' + ICON.render(om.icon) + ' ' + escHTML(om.label || '') + '</span>' : '') +
              (tasks.length ? '<span class="pmr-fr-tasks">' + done + '/' + tasks.length + ' tasks</span>' : '') +
              /* V3.602 — grouped by thrust the card name is already the
               * group head, so the chip narrows to the analysis alone;
               * ungrouped it shows the full "card › analysis" path. */
              (f.focus_ref && (!groupByThrust || f.focus_ref.analysis_title)
                ? '<a class="pmr-fr-nb" href="/rm/pages/research.html?id=' + encodeURIComponent(f.focus_ref.id) +
                    (f.focus_ref.analysis_id ? '#rmap-' + f.focus_ref.analysis_id : '') + '">' + ICON.svg('target') + ' ' +
                    escHTML(groupByThrust
                      ? f.focus_ref.analysis_title
                      : (FOCUS_AREAS.focusRefLabel ? FOCUS_AREAS.focusRefLabel(f.focus_ref) : f.focus_ref.title)) +
                  '</a>'
                : '') +
            '</div>' +
            (f.description ? '<div class="pmr-fr-desc">' + escHTML(f.description) + '</div>' : '') +
            ((f.paper_refs || []).map(r =>
              '<a class="pmr-fr-nb" href="/rm/pages/paper-builder.html?id=' + encodeURIComponent(r.id) + '">' + ICON.svg('pencil-square') + ' ' + escHTML(r.title) + '</a>').join(' ')) +
            (f.report && f.report.summary ? '<div class="pmr-fr-summary">' + escHTML(f.report.summary) + '</div>' : '') +
            ((f.report && f.report.notebook_entry_ids || []).map(id =>
              '<a class="pmr-fr-nb" href="/rm/pages/notebook.html?entry=' + encodeURIComponent(id) + '">' + ICON.svg('book-open') + ' notebook entry</a>').join(' ')) +
          '</div>';
        };

        const renderByThrust = () => {
          const byRef = {};
          focuses.forEach(f => {
            const key = (f.focus_ref && f.focus_ref.id) || '__none__';
            (byRef[key] = byRef[key] || { ref: f.focus_ref, rows: [] }).rows.push(f);
          });
          const keys = Object.keys(byRef).sort((a, b) => (a === '__none__') - (b === '__none__'));
          return keys.map(k => {
            const g = byRef[k];
            const head = g.ref
              ? '<a href="/rm/pages/research.html?id=' + encodeURIComponent(g.ref.id) + '">' + ICON.svg('target') + ' ' + escHTML(g.ref.title) + '</a>'
              : 'Not aligned with a research focus';
            const rows = g.rows.sort((a, b) => (b.weekId || '').localeCompare(a.weekId || ''))
              .map(f => '<div class="pmr-fr-weekhead">Week ' + escHTML(f.weekId) + '</div>' + focusCard(f)).join('');
            return '<div class="pmr-fr-week"><div class="pmr-fr-thrust">' + head + '</div>' + rows + '</div>';
          }).join('');
        };

        const renderByWeek = () => {
        // Group by weekId (desc — most recent first), month subheads.
        const byWeek = {};
        focuses.forEach(f => { (byWeek[f.weekId] = byWeek[f.weekId] || []).push(f); });
        const weekIds = Object.keys(byWeek).sort().reverse();
        let lastMonth = null;
        return weekIds.map(wid => {
          // Monday of the ISO week → month label for the monthly rollup.
          const m = wid.match(/^(\d{4})-W(\d{2})$/);
          let monthHead = '';
          if (m) {
            const jan4 = new Date(Date.UTC(+m[1], 0, 4));
            const mon = new Date(jan4.getTime());
            mon.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (+m[2] - 1) * 7);
            const label = mon.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
            if (label !== lastMonth) { lastMonth = label; monthHead = '<div class="pmr-fr-month">' + escHTML(label) + '</div>'; }
          }
          const cards = byWeek[wid].map(focusCard).join('');
          return monthHead + '<div class="pmr-fr-week"><div class="pmr-fr-weekhead">Week ' + escHTML(wid) + '</div>' + cards + '</div>';
        }).join('');
        };

        renderBody();
      } catch (err) {
        console.warn('[pmr] focus review load failed:', err && err.message);
        host.innerHTML = '<div style="color:#9ca3af;font-size:13px">Focus areas unavailable.</div>';
      }
    })();

    return block;
  }

  /* ── Block: My projects — health header (V3.625) ───────────── */
  /* Derived from the outcome ledger by project-health.js: traffic-light
   * status + trend + a human "why" per researchFoci project the student
   * is attached to. Replaces the hand-set project_overview status pill.
   * The only stored piece is the student's one-line description
   * (doc.project_health); mentors act through ✔ Accept on barriers. */

  let _healthCache = { key: null, rows: null };

  function canAcceptBarriers() {
    // A reviewer looking at someone else's PMR: the PI (admin) or one of
    // the student's assigned mentors. Never the student on their own doc.
    return isReadOnlyView() &&
      (state.isAdmin || state.menteeUids.has(viewedUid()));
  }

  async function loadProjectHealth(force) {
    if (!window.PROJECT_HEALTH || !window.FOCUS_AREAS) return null;
    const uid = viewedUid();
    const key = uid + '|' + todayStr();
    if (!force && _healthCache.key === key && _healthCache.rows) return _healthCache.rows;
    const mondays = PROJECT_HEALTH.windowMondays();
    const from = mondays[0], to = shiftDateStr(mondays[mondays.length - 1], 6);
    const [itemsSnap, reviewsSnap, focusAreas] = await Promise.all([
      dayPlansCollRef(uid).where('date', '>=', from).where('date', '<=', to).get(),
      healthReviewsCollRef(uid).get(),
      FOCUS_AREAS.listForRange(uid, FOCUS_AREAS.weekIdFor(from), FOCUS_AREAS.weekIdFor(to)),
    ]);
    const items = itemsSnap.docs.filter(d => d.id !== '_prefs')
      .map(d => Object.assign({ id: d.id }, d.data()))
      .filter(it => it.status !== 'cancelled');
    const reviews = reviewsSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));
    const projects = await PROJECT_HEALTH.listProjectsForStudent(uid, focusAreas);
    const rows = PROJECT_HEALTH.compute({
      projects, items, focusAreas, reviews,
      weekIdFor: FOCUS_AREAS.weekIdFor,
    });
    _healthCache = { key, rows };
    return rows;
  }

  function projectDescRow(fociId) {
    const list = (state.doc && state.doc.project_health) || [];
    return list.find(r => r && r.foci_id === fociId) || null;
  }

  function renderProjectHealthBlock() {
    const block = document.createElement('section');
    block.className = 'pmr-block';
    block.innerHTML = '<h2>My projects <span class="pmr-help">health per project, derived from your My Week outcomes — barriers escalate until a mentor accepts the reason</span></h2>';
    const host = document.createElement('div');
    host.className = 'pmr-ph';
    host.innerHTML = '<div style="color:#9ca3af;font-size:13px">Scoring projects…</div>';
    block.appendChild(host);
    buildCommentToggle(block, 'project_health', null, 'Projects discussion');

    const paint = (rows) => {
      if (!rows) { host.innerHTML = ''; return; }
      if (!rows.length) {
        host.innerHTML = '<div style="color:#9ca3af;font-size:13px">No projects attached yet — ' +
          'projects come from the <a href="/rm/pages/research.html">research roadmap</a> ' +
          '(cards you\'re a member of, analyses you own) and from aligning your weekly focus (' + ICON.svg('target') + ') to one.</div>';
        return;
      }
      host.innerHTML = '';
      rows.forEach(ph => {
        const meta = PROJECT_HEALTH.STATUS_META[ph.status] || {};
        const trend = PROJECT_HEALTH.TREND_META[ph.trend] || {};
        const card = document.createElement('div');
        card.className = 'pmr-ph-card';
        const descRow = projectDescRow(ph.id);
        const strip = ph.weeks.map(w =>
          '<span class="pmr-ph-wk" title="Week of ' + escHTML(w.monday) + (w.score ? ' · score ' + w.score.toFixed(1) : '') + '">' +
          ICON.render(w.icon) + '</span>').join('');
        const openBarriers = ph.barrierRows.filter(r => !r.accepted);
        card.innerHTML =
          '<div class="pmr-ph-head">' +
            '<span class="pmr-ph-dot ' + escHTML(ph.status) + '" title="' + escHTML(meta.label || ph.status) + '"></span>' +
            '<a class="pmr-ph-title" href="/rm/pages/research.html?id=' + encodeURIComponent(ph.id) + '">' +
              (ph.icon ? ICON.render(ph.icon) + ' ' : '') + escHTML(ph.title) + '</a>' +
            '<span class="pmr-ph-trend" title="' + escHTML(trend.label || '') + '">' + (trend.icon || '') + '</span>' +
            (openBarriers.length ? '<span class="pmr-lg-chip pmr-lg-oc-barrier">' + ICON.svg('construction') + ' ' + openBarriers.length + ' open</span>' : '') +
            '<span class="pmr-ph-why">' + escHTML(ph.why) + '</span>' +
          '</div>' +
          '<div class="pmr-ph-strip">' + strip + '</div>';

        // student-editable one-liner (owner only)
        const desc = document.createElement('input');
        desc.className = 'pmr-ph-desc';
        desc.placeholder = 'One line: what this project is / where it stands…';
        desc.value = (descRow && descRow.description) || '';
        desc.readOnly = isReadOnlyView();
        desc.addEventListener('input', () => {
          if (isReadOnlyView()) return;
          let row = projectDescRow(ph.id);
          if (!row) {
            row = { foci_id: ph.id, description: '' };
            state.doc.project_health.push(row);
          }
          row.description = desc.value;
          scheduleSave();
        });
        card.appendChild(desc);

        // expandable barrier history (the actionable ledger slice)
        if (ph.barrierRows.length) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'pmr-ph-expand';
          btn.textContent = '▸ barriers (' + ph.barrierRows.length + ')';
          const detail = document.createElement('div');
          detail.className = 'pmr-ph-detail';
          detail.style.display = 'none';
          btn.addEventListener('click', () => {
            const open = detail.style.display !== 'none';
            detail.style.display = open ? 'none' : '';
            ICON.label(btn, open ? 'chevron-right' : 'chevron-down', ' barriers (' + ph.barrierRows.length + ')');
          });
          ph.barrierRows.forEach(row => {
            const it = row.item;
            const line = document.createElement('div');
            line.className = 'pmr-lg-item';
            const summary = (it.outcome && it.outcome.summary) || '';
            line.innerHTML =
              '<span class="pmr-lg-icon">' + ICON.svg('construction') + '</span>' +
              '<div class="pmr-lg-main">' +
                '<div class="pmr-lg-title">' + escHTML(it.title || '(untitled)') +
                  '<span class="pmr-lg-day">week of ' + escHTML(weekRangeLabel(row.monday)) + '</span></div>' +
                (summary ? '<div class="pmr-lg-outcome pmr-lg-oc-barrier">' + escHTML(summary) + '</div>' : '') +
              '</div>';
            const slot = document.createElement('span');
            if (row.accepted) {
              slot.className = 'pmr-ph-accepted';
              ICON.label(slot, 'check', ' accepted by ' + ((row.review && row.review.reviewer_name) || 'mentor') +
                ((row.review && row.review.note) ? ' — ' + row.review.note : ''));
              slot.title = 'This barrier no longer counts against health.';
            } else if (canAcceptBarriers()) {
              const accept = document.createElement('button');
              accept.type = 'button';
              accept.className = 'pmr-ph-accept';
              ICON.label(accept, 'check', ' Accept reason');
              accept.title = 'Mark this barrier\'s reason as acceptable — resets its drag on project health';
              accept.addEventListener('click', async () => {
                const note = window.prompt('Why is this barrier acceptable? (the student sees this note)', '');
                if (note === null) return;
                accept.disabled = true;
                try {
                  const id = newId('hr');
                  await healthReviewsCollRef(viewedUid()).doc(id).set({
                    id: id,
                    item_id: it.id,
                    foci_id: ph.id,
                    note: String(note || ''),
                    reviewer_uid: state.user.uid,
                    reviewer_name: (state.labMembersByUid[state.user.uid] || {}).name || state.user.displayName || state.user.email || '',
                    week_monday: row.monday,
                    created_at: isoNow(),
                  });
                  if (window.TOAST) TOAST.success('Barrier accepted — health recalculated.');
                  paint(await loadProjectHealth(true));
                } catch (err) {
                  accept.disabled = false;
                  alert('Could not record the acceptance: ' + (err && err.message));
                }
              });
              slot.appendChild(accept);
            }
            line.appendChild(slot);
            detail.appendChild(line);
          });
          card.appendChild(btn);
          card.appendChild(detail);
        }
        host.appendChild(card);
      });
    };

    (async () => {
      try {
        paint(await loadProjectHealth());
      } catch (err) {
        console.warn('[pmr] project health load failed:', err && err.message);
        host.innerHTML = '<div style="color:#9ca3af;font-size:13px">Project health unavailable' +
          (isReadOnlyView() ? ' — visible to the student, their mentors, and admins.' : '.') + '</div>';
      }
    })();

    return block;
  }

  /* ── Block: My Week ledger (V3.624) ─────────────────────────── */
  /* Derived + read-only: every My Week plan in the period and what came of
   * it (outcome, V3.623), grouped by week. Nothing here writes into the
   * PMR doc — the curated weekly entries stay human; this is the factual
   * record beside them. Cross-user via dayPlansCollRef (rules V3.624). */
  function renderMyWeekLedgerBlock() {
    const block = document.createElement('section');
    block.className = 'pmr-block';
    block.innerHTML = '<h2>My Week ledger <span class="pmr-help">every plan and what came of it — recorded on My Week, reported here</span>' +
      '<button type="button" class="pmr-lg-refresh" title="Reload plans">' + ICON.svg('arrow-path') + '</button></h2>';
    const host = document.createElement('div');
    host.className = 'pmr-ledger';
    host.innerHTML = '<div style="color:#9ca3af;font-size:13px">Loading My Week plans…</div>';
    block.appendChild(host);
    buildCommentToggle(block, 'myday_ledger', null, 'My Week ledger discussion');

    const outcomeLine = (it) => {
      if (it.outcome && MYDAY_OUTCOME_META[it.outcome.kind]) {
        const om = MYDAY_OUTCOME_META[it.outcome.kind];
        const img = (it.outcome.image && it.outcome.image.download_url)
          ? ' <a class="pmr-lg-img" href="' + escHTML(it.outcome.image.download_url) + '" target="_blank" rel="noopener">' + ICON.svg('photo') + ' image</a>' : '';
        const nbs = (it.outcome.notebook_entry_ids || []).map(id =>
          ' <a class="pmr-lg-img" href="/rm/pages/notebook.html?entry=' + encodeURIComponent(id) + '">' + ICON.svg('book-open') + ' notebook</a>').join('');
        // V3.853 — the cards the result points at (figure board / notebook), deep-linked to the card
        const lks = (Array.isArray(it.outcome.links) ? it.outcome.links : []).filter(l => l && l.url).map(l => {
          const fb = /^figure_board/.test(l.kind || ''), nb = l.kind === 'notebook_item';
          const where = fb ? 'figure board' : nb ? 'notebook' : '';
          const label = (where ? where + (l.boardTitle ? ' · ' + l.boardTitle : '') + (l.title ? ': ' + l.title : '') : (l.title || 'link'));
          const thumb = l.thumb ? '<img class="pmr-lg-thumb" src="' + escHTML(l.thumb) + '" alt="" loading="lazy"> ' : '';
          return ' <a class="pmr-lg-img" href="' + escHTML(l.url) + '" target="_blank" rel="noopener">' + thumb + ICON.svg(fb ? 'chart-bar' : nb ? 'book-open' : 'link') + ' ' + escHTML(label) + '</a>';
        }).join('');
        const fu = it.outcome.follow_up_item_id ? ' <span class="pmr-lg-fu" title="Follow-up planned next week">' + ICON.svg('arrow-path') + ' follow-up planned</span>' : '';
        return '<div class="pmr-lg-outcome pmr-lg-oc-' + escHTML(it.outcome.kind) + '">' +
          ICON.render(om.icon) + ' ' + om.label +
          (it.outcome.summary ? ' — ' + escHTML(it.outcome.summary) : '') +
          lks + img + nbs + fu + '</div>';
      }
      if (isUnaccounted(it)) {
        const why = it.status === 'planned' ? 'never confirmed' : (it.status + ', no result recorded');
        return '<div class="pmr-lg-outcome pmr-lg-oc-missing">◇ unaccounted — ' + escHTML(why) + '</div>';
      }
      if (it.status === 'done') return '<div class="pmr-lg-outcome">✓ done</div>';
      if (it.status === 'skipped') return '<div class="pmr-lg-outcome">✗ skipped</div>';
      return ''; // upcoming planned item — the plan line is enough
    };

    const itemRow = (it) => {
      const det = it.details || {};
      const bits = [];
      if (it.follow_up_of) bits.push('<span class="pmr-lg-fu" title="Follows up an earlier step">' + ICON.svg('arrow-path') + '</span>');
      if (det.focusTitle) bits.push(ICON.svg('target') + ' ' + escHTML(det.focusTitle));
      const dayName = it.date ? new Date(it.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' }) : '';
      return '<div class="pmr-lg-item' + (isUnaccounted(it) ? ' pmr-lg-missing' : '') + '">' +
        '<span class="pmr-lg-icon">' + (MYDAY_TYPE_ICONS[it.type] ? ICON.render(MYDAY_TYPE_ICONS[it.type]) : '•') + '</span>' +
        '<div class="pmr-lg-main">' +
          '<div class="pmr-lg-title">' + escHTML(it.title || '(untitled)') +
            '<span class="pmr-lg-day">' + escHTML(dayName) + '</span>' +
            (bits.length ? '<span class="pmr-lg-bits">' + bits.join(' · ') + '</span>' : '') +
          '</div>' +
          outcomeLine(it) +
        '</div>' +
      '</div>';
    };

    const weekHtml = (mon, items, activeDays) => {
      const counts = { result: 0, barrier: 0, no_result: 0, missing: 0, upcoming: 0 };
      items.forEach(it => {
        if (it.outcome && counts[it.outcome.kind] != null) counts[it.outcome.kind]++;
        else if (isUnaccounted(it)) counts.missing++;
        else if (it.status === 'planned') counts.upcoming++;
      });
      // V3.626 — 7 presence dots (Mon→Sun): which days actually saw work,
      // from the same tracker events the Activity block renders.
      let presence = '';
      if (activeDays) {
        const today = todayStr();
        presence = '<span class="pmr-lg-presence" title="Days with recorded activity">' +
          [0, 1, 2, 3, 4, 5, 6].map(i => {
            const d = shiftDateStr(mon, i);
            const cls = activeDays.has(d) ? ' on' : (d > today ? ' future' : '');
            return '<span class="pmr-lg-pd' + cls + '" title="' + escHTML(d) + (activeDays.has(d) ? ' — active' : '') + '"></span>';
          }).join('') + '</span>';
      }
      const chips =
        (counts.result ? '<span class="pmr-lg-chip pmr-lg-oc-result">' + ICON.svg('check-circle') + ' ' + counts.result + '</span>' : '') +
        (counts.barrier ? '<span class="pmr-lg-chip pmr-lg-oc-barrier">' + ICON.svg('construction') + ' ' + counts.barrier + '</span>' : '') +
        (counts.no_result ? '<span class="pmr-lg-chip">◌ ' + counts.no_result + '</span>' : '') +
        (counts.missing ? '<span class="pmr-lg-chip pmr-lg-oc-missing">◇ ' + counts.missing + '</span>' : '') +
        (counts.upcoming ? '<span class="pmr-lg-chip">' + ICON.svg('calendar-days') + ' ' + counts.upcoming + ' planned</span>' : '');
      const ownerLink = !isReadOnlyView()
        ? '<a class="pmr-lg-golink" href="/rm/pages/my-week.html?date=' + encodeURIComponent(mon) + '&view=week">My Week →</a>'
        : '';
      return '<div class="pmr-lg-week">' +
        '<div class="pmr-lg-weekhead"><span class="pmr-lg-range">Week of ' + escHTML(weekRangeLabel(mon)) + '</span>' +
          presence + chips + ownerLink + '</div>' +
        items.map(itemRow).join('') +
      '</div>';
    };

    const paint = (rows, activeDays) => {
      if (!rows.length) {
        host.innerHTML = '<div style="color:#9ca3af;font-size:13px">No My Week plans in this period yet' +
          (!isReadOnlyView() ? ' — plan your steps on <a href="/rm/pages/my-week.html">My Week</a> and they report here automatically.' : '.') +
          '</div>';
        return;
      }
      const byWeek = {};
      rows.forEach(it => { const wk = mondayStr(it.date); (byWeek[wk] = byWeek[wk] || []).push(it); });
      const weekKeys = Object.keys(byWeek).sort().reverse();
      let showAll = false;
      const draw = () => {
        const keys = showAll ? weekKeys : weekKeys.slice(0, 12);
        host.innerHTML = keys.map(k => weekHtml(k, byWeek[k], activeDays)).join('') +
          (weekKeys.length > 12 && !showAll
            ? '<button type="button" class="pmr-lg-more">Show all ' + weekKeys.length + ' weeks</button>' : '');
        const more = host.querySelector('.pmr-lg-more');
        if (more) more.addEventListener('click', () => { showAll = true; draw(); });
      };
      draw();
    };

    (async () => {
      try {
        const [rows, entries] = await Promise.all([
          loadDayPlansForPeriod(),
          ensureActivityForPeriod().catch(() => []),   // presence is best-effort
        ]);
        paint(rows, activeDaySet(entries));
      } catch (err) {
        console.warn('[pmr] My Week ledger load failed:', err && err.message);
        host.innerHTML = '<div style="color:#9ca3af;font-size:13px">My Week plans unavailable' +
          (isReadOnlyView() ? ' — visible to the student, their mentors, and admins.' : '.') + '</div>';
      }
    })();

    const refreshBtn = block.querySelector('.pmr-lg-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', async () => {
      host.innerHTML = '<div style="color:#9ca3af;font-size:13px">Reloading…</div>';
      try {
        const rows = await loadDayPlansForPeriod(true);
        const entries = await ensureActivityForPeriod().catch(() => []);
        paint(rows, activeDaySet(entries));
      }
      catch (_) { host.innerHTML = '<div style="color:#9ca3af;font-size:13px">My Week plans unavailable.</div>'; }
    });

    return block;
  }

  /* ── Block: Weekly entries ─────────────────────────────────── */
  function renderWeeklyEntriesBlock() {
    const block = document.createElement('section');
    block.className = 'pmr-block';
    block.innerHTML = '<h2>Weekly entries <span class="pmr-help">date-ranged log of experimental updates, reading, sidequests</span></h2>';

    const weeks = state.doc.weekly_entries || [];
    const split = splitArchive(weeks);
    split.active.forEach((wk) => {
      const origIdx = weeks.indexOf(wk);
      block.appendChild(renderWeek(wk, origIdx));
    });

    const add = document.createElement('button');
    add.className = 'pmr-add-btn';
    add.textContent = '+ Add week';
    add.onclick = () => addWeek();
    block.appendChild(add);

    block.appendChild(renderItemArchive('Discussed weeks', split.archived, (wk) => {
      const origIdx = weeks.indexOf(wk);
      return renderWeek(wk, origIdx);
    }));
    // V3.157 — section-level conversation
    buildCommentToggle(block, 'weekly_entries', null, 'Weekly entries discussion');
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

    // V3.190 — discussed toggle in the week header.
    head.appendChild(buildDiscussedToggle(wk, () => { scheduleSave(); renderBody(); }));

    // V3.532 — assemble the week from what the student already did
    // (notebook entries, tracker events, done subtasks, My Week plans).
    // Owner-only: the reviewer view is read-only anyway.
    if (!isReadOnlyView() && window.PMR_WEEK_ASSEMBLE) {
      const asm = document.createElement('button');
      asm.className = 'pmr-add-btn';
      ICON.label(asm, 'arrow-down-tray', ' Assemble');
      asm.title = 'Pull this week’s notebook entries, tracker events, completed tasks and My Week plans into the week';
      asm.onclick = () => PMR_WEEK_ASSEMBLE.open(wk, state.doc, {
        onInsert: (picked) => {
          wk.subsections = (wk.subsections && wk.subsections.length)
            ? wk.subsections : [{ name: 'Experimental update', items: [] }];
          picked.forEach(({ bySubsection, item }) => {
            let dest = wk.subsections.find(s => (s.name || '') === bySubsection);
            if (!dest) {
              dest = wk.subsections.find(s => (s.name || '').toLowerCase().includes(
                bySubsection === 'Reading/Writing' ? 'read' : 'experiment')) || wk.subsections[0];
            }
            dest.items = dest.items || [];
            dest.items.push(item);
          });
          scheduleSave();
          renderBody();
          if (window.TOAST) TOAST.success(picked.length + ' item' + (picked.length === 1 ? '' : 's') + ' added to the week');
        },
      });
      head.appendChild(asm);
    }

    const del = document.createElement('span');
    del.className = 'del'; del.textContent = '✕'; del.title = 'Remove week';
    del.onclick = () => {
      if (!confirm('Remove this week?')) return;
      const targetIdx = (idx != null && idx >= 0) ? idx : state.doc.weekly_entries.indexOf(wk);
      if (targetIdx >= 0) state.doc.weekly_entries.splice(targetIdx, 1);
      scheduleSave();
      renderBody();
    };
    head.appendChild(del);
    div.appendChild(head);

    // V3.532 — the student's 2-sentence narrative on top of the assembled
    // items ("Summarize my week"). Schema-additive: old week objects
    // simply have no `summary`.
    const summary = document.createElement('textarea');
    summary.className = 'pmr-week-summary';
    summary.placeholder = 'Summarize my week — the 2-sentence story above the items…';
    summary.value = wk.summary || '';
    summary.rows = 2;
    summary.style.cssText = 'width:100%;margin:4px 0 8px;padding:6px 8px;border:1px solid var(--border,#e1e4e8);border-radius:8px;font:inherit;font-size:.9em;background:transparent;color:inherit;resize:vertical';
    summary.readOnly = isReadOnlyView();
    summary.addEventListener('input', () => { wk.summary = summary.value; scheduleSave(); });
    div.appendChild(summary);

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
    // V3.517 — read-only lab-notebook entries dated within this week,
    // surfaced for the owner + PMR reviewers (PI / mentors).
    const nbBlock = renderWeekNotebook(wk);
    if (nbBlock) div.appendChild(nbBlock);
    // V3.157 — per-week comment thread (so admin/student can talk about a
    // specific week's progress, not just the section as a whole).
    buildCommentToggle(div, 'weekly_entries', wk.id, 'Discussion for week ' + (wk.date_range_start || ''));
    return div;
  }

  /* ── V3.517: read-only lab-notebook entries under a week ─────────
   * The notebook is the source of truth, so this is a cross-reference
   * only — never editable PMR content (exempt from scheduleSave). Shown
   * to the owner and to PMR reviewers (admin/mentors via the V3.517
   * notebook read rule). Hidden entirely when the week has no entries. */
  function renderWeekNotebook(wk) {
    const rows = notebookEntriesForWeek(wk);
    if (!rows.length) return null;
    const wrap = document.createElement('div');
    wrap.className = 'pmr-week-notebook';
    const head = document.createElement('div');
    head.className = 'pmr-wn-head';
    ICON.label(head, 'book-open', ' Lab notebook (' + rows.length + ')');
    wrap.appendChild(head);
    rows.forEach(row => wrap.appendChild(renderWeekNotebookRow(row)));
    return wrap;
  }

  function renderWeekNotebookRow(row) {
    const item = document.createElement('div');
    item.className = 'pmr-wn-item';

    const header = document.createElement('div');
    header.className = 'pmr-wn-row';

    const twist = document.createElement('span');
    twist.className = 'pmr-wn-twist';
    ICON.label(twist, 'chevron-right');
    header.appendChild(twist);

    const title = document.createElement('span');
    title.className = 'pmr-wn-title';
    title.textContent = row.title || row.id || 'Untitled entry';
    header.appendChild(title);

    const date = document.createElement('span');
    date.className = 'pmr-wn-date';
    date.textContent = row.date || '';
    header.appendChild(date);

    const pillText = row.phase || row.status;
    if (pillText) {
      const pill = document.createElement('span');
      pill.className = 'pmr-wn-pill s-' + pillText;
      pill.textContent = pillText;
      header.appendChild(pill);
    }

    // Owner only: a shortcut into the full notebook page. Omitted for
    // reviewers because lab-notebook.html is uid-scoped to the signed-in
    // user (it would open the reviewer's own notebook, not the student's).
    if (!isReadOnlyView()) {
      const open = document.createElement('a');
      open.className = 'pmr-wn-open';
      open.href = '/rm/pages/notebook.html?entry=' + encodeURIComponent(row.id);
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = 'open ↗';
      open.title = 'Open in lab notebook';
      open.addEventListener('click', ev => ev.stopPropagation());
      header.appendChild(open);
    }
    item.appendChild(header);

    const body = document.createElement('div');
    body.className = 'pmr-wn-body';
    body.style.display = 'none';
    item.appendChild(body);

    let loaded = false;
    header.addEventListener('click', async () => {
      const isOpen = body.style.display !== 'none';
      if (isOpen) { body.style.display = 'none'; twist.textContent = '▸'; return; }
      body.style.display = '';
      ICON.label(twist, 'chevron-down');
      if (loaded) return;
      loaded = true;
      body.innerHTML = '<div class="pmr-empty" style="padding:6px">Loading…</div>';
      try {
        const full = await loadNotebookEntry(row.id);
        renderNotebookEntryBody(body, full);
      } catch (err) {
        loaded = false; // allow retry on next expand
        body.innerHTML = '<div class="pmr-empty" style="padding:6px;color:#991b1b">Could not load entry: '
          + escapeHtml((err && err.message) || 'error') + '</div>';
      }
    });
    return item;
  }

  /* Render one entry's content read-only. body_html is already sanitized on
   * the notebook side (images are tokenized Storage download URLs, so they
   * render for reviewers too), so we inject it directly — the same trusted-
   * render pattern PMR uses for barrier descriptions. */
  function renderNotebookEntryBody(container, entry) {
    container.innerHTML = '';
    if (entry && entry.summary) {
      const sum = document.createElement('div');
      sum.className = 'pmr-wn-summary';
      sum.textContent = entry.summary;
      container.appendChild(sum);
    }
    const rich = document.createElement('div');
    rich.className = 'pmr-wn-rich';
    if (entry && entry.body_html) {
      rich.innerHTML = entry.body_html;
    } else if (entry && entry.body_text) {
      rich.textContent = entry.body_text;
    } else {
      rich.innerHTML = '<div class="pmr-empty" style="padding:6px">(empty entry)</div>';
    }
    container.appendChild(rich);
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
      const prev = item.status;
      item.status = stat.value;
      stat.className = 's-' + stat.value;
      scheduleSave();
      // V3.194 — when a PMR weekly item is toggled in/out of "done" AND
      // it carries a source_subtask_id back-link, mirror the done flag to
      // the original subtask in userData/{uid}/buckets/... Fire-and-forget;
      // the Tasks page's live-sync onSnapshot picks it up if open.
      if (item.source_subtask_id && window.TASK_PMR_SYNC) {
        const wasDone = prev === 'done';
        const isDone  = stat.value === 'done';
        if (wasDone !== isDone) {
          TASK_PMR_SYNC.syncPMRItemDoneToSubtask(item.source_subtask_id, isDone).catch(function () {});
        }
      }
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
    const cards = state.doc.discussion || [];
    const split = splitArchive(cards);
    split.active.forEach((card) => {
      const origIdx = cards.indexOf(card);
      list.appendChild(renderDiscCard(card, origIdx));
    });
    if (!split.active.length && !split.archived.length) {
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
    block.appendChild(renderItemArchive('Discussed items', split.archived, (card) => {
      const origIdx = cards.indexOf(card);
      return renderDiscCard(card, origIdx);
    }));
    // V3.157 — section-level conversation
    buildCommentToggle(block, 'discussion', null, 'Discussion');
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
    ICON.label(delBtn, 'x-mark');
    delBtn.title = 'Remove permanently';
    delBtn.onclick = () => {
      const targetIdx = (idx != null && idx >= 0) ? idx : state.doc.discussion.indexOf(card);
      if (targetIdx >= 0) state.doc.discussion.splice(targetIdx, 1);
      scheduleSave();
      renderBody();
    };
    actions.appendChild(delBtn);
    // V3.190 — discussed toggle that moves this card into the archive.
    actions.appendChild(buildDiscussedToggle(card, () => { scheduleSave(); renderBody(); }));
    div.appendChild(actions);
    // V3.157 — per-card thread so a specific blocker / next-action / idea
    // gets its own back-and-forth without polluting the section channel.
    if (card.id) {
      buildCommentToggle(div, 'discussion', card.id, 'Discussion: ' + (card.kind || 'item'));
    }
    return div;
  }

  /* V3.190 — coerce legacy plain-text goal bodies (V3.185 stored either
   * "" or a raw HTML fragment from contentEditable) into a `<ul><li>…</li></ul>`
   * tree so the bullet-list editor has something to work on. Existing
   * <ul>-shaped HTML passes through unchanged.
   */
  function coerceGoalHtmlToList(html) {
    if (!html) return '<ul><li><br></li></ul>';
    const trimmed = String(html).trim();
    if (!trimmed) return '<ul><li><br></li></ul>';
    // Already a list-shaped body — pass through.
    if (/^<ul[\s>]/i.test(trimmed) || /^<ol[\s>]/i.test(trimmed)) return trimmed;
    // Split on linebreaks (legacy plain-text or <br>-separated) and wrap
    // each line as an <li>. Strip any inline tags conservatively.
    const lines = trimmed
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<p[^>]*>/gi, '')
      .replace(/<[^>]+>/g, '')
      .split(/\n+/)
      .map(l => l.trim())
      .filter(l => l.length > 0);
    if (!lines.length) return '<ul><li><br></li></ul>';
    return '<ul>' + lines.map(l => '<li>' + escapeHtml(l) + '</li>').join('') + '</ul>';
  }

  function goalHasContent(bodyEl) {
    if (!bodyEl) return false;
    if (bodyEl.classList.contains('placeholder-shown')) return false;
    const text = (bodyEl.textContent || '').replace(/\s+/g, '');
    return text.length > 0;
  }

  function showGoalPlaceholder(bodyEl, placeholder) {
    bodyEl.classList.add('placeholder-shown');
    bodyEl.style.color = '#9ca3af';
    bodyEl.innerHTML = '<ul><li>' + escapeHtml(placeholder) + '</li></ul>';
  }

  /* ── Block: Goals (V3.185) ──────────────────────────────────────
   * Four time-horizon cards (this semester → beyond PhD) where the
   * student writes what they're aiming for. Each horizon gets its own
   * rich-text body + per-horizon comment thread so admin and student
   * can talk about each separately. Goals frame everything below
   * (projects, weekly entries, barriers) so this block renders early.
   */
  function renderGoalsBlock() {
    const block = document.createElement('section');
    block.className = 'pmr-block';
    const head = document.createElement('h2');
    head.innerHTML = 'Goals <span class="pmr-help">what you\'re aiming for — this semester through beyond the PhD</span>';
    block.appendChild(head);

    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px';
    GOAL_HORIZONS.forEach(h => grid.appendChild(renderGoalCard(h)));
    block.appendChild(grid);

    // Section-level conversation (general goal-setting discussion that
    // isn't tied to a single horizon).
    buildCommentToggle(block, 'goals', null, 'Goals discussion');
    return block;
  }

  function renderGoalCard(horizon) {
    const card = document.createElement('div');
    card.className = 'pmr-goal-card';
    card.style.cssText =
      'border:1px solid #e5e7eb;border-left:4px solid #6366f1;border-radius:8px;' +
      'padding:10px 12px;background:#fff';

    const headRow = document.createElement('div');
    headRow.style.cssText = 'display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:4px';
    const title = document.createElement('div');
    title.textContent = horizon.label;
    title.style.cssText = 'font-size:13px;font-weight:600;color:#312e81;text-transform:uppercase;letter-spacing:.4px';
    headRow.appendChild(title);
    const goalData = (state.doc.goals && state.doc.goals[horizon.key]) || { text_html: '', last_updated: null };
    if (goalData.last_updated) {
      const when = document.createElement('span');
      when.style.cssText = 'font-size:10px;color:#9ca3af;font-variant-numeric:tabular-nums';
      when.textContent = 'updated ' + goalData.last_updated.slice(0, 10);
      when.title = 'Last edited ' + goalData.last_updated;
      headRow.appendChild(when);
    }
    card.appendChild(headRow);

    const hint = document.createElement('div');
    hint.textContent = horizon.hint;
    hint.style.cssText = 'font-size:11px;color:#6b7280;line-height:1.4;margin-bottom:6px';
    card.appendChild(hint);

    // V3.190 — bullet-list contentEditable body. Each goal is a UL of LIs;
    // Enter creates a new bullet, Tab indents to a sub-bullet, Shift+Tab
    // outdents. We persist the raw HTML so older browsers with execCommand
    // support keep working without a sanitizer; on render we coerce legacy
    // plain-text bodies into `<ul><li>line</li>…</ul>`.
    const body = document.createElement('div');
    body.contentEditable = isReadOnlyView() ? 'false' : 'true';
    body.className = 'pmr-goal-body';
    body.style.cssText =
      'min-height:80px;padding:6px 10px 6px 4px;border:1px solid #e5e7eb;border-radius:6px;' +
      'font-size:13px;color:#374151;line-height:1.5;background:#fafbfc;outline:none';
    body.innerHTML = coerceGoalHtmlToList(goalData.text_html);
    if (!goalHasContent(body)) showGoalPlaceholder(body, horizon.placeholder);
    body.addEventListener('focus', () => {
      // Strip the placeholder UL once the user focuses, leaving an empty
      // <ul><li><br></li></ul> so Enter/Tab start clean.
      if (body.classList.contains('placeholder-shown')) {
        body.innerHTML = '<ul><li><br></li></ul>';
        body.classList.remove('placeholder-shown');
        body.style.color = '#374151';
        // Move caret into the empty <li>.
        const li = body.querySelector('li');
        if (li) {
          const range = document.createRange();
          range.setStart(li, 0);
          range.collapse(true);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    });
    body.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Tab') return;
      ev.preventDefault();
      if (ev.shiftKey) document.execCommand('outdent');
      else             document.execCommand('indent');
    });
    body.addEventListener('blur', () => {
      const html = body.innerHTML.trim();
      const isEmpty = !goalHasContent(body) || html === '<ul><li><br></li></ul>' || html === '<ul><li></li></ul>';
      if (isEmpty) {
        showGoalPlaceholder(body, horizon.placeholder);
        if (goalData.text_html) {
          state.doc.goals[horizon.key] = { text_html: '', last_updated: isoNow() };
          scheduleSave();
        }
      } else if (html !== goalData.text_html) {
        state.doc.goals = state.doc.goals || emptyGoals();
        state.doc.goals[horizon.key] = { text_html: html, last_updated: isoNow() };
        scheduleSave();
      }
    });
    body.addEventListener('input', () => {
      if (body.classList.contains('placeholder-shown')) return;
      // Re-coerce after every input so a delete that empties the body
      // doesn't leave a bare text node — browser would otherwise refuse
      // to indent a top-level text node. Cheap relative to typing rate.
      if (!body.querySelector('ul')) {
        const txt = body.textContent;
        body.innerHTML = '<ul><li>' + escapeHtml(txt) + '</li></ul>';
        // Caret moves to end of the new <li>.
        const li = body.querySelector('li');
        if (li) {
          const range = document.createRange();
          range.selectNodeContents(li);
          range.collapse(false);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      state.doc.goals = state.doc.goals || emptyGoals();
      state.doc.goals[horizon.key] = state.doc.goals[horizon.key] || { text_html: '', last_updated: null };
      state.doc.goals[horizon.key].text_html = body.innerHTML;
      scheduleSave();
    });
    card.appendChild(body);

    // Per-horizon discussion thread (admin↔student per time scale).
    buildCommentToggle(card, 'goals', horizon.key, horizon.label + ' discussion');

    return card;
  }

  /* ── Block: Barriers (V3.157) ───────────────────────────────────
   * First-class section for blockers / things stuck on the project.
   * Each barrier carries:
   *   id, title, description_html (rich text), status (open/discussing/resolved),
   *   figures[] (paper-figures uploads), linked_task_ids[]
   * Admin reads + comments; only the owner edits the cards themselves.
   */
  function renderBarriersBlock() {
    const block = document.createElement('section');
    block.className = 'pmr-block';
    const head = document.createElement('h2');
    head.innerHTML = 'Barriers <span class="pmr-help">things blocking progress — describe, discuss, resolve</span>';
    block.appendChild(head);

    // V3.190 — split active vs discussed/archived.
    const list = document.createElement('div');
    const barriers = state.doc.barriers || [];
    const split = splitArchive(barriers);
    split.active.forEach((b) => {
      const origIdx = barriers.indexOf(b);
      list.appendChild(renderBarrierCard(b, origIdx));
    });
    if (!split.active.length && !split.archived.length) {
      const empty = document.createElement('div');
      empty.className = 'pmr-empty';
      empty.style.padding = '14px';
      empty.textContent = isReadOnlyView()
        ? 'No barriers raised. The student can add one when something is blocking their progress.'
        : 'No barriers yet. Click "+ Add barrier" below when you hit something blocking progress — admin will see it and you can talk through it here.';
      list.appendChild(empty);
    }
    block.appendChild(list);

    if (!isReadOnlyView()) {
      const add = document.createElement('button');
      add.className = 'pmr-add-btn';
      add.textContent = '+ Add barrier';
      add.onclick = () => {
        state.doc.barriers = state.doc.barriers || [];
        state.doc.barriers.push({
          id: newId('barr'),
          title: '',
          description_html: '',
          status: 'open',
          figures: [],
          linked_task_ids: [],
          created_at: isoNow(),
        });
        scheduleSave();
        renderBody();
      };
      block.appendChild(add);
    }

    block.appendChild(renderItemArchive('Discussed barriers', split.archived, (b) => {
      const origIdx = barriers.indexOf(b);
      return renderBarrierCard(b, origIdx);
    }));

    // Section-level conversation (free of any specific barrier).
    buildCommentToggle(block, 'barriers', null, 'Section discussion');
    return block;
  }

  function renderBarrierCard(barrier, idx) {
    const card = document.createElement('div');
    card.className = 'pmr-barrier-card';
    card.style.cssText =
      'border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-bottom:10px;' +
      'background:#fff;border-left:4px solid ' +
      (barrier.status === 'resolved'   ? '#16a34a' :
       barrier.status === 'discussing' ? '#2563eb' :
                                         '#dc2626');

    // Header — title + status + delete
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px';
    const title = document.createElement('input');
    title.type = 'text';
    title.value = barrier.title || '';
    title.placeholder = 'What is blocking progress?';
    title.style.cssText = 'font-size:14px;font-weight:600;border:1px solid transparent;background:transparent;padding:4px 6px;flex:1;border-radius:4px;color:#1f2937';
    title.disabled = isReadOnlyView();
    title.addEventListener('input', () => { barrier.title = title.value; scheduleSave(); });
    title.addEventListener('focus', () => { title.style.borderColor = '#d1d5db'; title.style.background = '#fff'; });
    title.addEventListener('blur',  () => { title.style.borderColor = 'transparent'; title.style.background = 'transparent'; });
    head.appendChild(title);

    const statusSel = document.createElement('select');
    statusSel.className = 'pmr-barrier-status status-' + (barrier.status || 'open');
    BARRIER_STATUSES.forEach(s => {
      const o = document.createElement('option');
      o.value = s; o.textContent = s;
      if (s === barrier.status) o.selected = true;
      statusSel.appendChild(o);
    });
    statusSel.style.cssText = 'font-size:11px;padding:3px 6px;border:1px solid #e5e7eb;border-radius:4px;font-weight:600;text-transform:uppercase;letter-spacing:.4px';
    statusSel.disabled = isReadOnlyView();
    statusSel.addEventListener('change', () => {
      barrier.status = statusSel.value;
      if (barrier.status === 'resolved') barrier.resolved_at = isoNow();
      else                                barrier.resolved_at = null;
      scheduleSave();
      renderBody();
    });
    head.appendChild(statusSel);

    if (!isReadOnlyView()) {
      const del = document.createElement('span');
      del.className = 'del';
      ICON.label(del, 'x-mark');
      del.title = 'Remove barrier';
      del.style.cssText = 'cursor:pointer;color:#dc2626;font-size:14px;padding:4px 8px';
      del.onclick = () => {
        if (!confirm('Remove this barrier? Comments under it will remain in the database.')) return;
        state.doc.barriers.splice(idx, 1);
        scheduleSave();
        renderBody();
      };
      head.appendChild(del);
    }
    card.appendChild(head);

    // Description (rich text via contentEditable). Lift the pattern from
    // paper-blocks.js but keep it simple — no Yjs needed; debounced save
    // through the existing scheduleSave.
    const desc = document.createElement('div');
    desc.contentEditable = isReadOnlyView() ? 'false' : 'true';
    desc.style.cssText =
      'min-height:48px;padding:8px 10px;border:1px solid #e5e7eb;border-radius:6px;' +
      'font-size:13px;color:#374151;line-height:1.5;background:#fafbfc;outline:none;' +
      'white-space:pre-wrap';
    desc.innerHTML = barrier.description_html || '';
    if (isReadOnlyView()) desc.style.background = '#fff';
    desc.setAttribute('data-placeholder', 'Describe the barrier — what you tried, what isn\'t working, what would help unstick this.');
    if (!barrier.description_html) {
      desc.style.color = '#9ca3af';
      desc.textContent = desc.getAttribute('data-placeholder');
    }
    desc.addEventListener('focus', () => {
      if (desc.style.color === 'rgb(156, 163, 175)' && desc.textContent === desc.getAttribute('data-placeholder')) {
        desc.textContent = '';
        desc.style.color = '#374151';
      }
    });
    desc.addEventListener('blur', () => {
      const html = desc.innerHTML.trim();
      if (!html) {
        desc.style.color = '#9ca3af';
        desc.textContent = desc.getAttribute('data-placeholder');
      } else {
        barrier.description_html = html;
        scheduleSave();
      }
    });
    desc.addEventListener('input', () => {
      barrier.description_html = desc.innerHTML;
      scheduleSave();
    });
    // Paste images directly into the barrier — uploads via PAPER_FIGURES (lab-readable
    // SHA-256 dedup; reusing the existing paper-figures/{paperId} bucket would be wrong,
    // so we use the special paper-figures/{pmr-{periodId}-{barrier.id}} pseudo-id).
    desc.addEventListener('paste', async (ev) => {
      if (isReadOnlyView()) return;
      if (!window.PAPER_FIGURES) return;
      const items = (ev.clipboardData && ev.clipboardData.items) || [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) {
          ev.preventDefault();
          const blob = it.getAsFile();
          if (!blob) return;
          try {
            const fakePaperId = 'pmr-' + (state.currentPeriodId || 'p') + '-' + (barrier.id || 'b');
            const result = await window.PAPER_FIGURES.uploadImage(fakePaperId, blob);
            barrier.figures = barrier.figures || [];
            barrier.figures.push({
              storage_path: result.storage_path,
              hash: result.hash,
              mime: result.mime,
              size_bytes: result.size_bytes,
              uploaded_at: result.uploaded_at,
              download_url: result.download_url,
            });
            scheduleSave();
            renderBody();
          } catch (err) {
            alert('Image upload failed: ' + (err.message || err));
          }
          return;
        }
      }
    });
    card.appendChild(desc);

    // Figure thumbnails (if any uploaded)
    if (barrier.figures && barrier.figures.length) {
      const figs = document.createElement('div');
      figs.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:6px';
      barrier.figures.forEach((f, fi) => {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative;border:1px solid #e5e7eb;border-radius:4px;overflow:hidden;width:80px;height:80px';
        const img = document.createElement('img');
        img.src = f.download_url;
        img.alt = 'figure';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;cursor:pointer';
        img.title = 'Click to open full size';
        img.onclick = () => window.open(f.download_url, '_blank');
        wrap.appendChild(img);
        if (!isReadOnlyView()) {
          const x = document.createElement('span');
          ICON.label(x, 'x-mark');
          x.title = 'Remove figure';
          x.style.cssText = 'position:absolute;top:2px;right:2px;background:rgba(255,255,255,0.85);border-radius:10px;padding:0 5px;font-size:11px;color:#dc2626;cursor:pointer;line-height:1.2';
          x.onclick = (ev) => {
            ev.stopPropagation();
            barrier.figures.splice(fi, 1);
            scheduleSave();
            renderBody();
          };
          wrap.appendChild(x);
        }
        figs.appendChild(wrap);
      });
      card.appendChild(figs);
    }

    // Linked task chips
    if (barrier.linked_task_ids && barrier.linked_task_ids.length) {
      const taskChips = document.createElement('div');
      taskChips.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-top:6px';
      barrier.linked_task_ids.forEach(taskId => {
        const chip = document.createElement('span');
        chip.textContent = '↳ task ' + taskId.slice(-6);
        chip.title = 'Linked task — open Tasks page to view';
        chip.style.cssText = 'font-size:10px;padding:2px 6px;border-radius:8px;background:#dbeafe;color:#1e40af;font-weight:600';
        taskChips.appendChild(chip);
      });
      card.appendChild(taskChips);
    }

    // Action row — Assign task (admin or self-assign)
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap';
    const assignBtn = document.createElement('button');
    assignBtn.type = 'button';
    ICON.label(assignBtn, 'plus', ' Assign task');
    assignBtn.title = 'Create a task to address this barrier (admin → student, or student-to-self)';
    assignBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid #c4b5fd;color:#5b21b6;background:#f5f3ff;border-radius:4px;cursor:pointer;font-weight:500';
    assignBtn.onclick = () => openAssignFromBarrier(barrier);
    actions.appendChild(assignBtn);
    // V3.190 — discussed toggle: moves the barrier into the collapsed archive.
    actions.appendChild(buildDiscussedToggle(barrier, () => { scheduleSave(); renderBody(); }));
    card.appendChild(actions);

    // Per-barrier comment thread
    buildCommentToggle(card, 'barriers', barrier.id, 'Discussion: ' + (barrier.title || 'this barrier'));

    return card;
  }

  function openAssignFromBarrier(barrier) {
    if (!window.TASK_ASSIGN) {
      alert('Task assignment module not loaded. Refresh the page (Ctrl/Cmd+Shift+R).');
      return;
    }
    const me = state.user && state.user.uid;
    const studentUid = viewedUid();
    // For admin viewing a student: prefill assignee = student. For student
    // viewing self: open the regular modal (assignee blank, can self-assign
    // by picking themselves… but task-assign filters out self today, so
    // students using "+ Assign task" on their own barrier currently has to
    // pick a teammate. That's acceptable — barriers usually need a teammate
    // to help anyway).
    window.TASK_ASSIGN.open({
      source: 'pmr',
      pmrPeriodId: state.currentPeriodId || '',
      pmrSectionId: 'barriers',
      pmrTargetId: barrier.id,
      defaultAssigneeUid: (me && studentUid && studentUid !== me) ? studentUid : null,
      titlePrefill: barrier.title ? 'Address barrier: ' + barrier.title : '',
      onCreated: function (task) {
        if (!task || !task.id) return;
        // Back-link the task on this barrier so it renders as a chip.
        // V3.157 — admin writes the back-link onto the student's PMR doc.
        // That single field write is the only PMR-doc write admin makes;
        // the rest of the doc stays student-owned.
        if (isReadOnlyView()) {
          // Admin path: read-modify-write JUST the barriers array on the
          // student's PMR doc. Nested-array element fields don't support
          // arrayUnion, so we read and re-write the whole barriers list.
          // Race window with the student's in-flight save is small in
          // practice (admin assigns tasks rarely; the doc is debounced
          // 400ms either way) — accept the trade-off for V1.
          pmrPeriodDocRef(viewedUid(), state.currentPeriodId).get().then(snap => {
            if (!snap.exists) return;
            const data = snap.data();
            const list = (data.barriers || []).map(b => {
              if (b.id !== barrier.id) return b;
              return Object.assign({}, b, {
                linked_task_ids: (b.linked_task_ids || []).concat([task.id]),
              });
            });
            return pmrPeriodDocRef(viewedUid(), state.currentPeriodId).update({
              barriers: list,
              updated_at: isoNow(),
            });
          }).catch(err => {
            console.warn('[pmr] failed to back-link task on barrier (admin):', err && err.message);
          });
        } else {
          barrier.linked_task_ids = (barrier.linked_task_ids || []).concat([task.id]);
          scheduleSave();
          renderBody();
        }
      },
    });
  }

  /* ── Block: Paper writing (V3.157) ─────────────────────────────
   * Surfaces papers where the viewed student is in authorUids and the paper
   * is a draft (is_library_entry !== true). The paper itself is the
   * canonical source of status / content — this block just provides a
   * conversation surface scoped to each draft.
   */
  function renderPaperWritingBlock() {
    const block = document.createElement('section');
    block.className = 'pmr-block';
    const head = document.createElement('h2');
    head.innerHTML = 'Paper writing <span class="pmr-help">drafts you are authoring · status + per-paper conversation</span>';
    block.appendChild(head);

    if (!state.paperDraftsLoaded) {
      const loading = document.createElement('div');
      loading.className = 'pmr-empty';
      loading.textContent = 'Loading drafts…';
      block.appendChild(loading);
      return block;
    }
    if (state.paperDraftsError) {
      const err = document.createElement('div');
      err.className = 'pmr-empty';
      err.textContent = 'Could not load drafts: ' + state.paperDraftsError;
      block.appendChild(err);
      return block;
    }
    if (!state.paperDrafts.length) {
      const empty = document.createElement('div');
      empty.className = 'pmr-empty';
      empty.style.padding = '14px';
      empty.textContent = 'No paper drafts found. When the student starts a paper in the paper builder (and is listed in authorUids), it will appear here.';
      block.appendChild(empty);
      // V3.190 — always render the archive section so the system is
      // discoverable even on empty PMRs. Will show "Archive (0)".
      block.appendChild(renderItemArchive('Discussed paper drafts', [], (p) => renderPaperDraftRow(p)));
      buildCommentToggle(block, 'paper_writing', null, 'Section discussion');
      return block;
    }

    // V3.190 — split drafts via per-paper discussed_at stored in
    // state.doc.paper_writing[]. Entries are created lazily by the toggle.
    const pwArchive = state.doc.paper_writing || [];
    const archivedById = {};
    pwArchive.forEach(p => { if (p && p.discussed_at) archivedById[p.paper_id] = p.discussed_at; });
    const activeDrafts = [];
    const archivedDrafts = [];
    state.paperDrafts.forEach(d => {
      if (archivedById[d.id]) archivedDrafts.push(d);
      else                    activeDrafts.push(d);
    });
    activeDrafts.forEach(p => block.appendChild(renderPaperDraftRow(p)));
    block.appendChild(renderItemArchive('Discussed paper drafts', archivedDrafts, (p) => renderPaperDraftRow(p)));
    buildCommentToggle(block, 'paper_writing', null, 'Section discussion');
    return block;
  }

  function renderPaperDraftRow(draft) {
    const row = document.createElement('div');
    row.style.cssText =
      'border:1px solid #e5e7eb;border-radius:6px;padding:8px 10px;margin-bottom:8px;background:#fff';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;gap:8px;align-items:center';

    const link = document.createElement('a');
    link.href = '/rm/pages/paper-builder.html?id=' + encodeURIComponent(draft.id);
    link.target = '_self';
    link.textContent = draft.title;
    link.style.cssText = 'color:#1f2937;text-decoration:none;font-weight:500;flex:1;border-bottom:1px dotted #9ca3af';
    head.appendChild(link);

    const pill = document.createElement('span');
    pill.textContent = draft.status;
    pill.title = 'Status from papers/{id}.status — edit in the paper builder';
    pill.style.cssText = 'display:inline-block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;padding:2px 8px;border-radius:10px;';
    if (draft.status === 'submitted')      { pill.style.background = '#fef3c7'; pill.style.color = '#92400e'; }
    else if (draft.status === 'in_revision') { pill.style.background = '#fee2e2'; pill.style.color = '#991b1b'; }
    else if (draft.status === 'review')    { pill.style.background = '#dbeafe'; pill.style.color = '#1e40af'; }
    else if (draft.status === 'published') { pill.style.background = '#dcfce7'; pill.style.color = '#166534'; }
    else                                   { pill.style.background = '#f3f4f6'; pill.style.color = '#374151'; }
    head.appendChild(pill);

    const openBtn = document.createElement('a');
    openBtn.href = '/rm/pages/paper-builder.html?id=' + encodeURIComponent(draft.id);
    openBtn.textContent = '→ open';
    openBtn.style.cssText = 'font-size:11px;color:#2563eb;text-decoration:none;padding:3px 8px;border:1px solid #dbeafe;border-radius:4px;background:#eff6ff';
    head.appendChild(openBtn);

    const assignBtn = document.createElement('button');
    assignBtn.type = 'button';
    ICON.label(assignBtn, 'plus', ' task');
    assignBtn.title = 'Create a task related to this paper';
    assignBtn.style.cssText = 'font-size:11px;padding:3px 8px;border:1px solid #c4b5fd;color:#5b21b6;background:#f5f3ff;border-radius:4px;cursor:pointer';
    assignBtn.onclick = () => openAssignFromPaperDraft(draft);
    head.appendChild(assignBtn);

    // V3.190 — discussed toggle. The discussed_at lives on
    // state.doc.paper_writing[].discussed_at keyed by paper_id; lazily
    // created when the user clicks.
    state.doc.paper_writing = state.doc.paper_writing || [];
    let pwEntry = state.doc.paper_writing.find(p => p.paper_id === draft.id);
    if (!pwEntry) {
      pwEntry = { paper_id: draft.id, discussed_at: null };
      // Don't push to doc yet — only push if discussed is toggled on,
      // otherwise we'd dirty the doc and trigger a save just by rendering.
    }
    const discToggle = buildDiscussedToggle(pwEntry, () => {
      // Ensure the entry exists in the array so the new discussed_at sticks.
      if (state.doc.paper_writing.indexOf(pwEntry) < 0) state.doc.paper_writing.push(pwEntry);
      scheduleSave();
      renderBody();
    });
    head.appendChild(discToggle);

    row.appendChild(head);

    // Per-paper conversation thread
    buildCommentToggle(row, 'paper_writing', draft.id, 'Discussion: ' + draft.title);

    return row;
  }

  function openAssignFromPaperDraft(draft) {
    if (!window.TASK_ASSIGN) return;
    const me = state.user && state.user.uid;
    const studentUid = viewedUid();
    window.TASK_ASSIGN.open({
      source: 'pmr',
      pmrPeriodId: state.currentPeriodId || '',
      pmrSectionId: 'paper_writing',
      pmrTargetId: draft.id,
      defaultAssigneeUid: (me && studentUid && studentUid !== me) ? studentUid : null,
      titlePrefill: 'Paper task: ' + draft.title,
      paperRef: {
        paperId: draft.id,
        paperTitle: draft.title,
        paperAuthors: '',
      },
    });
  }

  /* ── Block: Past PMRs (legacy archive) ──────────────────────── */
  /* V3.160 — Activity block. Read-only roll-up of the student's tracker
   * entries within the PMR period. Cross-user reads work because
   * firestore.rules now allows admin to read trackerEntries/{userId}/entries.
   * Pending entries shown with distinct styling so admin can ask "how
   * long did this take?" during the 1:1. */
  function renderActivityBlock() {
    const block = document.createElement('section');
    block.className = 'pmr-block';
    const head = document.createElement('h2');
    head.innerHTML = 'Activity <span class="pmr-help">tracker entries dated within this PMR period</span>';
    block.appendChild(head);

    const period = state.doc && state.doc.period;
    const fromDate = period && period.start_date;
    const toDate   = period && period.end_date;

    const body = document.createElement('div');
    body.id = 'pmr-activity-body';
    body.innerHTML = '<div class="pmr-empty">Loading…</div>';
    block.appendChild(body);

    // Async load — uses ActivitySignals.listForPeriod (confirmed + pending).
    loadActivityForBlock(body, fromDate, toDate).catch(err => {
      body.innerHTML = '<div class="pmr-empty">Could not load activity: ' +
        escapeHtml(err && err.message || 'error') + '</div>';
    });

    // Threaded conversation pane.
    block.appendChild(buildCommentToggle(block, 'activity', null, 'Activity discussion'));
    return block;
  }

  async function loadActivityForBlock(host, fromDate, toDate) {
    if (!window.ActivitySignals) {
      host.innerHTML = '<div class="pmr-empty">Activity helper not loaded.</div>';
      return;
    }
    if (!fromDate || !toDate) {
      host.innerHTML = '<div class="pmr-empty">No period date range — set start/end on the PMR period to surface activity.</div>';
      return;
    }
    const uid = viewedUid();
    if (!uid) {
      host.innerHTML = '<div class="pmr-empty">Not signed in.</div>';
      return;
    }
    let entries;
    try {
      // V3.626 — shared one-flight fetch (the ledger's presence dots ask
      // for the same range at the same time).
      entries = await ensureActivityForPeriod();
    } catch (err) {
      throw err;
    }
    // Cache for the Stats block to reuse (avoid double-fetching).
    state._activityCache = { uid, from: fromDate, to: toDate, entries };
    renderActivityList(host, entries, fromDate, toDate);
  }

  /* V3.321 — heatmap strip: one cell per period day, shaded by event
   * count (hours are dead; count = entries dated that day, schedule
   * markers excluded). Mirrors the tracker page's calendar heatmap. */
  function renderActivityStrip(entries, fromDate, toDate) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:2px;margin:2px 0 10px';
    const byDay = {};
    (entries || []).forEach(e => {
      if (!e.date) return;
      if (e.kind === 'schedule' || (!e.kind && e.scheduled_for && e.status === 'pending')) return;
      byDay[e.date] = (byDay[e.date] || 0) + 1;
    });
    const shades = ['#e5e7eb', '#bbf7d0', '#4ade80', '#16a34a', '#14532d'];
    enumerateDates(fromDate, toDate).forEach(d => {
      const c = byDay[d] || 0;
      const lv = !c ? 0 : c === 1 ? 1 : c <= 3 ? 2 : c <= 6 ? 3 : 4;
      const cell = document.createElement('span');
      cell.title = d + ' — ' + c + ' event' + (c === 1 ? '' : 's');
      cell.style.cssText = 'width:10px;height:10px;border-radius:2px;background:' + shades[lv];
      wrap.appendChild(cell);
    });
    return wrap;
  }

  function renderActivityList(host, entries, fromDate, toDate) {
    host.innerHTML = '';
    host.appendChild(renderActivityStrip(entries, fromDate, toDate));
    if (!entries || !entries.length) {
      const empty = document.createElement('div');
      empty.className = 'pmr-activity-empty';
      empty.textContent = 'No tracker entries in this period yet.';
      host.appendChild(empty);
      // V3.195 — keep the archive system discoverable even on empty periods.
      host.appendChild(renderItemArchive('Discussed weeks', [], () => document.createElement('div')));
      return;
    }
    // Group by ISO week (Mon-Sun). Sort by date ascending.
    const sorted = entries.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const byWeek = {};
    const weekOrder = [];
    sorted.forEach(e => {
      const wk = isoWeekKey(e.date);
      if (!byWeek[wk]) { byWeek[wk] = []; weekOrder.push(wk); }
      byWeek[wk].push(e);
    });
    // V3.195 — split weeks into active (not discussed) and archived
    // based on state.doc.activity_archive[weekKey]. Active weeks render
    // as collapsed-by-default <details>; archived weeks render in a
    // collapsed Archive section at the bottom (same as other sections).
    const archiveMap = (state.doc && state.doc.activity_archive) || {};
    const activeWeeks = [];
    const archivedWeeks = [];
    weekOrder.forEach(wk => {
      if (archiveMap[wk]) archivedWeeks.push(wk);
      else                activeWeeks.push(wk);
    });

    activeWeeks.forEach(wk => host.appendChild(renderActivityWeek(wk, byWeek[wk], false)));

    host.appendChild(renderItemArchive('Discussed weeks',
      archivedWeeks.map(wk => ({ wk: wk, entries: byWeek[wk] })),
      (item) => renderActivityWeek(item.wk, item.entries, true)));
  }

  /* V3.195 — render a single activity week. Collapsed-by-default for
   * active weeks; per-week "✓ discussed" toggle writes to
   * state.doc.activity_archive[weekKey]. Archived weeks pass
   * isArchivedView=true so we render with a "↶ restore" affordance.
   */
  function renderActivityWeek(wk, entries, isArchivedView) {
    const det = document.createElement('details');
    det.className = 'pmr-activity-week';
    // V3.195 — collapsed by default for both active and archived weeks.

    const sum = document.createElement('summary');
    sum.className = 'pmr-activity-week-head';
    sum.style.cssText = 'cursor:pointer;display:flex;align-items:center;gap:8px;justify-content:space-between';

    const wkLabel = document.createElement('span');
    wkLabel.textContent = wk + '  ·  ' + entries.length + ' entr' + (entries.length === 1 ? 'y' : 'ies');
    sum.appendChild(wkLabel);

    // Per-week discussed toggle — stores state in state.doc.activity_archive
    // (the tracker entries themselves live in a separate collection so
    // can't carry the flag directly). Inline button rather than
    // buildDiscussedToggle since the helper expects a writable
    // `discussed_at` field on the item itself.
    if (!isReadOnlyView()) {
      const archived = !!(state.doc.activity_archive || {})[wk];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = archived ? '↶ restore' : '✓ discussed';
      btn.title = archived
        ? 'Move this week back to the active list'
        : 'Mark this week as discussed — it will move to the Archive section below';
      btn.style.cssText = archived
        ? 'font-size:11px;padding:3px 8px;border:1px solid #d1d5db;border-radius:4px;background:#fff;cursor:pointer;color:#374151'
        : 'font-size:11px;padding:3px 8px;border:1px solid #16a34a;color:#fff;background:#16a34a;border-radius:4px;cursor:pointer;font-weight:500';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.doc.activity_archive = state.doc.activity_archive || {};
        if (state.doc.activity_archive[wk]) delete state.doc.activity_archive[wk];
        else                                state.doc.activity_archive[wk] = isoNow();
        scheduleSave();
        renderBody();
      });
      sum.appendChild(btn);
    }
    det.appendChild(sum);

    entries.forEach(e => {
      // V3.327 — hybrid model: manual entries carry `duration` (hours),
      // auto-captured events (page-time / producers) don't. Show hours
      // when present so the PMR matches the tracker; blank for presence
      // events (they still show on the heatmap strip above).
      const row = document.createElement('div');
      row.className = 'pmr-activity-row';
      const day = document.createElement('span');
      day.className = 'pmr-activity-day';
      day.textContent = dayLabel(e.date);
      row.appendChild(day);
      const cat = document.createElement('span');
      cat.className = 'pmr-activity-cat';
      const catStr = Array.isArray(e.categoryPath) && e.categoryPath.length
        ? e.categoryPath.join(' › ') : '(uncategorized)';
      cat.textContent = catStr + ' — ' + (e.text || '');
      row.appendChild(cat);
      const hrs = document.createElement('span');
      hrs.className = 'pmr-activity-hours';
      const mins = (e.duration != null && isFinite(e.duration) && e.status !== 'pending') ? Number(e.duration) : 0;
      hrs.textContent = mins > 0 ? (mins / 60).toFixed(1) + 'h' : '';
      row.appendChild(hrs);
      det.appendChild(row);
    });
    return det;
  }

  /* V3.160 — Stats block. Browser-side aggregation of hours by top-level
   * category + daily sparkline. Reuses state._activityCache populated by
   * the Activity block so we don't double-fetch. */
  function renderStatsBlock() {
    const block = document.createElement('section');
    block.className = 'pmr-block';
    const head = document.createElement('h2');
    head.innerHTML = 'Stats <span class="pmr-help">logged hours by category for this period</span>';
    block.appendChild(head);

    const body = document.createElement('div');
    body.id = 'pmr-stats-body';
    body.innerHTML = '<div class="pmr-empty">Loading…</div>';
    block.appendChild(body);

    const period = state.doc && state.doc.period;
    const fromDate = period && period.start_date;
    const toDate   = period && period.end_date;
    loadStatsForBlock(body, fromDate, toDate).catch(err => {
      body.innerHTML = '<div class="pmr-empty">Could not load stats: ' +
        escapeHtml(err && err.message || 'error') + '</div>';
    });

    block.appendChild(buildCommentToggle(block, 'stats', null, 'Stats discussion'));
    return block;
  }

  async function loadStatsForBlock(host, fromDate, toDate) {
    if (!window.ActivitySignals) {
      host.innerHTML = '<div class="pmr-empty">Activity helper not loaded.</div>';
      return;
    }
    if (!fromDate || !toDate) {
      host.innerHTML = '<div class="pmr-empty">No period date range — set start/end on the PMR period to surface stats.</div>';
      return;
    }
    const uid = viewedUid();
    if (!uid) {
      host.innerHTML = '<div class="pmr-empty">Not signed in.</div>';
      return;
    }
    let entries;
    if (state._activityCache && state._activityCache.uid === uid &&
        state._activityCache.from === fromDate && state._activityCache.to === toDate) {
      entries = state._activityCache.entries;
    } else {
      entries = await window.ActivitySignals.listForPeriod(uid, { from: fromDate, to: toDate });
    }
    // V3.327 — hours by category (from manual entries' `duration`), to
    // match the tracker. Schedule markers are excluded; auto-captured
    // presence events (no duration) contribute 0 hours here — they show
    // on the heatmap strip in the Activity block instead.
    const work = entries.filter(e =>
      !(e.kind === 'schedule' || (!e.kind && e.scheduled_for && e.status === 'pending')));
    renderStatsContent(host, work, fromDate, toDate);
  }

  function renderStatsContent(host, entries, fromDate, toDate) {
    host.innerHTML = '';
    // Aggregate minutes by top-level category.
    const byCat = {};
    let totalMins = 0;
    entries.forEach(e => {
      const mins = (e.duration != null && isFinite(e.duration) && e.status !== 'pending') ? Number(e.duration) : 0;
      if (mins <= 0) return;
      const cat = (Array.isArray(e.categoryPath) && e.categoryPath[0]) || 'other';
      byCat[cat] = (byCat[cat] || 0) + mins;
      totalMins += mins;
    });
    if (!totalMins) {
      const empty = document.createElement('div');
      empty.className = 'pmr-stats-empty';
      empty.textContent = 'No logged hours in this period yet — log time on the Activity tracker (Daily) and it rolls up here.';
      host.appendChild(empty);
      return;
    }
    // Sort descending by hours.
    const cats = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]);
    cats.forEach(cat => {
      const mins = byCat[cat];
      const pct = mins / totalMins * 100;
      const row = document.createElement('div');
      row.className = 'pmr-stats-bar';
      const label = document.createElement('div');
      label.className = 'pmr-stats-bar-label';
      label.textContent = cat;
      row.appendChild(label);
      const track = document.createElement('div');
      track.className = 'pmr-stats-bar-track';
      const fill = document.createElement('div');
      const safeCat = String(cat).toLowerCase().replace(/[^a-z]/g, '');
      fill.className = 'pmr-stats-bar-fill cat-' + (
        ['research','coursework','service','personal','admin'].indexOf(safeCat) >= 0 ? safeCat : 'other'
      );
      fill.style.width = pct.toFixed(1) + '%';
      track.appendChild(fill);
      row.appendChild(track);
      const hrsEl = document.createElement('div');
      hrsEl.className = 'pmr-stats-hours';
      hrsEl.textContent = (mins / 60).toFixed(1) + 'h';
      row.appendChild(hrsEl);
      const pctEl = document.createElement('div');
      pctEl.className = 'pmr-stats-pct';
      pctEl.textContent = Math.round(pct) + '%';
      row.appendChild(pctEl);
      host.appendChild(row);
    });

    // Daily sparkline across the period (hours per day).
    const spark = document.createElement('div');
    spark.className = 'pmr-stats-sparkline';
    const byDay = {};
    entries.forEach(e => {
      const mins = (e.duration != null && isFinite(e.duration) && e.status !== 'pending') ? Number(e.duration) : 0;
      if (!e.date || mins <= 0) return;
      byDay[e.date] = (byDay[e.date] || 0) + mins;
    });
    const dates = enumerateDates(fromDate, toDate);
    const maxDay = Math.max(1, ...Object.values(byDay));
    const step = Math.max(1, Math.floor(dates.length / 60));
    dates.forEach((d, i) => {
      if (i % step !== 0) return;
      const bar = document.createElement('div');
      bar.className = 'pmr-stats-spark-bar';
      const v = byDay[d] || 0;
      bar.style.height = Math.max(2, (v / maxDay) * 100) + '%';
      bar.title = d + ': ' + (v / 60).toFixed(1) + 'h';
      spark.appendChild(bar);
    });
    host.appendChild(spark);
  }

  /* ----- date helpers for Activity/Stats blocks ----- */
  function isoWeekKey(dateStr) {
    if (!dateStr) return '?';
    const d = new Date(dateStr + 'T00:00:00');
    // Find Monday of that week.
    const day = d.getDay() || 7; // Sun=0 → 7
    const mon = new Date(d); mon.setDate(d.getDate() - (day - 1));
    return 'Week of ' + mon.toISOString().slice(0, 10);
  }
  function dayLabel(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return days[d.getDay()];
  }
  function enumerateDates(from, to) {
    if (!from || !to) return [];
    const out = [];
    const d = new Date(from + 'T00:00:00');
    const end = new Date(to + 'T00:00:00');
    let safety = 0;
    while (d <= end && safety < 1000) {
      out.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
      safety++;
    }
    return out;
  }

  /* V3.161 — Figure reviews. Renders lab notebook images the student
   * flagged for this PMR period via the notebook page's 📌 toggle.
   * Each card has an image preview (click → fullscreen modal), an
   * editable caption, a deep-link back to the originating notebook
   * entry, a per-figure comment thread, and a "+ Create follow-up
   * task" button that wires through task-assign with the PMR backref.
   *
   * The notebook page is the only writer of state.doc.figure_reviews
   * (dual-write with notebook.pmr_review_figures). PMR-side edits in
   * this block are limited to caption text (saves through scheduleSave)
   * and the per-figure removal — never to the flag itself, which is
   * owned by the notebook surface.
   */
  function renderFigureReviewsBlock() {
    const block = document.createElement('section');
    block.className = 'pmr-block';
    const head = document.createElement('h2');
    const reviews = state.doc.figure_reviews || [];
    head.innerHTML = 'Figure reviews <span class="pmr-help">' +
      'lab notebook images flagged for review here · ' + reviews.length + ' figure' +
      (reviews.length === 1 ? '' : 's') + '</span>';
    block.appendChild(head);

    const split = splitArchive(reviews);
    if (!split.active.length && !split.archived.length) {
      const empty = document.createElement('div');
      empty.className = 'pmr-empty';
      empty.innerHTML = isReadOnlyView()
        ? 'No figures flagged for this period. The student can flag images from the ' + ICON.svg('pin') + ' button on a lab notebook attachment.'
        : 'No figures flagged yet. Open a Lab Notebook entry, click ' + ICON.svg('pin') + ' on any image attachment to flag it for the next PMR.';
      block.appendChild(empty);
      // V3.190 — always render the archive section so the system is
      // discoverable even before items are flagged.
      block.appendChild(renderItemArchive('Discussed figures', [], (fr) => renderFigureReviewCard(fr, 0)));
      block.appendChild(buildCommentToggle(block, 'figure_reviews', null, 'Section discussion'));
      return block;
    }

    const grid = document.createElement('div');
    grid.className = 'pmr-fig-review-grid';
    split.active.forEach((fr) => {
      const origIdx = reviews.indexOf(fr);
      grid.appendChild(renderFigureReviewCard(fr, origIdx));
    });
    block.appendChild(grid);

    block.appendChild(renderItemArchive('Discussed figures', split.archived, (fr) => {
      const origIdx = reviews.indexOf(fr);
      return renderFigureReviewCard(fr, origIdx);
    }));

    block.appendChild(buildCommentToggle(block, 'figure_reviews', null, 'Section discussion'));
    return block;
  }

  function renderFigureReviewCard(fr, idx) {
    const card = document.createElement('div');
    card.className = 'pmr-fig-review-card';
    card.dataset.id = fr.id || '';

    // Image preview — lazy-resolved download URL from Firebase Storage.
    const imgBox = document.createElement('div');
    imgBox.className = 'pmr-fig-review-imgbox';
    const img = document.createElement('img');
    img.alt = fr.notebook_title || '';
    img.className = 'pmr-fig-review-img';
    if (fr.image_url) img.src = fr.image_url;
    else if (fr.storage_path) resolveFigureUrl(fr.storage_path).then(url => {
      if (url) img.src = url;
    });
    img.addEventListener('click', () => openFigureLightbox(img.src, fr.notebook_title));
    imgBox.appendChild(img);
    card.appendChild(imgBox);

    // Notebook link
    const meta = document.createElement('div');
    meta.className = 'pmr-fig-review-meta';
    const link = document.createElement('a');
    link.href = '/rm/pages/notebook.html?entry=' + encodeURIComponent(fr.notebook_entry_id || '');
    ICON.label(link, 'book-open', ' ' + (fr.notebook_title || '(untitled entry)') +
      (fr.notebook_date ? ' · ' + fr.notebook_date : ''));
    link.title = 'Open the originating notebook entry';
    meta.appendChild(link);
    if (fr.flagged_at) {
      const stamp = document.createElement('span');
      stamp.className = 'pmr-fig-review-stamp';
      stamp.textContent = 'flagged ' + String(fr.flagged_at).slice(0, 10);
      meta.appendChild(stamp);
    }
    card.appendChild(meta);

    // Caption — editable on the PMR side. Saves on blur.
    const caption = document.createElement('div');
    caption.className = 'pmr-fig-review-caption';
    caption.setAttribute('contenteditable', isReadOnlyView() ? 'false' : 'true');
    caption.setAttribute('data-placeholder', 'Caption — what to discuss about this figure');
    caption.textContent = fr.caption || '';
    caption.addEventListener('blur', () => {
      if (isReadOnlyView()) return;
      const next = caption.textContent.trim();
      if (next === (fr.caption || '')) return;
      state.doc.figure_reviews[idx].caption = next;
      scheduleSave();
    });
    card.appendChild(caption);

    // Action row — Assign task + Remove
    const actions = document.createElement('div');
    actions.className = 'pmr-fig-review-actions';
    const assignBtn = document.createElement('button');
    assignBtn.type = 'button';
    assignBtn.className = 'pmr-add-btn';
    assignBtn.textContent = '+ Create follow-up task';
    assignBtn.addEventListener('click', () => openTaskForFigureReview(fr));
    actions.appendChild(assignBtn);
    if (!isReadOnlyView()) {
      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'pmr-add-btn pmr-fig-review-remove';
      ICON.label(rmBtn, 'x-mark', ' Remove');
      rmBtn.title = 'Remove this figure from the PMR (the notebook flag stays on)';
      rmBtn.addEventListener('click', () => {
        if (!confirm('Remove this figure from the PMR? The notebook flag will stay; re-flag from the notebook to bring it back.')) return;
        const targetIdx = (idx != null && idx >= 0) ? idx : state.doc.figure_reviews.indexOf(fr);
        if (targetIdx >= 0) state.doc.figure_reviews.splice(targetIdx, 1);
        scheduleSave();
        renderBody();
      });
      actions.appendChild(rmBtn);
    }
    // V3.190 — discussed toggle on each figure card.
    actions.appendChild(buildDiscussedToggle(fr, () => { scheduleSave(); renderBody(); }));
    card.appendChild(actions);

    // Per-figure conversation thread.
    card.appendChild(buildCommentToggle(card, 'figure_reviews', fr.id || ('fr-' + idx), 'Figure discussion'));
    return card;
  }

  /* Lazy-resolve and cache the download URL for a Storage path. */
  function resolveFigureUrl(storagePath) {
    if (!storagePath) return Promise.resolve(null);
    if (!state._figureUrlCache) state._figureUrlCache = {};
    if (state._figureUrlCache[storagePath]) return Promise.resolve(state._figureUrlCache[storagePath]);
    try {
      const ref = firebase.storage().ref(storagePath);
      return ref.getDownloadURL().then(url => {
        state._figureUrlCache[storagePath] = url;
        return url;
      }).catch(err => {
        console.warn('[pmr] figure URL resolve failed:', storagePath, err && err.message);
        return null;
      });
    } catch (err) {
      console.warn('[pmr] storage SDK missing:', err && err.message);
      return Promise.resolve(null);
    }
  }

  function openFigureLightbox(src, label) {
    if (!src) return;
    let overlay = document.getElementById('pmr-figure-lightbox');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'pmr-figure-lightbox';
    overlay.className = 'pmr-fig-lightbox';
    const closeAndCleanup = () => overlay.remove();
    overlay.addEventListener('click', closeAndCleanup);
    const big = document.createElement('img');
    big.src = src;
    big.alt = label || '';
    big.className = 'pmr-fig-lightbox-img';
    overlay.appendChild(big);
    if (label) {
      const cap = document.createElement('div');
      cap.className = 'pmr-fig-lightbox-label';
      cap.textContent = label;
      overlay.appendChild(cap);
    }
    document.body.appendChild(overlay);
  }

  function openTaskForFigureReview(fr) {
    if (!window.TASK_ASSIGN || typeof TASK_ASSIGN.open !== 'function') {
      alert('Task assign module not loaded.');
      return;
    }
    const ownerUid = viewedUid();
    TASK_ASSIGN.open({
      source: 'pmr',
      pmrPeriodId: state.currentPeriodId,
      pmrSectionId: 'figure_reviews',
      pmrTargetId: fr.id,
      defaultAssigneeUid: ownerUid,
      titlePrefill: 'Follow up on figure: ' + (fr.notebook_title || ''),
      heading: 'Follow-up task for figure review',
    });
  }

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
      if (isReadOnlyView()) {
        alert('Only the student can flip the status. Switch back to your own PMR to submit.');
        return;
      }
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
    btn.addEventListener('click', () => {
      if (isReadOnlyView()) {
        alert('Admin view is read-only for the doc itself. Switch back to your own PMR to create a new period.');
        return;
      }
      openNewPeriodDialog();
    });
  }

  /* V3.322 — guided period creation (FuturePlan 04 C1). Replaces the raw
   * window.prompt: suggestion chips from suggestedPeriods(), a custom
   * slug field, and copy-forward checkboxes that carry goals / project
   * overview / reference links over from the most-recent period. */
  function openNewPeriodDialog() {
    const existing = {};
    (state.indexDoc && state.indexDoc.periods || []).forEach(p => { existing[p.id] = true; });
    const suggestions = suggestedPeriods().map(p => ({ id: periodIdFor(p), label: periodLabel(p), period: p }));
    const latest = (state.indexDoc && state.indexDoc.periods || []).slice()
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0] || null;

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(11,13,18,.55);display:flex;align-items:center;justify-content:center;padding:24px';
    const chipHtml = suggestions.map(s =>
      '<button type="button" class="pmr-np-chip" data-id="' + escapeHtml(s.id) + '"' +
      (existing[s.id] ? ' disabled title="Already created"' : '') +
      ' style="font-size:12px;padding:6px 12px;border:1px solid #d1d5db;border-radius:16px;background:#fff;cursor:pointer' +
      (existing[s.id] ? ';opacity:.45;cursor:default' : '') + '">' +
      escapeHtml(s.label) + (existing[s.id] ? ' ✓' : '') + '</button>'
    ).join('');
    const copyHtml = latest
      ? '<div style="font-size:12px;color:#374151;border-top:1px solid #e5e7eb;padding-top:10px">' +
          'Carry forward from <strong>' + escapeHtml(latest.label || latest.id) + '</strong>:' +
          '<div style="display:flex;gap:14px;margin-top:6px;flex-wrap:wrap">' +
            '<label style="display:flex;gap:5px;align-items:center"><input type="checkbox" class="pmr-np-copy" value="goals" checked> Goals</label>' +
            '<label style="display:flex;gap:5px;align-items:center"><input type="checkbox" class="pmr-np-copy" value="project_overview" checked> Project overview</label>' +
            '<label style="display:flex;gap:5px;align-items:center"><input type="checkbox" class="pmr-np-copy" value="reference_links" checked> Reference links</label>' +
          '</div>' +
        '</div>'
      : '';
    overlay.innerHTML =
      '<div style="background:#fff;color:#111;border-radius:12px;max-width:480px;width:100%;padding:22px;box-shadow:0 24px 48px rgba(0,0,0,.4)">' +
        '<h2 style="margin:0 0 12px;font-size:17px">New PMR period</h2>' +
        '<div style="display:grid;gap:12px">' +
          '<div style="font-size:12px;color:#374151">Pick a semester:' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">' + chipHtml + '</div>' +
          '</div>' +
          '<label style="display:grid;gap:4px;font-size:12px;color:#374151">…or a custom period' +
            '<input type="text" class="pmr-np-slug" placeholder="e.g. summer-rotation → custom-summer-rotation" style="padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px">' +
          '</label>' +
          copyHtml +
          '<div class="pmr-np-status" style="font-size:12px;color:#991b1b;min-height:14px"></div>' +
          '<div style="display:flex;gap:8px;justify-content:flex-end">' +
            '<button type="button" class="pmr-np-cancel" style="font-size:13px;padding:7px 14px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer">Cancel</button>' +
            '<button type="button" class="pmr-np-create" style="font-size:13px;padding:7px 14px;border:1px solid #2563eb;border-radius:6px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer">Create</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    let pickedId = null;
    const slugInput = overlay.querySelector('.pmr-np-slug');
    overlay.querySelectorAll('.pmr-np-chip:not([disabled])').forEach(chip => {
      chip.addEventListener('click', () => {
        pickedId = chip.getAttribute('data-id');
        overlay.querySelectorAll('.pmr-np-chip').forEach(c => { c.style.background = '#fff'; c.style.color = ''; });
        chip.style.background = '#2563eb';
        chip.style.color = '#fff';
        slugInput.value = '';
      });
    });
    slugInput.addEventListener('input', () => {
      if (slugInput.value.trim()) {
        pickedId = null;
        overlay.querySelectorAll('.pmr-np-chip').forEach(c => { c.style.background = '#fff'; c.style.color = ''; });
      }
    });
    function dismiss() { overlay.remove(); }
    overlay.querySelector('.pmr-np-cancel').addEventListener('click', dismiss);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) dismiss(); });

    overlay.querySelector('.pmr-np-create').addEventListener('click', async () => {
      const statusEl = overlay.querySelector('.pmr-np-status');
      let id = pickedId;
      const slug = slugInput.value.trim();
      if (!id && slug) {
        id = 'custom-' + slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      }
      if (!id) { statusEl.textContent = 'Pick a semester chip or type a custom period name.'; return; }
      if ((state.indexDoc.periods || []).find(p => p.id === id)) {
        statusEl.textContent = 'That period already exists — pick it from the dropdown instead.';
        return;
      }
      const copyOpts = {};
      overlay.querySelectorAll('.pmr-np-copy:checked').forEach(cb => { copyOpts[cb.value] = true; });
      dismiss();
      await createPeriodGuided(id, latest ? latest.id : null, copyOpts);
    });
  }

  async function createPeriodGuided(id, sourceId, copyOpts) {
    const period = inferPeriodFromId(id);
    if (!state.indexDoc) state.indexDoc = { periods: [] };
    if (!state.indexDoc.periods.find(p => p.id === id)) {
      state.indexDoc.periods.push({ id: id, label: periodLabel(period), status: 'draft', updated_at: isoNow(), period: period });
    }
    await switchToPeriod(id);
    // Copy-forward from the most-recent period onto the fresh doc. Items
    // arrive with discussed_at reset so they land in the active lists.
    if (sourceId && copyOpts && Object.keys(copyOpts).length && state.doc) {
      try {
        const src = await loadPmrDoc(sourceId);
        if (src) {
          const clone = (v) => JSON.parse(JSON.stringify(v));
          if (copyOpts.goals && src.goals) state.doc.goals = clone(src.goals);
          if (copyOpts.project_overview && Array.isArray(src.project_overview)) {
            state.doc.project_overview = clone(src.project_overview);
            state.doc.project_overview.forEach(r => { if (r && 'discussed_at' in r) r.discussed_at = null; });
          }
          if (copyOpts.reference_links && Array.isArray(src.reference_links)) {
            state.doc.reference_links = clone(src.reference_links);
            state.doc.reference_links.forEach(r => { if (r && 'discussed_at' in r) r.discussed_at = null; });
          }
          // V3.322 review-fix — commit the copied sections immediately
          // rather than via the 400 ms debounce. switchToPeriod's auto-week
          // already armed a debounced save of the BLANK doc; if the user
          // closed the tab inside that window the copy would be lost. Cancel
          // the pending timer and save the merged doc directly (mirrors how
          // section reorders bypass the debounce).
          if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
          try { await saveDoc(); } catch (e) { console.warn('[pmr] copy-forward save failed:', e && e.message); }
          renderBody();
        }
      } catch (err) {
        console.warn('[pmr] copy-forward failed:', err && err.message);
      }
    }
  }

  /* ─────────────────────────────────────────────────────────────
   * Boot
   * ───────────────────────────────────────────────────────────── */
  function pickInitialPeriod() {
    // Prefer the most-recently-updated period; else current semester id.
    // V3.323 — land on a NON-archived period when one exists (fall back to
    // archived only if every period is archived), so archiving the newest
    // period doesn't keep re-selecting it on reload.
    const sorted = (state.indexDoc.periods || []).slice()
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    const idx = sorted.filter(p => !p.archived);
    const pick = idx[0] || sorted[0];
    if (pick) {
      state.currentPeriodId = pick.id;
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
      if (typeof firebridge === 'undefined' || !firebridge.requireSignIn) {
        document.getElementById('pmr-content').innerHTML = '<div class="pmr-empty">firebridge missing — load order issue.</div>';
        return;
      }
      const gate = await firebridge.requireSignIn('PMR is for lab members. Sign in with your @arizona.edu (or admin Google) account.');
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
        // V3.157 — paper drafts feed the new "Paper writing" block.
        loadPaperDraftsFor(state.user.uid),
        // V3.243 — mentee lookup so non-admin mentors get a rail.
        loadMyMentees(),
        // V3.517 — the signed-in user's own notebook index (cross-user
        // loads happen later via switchToUser when viewing a mentee).
        loadNotebookIndex(),
      ]);
      pickInitialPeriod();

      wireSubmitButton();
      wireNewPeriodButton();

      renderAll();
      await switchToPeriod(state.currentPeriodId);
      // V3.199 — live subscribe so a teammate's new task assignment
      // appears in the "📥 Assigned by teammates" group within seconds,
      // not on next 30-min cache TTL.
      attachAssignedTasksLiveSync();
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
