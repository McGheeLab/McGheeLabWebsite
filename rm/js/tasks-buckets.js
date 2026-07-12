/* tasks-buckets.js — Bucket + Subtask workspace (three-tier model).
 *
 * Reads/writes data/tasks/buckets.json.
 *
 * Schema (see scripts/migrate_inbox_to_buckets.py):
 *   { taskBuilders: [{ id, title, status, category, due_date, hours_estimate,
 *                  tracker_entry_id, evidence:{email_ids,event_ids,item_ids},
 *                  notes, created_at, completed_at, reserved?,
 *                  associated_categories?:[],   // V3.129
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
  const CAT_ORDER = YR.CAT_ORDER || ['research', 'service', 'teaching', 'admin', 'personal', 'noise', 'unknown'];
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
    activeTaskBuilderId: null,
    selectedNode: null,          // { kind, id, parentRef? } for detail pane
    searchQuery: '',
    showCompleted: localStorage.getItem(SHOW_COMPLETED_KEY) === '1',
    expandedBuckets: new Set(),  // bucket ids currently expanded
    expandedSubtasks: new Set(), // subtask ids whose children are visible
    expandedEdit: new Set(),     // subtask ids whose inline edit body is open
    collapsedTaskBuilders: new Set(),
    suggestedCollapsed: new Set(),  // task-builder ids whose Suggested-from-category panel is collapsed
    saveTimer: null,
  };

  /* ---------- io ----------
   * Routed through the firestore adapter (js/api-firestore-adapter.js +
   * js/api-routes.js) — `tasks/buckets.json` maps to userData/{uid}/buckets,
   * one Firestore doc per task builder. Multi-tenant isolation is enforced
   * by the adapter: each lab member's reads return their own buckets, not
   * Alex's.
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
    if (!state.doc.taskBuilders) state.doc.taskBuilders = [];
  }

  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    _savePending = true;
    state.saveTimer = setTimeout(() => saveDoc().catch(err => console.error('save failed', err)), 400);
  }

  var _lastSaveFailed = false; // V3.302 — gates the one-time "Saved" toast after a recovery

  async function saveDoc() {
    state.doc.updated_at = new Date().toISOString();
    _suppressUntil = Date.now() + 2500;
    state.saveTimer = null;
    try {
      await api.save(DATA_PATH, state.doc);
      _savePending = false;
      if (_lastSaveFailed) {
        _lastSaveFailed = false;
        if (window.TOAST) TOAST.success('Tasks saved');
      }
    } catch (err) {
      // Leave _savePending true so a subsequent edit (via scheduleSave) will
      // retry. If that never happens, the in-memory state is still preserved
      // until the user takes another action.
      console.error('[tasks-buckets] save failed:', err);
      // V3.302 — surface the failure instead of dying in the console; a
      // student typing on flaky wifi must know their edits aren't saved.
      _lastSaveFailed = true;
      if (window.TOAST) {
        TOAST.error('Task save failed — recent edits are NOT saved', {
          detail: err && err.message,
          retry: () => scheduleSave()
        });
      }
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
        if (!data || !Array.isArray(data.taskBuilders)) return;
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

  /* ---------- activity-tracker bridge ----------
   * When a subtask is marked done, fire tracker entries into
   * trackerEntries/{uid}/entries so the activity tracker (mirrored in
   * RM at /pages/activity-tracker.html) reflects the work.
   *
   * Idempotency: each entry's id goes into st.tracker_entry_ids[].
   * st.tracker_entry_id (singular) stays populated with the FIRST id
   * for back-compat with anything reading the older field.
   *
   * Modes:
   *   - opts.hours + opts.dates[]: explicit (from the time-log modal).
   *     Hours are split evenly across the dates; one tracker entry per
   *     date, duration = round(hours*60/N).
   *   - no opts: silent path. Uses st.hours_estimate * 60 minutes on
   *     today's date (st.worked_on_dates[] if set takes precedence).
   *     Skips silently when hours_estimate is missing/0 — the toggle
   *     handler is responsible for showing the modal in that case.
   *
   * Always best-effort: never throws into the toggle path. */
  async function logTaskCompletionToTracker(bucket, st, opts) {
    try {
      if (!st) return;
      // Idempotent: skip if any tracker entry already exists for this subtask.
      if (st.tracker_entry_id) return;
      if (st.tracker_entry_ids && st.tracker_entry_ids.length) return;
      if (typeof firebridge === 'undefined' || !firebridge.getUser) return;
      var u = firebridge.getUser();
      if (!u || !u.uid) return;

      var bucketCat = bucket && bucket.category ? String(bucket.category) : '';
      if (!bucketCat) return;
      var subPath = bucket && bucket.sub_category
        ? String(bucket.sub_category).split(':').filter(function (p) { return !!p; })
        : [];
      var categoryPath = [bucketCat].concat(subPath);

      // Resolve hours + dates — explicit opts beat schema fields beat defaults.
      var hours = (opts && opts.hours != null) ? Number(opts.hours) : Number(st.hours_estimate) || 0;
      if (!isFinite(hours) || hours <= 0) return;

      var dates = (opts && Array.isArray(opts.dates) && opts.dates.length) ? opts.dates.slice()
                : (Array.isArray(st.worked_on_dates) && st.worked_on_dates.length) ? st.worked_on_dates.slice()
                : [todayStr()];
      // Defensive: drop any falsy or duplicate, sort ascending.
      var seen = {};
      dates = dates.filter(function (d) { if (!d || seen[d]) return false; seen[d] = true; return true; }).sort();
      if (!dates.length) dates = [todayStr()];

      var title = String(st.text || '').trim();
      var desc  = String(st.description || '').trim();
      var text  = (desc && desc !== title) ? (title + ' — ' + desc) : title;

      var totalMins = Math.round(hours * 60);
      // Even split across days. Single-day case = full duration.
      var perDay = Math.max(1, Math.round(totalMins / dates.length));

      // Persist worked_on_dates so a future re-completion (e.g. after undo)
      // remembers the spread. Hours_estimate too if it wasn't set.
      st.worked_on_dates = dates.slice();
      if (!Number(st.hours_estimate)) st.hours_estimate = hours;

      var trackerRef = firebridge.db()
        .collection('trackerEntries').doc(u.uid)
        .collection('entries');

      var ids = [];
      for (var i = 0; i < dates.length; i++) {
        var entry = {
          date: dates[i],
          text: text,
          categoryPath: categoryPath,
          duration: perDay,
          milestone: 0,
          source: 'rm-task',
          original: {
            subtask_id: st.id || null,
            bucket_id: bucket.id || null,
            bucket_category: bucketCat,
            bucket_sub_category: bucket.sub_category || null,
            day_index: i,
            day_count: dates.length,
            total_hours: hours,
          },
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        };
        var ref = await trackerRef.add(entry);
        ids.push(ref.id);
      }
      st.tracker_entry_ids = ids;
      st.tracker_entry_id = ids[0]; // back-compat with any reader of the old singular field

      // Re-save once the tracker writes resolve so the new ids make it
      // into buckets.json — otherwise the next page load wouldn't know
      // we already logged this and we'd duplicate on re-toggle.
      if (typeof scheduleSave === 'function') scheduleSave();
    } catch (err) {
      console.warn('[tasks-buckets] tracker log failed:', err);
    }
  }

  /* V3.160 — fire a scheduled tracker entry when a subtask gets a real
   * due_date, or remove it when due_date goes back to TBD / blank.
   * Idempotent via ActivitySignals' deterministic doc id.
   * Best-effort: never throws into the edit path. */
  function pingScheduleForSubtask(bucket, st) {
    try {
      if (!window.ActivitySignals || !st || !bucket) return;
      // Done subtasks: no scheduled entry needed. Completion fires the
      // confirmed entry via logTaskCompletionToTracker.
      if (st.done) {
        window.ActivitySignals.removeSchedule({ kind: 'subtask', id: st.id });
        return;
      }
      if (!st.due_date || st.due_date === 'TBD') {
        window.ActivitySignals.removeSchedule({ kind: 'subtask', id: st.id });
        return;
      }
      var cat = bucket.category ? String(bucket.category) : '';
      var subPath = bucket.sub_category
        ? String(bucket.sub_category).split(':').filter(function (p) { return !!p; })
        : [];
      var categoryPath = cat ? [cat].concat(subPath) : [];
      window.ActivitySignals.recordSchedule({
        source: 'rm-task',
        sourceRef: { kind: 'subtask', id: st.id, path: 'tasks/buckets/' + (bucket.id || '') + '/' + st.id },
        date: st.due_date,
        text: st.text || '(subtask)',
        categoryPath: categoryPath,
        hoursEstimate: st.hours_estimate || null,
      });
    } catch (err) { console.warn('[tasks-buckets] pingScheduleForSubtask failed:', err); }
  }

  /* Dispatch a just-completed subtask through the tracker pipeline.
     Caller is responsible for having ALREADY mutated st.done = true and
     called scheduleSave/render — this is a follow-up that may either
     log silently, pop a modal to ask for hours/days, or revert the
     completion if the user cancels the modal. Best-effort; never
     throws. */
  async function handleSubtaskCompletion(bucket, st) {
    if (!shouldPromptForTime(bucket, st)) {
      logTaskCompletionToTracker(bucket, st);
      return;
    }
    try {
      var result = await promptTrackerTimeLog(st);
      if (result.action === 'log') {
        await logTaskCompletionToTracker(bucket, st, { hours: result.hours, dates: result.dates });
      } else if (result.action === 'cancel') {
        // Revert: caller optimistically marked done; user backed out.
        st.done = false;
        st.done_at = null;
        if (typeof scheduleSave === 'function') scheduleSave();
        render();
      }
      // 'skip' → leave as done, no tracker entry written.
    } catch (err) {
      console.warn('[tasks-buckets] completion modal failed:', err);
    }
  }

  /* True when the toggle handler should pop the time-log modal before
     completing the task: bucket has a category to log against AND no
     entry is already logged AND we don't have hours_estimate to use as
     a silent default. */
  function shouldPromptForTime(bucket, st) {
    if (!bucket || !bucket.category) return false;            // nowhere to log
    if (st.tracker_entry_id) return false;                    // already logged
    if (st.tracker_entry_ids && st.tracker_entry_ids.length) return false;
    if (Number(st.hours_estimate) > 0) return false;          // silent path
    return true;
  }

  /* Build + show the time-log modal. Returns a Promise resolving to:
       { action: 'log', hours, dates: [yyyy-mm-dd, ...] }
       { action: 'skip' }    — complete task, don't log to tracker
       { action: 'cancel' }  — un-complete the task (revert checkbox)
     Esc / click-outside / × button = cancel. The modal is appended to
     <body> so it floats above any page chrome. */
  function promptTrackerTimeLog(st) {
    return new Promise(function (resolve) {
      ensureTimeLogStyles();

      var back = document.createElement('div');
      back.className = 'tlog-back';

      var card = document.createElement('div');
      card.className = 'tlog-card';
      back.appendChild(card);

      var title = String(st.text || '').trim() || '(untitled task)';
      card.innerHTML =
        '<div class="tlog-head">' +
          '<h3>Log time to activity tracker</h3>' +
          '<button class="tlog-x" type="button" title="Cancel">×</button>' +
        '</div>' +
        '<p class="tlog-subtitle">' + escapeHtml(title) + '</p>' +
        '<div class="tlog-row">' +
          '<label>Hours worked</label>' +
          '<input type="number" id="tlog-hours" min="0" step="0.25" inputmode="decimal" autocomplete="off">' +
        '</div>' +
        '<div class="tlog-row tlog-row-dates">' +
          '<label>Day(s) worked on</label>' +
          '<div class="tlog-dates">' +
            '<input type="date" id="tlog-start">' +
            '<span class="tlog-arrow">→</span>' +
            '<input type="date" id="tlog-end">' +
          '</div>' +
          '<div class="tlog-hint" id="tlog-hint">single day</div>' +
        '</div>' +
        '<div class="tlog-actions">' +
          '<button type="button" class="btn btn-sm" id="tlog-skip">Skip — don\'t log</button>' +
          '<span class="tlog-spacer"></span>' +
          '<button type="button" class="btn btn-sm" id="tlog-cancel">Cancel</button>' +
          '<button type="button" class="btn btn-primary btn-sm" id="tlog-save">Log it</button>' +
        '</div>';

      document.body.appendChild(back);

      var hoursEl  = card.querySelector('#tlog-hours');
      var startEl  = card.querySelector('#tlog-start');
      var endEl    = card.querySelector('#tlog-end');
      var hintEl   = card.querySelector('#tlog-hint');

      var today = todayStr();
      startEl.value = today;
      endEl.value = today;

      // Prefill hours_estimate if non-zero (rare on this path but harmless).
      if (Number(st.hours_estimate) > 0) hoursEl.value = String(st.hours_estimate);
      setTimeout(function () { hoursEl.focus(); hoursEl.select(); }, 30);

      function dateRange(start, end) {
        var out = [];
        if (!start || !end) return out;
        var a = new Date(start + 'T00:00:00');
        var b = new Date(end + 'T00:00:00');
        if (b < a) return out;
        var d = new Date(a);
        var i = 0;
        while (d <= b && i < 366) {  // hard cap to avoid runaway loops
          out.push(d.toISOString().slice(0, 10));
          d.setDate(d.getDate() + 1);
          i++;
        }
        return out;
      }

      function refreshHint() {
        var s = startEl.value, e = endEl.value;
        var days = dateRange(s, e);
        if (!days.length) {
          hintEl.textContent = 'end date is before start date';
          hintEl.style.color = 'var(--red, #b91c1c)';
        } else if (days.length === 1) {
          hintEl.textContent = 'single day';
          hintEl.style.color = '';
        } else {
          var h = Number(hoursEl.value) || 0;
          var perDay = h ? (h / days.length) : 0;
          hintEl.textContent = days.length + ' days · ' + (h ? perDay.toFixed(2) + 'h each' : 'enter hours to see split');
          hintEl.style.color = '';
        }
      }
      hoursEl.addEventListener('input', refreshHint);
      startEl.addEventListener('change', function () {
        if (endEl.value < startEl.value) endEl.value = startEl.value;
        refreshHint();
      });
      endEl.addEventListener('change', refreshHint);
      refreshHint();

      var resolved = false;
      function close(result) {
        if (resolved) return;
        resolved = true;
        document.removeEventListener('keydown', onKey);
        if (back.parentNode) back.parentNode.removeChild(back);
        resolve(result);
      }
      function onKey(ev) {
        if (ev.key === 'Escape') close({ action: 'cancel' });
        else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) trySave();
      }
      document.addEventListener('keydown', onKey);

      function trySave() {
        var h = Number(hoursEl.value);
        if (!isFinite(h) || h <= 0) {
          hoursEl.classList.add('tlog-invalid');
          hoursEl.focus();
          return;
        }
        var days = dateRange(startEl.value, endEl.value);
        if (!days.length) {
          hintEl.style.color = 'var(--red, #b91c1c)';
          return;
        }
        close({ action: 'log', hours: h, dates: days });
      }

      card.querySelector('#tlog-save').addEventListener('click', trySave);
      card.querySelector('#tlog-skip').addEventListener('click', function () { close({ action: 'skip' }); });
      card.querySelector('#tlog-cancel').addEventListener('click', function () { close({ action: 'cancel' }); });
      card.querySelector('.tlog-x').addEventListener('click', function () { close({ action: 'cancel' }); });
      back.addEventListener('click', function (ev) { if (ev.target === back) close({ action: 'cancel' }); });
    });
  }

  /* Inject the time-log modal styles once per page. */
  var _tlogStylesInjected = false;
  function ensureTimeLogStyles() {
    if (_tlogStylesInjected) return;
    _tlogStylesInjected = true;
    var s = document.createElement('style');
    s.textContent =
      '.tlog-back{position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:1000;display:flex;align-items:center;justify-content:center;animation:tlogfade .12s ease-out}' +
      '@keyframes tlogfade{from{opacity:0}to{opacity:1}}' +
      '.tlog-card{background:var(--surface,#fff);border-radius:10px;min-width:380px;max-width:520px;width:92vw;padding:18px 22px;box-shadow:0 20px 48px rgba(0,0,0,.25);font-family:inherit}' +
      '.tlog-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 4px 0}' +
      '.tlog-card h3{margin:0;font-size:15px}' +
      '.tlog-x{background:transparent;border:none;font-size:22px;line-height:1;cursor:pointer;color:var(--text-muted,#6b7280);padding:0 4px}' +
      '.tlog-x:hover{color:var(--text,#1f2937)}' +
      '.tlog-subtitle{font-size:12.5px;color:var(--text-muted,#6b7280);margin:0 0 14px 0;font-style:italic;overflow-wrap:anywhere}' +
      '.tlog-row{margin-bottom:12px}' +
      '.tlog-row label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted,#6b7280);font-weight:600;margin-bottom:4px}' +
      '.tlog-row input[type=number],.tlog-row input[type=date]{padding:6px 10px;border:1px solid var(--border,#e1e4e8);border-radius:6px;font-size:13px;font-family:inherit;background:var(--surface,#fff);color:var(--text,#1f2937)}' +
      '.tlog-row input[type=number]{width:120px}' +
      '.tlog-row input[type=date]{width:160px}' +
      '.tlog-row input.tlog-invalid{border-color:var(--red,#dc2626);box-shadow:0 0 0 2px rgba(220,38,38,.15)}' +
      '.tlog-dates{display:flex;align-items:center;gap:8px}' +
      '.tlog-arrow{color:var(--text-muted,#6b7280);font-size:14px}' +
      '.tlog-hint{margin-top:6px;font-size:12px;color:var(--text-muted,#6b7280)}' +
      '.tlog-actions{display:flex;align-items:center;gap:8px;margin-top:18px}' +
      '.tlog-spacer{flex:1}';
    document.head.appendChild(s);
  }


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
        .filter(function (u) { return ASSIGNEE_CATEGORIES.indexOf(u.category) !== -1 && LAB_USERS.isVisible(u); })
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

  function findTaskBuilder(pid) {
    return (state.doc.taskBuilders || []).find(p => p.id === pid);
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

  /* ---------- V3.129: associated categories ---------- */
  function getAssociatedCats(tb) {
    return new Set(Array.isArray(tb.associated_categories) ? tb.associated_categories : []);
  }
  function setAssociatedCat(tb, cat, on) {
    const cur = new Set(Array.isArray(tb.associated_categories) ? tb.associated_categories : []);
    if (on) cur.add(cat); else cur.delete(cat);
    tb.associated_categories = [...cur];
    scheduleSave();
  }
  // Walks every task-builder → bucket → subtask tree and yields proposed:true
  // rows whose containing bucket's category is in `catSet`. Excludes any
  // subtask already living inside the *current* task-builder so the panel
  // doesn't suggest tasks that are already there.
  function walkProposedByCats(catSet, excludeTaskBuilderId) {
    const out = [];
    for (const p of state.doc.taskBuilders || []) {
      if (p.id === excludeTaskBuilderId) continue;
      for (const b of p.buckets || []) {
        const cat = b.category || 'unknown';
        if (!catSet.has(cat)) continue;
        function visit(arr, parentPath) {
          for (const st of arr || []) {
            if (st.proposed) {
              out.push({ subtask: st, bucket: b, project: p, parentPath });
            }
            if ((st.children || []).length) visit(st.children, parentPath.concat(st.text || ''));
          }
        }
        visit(b.subtasks, []);
      }
    }
    return out;
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
  function rollupTaskBuilder(project) {
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
    for (const p of state.doc.taskBuilders || []) {
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
    wrap.appendChild(renderTaskBuildersCol());
    wrap.appendChild(renderMain());
    if (state.selectedNode) wrap.appendChild(renderDetail());
    return wrap;
  }

  /* ----- task-builder column ----- */
  function renderTaskBuildersCol() {
    const col = document.createElement('div');
    col.className = 'buk-proj-col';
    const projects = state.doc.taskBuilders || [];
    for (const p of projects) {
      const row = document.createElement('div');
      row.className = 'buk-proj-row' + (p.id === state.activeTaskBuilderId ? ' active' : '') + (p.reserved ? ' reserved' : '');
      const dot = document.createElement('span');
      dot.className = 'buk-proj-dot';
      dot.style.background = CAT_COLOR[p.category] || '#9ca3af';
      row.appendChild(dot);
      const title = document.createElement('span');
      title.className = 'buk-proj-title';
      title.textContent = p.title;
      row.appendChild(title);
      const r = rollupTaskBuilder(p);
      const count = document.createElement('span');
      count.className = 'buk-proj-count';
      count.textContent = r.open ? `${r.open}` : '';
      row.appendChild(count);
      row.addEventListener('click', () => {
        state.activeTaskBuilderId = p.id;
        state.searchQuery = '';
        state.selectedNode = null;
        state.expandedBuckets = new Set();   // start fresh — all sub-buckets collapsed
        state.expandedSubtasks = new Set();
        render();
      });
      col.appendChild(row);
    }
    // Add task builder
    const add = document.createElement('div');
    add.className = 'buk-proj-new';
    const inp = document.createElement('input');
    inp.placeholder = '+ New task builder';
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && inp.value.trim()) {
        const title = inp.value.trim();
        const id = `proj-${slugify(title)}-${Date.now().toString(36)}`;
        state.doc.taskBuilders.push({
          id, title, status: 'active', category: '',
          due_date: 'TBD', hours_estimate: 0, tracker_entry_id: null,
          evidence: emptyEvidence(), notes: '',
          created_at: todayStr(), completed_at: null, buckets: [],
        });
        state.activeTaskBuilderId = id;
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
      const p = findTaskBuilder(state.activeTaskBuilderId);
      if (!p) {
        const hint = document.createElement('div');
        hint.className = 'buk-search-empty';
        hint.textContent = 'Pick a task builder from the left, or create a new one.';
        main.appendChild(hint);
      } else {
        main.appendChild(renderTaskBuilderHead(p));
        // V3.234 — external links block (Synology share URLs etc), scoped
        // to the project bucket (tier 1). Hidden on the inbox builder.
        if (!p.reserved) main.appendChild(renderExternalLinksBlock(p));
        // V3.129 — suggestions from associated categories sit between the head
        // and the buckets list. No-op when no categories are associated.
        const sugg = renderSuggestedFromCategories(p);
        if (sugg) main.appendChild(sugg);
        // V3.187 — split active vs archived. Archived render in a collapsed
        // section at the bottom of the task builder so completed work stays
        // accessible without cluttering the active list.
        const archivedHere = [];
        for (const b of p.buckets || []) {
          if (b.archived) { archivedHere.push(b); continue; }
          // Hide buckets that have no visible subtasks (after the show-completed filter)
          if (!state.showCompleted) {
            const anyOpen = bucketHasOpenSubtask(b);
            if (!anyOpen) continue;
          }
          main.appendChild(renderBucket(p, b));
        }
        main.appendChild(renderAddBucket(p));
        if (archivedHere.length) {
          main.appendChild(renderArchivedBucketsForProject(p, archivedHere));
        }
      }
    }
    return main;
  }

  /* V3.187 — Archived-buckets collapsed section per task builder. Restore
   * flips `bucket.archived` back to false (and clears completed_at) so the
   * bucket reappears in the active list. Subtask state is preserved.
   */
  function renderArchivedBucketsForProject(project, archivedBuckets) {
    const det = document.createElement('details');
    det.className = 'buk-archived-section';
    det.style.cssText = 'margin-top:14px;padding:8px 10px;background:#f9fafb;border:1px dashed #d1d5db;border-radius:6px';
    const sum = document.createElement('summary');
    sum.style.cssText = 'cursor:pointer;font-size:12px;color:#4b5563;font-weight:600';
    sum.textContent = 'Archived buckets (' + archivedBuckets.length + ')';
    det.appendChild(sum);
    archivedBuckets
      .slice()
      .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''))
      .forEach(b => det.appendChild(renderArchivedBucketRow(project, b)));
    return det;
  }

  function renderArchivedBucketRow(project, bucket) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:12px;color:#374151';
    const title = document.createElement('span');
    title.textContent = bucket.title || '(untitled bucket)';
    title.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500';
    row.appendChild(title);
    if (bucket.sub_category) {
      const sub = document.createElement('span');
      sub.textContent = bucket.sub_category;
      sub.style.cssText = 'font-size:10px;color:#9ca3af';
      row.appendChild(sub);
    }
    const when = document.createElement('span');
    when.textContent = bucket.completed_at ? 'completed ' + String(bucket.completed_at).slice(0, 10) : 'archived';
    when.style.cssText = 'font-size:10px;color:#6b7280;font-variant-numeric:tabular-nums';
    row.appendChild(when);
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.textContent = '↶ restore';
    restore.title = 'Move this bucket back to the active list';
    restore.style.cssText = 'font-size:10px;padding:2px 8px;border:1px solid #d1d5db;border-radius:4px;background:#fff;cursor:pointer;color:#374151';
    restore.addEventListener('click', () => {
      bucket.archived = false;
      bucket.completed_at = null;
      scheduleSave();
      render();
    });
    row.appendChild(restore);
    return row;
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
    hint.textContent = state.searchQuery ? '(across all task builders)' : '';
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
        state.activeTaskBuilderId = row.project.id;
        state.searchQuery = '';
        state.expandedBuckets.add(row.bucket.id);
        for (const a of row.path) state.expandedSubtasks.add(a.id);
        state.selectedNode = { kind: 'subtask', taskBuilderId: row.project.id, bucketId: row.bucket.id, subtaskId: row.subtask.id };
        render();
      });
      box.appendChild(item);
    }
    return box;
  }

  function renderTaskBuilderHead(p) {
    const head = document.createElement('div');
    head.className = 'buk-proj-head';
    const h2 = document.createElement('h2');
    h2.textContent = p.title;
    h2.title = 'Double-click to rename';
    h2.style.cursor = 'text';
    h2.addEventListener('dblclick', async () => {
      const v = window.RM_DIALOG
        ? await RM_DIALOG.prompt({ title: 'Rename task builder', value: p.title, okText: 'Rename' })
        : prompt('Task builder title:', p.title);
      if (v != null && v.trim()) { p.title = v.trim(); scheduleSave(); render(); }
    });
    head.appendChild(h2);
    const r = rollupTaskBuilder(p);
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
    linkBtn.title = 'Edit task builder metadata';
    linkBtn.addEventListener('click', () => {
      state.selectedNode = { kind: 'task_builder', taskBuilderId: p.id };
      render();
    });
    head.appendChild(linkBtn);

    // V3.129 — associated category chips. A second row underneath the title +
    // rollup. Toggling a chip adds/removes it from p.associated_categories;
    // the suggested panel below the head reads the same set.
    head.appendChild(renderCatChipsRow(p));
    return head;
  }

  /* V3.234 — External links block (Synology share URLs etc), scoped to
   * the project bucket (tier 1). Reuses the shared EXTERNAL_LINKS helper
   * in rm/js/external-links.js. */
  function renderExternalLinksBlock(tb) {
    const host = document.createElement('div');
    host.className = 'buk-ext-links';
    if (!window.EXTERNAL_LINKS) return host;
    if (!Array.isArray(tb.externalLinks)) tb.externalLinks = [];
    window.EXTERNAL_LINKS.mount({
      container: host,
      getLinks: function () { return tb.externalLinks || []; },
      setLinks: function (next) {
        tb.externalLinks = next;
        scheduleSave();
      },
      readOnly: false,
    });
    return host;
  }

  function renderCatChipsRow(tb) {
    const row = document.createElement('div');
    row.className = 'tb-cat-chips';
    const lbl = document.createElement('span');
    lbl.className = 'tb-cat-chips-label';
    lbl.textContent = 'Categories:';
    row.appendChild(lbl);
    const active = getAssociatedCats(tb);
    for (const c of CAT_ORDER) {
      const chip = document.createElement('button');
      const on = active.has(c);
      chip.className = 'tb-cat-chip' + (on ? ' on' : '');
      chip.style.background = on ? (CAT_COLOR[c] || '#6b7280') : '#f3f4f6';
      chip.style.color = on ? '#fff' : '#374151';
      chip.style.borderColor = on ? (CAT_COLOR[c] || '#6b7280') : '#d1d5db';
      chip.textContent = CAT_LABEL[c] || c;
      chip.title = on ? `Stop suggesting ${CAT_LABEL[c] || c} tasks` : `Suggest ${CAT_LABEL[c] || c} tasks here`;
      chip.addEventListener('click', () => {
        setAssociatedCat(tb, c, !on);
        render();
      });
      row.appendChild(chip);
    }
    return row;
  }

  function bucketHasOpenSubtask(bucket) {
    let any = false;
    walkSubtasks(bucket, (st) => { if (!st.done) any = true; });
    return any;
  }

  /* ---------- V3.129: suggested-from-category panel ---------- */
  function renderSuggestedFromCategories(tb) {
    const cats = getAssociatedCats(tb);
    if (!cats.size) return null;
    const rows = walkProposedByCats(cats, tb.id);

    const acc = document.createElement('div');
    const collapsed = state.suggestedCollapsed.has(tb.id);
    acc.className = 'buk-accordion tb-suggested' + (collapsed ? ' collapsed' : '');

    const head = document.createElement('div');
    head.className = 'buk-accordion-head tb-suggested-head';
    head.innerHTML = `<span class="buk-caret">${collapsed ? '▸' : '▾'}</span>`;
    const title = document.createElement('span');
    title.className = 'buk-accordion-title';
    const catList = [...cats].map(c => CAT_LABEL[c] || c).join(', ');
    title.textContent = `Suggested from ${catList}`;
    head.appendChild(title);
    const pill = document.createElement('span');
    pill.className = 'buk-rollup-pill';
    pill.textContent = rows.length ? `${rows.length} proposed` : 'none';
    head.appendChild(pill);
    head.addEventListener('click', (ev) => {
      if (ev.target.closest('button, input')) return;
      if (state.suggestedCollapsed.has(tb.id)) state.suggestedCollapsed.delete(tb.id);
      else state.suggestedCollapsed.add(tb.id);
      render();
    });
    acc.appendChild(head);

    const body = document.createElement('div');
    body.className = 'buk-accordion-body tb-suggested-body';
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'tb-suggested-empty';
      empty.textContent = 'No proposed subtasks in the selected categories. New email/calendar suggestions land here once classified.';
      body.appendChild(empty);
    } else {
      for (const row of rows) body.appendChild(renderProposedRow(row, tb));
    }
    acc.appendChild(body);
    return acc;
  }

  function renderProposedRow(row, tb) {
    const r = document.createElement('div');
    r.className = 'tb-suggested-row';
    const dot = document.createElement('span');
    dot.className = 'inbox-dot';
    dot.style.background = CAT_COLOR[row.bucket.category] || '#9ca3af';
    r.appendChild(dot);
    const main = document.createElement('div');
    main.className = 'tb-suggested-main';
    const title = document.createElement('div');
    title.className = 'tb-suggested-title';
    title.textContent = row.subtask.text || '(untitled)';
    main.appendChild(title);
    const crumb = document.createElement('div');
    crumb.className = 'tb-suggested-crumb';
    const parts = [row.project.title, row.bucket.title];
    if (row.parentPath && row.parentPath.length) parts.push('… ' + row.parentPath.join(' › '));
    crumb.textContent = parts.join(' › ');
    main.appendChild(crumb);
    r.appendChild(main);
    const meta = document.createElement('div');
    meta.className = 'tb-suggested-meta';
    if (row.subtask.due_date && row.subtask.due_date !== 'TBD') {
      const due = document.createElement('span');
      due.className = 'inbox-chip';
      due.textContent = String(row.subtask.due_date).slice(5);
      meta.appendChild(due);
    }
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-sm btn-primary';
    addBtn.textContent = '+ add to…';
    addBtn.title = `Add this subtask to "${tb.title}"`;
    addBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openAddToTaskBuilderMenu(addBtn, row, tb);
    });
    meta.appendChild(addBtn);
    r.appendChild(meta);
    return r;
  }

  // Lightweight version of openPinMenu, scoped to a specific destination
  // task-builder. Lists the destination's existing sub-buckets plus a
  // "+ new sub-bucket" entry; selecting one calls moveNodeTo.
  function openAddToTaskBuilderMenu(anchor, row, tb) {
    closePinMenu();
    const menu = document.createElement('div');
    menu.className = 'buk-pin-menu';
    menu.id = 'buk-pin-menu';
    const rect = anchor.getBoundingClientRect();
    menu.style.left = (rect.left + window.scrollX) + 'px';
    menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';

    const header = document.createElement('div');
    header.className = 'pin-group';
    header.textContent = `Add to "${tb.title}"`;
    menu.appendChild(header);

    const newOpt = document.createElement('div');
    newOpt.className = 'pin-opt';
    newOpt.style.fontWeight = '700';
    newOpt.style.color = '#1e40af';
    newOpt.textContent = '+ New sub-bucket…';
    newOpt.addEventListener('click', async () => {
      const title = window.RM_DIALOG
        ? await RM_DIALOG.prompt({ title: 'New sub-bucket', placeholder: 'Sub-bucket name', okText: 'Create' })
        : prompt('New sub-bucket name:');
      if (!title || !title.trim()) return;
      const bucket = {
        id: `buk-${slugify(tb.id)}-${slugify(title.trim())}-${Date.now().toString(36)}`,
        category: row.bucket.category || tb.category || '',
        sub_category: row.bucket.sub_category || '',
        title: title.trim(),
        due_date: 'TBD', hours_estimate: 0, tracker_entry_id: null,
        evidence: emptyEvidence(), notes: '', subtasks: [],
      };
      tb.buckets = tb.buckets || [];
      tb.buckets.push(bucket);
      moveNodeTo(row.subtask, row.bucket, tb, bucket);
      closePinMenu();
    });
    menu.appendChild(newOpt);

    const buckets = tb.buckets || [];
    if (!buckets.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:10px;font-size:11px;color:#9ca3af;text-align:center';
      empty.textContent = 'No sub-buckets yet — create one above.';
      menu.appendChild(empty);
    } else {
      const existingHdr = document.createElement('div');
      existingHdr.className = 'pin-group';
      existingHdr.style.marginTop = '4px';
      existingHdr.textContent = 'Sub-buckets';
      menu.appendChild(existingHdr);
      for (const b of buckets) {
        const opt = document.createElement('div');
        opt.className = 'pin-opt';
        const catChip = b.category ? `<span class="buk-cat-chip" style="background:${CAT_COLOR[b.category] || '#6b7280'}">${escapeHtml((CAT_LABEL[b.category] || b.category).slice(0, 8))}</span> ` : '';
        opt.innerHTML = `${catChip}${escapeHtml(b.title)}${b.sub_category ? ` <span style="color:#9ca3af;font-size:11px">${escapeHtml(b.sub_category)}</span>` : ''}`;
        opt.addEventListener('click', () => {
          moveNodeTo(row.subtask, row.bucket, tb, b);
          closePinMenu();
        });
        menu.appendChild(opt);
      }
    }
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', pinMenuOutside, { once: true }), 0);
  }

  // V3.317 — market mini-menu on a subtask row: Offer to market (anyone
  // claims) or Ask for help (directed handoff). Both route to
  // TASK_MARKET.openComposer with the subtask prefilled + source_ref
  // {projectId, bucketId, subtaskId} so a claim can be traced back here.
  function openMarketMenu(anchor, st, project, bucket) {
    closePinMenu();
    if (!window.TASK_MARKET || typeof TASK_MARKET.openComposer !== 'function') {
      if (window.TOAST) TOAST.error('Task market module not loaded'); else alert('Task market module not loaded');
      return;
    }
    const menu = document.createElement('div');
    menu.className = 'buk-pin-menu';
    menu.id = 'buk-pin-menu';
    const rect = anchor.getBoundingClientRect();
    menu.style.left = (rect.left + window.scrollX) + 'px';
    menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';

    const header = document.createElement('div');
    header.className = 'pin-group';
    header.textContent = 'Task market';
    menu.appendChild(header);

    const prefillBase = {
      title: st.text || '(untitled)',
      description: st.notes || '',
      due: (st.due_date && st.due_date !== 'TBD') ? st.due_date : '',
      source_ref: { projectId: project.id, bucketId: bucket.id, subtaskId: st.id },
    };
    const offerOpt = document.createElement('div');
    offerOpt.className = 'pin-opt';
    offerOpt.textContent = '📋 Offer to market…';
    offerOpt.addEventListener('click', () => {
      closePinMenu();
      TASK_MARKET.openComposer(Object.assign({ kind: 'offer', heading: 'Offer this task to the lab' }, prefillBase));
    });
    menu.appendChild(offerOpt);

    const helpOpt = document.createElement('div');
    helpOpt.className = 'pin-opt';
    helpOpt.textContent = '🤝 Ask a teammate for help…';
    helpOpt.addEventListener('click', () => {
      closePinMenu();
      TASK_MARKET.openComposer(Object.assign({
        kind: 'handoff',
        heading: 'Ask a teammate for help',
        title: 'Help with: ' + (st.text || '(untitled)'),
      }, prefillBase, { title: 'Help with: ' + (st.text || '(untitled)') }));
    });
    menu.appendChild(helpOpt);

    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', pinMenuOutside, { once: true }), 0);
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

    // V3.187 — "Mark complete" button visible when every subtask is done.
    // Sets bucket.archived = true + completed_at = now, then re-renders so
    // the bucket drops into the Archived section below.
    if (r.open === 0 && r.done > 0 && !bucket.archived) {
      const mark = document.createElement('button');
      mark.type = 'button';
      mark.textContent = '✓ Mark complete';
      mark.title = 'Archive this bucket — every subtask is done.';
      mark.style.cssText = 'font-size:11px;padding:3px 8px;border:1px solid #16a34a;color:#fff;background:#16a34a;border-radius:4px;cursor:pointer;font-weight:600;margin-left:6px';
      mark.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!confirm('Archive bucket "' + (bucket.title || bucket.id) + '"? You can restore it from the Archived buckets section.')) return;
        bucket.archived = true;
        bucket.completed_at = new Date().toISOString();
        scheduleSave();
        render();
      });
      head.appendChild(mark);
    }

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
      inp.addEventListener('change', () => {
        st.due_date = inp.value || 'TBD';
        scheduleSave();
        pingScheduleForSubtask(bucket, st);
        render();
      });
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
        // Tracker dispatch: silent log when hours_estimate is set, else
        // pops the time-log modal. Modal can also revert the completion.
        handleSubtaskCompletion(bucket, st);
        // V3.194 — propagate to PMR weekly items.
        if (window.TASK_PMR_SYNC) TASK_PMR_SYNC.syncSubtaskDoneToPMR(st.id, true).catch(function () {});
      });
      actions.appendChild(complete);
    } else {
      const undo = document.createElement('button');
      undo.className = 'btn btn-primary btn-sm';
      undo.textContent = '↶ Undo completion';
      undo.addEventListener('click', () => {
        st.done = false; st.done_at = null;
        scheduleSave(); render();
        // V3.194 — propagate undo to PMR weekly items.
        if (window.TASK_PMR_SYNC) TASK_PMR_SYNC.syncSubtaskDoneToPMR(st.id, false).catch(function () {});
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
      if (cb.checked) handleSubtaskCompletion(bucket, st);
      // V3.194 — mirror the done flag to any PMR weekly-entry items that
      // reference this subtask via source_subtask_id. Fire-and-forget;
      // the PMR live-sync onSnapshot picks it up if the page is open.
      if (window.TASK_PMR_SYNC) {
        TASK_PMR_SYNC.syncSubtaskDoneToPMR(st.id, cb.checked).catch(function () {});
      }
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
        state.selectedNode = { kind: 'subtask', taskBuilderId: project.id, bucketId: bucket.id, subtaskId: st.id };
        render();
      });
      row.appendChild(c);
    }

    // add-to-task-builder button (always shown — moves/pins this subtask onto the dashboard)
    const pinBtn = document.createElement('button');
    pinBtn.className = 'btn btn-sm';
    pinBtn.style.padding = '0 8px';
    pinBtn.style.background = '#dbeafe';
    pinBtn.style.borderColor = '#93c5fd';
    pinBtn.style.color = '#1e40af';
    pinBtn.textContent = '→ task builder';
    pinBtn.title = 'Add this task to a task builder on the dashboard';
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPinMenu(pinBtn, st, project, bucket);
    });
    row.appendChild(pinBtn);

    // V3.194 — Add-to-PMR button. Pushes a copy of this subtask into the
    // current week of the user's most-recent PMR period (auto-creating
    // the week if needed). Idempotent: re-clicking on a subtask that's
    // already linked just toasts "already in this week".
    const pmrBtn = document.createElement('button');
    pmrBtn.className = 'btn btn-sm';
    pmrBtn.style.padding = '0 8px';
    pmrBtn.style.background = '#f5f3ff';
    pmrBtn.style.borderColor = '#c4b5fd';
    pmrBtn.style.color = '#5b21b6';
    pmrBtn.textContent = '＋ PMR';
    pmrBtn.title = 'Add this task to the current week of your PMR';
    pmrBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!window.TASK_PMR_SYNC) {
        if (window.TOAST) TOAST.error('PMR sync module not loaded'); else alert('PMR sync module not loaded');
        return;
      }
      pmrBtn.disabled = true;
      const result = await TASK_PMR_SYNC.addSubtaskToCurrentWeek(st, project, bucket);
      pmrBtn.disabled = false;
      if (result.ok) {
        if (window.TOAST) TOAST.success(result.message, { ttl: 2500 });
      } else {
        if (window.TOAST) TOAST.info(result.message, { ttl: 3500 });
        else alert(result.message);
      }
    });
    row.appendChild(pmrBtn);

    // V3.317 — offer this subtask to the task marketplace or ask a
    // teammate for help on it. Opens a mini-menu → the market composer
    // (task-market.js is loaded by tasks.html in embedded, composer-only
    // mode) prefilled with the subtask + source_ref backrefs.
    const mktBtn = document.createElement('button');
    mktBtn.className = 'btn btn-sm';
    mktBtn.style.padding = '0 8px';
    mktBtn.style.background = '#fef3c7';
    mktBtn.style.borderColor = '#fcd34d';
    mktBtn.style.color = '#92400e';
    mktBtn.textContent = '⇄ market';
    mktBtn.title = 'Offer this task to the lab or ask a teammate for help';
    mktBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMarketMenu(mktBtn, st, project, bucket);
    });
    row.appendChild(mktBtn);

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

  async function promptAddChild(parentNode) {
    const text = window.RM_DIALOG
      ? await RM_DIALOG.prompt({ title: 'Add child subtask', placeholder: 'Subtask text', okText: 'Add' })
      : prompt('Child subtask text:');
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
    project = findTaskBuilder(sel.taskBuilderId);
    if (!project) { pane.innerHTML += '<p>Task builder not found.</p>'; return pane; }
    if (kind === 'task_builder') {
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
      node.due_date = v || 'TBD';
      scheduleSave();
      if (kind === 'subtask') pingScheduleForSubtask(bucket, node);
      render();
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

    // pin/move to a task-builder bucket (shown for every subtask, not just proposed)
    if (kind === 'subtask') {
      const pinBtn = document.createElement('button');
      pinBtn.className = 'btn btn-primary btn-sm';
      pinBtn.style.marginTop = '8px';
      pinBtn.textContent = node.proposed ? 'Pin to task builder…' : 'Move to task builder…';
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
      else if (kind === 'task_builder') state.doc.taskBuilders = state.doc.taskBuilders.filter(x => x.id !== node.id);
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
    header.textContent = 'Add to task builder on dashboard';
    menu.appendChild(header);

    // "New task builder" entry — always at top
    const newOpt = document.createElement('div');
    newOpt.className = 'pin-opt';
    newOpt.style.fontWeight = '700';
    newOpt.style.color = '#1e40af';
    newOpt.textContent = '+ New task builder…';
    newOpt.addEventListener('click', async () => {
      const title = window.RM_DIALOG
        ? await RM_DIALOG.prompt({ title: 'New task builder', placeholder: 'Task builder name', okText: 'Create' })
        : prompt('New task builder name:');
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
      state.doc.taskBuilders.push(proj);
      moveNodeTo(node, fromBucket, proj, proj.buckets[0]);
      closePinMenu();
    });
    menu.appendChild(newOpt);

    // Existing dashboard-visible task builders only
    const hidden = dashHiddenSet();
    const visible = (state.doc.taskBuilders || [])
      .filter(p => p.id !== 'proj-inbox' && !hidden.has(p.id));
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:10px;font-size:11px;color:#9ca3af;text-align:center';
      empty.textContent = 'No task builders on the dashboard yet.';
      menu.appendChild(empty);
    } else {
      const existingHdr = document.createElement('div');
      existingHdr.className = 'pin-group';
      existingHdr.style.marginTop = '4px';
      existingHdr.textContent = 'Existing task builders';
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
    state.activeTaskBuilderId = toProject.id;
    state.expandedBuckets.add(toBucket.id);
    state.selectedNode = { kind: 'subtask', taskBuilderId: toProject.id, bucketId: toBucket.id, subtaskId: node.id };
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
      // Default to first non-inbox task builder
      if (!state.activeTaskBuilderId) {
        const firstNonInbox = (state.doc.taskBuilders || []).find(p => p.id !== 'proj-inbox');
        state.activeTaskBuilderId = firstNonInbox ? firstNonInbox.id : (state.doc.taskBuilders[0] && state.doc.taskBuilders[0].id);
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
