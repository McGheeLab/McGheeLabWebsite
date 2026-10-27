#!/usr/bin/env node
/* restore-share.js — find a shared Scientia project that disappeared, say what removed it, and put it back (V3.931).

   node scripts/scientia-project/restore-share.js --name "Our lab development"            # read only: the trace + the plan
   node scripts/scientia-project/restore-share.js --name "Our lab development" --commit   # writes it back to the owner, then the share

   The trace, for every hub that ever held the project: the share index (scientiaShares), the hub's replacedAt (a desktop's
   "this computer wins" replaces the whole hub — rows AND op log, no tombstones), the copies kept before each replace
   (Storage scientia/<uid>/kept/before-replace-*.json), the computers paired to the account (hub keys: created, last
   seen), and the project's rows now (live / tombstone + the device that wrote it / gone).

   The source for the restore, best first: the owner's newest kept copy that holds the project (the whole record before a
   replace) → the share's shadows (the copies last given to members) → op logs (the last version each hub saw of each
   record). The closure is the project, its themes, aims, terms, notes, their components, wires, structures and media.
   --commit pushes to the owner's hub, as device "restore", every record of it that is gone or a tombstone there (a live
   record is left as it is), with the grants put back on the project, then runs the share pass so each member gets
   their copy again. Needs scripts/service-account.json.
*/
'use strict';
require('net').setDefaultAutoSelectFamilyAttemptTimeout(3000);
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2), opt = k => { const i = argv.indexOf(k); return i < 0 ? null : argv[i + 1]; };
const NAME = opt('--name'), PID = opt('--project'), COMMIT = argv.includes('--commit');
if (!NAME && !PID) { console.error('usage: restore-share.js --name "<project name>" | --project <id> [--commit]'); process.exit(2); }
const admin = require(ROOT + '/functions/node_modules/firebase-admin');
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(require(ROOT + '/scripts/service-account.json')), storageBucket: 'mcgheelab-f56cc.firebasestorage.app' });
const { FirestoreHub, shareEnv } = require(ROOT + '/functions/scientia-hub.js');
const C = require(ROOT + '/functions/scientia-hub-core.js'), S = require(ROOT + '/functions/scientia-share-core.js');
const db = admin.firestore(), bucket = admin.storage().bucket();
const iso = v => v && v.toDate ? v.toDate().toISOString() : (typeof v === 'number' ? new Date(v).toISOString() : (v || '?'));
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const matches = rec => isObj(rec) && (PID ? String(rec.id) === PID : norm(rec.name || rec.title) === norm(NAME));

