/* inventory-use-plan.test.mjs — node scripts/tests/inventory-use-plan.test.mjs
 * V3.840: a measured per-use amount moves the measure and counts a use; the
 * dial's unit follows the item (pickerFor); the toast line reads right. The
 * V3.835 cases live in inventory-labels.test.mjs and must keep passing. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const U = require('../../rm/js/inventory-use.js');

let pass = 0, fail = 0;
function eq(got, want, name) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok    ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '\n        got  ' + g + '\n        want ' + w); }
}
const P = U.plan, F = U.pickerFor;

console.log('── plan: per use with an amount ──');
const ab = { name: 'Anti-tubulin', use_mode: 'per_use', qty_tracked: true, qty_remaining: 98, qty_unit: 'uL', qty_made: 100, qty_min: 10, use_count: 7 };
eq(P(ab, { kind: 'use', n: 2 }), { via: 'qty', mode: 'per_use', event: 'use', qty: 2, unit: 'uL', delta: -2, before: 98, after: 96, itemPatch: { use_count: 8 }, low: false, last: false },
   '2 µL of a tracked antibody: the volume moves, one use counted');
eq(P(ab, { kind: 'use', n: 90 }).low, true, '… and running low when it crosses qty_min');
eq(P(ab, { kind: 'use', n: 2.345 }).qty, 2.345, 'a measure keeps its decimals');
eq(P(ab, { kind: 'use' }).via, 'log', 'no amount → the V3.835 log row');
eq(P(ab, { kind: 'use', n: 0 }).via, 'log', 'zero amount → the log row');
const vials = { use_mode: 'per_use', qty_tracked: true, qty_remaining: 3, qty_unit: 'vial', use_count: 1 };
eq(P(vials, { kind: 'use', n: 1 }), { via: 'log', mode: 'per_use', event: 'use', qty: 1, unit: 'use', delta: 0, before: 3, after: 3, itemPatch: { use_count: 2 }, low: false, last: false },
   'per use on a COUNT still only logs (the vial count moves on "finished")');
eq(P({ use_mode: 'per_use', quantity: 4, use_count: 0 }, { kind: 'use', n: 3 }).itemPatch, { use_count: 3 }, 'untracked: n uses logged');

console.log('── plan: finish ──');
eq(P(ab, { kind: 'finish' }), { via: 'qty', mode: 'per_use', event: 'use', qty: 98, unit: 'uL', delta: -98, before: 98, after: 0, itemPatch: { use_count: 0 }, low: true, last: true },
   'finished a measure: everything left comes off, uses reset');
eq(P(Object.assign({}, ab, { qty_remaining: 0 }), { kind: 'finish' }), { via: 'log', mode: 'per_use', event: 'use', qty: 1, unit: 'use', delta: 0, before: 0, after: 0, itemPatch: { use_count: 0 }, low: true, last: true },
   'finished an already-empty measure: a log row, uses reset');
eq(P(vials, { kind: 'finish' }).qty, 1, 'finished a count: one off (V3.835)');

console.log('── plan: take ──');
const gel = { use_mode: 'package', qty_tracked: true, qty_remaining: 10, qty_unit: 'mL', qty_made: 10 };
eq(P(gel, { kind: 'take', n: 0.5 }), { via: 'qty', mode: 'package', event: 'use', qty: 0.5, unit: 'mL', delta: -0.5, before: 10, after: 9.5, itemPatch: {}, low: false, last: false }, 'a measure package takes a fraction');
eq(P({ use_mode: 'package', qty_tracked: true, qty_remaining: 5, qty_unit: 'box' }, { kind: 'take', n: 2.4 }).qty, 2, 'a count rounds');
eq(P({ use_mode: 'package', qty_tracked: true, qty_remaining: 5, qty_unit: 'box' }, { kind: 'take', n: 0.4 }).qty, 1, 'a count never takes less than one');
eq(P({ is_consumable: true, quantity: 3 }, { kind: 'take', n: 2.7 }).qty, 3, 'legacy rounds too');

console.log('── pickerFor: each item has its own selector unit ──');
eq(F({ use_mode: 'package', qty_tracked: true, qty_remaining: 12, qty_unit: 'pack' }), { kind: 'take', unit: 'pack', max: 12, integer: true, remaining: 12, question: 'How many are you taking?', finish: false }, 'package · tracked count');
eq(F(gel), { kind: 'take', unit: 'mL', max: 10, integer: false, remaining: 10, question: 'How much are you taking?', finish: false }, 'package · tracked measure');
eq(F({ is_consumable: true, quantity: '3' }), { kind: 'take', unit: 'package', max: 3, integer: true, remaining: 3, question: 'How many packages?', finish: false }, 'package · untracked with a Qty');
eq(F({ is_consumable: true }).max, 50, 'package · untracked, no Qty → 50');
eq(F(ab), { kind: 'use', unit: 'uL', max: 98, integer: false, remaining: 98, question: 'How much are you taking?', finish: true }, 'per use · tracked measure');
eq(F(Object.assign({}, ab, { qty_remaining: 0 })).max, null, 'per use · tracked measure, empty → the unit default range');
eq(F({ use_mode: 'per_use' }), { kind: 'use', unit: 'use', max: 20, integer: true, remaining: 0, question: 'How many uses?', finish: true }, 'per use · untracked → uses');
eq(F(vials).unit, 'use', 'per use · tracked count → uses');
eq(F({}).unit, 'package', 'no mode at all → package');
eq(F(ab, 'package').kind, 'take', 'an explicit mode wins');

console.log('── describe ──');
const D = U.describe;
eq(D({ plan: P(ab, { kind: 'use', n: 2 }), item: ab, after: 96, low: false, last: false }), 'Used 2 µL of Anti-tubulin. 96 µL left.', 'measured use');
eq(D({ plan: P(ab, { kind: 'use', n: 90 }), item: ab, after: 8, low: true, last: false }), 'Used 90 µL of Anti-tubulin. 8 µL left. Running low.', 'low');
eq(D({ plan: P(ab, { kind: 'use' }), item: ab }), 'Logged 1 use of Anti-tubulin.', 'log row');
eq(D({ plan: P({ name: 'Tips', is_consumable: true, quantity: 3 }, { kind: 'take', n: 2 }), item: { name: 'Tips' }, after: 1 }), 'Took 2 packages of Tips. 1 package left.', 'legacy packages, singular left');
eq(D({ plan: P(ab, { kind: 'finish' }), item: ab, after: 0, last: true, finished: true }), 'Finished — took it off the shelf. 0 µL left. That was the last one.', 'finished');

console.log(`inventory-use-plan: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
