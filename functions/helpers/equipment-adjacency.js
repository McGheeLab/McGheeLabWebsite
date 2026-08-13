/* ================================================================
   equipment-adjacency.js — "shift change" notification engine
   ================================================================
   PURE module: no Firestore, no FCM, no side effects. Everything here
   is a function of (before, after, the day's other bookings, config),
   so the whole decision matrix is testable with plain node.

   THE PROBLEM IT SOLVES
   Two students sharing a microscope back-to-back create friction: the
   one finishing doesn't know somebody is waiting, and the one waiting
   doesn't know when the slot before them shifts or frees up. So the
   outgoing student runs over, or the incoming student sits idle.

   THE DESIGN CONSTRAINT
   Over-notify and students disable notifications, which is strictly
   worse than never having built this. So the engine is deliberately
   QUIET, weighted on booking criticality (the `priority` enum, see
   V3.588):

     Soft (normal)  — exerts no pressure, receives no nudges
     Firm (high)    — must start on time; both sides get told
     Hard (urgent)  — mission critical; radiates the most signal

   A day of Soft bookings produces ZERO pushes. That is the point.

   Keep PRIORITY_LABELS in sync with rm/js/equipment.js and
   rm/js/equipment-availability.js.

   KNOWN LIMITATION: same-date only. Multi-day bookings
   (endDate > date) are excluded from adjacency math entirely, so
   cross-midnight handoffs are never detected. Flagged, not solved —
   overnight runs are rare in this lab today.
   ================================================================ */

'use strict';

const PRIORITY_LABELS = {
  normal: 'Soft', high: 'Firm', urgent: 'Hard', maintenance: 'Maintenance',
};

/* Criticality weight. 'maintenance' counts as Hard: a device blocked
   for service is the least movable thing on the calendar. */
const WEIGHTS = { normal: 0, high: 1, urgent: 2, maintenance: 2 };

const DEFAULT_GAP_MIN = 30;
const DEFAULT_SUPPRESS_MIN = 3;

/* Statuses that occupy the calendar. A cancelled or displaced booking
   holds no time and has no neighbors. */
const ACTIVE_STATUSES = ['confirmed', 'pending-approval'];

function weight(priority) {
  return WEIGHTS[priority] === undefined ? 0 : WEIGHTS[priority];
}
function label(priority) {
  return PRIORITY_LABELS[priority] || PRIORITY_LABELS.normal;
}
function isSoft(priority) { return weight(priority) === 0; }

