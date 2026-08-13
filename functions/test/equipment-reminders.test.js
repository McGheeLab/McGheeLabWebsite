/* ================================================================
   equipment-reminders.test.js — time math for the scheduled jobs
   ================================================================
       node functions/test/equipment-reminders.test.js

   Booking times are LOCAL WALL-CLOCK STRINGS, so every reminder
   decision is string/integer arithmetic against "now in Phoenix". That
   arithmetic — date rollover, the T-30 window vs the 15-min cadence,
   the morning threshold — is what this file pins down. The Firestore
   plumbing around it needs an emulator and is verified by hand.
   ================================================================ */

'use strict';

// The module registers onSchedule handlers at require time, which needs
// firebase-admin initialized. Stub just enough for that to be inert.
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'test-project';

let R;
try {
  R = require('../equipment-reminders')._internal;
} catch (e) {
  console.error('Could not load equipment-reminders.js:', e.message);
  process.exit(1);
}
const ADJ = require('../helpers/equipment-adjacency');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + detail : ''));
}

/* ── phoenixNow shape ───────────────────────────────────────── */
{
  const now = R.phoenixNow();
  check('phoenixNow returns YYYY-MM-DD',
    /^\d{4}-\d{2}-\d{2}$/.test(now.dateStr), now.dateStr);
  check('phoenixNow minutes in range',
    now.minutes >= 0 && now.minutes < 1440, String(now.minutes));

  // Arizona is UTC-7 year round (no DST). Verify the offset really is
  // that — if this ever fails, the whole no-DST assumption is wrong.
  const utcH = new Date().getUTCHours();
  const expected = ((utcH - 7) + 24) % 24;
  check('Phoenix is UTC-7 (no DST)',
    Math.floor(now.minutes / 60) === expected,
    `phoenix hour ${Math.floor(now.minutes / 60)} vs expected ${expected}`);
}

/* ── shiftDateStr: rollovers are where date math breaks ─────── */
{
  check('same month', R.shiftDateStr('2026-08-03', 6) === '2026-08-09');
  check('month boundary', R.shiftDateStr('2026-08-28', 6) === '2026-09-03',
    R.shiftDateStr('2026-08-28', 6));
  check('year boundary', R.shiftDateStr('2026-12-29', 6) === '2027-01-04',
    R.shiftDateStr('2026-12-29', 6));
  check('leap day forward', R.shiftDateStr('2028-02-28', 1) === '2028-02-29',
    R.shiftDateStr('2028-02-28', 1));
  check('non-leap February', R.shiftDateStr('2026-02-28', 1) === '2026-03-01',
    R.shiftDateStr('2026-02-28', 1));
  check('negative shift', R.shiftDateStr('2026-01-02', -3) === '2025-12-30',
    R.shiftDateStr('2026-01-02', -3));
  check('zero shift is identity', R.shiftDateStr('2026-08-03', 0) === '2026-08-03');
}

/* ── T-30 window vs the 15-minute cadence ───────────────────── */
{
  // Every booking must be SEEN by the T-minus test at least once. With a
  // 15-min cadence and a 30-min window, any start time gets two looks —
  // that redundancy is why a missed tick doesn't lose the reminder.
  check('T-minus window exceeds the schedule interval',
    R.TMINUS_MIN >= 15, `TMINUS_MIN=${R.TMINUS_MIN}`);

  const fires = (startMin, nowMin) => {
    const until = startMin - nowMin;
    return until > 0 && until <= R.TMINUS_MIN;
  };

  check('fires 30 min before', fires(600, 570));
  check('fires 5 min before', fires(600, 595));
  check('does NOT fire 31 min before', !fires(600, 569));
  check('does NOT fire at start time', !fires(600, 600));
  check('does NOT fire after start', !fires(600, 605));

  // Walk a whole day of 15-minute ticks for a 10:00 booking: exactly two
  // ticks should land in the window (09:30 and 09:45).
  let hits = 0;
  for (let t = 0; t < 1440; t += 15) if (fires(600, t)) hits++;
  check('a 10:00 booking is caught by exactly 2 ticks', hits === 2, `hits=${hits}`);
}

/* ── morning threshold ──────────────────────────────────────── */
{
  check('morning threshold is 07:30', R.MORNING_MIN === 450);

  const fires = (startMin, nowMin) => nowMin >= R.MORNING_MIN && startMin > nowMin;
  check('no morning push at 06:00', !fires(600, 360));
  check('morning push at 07:30 for a 10:00 booking', fires(600, 450));
  check('no morning push for a slot already started', !fires(540, 600));
  // An early booking (e.g. 07:00) is past by the time we look — it gets
  // the T-30 reminder instead, never a stale "today:" push.
  check('no morning push for a pre-07:30 booking at 07:30', !fires(420, 450));
}

/* ── audience ───────────────────────────────────────────────── */
{
  check('owner only', R.bookingAudience({ uid: 'a' }).join() === 'a');
  check('owner + co-operator',
    R.bookingAudience({ uid: 'a', coOperatorUid: 'b' }).sort().join() === 'a,b');
  check('co-operator equal to owner is not duplicated',
    R.bookingAudience({ uid: 'a', coOperatorUid: 'a' }).join() === 'a');
  check('missing uid drops out', R.bookingAudience({ coOperatorUid: 'b' }).join() === 'b');
}

/* ── T-30 handoff line reuses the adjacency engine ──────────── */
{
  // The T-30 body names the next booking only when it is a real handoff
  // owned by somebody else and not Soft — same quiet rule as V3.594.
  const mine = {
    id: 'M', uid: 'alice', equipmentId: 'confocal', equipmentName: 'AX-R',
    date: '2026-08-03', endDate: '2026-08-03',
    startTime: '10:00', endTime: '12:00', priority: 'normal', status: 'confirmed',
  };
  const next = (uid, priority, startTime) => ({
    id: 'N', uid, userName: 'User-' + uid, equipmentId: 'confocal',
    equipmentName: 'AX-R', date: '2026-08-03', endDate: '2026-08-03',
    startTime, endTime: '14:00', priority, status: 'confirmed',
  });

  const handoff = (nb) => {
    const found = ADJ.findNeighbors([mine, nb], mine, ADJ.intervalOf(mine), 30, mine.id);
    return !!(found.downstream && !ADJ.isSoft(found.downstream.priority)
      && found.downstream.uid !== mine.uid);
  };

  check('Firm booking after mine → handoff line', handoff(next('bob', 'high', '12:00')));
  check('Hard booking after mine → handoff line', handoff(next('bob', 'urgent', '12:00')));
  check('Soft booking after mine → no handoff line', !handoff(next('bob', 'normal', '12:00')));
  check('my own next booking → no handoff line', !handoff(next('alice', 'urgent', '12:00')));
  check('far-off booking → no handoff line', !handoff(next('bob', 'urgent', '13:30')));
}

console.log(`\nequipment-reminders: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('All reminder time-math fixtures green.\n');
