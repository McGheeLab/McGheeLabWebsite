/* ================================================================
   equipment-adjacency.test.js — decision-matrix fixtures
   ================================================================
   Plain node, no emulator, no deps:
       node functions/test/equipment-adjacency.test.js

   The engine's whole value is being QUIET in the right cases, so most
   of these fixtures assert that NOTHING is sent. Run this before every
   `firebase deploy --only functions` touching equipment.
   ================================================================ */

'use strict';

const A = require('../helpers/equipment-adjacency');

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + detail : ''));
}

/* Booking factory — id, uid, times, criticality. */
function bk(id, uid, startTime, endTime, priority, extra) {
  return Object.assign({
    id, uid,
    userName: 'User-' + uid,
    equipmentId: 'confocal',
    equipmentName: 'AX-R Confocal',
    date: '2026-08-03', endDate: '2026-08-03',
    startTime, endTime,
    priority: priority || 'normal',
    status: 'confirmed',
  }, extra || {});
}

function decide(event, before, after, day, gapMin) {
  return A.decide({
    event, before, after,
    dayBookings: day,
    bookingId: (after && after.id) || (before && before.id),
    gapMin: gapMin === undefined ? 30 : gapMin,
  });
}

function bodies(res) { return res.map((r) => r.recipientUid + ': ' + r.title).join(' | '); }

/* ── time + weight primitives ───────────────────────────────── */

check('timeToMin parses', A.timeToMin('14:30') === 870);
check('timeToMin rejects junk', A.timeToMin('nope') === null);
check('fmt12h noon', A.fmt12h('12:00') === '12 PM', A.fmt12h('12:00'));
check('fmt12h afternoon', A.fmt12h('14:30') === '2:30 PM', A.fmt12h('14:30'));
check('fmt12h midnight', A.fmt12h('00:00') === '12 AM', A.fmt12h('00:00'));
check('maintenance weighs as Hard', A.weight('maintenance') === 2);
check('unknown priority is Soft', A.weight('bogus') === 0);
check('labels match V3.588', A.label('high') === 'Firm' && A.label('urgent') === 'Hard');

/* ── classifyChange ─────────────────────────────────────────── */

check('create', A.classifyChange(null, bk('b', 'u1', '09:00', '10:00')) === 'created');
check('cancel', A.classifyChange(
  bk('b', 'u1', '09:00', '10:00'),
  bk('b', 'u1', '09:00', '10:00', 'normal', { status: 'cancelled' })) === 'cancelled');
check('displacement reads as cancelled', A.classifyChange(
  bk('b', 'u1', '09:00', '10:00'),
  bk('b', 'u1', '09:00', '10:00', 'normal', { status: 'needs-rebooking' })) === 'cancelled');
check('time move', A.classifyChange(
  bk('b', 'u1', '09:00', '10:00'),
  bk('b', 'u1', '11:00', '12:00')) === 'moved');
check('notes-only edit is none', A.classifyChange(
  bk('b', 'u1', '09:00', '10:00'),
  bk('b', 'u1', '09:00', '10:00', 'normal', { notes: 'changed' })) === 'none');
check('approval→confirmed is not a move', A.classifyChange(
  bk('b', 'u1', '09:00', '10:00', 'normal', { status: 'pending-approval' }),
  bk('b', 'u1', '09:00', '10:00')) === 'none');

/* ── E1: someone books right after you ──────────────────────── */
{
  const a = bk('A', 'alice', '09:00', '12:00', 'normal');

  // Firm booking lands right after Alice → Alice is told to be on time.
  const firm = bk('B', 'bob', '12:00', '14:00', 'high');
  let r = decide('created', null, firm, [a, firm]);
  check('E1 Firm-after notifies the outgoing student',
    r.length === 1 && r[0].recipientUid === 'alice', bodies(r));
  check('E1 body names the end time',
    r.length === 1 && r[0].body.indexOf('12 PM') >= 0, r.length ? r[0].body : '');
  check('E1 direction is down', r.length === 1 && r[0].direction === 'down');

  // Soft booking lands right after Alice → SILENCE. This is the
  // single most important assertion in the file.
  const soft = bk('B', 'bob', '12:00', '14:00', 'normal');
  r = decide('created', null, soft, [a, soft]);
  check('E1 Soft-after stays SILENT', r.length === 0, bodies(r));

  // 90-minute gap is not a handoff.
  const far = bk('B', 'bob', '13:30', '15:00', 'urgent');
  r = decide('created', null, far, [a, far]);
  check('E1 gap beyond threshold stays silent', r.length === 0, bodies(r));

  // Exactly at the 30-min threshold still counts.
  const edge = bk('B', 'bob', '12:30', '14:00', 'high');
  r = decide('created', null, edge, [a, edge]);
  check('E1 gap exactly == threshold notifies', r.length === 1, bodies(r));

  // Your own back-to-back bookings never notify you.
  const mine = bk('B', 'alice', '12:00', '14:00', 'urgent');
  r = decide('created', null, mine, [a, mine]);
  check('E1 same-owner pair stays silent', r.length === 0, bodies(r));

  // A maintenance block should not be told to hurry up.
  const maint = bk('M', 'admin', '09:00', '12:00', 'maintenance');
  const hard = bk('B', 'bob', '12:00', '14:00', 'urgent');
  r = decide('created', null, hard, [maint, hard]);
  check('E1 maintenance upstream stays silent', r.length === 0, bodies(r));
}

