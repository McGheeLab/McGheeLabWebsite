/* ================================================================
   scientia-share.js — V3.899 — the Share / Collaborate relay on Firestore
   ================================================================
   The storage half of scientia-share-core.js (which does all the
   deciding): each person's hub through FirestoreHub, the index and the
   shadows under one function-only collection (no client rule reads or
   writes it):

     scientiaShares/{ownerUid}__{d|p}__{recId}
        ownerUid, ownerName, kind, recId, title, members {uid: role},
        memberUids, names, asked, docIds, blockIds, themeIds, mediaIds,
        projectId, passAt, lockUntil, dirty
     scientiaShares/{id}/shadow/{uid}__{store}__{id}
        uid, store, id, recJson, ownerSeq      (the copy last given)

   Used by scientia-hub.js: after a push / resolve / media upload
   (relayPush, relayMedia) and from quietSyncs (syncShares).
   ================================================================ */
'use strict';

const S = require('./scientia-share-core');
const { keyOf } = require('./scientia-hub-core');

const CACHE_MS = 3 * 1000, MEMBERS_MS = 5 * 60 * 1000;
const NOT_LISTED = new Set(['collaborator', 'alumni']);

/** One env per request: hubs are made once each. deps = { db, FieldValue, FirestoreHub, rowDocId, rowFromDoc }. */
function firestoreEnv(deps) {
  const { db, FieldValue, FirestoreHub, rowDocId, rowFromDoc } = deps, coll = () => db().collection('scientiaShares'), hubs = new Map();
  const shadowId = (uid, store, id) => uid + '__' + rowDocId(store, id);
  const fromShadow = d => { let rec = null; try { rec = d.recJson ? JSON.parse(d.recJson) : null; } catch (e) { rec = null; } return { uid: d.uid, store: d.store, id: String(d.id), rec, ownerSeq: d.ownerSeq || 0 }; };
  const getAll = async refs => { const out = []; for (let i = 0; i < refs.length; i += 300) out.push(...await db().getAll(...refs.slice(i, i + 300))); return out; };
  const batched = async (list, fn) => { for (let i = 0; i < list.length; i += 400) { const b = db().batch(); list.slice(i, i + 400).forEach(x => fn(b, x)); await b.commit(); } };
  const env = {
    now: () => Date.now(),
    members: () => labMembers(db),
    async nameOf(uid) { const m = await labMembers(db); if (m.has(uid)) return m.get(uid).name; const u = await db().collection('users').doc(uid).get(); const d = u.exists ? (u.data() || {}) : {}; return String(d.name || d.displayName || d.email || ''); },
    hub(uid) {
      if (hubs.has(uid)) return hubs.get(uid);
      const h = new FirestoreHub(uid), api = {
        async rowsOf(store) { return (await h.rows.where('store', '==', store).get()).docs.map(rowFromDoc).filter(r => r && !r.deleted); },
        async rowsGet(keys) {
          const m = new Map(), snaps = await getAll(keys.map(k => h.rows.doc(rowDocId(k.store, k.id))));
          snaps.forEach((s, i) => { const r = rowFromDoc(s); m.set(keyOf(keys[i].store, keys[i].id), r || null); });
          return m;
        },
        async push(a) { const result = await h.push(a); return { result, commits: h.lastCommits || [] }; },
        async mediaFiles(paths) {
          const m = new Map(), snaps = await getAll(paths.map(p => h.media.doc(encodeURIComponent(p))));
          snaps.forEach((s, i) => { if (s.exists) { const d = s.data() || {}; if (d.url) m.set(paths[i], { path: paths[i], url: d.url, bytes: d.bytes || 0, mime: d.mime || '' }); } });
          return m;
        },
        async mediaCopy(docs) {   // the download-token URL works for whoever holds it: the bytes stay where they are
          await batched(docs, (b, d) => b.set(h.media.doc(encodeURIComponent(d.path)), { path: d.path, url: d.url, bytes: d.bytes || 0, mime: d.mime || '', shared: true, created: FieldValue.serverTimestamp() }, { merge: true }));
        },
      };
      hubs.set(uid, api); return api;
    },
    index: {
      async get(id) { const s = await coll().doc(id).get(); return s.exists ? Object.assign({}, s.data(), { id }) : null; },
      async put(id, d) {
        const o = Object.assign({}, d); delete o.id;
        await coll().doc(id).set(Object.assign(o, { updatedAt: FieldValue.serverTimestamp() }), { mergeFields: Object.keys(o).concat(['updatedAt']) });   // whole maps replaced, the lease kept
        cacheClear();
      },
      async del(id) {
        const ref = coll().doc(id), sh = await ref.collection('shadow').listDocuments();
        await batched(sh, (b, r) => b.delete(r)); await ref.delete(); cacheClear();
      },
      owned: uid => cached('o' + uid, async () => (await coll().where('ownerUid', '==', uid).get()).docs.map(s => Object.assign({}, s.data(), { id: s.id }))),
      memberOf: uid => cached('m' + uid, async () => (await coll().where('memberUids', 'array-contains', uid).get()).docs.map(s => Object.assign({}, s.data(), { id: s.id }))),
      lease(id, ms) {
        return db().runTransaction(async t => {
          const ref = coll().doc(id), s = await t.get(ref), d = s.exists ? (s.data() || {}) : {}, now = Date.now();
          if (d.lockUntil && d.lockUntil > now) { t.set(ref, { dirty: true }, { merge: true }); return false; }
          t.set(ref, { lockUntil: now + ms, dirty: false }, { merge: true }); return true;
        });
      },
      release(id) {
        return db().runTransaction(async t => {
          const ref = coll().doc(id), s = await t.get(ref); if (!s.exists) return false;
          const d = s.data() || {}, dirty = !!d.dirty;
          if (!d.ownerUid) t.delete(ref); else t.update(ref, { lockUntil: 0, dirty: false });
          return dirty;
        });
      },
      async addIds(id, grow) {
        const u = {}; for (const [k, v] of Object.entries(grow)) if (v.length) u[k] = FieldValue.arrayUnion(...v);
        if (Object.keys(u).length) { await coll().doc(id).update(u); cacheClear(); }
      },
      async shadows(id, uid) {
        const m = new Map(); (await coll().doc(id).collection('shadow').where('uid', '==', uid).get()).docs.forEach(s => { const x = fromShadow(s.data() || {}); m.set(keyOf(x.store, x.id), x); });
        return m;
      },
      async shadowsGet(id, uid, keys) {
        const m = new Map(), c = coll().doc(id).collection('shadow'), snaps = await getAll(keys.map(k => c.doc(shadowId(uid, k.store, k.id))));
        snaps.forEach((s, i) => { if (s.exists) m.set(keyOf(keys[i].store, keys[i].id), fromShadow(s.data() || {})); });
        return m;
      },
      async shadowPut(id, uid, list) {
        const c = coll().doc(id).collection('shadow');
        await batched(list, (b, x) => b.set(c.doc(shadowId(uid, x.store, x.id)), { uid, store: x.store, id: String(x.id), recJson: JSON.stringify(x.rec), ownerSeq: x.ownerSeq || 0 }));
      },
      async shadowDel(id, uid, keys) { const c = coll().doc(id).collection('shadow'); await batched(keys, (b, k) => b.delete(c.doc(shadowId(uid, k.store, k.id)))); },
      async shadowHas(id, store, rid) { return !(await coll().doc(id).collection('shadow').where('store', '==', store).where('id', '==', String(rid)).limit(1).get()).empty; },
    },
  };
  return env;
}

/* the share lists are read on every push: kept a few seconds per instance (a pass clears them) */
const CACHE = new Map();
function cacheClear() { CACHE.clear(); }
async function cached(k, fn) { const c = CACHE.get(k); if (c && Date.now() - c.at < CACHE_MS) return c.v; const v = await fn(); CACHE.set(k, { at: Date.now(), v }); return v; }

let MEMBERS = null;
/** Lab members anyone may share with: not a guest, not hidden, not a collaborator or alumni (RM's people pickers). */
async function labMembers(db) {
  if (MEMBERS && Date.now() - MEMBERS.at < MEMBERS_MS) return MEMBERS.v;
  const m = new Map();
  (await db().collection('users').get()).docs.forEach(s => {
    const d = s.data() || {}; if (!d.role || d.role === 'guest' || d.hidden || NOT_LISTED.has(d.category)) return;
    m.set(s.id, { name: String(d.name || d.displayName || d.email || 'A lab member'), category: String(d.category || '') });
  });
  MEMBERS = { at: Date.now(), v: m };
  return m;
}

module.exports = { firestoreEnv, labMembers, cacheClear };