function timeToMin(t) {
  if (!t || typeof t !== 'string' || t.indexOf(':') < 0) return null;
  const p = t.split(':');
  const h = Number(p[0]), m = Number(p[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/* 24h "HH:MM" → "2:30 PM". Students read clock time, not minutes. */
function fmt12h(t) {
  const min = timeToMin(t);
  if (min === null) return String(t || '');
  const h = Math.floor(min / 60) % 24, m = min % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return h12 + (m ? ':' + String(m).padStart(2, '0') : '') + ' ' + ampm;
}

function isActive(b) {
  return !!b && ACTIVE_STATUSES.indexOf(b.status) >= 0;
}

/* Single-day bookings only — see KNOWN LIMITATION above. */
function isSingleDay(b) {
  return !!b && (!b.endDate || b.endDate === b.date);
}

/* An interval is comparable only if we can place it on a clock. */
function intervalOf(b) {
  if (!b) return null;
  const s = timeToMin(b.startTime), e = timeToMin(b.endTime);
  if (s === null || e === null || e <= s) return null;
  return { start: s, end: e };
}

/**
 * Did this change move the booking in time, take it off the calendar,
 * or neither?
 *
 * 'cancelled' covers both real cancellation and displacement
 * ('needs-rebooking'): from a neighbor's point of view the time is
 * released either way.
 *
 * @returns {'created'|'cancelled'|'restored'|'moved'|'none'}
 */
function classifyChange(before, after) {
  if (!before && after) return 'created';
  if (!before || !after) return 'none';

  const wasActive = isActive(before), nowActive = isActive(after);
  if (wasActive && !nowActive) return 'cancelled';
  if (!wasActive && nowActive) return 'restored';
  if (!wasActive && !nowActive) return 'none';

  if (before.date !== after.date
      || before.startTime !== after.startTime
      || before.endTime !== after.endTime) return 'moved';

  return 'none';
}

/**
 * Find the bookings immediately before and after `subject` on the same
 * device and date, when the gap is small enough to be a real handoff.
 *
 * @param {Array}  dayBookings - all bookings for that equipment+date
 * @param {Object} subject     - the booking to find neighbors of
 * @param {Object} iv          - subject's interval {start,end} in minutes
 * @param {number} gapMin      - handoff threshold
 * @param {string} [skipId]    - subject's own doc id
 * @returns {{upstream: Object|null, downstream: Object|null}}
 */
function findNeighbors(dayBookings, subject, iv, gapMin, skipId) {
  const out = { upstream: null, downstream: null };
  if (!iv || !subject) return out;
  const limit = Number.isFinite(gapMin) ? gapMin : DEFAULT_GAP_MIN;

  (dayBookings || []).forEach((b) => {
    if (!b || b.id === skipId) return;
    if (!isActive(b) || !isSingleDay(b)) return;
    // Callers may hand us more than one date (a booking that moved
    // across midnight needs both), so times alone are not enough to
    // establish adjacency — the dates must match too.
    if (b.date !== subject.date) return;
    if (b.equipmentId && subject.equipmentId && b.equipmentId !== subject.equipmentId) return;
    const other = intervalOf(b);
    if (!other) return;

    // b ends just before subject starts → b is upstream of subject
    const gapBefore = iv.start - other.end;
    if (gapBefore >= 0 && gapBefore <= limit) {
      if (!out.upstream || other.end > intervalOf(out.upstream).end) out.upstream = b;
    }

    // b starts just after subject ends → b is downstream of subject
    const gapAfter = other.start - iv.end;
    if (gapAfter >= 0 && gapAfter <= limit) {
      if (!out.downstream || other.start < intervalOf(out.downstream).start) out.downstream = b;
    }
  });

  return out;
}

function nameOf(b) {
  return (b && b.userName) || 'Someone';
}
function deviceOf(b) {
  return (b && b.equipmentName) || 'the instrument';
}

/**
 * Should these two people hear about each other at all?
 *
 * Silent when: same person on both sides (you already know your own
 * schedule), either side is missing a uid, or the recipient is a
 * maintenance block (don't tell the admin calendar about slack).
 */
function pairIsNotifiable(recipientBooking, otherBooking) {
  if (!recipientBooking || !otherBooking) return false;
  if (!recipientBooking.uid || !otherBooking.uid) return false;
  if (recipientBooking.uid === otherBooking.uid) return false;
  if (recipientBooking.priority === 'maintenance') return false;
  return true;
}

/**
 * The decision matrix. Returns the notifications to send — often none.
 *
 * Direction encodes who the recipient is relative to the changed
 * booking, and becomes part of the FCM tag so an "upstream" and a
 * "downstream" notice about the same booking don't collapse into each
 * other:
 *   'down' → recipient is UPSTREAM of the change (they hand off)
 *   'up'   → recipient is DOWNSTREAM of the change (they receive)
 *
 * @param {Object} args
 * @param {string} args.event        - classifyChange() result
 * @param {Object} args.before       - booking before the change (null on create)
 * @param {Object} args.after        - booking after the change (null on delete)
 * @param {Array}  args.dayBookings  - same equipment+date, AFTER state
 * @param {string} args.bookingId
 * @param {number} args.gapMin
 * @returns {Array<{recipientUid,title,body,tag,url,targetBookingId,direction,kind}>}
 */
function decide(args) {
  const event = args.event;
  const before = args.before, after = args.after;
  const bookingId = args.bookingId;
  const gapMin = Number.isFinite(args.gapMin) ? args.gapMin : DEFAULT_GAP_MIN;
  const day = args.dayBookings || [];
  const out = [];

  const push = (target, changed, direction, title, body) => {
    if (!pairIsNotifiable(target, changed)) return;
    out.push({
      recipientUid: target.uid,
      title,
      body,
      url: '/rm/pages/equipment.html',
      // Tag keys the RECIPIENT's booking + direction, so repeated churn
      // on the other side replaces one notice instead of stacking.
      tag: `equip-adj-${target.id || bookingId}-${direction}`,
      targetBookingId: target.id || null,
      direction,
      kind: 'adjacency',
    });
  };

  /* ---- A booking appeared on the calendar ---- */
  if (event === 'created' || event === 'restored') {
    const subject = after;
    if (!isActive(subject) || !isSingleDay(subject)) return out;
    const iv = intervalOf(subject);
    const nb = findNeighbors(day, subject, iv, gapMin, bookingId);

    // Someone booked right AFTER an existing booking → tell the person
    // finishing that a handoff now exists. This is the core case: it is
    // exactly the friction the user described.
    if (nb.upstream && !isSoft(subject.priority)) {
      push(nb.upstream, subject, 'down',
        `${nameOf(subject)} booked ${deviceOf(subject)} right after you`,
        `${label(subject.priority)} booking at ${fmt12h(subject.startTime)} — `
        + `please wrap up and be off by ${fmt12h(nb.upstream.endTime)}.`);
    }

    // Someone booked right BEFORE an existing booking. Only a Hard
    // booking earns this — otherwise it's noise about a slot the
    // recipient never had.
    if (nb.downstream && weight(subject.priority) >= 2) {
      push(nb.downstream, subject, 'up',
        `Tight handoff before your ${deviceOf(subject)} slot`,
        `A ${label(subject.priority)} booking now runs until `
        + `${fmt12h(subject.endTime)}, right up against your `
        + `${fmt12h(nb.downstream.startTime)} start.`);
    }
    return out;
  }

  /* ---- A booking left the calendar ---- */
  if (event === 'cancelled') {
    const subject = before;
    if (!isSingleDay(subject)) return out;
    const iv = intervalOf(subject);
    // Neighbors are whoever was adjacent to the slot that just opened.
    const nb = findNeighbors(day, subject, iv, gapMin, bookingId);
    const wasDisplaced = after && after.status === 'needs-rebooking';

    // Relieve the pressure we previously applied: only the people we
    // would have nudged get the all-clear.
    if (nb.upstream && !isSoft(subject.priority)) {
      push(nb.upstream, subject, 'down',
        `Time opened up after your ${deviceOf(subject)} booking`,
        `The ${label(subject.priority)} booking that followed yours was `
        + `${wasDisplaced ? 'displaced' : 'cancelled'} — no handoff pressure at `
        + `${fmt12h(nb.upstream.endTime)} anymore.`);
    }

    // The slot before you vanished — you can set up early.
    if (nb.downstream && !isSoft(nb.downstream.priority)) {
      push(nb.downstream, subject, 'up',
        `The slot before your ${deviceOf(subject)} booking freed up`,
        `${nameOf(subject)}'s booking ending ${fmt12h(subject.endTime)} was `
        + `${wasDisplaced ? 'displaced' : 'cancelled'} — you can start setting up early.`);
    }
    return out;
  }

  /* ---- A booking moved in time ---- */
  if (event === 'moved') {
    if (!isSingleDay(after) || !isSingleDay(before)) return out;
    const ivBefore = intervalOf(before), ivAfter = intervalOf(after);

    // Who WAS adjacent (they need to know the situation changed) and
    // who IS adjacent now (they need to know it exists). findNeighbors
    // filters on the subject's own date, so a cross-date move resolves
    // both sets correctly as long as the caller supplied both days.
    const wasNb = findNeighbors(day, before, ivBefore, gapMin, bookingId);
    const nowNb = findNeighbors(day, after, ivAfter, gapMin, bookingId);

    /* A move asks two INDEPENDENT questions per side: does someone new
       now need to be on time, and did someone old stop needing to be?
       When a booking slides from between one pair to between another,
       both answers are yes — so these are separate ifs, not if/else. */

    /* -- People who hand off TO the moved booking (recipient upstream) -- */
    const upBefore = wasNb.upstream, upNow = nowNb.upstream;
    const upSame = upBefore && upNow && upBefore.id === upNow.id;

    if (upNow && !isSoft(after.priority)) {
      const movedEarlier = upSame && ivAfter.start < ivBefore.start;
      if (!upSame || movedEarlier) {
        // Newly adjacent, or the handoff got tighter — this is the
        // "your end time just became a real deadline" case.
        push(upNow, after, 'down',
          movedEarlier
            ? `Handoff moved earlier on ${deviceOf(after)}`
            : `${nameOf(after)} now books ${deviceOf(after)} right after you`,
          `${label(after.priority)} booking now starts `
          + `${fmt12h(after.startTime)} — please be off by `
          + `${fmt12h(upNow.endTime)}.`);
      }
    }
    if (upBefore && !upSame && !isSoft(before.priority)) {
      // The booking that was pressing them moved away → gained slack.
      push(upBefore, before, 'down',
        `You gained slack after your ${deviceOf(before)} booking`,
        `The ${label(before.priority)} booking that followed yours moved to `
        + `${after.date === before.date ? fmt12h(after.startTime) : after.date}`
        + ` — the tight handoff at ${fmt12h(upBefore.endTime)} is gone.`);
    }

    /* -- People who receive FROM the moved booking (recipient downstream) -- */
    const downBefore = wasNb.downstream, downNow = nowNb.downstream;
    const downSame = downBefore && downNow && downBefore.id === downNow.id;

    if (downNow && !isSoft(downNow.priority)) {
      const endsLater = downSame && ivAfter.end > ivBefore.end;
      if (!downSame || endsLater) {
        push(downNow, after, 'up',
          `Tight handoff before your ${deviceOf(downNow)} slot`,
          `${nameOf(after)}'s booking now runs until ${fmt12h(after.endTime)}, `
          + `right up against your ${fmt12h(downNow.startTime)} start.`);
      }
    }
    if (downBefore && !downSame && !isSoft(downBefore.priority)) {
      push(downBefore, before, 'up',
        `Setup room before your ${deviceOf(downBefore)} booking`,
        `${nameOf(before)}'s booking that ended ${fmt12h(before.endTime)} moved `
        + `— you have room to set up before ${fmt12h(downBefore.startTime)}.`);
    }
    return out;
  }

  return out;
}

module.exports = {
  PRIORITY_LABELS,
  DEFAULT_GAP_MIN,
  DEFAULT_SUPPRESS_MIN,
  ACTIVE_STATUSES,
  weight, label, isSoft, timeToMin, fmt12h,
  isActive, isSingleDay, intervalOf,
  classifyChange, findNeighbors, decide,
};
