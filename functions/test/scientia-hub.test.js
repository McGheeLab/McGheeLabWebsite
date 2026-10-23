/* ================================================================
   scientia-hub.test.js — the cloud hub's merge + ops rules (V3.857)
   ================================================================
   Pure node fixtures over functions/scientia-hub-core.js: the port of
   Gabe's sisync.py. No Firestore, no network — run `node
   functions/test/scientia-hub.test.js` (scripts/tests/run-all.sh
   picks it up). Every scenario is one Gabe's desktop hub would
   produce the same answer for: two devices editing the same record,
   field merges, AUTO_MAX timestamps, list unions, the three conflict
   kinds and their resolution, resets, a whole-record replace, ops
   trimming, and the HTTP routes the untouched build calls.
   ================================================================ */
'use strict';
const assert = require('assert');
const C = require('../scientia-hub-core');

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.error('✗ ' + name + '\n   ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n   ')); } }

const dev = (hub, id, conn) => ({
  id, conn, seq: 0, shadow: new Map(),
  async load() { const s = await hub.state(); this.seq = s.syncSeq; this.sid = s.sid; this.shadow = new Map(); for (const [store, rows] of Object.entries(s.stores)) for (const r of rows) this.shadow.set(C.keyOf(store, r[C.rowKey(store)]), JSON.stringify(r)); },
  op(store, id, rec, del) { const k = C.keyOf(store, id), sh = this.shadow.get(k); return { store, id, rec: del ? null : rec, del: !!del, prev: sh ? JSON.parse(sh) : null, base: this.seq }; },
  async push(ops) { const r = await hub.push({ dev: this.id, conn: this.conn, name: this.id, ops }); for (const o of ops) { const k = C.keyOf(o.store, o.id); if (o.del) this.shadow.delete(k); else this.shadow.set(k, JSON.stringify(o.rec)); } for (const e of r.echo || []) this.shadow.set(C.keyOf(e.store, e.id), JSON.stringify(e.rec)); return r; },
  async pull() { const r = await hub.pull({ conn: this.conn, since: this.seq, sid: this.sid }); if (r.reset) return r; this.seq = r.seq; for (const o of r.ops) { const k = C.keyOf(o.store, o.id); if (o.del) this.shadow.delete(k); else this.shadow.set(k, JSON.stringify(o.rec)); } return r; },
});

