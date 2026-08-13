/* ================================================================
   equipment-watches.js — "notify me if it frees up" matcher
   ================================================================
   PURE module (no Firestore, no FCM) so the interval math is testable
   with plain node.

   THE PROBLEM
   A student needs the confocal Thursday afternoon, but it's booked. Today
   they have to keep reopening the calendar to check. A watch lets them
   drag a window across the grid once and be told if it opens.

   THE MATCHING RULE
   A booking change frees time. A watch fires only when the freed time
   overlaps the watch window AND that overlap is genuinely bookable now —
   i.e. there is a contiguous gap of at least MIN_USEFUL_MIN inside it
   after accounting for every other booking still on the calendar. Two
   students each cancelling half of a blocked afternoon should produce one
   useful notification on the second cancel, not two useless ones.

   This is the ONE sanctioned server-side copy of overlap math (the
   client has three: equipment.js checkAvailability + checkConflicts, and
   equipment-availability.js checkSlot). Don't add a fourth.
   ================================================================ */

'use strict';

const ADJ = require('./equipment-adjacency');

/* A gap shorter than this isn't worth telling anyone about — you can't
   run an experiment in 20 minutes of scope time. */
const MIN_USEFUL_MIN = 30;

/* Don't re-buzz a watcher more often than this, however much churn there
   is on the device. */
const RENOTIFY_THROTTLE_MIN = 15;

/**
 * Subtract busy intervals from a window and return what's left.
 *
 * @param {{start:number,end:number}} window
 * @param {Array<{start:number,end:number}>} busy
 * @returns {Array<{start:number,end:number}>} free sub-intervals, ordered
 */
function freeGaps(window, busy) {
  if (!window || window.end <= window.start) return [];
  let gaps = [{ start: window.start, end: window.end }];

  (busy || []).forEach((b) => {
    if (!b) return;
    const next = [];
    gaps.forEach((g) => {
      // No overlap → gap survives whole.
      if (b.end <= g.start || b.start >= g.end) { next.push(g); return; }
      // Overlap → keep whatever sticks out either side.
      if (b.start > g.start) next.push({ start: g.start, end: b.start });
      if (b.end < g.end) next.push({ start: b.end, end: g.end });
    });
    gaps = next;
  });

  return gaps.filter((g) => g.end > g.start);
}

/**
 * The bookable gaps inside a watch window, given the day's bookings.
 *
 * @param {Object} watch        - { date, startTime, endTime, equipmentId }
 * @param {Array}  dayBookings  - AFTER-state bookings for that device+date
 * @param {number} [minMin]     - smallest gap worth reporting
 * @returns {Array<{start:number,end:number}>}
 */
function openGapsForWatch(watch, dayBookings, minMin) {
  const min = Number.isFinite(minMin) ? minMin : MIN_USEFUL_MIN;
  const wStart = ADJ.timeToMin(watch.startTime);
  const wEnd = ADJ.timeToMin(watch.endTime);
  if (wStart === null || wEnd === null || wEnd <= wStart) return [];

  const busy = (dayBookings || [])
    .filter((b) => b
      && ADJ.isActive(b)
      && b.date === watch.date
      && (!b.equipmentId || !watch.equipmentId || b.equipmentId === watch.equipmentId))
    .map((b) => ADJ.intervalOf(b))
    .filter(Boolean);

  return freeGaps({ start: wStart, end: wEnd }, busy)
    .filter((g) => (g.end - g.start) >= min);
}

/**
 * Did this change actually release time inside this watch's window?
 *
 * A cancel/displacement releases the booking's whole interval. A move
 * releases only the part of the OLD interval the new one no longer
 * covers (a booking shifted by 15 minutes barely frees anything).
 *
 * @returns {{start:number,end:number}|null} the released span, clipped
 *   to the watch window
 */
function releasedSpan(event, before, after, watch) {
  if (!before) return null;
  if (before.date !== watch.date) return null;
  if (before.equipmentId && watch.equipmentId
      && before.equipmentId !== watch.equipmentId) return null;

  const old = ADJ.intervalOf(before);
  if (!old) return null;

  let released = [old];
  if (event === 'moved' && after && ADJ.isActive(after) && after.date === watch.date) {
    const now = ADJ.intervalOf(after);
    if (now) released = freeGaps(old, [now]);
  }

  const wStart = ADJ.timeToMin(watch.startTime);
  const wEnd = ADJ.timeToMin(watch.endTime);
  if (wStart === null || wEnd === null) return null;

  // Clip to the watch window and take the largest surviving piece.
  let best = null;
  released.forEach((r) => {
    const s = Math.max(r.start, wStart);
    const e = Math.min(r.end, wEnd);
    if (e > s && (!best || (e - s) > (best.end - best.start))) best = { start: s, end: e };
  });
  return best;
}

