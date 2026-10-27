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
     scientiaShares/{id} (+ /shadow)        V3.899 Share / Collaborate between hubs — scientia-share.js

   Deploy: firebase deploy --only functions:scientiaHub
   ================================================================ */
'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const crypto = require('crypto');
const C = require('./scientia-hub-core');
const SH = require('./scientia-share-core');
const SHF = require('./scientia-share');

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
    this.lastCommits = [];   // V3.899 — what the share relay looks at
    for (let i = 0; i < ops.length; i += 150) {
      const chunk = ops.slice(i, i + 150); let chunkCommits = [];
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
        lastState = plan.state; chunkCommits = plan.commits; return plan.result;
      });
      this.lastCommits.push(...chunkCommits);
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
      this.lastCommits = plan.commits;
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
  /* ---- V3.884: a recording saved while it runs — a part a minute under recparts/<rid>/, joined at Stop (or after a crash) ---- */
  async recPart(rid, n, ext, bytes) {
    await this._file(C.recPartPath(rid, n, ext)).save(bytes, { contentType: C.MEDIA_MIME[ext] || 'application/octet-stream', resumable: false });
    return { ok: true, rid, n, bytes: bytes.length };
  }
  async _recPartFiles(rid) {
    const [files] = await bucket().getFiles({ prefix: 'scientia/' + this.uid + '/recparts/' + rid + '/' });
    return files.filter(f => /\/part-\d{4}\.[a-z0-9]+$/.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  }
  async recPartsOf(rid) { return (await this._recPartFiles(rid)).map(f => ({ path: f.name, bytes: +((f.metadata && f.metadata.size) || 0) })); }
  async recCompose(rid, path, mime) {
    const parts = await this._recPartFiles(rid); if (!parts.length) return { ok: false, error: 'no saved parts for this recording' };
    // Storage joins at most 32 objects a call: join in rounds through temporary objects
    let srcs = parts, round = 0; const temps = [];
    while (srcs.length > 32) {
      const next = [];
      for (let i = 0; i < srcs.length; i += 32) { const t = this._file('recparts/' + rid + '/tmp-' + round + '-' + String(i).padStart(4, '0')); await bucket().combine(srcs.slice(i, i + 32), t); next.push(t); temps.push(t); }
      srcs = next; round++;
    }
    const dest = this._file(path), tok = crypto.randomUUID();
    await bucket().combine(srcs, dest);
    await dest.setMetadata({ contentType: mime, metadata: { firebaseStorageDownloadTokens: tok } });
    const [meta] = await dest.getMetadata(), bytes = +meta.size || 0;
    const url = 'https://firebasestorage.googleapis.com/v0/b/' + bucket().name + '/o/' + encodeURIComponent(dest.name) + '?alt=media&token=' + tok;
    await this.media.doc(encodeURIComponent(path)).set({ path, url, bytes, mime, created: FieldValue.serverTimestamp() });
    await Promise.all(parts.concat(temps).map(f => f.delete().catch(() => {})));
    return { ok: true, path, url, bytes, parts: parts.length };
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
  /* ---- RM inventory for Scientia's materials (V3.870): compact rows, cached per instance, searched here ---- */
  async inventory({ q, limit, ids } = {}) {
    const now = Date.now();
    if (!FirestoreHub._inv || now - FirestoreHub._inv.at > C.INVENTORY_MS) {
      const snap = await db().collection('inventory').get();
      FirestoreHub._inv = { at: now, rows: snap.docs.map(x => C.rmInventoryRow(Object.assign({ id: x.id }, x.data() || {}))).filter(r => r.condition !== 'retired' && r.condition !== 'disposed') };
    }
    let rows = FirestoreHub._inv.rows;
    if (ids && ids.length) rows = rows.filter(r => ids.includes(r.id));
    const r = C.searchInventory(rows, q, limit);
    r.cachedAt = new Date(FirestoreHub._inv.at).toISOString(); r.all = FirestoreHub._inv.rows.length;
    return r;
  }
  /* ---- RM tasks for Scientia's task components (V3.872): userData/{uid}/tasks + the pairing on the hub doc ---- */
  _taskRef(id) { return db().doc('userData/' + this.uid + '/tasks/' + String(id)); }
  async _pairs() { const snap = await this.ref.get(); const m = (snap.data() || {}).rmTasks; return m && typeof m === 'object' ? m : {}; }
  async createTask({ who, b }) {
    const pairs = await this._pairs(), blockId = String(b.blockId);
    const had = Object.keys(pairs).find(tid => pairs[tid] === blockId);
    if (had) { const s = await this._taskRef(had).get(); if (s.exists) return { ok: true, id: had, task: Object.assign({ id: had }, s.data()), existed: true }; }
    const task = C.rmTaskFromBlock({ uid: this.uid, name: (who && who.name) || '', b, now: Date.now() });
    await this._taskRef(task.id).set(Object.assign({}, task, { createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }));
    await this.ref.set({ rmTasks: { [task.id]: blockId } }, { merge: true });
    return { ok: true, id: task.id, task };
  }
  async updateTask({ u }) {
    const id = String(u.id || ''), pairs = await this._pairs();
    if (!pairs[id]) return { ok: false, error: 'not a task the notebook made' };
    const ref = this._taskRef(id), s = await ref.get();
    if (!s.exists) return { ok: false, error: 'the task is gone from RM' };
    const patch = Object.assign(C.rmTaskPatch(u, Date.now()), { updatedAt: FieldValue.serverTimestamp() });
    await ref.update(patch);
    return { ok: true, id, task: Object.assign({ id }, s.data(), patch, { updatedAt: null }) };
  }
  async getTasks({ ids } = {}) {
    const pairs = await this._pairs(), pick = (ids && ids.length ? ids : Object.keys(pairs)).filter(id => pairs[id]);
    if (!pick.length) return { ok: true, tasks: [] };
    const snaps = await db().getAll(...pick.map(id => this._taskRef(id)));
    return { ok: true, tasks: snaps.filter(s => s.exists).map(s => { const t = s.data() || {}; return { id: s.id, text: t.text, done: !!t.done, done_at: t.done_at || null, due_date: t.due_date, priority: t.priority || 'normal', planned_item_id: t.planned_item_id || null, dismissed_at: t.dismissed_at || null }; }) };
  }
  async syncTasks({ force } = {}) {
    const snap = await this.ref.get(), d = snap.data() || {}, now = Date.now();
    if (!force && d.taskSyncAt && now - tsMs(d.taskSyncAt) < C.TASKSYNC_MS) return { ok: true, skipped: true };
    const pairs = d.rmTasks && typeof d.rmTasks === 'object' ? d.rmTasks : {}, ids = Object.keys(pairs);
    if (!ids.length) { await this.ref.set({ taskSyncAt: FieldValue.serverTimestamp() }, { merge: true }); return { ok: true, paired: 0, blocksUpdated: 0, tasksUpdated: 0, dropped: 0 }; }
    const taskSnaps = await db().getAll(...ids.map(id => this._taskRef(id)));
    const rowSnaps = await db().getAll(...ids.map(id => this.rows.doc(rowDocId('blocks', pairs[id]))));
    const list = ids.map((taskId, i) => ({ taskId, blockId: pairs[taskId], row: rowFromDoc(rowSnaps[i]), task: taskSnaps[i].exists ? Object.assign({ id: taskId }, taskSnaps[i].data()) : null }));
    const st = await this.loadState();
    const plan = C.planTaskSync({ state: st, pairs: list, now });
    if (plan.ops.length) await this.push({ dev: 'rm', conn: null, name: 'RM tasks', ops: plan.ops });
    for (const { id, patch } of plan.patches) { try { await this._taskRef(id).update(Object.assign({}, patch, { updatedAt: FieldValue.serverTimestamp() })); } catch (e) { /* gone */ } }
    const meta = { taskSyncAt: FieldValue.serverTimestamp() };
    for (const id of plan.prune) meta['rmTasks.' + id] = FieldValue.delete();
    await this.ref.update(meta);
    return { ok: true, paired: ids.length - plan.prune.length, blocksUpdated: plan.ops.length, tasksUpdated: plan.patches.length, dropped: plan.prune.length };
  }
  /* ---- V3.927: offline Scientia — task components become RM tasks, desktop papers join the lab library (core: planTaskPairing, planLibraryUp) ---- */
  async syncUp({ force, who } = {}) {
    const snap = await this.ref.get(), d = snap.data() || {}, now = Date.now();
    if (!force && d.upSyncAt && now - tsMs(d.upSyncAt) < C.UPSYNC_MS) return { ok: true, skipped: true };
    await this.ref.set({ upSyncAt: FieldValue.serverTimestamp() }, { merge: true });
    const st = await this.loadState(), ops = [], out = { ok: true, tasks: 0, papers: 0, matched: 0, errors: [] };
    const rowsSnap = await this.rows.where('store', 'in', ['blocks', 'documents', 'projects', 'library']).get();
    const blocks = [], docs = new Map(), projects = new Map(), lib = new Map();
    rowsSnap.docs.forEach(x => { const r = rowFromDoc(x); if (!r || r.deleted || !r.rec) return;
      if (r.store === 'blocks') blocks.push(r.rec); else if (r.store === 'documents') docs.set(String(r.id), r.rec); else if (r.store === 'projects') projects.set(String(r.id), r.rec); else lib.set(C.keyOf('library', r.id), r); });
    const pairs = d.rmTasks && typeof d.rmTasks === 'object' ? d.rmTasks : {};
    for (const b of C.planTaskPairing({ blocks, docs, projects, paired: new Set(Object.values(pairs).map(String)) })) {
      try {
        const r = await this.createTask({ who, b }), rec = blocks.find(x => String(x.id) === b.blockId);
        if (r && r.ok && rec) { ops.push(C.patchOp({ state: st, store: 'blocks', rec, patch: { rmTaskId: r.id } })); out.tasks++; }
      } catch (e) { out.errors.push('task ' + b.blockId + ': ' + (e.message || e)); }
    }
    if (C.libraryUpCandidates(lib).length) {   // the lab library is read only when there is a desktop paper to compare
      const itemsSnap = await db().collection('items').where('type', '==', 'paper').where('meta.library.is_library_entry', '==', true).get();
      const items = itemsSnap.docs.map(x => Object.assign({ id: x.id }, x.data() || {}));
      const plan = C.planLibraryUp({ state: st, rows: lib, items, today: C.todayIn(C.LAB_TZ, now), uid: this.uid, now });
      for (const { rec, doc } of plan.create) {
        try {
          await db().collection('items').doc(doc.id).create(Object.assign({}, doc, { updatedAt: FieldValue.serverTimestamp() }));   // create(): never over an RM paper
          ops.push(C.patchOp({ state: st, store: 'library', rec, patch: { rmSync: { state: 'done', rmId: doc.id, at: C.isoLocal(new Date(now)) } } })); out.papers++;
        } catch (e) { out.errors.push('paper ' + doc.id + ': ' + (e.message || e)); }
      }
      ops.push(...plan.ops); out.matched = plan.ops.length;
    }
    if (ops.length) await this.push({ dev: 'rm', conn: null, name: 'RM sync', ops });
    return out;
  }
  /* ---- V3.927: My Week from a component's ✓ — the steps mirrored for the app's picker; offline ticks reported (core: planWeekSteps, planTickReport) ---- */
  _dayPlans() { return db().collection('userData').doc(this.uid).collection('dayPlans'); }
  _trackerRef(id) { return db().collection('trackerEntries').doc(this.uid).collection('entries').doc(String(id)); }
  async _trackerUpsert({ id, data }) {   // ActivitySignals.upsert: a confirmed or dismissed entry is left alone
    const ref = this._trackerRef(id), snap = await ref.get(), ex = snap.exists ? snap.data() : null;
    if (ex && ex.status && ex.status !== 'pending') return false;
    const entry = Object.assign({}, data, { updatedAt: FieldValue.serverTimestamp() });
    if (ex && ex.status === 'pending') { entry.status = FieldValue.delete(); entry.duration = FieldValue.delete(); entry.auto_hours_estimate = FieldValue.delete(); }
    if (!ex) entry.createdAt = FieldValue.serverTimestamp();
    await ref.set(entry, { merge: true }); return true;
  }
  async syncWeekSteps({ force } = {}) {
    const snap = await this.ref.get(), d = snap.data() || {}, now = Date.now();
    if (!force && d.weekAt && now - tsMs(d.weekAt) < C.MWSTEPS_MS) return { ok: true, skipped: true };
    await this.ref.set({ weekAt: FieldValue.serverTimestamp() }, { merge: true });
    const { from, to } = C.weekWindow(C.todayIn(C.LAB_TZ, now));
    const stepsSnap = await this._dayPlans().where('date', '>=', from).where('date', '<=', to).get();
    const steps = stepsSnap.docs.filter(x => x.id !== '_prefs').map(x => Object.assign({ id: x.id }, x.data() || {}));
    const rowsSnap = await this.rows.where('store', '==', 'mwsteps').get(), rows = new Map();
    rowsSnap.docs.forEach(x => { const r = rowFromDoc(x); if (r && !r.deleted && r.rec) rows.set(C.keyOf('mwsteps', r.id), r); });
    const ops = C.planWeekSteps({ state: await this.loadState(), rows, steps });
    if (ops.length) await this.push({ dev: 'rm', conn: null, name: 'My Week', ops });
    return { ok: true, steps: steps.length, written: ops.length };
  }
  async syncTicks({ who } = {}) {
    const rowsSnap = await this.rows.where('store', '==', 'blocks').get(), blocks = [];
    rowsSnap.docs.forEach(x => { const r = rowFromDoc(x); if (r && !r.deleted && r.rec) blocks.push(r.rec); });
    const pend = C.pendingTicks(blocks); if (!pend.length) return { ok: true, sent: 0 };
    const st = await this.loadState(), byBlock = new Map(), out = { ok: true, sent: 0, failed: 0 }, uid = this.uid;
    for (const { rec, entry } of pend) {
      const res = byBlock.get(rec.id) || new Map(); byBlock.set(rec.id, res);
      const sid = String(entry.stepId), nowIso = new Date().toISOString();
      try {
        const ref = this._dayPlans().doc(sid), ss = await ref.get(), step = ss.exists ? Object.assign({ id: sid }, ss.data()) : null;
        if (!step || step.status === 'cancelled') { res.set(sid, { ok: false, final: true, error: 'That step is no longer in your My Week' }); out.failed++; continue; }
        const plan = C.planTickReport({ step, link: C.tickLink(rec), uid, nowIso });
        await ref.update(plan.patch);
        Object.assign(step, plan.patch);
        if (plan.becameDone) await this._trackerUpsert(C.stepTrackerEntry({ step, uid, scheduled: false }));   // recordDoneWork
        if (plan.becameDone || plan.becameSkipped) {   // cascadeUpdate: the copies RM keeps of the step (task, tracker)
          const dists = Object.assign({}, step.distributions || {});
          if (dists.task && dists.task.status === 'created' && dists.task.docId) {
            try { await db().doc('userData/' + uid + '/tasks/' + dists.task.docId).update(C.stepTaskCopyPatch(step, nowIso, plan.status === 'done')); dists.task = Object.assign({}, dists.task, { status: 'created', lastSyncedAt: nowIso, error: null }); }
            catch (e) { dists.task = Object.assign({}, dists.task, { status: 'failed', error: String(e.message || e) }); }
          }
          if (dists.tracker && dists.tracker.status === 'created' && !(dists.tracker.meta && dists.tracker.meta.native)) {
            try { await this._trackerUpsert(C.stepTrackerEntry({ step, uid, scheduled: true })); dists.tracker = Object.assign({}, dists.tracker, { lastSyncedAt: nowIso, error: null }); }
            catch (e) { dists.tracker = Object.assign({}, dists.tracker, { status: 'failed', error: String(e.message || e) }); }
          }
          if (Object.keys(dists).length) await ref.update({ distributions: dists, updated_at: nowIso });
        }
        res.set(sid, { ok: true, at: nowIso, title: step.title, date: step.date }); out.sent++;
      } catch (e) { res.set(sid, { ok: false, final: false, error: String(e.message || e) }); out.failed++; }
    }
    const ops = [];
    for (const [id, results] of byBlock) { const rec = blocks.find(b => String(b.id) === String(id)); if (rec) ops.push(C.tickAnsweredOp({ state: st, rec, results })); }
    if (ops.length) await this.push({ dev: 'rm', conn: null, name: 'My Week', ops });
    if (out.sent) await this.syncWeekSteps({ force: true });   // the picker shows the steps as they are now
    return out;
  }
  /* ---- V3.874: reminders + chores → My Week; timer sessions + edits → RM's activity tracker ---- */
  async syncWhen({ force, who } = {}) {
    const snap = await this.ref.get(), d = snap.data() || {}, now = Date.now();
    if (!force && d.whenSyncAt && now - tsMs(d.whenSyncAt) < C.WHEN_MS) return { ok: true, skipped: true };
    const rowsSnap = await this.rows.where('store', 'in', ['chores', 'reminders']).get();
    const chores = [], reminders = [];
    rowsSnap.docs.forEach(x => { const r = rowFromDoc(x); if (!r || r.deleted || !r.rec) return; (r.store === 'chores' ? chores : reminders).push(r.rec); });
    const tracked = d.rmWhen && typeof d.rmWhen === 'object' ? d.rmWhen : {}, today = C.todayIn(C.LAB_TZ, now);
    const ids = [...new Set(Object.keys(tracked).concat(C.whenCandidates({ chores, reminders, today }).map(c => c.taskId)))];
    const tasks = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100), snaps = await db().getAll(...part.map(id => this._taskRef(id)));
      snaps.forEach((s, j) => tasks.set(part[j], s.exists ? Object.assign({ id: part[j] }, s.data()) : null));
    }
    const st = stateFromDoc(snap) || await this.loadState();
    const plan = C.planWhen({ state: st, chores, reminders, tracked, tasks, today, uid: this.uid, name: (who && who.name) || d.ownerName || '', now });
    if (plan.ops.length) await this.push({ dev: 'rm', conn: null, name: 'RM My Week', ops: plan.ops });
    for (const doc of plan.creates) {
      try { await this._taskRef(doc.id).create(Object.assign({}, doc, { createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })); }
      catch (e) { if (e.code !== 6 && !/already exists/i.test(String(e.message || ''))) throw e; }
    }
    for (const { id, patch } of plan.patches) { try { await this._taskRef(id).update(Object.assign({}, patch, { updatedAt: FieldValue.serverTimestamp() })); } catch (e) { /* gone */ } }
    const meta = { whenSyncAt: FieldValue.serverTimestamp() };
    if (who && who.name && who.kind === 'browser') meta.ownerName = String(who.name);
    for (const [id, ref] of Object.entries(plan.track)) meta['rmWhen.' + id] = ref;
    for (const id of plan.untrack) meta['rmWhen.' + id] = FieldValue.delete();
    await this.ref.update(meta);
    return { ok: true, created: plan.creates.length, tasksUpdated: plan.patches.length, notebookUpdated: plan.ops.length, tracked: Object.keys(tracked).length + Object.keys(plan.track).length - plan.untrack.length };
  }
  async syncActivity({ force } = {}) {
    const snap = await this.ref.get(), d = snap.data() || {}, now = Date.now();
    if (!force && d.actSyncAt && now - tsMs(d.actSyncAt) < C.ACT_MS) return { ok: true, skipped: true };
    const st = stateFromDoc(snap) || await this.loadState(), today = C.todayIn(C.LAB_TZ, now), from = C.addDays_(today, -C.ACT_DAYS);
    const cursor = d.actCursor || 0, latest = new Map(); let nextCursor = st.seq;
    if (cursor && cursor >= (st.minSeq || 0)) {
      const opsSnap = await this.ops.where('seq', '>', cursor).orderBy('seq').limit(2000).get();
      opsSnap.docs.forEach(x => { const o = opFromDoc(x.data() || {}); if (o.store === 'sessions' || o.store === 'documents') latest.set(o.store + '/' + o.id, { store: o.store, rec: o.del ? null : o.rec }); });
      if (opsSnap.size === 2000) nextCursor = opsSnap.docs[opsSnap.size - 1].data().seq;
    } else {
      for (const store of ['sessions', 'documents']) { const rs = await this.rows.where('store', '==', store).get(); rs.docs.forEach(x => { const r = rowFromDoc(x); if (r && !r.deleted && r.rec) latest.set(store + '/' + r.id, { store, rec: r.rec }); }); }
    }
    const groups = C.activityGroups({ changes: [...latest.values()], today, from });
    if (!groups.size) { await this.ref.set({ actCursor: nextCursor, actSyncAt: FieldValue.serverTimestamp() }, { merge: true }); return { ok: true, events: 0 }; }
    const docIds = [...new Set([...groups.values()].map(g => g.docId))], docs = new Map();
    for (const [k, v] of latest) if (v.store === 'documents' && v.rec) docs.set(String(v.rec.id), v.rec);
    const need = docIds.filter(id => !docs.has(id));
    for (let i = 0; i < need.length; i += 100) { const part = need.slice(i, i + 100), snaps = await db().getAll(...part.map(id => this.rows.doc(rowDocId('documents', id)))); snaps.forEach((s, j) => { const r = rowFromDoc(s); if (r && r.rec) docs.set(part[j], r.rec); }); }
    const entries = db().collection('trackerEntries').doc(this.uid).collection('entries'), ids = [...groups.keys()], existing = new Map();
    for (let i = 0; i < ids.length; i += 100) { const part = ids.slice(i, i + 100), snaps = await db().getAll(...part.map(id => entries.doc(id))); snaps.forEach((s, j) => existing.set(part[j], s.exists ? s.data() : null)); }
    const writes = C.planActivity({ groups, docs, existing });
    for (const w of writes) await entries.doc(w.id).set(Object.assign({}, w.data, { updatedAt: FieldValue.serverTimestamp() }, w.isNew ? { createdAt: FieldValue.serverTimestamp() } : {}), { merge: true });
    await this.ref.set({ actCursor: nextCursor, actSyncAt: FieldValue.serverTimestamp() }, { merge: true });
    return { ok: true, events: writes.length };
  }
  /* ---- V3.875: RM highlights for a paper card — what the rules would let this person read ---- */
  async annotations({ paperId }) {
    const snap = await db().collection('papers').doc(String(paperId)).collection('annotations').limit(1000).get();
    const items = C.visibleAnnotations(snap.docs.map(x => Object.assign({ id: x.id }, x.data() || {})), this.uid);
    return { ok: true, paperId: String(paperId), total: items.length, items: items.slice(0, 300) };
  }
  /* ---- V3.877: RM protocols (list by field selection; one protocol in full) and the person's collections ---- */
  async protocols({ q, id } = {}) {
    if (id) {
      const s = await db().collection('protocols').doc(String(id)).get();
      return s.exists ? { ok: true, protocol: C.rmProtocolSteps(Object.assign({ id: s.id }, s.data() || {})) } : { ok: false, error: 'no such protocol' };
    }
    const snap = await db().collection('protocols').select('title', 'status', 'category', 'current_version', 'updated_at').get();
    const items = C.searchProtocols(snap.docs.map(x => C.rmProtocolRow(Object.assign({ id: x.id }, x.data() || {}))), q);
    return { ok: true, total: items.length, items: items.slice(0, 100) };
  }
  async collections({ id } = {}) {
    const coll = db().collection('userData').doc(this.uid).collection('litReviews');
    if (id) { const s = await coll.doc(String(id)).get(); return s.exists ? { ok: true, collection: C.rmCollectionFull(Object.assign({ id: s.id }, s.data() || {})) } : { ok: false, error: 'no such collection' }; }
    const snap = await coll.get();
    const items = snap.docs.map(x => C.rmCollectionRow(Object.assign({ id: x.id }, x.data() || {}))).filter(r => r.id).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    return { ok: true, total: items.length, items };
  }
  /* ---- V3.880: what the PI assigned this person in RM → this hub's `projects` / `themes` rows, device 'rm' ---- */
  async syncProjects({ force } = {}) {
    const d = (await this.ref.get()).data() || {}, now = Date.now();
    if (!force && d.projSyncAt && now - tsMs(d.projSyncAt) < C.PROJECTS_MS) return { ok: true, skipped: true };
    const [fociSnap, projSnap] = await Promise.all([
      db().collection('researchFoci').where('member_uids', 'array-contains', this.uid).get(),
      db().collection('projects').where('member_uids', 'array-contains', this.uid).get()]);
    const foci = fociSnap.docs.map(x => Object.assign({}, x.data() || {}, { id: x.id }));
    const parentIds = [...new Set(foci.flatMap(f => ['specialty_ids', 'concept_ids', 'grant_ids', 'aim_ids'].flatMap(k => (f.links && Array.isArray(f.links[k]) ? f.links[k] : []).map(String))))].filter(id => !foci.some(f => f.id === id));
    const parents = parentIds.length ? (await Promise.all(parentIds.slice(0, 30).map(id => db().collection('researchFoci').doc(id).get()))).filter(x => x.exists).map(x => ({ id: x.id, title: (x.data() || {}).title || x.id })) : [];
    const projects = projSnap.docs.map(x => Object.assign({}, x.data() || {}, { id: x.id }));
    const rows = new Map();
    const [pr, th] = await Promise.all([this.rows.where('store', '==', 'projects').get(), this.rows.where('store', '==', 'themes').get()]);
    pr.docs.concat(th.docs).forEach(x => { const r = rowFromDoc(x); if (r && !r.deleted && r.rec) rows.set(C.keyOf(r.store, r.id), r); });
    const st = await this.loadState();
    const plan = C.planAssigned({ state: st, rows, assigned: C.rmAssigned({ foci: foci.concat(parents), projects, uid: this.uid }), now });
    if (plan.ops.length) await this.push({ dev: 'rm', conn: null, name: 'RM projects', ops: plan.ops });
    await this.ref.set({ projSyncAt: FieldValue.serverTimestamp(), projN: plan.projects, projWritten: plan.ops.length }, { merge: true });
    return { ok: true, projects: plan.projects, themes: plan.themes, written: plan.ops.length, removed: plan.removed };
  }
  /* ---- V3.880: notes filed under RM work → `scientiaNotes/{uid}__{docId}`, read by RM's research and project pages ---- */
  async syncNotes({ force } = {}) {
    const snap = await this.ref.get(), d = snap.data() || {}, now = Date.now();
    if (!force && d.noteSyncAt && now - tsMs(d.noteSyncAt) < C.NOTES_MS) return { ok: true, skipped: true };
    const st = stateFromDoc(snap) || await this.loadState(), cursor = d.noteCursor || 0, index = db().collection('scientiaNotes');
    let nextCursor = st.seq, full = !(cursor && cursor >= (st.minSeq || 0));
    const docs = new Map(), viaBlocks = new Set(), existing = new Map();
    if (!full) {
      const opsSnap = await this.ops.where('seq', '>', cursor).orderBy('seq').limit(2000).get();
      opsSnap.docs.forEach(x => { const o = opFromDoc(x.data() || {});
        if (o.store === 'projects' || o.store === 'themes') full = true;
        else if (o.store === 'documents') docs.set(String(o.id), o.del ? null : o.rec);
        else if (o.store === 'blocks' && o.rec && o.rec.docId) viaBlocks.add(String(o.rec.docId)); });
      if (opsSnap.size === 2000) nextCursor = opsSnap.docs[opsSnap.size - 1].data().seq;
    }
    const getRows = async (store, ids) => { const out = new Map(); for (let i = 0; i < ids.length; i += 100) { const part = ids.slice(i, i + 100), snaps = await db().getAll(...part.map(id => this.rows.doc(rowDocId(store, id)))); snaps.forEach((s, j) => { const r = rowFromDoc(s); out.set(part[j], r && !r.deleted ? r.rec : null); }); } return out; };
    if (full) {
      docs.clear(); viaBlocks.clear();
      (await this.rows.where('store', '==', 'documents').get()).docs.forEach(x => { const r = rowFromDoc(x); if (r && !r.deleted && r.rec) docs.set(String(r.id), r.rec); });
      (await index.where('ownerUid', '==', this.uid).get()).docs.forEach(x => { const v = x.data() || {}; existing.set(x.id, v); if (v.docId && !docs.has(String(v.docId))) docs.set(String(v.docId), null); });
    } else {
      const need = [...viaBlocks].filter(id => !docs.has(id));
      if (need.length) for (const [id, rec] of await getRows('documents', need)) docs.set(id, rec);
      const ids = [...docs.keys()];
      for (let i = 0; i < ids.length; i += 100) { const part = ids.slice(i, i + 100), snaps = await db().getAll(...part.map(id => index.doc(C.noteIndexId(this.uid, id)))); snaps.forEach((s, j) => existing.set(C.noteIndexId(this.uid, part[j]), s.exists ? s.data() : null)); }
    }
    const projects = new Map(), themes = new Map();
    const [pr, th] = await Promise.all([this.rows.where('store', '==', 'projects').get(), this.rows.where('store', '==', 'themes').get()]);
    pr.docs.forEach(x => { const r = rowFromDoc(x); if (r && !r.deleted && r.rec) projects.set(String(r.id), r.rec); });
    th.docs.forEach(x => { const r = rowFromDoc(x); if (r && !r.deleted && r.rec) themes.set(String(r.id), r.rec); });
    // a shared note's preview needs its components
    const shared = [...docs.values()].filter(x => x && x.share === 'lab' && C.noteProjects(x, projects).length);   // V3.889: a review's linked projects too
    const blockIds = [...new Set(shared.flatMap(x => (x.blockIds || []).slice(0, 60).map(String)))], blocks = blockIds.length ? await getRows('blocks', blockIds) : new Map();
    let ownerName = d.ownerName || '';
    if (!ownerName) { const u = await db().collection('users').doc(this.uid).get(); const ud = u.exists ? (u.data() || {}) : {}; ownerName = String(ud.name || ud.displayName || ud.email || ''); }
    const plan = C.planNoteLinks({ uid: this.uid, ownerName, docs, projects, themes, existing, blocksOf: x => (x.blockIds || []).map(id => blocks.get(String(id))).filter(Boolean) });
    const writes = plan.sets.map(w => ({ ref: index.doc(w.id), data: Object.assign({}, w.data, { updatedAt: FieldValue.serverTimestamp() }) })).concat(plan.dels.map(id => ({ ref: index.doc(id), del: true })));
    for (let i = 0; i < writes.length; i += 400) { const b = db().batch(); writes.slice(i, i + 400).forEach(w => w.del ? b.delete(w.ref) : b.set(w.ref, w.data)); await b.commit(); }
    await this.ref.set({ noteCursor: nextCursor, noteSyncAt: FieldValue.serverTimestamp(), ownerName }, { merge: true });
    return { ok: true, full, linked: plan.linked, written: plan.sets.length, removed: plan.dels.length };
  }
  /** One read of the hub doc decides which throttled syncs are due (every pull calls this). */
  async quietSyncs(who, { force, only } = {}) {
    const d = (await this.ref.get()).data() || {}, now = Date.now(), out = {};
    const due = (name, k, ms) => (!only || only.includes(name)) && (force || !d[k] || now - tsMs(d[k]) >= ms);
    const run = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = { ok: false, error: String(e.message || e) }; } };
    if (due('library', 'mirrorAt', C.MIRROR_MS)) await run('library', () => this.mirrorLibrary({ force: true }));
    if (due('up', 'upSyncAt', C.UPSYNC_MS)) await run('up', () => this.syncUp({ force: true, who }));   // V3.927, before the task reconcile
    if (due('week', 'weekAt', C.MWSTEPS_MS)) await run('week', () => this.syncWeekSteps({ force: true }));   // V3.927
    if (due('ticks', 'tickAt', 5 * 60 * 1000)) await run('ticks', async () => { await this.ref.set({ tickAt: FieldValue.serverTimestamp() }, { merge: true }); return this.syncTicks({ who }); });   // V3.927
    if (due('tasks', 'taskSyncAt', C.TASKSYNC_MS)) await run('tasks', () => this.syncTasks({ force: true }));
    if (due('when', 'whenSyncAt', C.WHEN_MS)) await run('when', () => this.syncWhen({ force: true, who }));
    if (due('activity', 'actSyncAt', C.ACT_MS)) await run('activity', () => this.syncActivity({ force: true }));
    if (due('projects', 'projSyncAt', C.PROJECTS_MS)) await run('projects', () => this.syncProjects({ force: true }));
    if (due('notes', 'noteSyncAt', C.NOTES_MS)) await run('notes', () => this.syncNotes({ force: true }));
    if (due('shares', 'shareSyncAt', 10 * 60 * 1000)) await run('shares', async () => { await this.ref.set({ shareSyncAt: FieldValue.serverTimestamp() }, { merge: true }); return SH.syncShares(shareEnv(), this.uid, { force: !!(force && only && only.includes('shares')) }); });
    return out;
  }
  /* ---- V3.899: who can be given a share (RM's people pickers: not guests, hidden, collaborators or alumni) ---- */
  async members() {
    const m = await SHF.labMembers(db), out = [];
    for (const [uid, x] of m) if (uid !== this.uid) out.push({ uid, name: x.name, category: x.category });
    return { ok: true, members: out.sort((a, b) => a.name.localeCompare(b.name)) };
  }
  /* ---- V3.932: deletions in a share waiting for a person (scientia-share-core.js holdDeletes / decide) ---- */
  async sharesPending() { return SH.pendingFor(shareEnv(), this.uid); }
  async sharesDecide({ share, pid, pick }) { return SH.decide(shareEnv(), this.uid, String(share || ''), String(pid || ''), pick); }
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

