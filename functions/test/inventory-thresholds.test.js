/* ================================================================
   inventory-thresholds.test.js — the low-stock derivation (V3.646)
   ================================================================
   Plain node, no emulator, no deps:
       node functions/test/inventory-thresholds.test.js

   TWO JOBS.

   1. Assert the derivation itself: explicit qty_min wins; a batch with
      no qty_min falls back to 20%-of-made; an untracked item is left
      strictly alone (deriveStatus → null), which is what stops 740 of
      777 legacy items acquiring a stock_status nobody set.

   2. Assert the CLIENT and SERVER copies agree. rm/js/inventory-qty.js
      and functions/helpers/inventory-thresholds.js implement the same
      rule twice, deliberately — functions/ is CommonJS on Node, rm/js/
      is browser globals with no build step, and there is no import path
      between them. This fuzz is what keeps that duplication honest: the
      client WRITES stock_status but the alerting trigger RECOMPUTES it,
      so a drift means the badge and the push disagree about the same
      bottle.

   Run before every `firebase deploy --only functions` touching
   inventory-alerts.js, and after ANY edit to either derivation.
   ================================================================ */

'use strict';

const fs = require('fs');
const path = require('path');
const SRV = require('../helpers/inventory-thresholds');

let pass = 0, fail = 0;
const failures = [];
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  failures.push(`${name}\n      got ${g}, want ${w}`);
}

/* Load the browser module by evaluating it against a fake window — the same
 * trick keeps this dependency-free and needs no build step. */
function loadClient() {
  const p = path.join(__dirname, '..', '..', 'rm', 'js', 'inventory-qty.js');
  const sandbox = { window: {} };
  new Function('window', fs.readFileSync(p, 'utf8')).call(sandbox, sandbox.window);
  return sandbox.window.INV_QTY;
}
const CLI = loadClient();

const T = (o) => Object.assign({ qty_tracked: true, qty_unit: 'mL' }, o);

/* ── 1. untracked items must be untouched ── */
check('untracked → null', SRV.deriveStatus({ name: 'legacy', quantity: 3 }), null);
check('qty_tracked:false → null', SRV.deriveStatus({ qty_tracked: false, qty_remaining: 0 }), null);
check('untracked severity', SRV.severity({ quantity: 3 }), 'na');
// A tracked item with a non-numeric remaining must not be guessed at.
check('tracked but remaining NaN → na', SRV.severity(T({ qty_remaining: 'lots' })), 'na');

/* ── 2. explicit qty_min wins ── */
check('at min → low', SRV.severity(T({ qty_made: 500, qty_remaining: 100, qty_min: 100 })), 'low');
check('above min → full', SRV.severity(T({ qty_made: 500, qty_remaining: 101, qty_min: 100 })), 'full');
check('zero → out', SRV.severity(T({ qty_made: 500, qty_remaining: 0, qty_min: 100 })), 'out');
check('negative → out', SRV.severity(T({ qty_made: 500, qty_remaining: -5, qty_min: 100 })), 'out');
check('min 0 stays full until empty', SRV.severity(T({ qty_made: 500, qty_remaining: 1, qty_min: 0 })), 'full');

/* ── 3. the 20%-of-made fallback ── */
check('exactly 20% → low', SRV.severity(T({ qty_made: 500, qty_remaining: 100, qty_min: null })), 'low');
check('20.2% → full', SRV.severity(T({ qty_made: 500, qty_remaining: 101, qty_min: null })), 'full');
check('8 of a 40 mL batch → low', SRV.severity(T({ qty_made: 40, qty_remaining: 8, qty_min: null })), 'low');
check('made 0, no min → full (no pct to compute)', SRV.severity(T({ qty_made: 0, qty_remaining: 5, qty_min: null })), 'full');

/* ── 4. enum mapping the four legacy consumers read ── */
check('out maps to out_of_stock', SRV.deriveStatus(T({ qty_made: 1, qty_remaining: 0 })), 'out_of_stock');
check('low maps to low', SRV.deriveStatus(T({ qty_made: 500, qty_remaining: 50 })), 'low');
check('full maps to full', SRV.deriveStatus(T({ qty_made: 500, qty_remaining: 500 })), 'full');
check('isLowSeverity', [SRV.isLowSeverity('low'), SRV.isLowSeverity('out'), SRV.isLowSeverity('full'), SRV.isLowSeverity('na')], [true, true, false, false]);

/* ── 5. client ↔ server drift fuzz ── */
check('LOW_PCT agrees', CLI.LOW_PCT, SRV.LOW_PCT);
let combos = 0, drift = 0;
for (const qty_tracked of [true, false, undefined])
  for (const qty_made of [0, 1, 40, 500, 1e6])
    for (const qty_min of [null, undefined, 0, 1, 100, 499])
      for (const qty_remaining of [-5, 0, 0.0001, 1, 8, 99.9, 100, 100.1, 400, 500, 1e6]) {
        const item = { qty_tracked, qty_made, qty_min, qty_remaining, qty_unit: 'mL' };
        combos++;
        if (CLI.severity(item) !== SRV.severity(item) ||
            CLI.deriveStatus(item) !== SRV.deriveStatus(item)) {
          if (drift < 5) {
            failures.push('DRIFT ' + JSON.stringify(item) +
              `\n      client ${CLI.severity(item)}/${CLI.deriveStatus(item)}` +
              ` server ${SRV.severity(item)}/${SRV.deriveStatus(item)}`);
          }
          drift++;
        }
      }
check(`client/server agree over ${combos} combinations`, drift, 0);

console.log(`\ninventory-thresholds: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  - ' + f));
}
process.exit(fail ? 1 : 0);
