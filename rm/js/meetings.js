/* ================================================================
   Lab Meetings — V3.743 remodel
   ================================================================
   Runs the whole lab-meeting loop on one page:

     rotation → slide submissions → PI review → run the timed meeting
     → minutes → action items + chores that land on people's My Week

   Sections (tab strip): Next meeting · Schedule · One-on-ones · Chores ·
   Topics · History · My items · Settings. The Run-meeting view lives in
   meetings-live.js; the chore board in meetings-chores.js; the one-on-one
   calendar (V3.938) in meetings-one-on-one.js; Drive-link
   parsing/verification in drive-link.js. Those modules read the
   `window.MEETINGS` surface published at the bottom of this file.

   Data (see CodeLog/ClaudesPlan/V3.743_lab_meetings_remodel.md):
     meetings/{id}            presenters is a MAP keyed by uid (rules diff
                              it by key: a member may touch only their own),
                              updates{} = the round-robin slide pipeline,
                              minutes{} = the live record, agendaItems[] carry
                              `minutes` so the run view can time each block.
     meetingConfig/settings   coordinatorUids[], agendaTemplates, chores[],
                              Drive settings, semester defaults.
     meetingTopics/{id}       suggestions + votes.
     meetingSwaps/{id}        peer-accept slot swaps; the move itself is done
                              by functions/meetings.js once status='accepted'.
     labChores/{weekId}       assignments (coordinator) + completions (own key).
     oneOnOneSlots/{id}       V3.938 — a recurring one-on-one time offered by
                              the PI / a mentor; a student subscribes by
                              writing their own uid (see meetings-one-on-one.js).

   Live sync: api.subscribe on every route, state hydrated from the
   snapshot itself. NOT the LIVE_SYNC refresh→api.load pattern — that
   re-read the 30-minute route cache and other viewers never actually
   updated. Every direct write still api.invalidate()s its route so a
   cold load is fresh.
   ================================================================ */

