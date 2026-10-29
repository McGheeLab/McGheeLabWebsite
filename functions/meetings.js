/* ================================================================
   meetings.js — Lab Meetings reminders + swap execution (V3.743)
   ================================================================
   Three jobs, all through helpers/notify.js notifyUsers() so every notice
   is BOTH a push and a row in the recipient's My Week 🔔 feed, gated by the
   per-user `notifications.apps.meetings.push` toggle (which existed since
   V3.4x and never controlled anything until now).

   1. meetingReminders — daily at 09:00 and 16:00 Phoenix. For each
      upcoming meeting in the next 7 days, decide who owes what and nudge
      once, deduped with dotted-path flags on the meeting doc exactly like
      equipment-reminders.js (`reminded.presenter`, `.submitCall`,
      `.deckCall`, `.reviewCall`, `.dayBefore`). For a Friday meeting:
        Mon   presenter(s)      "You present Friday — add your slides link"
        Wed   everyone else     "Send <presenter> your 1–2 slides by Thu"
        Thu   presenter         "N of M slides in — build the combined deck"
        Thu   reviewers (PI)    "Deck ready for review"    (fallback; the
                                trigger below does the immediate one)
        Thu   whoever blocks    afternoon: no deck yet / review still pending
      Flash-talk weeks nudge everyone once; break weeks are skipped.

   2. onMeetingSwapWritten — meetingSwaps/{id}. On create, tell the target.
      On pending→accepted, EXECUTE THE SWAP: move both presenter entries
      across the two meeting docs in one transaction, resolving each party
      by uid at execution time (never by the slot stored at request time —
      the board may have moved). This is server-side on purpose: the rules
      let a member touch only their OWN presenters key, so the accepter
      cannot legally write the requester's entry. Then tell the requester
      and the coordinators. Declined / cancelled → tell the other party.

   4. onOneOnOneSlotWritten — oneOnOneSlots/{id} (V3.938). A student
      subscribed / left (→ the host), the host reserved / unbooked / moved /
      ended / deleted the time (→ the student), a week skipped or un-skipped
      (→ the other party). The 16:00 reminder pass also sends tomorrow's
      one-on-ones: one notice per student, ONE per host listing them all.

   3. onMeetingWritten — meetings/{id}. EARLY-EXIT GUARD FIRST: this fires on
      every debounced minutes keystroke during a live meeting, so it must
      return after two field compares unless something notification-worthy
      changed: the combined deck was posted (→ reviewers), the PI review
      status changed (→ presenters + coordinators), or someone new appears
      in `presenters` (→ them).

   Pure decision logic lives in _internal for functions/test/meetings.test.js.
   ================================================================ */

'use strict';

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { notifyUsers } = require('./helpers/notify');

const APP_KEY = 'meetings';
const PAGE = '/rm/pages/meetings.html';
const TZ = 'America/Phoenix';

/* Days before the meeting each nudge fires (Fri meeting → Mon / Wed / Thu). */
const PRESENTER_DAYS = 4;
const SUBMIT_DAYS = 2;
const DECK_DAYS = 1;
const AFTERNOON_MIN = 12 * 60;   // the 16:00 pass handles the day-before chase

/* ─── time helpers (same approach as equipment-reminders.js) ───── */
function phoenixNow(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(date || new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (+parts.hour) * 60 + (+parts.minute),
    weekday: parts.weekday,
  };
}
function shiftDateStr(dateStr, days) {
  const p = String(dateStr).split('-');
  const d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  const pa = String(a).split('-'), pb = String(b).split('-');
  return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 86400000);
}
function weekdayName(dateStr) {
  const p = String(dateStr).split('-');
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay()];
}
function fmtShort(dateStr) {
  const p = String(dateStr).split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || 'someone'; }

/* ─── shape helpers ───────────────────────────────────────────── */
/* presenters: uid-keyed map (V3.743) or legacy array / presenterId. */
function presentersOf(m) {
  if (!m) return [];
  const p = m.presenters;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    return Object.keys(p).map((uid) => Object.assign({ uid }, p[uid] || {})).sort((a, b) => (a.slot || 0) - (b.slot || 0));
  }
  if (Array.isArray(p)) return p.map((x, i) => Object.assign({ slot: i }, x || {}));
  if (m.presenterId) return [{ uid: m.presenterId, name: m.presenterName || '', slot: 0 }];
  return [];
}
function presenterUids(m) { return presentersOf(m).map((p) => p.uid).filter(Boolean); }
function updatesOf(m) {
  const u = (m && m.updates) || {};
  return { submissions: u.submissions || {}, deck: u.deck || null, review: Object.assign({ status: null }, u.review || {}) };
}

/**
 * Who owes 1–2 slides: every visible lab member minus presenters minus
 * reviewers. `members` = [{uid, role, category, hidden}] from users/.
 */
function submittersFor(m, members, reviewerUids) {
  const pres = new Set(presenterUids(m));
  const rev = new Set(reviewerUids || []);
  return attendees(members).filter((u) => !pres.has(u.uid) && !rev.has(u.uid));
}

