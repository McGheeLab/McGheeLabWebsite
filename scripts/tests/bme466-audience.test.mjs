/* V3.681 — functions/bme466-notify.js audience resolution.
 *
 *   node scripts/tests/bme466-audience.test.mjs
 *
 * No emulator needed: this pins the pure logic that decides WHO gets told an
 * assignment was published. It matters because the failure is silent — a
 * student who is never notified has nothing to notice — and because this
 * mirrors bme466Section() in class-builder.js, so the two must not drift.
 *
 * The load-bearing rule: an UNKNOWN section fails OPEN. Notifying one extra
 * person is a small cost; failing to tell a 566 student about the qualifying
 * exam because their section was blank is not.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-bme466';
const { _levelOf: levelOf, _inAudience: inAudience } =
  require('../../functions/bme466-notify.js');

const results = [];
function check(name, got, want) {
  const ok = got === want;
  results.push({ name, ok, got: String(got), want: String(want) });
}

/* levelOf: staff assignment wins over the student's claim */
check('sectionAssigned wins over sectionClaim',
  levelOf({ sectionAssigned: 'BME466', sectionClaim: 'AME566' }), '466');
check('claim is used when nothing is assigned',
  levelOf({ sectionClaim: 'AME566' }), '566');
check('empty profile has no level', levelOf({}), null);
check('missing profile has no level', levelOf(null), null);
check('BME566 → 566', levelOf({ sectionAssigned: 'BME566' }), '566');
check('AME466 → 466', levelOf({ sectionAssigned: 'AME466' }), '466');
check('junk section yields no level', levelOf({ sectionClaim: 'not-a-section' }), null);

/* inAudience: the fail-open contract */
check('audience "all" includes a sectionless student',
  inAudience({}, 'all'), true);
check('audience "all" includes a 566 student',
  inAudience({ sectionAssigned: 'BME566' }, 'all'), true);
check('missing audience defaults to everyone',
  inAudience({ sectionAssigned: 'BME466' }, undefined), true);
check('466-only excludes a 566 student',
  inAudience({ sectionAssigned: 'BME566' }, '466'), false);
check('566-only excludes a 466 student',
  inAudience({ sectionAssigned: 'BME466' }, '566'), false);
check('566-only includes AME566 (department never gates work)',
  inAudience({ sectionAssigned: 'AME566' }, '566'), true);
check('466-only includes AME466',
  inAudience({ sectionClaim: 'AME466' }, '466'), true);
check('566-only FAILS OPEN for an unknown section',
  inAudience({}, '566'), true);
check('466-only FAILS OPEN for an unknown section',
  inAudience({ sectionClaim: 'nonsense' }, '466'), true);
check('a staff-corrected 466 is excluded from 566 even if they claimed 566',
  inAudience({ sectionClaim: 'BME566', sectionAssigned: 'BME466' }, '566'), false);

const bad = results.filter(r => !r.ok);
console.log('='.repeat(82));
for (const r of results) {
  console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.name.padEnd(58)} got=${r.got} want=${r.want}`);
}
console.log('='.repeat(82));
console.log(`${results.length} checks · ${results.length - bad.length} as intended · ${bad.length} deviations`);
process.exit(bad.length ? 1 : 0);
