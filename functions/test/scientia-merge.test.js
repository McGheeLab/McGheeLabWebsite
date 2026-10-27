/* ================================================================
   scientia-merge.test.js — V3.932 — two people's edits to one card
   ================================================================
   functions/scientia-merge.js on its own, then through the hub's push
   (planPush): edits in place, additions to the same list, both versions
   side by side, an edit whose place was removed at the end of the card,
   no common version (a computer meeting the cloud), marks following
   their lines, a card's place and name.
   Run: node functions/test/scientia-merge.test.js
   ================================================================ */
'use strict';
const assert = require('assert');
const G = require('../scientia-merge');
const C = require('../scientia-hub-core');

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.error('✗ ' + name + '\n   ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n   ')); } }
const L = (...a) => a.join('\n');

(async () => {
  const list = L('Buffers', '• PBS 1x', '• Tris 50 mM', '• EDTA 1 mM', 'Done by Friday');
  await test('edits to different items of a list both land in place', () => {
    const mine = list.replace('PBS 1x', 'PBS 10x'), cur = list.replace('EDTA 1 mM', 'EDTA 2 mM');
    const r = G.mergeLines(list, mine, cur);
    assert.strictEqual(r.text, L('Buffers', '• PBS 10x', '• Tris 50 mM', '• EDTA 2 mM', 'Done by Friday')); assert.ok(r.clean);
  });
  await test('both add to the end of the list → both items, in the list, the one already there first', () => {
    const mine = list.replace('• EDTA 1 mM', '• EDTA 1 mM\n• NaCl 150 mM'), cur = list.replace('• EDTA 1 mM', '• EDTA 1 mM\n• Glycerol 5%');
    assert.strictEqual(G.mergeLines(list, mine, cur).text, L('Buffers', '• PBS 1x', '• Tris 50 mM', '• EDTA 1 mM', '• Glycerol 5%', '• NaCl 150 mM', 'Done by Friday'));
  });
  await test('one edits an item while the other adds an item elsewhere in the list', () => {
    const mine = list.replace('Tris 50 mM', 'Tris 20 mM'), cur = list.replace('• PBS 1x', '• PBS 1x\n• MgCl2 2 mM');
    assert.strictEqual(G.mergeLines(list, mine, cur).text, L('Buffers', '• PBS 1x', '• MgCl2 2 mM', '• Tris 20 mM', '• EDTA 1 mM', 'Done by Friday'));
  });
  await test('both change the same item differently → both versions there, side by side', () => {
    const mine = list.replace('Tris 50 mM', 'Tris 20 mM'), cur = list.replace('Tris 50 mM', 'Tris 100 mM');
    const r = G.mergeLines(list, mine, cur);
    assert.strictEqual(r.text, L('Buffers', '• PBS 1x', '• Tris 100 mM', '• Tris 20 mM', '• EDTA 1 mM', 'Done by Friday')); assert.strictEqual(r.together, 1);
  });
  await test('an edit to lines the other removed has no place → the end of the card, saying whose', () => {
    const mine = list.replace('Done by Friday', 'Done by Monday'), cur = L('Buffers', '• PBS 1x', '• Tris 50 mM', '• EDTA 1 mM');
    const r = G.mergeLines(list, mine, cur, { mineName: 'Gabe' });
    assert.strictEqual(r.text, L('Buffers', '• PBS 1x', '• Tris 50 mM', '• EDTA 1 mM', '', 'Gabe’s edit (its place was removed):', 'Done by Monday')); assert.strictEqual(r.atEnd, 1);
  });
  await test('a line one side removed and the other left alone is removed', () => {
    const cur = list.replace('• Tris 50 mM\n', ''), mine = list.replace('Buffers', 'Buffers (fresh)');
    assert.strictEqual(G.mergeLines(list, mine, cur).text, L('Buffers (fresh)', '• PBS 1x', '• EDTA 1 mM', 'Done by Friday'));
  });
  await test('no common version (a computer and the cloud meeting): what both hold once, each one’s own lines kept', () => {
    const mine = L('Plan', 'step A', 'step B (computer)', 'step C'), cur = L('Plan', 'step A', 'step C', 'step D (cloud)');
    assert.strictEqual(G.mergeLines(null, mine, cur).text, L('Plan', 'step A', 'step B (computer)', 'step C', 'step D (cloud)'));
  });
  await test('marks follow their lines; one a side removed stays removed', () => {
    const base = { text: L('alpha', 'beta', 'gamma'), marks: [{ id: 'm1', type: 'struct', from: 6, to: 10, ref: 'i1' }, { id: 'm2', type: 'term', from: 11, to: 16, ref: 't1' }] };
    const mine = { text: L('new first', 'alpha', 'beta', 'gamma'), marks: [{ id: 'm1', type: 'struct', from: 16, to: 20, ref: 'i1' }, { id: 'm2', type: 'term', from: 21, to: 26, ref: 't1' }] };
    const cur = { text: L('alpha', 'beta', 'gamma', 'delta'), marks: [{ id: 'm1', type: 'struct', from: 6, to: 10, ref: 'i1' }, { id: 'm3', type: 'cite', from: 17, to: 18, ref: 'p1' }] };   // m2 removed here
    const r = G.mergeBody(base, mine, cur);
    assert.strictEqual(r.body.text, L('new first', 'alpha', 'beta', 'gamma', 'delta'));
    const t = r.body.text, by = id => r.body.marks.find(m => m.id === id);
    assert.strictEqual(t.slice(by('m1').from, by('m1').to), 'beta'); assert.ok(!by('m2'), 'removed on one side'); assert.strictEqual(t.slice(by('m3').from, by('m3').to), 'd');
  });

  /* ---- through the hub ---- */
  const dev = (hub, name) => ({ seq: 0, sid: null, async load() { const s = await hub.state(); this.sid = s.sid; this.seq = s.syncSeq; }, async push(ops) { const r = await hub.push({ dev: name, conn: name, name, ops: ops.map(o => Object.assign({ base: this.seq }, o)) }); return r; } });
  await test('two devices edit the same card: one card, both edits in it, no decision to make', async () => {
    const hub = new C.MemoryHub(), A = dev(hub, 'Alex'), B = dev(hub, 'Gabe');
    const b0 = { id: 'b1', label: 'Buffers', x: 0, y: 0, body: { text: list, marks: [] } };
    await A.load(); await A.push([{ store: 'blocks', id: 'b1', rec: b0, prev: null }]); await B.load(); await A.load();
    const ra = await A.push([{ store: 'blocks', id: 'b1', prev: b0, rec: Object.assign({}, b0, { x: 40, body: { text: list.replace('EDTA 1 mM', 'EDTA 2 mM'), marks: [] } }) }]);
    const rb = await B.push([{ store: 'blocks', id: 'b1', prev: b0, rec: Object.assign({}, b0, { x: 90, label: 'Buffer list', body: { text: list.replace('• EDTA 1 mM', '• EDTA 1 mM\n• NaCl 150 mM'), marks: [] } }) }]);
    assert.strictEqual(ra.conflicts, 0); assert.strictEqual(rb.conflicts, 0);
    const rec = hub.rows.get(C.keyOf('blocks', 'b1')).rec;
    assert.strictEqual(rec.body.text, L('Buffers', '• PBS 1x', '• Tris 50 mM', '• EDTA 2 mM', '• NaCl 150 mM', 'Done by Friday'));
    assert.strictEqual(rec.label, 'Buffer list'); assert.strictEqual(rec.x, 40, 'where it is now stays');
  });
  await test('both rename the card → the other name goes at the end of the card', async () => {
    const hub = new C.MemoryHub(), A = dev(hub, 'Alex'), B = dev(hub, 'Gabe (shared)');
    const b0 = { id: 'b1', label: 'Buffers', body: { text: 'PBS', marks: [] } };
    await A.load(); await A.push([{ store: 'blocks', id: 'b1', rec: b0, prev: null }]); await B.load(); await A.load();
    await A.push([{ store: 'blocks', id: 'b1', prev: b0, rec: Object.assign({}, b0, { label: 'Buffers (Alex)' }) }]);
    const r = await B.push([{ store: 'blocks', id: 'b1', prev: b0, rec: Object.assign({}, b0, { label: 'Buffers (Gabe)' }) }]);
    const rec = hub.rows.get(C.keyOf('blocks', 'b1')).rec;
    assert.strictEqual(r.conflicts, 0); assert.strictEqual(rec.label, 'Buffers (Alex)'); assert.strictEqual(rec.body.text, L('PBS', '', 'Gabe’s name for this card: Buffers (Gabe)'));
  });

  /* ---- V3.933: each person's version in their colour ---- */
  const byMarks = body => body.marks.filter(m => m.type === 'fmt' && /^by\d$/.test(m.s));
  await test('both change the same item → each version coloured as its writer’s, never the same colour', () => {
    const base = { text: list, marks: [] }, mine = { text: list.replace('Tris 50 mM', 'Tris 20 mM'), marks: [] }, cur = { text: list.replace('Tris 50 mM', 'Tris 100 mM'), marks: [] };
    const r = G.mergeBody(base, mine, cur, { mineName: 'Gabe', curName: 'Alex' }), t = r.body.text, by = byMarks(r.body);
    assert.strictEqual(by.length, 2);
    const a = by.find(m => m.who === 'Alex'), g = by.find(m => m.who === 'Gabe');
    assert.strictEqual(t.slice(a.from, a.to), '• Tris 100 mM'); assert.strictEqual(t.slice(g.from, g.to), '• Tris 20 mM');
    assert.notStrictEqual(a.s, g.s); assert.strictEqual(a.s, 'by' + G.hueOf('Alex'));
    assert.ok(!byMarks(G.mergeBody(base, mine, { text: list.replace('PBS 1x', 'PBS 2x'), marks: [] }, { mineName: 'Gabe', curName: 'Alex' }).body).length, 'edits in different places are not coloured');
  });
  await test('a person keeps one colour across cards; two people never share one on a card', () => {
    for (const [x, y] of [['Alex', 'Gabe'], ['Gabe', 'Alex'], ['Bea', 'Bea'], ['Online', 'This computer']]) { const c = G.byColours(x, y); assert.notStrictEqual(c.cur, c.mine); }
    assert.strictEqual(G.byColours('Alex', 'Gabe').cur, G.byColours('Alex', 'Bea').cur);
  });
  await test('an edit moved to the end of the card is coloured as its writer’s', () => {
    const r = G.mergeBody({ text: list, marks: [] }, { text: list.replace('Done by Friday', 'Done by Monday'), marks: [] }, { text: L('Buffers', '• PBS 1x', '• Tris 50 mM', '• EDTA 1 mM'), marks: [] }, { mineName: 'Gabe', curName: 'Alex' });
    const g = byMarks(r.body); assert.strictEqual(g.length, 1); assert.strictEqual(g[0].who, 'Gabe'); assert.strictEqual(r.body.text.slice(g[0].from, g[0].to), 'Done by Monday');
  });
  await test('through the hub: a collaborator’s line and the owner’s are named by person, not device', () => {
    const b0 = { id: 'b1', body: { text: list, marks: [] } }, curRec = { id: 'b1', body: { text: list.replace('Tris 50 mM', 'Tris 100 mM'), marks: [] } };
    const rows = new Map([[C.keyOf('blocks', 'b1'), { rec: curRec, seq: 5, dev: 'web_ab12', name: 'Online' }]]);
    const plan = C.planPush({ state: Object.assign(C.emptyState(), { seq: 5 }), rows, dev: 'share:G', name: 'Gabe (shared)', ownerName: 'Alex McGhee',
      ops: [{ store: 'blocks', id: 'b1', base: 2, prev: b0, rec: { id: 'b1', body: { text: list.replace('Tris 50 mM', 'Tris 20 mM'), marks: [] } } }] });
    const rec = plan.writes[0].rec, who = byMarks(rec.body).map(m => m.who).sort();
    assert.deepStrictEqual(who, ['Alex McGhee', 'Gabe']); assert.strictEqual(plan.state.conflicts.length, 0);
  });

  console.log('scientia-merge: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})();
