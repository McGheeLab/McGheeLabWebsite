/* qty-picker.test.mjs — node scripts/tests/qty-picker.test.mjs
 * V3.840: the DOM-free half of the Woodchuck amount dial — a count is an
 * integer drum, a measure is a 1/2/5 ladder with a fine dial step, the top
 * of the range is always reachable, and the default is sensible. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../../rm/js/qty-picker.js');

let pass = 0, fail = 0;
function eq(got, want, name) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok    ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '\n        got  ' + g + '\n        want ' + w); }
}

console.log('── niceStep ──');
eq([C.niceStep(98), C.niceStep(500), C.niceStep(10), C.niceStep(1000), C.niceStep(5), C.niceStep(0), C.niceStep(400)],
   [0.5, 2, 0.05, 5, 0.02, 1, 1], '1/2/5 ladder so max/step ≤ 400 rows');
eq(C.niceStep(98, 100), 1, 'rows is a parameter');

console.log('── range / nearest / fmt ──');
eq(C.range(0, 1, 0.1), [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1], 'range cleans float noise');
eq(C.range(1, 3, 1), [1, 2, 3], 'integer range');
eq(C.range(0, 1, 0), [], 'no step → empty');
eq(C.nearest([0, 0.5, 1], 0.74), 0.5, 'nearest picks the closest rung');
eq([C.fmt(2.5), C.fmt(0.1 + 0.2), C.fmt(3), C.fmt(1.23456)], ['2.5', '0.3', '3', '1.235'], 'fmt trims to 3 decimals');
eq([C.displayUnit('uL'), C.displayUnit('ug'), C.displayUnit('package', 2), C.displayUnit('use', 1), C.displayUnit('mL')], ['µL', 'µg', 'packages', 'use', 'mL'], 'display units');

console.log('── specFor ──');
const ab = C.specFor('uL', { remaining: 98 });
eq([ab.integer, ab.step, ab.fine, ab.min, ab.max, ab.values[0], ab.values[ab.values.length - 1], ab.values.length, ab.display],
   [false, 0.5, 0.05, 0, 98, 0, 98, 197, 'µL'], 'µL antibody, 98 left: 0.5 ladder, 0.05 dial, top reachable');
const pk = C.specFor('pack', { remaining: 12 });
eq([pk.integer, pk.step, pk.fine, pk.min, pk.max, pk.values], [true, 1, 0, 1, 12, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]], 'packs, 12 left: 1 … 12');
eq(C.specFor('package', {}).max, 50, 'untracked packages: 1 … 50');
eq(C.specFor('use', { max: 20 }).values.length, 20, 'uses: 1 … 20');
eq(C.specFor('vial', { max: 1 }).values, [1], 'a count with nothing left (pickerFor passes max 1) still offers 1');
eq(C.specFor('vial', { remaining: 0 }).max, 50, 'a count with unknown stock → 50');
eq(C.specFor('mL', {}).max, 100, 'a measure with no remaining uses the unit default');
eq(C.specFor('g', { remaining: -3 }).max, 100, 'a negative remaining is ignored');
const odd = C.specFor('mL', { remaining: 7.3 });
eq([odd.step, odd.values[odd.values.length - 1]], [0.02, 7.3], 'a max that is not on the ladder is appended');
eq(C.specFor('uL', { remaining: 98, integer: true }).integer, true, 'integer can be forced');
eq(C.specFor('mL', { max: 10, step: 0.5, fine: 0.1 }).fine, 0.1, 'explicit step and fine win');

console.log('── defaultValue ──');
eq(C.defaultValue(pk, null), 1, 'a count starts at 1');
eq(C.defaultValue(ab, null), 10, 'a measure starts near a tenth of the range, on the ladder');
eq(C.defaultValue(ab, 2.5), 2.5, 'the remembered amount wins');
eq(C.defaultValue(ab, 500), 10, 'a remembered amount above the range is ignored');
eq(C.defaultValue(pk, 2.6), 3, 'a remembered count is rounded');
eq(C.defaultValue(C.specFor('vial', { remaining: 0 }), null), 1, 'nothing left → 1');

console.log(`qty-picker: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
