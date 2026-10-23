/* my-week.js — My Week: the unified student entry surface.
 *
 * V3.526 program: composer + fan-out via window.DAY_DISTRIBUTE (huddle,
 * equipment, notebook, tracker, task), pending confirmations, week
 * glance, prefs (V3.529), URL prefill (?compose=1&title=&type=&date=).
 *
 * V3.536–V3.541 Weekly Focus program:
 *  - "This week's focus" panel (mentor↔mentee focus areas via
 *    window.FOCUS_AREAS): status chips, tasks-under-focus quick-plan,
 *    Report button (outcome + lab-notebook entry as the narrative).
 *  - The composer is now an INGREDIENT builder: 🎯 Weekly focus,
 *    📋 Protocol, 🔬 Equipment, ✅ Task toggle and STACK on one
 *    plan-of-action item (title ghost-suggested from the combo).
 *    Meeting / Reading / Order / Help stay simple standalone types.
 *    Hierarchy is kept explicit: a FOCUS contains TASKS — the task
 *    picker lists this week's focus tasks first, grouped under their
 *    focus, and picking one auto-attaches the parent focus.
 *  - Equipment time is picked by DRAGGING on a stacked 7-day
 *    availability strip (existing bookings gray, posted window hatched,
 *    15-minute snap); the date/time inputs stay in sync as fine-tune.
 *
 * V3.623 Outcomes: every done/skipped item takes an OUTCOME — a result
 * (✅ + optional image/notebook links), a barrier (🚧 the reason), or a
 * no-result (◌). Recorded anytime via the ◇ chip or the standing
 * "N steps need outcomes" nudge; ✗ Skipped opens the dialog with barrier
 * preselected. "↻ Follow up next week" spawns a chained planned item
 * (follow_up_of backref). The PMR ledger (V3.624) reads all of it.
 *
 * V3.853 Every step ends in a RESULT. ✓ / "Did it" / "Skipped" open the
 * outcome dialog FIRST and the status flips when the outcome saves
 * (DD.saveOutcome closeAs); Cancel leaves the step planned. A result is
 * evidence: a SPECIFIC card on one of my figure boards or in my notebook
 * — chosen by EDIT TIME, i.e. cards touched since the step was planned
 * (outcome.links[] kind 'figure_board_item' → figure-board.html?paper=&item=,
 * 'notebook_item' → notebook.html?entry=&item=; the hosts centre + pulse
 * the card) — or an image, or a sentence; at least one. A barrier needs
 * its reason. The nudge counts done/skipped-without-result the same day,
 * four weeks back.
 *
 * Data: userData/{uid}/dayPlans/{itemId} via DAY_DISTRIBUTE helpers;
 * focus areas at userData/{uid}/focusAreas via FOCUS_AREAS.
 */
