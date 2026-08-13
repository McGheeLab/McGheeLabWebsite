/* ================================================================
   equipment-watches.test.js — watch-matcher fixtures
   ================================================================
       node functions/test/equipment-watches.test.js

   The interesting property is NOT "does it notify when a booking is
   cancelled" — it's "does it stay quiet when the freed time is still
   unusable". A watch that cries wolf is worse than no watch.
   ================================================================ */

'use strict';

const W = require('../helpers/equipment-watches');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + detail : ''));
}

const DATE = '2026-08-06';

function bk(id, uid, startTime, endTime, extra) {
  return Object.assign({
    id, uid, userName: 'User-' + uid,
    equipmentId: 'confocal', equipmentName: 'AX-R Confocal',
    date: DATE, endDate: DATE,
    startTime, endTime, priority: 'normal', status: 'confirmed',
  }, extra || {});
}

function watch(id, uid, startTime, endTime, extra) {
  return Object.assign({
    id, uid, equipmentId: 'confocal', equipmentName: 'AX-R Confocal',
    date: DATE, startTime, endTime, status: 'active', lastNotifiedAt: null,
  }, extra || {});
}

function cancel(b) { return Object.assign({}, b, { status: 'cancelled' }); }

function match(event, before, after, watches, dayBookings, nowMs) {
  return W.matchWatches({
    event, before, after,
    watches, dayBookings,
    nowMs: nowMs === undefined ? Date.parse('2026-08-06T10:00:00Z') : nowMs,
  });
}

/* ── freeGaps: the primitive everything rests on ────────────── */
{
  const win = { start: 480, end: 720 };   // 08:00–12:00

  check('no busy → whole window',
    JSON.stringify(W.freeGaps(win, [])) === JSON.stringify([win]));

  check('busy covers all → nothing free',
    W.freeGaps(win, [{ start: 480, end: 720 }]).length === 0);

  check('busy in the middle → two gaps',
    JSON.stringify(W.freeGaps(win, [{ start: 540, end: 600 }]))
      === JSON.stringify([{ start: 480, end: 540 }, { start: 600, end: 720 }]));

  check('busy overhangs the start',
    JSON.stringify(W.freeGaps(win, [{ start: 420, end: 540 }]))
      === JSON.stringify([{ start: 540, end: 720 }]));

  check('busy outside the window is ignored',
    JSON.stringify(W.freeGaps(win, [{ start: 100, end: 200 }]))
      === JSON.stringify([win]));

  check('two busy blocks → three gaps',
    W.freeGaps(win, [{ start: 510, end: 540 }, { start: 600, end: 630 }]).length === 3);

  check('adjacent busy blocks do not create a zero-width gap',
    W.freeGaps(win, [{ start: 540, end: 600 }, { start: 600, end: 660 }]).length === 2);

  check('overlapping busy blocks are handled',
    JSON.stringify(W.freeGaps(win, [{ start: 540, end: 620 }, { start: 600, end: 660 }]))
      === JSON.stringify([{ start: 480, end: 540 }, { start: 660, end: 720 }]));
}

/* ── the core case: a blocking booking is cancelled ─────────── */
{
  const w = watch('W1', 'carol', '13:00', '17:00');
  const blocker = bk('B', 'bob', '13:00', '17:00');

  const r = match('cancelled', blocker, cancel(blocker), [w], []);
  check('cancelling the blocker notifies the watcher', r.length === 1, JSON.stringify(r));
  check('body names the freed span',
    r.length === 1 && r[0].body.indexOf('1 PM–5 PM') >= 0, r.length ? r[0].body : '');
  check('tag is keyed to the watch',
    r.length === 1 && r[0].tag === 'equip-watch-W1', r.length ? r[0].tag : '');
}

/* ── STILL BLOCKED: the assertions that matter most ─────────── */
{
  const w = watch('W1', 'carol', '13:00', '17:00');
  // Two students split the afternoon. Only one cancels.
  const first = bk('B1', 'bob', '13:00', '15:00');
  const second = bk('B2', 'dave', '15:00', '17:00');

  // Dave's booking still stands, so only 13:00–15:00 is free — that IS
  // useful (2h), so this should notify.
  let r = match('cancelled', first, cancel(first), [w], [second]);
  check('partial free with a usable gap notifies', r.length === 1, JSON.stringify(r));
  check('reported gap is the usable part only',
    r.length === 1 && r[0].body.indexOf('1 PM–3 PM') >= 0, r.length ? r[0].body : '');

  // Now a case where the freed time is unusable: the watcher wants
  // 13:00–17:00, a 20-minute sliver frees, everything else stays booked.
  const w2 = watch('W2', 'carol', '13:00', '17:00');
  const sliver = bk('S', 'bob', '13:00', '13:20');
  const rest = bk('R', 'dave', '13:20', '17:00');
  r = match('cancelled', sliver, cancel(sliver), [w2], [rest]);
  check('a sub-30-min sliver stays SILENT', r.length === 0, JSON.stringify(r));

  // And the fully-still-blocked case.
  const w3 = watch('W3', 'carol', '13:00', '17:00');
  const a = bk('A', 'bob', '13:00', '15:00');
  const b = bk('B', 'dave', '13:00', '17:00');   // covers the whole window
  r = match('cancelled', a, cancel(a), [w3], [b]);
  check('freed time still covered by another booking stays SILENT',
    r.length === 0, JSON.stringify(r));
}

