/* ================================================================
   scientia-hub.js — Gabe's Scientia sync hub on Firestore (V3.857)
   ================================================================
   The "computer that holds the record" for Scientia In Situ, in the
   cloud: one hub per lab member under userData/{uid}/scientia/hub.
   Gabe's untouched build at /rm/scientia/ talks to it through the
   cloud-sync.js shim (relative `api/…` → this function, with the
   person's Firebase ID token); his desktop app talks to it through
   rm/scientia/scientia-cloud.py (a desktop key, `X-Scientia-Key`).
   The protocol is his (serve.py / sisync.py): hello, state, pull,
   push, conflicts, resolve, snapshot, media, rec — see
   scientia-hub-core.js for the merge rules and the routes.

   Layout (all under the owner catch-all rule — no rules change):
     userData/{uid}/scientia/hub            sid, seq, minSeq, records, savedAt,
                                            conflictsJson, conflictsN, meta, counts
     …/hub/rows/{store}__{id}               recJson | deleted (tombstone keeps seq/dev)
     …/hub/ops/{seq}                        the ops log devices pull from
     …/hub/keys/{id}                        desktop keys (sha-256 hash, name, lastSeen)
     …/hub/media/{encoded path}             path → download-token URL in Storage
     Storage scientia/{uid}/images|recordings|kept/…

   Deploy: firebase deploy --only functions:scientiaHub
   ================================================================ */
'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const crypto = require('crypto');
const C = require('./scientia-hub-core');

const db = () => getFirestore();
const bucket = () => getStorage().bucket();
const rowDocId = (store, id) => store + '__' + encodeURIComponent(String(id)).replace(/\./g, '%2E');
const opDocId = seq => String(seq).padStart(12, '0');
const tsIso = t => (t && typeof t.toDate === 'function') ? t.toDate().toISOString() : (t || null);
const tsMs = t => (t && typeof t.toMillis === 'function') ? t.toMillis() : 0;

function stateFromDoc(snap) {
  if (!snap.exists) return null;
  const d = snap.data() || {};
  let conflicts = []; try { conflicts = d.conflictsJson ? JSON.parse(d.conflictsJson) : []; } catch (e) { conflicts = []; }
  return { sid: d.sid, seq: d.seq || 0, minSeq: d.minSeq || 0, records: d.records || 0, savedAt: d.savedAt || null, conflicts, meta: d.meta || {}, counts: d.counts || undefined };
}
function stateToDoc(st) {
  return { sid: st.sid, seq: st.seq, minSeq: st.minSeq || 0, records: st.records || 0, savedAt: st.savedAt || null, conflictsJson: JSON.stringify(st.conflicts || []),
    conflictsN: (st.conflicts || []).length, meta: st.meta || {}, counts: st.counts || null, updated: FieldValue.serverTimestamp() };
}
function rowFromDoc(snap) {
  if (!snap || !snap.exists) return undefined;
  const d = snap.data() || {};
  let rec = null; if (!d.deleted && d.recJson) { try { rec = JSON.parse(d.recJson); } catch (e) { rec = null; } }
  return { store: d.store, id: d.id, rec, deleted: !!d.deleted || rec === null, seq: d.seq || 0, dev: d.dev || null, name: d.name || null };
}
const rowToDoc = w => ({ store: w.store, id: String(w.id), recJson: w.deleted || w.rec == null ? null : JSON.stringify(w.rec), deleted: !!w.deleted || w.rec == null, seq: w.seq || 0, dev: w.dev || null, name: w.name || null, updated: FieldValue.serverTimestamp() });
const opToDoc = op => ({ seq: op.seq, sid: op.sid, store: op.store, id: String(op.id), recJson: op.rec == null ? null : JSON.stringify(op.rec), del: !!op.del, dev: op.dev || null, conn: op.conn || null, name: op.name || null, ts: op.ts });
function opFromDoc(d) { let rec = null; if (d.recJson) { try { rec = JSON.parse(d.recJson); } catch (e) { rec = null; } } return { seq: d.seq, sid: d.sid, store: d.store, id: d.id, rec, del: !!d.del, dev: d.dev, conn: d.conn, name: d.name, ts: d.ts }; }