(function () {
  'use strict';

  var DD = null; // window.DAY_DISTRIBUTE
  var FA = null; // window.FOCUS_AREAS

  var INGREDIENTS = [
    { key: 'focus',     icon: 'target', label: 'Weekly focus' },
    { key: 'protocol',  icon: 'clipboard-document-list', label: 'Protocol' },
    { key: 'equipment', icon: 'microscope', label: 'Equipment' },
    { key: 'task',      icon: 'check-circle', label: 'Task' },
  ];
  var SIMPLE_TYPES = [
    { key: 'meeting', icon: 'users', label: 'Meeting' },
    { key: 'reading', icon: 'book-open', label: 'Reading' },
    { key: 'order',   icon: 'shopping-cart', label: 'Order' },
    { key: 'help',    icon: 'lifebuoy', label: 'Help' },
  ];
  var TYPE_ICONS = { work: 'target', equipment: 'microscope', task: 'check-circle', meeting: 'users', reading: 'book-open', order: 'shopping-cart', help: 'lifebuoy' };

  /* V3.594 — in-app notification feed (catch-up surface for missed pushes) */
  var NOTIF_LIMIT = 20;
  var NOTIF_WINDOW_DAYS = 7;
  var NOTIF_ICONS = {
    adjacency: 'arrow-path-rounded-square', watch: 'bell', reminder: 'clock', coop: 'user-group',
    approval: 'pencil-square', confirmed: 'check-circle', displaced: 'exclamation-triangle',
  };

  var state = {
    // V3.563 — 'day' | 'week' | 'month' horizon tabs.
    // V3.638 — seeds to 'week' (was 'day') so the page opens on the horizon
    // it is now named after. Costs nothing: init() already loads the whole
    // viewed week unconditionally and the day view renders out of that same
    // state.items, so there is no extra fetch. ?view=day still overrides.
    view: 'week',
    composerOpen: false,  // V3.567 — composer is a pop-up sheet, folded by default
    date: null,
    items: [],            // viewed WEEK's items
    monthItems: [],       // V3.563 — items across the viewed month's calendar grid
    pending: [],          // past planned items awaiting confirmation
    outcomeQueue: [],     // V3.623 — past items still missing an outcome
    prefs: null,
    focuses: [],          // this (current) week's focus areas
    equipment: [],
    protocols: [],
    bucketTasks: [],      // open subtasks from the buckets system (task picker, group 2)
    editingId: null,
    slotCheck: null,
    dayBookings: {},      // date -> bookings[] for the drag strip (per selected device)
    researchFoci: [],     // V3.550 — research-foci rows for the alignment picker
    fociGroups: [],       // V3.717 — those rows bucketed by grant
    grantRows: [],        // V3.717 — the grant cards, for dropdown 1
    grantChildren: {},    // V3.717 — grantId → its aims/outputs, for dropdown 2
    grantOfCard: {},      // V3.717 — any card id → the grant it rolls up to
    semFocuses: [],       // V3.715 — this semester's foci (semester group in the 🎯 dropdown)
    notifications: [],    // V3.594 — in-app feed rows (newest first)
    notifOpen: false,     // expanded state; auto-opens when something is unread
    assigned: [],         // V3.743 — tasks others put in my queue that I haven't planned into a day yet
    compWatches: [],      // V3.598 — own active watches on the composer's device+date
    comp: null,
  };

  function freshComposer() {
    return {
      mode: 'compose',            // 'compose' | one of SIMPLE_TYPES keys
      ingredients: new Set(['focus']),
      title: '', notes: '',
      date: state && state.date ? state.date : localToday(),
      startTime: '', endTime: '',
      equipmentId: '', protocolId: '',
      priority: 'normal',         // V3.588 — booking criticality (Soft/Firm/Hard)
      focusId: '', focusFreeText: '', focusTaskId: '',
      focusAlignId: '',           // V3.717 — the aim/output under the picked grant (dropdown 2)
      semesterFocusId: '',        // V3.715 — semester focus a freeform proposal nests under
      surfaces: null,
    };
  }

  /* ── small helpers ────────────────────────────────────────── */

  function localToday() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function shiftDate(dateStr, days) {
    var p = dateStr.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    d.setDate(d.getDate() + days);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function mondayOf(dateStr) {
    var p = dateStr.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var dow = d.getDay();
    return shiftDate(dateStr, dow === 0 ? -6 : 1 - dow);
  }
  /* V3.563 — month/week horizon helpers */
  function shiftMonth(dateStr, delta) {
    var p = dateStr.split('-');
    var y = +p[0], m = (+p[1] - 1) + delta, day = +p[2];
    var last = new Date(y, m + 1, 0).getDate();
    if (day > last) day = last;
    var d = new Date(y, m, day);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function firstOfMonth(dateStr) {
    var p = dateStr.split('-');
    return p[0] + '-' + p[1] + '-01';
  }
  function monthLabel(dateStr) {
    var p = dateStr.split('-');
    return new Date(+p[0], +p[1] - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  /* Monday-aligned calendar grid for the month containing dateStr —
   * always a whole number of weeks. Returns [{date, inMonth}]. */
  function monthGridDays(dateStr) {
    /* V3.867 — a malformed date made the loop below endless ('NaN-NaN-NaN' <= 'NaN-NaN-NaN' is always true), filling
     * memory until the page's process died; fall back to today, and never build more than six weeks */
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) dateStr = localToday();
    var p = dateStr.split('-'), y = +p[0], mIdx = +p[1] - 1;
    var last = new Date(y, mIdx + 1, 0).getDate();
    var firstStr = y + '-' + String(mIdx + 1).padStart(2, '0') + '-01';
    var lastStr = y + '-' + String(mIdx + 1).padStart(2, '0') + '-' + String(last).padStart(2, '0');
    var d = mondayOf(firstStr);
    var gridEnd = shiftDate(mondayOf(lastStr), 6); // Sunday of the last week
    var days = [];
    while (d <= gridEnd && days.length < 42) {
      days.push({ date: d, inMonth: (+d.split('-')[1] - 1) === mIdx });
      d = shiftDate(d, 1);
    }
    return days;
  }
  function weekSpanLabel(mon) {
    var a = mon.split('-'), b = shiftDate(mon, 6).split('-');
    var ds = new Date(+a[0], +a[1] - 1, +a[2]), de = new Date(+b[0], +b[1] - 1, +b[2]);
    var f = function (x) { return x.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
    return f(ds) + ' – ' + f(de);
  }

  function fmtDateLabel(dateStr) {
    var p = dateStr.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var today = localToday();
    var rel = dateStr === today ? 'Today' :
      (dateStr === shiftDate(today, 1) ? 'Tomorrow' :
      (dateStr === shiftDate(today, -1) ? 'Yesterday' : d.toLocaleDateString('en-US', { weekday: 'long' })));
    return { rel: rel, full: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) };
  }
  function fmtTime(t) {
    if (!t) return '';
    var p = t.split(':').map(Number);
    var ampm = p[0] >= 12 ? 'pm' : 'am';
    var h = p[0] % 12 || 12;
    return h + (p[1] ? ':' + String(p[1]).padStart(2, '0') : '') + ampm;
  }
  function minToTime(min) {
    return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(kind, msg) { if (window.TOAST && TOAST[kind]) TOAST[kind](msg); }

  function currentFocus() {
    var c = state.comp;
    return state.focuses.find(function (f) { return f.id === c.focusId; }) || null;
  }
  function currentEquip() {
    return state.equipment.find(function (e) { return e.id === state.comp.equipmentId; }) || null;
  }
  function currentProtocol() {
    return state.protocols.find(function (p) { return p.id === state.comp.protocolId; }) || null;
  }

  /* ── data loading ─────────────────────────────────────────── */

  async function loadWeek() {
    var mon = mondayOf(state.date);
    state.items = await DD.listRange(mon, shiftDate(mon, 6));
    state.items.sort(function (a, b) {
      return (a.startTime || '00:00').localeCompare(b.startTime || '00:00');
    });
  }

  /* V3.563 — items across the whole month's calendar grid (Month tab). */
  async function loadMonth() {
    var days = monthGridDays(state.date);
    state.monthItems = await DD.listRange(days[0].date, days[days.length - 1].date);
    state.monthItems.sort(function (a, b) {
      return (a.date || '').localeCompare(b.date || '') ||
        (a.startTime || '00:00').localeCompare(b.startTime || '00:00');
    });
  }

  async function loadPending() {
    var today = localToday();
    var rows = await DD.listRange(shiftDate(today, -7), shiftDate(today, -1));
    state.pending = rows.filter(function (it) { return it.status === 'planned'; });
  }

  /* V3.853 — the predicate behind the nudge (pure; lifted by
   * scripts/tests/myweek-needs-result.test.mjs). Done or skipped without a
   * result counts the SAME DAY: marking done now goes through the result
   * dialog, so a gap here is a cancelled dialog or a pre-V3.853 item, and
   * both should be visible at once. Planned items count once their day has
   * passed (today's plan is still in progress); cancelled ones never do. */
  function needsResult(it, today) {
    if (!it || it.outcome || it.status === 'cancelled') return false;
    if (it.status === 'done' || it.status === 'skipped') return !!it.date && it.date <= today;
    return it.status === 'planned' && !!it.date && it.date < today;
  }

  /* V3.623 · V3.853 — every step from four weeks back through today that
   * still has no result (needsResult). Four weeks, not "this week + last":
   * a result recorded late is still worth more to the PMR ledger than a
   * step that quietly ages out of the nudge. */
  async function loadOutcomeQueue() {
    var today = localToday();
    var from = shiftDate(mondayOf(today), -28);
    var rows = await DD.listRange(from, today);
    state.outcomeQueue = rows.filter(function (it) { return needsResult(it, today); })
      .sort(function (a, b) { return (a.date || '').localeCompare(b.date || ''); });
  }

  /* V3.594 — the in-app notification feed.
   *
   * Push is transient: miss the buzz and "the booking after yours was
   * cancelled" is gone, with no trace left on the calendar to re-derive
   * it from. Cloud Functions mirror every equipment notification into
   * userData/{uid}/notifications (Admin SDK), and this is the catch-up
   * surface. Deliberately readable even by users who muted equipment
   * push — that's the point of a fallback.
   *
   * Owner-locked by the userData wildcard rule, so a plain collection
   * read needs no index (single-collection orderBy). */
  async function loadNotifications() {
    state.notifications = [];
    try {
      var user = firebridge.getUser();
      if (!user || !firebridge.db) return;
      var cutoff = new Date(Date.now() - NOTIF_WINDOW_DAYS * 86400000);
      var snap = await firebridge.db()
        .collection('userData').doc(user.uid).collection('notifications')
        .orderBy('createdAt', 'desc').limit(NOTIF_LIMIT).get();
      state.notifications = snap.docs.map(function (d) {
        var v = d.data() || {};
        return {
          id: d.id,
          title: v.title || '',
          body: v.body || '',
          url: v.url || '',
          kind: v.kind || '',
          readAt: v.readAt || null,
          createdAt: v.createdAt && v.createdAt.toDate ? v.createdAt.toDate() : null,
        };
      }).filter(function (n) {
        // Drop anything older than the window; unread items are kept
        // regardless so a missed notice never silently disappears.
        return !n.readAt || !n.createdAt || n.createdAt >= cutoff;
      });
    } catch (e) {
      console.warn('[my-week] notification feed load failed:', e && e.message);
    }
  }

  function unreadNotifications() {
    return state.notifications.filter(function (n) { return !n.readAt; });
  }

  /* V3.743 — "Assigned to you": tasks a teammate dropped into my queue
   * (lab-meeting action items, weekly chores, PMR sends — anything with
   * bucket 'assigned') that I haven't planned into a day or finished yet.
   *
   * Read DIRECTLY, not via api.load('tasks/assigned.json'): that route is
   * cache: MEDIUM (30 min) and a cross-user write can't invalidate the
   * RECIPIENT's cache, so a fresh assignment would sit invisible for half an
   * hour. Single equality filter → automatic index, no composite needed;
   * done/planned are filtered client-side. */
  async function loadAssigned() {
    state.assigned = [];
    try {
      var user = firebridge.getUser();
      if (!user || !firebridge.db) return;
      var snap = await firebridge.db()
        .collection('userData').doc(user.uid).collection('tasks')
        .where('bucket', '==', 'assigned').get();
      state.assigned = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data() || {}); })
        .filter(function (t) { return !t.done && !t.planned_item_id && !t.dismissed_at; })
        .sort(function (a, b) {
          var ad = (a.due_date && a.due_date !== 'TBD') ? a.due_date : '9999';
          var bd = (b.due_date && b.due_date !== 'TBD') ? b.due_date : '9999';
          return ad.localeCompare(bd) || String(b.created_at || '').localeCompare(String(a.created_at || ''));
        });
    } catch (e) {
      console.warn('[my-week] assigned-tasks load failed:', e && e.message);
    }
  }
  function assignedRef(id) {
    return firebridge.db().collection('userData').doc(firebridge.getUser().uid).collection('tasks').doc(id);
  }

  async function markNotificationRead(id) {
    var n = state.notifications.find(function (x) { return x.id === id; });
    if (!n || n.readAt) return;
    n.readAt = new Date();       // optimistic — the badge drops immediately
    try {
      await firebridge.db().collection('userData').doc(firebridge.getUser().uid)
        .collection('notifications').doc(id)
        .update({ readAt: firebase.firestore.FieldValue.serverTimestamp() });
    } catch (e) { console.warn('[my-week] mark-read failed:', e && e.message); }
  }

  async function dismissNotification(id) {
    state.notifications = state.notifications.filter(function (x) { return x.id !== id; });
    try {
      await firebridge.db().collection('userData').doc(firebridge.getUser().uid)
        .collection('notifications').doc(id).delete();
    } catch (e) { console.warn('[my-week] dismiss failed:', e && e.message); }
  }

  async function markAllNotificationsRead() {
    var unread = unreadNotifications();
    if (!unread.length) return;
    var now = new Date();
    unread.forEach(function (n) { n.readAt = now; });
    try {
      var col = firebridge.db().collection('userData')
        .doc(firebridge.getUser().uid).collection('notifications');
      await Promise.all(unread.map(function (n) {
        return col.doc(n.id).update({
          readAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }));
    } catch (e) { console.warn('[my-week] mark-all-read failed:', e && e.message); }
  }

  async function loadFocuses() {
    if (!FA) {
      state.focuses = []; state.researchFoci = []; state.semFocuses = [];
      buildGrantIndex([]);
      return;
    }
    state.focuses = await FA.listForWeek(firebridge.getUser().uid, FA.weekIdFor(localToday()));
    // V3.550 — research-foci rows for the freeform-alignment picker
    // (cached inside FOCUS_AREAS after the first read).
    if (FA.listFociForPicker) {
      state.researchFoci = await FA.listFociForPicker();
      // V3.717 — bucket by grant once per load; both dropdowns read the
      // index rather than re-walking the card graph on every keystroke.
      buildGrantIndex(FA.rowsByGrant ? await FA.rowsByGrant(state.researchFoci) : []);
    }
    // V3.715 — this semester's foci: the semester group in the 🎯 dropdown
    // (picking one creates/reuses a weekly focus nested under it).
    if (window.SEMESTERS && FA.listSemesterFoci) {
      try {
        await SEMESTERS.load();
        state.semFocuses = await FA.listSemesterFoci(
          firebridge.getUser().uid, SEMESTERS.currentOrFallback(localToday()).id);
      } catch (e) { state.semFocuses = []; }
    }
  }

  /* Open subtasks from the buckets system, for the task picker's second
   * group (the first group is this week's focus tasks — the hierarchy). */
  async function loadBucketTasks() {
    try {
      var doc = await api.load('tasks/buckets.json');
      var out = [];
      function walk(subtasks, projTitle) {
        (subtasks || []).forEach(function (st) {
          if (!st) return;
          if (!st.done && st.text) out.push({ id: st.id, text: st.text, from: projTitle });
          walk(st.children, projTitle);
        });
      }
      (doc.taskBuilders || []).forEach(function (p) {
        (p.buckets || []).forEach(function (b) { if (!b.archived) walk(b.subtasks, p.title || ''); });
      });
      state.bucketTasks = out.slice(0, 200);
    } catch (e) { state.bucketTasks = []; }
  }

  function dayItems() {
    return state.items.filter(function (it) { return it.date === state.date; });
  }

  /* ── composer derivations ─────────────────────────────────── */

  function derivedType() {
    var c = state.comp;
    if (c.mode !== 'compose') return c.mode;
    return c.ingredients.has('equipment') ? 'equipment' : 'work';
  }

  /* Ghost title from the combo: "Protocol X on Confocal — Focus title". */
  function suggestedTitle() {
    var c = state.comp;
    if (c.mode !== 'compose') return '';
    var bits = [];
    var prot = currentProtocol();
    var eq = currentEquip();
    if (c.ingredients.has('task') && c.focusTaskId) {
      var ft = focusTaskById(c.focusTaskId);
      if (ft) bits.push(ft.text);
    }
    if (!bits.length && prot && c.ingredients.has('protocol')) bits.push(prot.title);
    if (eq && c.ingredients.has('equipment')) bits.push((bits.length ? 'on ' : 'Session on ') + (eq.shortName || eq.name));
    var head = bits.join(' ');
    var f = currentFocus();
    var focusBit = '';
    if (c.ingredients.has('focus')) {
      if (f) focusBit = f.title;
      else if (c.focusId && c.focusId.indexOf('sem:') === 0) {
        // V3.715 — a semester-focus pick suggests the semester title until
        // the weekly focus is created on submit.
        var semSf = state.semFocuses.find(function (x) { return 'sem:' + x.id === c.focusId; });
        focusBit = semSf ? semSf.title : '';
      } else if (c.focusId && c.focusId.indexOf('grant:') === 0) {
        // V3.717 — same, for a week started straight under a grant. The
        // narrower aim wins the suggestion when one was picked.
        var alignRow = c.focusAlignId
          ? (state.researchFoci || []).find(function (x) { return (x.key || x.id) === c.focusAlignId; })
          : null;
        var gRow = state.grantRows.find(function (g) { return 'grant:' + g.id === c.focusId; });
        focusBit = alignRow
          ? (alignRow.analysis_title || alignRow.title)
          : (gRow ? gRow.title : '');
      } else focusBit = c.focusFreeText || '';
    }
    if (head && focusBit) return head + ' — ' + focusBit;
    return head || focusBit || '';
  }

  function focusTaskById(taskId) {
    for (var i = 0; i < state.focuses.length; i++) {
      var hit = (state.focuses[i].tasks || []).find(function (t) { return t.id === taskId; });
      if (hit) return Object.assign({ focus: state.focuses[i] }, hit);
    }
    return null;
  }

  function computeSurfaces() {
    var c = state.comp;
    var all = (DD.TYPE_SURFACES[derivedType()] || ['tracker']).slice();
    if (c.surfaces) {
      c.surfaces = new Set(Array.from(c.surfaces).filter(function (s) { return all.indexOf(s) >= 0; }));
      return all;
    }
    if (state.prefs && state.prefs.auto_distribute) {
      var excluded = (state.prefs.excluded_surfaces || []);
      c.surfaces = new Set(all.filter(function (s) { return excluded.indexOf(s) < 0; }));
    } else {
      c.surfaces = new Set();
    }
    return all;
  }

  /* ── rendering ────────────────────────────────────────────── */

  function render() {
    var root = document.getElementById('myday-root');
    if (!root) return;
    var inner;
    // V3.594 — the feed sits directly under the horizon tabs on EVERY
    // view: a "be off the scope by 12" notice is not day-specific, and
    // burying it under the timeline would defeat the catch-up purpose.
    var notif = renderNotifications();
    // V3.623 — the outcomes nudge rides directly under the feed on every
    // horizon: unaccounted steps are week-level debt, not day-specific.
    var nudge = renderNudge();
    // V3.743 — "Assigned to you" cards ride under the nudge on every horizon:
    // a lab-meeting action item or a chore is a thing to place on SOME day,
    // so it belongs above the day/week/month grid, not inside one of them.
    var inbox = renderAssignedInbox();
    if (state.view === 'week') {
      inner = notif + nudge + inbox + renderWeekView();
    } else if (state.view === 'month') {
      inner = notif + nudge + inbox + renderMonthView();
    } else {
      inner =
        renderDatebar() +
        notif +
        nudge +
        inbox +
        renderWeek() +
        renderFocusPanel() +
        renderPending() +
        '<div class="md-section-title">' + esc(fmtDateLabel(state.date).rel) + '’s plan</div>' +
        renderTimeline();
    }
    // Composer is a pop-up sheet on the planning horizons (day/week),
    // folded away behind a ＋ button by default; the month tab is a
    // read-first overview (tap a day to drop into it).
    var composerZone = '';
    if (state.view !== 'month') {
      composerZone = state.composerOpen ? renderComposer() : renderFab();
    }
    root.innerHTML = '<div class="md-wrap">' + renderTabs() + inner + '</div>' + composerZone;
    wireEvents(root);
  }

  function renderFab() {
    return '<button type="button" class="md-fab" data-act="open-composer" aria-label="Add to my day">＋</button>';
  }

  /* V3.594 — 🔔 Notifications. Renders NOTHING when the feed is empty and
   * a single quiet header line when everything is read, so a calm week
   * costs no vertical space. Unread items force it open — if a student
   * missed the push that said "be off the scope by 12", this is where
   * they find out. */
  function renderNotifications() {
    if (!state.notifications.length) return '';
    var unread = unreadNotifications();
    var open = state.notifOpen || unread.length > 0;

    var head = '<button type="button" class="md-notif-head' + (unread.length ? ' md-notif-head--alert' : '') + '" data-act="notif-toggle">' +
      '<span class="md-notif-caret">' + (ICON.svg(open ? 'chevron-down' : 'chevron-right')) + '</span>' +
      '<span class="md-notif-title">' + ICON.svg('bell') + ' Notifications</span>' +
      (unread.length ? '<span class="md-notif-badge">' + unread.length + '</span>' : '') +
      '</button>';

    if (!open) return '<div class="md-notif">' + head + '</div>';

    var rows = state.notifications.map(function (n) {
      var icon = NOTIF_ICONS[n.kind] || 'bell';
      return '<div class="md-notif-item' + (n.readAt ? '' : ' md-notif-unread') + '" data-notif="' + esc(n.id) + '">' +
        '<span class="md-notif-icon">' + ICON.render(icon) + '</span>' +
        '<button type="button" class="md-notif-main" data-act="notif-open">' +
          '<span class="md-notif-itop">' + esc(n.title) + '</span>' +
          (n.body ? '<span class="md-notif-ibody">' + esc(n.body) + '</span>' : '') +
          (n.createdAt ? '<span class="md-notif-when">' + esc(relTime(n.createdAt)) + '</span>' : '') +
        '</button>' +
        '<button type="button" class="md-notif-x" data-act="notif-dismiss" aria-label="Dismiss">✕</button>' +
      '</div>';
    }).join('');

    var foot = unread.length > 1
      ? '<button type="button" class="md-notif-readall" data-act="notif-readall">Mark all read</button>'
      : '';

    return '<div class="md-notif">' + head +
      '<div class="md-notif-list">' + rows + '</div>' + foot + '</div>';
  }

  /* V3.623 · V3.853 — the standing nudge. Quiet when every step has a
   * result; one calm line otherwise. "Record" walks the queue one dialog
   * at a time. */
  function renderNudge() {
    var n = state.outcomeQueue.length;
    if (!n) return '';
    return '<div class="md-nudge">' +
      '<span class="md-nudge-txt">' + ICON.svg('receipt-percent') + ' ' + n + ' step' + (n === 1 ? '' : 's') + ' need' + (n === 1 ? 's' : '') +
        ' a result — link the figure board or notebook entry that holds ' + (n === 1 ? 'it' : 'them') + '.</span>' +
      '<button type="button" class="md-nudge-go" data-act="nudge-run">Record</button>' +
    '</div>';
  }

  /* V3.623 — the per-item outcome affordance. A recorded outcome renders
   * as its icon + first line (tap to edit); a done/skipped item without
   * one gets the ◇ chip. Planned items show nothing — outcomes are for
   * steps whose day has come and gone. */
  function outcomeChipHtml(it) {
    var META = DD.ITEM_OUTCOME_META || {};
    if (it.outcome && META[it.outcome.kind]) {
      var om = META[it.outcome.kind];
      var sum = it.outcome.summary ? ' — ' + esc(it.outcome.summary) : '';
      var img = (it.outcome.image && it.outcome.image.download_url) ? ' ' + ICON.svg('photo') : '';
      var links = it.outcome.links || [];
      // V3.853 — the cards the result points at (figure board / notebook)
      var fb = links.some(function (l) { return l && /^figure_board/.test(l.kind || ''); }) ? ' ' + ICON.svg('chart-bar') : '';
      var nb = ((it.outcome.notebook_entry_ids || []).length || links.some(function (l) { return l && l.kind === 'notebook_item'; })) ? ' ' + ICON.svg('book-open') : '';
      var fu = it.outcome.follow_up_item_id
        ? '<span class="md-oc-fu" title="Follow-up planned">' + ICON.svg('arrow-path') + ' next week</span>' : '';
      return '<button type="button" class="md-oc md-oc-' + esc(it.outcome.kind) + '" data-act="i-outcome" title="Edit outcome">' +
        ICON.render(om.icon) + ' ' + om.label + sum + fb + img + nb + '</button>' + fu;
    }
    if (it.status === 'done' || it.status === 'skipped') {
      // V3.853 — not an invitation any more: a closed step without a result is a gap
      return '<button type="button" class="md-oc md-oc-add md-oc-need" data-act="i-outcome" title="Link the figure board or notebook entry that holds the result">◇ Needs a result</button>';
    }
    return '';
  }

  /* "12 min ago" / "3 h ago" / "Tue" — short, because these stack. */
  function relTime(d) {
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + ' h ago';
    var days = Math.round(hrs / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return days + ' days ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // R2 (V3.580) — paint the shell INSTANTLY so My Week never blank-waits on
  // the network while getPrefs() + loadWeek() + loadPending() + loadFocuses()
  // resolve. render() replaces this the moment data arrives. Reuses the real
  // tabs/datebar so the swap is seamless (state.date/state.view are set by
  // now; state.items defaults to [] so renderDatebar draws without dots).
  function renderSkeleton() {
    var root = document.getElementById('myday-root');
    if (!root) return;
    var bar = function (w) { return '<div class="md-skel-bar" style="width:' + w + '"></div>'; };
    var head = (state.view === 'day') ? renderDatebar() : '';
    var body =
      '<div class="md-section-title">This week’s focus</div>' +
      '<div class="md-skel-card">' + bar('55%') + bar('92%') + bar('84%') + '</div>' +
      '<div class="md-section-title">' + esc(fmtDateLabel(state.date).rel) + '’s plan</div>' +
      '<div class="md-skel-card">' + bar('70%') + bar('48%') + '</div>';
    root.innerHTML = '<div class="md-wrap">' + renderTabs() + head + body + '</div>' + renderFab();
  }

  function renderTabs() {
    var tabs = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];
    return '<div class="md-tabs">' + tabs.map(function (t) {
      return '<button type="button" class="md-tab' + (state.view === t[0] ? ' md-tab-on' : '') +
        '" data-view="' + t[0] + '">' + t[1] + '</button>';
    }).join('') + '</div>';
  }

  /* ── Week tab: the 7 days of the viewed week, each with its items ── */

  function renderWeekView() {
    var mon = mondayOf(state.date);
    var today = localToday();
    var nav = '<div class="md-rangenav">' +
      '<button type="button" data-act="wprev" aria-label="Previous week">‹</button>' +
      '<span class="md-rangelabel">' + esc(weekSpanLabel(mon)) + '</span>' +
      '<button type="button" data-act="wnext" aria-label="Next week">›</button>' +
      (mon !== mondayOf(today) ? '<button type="button" class="md-range-now" data-act="wnow">This week</button>' : '') +
    '</div>';
    var dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    var days = '';
    for (var i = 0; i < 7; i++) {
      var d = shiftDate(mon, i);
      var items = state.items.filter(function (it) { return it.date === d; });
      var lbl = fmtDateLabel(d);
      var itemsHtml = items.length
        ? items.map(renderMiniItem).join('')
        : '<button type="button" class="md-wv-add" data-date="' + d + '" data-open="1">' + ICON.svg('plus') + ' plan something</button>';
      days += '<div class="md-wv-day' + (d === today ? ' md-wv-today' : '') + (d === state.date ? ' md-wv-sel' : '') + '">' +
        '<button type="button" class="md-wv-dayhead" data-date="' + d + '">' +
          '<span class="md-wv-dname">' + dayNames[i] + '</span>' +
          '<span class="md-wv-ddate">' + esc(lbl.full) + '</span>' +
          (items.length ? '<span class="md-wv-count">' + items.length + '</span>' : '') +
        '</button>' +
        '<div class="md-wv-items">' + itemsHtml + '</div>' +
      '</div>';
    }
    // The focus panel always reflects the CURRENT week (loadFocuses keys
    // off today), so only surface it when the viewed week is this week.
    var focusPanel = mon === mondayOf(today) ? renderFocusPanel() : '';
    return nav + focusPanel + '<div class="md-weekview">' + days + '</div>';
  }

  function renderMiniItem(it) {
    var det = it.details || {};
    var combo = '';
    if (det.focusTitle) combo = '<span class="md-mini-combo">' + ICON.svg('target') + ' ' + esc(det.focusTitle) + '</span>';
    // V3.623 — outcome verdict / follow-up marker on the compact row
    var META = DD.ITEM_OUTCOME_META || {};
    var oc = (it.outcome && META[it.outcome.kind])
      ? '<span class="md-mini-oc" title="' + esc(META[it.outcome.kind].label) + '">' + ICON.render(META[it.outcome.kind].icon) + '</span>' : '';
    var fu = it.follow_up_of ? '<span class="md-mini-oc" title="Follows up last week">' + ICON.svg('arrow-path') + '</span>' : '';
    return '<div class="md-mini' + (it.status === 'done' ? ' md-done' : '') + '" data-id="' + esc(it.id) + '">' +
      '<span class="md-mini-icon">' + (TYPE_ICONS[it.type] ? ICON.render(TYPE_ICONS[it.type]) : '•') + '</span>' +
      '<span class="md-mini-main">' +
        '<span class="md-mini-title">' + fu + esc(it.title) + '</span>' +
        (it.startTime ? '<span class="md-mini-time">' + fmtTime(it.startTime) + (it.endTime ? '–' + fmtTime(it.endTime) : '') + '</span>' : '') +
        combo +
      '</span>' +
      oc +
      (it.status === 'planned' ? '<button type="button" class="md-mini-done" data-act="i-done" title="Done — record the result">✓</button>' : '') +
    '</div>';
  }

  /* ── Month tab: a calendar grid of the viewed month ──────── */

  function renderMonthView() {
    var days = monthGridDays(state.date);
    var today = localToday();
    var nav = '<div class="md-rangenav">' +
      '<button type="button" data-act="mprev" aria-label="Previous month">‹</button>' +
      '<span class="md-rangelabel">' + esc(monthLabel(state.date)) + '</span>' +
      '<button type="button" data-act="mnext" aria-label="Next month">›</button>' +
      (firstOfMonth(state.date) !== firstOfMonth(today) ? '<button type="button" class="md-range-now" data-act="mnow">This month</button>' : '') +
    '</div>';
    var dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      .map(function (x) { return '<div class="md-mo-dow">' + x + '</div>'; }).join('');
    var cells = days.map(function (cell) {
      var items = state.monthItems.filter(function (it) { return it.date === cell.date; });
      var pills = items.slice(0, 3).map(function (it) {
        // V3.623 — a recorded outcome's icon leads the pill
        var META = DD.ITEM_OUTCOME_META || {};
        var oc = (it.outcome && META[it.outcome.kind]) ? ICON.render(META[it.outcome.kind].icon) + ' ' : '';
        return '<span class="md-mo-pill' + (it.status === 'done' ? ' md-done' : '') + '">' +
          oc + (TYPE_ICONS[it.type] ? ICON.render(TYPE_ICONS[it.type]) : '•') + ' ' + esc(it.title) + '</span>';
      }).join('');
      var more = items.length > 3 ? '<span class="md-mo-more">+' + (items.length - 3) + '</span>' : '';
      // A compact count badge shows on narrow screens where the title
      // pills are hidden (phone is the default layout).
      var count = items.length ? '<span class="md-mo-count">' + items.length + '</span>' : '';
      var cls = 'md-mo-cell' + (cell.inMonth ? '' : ' md-mo-out') +
        (cell.date === today ? ' md-mo-today' : '') + (cell.date === state.date ? ' md-mo-sel' : '');
      return '<button type="button" class="' + cls + '" data-date="' + cell.date + '">' +
        '<span class="md-mo-num">' + (+cell.date.split('-')[2]) + count + '</span>' +
        pills + more +
      '</button>';
    }).join('');
    return nav +
      '<div class="md-month">' +
        '<div class="md-mo-grid md-mo-dowrow">' + dow + '</div>' +
        '<div class="md-mo-grid">' + cells + '</div>' +
      '</div>';
  }

  function renderDatebar() {
    var lbl = fmtDateLabel(state.date);
    return '<div class="md-datebar">' +
      '<button type="button" data-act="prev" aria-label="Previous day">‹</button>' +
      '<div class="md-date-label">' + esc(lbl.rel) + '<span class="md-sub">' + esc(lbl.full) + '</span></div>' +
      '<button type="button" data-act="next" aria-label="Next day">›</button>' +
      '<button type="button" class="md-gear" data-act="prefs" aria-label="Distribution settings">' + ICON.svg('cog-6-tooth') + '</button>' +
    '</div>';
  }

  function renderWeek() {
    var mon = mondayOf(state.date);
    var today = localToday();
    var cells = [];
    for (var i = 0; i < 7; i++) {
      var d = shiftDate(mon, i);
      var count = state.items.filter(function (it) { return it.date === d; }).length;
      var cls = 'md-day' + (d === state.date ? ' md-active' : '') + (d === today ? ' md-today' : '');
      var dayName = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i];
      cells.push('<button type="button" class="' + cls + '" data-date="' + d + '">' +
        '<span class="md-dot">' + (count || '·') + '</span>' + dayName + '</button>');
    }
    return '<div class="md-week">' + cells.join('') + '</div>';
  }

  /* ── "This week's focus" panel (V3.537 + V3.540 report) ───── */

  function renderFocusPanel() {
    if (!FA) return '';
    var head = '<div class="md-section-title">This week’s focus ' +
      '<a class="md-focus-manage" href="/rm/pages/team-focus.html">manage ' + ICON.svg('arrow-top-right-on-square') + '</a></div>';
    if (!state.focuses.length) {
      return head + '<div class="md-focus-empty">No focus set for this week yet — agree on one with your mentor on ' +
        '<a href="/rm/pages/team-focus.html">Team Focus</a>, or propose one there yourself.</div>';
    }
    return head + state.focuses.map(function (f) {
      var meta = FA.STATUS_META[f.status];
      var openTasks = (f.tasks || []).filter(function (t) { return !t.done; });
      var doneCount = (f.tasks || []).length - openTasks.length;
      var taskRows = openTasks.slice(0, 5).map(function (t) {
        return '<button type="button" class="md-ft" data-act="plan-ft" data-focus="' + esc(f.id) + '" data-task="' + esc(t.id) + '" title="Plan this task into your day">▸ ' + esc(t.text) + '</button>';
      }).join('');
      var report = '';
      if (f.report) {
        var om = FA.OUTCOME_META[f.report.outcome] || {};
        report = '<div class="md-focus-report">' + ICON.render(om.icon) + ' ' + esc(om.label || '') +
          (f.report.summary ? ' — ' + esc(f.report.summary) : '') + '</div>';
      }
      var papers = (f.paper_refs || []).map(function (r) {
        return '<a class="md-focus-paper" href="/rm/pages/paper-builder.html?id=' + encodeURIComponent(r.id) + '">' + ICON.svg('pencil-square') + ' ' + esc(r.title) + '</a>';
      }).join('');
      // V3.550 — the research focus this week advances (inherited badge).
      // V3.602 — deep-links to the specific analysis when one is named.
      var align = '';
      if (f.focus_ref) {
        var anch = f.focus_ref.analysis_id ? '#rmap-' + f.focus_ref.analysis_id : '';
        var alabel = (FA && FA.focusRefLabel) ? FA.focusRefLabel(f.focus_ref) : f.focus_ref.title;
        align = '<a class="md-focus-align" href="/rm/pages/research.html?id=' + encodeURIComponent(f.focus_ref.id) + anch + '" title="Research focus this week advances">' + ICON.svg('target') + ' ' + esc(alabel) + '</a>';
      }
      // V3.715 — the semester focus this week nests under.
      if (f.semester_focus_id) {
        var semHit = state.semFocuses.find(function (x) { return x.id === f.semester_focus_id; });
        align += '<a class="md-focus-align" href="/rm/pages/team-focus.html" title="Semester focus this week nests under">' + ICON.svg('academic-cap') + ' ' + esc(semHit ? semHit.title : 'semester focus') + '</a>';
      }
      return '<div class="md-focus-card" data-focus="' + esc(f.id) + '">' +
        '<div class="md-focus-head">' +
          '<button type="button" class="md-focus-title" data-act="plan-focus" data-focus="' + esc(f.id) + '" title="Plan your day against this focus">' + ICON.svg('target') + ' ' + esc(f.title) + '</button>' +
          '<span class="tfp-chip" style="color:' + meta.color + ';background:' + meta.bg + '">' + meta.label + '</span>' +
          (f.status === 'confirmed'
            ? '<button type="button" class="md-focus-report-btn" data-act="report" data-focus="' + esc(f.id) + '">Report</button>' : '') +
        '</div>' +
        (f.description ? '<div class="md-focus-desc">' + esc(f.description) + '</div>' : '') +
        ((align || papers) ? '<div class="md-focus-papers">' + align + papers + '</div>' : '') +
        (taskRows ? '<div class="md-focus-tasks">' + taskRows +
          (doneCount ? '<span class="md-ft-done">' + doneCount + ' done</span>' : '') + '</div>' : '') +
        report +
      '</div>';
    }).join('');
  }

  /* V3.768 — a weekly chore is not work until its week arrives. The
   * coordinator fills the chore board a semester ahead, and each assignment
   * writes the task immediately, so every future week's chore was sitting in
   * everybody's inbox at once. Hold a lab-chore card back until the VISIBLE
   * week reaches it: on this week you see this week's chore, and paging
   * forward shows next week's with that week's day chips. Meeting action
   * items and PMR sends carry real deadlines and are never hidden. */
  function inboxItems(weekMonday) {
    return state.assigned.filter(function (t) {
      var sr = t.source_ref || {};
      // V3.874: a Scientia chore / reminder occurrence is dated work too — held back until its week like a lab chore
      if (sr.kind !== 'lab-chore' && sr.kind !== 'scientia-when') return true;
      if (/^\d{4}-\d{2}-\d{2}$/.test(t.due_date || '')) return mondayOf(t.due_date) <= weekMonday;
      if (sr.weekId && FA && FA.weekIdFor) return String(sr.weekId) <= FA.weekIdFor(weekMonday);
      return true;
    });
  }

  /* V3.743 — cards for tasks others assigned me. Seven day-chips (Mon–Sun of
   * the visible week, past days disabled) drop the task onto that day as a
   * real planned item via DD.importAndDistribute — the task doc stays the
   * native copy, so marking the day item done marks the task done and no
   * duplicate task is created. */
  function renderAssignedInbox() {
    if (!state.assigned.length) return '';
    var today = localToday();
    var anchor = state.view === 'month' ? today : (state.date || today);
    var mon = mondayOf(anchor);
    var items = inboxItems(mon);
    if (!items.length) return '';
    var chips = [];
    for (var i = 0; i < 7; i++) {
      var d = shiftDate(mon, i);
      var lbl = fmtDateLabel(d);           // { rel, full: 'Fri, Sep 11' }
      var past = d < today;
      chips.push('<button type="button" class="md-inbox-day' + (d === today ? ' md-inbox-today' : '') + '" data-act="plan-assigned" data-date="' + esc(d) + '"' + (past ? ' disabled title="Already past"' : ' title="Plan it for ' + esc(lbl.full) + '"') + '>' +
        esc(lbl.full.slice(0, 3)) + '<b>' + esc(String(+d.slice(8))) + '</b></button>');
    }
    var dayRow = chips.join('') + '<label class="md-inbox-other" title="Another date"><input type="date" data-act="plan-assigned-date" min="' + esc(today) + '"><span>other…</span></label>';
    var cards = items.map(function (t) {
      var sr = t.source_ref || {};
      var src;
      if (sr.kind === 'meeting-action') src = ICON.svg('megaphone') + ' Lab meeting' + (sr.meetingDate ? ' · ' + esc(fmtDateLabel(sr.meetingDate).full.replace(/^\w+, /, '')) : '');
      else if (sr.kind === 'lab-chore') src = ICON.svg('brush') + ' Chore' + (sr.weekId ? ' · week ' + esc(sr.weekId.split('-W')[1]) : '');
      else if (sr.kind === 'scientia-when') src = ICON.svg({ Chore: 'brush', Meeting: 'clock', Deadline: 'flag' }[sr.label] || 'bell') + ' Scientia · ' + esc(sr.label || 'Reminder');
      else if (t.source === 'scientia') src = ICON.svg('book-open') + ' Scientia';
      else if (t.source === 'pmr') src = ICON.svg('pencil-square') + ' PMR';
      else src = ICON.svg('arrow-down-tray') + ' Assigned';
      var due = (t.due_date && t.due_date !== 'TBD') ? '<span class="md-inbox-due' + (t.due_date < today ? ' md-inbox-overdue' : '') + '">due ' + esc(fmtDateLabel(t.due_date).full.replace(/^\w+, /, '')) + '</span>' : '';
      return '<div class="md-inbox-card" data-task="' + esc(t.id) + '">' +
        '<div class="md-inbox-head"><span class="md-inbox-src">' + src + '</span>' + due +
          (t.createdByName ? '<span class="md-inbox-from">from ' + esc(t.createdByName.split(/\s+/)[0]) + '</span>' : '') + '</div>' +
        '<div class="md-inbox-text">' + esc(t.text || '(untitled)') + '</div>' +
        (t.notes ? '<div class="md-inbox-notes">' + esc(t.notes) + '</div>' : '') +
        '<div class="md-inbox-days">' + dayRow + '</div>' +
        '<div class="md-inbox-actions">' +
          '<button type="button" class="md-inbox-btn" data-act="assigned-done" title="Already did it">✓ Done</button>' +
          '<button type="button" class="md-inbox-btn md-inbox-dismiss" data-act="assigned-dismiss" title="Hide from My Week (stays in your Tasks)">✕ Dismiss</button>' +
        '</div>' +
      '</div>';
    }).join('');
    return '<div class="md-section-title">Assigned to you <span class="md-inbox-n">' + items.length + '</span>' +
      '<span class="md-inbox-hint">pick a day to plan it</span></div>' +
      '<div class="md-inbox">' + cards + '</div>';
  }

  /* Drop an assigned task onto a date. The task doc is the native copy
   * (origin), so distribute() never re-creates it; only the tracker gets a
   * fan-out copy. Then stamp planned_item_id so the card clears. */
  async function planAssigned(taskId, date) {
    var t = state.assigned.find(function (x) { return x.id === taskId; });
    if (!t || !date) return;
    var uid = firebridge.getUser().uid;
    var sr = t.source_ref || {};
    var item = await DD.importAndDistribute({
      source: 'tasks', type: 'task',
      nativeDocPath: 'userData/' + uid + '/tasks/' + t.id,
      draft: {
        title: t.text || '(untitled)', notes: t.notes || '', date: date,
        details: Object.assign({ assignedTaskId: t.id, assignedBy: t.createdByName || '' },
          sr.kind === 'meeting-action' ? { meetingId: sr.meetingId, actionItemId: sr.actionItemId } : {},
          sr.kind === 'lab-chore' ? { choreWeekId: sr.weekId, choreId: sr.choreId } : {}),
      },
    }, ['tracker']);
    try { await assignedRef(t.id).update({ planned_item_id: item.id, due_date: date, updatedAt: new Date().toISOString() }); }
    catch (e) { console.warn('[my-week] planned_item_id stamp failed:', e && e.message); }
    state.assigned = state.assigned.filter(function (x) { return x.id !== taskId; });
    toast('success', 'Planned for ' + (fmtDateLabel(date).rel || date) + ' — tap it there to add a time');
  }

  async function finishAssigned(taskId, done) {
    var t = state.assigned.find(function (x) { return x.id === taskId; });
    if (!t) return;
    var patch = done ? { done: true, done_at: new Date().toISOString() } : { dismissed_at: new Date().toISOString() };
    patch.updatedAt = new Date().toISOString();
    await assignedRef(taskId).update(patch);
    state.assigned = state.assigned.filter(function (x) { return x.id !== taskId; });
    if (done) await maybeCompleteMeetingWork({ details: Object.assign({ assignedTaskId: taskId }, sourceDetails(t)) });
  }
  function sourceDetails(t) {
    var sr = t.source_ref || {};
    if (sr.kind === 'meeting-action') return { meetingId: sr.meetingId, actionItemId: sr.actionItemId };
    if (sr.kind === 'lab-chore') return { choreWeekId: sr.weekId, choreId: sr.choreId };
    return {};
  }

  function renderPending() {
    if (!state.pending.length) return '';
    var cards = state.pending.map(function (it) {
      var lbl = fmtDateLabel(it.date);
      return '<div class="md-confirm-card" data-id="' + esc(it.id) + '">' +
        '<div class="md-c-title">' + (TYPE_ICONS[it.type] ? ICON.render(TYPE_ICONS[it.type]) : '•') + ' ' + esc(it.title) + '</div>' +
        '<div class="md-c-when">Planned ' + esc(lbl.full) + (it.startTime ? ' · ' + fmtTime(it.startTime) : '') + ' — did this happen?</div>' +
        '<div class="md-c-actions">' +
          '<button type="button" class="md-c-did" data-act="c-did" title="Done — record the result">' + ICON.svg('check') + ' Did it</button>' +
          '<button type="button" data-act="c-skip" title="Skipped — record what got in the way">' + ICON.svg('x-mark') + ' Skipped</button>' +
          '<button type="button" data-act="c-move">→ Today</button>' +
        '</div>' +
      '</div>';
    });
    return '<div class="md-section-title">Waiting on you</div>' + cards.join('');
  }

  function distChip(item, surface, rec) {
    var meta = DD.SURFACE_LABELS[surface] || { icon: '•', label: surface };
    if (!rec || rec.status === 'skipped') {
      return '<span class="md-d-chip md-skip" title="Not sent to ' + esc(meta.label) + '">◌ ' + ICON.render(meta.icon) + '</span>';
    }
    if (rec.status === 'failed') {
      return '<button type="button" class="md-d-chip md-fail" data-act="retry" data-surface="' + esc(surface) + '" title="' + esc(rec.error || 'failed') + ' — tap to retry">' + ICON.svg('exclamation-triangle') + ' ' + ICON.render(meta.icon) + ' retry</button>';
    }
    if (rec.status === 'orphaned') {
      return '<a class="md-d-chip md-orphan" href="' + esc(DD.linkFor(rec, item) || '#') + '" title="Kept on ' + esc(meta.label) + ' (has your content)">' + ICON.svg('link') + ' ' + ICON.render(meta.icon) + '</a>';
    }
    if (rec.status === 'removed') return '';
    var extra = (rec.meta && rec.meta.needsApproval) ? ' (approval pending)' : '';
    return '<a class="md-d-chip md-ok" href="' + esc(DD.linkFor(rec, item) || '#') + '" title="On ' + esc(meta.label) + extra + '">✓ ' + ICON.render(meta.icon) + ' ' + esc(meta.label) + extra + '</a>';
  }

  function renderTimeline() {
    var items = dayItems();
    if (!items.length) {
      return '<div class="md-empty">Nothing planned yet. ' +
        '<button type="button" class="md-empty-add" data-act="open-composer">' + ICON.svg('plus') + ' Plan a step</button></div>';
    }
    return items.map(function (it) {
      var dists = it.distributions || {};
      var chips = Object.keys(dists).map(function (s) { return distChip(it, s, dists[s]); }).join('');
      var det = it.details || {};
      var comboBits = [];
      // V3.623 — chained follow-up marker (this item continues last week's)
      if (it.follow_up_of) comboBits.push('<span class="md-fu-tag" title="Follows up an earlier step">' + ICON.svg('arrow-path') + ' follow-up</span>');
      if (det.focusTitle) comboBits.push(ICON.svg('target') + ' ' + esc(det.focusTitle));
      if (det.protocolTitle) comboBits.push(ICON.svg('clipboard-document-list') + ' ' + esc(det.protocolTitle));
      if (det.subtaskText) comboBits.push(ICON.svg('check-circle') + ' ' + esc(det.subtaskText));
      // V3.588 — surface criticality only when it's above the quiet default,
      // so a Soft day stays visually clean.
      if (det.equipmentId && (det.priority === 'high' || det.priority === 'urgent')) {
        comboBits.push('<span class="md-crit-chip md-crit-chip--' + det.priority + '">'
          + (det.priority === 'urgent' ? 'Hard' : 'On time') + '</span>');
      }
      var doneBtn = it.status === 'planned'
        ? '<button type="button" data-act="i-done" title="Done — record the result">' + ICON.svg('check') + '</button>' : '';
      return '<div class="md-item' + (it.status === 'done' ? ' md-done' : '') + '" data-id="' + esc(it.id) + '">' +
        '<div class="md-i-icon">' + (TYPE_ICONS[it.type] ? ICON.render(TYPE_ICONS[it.type]) : '•') + '</div>' +
        '<div class="md-i-main">' +
          '<div class="md-i-title">' + esc(it.title) + '</div>' +
          (it.startTime ? '<div class="md-i-time">' + fmtTime(it.startTime) + (it.endTime ? '–' + fmtTime(it.endTime) : '') + '</div>' : '') +
          (comboBits.length ? '<div class="md-i-combo">' + comboBits.join(' · ') + '</div>' : '') +
          (it.notes ? '<div class="md-i-notes">' + esc(it.notes) + '</div>' : '') +
          (function () { // V3.623 — outcome chip row
            var oc = outcomeChipHtml(it);
            return oc ? '<div class="md-i-outcome">' + oc + '</div>' : '';
          })() +
          (chips ? '<div class="md-i-dist">' + chips + '</div>' : '') +
        '</div>' +
        '<div class="md-i-actions">' + doneBtn +
          '<button type="button" data-act="i-edit" title="Edit">' + ICON.svg('pencil') + '</button>' +
          '<button type="button" data-act="i-del" title="Delete">' + ICON.svg('trash') + '</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  /* ── composer (ingredient builder, V3.538) ────────────────── */

  function renderComposer() {
    var c = state.comp;
    var all = computeSurfaces();

    var ingRow = INGREDIENTS.map(function (t) {
      var on = c.mode === 'compose' && c.ingredients.has(t.key);
      return '<button type="button" class="md-type' + (on ? ' md-active' : '') + '" data-ingredient="' + t.key + '">' + ICON.render(t.icon) + ' ' + t.label + '</button>';
    }).join('');
    var simpleRow = SIMPLE_TYPES.map(function (t) {
      return '<button type="button" class="md-type md-simple' + (c.mode === t.key ? ' md-active' : '') + '" data-simple="' + t.key + '">' + ICON.render(t.icon) + ' ' + t.label + '</button>';
    }).join('');

    var fields = '';
    if (c.mode === 'compose') {
      if (c.ingredients.has('focus')) fields += renderFocusField();
      if (c.ingredients.has('protocol')) fields += renderProtocolField();
      if (c.ingredients.has('task')) fields += renderTaskField();
      if (c.ingredients.has('equipment')) fields += renderEquipmentField();
    }

    var suggestion = suggestedTitle();
    var destChips = all.map(function (s) {
      var meta = DD.SURFACE_LABELS[s] || { icon: '•', label: s };
      var on = c.surfaces.has(s);
      return '<button type="button" class="md-dest' + (on ? ' md-on' : '') + '" data-dest="' + s + '">' + ICON.render(meta.icon) + ' ' + meta.label + '</button>';
    }).join('');
    var autoNote = (state.prefs && state.prefs.auto_distribute)
      ? 'Auto-distribute is on — sending to ' + c.surfaces.size + ' surface' + (c.surfaces.size === 1 ? '' : 's')
      : 'Pick where this goes:';

    var timeRow = (c.mode === 'compose' && c.ingredients.has('equipment'))
      ? '' // date+time set by the drag strip; fine-tune inputs live inside the equipment field
      : '<input type="date" data-field="date" value="' + esc(c.date) + '">' +
        '<input type="time" data-field="startTime" value="' + esc(c.startTime) + '">' +
        '<input type="time" data-field="endTime" value="' + esc(c.endTime) + '">';

    return '<div class="md-composer md-open"><div class="md-comp-inner">' +
      '<div class="md-comp-header">' +
        '<span class="md-comp-htitle">' + (state.editingId ? 'Edit step' : 'Plan a step') + '</span>' +
        '<button type="button" class="md-comp-fold" data-act="fold-composer" aria-label="Fold away">▾</button>' +
      '</div>' +
      '<div class="md-typerow">' + ingRow + '<span class="md-typegap"></span>' + simpleRow + '</div>' +
      '<div class="md-comp-grid">' +
        '<input type="text" data-field="title" placeholder="' + esc(suggestion || placeholderFor(derivedType())) + '" value="' + esc(c.title) + '">' +
        (suggestion && !c.title ? '<div class="md-ghost">' + ICON.svg('sparkles') + ' Suggested: <button type="button" data-act="use-suggestion">' + esc(suggestion) + '</button></div>' : '') +
        timeRow +
        fields +
      '</div>' +
      '<div class="md-destrow"><span class="md-dest-lead">' + autoNote + '</span>' + destChips + '</div>' +
      '<div class="md-comp-actions">' +
        (state.editingId ? '<button type="button" class="md-cancel-edit" data-act="cancel-edit">Cancel</button>' : '') +
        '<button type="button" class="md-add" data-act="add">' + (state.editingId ? 'Save changes' : '＋ Add to my day') + '</button>' +
      '</div>' +
    '</div></div>';
  }

  /* V3.717 — the composer's two focus dropdowns. Dropdown 1 always resolves
   * to exactly ONE grant; dropdown 2 narrows to the aim or output under it.
   * Both indexes are rebuilt from FOCUS_AREAS.rowsByGrant on every load. */
  function buildGrantIndex(groups) {
    state.fociGroups = groups || [];
    state.grantRows = [];
    state.grantChildren = {};
    state.grantOfCard = {};
    state.fociGroups.forEach(function (g) {
      if (!g.grant) return;
      state.grantRows.push(g.grant);
      state.grantChildren[g.grant.id] = g.rows.filter(function (r) {
        return r.level === 'aim' || r.level === 'output';
      });
      // Every row in the bucket — the grant itself included — maps back to
      // the grant, so a focus_ref at ANY level resolves in one lookup.
      g.rows.forEach(function (r) { state.grantOfCard[r.id] = g.grant.id; });
    });
  }

  /* Which grant is dropdown 1 currently pointing at? A semester focus and a
   * grant pick name one directly; an existing weekly focus reaches one
   * through its focus_ref. Null means "no grant yet" — dropdown 2 stays
   * hidden rather than offering the whole map. */
  function resolvedGrantId() {
    var c = state.comp;
    var fid = c.focusId || '';
    function viaRef(ref) {
      if (!ref || !ref.id) return null;
      return state.grantOfCard[ref.id] || null;
    }
    if (fid.indexOf('grant:') === 0) return fid.slice(6);
    if (fid.indexOf('sem:') === 0) {
      var sf = state.semFocuses.find(function (x) { return 'sem:' + x.id === fid; });
      return sf ? viaRef(sf.focus_ref) : null;
    }
    if (fid === '__free__') {
      var sf2 = state.semFocuses.find(function (x) { return x.id === c.semesterFocusId; });
      return sf2 ? viaRef(sf2.focus_ref) : null;
    }
    if (fid) {
      var w = state.focuses.find(function (x) { return x.id === fid; });
      return w ? viaRef(w.focus_ref) : null;
    }
    return null;
  }

  function renderFocusField() {
    var c = state.comp;
    var opts = state.focuses
      .slice()
      .sort(function (a, b) { // confirmed first, then proposed/edited
        var rank = { confirmed: 0, mentee_edited: 1, proposed: 2, reported: 3 };
        return (rank[a.status] || 9) - (rank[b.status] || 9);
      })
      .map(function (f) {
        var tag = f.status === 'confirmed' ? '' : ' (' + (FA.STATUS_META[f.status] || {}).label + ')';
        return '<option value="' + esc(f.id) + '"' + (c.focusId === f.id ? ' selected' : '') + '>' + esc(f.title) + esc(tag) + '</option>';
      }).join('');
    var free = c.focusId === '__free__';
    /* V3.717 — DROPDOWN 2. Where V3.550 offered the whole card map on
     * freeform proposals only, this offers exactly the aims and outputs of
     * the grant dropdown 1 resolved to — on every pick, not just freeform.
     * Leaving it empty is a real answer: the week counts against the grant
     * itself. Analysis rows still indent under their card (V3.602), and
     * their composite key is what carries the roadmapClaims mirror. */
    var grantId = resolvedGrantId();
    var kids = grantId ? (state.grantChildren[grantId] || []) : [];
    var alignSel = '';
    if (kids.length) {
      var gRow = state.grantRows.find(function (g) { return g.id === grantId; });
      alignSel = '<select data-field="focusAlignId">' +
        '<option value="">Anything under ' +
          esc(gRow ? gRow.title : 'this grant') + '… (optional)</option>' +
        kids.map(function (rf) {
          var k = rf.key || rf.id;
          var text = rf.analysis_title
            ? '  ↳ ' + rf.analysis_title
            : rf.title;
          return '<option value="' + esc(k) + '"' + (c.focusAlignId === k ? ' selected' : '') + '>' + esc(text) + '</option>';
        }).join('') +
      '</select>';
    }
    // V3.715 — the semester group: picking a semester focus creates (or
    // reuses) a weekly focus nested under it, so the week's work lands on
    // the running list Team Focus shows per semester focus.
    var semGroup = '';
    if (state.semFocuses.length) {
      semGroup = '<optgroup label="Semester foci — start this week under…">' +
        state.semFocuses.filter(function (sf) { return sf.status !== 'reported'; }).map(function (sf) {
          var k = 'sem:' + sf.id;
          return '<option value="' + esc(k) + '"' + (c.focusId === k ? ' selected' : '') + '>' + esc(sf.title || '(untitled)') + '</option>';
        }).join('') +
      '</optgroup>';
    }
    // V3.715 — a freeform proposal can also nest under a semester focus.
    var semSel = '';
    if (free && state.semFocuses.length) {
      semSel = '<select data-field="semesterFocusId">' +
        '<option value="">Under semester focus… (optional)</option>' +
        state.semFocuses.filter(function (sf) { return sf.status !== 'reported'; }).map(function (sf) {
          return '<option value="' + esc(sf.id) + '"' + (c.semesterFocusId === sf.id ? ' selected' : '') + '>' + esc(sf.title || '(untitled)') + '</option>';
        }).join('') +
      '</select>';
    }
    // V3.717 — start a week directly under a grant, with no semester focus
    // standing between. The created weekly focus gets a grant-level
    // focus_ref, which dropdown 2 can then narrow.
    var grantGroup = '';
    if (state.grantRows.length) {
      grantGroup = '<optgroup label="Grants — start this week under…">' +
        state.grantRows.map(function (g) {
          var k = 'grant:' + g.id;
          return '<option value="' + esc(k) + '"' + (c.focusId === k ? ' selected' : '') + '>' +
            esc(g.title) + '</option>';
        }).join('') +
      '</optgroup>';
    }
    return '<select data-field="focusId">' +
        '<option value="">Pick this week’s focus…</option>' + opts +
        semGroup +
        grantGroup +
        '<option value="__free__"' + (free ? ' selected' : '') + '>Something else (unassigned)…</option>' +
      '</select>' +
      (free ? '<input type="text" data-field="focusFreeText" placeholder="Describe the focus — your mentor will see it as proposed" value="' + esc(c.focusFreeText) + '">' : '') +
      semSel +
      alignSel;
  }

  function renderProtocolField() {
    var c = state.comp;
    var popts = state.protocols.map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (c.protocolId === p.id ? ' selected' : '') + '>' + esc(p.title) + '</option>';
    }).join('');
    return '<select data-field="protocolId"><option value="">Pick a protocol…</option>' + popts + '</select>';
  }

  function renderTaskField() {
    var c = state.comp;
    var groups = '';
    var focusGroups = state.focuses.map(function (f) {
      var open = (f.tasks || []).filter(function (t) { return !t.done; });
      if (!open.length) return '';
      return '<optgroup label="' + esc(f.title) + '">' + open.map(function (t) {
        return '<option value="ft:' + esc(t.id) + '"' + (c.focusTaskId === t.id ? ' selected' : '') + '>' + esc(t.text) + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
    if (focusGroups) groups += focusGroups;
    if (state.bucketTasks.length) {
      groups += '<optgroup label="Other tasks (Tasks page)">' + state.bucketTasks.map(function (t) {
        return '<option value="bt:' + esc(t.id) + '"' + (state.comp.subtaskId === t.id ? ' selected' : '') + '>' + esc(t.text) + '</option>';
      }).join('') + '</optgroup>';
    }
    return '<select data-field="taskPick"><option value="">Pick a task…</option>' + groups + '</select>';
  }

  function renderEquipmentField() {
    var c = state.comp;
    var opts = state.equipment.map(function (e) {
      return '<option value="' + esc(e.id) + '"' + (c.equipmentId === e.id ? ' selected' : '') + '>' + esc(e.shortName || e.name) + '</option>';
    }).join('');
    return '<select data-field="equipmentId"><option value="">Pick equipment…</option>' + opts + '</select>' +
      '<div class="md-avail" id="md-avail"></div>' +
      '<div class="md-finetune">' +
        '<input type="date" data-field="date" value="' + esc(c.date) + '">' +
        '<input type="time" data-field="startTime" value="' + esc(c.startTime) + '">' +
        '<input type="time" data-field="endTime" value="' + esc(c.endTime) + '">' +
      '</div>' +
      renderCriticalityField(c);
  }

  /* V3.588 — how critical is this booking? Drives the adjacency
     notification engine: a Soft booking never pressures the person
     before it, a Hard booking tells them to end on time. Stored as
     the existing `priority` enum on equipmentBookings. */
  function renderCriticalityField(c) {
    var cur = c.priority || 'normal';
    var levels = [
      ['normal', 'Soft book'],
      ['high',   'Needed on time'],
      ['urgent', 'Hard book'],
    ];
    var opts = levels.map(function (pair) {
      return '<option value="' + pair[0] + '"' + (cur === pair[0] ? ' selected' : '') + '>' + pair[1] + '</option>';
    }).join('');
    return '<div class="md-crit">' +
      '<label class="md-crit-label">How critical is this booking?</label>' +
      '<select data-field="priority">' + opts + '</select>' +
      '<div class="md-crit-hint">' + esc(criticalityHint(cur)) + '</div>' +
    '</div>';
  }

  function criticalityHint(p) {
    switch (p) {
      case 'high':   return 'Must start on time, but the length is flexible. Neighbors are told to hand off promptly.';
      case 'urgent': return 'No flexibility — mission critical. Neighbors are told to end on time.';
      default:       return 'Flexible. Running a bit late is fine and nobody downstream is nudged.';
    }
  }

  function placeholderFor(type) {
    switch (type) {
      case 'equipment': return 'What are you running?';
      case 'meeting':   return 'Who / what about?';
      case 'reading':   return 'What are you reading?';
      case 'order':     return 'What do you need ordered?';
      case 'help':      return 'What do you need help with?';
      default:          return 'What does this step accomplish?';
    }
  }

  /* ── stacked-day drag availability strip (V3.539) ─────────── */

  var DAY_START = 7 * 60, DAY_END = 21 * 60, SNAP = 15;
  var _drag = null; // { date, barEl, startMin, endMin }

  function pctOf(min) {
    return Math.max(0, Math.min(100, ((min - DAY_START) / (DAY_END - DAY_START)) * 100));
  }

  async function renderAvailStrip() {
    var host = document.getElementById('md-avail');
    if (!host || !window.EQUIP_AVAIL) return;
    var c = state.comp;
    state.slotCheck = null;
    if (!c.equipmentId) { host.innerHTML = ''; updateAddEnabled(); return; }
    host.innerHTML = '<div class="md-a-msg">Loading 7-day availability…</div>';

    var today = localToday();
    var days = [];
    for (var i = 0; i < 7; i++) days.push(shiftDate(today, i));

    await loadComposerWatches();   // V3.598 — chips under the strip
    var equip = await EQUIP_AVAIL.getEquipment(c.equipmentId);
    var r = EQUIP_AVAIL.availabilityRestrictions(equip);
    var lists = await Promise.all(days.map(function (d) { return EQUIP_AVAIL.listForDay(c.equipmentId, d); }));
    state.dayBookings = {};
    days.forEach(function (d, i) { state.dayBookings[d] = lists[i]; });

    var rows = days.map(function (d) {
      var lbl = fmtDateLabel(d);
      var dow = new Date(d + 'T00:00:00').getDay();
      var closedDay = r && r.days && r.days.indexOf(dow) < 0;
      var blocks = (state.dayBookings[d] || []).map(function (b) {
        var bs = EQUIP_AVAIL.timeToMin(b.startTime), be = EQUIP_AVAIL.timeToMin(b.endTime);
        if (bs == null || be == null) return '';
        return '<div class="md-a-block" style="left:' + pctOf(bs) + '%;width:' + (pctOf(be) - pctOf(bs)) + '%" title="' +
          esc((b.userName || '') + ' ' + b.startTime + '–' + b.endTime) + '"></div>';
      }).join('');
      var closed = '';
      if (closedDay) {
        closed = '<div class="md-a-closed" style="left:0;right:0"></div>';
      } else if (r) {
        if (r.startMin > DAY_START) closed += '<div class="md-a-closed" style="left:0;width:' + pctOf(r.startMin) + '%"></div>';
        if (r.endMin < DAY_END) closed += '<div class="md-a-closed" style="left:' + pctOf(r.endMin) + '%;right:0"></div>';
      }
      var mine = '';
      if (c.date === d && c.startTime && c.endTime) {
        var sm = EQUIP_AVAIL.timeToMin(c.startTime), em = EQUIP_AVAIL.timeToMin(c.endTime);
        if (sm != null && em != null && em > sm) {
          var bad = state.slotCheck && !state.slotCheck.ok;
          mine = '<div class="md-a-mine' + (bad ? ' md-a-bad' : '') + '" style="left:' + pctOf(sm) + '%;width:' + (pctOf(em) - pctOf(sm)) + '%"></div>';
        }
      }
      return '<div class="md-a-row">' +
        '<span class="md-a-daylabel' + (d === c.date ? ' md-a-sel' : '') + '">' + esc(lbl.rel === 'Today' || lbl.rel === 'Tomorrow' ? lbl.rel : lbl.full.split(',')[0]) + '<em>' + esc(d.slice(5)) + '</em></span>' +
        '<div class="md-avail-bar" data-avail-date="' + d + '">' + closed + blocks + mine + '</div>' +
      '</div>';
    }).join('');

    var msg = '<div class="md-a-msg">Drag on a day to pick your slot — gray is booked, hatched is outside ' + esc(equip && (equip.shortName || equip.name) || 'the device') + '’s posted hours.</div>';
    var watchCta = '';
    if (c.date && c.startTime && c.endTime) {
      var check = await EQUIP_AVAIL.checkSlot(c.equipmentId, c.date, c.startTime, c.endTime, state.editingId || undefined);
      state.slotCheck = check;
      if (!check.ok) {
        msg = '<div class="md-a-msg md-a-err">' + esc(check.reason || 'Slot unavailable') + '</div>';
        // V3.598 — the slot you want is taken. Rather than leaving you to
        // re-check the calendar every hour, offer to watch it. Gated on
        // `bookings`, which checkSlot returns ONLY from its clash branch:
        // a slot refused for being outside posted hours or past the
        // advance limit will never "free up", so offering to watch it
        // would be a lie.
        if (check.bookings && check.bookings.length) {
          watchCta = '<button type="button" class="md-a-watch" data-act="watch-slot">'
            + ICON.svg('bell') + ' Notify me if ' + esc(fmtTime(c.startTime)) + '–' + esc(fmtTime(c.endTime))
            + ' frees up</button>';
        }
      }
      else if (check.needsApproval) msg = '<div class="md-a-msg md-a-warn">Over the standard max duration — booking will need manager approval.</div>';
      else msg = '<div class="md-a-msg md-a-ok">' + esc(fmtDateLabel(c.date).rel) + ' ' + fmtTime(c.startTime) + '–' + fmtTime(c.endTime) + ' is free ' + ICON.svg('check') + '</div>';
    }

    host.innerHTML =
      '<div class="md-a-scale"><span></span><span>7am</span><span>12pm</span><span>5pm</span><span>9pm</span></div>' +
      rows + msg + watchCta + renderWatchChips();
    wireDrag(host);
    // re-render the selection overlay now that slotCheck is known
    if (state.slotCheck && !state.slotCheck.ok) {
      var sel = host.querySelector('.md-a-mine');
      if (sel) sel.classList.add('md-a-bad');
    }
    updateAddEnabled();
  }

  /* V3.598 — watches the user already has on the composer's device+date,
   * so they can see (and drop) them without leaving My Week. Rendered from
   * state; `loadComposerWatches()` refreshes it. */
  function renderWatchChips() {
    if (!state.compWatches.length) return '';
    var chips = state.compWatches.map(function (w) {
      return '<span class="md-a-wchip">' + ICON.svg('bell') + ' ' + esc(fmtTime(w.startTime)) + '–' + esc(fmtTime(w.endTime)) +
        '<button type="button" data-act="watch-drop" data-watch="' + esc(w.id) + '" aria-label="Stop watching">✕</button></span>';
    }).join('');
    return '<div class="md-a-wchips"><span class="md-a-wlabel">Watching:</span>' + chips + '</div>';
  }

  async function loadComposerWatches() {
    var c = state.comp;
    if (!c || !c.equipmentId || !window.EQUIP_AVAIL || !EQUIP_AVAIL.listWatches) {
      state.compWatches = [];
      return;
    }
    state.compWatches = await EQUIP_AVAIL.listWatches(c.equipmentId, c.date);
  }

  function wireDrag(host) {
    host.querySelectorAll('.md-avail-bar').forEach(function (bar) {
      bar.addEventListener('pointerdown', function (ev) {
        ev.preventDefault();
        var rect = bar.getBoundingClientRect();
        var min = posToMin(ev.clientX, rect);
        _drag = { date: bar.getAttribute('data-avail-date'), barEl: bar, startMin: min, endMin: min + SNAP };
        bar.setPointerCapture(ev.pointerId);
        paintDrag();
      });
      bar.addEventListener('pointermove', function (ev) {
        if (!_drag || _drag.barEl !== bar) return;
        var rect = bar.getBoundingClientRect();
        var min = posToMin(ev.clientX, rect);
        if (min <= _drag.startMin) _drag.endMin = _drag.startMin + SNAP;
        else _drag.endMin = min;
        paintDrag();
      });
      bar.addEventListener('pointerup', async function (ev) {
        if (!_drag || _drag.barEl !== bar) return;
        var d = _drag;
        _drag = null;
        state.comp.date = d.date;
        state.comp.startTime = minToTime(Math.min(d.startMin, d.endMin));
        state.comp.endTime = minToTime(Math.max(d.startMin + SNAP, d.endMin));
        syncFinetuneInputs();
        await renderAvailStrip();
      });
      bar.addEventListener('pointercancel', function () { _drag = null; });
    });
  }

  function posToMin(clientX, rect) {
    var frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    var min = DAY_START + frac * (DAY_END - DAY_START);
    return Math.round(min / SNAP) * SNAP;
  }

  function paintDrag() {
    if (!_drag) return;
    var bar = _drag.barEl;
    var sel = bar.querySelector('.md-a-drag');
    if (!sel) {
      sel = document.createElement('div');
      sel.className = 'md-a-mine md-a-drag';
      bar.appendChild(sel);
    }
    var s = Math.min(_drag.startMin, _drag.endMin);
    var e = Math.max(_drag.startMin + SNAP, _drag.endMin);
    sel.style.left = pctOf(s) + '%';
    sel.style.width = (pctOf(e) - pctOf(s)) + '%';
  }

  function syncFinetuneInputs() {
    var c = state.comp;
    var root = document.querySelector('.md-finetune');
    if (!root) return;
    var di = root.querySelector('input[data-field="date"]');
    var si = root.querySelector('input[data-field="startTime"]');
    var ei = root.querySelector('input[data-field="endTime"]');
    if (di) di.value = c.date;
    if (si) si.value = c.startTime;
    if (ei) ei.value = c.endTime;
  }

  function updateAddEnabled() {
    var btn = document.querySelector('.md-comp-actions .md-add');
    if (!btn) return;
    var c = state.comp;
    var needsEquipment = c.mode === 'compose' && c.ingredients.has('equipment');
    var titleOk = !!(c.title.trim() || suggestedTitle());
    var bad = !titleOk
      || (needsEquipment && (!c.equipmentId || !c.startTime || !c.endTime))
      || (needsEquipment && state.slotCheck && !state.slotCheck.ok && c.surfaces.has('equipment'));
    btn.disabled = !!bad;
  }

  /* ── report dialog (V3.540) ───────────────────────────────── */

  async function openReportDialog(focus) {
    var me = firebridge.getUser().uid;
    // notebook entries from this week for linking
    var entries = [];
    try {
      var snap = await firebridge.db().collection('userData').doc(me)
        .collection('notebook').doc('_index').get();
      var mon = mondayOf(localToday());
      var sun = shiftDate(mon, 6);
      entries = (((snap.exists && snap.data()) || {}).entries || [])
        .filter(function (r) { return r && r.date >= mon && r.date <= sun; }).slice(0, 20);
    } catch (e) { /* linking is optional */ }

    var overlay = document.createElement('div');
    overlay.className = 'md-report-overlay';
    overlay.innerHTML =
      '<div class="md-report-dialog">' +
        '<div class="md-report-head">Report on “' + esc(focus.title) + '”</div>' +
        '<div class="md-report-outcomes">' +
          Object.keys(FA.OUTCOME_META).map(function (k) {
            var om = FA.OUTCOME_META[k];
            return '<label><input type="radio" name="md-outcome" value="' + k + '"' + (k === 'partial' ? ' checked' : '') + '> ' + ICON.render(om.icon) + ' ' + om.label + '</label>';
          }).join('') +
        '</div>' +
        '<textarea id="md-report-summary" rows="3" placeholder="Two sentences: what happened, and what you concluded. The full story belongs in the notebook entry…"></textarea>' +
        '<div class="md-report-entries">' +
          '<div class="md-report-sub">Notebook entries carrying the narrative:</div>' +
          entries.map(function (r) {
            return '<label><input type="checkbox" class="md-report-nb" value="' + esc(r.id) + '"> ' + ICON.svg('book-open') + ' ' + esc(r.title || '(untitled)') + ' <em>' + esc(r.date) + '</em></label>';
          }).join('') +
          '<label><input type="checkbox" id="md-report-create" checked> ' + ICON.svg('plus') + ' Create a “Report: ' + esc(focus.title) + '” notebook entry to write it up</label>' +
        '</div>' +
        '<div class="md-report-actions">' +
          '<button type="button" class="md-r-cancel">Cancel</button>' +
          '<button type="button" class="md-r-save">Save report</button>' +
        '</div>' +
      '</div>';

    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay || ev.target.classList.contains('md-r-cancel')) overlay.remove();
    });
    overlay.querySelector('.md-r-save').addEventListener('click', async function () {
      var outcome = (overlay.querySelector('input[name="md-outcome"]:checked') || {}).value || 'partial';
      var summary = (overlay.querySelector('#md-report-summary') || {}).value || '';
      var ids = Array.from(overlay.querySelectorAll('.md-report-nb:checked')).map(function (el) { return el.value; });
      var createEntry = (overlay.querySelector('#md-report-create') || {}).checked;
      overlay.remove();
      try {
        if (createEntry && typeof notebookEmptyEntry === 'function') {
          var entry = notebookEmptyEntry();
          entry.id = 'nb-report-' + focus.id;
          entry.ownerUid = me;
          entry.title = 'Report: ' + focus.title;
          entry.date = localToday();
          entry.phase = 'complete';
          entry.tags = ['focus-report'];
          entry.body_html = '<p><strong>Focus:</strong> ' + esc(focus.title) + ' — outcome: ' + esc(outcome) + '</p><p></p>';
          entry.reference_links = [{ kind: 'other', label: 'Weekly focus', url: '/rm/pages/team-focus.html' }];
          var ref = firebridge.db().collection('userData').doc(me).collection('notebook');
          var existing = await ref.doc(entry.id).get();
          if (!existing.exists) {
            await ref.doc(entry.id).set(entry);
            if (window.DAY_DISTRIBUTE && DAY_DISTRIBUTE.notebookUpsertIndexRow) {
              await DAY_DISTRIBUTE.notebookUpsertIndexRow(entry);
            }
          }
          ids.push(entry.id);
        }
        await FA.saveReport(me, focus, { outcome: outcome, summary: summary, notebook_entry_ids: ids });
        toast('success', 'Reported — it flows into your PMR review. Write the full story in the notebook entry.');
        if (createEntry) {
          window.open('/rm/pages/notebook.html?entry=' + encodeURIComponent('nb-report-' + focus.id), '_blank');
        }
        await loadFocuses();
        render();
      } catch (err) {
        console.error('[my-week] report failed:', err);
        toast('error', 'Could not save the report: ' + (err && err.message));
      }
    });
    document.body.appendChild(overlay);
  }

  /* ── outcome dialog (V3.623 · V3.853) ───────────────────────── */

  /* V3.853 — what a result points at: a SPECIFIC card on one of my figure
   * boards (papers I'm an author on → papers/{pid}/boards/main/items) or in
   * my notebook (entries with a board → userData/{me}/notebookBoards/{bid}/items),
   * chosen by EDIT TIME: cards touched since the step was planned
   * (item.created_at, else the start of its day — "plan Monday, put the
   * result on the canvas Wednesday, pick it Friday"). opts.all lifts the
   * time filter (latest 60 per board, sorted here). One query per board,
   * every read optional — the dialog opens with an empty list and says so. */
  var CANVAS_KIND_LABELS = {
    figcard: 'Planned figure', experiment: 'Experiment', panel: 'Panel', snip: 'Reference figure',
    quote: 'Quote', litref: 'Lit review', litreview: 'Lit review', note: 'Note', checklist: 'Checklist',
    figure: 'Figure / photo', html: 'HTML frame', calc: 'Calculator', protocol: 'Protocol run',
    inventory: 'Inventory item', paper: 'From a paper', action: 'Something I did',
  };
  function sinceFor(item) {
    var t = item.created_at ? new Date(item.created_at) : null;
    if (!t || isNaN(t.getTime())) { var p = (item.date || localToday()).split('-'); t = new Date(+p[0], +p[1] - 1, +p[2]); }
    return t;
  }
  function plainTextOf(html) {
    var d = document.createElement('div'); d.innerHTML = String(html || '');
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function tsOf(v) { return v && v.toDate ? v.toDate() : (typeof v === 'string' && v ? new Date(v) : null); }
  /* One listed card. Regions, instances and ink text are not results — only widgets. */
  function canvasCardRow(id, data, board) {
    if (!data || data.type !== 'widget') return null;
    var d = data.data || {};
    var cell = (d.cells && d.cells[0]) || {};
    var kindLabel = CANVAS_KIND_LABELS[data.kind] || (data.kind || 'card');
    var label = String(data.title || d.caption || cell.caption || plainTextOf(d.html) || data.text || '').trim().slice(0, 140);
    var when = tsOf(data.updatedAt) || tsOf(data.createdAt);
    return {
      kind: board.surface === 'figure_board' ? 'figure_board_item' : 'notebook_item',
      boardId: board.boardId, itemId: id, paperId: board.paperId || '', entryId: board.entryId || '',
      boardTitle: board.title || '', item_kind: data.kind || '', kindLabel: kindLabel,
      title: label || kindLabel, thumb: String(d.url || cell.url || ''), when: when,
      url: board.surface === 'figure_board'
        ? '/rm/pages/figure-board.html?paper=' + encodeURIComponent(board.paperId) + '&item=' + encodeURIComponent(id)
        : '/rm/pages/notebook.html?entry=' + encodeURIComponent(board.entryId) + '&item=' + encodeURIComponent(id),
    };
  }
  async function loadResultSources(item, opts) {
    opts = opts || {};
    var me = firebridge.getUser().uid;
    var db = firebridge.db();
    var since = sinceFor(item);
    var ts = (window.firebase && firebase.firestore && firebase.firestore.Timestamp && firebase.firestore.Timestamp.fromDate)
      ? firebase.firestore.Timestamp.fromDate(since) : since;
    var boards = [];
    try {
      var ps = await db.collection('papers').where('authorUids', 'array-contains', me).get();
      ps.forEach(function (d) {
        var p = d.data() || {};
        if (p.is_library_entry === true) return;   // library imports have no figure board of mine
        boards.push({ surface: 'figure_board', paperId: d.id, boardId: 'main', title: p.title || p.meta_title || '(untitled draft)',
          ref: db.collection('papers').doc(d.id).collection('boards').doc('main').collection('items') });
      });
    } catch (e) { /* no figure boards — the list says so */ }
    try {
      var snap = await db.collection('userData').doc(me).collection('notebook').doc('_index').get();
      var rows = (((snap.exists && snap.data()) || {}).entries || []).filter(function (r) { return r && r.id && r.board_id; });
      var sinceIso = since.toISOString();
      var sinceDay = sinceIso.slice(0, 10);
      // an entry's board is worth a query when the entry was touched (its mirror's
      // updated_at moves with its cards) or DATED since the plan; a stale, older
      // entry's board is skipped unless "Show everything" asks for it
      if (!opts.all) rows = rows.filter(function (r) {
        return !r.updated_at || String(r.updated_at) >= sinceIso || String(r.date || '') >= sinceDay;
      });
      rows.sort(function (x, y) { return String(y.updated_at || y.date || '').localeCompare(String(x.updated_at || x.date || '')); });
      rows.slice(0, 40).forEach(function (r) {
        boards.push({ surface: 'notebook', entryId: r.id, boardId: r.board_id, title: r.title || '(untitled entry)',
          ref: db.collection('userData').doc(me).collection('notebookBoards').doc(r.board_id).collection('items') });
      });
    } catch (e) { /* no notebook — the list says so */ }
    var cards = [];
    await Promise.all(boards.map(async function (b) {
      try {
        var q = opts.all ? b.ref.limit(60) : b.ref.where('updatedAt', '>=', ts).orderBy('updatedAt', 'desc').limit(40);
        var s = await q.get();
        s.forEach(function (d) { var row = canvasCardRow(d.id, d.data(), b); if (row) cards.push(row); });
      } catch (e) { console.warn('[my-week] result sources: board read failed', b.boardId, e && e.message); }
    }));
    cards.sort(function (x, y) { return (y.when ? y.when.getTime() : 0) - (x.when ? x.when.getTime() : 0); });
    return { cards: cards.slice(0, 80), since: since, boards: boards.length };
  }

  /* What came of one planned step. kinds: result / barrier / no_result
   * (DD.ITEM_OUTCOME_META). V3.853: a RESULT is evidence, not a verdict —
   * it points at the SPECIFIC card(s) on a figure board or in the notebook
   * that hold the plot or image (loadResultSources, by edit time), or a
   * photo (PAPER_FIGURES under the paper-figures/myday-<itemId> pseudo-id,
   * the PMR-barriers precedent), or a sentence; at least one. A barrier
   * needs its reason (the mentor reads it on the PMR). Layout: the step's
   * title, a three-way segmented choice, then — for a result — the cards as
   * picture tiles grouped under their board or entry, with the sentence /
   * photo below; for a barrier or no-result the text leads and the cards
   * fold into an optional "Attach a card" row. "↻ follow up next week"
   * spawns the chained item. opts.closeAs ('done' | 'skipped') means the
   * dialog IS the confirm step: the item stays planned until Save
   * (DD.saveOutcome flips the status in the same write) and Cancel leaves
   * it planned. Errors render in the pinned Save row — no browser popups.
   * onDone(saved) lets the nudge queue chain. */
  async function openOutcomeDialog(item, presetKind, onDone, opts) {
    opts = opts || {};
    var closeAs = (opts.closeAs === 'done' || opts.closeAs === 'skipped') ? opts.closeAs : null;
    var META = DD.ITEM_OUTCOME_META;
    var existing = item.outcome || null;
    var kind = META[presetKind] ? presetKind
      : (existing ? existing.kind : (item.status === 'done' ? 'result' : 'barrier'));

    var CARD_KINDS = { figure_board_item: 1, notebook_item: 1 };
    var existingLinks = (existing && Array.isArray(existing.links)) ? existing.links : [];
    var tickedIds = existingLinks.filter(function (l) { return l && CARD_KINDS[l.kind]; }).map(function (l) { return l.itemId; });
    var showAll = false;
    // a card linked earlier that the time filter (or a deleted board) no longer lists still shows, selected
    function withOrphans(list) {
      existingLinks.forEach(function (l) {
        if (!l || !CARD_KINDS[l.kind] || list.some(function (c) { return c.itemId === l.itemId; })) return;
        list.push({ kind: l.kind, boardId: l.boardId || '', itemId: l.itemId, paperId: l.paperId || '', entryId: l.entryId || '',
          boardTitle: l.boardTitle || '', item_kind: l.item_kind || '', kindLabel: CANVAS_KIND_LABELS[l.item_kind] || 'card',
          title: l.title || l.itemId, thumb: l.thumb || '', when: null, url: l.url || '' });
      });
      return list;
    }
    var src = await loadResultSources(item);
    var cards = withOrphans(src.cards);
    var sinceLabel = src.since.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    // what the user has typed / chosen — survives a re-render when the kind changes
    var summary = existing ? (existing.summary || '') : '';
    var pendingFile = null;   // File chosen but not yet uploaded — uploads on save
    var canUpload = !!window.PAPER_FIGURES;
    var fuWanted = false, fuDate = DD.nextMondayStr(), fuTitle = 'Follow up: ' + (item.title || '');
    var filterQ = '';

    var PLACEHOLDERS = {
      result: 'A sentence about it, if the card doesn’t say it all…',
      barrier: 'What blocked you, specifically? Your mentor reads this on your PMR…',
      no_result: 'What happened?…',
    };
    var lbl = fmtDateLabel(item.date || localToday());
    var eyebrow = (closeAs === 'done' ? 'Done ✓' : closeAs === 'skipped' ? 'Skipped' : 'Outcome') + ' · planned ' + lbl.full;
    var saveLabel = closeAs === 'done' ? 'Save & mark done'
      : closeAs === 'skipped' ? 'Save & mark skipped' : 'Save outcome';

    /* ── pieces ── */
    function kindsHtml() {
      return '<div class="md-oc-kinds" role="radiogroup" aria-label="What came of it">' + Object.keys(META).map(function (k) {
        return '<label class="md-oc-kind' + (k === kind ? ' md-oc-kind-on' : '') + '">' +
          '<input type="radio" name="md-oc-kind" value="' + k + '"' + (k === kind ? ' checked' : '') + '>' +
          '<span class="md-oc-kglyph">' + ICON.render(META[k].icon) + '</span><span>' + META[k].label + '</span></label>';
      }).join('') + '</div>';
    }
    // tiles grouped under the board / entry they live on, newest group first
    function groupsOf(list) {
      var map = {}, order = [];
      list.forEach(function (c) {
        var key = c.kind + ':' + (c.paperId || c.entryId || c.boardId);
        if (!map[key]) {
          map[key] = { key: key, kind: c.kind, title: c.boardTitle || (c.kind === 'figure_board_item' ? 'Figure board' : 'Notebook'), cards: [], latest: 0 };
          order.push(key);
        }
        map[key].cards.push(c);
        var t = c.when ? c.when.getTime() : 0;
        if (t > map[key].latest) map[key].latest = t;
      });
      return order.map(function (k) { return map[k]; }).sort(function (x, y) { return y.latest - x.latest; });
    }
    function tileHtml(c) {
      var on = tickedIds.indexOf(c.itemId) >= 0;
      var hay = (c.title + ' ' + c.boardTitle + ' ' + c.kindLabel).toLowerCase();
      var thumb = c.thumb
        ? '<img src="' + esc(c.thumb) + '" alt="" loading="lazy">'
        : '<span class="md-oc-tglyph">' + ICON.svg(c.kind === 'figure_board_item' ? 'chart-bar' : 'book-open') + '</span>';
      var when = c.when ? c.when.toLocaleDateString('en-US', { weekday: 'short' }) : '';
      return '<button type="button" class="md-oc-tile' + (on ? ' md-oc-tile-on' : '') + '" data-item="' + esc(c.itemId) + '" data-hay="' + esc(hay) + '" aria-pressed="' + (on ? 'true' : 'false') + '" title="' + esc(c.title) + '">' +
        '<span class="md-oc-tthumb">' + thumb + '</span>' +
        '<span class="md-oc-ttitle">' + esc(c.title) + '</span>' +
        '<span class="md-oc-tmeta">' + esc(c.kindLabel) + (when ? ' · ' + esc(when) : '') + '</span>' +
        '<span class="md-oc-tcheck" aria-hidden="true">✓</span>' +
      '</button>';
    }
    function cardsHtml() {
      if (!cards.length) {
        return '<div class="md-oc-empty">' +
          '<div>Nothing has been added to your figure boards or notebook since ' + esc(sinceLabel) + '.</div>' +
          '<div class="md-oc-empty-links">' +
            '<a href="/rm/pages/notebook.html" target="_blank" rel="noopener">Open the notebook ↗</a>' +
            '<a href="/rm/pages/paper-builder.html" target="_blank" rel="noopener">Open a figure board ↗</a>' +
          '</div></div>';
      }
      var filter = cards.length > 6
        ? '<input type="search" class="md-oc-filter" data-filter="cards" value="' + esc(filterQ) + '" placeholder="Find a card…" aria-label="Find a card">' : '';
      return filter + groupsOf(cards).map(function (g) {
        return '<div class="md-oc-group">' +
          '<div class="md-oc-ghead"><span class="md-oc-gglyph">' + ICON.svg(g.kind === 'figure_board_item' ? 'chart-bar' : 'book-open') + '</span>' +
            esc(g.title) + '<span class="md-oc-gsub">' + (g.kind === 'figure_board_item' ? 'figure board' : 'notebook') + '</span></div>' +
          '<div class="md-oc-tiles">' + g.cards.map(tileHtml).join('') + '</div>' +
        '</div>';
      }).join('');
    }
    function sourcesSection() {
      var isResult = kind === 'result';
      var more = '<button type="button" class="md-oc-more" id="md-oc-showall">' +
        (showAll ? 'Only cards since ' + esc(sinceLabel) : 'Show older cards') + '</button>';
      var body = '<div class="md-oc-cards" id="md-oc-cards">' + cardsHtml() + '</div>' + more;
      if (isResult) {
        return '<section class="md-oc-sec" id="md-oc-sources">' +
          '<h4 class="md-oc-h">Where is the result? <span class="md-oc-hsub">cards you added since ' + esc(sinceLabel) + '</span></h4>' +
          body + '</section>';
      }
      return '<details class="md-oc-sec md-oc-attach" id="md-oc-sources"' + (tickedIds.length ? ' open' : '') + '>' +
        '<summary class="md-oc-h">Attach a card that shows it <span class="md-oc-hsub">optional</span></summary>' +
        body + '</details>';
    }
    function notesSection() {
      var head = kind === 'barrier' ? 'What blocked you? <span class="md-oc-hsub md-oc-req">required</span>'
        : kind === 'no_result' ? 'What happened? <span class="md-oc-hsub">optional</span>'
        : 'A photo or a sentence <span class="md-oc-hsub">optional</span>';
      var imgRow = canUpload
        ? '<div class="md-oc-imgrow">' +
            ((existing && existing.image && existing.image.download_url && !pendingFile)
              ? '<img class="md-oc-thumb" src="' + esc(existing.image.download_url) + '" alt="outcome image">' : '') +
            '<label class="md-oc-imgbtn">' + ICON.svg('photo') + ' ' +
              (pendingFile ? 'Change photo' : (existing && existing.image) ? 'Replace photo' : 'Add a photo') +
              '<input type="file" id="md-oc-img" accept="image/*" hidden></label>' +
            '<span class="md-oc-imgname" id="md-oc-imgname">' + esc(pendingFile ? pendingFile.name : '') + '</span>' +
          '</div>'
        : '';
      return '<section class="md-oc-sec" id="md-oc-notes"><h4 class="md-oc-h">' + head + '</h4>' +
        '<textarea id="md-oc-summary" rows="' + (kind === 'result' ? 2 : 3) + '" placeholder="' + esc(PLACEHOLDERS[kind]) + '">' + esc(summary) + '</textarea>' +
        imgRow + '</section>';
    }
    function followUpSection() {
      if (existing && existing.follow_up_item_id) {
        return '<div class="md-oc-fudone">' + ICON.svg('arrow-path') + ' A follow-up is already planned for this step.</div>';
      }
      return '<div class="md-oc-fu-block">' +
        '<label class="md-oc-furow"><input type="checkbox" id="md-oc-fu"' + (fuWanted ? ' checked' : '') + '> ' + ICON.svg('arrow-path') + ' Follow up next week</label>' +
        '<div class="md-oc-fu-fields" id="md-oc-fu-fields"' + (fuWanted ? '' : ' hidden') + '>' +
          '<input type="date" id="md-oc-fu-date" value="' + esc(fuDate) + '">' +
          '<input type="text" id="md-oc-fu-title" value="' + esc(fuTitle) + '">' +
        '</div></div>';
    }
    function bodyHtml() {
      var parts = kind === 'result' ? [sourcesSection(), notesSection()] : [notesSection(), sourcesSection()];
      return parts.join('') + followUpSection();
    }

    var overlay = document.createElement('div');
    overlay.className = 'md-report-overlay';
    overlay.innerHTML =
      '<div class="md-report-dialog md-oc-dialog md-oc-k-' + kind + '">' +
        '<div class="md-oc-head">' +
          '<div class="md-oc-eyebrow">' + esc(eyebrow) + '</div>' +
          '<div class="md-oc-title">' + esc(item.title || '(untitled step)') + '</div>' +
        '</div>' +
        kindsHtml() +
        '<div id="md-oc-body">' + bodyHtml() + '</div>' +
        // the error lives IN the pinned Save row, so it is never hidden under it on a phone
        '<div class="md-report-actions">' +
          '<div class="md-oc-err" id="md-oc-err" role="alert" hidden></div>' +
          '<button type="button" class="md-r-cancel">Cancel</button>' +
          '<button type="button" class="md-r-save">' + saveLabel + '</button>' +
        '</div>' +
      '</div>';

    function $(sel) { return overlay.querySelector(sel); }
    function kindNow() { return kind; }
    function rememberInputs() {
      var ta = $('#md-oc-summary'); if (ta) summary = ta.value;
      var fd = $('#md-oc-fu-date'); if (fd) fuDate = fd.value;
      var ft = $('#md-oc-fu-title'); if (ft) fuTitle = ft.value;
    }
    function renderBody() {
      rememberInputs();
      $('#md-oc-body').innerHTML = bodyHtml();
      $('.md-oc-dialog').className = 'md-report-dialog md-oc-dialog md-oc-k-' + kind;
      applyFilter();
    }
    function applyFilter() {
      var q = filterQ.trim().toLowerCase();
      overlay.querySelectorAll('.md-oc-group').forEach(function (g) {
        var any = false;
        g.querySelectorAll('.md-oc-tile').forEach(function (t) {
          var on = t.classList.contains('md-oc-tile-on');   // a chosen card never hides
          var hide = !!q && !on && (t.getAttribute('data-hay') || '').indexOf(q) < 0;
          t.hidden = hide;
          if (!hide) any = true;
        });
        g.hidden = !any;
      });
    }
    function clearError() {
      var e = $('#md-oc-err');
      e.hidden = true; e.textContent = '';
      var s = $('#md-oc-sources'); if (s) s.classList.remove('md-oc-invalid');
      var t = $('#md-oc-summary'); if (t) t.classList.remove('md-oc-invalid');
    }
    // The error sits in the Save row; the first field to fix takes focus.
    function showError(msg, where) {
      var e = $('#md-oc-err');
      e.textContent = msg; e.hidden = false;
      var sources = $('#md-oc-sources'), ta = $('#md-oc-summary');
      if (sources) sources.classList.toggle('md-oc-invalid', where === 'sources');
      if (ta) ta.classList.toggle('md-oc-invalid', where === 'summary');
      if (where === 'sources' && sources) {
        if (sources.tagName === 'DETAILS') sources.open = true;
        var first = sources.querySelector('.md-oc-tile:not([hidden])');
        (first || ta).focus();
      } else if (ta) ta.focus();
    }

    overlay.addEventListener('change', async function (ev) {
      var t = ev.target;
      if (t.name === 'md-oc-kind') {
        kind = META[t.value] ? t.value : kind;
        overlay.querySelectorAll('.md-oc-kind').forEach(function (l) { l.classList.toggle('md-oc-kind-on', l.querySelector('input').value === kind); });
        renderBody();
        clearError();
        return;
      }
      if (t.id === 'md-oc-fu') {
        fuWanted = !!t.checked;
        var f = $('#md-oc-fu-fields'); if (f) f.hidden = !fuWanted;
        return;
      }
      if (t.id === 'md-oc-img') {
        pendingFile = t.files && t.files[0] ? t.files[0] : null;
        var nm = $('#md-oc-imgname'); if (nm) nm.textContent = pendingFile ? pendingFile.name : '';
        clearError();
      }
    });
    overlay.addEventListener('input', function (ev) {
      var t = ev.target;
      if (t.classList && t.classList.contains('md-oc-filter')) { filterQ = t.value; applyFilter(); return; }
      if (t.id === 'md-oc-summary') { summary = t.value; clearError(); }
    });
    overlay.addEventListener('click', async function (ev) {
      var tile = ev.target.closest && ev.target.closest('.md-oc-tile');
      if (tile) {
        var id = tile.getAttribute('data-item');
        var i = tickedIds.indexOf(id);
        if (i >= 0) tickedIds.splice(i, 1); else tickedIds.push(id);
        tile.classList.toggle('md-oc-tile-on', i < 0);
        tile.setAttribute('aria-pressed', i < 0 ? 'true' : 'false');
        clearError();
        return;
      }
      var more = ev.target.closest && ev.target.closest('#md-oc-showall');
      if (more) {   // lift / restore the time filter and re-list; chosen cards stay chosen
        more.disabled = true; more.textContent = 'Loading…';
        showAll = !showAll;
        try {
          var fresh = await loadResultSources(item, { all: showAll });
          cards = withOrphans(fresh.cards);
        } catch (e) { /* keep the current list */ }
        rememberInputs();
        var sec = $('#md-oc-sources');
        if (sec) { sec.outerHTML = sourcesSection(); applyFilter(); }
        return;
      }
      if (ev.target === overlay || ev.target.classList.contains('md-r-cancel')) {
        overlay.remove();
        // V3.853 — the click was the confirm; backing out means nothing was confirmed.
        if (closeAs && item.status === 'planned') {
          toast('info', closeAs === 'done'
            ? 'Still planned — a step is marked done when its result is saved.'
            : 'Still planned — nothing was skipped.');
        }
        if (typeof onDone === 'function') onDone(false);
      }
    });
    $('.md-r-save').addEventListener('click', async function () {
      var saveBtn = $('.md-r-save');
      rememberInputs();
      var picked = cards.filter(function (c) { return tickedIds.indexOf(c.itemId) >= 0; });
      var text = summary.trim();
      var hasImage = !!pendingFile || !!(existing && existing.image && existing.image.download_url);
      // V3.853 — required fields, checked here and shown here
      if (kind === 'result' && !picked.length && !hasImage && !text) {
        showError('A result needs evidence: pick the card that holds it, add a photo, or write what you got.', 'sources');
        return;
      }
      if (kind === 'barrier' && !text) {
        showError('Say what blocked you — your mentor reads this on your PMR.', 'summary');
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        var image = existing ? existing.image : null;
        if (pendingFile && window.PAPER_FIGURES) {
          var up = await PAPER_FIGURES.uploadImage('myday-' + item.id, pendingFile);
          image = { storage_path: up.storage_path, download_url: up.download_url };
        }
        // card links are rebuilt from the picks; any other link kinds (and the
        // V3.623 notebook_entry_ids of an older outcome) ride along untouched
        var links = existingLinks.filter(function (l) { return !(l && CARD_KINDS[l.kind]); })
          .concat(picked.map(function (c) {
            return { kind: c.kind, boardId: c.boardId, itemId: c.itemId, paperId: c.paperId, entryId: c.entryId,
              boardTitle: c.boardTitle, item_kind: c.item_kind, title: c.title, url: c.url, thumb: c.thumb };
          }));
        var payload = { kind: kind, summary: text, image: image,
          notebook_entry_ids: (existing && existing.notebook_entry_ids) || [], links: links };
        var wasPlanned = item.status === 'planned';
        await DD.saveOutcome(item, payload, { closeAs: closeAs });
        if (wasPlanned && item.status === 'done') {
          await maybeCompleteFocusTask(item);
          await maybeCompleteMeetingWork(item);   // V3.743
        }
        var fu = fuWanted && !(existing && existing.follow_up_item_id);
        if (fu) await DD.createFollowUp(item, { date: fuDate, title: fuTitle });
        overlay.remove();
        var msg = kind === 'barrier'
          ? 'Barrier recorded — it shows on your PMR so it gets addressed.'
          : kind === 'result'
            ? ((wasPlanned && item.status === 'done') ? 'Done ✓ — result recorded' : 'Result recorded ✓')
            : 'Outcome recorded ✓';
        toast('success', msg + (fu ? ' — follow-up planned.' : ''));
        await refresh();
        if (typeof onDone === 'function') onDone(true);
      } catch (err) {
        console.error('[my-week] outcome save failed:', err);
        toast('error', 'Could not save the outcome: ' + (err && err.message));
        saveBtn.disabled = false;
        saveBtn.textContent = saveLabel;
      }
    });
    document.body.appendChild(overlay);
    applyFilter();
  }

  /* Walk the unaccounted-steps queue one dialog at a time; cancelling
   * exits the walk (the banner stays until the queue is clean). */
  function runOutcomeQueue() {
    var next = state.outcomeQueue[0];
    if (!next) { toast('success', 'All caught up — every step has a result'); return; }
    openOutcomeDialog(next, null, function (saved) {
      if (saved && state.outcomeQueue.length) runOutcomeQueue();
      else if (saved) toast('success', 'All caught up — every step has a result');
    });
  }

  /* ── event wiring ─────────────────────────────────────────── */

  function wireEvents(root) {
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    updateAddEnabled();
    if (state.comp.mode === 'compose' && state.comp.ingredients.has('equipment')) renderAvailStrip();
  }

  function findItem(el) {
    var card = el.closest('[data-id]');
    if (!card) return null;
    var id = card.getAttribute('data-id');
    return state.items.find(function (it) { return it.id === id; })
        || state.pending.find(function (it) { return it.id === id; })
        || state.monthItems.find(function (it) { return it.id === id; }) || null;
  }

  async function onClick(ev) {
    var btn = ev.target.closest('button, a.md-d-chip');
    if (!btn) return;
    var act = btn.getAttribute('data-act');

    // V3.743 — "Assigned to you" cards
    if (act === 'plan-assigned' || act === 'assigned-done' || act === 'assigned-dismiss') {
      var card = btn.closest('.md-inbox-card');
      var taskId = card && card.getAttribute('data-task');
      if (!taskId) return;
      btn.disabled = true;
      try {
        if (act === 'plan-assigned') await planAssigned(taskId, btn.getAttribute('data-date'));
        else await finishAssigned(taskId, act === 'assigned-done');
        if (act === 'assigned-done') toast('success', 'Marked done');
        await refresh();
      } catch (e) {
        btn.disabled = false;
        toast('error', 'Could not update: ' + (e && e.message ? e.message : 'unknown error'));
      }
      return;
    }

    // V3.598 — notify-me watch from the composer's availability strip
    if (act === 'watch-slot') {
      var cw = state.comp;
      if (!cw.equipmentId || !cw.date || !cw.startTime || !cw.endTime) return;
      btn.disabled = true;
      try {
        var eqw = currentEquip();
        await EQUIP_AVAIL.createWatch(cw.equipmentId,
          eqw ? (eqw.shortName || eqw.name) : '', cw.date, cw.startTime, cw.endTime);
        toast('info', 'Watching — you’ll hear if that window frees up.');
        await renderAvailStrip();     // repaints with the new chip
      } catch (e) {
        btn.disabled = false;
        toast('error', 'Could not save watch: ' + (e && e.message ? e.message : 'unknown error'));
      }
      return;
    }
    if (act === 'watch-drop') {
      var wid = btn.getAttribute('data-watch');
      if (!wid) return;
      try {
        await EQUIP_AVAIL.deleteWatch(wid);
        state.compWatches = state.compWatches.filter(function (w) { return w.id !== wid; });
        await renderAvailStrip();
      } catch (e) {
        toast('error', 'Could not remove watch.');
      }
      return;
    }

    // V3.594 — notification feed
    if (act === 'notif-toggle') {
      // Unread items force the section open, so the effective state — not
      // state.notifOpen — is what we're toggling away from. Collapsing
      // also implies "I've seen these", otherwise it would spring back
      // open on the very next render.
      var wasOpen = state.notifOpen || unreadNotifications().length > 0;
      if (unreadNotifications().length) await markAllNotificationsRead();
      state.notifOpen = !wasOpen;
      render(); return;
    }
    if (act === 'notif-readall') { await markAllNotificationsRead(); render(); return; }
    if (act === 'notif-open' || act === 'notif-dismiss') {
      var row = btn.closest('[data-notif]');
      var nid = row && row.getAttribute('data-notif');
      if (!nid) return;
      if (act === 'notif-dismiss') { await dismissNotification(nid); render(); return; }
      var target = state.notifications.find(function (x) { return x.id === nid; });
      await markNotificationRead(nid);
      state.notifOpen = true;   // survive the render that follows
      render();
      if (target && target.url) window.location.href = target.url;
      return;
    }

    // V3.563 — horizon tabs + week/month navigation
    var view = btn.getAttribute('data-view');
    if (view) { await setView(view); return; }
    if (act === 'wprev' || act === 'wnext') {
      state.date = shiftDate(state.date, act === 'wprev' ? -7 : 7);
      state.comp.date = state.date;
      await loadWeek(); render(); return;
    }
    if (act === 'wnow') { state.date = localToday(); state.comp.date = state.date; await loadWeek(); render(); return; }
    if (act === 'mprev' || act === 'mnext') {
      state.date = shiftMonth(state.date, act === 'mprev' ? -1 : 1);
      await loadMonth(); render(); return;
    }
    if (act === 'mnow') { state.date = localToday(); await loadMonth(); render(); return; }

    if (act === 'prev' || act === 'next') { await setDate(shiftDate(state.date, act === 'prev' ? -1 : 1)); return; }
    var glance = btn.getAttribute('data-date');
    if (glance) {
      state.view = 'day';
      if (btn.getAttribute('data-open')) state.composerOpen = true;
      await setDate(glance);
      return;
    }
    if (act === 'prefs') { togglePrefsPopover(btn); return; }
    if (act === 'nudge-run') { runOutcomeQueue(); return; }   // V3.623

    // composer pills
    var ing = btn.getAttribute('data-ingredient');
    if (ing) {
      var c = state.comp;
      if (c.mode !== 'compose') { c.mode = 'compose'; c.ingredients = new Set([ing]); }
      else if (c.ingredients.has(ing)) c.ingredients.delete(ing);
      else c.ingredients.add(ing);
      c.surfaces = null;
      render();
      return;
    }
    var simple = btn.getAttribute('data-simple');
    if (simple) {
      state.comp.mode = state.comp.mode === simple ? 'compose' : simple;
      state.comp.surfaces = null;
      render();
      return;
    }
    var dest = btn.getAttribute('data-dest');
    if (dest) {
      if (state.comp.surfaces.has(dest)) state.comp.surfaces.delete(dest);
      else state.comp.surfaces.add(dest);
      render();
      return;
    }
    // V3.567 — composer pop-up sheet
    if (act === 'open-composer') {
      state.composerOpen = true;
      render();
      var openInput = document.querySelector('.md-comp-grid input[data-field="title"]');
      if (openInput) openInput.focus();
      return;
    }
    if (act === 'fold-composer') {
      state.composerOpen = false;
      if (state.editingId) { state.editingId = null; state.comp = freshComposer(); state.comp.date = state.date; }
      render();
      return;
    }
    if (act === 'use-suggestion') {
      state.comp.title = suggestedTitle();
      render();
      return;
    }
    if (act === 'add') { await submitComposer(); return; }
    if (act === 'cancel-edit') { state.editingId = null; state.comp = freshComposer(); state.comp.date = state.date; render(); return; }

    // focus panel
    var focusId = btn.getAttribute('data-focus');
    if (act === 'plan-focus' && focusId) {
      state.comp.mode = 'compose';
      state.comp.ingredients.add('focus');
      state.comp.focusId = focusId;
      state.composerOpen = true;
      render();
      var input = document.querySelector('.md-comp-grid input[data-field="title"]');
      if (input) input.focus();
      return;
    }
    if (act === 'plan-ft' && focusId) {
      var taskId = btn.getAttribute('data-task');
      state.comp.mode = 'compose';
      state.comp.ingredients.add('focus');
      state.comp.ingredients.add('task');
      state.comp.focusId = focusId;
      state.comp.focusTaskId = taskId;
      state.composerOpen = true;
      render();
      return;
    }
    if (act === 'report' && focusId) {
      var f = state.focuses.find(function (x) { return x.id === focusId; });
      if (f) await openReportDialog(f);
      return;
    }

    // item + confirmation actions
    var item = findItem(btn);
    if (!item) return;
    if (act === 'retry') {
      var surface = btn.getAttribute('data-surface');
      btn.disabled = true;
      var rec = await DD.retry(item, surface);
      toast(rec && rec.status === 'created' ? 'success' : 'warn',
        rec && rec.status === 'created' ? 'Sent to ' + surface : (rec && rec.error) || 'Retry failed');
      await refresh();
      return;
    }
    if (act === 'i-done' || act === 'c-did') {
      // V3.853 — done means "here is the result": the dialog opens first and
      // DD.saveOutcome flips planned → done in the same write (closeAs).
      // Cancel leaves the step planned. Focus-task / meeting loop-closure
      // run inside the dialog's save once the item is actually done.
      if (item.status !== 'planned') { openOutcomeDialog(item, 'result'); return; }
      openOutcomeDialog(item, 'result', null, { closeAs: 'done' });
      return;
    }
    if (act === 'c-skip') {
      // V3.623 · V3.853 — a skip almost always has a reason worth
      // recording, so the dialog opens with Barrier preselected and the
      // skip is written WITH the outcome (cascading like done does).
      openOutcomeDialog(item, 'barrier', null, { closeAs: 'skipped' });
      return;
    }
    if (act === 'i-outcome') {   // V3.623 — record / edit an outcome
      openOutcomeDialog(item);
      return;
    }
    if (act === 'c-move') {
      item.date = localToday();
      item.status = 'planned';
      await DD.saveItem(item);
      await DD.cascadeUpdate(item);
      toast('info', 'Moved to today — booking/huddle/tracker follow.');
      await refresh();
      return;
    }
    if (act === 'i-edit') {
      var det = item.details || {};
      state.editingId = item.id;
      state.composerOpen = true;
      state.comp = {
        mode: (['meeting', 'reading', 'order', 'help'].indexOf(item.type) >= 0) ? item.type : 'compose',
        ingredients: new Set([].concat(
          det.focusId ? ['focus'] : [],
          det.protocolId ? ['protocol'] : [],
          det.equipmentId ? ['equipment'] : [],
          (det.focusTaskId || det.subtaskId) ? ['task'] : [],
          (!det.focusId && !det.protocolId && !det.equipmentId && !det.focusTaskId && !det.subtaskId) ? ['focus'] : []
        )),
        title: item.title || '', notes: item.notes || '',
        date: item.date, startTime: item.startTime || '', endTime: item.endTime || '',
        equipmentId: det.equipmentId || '', protocolId: det.protocolId || '',
        priority: det.priority || 'normal',   // V3.588
        focusId: det.focusId || '', focusFreeText: '', focusTaskId: det.focusTaskId || '',
        focusAlignId: '', semesterFocusId: '',   // V3.717 — the narrowing picks start clean on edit
        subtaskId: det.subtaskId || '',
        surfaces: new Set(Object.keys(item.distributions || {}).filter(function (s) {
          var r = item.distributions[s];
          return r && (r.status === 'created' || r.status === 'failed');
        })),
      };
      render();
      var input2 = document.querySelector('.md-comp-grid input[data-field="title"]');
      if (input2) input2.focus();
      return;
    }
    if (act === 'i-del') {
      if (!window.confirm('Delete this plan? Its copies (huddle post, booking, tracker event…) are removed too. A notebook entry you’ve written in is kept.')) return;
      var res = await DD.cascadeDelete(item);
      toast(res.deleted ? 'success' : 'warn',
        res.deleted ? 'Plan and its copies removed' : 'Some copies could not be removed — item kept so you can retry');
      await refresh();
      return;
    }
  }

  /* Confirming a planned item that carries a focus task checks the task
   * off in the focus doc (hierarchy loop-closure). */
  async function maybeCompleteFocusTask(item) {
    var det = item.details || {};
    if (!FA || !det.focusId || !det.focusTaskId) return;
    try {
      var focus = state.focuses.find(function (f) { return f.id === det.focusId; });
      if (!focus) {
        var week = await FA.listForWeek(firebridge.getUser().uid, FA.weekIdFor(item.date));
        focus = week.find(function (f) { return f.id === det.focusId; });
      }
      if (focus) {
        await FA.setTaskDone(firebridge.getUser().uid, focus, det.focusTaskId, true, item.id);
        await loadFocuses();
      }
    } catch (err) {
      console.warn('[my-week] focus-task completion failed:', err && err.message);
    }
  }

  /* V3.743 — a planned item that came from an "Assigned to you" card closes
   * the loop at its source: the lab meeting's actionItems[] entry flips to
   * done, or the chore board records my completion. The task doc itself is
   * already flipped by the day-distribute `task` adapter (native origin).
   * Both writes are rules-legal for any lab member (actionItems is a
   * collaborative field; completions.<me> is my own key). */
  async function maybeCompleteMeetingWork(item) {
    var det = (item && item.details) || {};
    var db = firebridge.db && firebridge.db();
    if (!db) return;
    var me = firebridge.getUser().uid;
    try {
      if (det.meetingId && det.actionItemId) {
        var ref = db.collection('meetings').doc(det.meetingId);
        var snap = await ref.get();
        if (snap.exists) {
          var items = (snap.data().actionItems || []).map(function (a) {
            return a.id === det.actionItemId ? Object.assign({}, a, { status: 'done', doneAt: new Date().toISOString(), doneBy: me }) : a;
          });
          await ref.update({ actionItems: items, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        }
      }
      if (det.choreWeekId && det.choreId) {
        var patch = {};
        patch['completions.' + me + '.' + det.choreId] = { doneAt: new Date().toISOString() };
        patch.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
        await db.collection('labChores').doc(det.choreWeekId).update(patch);
      }
    } catch (err) {
      console.warn('[my-week] meeting/chore loop-closure failed:', err && err.message);
    }
  }

  function onInput(ev) {
    var f = ev.target.getAttribute && ev.target.getAttribute('data-field');
    if (!f) return;
    state.comp[f] = ev.target.value;
    if (f === 'title') updateAddEnabled();
  }

  async function onChange(ev) {
    // V3.743 — "other date…" picker on an Assigned-to-you card
    if (ev.target.getAttribute && ev.target.getAttribute('data-act') === 'plan-assigned-date') {
      var pcard = ev.target.closest('.md-inbox-card');
      var ptask = pcard && pcard.getAttribute('data-task');
      var pdate = ev.target.value;
      if (!ptask || !/^\d{4}-\d{2}-\d{2}$/.test(pdate)) return;
      try { await planAssigned(ptask, pdate); await refresh(); }
      catch (e) { toast('error', 'Could not plan: ' + (e && e.message ? e.message : 'unknown error')); }
      return;
    }
    var f = ev.target.getAttribute && ev.target.getAttribute('data-field');
    if (!f) return;
    var c = state.comp;
    if (f === 'taskPick') {
      var v = ev.target.value;
      c.focusTaskId = ''; c.subtaskId = '';
      if (v.indexOf('ft:') === 0) {
        c.focusTaskId = v.slice(3);
        var ft = focusTaskById(c.focusTaskId);
        if (ft && ft.focus) {
          // picking a focus task attaches the parent focus — the hierarchy
          c.ingredients.add('focus');
          c.focusId = ft.focus.id;
        }
      } else if (v.indexOf('bt:') === 0) {
        c.subtaskId = v.slice(3);
      }
      render();
      return;
    }
    c[f] = ev.target.value;
    if (f === 'focusId' || f === 'semesterFocusId') {
      // V3.717 — dropdown 1 moved, so dropdown 2's grant changed underneath
      // it. Drop the stale pick rather than carrying an aim from one grant
      // over to another, then re-render to repopulate.
      c.focusAlignId = '';
      render();
      return;
    }
    if (f === 'priority') {
      // V3.588 — refresh the hint in place; a full render would close
      // the open select and lose the availability strip's state.
      var hintEl = document.querySelector('.md-crit-hint');
      if (hintEl) hintEl.textContent = criticalityHint(c.priority);
      return;
    }
    if (c.mode === 'compose' && c.ingredients.has('equipment')
        && (f === 'equipmentId' || f === 'date' || f === 'startTime' || f === 'endTime')) {
      await renderAvailStrip();
    }
    updateAddEnabled();
  }

  /* ── composer submit ─────────────────────────────────────── */

  /* Dropdown 2's composite key → a focus_ref. V3.602's analysis keys ride
   * along when the pick was an analysis rather than a whole card, so the
   * week lands on the specific measurement instead of the whole paper.
   * Returns null for "nothing picked", which every caller treats as
   * "fall back to the broader ref". */
  function alignRefFor(key) {
    if (!key) return null;
    var rf = (state.researchFoci || []).find(function (x) { return (x.key || x.id) === key; });
    if (!rf) return null;
    var ref = { id: rf.id, title: rf.title, level: rf.level };
    if (rf.analysis_id) {
      ref.analysis_id = rf.analysis_id;
      ref.analysis_title = rf.analysis_title || '';
      ref.experiment_id = rf.experiment_id || null;
    }
    return ref;
  }

  /* FA.create writes focus_ref directly rather than going through
   * setFocusRef, so the roadmapClaims mirror has to be stamped by hand.
   * Card-level refs carry no analysis and claim nothing — that is the
   * whole rule, in one place now instead of three. Mirror-only: a failure
   * never blocks the item. */
  async function stampClaim(ref, weekId) {
    if (!ref || !ref.analysis_id || !window.ROADMAP_DATA) return;
    try {
      await ROADMAP_DATA.setClaim({
        uid: firebridge.getUser().uid,
        foci_id: ref.id,
        experiment_id: ref.experiment_id,
        analysis_id: ref.analysis_id,
        analysis_title: ref.analysis_title,
        week_id: weekId,
      });
    } catch (e) { /* mirror only */ }
  }

  async function submitComposer() {
    var c = state.comp;
    var title = c.title.trim() || suggestedTitle();
    if (!title) return;
    var btn = document.querySelector('.md-comp-actions .md-add');
    if (btn) { btn.disabled = true; btn.textContent = state.editingId ? 'Saving…' : 'Adding…'; }

    var details = {};
    if (c.mode === 'compose') {
      if (c.ingredients.has('equipment') && c.equipmentId) {
        var eq = currentEquip();
        details.equipmentId = c.equipmentId;
        details.equipmentName = eq ? (eq.shortName || eq.name) : '';
        // V3.588 — criticality rides to equipmentBookings.priority via
        // day-distribute's equipment adapter.
        details.priority = c.priority || 'normal';
      }
      if (c.ingredients.has('protocol') && c.protocolId) {
        var pr = currentProtocol();
        details.protocolId = c.protocolId;
        details.protocolTitle = pr ? pr.title : '';
      }
      if (c.ingredients.has('focus')) {
        if (c.focusId && c.focusId.indexOf('grant:') === 0 && FA) {
          /* V3.717 — a week started straight under a grant. Reuse an open
           * weekly already pointed at the same target, else create one. The
           * focus_ref is dropdown 2's pick when there is one, otherwise the
           * grant itself — both roll up to the same grant on the review
           * page, the aim just says which result is being chased. */
          try {
            var gid = c.focusId.slice(6);
            var gRow2 = state.grantRows.find(function (g) { return g.id === gid; });
            var ref = alignRefFor(c.focusAlignId) ||
              (gRow2 ? { id: gRow2.id, title: gRow2.title, level: 'grant' } : null);
            var openW = ref && state.focuses.find(function (w) {
              return w.status !== 'reported' && w.focus_ref && w.focus_ref.id === ref.id &&
                (w.focus_ref.analysis_id || null) === (ref.analysis_id || null);
            });
            if (openW) {
              details.focusId = openW.id;
              details.focusTitle = openW.title;
            } else if (ref) {
              var createdG = await FA.create(firebridge.getUser().uid, {
                title: ref.analysis_title || ref.title,
                focus_ref: ref,
              });
              await stampClaim(ref, createdG.weekId);
              details.focusId = createdG.id;
              details.focusTitle = createdG.title;
              await loadFocuses();
            }
          } catch (e) { console.warn('[my-week] grant pick failed:', e && e.message); }
        } else if (c.focusId && c.focusId.indexOf('sem:') === 0 && FA) {
          // V3.715 — a semester-focus pick: reuse this week's weekly focus
          // already nested under it, else create one (title copied,
          // semester attribution stamped, card-level focus_ref inherited —
          // card refs have no analysis, so no claim mirror is involved).
          try {
            var semId = c.focusId.slice(4);
            var semSf = state.semFocuses.find(function (x) { return x.id === semId; });
            var existing = state.focuses.find(function (w) {
              return w.semester_focus_id === semId && w.status !== 'reported';
            });
            if (existing) {
              details.focusId = existing.id;
              details.focusTitle = existing.title;
            } else if (semSf) {
              // V3.717 — dropdown 2's aim/output wins over the semester's
              // own (grant-level) ref: it is the narrower statement of the
              // same thing. With nothing picked, the semester ref carries.
              var semRef = alignRefFor(c.focusAlignId) ||
                (semSf.focus_ref
                  ? { id: semSf.focus_ref.id, title: semSf.focus_ref.title, level: semSf.focus_ref.level || 'concept' }
                  : null);
              var createdW = await FA.create(firebridge.getUser().uid, {
                title: semSf.title,
                semester_focus_id: semSf.id,
                focus_ref: semRef,
              });
              await stampClaim(semRef, createdW.weekId);
              details.focusId = createdW.id;
              details.focusTitle = createdW.title;
              await loadFocuses();
            }
          } catch (e) { console.warn('[my-week] semester-focus pick failed:', e && e.message); }
        } else if (c.focusId === '__free__' && c.focusFreeText.trim() && FA) {
          // freeform → a student-proposed focus area (drift the mentor sees)
          try {
            // V3.550/V3.602/V3.717 — carry dropdown 2's pick (aim, output,
            // or a specific analysis on one) onto the proposed focusArea so
            // Team Focus, PMR and the grant review all inherit it.
            var alignRef = alignRefFor(c.focusAlignId);
            // V3.715 — freeform can nest under a semester focus; when no
            // research alignment was picked, inherit the semester focus's
            // card-level ref (card refs carry no analysis → no claim).
            var semUnder = c.semesterFocusId
              ? state.semFocuses.find(function (x) { return x.id === c.semesterFocusId; })
              : null;
            if (!alignRef && semUnder && semUnder.focus_ref) {
              alignRef = {
                id: semUnder.focus_ref.id,
                title: semUnder.focus_ref.title,
                level: semUnder.focus_ref.level || 'concept',
              };
            }
            var created = await FA.create(firebridge.getUser().uid, {
              title: c.focusFreeText.trim(),
              focus_ref: alignRef,
              semester_focus_id: semUnder ? semUnder.id : null,   // V3.715
            });
            await stampClaim(alignRef, created.weekId);
            details.focusId = created.id;
            details.focusTitle = created.title;
            await loadFocuses();
          } catch (e) { console.warn('[my-week] freeform focus create failed:', e && e.message); }
        } else if (c.focusId && c.focusId !== '__free__') {
          var cf = currentFocus();
          details.focusId = c.focusId;
          details.focusTitle = cf ? cf.title : '';
        }
      }
      if (c.ingredients.has('task')) {
        if (c.focusTaskId) {
          var ft = focusTaskById(c.focusTaskId);
          details.focusTaskId = c.focusTaskId;
          details.subtaskText = ft ? ft.text : '';
        } else if (c.subtaskId) {
          var bt = state.bucketTasks.find(function (t) { return t.id === c.subtaskId; });
          details.subtaskId = c.subtaskId;
          details.subtaskText = bt ? bt.text : '';
        }
      }
    }

    try {
      if (state.editingId) {
        var item = state.items.find(function (it) { return it.id === state.editingId; })
                || state.pending.find(function (it) { return it.id === state.editingId; });
        if (!item) { state.editingId = null; render(); return; }
        item.title = title;
        item.notes = c.notes;
        item.date = c.date;
        item.startTime = c.startTime || null;
        item.endTime = c.endTime || null;
        item.type = derivedType();
        item.details = Object.assign({}, item.details, details);
        await DD.saveItem(item);
        await DD.cascadeUpdate(item);
        var newSurfaces = Array.from(c.surfaces).filter(function (s) {
          var r = (item.distributions || {})[s];
          return !r || r.status === 'skipped' || r.status === 'removed';
        });
        if (newSurfaces.length) await DD.distribute(item, newSurfaces);
        state.editingId = null;
        toast('success', 'Updated — copies follow');
      } else {
        var newItem = {
          id: DD.newItemId(),
          type: derivedType(),
          title: title, notes: c.notes,
          date: c.date,
          startTime: c.startTime || null, endTime: c.endTime || null,
          status: 'planned', confirmed_at: null,
          details: details,
          categoryPath: [],
          auto_distributed: !!(state.prefs && state.prefs.auto_distribute),
          excluded_surfaces: [],
          distributions: {},
          origin: null,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          ownerUid: firebridge.getUser().uid, schema_version: 1,
        };
        await DD.saveItem(newItem);
        var targets = Array.from(c.surfaces);
        if (targets.length) await DD.distribute(newItem, targets);
        var fails = Object.keys(newItem.distributions).filter(function (s) { return newItem.distributions[s].status === 'failed'; });
        if (fails.length) toast('warn', 'Added, but ' + fails.join(' + ') + ' failed — tap its retry chip');
        else if (targets.length) toast('success', 'Added + sent to ' + targets.length + ' surface' + (targets.length === 1 ? '' : 's'));
        else toast('success', 'Added to My Week');
      }
      var keepMode = c.mode, keepIng = new Set(c.ingredients);
      state.comp = freshComposer();
      state.comp.mode = keepMode;
      state.comp.ingredients = keepIng;
      state.comp.date = state.date;
      await refresh();
    } catch (err) {
      console.error('[my-week] submit failed:', err);
      toast('error', 'Could not save: ' + (err && err.message));
      render();
    }
  }

  /* ── prefs popover (V3.529) ──────────────────────────────── */

  function togglePrefsPopover(anchorBtn) {
    var existing = document.querySelector('.md-prefs');
    if (existing) { existing.remove(); return; }
    var p = state.prefs || { auto_distribute: true, excluded_surfaces: [] };
    var surfaces = Object.keys(DD.SURFACE_LABELS);
    var pop = document.createElement('div');
    pop.className = 'md-prefs';
    pop.innerHTML =
      '<label><input type="checkbox" id="md-pref-auto"' + (p.auto_distribute ? ' checked' : '') + '> Auto-distribute new entries</label>' +
      '<div class="md-prefs-sub">Never auto-send to:</div>' +
      surfaces.map(function (s) {
        var meta = DD.SURFACE_LABELS[s];
        var off = (p.excluded_surfaces || []).indexOf(s) >= 0;
        return '<label><input type="checkbox" class="md-pref-excl" value="' + s + '"' + (off ? ' checked' : '') + '> ' + ICON.render(meta.icon) + ' ' + meta.label + '</label>';
      }).join('');
    pop.addEventListener('change', async function () {
      var next = {
        auto_distribute: pop.querySelector('#md-pref-auto').checked,
        excluded_surfaces: Array.from(pop.querySelectorAll('.md-pref-excl:checked')).map(function (el) { return el.value; }),
      };
      state.prefs = await DD.setPrefs(next);
      state.comp.surfaces = null;
    });
    document.addEventListener('click', function closePrefs(ev) {
      if (!pop.contains(ev.target) && ev.target !== anchorBtn) {
        pop.remove();
        document.removeEventListener('click', closePrefs, true);
        render();
      }
    }, true);
    anchorBtn.closest('.md-datebar').style.position = 'relative';
    anchorBtn.closest('.md-datebar').appendChild(pop);
  }

  /* ── lifecycle ────────────────────────────────────────────── */

  async function setView(v) {
    state.view = v;
    if (v === 'month') await loadMonth();
    render();
  }

  async function setDate(d) {
    state.date = d;
    state.comp.date = d;
    await loadWeek();
    render();
  }

  async function refresh() {
    var jobs = [loadWeek(), loadPending(), loadFocuses(), loadNotifications(), loadOutcomeQueue(), loadAssigned()];
    if (state.view === 'month') jobs.push(loadMonth());
    await Promise.all(jobs);
    render();
  }

  // V3.585 — tab-lifecycle hook (Ourlab app multi-WebView shell). My Week is
  // one-shot api.load reads, so there's nothing to pause; on resume, refresh
  // so the day/week data is current when the warm tab is swapped back in.
  // Inert on web (tab-lifecycle events never fire there).
  window.OURLAB_TAB_LIFECYCLE = {
    pause: function () {},
    resume: function () { refresh().catch(function () {}); },
  };

  async function init() {
    var root = document.getElementById('myday-root');
    if (!root) return;
    DD = window.DAY_DISTRIBUTE;
    FA = window.FOCUS_AREAS || null;
    if (!DD) { root.innerHTML = '<div class="md-empty">day-distribute.js failed to load.</div>'; return; }

    // R2 (V3.580) — parse params + paint the skeleton IMMEDIATELY, BEFORE the
    // auth await. whenAuthResolved() (auth restore + network) is itself the
    // slow part, so painting after it left the content blank for that whole
    // window (the exact blank the early-launch screenshot showed). The shell
    // (tabs/datebar/shimmer) needs only state.date/state.view — set here from
    // the URL — so it can render before auth resolves.
    var params = new URLSearchParams(location.search);
    state.date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : localToday();
    var vparam = params.get('view');
    if (['day', 'week', 'month'].indexOf(vparam) >= 0) state.view = vparam;
    state.comp = freshComposer();
    state.comp.date = state.date;
    if (params.get('compose') === '1') {
      state.composerOpen = true;   // V3.567 — deep-link opens the pop-up composer
      if (params.get('title')) state.comp.title = params.get('title');
      var t = params.get('type');
      if (t && ['meeting', 'reading', 'order', 'help'].indexOf(t) >= 0) state.comp.mode = t;
      if (t === 'task') state.comp.ingredients.add('task');
      if (t === 'equipment') state.comp.ingredients.add('equipment');
    }
    renderSkeleton();  // instant shell — replaced by render() once data loads.

    await firebridge.whenAuthResolved();
    var user = firebridge.getUser();
    if (!user || !firebridge.isLabMember()) {
      root.innerHTML = '<div class="md-empty">My Week is for lab members — sign in from the nav, or ask an admin for access.</div>';
      return;
    }

    state.prefs = await DD.getPrefs();
    // V3.743 — loadNotifications + loadAssigned join the FIRST paint. Before
    // this, notifications only loaded inside refresh(), so the 🔔 feed was
    // empty on every cold open until some action triggered a refresh.
    await Promise.all([loadWeek(), loadPending(), loadFocuses(), loadOutcomeQueue(), loadNotifications(), loadAssigned()]);
    if (state.view === 'month') await loadMonth();
    render();

    // lazy pickers — re-render when they arrive
    if (window.EQUIP_AVAIL) {
      EQUIP_AVAIL.listEquipment().then(function (list) { state.equipment = list; render(); });
    }
    // V3.647 — `typeof api`; `window.api` is always undefined (lexical const), so
    // the protocol picker's list had never loaded on this page at all.
    if (typeof api !== 'undefined' && api.load) {
      api.load('protocols/list.json').then(function (d) {
        state.protocols = ((d && d.protocols) || []).map(function (p) {
          return { id: p.id, title: p.title || '(untitled protocol)' };
        });
        render();
      }).catch(function () {});
    }
    loadBucketTasks().then(render);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
