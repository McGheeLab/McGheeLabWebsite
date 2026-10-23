/* user-actions.test.mjs — node scripts/tests/user-actions.test.mjs
 * V3.844: an action is built from a ledger write or a booking, reads as one
 * plain line, groups by day, and a pending list leaves out the ignored and
 * the already-noted. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const A = require('../../rm/js/user-actions.js');

let pass = 0, fail = 0;
function eq(got, want, name) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok    ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '\n        got  ' + g + '\n        want ' + w); }
}
const local = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm).toISOString();

console.log('── fromInventory / fromBooking ──');
const out = { itemId: 'ab', usageId: 'u123', qty: 2.5, unit: 'uL', delta: -2.5, after: 95.5, note: 'GELS day 3', labelCode: 'MG-A7K2X', context: 'scan', useMode: 'per_use', event: 'use', item: { id: 'ab', name: 'Anti-tubulin' } };
const a1 = A.fromInventory(out);
eq([a1.id, a1.kind, a1.status, a1.itemId, a1.itemName, a1.qty, a1.unit, a1.delta, a1.after, a1.note, a1.labelCode, a1.useMode, a1.usageId], ['inv_u123', 'inventory_use', 'new', 'ab', 'Anti-tubulin', 2.5, 'uL', -2.5, 95.5, 'GELS day 3', 'MG-A7K2X', 'per_use', 'u123'], 'an inventory action carries the ledger facts; id = inv_<usageId>');
eq(typeof a1.at === 'string' && a1.at.length > 10, true, 'stamped at now');
const b1 = A.fromBooking('bk1', { equipmentId: 'conf', equipmentName: 'Confocal', date: '2026-10-23', startTime: '10:00', endTime: '12:00', durationMin: 120, notes: 'GELS imaging', uid: 'u1' });
eq([b1.id, b1.kind, b1.equipmentName, b1.date, b1.endDate, b1.startTime, b1.endTime, b1.durationMin, b1.notes, b1.bookingId], ['eq_bk1', 'equipment_booking', 'Confocal', '2026-10-23', '2026-10-23', '10:00', '12:00', 120, 'GELS imaging', 'bk1'], 'a booking action; id = eq_<bookingId>');

console.log('── describe ──');
eq(A.describe(a1), 'Used 2.5 µL of Anti-tubulin', 'per-use measure');
eq(A.describe({ kind: 'inventory_use', itemName: 'Tips', qty: 2, unit: 'pack', delta: -2, useMode: 'package' }), 'Took 2 packs of Tips', 'package');
eq(A.describe({ kind: 'inventory_use', itemName: 'Tubes', qty: 1, unit: 'ea', delta: -1, useMode: 'package', legacy: true }), 'Took 1 package of Tubes', 'legacy ea reads as a package');
eq(A.describe({ kind: 'inventory_use', itemName: 'Kit', qty: 1, unit: 'use', delta: 0, useMode: 'per_use' }), 'Logged a use of Kit', 'a log row');
eq(A.describe({ kind: 'inventory_use', itemName: 'Kit', qty: 3, unit: 'use', delta: 0 }), 'Logged 3 uses of Kit', 'n uses');
eq(A.shortDate('2026-10-22'), 'Thu 22 Oct', 'short date (2026-10-22 is a Thursday)');
const before = new Date(2026, 9, 22, 12, 0), after = new Date(2026, 9, 23, 13, 0);
eq(A.describe(b1, before), 'Booked the Confocal · ' + A.shortDate('2026-10-23') + ' 10:00–12:00', 'a future booking reads Booked');
eq(A.describe(b1, after), 'Used the Confocal · ' + A.shortDate('2026-10-23') + ' 10:00–12:00', '… and Used once the slot has passed');
eq(A.describe({ kind: 'equipment_booking', equipmentName: 'Plasma cleaner', date: '2026-10-23' }, before), 'Booked the Plasma cleaner · ' + A.shortDate('2026-10-23'), 'no times → the date only');

console.log('── days ──');
eq(A.dayKey(local(2026, 10, 22, 14, 2)), '2026-10-22', 'dayKey is the local day');
eq(A.timeOf(local(2026, 10, 22, 14, 2)), '14:02', 'timeOf');
eq([A.dayLabel('2026-10-22', '2026-10-22'), A.dayLabel('2026-10-21', '2026-10-22'), A.dayLabel('2026-10-13', '2026-10-22')], ['Today', 'Yesterday', A.shortDate('2026-10-13')], 'Today / Yesterday / a date');
const rows = [
  { id: 'a', at: local(2026, 10, 21, 9, 0), status: 'new' },
  { id: 'b', at: local(2026, 10, 22, 14, 2), status: 'new' },
  { id: 'c', at: local(2026, 10, 22, 9, 30), status: 'ignored' },
  { id: 'd', at: local(2026, 10, 22, 16, 0), status: 'noted' },
];
const g = A.groupByDay(rows, '2026-10-22');
eq(g.map(x => x.label), ['Today', 'Yesterday'], 'newest day first');
eq(g[0].rows.map(x => x.id), ['d', 'b', 'c'], 'newest first inside a day');
eq(A.pending(rows).map(x => x.id), ['a', 'b'], 'pending = not ignored, not noted');

console.log(`user-actions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
