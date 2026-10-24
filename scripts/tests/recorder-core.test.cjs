/* V3.884 — the one recorder's shared timeline (rm/js/recorder-core.js). node scripts/tests/recorder-core.test.cjs */
'use strict';
const assert = require('assert');
const C = require('../../rm/js/recorder-core.js');
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error('✗ ' + name + '\n   ' + String(e.stack || e).split('\n').slice(0, 3).join('\n   ')); } }

test('marks: a moment, sorted, kinds kept or defaulted to important; Scientia bookmarks (no kind) read as important', () => {
  let m = C.addMark([], { t: 12.345, kind: 'question', label: 'why 40 µm?' });
  m = C.addMark(m, { t: 3, kind: 'nonsense' });
  assert.deepStrictEqual(m.map(x => [x.t, x.kind, x.end]), [[3, 'important', undefined], [12.35, 'question', undefined]]);
  assert.strictEqual(C.normMarks([{ id: 'k1', t: 5, label: '' }])[0].kind, 'important');
  assert.strictEqual(C.markLabel(m[1]), '? why 40 µm?'); assert.strictEqual(C.markLabel({ t: 1 }), '◆ Important');
});
test('marks: a section opens (end null), a second toggle closes it; opening another closes the first', () => {
  let m = C.toggleSection([], 10, 'decision');
  assert.deepStrictEqual([C.openOf(m).t, C.openOf(m).end, C.openOf(m).kind], [10, null, 'decision']);
  m = C.toggleSection(m, 25);
  assert.strictEqual(C.openOf(m), null); assert.strictEqual(m[0].end, 25);
  m = C.openSection(m, { t: 30, kind: 'todo' }); m = C.openSection(m, { t: 40 });
  assert.deepStrictEqual(m.map(x => [x.t, x.end]), [[10, 25], [30, 40], [40, null]]);
  assert.strictEqual(C.closeSection([{ t: 50, end: null }], 45)[0].end, 50, 'an end never comes before the start');
});
test('marks: marksAt finds the sections around t and the moments near it', () => {
  const m = C.normMarks([{ id: 'a', t: 5 }, { id: 'b', t: 10, end: 20 }, { id: 'c', t: 30, end: null }]);
  assert.deepStrictEqual(C.marksAt(m, 6).map(x => x.id), ['a']);
  assert.deepStrictEqual(C.marksAt(m, 15).map(x => x.id), ['b']);
  assert.deepStrictEqual(C.marksAt(m, 99).map(x => x.id), ['c'], 'an open section runs to now');
});
test('voice: wall ↔ audio around gaps (a pause, a suspended tab) — the replay\'s rule', () => {
  const gaps = [{ t: 20000, durationMs: 5000 }];   // silent from 15 s to 20 s of wall time
  assert.strictEqual(C.audioToWall(10000, gaps), 10000);
  assert.strictEqual(C.audioToWall(16000, gaps), 21000);
  assert.strictEqual(C.wallToAudio(21000, gaps), 16000);
  assert.strictEqual(C.wallToAudio(10000, gaps), 10000);
});
test('words: lineAt is the segment being spoken (or the last begun); -1 before the first', () => {
  const segs = [{ s: 0, e: 4, text: 'a' }, { s: 4, e: 9, text: 'b' }, { s: 12, e: 15, text: 'c' }];
  assert.deepStrictEqual([C.lineAt(segs, 0), C.lineAt(segs, 5), C.lineAt(segs, 10), C.lineAt(segs, 99), C.lineAt([{ s: 2, e: 3 }], 1)], [0, 1, 1, 2, -1]);
});
test('ink: a stamped stroke knows its moment; strokesAt finds what was being drawn', () => {
  const s1 = C.stamp({ p: [[0, 0, .5]] }, 'rec1', 10, 12.5), s2 = C.stamp({ p: [] }, 'rec1', 30, 31), s3 = C.stamp({ p: [] }, 'other', 11, 12);
  assert.deepStrictEqual(s1.rt, ['rec1', 10, 12.5]); assert.ok(!('rt' in { p: [] }));
  assert.deepStrictEqual(C.momentOf(s1, 'rec1'), { t0: 10, t1: 12.5 }); assert.strictEqual(C.momentOf(s3, 'rec1'), null);
  assert.deepStrictEqual(C.strokesAt([s1, s2, s3], 11, 'rec1').length, 1);
  assert.deepStrictEqual(C.strokesAt([s1, s2, s3], 13, 'rec1', 0).length, 0);
});
test('cost: minutes rounded up × the rate; words a person reads', () => {
  assert.deepStrictEqual([C.sttCost(30 * 60).minutes, C.sttCost(30 * 60).text], [30, '48¢']);
  assert.strictEqual(C.sttCost(75 * 60).text, '$1.20');
  assert.strictEqual(C.sttCost(5).minutes, 1);
  assert.strictEqual(C.sttCost(0, 0.004).text, 'under 1¢');
});
test('parts: names sort in order; mm:ss', () => {
  assert.deepStrictEqual([C.partName(3, 'webm'), C.partName(12, 'm4a')], ['part-0003.webm', 'part-0012.m4a']);
  assert.deepStrictEqual([C.mmss(65), C.mmss(3725)], ['1:05', '1:02:05']);
});
console.log(`recorder-core: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