/** V3.928 — pairing codes (core: pairCode, pairRefusal): scientiaPairs/{sha(code)} = { uid, account, exp, used }. A claim
 *  marks its code used in a transaction, so a code makes at most one key. */
const firestorePairs = {
  async make({ uid }) {
    const code = C.pairCode(), exp = Date.now() + C.PAIR_MS, u = (await db().doc('users/' + uid).get()).data() || {};
    const account = { name: String(u.name || u.displayName || ''), email: String(u.email || '') };
    await db().collection('scientiaPairs').doc(C.sha(C.normPairCode(code))).set({ uid, account, exp, used: false, created: FieldValue.serverTimestamp() });
    return { ok: true, code, exp, account };
  },
  async claim({ code, name }) {
    const ref = db().collection('scientiaPairs').doc(C.sha(C.normPairCode(code)));
    const rec = await db().runTransaction(async t => {
      const snap = await t.get(ref), r = snap.exists ? snap.data() : null;
      if (C.pairRefusal(r, Date.now())) return { refused: C.pairRefusal(r, Date.now()) };
      t.update(ref, { used: true, usedAt: FieldValue.serverTimestamp() }); return r;
    });
    if (rec.refused) return { ok: false, error: rec.refused };
    const k = await new FirestoreHub(rec.uid).keyMake(String(name || 'My computer').slice(0, 40));
    return { ok: true, key: 'sck_' + rec.uid + '_' + k.secret, keyId: k.id, account: rec.account };
  }
};

