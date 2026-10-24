/* ================================================================
   scientia-share.emulator.js — V3.899 — the Share / Collaborate relay
   on real Firestore code paths (transactions, mergeFields, arrayUnion,
   getAll, the index queries), against the Firestore EMULATOR only.
   Not part of run-all (it needs the emulator):
     firebase emulators:start --only firestore --project demo-scientia   (port in FIRESTORE_EMULATOR_HOST)
     FIRESTORE_EMULATOR_HOST=127.0.0.1:8089 node functions/test/scientia-share.emulator.js
   ================================================================ */
'use strict';
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('set FIRESTORE_EMULATOR_HOST (this test never touches the real database)'); process.exit(2); }
process.env.GCLOUD_PROJECT = 'demo-scientia';
const assert = require('assert');
const admin = require('firebase-admin'); admin.initializeApp({ projectId: 'demo-scientia' });
const { getFirestore } = require('firebase-admin/firestore');
const { FirestoreHub, shareEnv } = require('../scientia-hub');
const SH = require('../scientia-share-core');

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('✓ ' + name); } catch (e) { failed++; console.error('✗ ' + name + '\n   ' + (e.stack || e).toString().split('\n').slice(0, 5).join('\n   ')); } }
const db = getFirestore();
async function push(uid, ops, dev) { const h = new FirestoreHub(uid); await h.push({ dev: dev || 'web', name: 'Online', ops: ops.map(o => Object.assign({ base: Number.MAX_SAFE_INTEGER, prev: null }, o)) }); return SH.relayPush(shareEnv(), uid, h.lastCommits); }
async function row(uid, store, id) { const s = await db.doc('userData/' + uid + '/scientia/hub/rows/' + store + '__' + encodeURIComponent(id)).get(); if (!s.exists) return null; const d = s.data(); return d.deleted ? null : JSON.parse(d.recJson); }
const put = (store, rec) => ({ store, id: rec.id, rec });

(async () => {
  const U = 'emuA' + Date.now().toString(36), B = 'emuB' + Date.now().toString(36);
  await db.doc('users/' + U).set({ role: 'member', name: 'Alex' }); await db.doc('users/' + B).set({ role: 'member', name: 'Bea' });
  await db.doc('userData/' + U + '/scientia/hub/media/' + encodeURIComponent('images/m_pdf0001.pdf')).set({ path: 'images/m_pdf0001.pdf', url: 'https://files/A/m_pdf0001.pdf' });
  await push(U, [put('documents', { id: 'd_r', type: 'literature', title: 'ERK', review: { topic: 'q', projectIds: [] }, blockIds: ['b_1', 'b_2'] }),
    put('blocks', { id: 'b_1', docId: 'd_r', body: { text: 'one' } }), put('blocks', { id: 'b_2', docId: 'd_r', kind: 'pdf', media: 'm_pdf0001' }), put('media', { id: 'm_pdf0001', path: 'images/m_pdf0001.pdf' })]);
  const id = SH.shareIdOf(U, 'review', 'd_r');
  await test('share to read: Bea’s hub gets the copy, its parts and the PDF’s link; the index exists', async () => {
    const r = await push(U, [put('documents', Object.assign(await row(U, 'documents', 'd_r'), { shareWith: { [B]: 'read' } }))]);
    assert.strictEqual(r.passes.length, 1, JSON.stringify(r));
    const d = await row(B, 'documents', 'd_r'); assert.ok(d && d.sharedFrom && d.sharedFrom.role === 'read', JSON.stringify(d));
    assert.ok(await row(B, 'blocks', 'b_2')); assert.ok(await row(B, 'media', 'm_pdf0001'));
    assert.strictEqual((await db.doc('userData/' + B + '/scientia/hub/media/' + encodeURIComponent('images/m_pdf0001.pdf')).get()).data().url, 'https://files/A/m_pdf0001.pdf');
    const ix = (await db.doc('scientiaShares/' + id).get()).data(); assert.deepStrictEqual(ix.memberUids, [B]); assert.strictEqual(ix.lockUntil, 0); assert.ok(ix.blockIds.includes('b_2'));
    assert.strictEqual((await db.collection('scientiaShares/' + id + '/shadow').get()).size, 4);
    const pulled = await new FirestoreHub(B).pull({ conn: 'x', since: 0, sid: (await new FirestoreHub(B).loadState()).sid });
    assert.ok(pulled.ops.some(o => o.store === 'documents' && o.name === 'Shared by Alex'), 'her devices pull it from “Shared by Alex”');
  });
  await test('Alex edits → Bea’s copy follows; a new component adds to the index (arrayUnion)', async () => {
    const d = await row(U, 'documents', 'd_r'); d.blockIds.push('b_3');
    await push(U, [put('blocks', Object.assign(await row(U, 'blocks', 'b_1'), { body: { text: 'two' } })), put('blocks', { id: 'b_3', docId: 'd_r', body: { text: 'three' } }), put('documents', d)]);
    assert.strictEqual((await row(B, 'blocks', 'b_1')).body.text, 'two'); assert.ok(await row(B, 'blocks', 'b_3'));
    assert.ok((await db.doc('scientiaShares/' + id).get()).data().blockIds.includes('b_3'));
  });
  await test('Bea (read) edits → put back', async () => {
    const r = await push(B, [put('blocks', Object.assign(await row(B, 'blocks', 'b_1'), { body: { text: 'nope' } }))]);
    assert.strictEqual(r.reverted, 1); assert.strictEqual((await row(B, 'blocks', 'b_1')).body.text, 'two'); assert.strictEqual((await row(U, 'blocks', 'b_1')).body.text, 'two');
  });
  await test('Collaborate: Bea edits → Alex’s original changes', async () => {
    await push(U, [put('documents', Object.assign(await row(U, 'documents', 'd_r'), { shareWith: { [B]: 'edit' } }))]);
    assert.strictEqual((await row(B, 'documents', 'd_r')).sharedFrom.role, 'edit');
    const r = await push(B, [put('blocks', Object.assign(await row(B, 'blocks', 'b_3'), { body: { text: 'Bea wrote this' } }))]);
    assert.strictEqual(r.in, 1); assert.strictEqual((await row(U, 'blocks', 'b_3')).body.text, 'Bea wrote this');
  });
  await test('the members route lists lab members, not the caller', async () => {
    const m = await new FirestoreHub(U).members(); assert.ok(m.members.some(x => x.uid === B && x.name === 'Bea')); assert.ok(!m.members.some(x => x.uid === U));
  });
  await test('unshare: Bea’s copies go, the index and shadows go; Alex keeps everything', async () => {
    const d = await row(U, 'documents', 'd_r'); delete d.shareWith;
    await push(U, [put('documents', d)]);
    assert.strictEqual(await row(B, 'documents', 'd_r'), null); assert.strictEqual(await row(B, 'blocks', 'b_3'), null);
    assert.ok(!(await db.doc('scientiaShares/' + id).get()).exists); assert.strictEqual((await db.collection('scientiaShares/' + id + '/shadow').get()).size, 0);
    assert.strictEqual((await row(U, 'blocks', 'b_3')).body.text, 'Bea wrote this');
  });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