function fmtSpan(gap) {
  return `${ADJ.fmt12h(minToTime(gap.start))}–${ADJ.fmt12h(minToTime(gap.end))}`;
}

function minToTime(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/**
 * Decide which watches to notify for one booking change.
 *
 * @param {Object} args
 * @param {string} args.event        - ADJ.classifyChange() result
 * @param {Object} args.before
 * @param {Object} args.after
 * @param {Array}  args.watches      - active watches for the device+date
 * @param {Array}  args.dayBookings  - AFTER-state bookings, device+date
 * @param {string} [args.actorUid]   - whoever's booking changed
 * @param {number} [args.nowMs]      - injectable clock for tests
 * @returns {Array<{watch,gap,title,body,tag,url,kind}>}
 */
function matchWatches(args) {
  const { event, before, after, watches, dayBookings } = args;
  const nowMs = Number.isFinite(args.nowMs) ? args.nowMs : Date.now();
  const out = [];

  // Only changes that RELEASE time can open a slot.
  if (event !== 'cancelled' && event !== 'moved') return out;
  // Multi-day bookings are outside the model (same limitation as
  // adjacency) — their release spans midnight and the watch is one day.
  if (before && !ADJ.isSingleDay(before)) return out;

  (watches || []).forEach((watch) => {
    if (!watch || watch.status !== 'active') return;
    // Your own booking moving never notifies you about your own watch.
    if (before && watch.uid && before.uid === watch.uid) return;

    // Throttle: however much churn there is, one buzz per window.
    const last = watch.lastNotifiedAt;
    if (last) {
      const lastMs = typeof last.toMillis === 'function' ? last.toMillis() : Number(last);
      if (Number.isFinite(lastMs) && (nowMs - lastMs) < RENOTIFY_THROTTLE_MIN * 60 * 1000) return;
    }

    // Did this change release anything inside the window?
    const released = releasedSpan(event, before, after, watch);
    if (!released) return;

    // And is the window ACTUALLY bookable now? Re-deriving from the
    // after-state is what stops "it opened!" pings for time that is
    // still blocked by somebody else.
    const gaps = openGapsForWatch(watch, dayBookings);
    if (!gaps.length) return;

    // Report the gap that overlaps what was just released — that's the
    // change the student is being told about.
    let gap = gaps.find((g) => g.start < released.end && g.end > released.start);
    if (!gap) return;

    const device = (before && before.equipmentName) || watch.equipmentName || 'Equipment';
    out.push({
      watch,
      gap,
      title: `${device} opened up`,
      body: `${watch.date} ${fmtSpan(gap)} is free — inside the window you asked to watch.`,
      url: '/rm/pages/equipment.html',
      tag: `equip-watch-${watch.id}`,
      kind: 'watch',
    });
  });

  return out;
}

/**
 * Watches this booking fulfills — the owner booked inside their own
 * watch window, so the watch has done its job and should stop.
 */
function fulfilledWatches(booking, watches) {
  if (!booking || !ADJ.isActive(booking)) return [];
  const iv = ADJ.intervalOf(booking);
  if (!iv) return [];
  return (watches || []).filter((w) => {
    if (!w || w.status !== 'active') return false;
    if (w.uid !== booking.uid) return false;
    if (w.date !== booking.date) return false;
    if (w.equipmentId !== booking.equipmentId) return false;
    const ws = ADJ.timeToMin(w.startTime), we = ADJ.timeToMin(w.endTime);
    if (ws === null || we === null) return false;
    return iv.start < we && iv.end > ws;   // any overlap counts
  });
}

module.exports = {
  MIN_USEFUL_MIN,
  RENOTIFY_THROTTLE_MIN,
  freeGaps,
  openGapsForWatch,
  releasedSpan,
  matchWatches,
  fulfilledWatches,
  minToTime,
  fmtSpan,
};
