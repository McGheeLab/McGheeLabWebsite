/* meetings-one-on-one.js — One-on-ones tab on Lab Meetings (V3.938; unique
 * slots, every-week requests and joined slots V3.940).
 *
 * The PI (or anyone who is somebody's mentor — users/{uid}.mentor_uids)
 * OFFERS recurring times. One doc per recurring time:
 *
 *   oneOnOneSlots/{id}  hostUid, weekday 0–6, time 'HH:MM', duration, cadence
 *                       weekly|biweekly, location, note, startDate (first
 *                       occurrence + fortnight anchor), endDate|null, active,
 *                       mode 'recurring' (default) | 'unique'          V3.940
 *                       subscriberUid|null — the EVERY-WEEK holder (+ Name /
 *                         subscribedAt / subscribedBy 'self'|'host'|'approved',
 *                         subscribedFrom 'YYYY-MM-DD'|null: holds from then on)
 *                       bookings{ <uid>: { 'YYYY-MM-DD': {name, at, by} } }
 *                         — ONE-WEEK holders (unique slots)            V3.940
 *                       recurRequests{ <uid>: {name, at, from} } — "make it
 *                         every week", waiting for the host           V3.940
 *                       skips{ 'YYYY-MM-DD': {by, name, reason, at} } — the
 *                         every-week holder can't make that date
 *                       updatedBy, lastReminded (function only).
 *
 * Who holds a date (holderOn): a one-week booking wins; else the every-week
 * holder (from subscribedFrom), 'skipped' if they skipped it; else open. A
 * skipped week of a UNIQUE slot is open to a one-week booking.
 *
 *   recurring slot  a sign-up is every week (the student writes their own
 *                   uid into subscriberUid — V3.938).
 *   unique slot     a sign-up is that week only (bookings.<me>.<date>); the
 *                   student may ask for every week (recurRequests.<me>), the
 *                   host approves → subscriberUid = them from that date. The
 *                   host can flip a slot's mode in Edit, make any one-week
 *                   booking every week, or turn an every-week one back into
 *                   one week, any time.
 *
 * Joined slots: when one person holds back-to-back slots of the same host on
 * a date (one ends as the next starts), the calendar, the student's list, the
 * reminder and the .ics show ONE block (2:00–3:00). Sign-up sheets offer
 * "also take the next slot". The rules key bookings / requests by uid, so a
 * student can only ever write their own (firestore.rules oneOnOneSlots).
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
  const OPEN_LOOKAHEAD = 6;     // occurrences scanned for "has an open week"

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
  /* who a host may reserve / book a time for: the PI → the meeting roster; a mentor → their mentees */
  function reservePool(hostUid) {
    const A = M();
    const pi = piUids().includes(hostUid) || (hostUid === A.me() && A.isAdmin());
    const list = pi ? A.rosterMembers() : menteesOf(hostUid);
    return list.filter(u => u.uid !== hostUid);
  }

  /* ═══ occurrence math — mirrored in functions/meetings.js ═════ */
  function weekdayOf(ds) { return M().parseDate(ds).getDay(); }
  function firstOnOrAfter(from, weekday) {
    const A = M();
    let d = from;
    for (let i = 0; i < 7; i++) { if (weekdayOf(d) === weekday) return d; d = A.addDays(d, 1); }
    return from;
  }
  /* null = no meeting that day · 'on' · 'skipped' (the every-week holder skipped it) */
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
  /* the next n dates the slot meets (skipped ones included, flagged) */
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
  function tShort(hhmm) {
    const [h, m] = String(hhmm || '0:0').split(':').map(Number);
    return ((h % 12) || 12) + (m ? ':' + pad(m) : '') + (h >= 12 ? 'p' : 'a');
  }
  function endOf(s) { return M().addMinutes(s.time, s.duration); }
  function span(start, end) { const A = M(); return A.fmtTime(start) + ' – ' + A.fmtTime(end); }
  function minsBetween(a, b) { const p = x => { const [h, m] = String(x).split(':').map(Number); return h * 60 + m; }; return p(b) - p(a); }
  function lengthWord(start, end) { const n = minsBetween(start, end); return n % 60 === 0 ? (n / 60) + (n === 60 ? ' hour' : ' hours') : n + ' min'; }
  /* 'a one-hour meeting' · 'a 2-hour meeting' · 'a 45-minute meeting' */
  function meetingLen(start, end) { const n = minsBetween(start, end); return n === 60 ? 'a one-hour meeting' : n % 60 === 0 ? 'a ' + (n / 60) + '-hour meeting' : 'a ' + n + '-minute meeting'; }
  function dowPlural(wd) { return M().dowName(+wd) + 's'; }
  function cadenceLabel(s) { return CADENCE[s.cadence] || CADENCE.weekly; }
  function everyLabel(s) { return (s.cadence === 'biweekly' ? 'Every other ' : 'Every ') + M().dowName(+s.weekday); }
  function repeatLine(s) {
    const A = M();
    return cadenceLabel(s) + ' from ' + A.fmtDateShort(s.startDate) + (s.endDate ? ' to ' + A.fmtDateShort(s.endDate) : '');
  }

  /* ═══ who holds a date (V3.940) — mirrored in functions/meetings.js ═══ */
  function isUnique(s) { return !!s && s.mode === 'unique'; }
  /* the one-week booking on d, earliest first if two ever collide */
  function bookingOn(s, d) {
    const b = (s && s.bookings) || {};
    let best = null;
    Object.keys(b).forEach(uid => {
      const e = b[uid] && b[uid][d];
      if (e && (!best || String(e.at || '') < String(best.at || ''))) best = Object.assign({ uid }, e);
    });
    return best;
  }
  function standingOn(s, d) { return !!(s && s.subscriberUid && (!s.subscribedFrom || d >= s.subscribedFrom)); }
  /* → null (no meeting that day) | {state:'week'|'standing'|'skipped'|'open', uid?, name?} */
  function holderOn(s, d) {
    const o = occursOn(s, d);
    if (!o) return null;
    const b = bookingOn(s, d);
    if (b) return { state: 'week', uid: b.uid, name: b.name || '', by: b.by || 'self' };
    if (standingOn(s, d)) return { state: o === 'skipped' ? 'skipped' : 'standing', uid: s.subscriberUid, name: s.subscriberName || '' };
    return { state: 'open' };
  }
  function isOpenFor(h, s) { return !!h && (h.state === 'open' || (h.state === 'skipped' && isUnique(s))); }
  /* the next n dates a unique slot is open for a one-week booking */
  function openWeeks(s, n) {
    const A = M();
    const out = [];
    let d = A.todayStr();
    for (let i = 0; i < 200 && out.length < n; i++) {
      const h = holderOn(s, d);
      if (h && isOpenFor(h, s)) out.push(d);
      d = A.addDays(d, 1);
    }
    return out;
  }
  function requestsOf(s) {
    const r = (s && s.recurRequests) || {};
    return Object.keys(r).map(uid => Object.assign({ uid }, r[uid] || {}));
  }

  /* ═══ slots ═══════════════════════════════════════════════════ */
  function all() { return M().state.slots || []; }
  function slot(id) { return all().find(s => s.id === id) || null; }
  function isHostOf(s) { const A = M(); return !!s && (s.hostUid === A.me() || A.isAdmin()); }
  function isMine(s) { return !!s && !!s.subscriberUid && s.subscriberUid === M().me(); }
  function myBookedDates(s) {
    const A = M();
    const t = A.todayStr();
    const mine = ((s && s.bookings) || {})[A.me()] || {};
    return Object.keys(mine).filter(d => d >= t && occursOn(s, d)).sort();
  }
  /* every-week sign-up (recurring slots) */
  function mayTake(s) { return !!s && s.active !== false && !isUnique(s) && !s.subscriberUid && s.hostUid !== M().me() && myHosts().includes(s.hostUid); }
  /* one-week booking (unique slots) */
  function mayBook(s, d) {
    const A = M();
    return !!s && s.active !== false && isUnique(s) && d >= A.todayStr() && s.hostUid !== A.me()
      && myHosts().includes(s.hostUid) && isOpenFor(holderOn(s, d), s);
  }
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
    return act.filter(s => s.hostUid === me || s.subscriberUid === me || myBookedDates(s).length || (hosts.has(s.hostUid) && hasOpening(s)));
  }
  function hasOpening(s) { return isUnique(s) ? openWeeks(s, 1).length > 0 : !s.subscriberUid; }
  function mine() { return sortSlots(all().filter(s => s.active !== false && isMine(s))); }
  function hosted() { return sortSlots(all().filter(s => s.hostUid === M().me() && s.active !== false)); }
  function ended() { return sortSlots(all().filter(s => s.active === false && isHostOf(s))); }
  function openFromMyHosts() {
    const hosts = new Set(myHosts());
    return all().filter(s => s.active !== false && hosts.has(s.hostUid) && hasOpening(s));
  }
  /* the slot that starts as this one ends: same host, weekday, cadence, still on */
  function nextAdjacent(s) {
    return all().find(x => x.id !== s.id && x.active !== false && x.hostUid === s.hostUid && +x.weekday === +s.weekday
      && (x.cadence || 'weekly') === (s.cadence || 'weekly') && x.time === endOf(s)) || null;
  }
  function slotWhoLabel(s) {
    const A = M();
    if (s.hostUid === A.me()) return s.subscriberUid ? 'with ' + A.firstName(s.subscriberUid, s.subscriberName) : 'open';
    return 'with ' + A.firstName(s.hostUid, s.hostName);
  }

  /* ═══ joined slots (V3.940) ═══════════════════════════════════ */
  /* per-date entries for the calendar: one per slot, MERGED where the same
   * person holds back-to-back slots of the same host (end === next start) */
  function entriesOn(list, d) {
    const items = [];
    list.forEach(s => { const h = holderOn(s, d); if (h) items.push({ date: d, slots: [s], h, hostUid: s.hostUid, start: s.time, end: endOf(s) }); });
    items.sort((a, b) => String(a.hostUid).localeCompare(String(b.hostUid)) || String(a.start).localeCompare(String(b.start)));
    const out = [];
    items.forEach(it => {
      const prev = out[out.length - 1];
      if (prev && prev.hostUid === it.hostUid && prev.h.uid && prev.h.uid === it.h.uid && prev.end === it.start
          && prev.h.state !== 'skipped' && it.h.state !== 'skipped') {
        prev.end = it.end; prev.slots.push(it.slots[0]);
        if (prev.h.state !== it.h.state) prev.h = Object.assign({}, prev.h, { state: 'week' });   // mixed → this week only
      } else out.push(it);
    });
    return out.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  }
  /* every-week groups: back-to-back slots with the same host, holder, weekday, cadence, dates */
  function standingGroups(slots) {
    const key = s => [s.hostUid, s.subscriberUid, s.weekday, s.cadence || 'weekly', s.startDate, s.endDate || '', s.subscribedFrom || ''].join('|');
    const sorted = slots.slice().sort((a, b) => key(a).localeCompare(key(b)) || String(a.time).localeCompare(String(b.time)));
    const out = [];
    sorted.forEach(s => {
      const g = out[out.length - 1];
      if (g && key(g.slots[0]) === key(s) && g.end === s.time) { g.slots.push(s); g.end = endOf(s); }
      else out.push({ slots: [s], start: s.time, end: endOf(s) });
    });
    return out.sort((a, b) => (ord(a.slots[0].weekday) - ord(b.slots[0].weekday)) || String(a.start).localeCompare(String(b.start)));
  }
  /* my upcoming one-week bookings, merged per date + host */
  function myWeekEntries() {
    const A = M();
    const me = A.me();
    const dates = new Set();
    all().forEach(s => { if (s.active !== false) myBookedDates(s).forEach(d => dates.add(d)); });
    const out = [];
    Array.from(dates).sort().forEach(d => {
      entriesOn(all().filter(s => s.active !== false), d).forEach(e => { if (e.h.uid === me && e.h.state === 'week') out.push(e); });
    });
    return out;
  }
  /* pending every-week requests on the slots I host, grouped like a joined block */
  function pendingGroups() {
    const A = M();
    const out = [];
    hosted().concat(A.isAdmin() && A.state.ui.ooFilter === 'all' ? all().filter(s => s.active !== false && s.hostUid !== A.me()) : [])
      .forEach(s => requestsOf(s).forEach(r => {
        const g = out.find(x => x.uid === r.uid && x.hostUid === s.hostUid && +x.weekday === +s.weekday && (x.end === s.time || x.start === endOf(s)) && x.from === r.from);
        if (g) { g.slots.push(s); if (s.time < g.start) g.start = s.time; if (endOf(s) > g.end) g.end = endOf(s); }
        else out.push({ uid: r.uid, name: r.name || '', from: r.from, at: r.at, hostUid: s.hostUid, weekday: s.weekday, slots: [s], start: s.time, end: endOf(s) });
      }));
    return out;
  }
  /* tab badge: requests waiting on me, else a host of mine has an opening and I have nothing with them */
  function badge() {
    const A = M();
    if (!A.state.loaded.slots || !A.state.loaded.users) return 0;
    const pend = pendingGroups().filter(g => g.hostUid === A.me()).length;
    if (pend) return pend;
    const have = new Set(mine().map(s => s.hostUid).concat(myWeekEntries().map(e => e.hostUid)));
    return openFromMyHosts().some(s => !have.has(s.hostUid)) ? 1 : 0;
  }

  /* ═══ writes ══════════════════════════════════════════════════ */
  function col() { return M().db().collection(COLL); }
  function applyLocal(id, patch) {
    const A = M();
    const s = slot(id);
    if (s) Object.keys(patch).forEach(k => A.setPath(s, k, patch[k]));
  }
  function toFs(patch) {
    const A = M();
    const fs = {};
    Object.keys(patch).forEach(k => { fs[k] = A.toFirestore(patch[k]); });
    fs.updatedBy = A.me();
    fs.updatedAt = A.FV().serverTimestamp();
    return fs;
  }
  async function patchSlot(id, patch) {
    const A = M();
    applyLocal(id, patch);
    A.scheduleRender();
    await col().doc(id).update(toFs(patch));
    A.invalidate(PATH);
  }
  /* one batch over several slots: patches = [[id, patch], …] */
  async function patchMany(patches) {
    const A = M();
    if (!patches.length) return;
    patches.forEach(([id, p]) => applyLocal(id, p));
    A.scheduleRender();
    const b = A.db().batch();
    patches.forEach(([id, p]) => b.update(col().doc(id), toFs(p)));
    await b.commit();
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
        mode: f.unique ? 'unique' : 'recurring',
        location: f.location || '', note: f.note || '',
        startDate: start, endDate: f.endDate || null, active: true,
        subscriberUid: null, subscriberName: '', subscribedAt: null, subscribedBy: null, subscribedFrom: null,
        bookings: {}, recurRequests: {}, skips: {},
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
      mode: f.unique ? 'unique' : 'recurring',
      location: f.location || '', note: f.note || '',
      startDate: firstOnOrAfter(f.startDate || M().todayStr(), +f.weekday), endDate: f.endDate || null,
    });
  }
  /* every week — recurring slots; ids = one slot, or it plus the next */
  async function subscribe(ids) {
    const A = M();
    const p = { subscriberUid: A.me(), subscriberName: A.myName(), subscribedAt: A.isoNow(), subscribedBy: 'self' };
    await patchMany(ids.map(id => [id, Object.assign({}, p)]));
  }
  async function unsubscribe(ids) {
    await patchMany([].concat(ids).map(id => [id, { subscriberUid: null, subscriberName: '', subscribedAt: null, subscribedBy: null }]));
  }
  async function reserve(id, uid) {
    const A = M();
    if (!uid) return unsubscribe([id]);
    await patchSlot(id, { subscriberUid: uid, subscriberName: A.memberName(uid), subscribedAt: A.isoNow(), subscribedBy: 'host', subscribedFrom: null });
  }
  /* one week — unique slots. In a transaction so two students can't take
   * the same week: every slot must still be open on `date` at commit time. */
  async function bookWeek(ids, date, opts) {
    const A = M();
    opts = opts || {};
    const who = opts.uid || A.me();
    const entry = { name: A.memberName(who), at: A.isoNow(), by: who === A.me() ? 'self' : 'host' };
    const patches = ids.map(() => {
      const p = {};
      p['bookings.' + who + '.' + date] = Object.assign({}, entry);
      if (opts.request) p['recurRequests.' + who] = { name: entry.name, at: entry.at, from: date };
      return p;
    });
    await A.db().runTransaction(async t => {
      const refs = ids.map(id => col().doc(id));
      const snaps = [];
      for (const r of refs) snaps.push(await t.get(r));
      snaps.forEach(sn => {
        const d = sn.exists ? Object.assign({ id: sn.id }, sn.data()) : null;
        if (!d || d.active === false || !isOpenFor(holderOn(d, date), d)) throw Object.assign(new Error('That week was just taken'), { code: 'taken' });
      });
      refs.forEach((r, i) => t.update(r, toFs(patches[i])));
    });
    patches.forEach((p, i) => applyLocal(ids[i], p));   // only once the commit landed (a transaction may retry)
    A.invalidate(PATH);
    A.render();
  }
  async function cancelWeek(ids, date, uid) {
    const A = M();
    const who = uid || A.me();
    await patchMany([].concat(ids).map(id => { const p = {}; p['bookings.' + who + '.' + date] = A.DEL(); return [id, p]; }));
  }
  async function requestRecurring(ids, from) {
    const A = M();
    const e = { name: A.myName(), at: A.isoNow(), from };
    await patchMany([].concat(ids).map(id => { const p = {}; p['recurRequests.' + A.me()] = Object.assign({}, e); return [id, p]; }));
  }
  async function withdrawRequest(ids, uid) {
    const A = M();
    const who = uid || A.me();
    await patchMany([].concat(ids).map(id => { const p = {}; p['recurRequests.' + who] = A.DEL(); return [id, p]; }));
  }
  /* host: every week for `uid` from `from` — approving a request, or making a
   * one-week booking every week. Their own one-week bookings from `from` on
   * fold into it; anyone else's booked weeks stay theirs. */
  async function makeEveryWeek(ids, uid, from) {
    const A = M();
    const patches = [];
    const skipped = [];
    [].concat(ids).forEach(id => {
      const s = slot(id);
      if (!s) return;
      if (s.subscriberUid && s.subscriberUid !== uid) { skipped.push(s); return; }
      const p = { subscriberUid: uid, subscriberName: A.memberName(uid), subscribedAt: A.isoNow(), subscribedBy: requestsOf(s).some(r => r.uid === uid) ? 'approved' : 'host', subscribedFrom: from || null };
      if ((s.recurRequests || {})[uid]) p['recurRequests.' + uid] = A.DEL();
      Object.keys(((s.bookings || {})[uid]) || {}).forEach(d => { if (!from || d >= from) p['bookings.' + uid + '.' + d] = A.DEL(); });
      patches.push([id, p]);
    });
    await patchMany(patches);
    return skipped;
  }
  /* host: every week → this week only (keeps their next date as a one-week booking) */
  async function makeOneWeek(ids) {
    const A = M();
    const patches = [];
    let kept = null;
    [].concat(ids).forEach(id => {
      const s = slot(id);
      if (!s || !s.subscriberUid) return;
      const next = nextOccurrence(s);
      const p = { subscriberUid: null, subscriberName: '', subscribedAt: null, subscribedBy: null, subscribedFrom: null };
      if (next && !bookingOn(s, next)) { p['bookings.' + s.subscriberUid + '.' + next] = { name: s.subscriberName || A.memberName(s.subscriberUid), at: A.isoNow(), by: 'host' }; kept = next; }
      patches.push([id, p]);
    });
    await patchMany(patches);
    return kept;
  }
  async function skipDate(ids, date, reason) {
    const A = M();
    const e = { by: A.me(), name: A.myName(), reason: reason || '', at: A.isoNow() };
    await patchMany([].concat(ids).map(id => { const p = {}; p['skips.' + date] = Object.assign({}, e); return [id, p]; }));
  }
  async function unskipDate(ids, date) {
    const A = M();
    await patchMany([].concat(ids).map(id => { const p = {}; p['skips.' + date] = A.DEL(); return [id, p]; }));
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

  /* ═══ .ics — Phoenix has no DST ═══════════════════════════════ */
  function icsText(s) {
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }
  const dtStamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dt = (ds, hhmm) => ds.replace(/-/g, '') + 'T' + String(hhmm).replace(':', '') + '00';
  function icsWrap(events) {
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//McGhee Lab//Ourlab one-on-ones//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH']
      .concat(events).concat(['END:VCALENDAR']).join('\r\n') + '\r\n';
  }
  function titleFor(s, holderUid, holderName) {
    const A = M();
    const host = A.firstName(s.hostUid, s.hostName);
    return holderUid ? 'One-on-one: ' + A.firstName(holderUid, holderName) + ' & ' + host : 'One-on-one with ' + host + ' (open)';
  }
  /* an every-week block (one slot, or back-to-back slots joined into one event) */
  function icsStandingEvent(group) {
    const A = M();
    const s = group.slots[0];
    const end = group.end || endOf(s);
    const first = s.subscribedFrom && s.subscribedFrom > s.startDate ? (nextOccurrence(s, s.subscribedFrom) || s.startDate) : s.startDate;
    // skipped dates, and weeks somebody else booked, are not this person's
    const ex = new Set();
    group.slots.forEach(x => {
      Object.keys(x.skips || {}).forEach(d => ex.add(d));
      Object.keys(x.bookings || {}).forEach(u => { if (u !== x.subscriberUid) Object.keys(x.bookings[u] || {}).forEach(d => ex.add(d)); });
    });
    const lines = [
      'BEGIN:VEVENT',
      'UID:oneonone-' + group.slots.map(x => x.id).join('+') + '@mcgheelab.com',
      'DTSTAMP:' + dtStamp(),
      'DTSTART;TZID=America/Phoenix:' + dt(first, s.time),
      'DTEND;TZID=America/Phoenix:' + dt(first, end),
      'RRULE:FREQ=WEEKLY;INTERVAL=' + (s.cadence === 'biweekly' ? 2 : 1) + ';BYDAY=' + BYDAY[+s.weekday] +
        (s.endDate ? ';UNTIL=' + A.addDays(s.endDate, 1).replace(/-/g, '') + 'T065959Z' : ''),
    ];
    const exList = Array.from(ex).filter(d => occursOn(s, d)).sort();
    if (exList.length) lines.push('EXDATE;TZID=America/Phoenix:' + exList.map(d => dt(d, s.time)).join(','));
    lines.push(
      'SUMMARY:' + icsText(titleFor(s, s.subscriberUid, s.subscriberName)),
      'LOCATION:' + icsText(s.location || ''),
      'DESCRIPTION:' + icsText((s.note ? s.note + '\n' : '') + 'Recurring one-on-one from the McGhee Lab meetings page. Changes and skipped weeks are kept there: ' + PAGE_URL),
      'URL:' + PAGE_URL,
      'END:VEVENT');
    return lines;
  }
  /* a one-week block */
  function icsWeekEvent(entry) {
    const s = entry.slots[0];
    return [
      'BEGIN:VEVENT',
      'UID:oneonone-' + entry.slots.map(x => x.id).join('+') + '-' + entry.date + '@mcgheelab.com',
      'DTSTAMP:' + dtStamp(),
      'DTSTART;TZID=America/Phoenix:' + dt(entry.date, entry.start),
      'DTEND;TZID=America/Phoenix:' + dt(entry.date, entry.end),
      'SUMMARY:' + icsText(titleFor(s, entry.h.uid, entry.h.name)),
      'LOCATION:' + icsText(s.location || ''),
      'DESCRIPTION:' + icsText((s.note ? s.note + '\n' : '') + 'One-on-one from the McGhee Lab meetings page (this week only): ' + PAGE_URL),
      'URL:' + PAGE_URL,
      'END:VEVENT',
    ];
  }
  /* kept for tests and callers: one slot as an every-week event */
  function icsFor(s) { return icsWrap(icsStandingEvent({ slots: [s], start: s.time, end: endOf(s) })); }
  function groupForSlot(s) {
    return standingGroups(all().filter(x => x.active !== false && x.subscriberUid && x.subscriberUid === s.subscriberUid))
      .find(g => g.slots.some(x => x.id === s.id)) || { slots: [s], start: s.time, end: endOf(s) };
  }
  function download(text, name) {
    const A = M();
    try {
      const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      A.toast('success', 'Calendar file downloaded — open it to add the one-on-one to your calendar');
    } catch (e) {
      A.toast('warn', 'Could not build the calendar file: ' + (e && e.message));
    }
  }
  function downloadStanding(s) {
    if (!s) return;
    const g = groupForSlot(s);
    download(icsWrap(icsStandingEvent(g)), 'one-on-one-' + M().firstName(s.hostUid, s.hostName).toLowerCase() + '-' + dowPlural(s.weekday).toLowerCase() + '.ics');
  }
  function downloadWeek(s, date) {
    if (!s) return;
    const e = entriesOn(all().filter(x => x.active !== false), date).find(x => x.slots.some(y => y.id === s.id));
    if (!e) return;
    download(icsWrap(icsWeekEvent(e)), 'one-on-one-' + M().firstName(s.hostUid, s.hostName).toLowerCase() + '-' + date + '.ics');
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
      const chips = entriesOn(list, d.date).map(chip).join('');
      return '<div class="oo-day' + (d.inMonth ? '' : ' oo-day-out') + (d.date === today ? ' oo-day-today' : '') + (d.date < today ? ' oo-day-past' : '') + '" data-date="' + d.date + '">' +
        '<span class="oo-day-n">' + (+d.date.slice(8)) + '</span>' + chips + '</div>';
    }).join('');
    return '<section class="mtg-card oo-cal"><div class="oo-dow">' + dow + '</div><div class="oo-grid">' + cells + '</div>' +
      '<p class="mtg-muted mtg-tiny mtg-legend">Solid = every week · outlined = this week only · dashed = open, tap to sign up · struck through = skipped. Back-to-back slots held by one person show as one block.</p></section>';
  }
  function chip(e) {
    const A = M();
    const me = A.me();
    const s = e.slots[0];
    const iHost = s.hostUid === me;
    const h = e.h;
    const holderIsMe = !!h.uid && h.uid === me;
    const open = h.state === 'open' || (h.state === 'skipped' && isUnique(s));
    let label;
    if (open) label = iHost ? 'open' : 'open · ' + A.firstName(s.hostUid, s.hostName);
    else if (iHost) label = A.firstName(h.uid, h.name);
    else if (holderIsMe) label = A.firstName(s.hostUid, s.hostName);
    else label = A.firstName(h.uid, h.name) + ' · ' + A.firstName(s.hostUid, s.hostName);
    const joined = e.slots.length > 1;
    const time = joined ? tShort(e.start) + '–' + tShort(e.end) : tShort(e.start);
    const what = open ? (isUnique(s) ? 'open — one week at a time' : 'open — every week')
      : h.state === 'week' ? 'this week only' : h.state === 'skipped' ? 'skipped' : 'every week';
    const title = span(e.start, e.end) + (joined ? ' (' + lengthWord(e.start, e.end) + ', ' + e.slots.length + ' slots)' : '') + ' · ' +
      A.memberName(s.hostUid, s.hostName) + (h.uid ? ' with ' + A.memberName(h.uid, h.name) : '') + ' · ' + what +
      (h.state === 'skipped' && s.skips && s.skips[e.date] && s.skips[e.date].reason ? ': ' + s.skips[e.date].reason : '');
    const cls = 'oo-chip' + (open ? ' oo-chip-open' : '') + (open && isUnique(s) ? ' oo-chip-unique' : '') + (h.state === 'week' ? ' oo-chip-week' : '') +
      (holderIsMe ? ' oo-chip-me' : '') + (h.state === 'skipped' && !open ? ' oo-chip-skip' : '') + (joined ? ' oo-chip-joined' : '');
    return '<button type="button" class="' + cls + '" data-act="oo-chip" data-id="' + esc(s.id) + '" data-date="' + e.date + '" title="' + esc(title) + '">' + esc(time) + ' ' + esc(label) + '</button>';
  }

  function slotRow(s) {
    const A = M();
    const me = A.me();
    const iHost = s.hostUid === me;
    const uniq = isUnique(s);
    const tools = [];
    if (mayTake(s)) tools.push('<button type="button" class="mtg-btn mtg-btn-xs mtg-btn-primary" data-act="oo-subscribe" data-id="' + esc(s.id) + '">Subscribe</button>');
    if (uniq && !iHost && myHosts().includes(s.hostUid) && openWeeks(s, 1).length) tools.push('<button type="button" class="mtg-btn mtg-btn-xs mtg-btn-primary" data-act="oo-open" data-id="' + esc(s.id) + '">Book a week</button>');
    if (isMine(s)) tools.push('<button type="button" class="mtg-iconbtn" data-act="oo-ics" data-id="' + esc(s.id) + '" title="Add to my calendar (.ics)">' + icon('arrow-down-tray', { size: 'sm' }) + '</button>');
    if (isHostOf(s)) tools.push('<button type="button" class="mtg-btn mtg-btn-xs' + (s.subscriberUid ? '' : ' mtg-btn-primary') + '" data-act="oo-reserve" data-id="' + esc(s.id) + '">' + (s.subscriberUid ? 'Change' : icon('plus', { size: 'xs' }) + ' Reserve for…') + '</button>');
    tools.push('<button type="button" class="mtg-btn mtg-btn-xs mtg-btn-ghost" data-act="oo-open" data-id="' + esc(s.id) + '">Details</button>');
    // who: the every-week holder (or open / one week at a time), then any
    // booked single weeks — whatever the mode, since a slot can switch modes
    // with weeks already booked
    const booked = upcoming(s, OPEN_LOOKAHEAD).map(o => ({ d: o.date, h: holderOn(s, o.date) })).filter(x => x.h && x.h.state === 'week');
    const mineB = booked.filter(x => x.h.uid === me);
    const bookedTxt = booked.length ? ' <span class="mtg-muted mtg-tiny">' + (iHost || A.isAdmin()
      ? booked.map(x => esc(A.fmtDateShort(x.d)) + ' ' + esc(A.firstName(x.h.uid, x.h.name))).join(' · ')
      : (mineB.length ? 'you: ' + mineB.map(x => esc(A.fmtDateShort(x.d))).join(', ') : booked.length + ' week' + (booked.length === 1 ? '' : 's') + ' taken')) + '</span>' : '';
    let who;
    if (s.subscriberUid) {
      who = A.avatar(s.subscriberUid, s.subscriberName) + ' <span>' + esc(A.memberName(s.subscriberUid, s.subscriberName)) + (isMine(s) ? ' <span class="mtg-you">you</span>' : '') + '</span>' +
        (s.subscribedFrom && s.subscribedFrom > A.todayStr() ? ' <span class="mtg-muted mtg-tiny">from ' + esc(A.fmtDateShort(s.subscribedFrom)) + '</span>' : '');
    } else {
      who = '<span class="mtg-chip mtg-chip-muted">' + (uniq ? 'one week at a time' : 'open') + '</span>';
    }
    who += bookedTxt;
    const reqs = isHostOf(s) ? requestsOf(s) : [];
    return '<div class="oo-row' + (isMine(s) || myBookedDates(s).length ? ' oo-row-me' : '') + (!s.subscriberUid ? ' oo-row-open' : '') + '">' +
      '<span class="oo-row-time"><b>' + esc(span(s.time, endOf(s))) + '</b><small>' + esc(cadenceLabel(s)) + (uniq ? ' · unique' : '') + (s.endDate ? ' · until ' + esc(A.fmtDateShort(s.endDate)) : '') + '</small></span>' +
      '<span class="oo-row-who">' + A.avatar(s.hostUid, s.hostName) + ' <span>' + esc(A.memberName(s.hostUid, s.hostName)) + (iHost ? ' <span class="mtg-you">you</span>' : '') + '</span>' +
        '<span class="oo-arrow">' + icon('chevron-right', { size: 'xs' }) + '</span>' + who +
        (reqs.length ? ' <span class="mtg-chip mtg-chip-warn">' + esc(reqs.map(r => A.firstName(r.uid, r.name)).join(', ')) + ' asks for every week</span>' : '') +
      '</span>' +
      '<span class="oo-row-loc">' + (s.location ? icon('map-pin', { size: 'xs' }) + ' ' + esc(s.location) : '') + '</span>' +
      '<span class="oo-row-tools">' + tools.join('') + '</span>' +
    '</div>';
  }

  function renderPattern(list) {
    const A = M();
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
        // back-to-back slots with the same every-week holder: one bracket, one time range
        const joined = standingGroups(rows.filter(s => s.subscriberUid)).filter(g => g.slots.length > 1);
        const inJoin = new Map();
        joined.forEach(g => g.slots.forEach(s => inJoin.set(s.id, g)));
        const done = new Set();
        const html = rows.map(s => {
          const g = inJoin.get(s.id);
          if (!g) return slotRow(s);
          if (done.has(g)) return '';
          done.add(g);
          return '<div class="oo-joined"><div class="oo-joined-head">' + icon('link', { size: 'xs' }) + ' ' + esc(span(g.start, g.end)) + ' — ' + esc(meetingLen(g.start, g.end)) + ' with ' +
            esc(A.memberName(g.slots[0].subscriberUid, g.slots[0].subscriberName)) + ' (' + g.slots.length + ' slots)</div>' + g.slots.map(slotRow).join('') + '</div>';
        }).join('');
        return '<h4 class="oo-wd">' + esc(dowPlural(rows[0].weekday)) + '</h4>' + html;
      }).join('');
    }
    return '<section class="mtg-card"><h3 class="mtg-h3">' + icon('arrow-path', { size: 'sm' }) + ' Weekly pattern <span class="mtg-h3-sub">' +
      (A.isAdmin() && A.state.ui.ooFilter === 'all' ? 'every recurring one-on-one in the lab' : 'the times you’re part of, and the open ones you can take') + '</span></h3>' + body + '</section>';
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
    const me = A.me();
    const parts = [];
    // every week (back-to-back slots joined)
    standingGroups(mine()).forEach(g => {
      const s = g.slots[0];
      const next = g.slots.map(x => nextOccurrence(x)).filter(Boolean).sort()[0];
      const role = hostRole(s.hostUid);
      parts.push('<div class="oo-mine"><div>' +
        '<b>' + esc(everyLabel(s)) + ' ' + esc(span(g.start, g.end)) + '</b> with <b>' + esc(A.memberName(s.hostUid, s.hostName)) + '</b>' + (role ? ' <span class="mtg-muted">(' + esc(role) + ')</span>' : '') +
        '<div class="mtg-muted mtg-tiny">' + (g.slots.length > 1 ? esc(g.slots.length + ' back-to-back slots, ' + meetingLen(g.start, g.end)) + ' · ' : '') +
          (s.location ? esc(s.location) + ' · ' : '') + (next ? 'next ' + esc(A.fmtDate(next)) : s.endDate && s.endDate < A.todayStr() ? 'finished ' + esc(A.fmtDateShort(s.endDate)) : 'no upcoming date') +
          (s.note ? ' · ' + esc(s.note) : '') + '</div></div>' +
        '<div class="mtg-row-actions" style="margin:0">' +
          '<button type="button" class="mtg-btn mtg-btn-sm" data-act="oo-ics" data-id="' + esc(s.id) + '">' + icon('arrow-down-tray', { size: 'sm' }) + ' Add to calendar</button>' +
          '<button type="button" class="mtg-btn mtg-btn-sm mtg-btn-ghost" data-act="oo-open" data-id="' + esc(s.id) + '">' + icon('no-symbol', { size: 'sm' }) + ' Can’t make a date</button>' +
          '<button type="button" class="mtg-btn mtg-btn-sm mtg-btn-ghost" data-act="oo-unsubscribe" data-id="' + esc(s.id) + '">Unsubscribe</button>' +
        '</div></div>');
    });
    // this week only (unique slots), joined per date
    myWeekEntries().forEach(e => {
      const s = e.slots[0];
      const pend = e.slots.every(x => (x.recurRequests || {})[me]);
      const ids = e.slots.map(x => x.id).join(',');
      parts.push('<div class="oo-mine oo-mine-week"><div>' +
        '<b>' + esc(A.fmtDate(e.date)) + ' ' + esc(span(e.start, e.end)) + '</b> with <b>' + esc(A.memberName(s.hostUid, s.hostName)) + '</b> <span class="mtg-chip mtg-chip-muted">this week only</span>' +
        '<div class="mtg-muted mtg-tiny">' + (e.slots.length > 1 ? esc(e.slots.length + ' back-to-back slots, ' + meetingLen(e.start, e.end)) + ' · ' : '') + (s.location ? esc(s.location) : '') +
          (pend ? ' · waiting for ' + esc(A.firstName(s.hostUid, s.hostName)) + ' to approve every week' : '') + '</div></div>' +
        '<div class="mtg-row-actions" style="margin:0">' +
          (s.subscriberUid ? '' : pend
            ? '<button type="button" class="mtg-btn mtg-btn-sm mtg-btn-ghost" data-act="oo-withdraw" data-ids="' + esc(ids) + '">Withdraw request</button>'
            : '<button type="button" class="mtg-btn mtg-btn-sm" data-act="oo-request" data-ids="' + esc(ids) + '" data-date="' + e.date + '">' + icon('arrow-path', { size: 'sm' }) + ' Ask to make it every week</button>') +
          '<button type="button" class="mtg-btn mtg-btn-sm mtg-btn-ghost" data-act="oo-ics-week" data-id="' + esc(s.id) + '" data-date="' + e.date + '">' + icon('arrow-down-tray', { size: 'sm' }) + ' Add to calendar</button>' +
          '<button type="button" class="mtg-btn mtg-btn-sm mtg-btn-ghost" data-act="oo-cancel-week" data-ids="' + esc(ids) + '" data-date="' + e.date + '">Cancel</button>' +
        '</div></div>');
    });
    // requests waiting on me (host)
    pendingGroups().filter(g => g.hostUid === me || A.isAdmin()).forEach(g => {
      const ids = g.slots.map(x => x.id).join(',');
      parts.push('<div class="oo-mine oo-mine-req"><div>' + icon('arrow-path', { size: 'sm' }) + ' <b>' + esc(A.memberName(g.uid, g.name)) + '</b> asks to make <b>' + esc(dowPlural(g.weekday)) + ' ' + esc(span(g.start, g.end)) + '</b> every week' +
        (g.from ? ', from ' + esc(A.fmtDate(g.from)) : '') + (g.hostUid !== me ? ' <span class="mtg-muted">(' + esc(A.firstName(g.hostUid)) + '’s slot)</span>' : '') + '</div>' +
        '<div class="mtg-row-actions" style="margin:0">' +
          '<button type="button" class="mtg-btn mtg-btn-sm mtg-btn-primary" data-act="oo-approve" data-ids="' + esc(ids) + '" data-uid="' + esc(g.uid) + '" data-date="' + esc(g.from || '') + '">' + icon('check', { size: 'sm' }) + ' Approve</button>' +
          '<button type="button" class="mtg-btn mtg-btn-sm mtg-btn-ghost" data-act="oo-decline" data-ids="' + esc(ids) + '" data-uid="' + esc(g.uid) + '">Decline</button>' +
        '</div></div>');
    });
    const hostedRows = hosted();
    if (hostedRows.length) {
      const booked = hostedRows.filter(s => s.subscriberUid), free = hostedRows.filter(s => !s.subscriberUid);
      parts.push('<div class="oo-mine"><div><b>You host ' + hostedRows.length + ' recurring time' + (hostedRows.length === 1 ? '' : 's') + '</b>' +
        '<div class="mtg-muted mtg-tiny">' + booked.map(s => esc(A.dowName(+s.weekday).slice(0, 3) + ' ' + tShort(s.time) + ' ' + A.firstName(s.subscriberUid, s.subscriberName))).join(' · ') +
          (free.length ? (booked.length ? ' · ' : '') + free.length + ' open' : '') + '</div></div>' +
        (inTab ? '' : '<a class="mtg-btn mtg-btn-sm" href="#" data-act="tab" data-id="oneonone">Open the calendar</a>') + '</div>');
    }
    if (!mine().length && !myWeekEntries().length) {
      const openHosts = Array.from(new Set(openFromMyHosts().map(s => s.hostUid)));
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
    const v = s || { weekday: (wd >= 1 && wd <= 5) ? wd : 2, time: '14:00', duration: 30, cadence: 'weekly', mode: 'recurring', location: lastLocation(), startDate: today, endDate: c.semesterEnd && c.semesterEnd >= today ? c.semesterEnd : '', note: '' };
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
        // V3.940 — unique: a sign-up is one week; the student can ask for every week
        '<label class="mtg-radio oo-unique-toggle"><input type="checkbox" name="unique"' + (v.mode === 'unique' ? ' checked' : '') + '> <span><b>Make unique</b> — a student signs up for one week at a time. They can ask to make it every week, and it becomes every week when you approve.</span></label>' +
        '<label>Note for the student <small>(optional)</small><input type="text" name="note" value="' + esc(v.note || '') + '" maxlength="200" placeholder="e.g. bring your latest figures"></label>' +
        (pool.length ? '<label>Reserve every week for<select name="reserveUid"><option value="">Open — any of your students can take it</option>' + pool.map(u => '<option value="' + esc(u.uid) + '">' + esc(u.name || u.email) + '</option>').join('') + '</select></label>' : '') +
        '<p class="mtg-muted mtg-tiny">' + (s ? 'Switching to or from unique changes how the NEXT sign-up works; whoever already has it every week keeps it. The student is told if the time moves.' : 'Your students see open times on this tab and sign up themselves. Reserving puts a student there every week and tells them. Back-to-back slots start one after another; a student who takes two in a row has one longer meeting.') + '</p>' +
        '<div class="mtg-row-actions"><button type="submit" class="mtg-btn mtg-btn-primary">' + (s ? 'Save' : 'Offer') + '</button><button type="button" class="mtg-btn mtg-cancel">Cancel</button></div></form>';
      body.querySelector('.mtg-cancel').addEventListener('click', () => api.close());
      body.querySelector('form').addEventListener('submit', async ev => {
        ev.preventDefault();
        const f = ev.target;
        const fields = {
          weekday: +f.weekday.value, time: f.time.value, duration: +f.duration.value, cadence: f.cadence.value,
          location: f.location.value.trim(), note: f.note.value.trim(), startDate: f.startDate.value || today, endDate: f.endDate.value || null,
          count: f.count ? +f.count.value : 1, reserveUid: f.reserveUid ? f.reserveUid.value : '', unique: !!f.unique.checked,
        };
        if (fields.endDate && fields.endDate < fields.startDate) { A.toast('warn', 'The end date is before the start date'); return; }
        api.close();
        try {
          if (s) { await editSlot(s.id, fields); A.toast('success', 'Time updated'); }
          else {
            const ids = await createSlots(fields);
            A.toast('success', (ids.length === 1 ? 'Time offered — ' + dowPlural(fields.weekday) + ' ' + A.fmtTime(fields.time) : ids.length + ' back-to-back times offered on ' + dowPlural(fields.weekday)) + (fields.unique ? ' (one week at a time)' : ''));
          }
        } catch (e) { A.toast('error', (e && e.code === 'permission-denied') ? 'You don’t have permission to do that.' : 'Failed: ' + (e && e.message)); }
      });
    } });
  }

  /* every week — recurring slots */
  function openSubscribeSheet(id) {
    const A = M();
    const s = slot(id);
    if (!s || !mayTake(s)) { A.toast('warn', 'That time was just taken'); return; }
    const role = hostRole(s.hostUid);
    const nx = nextAdjacent(s);
    const nxOk = nx && mayTake(nx);
    A.sheet({ title: 'Subscribe — ' + dowPlural(s.weekday) + ' ' + A.fmtRange(s.time, s.duration), build(body, api) {
      const next = nextOccurrence(s);
      body.innerHTML = '<p class="mtg-confirm-msg">A recurring one-on-one with <b>' + esc(A.memberName(s.hostUid, s.hostName)) + '</b>' + (role ? ' (' + esc(role) + ')' : '') + ': <b>' + esc(cadenceLabel(s).toLowerCase()) + '</b> on ' + esc(dowPlural(s.weekday)) + ', ' + esc(A.fmtRange(s.time, s.duration)) +
        (s.location ? ', in ' + esc(s.location) : '') + (next ? '. First one ' + esc(A.fmtDateLong(next)) : '') + (s.endDate ? ', through ' + esc(A.fmtDateShort(s.endDate)) : '') + '.</p>' +
        (s.note ? '<p class="mtg-muted">“' + esc(s.note) + '”</p>' : '') +
        (nxOk ? '<label class="mtg-radio"><input type="checkbox" class="oo-also-next"> Also take ' + esc(span(nx.time, endOf(nx))) + ' — ' + esc(meetingLen(s.time, endOf(nx))) + ' (' + esc(span(s.time, endOf(nx))) + ')</label>' : '') +
        '<p class="mtg-muted mtg-tiny">You get a reminder the afternoon before each one. If you can’t make a week, mark it skipped from the calendar — ' + esc(A.firstName(s.hostUid, s.hostName)) + ' is told.</p>' +
        '<div class="mtg-row-actions"><button type="button" class="mtg-btn mtg-btn-primary oo-yes">' + icon('check', { size: 'sm' }) + ' Subscribe</button><button type="button" class="mtg-btn mtg-cancel">Not now</button></div>';
      body.querySelector('.mtg-cancel').addEventListener('click', () => api.close());
      body.querySelector('.oo-yes').addEventListener('click', async () => {
        const btn = body.querySelector('.oo-yes');
        const also = body.querySelector('.oo-also-next');
        const ids = [id].concat(also && also.checked ? [nx.id] : []);
        btn.disabled = true;
        try {
          await subscribe(ids);
          const end = ids.length > 1 ? endOf(nx) : endOf(s);
          body.innerHTML = '<p class="mtg-confirm-msg">' + icon('check-circle', { size: 'sm' }) + ' You’re on <b>' + esc(A.firstName(s.hostUid, s.hostName)) + '</b>’s calendar — ' + esc(cadenceLabel(s).toLowerCase()) + ', ' + esc(dowPlural(s.weekday)) + ' ' + esc(span(s.time, end)) + '.</p>' +
            '<div class="mtg-row-actions"><button type="button" class="mtg-btn mtg-btn-primary oo-ics">' + icon('arrow-down-tray', { size: 'sm' }) + ' Add to my calendar</button><button type="button" class="mtg-btn mtg-cancel">Done</button></div>';
          body.querySelector('.mtg-cancel').addEventListener('click', () => api.close());
          body.querySelector('.oo-ics').addEventListener('click', () => { downloadStanding(slot(id)); api.close(); });
          A.render();
        } catch (e) {
          api.close();
          A.toast('error', (e && e.code === 'permission-denied') ? 'That time is no longer open.' : 'Failed: ' + (e && e.message));
        }
      });
    } });
  }

  /* one week — unique slots (V3.940) */
  function openBookSheet(id, date) {
    const A = M();
    const s = slot(id);
    if (!s || !mayBook(s, date)) { A.toast('warn', 'That week was just taken'); return; }
    const role = hostRole(s.hostUid);
    const nx = nextAdjacent(s);
    const nxOk = nx && mayBook(nx, date);
    A.sheet({ title: 'Book ' + A.fmtDate(date) + ' ' + A.fmtRange(s.time, s.duration), build(body, api) {
      body.innerHTML = '<p class="mtg-confirm-msg">A one-on-one with <b>' + esc(A.memberName(s.hostUid, s.hostName)) + '</b>' + (role ? ' (' + esc(role) + ')' : '') + ' on <b>' + esc(A.fmtDateLong(date)) + '</b>, ' + esc(A.fmtRange(s.time, s.duration)) +
        (s.location ? ', in ' + esc(s.location) : '') + ' — <b>this week only</b>.</p>' +
        (s.note ? '<p class="mtg-muted">“' + esc(s.note) + '”</p>' : '') +
        (nxOk ? '<label class="mtg-radio"><input type="checkbox" class="oo-also-next"> Also take ' + esc(span(nx.time, endOf(nx))) + ' — ' + esc(meetingLen(s.time, endOf(nx))) + ' (' + esc(span(s.time, endOf(nx))) + ')</label>' : '') +
        '<label class="mtg-radio"><input type="checkbox" class="oo-ask-every"> Ask ' + esc(A.firstName(s.hostUid, s.hostName)) + ' to make it every ' + esc(A.dowName(+s.weekday)) + ' from then on</label>' +
        '<div class="mtg-row-actions"><button type="button" class="mtg-btn mtg-btn-primary oo-yes">' + icon('check', { size: 'sm' }) + ' Book this week</button><button type="button" class="mtg-btn mtg-cancel">Not now</button></div>';
      body.querySelector('.mtg-cancel').addEventListener('click', () => api.close());
      body.querySelector('.oo-yes').addEventListener('click', async () => {
        const btn = body.querySelector('.oo-yes');
        const also = body.querySelector('.oo-also-next');
        const ask = body.querySelector('.oo-ask-every');
        const ids = [id].concat(also && also.checked ? [nx.id] : []);
        btn.disabled = true;
        try {
          await bookWeek(ids, date, { request: !!(ask && ask.checked) });
          const end = ids.length > 1 ? endOf(nx) : endOf(s);
          body.innerHTML = '<p class="mtg-confirm-msg">' + icon('check-circle', { size: 'sm' }) + ' Booked: <b>' + esc(A.fmtDate(date)) + ' ' + esc(span(s.time, end)) + '</b> with ' + esc(A.firstName(s.hostUid, s.hostName)) + '.' +
            (ask && ask.checked ? ' You asked to make it every week — you’ll hear when ' + esc(A.firstName(s.hostUid, s.hostName)) + ' answers.' : '') + '</p>' +
            '<div class="mtg-row-actions"><button type="button" class="mtg-btn mtg-btn-primary oo-ics">' + icon('arrow-down-tray', { size: 'sm' }) + ' Add to my calendar</button><button type="button" class="mtg-btn mtg-cancel">Done</button></div>';
          body.querySelector('.mtg-cancel').addEventListener('click', () => api.close());
          body.querySelector('.oo-ics').addEventListener('click', () => { downloadWeek(slot(id), date); api.close(); });
        } catch (e) {
          api.close();
          A.toast('error', (e && e.code === 'taken') ? 'That week was just taken — pick another.'
            : (e && e.code === 'permission-denied') ? 'Couldn’t book that week — the slot may have just closed. Refresh and try again.'
            : 'Failed: ' + (e && e.message));
        }
      });
    } });
  }

  /* details: who, repeat, upcoming dates with their holder, and what you may do */
  function openSlotSheet(id) {
    const A = M();
    if (!slot(id)) return;
    A.sheet({ title: dowPlural(slot(id).weekday) + ' ' + A.fmtRange(slot(id).time, slot(id).duration), build(body, api) {
      function fill() {
        const s = slot(id);
        if (!s) { body.innerHTML = '<p class="mtg-muted">This time is gone.</p>'; return; }
        const me = A.me();
        const iHost = isHostOf(s);
        const role = hostRole(s.hostUid);
        const uniq = isUnique(s);
        const g = s.subscriberUid ? groupForSlot(s) : null;
        const reqs = requestsOf(s);
        const dates = upcoming(s, 6);
        const myDates = myBookedDates(s);
        const actions = [];
        if (mayTake(s)) actions.push('<button type="button" class="mtg-btn mtg-btn-primary" data-oo="subscribe">' + icon('check', { size: 'sm' }) + ' Subscribe</button>');
        if (isMine(s) || (iHost && s.subscriberUid)) actions.push('<button type="button" class="mtg-btn" data-oo="ics">' + icon('arrow-down-tray', { size: 'sm' }) + ' Add to calendar</button>');
        if (isMine(s)) actions.push('<button type="button" class="mtg-btn mtg-btn-ghost" data-oo="unsubscribe">Unsubscribe</button>');
        if (uniq && !s.subscriberUid && myDates.length && !(s.recurRequests || {})[me]) actions.push('<button type="button" class="mtg-btn" data-oo="request" data-date="' + myDates[0] + '">' + icon('arrow-path', { size: 'sm' }) + ' Ask to make it every week</button>');
        if ((s.recurRequests || {})[me]) actions.push('<button type="button" class="mtg-btn mtg-btn-ghost" data-oo="withdraw">Withdraw every-week request</button>');
        if (iHost) {
          actions.push('<button type="button" class="mtg-btn" data-oo="reserve">' + (s.subscriberUid ? icon('user', { size: 'sm' }) + ' Change student' : icon('plus', { size: 'sm' }) + ' Reserve every week for…') + '</button>');
          if (s.subscriberUid) actions.push('<button type="button" class="mtg-btn mtg-btn-ghost" data-oo="oneweek">Make it one week only</button>');
          actions.push('<button type="button" class="mtg-btn" data-oo="edit">' + icon('pencil-square', { size: 'sm' }) + ' Edit</button>');
          if (s.active !== false) actions.push('<button type="button" class="mtg-btn mtg-btn-ghost" data-oo="end">' + icon('no-symbol', { size: 'sm' }) + ' End</button>');
          actions.push('<button type="button" class="mtg-btn mtg-btn-ghost mtg-danger" data-oo="delete">' + icon('trash', { size: 'sm' }) + ' Delete</button>');
        }
        const standingMe = isMine(s);
        const rows = dates.map(o => {
          const h = holderOn(s, o.date);
          const sk = h.state === 'skipped' ? ((s.skips || {})[o.date] || {}) : null;
          let who, btns = '';
          if (h.state === 'week') who = esc(A.firstName(h.uid, h.name)) + ' <span class="mtg-muted mtg-tiny">this week only</span>';
          else if (h.state === 'standing') who = esc(A.firstName(h.uid, h.name));
          else if (h.state === 'skipped') who = '<span class="mtg-muted mtg-tiny">skipped' + (sk.name ? ' by ' + esc(sk.name.split(/\s+/)[0]) : '') + (sk.reason ? ' — ' + esc(sk.reason) : '') + '</span>';
          else who = '<span class="mtg-muted mtg-tiny">open</span>';
          // the every-week holder (or the host) skips / un-skips
          if ((standingMe || iHost) && s.subscriberUid && standingOn(s, o.date) && h.state !== 'week') {
            btns += h.state === 'skipped'
              ? '<button type="button" class="mtg-btn mtg-btn-xs" data-oo="unskip" data-date="' + o.date + '">' + icon('arrow-uturn-left', { size: 'xs' }) + ' Back on</button>'
              : '<button type="button" class="mtg-btn mtg-btn-xs mtg-btn-ghost" data-oo="skip" data-date="' + o.date + '">Skip</button>';
          }
          if (h.state === 'week' && h.uid === me) btns += '<button type="button" class="mtg-btn mtg-btn-xs mtg-btn-ghost" data-oo="cancel-week" data-date="' + o.date + '" data-uid="' + esc(me) + '">Cancel my week</button>';
          if (h.state === 'week' && iHost && h.uid !== me) {
            btns += '<button type="button" class="mtg-btn mtg-btn-xs" data-oo="every-from" data-date="' + o.date + '" data-uid="' + esc(h.uid) + '">Make it every week</button>' +
                    '<button type="button" class="mtg-btn mtg-btn-xs mtg-btn-ghost" data-oo="cancel-week" data-date="' + o.date + '" data-uid="' + esc(h.uid) + '">Cancel</button>';
          }
          if (uniq && mayBook(s, o.date)) btns += '<button type="button" class="mtg-btn mtg-btn-xs mtg-btn-primary" data-oo="book" data-date="' + o.date + '">Book this week</button>';
          if (uniq && iHost && isOpenFor(h, s)) btns += '<button type="button" class="mtg-btn mtg-btn-xs mtg-btn-ghost" data-oo="book-for" data-date="' + o.date + '">Book for…</button>';
          return '<li' + (h.state === 'skipped' ? ' class="oo-date-skip"' : '') + '><span>' + esc(A.fmtDate(o.date)) + '</span><span class="oo-date-who">' + who + '</span>' + btns + '</li>';
        }).join('');
        body.innerHTML = '<dl class="mtg-dl">' +
          '<dt>Host</dt><dd>' + A.avatar(s.hostUid, s.hostName) + ' ' + esc(A.memberName(s.hostUid, s.hostName)) + (role ? ' <span class="mtg-muted">(' + esc(role) + ')</span>' : '') + '</dd>' +
          '<dt>Sign-up</dt><dd>' + (uniq ? 'Unique — one week at a time; every week on approval' : 'Every week') + '</dd>' +
          '<dt>Every week</dt><dd>' + (s.subscriberUid ? A.avatar(s.subscriberUid, s.subscriberName) + ' ' + esc(A.memberName(s.subscriberUid, s.subscriberName)) + (isMine(s) ? ' <span class="mtg-you">you</span>' : '') +
              (s.subscribedFrom ? ' <span class="mtg-muted mtg-tiny">from ' + esc(A.fmtDateShort(s.subscribedFrom)) + '</span>' : '') : '<span class="mtg-chip mtg-chip-muted">nobody</span>') + '</dd>' +
          (g && g.slots.length > 1 ? '<dt>Joined</dt><dd>' + esc(span(g.start, g.end)) + ' — ' + esc(meetingLen(g.start, g.end)) + ' across ' + g.slots.length + ' slots</dd>' : '') +
          '<dt>Repeats</dt><dd>' + esc(repeatLine(s)) + (s.active === false ? ' <span class="mtg-status mtg-status-cancelled">ended</span>' : '') + '</dd>' +
          (s.location ? '<dt>Where</dt><dd>' + esc(s.location) + '</dd>' : '') +
          (s.note ? '<dt>Note</dt><dd>' + esc(s.note) + '</dd>' : '') +
          (reqs.length ? '<dt>Asks</dt><dd>' + reqs.map(r => esc(A.memberName(r.uid, r.name)) + ' wants every week' + (r.from ? ' from ' + esc(A.fmtDateShort(r.from)) : '') +
              (iHost ? ' <button type="button" class="mtg-btn mtg-btn-xs mtg-btn-primary" data-oo="approve" data-uid="' + esc(r.uid) + '" data-date="' + esc(r.from || '') + '">Approve</button> <button type="button" class="mtg-btn mtg-btn-xs mtg-btn-ghost" data-oo="decline" data-uid="' + esc(r.uid) + '">Decline</button>' : '')).join('<br>') + '</dd>' : '') +
        '</dl>' +
        (dates.length ? '<h4 style="margin:12px 0 2px">Upcoming</h4>' +
          ((standingMe || iHost) && s.subscriberUid ? '<input type="text" class="mtg-input" id="oo-skip-reason" placeholder="Reason for skipping (optional — the other person sees it)" maxlength="120" style="width:100%;box-sizing:border-box;margin:4px 0">' : '') +
          '<ul class="oo-dates">' + rows + '</ul>' : '<p class="mtg-muted mtg-tiny">No upcoming dates.</p>') +
        (actions.length ? '<div class="mtg-row-actions">' + actions.join('') + '</div>' : '');
      }
      fill();
      body.addEventListener('click', async ev => {
        const b = ev.target.closest('[data-oo]');
        if (!b) return;
        const s = slot(id);
        if (!s) return;
        const what = b.dataset.oo;
        const date = b.dataset.date;
        // a joined every-week block skips together
        const groupIds = (s.subscriberUid ? groupForSlot(s).slots : [s]).map(x => x.id);
        try {
          if (what === 'skip') { b.disabled = true; const r = body.querySelector('#oo-skip-reason'); await skipDate(groupIds, date, r ? r.value.trim() : ''); fill(); A.render(); return; }
          if (what === 'unskip') { b.disabled = true; await unskipDate(groupIds, date); fill(); A.render(); return; }
          if (what === 'cancel-week') {
            b.disabled = true;
            const who = b.dataset.uid;
            const e = entriesOn(all().filter(x => x.active !== false), date).find(x => x.slots.some(y => y.id === id));
            await cancelWeek(e ? e.slots.map(x => x.id) : [id], date, who);
            A.toast('info', 'Cancelled ' + A.fmtDate(date)); fill(); A.render(); return;
          }
          if (what === 'request') { b.disabled = true; await requestRecurring(myWeekIdsFor(s, date), date); A.toast('success', 'Asked ' + A.firstName(s.hostUid, s.hostName) + ' to make it every week'); fill(); A.render(); return; }
          if (what === 'withdraw') { b.disabled = true; await withdrawRequest(all().filter(x => (x.recurRequests || {})[A.me()] && x.hostUid === s.hostUid && +x.weekday === +s.weekday).map(x => x.id)); fill(); A.render(); return; }
          if (what === 'approve') { b.disabled = true; await approve(requestIds(s, b.dataset.uid), b.dataset.uid, date); fill(); A.render(); return; }
          if (what === 'decline') { b.disabled = true; await withdrawRequest(requestIds(s, b.dataset.uid), b.dataset.uid); A.toast('info', 'Declined'); fill(); A.render(); return; }
          if (what === 'every-from') { b.disabled = true; await approve(weekIdsFor(s, date, b.dataset.uid), b.dataset.uid, date); fill(); A.render(); return; }
          if (what === 'ics') { downloadStanding(s); return; }
          api.close();
          if (what === 'subscribe') openSubscribeSheet(id);
          else if (what === 'book') openBookSheet(id, date);
          else if (what === 'book-for') pickBookFor(id, date);
          else if (what === 'unsubscribe') confirmUnsubscribe(id);
          else if (what === 'reserve') pickReserve(id);
          else if (what === 'oneweek') confirmOneWeek(id);
          else if (what === 'edit') openOfferSheet(id);
          else if (what === 'end') confirmEnd(id);
          else if (what === 'delete') confirmDelete(id);
        } catch (e) {
          A.toast('error', (e && e.code === 'permission-denied') ? 'You don’t have permission to do that.' : (e && e.code === 'taken') ? 'That week was just taken.' : 'Failed: ' + (e && e.message));
          fill();
        }
      });
    } });
  }
  /* the slots in my joined one-week block on date that contains slot s */
  function myWeekIdsFor(s, date) {
    const e = entriesOn(all().filter(x => x.active !== false), date).find(x => x.slots.some(y => y.id === s.id));
    return e ? e.slots.map(x => x.id) : [s.id];
  }
  function weekIdsFor(s, date, uid) {
    const e = entriesOn(all().filter(x => x.active !== false), date).find(x => x.slots.some(y => y.id === s.id) && x.h.uid === uid);
    return e ? e.slots.map(x => x.id) : [s.id];
  }
  /* the request group (adjacent slots, same student) that contains slot s */
  function requestIds(s, uid) {
    const g = pendingGroups().find(x => x.uid === uid && x.slots.some(y => y.id === s.id));
    return g ? g.slots.map(x => x.id) : [s.id];
  }
  async function approve(ids, uid, from) {
    const A = M();
    const clash = await makeEveryWeek(ids, uid, from || null);
    A.toast(clash.length ? 'warn' : 'success', clash.length
      ? 'Made it every week where the slot was free; ' + clash.map(x => A.fmtTime(x.time)).join(', ') + ' already has someone every week'
      : A.firstName(uid) + ' now has it every week' + (from ? ' from ' + A.fmtDate(from) : '') + ' — they’ve been told');
  }

  function pickReserve(id) {
    const A = M();
    const s = slot(id);
    if (!s) return;
    const pool = reservePool(s.hostUid);
    A.openMemberPicker('Reserve ' + dowPlural(s.weekday) + ' ' + A.fmtTime(s.time) + ' every week for…', {
      only: pool.map(u => u.uid), exclude: s.subscriberUid ? [s.subscriberUid] : [],
      allowNone: !!s.subscriberUid, noneLabel: 'Make it open again',
      emptyText: 'Nobody to pick — you’re not listed as anyone’s mentor yet (Settings → Permissions → Mentors).',
    }, async uid => {
      await reserve(id, uid || null);
      A.toast('success', uid ? A.firstName(uid) + ' is on your calendar every week — they’ve been told' : 'The time is open again');
    });
  }
  function pickBookFor(id, date) {
    const A = M();
    const s = slot(id);
    if (!s) return;
    A.openMemberPicker('Book ' + A.fmtDate(date) + ' ' + A.fmtTime(s.time) + ' for…', {
      only: reservePool(s.hostUid).map(u => u.uid),
      emptyText: 'Nobody to pick — you’re not listed as anyone’s mentor yet (Settings → Permissions → Mentors).',
    }, async uid => {
      if (!uid) return;
      await bookWeek([id], date, { uid });
      A.toast('success', A.firstName(uid) + ' is booked for ' + A.fmtDate(date) + ' — they’ve been told');
    });
  }
  function confirmUnsubscribe(id) {
    const A = M();
    const s = slot(id);
    if (!s) return;
    const ids = groupForSlot(s).slots.map(x => x.id);
    A.openConfirm('Stop meeting ' + A.firstName(s.hostUid, s.hostName) + ' ' + dowPlural(s.weekday).toLowerCase() + ' at ' + A.fmtTime(s.time) + (ids.length > 1 ? ' (all ' + ids.length + ' back-to-back slots)' : '') + '? The time opens up for someone else and ' + A.firstName(s.hostUid, s.hostName) + ' is told.', 'Unsubscribe', async () => {
      await unsubscribe(ids);
      A.toast('info', 'Unsubscribed');
    });
  }
  function confirmOneWeek(id) {
    const A = M();
    const s = slot(id);
    if (!s || !s.subscriberUid) return;
    const ids = groupForSlot(s).slots.map(x => x.id);
    A.openConfirm('Make ' + A.firstName(s.subscriberUid, s.subscriberName) + '’s ' + dowPlural(s.weekday).toLowerCase() + ' ' + A.fmtTime(s.time) + ' one week only? They keep the next date; after that the time is open again. They are told.', 'One week only', async () => {
      const kept = await makeOneWeek(ids);
      A.toast('success', kept ? 'One week only — ' + A.firstName(s.subscriberUid, s.subscriberName) + ' keeps ' + A.fmtDate(kept) : 'One week only');
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

  /* a calendar chip: an open time → sign up, anything else → details */
  function onChip(id, date) {
    const s = slot(id);
    if (!s) return;
    if (isUnique(s) && mayBook(s, date)) return openBookSheet(id, date);
    if (!isUnique(s) && mayTake(s)) return openSubscribeSheet(id);
    openSlotSheet(id);
  }

  /* ═══ events (delegated from meetings.js: data-act="oo-*") ═════ */
  async function onAct(act, btn) {
    const A = M();
    const id = btn.dataset.id;
    const ids = btn.dataset.ids ? btn.dataset.ids.split(',').filter(Boolean) : (id ? [id] : []);
    const date = btn.dataset.date;
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
      case 'oo-chip': onChip(id, date); break;
      case 'oo-open': openSlotSheet(id); break;
      case 'oo-subscribe': openSubscribeSheet(id); break;
      case 'oo-book': openBookSheet(id, date); break;
      case 'oo-unsubscribe': confirmUnsubscribe(id); break;
      case 'oo-reserve': pickReserve(id); break;
      case 'oo-ics': downloadStanding(slot(id)); break;
      case 'oo-ics-week': downloadWeek(slot(id), date); break;
      case 'oo-request': await requestRecurring(ids, date); A.toast('success', 'Asked to make it every week'); A.render(); break;
      case 'oo-withdraw': await withdrawRequest(ids); A.toast('info', 'Request withdrawn'); A.render(); break;
      case 'oo-cancel-week': {
        const s = slot(ids[0]);
        A.openConfirm('Cancel ' + A.fmtDate(date) + (s ? ' with ' + A.firstName(s.hostUid, s.hostName) : '') + '? The week opens up for someone else.', 'Cancel it', async () => {
          await cancelWeek(ids, date);
          A.toast('info', 'Cancelled');
        });
        break;
      }
      case 'oo-approve': await approve(ids, btn.dataset.uid, date); A.render(); break;
      case 'oo-decline': await withdrawRequest(ids, btn.dataset.uid); A.toast('info', 'Declined — they keep the weeks they booked'); A.render(); break;
      case 'oo-end': confirmEnd(id); break;
      case 'oo-delete': confirmDelete(id); break;
      default: break;
    }
  }

  window.MEETINGS_ONE_ON_ONE = {
    render, renderMine, badge, onAct,
    onChange: async () => {}, onSubmit: async () => {},
    // for tests / other modules
    occursOn, nextOccurrence, upcoming, holderOn, entriesOn, standingGroups, myWeekEntries, pendingGroups,
    icsFor, icsWrap, icsStandingEvent, icsWeekEvent, myHosts, canHost, menteesOf, visible, mine, hosted,
    PATH, COLL,
  };
})();
