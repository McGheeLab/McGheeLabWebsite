/* ================================================================
   scientia-share.test.js — V3.899 — Share / Collaborate between hubs
   ================================================================
   Pure node fixtures over functions/scientia-share-core.js on
   MemoryHubs (one per person): a review shared to read, a change
   reaching the reader, a reader's change put back, a collaborator's
   change reaching the owner and everyone, two edits merging, a clash
   landing in the owner's conflicts, the owner's fields kept, access
   taken away, a project with its themes and notes, a member's own
   project of the same id left alone, files following their records,
   and (V3.921) a collaborator's side losing its copies never deleting
   the owner's originals.
   Run: node functions/test/scientia-share.test.js
   ================================================================ */
'use strict';
const assert = require('assert');
const C = require('../scientia-hub-core');
const S = require('../scientia-share-core');

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.error('✗ ' + name + '\n   ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n   ')); } }

const MEMBERS = { A: { name: 'Alex' }, B: { name: 'Bea' }, C: { name: 'Cy' } };
const rowOf = (env, uid, store, id) => { const r = env.memoryHub(uid).rows.get(C.keyOf(store, id)); return r && r.rec ? r.rec : null; };
/** a device of `uid` pushes (as the web app would) and the function relays what it committed */
async function push(env, uid, ops, dev) {
  const h = env.memoryHub(uid);
  await h.push({ dev: dev || 'web', name: 'Online', ops: ops.map(o => Object.assign({ base: Number.MAX_SAFE_INTEGER, prev: null }, o)) });
  return S.relayPush(env, uid, h.lastCommits || []);
}
const put = (store, rec) => ({ store, id: rec.id, rec });
function review(env, uid, extra) {
  const d = Object.assign({ id: 'd_rev1', type: 'literature', title: 'ERK waves', projectId: null, review: { topic: 'How do ERK waves travel?', projectIds: ['p_mine'] }, blockIds: ['b_1', 'b_2'], modified: '2026-10-24T10:00:00' }, extra || {});
  return [put('documents', d), put('blocks', { id: 'b_1', docId: d.id, kind: 'component', body: { text: 'Waves travel at 2 µm/min' }, label: 'claim' }),
    put('blocks', { id: 'b_2', docId: d.id, kind: 'pdf', media: 'm_pdf0001', label: 'Aoki 2017' }), put('media', { id: 'm_pdf0001', kind: 'pdf', path: 'images/m_pdf0001.pdf' }),
    put('wires', { id: 'w_1', from: 'b_1', to: 'b_2', rel: 'supports' }), put('items', { id: 'i_1', kind: 'claim', originDocId: d.id })];
}