(async () => {
  /* ---- merge3 ---- */
  await test('merge3: only mine changed a field', () => { const { merged, bad } = C.merge3({ a: 1, b: 2 }, { a: 9, b: 2 }, { a: 1, b: 2 }); assert.deepStrictEqual(merged, { a: 9, b: 2 }); assert.deepStrictEqual(bad, []); });
  await test('merge3: only theirs changed a field', () => { const { merged, bad } = C.merge3({ a: 1, b: 2 }, { a: 1, b: 2 }, { a: 1, b: 7 }); assert.deepStrictEqual(merged, { a: 1, b: 7 }); assert.deepStrictEqual(bad, []); });
  await test('merge3: both changed different fields', () => { const { merged, bad } = C.merge3({ a: 1, b: 2 }, { a: 9, b: 2 }, { a: 1, b: 7 }); assert.deepStrictEqual(merged, { a: 9, b: 7 }); assert.deepStrictEqual(bad, []); });
  await test('merge3: both changed the same field differently → bad', () => { const { merged, bad } = C.merge3({ a: 1 }, { a: 2 }, { a: 3 }); assert.deepStrictEqual(bad, ['a']); assert.strictEqual(merged.a, 3); });
  await test('merge3: both made the same change → fine', () => { const { bad } = C.merge3({ a: 1 }, { a: 2 }, { a: 2 }); assert.deepStrictEqual(bad, []); });
  await test('merge3: mine removed a key theirs kept', () => { const { merged } = C.merge3({ a: 1, b: 2 }, { b: 2 }, { a: 1, b: 2 }); assert.deepStrictEqual(merged, { b: 2 }); });
  await test('merge3: AUTO_MAX takes the later stamp', () => { const { merged, bad } = C.merge3({ modified: '2026-01-01' }, { modified: '2026-03-01' }, { modified: '2026-02-01' }); assert.strictEqual(merged.modified, '2026-03-01'); assert.deepStrictEqual(bad, []); });
  await test('merge3: scalar lists union, removals respected', () => { const { merged, bad } = C.merge3({ tags: ['a', 'b'] }, { tags: ['b', 'c'] }, { tags: ['a', 'b', 'd'] }); assert.deepStrictEqual(merged.tags, ['b', 'd', 'c']); assert.deepStrictEqual(bad, []); });
  await test('merge3: nested objects compare like Python dicts (key order)', () => { const { bad } = C.merge3({ body: { text: 'x', marks: [] } }, { body: { marks: [], text: 'x' } }, { body: { text: 'y', marks: [] } }); assert.deepStrictEqual(bad, []); });
  await test('merge3: nested object changed both ways → bad', () => { const { bad } = C.merge3({ body: { text: 'x' } }, { body: { text: 'y' } }, { body: { text: 'z' } }); assert.deepStrictEqual(bad, ['body']); });
  await test('merge3: prev not an object is treated as empty', () => { const { merged, bad } = C.merge3(null, { a: 1 }, { b: 2 }); assert.deepStrictEqual(merged, { b: 2, a: 1 }); assert.deepStrictEqual(bad, []); });

  /* ---- push / pull between two devices ---- */
  await test('push then pull: B sees A\'s create, A does not see its own', async () => {
    const hub = new C.MemoryHub(); const A = dev(hub, 'A', 'ka'), B = dev(hub, 'B', 'kb'); await A.load(); await B.load();
    const r = await A.push([A.op('documents', 'd1', { id: 'd1', title: 'Day one' })]);
    assert.strictEqual(r.ok, true); assert.strictEqual(r.seq, 1); assert.deepStrictEqual(r.echo, []);
    const pb = await B.pull(); assert.strictEqual(pb.ops.length, 1); assert.strictEqual(pb.ops[0].rec.title, 'Day one'); assert.strictEqual(pb.seq, 1);
    const pa = await A.pull(); assert.strictEqual(pa.ops.length, 0); assert.strictEqual(pa.seq, 1);
    assert.strictEqual(hub.st.records, 1);
  });
  await test('records count skips settings and profiles', async () => {
    const hub = new C.MemoryHub(); const A = dev(hub, 'A', 'ka'); await A.load();
    await A.push([A.op('settings', 'main', { id: 'main' }), A.op('profiles', 'note', { type: 'note' }), A.op('terms', 't1', { id: 't1' })]);
    assert.strictEqual(hub.st.records, 1); assert.strictEqual(hub.st.seq, 3);
  });
  await test('NOSYNC stores are ignored', async () => {
    const hub = new C.MemoryHub(); const A = dev(hub, 'A', 'ka'); await A.load();
    const r = await A.push([A.op('journal', '1', { seq: 1 }), A.op('blobs', 'x', { id: 'x' }), A.op('datasets', 'y', { id: 'y' })]);
    assert.strictEqual(r.seq, 0); assert.strictEqual(hub.ops.length, 0);
  });
  await test('a push identical to the current record is a no-op', async () => {
    const hub = new C.MemoryHub(); const A = dev(hub, 'A', 'ka'); await A.load();
    await A.push([A.op('documents', 'd1', { id: 'd1', title: 'x' })]); const r = await A.push([A.op('documents', 'd1', { title: 'x', id: 'd1' })]);
    assert.strictEqual(r.seq, 1);
  });
  await test('concurrent edits of different fields merge; the merged record echoes back', async () => {
    const hub = new C.MemoryHub(); const A = dev(hub, 'A', 'ka'), B = dev(hub, 'B', 'kb'); await A.load();
    await A.push([A.op('documents', 'd1', { id: 'd1', title: 'Day', synthesis: { text: '' } })]); await B.load(); await A.pull();
    await A.push([A.op('documents', 'd1', { id: 'd1', title: 'Day one', synthesis: { text: '' } })]);
    const r = await B.push([B.op('documents', 'd1', { id: 'd1', title: 'Day', synthesis: { text: 'it worked' } })]);
    assert.strictEqual(r.conflicts, 0); assert.strictEqual(r.echo.length, 1); assert.deepStrictEqual(r.echo[0].rec, { id: 'd1', title: 'Day one', synthesis: { text: 'it worked' } });
    assert.deepStrictEqual(hub.rows.get(C.keyOf('documents', 'd1')).rec, { id: 'd1', title: 'Day one', synthesis: { text: 'it worked' } });
    const pa = await A.pull(); assert.strictEqual(pa.ops.length, 1); assert.strictEqual(pa.ops[0].rec.synthesis.text, 'it worked');
  });
  await test('concurrent edits of the same field → a fields conflict, other fields still merge', async () => {
    const hub = new C.MemoryHub(); const A = dev(hub, 'A', 'ka'), B = dev(hub, 'B', 'kb'); await A.load();
    await A.push([A.op('blocks', 'b1', { id: 'b1', label: 'L', body: { text: 'one' } })]); await B.load(); await A.pull();
    await A.push([A.op('blocks', 'b1', { id: 'b1', label: 'L', body: { text: 'two' } })]);
    const r = await B.push([B.op('blocks', 'b1', { id: 'b1', label: 'Mine', body: { text: 'three' } })]);
    assert.strictEqual(r.conflicts, 1);
    const c = hub.st.conflicts[0]; assert.strictEqual(c.type, 'fields'); assert.deepStrictEqual(c.fields, ['body']); assert.strictEqual(c.theirsName, 'A'); assert.strictEqual(c.mineName, 'B');
    assert.deepStrictEqual(hub.rows.get(C.keyOf('blocks', 'b1')).rec, { id: 'b1', label: 'Mine', body: { text: 'two' } });
    assert.strictEqual(r.echo.length, 1); assert.strictEqual(r.echo[0].rec.body.text, 'two');
  });
  await test('resolve "mine" applies the losing side\'s fields; "theirs" just closes it; twice → already decided', async () => {
    const hub = new C.MemoryHub(); const A = dev(hub, 'A', 'ka'), B = dev(hub, 'B', 'kb'); await A.load();
    await A.push([A.op('blocks', 'b1', { id: 'b1', body: { text: 'one' } })]); await B.load(); await A.pull();
    await A.push([A.op('blocks', 'b1', { id: 'b1', body: { text: 'two' } })]);
    await B.push([B.op('blocks', 'b1', { id: 'b1', body: { text: 'three' } })]);
    const cid = hub.st.conflicts[0].cid;
    const r = await hub.resolve({ cid, pick: 'mine', dev: 'B', name: 'B' }); assert.strictEqual(r.ok, true); assert.strictEqual(r.conflicts, 0);
    assert.strictEqual(hub.rows.get(C.keyOf('blocks', 'b1')).rec.body.text, 'three');
    const again = await hub.resolve({ cid, pick: 'mine', dev: 'B', name: 'B' }); assert.strictEqual(again.ok, false);
    // theirs
    await A.pull(); await A.push([A.op('blocks', 'b1', { id: 'b1', body: { text: 'four' } })]);
    await B.push([B.op('blocks', 'b1', { id: 'b1', body: { text: 'five' } })]);
    const cid2 = hub.st.conflicts[0].cid; const seqBefore = hub.st.seq;
    await hub.resolve({ cid: cid2, pick: 'theirs', dev: 'B', name: 'B' });
    assert.strictEqual(hub.st.conflicts.length, 0); assert.strictEqual(hub.st.seq, seqBefore); assert.strictEqual(hub.rows.get(C.keyOf('blocks', 'b1')).rec.body.text, 'four');
  });
  await test('delete after someone changed it → "delete" conflict; resolve mine deletes', async () => {
    const hub = new C.MemoryHub(); const A = dev(hub, 'A', 'ka'), B = dev(hub, 'B', 'kb'); await A.load();
    await A.push([A.op('terms', 't1', { id: 't1', label: 'gel' })]); await B.load(); await A.pull();
    await A.push([A.op('terms', 't1', { id: 't1', label: 'hydrogel' })]);
    const r = await B.push([B.op('terms', 't1', null, true)]);
    assert.strictEqual(r.conflicts, 1); assert.strictEqual(hub.st.conflicts[0].type, 'delete'); assert.strictEqual(hub.rows.get(C.keyOf('terms', 't1')).rec.label, 'hydrogel');
    await hub.resolve({ cid: hub.st.conflicts[0].cid, pick: 'mine', dev: 'B', name: 'B' });
    assert.strictEqual(hub.rows.get(C.keyOf('terms', 't1')).rec, null); assert.strictEqual(hub.st.records, 0);
  });
  await test('change after someone deleted it → "deleted" conflict; resolve mine restores', async () => {
    const hub = new C.MemoryHub(); const A = dev(hub, 'A', 'ka'), B = dev(hub, 'B', 'kb'); await A.load();
    await A.push([A.op('terms', 't1', { id: 't1', label: 'gel' })]); await B.load(); await A.pull();
    await A.push([A.op('terms', 't1', null, true)]);
    const r = await B.push([B.op('terms', 't1', { id: 't1', label: 'hydrogel' })]);
    assert.strictEqual(r.conflicts, 1); assert.strictEqual(hub.st.conflicts[0].type, 'deleted');
    await hub.resolve({ cid: hub.st.conflicts[0].cid, pick: 'mine', dev: 'B', name: 'B' });
    assert.strictEqual(hub.rows.get(C.keyOf('terms', 't1')).rec.label, 'hydrogel'); assert.strictEqual(hub.st.records, 1);
  });
  await test('a delete by the same device that last changed it is not a conflict', async () => {
    const hub = new C.MemoryHub(); const A = dev(hub, 'A', 'ka'); await A.load();
    await A.push([A.op('terms', 't1', { id: 't1' })]); A.seq = 0; // stale base, but the only other change is ours
    const r = await A.push([A.op('terms', 't1', null, true)]); assert.strictEqual(r.conflicts, 0); assert.strictEqual(hub.rows.get(C.keyOf('terms', 't1')).rec, null);
  });
  await test('a stale base below minSeq with a different prev counts as "others changed it"', async () => {
    const hub = new C.MemoryHub(); const A = dev(hub, 'A', 'ka'); await A.load();
    await A.push([A.op('terms', 't1', { id: 't1', label: 'a' })]);
    hub.st.minSeq = 5; hub.st.seq = 5;
    const r = await hub.push({ dev: 'B', conn: 'kb', name: 'B', ops: [{ store: 'terms', id: 't1', rec: { id: 't1', label: 'b' }, del: false, prev: { id: 't1', label: 'z' }, base: 1 }] });
    assert.strictEqual(r.conflicts, 1);
  });

  /* ---- resets, trimming, replace, export ---- */
  await test('pull with another sid, or since below minSeq, → reset', async () => {
    const hub = new C.MemoryHub(); const A = dev(hub, 'A', 'ka'); await A.load();
    assert.strictEqual((await hub.pull({ conn: 'x', since: 0, sid: 'nope' })).reset, true);
    hub.st.minSeq = 10; assert.strictEqual((await hub.pull({ conn: 'x', since: 3, sid: hub.st.sid })).reset, true);
    assert.strictEqual((await hub.pull({ conn: 'x', since: 10, sid: hub.st.sid })).reset, undefined);
  });
  await test('minSeq follows seq − MAX_OPS; pull caps at PULL_MAX with more:true', async () => {
    const st = Object.assign(C.emptyState(), { seq: 60000, minSeq: 0 });
    const plan = C.planPush({ state: st, rows: new Map(), dev: 'A', conn: 'k', name: 'A', ops: [{ store: 'terms', id: 'x', rec: { id: 'x' }, base: 60000, prev: null }] });
    assert.strictEqual(plan.state.minSeq, 60001 - C.MAX_OPS);
    const ops = []; for (let i = 1; i <= C.PULL_MAX; i++) ops.push({ seq: i, store: 'terms', id: 'i' + i, rec: { id: 'i' + i }, del: false, conn: 'other' });
    const r = C.pullResult({ state: Object.assign(C.emptyState(), { sid: 's', seq: 5000, minSeq: 0 }), ops, since: 0, sid: 's', conn: 'me' });
    assert.strictEqual(r.more, true); assert.strictEqual(r.seq, C.PULL_MAX); assert.strictEqual(r.ops.length, C.PULL_MAX);
  });
  await test('replace: new sid, NOSYNC stripped, profiles keyed by type, counts verified by the export', async () => {
    const hub = new C.MemoryHub(); const sid0 = hub.st.sid;
    const r = await hub.replace({ app: 'Scientia In Situ', format: 2, epoch: 1, build: 'b1', stores: { documents: [{ id: 'd1' }, { id: 'd2' }], profiles: [{ type: 'note' }], settings: [{ id: 'main' }], journal: [{ seq: 1 }], blobs: [{ id: 'x' }], terms: [{ id: 't' }, { nope: 1 }] }, counts: { documents: 2 } });
    assert.strictEqual(r.ok, true); assert.notStrictEqual(hub.st.sid, sid0); assert.strictEqual(r.meta.records, 3); assert.strictEqual(hub.st.seq, 1); assert.strictEqual(hub.st.minSeq, 1);
    const s = await hub.state(); assert.deepStrictEqual(s.counts, { documents: 2, profiles: 1, settings: 1, terms: 1 }); assert.strictEqual(s.stores.journal, undefined); assert.strictEqual(s.sid, hub.st.sid); assert.strictEqual(s.epoch, 1); assert.strictEqual(s.build, 'b1'); assert.strictEqual(s.syncSeq, 1);
    assert.strictEqual(hub.ops.length, 0);
    const A = dev(hub, 'A', 'ka'); await A.load(); assert.strictEqual(A.shadow.size, 5);
    assert.throws(() => C.planReplace({ state: hub.st, obj: { nope: 1 } }), /not a Scientia export/);
  });
  await test('export excludes tombstones and reports the live rows', async () => {
    const hub = new C.MemoryHub(); const A = dev(hub, 'A', 'ka'); await A.load();
    await A.push([A.op('terms', 't1', { id: 't1' }), A.op('terms', 't2', { id: 't2' })]); await A.push([A.op('terms', 't1', null, true)]);
    const s = await hub.state(); assert.deepStrictEqual(s.counts, { terms: 1 }); assert.strictEqual(s.stores.terms[0].id, 't2');
  });

  /* ---- routes ---- */
  const call = (hub, who, method, path, { query, body, rawBody } = {}) => C.route({ method, path, query: query || {}, body, rawBody: rawBody || null, headers: {} }, { hub, who });
  const web = { uid: 'u1', id: 'web', name: 'Online', kind: 'browser' }, key = { uid: 'u1', id: 'k1', name: 'Gabe PC', kind: 'key' };
  await test('route: hello answers signed out and signed in; everything else needs a caller', async () => {
    const hub = new C.MemoryHub();
    const out = await call(hub, null, 'GET', '/api/sync/hello'); assert.strictEqual(out.status, 200); assert.strictEqual(out.body.auth, false); assert.strictEqual(out.body.local, false);
    const inn = await call(hub, web, 'GET', '/api/sync/hello'); assert.strictEqual(inn.body.auth, true); assert.strictEqual(inn.body.notebook, true); assert.strictEqual(inn.body.records, 0); assert.strictEqual(inn.body.device, 'Online');
    assert.strictEqual((await call(hub, null, 'GET', '/api/sync/state')).status, 401);
  });
  await test('route: push with a stale sid → reset; anySid goes through', async () => {
    const hub = new C.MemoryHub();
    const r = await call(hub, web, 'POST', '/api/sync/push', { body: { sid: 'old', dev: 'd', conn: 'c', name: 'n', ops: [] } }); assert.strictEqual(r.body.reset, true); assert.strictEqual(r.body.sid, hub.st.sid);
    const r2 = await call(hub, web, 'POST', '/api/sync/push', { body: { sid: 'old', anySid: true, dev: 'd', conn: 'c', name: 'n', ops: [{ store: 'terms', id: 't', rec: { id: 't' }, base: 0, prev: null }] } }); assert.strictEqual(r2.body.ok, true); assert.strictEqual(r2.body.seq, 1);
    const raw = await call(hub, web, 'POST', '/api/sync/push', { rawBody: Buffer.from(JSON.stringify({ sid: hub.st.sid, dev: 'd', conn: 'c', name: 'n', ops: [{ store: 'terms', id: 'u', rec: { id: 'u' }, base: 1, prev: null }] })) }); assert.strictEqual(raw.body.seq, 2);
  });
  await test('route: snapshot GET is 404 until there is a record, then the export; POST replaces; keep= keeps', async () => {
    const hub = new C.MemoryHub();
    assert.strictEqual((await call(hub, web, 'GET', '/api/snapshot')).status, 404);
    const bad = await call(hub, web, 'POST', '/api/snapshot', { body: { hello: 1 } }); assert.strictEqual(bad.status, 400);
    const rep = await call(hub, web, 'POST', '/api/snapshot', { body: { stores: { documents: [{ id: 'd1' }] }, counts: { documents: 1 } } }); assert.strictEqual(rep.body.ok, true); assert.strictEqual(rep.body.meta.records, 1);
    const got = await call(hub, web, 'GET', '/api/snapshot'); assert.strictEqual(got.status, 200); assert.strictEqual(got.body.counts.documents, 1);
    const kept = await call(hub, web, 'POST', '/api/snapshot', { query: { keep: 'browser-before-load' }, body: { stores: {} } }); assert.strictEqual(kept.body.ok, true); assert.strictEqual(hub.kept.length, 1); assert.strictEqual(hub.st.records, 1);
    const st = await call(hub, web, 'GET', '/api/sync/state'); assert.strictEqual(st.body.stores.documents.length, 1);
  });
  await test('route: media upload + list, recordings dedupe their names, size and name checks', async () => {
    const hub = new C.MemoryHub();
    const up = await call(hub, web, 'POST', '/api/media', { query: { id: 'm_abc', ext: 'png' }, rawBody: Buffer.from('png') }); assert.strictEqual(up.body.ok, true); assert.strictEqual(up.body.path, 'images/m_abc.png');
    assert.strictEqual((await call(hub, web, 'POST', '/api/media', { query: { id: '../x', ext: 'png' }, rawBody: Buffer.from('x') })).status, 400);
    assert.strictEqual((await call(hub, web, 'POST', '/api/media', { query: { id: 'm1', ext: 'exe' }, rawBody: Buffer.from('x') })).status, 400);
    assert.strictEqual((await call(hub, web, 'POST', '/api/media', { query: { id: 'm1', ext: 'png' }, rawBody: Buffer.alloc(0) })).status, 400);
    const r1 = await call(hub, key, 'POST', '/api/rec', { query: { name: 'Lab meeting', ext: 'webm' }, rawBody: Buffer.from('a') }); assert.strictEqual(r1.body.file, 'Lab meeting.webm');
    const r2 = await call(hub, key, 'POST', '/api/rec', { query: { name: 'Lab meeting', ext: 'webm' }, rawBody: Buffer.from('b') }); assert.strictEqual(r2.body.file, 'Lab meeting (2).webm'); assert.strictEqual(r2.body.path, 'recordings/Lab meeting (2).webm');
    const list = await call(hub, web, 'GET', '/api/media/list'); assert.deepStrictEqual(Object.keys(list.body.files).sort(), ['images/m_abc.png', 'recordings/Lab meeting (2).webm', 'recordings/Lab meeting.webm']);
    assert.strictEqual((await call(hub, web, 'GET', '/api/rec/status', { query: { file: 'x' } })).body.state, 'none');
  });
  await test('route: desktop keys — browser makes, lists, removes; a key caller cannot; the secret resolves once stored', async () => {
    const hub = new C.MemoryHub();
    const mk = await call(hub, web, 'POST', '/api/cloud/key', { body: { name: 'Office PC' } }); assert.strictEqual(mk.body.ok, true); assert.ok(/^sck_u1_[0-9a-f]{32}$/.test(mk.body.key));
    const secret = mk.body.key.split('_')[2]; const found = await hub.keyFind(secret); assert.strictEqual(found.id, mk.body.id); assert.strictEqual(found.name, 'Office PC');
    assert.strictEqual((await call(hub, web, 'GET', '/api/cloud/keys')).body.keys.length, 1);
    assert.strictEqual((await call(hub, key, 'GET', '/api/cloud/keys')).status, 403);
    assert.strictEqual((await call(hub, web, 'POST', '/api/cloud/key/remove', { body: { id: mk.body.id } })).body.ok, true);
    assert.strictEqual(await hub.keyFind(secret), null);
  });
  await test('route: the desktop-only endpoints answer like a computer without them', async () => {
    const hub = new C.MemoryHub();
    assert.deepStrictEqual((await call(hub, web, 'GET', '/api/net')).body.lan, []);
    assert.deepStrictEqual((await call(hub, web, 'GET', '/api/devices')).body.devices, []);
    assert.strictEqual((await call(hub, web, 'POST', '/api/pair/new')).body.ok, false);
    assert.strictEqual((await call(hub, web, 'POST', '/api/ink/read', { body: { strokes: [] } })).body.ok, false);
    assert.strictEqual((await call(hub, web, 'GET', '/api/ping')).body.ok, true);
    assert.strictEqual((await call(hub, web, 'GET', '/api/notebook')).body.path, 'cloud');
    assert.strictEqual((await call(hub, web, 'GET', '/api/nope')).status, 404);
  });

  /* ---- V3.869: the RM library mirror ---- */
  const rmItem = (id, extra) => Object.assign({ id, type: 'paper', title: 'Paper ' + id, created_at: '2026-10-01', updated_at: '2026-10-20',
    meta: { library: Object.assign({ is_library_entry: true, doi: '10.1000/' + id, authors: [{ family: 'Smith', given: 'A' }, { family: 'Lee', given: 'B' }], year: '2024', journal: 'Soft Matter', volume: '20', issue: '3', pages: '100-110', url: '', date_added: '2026-10-02', pdf: null }, extra || {}) } });
  await test('rmItemToLibraryRow: RM item → Scientia library row (id = the RM id, CSL built, pdf flag)', () => {
    const r = C.rmItemToLibraryRow(rmItem('p1', { pdf: { storage_path: 'papers/p1.pdf', hash: 'h' } }));
    assert.strictEqual(r.id, 'p1'); assert.strictEqual(r.rmId, 'p1'); assert.strictEqual(r.rm, true); assert.strictEqual(r.kind, 'paper');
    assert.strictEqual(r.doi, '10.1000/p1'); assert.strictEqual(r.title, 'Paper p1'); assert.strictEqual(r.container, 'Soft Matter'); assert.strictEqual(r.year, 2024);
    assert.deepStrictEqual(r.authors, [{ family: 'Smith', given: 'A' }, { family: 'Lee', given: 'B' }]);
    assert.strictEqual(r.url, 'https://doi.org/10.1000/p1'); assert.strictEqual(r.cslType, 'article-journal'); assert.strictEqual(r.isPreprint, false);
    assert.strictEqual(r.csl.DOI, '10.1000/p1'); assert.deepStrictEqual(r.csl.issued, { 'date-parts': [[2024]] }); assert.strictEqual(r.csl['container-title'], 'Soft Matter'); assert.strictEqual(r.csl.page, '100-110');
    assert.strictEqual(r.rmPdf, true); assert.strictEqual(r.added, '2026-10-02'); assert.strictEqual(r.rmUpdated, '2026-10-20');
    const pre = C.rmItemToLibraryRow(rmItem('p2', { journal: '', authors: ['Solo Author'] }));
    assert.strictEqual(pre.cslType, 'posted-content'); assert.strictEqual(pre.isPreprint, true); assert.deepStrictEqual(pre.authors, [{ family: 'Solo Author', given: '' }]); assert.strictEqual(pre.rmPdf, false);
  });
  await test('planMirror: new papers are added, unchanged ones skipped, changed ones updated, gone ones tombstoned; desktop fields survive', () => {
    const st = { seq: 7 };
    const rows = new Map();
    const cur = Object.assign(C.rmItemToLibraryRow(rmItem('p1')), { pdf: 'm-desktop', note: 'mine' });  // mirrored earlier, pdf attached on the desktop
    rows.set(C.keyOf('library', 'p1'), { store: 'library', id: 'p1', rec: cur });
    rows.set(C.keyOf('library', 'gone'), { store: 'library', id: 'gone', rec: C.rmItemToLibraryRow(rmItem('gone')) });
    rows.set(C.keyOf('library', 'l-local'), { store: 'library', id: 'l-local', rec: { id: 'l-local', title: 'Desktop-only paper' } });
    const plan = C.planMirror({ state: st, rows, items: [rmItem('p1'), rmItem('p3', { pdf: { storage_path: 'papers/p3.pdf' } })] });
    assert.strictEqual(plan.total, 2);
    assert.deepStrictEqual(plan.ops.map(o => [o.id, o.del]), [['p3', false], ['gone', true]]);
    const p3 = plan.ops[0]; assert.strictEqual(p3.base, 7); assert.strictEqual(p3.prev, null); assert.strictEqual(p3.rec.pdf, 'rm:p3'); assert.strictEqual(p3.rec.rmPdf, true);
    assert.strictEqual(plan.ops[1].prev.id, 'gone'); assert.strictEqual(plan.changed, 1); assert.strictEqual(plan.removed, 1);
    // p1 changed in RM (new year) → updated, keeping the desktop's pdf and the note
    const plan2 = C.planMirror({ state: st, rows, items: [rmItem('p1', { year: '2025' })] });
    const up = plan2.ops.find(o => o.id === 'p1'); assert.ok(up); assert.strictEqual(up.rec.year, 2025); assert.strictEqual(up.rec.pdf, 'm-desktop'); assert.strictEqual(up.rec.note, 'mine'); assert.strictEqual(up.prev.year, 2024);
    // the local (non-RM) row is never touched
    assert.ok(!plan2.ops.find(o => o.id === 'l-local'));
  });
  await test('mirror on the hub: hello mirrors (throttled), refresh forces, devices receive the rows through pull, RM is a device named RM library', async () => {
    const hub = new C.MemoryHub(); hub.rmItems = [rmItem('p1'), rmItem('p2', { pdf: { storage_path: 'papers/p2.pdf' } })];
    const web = { id: 'u1', kind: 'browser', name: 'Alex' };
    const h1 = await call(hub, web, 'GET', '/api/sync/hello');
    assert.strictEqual(h1.body.records, 2); assert.strictEqual(hub.mirrorRuns, 1);
    await call(hub, web, 'GET', '/api/sync/hello');
    assert.strictEqual(hub.mirrorRuns, 1, 'a second hello within 5 minutes does not re-read RM');
    const st = await hub.state('state');
    assert.deepStrictEqual(st.stores.library.map(r => r.id).sort(), ['p1', 'p2']);
    assert.strictEqual(st.stores.library.find(r => r.id === 'p2').pdf, 'rm:p2');
    const d = dev(hub, 'desktop', 'c1'); await d.load();
    hub.rmItems = [Object.assign(rmItem('p1'), { title: 'Paper p1 (revised)' })];
    const r = await call(hub, web, 'POST', '/api/rm/library/refresh', {});
    assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.total, 1); assert.strictEqual(r.body.changed, 1); assert.strictEqual(r.body.removed, 1);
    const pulled = await d.pull();
    assert.deepStrictEqual(pulled.ops.map(o => [o.store, o.id, o.del, o.name]), [['library', 'p1', false, 'RM library'], ['library', 'p2', true, 'RM library']]);
    assert.deepStrictEqual(hub.ops.slice(-2).map(o => o.dev), ['rm', 'rm'], 'the hub records RM as the device');
    assert.strictEqual(pulled.ops[0].rec.title, 'Paper p1 (revised)');
    assert.strictEqual((await call(hub, web, 'GET', '/api/rm/library/pdf?id=p1')).status, 404, 'the in-memory hub has no Storage');
  });
  await test('mirror: a hub whose devices never see RM (no mirrorLibrary) still answers hello and refresh', async () => {
    const hub = new C.MemoryHub(); hub.mirrorLibrary = undefined;
    const web = { id: 'u1', kind: 'browser', name: 'Alex' };
    assert.strictEqual((await call(hub, web, 'GET', '/api/sync/hello')).body.ok, true);
    assert.strictEqual((await call(hub, web, 'POST', '/api/rm/library/refresh', {})).body.ok, false);
  });

  /* ---- V3.870: RM inventory for Scientia's materials ---- */
  const inv = (id, extra) => Object.assign({ id, kind: 'item', name: 'Thing ' + id, description: '', category: 'consumable', subcategory: 'tubes', vendor: 'Alkali Scientific (ASi)',
    catalogue_number: 'C' + id, quantity: 3, stock_status: 'full', condition: 'active', is_consumable: true, locations: [], updatedAt: '2026-04-30T20:27:11.435Z' }, extra || {});
  await test('rmInventoryRow: a compact row from an RM inventory doc (chemicals, locations as a list or a map)', () => {
    const r = C.rmInventoryRow(inv('tubes', { locations: [{ name: 'Fridge 2' }, 'Bench'], use_mode: 'package' }));
    assert.deepStrictEqual([r.id, r.kind, r.name, r.vendor, r.catalogue_number, r.quantity, r.stock_status, r.use_mode, r.locations], ['tubes', 'item', 'Thing tubes', 'Alkali Scientific (ASi)', 'Ctubes', 3, 'full', 'package', ['Fridge 2', 'Bench']]);
    const c = C.rmInventoryRow(inv('pbs', { kind: 'chemical', is_chemical: true, locations: { 'Shelf A': 2 }, quantity: '7' }));
    assert.strictEqual(c.kind, 'chemical'); assert.deepStrictEqual(c.locations, ['Shelf A']); assert.strictEqual(c.quantity, 7);
    assert.strictEqual(C.rmInventoryRow({ id: 'x' }).name, 'x');
  });
  await test('searchInventory: every word must match (name, vendor, catalogue, category); name-prefix first; limit', () => {
    const rows = [inv('a', { name: 'Matrigel Matrix', vendor: 'Corning', category: 'reagent', subcategory: '' }), inv('b', { name: 'Microcentrifuge Tubes 1.7 mL' }), inv('c', { name: 'Tube rack', vendor: 'Fisher' }), inv('d', { name: 'Conical Centrifuge Tubes 50 mL', updatedAt: '2026-05-01' })].map(C.rmInventoryRow);
    assert.deepStrictEqual(C.searchInventory(rows, 'tubes').items.map(r => r.id), ['d', 'b', 'c']);   // 'Tube rack' matches through its subcategory "tubes"; newest first among equals
    assert.deepStrictEqual(C.searchInventory(rows, 'tubes alkali').items.map(r => r.id), ['d', 'b']);
    assert.deepStrictEqual(C.searchInventory(rows, 'matrigel corning').items.map(r => r.id), ['a']);
    assert.strictEqual(C.searchInventory(rows, 'c', 2).items.length, 2); assert.strictEqual(C.searchInventory(rows, '').total, 4);
    assert.strictEqual(C.searchInventory(rows, 'nothing here').total, 0);
  });
  await test('api/rm/inventory on the hub: q, limit, ids; a hub without an inventory answers ok:false', async () => {
    const hub = new C.MemoryHub(); hub.rmInventory = [inv('tubes'), inv('pbs', { kind: 'chemical', name: 'PBS 10x' }), inv('tips', { name: 'Pipette tips' })];
    const web = { id: 'u1', kind: 'browser', name: 'Alex' };
    const r = await call(hub, web, 'GET', '/api/rm/inventory', { query: { q: 'pbs' } });
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.items.map(x => x.id), ['pbs']); assert.strictEqual(r.body.items[0].kind, 'chemical');
    assert.strictEqual((await call(hub, web, 'GET', '/api/rm/inventory', { query: { limit: '2' } })).body.items.length, 2);
    assert.deepStrictEqual((await call(hub, web, 'GET', '/api/rm/inventory', { query: { ids: 'tips,tubes' } })).body.items.map(x => x.id).sort(), ['tips', 'tubes']);
    const bare = new C.MemoryHub(); bare.inventory = undefined;
    assert.strictEqual((await call(bare, web, 'GET', '/api/rm/inventory')).body.ok, false);
  });

  /* ---- V3.872: RM tasks for Scientia's task components ---- */
  const taskBlock = (id, docId, text, extra) => Object.assign({ id, docId, kind: 'task', status: 'live', body: { text, marks: [] }, task: { due: null, allDay: false, prio: 'normal', repeat: 'none', subs: [], done: null, log: [] }, modified: '2026-10-23T10:00:00' }, extra || {});
  await test('rmTaskFromBlock: the document TASK_ASSIGN.writeTaskFor would write (bucket assigned, due_date, priority → importance, source scientia)', () => {
    const t = C.rmTaskFromBlock({ uid: 'u1', name: 'Alex', b: { blockId: 'b1', docId: 'd1', text: 'Order coverslips\nmore', due: '2026-10-30T09:00', prio: 'high', docTitle: 'Plan', projectName: 'GELS' }, now: Date.parse('2026-10-23T10:00:00Z') });
    assert.ok(/^task-[a-z0-9]+-[a-z0-9]{4}$/.test(t.id), t.id);
    assert.deepStrictEqual([t.text, t.bucket, t.status, t.done, t.due_date, t.priority, t.self_importance, t.assignedToUid, t.assignedToName, t.source], ['Order coverslips', 'assigned', 'pending', false, '2026-10-30', 'high', 2, 'u1', 'Alex', 'scientia']);
    assert.deepStrictEqual(t.source_ref, { scientia: { docId: 'd1', blockId: 'b1' }, docTitle: 'Plan', projectName: 'GELS' });
    assert.strictEqual(C.rmTaskFromBlock({ uid: 'u1', b: { blockId: 'b2' } }).due_date, 'TBD');
    assert.strictEqual(C.rmTaskFromBlock({ uid: 'u1', b: { blockId: 'b2', text: '' } }).text, 'Untitled task');
    const p = C.rmTaskPatch({ text: 'New', due: null, prio: 'low', done: true, doneAt: '2026-10-24T08:00:00' }, Date.now());
    assert.deepStrictEqual([p.text, p.due_date, p.priority, p.self_importance, p.done, p.done_at], ['New', 'TBD', 'low', -1, true, '2026-10-24T08:00:00']);
  });
  await test('planTaskSync: done flows both ways, the later change wins; a removed block dismisses the RM task; a gone task is unpaired', () => {
    const st = { seq: 3 }, now = Date.parse('2026-10-23T12:00:00Z');
    const row = b => ({ store: 'blocks', id: b.id, rec: b });
    // 1. done in Scientia (later) → RM gets done
    let plan = C.planTaskSync({ state: st, now, pairs: [{ taskId: 'ta', blockId: 'b1', row: row(taskBlock('b1', 'd1', 'A', { task: { done: '2026-10-23T11:30:00', log: [] } })), task: { id: 'ta', done: false, updated_at: '2026-10-23T10:00:00' } }] });
    assert.deepStrictEqual(plan.patches.map(x => [x.id, x.patch.done, x.patch.done_at]), [['ta', true, '2026-10-23T11:30:00']]); assert.strictEqual(plan.ops.length, 0);
    // 2. done in RM (later) → the block gets done (and a log entry via rm)
    plan = C.planTaskSync({ state: st, now, pairs: [{ taskId: 'tb', blockId: 'b2', row: row(taskBlock('b2', 'd1', 'B')), task: { id: 'tb', done: true, done_at: '2026-10-23T11:45:00' } }] });
    assert.strictEqual(plan.patches.length, 0); assert.strictEqual(plan.ops.length, 1);
    const op = plan.ops[0]; assert.strictEqual(op.store, 'blocks'); assert.strictEqual(op.id, 'b2'); assert.strictEqual(op.base, 3); assert.strictEqual(op.prev.task.done, null);
    assert.strictEqual(op.rec.task.done, '2026-10-23T11:45:00'); assert.strictEqual(op.rec.task.log.slice(-1)[0].via, 'rm'); assert.strictEqual(op.rec.body.text, 'B');
    // 3. reopened in RM after the block was done earlier → the block reopens
    plan = C.planTaskSync({ state: st, now, pairs: [{ taskId: 'tc', blockId: 'b3', row: row(taskBlock('b3', 'd1', 'C', { task: { done: '2026-10-22T09:00:00', log: [] } })), task: { id: 'tc', done: false, updated_at: '2026-10-23T09:00:00' } }] });
    assert.strictEqual(plan.ops.length, 1); assert.strictEqual(plan.ops[0].rec.task.done, null);
    // 4. agreement → nothing; a removed block → dismissed + unpaired; a gone task → unpaired
    plan = C.planTaskSync({ state: st, now, pairs: [
      { taskId: 'td', blockId: 'b4', row: row(taskBlock('b4', 'd1', 'D')), task: { id: 'td', done: false } },
      { taskId: 'te', blockId: 'b5', row: row(taskBlock('b5', 'd1', 'E', { status: 'removed' })), task: { id: 'te', done: false } },
      { taskId: 'tf', blockId: 'b6', row: undefined, task: null }] });
    assert.strictEqual(plan.ops.length, 0); assert.deepStrictEqual(plan.prune.sort(), ['te', 'tf']);
    assert.deepStrictEqual(plan.patches.map(x => [x.id, x.patch.dismissed_reason]), [['te', 'removed in the notebook']]);
  });
  await test('tasks on the hub: create (idempotent per block), update, list, sync both ways through ordinary pull, a hub without tasks', async () => {
    const hub = new C.MemoryHub(), web = { id: 'u1', kind: 'browser', name: 'Alex' };
    const d = dev(hub, 'web', 'c1'); await d.load();
    await d.push([d.op('documents', 'd1', { id: 'd1', type: 'note', title: 'Plan' }), d.op('blocks', 'b1', taskBlock('b1', 'd1', 'Order coverslips'))]);
    const c = await call(hub, web, 'POST', '/api/rm/tasks', { body: { blockId: 'b1', docId: 'd1', text: 'Order coverslips', due: '2026-10-30', prio: 'high', docTitle: 'Plan' } });
    assert.strictEqual(c.body.ok, true); const tid = c.body.id; assert.strictEqual(c.body.task.due_date, '2026-10-30');
    const again = await call(hub, web, 'POST', '/api/rm/tasks', { body: { blockId: 'b1', docId: 'd1', text: 'Order coverslips' } });
    assert.strictEqual(again.body.id, tid); assert.strictEqual(again.body.existed, true, 'one RM task per block');
    assert.strictEqual((await call(hub, web, 'POST', '/api/rm/tasks', { body: {} })).status, 400);
    const up = await call(hub, web, 'POST', '/api/rm/tasks/update', { body: { id: tid, text: 'Order 500 coverslips', due: null } });
    assert.strictEqual(up.body.task.text, 'Order 500 coverslips'); assert.strictEqual(up.body.task.due_date, 'TBD');
    assert.strictEqual((await call(hub, web, 'POST', '/api/rm/tasks/update', { body: { id: 'task-not-ours' } })).body.ok, false);
    const list = await call(hub, web, 'GET', '/api/rm/tasks', { query: { ids: tid } });
    assert.deepStrictEqual(list.body.tasks.map(t => [t.id, t.done, t.text]), [[tid, false, 'Order 500 coverslips']]);
    // RM marks it done (My Week) → hello syncs → the web device pulls the block as done, from device rm
    hub.rmTaskDocs.set(tid, Object.assign({}, hub.rmTaskDocs.get(tid), { done: true, done_at: '2026-10-24T08:00:00' }));
    await call(hub, web, 'GET', '/api/sync/hello');
    const pulled = await d.pull();
    assert.deepStrictEqual(pulled.ops.map(o => [o.store, o.id, o.name, o.rec.task.done]), [['blocks', 'b1', 'RM tasks', '2026-10-24T08:00:00']]);
    await call(hub, web, 'GET', '/api/sync/hello');
    assert.strictEqual(hub.taskSyncRuns, 1, 'throttled');
    // the notebook reopens it later → forced sync → RM reopened
    const b = JSON.parse(JSON.stringify(pulled.ops[0].rec)); b.task.done = null; b.modified = '2026-10-25T09:00:00';
    await d.push([d.op('blocks', 'b1', b)]);
    const s = await call(hub, web, 'POST', '/api/rm/tasks/sync', {});
    assert.strictEqual(s.body.tasksUpdated, 1); assert.strictEqual(hub.rmTaskDocs.get(tid).done, false);
    // the block is removed → the RM task is dismissed and unpaired
    const gone = Object.assign({}, b, { status: 'removed', modified: '2026-10-26T09:00:00' }); await d.push([d.op('blocks', 'b1', gone)]);
    const s2 = await call(hub, web, 'POST', '/api/rm/tasks/sync', {});
    assert.strictEqual(s2.body.dropped, 1); assert.ok(hub.rmTaskDocs.get(tid).dismissed_at); assert.strictEqual(hub.rmTasks.size, 0);
    const bare = new C.MemoryHub(); bare.createTask = undefined;
    assert.strictEqual((await call(bare, web, 'POST', '/api/rm/tasks', { body: { blockId: 'x' } })).body.ok, false);
  });

  /* ---- V3.874: reminders + chores → My Week; timer sessions + edits → RM's activity ---- */
  await test('dates: the lab day (Phoenix), day arithmetic, weekdays, RM times → lab days', () => {
    assert.strictEqual(C.todayIn('America/Phoenix', Date.parse('2026-10-24T05:30:00Z')), '2026-10-23', '05:30 UTC is 22:30 the day before in Phoenix');
    assert.strictEqual(C.nowIn('America/Phoenix', Date.parse('2026-10-24T05:30:00Z')), '2026-10-23T22:30:00');
    assert.strictEqual(C.addDays_('2026-10-30', 3), '2026-11-02'); assert.strictEqual(C.wdayOf('2026-10-26'), 1, 'a Monday');
    assert.strictEqual(C.localDayOf('2026-10-24T05:30:00.000Z', 'America/Phoenix'), '2026-10-23');
    assert.strictEqual(C.localDayOf('2026-10-24T08:00:00', 'America/Phoenix'), '2026-10-24', 'a naive local time is already local');
    assert.strictEqual(C.localDayOf(null), null);
  });
  const chore = (id, extra) => Object.assign({ id, title: 'Chore ' + id, mode: 'interval', every: 3, days: [], start: '2026-10-20', done: [], active: true }, extra || {});
  const rem = (id, extra) => Object.assign({ id, kind: 'reminder', title: 'Rem ' + id, at: '2026-10-28T14:00', allDay: false, repeat: 'none' }, extra || {});
  await test('occurrences: interval chores (next = last done + N), weekday chores, one-off and repeating reminders; task reminders excluded', () => {
    assert.strictEqual(C.choreNext(chore('a')), '2026-10-23', 'never done: start + every');
    assert.strictEqual(C.choreNext(chore('a', { done: ['2026-10-22', '2026-10-24'] })), '2026-10-27');
    assert.deepStrictEqual(C.whenOcc('chores', chore('a', { done: ['2026-10-24'] }), '2026-10-23'), { valid: true, done: true }, 'a done date on/after the occurrence satisfies it');
    assert.deepStrictEqual(C.whenOcc('chores', chore('a'), '2026-10-25'), { valid: false, done: false }, 'not the open occurrence');
    const wk = chore('w', { mode: 'weekdays', days: [1, 3], done: ['2026-10-26'] });
    assert.deepStrictEqual([C.whenOcc('chores', wk, '2026-10-26'), C.whenOcc('chores', wk, '2026-10-28'), C.whenOcc('chores', wk, '2026-10-27')].map(o => [o.valid, o.done]), [[true, true], [true, false], [false, false]]);
    assert.strictEqual(C.whenOcc('chores', chore('s', { active: false }), '2026-10-23').valid, false, 'a stopped chore has no occurrences');
    const weekly = rem('r', { repeat: 'weekly', at: '2026-10-21T09:00', skip: ['2026-10-28'] });
    assert.deepStrictEqual([C.remOccursOn(weekly, '2026-11-04'), C.remOccursOn(weekly, '2026-11-05'), C.remOccursOn(weekly, '2026-10-14')], [true, false, false]);
    assert.deepStrictEqual(C.whenOcc('reminders', weekly, '2026-10-28'), { valid: true, done: true }, 'skip = done for that date');
    const cands = C.whenCandidates({ today: '2026-10-26', chores: [chore('a', { done: ['2026-10-25'] }), wk, chore('s', { active: false })],
      reminders: [rem('one'), weekly, rem('rt_task1', { kind: 'task' }), rem('old', { at: '2026-10-01T10:00' }), rem('closed', { done: '2026-10-20T10:00' })] });
    const got = cands.map(c => c.taskId);
    assert.ok(got.includes('sis-ch-a-2026-10-28'), 'interval chore: its next occurrence');
    assert.ok(!got.includes('sis-ch-w-2026-10-26') && got.includes('sis-ch-w-2026-10-28') && got.includes('sis-ch-w-2026-11-02') && got.includes('sis-ch-w-2026-11-04'), 'weekday chore: Mon/Wed in the window, done ones skipped');
    assert.ok(got.includes('sis-rm-one-2026-10-28'), 'one-off reminder in the window');
    assert.ok(!got.includes('sis-rm-r-2026-10-28') && got.includes('sis-rm-r-2026-11-04'), 'repeating: a skipped (done) date is not offered');
    assert.ok(!got.some(x => /rt_task1|-old-|-closed-|ch-s-/.test(x)), 'task reminders, old one-offs, closed reminders and stopped chores are not offered');
    assert.ok(cands.every(c => c.date <= '2026-11-08'), 'two weeks ahead at most');
  });
  await test('rmWhenTask: a dated item My Week holds back until its week (source_ref.kind scientia-when)', () => {
    const t = C.rmWhenTask({ uid: 'u1', name: 'Gabe', store: 'reminders', rec: rem('m', { kind: 'meeting', title: 'Lab meeting' }), date: '2026-10-28', done: false, now: Date.parse('2026-10-26T16:00:00Z') });
    assert.deepStrictEqual([t.id, t.text, t.bucket, t.due_date, t.done, t.sis_done, t.source, t.source_ref.kind, t.source_ref.label, t.source_ref.scientia.store],
      ['sis-rm-m-2026-10-28', 'Meeting: Lab meeting · 14:00', 'assigned', '2026-10-28', false, false, 'scientia', 'scientia-when', 'Meeting', 'reminders']);
    assert.strictEqual(C.rmWhenTask({ uid: 'u1', store: 'chores', rec: chore('p', { title: 'Passage MDCK' }), date: '2026-10-28' }).text, 'Passage MDCK');
    assert.strictEqual(C.rmWhenTask({ uid: 'u1', store: 'reminders', rec: rem('d', { kind: 'deadline', title: 'Abstract', allDay: true }), date: '2026-10-28' }).text, 'Deadline: Abstract');
  });
  await test('planWhen: create; a tick in My Week reaches the chore / reminder; a tick in Scientia reaches RM; agreement; gone → dismissed', () => {
    const st = { seq: 9 }, today = '2026-10-26', now = Date.parse('2026-10-26T18:00:00Z');
    const wk = chore('w', { mode: 'weekdays', days: [1, 3] }), iv = chore('a', { done: ['2026-10-23'] }), one = rem('one'), weekly = rem('r', { repeat: 'weekly', at: '2026-10-19T09:00' });
    // first pass: everything is new
    let p = C.planWhen({ state: st, chores: [wk, iv], reminders: [one, weekly], tracked: {}, tasks: new Map(), today, uid: 'u1', name: 'Gabe', now });
    assert.ok(p.creates.length >= 5 && p.ops.length === 0 && Object.keys(p.track).length === p.creates.length);
    const docs = new Map(p.creates.map(t => [t.id, t])), tracked = Object.assign({}, p.track);
    // My Week ticks: the weekday chore today, the interval chore's 26th, the one-off, the weekly's 26th
    const tick = (id, at) => docs.set(id, Object.assign({}, docs.get(id), { done: true, done_at: at }));
    tick('sis-ch-w-2026-10-26', '2026-10-26T17:00:00.000Z'); tick('sis-ch-a-2026-10-26', '2026-10-27T02:00:00.000Z'); tick('sis-rm-one-2026-10-28', '2026-10-26T17:30:00.000Z'); tick('sis-rm-r-2026-10-26', '2026-10-26T16:00:00.000Z');
    p = C.planWhen({ state: st, chores: [wk, iv], reminders: [one, weekly], tracked, tasks: docs, today, uid: 'u1', now });
    const op = id => p.ops.find(o => o.id === id);
    assert.deepStrictEqual(op('w').rec.done, ['2026-10-26'], 'weekday chore: the occurrence date');
    assert.deepStrictEqual(op('a').rec.done, ['2026-10-23', '2026-10-26'], 'interval chore: the lab day it was done (02:00Z = 19:00 Phoenix on the 26th)');
    assert.strictEqual(op('one').rec.done, '2026-10-26T17:30:00.000Z'); assert.deepStrictEqual(op('r').rec.skip, ['2026-10-26']);
    assert.ok(p.ops.every(o => o.base === 9 && o.prev && !o.del));
    assert.ok(['sis-ch-w-2026-10-26', 'sis-ch-a-2026-10-26', 'sis-rm-one-2026-10-28', 'sis-rm-r-2026-10-26'].every(id => p.patches.some(x => x.id === id && x.patch.sis_done === true && x.patch.done === undefined)), 'RM-side wins: only the agreed value moves');
    assert.ok(p.creates.some(t => t.id === 'sis-ch-a-2026-10-29'), 'the interval chore’s NEXT occurrence is offered at once');
    // Scientia ticks Wednesday's weekday chore → RM done
    const wk2 = Object.assign({}, wk, { done: ['2026-10-26', '2026-10-28'] });
    p.patches.forEach(x => docs.set(x.id, Object.assign({}, docs.get(x.id), x.patch)));
    p = C.planWhen({ state: st, chores: [wk2, iv], reminders: [one, weekly], tracked, tasks: docs, today, uid: 'u1', now });
    const w28 = p.patches.find(x => x.id === 'sis-ch-w-2026-10-28');
    assert.ok(w28 && w28.patch.done === true && w28.patch.sis_done === true && w28.patch.done_at, JSON.stringify(p.patches));
    // the chore is stopped → its open items are dismissed and untracked
    const stopped = Object.assign({}, wk2, { active: false });
    p = C.planWhen({ state: st, chores: [stopped, iv], reminders: [one, weekly], tracked, tasks: docs, today, uid: 'u1', now });
    const nov2 = p.patches.find(x => x.id === 'sis-ch-w-2026-11-02');
    assert.ok(nov2 && nov2.patch.dismissed_reason === 'gone from Scientia' && p.untrack.includes('sis-ch-w-2026-11-02'));
    assert.ok(!p.patches.some(x => x.id === 'sis-ch-w-2026-10-26' && x.patch.dismissed_at), 'a done item is not dismissed');
    // a task deleted in RM is untracked; a task dismissed in RM leaves Scientia alone
    docs.delete('sis-rm-one-2026-10-28'); docs.set('sis-rm-r-2026-11-02', Object.assign({}, docs.get('sis-rm-r-2026-11-02'), { dismissed_at: '2026-10-26T18:00:00Z' }));
    p = C.planWhen({ state: st, chores: [wk2, iv], reminders: [one, weekly], tracked, tasks: docs, today, uid: 'u1', now });
    assert.ok(p.untrack.includes('sis-rm-one-2026-10-28') && !p.ops.some(o => o.id === 'r' && (o.rec.skip || []).includes('2026-11-02')));
  });
  await test('when on the hub: a device’s chores reach RM; My Week’s tick comes back through ordinary pull from "RM My Week"', async () => {
    const hub = new C.MemoryHub(), web = { id: 'u1', kind: 'browser', name: 'Gabe' }; hub.today = '2026-10-26';
    const d = dev(hub, 'desktop', 'c1'); await d.load();
    await d.push([d.op('chores', 'ch1', chore('ch1', { title: 'Passage MDCK', mode: 'weekdays', days: [1, 4] })), d.op('reminders', 'r1', rem('r1', { kind: 'deadline', title: 'Abstract', at: '2026-10-30T23:59', allDay: true }))]);
    const s = await call(hub, web, 'POST', '/api/rm/sync', {});
    assert.strictEqual(s.body.ok, true); assert.ok(s.body.when.created >= 4, JSON.stringify(s.body.when));
    assert.ok(hub.rmTaskDocs.has('sis-ch-ch1-2026-10-26') && hub.rmTaskDocs.has('sis-ch-ch1-2026-10-29') && hub.rmTaskDocs.has('sis-rm-r1-2026-10-30'));
    assert.strictEqual(hub.rmTaskDocs.get('sis-rm-r1-2026-10-30').text, 'Deadline: Abstract');
    hub.rmTaskDocs.set('sis-ch-ch1-2026-10-26', Object.assign({}, hub.rmTaskDocs.get('sis-ch-ch1-2026-10-26'), { done: true, done_at: '2026-10-26T20:00:00.000Z' }));
    await call(hub, web, 'POST', '/api/rm/sync', {});
    const pulled = await d.pull();
    const chOp = pulled.ops.find(o => o.store === 'chores' && o.id === 'ch1');
    assert.ok(chOp && chOp.name === 'RM My Week' && chOp.rec.done.includes('2026-10-26'), JSON.stringify(pulled.ops.map(o => [o.store, o.id, o.name])));
    // the desktop ticks Thursday → RM done on the next sync
    const c2 = JSON.parse(JSON.stringify(chOp.rec)); c2.done = c2.done.concat(['2026-10-29']); await d.push([d.op('chores', 'ch1', c2)]);
    await call(hub, web, 'POST', '/api/rm/sync', {});
    assert.strictEqual(hub.rmTaskDocs.get('sis-ch-ch1-2026-10-29').done, true);
    // the pull long-poll runs the throttled syncs too
    const runs = hub.whenRuns; hub.whenSyncAt = 0; await call(hub, web, 'GET', '/api/sync/pull', { query: { since: '0', conn: 'c9' } });
    assert.strictEqual(hub.whenRuns, runs + 1, 'pull reconciles when a sync is due');
    await call(hub, web, 'GET', '/api/sync/pull', { query: { since: '0', conn: 'c9' } });
    assert.strictEqual(hub.whenRuns, runs + 1, '…and is throttled');
  });
  await test('activity: closed timer segments per lab day, edits, one event per note per day; merging, hours-era guard', () => {
    const s1 = { id: 's1', docId: 'd1', segments: [{ s: '2026-10-26T09:00:00', e: '2026-10-26T10:30:00' }, { s: '2026-10-26T13:00:00', e: '2026-10-26T13:20:00' }, { s: '2026-10-26T15:00:00', e: null }] };
    assert.deepStrictEqual(C.sessionDaySeconds(s1), { '2026-10-26': 6600 }, 'the open segment does not count yet');
    const groups = C.activityGroups({ today: '2026-10-26', from: '2026-10-23', changes: [
      { store: 'sessions', rec: s1 }, { store: 'documents', rec: { id: 'd1', title: 'Gel run 3', modified: '2026-10-26T16:00:00' } },
      { store: 'documents', rec: { id: 'd2', title: 'Old note', modified: '2026-09-01T10:00:00' } }, { store: 'documents', rec: { id: 'd3', title: 'Plan', modified: '2026-10-25T10:00:00' } }] });
    assert.deepStrictEqual([...groups.keys()].sort(), ['auto-scientia-note-d1-2026-10-26', 'auto-scientia-note-d3-2026-10-25']);
    const docs = new Map([['d1', { id: 'd1', title: 'Gel run 3', type: 'experiment' }], ['d3', { id: 'd3', title: 'Plan' }]]);
    let w = C.planActivity({ groups, docs, existing: new Map() });
    const e1 = w.find(x => x.id === 'auto-scientia-note-d1-2026-10-26');
    assert.deepStrictEqual([e1.isNew, e1.data.text, e1.data.scientia_minutes, e1.data.scientia_edited, e1.data.source, e1.data.kind, e1.data.categoryPath, e1.data.source_ref.kind],
      [true, 'Scientia: Gel run 3 · 1 h 50 min timed', 110, true, 'scientia', 'work', ['research', 'notebook'], 'scientia-note']);
    assert.strictEqual(w.find(x => x.id === 'auto-scientia-note-d3-2026-10-25').data.text, 'Scientia: Plan');
    // a second session the same day merges; an unchanged event is not rewritten; an hours-era decided doc is left alone
    const g2 = C.activityGroups({ today: '2026-10-26', from: '2026-10-23', changes: [{ store: 'sessions', rec: { id: 's2', docId: 'd1', segments: [{ s: '2026-10-26T17:00:00', e: '2026-10-26T17:10:00' }] } }] });
    w = C.planActivity({ groups: g2, docs, existing: new Map([['auto-scientia-note-d1-2026-10-26', e1.data]]) });
    assert.strictEqual(w[0].data.scientia_minutes, 120); assert.deepStrictEqual(Object.keys(w[0].data.scientia_sessions).sort(), ['s1', 's2']); assert.strictEqual(w[0].isNew, false);
    assert.strictEqual(C.planActivity({ groups, docs, existing: new Map([['auto-scientia-note-d1-2026-10-26', e1.data]]) }).filter(x => x.id === e1.id).length, 0, 'no change, no write');
    assert.strictEqual(C.planActivity({ groups, docs, existing: new Map([['auto-scientia-note-d1-2026-10-26', { status: 'confirmed' }]]) }).filter(x => x.id === e1.id).length, 0);
  });
  await test('activity on the hub: first pass scans, later passes read only new ops (cursor), both devices count', async () => {
    const hub = new C.MemoryHub(), web = { id: 'u1', kind: 'browser', name: 'Gabe' }; hub.today = '2026-10-26';
    const d = dev(hub, 'desktop', 'c1'); await d.load();
    await d.push([d.op('documents', 'd1', { id: 'd1', type: 'note', title: 'Gel run 3', modified: '2026-10-26T09:00:00' }),
      d.op('sessions', 's1', { id: 's1', docId: 'd1', state: 'complete', segments: [{ s: '2026-10-26T09:00:00', e: '2026-10-26T09:45:00' }] })]);
    await call(hub, web, 'POST', '/api/rm/sync', {});
    assert.strictEqual(hub.tracker.get('auto-scientia-note-d1-2026-10-26').text, 'Scientia: Gel run 3 · 45 min timed');
    const w = dev(hub, 'web', 'c2'); await w.load();
    await w.push([w.op('sessions', 's2', { id: 's2', docId: 'd1', state: 'complete', segments: [{ s: '2026-10-26T14:00:00', e: '2026-10-26T14:30:00' }] })]);
    await call(hub, web, 'POST', '/api/rm/sync', {});
    assert.strictEqual(hub.tracker.get('auto-scientia-note-d1-2026-10-26').scientia_minutes, 75);
    assert.strictEqual(hub.tracker.size, 1, 'one event per note per day');
  });

  /* ---- V3.875: RM highlights for a paper card ---- */
  await test('annotations: what the rule lets the person read (lab-visible or their own), compact rows, by page; route + errors', async () => {
    const ann = (id, extra) => Object.assign({ id, paperId: 'p1', visibility: 'lab', color_id: 'yellow', annotation_type: 'note', comment: '', creator: { uid: 'u2', displayName: 'Mo' },
      target: { pages: [{ page: 3, selectors: { textQuote: { exact: 'granular hydrogels', prefix: '', suffix: '' } } }] }, created: '2026-10-20T10:00:00Z' }, extra || {});
    const raw = [ann('a1', { creator: { uid: 'u1', displayName: 'Gabe' }, color_id: 'green', comment: 'key result', target: { pages: [{ page: 7, selectors: { textQuote: { exact: 'stiffness rises' } } }] } }),
      ann('a2'), ann('a3', { visibility: 'private', creator: { uid: 'u2' } }), ann('a4', { visibility: 'private', creator: { uid: 'u1', displayName: 'Gabe' }, target: { pages: [] } }), ann('a5', { deleted: true })];
    const rows = C.visibleAnnotations(raw, 'u1');
    assert.deepStrictEqual(rows.map(r => r.id), ['a2', 'a1', 'a4'], 'someone else’s private one and a deleted one are not shown; by page, page-less last');
    assert.deepStrictEqual([rows[1].color, rows[1].page, rows[1].exact, rows[1].comment, rows[1].mine, rows[1].by], ['green', 7, 'stiffness rises', 'key result', true, 'Gabe']);
    assert.deepStrictEqual([rows[0].mine, rows[2].page], [false, null]);
    const hub = new C.MemoryHub(); hub.uid = 'u1'; hub.rmAnnotations = new Map([['p1', raw]]);
    const web = { id: 'u1', kind: 'browser', name: 'Gabe' };
    const r = await call(hub, web, 'GET', '/api/rm/annotations', { query: { paperId: 'p1' } });
    assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.total, 3);
    assert.strictEqual((await call(hub, web, 'GET', '/api/rm/annotations', { query: {} })).status, 400);
    assert.strictEqual((await call(hub, web, 'GET', '/api/rm/annotations', { query: { paperId: 'nope' } })).body.total, 0);
  });

  /* ---- V3.877: RM protocols and collections for Scientia ---- */
  const proto = { id: 'agarose-lls', title: 'Agarose LLS', status: 'draft', category: 'gels', current_version: 2, updated_at: '2026-10-20T10:00:00',
    tree: { sections: [
      { label: 'Making the gel', order: 1, children: [{ id: 'f1', kind: 'formula', body: '' }, { id: 's1', kind: 'step', body: 'Weigh [!var:agarose_mass] of agarose.' }, { id: 's2', kind: 'step', body: '<p>Add [!var:vol] of PBS &amp; heat.</p>' }, { id: 'c1', kind: 'callout', body: 'Hot — use the clamp.' }] },
      { label: 'Design', order: 0, children: [{ id: 'm1', kind: 'materials', body: '' }, { id: 'sa', kind: 'safety', body: 'Work in the hood.' }, { id: 'n0', kind: 'note', body: '' }, { id: 't1', kind: 'table', body: '' }] },
      { label: 'Sieving', order: 2, children: [{ id: 's3', kind: 'step', body: 'Press through the 300 µm sieve.' }, { id: 'sx', kind: 'step', body: '   ' }, { id: 'sr', kind: 'step', body: 'gone', status: 'removed' }] }] } };
  await test('protocols: RM’s tree becomes Scientia steps (sections in order, notes as steps, variables named, the rest counted)', () => {
    const p = C.rmProtocolSteps(proto);
    assert.deepStrictEqual(p.list.map(s => s.text), ['Design: Note: Work in the hood.', 'Making the gel: Weigh ‹agarose_mass› of agarose.', 'Add ‹vol› of PBS & heat.', 'Note: Hot — use the clamp.', 'Sieving: Press through the 300 µm sieve.']);
    assert.deepStrictEqual(p.skipped, { materials: 1, table: 1, formula: 1 });
    assert.deepStrictEqual([p.id, p.title, p.version, p.steps, p.url], ['agarose-lls', 'Agarose LLS', 2, 5, '/rm/pages/protocols.html?protocol=agarose-lls']);
    assert.strictEqual(C.rmProtocolRow(proto).steps, 3, 'the list row counts real steps (not removed, not blank)');
    assert.deepStrictEqual(C.searchProtocols([C.rmProtocolRow(proto), C.rmProtocolRow({ id: 'old', title: 'Old', status: 'archived' }), C.rmProtocolRow({ id: 'b', title: 'Bradford assay', updated_at: '2026-10-22' })], '').map(r => r.id), ['b', 'agarose-lls']);
    assert.deepStrictEqual(C.searchProtocols([C.rmProtocolRow(proto), C.rmProtocolRow({ id: 'b', title: 'Bradford assay' })], 'gels').map(r => r.id), ['agarose-lls'], 'category is searched');
  });
  await test('collections: the Lab Notebook’s mirror as a list row and in full; routes', async () => {
    const lr = { id: 'col-1', itemId: 'col-1', kind: 'collection', title: 'Granule stiffness', entryId: 'nb-7', boardId: 'b-7', keyPoints: ['packing sets G′', ''],
      papers: { 'p-smith-2024': { title: 'Granular hydrogels', cite: 'Smith 2024', why: 'the method' } }, entries: [{ type: 'quote', quote: 'stiffness rises', hex: '#4ade80', paperId: 'p-smith-2024', cite: 'Smith 2024' }],
      counts: { papers: 1, quotes: 1 }, claim: null, updated_at: '2026-10-21T09:00:00' };
    const row = C.rmCollectionRow(lr), full = C.rmCollectionFull(lr);
    assert.deepStrictEqual([row.id, row.title, row.entryId, row.papers, row.entries, row.claim], ['col-1', 'Granule stiffness', 'nb-7', 1, 1, false]);
    assert.deepStrictEqual(full.keyPoints, ['packing sets G′']); assert.strictEqual(full.paperList[0].why, 'the method'); assert.strictEqual(full.entryList[0].hex, '#4ade80');
    const hub = new C.MemoryHub(); hub.rmCollections = [lr]; hub.rmProtocols = [proto];
    const web = { id: 'u1', kind: 'browser', name: 'Gabe' };
    assert.strictEqual((await call(hub, web, 'GET', '/api/rm/collections')).body.items[0].id, 'col-1');
    assert.strictEqual((await call(hub, web, 'GET', '/api/rm/collections', { query: { id: 'col-1' } })).body.collection.title, 'Granule stiffness');
    assert.strictEqual((await call(hub, web, 'GET', '/api/rm/collections', { query: { id: 'nope' } })).body.ok, false);
    assert.strictEqual((await call(hub, web, 'GET', '/api/rm/protocols', { query: { q: 'agarose' } })).body.items[0].id, 'agarose-lls');
    assert.strictEqual((await call(hub, web, 'GET', '/api/rm/protocols', { query: { id: 'agarose-lls' } })).body.protocol.list.length, 5);
  });

  /* ---- V3.880: the person's assignments → Portfolio projects ---- */
  const FOCI = [
    { id: 'gels-energy-landscape', level: 'concept', title: 'GELS energy landscape', status: 'active', one_liner: 'Bio-inks that behave to plan', member_uids: ['u1', 'u2'], links: { specialty_ids: ['gels'] } },
    { id: 'gels', level: 'specialty', title: 'GELS', status: 'active', member_uids: [] },
    { id: 'gels-career', level: 'grant', title: 'CAREER: granular microgels', status: 'submitted', member_uids: ['u1'], member_roles: { u1: 'secondary' },
      links: { concept_ids: ['gels-energy-landscape'], draft_refs: [{ id: 'career-draft', kind: 'grant' }] }, source_draft_id: 'career-draft' },
    { id: 'gels-career-aim-1', level: 'aim', title: 'Aim 1 — Map the landscape', status: 'planning', one_liner: 'Size and stiffness set packing', member_uids: ['u1'], links: { grant_ids: ['gels-career'] } },
    { id: 'lone-aim', level: 'aim', title: 'Aim 2 — elsewhere', status: 'planning', member_uids: ['u1'], links: { grant_ids: ['someone-elses-grant'] } },
    { id: 'proposed-card', level: 'concept', title: 'My idea', member_uids: ['u1'], approval: { status: 'proposed', proposed_by: 'u1' } },
    { id: 'not-mine', level: 'grant', title: 'R01', member_uids: ['u2'] }];
  const RMPROJ = [
    { id: 'career-draft', type: 'paper', title: 'CAREER: granular microgels', status: 'submitted', member_uids: ['u1'] },
    { id: 'source-and-sink', type: 'paper', title: 'Source and sink', status: 'drafting', target_journal: 'PNAS', lead_author_uid: 'u1', member_uids: ['u1', 'u3'] },
    { id: 'confocal', type: 'infrastructure', title: 'Confocal upkeep', member_uids: ['u3'] }];
  await test('assigned: cards and projects the person is on; aims under an assigned grant are its themes; the grant’s draft folds in; proposals are not assignments', () => {
    const A = C.rmAssigned({ foci: FOCI, projects: RMPROJ, uid: 'u1' });
    assert.deepStrictEqual(A.projects.map(p => p.id).sort(), ['rm-f-gels-career', 'rm-f-gels-energy-landscape', 'rm-f-lone-aim', 'rm-p-source-and-sink']);
    assert.deepStrictEqual(A.themes.map(t => [t.id, t.projectId, t.question]), [['rm-a-gels-career-aim-1', 'rm-f-gels-career', 'Size and stiffness set packing']]);
    const g = A.projects.find(p => p.id === 'rm-f-gels-career');
    assert.deepStrictEqual([g.rmKind, g.rmRole, g.rmDraftId, g.rmParents, g.rmUrl], ['grant', 'secondary', 'career-draft', ['GELS energy landscape'], '/rm/pages/research.html?id=gels-career']);
    const s = A.projects.find(p => p.id === 'rm-p-source-and-sink');
    assert.deepStrictEqual([s.rmKind, s.rmRole, s.rmLine, s.rmUrl], ['paper', 'lead', 'For PNAS', '/rm/pages/paper-builder.html?paper=source-and-sink']);
    assert.deepStrictEqual(A.projects.find(p => p.id === 'rm-f-gels-energy-landscape').rmParents, ['GELS']);
  });
  await test('assigned: the hub mirrors them as device “RM projects”; a re-run writes nothing; the person’s own fields survive', async () => {
    const hub = new C.MemoryHub(); hub.uid = 'u1'; hub.rmFoci = FOCI; hub.rmProjects = RMPROJ;
    const r = await hub.syncProjects({ force: true });
    assert.deepStrictEqual([r.projects, r.themes, r.written], [4, 1, 5]);
    const P = id => hub.rows.get(C.keyOf('projects', id)).rec, T = id => hub.rows.get(C.keyOf('themes', id)).rec;
    assert.strictEqual(P('rm-f-gels-career').status, 'active'); assert.ok(P('rm-f-gels-career').created, 'a project row has created (the map sorts on it)');
    assert.deepStrictEqual([T('rm-a-gels-career-aim-1').status, T('rm-a-gels-career-aim-1').supersedes], ['active', []]);
    assert.strictEqual(hub.rows.get(C.keyOf('projects', 'rm-f-gels-career')).name, 'RM projects');
    assert.strictEqual((await hub.syncProjects({ force: true })).written, 0, 'nothing changed in RM → nothing written');
    assert.strictEqual((await hub.syncProjects({})).skipped, true, 'throttled');
    const web = dev(hub, 'web', 'c1'); await web.load();
    const mine = Object.assign({}, P('rm-f-gels-career'), { pinned: true }); await web.push([web.op('projects', 'rm-f-gels-career', mine)]);
    const th = Object.assign({}, T('rm-a-gels-career-aim-1'), { question: 'My sharper question' }); await web.push([web.op('themes', th.id, th)]);
    hub.rmFoci = FOCI.map(f => f.id === 'gels-career' ? Object.assign({}, f, { title: 'CAREER: renamed', status: 'awarded' }) : f);
    assert.strictEqual((await hub.syncProjects({ force: true })).written, 1);
    assert.deepStrictEqual([P('rm-f-gels-career').name, P('rm-f-gels-career').rmStatus, P('rm-f-gels-career').pinned], ['CAREER: renamed', 'awarded', true]);
    assert.strictEqual(T('rm-a-gels-career-aim-1').question, 'My sharper question', 'the question is the person’s after the first mirror');
  });
  await test('assigned: taking a person off keeps the project (rmAssigned false) and retires the aim theme; putting them back restores it', async () => {
    const hub = new C.MemoryHub(); hub.uid = 'u1'; hub.rmFoci = FOCI; hub.rmProjects = RMPROJ;
    await hub.syncProjects({ force: true });
    hub.rmFoci = FOCI.map(f => (f.id === 'gels-career' || f.id === 'gels-career-aim-1') ? Object.assign({}, f, { member_uids: ['u2'] }) : f);
    const r = await hub.syncProjects({ force: true });
    assert.strictEqual(r.removed, 2);
    const P = id => hub.rows.get(C.keyOf('projects', id)).rec, T = id => hub.rows.get(C.keyOf('themes', id)).rec;
    assert.deepStrictEqual([P('rm-f-gels-career').rmAssigned, P('rm-f-gels-career').name], [false, 'CAREER: granular microgels']);
    assert.deepStrictEqual([T('rm-a-gels-career-aim-1').status, T('rm-a-gels-career-aim-1').retireReason], ['retired', C.UNASSIGNED_WHY]);
    assert.ok(hub.rows.get(C.keyOf('projects', 'rm-p-career-draft')), 'the grant is no longer assigned, so its draft paper (still assigned) is a project of its own');
    assert.strictEqual((await hub.syncProjects({ force: true })).written, 0, 'an unassigned row is written once');
    hub.rmFoci = FOCI;
    await hub.syncProjects({ force: true });
    assert.deepStrictEqual([P('rm-f-gels-career').rmAssigned, T('rm-a-gels-career-aim-1').status, T('rm-a-gels-career-aim-1').retireReason], [true, 'active', '']);
    const re = Object.assign({}, T('rm-a-gels-career-aim-1'), { status: 'superseded' }); const web = dev(hub, 'web', 'c1'); await web.load(); await web.push([web.op('themes', re.id, re)]);
    hub.rmFoci = FOCI.map(f => f.id === 'gels-career-aim-1' ? Object.assign({}, f, { member_uids: [] }) : f);
    await hub.syncProjects({ force: true });
    assert.deepStrictEqual([T('rm-a-gels-career-aim-1').status, T('rm-a-gels-career-aim-1').rmAssigned], ['superseded', false], 'a theme the person re-shaped keeps its own status');
  });
  await test('assigned: api/rm/sync?only=projects runs the mirror', async () => {
    const hub = new C.MemoryHub(); hub.uid = 'u1'; hub.rmFoci = FOCI; hub.rmProjects = RMPROJ;
    const r = await call(hub, { id: 'u1', kind: 'browser', name: 'Gabe' }, 'POST', '/api/rm/sync', { query: { only: 'projects' } });
    assert.strictEqual(r.body.projects.written, 5); assert.strictEqual(r.body.library, undefined);
  });

  console.log(`scientia-hub: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
