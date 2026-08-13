/* team-focus.js — V3.536 (Weekly Focus program R1): the mentor surface.
 *
 * Mentors (users listed in a mentee's users/{uid}.mentor_uids — the
 * V3.243 relationship; admins see the whole roster) pick a person, see
 * that week's focus areas, assign new ones with descriptions, edit, and
 * **✓ Sign off** (proposed / mentee_edited → confirmed — the expectation
 * is set). Mentees open the same page to see their own week, edit
 * descriptions (flips confirmed/mentor-proposed focus to mentee_edited,
 * back to the mentor), propose their own focus, and manage the task
 * checklist under each focus.
 *
 * Hierarchy, kept visually explicit: FOCUS (the week's why, mentor-agreed)
 * → TASKS (the concrete what, nested inside the focus card). Tasks here
 * are deliberately separate from the buckets task system.
 *
 * Data layer: window.FOCUS_AREAS (rm/js/focus-areas.js).
 */
(function () {
  'use strict';

  var state = {
    me: null,
    people: [],       // [{uid, name, category}] — self first, then mentees/roster
    viewUid: null,
    view: 'week',     // V3.564 — 'week' | 'month' horizon tabs
    weekOffset: 0,    // 0 = this week
    monthOffset: 0,   // V3.564 — 0 = this month (Month tab)
    monthFocuses: [], // V3.564 — all focus areas across the viewed month's weeks
    focuses: [],
    viewMentors: [],  // [{uid, name}] — the viewed person's mentor_uids (V3.542)
    drafts: [],       // the viewed person's paper drafts (V3.543 focus↔paper links)
    researchFoci: [], // researchFoci picker rows (V3.550 focus↔research alignment)
    loading: false,
  };

  /* V3.542 — rail grouping by member type (people.js category set;
   * alumni/guests are filtered out upstream in FOCUS_AREAS.listMentees). */
  var CAT_ORDER = ['pi', 'postdoc', 'grad', 'undergrad', 'highschool', 'collaborator', ''];
  var CAT_LABELS = {
    pi: 'PI', postdoc: 'Postdocs', grad: 'Grad students',
    undergrad: 'Undergrads', highschool: 'High school',
    collaborator: 'Collaborators', '': 'Other',
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(kind, msg) { if (window.TOAST && TOAST[kind]) TOAST[kind](msg); }
  function isSelf() { return state.viewUid === state.me.uid; }
  function canConfirm() {
    // Sign-off is a reviewer act: a mentor/admin viewing someone else.
    return !isSelf() || (firebridge.isAdmin && firebridge.isAdmin());
  }
  function weekId() { return FOCUS_AREAS.weekIdForOffset(state.weekOffset); }
  function weekLabel() {
    var d = new Date();
    d.setDate(d.getDate() + state.weekOffset * 7);
    var dow = d.getDay();
    d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow)); // Monday
    var end = new Date(d.getTime()); end.setDate(end.getDate() + 6);
    var fmt = function (x) { return x.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
    var prefix = state.weekOffset === 0 ? 'This week' : state.weekOffset === 1 ? 'Next week' : state.weekOffset === -1 ? 'Last week' : 'Week';
    return prefix + ': ' + fmt(d) + ' – ' + fmt(end);
  }

  /* ── month horizon (V3.564) ───────────────────────────────── */

  function fmtDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function thisMonday() {
    var d = new Date(); d.setHours(0, 0, 0, 0);
    var dow = d.getDay();
    d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
    return d;
  }
  function offsetOfMonday(mon) {
    return Math.round((mon.getTime() - thisMonday().getTime()) / (7 * 86400000));
  }
  function monthAnchor() {
    var d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(1);
    d.setMonth(d.getMonth() + state.monthOffset);
    return d;
  }
  function monthLabel() {
    return monthAnchor().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  /* The Monday-aligned weeks overlapping the viewed month.
   * [{monday: Date, weekId, offset, label}] */
  function monthWeeks() {
    var first = monthAnchor();
    var last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    var cur = new Date(first);
    var dow = cur.getDay();
    cur.setDate(cur.getDate() + (dow === 0 ? -6 : 1 - dow)); // Monday of first week
    var weeks = [];
    while (cur.getTime() <= last.getTime()) {
      var mondayStr = fmtDate(cur);
      var end = new Date(cur); end.setDate(end.getDate() + 6);
      var f = function (x) { return x.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
      weeks.push({
        weekId: FOCUS_AREAS.weekIdFor(mondayStr),
        offset: offsetOfMonday(new Date(cur)),
        label: f(cur) + ' – ' + f(end),
      });
      cur = new Date(cur); cur.setDate(cur.getDate() + 7);
    }
    return weeks;
  }

  async function loadMonthFocuses() {
    state.loading = true;
    render();
    var weeks = monthWeeks();
    var ids = weeks.map(function (w) { return w.weekId; }).sort();
    try {
      state.monthFocuses = await FOCUS_AREAS.listForRange(state.viewUid, ids[0], ids[ids.length - 1]);
    } catch (err) {
      console.warn('[team-focus] month load failed:', err && err.message);
      state.monthFocuses = [];
    }
    // shared side-data the cards reference
    await loadViewMentors();
    try { state.researchFoci = await FOCUS_AREAS.listFociForPicker(); } catch (e) {}
    state.loading = false;
    render();
  }

  /* ── data ─────────────────────────────────────────────────── */

  async function loadFocuses() {
    state.loading = true;
    render();
    var jobs = [FOCUS_AREAS.listForWeek(state.viewUid, weekId())];
    jobs.push(loadViewMentors());
    jobs.push(FOCUS_AREAS.listDrafts(state.viewUid).then(function (rows) { state.drafts = rows; }));
    // V3.550 — research-foci picker rows (cached in FOCUS_AREAS after first load)
    jobs.push(FOCUS_AREAS.listFociForPicker().then(function (rows) { state.researchFoci = rows; }));
    state.focuses = (await Promise.all(jobs))[0];
    state.loading = false;
    render();
  }

  /* V3.542 — the viewed person's mentors (users/{uid}.mentor_uids),
   * resolved to names via the roster (fallback: raw uid). */
  async function loadViewMentors() {
    state.viewMentors = [];
    if (isSelf()) return;
    try {
      var snap = await firebridge.db().collection('users').doc(state.viewUid).get();
      var uids = (snap.exists && (snap.data().mentor_uids || [])) || [];
      state.viewMentors = uids.map(function (uid) {
        var hit = state.people.find(function (p) { return p.uid === uid; });
        return { uid: uid, name: hit ? hit.name : uid.slice(0, 8) + '…' };
      });
    } catch (err) {
      console.warn('[team-focus] mentor load failed:', err && err.message);
    }
  }

  /* V3.542 — admins assign students under other team members from here
   * (users/{uid} update is admin-only in firestore.rules, so the row is
   * admin-gated; mentors themselves see the chips read-only). */
  function canEditMentors() {
    return !!(firebridge.isAdmin && firebridge.isAdmin()) && !isSelf();
  }

  function renderMentorRow() {
    if (isSelf() || !state.viewMentors) return '';
    var person = state.people.find(function (p) { return p.uid === state.viewUid; }) || { name: 'this person' };
    var chips = state.viewMentors.map(function (m) {
      return '<span class="tf-mentor-chip">' + esc(m.name) +
        (canEditMentors() ? '<button type="button" class="tf-mentor-del" data-act="mentor-del" data-uid="' + esc(m.uid) + '" aria-label="Remove mentor">✕</button>' : '') +
      '</span>';
    }).join('');
    var adder = canEditMentors()
      ? '<button type="button" class="tf-mentor-addbtn" data-act="mentor-add-open">＋ Assign mentor</button>'
      : '';
    if (!chips && !adder) return '';
    return '<div class="tf-mentors">' +
      '<span class="tf-mentors-lead">' + esc(person.name.split(' ')[0]) + ' reports to:</span>' +
      (chips || '<span class="tf-mentors-none">no mentor assigned</span>') + adder +
    '</div>';
  }

  /* ── render ───────────────────────────────────────────────── */

  /* V3.568 — grow a textarea to fit its content, up to a cap. */
  function autosize(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 260) + 'px';
  }

  function render() {
    var root = document.getElementById('teamfocus-root');
    if (!root) return;
    var main;
    if (state.view === 'month') {
      main = renderMonthNav() + renderMentorRow() +
        (state.loading ? '<div class="tf-empty">Loading…</div>' : renderMonthView());
    } else {
      main = renderWeekNav() + renderMentorRow() +
        (state.loading ? '<div class="tf-empty">Loading…</div>' : renderFocusList());
    }
    // V3.568 — the assign-a-focus form pops up from a standard app FAB
    // (APP_SHEET), matching the My Day input. Week view only.
    var fab = state.view === 'week'
      ? '<button type="button" class="app-fab" data-act="assign-open" aria-label="Assign a focus">＋</button>'
      : '';
    root.innerHTML =
      '<div class="tf-layout">' +
        renderRail() +
        '<div class="tf-main">' +
          renderTabs() +
          main +
        '</div>' +
      '</div>' + fab;
    // size every description box to its content
    Array.prototype.forEach.call(root.querySelectorAll('.tf-desc, #tf-new-desc'), autosize);
  }

  function renderTabs() {
    var tabs = [['week', 'Week'], ['month', 'Month']];
    return '<div class="tf-tabs">' + tabs.map(function (t) {
      return '<button type="button" class="tf-tab' + (state.view === t[0] ? ' tf-tab-on' : '') +
        '" data-act="tab" data-view="' + t[0] + '">' + t[1] + '</button>';
    }).join('') + '</div>';
  }

  function renderMonthNav() {
    return '<div class="tf-weeknav">' +
      '<button type="button" data-act="mo-prev" aria-label="Previous month">‹</button>' +
      '<span class="tf-weeklabel">' + esc(monthLabel()) + '</span>' +
      '<button type="button" data-act="mo-next" aria-label="Next month">›</button>' +
      (state.monthOffset !== 0 ? '<button type="button" class="tf-wk-today" data-act="mo-now">This month</button>' : '') +
    '</div>';
  }

  /* Read-first month rollup: each overlapping week, its focus areas with
   * status + reported outcome + task progress. "open ›" jumps to the
   * Week tab at that week for editing. */
  function renderMonthView() {
    var weeks = monthWeeks();
    var byWeek = {};
    state.monthFocuses.forEach(function (f) { (byWeek[f.weekId] = byWeek[f.weekId] || []).push(f); });
    var who = isSelf() ? 'you' : ((state.people.find(function (p) { return p.uid === state.viewUid; }) || {}).name || 'this person');
    var anyFocus = state.monthFocuses.length > 0;
    var body = weeks.map(function (w) {
      var rows = (byWeek[w.weekId] || []);
      var cards = rows.length
        ? rows.map(renderMonthFocusRow).join('')
        : '<div class="tf-mo-empty">No focus set</div>';
      return '<div class="tf-mo-week">' +
        '<div class="tf-mo-weekhead">' +
          '<span class="tf-mo-weeklabel">' + esc(w.label) + (w.offset === 0 ? ' · this week' : '') + '</span>' +
          '<button type="button" class="tf-mo-open" data-act="open-week" data-offset="' + w.offset + '">open ›</button>' +
        '</div>' +
        cards +
      '</div>';
    }).join('');
    var lead = anyFocus ? '' :
      '<div class="tf-empty">No focus areas for ' + esc(who) + ' this month yet. Switch to the <strong>Week</strong> tab to add one.</div>';
    return lead + '<div class="tf-monthview">' + body + '</div>';
  }

  function renderMonthFocusRow(f) {
    var meta = FOCUS_AREAS.STATUS_META[f.status];
    var chip = '<span class="tf-chip" style="color:' + meta.color + ';background:' + meta.bg + '">' + meta.label + '</span>';
    var tasks = (f.tasks || []);
    var doneCount = tasks.filter(function (t) { return t.done; }).length;
    var progress = tasks.length ? '<span class="tf-mo-tasks">' + doneCount + '/' + tasks.length + ' tasks</span>' : '';
    var outcome = '';
    if (f.report) {
      var om = FOCUS_AREAS.OUTCOME_META[f.report.outcome] || {};
      outcome = '<span class="tf-mo-outcome">' + (om.icon || '') + ' ' + esc(om.label || f.report.outcome) + '</span>';
    }
    var align = f.focus_ref
      ? '<a class="tf-mo-align" href="/rm/pages/research.html?id=' + encodeURIComponent(f.focus_ref.id) + '">🎯 ' + esc(f.focus_ref.title) + '</a>'
      : '';
    return '<div class="tf-mo-focus">' +
      '<div class="tf-mo-focus-head">' +
        '<span class="tf-mo-title">' + esc(f.title || '(untitled focus)') + '</span>' + chip +
      '</div>' +
      (f.description ? '<div class="tf-mo-desc">' + esc(f.description) + '</div>' : '') +
      '<div class="tf-mo-meta">' + progress + outcome + align + '</div>' +
    '</div>';
  }

  function personChip(p) {
    var initials = p.name.split(/\s+/).map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase();
    return '<button type="button" class="tf-person' + (p.uid === state.viewUid ? ' tf-active' : '') + '" data-uid="' + esc(p.uid) + '">' +
      '<span class="tf-avatar">' + esc(initials) + '</span>' +
      '<span class="tf-pname">' + esc(p.name) + (p.uid === state.me.uid ? ' (you)' : '') + '</span>' +
    '</button>';
  }

  /* V3.568 — the signed-in user as a full-width pill on top, mentees in a
   * horizontal scroll strip below. */
  function renderSelfPill() {
    var self = state.people.find(function (p) { return p.uid === state.me.uid; });
    if (!self) return '';
    var initials = self.name.split(/\s+/).map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase();
    return '<button type="button" class="tf-self-pill' + (self.uid === state.viewUid ? ' tf-active' : '') + '" data-uid="' + esc(self.uid) + '">' +
      '<span class="tf-avatar tf-avatar-lg">' + esc(initials) + '</span>' +
      '<span class="tf-self-name">' + esc(self.name) + ' <em>(you)</em></span>' +
    '</button>';
  }

  function renderRail() {
    var others = state.people.filter(function (p) { return p.uid !== state.me.uid; });
    var mentees = others.length
      ? '<div class="tf-mentees-label">Mentees</div>' +
        '<div class="tf-mentees-scroll">' + others.map(personChip).join('') + '</div>'
      : '';
    return '<div class="tf-people">' + renderSelfPill() + mentees + '</div>';
  }

  function renderWeekNav() {
    return '<div class="tf-weeknav">' +
      '<button type="button" data-act="wk-prev" aria-label="Previous week">‹</button>' +
      '<span class="tf-weeklabel">' + esc(weekLabel()) + '</span>' +
      '<button type="button" data-act="wk-next" aria-label="Next week">›</button>' +
      (state.weekOffset !== 0 ? '<button type="button" class="tf-wk-today" data-act="wk-now">This week</button>' : '') +
    '</div>';
  }

  function renderFocusList() {
    if (!state.focuses.length) {
      var who = isSelf() ? 'you' : (state.people.find(function (p) { return p.uid === state.viewUid; }) || {}).name || 'this person';
      return '<div class="tf-empty">No focus areas for ' + esc(who) + ' this week yet — tap ＋ to add one. ' +
        'A <strong>focus</strong> is the week’s outcome area; the concrete <strong>tasks</strong> live under it.</div>';
    }
    return state.focuses.map(renderFocusCard).join('');
  }

  function renderFocusCard(f) {
    var meta = FOCUS_AREAS.STATUS_META[f.status];
    var chip = '<span class="tf-chip" style="color:' + meta.color + ';background:' + meta.bg + '">' + meta.label + '</span>';
    var srcNote = f.source === 'student' && f.status === 'proposed'
      ? '<span class="tf-src">self-proposed</span>' : '';

    var actions = '';
    if (f.status !== 'reported') {
      if (canConfirm() && (f.status === 'proposed' || f.status === 'mentee_edited')) {
        actions += '<button type="button" class="tf-btn tf-confirm" data-act="confirm">✓ Sign off</button>';
      }
      actions += '<button type="button" class="tf-btn" data-act="del" title="Remove focus">🗑</button>';
    }

    var report = '';
    if (f.report) {
      var om = FOCUS_AREAS.OUTCOME_META[f.report.outcome] || {};
      report = '<div class="tf-report">' +
        '<span class="tf-outcome">' + (om.icon || '') + ' ' + esc(om.label || f.report.outcome) + '</span>' +
        (f.report.summary ? '<span class="tf-rsummary">' + esc(f.report.summary) + '</span>' : '') +
        (f.report.notebook_entry_ids || []).map(function (id) {
          return '<a class="tf-nb-link" href="/rm/pages/lab-notebook.html?entry=' + encodeURIComponent(id) + '">📓 notebook entry</a>';
        }).join('') +
      '</div>';
    }

    var editable = f.status !== 'reported';
    var tasks = (f.tasks || []).map(function (t) {
      return '<div class="tf-task' + (t.done ? ' tf-done' : '') + '">' +
        '<input type="checkbox" data-act="task-toggle" data-task="' + esc(t.id) + '"' + (t.done ? ' checked' : '') + '>' +
        '<input type="text" class="tf-task-text" data-act="task-text" data-task="' + esc(t.id) + '" value="' + esc(t.text) + '"' + (editable ? '' : ' readonly') + '>' +
        '<button type="button" class="tf-task-del" data-act="task-del" data-task="' + esc(t.id) + '" aria-label="Remove task">✕</button>' +
      '</div>';
    }).join('');

    // V3.543 — the research this focus advances (paper drafts).
    var paperChips = (f.paper_refs || []).map(function (r) {
      return '<span class="tf-paper-chip"><a href="/rm/pages/paper-builder.html?id=' + encodeURIComponent(r.id) + '">📝 ' + esc(r.title) + '</a>' +
        (editable ? '<button type="button" class="tf-paper-del" data-act="paper-del" data-paper="' + esc(r.id) + '" aria-label="Unlink paper">✕</button>' : '') +
      '</span>';
    }).join('');
    var paperAdder = '';
    if (editable) {
      var unlinked = state.drafts.filter(function (d) {
        return !(f.paper_refs || []).some(function (r) { return r.id === d.id; });
      });
      if (unlinked.length) {
        paperAdder = '<select class="tf-paper-add" data-act="paper-add">' +
          '<option value="">＋ link a paper…</option>' +
          unlinked.map(function (d) { return '<option value="' + esc(d.id) + '">' + esc(d.title) + '</option>'; }).join('') +
        '</select>';
      }
    }
    var papersRow = (paperChips || paperAdder)
      ? '<div class="tf-papers">' + paperChips + paperAdder + '</div>' : '';

    // V3.550 — the research focus (researchFoci card) this week advances.
    // V3.602 — that alignment can now name a specific ANALYSIS on the
    // card's roadmap, which is the level a week's work actually lands at.
    var alignRow = '';
    if (f.focus_ref) {
      var anchor = f.focus_ref.analysis_id ? '#rmap-' + f.focus_ref.analysis_id : '';
      var label = FOCUS_AREAS.focusRefLabel ? FOCUS_AREAS.focusRefLabel(f.focus_ref) : f.focus_ref.title;
      alignRow = '<div class="tf-align"><a class="tf-align-chip" href="/rm/pages/research.html?id=' + encodeURIComponent(f.focus_ref.id) + anchor + '">🎯 ' + esc(label) + '</a>' +
        (editable ? '<button type="button" class="tf-paper-del" data-act="align-del" aria-label="Unlink research focus">✕</button>' : '') +
      '</div>';
    } else if (editable && state.researchFoci.length) {
      alignRow = '<div class="tf-align"><select class="tf-paper-add" data-act="align-add">' +
        '<option value="">🎯 aligns with research focus…</option>' +
        state.researchFoci.map(function (rf) {
          // Analysis rows are indented under their card so the two levels
          // read as a tree in a flat <select>.
          var text = rf.analysis_title
            ? '  ↳ ' + rf.analysis_title
            : (rf.icon ? rf.icon + ' ' : '') + rf.title;
          return '<option value="' + esc(rf.key || rf.id) + '">' + esc(text) + '</option>';
        }).join('') +
      '</select></div>';
    }

    return '<div class="tf-card" data-id="' + esc(f.id) + '">' +
      '<div class="tf-card-head">' +
        '<input type="text" class="tf-title" data-field="title" value="' + esc(f.title) + '" placeholder="Focus title…"' + (f.status === 'reported' ? ' readonly' : '') + '>' +
        chip + srcNote + actions +
      '</div>' +
      '<textarea class="tf-desc" data-field="description" rows="2" placeholder="What should get done under this focus, and why…"' + (f.status === 'reported' ? ' readonly' : '') + '>' + esc(f.description) + '</textarea>' +
      alignRow +
      papersRow +
      '<div class="tf-tasks">' +
        '<div class="tf-tasks-head">Tasks under this focus</div>' +
        tasks +
        (f.status !== 'reported'
          ? '<input type="text" class="tf-task-add" data-act="task-add" placeholder="＋ add a task…">'
          : '') +
      '</div>' +
      report +
    '</div>';
  }

  /* V3.568 — assign-a-focus is a standard fold-up sheet (APP_SHEET). */
  function openAssignFocus() {
    var self = isSelf();
    if (!window.APP_SHEET) { toast('error', 'app-sheet.js not loaded'); return; }
    APP_SHEET.open({
      title: self ? 'Propose a focus for your week' : 'Assign a focus',
      build: function (body, api) {
        body.innerHTML =
          '<input type="text" id="tf-new-title" placeholder="Focus title (the week’s outcome area)…">' +
          '<textarea id="tf-new-desc" rows="2" placeholder="Description — what should get done and why…"></textarea>' +
          '<button type="button" class="tf-btn tf-primary tf-sheet-go">' + (self ? 'Propose' : 'Assign') + '</button>';
        var ta = body.querySelector('#tf-new-desc');
        body.addEventListener('input', function (ev) { if (ev.target === ta) autosize(ta); });
        body.querySelector('.tf-sheet-go').addEventListener('click', async function () {
          var title = (body.querySelector('#tf-new-title') || {}).value || '';
          var desc = (body.querySelector('#tf-new-desc') || {}).value || '';
          if (!title.trim()) { toast('warn', 'Give the focus a title'); return; }
          try {
            await FOCUS_AREAS.create(state.viewUid, { title: title.trim(), description: desc.trim(), weekId: weekId() });
            toast('success', self ? 'Focus proposed — your mentor will see it' : 'Focus assigned');
            api.close();
            await loadFocuses();
          } catch (err) { toast('error', 'Could not save: ' + (err && err.message)); }
        });
      },
    });
  }

  /* ── events ───────────────────────────────────────────────── */

  function findFocus(el) {
    var card = el.closest('.tf-card');
    if (!card) return null;
    var id = card.getAttribute('data-id');
    return state.focuses.find(function (f) { return f.id === id; }) || null;
  }

  async function onClick(ev) {
    var btn = ev.target.closest('button');
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    var uidBtn = btn.getAttribute('data-uid');
    if (uidBtn) {
      state.viewUid = uidBtn; state.weekOffset = 0; state.monthOffset = 0;
      await (state.view === 'month' ? loadMonthFocuses() : loadFocuses());
      return;
    }

    // V3.564 — horizon tabs + month navigation
    if (act === 'tab') {
      var v = btn.getAttribute('data-view');
      if (v && v !== state.view) {
        state.view = v;
        await (v === 'month' ? loadMonthFocuses() : loadFocuses());
      }
      return;
    }
    if (act === 'mo-prev') { state.monthOffset--; await loadMonthFocuses(); return; }
    if (act === 'mo-next') { state.monthOffset++; await loadMonthFocuses(); return; }
    if (act === 'mo-now')  { state.monthOffset = 0; await loadMonthFocuses(); return; }
    if (act === 'open-week') {
      state.view = 'week';
      state.weekOffset = parseInt(btn.getAttribute('data-offset'), 10) || 0;
      await loadFocuses();
      return;
    }

    if (act === 'wk-prev') { state.weekOffset--; await loadFocuses(); return; }
    if (act === 'wk-next') { state.weekOffset++; await loadFocuses(); return; }
    if (act === 'wk-now')  { state.weekOffset = 0; await loadFocuses(); return; }

    if (act === 'assign-open') { openAssignFocus(); return; }
    if (act === 'mentor-add-open') { openMentorPicker(); return; }
    if (await onMentorClick(btn)) return;

    var f = findFocus(btn);
    if (!f) return;
    if (act === 'confirm') {
      await FOCUS_AREAS.confirm(state.viewUid, f);
      toast('success', 'Signed off — the expectation is set');
      await loadFocuses();
      return;
    }
    if (act === 'del') {
      if (!window.confirm('Remove this focus area (and its tasks)?')) return;
      // V3.602 — pass the doc, not the id, so its roadmapClaims mirror
      // is dropped along with it.
      await FOCUS_AREAS.remove(state.viewUid, f);
      await loadFocuses();
      return;
    }
    if (act === 'task-del') {
      await FOCUS_AREAS.removeTask(state.viewUid, f, btn.getAttribute('data-task'));
      await loadFocuses();
      return;
    }
    if (act === 'paper-del') {
      await FOCUS_AREAS.removePaperRef(state.viewUid, f, btn.getAttribute('data-paper'));
      await loadFocuses();
      return;
    }
    if (act === 'align-del') {   // V3.550
      await FOCUS_AREAS.setFocusRef(state.viewUid, f, null);
      await loadFocuses();
      return;
    }
  }

  /* V3.568 — assign-a-mentor pops up through the standard app sheet. */
  function openMentorPicker() {
    var candidates = state.people.filter(function (p) {
      return p.uid !== state.viewUid &&
        !state.viewMentors.some(function (m) { return m.uid === p.uid; });
    });
    if (!window.APP_SHEET) { toast('error', 'app-sheet.js not loaded'); return; }
    APP_SHEET.open({
      title: 'Assign a mentor',
      build: function (body, api) {
        body.innerHTML = candidates.length
          ? candidates.map(function (p) {
              return '<button type="button" class="tf-picker-item" data-pick="' + esc(p.uid) + '">' +
                esc(p.name) + (p.uid === state.me.uid ? ' (you)' : '') + '</button>';
            }).join('')
          : '<div class="tf-picker-empty">Everyone available is already a mentor.</div>';
        body.addEventListener('click', async function (ev) {
          var pick = ev.target.getAttribute('data-pick');
          if (!pick) return;
          api.close();
          try {
            await firebridge.db().collection('users').doc(state.viewUid).update({
              mentor_uids: firebase.firestore.FieldValue.arrayUnion(pick),
            });
            toast('success', 'Mentor assigned');
            await loadViewMentors();
            render();
          } catch (err) { toast('error', 'Could not assign: ' + (err && err.message)); }
        });
      },
    });
  }

  async function onMentorClick(btn) {
    if (btn.getAttribute('data-act') !== 'mentor-del') return false;
    try {
      await firebridge.db().collection('users').doc(state.viewUid).update({
        mentor_uids: firebase.firestore.FieldValue.arrayRemove(btn.getAttribute('data-uid')),
      });
      await loadFocuses();
    } catch (err) { toast('error', 'Could not remove: ' + (err && err.message)); }
    return true;
  }

  async function onChange(ev) {
    var el = ev.target;
    var f = findFocus(el);
    if (!f) return;
    if (el.getAttribute('data-act') === 'task-toggle') {
      await FOCUS_AREAS.setTaskDone(state.viewUid, f, el.getAttribute('data-task'), el.checked);
      return;
    }
    if (el.getAttribute('data-act') === 'task-text') {
      await FOCUS_AREAS.updateTaskText(state.viewUid, f, el.getAttribute('data-task'), el.value);
      toast('success', 'Task updated');
      return;
    }
    if (el.getAttribute('data-act') === 'paper-add' && el.value) {
      var draft = state.drafts.find(function (d) { return d.id === el.value; });
      if (draft) {
        await FOCUS_AREAS.addPaperRef(state.viewUid, f, draft);
        toast('success', 'Paper linked to this focus');
        await loadFocuses();
      }
      return;
    }
    if (el.getAttribute('data-act') === 'align-add' && el.value) {   // V3.550
      // V3.602 — match on `key`, not `id`: a card and each of its roadmap
      // analyses all share the card's id, so only the composite key is
      // unique across the flattened option list.
      var rf = state.researchFoci.find(function (x) { return (x.key || x.id) === el.value; });
      if (rf) {
        await FOCUS_AREAS.setFocusRef(state.viewUid, f, rf);
        toast('success', 'Aligned with ' + (FOCUS_AREAS.focusRefLabel ? FOCUS_AREAS.focusRefLabel(rf) : rf.title));
        await loadFocuses();
      }
      return;
    }
    var field = el.getAttribute('data-field');
    if (field === 'title' || field === 'description') {
      var patch = {};
      patch[field] = el.value;
      var before = f.status;
      await FOCUS_AREAS.update(state.viewUid, f, patch);
      if (f.status !== before) {
        toast('info', f.status === 'mentee_edited' ? 'Edited — sent back for mentor sign-off' : 'Saved');
        await loadFocuses();
      } else {
        toast('success', 'Saved');
      }
    }
  }

  async function onKeydown(ev) {
    if (ev.key !== 'Enter') return;
    var el = ev.target;
    if (el.getAttribute && el.getAttribute('data-act') === 'task-add' && el.value.trim()) {
      var f = findFocus(el);
      if (!f) return;
      await FOCUS_AREAS.addTask(state.viewUid, f, el.value.trim());
      await loadFocuses();
    }
  }

  /* ── boot ─────────────────────────────────────────────────── */

  async function init() {
    var root = document.getElementById('teamfocus-root');
    if (!root) return;
    if (typeof firebridge === 'undefined') return;
    if (firebridge.requireSignIn) await firebridge.requireSignIn();
    state.me = firebridge.getUser();
    if (!state.me) return; // pending-access overlay covers guests
    if (firebridge.isLabMember && !firebridge.isLabMember()) {
      root.innerHTML = '<div class="tf-empty">Team Focus is for lab members.</div>';
      return;
    }

    var profile = firebridge.getProfile ? (firebridge.getProfile() || {}) : {};
    var self = { uid: state.me.uid, name: (profile.name || state.me.displayName || 'Me'), category: profile.category || '' };
    var mentees = await FOCUS_AREAS.listMentees();
    state.people = [self].concat(mentees.filter(function (p) { return p.uid !== self.uid; }));

    // Default view: mentors land on their first mentee; students on self.
    var params = new URLSearchParams(location.search);
    var wanted = params.get('uid');
    state.viewUid = (wanted && state.people.some(function (p) { return p.uid === wanted; })) ? wanted
      : (mentees.length ? mentees[0].uid : self.uid);

    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('keydown', onKeydown);
    root.addEventListener('input', function (ev) {   // V3.568 — grow desc boxes
      if (ev.target && ev.target.matches && ev.target.matches('.tf-desc, #tf-new-desc')) autosize(ev.target);
    });
    await loadFocuses();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