/* ── E2: someone books right before you ─────────────────────── */
{
  const b = bk('B', 'bob', '14:00', '16:00', 'high');

  // Hard booking squeezes in before Bob → warn him.
  const hard = bk('A', 'alice', '12:00', '14:00', 'urgent');
  let r = decide('created', null, hard, [hard, b]);
  check('E2 Hard-before warns the incoming student',
    r.length === 1 && r[0].recipientUid === 'bob' && r[0].direction === 'up', bodies(r));

  // Firm is not enough for the before-case — too speculative.
  const firm = bk('A', 'alice', '12:00', '14:00', 'high');
  r = decide('created', null, firm, [firm, b]);
  check('E2 Firm-before stays silent', r.length === 0, bodies(r));
}

/* ── E3/E4: cancellation and displacement ───────────────────── */
{
  const alice = bk('A', 'alice', '09:00', '12:00', 'normal');
  const bobFirm = bk('B', 'bob', '12:00', '14:00', 'high');

  // Bob's Firm booking is cancelled → Alice hears the pressure lifted.
  const gone = Object.assign({}, bobFirm, { status: 'cancelled' });
  let r = decide('cancelled', bobFirm, gone, [alice]);
  check('E3 cancel relieves the upstream student',
    r.length === 1 && r[0].recipientUid === 'alice', bodies(r));
  check('E3 body says cancelled',
    r.length === 1 && r[0].body.indexOf('cancelled') >= 0, r.length ? r[0].body : '');

  // Displacement is worded differently but reaches the same person.
  const displaced = Object.assign({}, bobFirm, { status: 'needs-rebooking' });
  r = decide('cancelled', bobFirm, displaced, [alice]);
  check('E3 displacement says displaced',
    r.length === 1 && r[0].body.indexOf('displaced') >= 0, r.length ? r[0].body : '');

  // A cancelled SOFT booking never applied pressure → nothing to relieve.
  const bobSoft = bk('B', 'bob', '12:00', '14:00', 'normal');
  r = decide('cancelled', bobSoft, Object.assign({}, bobSoft, { status: 'cancelled' }), [alice]);
  check('E3 cancelling a Soft booking stays silent', r.length === 0, bodies(r));

  // E4: the booking BEFORE a Firm booking is cancelled → free setup time.
  const carolFirm = bk('C', 'carol', '12:00', '14:00', 'high');
  r = decide('cancelled', alice, Object.assign({}, alice, { status: 'cancelled' }), [carolFirm]);
  check('E4 upstream cancel tells the incoming student',
    r.length === 1 && r[0].recipientUid === 'carol' && r[0].direction === 'up', bodies(r));

  // ...but a Soft downstream booking doesn't care.
  const carolSoft = bk('C', 'carol', '12:00', '14:00', 'normal');
  r = decide('cancelled', alice, Object.assign({}, alice, { status: 'cancelled' }), [carolSoft]);
  check('E4 Soft downstream stays silent', r.length === 0, bodies(r));
}

/* ── moves: the case the user called out explicitly ─────────── */
{
  const alice = bk('A', 'alice', '09:00', '12:00', 'normal');

  // "if the student taking over the shift moves their window at any
  // point, we should notify the student that their experiment end time
  // needs to be on time" — Bob slides earlier, tightening the handoff.
  const was = bk('B', 'bob', '12:30', '14:30', 'high');
  const now = bk('B', 'bob', '12:00', '14:00', 'high');
  let r = decide('moved', was, now, [alice, now]);
  check('move-earlier re-nudges the outgoing student',
    r.length === 1 && r[0].recipientUid === 'alice', bodies(r));
  check('move-earlier says moved earlier',
    r.length === 1 && r[0].title.indexOf('earlier') >= 0, r.length ? r[0].title : '');

  // Bob moves far away → Alice gains slack.
  const away = bk('B', 'bob', '16:00', '18:00', 'high');
  r = decide('moved', was, away, [alice, away]);
  check('move-away grants slack to the outgoing student',
    r.length === 1 && r[0].recipientUid === 'alice'
    && r[0].title.indexOf('slack') >= 0, bodies(r));

  // Bob slides LATER but stays inside the handoff window (Alice ends
  // 12:00, threshold 30, so 12:20 is still a 20-min handoff). He gave
  // her 20 minutes, the handoff is still tight, and she was already
  // told once — not worth a second buzz.
  const wasTight = bk('B', 'bob', '12:00', '14:00', 'high');
  const laterStart = bk('B', 'bob', '12:20', '14:20', 'high');
  r = decide('moved', wasTight, laterStart, [alice, laterStart]);
  check('move later but still adjacent stays silent', r.length === 0, bodies(r));

  // Moving the START earlier is the case that MUST re-nudge, even by a
  // few minutes — Alice's deadline genuinely moved.
  const slightlyEarlier = bk('B', 'bob', '12:15', '14:30', 'high');
  r = decide('moved', was, slightlyEarlier, [alice, slightlyEarlier]);
  check('any earlier start re-nudges', r.length === 1
    && r[0].title.indexOf('earlier') >= 0, bodies(r));

  // A Soft booking moving around is nobody else's business.
  const softWas = bk('B', 'bob', '12:30', '14:30', 'normal');
  const softNow = bk('B', 'bob', '12:00', '14:00', 'normal');
  r = decide('moved', softWas, softNow, [alice, softNow]);
  check('Soft move stays silent', r.length === 0, bodies(r));
}

