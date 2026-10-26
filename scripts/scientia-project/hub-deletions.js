#!/usr/bin/env node
/* hub-deletions.js — READ ONLY: who removed a project (or any records) from a person's Scientia hub, and when (V3.923).

   node scripts/scientia-project/hub-deletions.js <uid> [--project <projectId>] [--ids <prefix,prefix>] [--limit N]

   Every hub row keeps its tombstone: `deleted`, the hub `seq` it happened at, and the device (`dev`, `name`) that sent it.
   A deletion relayed from a collaborator's hub shows as dev "share:<their uid>", name "<their name> (shared)"; the safety
   pass and the live relay both write that way. Prints the project row, the notes that were in it (by projectId on the
   last copy the op log still holds, or by id prefix), and a count of every deleted record by device.

   Writes nothing. Needs scripts/service-account.json.
*/
'use strict';
require('net').setDefaultAutoSelectFamilyAttemptTimeout(3000);
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2), uid = argv[0];
const opt = k => { const i = argv.indexOf(k); return i < 0 ? null : argv[i + 1]; };
if (!uid) { console.error('usage: hub-deletions.js <uid> [--project <projectId>] [--ids <prefix,prefix>] [--limit N]'); process.exit(2); }
const admin = require(ROOT + '/functions/node_modules/firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(require(ROOT + '/scripts/service-account.json')) });
const db = admin.firestore();

(async () => {
  const hub = db.doc('userData/' + uid + '/scientia/hub'), st = (await hub.get()).data() || {};
  console.log(`hub ${uid}: seq ${st.seq}, ${st.records} records, sid ${st.sid}`);
  const project = opt('--project'), prefixes = (opt('--ids') || '').split(',').filter(Boolean), limit = +(opt('--limit') || 40);
  const dead = await hub.collection('rows').where('deleted', '==', true).get();
  const byDev = new Map(), hits = [];
  for (const s of dead.docs) {
    const r = s.data(), k = (r.name || '?') + ' [' + (r.dev || '?') + ']';
    byDev.set(k, (byDev.get(k) || 0) + 1);
    if ((project && r.store === 'projects' && r.id === project) || prefixes.some(p => String(r.id).startsWith(p))) hits.push(r);
  }
  console.log('\ndeleted records by device:');
  for (const [k, n] of [...byDev].sort((a, b) => b[1] - a[1])) console.log('  ' + String(n).padStart(6) + '  ' + k);
  if (project) {
    // the notes that were in the project: the last op that still carries a record says where it was filed
    const ops = await hub.collection('ops').where('store', '==', 'documents').get(), last = new Map();
    for (const s of ops.docs) { const o = s.data(); if (!o.recJson) continue; try { const rec = JSON.parse(o.recJson); if (rec.projectId === project) last.set(o.id, rec.title || o.id); } catch (e) { /* skip */ } }
    for (const id of last.keys()) { const r = (await hub.collection('rows').doc('documents__' + encodeURIComponent(id).replace(/\./g, '%2E')).get()).data(); if (r && r.deleted) hits.push(r); }
    if (!ops.size) console.log('\n(the op log is compacted: notes are matched by --ids prefix only)');
  }
  hits.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  console.log(`\n${hits.length} matching deleted records (first ${limit}, oldest first):`);
  for (const r of hits.slice(0, limit)) console.log(`  seq ${String(r.seq).padStart(6)}  ${r.store}/${r.id}  by ${r.name || '?'} [${r.dev || '?'}]  at ${r.updated && r.updated.toDate ? r.updated.toDate().toISOString() : '?'}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