(async () => {
  // 1. every hub; the project wherever it shows (live rows, then the op log for what is gone)
  const hubs = (await db.collectionGroup('scientia').get()).docs.filter(d => d.id === 'hub').map(d => ({ uid: d.ref.parent.parent.id, st: d.data(), ref: d.ref }));
  const names = new Map(); for (const u of (await db.collection('users').get()).docs) { const d = u.data() || {}; names.set(u.id, d.name || d.displayName || d.email || u.id); }
  const who = uid => (names.get(uid) || '?') + ' (' + uid + ')';
  const seen = [];   // {uid, rec, from: 'row'|'op', seq, dev, name, at}
  for (const h of hubs) {
    for (const s of (await h.ref.collection('rows').where('store', '==', 'projects').get()).docs) { const r = s.data(); let rec = null; try { rec = r.recJson ? JSON.parse(r.recJson) : null; } catch (e) { /* skip */ }
      if (matches(rec) || (PID && r.id === PID)) seen.push({ uid: h.uid, rec, from: 'row', deleted: !!r.deleted, seq: r.seq, dev: r.dev, name: r.name, at: iso(r.updated), id: r.id }); }
    for (const s of (await h.ref.collection('ops').where('store', '==', 'projects').get()).docs) { const o = s.data(); let rec = null; try { rec = o.recJson ? JSON.parse(o.recJson) : null; } catch (e) { /* skip */ }
      if (matches(rec) || (PID && o.id === PID)) seen.push({ uid: h.uid, rec, from: 'op', deleted: !!o.del, seq: o.seq, dev: o.dev, name: o.name, at: iso(o.ts), id: o.id }); }
  }
  const shares = (await db.collection('scientiaShares').where('kind', '==', 'project').get()).docs.map(d => Object.assign({ id: d.id }, d.data())).filter(x => norm(x.title) === norm(NAME) || (PID && x.recId === PID) || seen.some(s => s.id === x.recId));
  const id = PID || (seen.find(s => s.rec) || {}).id || (shares[0] || {}).recId;
  // the owner: the hub whose copy carries no sharedFrom; else the one a copy names
  const own = seen.find(s => s.rec && !s.rec.sharedFrom), copy = seen.find(s => s.rec && isObj(s.rec.sharedFrom));
  const owner = (shares[0] && shares[0].ownerUid) || (own && own.uid) || (copy && copy.rec.sharedFrom.uid);
  if (!id || !owner) { console.log('No project matching', NAME || PID, 'in any hub, op log or share index.'); process.exit(1); }
  console.log(`project ${id}; owner ${who(owner)}`);

  // 2. the trace
  console.log('\nshare index:'); if (!shares.length) console.log('  (none — the pass drops it, with its shadows, when the project is gone or unshared)');
  for (const x of shares) console.log(`  ${x.id}: members ${JSON.stringify(x.members)} asked ${JSON.stringify(x.asked)}; ${(x.docIds || []).length} notes; last pass ${iso(x.passAt)}`);
  const grants = Object.assign({}, ...seen.filter(s => s.uid === owner && s.rec && isObj(s.rec.shareWith)).map(s => s.rec.shareWith), ...shares.map(x => x.asked || x.members || {}));
  const involved = [...new Set([owner, ...Object.keys(grants), ...seen.map(s => s.uid)])];
  for (const uid of involved) {
    const h = hubs.find(x => x.uid === uid); if (!h) continue;
    console.log(`\n${who(uid)}${uid === owner ? ' — OWNER' : ''}: hub seq ${h.st.seq}, ${h.st.records} records, replacedAt ${iso(h.st.replacedAt)}, sid ${h.st.sid}`);
    for (const k of (await h.ref.collection('keys').get()).docs) { const d = k.data() || {}; console.log(`  computer key "${d.name}": created ${iso(d.created)}, last seen ${iso(d.lastSeen)}`); }
    const [files] = await bucket.getFiles({ prefix: 'scientia/' + uid + '/kept/' });
    for (const f of files) console.log(`  kept copy ${path.basename(f.name)} (${f.metadata.size} bytes)`);
    for (const s of seen.filter(x => x.uid === uid).sort((a, b) => (a.seq || 0) - (b.seq || 0))) console.log(`  ${s.from} seq ${s.seq}: ${s.deleted ? 'DELETED' : 'live'} by ${s.name || '-'} [${s.dev || '-'}] at ${s.at}${s.rec && s.rec.sharedFrom ? ' (a copy)' : ''}`);
    if (!seen.some(x => x.uid === uid && x.from === 'row')) console.log('  no row at all now (a replace removes rows without a tombstone)');
  }

  // 3. the source: the owner's newest kept copy holding the project, then shadows, then op logs
  let rows = null, source = '';
  const [kept] = await bucket.getFiles({ prefix: 'scientia/' + owner + '/kept/' });
  for (const f of kept.sort((a, b) => b.name.localeCompare(a.name))) {
    let st; try { st = JSON.parse((await f.download())[0].toString('utf8')); } catch (e) { continue; }
    const r = {}; for (const [store, list] of Object.entries(st.stores || {})) { const m = new Map(); for (const rec of list || []) if (isObj(rec) && rec.id != null && !rec.deleted) m.set(String(rec.id), rec); r[store] = m; }
    if (r.projects && r.projects.get(id)) { rows = r; source = 'kept copy ' + path.basename(f.name); break; }
  }
  const fromList = (list, label) => { const r = {}; for (const x of list) { if (!isObj(x.rec)) continue; (r[x.store] = r[x.store] || new Map()).set(String(x.id), S.stripMark(x.rec)); } if (r.projects && r.projects.get(id)) { rows = r; source = label; } };
  if (!rows) for (const x of shares) { const sh = await db.collection('scientiaShares').doc(x.id).collection('shadow').get(); const list = sh.docs.map(d => { const v = d.data(); let rec = null; try { rec = JSON.parse(v.recJson); } catch (e) { /* skip */ } return { store: v.store, id: v.id, rec }; }); fromList(list, 'share shadows'); if (rows) break; }
  if (!rows) {   // the op logs: the last version of each record any involved hub saw
    const last = new Map();
    for (const uid of [owner].concat(involved.filter(u => u !== owner))) { const h = hubs.find(x => x.uid === uid); if (!h) continue;
      for (const s of (await h.ref.collection('ops').orderBy('seq').get()).docs) { const o = s.data(); if (!o.recJson) continue; const k = C.keyOf(o.store, o.id); if (last.has(k) && last.get(k).uid === owner && uid !== owner) continue; try { last.set(k, { uid, store: o.store, id: o.id, rec: JSON.parse(o.recJson) }); } catch (e) { /* skip */ } } }
    fromList([...last.values()], 'op logs');
  }
  if (!rows) { console.log('\nNo copy of the project survives in a kept file, the share shadows or the op logs. The computers that synced it (Scientia desktop notebook folders: .scientia/record.json and backup/) are the last place to look.'); process.exit(1); }
  const c = S.closure({ kind: 'project', recId: id, rows });
  const byStore = {}; for (const x of c.recs.values()) byStore[x.store] = (byStore[x.store] || 0) + 1;
  console.log(`\nsource: ${source} — ${c.recs.size} records ${JSON.stringify(byStore)}`);

  // 4. what the owner's hub lacks
  const hub = new FirestoreHub(owner), st = await hub.loadState();
  const keys = [...c.recs.values()].map(x => ({ store: x.store, id: x.id }));
  const snaps = []; for (let i = 0; i < keys.length; i += 300) snaps.push(...await db.getAll(...keys.slice(i, i + 300).map(k => hub.rows.doc(k.store + '__' + encodeURIComponent(String(k.id)).replace(/\./g, '%2E')))));
  const ops = []; let live = 0;
  snaps.forEach((s, i) => {
    const x = c.recs.get(C.keyOf(keys[i].store, keys[i].id)), d = s.exists ? s.data() : null;
    let rec = S.stripMark(x.rec);
    if (x.store === 'projects' && String(x.id) === id) rec = Object.assign({}, rec, { shareWith: Object.assign({}, grants, isObj(rec.shareWith) ? rec.shareWith : {}) });
    if (d && !d.deleted) { live++; if (!(x.store === 'projects' && String(x.id) === id)) return; let cur = null; try { cur = JSON.parse(d.recJson); } catch (e) { /* skip */ } if (cur && JSON.stringify(cur.shareWith || {}) === JSON.stringify(rec.shareWith)) return; rec = Object.assign({}, cur || rec, { shareWith: rec.shareWith }); ops.push({ store: x.store, id: x.id, rec, prev: cur, base: d.seq || 0 }); return; }
    ops.push({ store: x.store, id: x.id, rec, prev: null, base: d ? (d.seq || 0) : 0 });
  });
  console.log(`owner's hub: ${live} of ${c.recs.size} still live; ${ops.length} to write back; shared with ${JSON.stringify(grants)}`);
  if (!COMMIT) { console.log('dry run — add --commit to write'); process.exit(0); }
  const r = await hub.push({ dev: 'restore', conn: null, name: 'Restored (' + source + ')', ops });
  console.log('owner push:', JSON.stringify(r).slice(0, 200), 'seq', st.seq, '→', (await hub.loadState()).seq);
  const pass = await S.sharePass(shareEnv(), { ownerUid: owner, kind: 'project', recId: id });
  console.log('share pass:', JSON.stringify(pass));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