(() => {
  'use strict';

  const root = document.getElementById('mtg-root');
  if (!root) { console.warn('[meetings] #mtg-root missing'); return; }

  /* ─── constants ─────────────────────────────────────────────── */
  const PATHS = {
    list:   'meetings/list.json',
    config: 'meetings/config.json',
    topics: 'meetings/topics.json',
    swaps:  'meetings/swaps.json',
    chores: 'meetings/chores.json',
    slots:  'meetings/one-on-ones.json',   // V3.938 — recurring one-on-one times
    users:  'lab/users.json',
  };

  const SECTIONS = [
    { id: 'next',     label: 'Next meeting', icon: 'megaphone' },
    { id: 'schedule', label: 'Schedule',     icon: 'calendar-days' },
    { id: 'oneonone', label: 'One-on-ones',  icon: 'user-group' },      // V3.938 — meetings-one-on-one.js
    { id: 'chores',   label: 'Chores',       icon: 'sparkles' },
    { id: 'topics',   label: 'Topics',       icon: 'light-bulb' },
    { id: 'history',  label: 'History',      icon: 'archive-box' },
    { id: 'mine',     label: 'My items',     icon: 'clipboard-document-list' },
    { id: 'settings', label: 'Settings',     icon: 'cog-6-tooth' },
  ];

  const AGENDA_TYPES = ['business', 'updates', 'discussion', 'presentation', 'qa', 'assignments', 'announcement'];
  const AGENDA_TYPE_LABEL = {
    business: 'Lab business', updates: 'Updates', discussion: 'Discussion',
    presentation: 'Presentation', qa: 'Q & A', assignments: 'Assignments', announcement: 'Announcement',
  };

  /* Alex's default structure — 60 min, 11:00 → 12:00. Start times are
   * DERIVED from meeting.time + cumulative minutes, never stored. */
  const DEFAULT_TEMPLATES = {
    standard: [
      { text: 'Lab business',                          minutes: 10, type: 'business' },
      { text: 'Round-robin updates (1–2 slides each)', minutes: 15, type: 'updates' },
      { text: 'Comments & concerns',                   minutes: 5,  type: 'discussion' },
      { text: 'Presentation',                          minutes: 15, type: 'presentation' },
      { text: 'Q & A',                                 minutes: 5,  type: 'qa' },
      { text: 'Task assignments for next week',        minutes: 10, type: 'assignments' },
    ],
    flash: [
      { text: 'Lab business',                          minutes: 10, type: 'business' },
      { text: 'Comments & concerns',                   minutes: 5,  type: 'discussion' },
      { text: 'Flash talks — everyone',                minutes: 35, type: 'presentation' },
      { text: 'Task assignments for next week',        minutes: 10, type: 'assignments' },
    ],
  };

  const DEFAULT_CHORES = [
    { id: 'autoclave', label: 'Autoclave',             pool: true },
    { id: 'di-water',  label: 'Refill DI water',       pool: true },
    { id: 'waterbath', label: 'Clean waterbath',       pool: true },
    { id: 'inventory', label: 'Update inventory',      pool: true },
    { id: 'sweep',     label: 'Sweep',                 pool: true },
    { id: 'mop',       label: 'Mop',                   pool: true },
    { id: 'biohazard', label: 'Empty biohazard trash', pool: true },
    { id: 'present',   label: 'Present at lab meeting', pool: false, derived: true },
  ];

  const KIND_LABEL = { standard: 'Lab meeting', flash: 'Flash talks — everyone', break: 'No meeting (break)' };

  const REACTIONS = [
    { type: 'interesting', label: 'Interesting',     icon: 'sparkles' },
    { type: 'question',    label: 'I have a question', icon: 'chat-bubble-left-right' },
    { type: 'collaborate', label: 'Let’s collaborate', icon: 'user-group' },
    { type: 'relevant',    label: 'Relevant to me',  icon: 'bolt' },
  ];

  /* Fall 2026 rotation as Alex gave it (2026-09-04), uids resolved against
   * the live users collection that day. Consumed only by seedFall2026(). */
  const UID = {
    gabe:  'BUD6erT6qXTSbFUmDIyNcSOIsXM2',   // Gabriel Declercq
    cason: 'hfcpFSLKLta6gOF8C3xq6tl7ZsP2',   // Cason Hancock
    ally:  'qCEdjoopJFZbN2QkrDTVVoe4YWr2',   // Allison Friedholm
    zeke:  'p5REOuZAUQOrHM7x5z5fO8rvsd72',   // Zeke Pangelinan
    cris:  'uhQNNK3JiMSgwDzEnDLN5aYW5ic2',   // Cristobal Angeles Toscano
    alia:  '3mQTUEImcfetSgW4lQCGtOD7pr22',   // Alia Starman
  };
  const SEED_NAMES = {
    [UID.gabe]: 'Gabriel Declercq', [UID.cason]: 'Cason Hancock', [UID.ally]: 'Allison Friedholm',
    [UID.zeke]: 'Zeke Pangelinan', [UID.cris]: 'Cristobal Angeles Toscano', [UID.alia]: 'Alia Starman',
  };
  const FALL_2026 = [
    ['2026-09-11', 'standard', [UID.gabe]],
    ['2026-09-18', 'standard', [UID.cason]],
    ['2026-09-25', 'standard', [UID.ally, UID.zeke]],
    ['2026-10-02', 'standard', [UID.cris]],
    ['2026-10-09', 'standard', [UID.alia]],
    ['2026-10-16', 'flash',    []],
    ['2026-10-23', 'standard', [UID.gabe]],
    ['2026-10-30', 'standard', [UID.cason]],
    ['2026-11-06', 'standard', [UID.zeke]],
    ['2026-11-13', 'standard', [UID.ally, UID.cris]],
    ['2026-11-20', 'standard', [UID.alia]],
    ['2026-11-27', 'break',    []],
    ['2026-12-04', 'flash',    []],
    ['2026-12-11', 'standard', [UID.gabe, UID.cason]],
    ['2026-12-18', 'standard', [UID.alia]],
  ];
  const FALL_2026_CONFIG = {
    defaultDay: 5, defaultTime: '11:00', defaultDuration: 60, defaultLocation: 'BSRL 100',
    semesterStart: '2026-09-11', semesterEnd: '2026-12-18', skipWeeks: ['2026-11-23'],
  };

  /* ─── state ─────────────────────────────────────────────────── */
  const state = {
    user: null, profile: null,
    config: null, meetings: [], topics: [], swaps: [], chores: [], slots: [], members: [],
    loaded: { list: false, config: false, topics: false, swaps: false, chores: false, slots: false, users: false },
    section: 'next',
    ui: {
      schedFilter: 'upcoming',      // 'upcoming' | 'all'
      ooMonth: null,                // 'YYYY-MM' shown on the One-on-ones calendar | null → this month
      ooFilter: 'mine',             // 'mine' | 'all' (admin: every host's slots)
      histSearch: '', histPresenter: '', histOpen: null,
      topicsShowClosed: false,
      choreWeek: null,              // 'YYYY-Wnn' | null → this week's meeting week
      live: null,                   // meetingId when the Run-meeting view is open
      settingsTab: 'schedule',
      agendaAdd: null,              // meetingId with the inline "+ item" row open
    },
    busy: {},                       // keyed by action id → true while a write is in flight
  };
  const unsubs = [];

  /* ─── tiny helpers ──────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function db() {
    if (typeof firebridge !== 'undefined' && firebridge.db) return firebridge.db();
    return firebase.firestore();
  }
  function FV() { return firebase.firestore.FieldValue; }
  function toast(kind, msg, opts) {
    if (window.TOAST && TOAST[kind]) TOAST[kind](msg, opts);
    else console.log('[meetings] ' + kind + ': ' + msg);
  }
  function icon(name, opts) {
    return (window.ICON && ICON.render) ? ICON.render(name, opts || {}) : '';
  }
  function newId(prefix) {
    return (prefix || 'm') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }
  function isoNow() { return new Date().toISOString(); }
  const pad2 = n => String(n).padStart(2, '0');

  /* dates — YYYY-MM-DD strings throughout; noon-anchored Date() to dodge DST */
  function toDateStr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayStr() { return toDateStr(new Date()); }
  function parseDate(ds) { return new Date(String(ds) + 'T12:00:00'); }
  function addDays(ds, n) { const d = parseDate(ds); d.setDate(d.getDate() + n); return toDateStr(d); }
  function daysUntil(ds) { return Math.round((parseDate(ds) - parseDate(todayStr())) / 86400000); }
  function fmtDate(ds) {
    if (!ds) return 'TBD';
    return parseDate(ds).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function fmtDateLong(ds) {
    if (!ds) return 'TBD';
    return parseDate(ds).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }
  function fmtDateShort(ds) {
    if (!ds) return 'TBD';
    return parseDate(ds).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function dowName(i) { return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i] || ''; }
  /* Monday of the week containing ds */
  function weekStart(ds) { const d = parseDate(ds); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return toDateStr(d); }
  /* ISO week id — same math as focus-areas.js / huddle.js so chore weeks
   * line up with My Week's weekId. */
  function weekIdFor(ds) {
    const p = String(ds || todayStr()).split('-');
    const d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
    const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const wk = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
    return d.getUTCFullYear() + '-W' + pad2(wk);
  }
  /* Monday date for a 'YYYY-Wnn' id */
  function mondayOfWeekId(weekId) {
    const m = /^(\d{4})-W(\d{2})$/.exec(weekId || '');
    if (!m) return todayStr();
    const jan4 = new Date(Date.UTC(+m[1], 0, 4));
    const mon = new Date(jan4); mon.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (+m[2] - 1) * 7);
    return mon.getUTCFullYear() + '-' + pad2(mon.getUTCMonth() + 1) + '-' + pad2(mon.getUTCDate());
  }

  /* times — HH:MM 24h stored; 12h shown */
  function fmtTime(hhmm) {
    if (!hhmm) return '';
    const [h, m] = String(hhmm).split(':').map(Number);
    const ap = h >= 12 ? 'PM' : 'AM';
    return ((h % 12) || 12) + ':' + pad2(m) + ' ' + ap;
  }
  function addMinutes(hhmm, mins) {
    const [h, m] = String(hhmm || '00:00').split(':').map(Number);
    const t = ((h * 60 + m + (mins || 0)) % 1440 + 1440) % 1440;
    return pad2(Math.floor(t / 60)) + ':' + pad2(t % 60);
  }
  function fmtRange(time, duration) {
    if (!time) return '';
    return fmtTime(time) + (duration ? ' – ' + fmtTime(addMinutes(time, duration)) : '');
  }

  /* ─── config with defaults ──────────────────────────────────── */
  function cfg() {
    const c = state.config || {};
    return {
      defaultDay: c.defaultDay != null ? +c.defaultDay : 5,
      defaultTime: c.defaultTime || '11:00',
      defaultDuration: c.defaultDuration != null ? +c.defaultDuration : 60,
      defaultLocation: c.defaultLocation || '',
      semesterStart: c.semesterStart || '', semesterEnd: c.semesterEnd || '',
      skipWeeks: Array.isArray(c.skipWeeks) ? c.skipWeeks : [],
      coordinatorUids: Array.isArray(c.coordinatorUids) ? c.coordinatorUids : [],
      primaryCoordinatorUid: c.primaryCoordinatorUid || (Array.isArray(c.coordinatorUids) ? c.coordinatorUids[0] : '') || '',
      reviewerUids: Array.isArray(c.reviewerUids) ? c.reviewerUids : [],
      driveApiKey: c.driveApiKey || '', driveFolderUrl: c.driveFolderUrl || '',
      labDriveEmail: c.labDriveEmail || (window.DRIVE_LINK ? DRIVE_LINK.LAB_DRIVE_EMAIL : 'mcgheelab@gmail.com'),
      slotsPerMeeting: c.slotsPerMeeting ? +c.slotsPerMeeting : 2,
      submitDeadlineOffsetDays: c.submitDeadlineOffsetDays != null ? +c.submitDeadlineOffsetDays : 2,
      reviewDeadlineOffsetDays: c.reviewDeadlineOffsetDays != null ? +c.reviewDeadlineOffsetDays : 1,
      agendaTemplates: Object.assign({}, DEFAULT_TEMPLATES, c.agendaTemplates || {}),
      chores: (Array.isArray(c.chores) && c.chores.length) ? c.chores : DEFAULT_CHORES,
      meetingAdmins: Array.isArray(c.meetingAdmins) ? c.meetingAdmins : [],
      // V3.744 — roster. null = "not set yet" → computed defaults below.
      attendeeUids: Array.isArray(c.attendeeUids) ? c.attendeeUids : null,
      presenterPoolUids: Array.isArray(c.presenterPoolUids) ? c.presenterPoolUids : null,
    };
  }

  /* ─── roster (V3.744) ───────────────────────────────────────
   * Who is AT lab meetings this semester (owes round-robin slides, can be
   * given chores, can be assigned action items) and who PRESENTS (can be
   * assigned/claim a slot, be a swap target). Set in Settings → Roster;
   * until then: attendees = every visible member who isn't alumni,
   * presenters = attendees minus the PI/reviewers. Alumni never appear in
   * any picker. `state.members` itself stays the full visible list so names
   * of past presenters still resolve in History. */
  const NON_ATTENDING = ['alumni'];
  function defaultAttendees() { return state.members.filter(u => !NON_ATTENDING.includes(u.category)); }
  function rosterMembers() {
    const ids = cfg().attendeeUids;
    if (!ids) return defaultAttendees();
    return state.members.filter(u => ids.includes(u.uid));
  }
  function attends(uid) { return rosterMembers().some(u => u.uid === uid); }
  function presenterPool() {
    const ids = cfg().presenterPoolUids;
    if (ids) return state.members.filter(u => ids.includes(u.uid));
    const rev = new Set(reviewerUids());
    return rosterMembers().filter(u => u.category !== 'pi' && !rev.has(u.uid));
  }
  function canPresent(uid) { return presenterPool().some(u => u.uid === uid); }
  /* action-item assignees: everyone at the meeting plus the reviewers (PI) */
  function assignees() {
    const ids = new Set(rosterMembers().map(u => u.uid).concat(reviewerUids()));
    return state.members.filter(u => ids.has(u.uid));
  }

  /* ─── people & roles ────────────────────────────────────────── */
  function me() { return state.user ? state.user.uid : null; }
  function myName() {
    return (state.profile && state.profile.name) || (state.user && (state.user.displayName || state.user.email)) || 'Someone';
  }
  function isAdmin() { return !!(typeof firebridge !== 'undefined' && firebridge.isAdmin && firebridge.isAdmin()); }
  function isCoordinator(uid) {
    uid = uid || me();
    if (!uid) return false;
    if (uid === me() && isAdmin()) return true;
    const c = cfg();
    if (c.coordinatorUids.includes(uid)) return true;
    // pre-seed fallback: the old meetingAdmins[] list is honoured client-side
    // until the seed folds it into coordinatorUids (rules already read the
    // new field, so this only affects what buttons show, not what saves).
    return !c.coordinatorUids.length && c.meetingAdmins.includes(uid);
  }
  function reviewerUids() {
    const c = cfg();
    if (c.reviewerUids.length) return c.reviewerUids;
    const pis = state.members.filter(u => u.category === 'pi').map(u => u.uid);
    if (pis.length) return pis;
    return state.members.filter(u => u.role === 'admin').map(u => u.uid);
  }
  function isReviewer(uid) { uid = uid || me(); return isAdmin() && uid === me() || reviewerUids().includes(uid); }
  function member(uid) { return state.members.find(u => u.uid === uid) || null; }
  function memberName(uid, fallback) {
    const u = member(uid);
    if (u) return u.name || u.displayName || u.email || 'Unknown';
    return fallback || SEED_NAMES[uid] || 'Unknown';
  }
  function firstName(uid, fallback) { return memberName(uid, fallback).split(/\s+/)[0]; }
  function avatar(uid, nameFallback) {
    const u = member(uid);
    const name = memberName(uid, nameFallback);
    const src = u && u.photo && (u.photo.thumb || u.photo.medium);
    const ini = name.split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase() || '?';
    return src
      ? '<img class="mtg-avatar" src="' + esc(src) + '" alt="" title="' + esc(name) + '">'
      : '<span class="mtg-avatar mtg-avatar-ini" title="' + esc(name) + '">' + esc(ini) + '</span>';
  }

  /* ─── normalizers — every reader goes through these ─────────── */
  /* presenters: map keyed by uid (V3.743) · legacy array · legacy presenterId */
  function presentersOf(m) {
    if (!m) return [];
    const p = m.presenters;
    let arr = [];
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      arr = Object.keys(p).map(uid => Object.assign({ uid }, p[uid] || {}));
    } else if (Array.isArray(p)) {
      arr = p.map((x, i) => Object.assign({ slot: i }, x || {}));
    } else if (m.presenterId) {
      arr = [{ uid: m.presenterId, name: m.presenterName || '', slot: 0 }];
    }
    // legacy per-meeting presentation fields → first presenter
    if (arr.length && !(p && !Array.isArray(p))) {
      if (m.presentationTitle && !arr[0].title) arr[0].title = m.presentationTitle;
      if (m.presentationNotes && !arr[0].abstract) arr[0].abstract = m.presentationNotes;
      if (!arr[0].link && Array.isArray(m.presentationLinks) && m.presentationLinks.length) {
        const l = m.presentationLinks[0];
        arr[0].link = { url: l.url, fileId: null, name: l.label || l.name || '', legacy: true };
      }
    }
    return arr.sort((a, b) => (a.slot || 0) - (b.slot || 0));
  }
  function presentersAreMap(m) { return !!(m && m.presenters && typeof m.presenters === 'object' && !Array.isArray(m.presenters)); }
  function isPresenter(m, uid) { uid = uid || me(); return presentersOf(m).some(p => p.uid === uid); }
  function presenterNames(m) {
    const p = presentersOf(m);
    if (m && m.kind === 'flash') return 'Everyone — flash talks';
    if (!p.length) return 'TBD';
    return p.map(x => memberName(x.uid, x.name)).join(' & ');
  }
  function agendaOf(m) {
    return ((m && Array.isArray(m.agendaItems)) ? m.agendaItems.slice() : [])
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }
  /* agenda with derived start/end — never stored */
  function agendaTimed(m) {
    let t = (m && m.time) || cfg().defaultTime;
    return agendaOf(m).map(it => {
      const mins = +it.minutes || 0;
      const row = Object.assign({}, it, { start: t, end: addMinutes(t, mins), minutes: mins });
      t = row.end;
      return row;
    });
  }
  function agendaTotal(items) { return (items || []).reduce((s, it) => s + (+it.minutes || 0), 0); }
  function updatesOf(m) {
    const u = (m && m.updates) || {};
    return {
      submissions: u.submissions || {},
      deck: u.deck || null, deckBy: u.deckBy || '', deckByName: u.deckByName || '', deckAt: u.deckAt || null,
      review: Object.assign({ status: null, by: '', byName: '', at: null, comment: '' }, u.review || {}),
    };
  }
  function minutesOf(m) {
    const x = (m && m.minutes) || {};
    return { text: x.text || '', items: x.items || {}, startedAt: x.startedAt || null, startedBy: x.startedBy || '',
             endedAt: x.endedAt || null, updatedAt: x.updatedAt || null, updatedBy: x.updatedBy || '' };
  }
  function actionItemsOf(m) { return (m && Array.isArray(m.actionItems)) ? m.actionItems : []; }
  function feedbackOf(m) { return (m && Array.isArray(m.feedback)) ? m.feedback : []; }
  function kindOf(m) { return (m && m.kind) || 'standard'; }
  function isBreak(m) { return kindOf(m) === 'break'; }
  function meeting(id) { return state.meetings.find(m => m.id === id) || null; }

  /* "Next" = soonest meeting that hasn't happened: today's counts until the
   * coordinator marks it completed, then it moves to History and the week
   * after becomes next. */
  function nextMeeting() {
    const t = todayStr();
    return state.meetings.find(m => m.date >= t && m.status !== 'cancelled' && m.status !== 'completed' && !isBreak(m)) || null;
  }
  function previousMeeting(before) {
    const t = before ? before.date : todayStr();
    const past = state.meetings.filter(m => m.date < t && !isBreak(m) && m.status !== 'cancelled');
    return past.length ? past[past.length - 1] : null;
  }
  /* Who owes 1–2 slides this week: lab members minus presenters minus the
   * reviewers (PI). Members who are hidden/collaborators are already filtered
   * out of state.members by LAB_USERS.isVisible. */
  function submittersFor(m) {
    if (!m || kindOf(m) !== 'standard') return [];
    const pres = new Set(presentersOf(m).map(p => p.uid));
    const rev = new Set(reviewerUids());
    return rosterMembers().filter(u => !pres.has(u.uid) && !rev.has(u.uid));
  }
  function submitDue(m) { return addDays(m.date, -cfg().submitDeadlineOffsetDays); }
  function reviewDue(m) { return addDays(m.date, -cfg().reviewDeadlineOffsetDays); }

  /* deep-set 'a.b.c' on a plain object (optimistic local apply) */
  function setPath(obj, path, val) {
    const parts = path.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
      o = o[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (val && val.__delete) delete o[last]; else o[last] = val;
  }
  function DEL() { return { __delete: true }; }
  function toFirestore(val) { return (val && val.__delete) ? FV().delete() : val; }

  /* ═══════════════════════════════════════════════════════════════
     DATA LAYER — subscribe-driven state, surgical writes
     ═══════════════════════════════════════════════════════════════ */
  function invalidate(path) { try { if (api.invalidate) api.invalidate(path); } catch (e) { /* cache only */ } }

  function sortMeetings(list) {
    return (list || []).slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  }

  function subscribeAll() {
    const sub = (path, apply) => {
      try {
        unsubs.push(api.subscribe(path, data => { apply(data || {}); scheduleRender(); }));
      } catch (e) { console.warn('[meetings] subscribe failed for ' + path, e); }
    };
    sub(PATHS.list,   d => { state.meetings = sortMeetings(d.meetings || d.items || []); state.loaded.list = true; });
    sub(PATHS.config, d => { state.config = (d && (d.defaultDay !== undefined || d.updatedAt || d.coordinatorUids)) ? d : (d || {}); state.loaded.config = true; });
    sub(PATHS.topics, d => { state.topics = d.topics || []; state.loaded.topics = true; });
    sub(PATHS.swaps,  d => { state.swaps = d.swaps || []; state.loaded.swaps = true; });
    sub(PATHS.chores, d => { state.chores = d.chores || []; state.loaded.chores = true; });
    sub(PATHS.slots,  d => { state.slots = d.slots || []; state.loaded.slots = true; });
  }

  async function loadMembers() {
    try {
      const d = await api.load(PATHS.users);
      state.members = ((d && d.users) || [])
        .filter(u => LAB_USERS.isVisible(u))
        .map(u => Object.assign({}, u, { uid: u.id || u.uid }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } catch (e) { console.warn('[meetings] users load failed', e); }
    state.loaded.users = true;
  }

  /* meetings/{id} — flat patch (top-level fields). Optimistic apply. */
  async function updateMeeting(id, patch) {
    const m = meeting(id);
    if (m) Object.assign(m, patch);
    scheduleRender();
    await db().collection('meetings').doc(id).update(Object.assign({}, patch, { updatedAt: FV().serverTimestamp() }));
    invalidate(PATHS.list);
  }
  /* meetings/{id} — dotted-path patch (minutes.items.x.notes, presenters.<uid>.title …).
   * Values may be DEL() to delete a key. */
  async function patchFields(id, dotted) {
    const m = meeting(id);
    if (m) Object.keys(dotted).forEach(k => setPath(m, k, dotted[k]));
    scheduleRender();
    const fs = {};
    Object.keys(dotted).forEach(k => { fs[k] = toFirestore(dotted[k]); });
    fs.updatedAt = FV().serverTimestamp();
    await db().collection('meetings').doc(id).update(fs);
    invalidate(PATHS.list);
  }
  async function createMeeting(data) {
    const ref = db().collection('meetings').doc();
    const doc = Object.assign({
      date: todayStr(), time: cfg().defaultTime, duration: cfg().defaultDuration,
      location: cfg().defaultLocation, status: 'upcoming', kind: 'standard',
      presenters: {}, updates: { submissions: {}, deck: null, review: { status: null } },
      agendaItems: [], minutes: { text: '', items: {} }, actionItems: [], feedback: [], notes: '',
      createdBy: me(), createdAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp(),
    }, data);
    await ref.set(doc);
    invalidate(PATHS.list);
    return ref.id;
  }
  async function deleteMeeting(id) {
    state.meetings = state.meetings.filter(m => m.id !== id);
    scheduleRender();
    await db().collection('meetings').doc(id).delete();
    invalidate(PATHS.list);
  }
  async function saveConfig(patch) {
    state.config = Object.assign({}, state.config || {}, patch);
    scheduleRender();
    await db().collection('meetingConfig').doc('settings').set(
      Object.assign({}, patch, { updatedAt: FV().serverTimestamp() }), { merge: true });
    invalidate(PATHS.config);
  }

  /* agenda materialization from a template */
  function templateItems(kind) {
    const tpl = cfg().agendaTemplates[kind === 'flash' ? 'flash' : 'standard'] || [];
    return tpl.map((t, i) => ({
      id: newId('ag'), text: t.text, minutes: +t.minutes || 0, type: t.type || 'discussion',
      order: i, done: false, addedBy: me() || '', addedByName: myName(),
    }));
  }

  /* ─── presenters (map keyed by uid) ─────────────────────────── */
  function presenterEntry(uid, slot, extra) {
    return Object.assign({ slot: slot || 0, name: memberName(uid), title: '', abstract: '', link: null, updatedAt: isoNow() }, extra || {});
  }
  function freeSlot(m, exclude) {
    const taken = new Set(presentersOf(m).filter(p => p.uid !== exclude).map(p => p.slot));
    for (let i = 0; i < cfg().slotsPerMeeting; i++) if (!taken.has(i)) return i;
    return null;
  }
  /* a member claiming an empty slot / a coordinator assigning anyone */
  async function assignSlot(meetingId, uid, slot) {
    const m = meeting(meetingId);
    if (!m) return;
    if (!presentersAreMap(m) && presentersOf(m).length) {
      toast('warn', 'This meeting still uses the old presenter format — run “Migrate presenters” in Settings first.');
      return;
    }
    if (slot == null) slot = freeSlot(m, uid);
    if (slot == null) { toast('warn', 'No free slot on ' + fmtDate(m.date)); return; }
    const existing = presentersOf(m).find(p => p.uid === uid);
    const patch = {};
    patch['presenters.' + uid] = existing ? Object.assign({}, existing, { slot, uid: undefined }) : presenterEntry(uid, slot);
    delete patch['presenters.' + uid].uid;
    await patchFields(meetingId, patch);
  }
  async function unassignSlot(meetingId, uid) {
    const patch = {}; patch['presenters.' + uid] = DEL();
    await patchFields(meetingId, patch);
  }
  /* coordinator: move/swap presenters across the board in one batch */
  async function movePresenter(fromMeetingId, uid, toMeetingId, toSlot) {
    const from = meeting(fromMeetingId), to = meeting(toMeetingId);
    if (!from || !to) return;
    const mover = presentersOf(from).find(p => p.uid === uid);
    if (!mover) return;
    const occupant = presentersOf(to).find(p => p.slot === toSlot && p.uid !== uid);
    const b = db().batch();
    const ts = FV().serverTimestamp();
    const moverEntry = Object.assign({}, mover, { slot: toSlot }); delete moverEntry.uid;
    if (fromMeetingId === toMeetingId) {
      const upd = {}; upd['presenters.' + uid] = moverEntry;
      if (occupant) { const occ = Object.assign({}, occupant, { slot: mover.slot }); delete occ.uid; upd['presenters.' + occupant.uid] = occ; }
      upd.updatedAt = ts;
      b.update(db().collection('meetings').doc(toMeetingId), upd);
    } else {
      const updFrom = {}; updFrom['presenters.' + uid] = FV().delete(); updFrom.updatedAt = ts;
      const updTo = {}; updTo['presenters.' + uid] = moverEntry; updTo.updatedAt = ts;
      if (occupant) {
        const occ = Object.assign({}, occupant, { slot: mover.slot }); delete occ.uid;
        updTo['presenters.' + occupant.uid] = FV().delete();
        updFrom['presenters.' + occupant.uid] = occ;
      }
      b.update(db().collection('meetings').doc(fromMeetingId), updFrom);
      b.update(db().collection('meetings').doc(toMeetingId), updTo);
    }
    await b.commit();
    invalidate(PATHS.list);
    toast('success', occupant ? 'Swapped ' + firstName(uid) + ' and ' + firstName(occupant.uid) : 'Moved ' + firstName(uid) + ' to ' + fmtDate(to.date));
  }
  /* a presenter editing their own title/abstract/link (or a coordinator, anyone's) */
  async function savePresentation(meetingId, uid, fields) {
    const patch = {};
    if (fields.title !== undefined)    patch['presenters.' + uid + '.title'] = fields.title;
    if (fields.abstract !== undefined) patch['presenters.' + uid + '.abstract'] = fields.abstract;
    if (fields.link !== undefined)     patch['presenters.' + uid + '.link'] = fields.link;
    patch['presenters.' + uid + '.updatedAt'] = isoNow();
    await patchFields(meetingId, patch);
  }

  /* ─── round-robin slide pipeline ────────────────────────────── */
  async function submitSlides(meetingId, ref, note) {
    const p = {}; p['updates.submissions.' + me()] = { link: ref, note: note || '', name: myName(), submittedAt: isoNow() };
    await patchFields(meetingId, p);
    toast('success', 'Slides link submitted');
  }
  async function removeSubmission(meetingId, uid) {
    const p = {}; p['updates.submissions.' + uid] = DEL();
    await patchFields(meetingId, p);
  }
  async function postDeck(meetingId, ref) {
    await patchFields(meetingId, {
      'updates.deck': ref, 'updates.deckBy': me(), 'updates.deckByName': myName(), 'updates.deckAt': isoNow(),
      'updates.review.status': 'pending', 'updates.review.comment': '', 'updates.review.by': '', 'updates.review.at': null,
    });
    toast('success', 'Combined deck posted — the PI has been asked to review it');
  }
  async function reviewDeck(meetingId, status, comment) {
    await patchFields(meetingId, {
      'updates.review.status': status, 'updates.review.comment': comment || '',
      'updates.review.by': me(), 'updates.review.byName': myName(), 'updates.review.at': isoNow(),
    });
    toast('success', status === 'approved' ? 'Deck approved' : 'Changes requested');
  }

  /* ─── agenda (coordinator) ──────────────────────────────────── */
  async function saveAgenda(meetingId, items) {
    const cleaned = items.map((it, i) => Object.assign({}, it, { order: i, minutes: +it.minutes || 0 }));
    await updateMeeting(meetingId, { agendaItems: cleaned });
  }
  async function addAgendaItem(meetingId, fields) {
    const items = agendaOf(meeting(meetingId));
    items.push({ id: newId('ag'), text: fields.text, minutes: +fields.minutes || 5, type: fields.type || 'discussion',
                 order: items.length, done: false, topicId: fields.topicId || null, addedBy: me(), addedByName: myName() });
    await saveAgenda(meetingId, items);
  }
  async function removeAgendaItem(meetingId, itemId) {
    await saveAgenda(meetingId, agendaOf(meeting(meetingId)).filter(it => it.id !== itemId));
  }
  async function moveAgendaItem(meetingId, itemId, dir) {
    const items = agendaOf(meeting(meetingId));
    const i = items.findIndex(it => it.id === itemId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    await saveAgenda(meetingId, items);
  }
  async function applyTemplate(meetingId) {
    const m = meeting(meetingId);
    await saveAgenda(meetingId, templateItems(kindOf(m)));
    toast('success', 'Agenda template applied');
  }

  /* ─── action items → the assignee's My Week ─────────────────── */
  /* Writes the meeting record AND a real task at userData/{assignee}/tasks
   * via TASK_ASSIGN.writeTaskFor — the rules-legal cross-user write. My Week
   * surfaces `bucket:'assigned'` tasks as a card the student plans into a
   * day. Never TASK_ASSIGN.open(): for a non-admin sender that writes only a
   * stranded taskMarket post (the V3.639 bug). */
  async function pushTask(assigneeUid, text, dueDate, sourceRef) {
    if (!window.TASK_ASSIGN || !TASK_ASSIGN.writeTaskFor || !assigneeUid) return null;
    try {
      const task = await TASK_ASSIGN.writeTaskFor(assigneeUid, {
        text, due_date: dueDate || 'TBD', bucket: 'assigned',
        createdByUid: me(), createdByName: myName(),
        assignedToUid: assigneeUid, assignedToName: memberName(assigneeUid),
        source: sourceRef.kind === 'lab-chore' ? 'chore' : 'meeting',
        source_ref: sourceRef,
      });
      return task && task.id;
    } catch (e) {
      console.warn('[meetings] task push failed:', e && e.message);
      toast('warn', 'Saved, but couldn’t add it to ' + firstName(assigneeUid) + '’s My Week: ' + (e && e.message));
      return null;
    }
  }
  async function deleteTask(assigneeUid, taskId) {
    if (!assigneeUid || !taskId) return;
    try { await db().collection('userData').doc(assigneeUid).collection('tasks').doc(taskId).delete(); }
    catch (e) { console.warn('[meetings] task delete failed:', e && e.message); }
  }
  async function markTaskDone(assigneeUid, taskId, done) {
    if (!assigneeUid || !taskId) return;
    try {
      await db().collection('userData').doc(assigneeUid).collection('tasks').doc(taskId)
        .update({ done: !!done, done_at: done ? isoNow() : null, updatedAt: FV().serverTimestamp() });
    } catch (e) { /* only owner or creator may — fine */ }
  }
  async function addActionItem(meetingId, fields) {
    const m = meeting(meetingId);
    if (!m || !fields.text) return;
    const id = newId('ai');
    const item = {
      id, text: fields.text, assigneeUid: fields.assigneeUid || '', assigneeName: fields.assigneeUid ? memberName(fields.assigneeUid) : '',
      deadline: fields.deadline || null, status: 'open', createdAt: isoNow(), createdBy: me(), createdByName: myName(),
      taskId: null, pushedAt: null,
    };
    if (fields.assigneeUid) {
      item.taskId = await pushTask(fields.assigneeUid, fields.text, fields.deadline,
        { kind: 'meeting-action', meetingId, actionItemId: id, meetingDate: m.date });
      if (item.taskId) item.pushedAt = isoNow();
    }
    await updateMeeting(meetingId, { actionItems: actionItemsOf(m).concat([item]) });
    toast('success', item.taskId ? 'Action item added — it’s on ' + firstName(item.assigneeUid) + '’s My Week' : 'Action item added');
    return item;
  }
  async function setActionItemStatus(meetingId, itemId, done) {
    const m = meeting(meetingId);
    if (!m) return;
    const items = actionItemsOf(m).map(it => it.id === itemId
      ? Object.assign({}, it, { status: done ? 'done' : 'open', doneAt: done ? isoNow() : null, doneBy: done ? me() : null }) : it);
    await updateMeeting(meetingId, { actionItems: items });
    const it = items.find(x => x.id === itemId);
    if (it && it.taskId) markTaskDone(it.assigneeUid, it.taskId, done);
  }
  async function removeActionItem(meetingId, itemId) {
    const m = meeting(meetingId);
    if (!m) return;
    const it = actionItemsOf(m).find(x => x.id === itemId);
    await updateMeeting(meetingId, { actionItems: actionItemsOf(m).filter(x => x.id !== itemId) });
    if (it && it.taskId && !(it.status === 'done')) deleteTask(it.assigneeUid, it.taskId);
  }

  /* ─── reactions ─────────────────────────────────────────────── */
  async function toggleReaction(meetingId, type) {
    const m = meeting(meetingId);
    if (!m) return;
    const fb = feedbackOf(m);
    const mine = fb.find(f => f.uid === me() && f.type === type);
    const next = mine ? fb.filter(f => !(f.uid === me() && f.type === type))
                      : fb.concat([{ uid: me(), name: myName(), type, createdAt: isoNow() }]);
    await updateMeeting(meetingId, { feedback: next });
  }

  /* ─── status / schedule (coordinator) ───────────────────────── */
  async function setStatus(meetingId, status) {
    const patch = { status };
    if (status === 'completed') patch['minutes.endedAt'] = isoNow();
    await patchFields(meetingId, patch);
  }
  async function postpone(meetingId, newDate) {
    await updateMeeting(meetingId, { date: newDate, 'reminded': {} });
    toast('success', 'Moved to ' + fmtDate(newDate));
  }

  /* Generate one meeting per configured weekday between the semester dates,
   * skipping weeks whose Monday is in skipWeeks and dates that already have
   * a meeting. One batch, not a serial await per meeting. */
  async function generateMeetings() {
    const c = cfg();
    if (!c.semesterStart || !c.semesterEnd) { toast('warn', 'Set the semester start and end dates first'); return 0; }
    const have = new Set(state.meetings.map(m => m.date));
    const b = db().batch();
    let n = 0;
    for (let d = c.semesterStart; d <= c.semesterEnd; d = addDays(d, 1)) {
      if (parseDate(d).getDay() !== c.defaultDay) continue;
      if (c.skipWeeks.includes(weekStart(d)) || have.has(d)) continue;
      const ref = db().collection('meetings').doc();
      b.set(ref, {
        date: d, time: c.defaultTime, duration: c.defaultDuration, location: c.defaultLocation,
        status: 'upcoming', kind: 'standard', presenters: {},
        updates: { submissions: {}, deck: null, review: { status: null } },
        agendaItems: templateItems('standard'), minutes: { text: '', items: {} }, actionItems: [], feedback: [], notes: '',
        createdBy: me(), createdAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp(),
      });
      n++;
      if (n >= 400) break;
    }
    if (n) await b.commit();
    invalidate(PATHS.list);
    toast('success', n ? 'Created ' + n + ' meeting' + (n === 1 ? '' : 's') : 'Nothing to add — every date already has a meeting');
    return n;
  }

  /* Fall 2026 seed — idempotent: skips dates that already exist, only ever
   * ADDS config keys it owns, archives stale spring rows still marked upcoming. */
  async function seedFall2026() {
    const c = cfg();
    const have = new Map(state.meetings.map(m => [m.date, m]));
    const b = db().batch();
    const ts = FV().serverTimestamp();
    let created = 0, skipped = 0, archived = 0;

    const coordinators = Array.from(new Set([UID.cason].concat(c.coordinatorUids, c.meetingAdmins)));
    const cfgPatch = Object.assign({}, FALL_2026_CONFIG, {
      coordinatorUids: coordinators,
      primaryCoordinatorUid: c.primaryCoordinatorUid || UID.cason,
      slotsPerMeeting: c.slotsPerMeeting || 2,
      labDriveEmail: c.labDriveEmail,
      submitDeadlineOffsetDays: c.submitDeadlineOffsetDays, reviewDeadlineOffsetDays: c.reviewDeadlineOffsetDays,
      seededAt: ts, updatedAt: ts,
    });
    if (!state.config || !state.config.agendaTemplates) cfgPatch.agendaTemplates = DEFAULT_TEMPLATES;
    if (!state.config || !Array.isArray(state.config.chores) || !state.config.chores.length) cfgPatch.chores = DEFAULT_CHORES;
    if (!c.reviewerUids.length) cfgPatch.reviewerUids = reviewerUids();
    // roster (V3.744): everyone current is at meetings; the six in the rotation present
    if (!c.attendeeUids) cfgPatch.attendeeUids = defaultAttendees().map(u => u.uid);
    if (!c.presenterPoolUids) cfgPatch.presenterPoolUids = Array.from(new Set(FALL_2026.flatMap(r => r[2])));
    b.set(db().collection('meetingConfig').doc('settings'), cfgPatch, { merge: true });

    FALL_2026.forEach(([date, kind, uids]) => {
      if (have.has(date)) { skipped++; return; }
      const presenters = {};
      uids.forEach((uid, i) => { presenters[uid] = presenterEntry(uid, i, { name: memberName(uid, SEED_NAMES[uid]) }); });
      b.set(db().collection('meetings').doc(), {
        date, time: FALL_2026_CONFIG.defaultTime, duration: FALL_2026_CONFIG.defaultDuration,
        location: FALL_2026_CONFIG.defaultLocation, kind,
        status: kind === 'break' ? 'cancelled' : 'upcoming',
        presenters, updates: { submissions: {}, deck: null, review: { status: null } },
        agendaItems: kind === 'break' ? [] : templateItems(kind),
        minutes: { text: '', items: {} }, actionItems: [], feedback: [], notes: '',
        seed: 'fall-2026', createdBy: me(), createdAt: ts, updatedAt: ts,
      });
      created++;
    });
    // stale spring rows still "upcoming" months after the fact
    state.meetings.forEach(m => {
      if (m.status === 'upcoming' && m.date < '2026-09-01') {
        b.update(db().collection('meetings').doc(m.id), { status: 'completed', archivedBySeed: true, updatedAt: ts });
        archived++;
      }
    });
    await b.commit();
    invalidate(PATHS.list); invalidate(PATHS.config);
    const msg = 'Seeded Fall 2026: ' + created + ' meetings created, ' + skipped + ' already existed, ' + archived + ' stale rows archived.';
    toast('success', msg);
    return msg;
  }

  /* Convert legacy presenters[] / presenterId docs to the uid-keyed map. */
  async function migratePresenters() {
    const b = db().batch();
    let n = 0;
    state.meetings.forEach(m => {
      if (presentersAreMap(m)) return;
      const arr = presentersOf(m);
      if (!arr.length && !m.presenterId && !Array.isArray(m.presenters)) return;
      const map = {};
      arr.forEach((p, i) => {
        if (!p.uid) return;
        map[p.uid] = { slot: i, name: p.name || memberName(p.uid), title: p.title || '', abstract: p.abstract || '',
                       link: p.link || null, updatedAt: isoNow() };
      });
      b.update(db().collection('meetings').doc(m.id), { presenters: map, updatedAt: FV().serverTimestamp() });
      n++;
    });
    if (n) await b.commit();
    invalidate(PATHS.list);
    toast('success', n ? 'Migrated ' + n + ' meeting' + (n === 1 ? '' : 's') : 'Nothing to migrate');
    return n;
  }

  /* ─── topics ────────────────────────────────────────────────── */
  async function addTopic(text, details) {
    const ref = db().collection('meetingTopics').doc();
    await ref.set({ text, details: details || '', suggestedBy: me(), suggestedByName: myName(), votes: [me()],
                    status: 'open', meetingId: null, agendaItemId: null,
                    createdAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp() });
    invalidate(PATHS.topics);
    toast('success', 'Topic suggested');
  }
  async function toggleVote(topicId) {
    const t = state.topics.find(x => x.id === topicId);
    if (!t) return;
    const votes = (t.votes || []).includes(me()) ? (t.votes || []).filter(u => u !== me()) : (t.votes || []).concat([me()]);
    t.votes = votes; scheduleRender();
    await db().collection('meetingTopics').doc(topicId).update({ votes, updatedAt: FV().serverTimestamp() });
    invalidate(PATHS.topics);
  }
  async function updateTopic(topicId, patch) {
    const t = state.topics.find(x => x.id === topicId);
    if (t) Object.assign(t, patch);
    scheduleRender();
    await db().collection('meetingTopics').doc(topicId).update(Object.assign({}, patch, { updatedAt: FV().serverTimestamp() }));
    invalidate(PATHS.topics);
  }
  async function deleteTopic(topicId) {
    state.topics = state.topics.filter(x => x.id !== topicId); scheduleRender();
    await db().collection('meetingTopics').doc(topicId).delete();
    invalidate(PATHS.topics);
  }
  /* coordinator: topic → agenda item on a meeting */
  async function scheduleTopic(topicId, meetingId, minutes) {
    const t = state.topics.find(x => x.id === topicId);
    const m = meeting(meetingId);
    if (!t || !m) return;
    const items = agendaOf(m);
    const agId = newId('ag');
    items.push({ id: agId, text: t.text, minutes: +minutes || 5, type: 'discussion', order: items.length, done: false,
                 topicId, addedBy: me(), addedByName: myName() });
    await saveAgenda(meetingId, items);
    await updateTopic(topicId, { status: 'scheduled', meetingId, agendaItemId: agId });
    toast('success', 'Scheduled for ' + fmtDate(m.date));
  }

  /* ─── swaps (peer-accept; executed server-side) ─────────────── */
  async function requestSwap(fromMeetingId, toUid, toMeetingId, message) {
    const from = meeting(fromMeetingId), to = meeting(toMeetingId);
    const mine = presentersOf(from).find(p => p.uid === me());
    const theirs = presentersOf(to).find(p => p.uid === toUid);
    if (!from || !to || !mine || !theirs) { toast('error', 'Those slots changed — refresh and try again'); return; }
    await db().collection('meetingSwaps').doc().set({
      fromUid: me(), fromName: myName(), fromMeetingId, fromDate: from.date, fromSlot: mine.slot || 0,
      toUid, toName: memberName(toUid), toMeetingId, toDate: to.date, toSlot: theirs.slot || 0,
      message: message || '', status: 'pending',
      createdAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp(), resolvedAt: null, executedAt: null, error: null,
    });
    invalidate(PATHS.swaps);
    toast('success', 'Swap request sent to ' + firstName(toUid));
  }
  async function respondSwap(swapId, status) {
    const s = state.swaps.find(x => x.id === swapId);
    if (s) s.status = status;
    scheduleRender();
    await db().collection('meetingSwaps').doc(swapId).update({ status, resolvedAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp() });
    invalidate(PATHS.swaps);
    if (status === 'accepted') toast('success', 'Accepted — the slots will switch in a few seconds');
    else if (status === 'declined') toast('info', 'Declined');
    else toast('info', 'Request cancelled');
  }
  /* Coordinator fallback: apply an accepted swap right now (the Cloud
   * Function normally does this within seconds). */
  async function executeSwap(swapId) {
    const s = state.swaps.find(x => x.id === swapId);
    if (!s || s.status !== 'accepted' || s.executedAt) return;
    // Resolve both parties by uid at execution time — the stored slots are a
    // snapshot from request time and the board may have moved since.
    const mover = presentersOf(meeting(s.fromMeetingId)).find(p => p.uid === s.fromUid);
    const target = presentersOf(meeting(s.toMeetingId)).find(p => p.uid === s.toUid);
    if (!mover || !target) {
      await db().collection('meetingSwaps').doc(swapId).update({ error: 'One of the slots changed before the swap was applied', updatedAt: FV().serverTimestamp() });
      toast('warn', 'Couldn’t apply — one of the slots changed. Ask them to re-request.');
      return;
    }
    await movePresenter(s.fromMeetingId, s.fromUid, s.toMeetingId, target.slot);
    await db().collection('meetingSwaps').doc(swapId).update({ executedAt: FV().serverTimestamp(), executedBy: me(), error: null });
    invalidate(PATHS.swaps);
  }
  function mySwaps() {
    const uid = me();
    return {
      incoming: state.swaps.filter(s => s.toUid === uid && s.status === 'pending'),
      outgoing: state.swaps.filter(s => s.fromUid === uid && s.status === 'pending'),
    };
  }

  /* ─── chores ────────────────────────────────────────────────── */
  function choreWeekId() {
    if (state.ui.choreWeek) return state.ui.choreWeek;
    const nm = nextMeeting();
    return weekIdFor(nm ? nm.date : todayStr());
  }
  function choreDoc(weekId) { return state.chores.find(c => c.id === weekId || c.weekId === weekId) || null; }
  function meetingForWeek(weekId) { return state.meetings.find(m => weekIdFor(m.date) === weekId && !isBreak(m)) || null; }
  async function ensureChoreDoc(weekId) {
    if (choreDoc(weekId)) return;
    const m = meetingForWeek(weekId);
    const doc = { weekId, meetingId: m ? m.id : null, meetingDate: m ? m.date : null, assignments: {}, completions: {},
                  assignedBy: me(), assignedByName: myName(), createdAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp() };
    await db().collection('labChores').doc(weekId).set(doc, { merge: true });
    state.chores.push(Object.assign({ id: weekId }, doc));
    invalidate(PATHS.chores);
  }
  async function assignChore(weekId, choreId, uid) {
    await ensureChoreDoc(weekId);
    const d = choreDoc(weekId);
    const prev = (d.assignments || {})[choreId];
    const chore = cfg().chores.find(c => c.id === choreId);
    const m = meetingForWeek(weekId);
    const patch = {};
    if (!uid) {
      patch['assignments.' + choreId] = FV().delete();
      if (prev && prev.taskId) deleteTask(prev.uid, prev.taskId);
      if (d.assignments) delete d.assignments[choreId];
    } else {
      if (prev && prev.uid !== uid && prev.taskId) deleteTask(prev.uid, prev.taskId);
      const taskId = (prev && prev.uid === uid && prev.taskId) ? prev.taskId
        : await pushTask(uid, (chore ? chore.label : choreId) + ' — lab chore', m ? m.date : addDays(mondayOfWeekId(weekId), 4),
            { kind: 'lab-chore', weekId, choreId, label: chore ? chore.label : choreId, meetingId: m ? m.id : null });
      const entry = { uid, name: memberName(uid), taskId: taskId || null, assignedBy: me(), assignedAt: isoNow() };
      patch['assignments.' + choreId] = entry;
      d.assignments = d.assignments || {}; d.assignments[choreId] = entry;
    }
    patch.updatedAt = FV().serverTimestamp();
    scheduleRender();
    await db().collection('labChores').doc(weekId).update(patch);
    invalidate(PATHS.chores);
  }
  async function tickChore(weekId, choreId, uid, done) {
    const d = choreDoc(weekId);
    if (!d) return;
    const patch = {};
    patch['completions.' + uid + '.' + choreId] = done ? { doneAt: isoNow() } : FV().delete();
    patch.updatedAt = FV().serverTimestamp();
    d.completions = d.completions || {}; d.completions[uid] = d.completions[uid] || {};
    if (done) d.completions[uid][choreId] = { doneAt: isoNow() }; else delete d.completions[uid][choreId];
    scheduleRender();
    await db().collection('labChores').doc(weekId).update(patch);
    invalidate(PATHS.chores);
    const a = (d.assignments || {})[choreId];
    if (a && a.taskId && a.uid === uid) markTaskDone(uid, a.taskId, done);
  }
  /* "⟳ Fill the rest": only chores with no assignment; pool = members minus
   * this week's presenters minus anyone already hand-assigned this week,
   * ordered by fewest chores in the last 8 weeks, then least recently. */
  async function fillRest(weekId) {
    await ensureChoreDoc(weekId);
    const d = choreDoc(weekId);
    const m = meetingForWeek(weekId);
    const presenters = new Set(m ? presentersOf(m).map(p => p.uid) : []);
    const taken = new Set(Object.values(d.assignments || {}).map(a => a.uid));
    const reviewers = new Set(reviewerUids());
    const open = cfg().chores.filter(c => c.pool !== false && !c.derived && !(d.assignments || {})[c.id]);
    if (!open.length) { toast('info', 'Every chore already has a name on it'); return 0; }
    // history: count per uid over the previous 8 weeks + most recent week
    const counts = {}, last = {};
    const weeks = state.chores.filter(c => c.weekId && c.weekId < weekId).sort((a, b) => b.weekId.localeCompare(a.weekId)).slice(0, 8);
    weeks.forEach(w => Object.values(w.assignments || {}).forEach(a => {
      counts[a.uid] = (counts[a.uid] || 0) + 1;
      if (!last[a.uid] || w.weekId > last[a.uid]) last[a.uid] = w.weekId;
    }));
    let pool = rosterMembers().filter(u => !presenters.has(u.uid) && !reviewers.has(u.uid) && !taken.has(u.uid));
    if (pool.length < open.length) pool = rosterMembers().filter(u => !presenters.has(u.uid) && !reviewers.has(u.uid));
    if (!pool.length) { toast('warn', 'No one to assign'); return 0; }
    pool.sort((a, b) => (counts[a.uid] || 0) - (counts[b.uid] || 0) || (last[a.uid] || '').localeCompare(last[b.uid] || '') || a.name.localeCompare(b.name));
    let n = 0;
    for (let i = 0; i < open.length; i++) {
      await assignChore(weekId, open[i].id, pool[i % pool.length].uid);
      n++;
    }
    toast('success', 'Filled ' + n + ' chore' + (n === 1 ? '' : 's') + ' — tap any name to change it');
    return n;
  }
  function myChoresThisWeek() {
    const wk = choreWeekId();
    const d = choreDoc(wk);
    if (!d) return [];
    const out = [];
    Object.keys(d.assignments || {}).forEach(cid => {
      const a = d.assignments[cid];
      if (a && a.uid === me()) {
        const chore = cfg().chores.find(c => c.id === cid);
        out.push({ weekId: wk, choreId: cid, label: chore ? chore.label : cid, done: !!((d.completions || {})[me()] || {})[cid] });
      }
    });
    return out;
  }

  /* ═══════════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════════ */
  let _renderTimer = null, _renderDeferred = false;

  function isTyping() {
    const ae = document.activeElement;
    if (!ae || !root.contains(ae)) return false;
    return ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'range'].includes(ae.type)) || ae.isContentEditable;
  }
  /* Snapshot-driven: debounced, and DEFERRED while the user is typing in
   * the page — a snapshot re-render would reset the field to its stored
   * value and eat unsaved keystrokes. Flushes on focusout. */
  function scheduleRender() {
    if (_renderTimer) return;
    _renderTimer = setTimeout(() => {
      _renderTimer = null;
      if (isTyping()) { _renderDeferred = true; return; }
      render();
    }, 120);
  }
  root.addEventListener('focusout', () => {
    if (!_renderDeferred) return;
    setTimeout(() => { if (_renderDeferred && !isTyping()) { _renderDeferred = false; render(); } }, 60);
  });

  /* User-action renders are immediate; focus + caret survive by element id. */
  function render() {
    _renderDeferred = false;
    const ae = document.activeElement;
    const keepId = ae && root.contains(ae) && ae.id ? ae.id : null;
    const sel = keepId && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') ? { s: ae.selectionStart, e: ae.selectionEnd } : null;
    const y = window.scrollY;

    if (!state.user) { root.innerHTML = ''; return; }
    if (typeof firebridge !== 'undefined' && firebridge.isLabMember && !firebridge.isLabMember()) {
      root.innerHTML = '<div class="mtg-empty">Lab meetings are for lab members.</div>';
      return;
    }
    let body;
    if (state.ui.live && window.MEETINGS_LIVE) {
      const m = meeting(state.ui.live);
      body = m ? MEETINGS_LIVE.render(m) : '<div class="mtg-empty">That meeting is gone.</div>';
      root.innerHTML = renderHeader() + body;
    } else {
      switch (state.section) {
        case 'schedule': body = renderSchedule(); break;
        case 'chores':   body = window.MEETINGS_CHORES ? MEETINGS_CHORES.render(choreWeekId()) : '<div class="mtg-empty">meetings-chores.js not loaded</div>'; break;
        case 'oneonone': body = window.MEETINGS_ONE_ON_ONE ? MEETINGS_ONE_ON_ONE.render() : '<div class="mtg-empty">meetings-one-on-one.js not loaded</div>'; break;
        case 'topics':   body = renderTopics(); break;
        case 'history':  body = renderHistory(); break;
        case 'mine':     body = renderMine(); break;
        case 'settings': body = renderSettings(); break;
        default:         body = renderNext();
      }
      root.innerHTML = renderHeader() + renderTabs() + '<div class="mtg-main">' + body + '</div>';
    }
    if (window.MEETINGS_LIVE && MEETINGS_LIVE.afterRender) MEETINGS_LIVE.afterRender(state.ui.live);
    window.scrollTo(0, y);
    if (keepId) {
      const el = document.getElementById(keepId);
      if (el) { try { el.focus({ preventScroll: true }); if (sel && el.setSelectionRange) el.setSelectionRange(sel.s, sel.e); } catch (e) { /* */ } }
    }
  }

  function renderHeader() {
    const c = cfg();
    const coord = c.primaryCoordinatorUid;
    const others = c.coordinatorUids.filter(u => u !== coord);
    const roleChips = [];
    if (isAdmin()) roleChips.push('<span class="mtg-role mtg-role-admin">admin</span>');
    else if (isCoordinator()) roleChips.push('<span class="mtg-role mtg-role-coord">coordinator</span>');
    if (isReviewer() && !isAdmin()) roleChips.push('<span class="mtg-role">reviewer</span>');
    return '<div class="mtg-head">' +
      '<div class="mtg-head-when">' + icon('calendar-days', { size: 'sm' }) + ' ' +
        esc(dowName(c.defaultDay) + 's · ' + fmtRange(c.defaultTime, c.defaultDuration)) +
        (c.defaultLocation ? ' · ' + esc(c.defaultLocation) : '') + '</div>' +
      '<div class="mtg-head-right">' +
        (coord ? '<span class="mtg-coord" title="' + esc(others.length ? 'Also: ' + others.map(u => memberName(u)).join(', ') : 'Meeting coordinator') + '">' +
          avatar(coord) + '<span><small>Meeting coordinator</small><b>' + esc(memberName(coord)) + '</b></span></span>' : '') +
        roleChips.join('') +
      '</div>' +
    '</div>';
  }

  function badgeCounts() {
    const sw = mySwaps();
    const chores = myChoresThisWeek().filter(c => !c.done).length;
    const nm = nextMeeting();
    let slides = 0;
    if (nm && kindOf(nm) === 'standard' && submittersFor(nm).some(u => u.uid === me()) && !updatesOf(nm).submissions[me()]) slides = 1;
    // V3.938 — a host of yours offered a one-on-one time and you have none with them
    const oneonone = window.MEETINGS_ONE_ON_ONE ? MEETINGS_ONE_ON_ONE.badge() : 0;
    return { schedule: sw.incoming.length, chores, oneonone, mine: sw.incoming.length + chores + slides + oneonone };
  }

  function renderTabs() {
    const badges = badgeCounts();
    return '<nav class="mtg-tabs" role="tablist">' + SECTIONS.map(s => {
      if (s.id === 'settings' && !isCoordinator()) {
        // members still get a read-only summary, but it lives at the end and unbadged
      }
      const n = badges[s.id] || 0;
      return '<button type="button" role="tab" class="mtg-tab' + (state.section === s.id ? ' mtg-tab-on' : '') + '" data-act="tab" data-id="' + s.id + '">' +
        icon(s.icon, { size: 'sm' }) + '<span>' + esc(s.label) + '</span>' + (n ? '<i class="mtg-badge">' + n + '</i>' : '') + '</button>';
    }).join('') + '</nav>';
  }

  function kindBadge(m) {
    const k = kindOf(m);
    if (k === 'standard') return '';
    return '<span class="mtg-kind mtg-kind-' + k + '">' + esc(KIND_LABEL[k]) + '</span>';
  }
  function statusBadge(m) {
    if (m.status === 'cancelled') return '<span class="mtg-status mtg-status-cancelled">cancelled</span>';
    if (m.status === 'completed') return '<span class="mtg-status mtg-status-done">completed</span>';
    if (minutesOf(m).startedAt && !minutesOf(m).endedAt) return '<span class="mtg-status mtg-status-live">live</span>';
    return '';
  }
  function busyAttr(key) { return state.busy[key] ? ' disabled aria-busy="true"' : ''; }

  /* ─── Next meeting ──────────────────────────────────────────── */
  function renderNext() {
    const m = nextMeeting();
    if (!state.loaded.list) return '<div class="mtg-empty">Loading…</div>';
    if (!m) {
      return '<div class="mtg-card mtg-empty-card">' + icon('calendar-days', { size: 'lg' }) +
        '<h3>No upcoming meeting</h3><p>' + (isCoordinator()
          ? 'Generate the semester from Settings, or add one meeting from the Schedule tab.'
          : 'The coordinator hasn’t scheduled the next one yet.') + '</p></div>';
    }
    const days = daysUntil(m.date);
    const when = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days < 0 ? fmtDate(m.date) : 'In ' + days + ' days';
    const canRun = days <= 0 || isCoordinator();
    const live = minutesOf(m).startedAt && !minutesOf(m).endedAt;
    return '' +
      '<section class="mtg-card mtg-hero">' +
        '<div class="mtg-hero-main">' +
          '<div class="mtg-hero-when">' + esc(when) + ' ' + kindBadge(m) + ' ' + statusBadge(m) + '</div>' +
          '<h2 class="mtg-hero-date">' + esc(fmtDateLong(m.date)) + '</h2>' +
          '<div class="mtg-hero-meta">' + icon('clock', { size: 'sm' }) + ' ' + esc(fmtRange(m.time, m.duration)) +
            (m.location ? ' &nbsp;·&nbsp; ' + icon('flag', { size: 'sm' }) + ' ' + esc(m.location) : '') + '</div>' +
        '</div>' +
        '<div class="mtg-hero-actions">' +
          (canRun ? '<button type="button" class="mtg-btn mtg-btn-primary" data-act="run" data-id="' + m.id + '">' + icon('play', { size: 'sm' }) + ' ' + (live ? 'Rejoin meeting' : 'Run meeting') + '</button>' : '') +
          (isCoordinator() ? '<button type="button" class="mtg-btn" data-act="edit-meeting" data-id="' + m.id + '">' + icon('pencil-square', { size: 'sm' }) + ' Edit</button>' : '') +
        '</div>' +
      '</section>' +
      renderPresentersBlock(m) +
      (kindOf(m) === 'standard' ? renderPipelineBlock(m) : '') +
      renderAgendaBlock(m, false) +
      renderCarryOver(m) +
      renderActionItemsBlock(m) +
      (days <= 0 ? renderReactions(m) : '');
  }

  function renderPresentersBlock(m) {
    const pres = presentersOf(m);
    const k = kindOf(m);
    let body;
    if (k === 'flash') {
      body = '<p class="mtg-muted">Everyone gives a flash talk this week — no single presenter, no round-robin submissions.</p>';
    } else if (!pres.length) {
      body = '<p class="mtg-muted">No presenter assigned yet.' +
        (isCoordinator() ? ' Assign one on the <a href="#" data-act="tab" data-id="schedule">Schedule</a> tab.' : ' Ask the coordinator, or claim an empty slot on the Schedule tab.') + '</p>';
    } else {
      body = pres.map(p => renderPresenterCard(m, p)).join('');
    }
    return '<section class="mtg-card"><h3 class="mtg-h3">' + icon('presentation-chart-bar', { size: 'sm' }) + ' Presenter' + (pres.length > 1 ? 's' : '') + '</h3>' + body + '</section>';
  }

  function renderPresenterCard(m, p) {
    const mine = p.uid === me();
    const canEdit = mine || isCoordinator();
    const link = p.link;
    return '<div class="mtg-presenter' + (mine ? ' mtg-presenter-me' : '') + '">' +
      '<div class="mtg-presenter-who">' + avatar(p.uid, p.name) +
        '<div><b>' + esc(memberName(p.uid, p.name)) + (mine ? ' <span class="mtg-you">you</span>' : '') + '</b>' +
        '<div class="mtg-presenter-title">' + (p.title ? esc(p.title) : '<span class="mtg-muted">No title yet</span>') + '</div></div>' +
        (canEdit ? '<button type="button" class="mtg-btn mtg-btn-sm" data-act="edit-presentation" data-id="' + m.id + '" data-uid="' + esc(p.uid) + '">' + icon('pencil-square', { size: 'sm' }) + ' Edit</button>' : '') +
      '</div>' +
      (p.abstract ? '<p class="mtg-abstract">' + esc(p.abstract) + '</p>' : '') +
      '<div class="mtg-presenter-link">' +
        (link ? (window.DRIVE_LINK ? DRIVE_LINK.card(link) : '<a href="' + esc(link.url) + '" target="_blank" rel="noopener">' + esc(link.name || link.url) + '</a>')
              : (mine ? '<button type="button" class="mtg-btn mtg-btn-sm mtg-btn-primary" data-act="edit-presentation" data-id="' + m.id + '" data-uid="' + esc(p.uid) + '">' + icon('link', { size: 'sm' }) + ' Add your slides link</button>'
                      : '<span class="mtg-muted">' + icon('link', { size: 'sm' }) + ' No slides link yet</span>')) +
      '</div>' +
    '</div>';
  }

  /* round-robin slides → presenter's combined deck → PI review */
  function renderPipelineBlock(m) {
    const u = updatesOf(m);
    const people = submittersFor(m);
    const done = people.filter(p => u.submissions[p.uid]);
    const pres = presentersOf(m);
    const iAmPresenter = isPresenter(m);
    const iOwe = people.some(p => p.uid === me());
    const due = submitDue(m);
    const dueLabel = daysUntil(due) < 0 ? 'was due ' + fmtDate(due) : 'due ' + fmtDate(due);
    const mySub = u.submissions[me()];
    const canPostDeck = iAmPresenter || isCoordinator();
    const canReview = isReviewer();
    const rv = u.review;
    const rvChip = !u.deck ? '<span class="mtg-chip mtg-chip-muted">' + icon('eye', { size: 'sm' }) + ' Waiting for the deck</span>'
      : rv.status === 'approved' ? '<span class="mtg-chip mtg-chip-ok">' + icon('check-circle', { size: 'sm' }) + ' Approved by ' + esc(rv.byName || 'PI') + '</span>'
      : rv.status === 'changes'  ? '<span class="mtg-chip mtg-chip-bad">' + icon('pencil-square', { size: 'sm' }) + ' Changes requested' + (rv.comment ? ': ' + esc(rv.comment) : '') + '</span>'
      : '<span class="mtg-chip mtg-chip-warn">' + icon('clock', { size: 'sm' }) + ' Awaiting PI review (by ' + esc(fmtDate(reviewDue(m))) + ')</span>';
    return '<section class="mtg-card">' +
      '<h3 class="mtg-h3">' + icon('queue-list', { size: 'sm' }) + ' Round-robin slides <span class="mtg-h3-sub">1–2 slides each · ' + esc(dueLabel) + ' · <b>' + done.length + ' / ' + people.length + '</b> in</span></h3>' +
      '<div class="mtg-subgrid">' + people.map(p => {
        const s = u.submissions[p.uid];
        const isMe = p.uid === me();
        return '<div class="mtg-subcell' + (s ? ' mtg-subcell-in' : '') + (isMe ? ' mtg-subcell-me' : '') + '" title="' + esc(s ? 'Submitted ' + new Date(s.submittedAt).toLocaleString() : 'Not yet') + '">' +
          icon(s ? 'check-circle' : 'clock', { size: 'sm' }) + ' ' + esc(firstName(p.uid)) +
          (s && s.link && (canPostDeck || isMe) ? ' <a href="' + esc(DRIVE_LINK.viewUrl(s.link)) + '" target="_blank" rel="noopener" title="Open">' + icon('arrow-top-right-on-square', { size: 'xs' }) + '</a>' : '') +
        '</div>';
      }).join('') + '</div>' +
      (iOwe ? '<div class="mtg-row-actions">' +
          (mySub ? '<span class="mtg-muted">' + icon('check-circle', { size: 'sm' }) + ' Yours is in.</span> <button type="button" class="mtg-btn mtg-btn-sm" data-act="submit-slides" data-id="' + m.id + '">Replace link</button> <button type="button" class="mtg-btn mtg-btn-sm mtg-btn-ghost" data-act="remove-submission" data-id="' + m.id + '">Remove</button>'
                 : '<button type="button" class="mtg-btn mtg-btn-primary mtg-btn-sm" data-act="submit-slides" data-id="' + m.id + '">' + icon('link', { size: 'sm' }) + ' Add my slides link</button>' +
                   ' <span class="mtg-muted">Send ' + (pres.length ? firstName(pres[0].uid) : 'the presenter') + ' 1–2 slides for the combined deck.</span>') +
        '</div>' : '') +
      '<div class="mtg-pipeline">' +
        '<div class="mtg-pipe-step"><div class="mtg-pipe-label">Combined deck' + (pres.length ? ' <small>by ' + esc(pres.map(p => firstName(p.uid, p.name)).join(' & ')) + '</small>' : '') + '</div>' +
          (u.deck ? DRIVE_LINK.card(u.deck, { compact: true }) + (u.deckByName ? '<div class="mtg-muted mtg-tiny">Posted by ' + esc(u.deckByName) + (u.deckAt ? ' · ' + new Date(u.deckAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '') + '</div>' : '')
                  : '<div class="mtg-muted">' + (canPostDeck ? 'Concatenate everyone’s slides, then post the link here.' : 'Not posted yet.') + '</div>') +
          (canPostDeck ? '<button type="button" class="mtg-btn mtg-btn-sm' + (u.deck ? '' : ' mtg-btn-primary') + '" data-act="post-deck" data-id="' + m.id + '">' + icon('link', { size: 'sm' }) + ' ' + (u.deck ? 'Replace deck link' : 'Post the combined deck') + '</button>' : '') +
        '</div>' +
        '<div class="mtg-pipe-step"><div class="mtg-pipe-label">PI review <small>the day before</small></div>' + rvChip +
          (canReview && u.deck ? '<div class="mtg-row-actions"><button type="button" class="mtg-btn mtg-btn-sm mtg-btn-primary" data-act="review-deck" data-id="' + m.id + '" data-status="approved">' + icon('check', { size: 'sm' }) + ' Approve</button> <button type="button" class="mtg-btn mtg-btn-sm" data-act="review-deck" data-id="' + m.id + '" data-status="changes">' + icon('pencil-square', { size: 'sm' }) + ' Request changes</button></div>' : '') +
        '</div>' +
      '</div>' +
    '</section>';
  }

  /* agenda — read view on Next meeting (+ coordinator editing); the live
   * view renders its own timed/checkable version */
  function renderAgendaBlock(m, compact) {
    const items = agendaTimed(m);
    const total = agendaTotal(items);
    const over = m.duration && total > m.duration;
    const mins = minutesOf(m);
    const editing = isCoordinator();
    const rows = items.map((it, i) => {
      const done = !!(mins.items[it.id] && mins.items[it.id].done) || it.done;
      const topic = it.topicId ? state.topics.find(t => t.id === it.topicId) : null;
      const presLine = it.type === 'presentation' && kindOf(m) === 'standard' ? '<div class="mtg-ag-sub">' + esc(presenterNames(m)) + '</div>' : '';
      return '<li class="mtg-ag' + (done ? ' mtg-ag-done' : '') + '" data-id="' + esc(it.id) + '">' +
        '<span class="mtg-ag-time">' + esc(fmtTime(it.start)) + '</span>' +
        '<span class="mtg-ag-body"><span class="mtg-ag-text">' + esc(it.text) + '</span>' +
          (topic ? ' <span class="mtg-chip mtg-chip-muted" title="Suggested by ' + esc(topic.suggestedByName || '') + '">' + icon('light-bulb', { size: 'xs' }) + ' topic</span>' : '') +
          presLine + '</span>' +
        '<span class="mtg-ag-mins">' + it.minutes + ' min</span>' +
        (editing && !compact ? '<span class="mtg-ag-tools">' +
          '<button type="button" class="mtg-iconbtn" data-act="ag-up" data-id="' + m.id + '" data-item="' + esc(it.id) + '" title="Move up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button type="button" class="mtg-iconbtn" data-act="ag-down" data-id="' + m.id + '" data-item="' + esc(it.id) + '" title="Move down"' + (i === items.length - 1 ? ' disabled' : '') + '>↓</button>' +
          '<button type="button" class="mtg-iconbtn mtg-danger" data-act="ag-remove" data-id="' + m.id + '" data-item="' + esc(it.id) + '" title="Remove">' + icon('x-mark', { size: 'xs' }) + '</button>' +
        '</span>' : '') +
      '</li>';
    }).join('');
    const addRow = editing && state.ui.agendaAdd === m.id
      ? '<form class="mtg-inline-form" data-form="agenda-add" data-id="' + m.id + '">' +
          '<input type="text" name="text" id="mtg-ag-new-text" placeholder="Agenda item" required maxlength="140">' +
          '<input type="number" name="minutes" value="5" min="1" max="120" aria-label="Minutes"><span class="mtg-muted">min</span>' +
          '<select name="type" aria-label="Type">' + AGENDA_TYPES.map(t => '<option value="' + t + '"' + (t === 'discussion' ? ' selected' : '') + '>' + esc(AGENDA_TYPE_LABEL[t]) + '</option>').join('') + '</select>' +
          '<button type="submit" class="mtg-btn mtg-btn-sm mtg-btn-primary">Add</button>' +
          '<button type="button" class="mtg-btn mtg-btn-sm mtg-btn-ghost" data-act="ag-add-cancel">Cancel</button>' +
        '</form>'
      : '';
    return '<section class="mtg-card">' +
      '<h3 class="mtg-h3">' + icon('clipboard-document-list', { size: 'sm' }) + ' Agenda <span class="mtg-h3-sub' + (over ? ' mtg-over' : '') + '">' + total + ' of ' + (m.duration || cfg().defaultDuration) + ' min' + (over ? ' — over' : '') + '</span></h3>' +
      (items.length ? '<ol class="mtg-agenda">' + rows + '</ol>'
                    : '<p class="mtg-muted">No agenda yet.' + (editing ? ' <button type="button" class="mtg-btn mtg-btn-sm" data-act="ag-template" data-id="' + m.id + '">Apply the ' + esc(kindOf(m)) + ' template</button>' : '') + '</p>') +
      (editing && !compact ? '<div class="mtg-row-actions">' + addRow +
        (state.ui.agendaAdd === m.id ? '' : '<button type="button" class="mtg-btn mtg-btn-sm" data-act="ag-add" data-id="' + m.id + '">' + icon('plus', { size: 'sm' }) + ' Add item</button>' +
          (items.length ? ' <button type="button" class="mtg-btn mtg-btn-sm mtg-btn-ghost" data-act="ag-template" data-id="' + m.id + '" title="Replace with the template">' + icon('arrow-path', { size: 'sm' }) + ' Reset to template</button>' : '')) +
        '</div>' : '') +
    '</section>';
  }

  function renderCarryOver(m) {
    const prev = previousMeeting(m);
    if (!prev) return '';
    const open = actionItemsOf(prev).filter(a => a.status !== 'done');
    const mins = minutesOf(prev);
    const undone = agendaOf(prev).filter(it => !((mins.items[it.id] && mins.items[it.id].done) || it.done) && !['business', 'updates', 'qa', 'assignments', 'presentation'].includes(it.type));
    if (!open.length && !undone.length) return '';
    return '<section class="mtg-card mtg-card-soft"><h3 class="mtg-h3">' + icon('arrow-path', { size: 'sm' }) + ' Carried over from ' + esc(fmtDate(prev.date)) + '</h3>' +
      (undone.length ? '<div class="mtg-muted mtg-tiny">Agenda items not reached:</div><ul class="mtg-plain">' + undone.map(it => '<li>' + esc(it.text) +
        (isCoordinator() ? ' <button type="button" class="mtg-btn mtg-btn-xs" data-act="ag-carry" data-id="' + m.id + '" data-from="' + prev.id + '" data-item="' + esc(it.id) + '">Add to this agenda</button>' : '') + '</li>').join('') + '</ul>' : '') +
      (open.length ? '<div class="mtg-muted mtg-tiny">Open action items:</div><ul class="mtg-plain">' + open.map(a => '<li>' + esc(a.text) + (a.assigneeUid ? ' <span class="mtg-muted">— ' + esc(firstName(a.assigneeUid, a.assigneeName)) + '</span>' : '') + (a.deadline ? ' <span class="mtg-muted">· ' + esc(fmtDateShort(a.deadline)) + '</span>' : '') + '</li>').join('') + '</ul>' : '') +
    '</section>';
  }

  function renderActionItemsBlock(m) {
    const items = actionItemsOf(m);
    if (!items.length && daysUntil(m.date) > 0) return '';
    return '<section class="mtg-card"><h3 class="mtg-h3">' + icon('check-circle', { size: 'sm' }) + ' Action items</h3>' +
      (items.length ? '<ul class="mtg-actions">' + items.map(a => renderActionItem(m, a)).join('') + '</ul>' : '<p class="mtg-muted">None yet — add them while running the meeting.</p>') +
    '</section>';
  }
  function renderActionItem(m, a) {
    const done = a.status === 'done';
    const canTick = true;   // collaborative: rules let any member write actionItems
    const overdue = !done && a.deadline && a.deadline < todayStr();
    return '<li class="mtg-ai' + (done ? ' mtg-ai-done' : '') + '">' +
      '<label class="mtg-check"><input type="checkbox" data-act="ai-toggle" data-id="' + m.id + '" data-item="' + esc(a.id) + '"' + (done ? ' checked' : '') + (canTick ? '' : ' disabled') + '><span></span></label>' +
      '<span class="mtg-ai-text">' + esc(a.text) + '</span>' +
      (a.assigneeUid ? '<span class="mtg-ai-who">' + avatar(a.assigneeUid, a.assigneeName) + ' ' + esc(firstName(a.assigneeUid, a.assigneeName)) + (a.taskId ? ' <i title="On their My Week">' + icon('calendar-days', { size: 'xs' }) + '</i>' : '') + '</span>' : '') +
      (a.deadline ? '<span class="mtg-ai-due' + (overdue ? ' mtg-over' : '') + '">' + esc(fmtDateShort(a.deadline)) + '</span>' : '') +
      '<button type="button" class="mtg-iconbtn mtg-danger" data-act="ai-remove" data-id="' + m.id + '" data-item="' + esc(a.id) + '" title="Remove">' + icon('x-mark', { size: 'xs' }) + '</button>' +
    '</li>';
  }

  /* Reaction chips. Presenters see the counts but can't react to themselves;
   * everyone else toggles. Used on the Next-meeting card once the day has
   * come, and inside every History card (reactions usually land after). */
  function reactionChips(m) {
    const fb = feedbackOf(m);
    const canReact = !isPresenter(m);
    return '<div class="mtg-reactions">' + REACTIONS.map(r => {
      const n = fb.filter(f => f.type === r.type).length;
      const mine = fb.some(f => f.type === r.type && f.uid === me());
      if (!canReact) return n ? '<span class="mtg-react mtg-react-static">' + icon(r.icon, { size: 'sm' }) + ' ' + esc(r.label) + ' <b>' + n + '</b></span>' : '';
      return '<button type="button" class="mtg-react' + (mine ? ' mtg-react-on' : '') + '" data-act="react" data-id="' + m.id + '" data-type="' + r.type + '">' + icon(r.icon, { size: 'sm' }) + ' ' + esc(r.label) + (n ? ' <b>' + n + '</b>' : '') + '</button>';
    }).join('') + '</div>';
  }
  function renderReactions(m) {
    if (!presentersOf(m).length) return '';
    return '<section class="mtg-card"><h3 class="mtg-h3">' + icon('hand-raised', { size: 'sm' }) + ' Reactions <span class="mtg-h3-sub">for the presenter' + (presentersOf(m).length > 1 ? 's' : '') + '</span></h3>' + reactionChips(m) + '</section>';
  }
  function renderReactionsInline(m) {
    if (!presentersOf(m).length) return '';
    if (isPresenter(m) && !feedbackOf(m).length) return '';
    return '<div class="mtg-hist-sec"><h4>Reactions</h4>' + reactionChips(m) + '</div>';
  }

  /* ─── Schedule ──────────────────────────────────────────────── */
  function renderSchedule() {
    if (!state.loaded.list) return '<div class="mtg-empty">Loading…</div>';
    const t = todayStr();
    const all = state.ui.schedFilter === 'all' ? state.meetings : state.meetings.filter(m => m.date >= t);
    const sw = mySwaps();
    const coord = isCoordinator();
    const pending = state.swaps.filter(s => s.status === 'pending');
    const acceptedUnexecuted = state.swaps.filter(s => s.status === 'accepted' && !s.executedAt);
    return '' +
      renderSwapBanners(sw) +
      (coord && acceptedUnexecuted.length ? '<div class="mtg-banner mtg-banner-warn">' + icon('exclamation-triangle', { size: 'sm' }) + ' ' + acceptedUnexecuted.length + ' accepted swap' + (acceptedUnexecuted.length === 1 ? '' : 's') + ' not applied yet. ' +
          acceptedUnexecuted.map(s => '<button type="button" class="mtg-btn mtg-btn-xs" data-act="swap-execute" data-id="' + s.id + '">Apply ' + esc(firstName(s.fromUid, s.fromName)) + ' ↔ ' + esc(firstName(s.toUid, s.toName)) + '</button>').join(' ') + '</div>' : '') +
      '<div class="mtg-toolbar">' +
        '<div class="mtg-seg"><button type="button" class="' + (state.ui.schedFilter === 'upcoming' ? 'on' : '') + '" data-act="sched-filter" data-id="upcoming">Upcoming</button><button type="button" class="' + (state.ui.schedFilter === 'all' ? 'on' : '') + '" data-act="sched-filter" data-id="all">Whole semester</button></div>' +
        '<div class="mtg-toolbar-right">' +
          (pending.length && !coord ? '<span class="mtg-muted">' + pending.length + ' swap request' + (pending.length === 1 ? '' : 's') + ' pending</span>' : '') +
          (coord ? '<button type="button" class="mtg-btn mtg-btn-sm" data-act="new-meeting">' + icon('plus', { size: 'sm' }) + ' Meeting</button>' : '') +
        '</div>' +
      '</div>' +
      (all.length ? '<div class="mtg-board' + (coord ? ' mtg-board-edit' : '') + '">' + all.map(m => renderBoardRow(m, coord)).join('') + '</div>'
                  : '<div class="mtg-empty">Nothing scheduled' + (coord ? ' — use “Seed Fall 2026” or “Generate meetings” in Settings.' : ' yet.') + '</div>') +
      (coord ? '<aside class="mtg-pool"><div class="mtg-pool-title">' + icon('users', { size: 'sm' }) + ' Lab members <span class="mtg-muted mtg-tiny">drag onto a slot · or tap a slot</span></div><div class="mtg-pool-cards">' +
          presenterPool().map(u => '<div class="mtg-pcard mtg-pcard-pool" draggable="true" data-uid="' + esc(u.uid) + '" data-from="pool">' + avatar(u.uid) + ' ' + esc(u.name || u.email) + '</div>').join('') +
          (presenterPool().length ? '' : '<span class="mtg-muted mtg-tiny">Nobody in the presenter pool — set it in Settings → Roster.</span>') + '</div></aside>' : '') +
      '<p class="mtg-muted mtg-tiny mtg-legend">' + (coord ? 'Drag a presenter onto another presenter to swap them. Drag to the pool to unassign.' : 'Claim an empty slot directly. To take someone’s slot, request a swap — they accept, and both dates switch.') + '</p>';
  }

  function renderSwapBanners(sw) {
    let out = '';
    sw.incoming.forEach(s => {
      out += '<div class="mtg-banner mtg-banner-swap">' + avatar(s.fromUid, s.fromName) +
        '<div><b>' + esc(memberName(s.fromUid, s.fromName)) + '</b> wants to swap presentation slots: you’d present <b>' + esc(fmtDate(s.fromDate)) + '</b> instead of ' + esc(fmtDate(s.toDate)) + '.' +
        (s.message ? '<div class="mtg-muted">“' + esc(s.message) + '”</div>' : '') + '</div>' +
        '<div class="mtg-banner-actions"><button type="button" class="mtg-btn mtg-btn-sm mtg-btn-primary" data-act="swap-respond" data-id="' + s.id + '" data-status="accepted">Accept</button> <button type="button" class="mtg-btn mtg-btn-sm" data-act="swap-respond" data-id="' + s.id + '" data-status="declined">Decline</button></div></div>';
    });
    sw.outgoing.forEach(s => {
      out += '<div class="mtg-banner mtg-banner-muted">' + icon('arrows-right-left', { size: 'sm' }) + ' Waiting on <b>' + esc(firstName(s.toUid, s.toName)) + '</b> to accept your swap (' + esc(fmtDate(s.fromDate)) + ' ↔ ' + esc(fmtDate(s.toDate)) + '). <button type="button" class="mtg-btn mtg-btn-xs" data-act="swap-respond" data-id="' + s.id + '" data-status="cancelled">Cancel request</button></div>';
    });
    return out;
  }

  function renderBoardRow(m, coord) {
    const pres = presentersOf(m);
    const slots = [];
    const isPast = m.date < todayStr();
    const k = kindOf(m);
    const n = k === 'standard' ? cfg().slotsPerMeeting : 0;
    for (let i = 0; i < n; i++) {
      const p = pres.find(x => x.slot === i) || (i === 0 && pres.length && !pres.some(x => x.slot != null) ? pres[0] : null);
      slots.push(renderSlot(m, i, p, coord, isPast));
    }
    // presenters beyond slotsPerMeeting (legacy data) still show
    pres.filter(p => p.slot >= n && n > 0).forEach(p => slots.push(renderSlot(m, p.slot, p, coord, isPast)));
    const rowCls = 'mtg-brow' + (m.status === 'cancelled' ? ' mtg-brow-cancelled' : '') + (isPast ? ' mtg-brow-past' : '') + (k !== 'standard' ? ' mtg-brow-' + k : '');
    return '<div class="' + rowCls + '" data-mid="' + m.id + '">' +
      '<div class="mtg-brow-date"><b>' + esc(fmtDate(m.date)) + '</b><small>' + esc(fmtTime(m.time)) + (m.location && m.location !== cfg().defaultLocation ? ' · ' + esc(m.location) : '') + '</small>' + kindBadge(m) + statusBadge(m) + '</div>' +
      '<div class="mtg-brow-slots">' + (k === 'flash' ? '<span class="mtg-slot mtg-slot-flash">' + icon('bolt', { size: 'sm' }) + ' Everyone — flash talks</span>' : k === 'break' ? '<span class="mtg-slot mtg-slot-break">No meeting</span>' : slots.join('')) + '</div>' +
      (coord ? '<div class="mtg-brow-tools">' +
        '<button type="button" class="mtg-iconbtn" data-act="edit-meeting" data-id="' + m.id + '" title="Edit date / time / room / kind">' + icon('pencil-square', { size: 'sm' }) + '</button>' +
        (m.status !== 'cancelled' && !isPast ? '<button type="button" class="mtg-iconbtn" data-act="postpone" data-id="' + m.id + '" title="Postpone">' + icon('calendar-days', { size: 'sm' }) + '</button>' : '') +
        '<button type="button" class="mtg-iconbtn mtg-danger" data-act="delete-meeting" data-id="' + m.id + '" title="Delete">' + icon('trash', { size: 'sm' }) + '</button>' +
      '</div>' : '') +
    '</div>';
  }

  function renderSlot(m, slot, p, coord, isPast) {
    const dropAttrs = coord && !isPast ? ' data-drop-mid="' + m.id + '" data-drop-slot="' + slot + '"' : '';
    if (!p) {
      const canClaim = !isPast && m.status !== 'cancelled' && (coord || (!isPresenter(m) && canPresent(me())));
      return '<div class="mtg-slot mtg-slot-empty"' + dropAttrs + '>' +
        (canClaim ? '<button type="button" class="mtg-btn mtg-btn-xs mtg-btn-ghost" data-act="' + (coord ? 'pick-presenter' : 'claim') + '" data-id="' + m.id + '" data-slot="' + slot + '">' + icon('plus', { size: 'xs' }) + ' ' + (coord ? 'Assign' : 'Claim') + (slot > 0 ? ' (optional)' : '') + '</button>'
                  : '<span class="mtg-muted">' + (slot > 0 ? 'optional' : 'open') + '</span>') +
      '</div>';
    }
    const mine = p.uid === me();
    const hasLink = !!p.link;
    const tools = [];
    if (!isPast && m.status !== 'cancelled') {
      if (mine || coord) tools.push('<button type="button" class="mtg-btn mtg-btn-xs" data-act="edit-presentation" data-id="' + m.id + '" data-uid="' + esc(p.uid) + '">' + icon(hasLink ? 'pencil-square' : 'link', { size: 'xs' }) + ' ' + (hasLink ? 'Slides' : 'Add slides') + '</button>');
      if (mine && !coord) tools.push('<button type="button" class="mtg-btn mtg-btn-xs mtg-btn-ghost" data-act="release" data-id="' + m.id + '" data-uid="' + esc(p.uid) + '">Release</button>');
      if (!mine && !coord) tools.push('<button type="button" class="mtg-btn mtg-btn-xs mtg-btn-ghost" data-act="request-swap" data-id="' + m.id + '" data-uid="' + esc(p.uid) + '">' + icon('arrows-right-left', { size: 'xs' }) + ' Swap</button>');
      if (coord) tools.push('<button type="button" class="mtg-iconbtn" data-act="unassign" data-id="' + m.id + '" data-uid="' + esc(p.uid) + '" title="Unassign">' + icon('x-mark', { size: 'xs' }) + '</button>');
    }
    return '<div class="mtg-slot mtg-slot-filled' + (mine ? ' mtg-slot-me' : '') + '"' + dropAttrs + '>' +
      '<div class="mtg-pcard' + (coord && !isPast ? ' mtg-pcard-drag' : '') + '"' + (coord && !isPast ? ' draggable="true"' : '') + ' data-uid="' + esc(p.uid) + '" data-from="' + m.id + '" data-slot="' + slot + '">' +
        avatar(p.uid, p.name) + '<span class="mtg-pcard-name">' + esc(memberName(p.uid, p.name)) + (mine ? ' <span class="mtg-you">you</span>' : '') + '</span>' +
        '<span class="mtg-pcard-state" title="' + (hasLink ? 'Slides link added' : 'No slides link yet') + '">' + icon(hasLink ? 'check-circle' : 'link', { size: 'xs' }) + '</span>' +
      '</div>' +
      (tools.length ? '<div class="mtg-slot-tools">' + tools.join('') + '</div>' : '') +
    '</div>';
  }

  /* ─── Topics ────────────────────────────────────────────────── */
  function renderTopics() {
    const open = state.topics.filter(t => t.status === 'open')
      .sort((a, b) => ((b.votes || []).length - (a.votes || []).length) || String(b.createdAt && b.createdAt.seconds || '').localeCompare(String(a.createdAt && a.createdAt.seconds || '')));
    const closed = state.topics.filter(t => t.status !== 'open');
    const coord = isCoordinator();
    const card = t => {
      const votes = t.votes || [];
      const mine = votes.includes(me());
      const own = t.suggestedBy === me();
      const sched = t.meetingId ? meeting(t.meetingId) : null;
      return '<div class="mtg-topic' + (t.status !== 'open' ? ' mtg-topic-closed' : '') + '">' +
        '<button type="button" class="mtg-vote' + (mine ? ' mtg-vote-on' : '') + '" data-act="vote" data-id="' + t.id + '" title="' + (mine ? 'Remove my vote' : 'Upvote') + '"' + (t.status !== 'open' ? ' disabled' : '') + '>▲<b>' + votes.length + '</b></button>' +
        '<div class="mtg-topic-body"><div class="mtg-topic-text">' + esc(t.text) + '</div>' +
          (t.details ? '<div class="mtg-topic-details">' + esc(t.details) + '</div>' : '') +
          '<div class="mtg-muted mtg-tiny">' + esc(t.suggestedByName || memberName(t.suggestedBy)) +
            (t.status === 'scheduled' && sched ? ' · scheduled for ' + esc(fmtDate(sched.date)) : t.status === 'done' ? ' · discussed' : t.status === 'dismissed' ? ' · dismissed' : '') + '</div>' +
        '</div>' +
        '<div class="mtg-topic-tools">' +
          (coord && t.status === 'open' ? '<button type="button" class="mtg-btn mtg-btn-xs mtg-btn-primary" data-act="topic-schedule" data-id="' + t.id + '">' + icon('calendar-days', { size: 'xs' }) + ' Schedule into…</button>' : '') +
          (coord && t.status === 'open' ? '<button type="button" class="mtg-btn mtg-btn-xs mtg-btn-ghost" data-act="topic-dismiss" data-id="' + t.id + '">Dismiss</button>' : '') +
          (coord && t.status !== 'open' ? '<button type="button" class="mtg-btn mtg-btn-xs mtg-btn-ghost" data-act="topic-reopen" data-id="' + t.id + '">Reopen</button>' : '') +
          (own && t.status === 'open' ? '<button type="button" class="mtg-btn mtg-btn-xs mtg-btn-ghost" data-act="topic-edit" data-id="' + t.id + '">Edit</button>' : '') +
          ((own || coord) && t.status !== 'scheduled' ? '<button type="button" class="mtg-iconbtn mtg-danger" data-act="topic-delete" data-id="' + t.id + '" title="Delete">' + icon('trash', { size: 'xs' }) + '</button>' : '') +
        '</div>' +
      '</div>';
    };
    return '<section class="mtg-card"><h3 class="mtg-h3">' + icon('light-bulb', { size: 'sm' }) + ' Suggest a topic <span class="mtg-h3-sub">anything the lab should talk through — vote for the ones you want</span></h3>' +
        '<form class="mtg-inline-form mtg-inline-form-wrap" data-form="topic-add">' +
          '<input type="text" name="text" id="mtg-topic-text" placeholder="e.g. How do we archive raw microscopy data?" required maxlength="160">' +
          '<input type="text" name="details" id="mtg-topic-details" placeholder="Optional detail" maxlength="400">' +
          '<button type="submit" class="mtg-btn mtg-btn-sm mtg-btn-primary">' + icon('plus', { size: 'sm' }) + ' Suggest</button>' +
        '</form></section>' +
      '<section class="mtg-card"><h3 class="mtg-h3">Open topics <span class="mtg-h3-sub">' + open.length + '</span></h3>' +
        (open.length ? open.map(card).join('') : '<p class="mtg-muted">Nothing suggested yet.</p>') + '</section>' +
      (closed.length ? '<details class="mtg-card mtg-details"' + (state.ui.topicsShowClosed ? ' open' : '') + '><summary data-act="topics-toggle">Scheduled, discussed &amp; dismissed (' + closed.length + ')</summary>' + closed.map(card).join('') + '</details>' : '');
  }

  /* ─── History ───────────────────────────────────────────────── */
  function renderHistory() {
    const t = todayStr();
    let list = state.meetings.filter(m => !isBreak(m) && (m.status === 'completed' || (m.date < t && m.status !== 'cancelled'))).slice().reverse();
    const q = state.ui.histSearch.trim().toLowerCase();
    if (state.ui.histPresenter) list = list.filter(m => presentersOf(m).some(p => p.uid === state.ui.histPresenter));
    if (q) list = list.filter(m => {
      const hay = [m.date, presenterNames(m), ...presentersOf(m).map(p => (p.title || '') + ' ' + (p.abstract || '')), minutesOf(m).text,
        ...agendaOf(m).map(a => a.text), ...Object.values(minutesOf(m).items).map(x => x.notes || ''), ...actionItemsOf(m).map(a => a.text), m.notes || ''].join(' ').toLowerCase();
      return hay.includes(q);
    });
    const presenterOpts = Array.from(new Set(state.meetings.flatMap(m => presentersOf(m).map(p => p.uid))))
      .map(uid => ({ uid, name: memberName(uid) })).sort((a, b) => a.name.localeCompare(b.name));
    return '<div class="mtg-toolbar">' +
        '<input type="search" id="mtg-hist-search" class="mtg-input" placeholder="Search titles, minutes, action items…" value="' + esc(state.ui.histSearch) + '" data-input="hist-search">' +
        '<select class="mtg-input" data-change="hist-presenter"><option value="">All presenters</option>' + presenterOpts.map(o => '<option value="' + esc(o.uid) + '"' + (o.uid === state.ui.histPresenter ? ' selected' : '') + '>' + esc(o.name) + '</option>').join('') + '</select>' +
      '</div>' +
      (list.length ? list.map(renderHistoryCard).join('') : '<div class="mtg-empty">No past meetings' + (q || state.ui.histPresenter ? ' match.' : ' yet.') + '</div>');
  }

  function renderHistoryCard(m) {
    const open = state.ui.histOpen === m.id;
    const pres = presentersOf(m);
    const u = updatesOf(m);
    const mins = minutesOf(m);
    const head = '<button type="button" class="mtg-hist-head" data-act="hist-toggle" data-id="' + m.id + '" aria-expanded="' + open + '">' +
      '<span class="mtg-hist-date">' + esc(fmtDate(m.date)) + '</span>' +
      '<span class="mtg-hist-who">' + esc(presenterNames(m)) + kindBadge(m) + '</span>' +
      '<span class="mtg-hist-title">' + esc(pres.map(p => p.title).filter(Boolean).join(' · ')) + '</span>' +
      '<span class="mtg-hist-marks">' + (pres.some(p => p.link) || u.deck ? icon('link', { size: 'xs' }) : '') + (mins.text || Object.keys(mins.items).length ? icon('document-text', { size: 'xs' }) : '') + (actionItemsOf(m).length ? '<small>' + actionItemsOf(m).length + '</small>' : '') + '</span>' +
    '</button>';
    if (!open) return '<div class="mtg-card mtg-hist">' + head + '</div>';
    const agenda = agendaTimed(m);
    return '<div class="mtg-card mtg-hist mtg-hist-open">' + head + '<div class="mtg-hist-body">' +
      (pres.length ? '<div class="mtg-hist-sec"><h4>Presentation' + (pres.length > 1 ? 's' : '') + '</h4>' + pres.map(p =>
        '<div class="mtg-hist-pres">' + avatar(p.uid, p.name) + '<div><b>' + esc(memberName(p.uid, p.name)) + '</b>' + (p.title ? ' — ' + esc(p.title) : '') + (p.abstract ? '<p class="mtg-abstract">' + esc(p.abstract) + '</p>' : '') +
          (p.link ? (window.DRIVE_LINK ? DRIVE_LINK.card(p.link, { compact: true }) : '<a href="' + esc(p.link.url) + '" target="_blank" rel="noopener">' + esc(p.link.name || p.link.url) + '</a>') : '<span class="mtg-muted mtg-tiny">No slides link</span>') + '</div></div>').join('') + '</div>' : '') +
      (u.deck ? '<div class="mtg-hist-sec"><h4>Round-robin deck</h4>' + DRIVE_LINK.card(u.deck, { compact: true }) + (u.review.status ? '<div class="mtg-muted mtg-tiny">Review: ' + esc(u.review.status) + (u.review.comment ? ' — ' + esc(u.review.comment) : '') + '</div>' : '') + '</div>' : '') +
      (Object.keys(u.submissions).length ? '<div class="mtg-hist-sec"><h4>Individual slides</h4><div class="mtg-subgrid">' + Object.keys(u.submissions).map(uid => { const s = u.submissions[uid]; return '<a class="mtg-subcell mtg-subcell-in" href="' + esc(DRIVE_LINK.viewUrl(s.link)) + '" target="_blank" rel="noopener">' + icon('link', { size: 'xs' }) + ' ' + esc(firstName(uid, s.name)) + '</a>'; }).join('') + '</div></div>' : '') +
      (agenda.length ? '<div class="mtg-hist-sec"><h4>Agenda &amp; minutes</h4><ol class="mtg-agenda mtg-agenda-hist">' + agenda.map(it => {
          const mi = mins.items[it.id] || {};
          return '<li class="mtg-ag' + (mi.done || it.done ? ' mtg-ag-done' : '') + '"><span class="mtg-ag-time">' + esc(fmtTime(it.start)) + '</span><span class="mtg-ag-body"><span class="mtg-ag-text">' + esc(it.text) + '</span>' + (mi.notes ? '<div class="mtg-ag-notes">' + esc(mi.notes) + '</div>' : '') + '</span><span class="mtg-ag-mins">' + it.minutes + ' min</span></li>';
        }).join('') + '</ol></div>' : '') +
      (mins.text || m.notes ? '<div class="mtg-hist-sec"><h4>General notes</h4><div class="mtg-prose">' + esc(mins.text || m.notes) + '</div></div>' : '') +
      (actionItemsOf(m).length ? '<div class="mtg-hist-sec"><h4>Action items</h4><ul class="mtg-actions">' + actionItemsOf(m).map(a => renderActionItem(m, a)).join('') + '</ul></div>' : '') +
      renderReactionsInline(m) +
      (isCoordinator() && m.status !== 'completed' ? '<div class="mtg-row-actions"><button type="button" class="mtg-btn mtg-btn-sm" data-act="set-status" data-id="' + m.id + '" data-status="completed">Mark completed</button></div>' : '') +
    '</div></div>';
  }

  /* ─── My items ──────────────────────────────────────────────── */
  function renderMine() {
    const uid = me();
    const t = todayStr();
    const myNext = state.meetings.find(m => m.date >= t && m.status !== 'cancelled' && isPresenter(m, uid));
    const nm = nextMeeting();
    const owe = nm && kindOf(nm) === 'standard' && submittersFor(nm).some(u => u.uid === uid) && !updatesOf(nm).submissions[uid];
    const chores = myChoresThisWeek();
    const sw = mySwaps();
    const myActions = [];
    state.meetings.forEach(m => actionItemsOf(m).forEach(a => { if (a.assigneeUid === uid && a.status !== 'done') myActions.push({ m, a }); }));
    myActions.sort((x, y) => (x.a.deadline || '9999').localeCompare(y.a.deadline || '9999'));
    return '' +
      '<section class="mtg-card"><h3 class="mtg-h3">' + icon('presentation-chart-bar', { size: 'sm' }) + ' My next presentation</h3>' +
        (myNext ? (function () { const p = presentersOf(myNext).find(x => x.uid === uid); const d = daysUntil(myNext.date);
            return '<div class="mtg-mine-row"><div><b>' + esc(fmtDateLong(myNext.date)) + '</b> <span class="mtg-muted">' + (d === 0 ? 'today' : d === 1 ? 'tomorrow' : 'in ' + d + ' days') + '</span>' +
              '<div>' + (p.title ? esc(p.title) : '<span class="mtg-muted">No title yet</span>') + '</div>' +
              '<div class="mtg-tiny">' + (p.link ? '<span class="mtg-chip mtg-chip-ok">' + icon('check-circle', { size: 'xs' }) + ' Slides linked</span>' : '<span class="mtg-chip mtg-chip-warn">' + icon('exclamation-triangle', { size: 'xs' }) + ' Slides link missing</span>') + '</div></div>' +
              '<button type="button" class="mtg-btn mtg-btn-sm mtg-btn-primary" data-act="edit-presentation" data-id="' + myNext.id + '" data-uid="' + esc(uid) + '">' + icon('pencil-square', { size: 'sm' }) + ' Edit</button></div>'; })()
          : '<p class="mtg-muted">You’re not scheduled to present. Claim an empty slot on the <a href="#" data-act="tab" data-id="schedule">Schedule</a> tab.</p>') +
      '</section>' +
      (nm && kindOf(nm) === 'standard' && !isPresenter(nm, uid) && submittersFor(nm).some(u => u.uid === uid) ? '<section class="mtg-card"><h3 class="mtg-h3">' + icon('queue-list', { size: 'sm' }) + ' My slides for ' + esc(fmtDate(nm.date)) + '</h3>' +
          (owe ? '<div class="mtg-mine-row"><div>1–2 slides for the round-robin, due <b>' + esc(fmtDate(submitDue(nm))) + '</b>.</div><button type="button" class="mtg-btn mtg-btn-sm mtg-btn-primary" data-act="submit-slides" data-id="' + nm.id + '">' + icon('link', { size: 'sm' }) + ' Add link</button></div>'
               : '<div class="mtg-mine-row"><div><span class="mtg-chip mtg-chip-ok">' + icon('check-circle', { size: 'xs' }) + ' Submitted</span></div><button type="button" class="mtg-btn mtg-btn-sm" data-act="submit-slides" data-id="' + nm.id + '">Replace</button></div>') + '</section>' : '') +
      '<section class="mtg-card"><h3 class="mtg-h3">' + icon('sparkles', { size: 'sm' }) + ' My chores this week</h3>' +
        (chores.length ? '<ul class="mtg-actions">' + chores.map(c => '<li class="mtg-ai' + (c.done ? ' mtg-ai-done' : '') + '"><label class="mtg-check"><input type="checkbox" data-act="chore-tick" data-week="' + esc(c.weekId) + '" data-chore="' + esc(c.choreId) + '" data-uid="' + esc(uid) + '"' + (c.done ? ' checked' : '') + '><span></span></label><span class="mtg-ai-text">' + esc(c.label) + '</span></li>').join('') + '</ul>'
                       : '<p class="mtg-muted">None assigned to you this week.</p>') +
      '</section>' +
      '<section class="mtg-card"><h3 class="mtg-h3">' + icon('check-circle', { size: 'sm' }) + ' My open action items</h3>' +
        (myActions.length ? '<ul class="mtg-actions">' + myActions.map(({ m, a }) => '<li class="mtg-ai"><label class="mtg-check"><input type="checkbox" data-act="ai-toggle" data-id="' + m.id + '" data-item="' + esc(a.id) + '"><span></span></label><span class="mtg-ai-text">' + esc(a.text) + ' <span class="mtg-muted mtg-tiny">from ' + esc(fmtDateShort(m.date)) + '</span></span>' + (a.deadline ? '<span class="mtg-ai-due' + (a.deadline < t ? ' mtg-over' : '') + '">' + esc(fmtDateShort(a.deadline)) + '</span>' : '') + '</li>').join('') + '</ul>'
                          : '<p class="mtg-muted">Nothing open. Items assigned in a meeting also appear at the top of your <a href="/rm/pages/my-week.html">My Week</a>.</p>') +
      '</section>' +
      (window.MEETINGS_ONE_ON_ONE ? MEETINGS_ONE_ON_ONE.renderMine(false) : '') +     // V3.938
      (sw.incoming.length || sw.outgoing.length ? '<section class="mtg-card"><h3 class="mtg-h3">' + icon('arrows-right-left', { size: 'sm' }) + ' Swap requests</h3>' + renderSwapBanners(sw) + '</section>' : '');
  }

  /* ─── Settings ──────────────────────────────────────────────── */
  function renderSettings() {
    const c = cfg();
    const coord = isCoordinator();
    const admin = isAdmin();
    if (!coord) {
      return '<section class="mtg-card"><h3 class="mtg-h3">' + icon('cog-6-tooth', { size: 'sm' }) + ' How lab meetings run</h3>' +
        '<dl class="mtg-dl">' +
          '<dt>When</dt><dd>' + esc(dowName(c.defaultDay) + 's, ' + fmtRange(c.defaultTime, c.defaultDuration)) + '</dd>' +
          '<dt>Where</dt><dd>' + esc(c.defaultLocation || '—') + '</dd>' +
          '<dt>Semester</dt><dd>' + esc(c.semesterStart ? fmtDate(c.semesterStart) + ' → ' + fmtDate(c.semesterEnd) : '—') + '</dd>' +
          '<dt>Coordinator</dt><dd>' + esc(c.coordinatorUids.map(u => memberName(u)).join(', ') || '—') + '</dd>' +
          '<dt>Reviews decks</dt><dd>' + esc(reviewerUids().map(u => memberName(u)).join(', ') || '—') + '</dd>' +
          '<dt>Presenting this semester</dt><dd>' + esc(presenterPool().map(u => firstName(u.uid)).join(', ') || '—') + '</dd>' +
          (c.driveFolderUrl ? '<dt>Lab Drive folder</dt><dd><a href="' + esc(c.driveFolderUrl) + '" target="_blank" rel="noopener">Open folder ' + icon('arrow-top-right-on-square', { size: 'xs' }) + '</a></dd>' : '') +
        '</dl>' +
        '<p class="mtg-muted mtg-tiny">Slides must live in the lab Google Drive (' + esc(c.labDriveEmail) + ') and be shared “Anyone with the link”.</p>' +
      '</section>';
    }
    const tabs = [['schedule', 'Schedule'], ['roster', 'Roster'], ['agenda', 'Agenda templates'], ['chores', 'Chore catalogue'], ['people', 'People & Drive']];
    const tab = state.ui.settingsTab;
    let body = '';
    if (tab === 'schedule') {
      body = '<form class="mtg-form" data-form="cfg-schedule">' +
        '<div class="mtg-grid2">' +
          '<label>Meeting day<select name="defaultDay">' + [0, 1, 2, 3, 4, 5, 6].map(i => '<option value="' + i + '"' + (i === c.defaultDay ? ' selected' : '') + '>' + dowName(i) + '</option>').join('') + '</select></label>' +
          '<label>Start time<input type="time" name="defaultTime" value="' + esc(c.defaultTime) + '"></label>' +
          '<label>Duration (min)<input type="number" name="defaultDuration" min="15" max="240" value="' + c.defaultDuration + '"></label>' +
          '<label>Room<input type="text" name="defaultLocation" value="' + esc(c.defaultLocation) + '" placeholder="BSRL 100"></label>' +
          '<label>Semester start<input type="date" name="semesterStart" value="' + esc(c.semesterStart) + '"></label>' +
          '<label>Semester end<input type="date" name="semesterEnd" value="' + esc(c.semesterEnd) + '"></label>' +
          '<label>Presenter slots per meeting<input type="number" name="slotsPerMeeting" min="1" max="4" value="' + c.slotsPerMeeting + '"></label>' +
          '<label>Slides due (days before)<input type="number" name="submitDeadlineOffsetDays" min="0" max="6" value="' + c.submitDeadlineOffsetDays + '"></label>' +
        '</div>' +
        '<label>Skip weeks <small class="mtg-muted">(Mondays, one per line — YYYY-MM-DD)</small><textarea name="skipWeeks" rows="2">' + esc(c.skipWeeks.join('\n')) + '</textarea></label>' +
        '<div class="mtg-row-actions"><button type="submit" class="mtg-btn mtg-btn-primary">Save</button></div>' +
      '</form>' +
      '<div class="mtg-card-soft mtg-card"><h4>Schedule tools</h4><div class="mtg-row-actions">' +
        '<button type="button" class="mtg-btn" data-act="generate"' + busyAttr('generate') + '>' + icon('calendar-days', { size: 'sm' }) + ' Generate meetings from semester dates</button>' +
        '<button type="button" class="mtg-btn" data-act="seed-fall-2026"' + busyAttr('seed') + '>' + icon('sparkles', { size: 'sm' }) + ' Seed Fall 2026 rotation</button>' +
        '<button type="button" class="mtg-btn mtg-btn-ghost" data-act="migrate-presenters"' + busyAttr('migrate') + '>' + icon('arrow-path', { size: 'sm' }) + ' Migrate old presenter format</button>' +
      '</div><p class="mtg-muted mtg-tiny">Seed = Fridays 11:00–12:00 in BSRL 100, Sep 11 → Dec 18 with Alex’s rotation pre-assigned, Nov 27 as a break, and the two flash-talk weeks. Safe to re-run: dates that already exist are skipped.</p></div>';
    } else if (tab === 'roster') {
      body = renderRosterSettings();
    } else if (tab === 'agenda') {
      body = ['standard', 'flash'].map(kind => {
        const items = c.agendaTemplates[kind] || [];
        return '<form class="mtg-form" data-form="cfg-template" data-kind="' + kind + '"><h4>' + esc(kind === 'flash' ? 'Flash-talk weeks' : 'Standard meeting') + ' <span class="mtg-h3-sub">' + agendaTotal(items) + ' min</span></h4>' +
          '<div class="mtg-tpl-rows">' + items.map((it, i) => tplRow(it, i)).join('') + '</div>' +
          '<div class="mtg-row-actions"><button type="button" class="mtg-btn mtg-btn-sm mtg-btn-ghost" data-act="tpl-add-row">' + icon('plus', { size: 'xs' }) + ' Row</button><button type="submit" class="mtg-btn mtg-btn-sm mtg-btn-primary">Save template</button></div>' +
        '</form>';
      }).join('') + '<p class="mtg-muted mtg-tiny">Templates are copied onto each meeting when it’s created or when a coordinator presses “Reset to template”. Start times are computed from the meeting start time.</p>';
    } else if (tab === 'chores') {
      body = '<form class="mtg-form" data-form="cfg-chores"><div class="mtg-tpl-rows">' + c.chores.map((ch, i) =>
        '<div class="mtg-tpl-row"><input type="text" name="label" value="' + esc(ch.label) + '" placeholder="Chore" required' + (ch.derived ? ' readonly' : '') + '><input type="hidden" name="id" value="' + esc(ch.id) + '">' +
        '<label class="mtg-tiny"><input type="checkbox" name="pool"' + (ch.pool !== false && !ch.derived ? ' checked' : '') + (ch.derived ? ' disabled' : '') + '> in rotation</label>' +
        (ch.derived ? '<span class="mtg-muted mtg-tiny">filled from the presenter rotation</span>' : '<button type="button" class="mtg-iconbtn mtg-danger" data-act="tpl-remove-row" title="Remove">' + icon('x-mark', { size: 'xs' }) + '</button>') + '</div>').join('') +
        '</div><div class="mtg-row-actions"><button type="button" class="mtg-btn mtg-btn-sm mtg-btn-ghost" data-act="chore-add-row">' + icon('plus', { size: 'xs' }) + ' Chore</button><button type="submit" class="mtg-btn mtg-btn-sm mtg-btn-primary">Save catalogue</button></div></form>';
    } else {
      const memberOpts = sel => state.members.map(u => '<option value="' + esc(u.uid) + '"' + (sel.includes(u.uid) ? ' selected' : '') + '>' + esc(u.name || u.email) + '</option>').join('');
      body = (admin ? '<form class="mtg-form" data-form="cfg-people"><h4>Roles <span class="mtg-h3-sub">admin only</span></h4>' +
          '<label>Coordinators <small class="mtg-muted">run the schedule, agenda, chores</small><select name="coordinatorUids" multiple size="6">' + memberOpts(c.coordinatorUids) + '</select></label>' +
          '<label>Named coordinator <small class="mtg-muted">shown in the header</small><select name="primaryCoordinatorUid"><option value="">—</option>' + memberOpts([c.primaryCoordinatorUid]) + '</select></label>' +
          '<label>Reviews the combined deck <small class="mtg-muted">PI</small><select name="reviewerUids" multiple size="4">' + memberOpts(c.reviewerUids.length ? c.reviewerUids : reviewerUids()) + '</select></label>' +
          '<h4>Google Drive</h4>' +
          '<label>Lab Drive account<input type="email" name="labDriveEmail" value="' + esc(c.labDriveEmail) + '"></label>' +
          '<label>Lab Drive folder link <small class="mtg-muted">where students should put slides</small><input type="url" name="driveFolderUrl" value="' + esc(c.driveFolderUrl) + '" placeholder="https://drive.google.com/drive/folders/…"></label>' +
          '<label>Drive API key <small class="mtg-muted">browser key, referrer-restricted to mcgheelab.com — enables name/thumbnail/owner checks</small><input type="text" name="driveApiKey" value="' + esc(c.driveApiKey) + '" autocomplete="off" spellcheck="false"></label>' +
          '<div class="mtg-row-actions"><button type="submit" class="mtg-btn mtg-btn-primary">Save</button> <button type="button" class="mtg-btn mtg-btn-ghost" data-act="test-drive-key">Test key</button></div>' +
        '</form>'
        : '<div class="mtg-card-soft mtg-card"><p class="mtg-muted">Only an admin can appoint coordinators, reviewers, or change the Drive settings.</p><dl class="mtg-dl"><dt>Coordinators</dt><dd>' + esc(c.coordinatorUids.map(u => memberName(u)).join(', ') || '—') + '</dd><dt>Reviewers</dt><dd>' + esc(reviewerUids().map(u => memberName(u)).join(', ')) + '</dd><dt>Drive API key</dt><dd>' + (c.driveApiKey ? 'configured' : 'not set — sharing is checked with a thumbnail probe only') + '</dd></dl></div>');
    }
    return '<div class="mtg-seg mtg-seg-tabs">' + tabs.map(([id, label]) => '<button type="button" class="' + (tab === id ? 'on' : '') + '" data-act="settings-tab" data-id="' + id + '">' + esc(label) + '</button>').join('') + '</div>' +
      '<section class="mtg-card">' + body + '</section>';
  }
  /* V3.744 — who's at meetings / who presents this semester */
  const CAT_LABEL = { pi: 'PI', postdoc: 'Postdoc', grad: 'Grad', undergrad: 'Undergrad', highschool: 'High school', alumni: 'Alumni', collaborator: 'Collaborator', teacher: 'Teacher', guest: 'Guest' };
  const CAT_ORDER = ['pi', 'postdoc', 'grad', 'undergrad', 'highschool', 'teacher', 'collaborator', 'alumni'];
  function renderRosterSettings() {
    const c = cfg();
    const att = new Set(rosterMembers().map(u => u.uid));
    const pres = new Set(presenterPool().map(u => u.uid));
    const rows = state.members.slice().sort((a, b) => (CAT_ORDER.indexOf(a.category || 'zz') - CAT_ORDER.indexOf(b.category || 'zz')) || (a.name || '').localeCompare(b.name || ''));
    return '<form class="mtg-form" data-form="cfg-roster">' +
      '<p class="mtg-muted">Tick who is <b>at lab meetings</b> this semester (owes round-robin slides, gets chores and action items) and who <b>presents</b> (can be given or claim a slot). Alumni are off by default and never appear in pickers. ' +
        (c.attendeeUids ? '' : '<b>Not saved yet — showing the defaults.</b>') + '</p>' +
      '<div class="mtg-roster-head"><span>Member</span><span>At meetings</span><span>Presents</span></div>' +
      rows.map(u => '<label class="mtg-roster-row' + (att.has(u.uid) ? '' : ' mtg-roster-off') + '">' +
        '<span class="mtg-roster-who">' + avatar(u.uid) + ' <span>' + esc(u.name || u.email) + '</span><small class="mtg-muted">' + esc(CAT_LABEL[u.category] || u.category || '') + (u.role === 'admin' ? ' · admin' : '') + '</small></span>' +
        '<span><input type="checkbox" name="att" value="' + esc(u.uid) + '"' + (att.has(u.uid) ? ' checked' : '') + '></span>' +
        '<span><input type="checkbox" name="pres" value="' + esc(u.uid) + '"' + (pres.has(u.uid) ? ' checked' : '') + '></span>' +
      '</label>').join('') +
      '<div class="mtg-row-actions"><button type="submit" class="mtg-btn mtg-btn-primary">Save roster</button>' +
        '<span class="mtg-muted mtg-tiny">' + att.size + ' at meetings · ' + pres.size + ' present</span></div>' +
    '</form>';
  }

  function tplRow(it, i) {
    return '<div class="mtg-tpl-row"><span class="mtg-tpl-n">' + (i + 1) + '</span>' +
      '<input type="text" name="text" value="' + esc(it.text) + '" placeholder="Block" required>' +
      '<input type="number" name="minutes" value="' + (+it.minutes || 5) + '" min="1" max="120"><span class="mtg-muted mtg-tiny">min</span>' +
      '<select name="type">' + AGENDA_TYPES.map(t => '<option value="' + t + '"' + (t === (it.type || 'discussion') ? ' selected' : '') + '>' + esc(AGENDA_TYPE_LABEL[t]) + '</option>').join('') + '</select>' +
      '<button type="button" class="mtg-iconbtn mtg-danger" data-act="tpl-remove-row" title="Remove">' + icon('x-mark', { size: 'xs' }) + '</button></div>';
  }

  /* ═══════════════════════════════════════════════════════════════
     SHEETS — every form lives in APP_SHEET; never a browser popup
     ═══════════════════════════════════════════════════════════════ */
  function sheet(opts) {
    if (!window.APP_SHEET) { toast('error', 'app-sheet.js not loaded'); return null; }
    return APP_SHEET.open(opts);
  }
  function openConfirm(message, yesLabel, onYes, danger) {
    sheet({ title: 'Confirm', build(body, api) {
      body.innerHTML = '<p class="mtg-confirm-msg">' + esc(message) + '</p><div class="mtg-row-actions">' +
        '<button type="button" class="mtg-btn ' + (danger ? 'mtg-btn-danger' : 'mtg-btn-primary') + ' mtg-yes">' + esc(yesLabel || 'Yes') + '</button>' +
        '<button type="button" class="mtg-btn mtg-no">Cancel</button></div>';
      body.querySelector('.mtg-yes').addEventListener('click', async () => { api.close(); try { await onYes(); } catch (e) { toast('error', 'Failed: ' + (e && e.message)); } });
      body.querySelector('.mtg-no').addEventListener('click', () => api.close());
    } });
  }

  /* Drive-link field: input + Check + live status. Returns { get() } where
   * get() yields the verified DriveRef (or null / an unverified stub). */
  function linkField(container, opts) {
    opts = opts || {};
    const id = 'lf-' + Math.random().toString(36).slice(2, 7);
    const c = cfg();
    container.insertAdjacentHTML('beforeend',
      '<div class="mtg-linkfield" id="' + id + '">' +
        '<label>' + esc(opts.label || 'Google Drive link') + '<div class="mtg-linkrow">' +
          '<input type="url" class="mtg-lf-input" placeholder="https://drive.google.com/… or docs.google.com/…" value="' + esc(opts.initial && opts.initial.url || '') + '" autocomplete="off" spellcheck="false">' +
          '<button type="button" class="mtg-btn mtg-btn-sm mtg-lf-check">Check</button></div></label>' +
        '<div class="mtg-lf-help mtg-muted mtg-tiny">Must live in the lab Drive (' + esc(c.labDriveEmail) + ')' + (c.driveFolderUrl ? ' — <a href="' + esc(c.driveFolderUrl) + '" target="_blank" rel="noopener">open the folder</a> —' : '') + ' and be shared “Anyone with the link”.</div>' +
        '<div class="mtg-lf-status"></div>' +
      '</div>');
    const el = container.querySelector('#' + id);
    const input = el.querySelector('.mtg-lf-input');
    const status = el.querySelector('.mtg-lf-status');
    let ref = opts.initial || null;
    let checking = false;
    if (ref && ref.fileId && window.DRIVE_LINK) status.innerHTML = DRIVE_LINK.chips(ref);
    async function check() {
      const url = input.value.trim();
      if (!url) { ref = null; status.innerHTML = ''; return; }
      if (!window.DRIVE_LINK) { ref = { url, fileId: null, accessible: null, ownerOk: null }; return; }
      const parsed = DRIVE_LINK.parse(url);
      if (!parsed) {
        ref = null;
        status.innerHTML = '<span class="dl-chip dl-bad">' + icon('exclamation-triangle', { size: 'xs' }) + ' That isn’t a Google Drive or Docs link</span>';
        return;
      }
      checking = true;
      status.innerHTML = '<span class="mtg-muted mtg-tiny">Checking sharing…</span>';
      ref = await DRIVE_LINK.verify(url, { apiKey: c.driveApiKey, labEmail: c.labDriveEmail, url });
      checking = false;
      status.innerHTML = DRIVE_LINK.chips(ref) + (ref.error ? '<div class="mtg-lf-err">' + esc(ref.error) + '</div>' : '') +
        (ref.keyError ? '<div class="mtg-muted mtg-tiny">Drive API key issue (' + esc(ref.keyError) + ') — checked with a thumbnail probe instead.</div>' : '');
      if (typeof opts.onVerified === 'function') opts.onVerified(ref);
    }
    el.querySelector('.mtg-lf-check').addEventListener('click', check);
    input.addEventListener('paste', () => setTimeout(check, 50));
    input.addEventListener('blur', () => { if (!ref || ref.url !== input.value.trim()) check(); });
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); check(); } });
    return {
      get() {
        const url = input.value.trim();
        if (!url) return null;
        if (ref && ref.url === url) return ref;
        const parsed = window.DRIVE_LINK ? DRIVE_LINK.parse(url) : null;
        return parsed ? Object.assign({ name: '', mimeType: '', accessible: null, ownerOk: null, verifiedAt: null }, parsed) : { url, fileId: null, accessible: null, ownerOk: null };
      },
      isChecking() { return checking; },
      input,
    };
  }
  function linkBlocks(ref) {
    // hard block only on a Drive link that we POSITIVELY know isn't shared
    return !!(ref && ref.fileId && ref.accessible === false);
  }

  function openPresentationSheet(meetingId, uid) {
    const m = meeting(meetingId);
    if (!m) return;
    const p = presentersOf(m).find(x => x.uid === uid) || { uid, title: '', abstract: '', link: null };
    const mine = uid === me();
    sheet({ title: (mine ? 'My presentation' : memberName(uid) + '’s presentation') + ' — ' + fmtDate(m.date), build(body, api) {
      body.innerHTML = '<form class="mtg-form">' +
        '<label>Title<input type="text" name="title" value="' + esc(p.title || '') + '" maxlength="160" placeholder="What are you presenting?"></label>' +
        '<label>Abstract / one-liner<textarea name="abstract" rows="3" maxlength="800" placeholder="Optional — what should people know going in?">' + esc(p.abstract || '') + '</textarea></label>' +
        '<div class="mtg-lf-slot"></div>' +
        '<div class="mtg-row-actions"><button type="submit" class="mtg-btn mtg-btn-primary">Save</button><button type="button" class="mtg-btn mtg-cancel">Cancel</button></div></form>';
      const lf = linkField(body.querySelector('.mtg-lf-slot'), { label: 'Slides link (Google Drive)', initial: p.link && p.link.fileId ? p.link : (p.link ? { url: p.link.url } : null) });
      body.querySelector('.mtg-cancel').addEventListener('click', () => api.close());
      body.querySelector('form').addEventListener('submit', async ev => {
        ev.preventDefault();
        const f = ev.target;
        const link = lf.get();
        if (linkBlocks(link)) { toast('warn', 'Fix the sharing on that Drive link first (Anyone with the link).'); return; }
        api.close();
        try {
          await savePresentation(meetingId, uid, { title: f.title.value.trim(), abstract: f.abstract.value.trim(), link });
          toast('success', 'Presentation saved');
        } catch (e) { toast('error', 'Save failed: ' + (e && e.message)); }
      });
    } });
  }

  function openSubmitSheet(meetingId) {
    const m = meeting(meetingId);
    if (!m) return;
    const existing = updatesOf(m).submissions[me()];
    const pres = presentersOf(m);
    sheet({ title: 'My 1–2 slides for ' + fmtDate(m.date), build(body, api) {
      body.innerHTML = '<form class="mtg-form"><p class="mtg-muted">' + (pres.length ? esc(firstName(pres[0].uid, pres[0].name)) + ' will' : 'The presenter will') + ' concatenate everyone’s slides into one deck for the PI to review on ' + esc(fmtDate(reviewDue(m))) + '. Due ' + esc(fmtDate(submitDue(m))) + '.</p>' +
        '<div class="mtg-lf-slot"></div>' +
        '<label>Note for the presenter <small class="mtg-muted">optional</small><input type="text" name="note" maxlength="200" value="' + esc(existing && existing.note || '') + '" placeholder="e.g. slide 2 has a video"></label>' +
        '<div class="mtg-row-actions"><button type="submit" class="mtg-btn mtg-btn-primary">Submit</button><button type="button" class="mtg-btn mtg-cancel">Cancel</button></div></form>';
      const lf = linkField(body.querySelector('.mtg-lf-slot'), { initial: existing && existing.link || null });
      body.querySelector('.mtg-cancel').addEventListener('click', () => api.close());
      body.querySelector('form').addEventListener('submit', async ev => {
        ev.preventDefault();
        const link = lf.get();
        if (!link) { lf.input.focus(); return; }
        if (linkBlocks(link)) { toast('warn', 'Fix the sharing on that Drive link first (Anyone with the link).'); return; }
        api.close();
        try { await submitSlides(meetingId, link, ev.target.note.value.trim()); } catch (e) { toast('error', 'Failed: ' + (e && e.message)); }
      });
    } });
  }

  function openDeckSheet(meetingId) {
    const m = meeting(meetingId);
    if (!m) return;
    const u = updatesOf(m);
    const people = submittersFor(m);
    const missing = people.filter(p => !u.submissions[p.uid]);
    sheet({ title: 'Combined round-robin deck — ' + fmtDate(m.date), build(body, api) {
      body.innerHTML = '<form class="mtg-form">' +
        (missing.length ? '<p class="mtg-muted">' + icon('exclamation-triangle', { size: 'xs' }) + ' Still missing slides from ' + esc(missing.map(p => firstName(p.uid)).join(', ')) + '.</p>' : '<p class="mtg-muted">' + icon('check-circle', { size: 'xs' }) + ' Everyone’s slides are in.</p>') +
        '<div class="mtg-lf-slot"></div>' +
        '<div class="mtg-row-actions"><button type="submit" class="mtg-btn mtg-btn-primary">Post deck</button><button type="button" class="mtg-btn mtg-cancel">Cancel</button></div></form>';
      const lf = linkField(body.querySelector('.mtg-lf-slot'), { label: 'Combined deck (Google Drive)', initial: u.deck });
      body.querySelector('.mtg-cancel').addEventListener('click', () => api.close());
      body.querySelector('form').addEventListener('submit', async ev => {
        ev.preventDefault();
        const link = lf.get();
        if (!link) { lf.input.focus(); return; }
        if (linkBlocks(link)) { toast('warn', 'Fix the sharing on that Drive link first (Anyone with the link).'); return; }
        api.close();
        try { await postDeck(meetingId, link); } catch (e) { toast('error', 'Failed: ' + (e && e.message)); }
      });
    } });
  }

  function openReviewSheet(meetingId, status) {
    const m = meeting(meetingId);
    if (!m) return;
    if (status === 'approved') { reviewDeck(meetingId, 'approved', '').catch(e => toast('error', e.message)); return; }
    sheet({ title: 'Request changes — ' + fmtDate(m.date), build(body, api) {
      body.innerHTML = '<form class="mtg-form"><label>What should change?<textarea name="comment" rows="3" required maxlength="600" placeholder="e.g. Zeke’s slide is missing axis labels; trim to 10 slides"></textarea></label>' +
        '<div class="mtg-row-actions"><button type="submit" class="mtg-btn mtg-btn-primary">Send</button><button type="button" class="mtg-btn mtg-cancel">Cancel</button></div></form>';
      body.querySelector('.mtg-cancel').addEventListener('click', () => api.close());
      body.querySelector('form').addEventListener('submit', async ev => {
        ev.preventDefault(); api.close();
        try { await reviewDeck(meetingId, 'changes', ev.target.comment.value.trim()); } catch (e) { toast('error', 'Failed: ' + (e && e.message)); }
      });
    } });
  }

  function openSwapSheet(targetMeetingId, targetUid) {
    const to = meeting(targetMeetingId);
    if (!to) return;
    const t = todayStr();
    const mine = state.meetings.filter(m => m.date >= t && m.status !== 'cancelled' && isPresenter(m) && m.id !== targetMeetingId);
    sheet({ title: 'Swap with ' + firstName(targetUid), build(body, api) {
      if (!mine.length) {
        body.innerHTML = '<p>You don’t have a presentation slot to offer ' + esc(firstName(targetUid)) + '.</p><p class="mtg-muted">Claim an empty slot on the schedule instead — no swap needed.</p><div class="mtg-row-actions"><button type="button" class="mtg-btn mtg-cancel">Close</button></div>';
        body.querySelector('.mtg-cancel').addEventListener('click', () => api.close());
        return;
      }
      body.innerHTML = '<form class="mtg-form"><p>You’d take <b>' + esc(fmtDate(to.date)) + '</b>. Which of your slots do you offer in return?</p>' +
        '<div class="mtg-radios">' + mine.map((m, i) => '<label class="mtg-radio"><input type="radio" name="offer" value="' + m.id + '"' + (i === 0 ? ' checked' : '') + '> ' + esc(fmtDateLong(m.date)) + '</label>').join('') + '</div>' +
        '<label>Message <small class="mtg-muted">optional</small><input type="text" name="message" maxlength="200" placeholder="e.g. I have a conference that week"></label>' +
        '<p class="mtg-muted mtg-tiny">' + esc(firstName(targetUid)) + ' gets a notification and a banner here. Nothing moves until they accept.</p>' +
        '<div class="mtg-row-actions"><button type="submit" class="mtg-btn mtg-btn-primary">Send request</button><button type="button" class="mtg-btn mtg-cancel">Cancel</button></div></form>';
      body.querySelector('.mtg-cancel').addEventListener('click', () => api.close());
      body.querySelector('form').addEventListener('submit', async ev => {
        ev.preventDefault(); api.close();
        const offer = ev.target.offer.value;
        try { await requestSwap(offer, targetUid, targetMeetingId, ev.target.message.value.trim()); } catch (e) { toast('error', 'Failed: ' + (e && e.message)); }
      });
    } });
  }

  function openMeetingSheet(meetingId) {
    const m = meetingId ? meeting(meetingId) : null;
    const c = cfg();
    const v = m || { date: '', time: c.defaultTime, duration: c.defaultDuration, location: c.defaultLocation, kind: 'standard', status: 'upcoming' };
    sheet({ title: m ? 'Edit meeting — ' + fmtDate(m.date) : 'New meeting', build(body, api) {
      body.innerHTML = '<form class="mtg-form"><div class="mtg-grid2">' +
        '<label>Date<input type="date" name="date" value="' + esc(v.date) + '" required></label>' +
        '<label>Start<input type="time" name="time" value="' + esc(v.time) + '" required></label>' +
        '<label>Duration (min)<input type="number" name="duration" min="15" max="240" value="' + (v.duration || 60) + '"></label>' +
        '<label>Room<input type="text" name="location" value="' + esc(v.location || '') + '"></label>' +
        '<label>Kind<select name="kind">' + ['standard', 'flash', 'break'].map(k => '<option value="' + k + '"' + (k === (v.kind || 'standard') ? ' selected' : '') + '>' + esc(KIND_LABEL[k]) + '</option>').join('') + '</select></label>' +
        (m ? '<label>Status<select name="status">' + ['upcoming', 'completed', 'cancelled'].map(s => '<option value="' + s + '"' + (s === v.status ? ' selected' : '') + '>' + s + '</option>').join('') + '</select></label>' : '') +
        '</div><div class="mtg-row-actions"><button type="submit" class="mtg-btn mtg-btn-primary">' + (m ? 'Save' : 'Create') + '</button><button type="button" class="mtg-btn mtg-cancel">Cancel</button></div></form>';
      body.querySelector('.mtg-cancel').addEventListener('click', () => api.close());
      body.querySelector('form').addEventListener('submit', async ev => {
        ev.preventDefault();
        const f = ev.target;
        const patch = { date: f.date.value, time: f.time.value, duration: +f.duration.value || 60, location: f.location.value.trim(), kind: f.kind.value };
        if (m) patch.status = f.status.value;
        if (patch.kind === 'break' && !m) patch.status = 'cancelled';
        api.close();
        try {
          if (m) {
            if (patch.kind !== kindOf(m) && !agendaOf(m).some(it => minutesOf(m).items[it.id])) patch.agendaItems = patch.kind === 'break' ? [] : templateItems(patch.kind);
            await updateMeeting(m.id, patch); toast('success', 'Meeting updated');
          } else {
            await createMeeting(Object.assign(patch, { agendaItems: patch.kind === 'break' ? [] : templateItems(patch.kind) })); toast('success', 'Meeting created');
          }
        } catch (e) { toast('error', 'Failed: ' + (e && e.message)); }
      });
    } });
  }

  function openPostponeSheet(meetingId) {
    const m = meeting(meetingId);
    if (!m) return;
    sheet({ title: 'Postpone ' + fmtDate(m.date), build(body, api) {
      body.innerHTML = '<form class="mtg-form"><label>New date<input type="date" name="date" value="' + esc(addDays(m.date, 7)) + '" required></label>' +
        '<p class="mtg-muted mtg-tiny">Presenters, agenda and submissions move with it. Reminders reset.</p>' +
        '<div class="mtg-row-actions"><button type="submit" class="mtg-btn mtg-btn-primary">Move</button><button type="button" class="mtg-btn mtg-cancel">Cancel</button></div></form>';
      body.querySelector('.mtg-cancel').addEventListener('click', () => api.close());
      body.querySelector('form').addEventListener('submit', async ev => {
        ev.preventDefault(); api.close();
        try { await postpone(meetingId, ev.target.date.value); } catch (e) { toast('error', 'Failed: ' + (e && e.message)); }
      });
    } });
  }

  /* generic member picker (coordinator assign, chore assign) */
  function openMemberPicker(title, opts, onPick) {
    opts = opts || {};
    sheet({ title, build(body, api) {
      const exclude = new Set(opts.exclude || []);
      const only = opts.only ? new Set(opts.only) : null;
      const list = state.members.filter(u => !exclude.has(u.uid) && (!only || only.has(u.uid)));
      body.innerHTML = '<input type="search" class="mtg-input mtg-picker-search" placeholder="Filter…">' +
        '<div class="mtg-picker">' + (opts.allowNone ? '<button type="button" class="mtg-picker-row mtg-picker-none" data-uid="">' + icon('x-mark', { size: 'sm' }) + ' ' + esc(opts.noneLabel || 'Unassign') + '</button>' : '') +
        (list.length ? '' : '<div class="mtg-muted mtg-tiny" style="padding:8px">' + esc(opts.emptyText || 'Nobody to pick') + '</div>') +
        list.map(u => '<button type="button" class="mtg-picker-row" data-uid="' + esc(u.uid) + '" data-name="' + esc((u.name || u.email || '').toLowerCase()) + '">' + avatar(u.uid) + ' <span>' + esc(u.name || u.email) + '</span>' + (opts.hint ? '<small class="mtg-muted">' + esc(opts.hint(u) || '') + '</small>' : '') + '</button>').join('') + '</div>';
      body.querySelector('.mtg-picker-search').addEventListener('input', ev => {
        const q = ev.target.value.toLowerCase();
        body.querySelectorAll('.mtg-picker-row[data-name]').forEach(r => { r.hidden = q && !r.dataset.name.includes(q); });
      });
      body.querySelector('.mtg-picker').addEventListener('click', async ev => {
        const row = ev.target.closest('.mtg-picker-row');
        if (!row) return;
        api.close();
        try { await onPick(row.dataset.uid); } catch (e) { toast('error', 'Failed: ' + (e && e.message)); }
      });
    } });
  }

  function openTopicEditSheet(topicId) {
    const t = state.topics.find(x => x.id === topicId);
    if (!t) return;
    sheet({ title: 'Edit topic', build(body, api) {
      body.innerHTML = '<form class="mtg-form"><label>Topic<input type="text" name="text" value="' + esc(t.text) + '" required maxlength="160"></label><label>Detail<textarea name="details" rows="3" maxlength="400">' + esc(t.details || '') + '</textarea></label>' +
        '<div class="mtg-row-actions"><button type="submit" class="mtg-btn mtg-btn-primary">Save</button><button type="button" class="mtg-btn mtg-cancel">Cancel</button></div></form>';
      body.querySelector('.mtg-cancel').addEventListener('click', () => api.close());
      body.querySelector('form').addEventListener('submit', async ev => {
        ev.preventDefault(); api.close();
        try { await updateTopic(topicId, { text: ev.target.text.value.trim(), details: ev.target.details.value.trim() }); } catch (e) { toast('error', 'Failed: ' + (e && e.message)); }
      });
    } });
  }

  function openScheduleTopicSheet(topicId) {
    const t = state.topics.find(x => x.id === topicId);
    if (!t) return;
    const upcoming = state.meetings.filter(m => m.date >= todayStr() && m.status !== 'cancelled' && !isBreak(m)).slice(0, 12);
    sheet({ title: 'Schedule “' + t.text + '”', build(body, api) {
      body.innerHTML = '<form class="mtg-form"><label>Meeting<select name="meetingId">' + upcoming.map(m => '<option value="' + m.id + '">' + esc(fmtDateLong(m.date)) + ' — ' + esc(presenterNames(m)) + ' (' + agendaTotal(agendaOf(m)) + '/' + (m.duration || 60) + ' min)</option>').join('') + '</select></label>' +
        '<label>Minutes<input type="number" name="minutes" value="5" min="1" max="60"></label>' +
        '<div class="mtg-row-actions"><button type="submit" class="mtg-btn mtg-btn-primary">Add to agenda</button><button type="button" class="mtg-btn mtg-cancel">Cancel</button></div></form>';
      body.querySelector('.mtg-cancel').addEventListener('click', () => api.close());
      body.querySelector('form').addEventListener('submit', async ev => {
        ev.preventDefault(); api.close();
        try { await scheduleTopic(topicId, ev.target.meetingId.value, +ev.target.minutes.value); } catch (e) { toast('error', 'Failed: ' + (e && e.message)); }
      });
    } });
  }

  function openActionItemSheet(meetingId, defaults) {
    const m = meeting(meetingId);
    if (!m) return;
    defaults = defaults || {};
    sheet({ title: 'Action item — ' + fmtDate(m.date), build(body, api) {
      body.innerHTML = '<form class="mtg-form"><label>What<input type="text" name="text" required maxlength="200" value="' + esc(defaults.text || '') + '" placeholder="e.g. Order 40 kPa gels for the TFM run"></label>' +
        '<div class="mtg-grid2"><label>Who<select name="assignee"><option value="">— nobody yet —</option>' + assignees().map(u => '<option value="' + esc(u.uid) + '"' + (u.uid === (defaults.assigneeUid || '') ? ' selected' : '') + '>' + esc(u.name || u.email) + '</option>').join('') + '</select></label>' +
        '<label>By when<input type="date" name="deadline" value="' + esc(defaults.deadline || addDays(m.date, 7)) + '"></label></div>' +
        '<p class="mtg-muted mtg-tiny">Assigning to someone puts a card at the top of their My Week, which they drop onto a day.</p>' +
        '<div class="mtg-row-actions"><button type="submit" class="mtg-btn mtg-btn-primary">Add</button><button type="button" class="mtg-btn mtg-cancel">Cancel</button></div></form>';
      body.querySelector('.mtg-cancel').addEventListener('click', () => api.close());
      body.querySelector('form').addEventListener('submit', async ev => {
        ev.preventDefault(); api.close();
        try { await addActionItem(meetingId, { text: ev.target.text.value.trim(), assigneeUid: ev.target.assignee.value, deadline: ev.target.deadline.value || null }); } catch (e) { toast('error', 'Failed: ' + (e && e.message)); }
      });
    } });
  }

  /* ═══════════════════════════════════════════════════════════════
     EVENTS — one delegated handler per event type
     ═══════════════════════════════════════════════════════════════ */
  async function withBusy(key, fn) {
    state.busy[key] = true; render();
    try { return await fn(); } finally { state.busy[key] = false; render(); }
  }

  root.addEventListener('click', async ev => {
    const btn = ev.target.closest('[data-act]');
    if (!btn || !root.contains(btn)) return;
    if (btn.tagName === 'INPUT' && btn.type === 'checkbox') return;  // handled on change
    if (btn.tagName === 'SUMMARY') return;                           // native toggle
    const act = btn.dataset.act, id = btn.dataset.id, uid = btn.dataset.uid;
    if (btn.tagName === 'A') ev.preventDefault();
    try {
      if (window.MEETINGS_LIVE && act.startsWith('live-')) { await MEETINGS_LIVE.onAct(act, btn, ev); return; }
      if (window.MEETINGS_CHORES && act.startsWith('chore-') && act !== 'chore-tick' && act !== 'chore-add-row') { await MEETINGS_CHORES.onAct(act, btn, ev); return; }
      if (window.MEETINGS_ONE_ON_ONE && act.startsWith('oo-')) { await MEETINGS_ONE_ON_ONE.onAct(act, btn, ev); return; }
      switch (act) {
        case 'tab': state.section = id; state.ui.live = null; render(); break;
        case 'run': state.ui.live = id; render(); break;
        case 'live-close': state.ui.live = null; render(); break;
        case 'sched-filter': state.ui.schedFilter = id; render(); break;
        case 'settings-tab': state.ui.settingsTab = id; render(); break;
        case 'hist-toggle': state.ui.histOpen = state.ui.histOpen === id ? null : id; render(); break;
        case 'topics-toggle': state.ui.topicsShowClosed = !state.ui.topicsShowClosed; break;

        case 'edit-presentation': openPresentationSheet(id, uid); break;
        case 'submit-slides': openSubmitSheet(id); break;
        case 'remove-submission': openConfirm('Remove your submitted slides link?', 'Remove', () => removeSubmission(id, me())); break;
        case 'post-deck': openDeckSheet(id); break;
        case 'review-deck': openReviewSheet(id, btn.dataset.status); break;
        case 'react': await toggleReaction(id, btn.dataset.type); break;

        case 'claim': await assignSlot(id, me(), +btn.dataset.slot); toast('success', 'You’re presenting ' + fmtDate(meeting(id).date)); break;
        case 'release': openConfirm('Give up your slot on ' + fmtDate(meeting(id).date) + '?', 'Release', () => unassignSlot(id, uid)); break;
        case 'unassign': await unassignSlot(id, uid); break;
        case 'pick-presenter': openMemberPicker('Assign presenter — ' + fmtDate(meeting(id).date), { only: presenterPool().map(u => u.uid), exclude: presentersOf(meeting(id)).map(p => p.uid), emptyText: 'Nobody in the presenter pool — set it in Settings → Roster.' }, u => assignSlot(id, u, +btn.dataset.slot)); break;
        case 'request-swap': openSwapSheet(id, uid); break;
        case 'swap-respond': await respondSwap(id, btn.dataset.status); break;
        case 'swap-execute': await executeSwap(id); break;

        case 'new-meeting': openMeetingSheet(null); break;
        case 'edit-meeting': openMeetingSheet(id); break;
        case 'postpone': openPostponeSheet(id); break;
        case 'delete-meeting': openConfirm('Delete the ' + fmtDate(meeting(id).date) + ' meeting? Presenters, minutes and action items on it are lost.', 'Delete', () => deleteMeeting(id), true); break;
        case 'set-status': await setStatus(id, btn.dataset.status); break;

        case 'ag-add': state.ui.agendaAdd = id; render(); break;
        case 'ag-add-cancel': state.ui.agendaAdd = null; render(); break;
        case 'ag-remove': await removeAgendaItem(id, btn.dataset.item); break;
        case 'ag-up': await moveAgendaItem(id, btn.dataset.item, -1); break;
        case 'ag-down': await moveAgendaItem(id, btn.dataset.item, +1); break;
        case 'ag-template': if (agendaOf(meeting(id)).length) openConfirm('Replace this agenda with the ' + kindOf(meeting(id)) + ' template?', 'Replace', () => applyTemplate(id)); else await applyTemplate(id); break;
        case 'ag-carry': { const src = agendaOf(meeting(btn.dataset.from)).find(it => it.id === btn.dataset.item); if (src) await addAgendaItem(id, { text: src.text, minutes: src.minutes, type: src.type, topicId: src.topicId }); break; }
        case 'ai-add': openActionItemSheet(id); break;
        case 'ai-remove': openConfirm('Remove this action item?', 'Remove', () => removeActionItem(id, btn.dataset.item)); break;

        case 'vote': await toggleVote(id); break;
        case 'topic-schedule': openScheduleTopicSheet(id); break;
        case 'topic-dismiss': await updateTopic(id, { status: 'dismissed' }); break;
        case 'topic-reopen': await updateTopic(id, { status: 'open', meetingId: null, agendaItemId: null }); break;
        case 'topic-edit': openTopicEditSheet(id); break;
        case 'topic-delete': openConfirm('Delete this topic?', 'Delete', () => deleteTopic(id), true); break;

        case 'generate': await withBusy('generate', generateMeetings); break;
        case 'seed-fall-2026': openConfirm('Seed the Fall 2026 schedule? Adds the 15 Fridays with presenters, sets Fridays 11:00–12:00 in BSRL 100, names Cason coordinator. Existing dates are skipped.', 'Seed', () => withBusy('seed', seedFall2026)); break;
        case 'migrate-presenters': await withBusy('migrate', migratePresenters); break;
        case 'test-drive-key': {
          const key = root.querySelector('input[name="driveApiKey"]');
          if (!key || !key.value.trim() || !window.DRIVE_LINK) { toast('warn', 'Paste a key first'); break; }
          // a well-known public Google Slides template
          const r = await DRIVE_LINK.verify('1cPoBDFENf6WFWWWhTOr5Orm6h5RWCA_FqZ-6o4-jR3g', { apiKey: key.value.trim() });
          toast(r.method === 'api' && r.accessible ? 'success' : 'warn', r.method === 'api' ? 'Key works — Drive API answered (' + (r.name || 'ok') + ')' : 'Key rejected (' + (r.keyError || 'unknown') + '). Is the Drive API enabled and the referrer allowed?');
          break;
        }
        case 'tpl-add-row': { const rows = btn.closest('form').querySelector('.mtg-tpl-rows'); rows.insertAdjacentHTML('beforeend', tplRow({ text: '', minutes: 5, type: 'discussion' }, rows.children.length)); rows.lastElementChild.querySelector('input').focus(); break; }
        case 'chore-add-row': { const rows = btn.closest('form').querySelector('.mtg-tpl-rows'); rows.insertAdjacentHTML('beforeend', '<div class="mtg-tpl-row"><input type="text" name="label" placeholder="Chore" required><input type="hidden" name="id" value=""><label class="mtg-tiny"><input type="checkbox" name="pool" checked> in rotation</label><button type="button" class="mtg-iconbtn mtg-danger" data-act="tpl-remove-row" title="Remove">' + icon('x-mark', { size: 'xs' }) + '</button></div>'); rows.lastElementChild.querySelector('input').focus(); break; }
        case 'tpl-remove-row': btn.closest('.mtg-tpl-row').remove(); break;
        default: break;
      }
    } catch (e) {
      console.warn('[meetings] action failed', act, e);
      toast('error', (e && e.code === 'permission-denied') ? 'You don’t have permission to do that.' : 'Something failed: ' + (e && e.message));
      render();
    }
  });

  root.addEventListener('change', async ev => {
    const el = ev.target;
    try {
      if (el.dataset.act === 'ai-toggle') { await setActionItemStatus(el.dataset.id, el.dataset.item, el.checked); return; }
      if (el.dataset.act === 'chore-tick') { await tickChore(el.dataset.week, el.dataset.chore, el.dataset.uid || me(), el.checked); return; }
      if (el.dataset.change === 'hist-presenter') { state.ui.histPresenter = el.value; render(); return; }
      if (window.MEETINGS_LIVE && el.dataset.act && el.dataset.act.startsWith('live-')) { await MEETINGS_LIVE.onChange(el, ev); return; }
      if (window.MEETINGS_CHORES && el.dataset.change && el.dataset.change.startsWith('chore-')) { await MEETINGS_CHORES.onChange(el, ev); return; }
    } catch (e) {
      toast('error', (e && e.code === 'permission-denied') ? 'You don’t have permission to do that.' : 'Failed: ' + (e && e.message));
      render();
    }
  });

  root.addEventListener('input', ev => {
    const el = ev.target;
    if (el.dataset.input === 'hist-search') { state.ui.histSearch = el.value; render(); return; }
    if (window.MEETINGS_LIVE && el.dataset.live) MEETINGS_LIVE.onInput(el, ev);
  });

  root.addEventListener('submit', async ev => {
    const f = ev.target.closest('form[data-form]');
    if (!f) return;
    ev.preventDefault();
    const kind = f.dataset.form;
    const fd = new FormData(f);
    try {
      switch (kind) {
        case 'agenda-add':
          await addAgendaItem(f.dataset.id, { text: String(fd.get('text') || '').trim(), minutes: +fd.get('minutes') || 5, type: fd.get('type') });
          state.ui.agendaAdd = f.dataset.id; render();
          setTimeout(() => { const i = document.getElementById('mtg-ag-new-text'); if (i) i.focus(); }, 30);
          break;
        case 'topic-add': {
          const text = String(fd.get('text') || '').trim();
          if (!text) return;
          f.reset();
          await addTopic(text, String(fd.get('details') || '').trim());
          render();   // explicit: the re-focused input would otherwise defer the snapshot render
          break;
        }
        case 'cfg-schedule':
          await saveConfig({
            defaultDay: +fd.get('defaultDay'), defaultTime: fd.get('defaultTime'), defaultDuration: +fd.get('defaultDuration') || 60,
            defaultLocation: String(fd.get('defaultLocation') || '').trim(), semesterStart: fd.get('semesterStart') || '', semesterEnd: fd.get('semesterEnd') || '',
            slotsPerMeeting: +fd.get('slotsPerMeeting') || 2, submitDeadlineOffsetDays: +fd.get('submitDeadlineOffsetDays') || 0,
            skipWeeks: String(fd.get('skipWeeks') || '').split(/\s+/).map(s => s.trim()).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s)),
          });
          toast('success', 'Schedule settings saved');
          break;
        case 'cfg-template': {
          const rows = Array.from(f.querySelectorAll('.mtg-tpl-row')).map(r => ({
            text: r.querySelector('[name="text"]').value.trim(), minutes: +r.querySelector('[name="minutes"]').value || 5, type: r.querySelector('[name="type"]').value,
          })).filter(r => r.text);
          const tpl = Object.assign({}, cfg().agendaTemplates); tpl[f.dataset.kind] = rows;
          await saveConfig({ agendaTemplates: tpl });
          toast('success', 'Template saved (' + agendaTotal(rows) + ' min)');
          break;
        }
        case 'cfg-chores': {
          const rows = Array.from(f.querySelectorAll('.mtg-tpl-row')).map(r => {
            const label = r.querySelector('[name="label"]').value.trim();
            let id = r.querySelector('[name="id"]').value;
            if (!id) id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || newId('ch');
            const derived = id === 'present';
            const poolEl = r.querySelector('[name="pool"]');
            return { id, label, pool: derived ? false : !!(poolEl && poolEl.checked), derived };
          }).filter(r => r.label);
          if (!rows.some(r => r.id === 'present')) rows.push(DEFAULT_CHORES.find(c => c.id === 'present'));
          await saveConfig({ chores: rows });
          toast('success', 'Chore catalogue saved');
          break;
        }
        case 'cfg-roster': {
          const attendeeUids = Array.from(f.querySelectorAll('input[name="att"]:checked')).map(i => i.value);
          const presenterPoolUids = Array.from(f.querySelectorAll('input[name="pres"]:checked')).map(i => i.value).filter(u => attendeeUids.includes(u));
          await saveConfig({ attendeeUids, presenterPoolUids });
          toast('success', 'Roster saved — ' + attendeeUids.length + ' at meetings, ' + presenterPoolUids.length + ' presenting');
          break;
        }
        case 'cfg-people': {
          const multi = name => Array.from(f.querySelector('[name="' + name + '"]').selectedOptions).map(o => o.value).filter(Boolean);
          const coordinatorUids = multi('coordinatorUids');
          let primary = fd.get('primaryCoordinatorUid') || '';
          if (primary && !coordinatorUids.includes(primary)) coordinatorUids.push(primary);
          if (!primary && coordinatorUids.length) primary = coordinatorUids[0];
          await saveConfig({
            coordinatorUids, primaryCoordinatorUid: primary, reviewerUids: multi('reviewerUids'),
            labDriveEmail: String(fd.get('labDriveEmail') || '').trim(), driveFolderUrl: String(fd.get('driveFolderUrl') || '').trim(), driveApiKey: String(fd.get('driveApiKey') || '').trim(),
          });
          toast('success', 'People & Drive settings saved');
          break;
        }
        default:
          if (window.MEETINGS_CHORES && kind.startsWith('chore-')) await MEETINGS_CHORES.onSubmit(f, fd);
          else if (window.MEETINGS_LIVE && kind.startsWith('live-')) await MEETINGS_LIVE.onSubmit(f, fd);
      }
    } catch (e) {
      console.warn('[meetings] form failed', kind, e);
      toast('error', (e && e.code === 'permission-denied') ? 'You don’t have permission to do that.' : 'Save failed: ' + (e && e.message));
    }
  });

  /* ─── drag & drop on the coordinator board ──────────────────── */
  let drag = null;
  root.addEventListener('dragstart', ev => {
    const card = ev.target.closest('.mtg-pcard[draggable="true"]');
    if (!card || !isCoordinator()) return;
    drag = { uid: card.dataset.uid, from: card.dataset.from, slot: card.dataset.slot != null ? +card.dataset.slot : null };
    card.classList.add('mtg-dragging');
    ev.dataTransfer.effectAllowed = 'move';
    try { ev.dataTransfer.setData('text/plain', drag.uid); } catch (e) { /* */ }
  });
  root.addEventListener('dragend', ev => { const c = ev.target.closest('.mtg-pcard'); if (c) c.classList.remove('mtg-dragging'); drag = null; root.querySelectorAll('.mtg-drop-over').forEach(x => x.classList.remove('mtg-drop-over')); });
  root.addEventListener('dragover', ev => {
    if (!drag) return;
    const slot = ev.target.closest('[data-drop-mid]'); const pool = ev.target.closest('.mtg-pool');
    if (slot || (pool && drag.from !== 'pool')) { ev.preventDefault(); (slot || pool).classList.add('mtg-drop-over'); }
  });
  root.addEventListener('dragleave', ev => { const t = ev.target.closest('[data-drop-mid], .mtg-pool'); if (t) t.classList.remove('mtg-drop-over'); });
  root.addEventListener('drop', async ev => {
    if (!drag) return;
    ev.preventDefault();
    const d = drag; drag = null;
    root.querySelectorAll('.mtg-drop-over').forEach(x => x.classList.remove('mtg-drop-over'));
    const slot = ev.target.closest('[data-drop-mid]'); const pool = ev.target.closest('.mtg-pool');
    try {
      if (pool && d.from !== 'pool') { await unassignSlot(d.from, d.uid); return; }
      if (!slot) return;
      const mid = slot.dataset.dropMid, s = +slot.dataset.dropSlot;
      if (d.from === 'pool') {
        const m = meeting(mid);
        if (presentersOf(m).some(p => p.uid === d.uid)) { toast('info', firstName(d.uid) + ' is already on ' + fmtDate(m.date)); return; }
        const occupied = presentersOf(m).some(p => p.slot === s);
        await assignSlot(mid, d.uid, occupied ? freeSlot(m) : s);
        if (occupied && freeSlot(m) == null) toast('info', 'No free slot — ' + firstName(d.uid) + ' was not added');
      } else {
        if (d.from === mid && d.slot === s) return;
        await movePresenter(d.from, d.uid, mid, s);
      }
    } catch (e) { toast('error', (e && e.code === 'permission-denied') ? 'You don’t have permission to do that.' : 'Failed: ' + (e && e.message)); }
  });

  /* ═══════════════════════════════════════════════════════════════
     BOOT
     ═══════════════════════════════════════════════════════════════ */
  (async function boot() {
    if (typeof firebridge === 'undefined') { root.innerHTML = '<div class="mtg-empty">Firebase bridge not loaded.</div>'; return; }
    if (firebridge.requireSignIn) await firebridge.requireSignIn();
    state.user = firebridge.getUser ? firebridge.getUser() : null;
    state.profile = firebridge.getProfile ? firebridge.getProfile() : null;
    if (!state.user) return; // pending-access overlay handled by firebridge
    if (firebridge.loadAccessGrant) { try { await firebridge.loadAccessGrant(); } catch (e) { /* */ } }
    const hash = (location.hash || '').replace('#', '');
    if (SECTIONS.some(s => s.id === hash)) state.section = hash;
    root.innerHTML = '<div class="mtg-empty">Loading…</div>';
    await loadMembers();
    subscribeAll();
    render();
    if (firebridge.onAuth) {
      firebridge.onAuth(() => {
        const prev = state.profile && state.profile.role;
        state.user = firebridge.getUser ? firebridge.getUser() : state.user;
        state.profile = firebridge.getProfile ? firebridge.getProfile() : state.profile;
        if ((state.profile && state.profile.role) !== prev) render();
      });
    }
    window.addEventListener('beforeunload', () => unsubs.forEach(u => { try { u(); } catch (e) { /* */ } }));
  })();

  /* ─── surface for meetings-live.js / meetings-chores.js ─────── */
  window.MEETINGS = {
    state, cfg, SECTIONS, AGENDA_TYPE_LABEL, KIND_LABEL, REACTIONS, PATHS,
    db, FV, invalidate, setPath, DEL, toFirestore, parseDate, toDateStr, dowName, busyAttr,   // V3.938 — for meetings-one-on-one.js
    esc, icon, toast, avatar, me, myName, memberName, firstName, member,
    isAdmin, isCoordinator, isReviewer, reviewerUids, rosterMembers, presenterPool, canPresent, assignees, attends,
    todayStr, fmtDate, fmtDateLong, fmtDateShort, fmtTime, fmtRange, addMinutes, addDays, daysUntil, weekIdFor, mondayOfWeekId, weekStart, isoNow, newId,
    meeting, nextMeeting, previousMeeting, presentersOf, isPresenter, presenterNames, agendaOf, agendaTimed, agendaTotal,
    updatesOf, minutesOf, actionItemsOf, feedbackOf, kindOf, isBreak, submittersFor, submitDue, reviewDue,
    updateMeeting, patchFields, setStatus, addActionItem, setActionItemStatus, removeActionItem,
    choreWeekId, choreDoc, meetingForWeek, ensureChoreDoc, assignChore, tickChore, fillRest, myChoresThisWeek,
    openMemberPicker, openConfirm, openActionItemSheet, sheet,
    render, scheduleRender,
  };
})();