class FirestoreHub {
  constructor(uid) {
    this.uid = uid; this.ref = db().doc('userData/' + uid + '/scientia/hub');
    this.rows = this.ref.collection('rows'); this.ops = this.ref.collection('ops'); this.keys = this.ref.collection('keys'); this.media = this.ref.collection('media');
  }
  async loadState() {
    const snap = await this.ref.get(); let st = stateFromDoc(snap);
    if (!st) { st = C.emptyState(); await this.ref.set(Object.assign(stateToDoc(st), { created: FieldValue.serverTimestamp() })); }
    return st;
  }
  async allRows() { const snap = await this.rows.get(); return snap.docs.map(rowFromDoc).filter(r => r && !r.deleted); }
  async state(reason) { const st = await this.loadState(); return C.exportState({ state: st, rows: await this.allRows(), reason }); }

  async push({ dev, conn, name, ops }) {
    if (!ops.length) { const st = await this.loadState(); return { ok: true, sid: st.sid, seq: st.seq, echo: [], conflicts: (st.conflicts || []).length }; }
    let result = { ok: true, sid: null, seq: 0, echo: [], conflicts: 0 }, lastState = null;
    for (let i = 0; i < ops.length; i += 150) {
      const chunk = ops.slice(i, i + 150);
      const r = await db().runTransaction(async t => {
        const st = stateFromDoc(await t.get(this.ref)) || C.emptyState();
        const keys = new Map();
        for (const o of chunk) if (o && o.store && o.id !== undefined && o.id !== null && !C.NOSYNC.has(o.store)) keys.set(C.keyOf(o.store, o.id), this.rows.doc(rowDocId(o.store, o.id)));
        const refs = [...keys.values()], snaps = refs.length ? await t.getAll(...refs) : [];
        const rows = new Map(); let j = 0;
        for (const k of keys.keys()) { const row = rowFromDoc(snaps[j++]); if (row) rows.set(k, row); }
        const plan = C.planPush({ state: st, rows, dev, conn, name, ops: chunk });
        t.set(this.ref, stateToDoc(plan.state), { merge: true });
        for (const w of plan.writes) t.set(this.rows.doc(rowDocId(w.store, w.id)), rowToDoc(w));
        for (const op of plan.commits) t.set(this.ops.doc(opDocId(op.seq)), opToDoc(op));
        lastState = plan.state; return plan.result;
      });
      result = { ok: true, sid: r.sid, seq: r.seq, echo: result.echo.concat(r.echo || []), conflicts: r.conflicts };
    }
    if (lastState && lastState.minSeq > 0 && lastState.seq % 200 === 0) this.trimOps(lastState.minSeq).catch(() => {});
    return result;
  }
  async trimOps(minSeq) {
    const snap = await this.ops.where('seq', '<=', minSeq).orderBy('seq').limit(400).get(); if (snap.empty) return;
    const b = db().batch(); snap.docs.forEach(d => b.delete(d.ref)); await b.commit();
  }
  async pull({ conn, since, sid }) {
    const st = await this.loadState();
    if (sid !== st.sid || since < st.minSeq) return C.pullResult({ state: st, ops: [], since, sid, conn });
    const snap = await this.ops.where('seq', '>', since).orderBy('seq').limit(C.PULL_MAX).get();
    return C.pullResult({ state: st, ops: snap.docs.map(d => opFromDoc(d.data())), since, sid, conn });
  }
  async conflicts() { const st = await this.loadState(); return { ok: true, conflicts: st.conflicts || [] }; }
  async resolve({ cid, pick, dev, name }) {
    return db().runTransaction(async t => {
      const st = stateFromDoc(await t.get(this.ref)) || C.emptyState();
      const c = (st.conflicts || []).find(x => x.cid === cid);
      const row = c ? rowFromDoc(await t.get(this.rows.doc(rowDocId(c.store, c.id)))) : undefined;
      const plan = C.planResolve({ state: st, row, cid, pick, dev, name });
      if (!plan.result.ok) return plan.result;
      t.set(this.ref, stateToDoc(plan.state), { merge: true });
      for (const w of plan.writes) t.set(this.rows.doc(rowDocId(w.store, w.id)), rowToDoc(w));
      for (const op of plan.commits) t.set(this.ops.doc(opDocId(op.seq)), opToDoc(op));
      return plan.result;
    });
  }
  async replace(obj) {
    const st = await this.loadState();
    if (st.records > 0) {
      try { const cur = await this.state('before-replace'); await this.keep('before-replace', Buffer.from(JSON.stringify(cur))); }
      catch (e) { console.warn('[scientiaHub] keep before replace failed:', e.message); }
    }
    const plan = C.planReplace({ state: st, obj });
    await this._wipe(this.rows); await this._wipe(this.ops);
    for (let i = 0; i < plan.rows.length; i += 400) { const b = db().batch(); for (const r of plan.rows.slice(i, i + 400)) b.set(this.rows.doc(rowDocId(r.store, r.id)), rowToDoc(r)); await b.commit(); }
    await this.ref.set(Object.assign(stateToDoc(plan.state), { replacedAt: FieldValue.serverTimestamp() }), { merge: true });
    return plan.result;
  }
  async _wipe(coll) {
    const refs = await coll.listDocuments();
    for (let i = 0; i < refs.length; i += 400) { const b = db().batch(); refs.slice(i, i + 400).forEach(r => b.delete(r)); await b.commit(); }
  }

