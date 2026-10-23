/* scripts/tests/myweek-needs-result.test.mjs — V3.853
 *
 * Pure logic lifted out of the page sources (the myweek-inbox pattern):
 *   rm/js/my-week.js        needsResult(it, today)              — what the nudge counts
 *   rm/js/day-distribute.js closedStatusFor(status, kind, closeAs) — the status an outcome closes to
 * No DOM, no Firestore. Run: node scripts/tests/myweek-needs-result.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function lift(file, name) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const i = src.indexOf('  function ' + name + '(');
  if (i < 0) throw new Error(file + ' no longer defines ' + name + '()');
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced braces in ' + name + '()');
}

const needsResult = new Function(lift('rm/js/my-week.js', 'needsResult') + '\nreturn needsResult;')();
const closedStatusFor = new Function(lift('rm/js/day-distribute.js', 'closedStatusFor') + '\nreturn closedStatusFor;')();

let pass = 0, fail = 0;
function eq(label, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  console.log('  FAIL ' + label + ' — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}

const T = '2026-10-23', Y = '2026-10-22', TM = '2026-10-24';
const oc = { kind: 'result' };

/* needsResult — closed-without-result counts the SAME day; planned once its day has passed */
eq('done today, no result → counts today', needsResult({ status: 'done', date: T }, T), true);
eq('done yesterday, no result → counts', needsResult({ status: 'done', date: Y }, T), true);
eq('done with a result → clean', needsResult({ status: 'done', date: Y, outcome: oc }, T), false);
eq('skipped today, no result → counts', needsResult({ status: 'skipped', date: T }, T), true);
eq('skipped with a barrier → clean', needsResult({ status: 'skipped', date: T, outcome: { kind: 'barrier' } }, T), false);
eq('planned today → still in progress', needsResult({ status: 'planned', date: T }, T), false);
eq('planned yesterday → never confirmed', needsResult({ status: 'planned', date: Y }, T), true);
eq('planned tomorrow → upcoming', needsResult({ status: 'planned', date: TM }, T), false);
eq('cancelled → never', needsResult({ status: 'cancelled', date: Y }, T), false);
eq('done without a date → ignored', needsResult({ status: 'done' }, T), false);
eq('done dated tomorrow (pre-logged) → not yet', needsResult({ status: 'done', date: TM }, T), false);
eq('null row → false', needsResult(null, T), false);

/* closedStatusFor — a result is always done; otherwise the click's intent wins on a planned item */
eq('planned + result (no intent) → done', closedStatusFor('planned', 'result', undefined), 'done');
eq('planned + barrier (no intent) → skipped', closedStatusFor('planned', 'barrier', undefined), 'skipped');
eq('planned + no_result (no intent) → skipped', closedStatusFor('planned', 'no_result', undefined), 'skipped');
eq('✓ then barrier → done (did it, hit a wall)', closedStatusFor('planned', 'barrier', 'done'), 'done');
eq('✓ then no_result → done (did it, nothing came out)', closedStatusFor('planned', 'no_result', 'done'), 'done');
eq('✗ then result → done (actually it worked)', closedStatusFor('planned', 'result', 'skipped'), 'done');
eq('✗ then barrier → skipped', closedStatusFor('planned', 'barrier', 'skipped'), 'skipped');
eq('skipped + result later → done', closedStatusFor('skipped', 'result', undefined), 'done');
eq('skipped + barrier later → skipped', closedStatusFor('skipped', 'barrier', undefined), 'skipped');
eq('done + barrier later → stays done', closedStatusFor('done', 'barrier', undefined), 'done');
eq('done + no_result with ✗ intent → stays done', closedStatusFor('done', 'no_result', 'skipped'), 'done');

console.log('my-week needs-result: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
