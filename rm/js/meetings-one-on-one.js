/* meetings-one-on-one.js — One-on-ones tab on Lab Meetings (V3.938).
 *
 * The PI (or anyone who is somebody's mentor — users/{uid}.mentor_uids)
 * OFFERS recurring times; a student SUBSCRIBES to one and has it every week
 * (or every other week) until the semester ends. One doc per recurring time:
 *
 *   oneOnOneSlots/{id}  hostUid, weekday 0–6, time 'HH:MM', duration, cadence
 *                       weekly|biweekly, location, note, startDate (first
 *                       occurrence + fortnight anchor), endDate|null, active,
 *                       subscriberUid|null (+ subscriberName / subscribedAt /
 *                       subscribedBy 'self'|'host'), skips{ 'YYYY-MM-DD': {by,
 *                       name, reason, at} }, updatedBy, lastReminded (function).
 *
 * "Subscribe" is the student writing THEIR OWN uid into subscriberUid on an
 * open, active slot — the rule allows exactly that (and the subscriber
 * releasing it or adding a skip), the host or an admin anything. The calendar
 * and the .ics file (RRULE + EXDATE) are both derived from the slot; nothing
 * is materialised per week. Reminders + the "Gabe subscribed" notices live in
 * functions/meetings.js (onOneOnOneSlotWritten, planOneOnOneReminders).
 *
 * Who sees what: a student sees their own one-on-ones plus OPEN times from
 * their hosts (the PI + their mentors); a host sees everything they host; an
 * admin may flip to Everyone. Reads only the window.MEETINGS surface.
 */