  _file(path) { return bucket().file('scientia/' + this.uid + '/' + path); }
  async keep(name, raw) {
    const f = this._file('kept/' + name + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    await f.save(raw, { contentType: 'application/json', resumable: false });
    return { ok: true, kept: 'cloud' };
  }
  async mediaPut(path, bytes, mime) {
    const tok = crypto.randomUUID(), f = this._file(path);
    await f.save(bytes, { contentType: mime, resumable: false, metadata: { metadata: { firebaseStorageDownloadTokens: tok } } });
    const url = 'https://firebasestorage.googleapis.com/v0/b/' + bucket().name + '/o/' + encodeURIComponent(f.name) + '?alt=media&token=' + tok;
    await this.media.doc(encodeURIComponent(path)).set({ path, url, bytes: bytes.length, mime, created: FieldValue.serverTimestamp() });
    return { ok: true, path, url, bytes: bytes.length };
  }
  async mediaList() { const snap = await this.media.get(); const files = {}; snap.docs.forEach(d => { const x = d.data() || {}; if (x.path && x.url) files[x.path] = x.url; }); return { ok: true, files }; }

  /* ---- the RM library mirror (V3.869): RM `items` → this hub's `library` rows, device 'rm' ---- */
  async mirrorLibrary({ force } = {}) {
    const snap = await this.ref.get(), d = snap.data() || {}, now = Date.now();
    if (!force && d.mirrorAt && now - tsMs(d.mirrorAt) < C.MIRROR_MS) return { ok: true, skipped: true, total: d.mirrorN || 0 };
    const itemsSnap = await db().collection('items').where('type', '==', 'paper').where('meta.library.is_library_entry', '==', true).get();
    const items = itemsSnap.docs.map(x => Object.assign({ id: x.id }, x.data() || {}));
    const rowsSnap = await this.rows.where('store', '==', 'library').get();
    const rows = new Map();
    rowsSnap.docs.forEach(x => { const r = rowFromDoc(x); if (r && !r.deleted && r.rec) rows.set(C.keyOf('library', r.id), r); });
    const st = await this.loadState();
    const plan = C.planMirror({ state: st, rows, items });
    if (plan.ops.length) await this.push({ dev: 'rm', conn: null, name: 'RM library', ops: plan.ops });
    await this.ref.set({ mirrorAt: FieldValue.serverTimestamp(), mirrorN: items.length, mirrorWritten: plan.ops.length }, { merge: true });
    return { ok: true, total: items.length, written: plan.ops.length, changed: plan.changed, removed: plan.removed };
  }
  /** A download URL for an RM paper's PDF (the same token scheme as the hub's own media). */
  async rmPdfUrl(id) {
    id = String(id || '').trim();
    if (!id) return { ok: false, error: 'no id' };
    const snap = await db().collection('items').doc(id).get();
    const data = snap.exists ? (snap.data() || {}) : {}, L = data.meta && data.meta.library;
    const path = L && L.pdf && L.pdf.storage_path;
    if (!path) return { ok: false, error: 'no PDF in RM for this paper' };
    const f = bucket().file(String(path));
    let meta = null; try { [meta] = await f.getMetadata(); } catch (e) { meta = null; }
    if (!meta) return { ok: false, error: 'the PDF file is missing from Storage' };
    let tok = meta.metadata && meta.metadata.firebaseStorageDownloadTokens;
    if (!tok) { tok = crypto.randomUUID(); await f.setMetadata({ metadata: Object.assign({}, meta.metadata || {}, { firebaseStorageDownloadTokens: tok }) }); }
    tok = String(tok).split(',')[0];
    return { ok: true, id, path: String(path), url: 'https://firebasestorage.googleapis.com/v0/b/' + bucket().name + '/o/' + encodeURIComponent(f.name) + '?alt=media&token=' + tok };
  }
  async keyMake(name) {
    const secret = C.token(16), id = C.token(5);
    await this.keys.doc(id).set({ id, name, hash: C.sha(secret), created: FieldValue.serverTimestamp(), lastSeen: null });
    return { ok: true, id, name, secret };
  }
  async keyList() { const snap = await this.keys.get(); return { ok: true, keys: snap.docs.map(d => { const k = d.data() || {}; return { id: k.id, name: k.name, created: tsIso(k.created), lastSeen: tsIso(k.lastSeen) }; }) }; }
  async keyRemove(id) { if (!id) return { ok: false }; await this.keys.doc(String(id)).delete(); return { ok: true }; }
  async keyFind(secret) {
    const snap = await this.keys.where('hash', '==', C.sha(secret)).limit(1).get(); if (snap.empty) return null;
    const d = snap.docs[0], k = d.data() || {};
    if (Date.now() - tsMs(k.lastSeen) > 60000) d.ref.set({ lastSeen: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
    return { id: k.id, name: k.name };
  }
}

async function isLabMember(uid) {
  const d = await db().collection('users').doc(uid).get();
  const role = d.exists ? (d.data() || {}).role : null;
  return !!role && role !== 'guest';
}

/** Who is calling: the signed-in browser (ID token) or a desktop key. */
async function resolveWho(req) {
  const auth = req.get('Authorization') || '', m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) {
    const decoded = await admin.auth().verifyIdToken(m[1]);
    if (!(await isLabMember(decoded.uid))) return { error: 403, msg: 'lab membership required' };
    return { uid: decoded.uid, id: 'web', name: 'Online', kind: 'browser' };
  }
  const key = req.get('X-Scientia-Key') || '', km = key.match(/^sck_([A-Za-z0-9]+)_([0-9a-f]{32})$/);
  if (km) {
    const hub = new FirestoreHub(km[1]), k = await hub.keyFind(km[2]);
    if (!k) return { error: 401, msg: 'this key is not valid any more — make a new one on the lab site (Desktop sync…)' };
    if (!(await isLabMember(km[1]))) return { error: 403, msg: 'lab membership required' };
    return { uid: km[1], id: k.id, name: k.name, kind: 'key', hub };
  }
  return null;
}

const scientiaHub = onRequest({ cors: false, timeoutSeconds: 300, memory: '512MiB', maxInstances: 4 }, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Scientia-Key');
  res.set('Access-Control-Max-Age', '3600');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  const path = (String(req.path || '/').replace(/^\/scientiaHub(?=\/|$)/, '') || '/').replace(/\/+$/, '') || '/';
  if (path === '/') { res.status(200).json({ ok: true, service: 'scientiaHub', version: 'V3.857' }); return; }
  let who = null;
  try { who = await resolveWho(req); }
  catch (e) { res.status(401).json({ ok: false, error: 'invalid token: ' + e.message }); return; }
  if (who && who.error) { res.status(who.error).json({ ok: false, error: who.msg }); return; }
  if (!who && path !== '/api/sync/hello') { res.status(401).json({ ok: false, error: 'not signed in' }); return; }
  const hub = who ? (who.hub || new FirestoreHub(who.uid)) : null;
  try {
    const out = await C.route({ method: req.method, path, query: req.query || {}, body: req.body, rawBody: req.rawBody || null, headers: req.headers || {} }, { hub, who });
    res.status(out.status).json(out.body);
  } catch (e) {
    console.error('[scientiaHub]', path, e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

module.exports = { scientiaHub, FirestoreHub, resolveWho };