/* ── moves release only the part no longer covered ──────────── */
{
  const w = watch('W1', 'carol', '13:00', '17:00');

  // A booking shifted by 30 min frees only 30 min → below the useful
  // threshold once the rest of the window is considered.
  const was = bk('B', 'bob', '13:00', '17:00');
  const nudged = bk('B', 'bob', '13:30', '17:30');
  let r = match('moved', was, nudged, [w], [nudged]);
  check('a 30-min nudge frees only a 30-min gap',
    r.length === 1 && r[0].body.indexOf('1 PM–1:30 PM') >= 0,
    r.length ? r[0].body : 'no notification');

  // A booking moved right out of the window frees the whole thing.
  const gone = bk('B', 'bob', '18:00', '20:00');
  r = match('moved', was, gone, [w], [gone]);
  check('moving out of the window frees it all',
    r.length === 1 && r[0].body.indexOf('1 PM–5 PM') >= 0, r.length ? r[0].body : '');

  // A move INTO a watched window releases nothing.
  const elsewhere = bk('C', 'dave', '08:00', '10:00');
  const intoWindow = bk('C', 'dave', '13:00', '15:00');
  r = match('moved', elsewhere, intoWindow, [w], [intoWindow]);
  check('a move INTO the window notifies nobody', r.length === 0, JSON.stringify(r));
}

/* ── silence rules ──────────────────────────────────────────── */
{
  const blocker = bk('B', 'bob', '13:00', '17:00');

  check('your own booking never fires your own watch',
    match('cancelled', blocker, cancel(blocker),
      [watch('W', 'bob', '13:00', '17:00')], []).length === 0);

  check('a non-overlapping window stays silent',
    match('cancelled', blocker, cancel(blocker),
      [watch('W', 'carol', '08:00', '10:00')], []).length === 0);

  check('a different date stays silent',
    match('cancelled', blocker, cancel(blocker),
      [watch('W', 'carol', '13:00', '17:00', { date: '2026-08-07' })], []).length === 0);

  check('a different device stays silent',
    match('cancelled', blocker, cancel(blocker),
      [watch('W', 'carol', '13:00', '17:00', { equipmentId: 'bioprinter' })], []).length === 0);

  check('an inactive watch stays silent',
    match('cancelled', blocker, cancel(blocker),
      [watch('W', 'carol', '13:00', '17:00', { status: 'fulfilled' })], []).length === 0);

  check('a booking CREATED notifies nobody',
    match('created', null, blocker,
      [watch('W', 'carol', '13:00', '17:00')], [blocker]).length === 0);

  check('a multi-day booking is out of the model',
    match('cancelled',
      bk('B', 'bob', '20:00', '08:00', { endDate: '2026-08-07' }),
      cancel(bk('B', 'bob', '20:00', '08:00', { endDate: '2026-08-07' })),
      [watch('W', 'carol', '13:00', '17:00')], []).length === 0);
}

/* ── re-notify throttle ─────────────────────────────────────── */
{
  const blocker = bk('B', 'bob', '13:00', '17:00');
  const now = Date.parse('2026-08-06T10:00:00Z');

  const fresh = watch('W', 'carol', '13:00', '17:00', {
    lastNotifiedAt: now - 5 * 60 * 1000,       // 5 minutes ago
  });
  check('throttled inside the window',
    match('cancelled', blocker, cancel(blocker), [fresh], [], now).length === 0);

  const stale = watch('W', 'carol', '13:00', '17:00', {
    lastNotifiedAt: now - 40 * 60 * 1000,      // 40 minutes ago
  });
  check('notifies again once the throttle expires',
    match('cancelled', blocker, cancel(blocker), [stale], [], now).length === 1);

  // Firestore Timestamps arrive as objects with toMillis().
  const tsStyle = watch('W', 'carol', '13:00', '17:00', {
    lastNotifiedAt: { toMillis: () => now - 60 * 1000 },
  });
  check('Firestore Timestamp shape is honored',
    match('cancelled', blocker, cancel(blocker), [tsStyle], [], now).length === 0);
}

/* ── several watchers on one device ─────────────────────────── */
{
  const blocker = bk('B', 'bob', '13:00', '17:00');
  const ws = [
    watch('W1', 'carol', '13:00', '15:00'),
    watch('W2', 'dave', '16:00', '17:00'),
    watch('W3', 'erin', '08:00', '09:00'),   // no overlap
    watch('W4', 'bob', '13:00', '17:00'),    // own booking
  ];
  const r = match('cancelled', blocker, cancel(blocker), ws, []);
  const ids = r.map((x) => x.watch.id).sort().join(',');
  check('every overlapping watcher is notified, others are not',
    ids === 'W1,W2', ids);
}

/* ── fulfillment ────────────────────────────────────────────── */
{
  const ws = [
    watch('W1', 'carol', '13:00', '17:00'),
    watch('W2', 'carol', '08:00', '10:00'),
    watch('W3', 'dave', '13:00', '17:00'),
    watch('W4', 'carol', '13:00', '17:00', { date: '2026-08-07' }),
  ];
  const booked = bk('NEW', 'carol', '14:00', '16:00');
  const ids = W.fulfilledWatches(booked, ws).map((w) => w.id).join(',');
  check('booking inside your window fulfills only that watch', ids === 'W1', ids);

  check('a cancelled booking fulfills nothing',
    W.fulfilledWatches(cancel(booked), ws).length === 0);

  // Touching the edge is not overlapping.
  const abutting = bk('NEW', 'carol', '17:00', '18:00');
  check('a booking that merely abuts the window does not fulfill it',
    W.fulfilledWatches(abutting, ws).length === 0);
}

console.log(`\nequipment-watches: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('All watch-matcher fixtures green.\n');