(function () {
  'use strict';

  const M = () => window.MEETINGS;
  const esc = s => M().esc(s);
  const icon = (n, o) => M().icon(n, o);
  const pad = n => String(n).padStart(2, '0');

  const PATH = 'meetings/one-on-ones.json';
  const COLL = 'oneOnOneSlots';
  const CADENCE = { weekly: 'Every week', biweekly: 'Every other week' };
  const DURATIONS = [15, 20, 30, 45, 60];
  const MAX_BACK_TO_BACK = 6;
  const PAGE_URL = 'https://mcgheelab.com/rm/pages/meetings.html#oneonone';
  const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

  /* ═══ people ══════════════════════════════════════════════════ */
  function piUids() {
    const A = M();
    const ids = new Set(A.reviewerUids());
    A.state.members.forEach(u => { if (u.category === 'pi') ids.add(u.uid); });
    return Array.from(ids);
  }
  /* users/{uid}.mentor_uids — the field Permissions → Mentors and Team Focus write */
  function mentorsOf(uid) {
    const A = M();
    const u = A.member(uid);
    let ids = u && Array.isArray(u.mentor_uids) ? u.mentor_uids : null;
    if (!ids && uid === A.me() && A.state.profile && Array.isArray(A.state.profile.mentor_uids)) ids = A.state.profile.mentor_uids;
    return ids || [];
  }
  function menteesOf(uid) {
    return M().state.members.filter(u => Array.isArray(u.mentor_uids) && u.mentor_uids.includes(uid));
  }
  /* the people the signed-in user may meet with: the PI(s) + their mentors */
  function myHosts() {
    const A = M();
    const me = A.me();
    const ids = new Set(piUids().concat(mentorsOf(me)));
    ids.delete(me);
    return Array.from(ids);
  }
  function canHost(uid) {
    const A = M();
    uid = uid || A.me();
    if (!uid) return false;
    if (uid === A.me() && A.isAdmin()) return true;
    return piUids().includes(uid) || menteesOf(uid).length > 0;
  }
  function hostRole(uid) {
    if (piUids().includes(uid)) return 'the PI';
    if (mentorsOf(M().me()).includes(uid)) return 'your mentor';
    return '';
  }
  /* who a host may reserve a time for: the PI → the meeting roster; a mentor → their mentees */
  function reservePool(hostUid) {
    const A = M();
    const pi = piUids().includes(hostUid) || (hostUid === A.me() && A.isAdmin());
    const list = pi ? A.rosterMembers() : menteesOf(hostUid);
    return list.filter(u => u.uid !== hostUid);
  }

  /* ═══ occurrence math — mirrored in functions/meetings.js ═════ */
  function weekdayOf(ds) { return M().parseDate(ds).getDay(); }
  /* null = no meeting that day · 'on' · 'skipped' */
  function occursOn(s, ds) {
    const A = M();
    if (!s || s.active === false || !s.startDate || s.weekday == null) return null;
    if (ds < s.startDate) return null;
    if (s.endDate && ds > s.endDate) return null;
    if (weekdayOf(ds) !== +s.weekday) return null;
    if (s.cadence === 'biweekly') {
      // anchor = the first occurrence on/after startDate (same weekday as ds, so whole weeks apart)
      const w = Math.round((A.parseDate(ds) - A.parseDate(firstOnOrAfter(s.startDate, +s.weekday))) / (7 * 86400000));
      if (w % 2) return null;
    }
    return (s.skips && s.skips[ds]) ? 'skipped' : 'on';
  }
  function nextOccurrence(s, from) {
    const A = M();
    let d = from || A.todayStr();
    for (let i = 0; i < 120; i++) { if (occursOn(s, d) === 'on') return d; d = A.addDays(d, 1); }
    return null;
  }
  /* the next n dates (skipped ones included, flagged) */
  function upcoming(s, n) {
    const A = M();
    const out = [];
    let d = A.todayStr();
    for (let i = 0; i < 200 && out.length < n; i++) {
      const o = occursOn(s, d);
      if (o) out.push({ date: d, skipped: o === 'skipped' });
      d = A.addDays(d, 1);
    }
    return out;
  }
  function firstOnOrAfter(from, weekday) {
    const A = M();
    let d = from;
    for (let i = 0; i < 7; i++) { if (weekdayOf(d) === weekday) return d; d = A.addDays(d, 1); }
    return from;
  }
  function tShort(hhmm) {
    const [h, m] = String(hhmm || '0:0').split(':').map(Number);
    return ((h % 12) || 12) + (m ? ':' + pad(m) : '') + (h >= 12 ? 'p' : 'a');
  }
  function dowPlural(wd) { return M().dowName(+wd) + 's'; }
  function cadenceLabel(s) { return CADENCE[s.cadence] || CADENCE.weekly; }
  function repeatLine(s) {
    const A = M();
    return cadenceLabel(s) + ' from ' + A.fmtDateShort(s.startDate) + (s.endDate ? ' to ' + A.fmtDateShort(s.endDate) : '');
  }

  /* ═══ slots ═══════════════════════════════════════════════════ */
  function all() { return M().state.slots || []; }
  function slot(id) { return all().find(s => s.id === id) || null; }
  function isHostOf(s) { const A = M(); return !!s && (s.hostUid === A.me() || A.isAdmin()); }
  function isMine(s) { return !!s && !!s.subscriberUid && s.subscriberUid === M().me(); }
  function mayTake(s) { return !!s && s.active !== false && !s.subscriberUid && s.hostUid !== M().me() && myHosts().includes(s.hostUid); }
  function ord(wd) { return (+wd + 6) % 7; }                       // Monday-first
  function sortSlots(list) {
    return list.slice().sort((a, b) => (ord(a.weekday) - ord(b.weekday)) || String(a.time).localeCompare(String(b.time)) || String(a.hostName || '').localeCompare(String(b.hostName || '')));
  }
  function visible() {
    const A = M();
    const me = A.me();
    const act = all().filter(s => s.active !== false);
    if (A.state.ui.ooFilter === 'all' && A.isAdmin()) return act;
    const hosts = new Set(myHosts());
    return act.filter(s => s.hostUid === me || s.subscriberUid === me || (!s.subscriberUid && hosts.has(s.hostUid)));
  }
  function mine() { return sortSlots(all().filter(s => s.active !== false && isMine(s))); }
  function hosted() { return sortSlots(all().filter(s => s.hostUid === M().me() && s.active !== false)); }
  function ended() { return sortSlots(all().filter(s => s.active === false && isHostOf(s))); }
  function openFromMyHosts() {
    const hosts = new Set(myHosts());
    return all().filter(s => s.active !== false && !s.subscriberUid && hosts.has(s.hostUid));
  }
  /* tab badge: a host of yours has an open time and you have nothing with them */
  function badge() {
    const A = M();
    if (!A.state.loaded.slots || !A.state.loaded.users) return 0;
    const have = new Set(mine().map(s => s.hostUid));
    return openFromMyHosts().some(s => !have.has(s.hostUid)) ? 1 : 0;
  }
  function whoLabel(s) {
    const A = M();
    if (s.hostUid === A.me()) return s.subscriberUid ? 'with ' + A.firstName(s.subscriberUid, s.subscriberName) : 'open';
    return 'with ' + A.firstName(s.hostUid, s.hostName);
  }

  /* ═══ writes ══════════════════════════════════════════════════ */
  function col() { return M().db().collection(COLL); }
  async function patchSlot(id, patch) {
    const A = M();
    const s = slot(id);
    if (s) Object.keys(patch).forEach(k => A.setPath(s, k, patch[k]));      // optimistic
    A.scheduleRender();
    const fs = {};
    Object.keys(patch).forEach(k => { fs[k] = A.toFirestore(patch[k]); });
    fs.updatedBy = A.me();
    fs.updatedAt = A.FV().serverTimestamp();
    await col().doc(id).update(fs);
    A.invalidate(PATH);
  }
  async function createSlots(f) {
    const A = M();
    const me = A.me();
    const b = A.db().batch();
    const ts = A.FV().serverTimestamp();
    const n = Math.max(1, Math.min(MAX_BACK_TO_BACK, +f.count || 1));
    const duration = +f.duration || 30;
    const start = firstOnOrAfter(f.startDate || A.todayStr(), +f.weekday);
    const ids = [];
    for (let i = 0; i < n; i++) {
      const ref = col().doc();
      const doc = {
        hostUid: me, hostName: A.myName(),
        weekday: +f.weekday, time: A.addMinutes(f.time, i * duration), duration,
        cadence: f.cadence === 'biweekly' ? 'biweekly' : 'weekly',
        location: f.location || '', note: f.note || '',
        startDate: start, endDate: f.endDate || null, active: true,
        subscriberUid: null, subscriberName: '', subscribedAt: null, subscribedBy: null, skips: {},
        createdBy: me, updatedBy: me, createdAt: ts, updatedAt: ts,
      };
      if (i === 0 && f.reserveUid) {
        Object.assign(doc, { subscriberUid: f.reserveUid, subscriberName: A.memberName(f.reserveUid), subscribedAt: A.isoNow(), subscribedBy: 'host' });
      }
      b.set(ref, doc);
      ids.push(ref.id);
      A.state.slots.push(Object.assign({ id: ref.id }, doc, { createdAt: null, updatedAt: null }));   // optimistic; the snapshot replaces it
    }
    await b.commit();
    A.invalidate(PATH);
    A.render();
    return ids;
  }
  async function editSlot(id, f) {
    await patchSlot(id, {
      weekday: +f.weekday, time: f.time, duration: +f.duration || 30,
      cadence: f.cadence === 'biweekly' ? 'biweekly' : 'weekly',
      location: f.location || '', note: f.note || '',
      startDate: firstOnOrAfter(f.startDate || M().todayStr(), +f.weekday), endDate: f.endDate || null,
    });
  }
  async function subscribe(id) {
    const A = M();
    await patchSlot(id, { subscriberUid: A.me(), subscriberName: A.myName(), subscribedAt: A.isoNow(), subscribedBy: 'self' });
  }
  async function unsubscribe(id) {
    await patchSlot(id, { subscriberUid: null, subscriberName: '', subscribedAt: null, subscribedBy: null });
  }
  async function reserve(id, uid) {
    const A = M();
    if (!uid) return unsubscribe(id);
    await patchSlot(id, { subscriberUid: uid, subscriberName: A.memberName(uid), subscribedAt: A.isoNow(), subscribedBy: 'host' });
  }
  async function skipDate(id, date, reason) {
    const A = M();
    const p = {};
    p['skips.' + date] = { by: A.me(), name: A.myName(), reason: reason || '', at: A.isoNow() };
    await patchSlot(id, p);
  }
  async function unskipDate(id, date) {
    const p = {};
    p['skips.' + date] = M().DEL();
    await patchSlot(id, p);
  }
  async function endSlot(id) {
    const A = M();
    await patchSlot(id, { active: false, endDate: A.todayStr(), endedAt: A.isoNow() });
  }
  async function removeSlot(id) {
    const A = M();
    A.state.slots = A.state.slots.filter(s => s.id !== id);
    A.scheduleRender();
    await col().doc(id).delete();
    A.invalidate(PATH);
  }

  /* ═══ .ics — RRULE + EXDATE, Phoenix has no DST ═══════════════ */
  function icsText(s) {
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }
  function icsFor(s) {
    const A = M();
    const dt = (ds, hhmm) => ds.replace(/-/g, '') + 'T' + String(hhmm).replace(':', '') + '00';
    const host = A.firstName(s.hostUid, s.hostName);
    const student = s.subscriberUid ? A.firstName(s.subscriberUid, s.subscriberName) : '';
    const title = student ? 'One-on-one: ' + student + ' & ' + host : 'One-on-one with ' + host + ' (open)';
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//McGhee Lab//Ourlab one-on-ones//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      'UID:oneonone-' + s.id + '@mcgheelab.com',
      'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''),
      'DTSTART;TZID=America/Phoenix:' + dt(s.startDate, s.time),
      'DTEND;TZID=America/Phoenix:' + dt(s.startDate, A.addMinutes(s.time, s.duration)),
      'RRULE:FREQ=WEEKLY;INTERVAL=' + (s.cadence === 'biweekly' ? 2 : 1) + ';BYDAY=' + BYDAY[+s.weekday] +
        (s.endDate ? ';UNTIL=' + A.addDays(s.endDate, 1).replace(/-/g, '') + 'T065959Z' : ''),
    ];
    const ex = Object.keys(s.skips || {}).sort();
    if (ex.length) lines.push('EXDATE;TZID=America/Phoenix:' + ex.map(d => dt(d, s.time)).join(','));
    lines.push(
      'SUMMARY:' + icsText(title),
      'LOCATION:' + icsText(s.location || ''),
      'DESCRIPTION:' + icsText((s.note ? s.note + '\n' : '') + 'Weekly one-on-one from the McGhee Lab meetings page. Changes and skipped weeks are kept there: ' + PAGE_URL),
      'URL:' + PAGE_URL,
      'END:VEVENT', 'END:VCALENDAR');
    return lines.join('\r\n') + '\r\n';
  }
  function downloadIcs(s) {
    const A = M();
    if (!s) return;
    try {
      const blob = new Blob([icsFor(s)], { type: 'text/calendar;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'one-on-one-' + A.firstName(s.hostUid, s.hostName).toLowerCase() + '-' + dowPlural(s.weekday).toLowerCase() + '.ics';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      A.toast('success', 'Calendar file downloaded — open it to add the recurring meeting to your calendar');
    } catch (e) {
      A.toast('warn', 'Could not build the calendar file: ' + (e && e.message));
    }
  }

  /* ═══ render ══════════════════════════════════════════════════ */
  function monthKey() { const A = M(); return A.state.ui.ooMonth || A.todayStr().slice(0, 7); }
  function shiftMonth(ym, n) {
    const p = ym.split('-').map(Number);
    const d = new Date(p[0], p[1] - 1 + n, 1);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }
  function monthLabel(ym) {
    const p = ym.split('-').map(Number);
    return new Date(p[0], p[1] - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  /* Monday-first grid covering the whole month — the My Week orientation */
  function gridDays(ym) {
    const A = M();
    const first = ym + '-01';
    const d0 = A.parseDate(first);
    const last = ym + '-' + pad(new Date(d0.getFullYear(), d0.getMonth() + 1, 0).getDate());
    let d = A.weekStart(first);
    const end = A.addDays(A.weekStart(last), 6);
    const out = [];
    while (d <= end && out.length < 42) { out.push({ date: d, inMonth: d.slice(0, 7) === ym }); d = A.addDays(d, 1); }
    return out;
  }

  function render() {
    const A = M();
    if (!A.state.loaded.slots || !A.state.loaded.users) return '<div class="mtg-empty">Loading…</div>';
    const admin = A.isAdmin();
    const host = canHost();
    const ym = monthKey();
    const list = sortSlots(visible());
    const toolbar = '<div class="mtg-toolbar">' +
      '<div class="mtg-seg oo-monthnav">' +
        '<button type="button" data-act="oo-month" data-dir="-1" title="Previous month" aria-label="Previous month">' + icon('chevron-left', { size: 'sm' }) + '</button>' +
        '<button type="button" class="on" data-act="oo-month" data-dir="0" title="Back to this month">' + esc(monthLabel(ym)) + '</button>' +
        '<button type="button" data-act="oo-month" data-dir="1" title="Next month" aria-label="Next month">' + icon('chevron-right', { size: 'sm' }) + '</button>' +
      '</div>' +
      '<div class="mtg-toolbar-right">' +
        (admin ? '<div class="mtg-seg"><button type="button" class="' + (A.state.ui.ooFilter === 'all' ? '' : 'on') + '" data-act="oo-filter" data-val="mine">Mine</button><button type="button" class="' + (A.state.ui.ooFilter === 'all' ? 'on' : '') + '" data-act="oo-filter" data-val="all">Everyone</button></div>' : '') +
        (host ? '<button type="button" class="mtg-btn mtg-btn-sm mtg-btn-primary" data-act="oo-offer">' + icon('plus', { size: 'sm' }) + ' Offer a time</button>' : '') +
      '</div></div>';
    return renderMine(true) + toolbar + renderCalendar(ym, list) + renderPattern(list) + renderEnded();
  }

  function renderCalendar(ym, list) {
    const A = M();
    const today = A.todayStr();
    const days = gridDays(ym);
    const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => '<span>' + d + '</span>').join('');
    const cells = days.map(d => {
      const chips = list.map(s => { const o = occursOn(s, d.date); return o ? chip(s, d.date, o) : ''; }).join('');
      return '<div class="oo-day' + (d.inMonth ? '' : ' oo-day-out') + (d.date === today ? ' oo-day-today' : '') + (d.date < today ? ' oo-day-past' : '') + '" data-date="' + d.date + '">' +
        '<span class="oo-day-n">' + (+d.date.slice(8)) + '</span>' + chips + '</div>';
    }).join('');
    return '<section class="mtg-card oo-cal"><div class="oo-dow">' + dow + '</div><div class="oo-grid">' + cells + '</div>' +
      '<p class="mtg-muted mtg-tiny mtg-legend">Solid = booked · dashed = open, tap to subscribe · struck through = skipped that week.</p></section>';
  }
  function chip(s, date, o) {
    const A = M();
    const me = A.me();
    const iHost = s.hostUid === me;
    let label;
    if (iHost) label = s.subscriberUid ? A.firstName(s.subscriberUid, s.subscriberName) : 'open';
    else if (isMine(s)) label = A.firstName(s.hostUid, s.hostName);
    else if (s.subscriberUid) label = A.firstName(s.subscriberUid, s.subscriberName) + ' · ' + A.firstName(s.hostUid, s.hostName);
    else label = 'open · ' + A.firstName(s.hostUid, s.hostName);
    const title = A.fmtRange(s.time, s.duration) + ' · ' + A.memberName(s.hostUid, s.hostName) +
      (s.subscriberUid ? ' with ' + A.memberName(s.subscriberUid, s.subscriberName) : ' — open') +
      (o === 'skipped' ? ' · skipped' + (s.skips[date] && s.skips[date].reason ? ': ' + s.skips[date].reason : '') : '');
    const cls = 'oo-chip' + (!s.subscriberUid ? ' oo-chip-open' : '') + (isMine(s) ? ' oo-chip-me' : '') + (o === 'skipped' ? ' oo-chip-skip' : '');
    return '<button type="button" class="' + cls + '" data-act="oo-open" data-id="' + esc(s.id) + '" data-date="' + date + '" title="' + esc(title) + '">' + esc(tShort(s.time)) + ' ' + esc(label) + '</button>';
  }

  function renderPattern(list) {
    const A = M();
    const me = A.me();
    const host = canHost();
    let body;
    if (!list.length) {
      const hosts = myHosts();
      body = '<p class="mtg-muted">' + (host
        ? 'You haven’t offered any one-on-one times yet. “Offer a time” above puts a recurring slot on the calendar for your students to take.'
        : hosts.length
          ? 'No one-on-one times offered yet by ' + esc(hosts.map(u => A.memberName(u)).join(' or ')) + '. You’ll see them here the moment they appear.'
          : 'Nobody is listed as your mentor yet, and the PI hasn’t offered times. Ask Alex to set your mentor in Settings → Permissions.') + '</p>';
    } else {
      const groups = {};
      list.forEach(s => { (groups[ord(s.weekday)] = groups[ord(s.weekday)] || []).push(s); });
      body = Object.keys(groups).sort((a, b) => a - b).map(k => {
        const rows = groups[k];
        return '<h4 class="oo-wd">' + esc(dowPlural(rows[0].weekday)) + '</h4>' + rows.map(s => {
          const iHost = s.hostUid === me;
          const tools = [];
          if (mayTake(s)) tools.push('<button type="button" class="mtg-btn mtg-btn-xs mtg-btn-primary" data-act="oo-subscribe" data-id="' + esc(s.id) + '">Subscribe</button>');
          if (isMine(s)) tools.push('<button type="button" class="mtg-iconbtn" data-act="oo-ics" data-id="' + esc(s.id) + '" title="Add to my calendar (.ics)">' + icon('arrow-down-tray', { size: 'sm' }) + '</button>');
          if (isHostOf(s)) tools.push('<button type="button" class="mtg-btn mtg-btn-xs' + (s.subscriberUid ? '' : ' mtg-btn-primary') + '" data-act="oo-reserve" data-id="' + esc(s.id) + '">' + (s.subscriberUid ? 'Change' : icon('plus', { size: 'xs' }) + ' Reserve for…') + '</button>');
          tools.push('<button type="button" class="mtg-btn mtg-btn-xs mtg-btn-ghost" data-act="oo-open" data-id="' + esc(s.id) + '">Details</button>');
          return '<div class="oo-row' + (isMine(s) ? ' oo-row-me' : '') + (!s.subscriberUid ? ' oo-row-open' : '') + '">' +
            '<span class="oo-row-time"><b>' + esc(A.fmtRange(s.time, s.duration)) + '</b><small>' + esc(cadenceLabel(s)) + (s.endDate ? ' · until ' + esc(A.fmtDateShort(s.endDate)) : '') + '</small></span>' +
            '<span class="oo-row-who">' + A.avatar(s.hostUid, s.hostName) + ' <span>' + esc(A.memberName(s.hostUid, s.hostName)) + (iHost ? ' <span class="mtg-you">you</span>' : '') + '</span>' +
              '<span class="oo-arrow">' + icon('chevron-right', { size: 'xs' }) + '</span>' +
              (s.subscriberUid ? A.avatar(s.subscriberUid, s.subscriberName) + ' <span>' + esc(A.memberName(s.subscriberUid, s.subscriberName)) + (isMine(s) ? ' <span class="mtg-you">you</span>' : '') + '</span>'
                               : '<span class="mtg-chip mtg-chip-muted">open</span>') +
            '</span>' +
            '<span class="oo-row-loc">' + (s.location ? icon('map-pin', { size: 'xs' }) + ' ' + esc(s.location) : '') + '</span>' +
            '<span class="oo-row-tools">' + tools.join('') + '</span>' +
          '</div>';
        }).join('');
      }).join('');
    }
    return '<section class="mtg-card"><h3 class="mtg-h3">' + icon('arrow-path', { size: 'sm' }) + ' Weekly pattern <span class="mtg-h3-sub">' +
      (A.isAdmin() && A.state.ui.ooFilter === 'all' ? 'every recurring one-on-one in the lab' : 'the recurring times you’re part of, and the open ones you can take') + '</span></h3>' + body + '</section>';
  }

  function renderEnded() {
    const A = M();
    const list = ended();
    if (!list.length) return '';
    return '<details class="mtg-card mtg-details"><summary>Ended one-on-ones (' + list.length + ')</summary>' +
      list.map(s => '<div class="oo-row"><span class="oo-row-time"><b>' + esc(dowPlural(s.weekday)) + ' ' + esc(A.fmtRange(s.time, s.duration)) + '</b><small>' + esc(repeatLine(s)) + '</small></span>' +
        '<span class="oo-row-who">' + esc(A.memberName(s.hostUid, s.hostName)) + ' <span class="oo-arrow">' + icon('chevron-right', { size: 'xs' }) + '</span> ' + esc(s.subscriberUid ? A.memberName(s.subscriberUid, s.subscriberName) : 'open') + '</span>' +
        '<span></span><span class="oo-row-tools"><button type="button" class="mtg-iconbtn mtg-danger" data-act="oo-delete" data-id="' + esc(s.id) + '" title="Delete">' + icon('trash', { size: 'sm' }) + '</button></span></div>').join('') +
      '</details>';
  }

  /* The summary card — the tab's first block, and My items' one-on-one block */
  function renderMine(inTab) {
    const A = M();
    if (!A.state.loaded.slots || !A.state.loaded.users) return inTab ? '' : '<section class="mtg-card"><h3 class="mtg-h3">' + icon('user-group', { size: 'sm' }) + ' My one-on-ones</h3><p class="mtg-muted">Loading…</p></section>';
    const my = mine();
    const hostedRows = hosted();
    const open = openFromMyHosts();
    const parts = [];
    my.forEach(s => {
      const next = nextOccurrence(s);
      const role = hostRole(s.hostUid);
      parts.push('<div class="oo-mine"><div>' +
        '<b>' + esc(cadenceLabel(s) === CADENCE.weekly ? 'Every ' + A.dowName(+s.weekday) : 'Every other ' + A.dowName(+s.weekday)) + ' ' + esc(A.fmtRange(s.time, s.duration)) + '</b> with <b>' + esc(A.memberName(s.hostUid, s.hostName)) + '</b>' + (role ? ' <span class="mtg-muted">(' + esc(role) + ')</span>' : '') +
        '<div class="mtg-muted mtg-tiny">' + (s.location ? esc(s.location) + ' · ' : '') + (next ? 'next ' + esc(A.fmtDate(next)) : s.endDate && s.endDate < A.todayStr() ? 'finished ' + esc(A.fmtDateShort(s.endDate)) : 'no upcoming date') +
          (s.note ? ' · ' + esc(s.note) : '') + '</div></div>' +
        '<div class="mtg-row-actions" style="margin:0">' +
          '<button type="button" class="mtg-btn mtg-btn-sm" data-act="oo-ics" data-id="' + esc(s.id) + '">' + icon('arrow-down-tray', { size: 'sm' }) + ' Add to calendar</button>' +
          '<button type="button" class="mtg-btn mtg-btn-sm mtg-btn-ghost" data-act="oo-open" data-id="' + esc(s.id) + '">' + icon('no-symbol', { size: 'sm' }) + ' Can’t make a date</button>' +
          '<button type="button" class="mtg-btn mtg-btn-sm mtg-btn-ghost" data-act="oo-unsubscribe" data-id="' + esc(s.id) + '">Unsubscribe</button>' +
        '</div></div>');
    });
    if (hostedRows.length) {
      const booked = hostedRows.filter(s => s.subscriberUid), free = hostedRows.filter(s => !s.subscriberUid);
      parts.push('<div class="oo-mine"><div><b>You host ' + hostedRows.length + ' recurring time' + (hostedRows.length === 1 ? '' : 's') + '</b>' +
        '<div class="mtg-muted mtg-tiny">' + booked.map(s => esc(A.dowName(+s.weekday).slice(0, 3) + ' ' + tShort(s.time) + ' ' + A.firstName(s.subscriberUid, s.subscriberName))).join(' · ') +
          (free.length ? (booked.length ? ' · ' : '') + free.length + ' open' : '') + '</div></div>' +
        (inTab ? '' : '<a class="mtg-btn mtg-btn-sm" href="#" data-act="tab" data-id="oneonone">Open the calendar</a>') + '</div>');
    }
    if (!my.length) {
      const have = new Set();
      const openHosts = Array.from(new Set(open.map(s => s.hostUid))).filter(u => !have.has(u));
      if (openHosts.length) {
        parts.push('<div class="oo-mine"><div>' + icon('information-circle', { size: 'sm' }) + ' <b>' + esc(openHosts.map(u => A.memberName(u)).join(' and ')) + '</b> ' + (openHosts.length === 1 ? 'has' : 'have') + ' open one-on-one times — ' +
          (inTab ? 'pick one below.' : '<a href="#" data-act="tab" data-id="oneonone">pick one</a>.') + '</div></div>');
      } else if (!hostedRows.length) {
        const hosts = myHosts();
        parts.push('<p class="mtg-muted">' + (hosts.length ? 'No one-on-one times offered yet by ' + esc(hosts.map(u => A.memberName(u)).join(' or ')) + '.' : 'No mentor listed for you yet, and no PI times offered.') + '</p>');
      }
    }
    return '<section class="mtg-card"><h3 class="mtg-h3">' + icon('user-group', { size: 'sm' }) + ' My one-on-ones' +
      (inTab ? ' <span class="mtg-h3-sub">a recurring meeting with the PI or your mentor</span>' : '') + '</h3>' + parts.join('') + '</section>';
  }

  /* ═══ sheets ══════════════════════════════════════════════════ */
  function lastLocation() {
    const h = hosted();
    return h.length ? (h[h.length - 1].location || '') : '';
  }
  function openOfferSheet(existingId) {
    const A = M();
    const s = existingId ? slot(existingId) : null;
    if (existingId && !s) return;
    const c = A.cfg();
    const today = A.todayStr();
    const wd = weekdayOf(today);
    const v = s || { weekday: (wd >= 1 && wd <= 5) ? wd : 2, time: '14:00', duration: 30, cadence: 'weekly', location: lastLocation(), startDate: today, endDate: c.semesterEnd && c.semesterEnd >= today ? c.semesterEnd : '', note: '' };
    const pool = s ? [] : reservePool(A.me());
    A.sheet({ title: s ? 'Edit one-on-one time' : 'Offer a one-on-one time', build(body, api) {
      body.innerHTML = '<form class="mtg-form" id="oo-offer-form"><div class="mtg-grid2">' +
        '<label>Day<select name="weekday">' + [1, 2, 3, 4, 5, 6, 0].map(i => '<option value="' + i + '"' + (i === +v.weekday ? ' selected' : '') + '>' + esc(dowPlural(i)) + '</option>').join('') + '</select></label>' +
        '<label>Start<input type="time" name="time" value="' + esc(v.time) + '" required></label>' +
        '<label>Length<select name="duration">' + DURATIONS.map(d => '<option value="' + d + '"' + (d === +v.duration ? ' selected' : '') + '>' + d + ' min</option>').join('') + '</select></label>' +
        '<label>Repeats<select name="cadence">' + Object.keys(CADENCE).map(k => '<option value="' + k + '"' + (k === (v.cadence || 'weekly') ? ' selected' : '') + '>' + esc(CADENCE[k]) + '</option>').join('') + '</select></label>' +
        '<label>Where<input type="text" name="location" value="' + esc(v.location || '') + '" placeholder="Office, BSRL 100, Zoom link…" maxlength="120"></label>' +
        (s ? '' : '<label>Back-to-back slots<select name="count">' + [1, 2, 3, 4, 5, 6].map(n => '<option value="' + n + '">' + n + (n === 1 ? ' — just this one' : ' in a row') + '</option>').join('') + '</select></label>') +
        '<label>From<input type="date" name="startDate" value="' + esc(v.startDate || today) + '"></label>' +
        '<label>Until <small>(blank = no end)</small><input type="date" name="endDate" value="' + esc(v.endDate || '') + '"></label>' +
        '</div>' +
        '<label>Note for the student <small>(optional)</small><input type="text" name="note" value="' + esc(v.note || '') + '" maxlength="200" placeholder="e.g. bring your latest figures"></label>' +
        (pool.length ? '<label>Reserve for<select name="reserveUid"><option value="">Open — any of your students can take it</option>' + pool.map(u => '<option value="' + esc(u.uid) + '">' + esc(u.name || u.email) + '</option>').join('') + '</select></label>' : '') +
        '<p class="mtg-muted mtg-tiny">' + (s ? 'The student subscribed to it is told about the change.' : 'Your students see open times on this tab and subscribe themselves. Reserving puts a student straight on the calendar and tells them. Back-to-back slots start one after another from the start time.') + '</p>' +
        '<div class="mtg-row-actions"><button type="submit" class="mtg-btn mtg-btn-primary">' + (s ? 'Save' : 'Offer') + '</button><button type="button" class="mtg-btn mtg-cancel">Cancel</button></div></form>';
      body.querySelector('.mtg-cancel').addEventListener('click', () => api.close());
      body.querySelector('form').addEventListener('submit', async ev => {
        ev.preventDefault();
        const f = ev.target;
        const fields = {
          weekday: +f.weekday.value, time: f.time.value, duration: +f.duration.value, cadence: f.cadence.value,
          location: f.location.value.trim(), note: f.note.value.trim(), startDate: f.startDate.value || today, endDate: f.endDate.value || null,
          count: f.count ? +f.count.value : 1, reserveUid: f.reserveUid ? f.reserveUid.value : '',
        };
        if (fields.endDate && fields.endDate < fields.startDate) { A.toast('warn', 'The end date is before the start date'); return; }
        api.close();
        try {
          if (s) { await editSlot(s.id, fields); A.toast('success', 'Time updated'); }
          else {
            const ids = await createSlots(fields);
            A.toast('success', ids.length === 1 ? 'Time offered — ' + dowPlural(fields.weekday) + ' ' + A.fmtTime(fields.time) : ids.length + ' back-to-back times offered on ' + dowPlural(fields.weekday));
          }
        } catch (e) { A.toast('error', (e && e.code === 'permission-denied') ? 'You don’t have permission to do that.' : 'Failed: ' + (e && e.message)); }
      });
    } });
  }

  function openSubscribeSheet(id) {
    const A = M();
    const s = slot(id);
    if (!s || !mayTake(s)) { A.toast('warn', 'That time was just taken'); return; }
    const role = hostRole(s.hostUid);
    A.sheet({ title: 'Subscribe — ' + dowPlural(s.weekday) + ' ' + A.fmtRange(s.time, s.duration), build(body, api) {
      const next = nextOccurrence(s);
      body.innerHTML = '<p class="mtg-confirm-msg">A recurring one-on-one with <b>' + esc(A.memberName(s.hostUid, s.hostName)) + '</b>' + (role ? ' (' + esc(role) + ')' : '') + ': <b>' + esc(cadenceLabel(s).toLowerCase()) + '</b> on ' + esc(dowPlural(s.weekday)) + ', ' + esc(A.fmtRange(s.time, s.duration)) +
        (s.location ? ', in ' + esc(s.location) : '') + (next ? '. First one ' + esc(A.fmtDateLong(next)) : '') + (s.endDate ? ', through ' + esc(A.fmtDateShort(s.endDate)) : '') + '.</p>' +
        (s.note ? '<p class="mtg-muted">“' + esc(s.note) + '”</p>' : '') +
        '<p class="mtg-muted mtg-tiny">You get a reminder the afternoon before each one. If you can’t make a week, mark it skipped from the calendar — ' + esc(A.firstName(s.hostUid, s.hostName)) + ' is told.</p>' +
        '<div class="mtg-row-actions"><button type="button" class="mtg-btn mtg-btn-primary oo-yes">' + icon('check', { size: 'sm' }) + ' Subscribe</button><button type="button" class="mtg-btn mtg-cancel">Not now</button></div>';
      body.querySelector('.mtg-cancel').addEventListener('click', () => api.close());
      body.querySelector('.oo-yes').addEventListener('click', async () => {
        const btn = body.querySelector('.oo-yes');
        btn.disabled = true;
        try {
          await subscribe(id);
          body.innerHTML = '<p class="mtg-confirm-msg">' + icon('check-circle', { size: 'sm' }) + ' You’re on <b>' + esc(A.firstName(s.hostUid, s.hostName)) + '</b>’s calendar — ' + esc(cadenceLabel(s).toLowerCase()) + ', ' + esc(dowPlural(s.weekday)) + ' at ' + esc(A.fmtTime(s.time)) + '.</p>' +
            '<div class="mtg-row-actions"><button type="button" class="mtg-btn mtg-btn-primary oo-ics">' + icon('arrow-down-tray', { size: 'sm' }) + ' Add to my calendar</button><button type="button" class="mtg-btn mtg-cancel">Done</button></div>';
          body.querySelector('.mtg-cancel').addEventListener('click', () => api.close());
          body.querySelector('.oo-ics').addEventListener('click', () => { downloadIcs(slot(id)); api.close(); });
          A.render();
        } catch (e) {
          api.close();
          A.toast('error', (e && e.code === 'permission-denied') ? 'That time is no longer open.' : 'Failed: ' + (e && e.message));
        }
      });
    } });
  }

  /* details: who, repeat, upcoming dates with skip / unskip, actions */
  function openSlotSheet(id) {
    const A = M();
    if (!slot(id)) return;
    A.sheet({ title: dowPlural(slot(id).weekday) + ' ' + A.fmtRange(slot(id).time, slot(id).duration), build(body, api) {
      function fill() {
        const s = slot(id);
        if (!s) { body.innerHTML = '<p class="mtg-muted">This time is gone.</p>'; return; }
        const iHost = isHostOf(s);
        const party = iHost || isMine(s);
        const role = hostRole(s.hostUid);
        const dates = upcoming(s, 6);
        const actions = [];
        if (mayTake(s)) actions.push('<button type="button" class="mtg-btn mtg-btn-primary" data-oo="subscribe">' + icon('check', { size: 'sm' }) + ' Subscribe</button>');
        if (isMine(s) || (iHost && s.subscriberUid)) actions.push('<button type="button" class="mtg-btn" data-oo="ics">' + icon('arrow-down-tray', { size: 'sm' }) + ' Add to calendar</button>');
        if (isMine(s)) actions.push('<button type="button" class="mtg-btn mtg-btn-ghost" data-oo="unsubscribe">Unsubscribe</button>');
        if (iHost) {
          actions.push('<button type="button" class="mtg-btn" data-oo="reserve">' + (s.subscriberUid ? icon('user', { size: 'sm' }) + ' Change student' : icon('plus', { size: 'sm' }) + ' Reserve for…') + '</button>');
          actions.push('<button type="button" class="mtg-btn" data-oo="edit">' + icon('pencil-square', { size: 'sm' }) + ' Edit</button>');
          if (s.active !== false) actions.push('<button type="button" class="mtg-btn mtg-btn-ghost" data-oo="end">' + icon('no-symbol', { size: 'sm' }) + ' End</button>');
          actions.push('<button type="button" class="mtg-btn mtg-btn-ghost mtg-danger" data-oo="delete">' + icon('trash', { size: 'sm' }) + ' Delete</button>');
        }
        body.innerHTML = '<dl class="mtg-dl">' +
          '<dt>Host</dt><dd>' + A.avatar(s.hostUid, s.hostName) + ' ' + esc(A.memberName(s.hostUid, s.hostName)) + (role ? ' <span class="mtg-muted">(' + esc(role) + ')</span>' : '') + '</dd>' +
          '<dt>Student</dt><dd>' + (s.subscriberUid ? A.avatar(s.subscriberUid, s.subscriberName) + ' ' + esc(A.memberName(s.subscriberUid, s.subscriberName)) + (isMine(s) ? ' <span class="mtg-you">you</span>' : '') : '<span class="mtg-chip mtg-chip-muted">open</span>') + '</dd>' +
          '<dt>Repeats</dt><dd>' + esc(repeatLine(s)) + (s.active === false ? ' <span class="mtg-status mtg-status-cancelled">ended</span>' : '') + '</dd>' +
          (s.location ? '<dt>Where</dt><dd>' + esc(s.location) + '</dd>' : '') +
          (s.note ? '<dt>Note</dt><dd>' + esc(s.note) + '</dd>' : '') +
        '</dl>' +
        (dates.length ? '<h4 style="margin:12px 0 2px">Upcoming</h4>' +
          (party ? '<input type="text" class="mtg-input" id="oo-skip-reason" placeholder="Reason for skipping (optional — the other person sees it)" maxlength="120" style="width:100%;box-sizing:border-box;margin:4px 0">' : '') +
          '<ul class="oo-dates">' + dates.map(d => {
            const sk = d.skipped ? (s.skips[d.date] || {}) : null;
            return '<li' + (d.skipped ? ' class="oo-date-skip"' : '') + '><span>' + esc(A.fmtDate(d.date)) + '</span>' +
              (sk ? '<span class="mtg-muted mtg-tiny">skipped' + (sk.name ? ' by ' + esc(sk.name.split(/\s+/)[0]) : '') + (sk.reason ? ' — ' + esc(sk.reason) : '') + '</span>' : '') +
              (party ? (d.skipped ? '<button type="button" class="mtg-btn mtg-btn-xs" data-oo="unskip" data-date="' + d.date + '">' + icon('arrow-uturn-left', { size: 'xs' }) + ' Back on</button>'
                                  : '<button type="button" class="mtg-btn mtg-btn-xs mtg-btn-ghost" data-oo="skip" data-date="' + d.date + '">Skip</button>') : '') +
            '</li>';
          }).join('') + '</ul>' : '<p class="mtg-muted mtg-tiny">No upcoming dates.</p>') +
        (actions.length ? '<div class="mtg-row-actions">' + actions.join('') + '</div>' : '');
      }
      fill();
      body.addEventListener('click', async ev => {
        const b = ev.target.closest('[data-oo]');
        if (!b) return;
        const s = slot(id);
        if (!s) return;
        const what = b.dataset.oo;
        try {
          if (what === 'skip') { b.disabled = true; const r = body.querySelector('#oo-skip-reason'); await skipDate(id, b.dataset.date, r ? r.value.trim() : ''); fill(); A.render(); return; }
          if (what === 'unskip') { b.disabled = true; await unskipDate(id, b.dataset.date); fill(); A.render(); return; }
          if (what === 'ics') { downloadIcs(s); return; }
          api.close();
          if (what === 'subscribe') openSubscribeSheet(id);
          else if (what === 'unsubscribe') confirmUnsubscribe(id);
          else if (what === 'reserve') pickReserve(id);
          else if (what === 'edit') openOfferSheet(id);
          else if (what === 'end') confirmEnd(id);
          else if (what === 'delete') confirmDelete(id);
        } catch (e) {
          A.toast('error', (e && e.code === 'permission-denied') ? 'You don’t have permission to do that.' : 'Failed: ' + (e && e.message));
          fill();
        }
      });
    } });
  }

  function pickReserve(id) {
    const A = M();
    const s = slot(id);
    if (!s) return;
    const pool = reservePool(s.hostUid);
    A.openMemberPicker('Reserve ' + dowPlural(s.weekday) + ' ' + A.fmtTime(s.time) + ' for…', {
      only: pool.map(u => u.uid), exclude: s.subscriberUid ? [s.subscriberUid] : [],
      allowNone: !!s.subscriberUid, noneLabel: 'Make it open again',
      emptyText: 'Nobody to pick — you’re not listed as anyone’s mentor yet (Settings → Permissions → Mentors).',
    }, async uid => {
      await reserve(id, uid || null);
      A.toast('success', uid ? A.firstName(uid) + ' is on your calendar — they’ve been told' : 'The time is open again');
    });
  }
  function confirmUnsubscribe(id) {
    const A = M();
    const s = slot(id);
    if (!s) return;
    A.openConfirm('Stop meeting ' + A.firstName(s.hostUid, s.hostName) + ' ' + dowPlural(s.weekday).toLowerCase() + ' at ' + A.fmtTime(s.time) + '? The time opens up for someone else and ' + A.firstName(s.hostUid, s.hostName) + ' is told.', 'Unsubscribe', async () => {
      await unsubscribe(id);
      A.toast('info', 'Unsubscribed');
    });
  }
  function confirmEnd(id) {
    const A = M();
    const s = slot(id);
    if (!s) return;
    A.openConfirm('End the ' + dowPlural(s.weekday).toLowerCase() + ' ' + A.fmtTime(s.time) + ' one-on-one' + (s.subscriberUid ? ' with ' + A.firstName(s.subscriberUid, s.subscriberName) + '? They are told' : '?') + ' It leaves the calendar from today; the record stays under “Ended”.', 'End', async () => {
      await endSlot(id);
      A.toast('success', 'Ended');
    });
  }
  function confirmDelete(id) {
    const A = M();
    const s = slot(id);
    if (!s) return;
    A.openConfirm('Delete this time entirely?' + (s.subscriberUid && s.active !== false ? ' ' + A.firstName(s.subscriberUid, s.subscriberName) + ' is told it was cancelled.' : ''), 'Delete', async () => {
      await removeSlot(id);
      A.toast('success', 'Deleted');
    }, true);
  }

  /* ═══ events (delegated from meetings.js: data-act="oo-*") ═════ */
  async function onAct(act, btn) {
    const A = M();
    const id = btn.dataset.id;
    switch (act) {
      case 'oo-month': {
        const dir = +btn.dataset.dir;
        A.state.ui.ooMonth = dir === 0 ? A.todayStr().slice(0, 7) : shiftMonth(monthKey(), dir);
        A.render();
        break;
      }
      case 'oo-filter': A.state.ui.ooFilter = btn.dataset.val === 'all' ? 'all' : 'mine'; A.render(); break;
      case 'oo-offer': openOfferSheet(null); break;
      case 'oo-edit': openOfferSheet(id); break;
      case 'oo-open': openSlotSheet(id); break;
      case 'oo-subscribe': openSubscribeSheet(id); break;
      case 'oo-unsubscribe': confirmUnsubscribe(id); break;
      case 'oo-reserve': pickReserve(id); break;
      case 'oo-ics': downloadIcs(slot(id)); break;
      case 'oo-end': confirmEnd(id); break;
      case 'oo-delete': confirmDelete(id); break;
      default: break;
    }
  }

  window.MEETINGS_ONE_ON_ONE = {
    render, renderMine, badge, onAct,
    onChange: async () => {}, onSubmit: async () => {},
    // for tests / other modules
    occursOn, nextOccurrence, upcoming, icsFor, myHosts, canHost, menteesOf, visible, mine, hosted,
    PATH, COLL,
  };
})();
