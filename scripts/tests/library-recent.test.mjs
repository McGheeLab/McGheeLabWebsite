/* library-recent.test.mjs — node scripts/tests/library-recent.test.mjs
 * Pins the DOM-free half of V3.825: when a paper counts as added, the
 * recency windows, the `added:` token grammar, the newest-first list and the
 * relative-time words. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../../rm/js/library-recent.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL ' + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' → got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
const NOW = Date.parse('2026-10-22T18:00:00Z');
const D = C.DAY;
const paper = (id, lib) => ({ id, title: id, meta: { library: Object.assign({ is_library_entry: true }, lib) } });

console.log('── when was it added ──');
eq(C.addedMs(paper('a', { captured_at_iso: '2026-10-22T15:30:00Z', date_added: '2026-01-01' })), Date.parse('2026-10-22T15:30:00Z'), 'captured_at_iso (to the second) wins over date_added');
eq(C.addedMs(paper('b', { date_added: '2026-10-20' })), Date.parse('2026-10-20'), 'date_added (the day)');
eq(C.addedMs(paper('c', { pdf: { uploaded_at: '2026-09-01' } })), Date.parse('2026-09-01'), 'the PDF upload day as a last resort');
eq([C.addedMs(paper('d', {})), C.addedMs(paper('e', { date_added: 'junk' })), C.addedMs({})], [0, 0, 0], 'unknown → 0');

console.log('── windows ──');
eq([C.parseWindow(''), C.parseWindow('any'), C.parseWindow('today'), C.parseWindow('7d'), C.parseWindow('30 days'), C.parseWindow('2w'), C.parseWindow('3m'), C.parseWindow('year'), C.parseWindow('2026'), C.parseWindow('2026-10'), C.parseWindow('older'), C.parseWindow('older-30d'), C.parseWindow('nonsense')],
   [null, null, { kind: 'days', n: 1 }, { kind: 'days', n: 7 }, { kind: 'days', n: 30 }, { kind: 'days', n: 14 }, { kind: 'days', n: 90 }, { kind: 'year', y: 0 }, { kind: 'year', y: 2026 }, { kind: 'month', y: 2026, m: 10 }, { kind: 'older', n: 90 }, { kind: 'older', n: 30 }, null], 'the token grammar');
const today = paper('t', { captured_at_iso: new Date(NOW - 3600000).toISOString() });
const d5 = paper('5', { date_added: new Date(NOW - 5 * D).toISOString().slice(0, 10) });
const d45 = paper('45', { date_added: new Date(NOW - 45 * D).toISOString().slice(0, 10) });
const d200 = paper('200', { date_added: new Date(NOW - 200 * D).toISOString().slice(0, 10) });
const lastYear = paper('ly', { date_added: '2025-03-03' });
const unknown = paper('u', {});
const all = [today, d5, d45, d200, lastYear, unknown];
const ids = (spec) => all.filter((p) => C.withinWindow(p, spec, NOW)).map((p) => p.id);
eq(ids(null), ['t', '5', '45', '200', 'ly', 'u'], 'no window → everything');
eq(ids(C.parseWindow('today')), ['t'], 'today');
eq(ids(C.parseWindow('7d')), ['t', '5'], 'last 7 days');
eq(ids(C.parseWindow('30d')), ['t', '5'], 'last 30 days');
eq(ids(C.parseWindow('90d')), ['t', '5', '45'], 'last 90 days');
eq(ids(C.parseWindow('year')), ['t', '5', '45', '200'], 'this year (2026)');
eq(ids(C.parseWindow('2025')), ['ly'], 'a named year');
eq(ids(C.parseWindow('2026-10')), ['t', '5'], 'a named month');
eq(ids(C.parseWindow('older')), ['200', 'ly', 'u'], 'older than 90 days — unknown dates count as old');
eq(C.countWithin(all, 30, NOW), 2, 'countWithin');

console.log('── the strip ──');
eq(C.recentList(all, { limit: 3 }).map((p) => p.id), ['t', '5', '45'], 'newest first, unknown dates left out, capped');
eq(C.recentList(all, { limit: 100 }).length, 5, 'the cap is the only limit');
eq([C.relTime(NOW - 3600000, NOW), C.relTime(NOW - 1 * D - 1000, NOW), C.relTime(NOW - 5 * D, NOW), C.relTime(NOW - 20 * D, NOW), C.relTime(NOW - 100 * D, NOW), C.relTime(NOW - 400 * D, NOW), C.relTime(NOW - 800 * D, NOW), C.relTime(0, NOW)],
   ['today', 'yesterday', '5 days ago', '3 weeks ago', '3 months ago', '1 year ago', '2 years ago', ''], 'relative time words');
ok(C.WINDOW_LABEL['30d'] === 'Added: last 30 days' && C.WINDOW_LABEL[''] === 'Added: any time', 'labels for the select');

console.log(`library-recent: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