(async () => {
  /* ---- pure parts ---- */
  await test('grantsOf: roles, lab members, never the owner, never a copy', () => {
    const m = new Map([['B', {}], ['C', {}]]);
    assert.deepStrictEqual(S.grantsOf({ shareWith: { B: 'read', C: 'edit', A: 'edit', Z: 'read', B2: 'admin' } }, 'A', m), { B: 'read', C: 'edit' });
    assert.deepStrictEqual(S.grantsOf({ shareWith: { B: 'read' }, sharedFrom: { uid: 'X' } }, 'A', m), {});
    assert.deepStrictEqual(S.grantsOf({ shareWith: { B: 'read' }, deleted: true }, 'A', m), {});
  });
  await test('sameish ignores AUTO_MAX timestamps only', () => {
    assert.ok(S.sameish({ a: 1, modified: 'x' }, { a: 1, modified: 'y' }));
    assert.ok(!S.sameish({ a: 1 }, { a: 2 }));
  });
  await test('protect keeps the owner’s filing and grants; a new note goes into the shared project', () => {
    const idx = S.idxSets({ projectId: 'p_1', themeIds: ['t_1'] });
    const o = S.protect('documents', { id: 'd', projectId: 'p_x', themeId: 't_x', shareWith: { Z: 'edit' }, title: 'new', review: { topic: 't', projectIds: ['p_x'] } }, { projectId: 'p_1', themeId: 't_1', shareWith: { B: 'edit' }, review: { projectIds: ['p_1'] } }, idx);
    assert.strictEqual(o.projectId, 'p_1'); assert.strictEqual(o.themeId, 't_1'); assert.deepStrictEqual(o.shareWith, { B: 'edit' }); assert.deepStrictEqual(o.review.projectIds, ['p_1']); assert.strictEqual(o.title, 'new');
    const n = S.protect('documents', { id: 'n', projectId: 'p_x', themeId: 't_1', shareWith: { Z: 'edit' } }, undefined, idx);
    assert.strictEqual(n.projectId, 'p_1'); assert.strictEqual(n.themeId, 't_1'); assert.ok(!('shareWith' in n));
  });
  await test('closure of a review: note, components, wires inside, structures, media it uses', () => {
    const rows = {}; for (const o of review()) { rows[o.store] = rows[o.store] || new Map(); rows[o.store].set(o.id, o.rec); }
    rows.media.set('m_other', { id: 'm_other', path: 'images/m_other.png' }); rows.wires.set('w_out', { id: 'w_out', from: 'b_1', to: 'b_elsewhere' });
    const c = S.closure({ kind: 'review', recId: 'd_rev1', rows });
    assert.deepStrictEqual([...c.recs.keys()].map(k => k.replace('\u0001', '/')).sort(), ['blocks/b_1', 'blocks/b_2', 'documents/d_rev1', 'items/i_1', 'media/m_pdf0001', 'wires/w_1']);
    assert.deepStrictEqual([...c.mediaIds], ['m_pdf0001']);
  });

  /* ---- a review, read only ---- */
  const env = new S.MemoryShareEnv(MEMBERS);
  env.hub('A'); await env.hub('A').mediaCopy([{ path: 'images/m_pdf0001.pdf', url: 'https://files/A/m_pdf0001.pdf' }]);
  await push(env, 'A', review(env, 'A'));
  await test('nothing is shared until the owner says so', () => { assert.strictEqual(rowOf(env, 'B', 'documents', 'd_rev1'), null); assert.strictEqual(env.idx.size, 0); });
  await test('Share with Bea → her Scientia has the review, its parts and its PDF, marked read only', async () => {
    const d = Object.assign({}, rowOf(env, 'A', 'documents', 'd_rev1'), { shareWith: { B: 'read' } });
    const r = await push(env, 'A', [put('documents', d)]);
    assert.strictEqual(r.passes.length, 1);
    const copy = rowOf(env, 'B', 'documents', 'd_rev1');
    assert.ok(copy); assert.deepStrictEqual(copy.sharedFrom, { uid: 'A', name: 'Alex', role: 'read', share: 'A__d__d_rev1' });
    for (const [s, id] of [['blocks', 'b_1'], ['blocks', 'b_2'], ['wires', 'w_1'], ['items', 'i_1'], ['media', 'm_pdf0001']]) assert.ok(rowOf(env, 'B', s, id), s + '/' + id);
    assert.ok(!rowOf(env, 'B', 'blocks', 'b_1').sharedFrom, 'components carry no marker');
    assert.strictEqual(env.files.get('B').get('images/m_pdf0001.pdf').url, 'https://files/A/m_pdf0001.pdf');
    const ix = env.idx.get('A__d__d_rev1'); assert.deepStrictEqual(ix.memberUids, ['B']); assert.strictEqual(ix.names.B, 'Bea');
  });
  await test('Alex edits a component → Bea’s copy follows (no full pass)', async () => {
    const r = await push(env, 'A', [put('blocks', Object.assign({}, rowOf(env, 'A', 'blocks', 'b_1'), { body: { text: 'Waves travel at 3 µm/min' } }))]);
    assert.strictEqual(r.passes.length, 0); assert.ok(r.out >= 1);
    assert.strictEqual(rowOf(env, 'B', 'blocks', 'b_1').body.text, 'Waves travel at 3 µm/min');
  });
  await test('Alex adds a component → Bea gets it and the note’s new order', async () => {
    const d = Object.assign({}, rowOf(env, 'A', 'documents', 'd_rev1')); d.blockIds = d.blockIds.concat(['b_3']);
    await push(env, 'A', [put('blocks', { id: 'b_3', docId: 'd_rev1', kind: 'component', body: { text: 'A third thought' } }), put('documents', d)]);
    assert.deepStrictEqual(rowOf(env, 'B', 'documents', 'd_rev1').blockIds, ['b_1', 'b_2', 'b_3']); assert.ok(rowOf(env, 'B', 'blocks', 'b_3'));
    assert.ok(env.idx.get('A__d__d_rev1').blockIds.includes('b_3'));
  });
  await test('Bea (read only) changes a component → put back; Alex’s stays as it was', async () => {
    const r = await push(env, 'B', [put('blocks', Object.assign({}, rowOf(env, 'B', 'blocks', 'b_1'), { body: { text: 'vandalised' } }))]);
    assert.strictEqual(r.reverted, 1);
    assert.strictEqual(rowOf(env, 'B', 'blocks', 'b_1').body.text, 'Waves travel at 3 µm/min');
    assert.strictEqual(rowOf(env, 'A', 'blocks', 'b_1').body.text, 'Waves travel at 3 µm/min');
  });
  await test('Bea only opens it (a timestamp moves) → nothing put back, nothing sent', async () => {
    const r = await push(env, 'B', [put('documents', Object.assign({}, rowOf(env, 'B', 'documents', 'd_rev1'), { modified: '2026-10-25T09:00:00' }))]);
    assert.strictEqual(r.reverted, 0); assert.strictEqual(r.in, 0);
  });

  /* ---- collaborate ---- */
  await test('Alex makes Bea a collaborator and shares with Cy to read → both copies say so', async () => {
    await push(env, 'A', [put('documents', Object.assign({}, rowOf(env, 'A', 'documents', 'd_rev1'), { shareWith: { B: 'edit', C: 'read' } }))]);
    assert.strictEqual(rowOf(env, 'B', 'documents', 'd_rev1').sharedFrom.role, 'edit');
    assert.strictEqual(rowOf(env, 'C', 'documents', 'd_rev1').sharedFrom.role, 'read');
    assert.ok(rowOf(env, 'C', 'blocks', 'b_3'));
  });
  await test('Bea edits → Alex’s original and Cy’s copy change', async () => {
    const r = await push(env, 'B', [put('blocks', Object.assign({}, rowOf(env, 'B', 'blocks', 'b_3'), { body: { text: 'Bea’s better third thought' } }))]);
    assert.strictEqual(r.in, 1);
    assert.strictEqual(rowOf(env, 'A', 'blocks', 'b_3').body.text, 'Bea’s better third thought');
    assert.strictEqual(rowOf(env, 'C', 'blocks', 'b_3').body.text, 'Bea’s better third thought');
  });
  await test('Bea adds a component to the shared note → it becomes part of Alex’s note, and Cy’s', async () => {
    const d = Object.assign({}, rowOf(env, 'B', 'documents', 'd_rev1')); d.blockIds = d.blockIds.concat(['b_bea']);
    await push(env, 'B', [put('blocks', { id: 'b_bea', docId: 'd_rev1', kind: 'component', body: { text: 'From Bea' } }), put('documents', d)]);
    assert.ok(rowOf(env, 'A', 'blocks', 'b_bea')); assert.ok(rowOf(env, 'A', 'documents', 'd_rev1').blockIds.includes('b_bea'));
    assert.ok(!rowOf(env, 'A', 'documents', 'd_rev1').sharedFrom, 'the original carries no marker');
    assert.ok(rowOf(env, 'C', 'blocks', 'b_bea'));
  });
  await test('Alex and Bea change different fields of one component at once → both kept everywhere', async () => {
    const bA = rowOf(env, 'A', 'blocks', 'b_1'), bB = rowOf(env, 'B', 'blocks', 'b_1');
    const ha = env.memoryHub('A'); await ha.push({ dev: 'web', name: 'Online', ops: [{ store: 'blocks', id: 'b_1', rec: Object.assign({}, bA, { label: 'key claim' }), prev: bA, base: Number.MAX_SAFE_INTEGER }] });
    // Bea's edit started from the copy she had (before Alex's label reached her)
    const hb = env.memoryHub('B'); await hb.push({ dev: 'web', name: 'Online', ops: [{ store: 'blocks', id: 'b_1', rec: Object.assign({}, bB, { body: { text: 'Waves travel at 3.2 µm/min' } }), prev: bB, base: Number.MAX_SAFE_INTEGER }] });
    await S.relayPush(env, 'B', hb.lastCommits);
    await S.relayPush(env, 'A', ha.lastCommits);
    for (const u of ['A', 'B', 'C']) { const b = rowOf(env, u, 'blocks', 'b_1'); assert.strictEqual(b.label, 'key claim', u); assert.strictEqual(b.body.text, 'Waves travel at 3.2 µm/min', u); }
  });
  await test('A clash on one field → Alex’s conflict list holds Bea’s version; Bea’s copy shows Alex’s', async () => {
    const bA = rowOf(env, 'A', 'blocks', 'b_2'), bB = rowOf(env, 'B', 'blocks', 'b_2');
    const ha = env.memoryHub('A'); await ha.push({ dev: 'web', name: 'Online', ops: [{ store: 'blocks', id: 'b_2', rec: Object.assign({}, bA, { label: 'Alex says' }), prev: bA, base: Number.MAX_SAFE_INTEGER }] });
    const hb = env.memoryHub('B'); await hb.push({ dev: 'web', name: 'Online', ops: [{ store: 'blocks', id: 'b_2', rec: Object.assign({}, bB, { label: 'Bea says' }), prev: bB, base: Number.MAX_SAFE_INTEGER }] });
    await S.relayPush(env, 'B', hb.lastCommits);
    const cs = (await ha.conflicts()).conflicts; assert.ok(cs.some(c => c.id === 'b_2' && c.fields.includes('label') && c.mine.label === 'Bea says'), JSON.stringify(cs));
    assert.strictEqual(rowOf(env, 'B', 'blocks', 'b_2').label, 'Alex says');
  });
  await test('A collaborator cannot move the note or change who it is shared with', async () => {
    await push(env, 'B', [put('documents', Object.assign({}, rowOf(env, 'B', 'documents', 'd_rev1'), { title: 'ERK waves (Bea)', shareWith: { B: 'edit', C: 'edit', Z: 'edit' }, review: { topic: 'How fast?', projectIds: ['p_bea'] } }))]);
    const d = rowOf(env, 'A', 'documents', 'd_rev1');
    assert.strictEqual(d.title, 'ERK waves (Bea)'); assert.strictEqual(d.review.topic, 'How fast?');
    assert.deepStrictEqual(d.shareWith, { B: 'edit', C: 'read' }); assert.deepStrictEqual(d.review.projectIds, ['p_mine']);
    assert.deepStrictEqual(rowOf(env, 'B', 'documents', 'd_rev1').shareWith, { B: 'edit', C: 'read' }, 'and her copy shows the owner’s again');
  });
  await test('Taking Cy off → every copy leaves his Scientia; his own notes stay', async () => {
    await env.memoryHub('C').push({ dev: 'web', name: 'Online', ops: [{ store: 'documents', id: 'd_cy', rec: { id: 'd_cy', title: 'Cy’s own' }, base: 1e15, prev: null }] });
    await push(env, 'A', [put('documents', Object.assign({}, rowOf(env, 'A', 'documents', 'd_rev1'), { shareWith: { B: 'edit' } }))]);
    for (const [s, id] of [['documents', 'd_rev1'], ['blocks', 'b_1'], ['blocks', 'b_bea'], ['media', 'm_pdf0001'], ['wires', 'w_1']]) assert.strictEqual(rowOf(env, 'C', s, id), null, s + '/' + id);
    assert.ok(rowOf(env, 'C', 'documents', 'd_cy'));
    assert.deepStrictEqual(env.idx.get('A__d__d_rev1').memberUids, ['B']);
  });
  await test('A grant to someone outside the lab is ignored, and does not make every edit a full pass', async () => {
    await push(env, 'A', [put('documents', Object.assign({}, rowOf(env, 'A', 'documents', 'd_rev1'), { shareWith: { B: 'edit', Z: 'read' } }))]);
    assert.ok(!env.hubs.has('Z') || !rowOf(env, 'Z', 'documents', 'd_rev1'));
    const r = await push(env, 'A', [put('documents', Object.assign({}, rowOf(env, 'A', 'documents', 'd_rev1'), { title: 'ERK waves, again' }))]);
    assert.strictEqual(r.passes.length, 0); assert.strictEqual(rowOf(env, 'B', 'documents', 'd_rev1').title, 'ERK waves, again');
  });
  await test('A file uploaded after its record reaches the members', async () => {
    const d = Object.assign({}, rowOf(env, 'A', 'documents', 'd_rev1')); d.blockIds = d.blockIds.concat(['b_img']);
    await push(env, 'A', [put('media', { id: 'm_img0001', kind: 'image', path: 'images/m_img0001.png' }), put('blocks', { id: 'b_img', docId: 'd_rev1', kind: 'figure', panels: [{ media: 'm_img0001' }] }), put('documents', d)]);
    assert.ok(rowOf(env, 'B', 'media', 'm_img0001'), 'the record went with its card');
    assert.ok(!env.files.get('B').has('images/m_img0001.png'));
    await env.hub('A').mediaCopy([{ path: 'images/m_img0001.png', url: 'https://files/A/m_img0001.png' }]);
    const r = await S.relayMedia(env, 'A', 'images/m_img0001.png');
    assert.strictEqual(r.copied, 1); assert.ok(env.files.get('B').has('images/m_img0001.png'));
  });
  await test('Unsharing everyone removes the index and every copy', async () => {
    const d = Object.assign({}, rowOf(env, 'A', 'documents', 'd_rev1')); delete d.shareWith;
    await push(env, 'A', [put('documents', d)]);
    assert.strictEqual(env.idx.size, 0); assert.strictEqual(rowOf(env, 'B', 'documents', 'd_rev1'), null); assert.strictEqual(rowOf(env, 'B', 'blocks', 'b_bea'), null);
    assert.ok(rowOf(env, 'A', 'blocks', 'b_bea'), 'the owner keeps what a collaborator added');
  });

  /* ---- a project ---- */
  const P = new S.MemoryShareEnv(MEMBERS);
  await push(P, 'A', [put('projects', { id: 'p_1', name: 'Mechanowaves' }), put('themes', { id: 't_1', projectId: 'p_1', name: 'Speed', status: 'active' }),
    put('aims', { id: 'a_1', themeId: 't_1', text: 'Measure it' }), put('terms', { id: 'tm_1', projectId: 'p_1', term: 'ERK' }),
    put('documents', { id: 'n_1', projectId: 'p_1', themeId: 't_1', title: 'Day 1', blockIds: ['nb_1'] }), put('blocks', { id: 'nb_1', docId: 'n_1', kind: 'component', body: { text: 'gel set' } }),
    put('documents', { id: 'n_2', projectId: 'p_1', title: 'Day 2', blockIds: [] }), put('documents', { id: 'n_3', projectId: 'p_other', title: 'Elsewhere', blockIds: [] })]);
  await test('Share a project to collaborate → its row, themes, aims, terms and notes, nothing else', async () => {
    await push(P, 'A', [put('projects', Object.assign({}, rowOf(P, 'A', 'projects', 'p_1'), { shareWith: { B: 'edit' } }))]);
    assert.strictEqual(rowOf(P, 'B', 'projects', 'p_1').sharedFrom.role, 'edit');
    for (const [s, id] of [['themes', 't_1'], ['aims', 'a_1'], ['terms', 'tm_1'], ['documents', 'n_1'], ['documents', 'n_2'], ['blocks', 'nb_1']]) assert.ok(rowOf(P, 'B', s, id), s + '/' + id);
    assert.strictEqual(rowOf(P, 'B', 'documents', 'n_3'), null);
    assert.ok(rowOf(P, 'B', 'themes', 't_1').sharedFrom && rowOf(P, 'B', 'documents', 'n_1').sharedFrom);
  });
  await test('Bea writes a new note in the shared project → it is filed in Alex’s project', async () => {
    await push(P, 'B', [put('documents', { id: 'n_bea', projectId: 'p_1', themeId: 't_1', title: 'Bea’s run', blockIds: [] })]);
    const d = rowOf(P, 'A', 'documents', 'n_bea'); assert.ok(d); assert.strictEqual(d.projectId, 'p_1'); assert.ok(!d.sharedFrom);
    assert.strictEqual(rowOf(P, 'B', 'documents', 'n_bea').sharedFrom.uid, 'A', 'and her copy is now a copy of the original');
  });
  await test('Alex moves a note out of the project → it leaves Bea’s Scientia', async () => {
    await push(P, 'A', [put('documents', Object.assign({}, rowOf(P, 'A', 'documents', 'n_2'), { projectId: 'p_other' }))]);
    assert.strictEqual(rowOf(P, 'B', 'documents', 'n_2'), null); assert.ok(rowOf(P, 'B', 'documents', 'n_1'));
  });
  await test('Alex adds a theme → Bea gets it', async () => {
    await push(P, 'A', [put('themes', { id: 't_2', projectId: 'p_1', name: 'Direction', status: 'active' })]);
    assert.ok(rowOf(P, 'B', 'themes', 't_2'));
  });

  /* ---- V3.921: a collaborator's side losing its copies never deletes the owner's originals ---- */
  await test('Bea’s hub loses the shared notes (her desktop replaced it) → Alex keeps them, Bea gets them back', async () => {
    const lost = ['n_1', 'nb_1'].map(id => ({ store: id.startsWith('nb') ? 'blocks' : 'documents', id, del: true, rec: null }));
    const r = await push(P, 'B', lost, 'desk');
    assert.ok(rowOf(P, 'A', 'documents', 'n_1'), 'Alex’s note stays'); assert.ok(rowOf(P, 'A', 'blocks', 'nb_1'), 'and its component');
    assert.ok(rowOf(P, 'B', 'documents', 'n_1'), 'Bea’s copy is back'); assert.ok(rowOf(P, 'B', 'blocks', 'nb_1'));
    assert.strictEqual(r.in, 0);
  });
  await test('Bea deletes the shared project itself → Alex keeps it; her copy comes back', async () => {
    await push(P, 'B', [{ store: 'projects', id: 'p_1', del: true, rec: null }], 'desk');
    assert.ok(rowOf(P, 'A', 'projects', 'p_1')); assert.ok(rowOf(P, 'B', 'projects', 'p_1'));
  });
  await test('…and the hourly pass does not delete them either when her copies vanish without a relay', async () => {
    const hb = P.memoryHub('B');
    await hb.push({ dev: 'desk', name: 'Desktop', ops: ['n_1', 'n_bea'].map(id => ({ store: 'documents', id, rec: null, del: true, prev: null, base: 1e15 })) });
    P.t += S.SHARES_MS + 1;
    await S.syncShares(P, 'A');
    assert.ok(rowOf(P, 'A', 'documents', 'n_1'), 'Alex’s own note stays');
    assert.ok(rowOf(P, 'B', 'documents', 'n_1'), 'and is back in Bea’s Scientia');
  });
  await test('Bea deletes a note she wrote herself → it leaves Alex’s project too', async () => {
    await push(P, 'B', [put('documents', { id: 'n_bea2', projectId: 'p_1', themeId: 't_1', title: 'Scratch', blockIds: [] })]);
    assert.ok(rowOf(P, 'A', 'documents', 'n_bea2'));
    await push(P, 'B', [{ store: 'documents', id: 'n_bea2', del: true, rec: null }]);
    assert.strictEqual(rowOf(P, 'A', 'documents', 'n_bea2'), null);
  });

  /* ---- the same RM project assigned to both ---- */
  const R = new S.MemoryShareEnv(MEMBERS);
  await push(R, 'B', [put('projects', { id: 'rm-p-9', name: 'Grant (Bea’s view)', rm: true }), put('documents', { id: 'n_beaown', projectId: 'rm-p-9', title: 'Bea’s own', blockIds: [] })]);
  await push(R, 'A', [put('projects', { id: 'rm-p-9', name: 'Grant', rm: true }), put('documents', { id: 'n_a', projectId: 'rm-p-9', title: 'Alex’s note', blockIds: [] })]);
  await test('A project Bea also has from RM → her project row stays hers; Alex’s notes appear in it', async () => {
    await push(R, 'A', [put('projects', Object.assign({}, rowOf(R, 'A', 'projects', 'rm-p-9'), { shareWith: { B: 'edit' } }))]);
    assert.strictEqual(rowOf(R, 'B', 'projects', 'rm-p-9').name, 'Grant (Bea’s view)'); assert.ok(!rowOf(R, 'B', 'projects', 'rm-p-9').sharedFrom);
    assert.ok(rowOf(R, 'B', 'documents', 'n_a').sharedFrom);
  });
  await test('…and her own notes in it stay hers (not sent to Alex)', async () => {
    await push(R, 'B', [put('documents', { id: 'n_beaown2', projectId: 'rm-p-9', title: 'Bea’s second', blockIds: [] })]);
    assert.strictEqual(rowOf(R, 'A', 'documents', 'n_beaown2'), null); assert.strictEqual(rowOf(R, 'A', 'documents', 'n_beaown'), null);
  });

  /* ---- the safety pass ---- */
  await test('A missed relay is made right by the pass (a collaborator’s change, the owner’s change)', async () => {
    const hb = R.memoryHub('B'), ha = R.memoryHub('A');
    await hb.push({ dev: 'desk', name: 'Desktop', ops: [{ store: 'documents', id: 'n_a', rec: Object.assign({}, rowOf(R, 'B', 'documents', 'n_a'), { title: 'Renamed offline' }), prev: null, base: 1e15 }] });
    await ha.push({ dev: 'desk', name: 'Desktop', ops: [{ store: 'documents', id: 'n_a2', rec: { id: 'n_a2', projectId: 'rm-p-9', title: 'Another', blockIds: [] }, prev: null, base: 1e15 }] });
    R.t += S.SHARES_MS + 1;
    const r = await S.syncShares(R, 'A');
    assert.strictEqual(r.passes, 1);
    assert.strictEqual(rowOf(R, 'A', 'documents', 'n_a').title, 'Renamed offline'); assert.ok(rowOf(R, 'B', 'documents', 'n_a2'));
  });
  await test('notes index: a shared copy is never listed under the member', () => {
    const projects = new Map([['p', { id: 'p', rm: true, rmId: 'x', name: 'P' }]]);
    assert.strictEqual(C.noteLink({ uid: 'B', doc: { id: 'd', projectId: 'p', sharedFrom: { uid: 'A' } }, projects: [projects.get('p')] }), null);
    assert.ok(C.noteLink({ uid: 'A', doc: { id: 'd', projectId: 'p' }, projects: [projects.get('p')] }));
  });

  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})();