/**
 * PURE (V3.744): who is at lab meetings. If the coordinator saved a roster
 * (`meetingConfig.attendeeUids`), that list is the truth; otherwise every
 * visible member who isn't alumni. `members` rows carry `attendee: bool`
 * once applyRoster() has run; before that, fall back to the category rule.
 */
function applyRoster(members, cfg) {
  const ids = cfg && Array.isArray(cfg.attendeeUids) ? new Set(cfg.attendeeUids) : null;
  return members.map((u) => Object.assign({}, u, {
    attendee: ids ? ids.has(u.uid)
                  : !!(u.role && u.role !== 'guest' && !u.hidden && u.category !== 'collaborator' && u.category !== 'alumni'),
  }));
}
function attendees(members) {
  return members.filter((u) => u.attendee === true || (u.attendee === undefined && u.role && u.role !== 'guest' && !u.hidden && u.category !== 'collaborator' && u.category !== 'alumni'));
}

/**
 * PURE: what this pass should send for one meeting.
 * ctx = { today, minutes, members, reviewerUids, coordinatorUids, names(uid) }
 * Returns [{ flag, uids, title, body, kind, url }] — each entry is one
 * dedupe flag; the caller stamps `reminded.<flag>` after sending.
 */
function planReminders(m, ctx) {
  const out = [];
  if (!m || m.status !== 'upcoming' || m.kind === 'break' || !m.date) return out;
  const daysOut = daysBetween(ctx.today, m.date);
  if (daysOut < 0 || daysOut > 7) return out;
  const reminded = m.reminded || {};
  const pres = presentersOf(m);
  const presUids = pres.map((p) => p.uid).filter(Boolean);
  const dayWord = daysOut === 0 ? 'today' : daysOut === 1 ? 'tomorrow' : weekdayName(m.date);
  const when = `${dayWord}${m.time ? ' at ' + fmtTime(m.time) : ''}${m.location ? ' in ' + m.location : ''}`;
  const url = PAGE;

  if (m.kind === 'flash') {
    if (!reminded.presenter && daysOut <= PRESENTER_DAYS) {
      const everyone = attendees(ctx.members).map((u) => u.uid);
      out.push({ flag: 'presenter', uids: everyone, kind: 'reminder', url,
        title: `⚡ Flash talks ${dayWord}`, body: `Everyone presents ${when}. Bring 1–2 slides.` });
    }
    return out;
  }

  // Mon — presenters
  if (!reminded.presenter && daysOut <= PRESENTER_DAYS && presUids.length) {
    out.push({ flag: 'presenter', uids: presUids, kind: 'reminder', url,
      title: `🗣 You present ${dayWord}`,
      body: pres.every((p) => p.link) ? `Lab meeting ${when}. Your slides link is in — thanks.` : `Lab meeting ${when}. Add your slides link on the meetings page.` });
  }
  // Wed — everyone else owes 1–2 slides
  const u = updatesOf(m);
  const owe = submittersFor(m, ctx.members, ctx.reviewerUids).filter((x) => !u.submissions[x.uid]).map((x) => x.uid);
  if (!reminded.submitCall && daysOut <= SUBMIT_DAYS && owe.length && presUids.length) {
    const dueStr = fmtShort(shiftDateStr(m.date, -DECK_DAYS));
    const who = pres.map((p) => firstName(ctx.names(p.uid, p.name))).join(' & ');
    out.push({ flag: 'submitCall', uids: owe, kind: 'reminder', url,
      title: `📎 1–2 slides for ${who} by ${dueStr}`,
      body: `Round-robin updates ${dayWord}: send ${who} your slides link so the combined deck is ready for review.` });
  }
  // Thu — presenter builds the combined deck
  if (!reminded.deckCall && daysOut <= DECK_DAYS && !u.deck && presUids.length) {
    const expected = submittersFor(m, ctx.members, ctx.reviewerUids);
    const got = expected.filter((x) => u.submissions[x.uid]).length;
    const missing = expected.filter((x) => !u.submissions[x.uid]).map((x) => firstName(ctx.names(x.uid))).slice(0, 6);
    out.push({ flag: 'deckCall', uids: presUids, kind: 'reminder', url,
      title: `🧩 ${got} of ${expected.length} slides in — build the deck`,
      body: (missing.length ? `Still missing: ${missing.join(', ')}. ` : 'Everyone is in. ') + 'Concatenate and post the combined deck for the PI to review.' });
  }
  // deck exists but the PI hasn't been asked (fallback for the trigger)
  if (!reminded.reviewCall && u.deck && ctx.reviewerUids.length) {
    out.push({ flag: 'reviewCall', uids: ctx.reviewerUids, kind: 'approval', url,
      title: `👀 Deck ready for review — ${fmtShort(m.date)}`, body: `${firstName(ctx.names(pres[0] && pres[0].uid))}’s combined deck is posted. Approve or request changes before ${dayWord}.` });
  }
  // day-before afternoon chase: whatever is still blocking
  if (!reminded.dayBefore && daysOut === 1 && ctx.minutes >= AFTERNOON_MIN) {
    if (!u.deck && presUids.length) {
      out.push({ flag: 'dayBefore', uids: presUids.concat(ctx.coordinatorUids), kind: 'reminder', url,
        title: `⏰ No combined deck yet for ${fmtShort(m.date)}`, body: 'The PI reviews it the day before — post the deck link now.' });
    } else if (u.deck && u.review.status !== 'approved' && ctx.reviewerUids.length) {
      out.push({ flag: 'dayBefore', uids: ctx.reviewerUids, kind: 'reminder', url,
        title: `⏰ Deck still awaiting your review — ${fmtShort(m.date)}`, body: u.review.status === 'changes' ? 'You requested changes; check whether they landed.' : 'Approve or request changes before tomorrow’s meeting.' });
    }
  }
  return out;
}
function fmtTime(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (isNaN(h)) return hhmm;
  return `${(h % 12) || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

/* PURE: classify a swap write. */
function swapTransition(before, after) {
  if (!after) return null;
  if (!before) return after.status === 'pending' ? 'created' : null;
  if (before.status === after.status) return null;
  if (after.status === 'accepted') return 'accepted';
  if (after.status === 'declined') return 'declined';
  if (after.status === 'cancelled') return 'cancelled';
  return null;
}

/* PURE: what changed on a meeting write that anyone needs to hear about.
 * Cheap on purpose — this runs on every minutes keystroke. */
const NEW_DOC_NOTIFY_DAYS = 30;
function meetingTransition(before, after, today) {
  if (!after) return null;
  const out = { deckPosted: false, reviewChanged: false, newPresenters: [] };
  const bu = updatesOf(before || {}), au = updatesOf(after);
  const bid = bu.deck && (bu.deck.fileId || bu.deck.url), aid = au.deck && (au.deck.fileId || au.deck.url);
  if (aid && aid !== bid) out.deckPosted = true;
  if ((au.review.status || null) !== (bu.review.status || null) && au.review.status && au.review.status !== 'pending') out.reviewChanged = true;
  const bp = new Set(presenterUids(before || {}));
  out.newPresenters = presenterUids(after).filter((uid) => !bp.has(uid));
  // A brand-new doc (seed / generate) with a presenter months out: don't
  // burst-push the whole semester — the Monday-of reminder covers it. A
  // reassignment on an EXISTING doc always notifies, however far out.
  if (!before && today && after.date && out.newPresenters.length && daysBetween(today, after.date) > NEW_DOC_NOTIFY_DAYS) out.newPresenters = [];
  if (!out.deckPosted && !out.reviewChanged && !out.newPresenters.length) return null;
  return out;
}

/* ═══════════════════════════════════════════════════════════════
   One-on-ones (V3.938)
   oneOnOneSlots/{id}: a recurring time the PI / a mentor offers; one student
   subscribes by writing their own uid. Occurrence math is mirrored in
   rm/js/meetings-one-on-one.js — keep the two in step.
   ═══════════════════════════════════════════════════════════════ */
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SLOT_TIME_KEYS = ['weekday', 'time', 'duration', 'location', 'cadence', 'startDate', 'endDate'];

function weekdayOf(dateStr) {
  const p = String(dateStr).split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();
}
/* the first date on/after dateStr that falls on weekday — the fortnight anchor */
function firstOnOrAfter(dateStr, weekday) { return shiftDateStr(dateStr, (weekday - weekdayOf(dateStr) + 7) % 7); }
function addMinutes(hhmm, mins) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  const t = (((h || 0) * 60 + (m || 0) + (+mins || 0)) % 1440 + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
function cadenceWord(s) { return s && s.cadence === 'biweekly' ? 'Every other week' : 'Every week'; }

/* PURE: null (no meeting that day) · 'on' · 'skipped' */
function slotOccursOn(s, dateStr) {
  if (!s || s.active === false || !s.startDate || s.weekday == null || !dateStr) return null;
  if (dateStr < s.startDate) return null;
  if (s.endDate && dateStr > s.endDate) return null;
  if (weekdayOf(dateStr) !== +s.weekday) return null;
  if (s.cadence === 'biweekly' && (daysBetween(firstOnOrAfter(s.startDate, +s.weekday), dateStr) / 7) % 2) return null;
  return (s.skips && s.skips[dateStr]) ? 'skipped' : 'on';
}

/* V3.940 — who holds a date. Mirrors rm/js/meetings-one-on-one.js holderOn():
 * a one-week booking (bookings.<uid>.<date>, earliest wins) beats the
 * every-week holder (subscriberUid, from subscribedFrom), who may have
 * skipped it; otherwise the date is open. */
function slotBookingOn(s, d) {
  const b = (s && s.bookings) || {};
  let best = null;
  Object.keys(b).forEach((uid) => {
    const e = b[uid] && b[uid][d];
    if (e && (!best || String(e.at || '') < String(best.at || ''))) best = Object.assign({ uid }, e);
  });
  return best;
}
function slotHolderOn(s, d) {
  const o = slotOccursOn(s, d);
  if (!o) return null;
  const b = slotBookingOn(s, d);
  if (b) return { state: 'week', uid: b.uid, name: b.name || '' };
  if (s.subscriberUid && (!s.subscribedFrom || d >= s.subscribedFrom)) return { state: o === 'skipped' ? 'skipped' : 'standing', uid: s.subscriberUid, name: s.subscriberName || '' };
  return { state: 'open' };
}
function futureBookers(s, today) {
  const b = (s && s.bookings) || {};
  return Object.keys(b).filter((uid) => Object.keys(b[uid] || {}).some((d) => !today || d >= today));
}
function lengthWord(start, end) {
  const m = (x) => { const [h, mm] = String(x).split(':').map(Number); return h * 60 + mm; };
  const n = m(end) - m(start);
  return n % 60 === 0 ? `${n / 60} hour${n === 60 ? '' : 's'}` : `${n} min`;
}

/* PURE: what changed on a slot write that someone must hear about.
 * [] for a reminder stamp, a note edit on an open slot, a no-op write.
 * `today` (YYYY-MM-DD) limits "has a booking" to upcoming ones. */
function slotTransition(before, after, today) {
  const out = [];
  if (!before && !after) return out;
  if (!before) {
    if (after.subscriberUid) out.push({ type: 'assigned', uid: after.subscriberUid, from: after.subscribedFrom || null });
    return out;
  }
  if (!after) {
    if (before.active !== false) {
      const who = new Set(futureBookers(before, today));
      if (before.subscriberUid) who.add(before.subscriberUid);
      who.forEach((uid) => out.push({ type: 'deleted', uid }));
    }
    return out;
  }
  const bs = before.subscriberUid || null, as = after.subscriberUid || null;
  const bb = before.bookings || {}, ab = after.bookings || {};
  const br = before.recurRequests || {}, ar = after.recurRequests || {};
  const newDates = (uid) => Object.keys(ab[uid] || {}).filter((d) => !(bb[uid] || {})[d]).sort();
  const oneWeek = !!(bs && !as && newDates(bs).length);              // every week → this week only
  if (bs !== as) {
    if (bs) out.push(oneWeek ? { type: 'madeOneWeek', uid: bs, date: newDates(bs)[0] } : { type: after.updatedBy === bs ? 'left' : 'removed', uid: bs });
    if (as) {
      const approved = !!(br[as] && !ar[as]);
      out.push(approved ? { type: 'recurApproved', uid: as, from: after.subscribedFrom || null }
        : { type: (after.subscribedBy === 'host' || after.subscribedBy === 'approved' || after.updatedBy !== as) ? 'assigned' : 'subscribed', uid: as, from: after.subscribedFrom || null });
    }
  }
  // one-week bookings
  new Set(Object.keys(bb).concat(Object.keys(ab))).forEach((uid) => {
    const b0 = bb[uid] || {}, b1 = ab[uid] || {};
    Object.keys(b1).sort().forEach((d) => {
      if (b0[d] || (oneWeek && uid === bs)) return;                    // madeOneWeek says it
      out.push({ type: 'booked', uid, date: d, by: (b1[d] && b1[d].by) || (after.updatedBy === uid ? 'self' : 'host') });
    });
    Object.keys(b0).sort().forEach((d) => {
      if (b1[d] || (uid === as && bs !== as)) return;                  // folded into every week
      out.push({ type: 'unbooked', uid, date: d, by: after.updatedBy || null });
    });
  });
  // every-week requests
  Object.keys(ar).forEach((uid) => { if (!br[uid]) out.push({ type: 'recurRequested', uid, from: (ar[uid] && ar[uid].from) || null }); });
  Object.keys(br).forEach((uid) => {
    if (ar[uid] || uid === as) return;                                 // still pending, or approved above
    out.push({ type: after.updatedBy === uid ? 'recurWithdrawn' : 'recurDeclined', uid });
  });
  if (before.active !== false && after.active === false) {
    const who = new Set(futureBookers(after, today));
    if (as) who.add(as);
    who.forEach((uid) => out.push({ type: 'ended', uid }));
  }
  const bsk = before.skips || {}, ask = after.skips || {};
  Object.keys(ask).forEach((d) => { if (!bsk[d]) out.push({ type: 'skipped', date: d, by: (ask[d] && ask[d].by) || after.updatedBy || null, reason: (ask[d] && ask[d].reason) || '' }); });
  Object.keys(bsk).forEach((d) => { if (!ask[d]) out.push({ type: 'unskipped', date: d, by: after.updatedBy || null }); });
  if (after.active !== false && SLOT_TIME_KEYS.some((k) => (before[k] == null ? null : before[k]) !== (after[k] == null ? null : after[k]))) {
    const who = new Set(futureBookers(after, today));
    if (as && bs === as) who.add(as);
    who.forEach((uid) => out.push({ type: 'changed', uid }));
  }
  return out;
}

/* PURE: the afternoon-before reminders. Whoever holds tomorrow (every week or
 * this week only) gets one notice, and back-to-back slots they hold with the
 * same host are ONE meeting (2:00–3:00). Each host gets ONE notice listing all
 * of tomorrow's (the PI with six students gets one push, not six).
 * ctx = { today, minutes, names(uid, fallback) }. Each entry carries the
 * slotIds to stamp `lastReminded = date` on. */
function planOneOnOneReminders(slots, ctx) {
  if (!ctx || ctx.minutes < AFTERNOON_MIN) return [];
  const tomorrow = shiftDateStr(ctx.today, 1);
  const items = [];
  (slots || []).forEach((s) => {
    if (s.lastReminded === tomorrow) return;
    const h = slotHolderOn(s, tomorrow);
    if (!h || !h.uid || h.state === 'skipped') return;
    items.push({ s, uid: h.uid, name: h.name, hostUid: s.hostUid, start: s.time, end: addMinutes(s.time, s.duration) });
  });
  items.sort((a, b) => String(a.hostUid).localeCompare(String(b.hostUid)) || String(a.uid).localeCompare(String(b.uid)) || String(a.start).localeCompare(String(b.start)));
  const blocks = [];
  items.forEach((it) => {
    const prev = blocks[blocks.length - 1];
    if (prev && prev.hostUid === it.hostUid && prev.uid === it.uid && prev.end === it.start) { prev.end = it.end; prev.slots.push(it.s); }
    else blocks.push(Object.assign({}, it, { slots: [it.s] }));
  });
  blocks.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const range = (b) => `${fmtTime(b.start)}–${fmtTime(b.end)}${b.slots.length > 1 ? ` (${lengthWord(b.start, b.end)})` : ''}`;
  const out = [];
  const byHost = {};
  blocks.forEach((b) => {
    const s = b.slots[0];
    const host = firstName(ctx.names(b.hostUid, s.hostName));
    out.push({ uids: [b.uid], slotIds: b.slots.map((x) => x.id), date: tomorrow, kind: 'reminder',
      title: `One-on-one with ${host} tomorrow at ${fmtTime(b.start)}`,
      body: `${DOW[+s.weekday]} ${range(b)}${s.location ? ' in ' + s.location : ''}.${s.note ? ' ' + s.note : ''}` });
    (byHost[b.hostUid] = byHost[b.hostUid] || []).push(b);
  });
  Object.keys(byHost).forEach((hostUid) => {
    const list = byHost[hostUid];
    const one = list[0];
    const who = (b) => firstName(ctx.names(b.uid, b.name));
    out.push({ uids: [hostUid], slotIds: [].concat(...list.map((b) => b.slots.map((x) => x.id))), date: tomorrow, kind: 'reminder',
      title: list.length === 1 ? `One-on-one with ${who(one)} tomorrow at ${fmtTime(one.start)}` : `${list.length} one-on-ones tomorrow`,
      body: list.length === 1
        ? `${DOW[+one.slots[0].weekday]} ${range(one)}${one.slots[0].location ? ' in ' + one.slots[0].location : ''}.`
        : list.map((b) => `${who(b)} ${fmtTime(b.start)}${b.slots.length > 1 ? '–' + fmtTime(b.end) : ''}`).join(' · ') });
  });
  return out;
}

/* ─── Firestore plumbing ─────────────────────────────────────── */
async function loadContext(db) {
  const [cfgSnap, usersSnap] = await Promise.all([
    db.collection('meetingConfig').doc('settings').get(),
    db.collection('users').get(),
  ]);
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  const members = [];
  const nameOf = {};
  usersSnap.forEach((d) => {
    const v = d.data() || {};
    nameOf[d.id] = v.name || v.displayName || v.email || '';
    members.push({ uid: d.id, role: v.role, category: v.category, hidden: !!v.hidden });
  });
  let reviewerUids = Array.isArray(cfg.reviewerUids) && cfg.reviewerUids.length ? cfg.reviewerUids : members.filter((u) => u.category === 'pi').map((u) => u.uid);
  if (!reviewerUids.length) reviewerUids = members.filter((u) => u.role === 'admin').map((u) => u.uid);
  return {
    cfg, members: applyRoster(members, cfg), reviewerUids,
    coordinatorUids: Array.isArray(cfg.coordinatorUids) ? cfg.coordinatorUids : [],
    names: (uid, fallback) => nameOf[uid] || fallback || '',
  };
}

/* ================================================================
   1. Reminders — 09:00 and 16:00 Phoenix
   ================================================================ */
const meetingReminders = onSchedule(
  { schedule: '0 9,16 * * *', timeZone: TZ, timeoutSeconds: 300 },
  async () => {
    const db = getFirestore();
    const messaging = getMessaging();
    const now = phoenixNow();
    const ctx = Object.assign(await loadContext(db), { today: now.dateStr, minutes: now.minutes });
    const snap = await db.collection('meetings')
      .where('date', '>=', now.dateStr).where('date', '<=', shiftDateStr(now.dateStr, 7)).get();
    let sent = 0;
    for (const doc of snap.docs) {
      const m = Object.assign({ id: doc.id }, doc.data());
      const plan = planReminders(m, ctx);
      for (const step of plan) {
        const uids = [...new Set(step.uids.filter(Boolean))];
        if (uids.length) {
          await notifyUsers(db, messaging, uids, { title: step.title, body: step.body, url: step.url, tag: `mtg-${step.flag}-${m.id}` }, APP_KEY, step.kind);
          sent += uids.length;
        }
        await doc.ref.update({ [`reminded.${step.flag}`]: true });
      }
    }
    // V3.938 — one-on-ones: the afternoon-before pass, grouped per host
    let ooSent = 0;
    if (now.minutes >= AFTERNOON_MIN) {
      const slotsSnap = await db.collection('oneOnOneSlots').where('active', '==', true).get();
      const slots = slotsSnap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
      const stamped = new Set();
      for (const step of planOneOnOneReminders(slots, ctx)) {
        await notifyUsers(db, messaging, step.uids, { title: step.title, body: step.body, url: PAGE + '#oneonone', tag: `oo-remind-${step.date}-${step.uids[0]}` }, APP_KEY, step.kind);
        ooSent += step.uids.length;
        for (const id of step.slotIds) {
          if (stamped.has(id)) continue;
          stamped.add(id);
          await db.collection('oneOnOneSlots').doc(id).update({ lastReminded: step.date });
        }
      }
    }
    console.log(`[MeetingReminders] ${now.dateStr} ${now.minutes >= AFTERNOON_MIN ? 'pm' : 'am'} — ${snap.size} meeting(s) scanned, ${sent} notice(s); ${ooSent} one-on-one reminder(s).`);
  }
);

/* ================================================================
   2. Swaps — notify + execute
   ================================================================ */
async function executeSwap(db, swapRef, swap) {
  return db.runTransaction(async (tx) => {
    const [sSnap, fromSnap, toSnap] = await Promise.all([
      tx.get(swapRef),
      tx.get(db.collection('meetings').doc(swap.fromMeetingId)),
      tx.get(db.collection('meetings').doc(swap.toMeetingId)),
    ]);
    const s = sSnap.data() || {};
    if (s.executedAt) return { skipped: true };            // client fallback beat us
    if (!fromSnap.exists || !toSnap.exists) throw new Error('One of the meetings no longer exists');
    const from = fromSnap.data(), to = toSnap.data();
    const mover = presentersOf(from).find((p) => p.uid === swap.fromUid);
    const target = presentersOf(to).find((p) => p.uid === swap.toUid);
    if (!mover || !target) throw new Error('One of the slots changed before the swap was applied');
    const moverEntry = Object.assign({}, mover, { slot: target.slot || 0, updatedAt: new Date().toISOString() }); delete moverEntry.uid;
    const targetEntry = Object.assign({}, target, { slot: mover.slot || 0, updatedAt: new Date().toISOString() }); delete targetEntry.uid;
    const ts = FieldValue.serverTimestamp();
    tx.update(fromSnap.ref, { [`presenters.${swap.fromUid}`]: FieldValue.delete(), [`presenters.${swap.toUid}`]: targetEntry, updatedAt: ts });
    tx.update(toSnap.ref, { [`presenters.${swap.toUid}`]: FieldValue.delete(), [`presenters.${swap.fromUid}`]: moverEntry, updatedAt: ts });
    tx.update(swapRef, { executedAt: ts, executedBy: 'function', error: null, updatedAt: ts });
    return { skipped: false };
  });
}

const onMeetingSwapWritten = onDocumentWritten('meetingSwaps/{swapId}', async (event) => {
  const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
  const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
  const kind = swapTransition(before, after);
  if (!kind) return;
  const db = getFirestore();
  const messaging = getMessaging();
  const ctx = await loadContext(db);
  const s = after;
  const fromName = firstName(ctx.names(s.fromUid, s.fromName));
  const toName = firstName(ctx.names(s.toUid, s.toName));
  const url = PAGE + '#schedule';

  if (kind === 'created') {
    await notifyUsers(db, messaging, [s.toUid], {
      title: `🔁 ${fromName} wants to swap presentation slots`,
      body: `You’d present ${fmtShort(s.fromDate)} instead of ${fmtShort(s.toDate)}.${s.message ? ' “' + s.message + '”' : ''} Accept or decline on the meetings page.`,
      url, tag: `mtg-swap-${event.params.swapId}`,
    }, APP_KEY, 'approval');
    return;
  }
  if (kind === 'accepted') {
    try {
      const r = await executeSwap(db, event.data.after.ref, s);
      if (!r.skipped) console.log(`[MeetingSwap] ${event.params.swapId} executed`);
      await notifyUsers(db, messaging, [...new Set([s.fromUid].concat(ctx.coordinatorUids))], {
        title: `✅ Swap done — ${fromName} now presents ${fmtShort(s.toDate)}`,
        body: `${toName} accepted. ${toName} presents ${fmtShort(s.fromDate)}.`,
        url, tag: `mtg-swap-${event.params.swapId}`,
      }, APP_KEY, 'confirmed');
    } catch (e) {
      console.warn(`[MeetingSwap] ${event.params.swapId} failed: ${e.message}`);
      await event.data.after.ref.update({ error: e.message, updatedAt: FieldValue.serverTimestamp() });
      await notifyUsers(db, messaging, [s.fromUid, s.toUid].concat(ctx.coordinatorUids), {
        title: '⚠️ Swap could not be applied', body: `${e.message}. Ask the coordinator to move you by hand.`, url, tag: `mtg-swap-${event.params.swapId}`,
      }, APP_KEY, 'displaced');
    }
    return;
  }
  if (kind === 'declined') {
    await notifyUsers(db, messaging, [s.fromUid], { title: `${toName} declined the swap`, body: `You still present ${fmtShort(s.fromDate)}.`, url, tag: `mtg-swap-${event.params.swapId}` }, APP_KEY, 'confirmed');
  } else if (kind === 'cancelled') {
    await notifyUsers(db, messaging, [s.toUid], { title: `${fromName} withdrew the swap request`, body: `Nothing changes — you present ${fmtShort(s.toDate)}.`, url, tag: `mtg-swap-${event.params.swapId}` }, APP_KEY, 'confirmed');
  }
});

/* ================================================================
   3. Meeting doc — deck posted / review decided / presenter added
   ================================================================ */
const onMeetingWritten = onDocumentWritten('meetings/{meetingId}', async (event) => {
  const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
  const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
  const t = meetingTransition(before, after, phoenixNow().dateStr);
  if (!t) return;                                    // ← the guard: minutes typing exits here
  if (after.status === 'cancelled' || after.kind === 'break') return;
  const db = getFirestore();
  const messaging = getMessaging();
  const ctx = await loadContext(db);
  const m = after;
  const pres = presentersOf(m);
  const presUids = pres.map((p) => p.uid);
  const u = updatesOf(m);
  const id = event.params.meetingId;

  if (t.deckPosted && ctx.reviewerUids.length) {
    const by = firstName(ctx.names(u.deckBy || (pres[0] && pres[0].uid), m.updates && m.updates.deckByName));
    await notifyUsers(db, messaging, ctx.reviewerUids, {
      title: `👀 Deck ready for review — ${fmtShort(m.date)}`,
      body: `${by} posted the combined round-robin deck. Approve or request changes before the meeting.`,
      url: PAGE, tag: `mtg-review-${id}`,
    }, APP_KEY, 'approval');
    await event.data.after.ref.update({ 'reminded.reviewCall': true });
  }
  if (t.reviewChanged) {
    const approved = u.review.status === 'approved';
    const to = [...new Set(presUids.concat(ctx.coordinatorUids))];
    if (to.length) {
      await notifyUsers(db, messaging, to, {
        title: approved ? `✅ Deck approved — ${fmtShort(m.date)}` : `✏️ Changes requested on the deck — ${fmtShort(m.date)}`,
        body: approved ? `${firstName(ctx.names(u.review.by, u.review.byName))} approved the combined deck.` : (u.review.comment || 'See the meetings page for what to change.'),
        url: PAGE, tag: `mtg-reviewed-${id}`,
      }, APP_KEY, approved ? 'confirmed' : 'reminder');
    }
  }
  if (t.newPresenters.length && m.date) {
    await notifyUsers(db, messaging, t.newPresenters, {
      title: `🗣 You’re presenting ${fmtShort(m.date)}`,
      body: `Lab meeting${m.time ? ' at ' + fmtTime(m.time) : ''}${m.location ? ' in ' + m.location : ''}. Add a title and your slides link when you’re ready.`,
      url: PAGE, tag: `mtg-assigned-${id}`,
    }, APP_KEY, 'confirmed');
  }
});

/* ================================================================
   4. One-on-one slot — subscribed / left / reserved / moved / skipped (V3.938)
   ================================================================ */
const onOneOnOneSlotWritten = onDocumentWritten('oneOnOneSlots/{slotId}', async (event) => {
  const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
  const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
  const events = slotTransition(before, after, phoenixNow().dateStr);
  if (!events.length) return;                        // reminder stamps, note edits on an open slot
  const db = getFirestore();
  const messaging = getMessaging();
  const ctx = await loadContext(db);
  const s = after || before;
  const host = s.hostUid;
  const hostName = firstName(ctx.names(host, s.hostName));
  const url = PAGE + '#oneonone';
  const tag = `oo-${event.params.slotId}`;
  const when = `${DOW[+s.weekday] || 'the'}s at ${fmtTime(s.time)}`;
  const where = s.location ? ` in ${s.location}` : '';
  const nameOf = (uid) => firstName(ctx.names(uid, (after && after.subscriberUid === uid && after.subscriberName) || (before && before.subscriberUid === uid && before.subscriberName)
    || (((after || before).recurRequests || {})[uid] || {}).name || ''));
  const onDate = (d) => `${DOW[+s.weekday]} ${fmtShort(d)} at ${fmtTime(s.time)}`;
  const send = (uids, title, body, kind) => notifyUsers(db, messaging, uids.filter(Boolean), { title, body, url, tag }, APP_KEY, kind || 'confirmed');

  for (const e of events) {
    switch (e.type) {
      case 'assigned':
        await send([e.uid], `${hostName} set up a one-on-one with you`,
          `${cadenceWord(s)} on ${when}${where}, from ${fmtShort(s.startDate)}.${s.note ? ' ' + s.note : ''} Details on the meetings page.`);
        break;
      case 'subscribed':
        await send([host], `${nameOf(e.uid)} subscribed to your ${when} one-on-one`, `${cadenceWord(s)}${where}, from ${fmtShort(s.startDate)}.`);
        break;
      case 'left':
        await send([host], `${nameOf(e.uid)} left your ${when} one-on-one`, 'The time is open again for someone else.');
        break;
      case 'removed':
        await send([e.uid], `${hostName} took you off the ${when} one-on-one`, 'Pick another open time on the meetings page if you still need one.', 'displaced');
        break;
      case 'ended':
        await send([e.uid], `${hostName} ended the ${when} one-on-one`, 'No more meetings at that time from today.', 'displaced');
        break;
      case 'deleted':
        await send([e.uid], `${hostName} cancelled the ${when} one-on-one`, 'It is off the calendar. Pick another open time if you still need one.', 'displaced');
        break;
      case 'changed':
        await send([e.uid], `Your one-on-one with ${hostName} moved`, s.subscriberUid === e.uid
          ? `Now ${cadenceWord(s).toLowerCase()} on ${when}${where}. Re-add it to your calendar from the meetings page.`
          : `The week you booked is now on ${when}${where}. Check the date on the meetings page.`, 'reminder');
        break;
      case 'skipped': {
        const other = e.by === host ? s.subscriberUid : host;
        if (!other || !s.subscriberUid) break;
        await send([other], `No one-on-one on ${fmtShort(e.date)}`, `${firstName(ctx.names(e.by))} skipped that week${e.reason ? ': ' + e.reason : ''}.`, 'reminder');
        break;
      }
      case 'unskipped': {
        const other = e.by === host ? s.subscriberUid : host;
        if (!other || !s.subscriberUid) break;
        await send([other], `One-on-one on ${fmtShort(e.date)} is back on`, `${firstName(ctx.names(e.by))} un-skipped it — ${fmtTime(s.time)}${where}.`, 'reminder');
        break;
      }
      /* V3.940 — one week at a time, every-week requests */
      case 'booked':
        if (e.by === 'host') await send([e.uid], `${hostName} booked you for ${onDate(e.date)}`, `One-on-one, this week only${where}.`, 'confirmed');
        else await send([host], `${nameOf(e.uid)} booked ${onDate(e.date)}`, `One-on-one, this week only${where}.`, 'confirmed');
        break;
      case 'unbooked':
        if (e.by === e.uid) await send([host], `${nameOf(e.uid)} cancelled ${onDate(e.date)}`, 'That week is open again.', 'confirmed');
        else await send([e.uid], `${hostName} cancelled your one-on-one on ${onDate(e.date)}`, 'Pick another week on the meetings page if you still need one.', 'displaced');
        break;
      case 'recurRequested':
        await send([host], `${nameOf(e.uid)} asks to make ${when} every week`, `${e.from ? 'From ' + fmtShort(e.from) + '. ' : ''}Approve or decline on the meetings page.`, 'approval');
        break;
      case 'recurApproved':
        await send([e.uid], `${hostName} approved: ${when} every week`, `${cadenceWord(s)}${e.from ? ' from ' + fmtShort(e.from) : ''}${where}. Add it to your calendar from the meetings page.`, 'confirmed');
        break;
      case 'recurDeclined':
        await send([e.uid], `${hostName} kept ${when} one week at a time`, 'You keep the weeks you booked; book other weeks as you need them.', 'confirmed');
        break;
      case 'madeOneWeek':
        await send([e.uid], `Your ${when} one-on-one is one week at a time now`, `${hostName} changed it. You keep ${fmtShort(e.date)}; book other weeks as you need them.`, 'reminder');
        break;
      default: break;
    }
  }
});

module.exports = {
  meetingReminders,
  onMeetingSwapWritten,
  onMeetingWritten,
  onOneOnOneSlotWritten,
  _internal: { phoenixNow, shiftDateStr, daysBetween, presentersOf, submittersFor, applyRoster, attendees, planReminders, swapTransition, meetingTransition,
               weekdayOf, firstOnOrAfter, slotOccursOn, slotBookingOn, slotHolderOn, slotTransition, planOneOnOneReminders,
               PRESENTER_DAYS, SUBMIT_DAYS, DECK_DAYS, AFTERNOON_MIN, NEW_DOC_NOTIFY_DAYS },
};