/* ── moved: both neighbors at once ──────────────────────────── */
{
  // Alice ends 12:00, Carol starts 15:00 (Firm). Bob's Hard booking
  // moves from a gap-less middle slot to fill 12:00-15:00 exactly.
  const alice = bk('A', 'alice', '09:00', '12:00', 'high');
  const carol = bk('C', 'carol', '15:00', '17:00', 'high');
  const was = bk('B', 'bob', '13:00', '14:00', 'urgent');
  const now = bk('B', 'bob', '12:00', '15:00', 'urgent');
  const r = decide('moved', was, now, [alice, carol, now]);
  const uids = r.map((x) => x.recipientUid).sort().join(',');
  check('a move can notify both neighbors', uids === 'alice,carol', bodies(r));
  check('the two notices carry different tags',
    r.length === 2 && r[0].tag !== r[1].tag, r.map((x) => x.tag).join(' '));
}

/* ── cross-date moves ───────────────────────────────────────── */
{
  // A booking dragged to a different DAY. Both days' neighbors are in
  // the list the caller supplies; adjacency must not pair across dates
  // just because the clock times line up.
  const mondayAlice = bk('A', 'alice', '09:00', '12:00', 'high');
  const tuesdayCarol = bk('C', 'carol', '09:00', '12:00', 'high',
    { date: '2026-08-04', endDate: '2026-08-04' });

  const was = bk('B', 'bob', '12:00', '14:00', 'urgent');
  const now = bk('B', 'bob', '12:00', '14:00', 'urgent',
    { date: '2026-08-04', endDate: '2026-08-04' });

  const r = decide('moved', was, now, [mondayAlice, tuesdayCarol, now]);
  const uids = r.map((x) => x.recipientUid).sort().join(',');
  // Alice (Monday) loses her tight handoff; Carol (Tuesday) gains one.
  check('cross-date move reaches both days', uids === 'alice,carol', bodies(r));
  const aliceMsg = r.find((x) => x.recipientUid === 'alice');
  check('old-date neighbor is told it left',
    aliceMsg && aliceMsg.title.indexOf('slack') >= 0, aliceMsg && aliceMsg.title);

  // Same clock times, different dates, nothing moved → no pairing.
  const r2 = decide('created', null, tuesdayCarol, [mondayAlice, tuesdayCarol]);
  check('same times on different dates are not neighbors', r2.length === 0, bodies(r2));
}

/* ── different devices are never neighbors ──────────────────── */
{
  const scope = bk('A', 'alice', '09:00', '12:00', 'high');
  const printer = bk('B', 'bob', '12:00', '14:00', 'urgent',
    { equipmentId: 'bioprinter', equipmentName: 'Bioprinter' });
  const r = decide('created', null, printer, [scope, printer]);
  check('bookings on different devices never pair', r.length === 0, bodies(r));
}

/* ── multi-day exclusion (known limitation) ─────────────────── */
{
  const overnight = bk('A', 'alice', '20:00', '08:00', 'normal', { endDate: '2026-08-04' });
  const bob = bk('B', 'bob', '08:00', '10:00', 'urgent');
  const r = decide('created', null, bob, [overnight, bob]);
  check('multi-day neighbors are skipped', r.length === 0, bodies(r));
}

/* ── malformed data must not throw ──────────────────────────── */
{
  const ok = bk('B', 'bob', '12:00', '14:00', 'high');
  const noTimes = bk('A', 'alice', null, null, 'normal');
  const backwards = bk('C', 'carol', '14:00', '09:00', 'normal');
  let threw = null;
  try {
    decide('created', null, ok, [noTimes, backwards, ok]);
    decide('created', null, noTimes, [ok]);
    decide('moved', noTimes, noTimes, [ok]);
    decide('cancelled', backwards, backwards, [ok]);
  } catch (e) { threw = e; }
  check('malformed bookings do not throw', threw === null, threw && threw.message);
}

/* ── configurable gap threshold ─────────────────────────────── */
{
  const alice = bk('A', 'alice', '09:00', '12:00', 'normal');
  const bob = bk('B', 'bob', '12:45', '14:00', 'high');
  let r = decide('created', null, bob, [alice, bob], 30);
  check('45-min gap silent at threshold 30', r.length === 0, bodies(r));
  r = decide('created', null, bob, [alice, bob], 60);
  check('45-min gap notifies at threshold 60', r.length === 1, bodies(r));
}

/* ── report ─────────────────────────────────────────────────── */

console.log(`\nequipment-adjacency: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('All adjacency fixtures green.\n');
