/* my-day.js — My Day: the unified student entry surface.
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
 * Data: userData/{uid}/dayPlans/{itemId} via DAY_DISTRIBUTE helpers;
 * focus areas at userData/{uid}/focusAreas via FOCUS_AREAS.
 */
(function () {
  'use strict';

  var DD = null; // window.DAY_DISTRIBUTE
  var FA = null; // window.FOCUS_AREAS

  var INGREDIENTS = [
    { key: 'focus',     icon: '🎯', label: 'Weekly focus' },
    { key: 'protocol',  icon: '📋', label: 'Protocol' },
    { key: 'equipment', icon: '🔬', label: 'Equipment' },
    { key: 'task',      icon: '✅', label: 'Task' },
  ];
  var SIMPLE_TYPES = [
    { key: 'meeting', icon: '👥', label: 'Meeting' },
    { key: 'reading', icon: '📖', label: 'Reading' },
    { key: 'order',   icon: '🛒', label: 'Order' },
    { key: 'help',    icon: '🆘', label: 'Help' },
  ];
  var TYPE_ICONS = { work: '🎯', equipment: '🔬', task: '✅', meeting: '👥', reading: '📖', order: '🛒', help: '🆘' };

  /* V3.594 — in-app notification feed (catch-up surface for missed pushes) */
  var NOTIF_LIMIT = 20;
  var NOTIF_WINDOW_DAYS = 7;
  var NOTIF_ICONS = {
    adjacency: '🔁', watch: '🔔', reminder: '⏰', coop: '🤝',
    approval: '📝', confirmed: '✅', displaced: '⚠️',
  };

  var state = {
    view: 'day',          // V3.563 — 'day' | 'week' | 'month' horizon tabs
    composerOpen: false,  // V3.567 — composer is a pop-up sheet, folded by default
    date: null,
    items: [],            // viewed WEEK's items
    monthItems: [],       // V3.563 — items across the viewed month's calendar grid
    pending: [],          // past planned items awaiting confirmation
    prefs: null,
    focuses: [],          // this (current) week's focus areas
    equipment: [],
    protocols: [],
    bucketTasks: [],      // open subtasks from the buckets system (task picker, group 2)
    editingId: null,
    slotCheck: null,
    dayBookings: {},      // date -> bookings[] for the drag strip (per selected device)
    researchFoci: [],     // V3.550 — research-foci rows for the freeform-alignment picker
    notifications: [],    // V3.594 — in-app feed rows (newest first)
    notifOpen: false,     // expanded state; auto-opens when something is unread
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
      focusAlignId: '',           // V3.550 — research focus a freeform proposal advances
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
    var p = dateStr.split('-'), y = +p[0], mIdx = +p[1] - 1;
    var last = new Date(y, mIdx + 1, 0).getDate();
    var firstStr = y + '-' + String(mIdx + 1).padStart(2, '0') + '-01';
    var lastStr = y + '-' + String(mIdx + 1).padStart(2, '0') + '-' + String(last).padStart(2, '0');
    var d = mondayOf(firstStr);
    var gridEnd = shiftDate(mondayOf(lastStr), 6); // Sunday of the last week
    var days = [];
    while (d <= gridEnd) {
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
      console.warn('[my-day] notification feed load failed:', e && e.message);
    }
  }

  function unreadNotifications() {
    return state.notifications.filter(function (n) { return !n.readAt; });
  }

  async function markNotificationRead(id) {
    var n = state.notifications.find(function (x) { return x.id === id; });
    if (!n || n.readAt) return;
    n.readAt = new Date();       // optimistic — the badge drops immediately
    try {
      await firebridge.db().collection('userData').doc(firebridge.getUser().uid)
        .collection('notifications').doc(id)
        .update({ readAt: firebase.firestore.FieldValue.serverTimestamp() });
    } catch (e) { console.warn('[my-day] mark-read failed:', e && e.message); }
  }

  async function dismissNotification(id) {
    state.notifications = state.notifications.filter(function (x) { return x.id !== id; });
    try {
      await firebridge.db().collection('userData').doc(firebridge.getUser().uid)
        .collection('notifications').doc(id).delete();
    } catch (e) { console.warn('[my-day] dismiss failed:', e && e.message); }
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
    } catch (e) { console.warn('[my-day] mark-all-read failed:', e && e.message); }
  }

  async function loadFocuses() {
    if (!FA) { state.focuses = []; state.researchFoci = []; return; }
    state.focuses = await FA.listForWeek(firebridge.getUser().uid, FA.weekIdFor(localToday()));
    // V3.550 — research-foci rows for the freeform-alignment picker
    // (cached inside FOCUS_AREAS after the first read).
    if (FA.listFociForPicker) state.researchFoci = await FA.listFociForPicker();
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
    var focusBit = c.ingredients.has('focus') ? (f ? f.title : (c.focusFreeText || '')) : '';
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
    if (state.view === 'week') {
      inner = notif + renderWeekView();
    } else if (state.view === 'month') {
      inner = notif + renderMonthView();
    } else {
      inner =
        renderDatebar() +
        notif +
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
      '<span class="md-notif-caret">' + (open ? '▾' : '▸') + '</span>' +
      '<span class="md-notif-title">🔔 Notifications</span>' +
      (unread.length ? '<span class="md-notif-badge">' + unread.length + '</span>' : '') +
      '</button>';

    if (!open) return '<div class="md-notif">' + head + '</div>';

    var rows = state.notifications.map(function (n) {
      var icon = NOTIF_ICONS[n.kind] || '🔔';
      return '<div class="md-notif-item' + (n.readAt ? '' : ' md-notif-unread') + '" data-notif="' + esc(n.id) + '">' +
        '<span class="md-notif-icon">' + icon + '</span>' +
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

  // R2 (V3.580) — paint the shell INSTANTLY so My Day never blank-waits on
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
        : '<button type="button" class="md-wv-add" data-date="' + d + '" data-open="1">＋ plan something</button>';
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
    if (det.focusTitle) combo = '<span class="md-mini-combo">🎯 ' + esc(det.focusTitle) + '</span>';
    return '<div class="md-mini' + (it.status === 'done' ? ' md-done' : '') + '" data-id="' + esc(it.id) + '">' +
      '<span class="md-mini-icon">' + (TYPE_ICONS[it.type] || '•') + '</span>' +
      '<span class="md-mini-main">' +
        '<span class="md-mini-title">' + esc(it.title) + '</span>' +
        (it.startTime ? '<span class="md-mini-time">' + fmtTime(it.startTime) + (it.endTime ? '–' + fmtTime(it.endTime) : '') + '</span>' : '') +
        combo +
      '</span>' +
      (it.status === 'planned' ? '<button type="button" class="md-mini-done" data-act="i-done" title="Mark done">✓</button>' : '') +
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
        return '<span class="md-mo-pill' + (it.status === 'done' ? ' md-done' : '') + '">' +
          (TYPE_ICONS[it.type] || '•') + ' ' + esc(it.title) + '</span>';
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
      '<button type="button" class="md-gear" data-act="prefs" aria-label="Distribution settings">⚙</button>' +
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
      '<a class="md-focus-manage" href="/rm/pages/team-focus.html">manage ↗</a></div>';
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
        report = '<div class="md-focus-report">' + (om.icon || '') + ' ' + esc(om.label || '') +
          (f.report.summary ? ' — ' + esc(f.report.summary) : '') + '</div>';
      }
      var papers = (f.paper_refs || []).map(function (r) {
        return '<a class="md-focus-paper" href="/rm/pages/paper-builder.html?id=' + encodeURIComponent(r.id) + '">📝 ' + esc(r.title) + '</a>';
      }).join('');
      // V3.550 — the research focus this week advances (inherited badge).
      // V3.602 — deep-links to the specific analysis when one is named.
      var align = '';
      if (f.focus_ref) {
        var anch = f.focus_ref.analysis_id ? '#rmap-' + f.focus_ref.analysis_id : '';
        var alabel = (FA && FA.focusRefLabel) ? FA.focusRefLabel(f.focus_ref) : f.focus_ref.title;
        align = '<a class="md-focus-align" href="/rm/pages/research.html?id=' + encodeURIComponent(f.focus_ref.id) + anch + '" title="Research focus this week advances">🎯 ' + esc(alabel) + '</a>';
      }
      return '<div class="md-focus-card" data-focus="' + esc(f.id) + '">' +
        '<div class="md-focus-head">' +
          '<button type="button" class="md-focus-title" data-act="plan-focus" data-focus="' + esc(f.id) + '" title="Plan your day against this focus">🎯 ' + esc(f.title) + '</button>' +
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

  function renderPending() {
    if (!state.pending.length) return '';
    var cards = state.pending.map(function (it) {
      var lbl = fmtDateLabel(it.date);
      return '<div class="md-confirm-card" data-id="' + esc(it.id) + '">' +
        '<div class="md-c-title">' + (TYPE_ICONS[it.type] || '•') + ' ' + esc(it.title) + '</div>' +
        '<div class="md-c-when">Planned ' + esc(lbl.full) + (it.startTime ? ' · ' + fmtTime(it.startTime) : '') + ' — did this happen?</div>' +
        '<div class="md-c-actions">' +
          '<button type="button" class="md-c-did" data-act="c-did">✓ Did it</button>' +
          '<button type="button" data-act="c-skip">✗ Skipped</button>' +
          '<button type="button" data-act="c-move">→ Today</button>' +
        '</div>' +
      '</div>';
    });
    return '<div class="md-section-title">Waiting on you</div>' + cards.join('');
  }

  function distChip(item, surface, rec) {
    var meta = DD.SURFACE_LABELS[surface] || { icon: '•', label: surface };
    if (!rec || rec.status === 'skipped') {
      return '<span class="md-d-chip md-skip" title="Not sent to ' + esc(meta.label) + '">◌ ' + meta.icon + '</span>';
    }
    if (rec.status === 'failed') {
      return '<button type="button" class="md-d-chip md-fail" data-act="retry" data-surface="' + esc(surface) + '" title="' + esc(rec.error || 'failed') + ' — tap to retry">⚠ ' + meta.icon + ' retry</button>';
    }
    if (rec.status === 'orphaned') {
      return '<a class="md-d-chip md-orphan" href="' + esc(DD.linkFor(rec, item) || '#') + '" title="Kept on ' + esc(meta.label) + ' (has your content)">🔗 ' + meta.icon + '</a>';
    }
    if (rec.status === 'removed') return '';
    var extra = (rec.meta && rec.meta.needsApproval) ? ' (approval pending)' : '';
    return '<a class="md-d-chip md-ok" href="' + esc(DD.linkFor(rec, item) || '#') + '" title="On ' + esc(meta.label) + extra + '">✓ ' + meta.icon + ' ' + esc(meta.label) + extra + '</a>';
  }

  function renderTimeline() {
    var items = dayItems();
    if (!items.length) {
      return '<div class="md-empty">Nothing planned yet. ' +
        '<button type="button" class="md-empty-add" data-act="open-composer">＋ Plan a step</button></div>';
    }
    return items.map(function (it) {
      var dists = it.distributions || {};
      var chips = Object.keys(dists).map(function (s) { return distChip(it, s, dists[s]); }).join('');
      var det = it.details || {};
      var comboBits = [];
      if (det.focusTitle) comboBits.push('🎯 ' + esc(det.focusTitle));
      if (det.protocolTitle) comboBits.push('📋 ' + esc(det.protocolTitle));
      if (det.subtaskText) comboBits.push('✅ ' + esc(det.subtaskText));
      // V3.588 — surface criticality only when it's above the quiet default,
      // so a Soft day stays visually clean.
      if (det.equipmentId && (det.priority === 'high' || det.priority === 'urgent')) {
        comboBits.push('<span class="md-crit-chip md-crit-chip--' + det.priority + '">'
          + (det.priority === 'urgent' ? 'Hard' : 'On time') + '</span>');
      }
      var doneBtn = it.status === 'planned'
        ? '<button type="button" data-act="i-done" title="Mark done">✓</button>' : '';
      return '<div class="md-item' + (it.status === 'done' ? ' md-done' : '') + '" data-id="' + esc(it.id) + '">' +
        '<div class="md-i-icon">' + (TYPE_ICONS[it.type] || '•') + '</div>' +
        '<div class="md-i-main">' +
          '<div class="md-i-title">' + esc(it.title) + '</div>' +
          (it.startTime ? '<div class="md-i-time">' + fmtTime(it.startTime) + (it.endTime ? '–' + fmtTime(it.endTime) : '') + '</div>' : '') +
          (comboBits.length ? '<div class="md-i-combo">' + comboBits.join(' · ') + '</div>' : '') +
          (it.notes ? '<div class="md-i-notes">' + esc(it.notes) + '</div>' : '') +
          (chips ? '<div class="md-i-dist">' + chips + '</div>' : '') +
        '</div>' +
        '<div class="md-i-actions">' + doneBtn +
          '<button type="button" data-act="i-edit" title="Edit">✎</button>' +
          '<button type="button" data-act="i-del" title="Delete">🗑</button>' +
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
      return '<button type="button" class="md-type' + (on ? ' md-active' : '') + '" data-ingredient="' + t.key + '">' + t.icon + ' ' + t.label + '</button>';
    }).join('');
    var simpleRow = SIMPLE_TYPES.map(function (t) {
      return '<button type="button" class="md-type md-simple' + (c.mode === t.key ? ' md-active' : '') + '" data-simple="' + t.key + '">' + t.icon + ' ' + t.label + '</button>';
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
      return '<button type="button" class="md-dest' + (on ? ' md-on' : '') + '" data-dest="' + s + '">' + meta.icon + ' ' + meta.label + '</button>';
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
        (suggestion && !c.title ? '<div class="md-ghost">✨ Suggested: <button type="button" data-act="use-suggestion">' + esc(suggestion) + '</button></div>' : '') +
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
    // V3.550 — a freeform proposal can declare which research focus it
    // advances; the created focusArea carries focus_ref so the mentor sees
    // the alignment on Team Focus and PMR groups it under the thrust.
    var alignSel = '';
    if (free && state.researchFoci.length) {
      alignSel = '<select data-field="focusAlignId">' +
        '<option value="">🎯 advances research focus… (optional)</option>' +
        state.researchFoci.map(function (rf) {
          // V3.602 — analysis rows indent under their card, and the value
          // is the composite key (a card and its analyses share an id).
          var k = rf.key || rf.id;
          var text = rf.analysis_title
            ? '  ↳ ' + rf.analysis_title
            : (rf.icon ? rf.icon + ' ' : '') + rf.title;
          return '<option value="' + esc(k) + '"' + (c.focusAlignId === k ? ' selected' : '') + '>' + esc(text) + '</option>';
        }).join('') +
      '</select>';
    }
    return '<select data-field="focusId">' +
        '<option value="">Pick this week’s focus…</option>' + opts +
        '<option value="__free__"' + (free ? ' selected' : '') + '>✎ Something else (unassigned)…</option>' +
      '</select>' +
      (free ? '<input type="text" data-field="focusFreeText" placeholder="Describe the focus — your mentor will see it as proposed" value="' + esc(c.focusFreeText) + '">' : '') +
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
      return '<optgroup label="🎯 ' + esc(f.title) + '">' + open.map(function (t) {
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
            + '🔔 Notify me if ' + esc(fmtTime(c.startTime)) + '–' + esc(fmtTime(c.endTime))
            + ' frees up</button>';
        }
      }
      else if (check.needsApproval) msg = '<div class="md-a-msg md-a-warn">Over the standard max duration — booking will need manager approval.</div>';
      else msg = '<div class="md-a-msg md-a-ok">' + esc(fmtDateLabel(c.date).rel) + ' ' + fmtTime(c.startTime) + '–' + fmtTime(c.endTime) + ' is free ✓</div>';
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
   * so they can see (and drop) them without leaving My Day. Rendered from
   * state; `loadComposerWatches()` refreshes it. */
  function renderWatchChips() {
    if (!state.compWatches.length) return '';
    var chips = state.compWatches.map(function (w) {
      return '<span class="md-a-wchip">🔔 ' + esc(fmtTime(w.startTime)) + '–' + esc(fmtTime(w.endTime)) +
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
            return '<label><input type="radio" name="md-outcome" value="' + k + '"' + (k === 'partial' ? ' checked' : '') + '> ' + om.icon + ' ' + om.label + '</label>';
          }).join('') +
        '</div>' +
        '<textarea id="md-report-summary" rows="3" placeholder="Two sentences: what happened, and what you concluded. The full story belongs in the notebook entry…"></textarea>' +
        '<div class="md-report-entries">' +
          '<div class="md-report-sub">Notebook entries carrying the narrative:</div>' +
          entries.map(function (r) {
            return '<label><input type="checkbox" class="md-report-nb" value="' + esc(r.id) + '"> 📓 ' + esc(r.title || '(untitled)') + ' <em>' + esc(r.date) + '</em></label>';
          }).join('') +
          '<label><input type="checkbox" id="md-report-create" checked> ＋ Create a “Report: ' + esc(focus.title) + '” notebook entry to write it up</label>' +
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
          window.open('/rm/pages/lab-notebook.html?entry=' + encodeURIComponent('nb-report-' + focus.id), '_blank');
        }
        await loadFocuses();
        render();
      } catch (err) {
        console.error('[my-day] report failed:', err);
        toast('error', 'Could not save the report: ' + (err && err.message));
      }
    });
    document.body.appendChild(overlay);
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
      await DD.confirmDone(item);
      await maybeCompleteFocusTask(item);
      toast('success', 'Logged as done ✓' + ((item.distributions || {}).notebook ? ' — record your results in the notebook entry.' : ''));
      await refresh();
      return;
    }
    if (act === 'c-skip') {
      item.status = 'skipped';
      await DD.saveItem(item);
      await refresh();
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
      console.warn('[my-day] focus-task completion failed:', err && err.message);
    }
  }

  function onInput(ev) {
    var f = ev.target.getAttribute && ev.target.getAttribute('data-field');
    if (!f) return;
    state.comp[f] = ev.target.value;
    if (f === 'title') updateAddEnabled();
  }

  async function onChange(ev) {
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
    if (f === 'focusId') { render(); return; }
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
        if (c.focusId === '__free__' && c.focusFreeText.trim() && FA) {
          // freeform → a student-proposed focus area (drift the mentor sees)
          try {
            // V3.550 — carry the declared research-focus alignment onto the
            // proposed focusArea so Team Focus + PMR inherit it.
            var alignRf = c.focusAlignId
              ? (state.researchFoci || []).find(function (x) { return (x.key || x.id) === c.focusAlignId; })
              : null;
            // V3.602 — carry the analysis too when one was picked, so the
            // week lands on the specific measurement rather than the
            // whole paper.
            var alignRef = null;
            if (alignRf) {
              alignRef = { id: alignRf.id, title: alignRf.title, level: alignRf.level };
              if (alignRf.analysis_id) {
                alignRef.analysis_id = alignRf.analysis_id;
                alignRef.analysis_title = alignRf.analysis_title || '';
                alignRef.experiment_id = alignRf.experiment_id || null;
              }
            }
            var created = await FA.create(firebridge.getUser().uid, {
              title: c.focusFreeText.trim(),
              focus_ref: alignRef,
            });
            // create() writes focus_ref directly, so the claim mirror has
            // to be stamped here rather than through setFocusRef.
            if (alignRef && alignRef.analysis_id && window.ROADMAP_DATA) {
              try {
                await ROADMAP_DATA.setClaim({
                  uid: firebridge.getUser().uid,
                  foci_id: alignRef.id,
                  experiment_id: alignRef.experiment_id,
                  analysis_id: alignRef.analysis_id,
                  analysis_title: alignRef.analysis_title,
                  week_id: created.weekId,
                });
              } catch (e) { /* mirror only */ }
            }
            details.focusId = created.id;
            details.focusTitle = created.title;
            await loadFocuses();
          } catch (e) { console.warn('[my-day] freeform focus create failed:', e && e.message); }
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
        if (fails.length) toast('warn', 'Added, but ' + fails.join(' + ') + ' failed — tap ⚠ to retry');
        else if (targets.length) toast('success', 'Added + sent to ' + targets.length + ' surface' + (targets.length === 1 ? '' : 's'));
        else toast('success', 'Added to My Day');
      }
      var keepMode = c.mode, keepIng = new Set(c.ingredients);
      state.comp = freshComposer();
      state.comp.mode = keepMode;
      state.comp.ingredients = keepIng;
      state.comp.date = state.date;
      await refresh();
    } catch (err) {
      console.error('[my-day] submit failed:', err);
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
        return '<label><input type="checkbox" class="md-pref-excl" value="' + s + '"' + (off ? ' checked' : '') + '> ' + meta.icon + ' ' + meta.label + '</label>';
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
    var jobs = [loadWeek(), loadPending(), loadFocuses(), loadNotifications()];
    if (state.view === 'month') jobs.push(loadMonth());
    await Promise.all(jobs);
    render();
  }

  // V3.585 — tab-lifecycle hook (Ourlab app multi-WebView shell). My Day is
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
      root.innerHTML = '<div class="md-empty">My Day is for lab members — sign in from the nav, or ask an admin for access.</div>';
      return;
    }

    state.prefs = await DD.getPrefs();
    await Promise.all([loadWeek(), loadPending(), loadFocuses()]);
    if (state.view === 'month') await loadMonth();
    render();

    // lazy pickers — re-render when they arrive
    if (window.EQUIP_AVAIL) {
      EQUIP_AVAIL.listEquipment().then(function (list) { state.equipment = list; render(); });
    }
    if (window.api && api.load) {
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
