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

  console.log(`scientia-hub: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