/** V3.899 — the Share / Collaborate relay's storage (scientia-share.js), one per request. */
function shareEnv() { return SHF.firestoreEnv({ db, FieldValue, FirestoreHub, rowDocId, rowFromDoc }); }
const RELAY_PATHS = new Set(['/api/sync/push', '/api/sync/resolve', '/api/media']);

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
  if (path === '/') { res.status(200).json({ ok: true, service: 'scientiaHub', version: 'V3.932' }); return; }
  let who = null;
  try { who = await resolveWho(req); }
  catch (e) { res.status(401).json({ ok: false, error: 'invalid token: ' + e.message }); return; }
  if (who && who.error) { res.status(who.error).json({ ok: false, error: who.msg }); return; }
  if (!who && path !== '/api/sync/hello' && path !== '/api/cloud/pair/claim') { res.status(401).json({ ok: false, error: 'not signed in' }); return; }
  const hub = who ? (who.hub || new FirestoreHub(who.uid)) : null;
  try {
    const out = await C.route({ method: req.method, path, query: req.query || {}, body: req.body, rawBody: req.rawBody || null, headers: req.headers || {} }, { hub, who, pairs: firestorePairs });
    // V3.899 — what was just written to this person's hub reaches the people it is shared with (or its owner)
    if (who && out.status === 200 && RELAY_PATHS.has(path)) {
      try {
        if (path === '/api/media') { if (out.body && out.body.path) await SH.relayMedia(shareEnv(), who.uid, out.body.path); }
        else if (hub.lastCommits && hub.lastCommits.length) await SH.relayPush(shareEnv(), who.uid, hub.lastCommits);
      } catch (e) { console.error('[scientiaHub] share relay', path, e); }
    }
    res.status(out.status).json(out.body);
  } catch (e) {
    console.error('[scientiaHub]', path, e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

module.exports = { scientiaHub, FirestoreHub, resolveWho, shareEnv };
