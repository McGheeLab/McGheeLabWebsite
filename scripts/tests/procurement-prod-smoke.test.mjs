/* procurement-prod-smoke.test.mjs — V3.813: the DEPLOYED rules + the LIVE
 * function, with a real throwaway user, no browser.
 *
 *   GCLOUD_TOKEN=$(gcloud auth print-access-token) \
 *   node /Users/alexmcghee/Documents/GitHub/McGheeLabWebsite/scripts/tests/procurement-prod-smoke.test.mjs
 *
 * What it does, in order, and undoes in `finally`:
 *   1. signs up a throwaway password user (Identity Toolkit REST, web API key),
 *   2. seeds users/{uid} role:'editor' hidden:true via Firestore REST with the
 *      gcloud OAuth token (IAM bypasses rules — the "admin" path),
 *   3. as that user, through the real client SDK against production:
 *        submit a request (allowed) → approve own (DENIED) → add a note (allowed),
 *   4. waits, then reads the admins' notification feeds for tag proc:{id}
 *      (proves onProcurementTicketWritten actually fired in production),
 *   5. deletes the feed items, the ticket, the users doc and the auth user.
 * The admins DO receive one push titled "New purchase request" for
 * "[TEST] procurement v2 smoke — ignore" — that is the point of step 4.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';

const require = createRequire(import.meta.url);
const C = require('../../rm/js/procurement-core.js');
const cfgSrc = readFileSync(new URL('../../firebase-config.js', import.meta.url), 'utf8');
const pick = (k) => (cfgSrc.match(new RegExp(k + ':\\s*"([^"]+)"')) || [])[1];
const CFG = { apiKey: pick('apiKey'), authDomain: pick('authDomain'), projectId: pick('projectId') };
const TOKEN = process.env.GCLOUD_TOKEN;
if (!TOKEN) { console.error('GCLOUD_TOKEN missing'); process.exit(2); }
const FS = `https://firestore.googleapis.com/v1/projects/${CFG.projectId}/databases/(default)/documents`;
const H = { Authorization: 'Bearer ' + TOKEN, 'x-goog-user-project': CFG.projectId, 'Content-Type': 'application/json' };

let pass = 0, fail = 0;
const ok = (n) => { console.log('  ok    ' + n); pass++; };
const bad = (n, d) => { console.log('  FAIL  ' + n + (d ? '   → ' + d : '')); fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rest(method, path, body) {
  const r = await fetch(FS + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: j, text: t };
}
const sv = (v) => typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : { stringValue: String(v) };

const email = `proc-smoke-${Date.now()}@test.invalid`;
const password = 'Smoke-' + Math.random().toString(36).slice(2) + 'A1!';
let uid = null, idToken = null, ticketId = null, app = null;
const adminUids = [];
try {
  console.log('\n── set up a throwaway lab member ──');
  const su = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${CFG.apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  const suj = await su.json();
  if (!suj.localId) throw new Error('signUp failed: ' + JSON.stringify(suj).slice(0, 300));
  uid = suj.localId; idToken = suj.idToken; ok('auth user created ' + uid);
  const seed = await rest('PATCH', `/users/${uid}`, { fields: { role: sv('editor'), category: sv('collaborator'), hidden: sv(true), name: sv('Procurement smoke (delete me)'), email: sv(email) } });
  if (seed.status !== 200) throw new Error('users seed failed ' + seed.status + ' ' + seed.text.slice(0, 200));
  ok('users/{uid} seeded role:editor hidden:true (IAM write)');

  const q = await rest('POST', ':runQuery', { structuredQuery: { from: [{ collectionId: 'users' }], where: { fieldFilter: { field: { fieldPath: 'role' }, op: 'EQUAL', value: sv('admin') } } } });
  (q.body || []).forEach((row) => { if (row.document) adminUids.push(row.document.name.split('/').pop()); });
  adminUids.length ? ok('admins found: ' + adminUids.length) : bad('no admin users found');

  console.log('\n── as that user, against the DEPLOYED rules ──');
  app = firebase.initializeApp(CFG, 'smoke');
  await app.auth().signInWithEmailAndPassword(email, password);
  const db = app.firestore();
  const actor = C.actorFrom({ uid, email, displayName: 'Procurement smoke' }, { name: 'Procurement smoke (delete me)', role: 'editor' }, () => false);
  const FV = firebase.firestore.FieldValue;
  const cr = C.buildCreate({ itemDescription: '[TEST] procurement v2 smoke — ignore', reason: 'Automated check of the deployed rules + function; auto-deleted.', quantity: 1, unitCost: 1, projectId: '__other', project: '[TEST] smoke', purchaseType: 'one_time' }, actor, Date.now(), FV.serverTimestamp());
  const ref = await db.collection('procurementTickets').add(cr.data);
  ticketId = ref.id; ok('member submits a request → ' + ticketId);
  const snap = await ref.get();
  snap.exists && snap.data().status === 'requested' ? ok('member reads own ticket back (isLabMember read)') : bad('read back');
  try { await ref.update({ status: 'approved' }); bad('member approves OWN request — HOLE'); }
  catch (e) { /permission|insufficient/i.test(e.message) ? ok('member approving own request is DENIED (' + e.code + ')') : bad('approve failed for the wrong reason', e.message); }
  try { await ref.update({ requestedBy: 'someone-else' }); bad('member changes requestedBy — HOLE'); }
  catch (e) { /permission|insufficient/i.test(e.message) ? ok('changing requestedBy is DENIED') : bad('requestedBy failed for the wrong reason', e.message); }
  const t = Object.assign({ id: ticketId }, (await ref.get()).data());
  const r = C.buildPatch('note', t, { note: 'smoke note' }, actor, Date.now(), FV.serverTimestamp());
  const patch = Object.assign({}, r.patch, { history: FV.arrayUnion(...r.appends.history), notes: FV.arrayUnion(...r.appends.notes), watcherUids: FV.arrayUnion(...r.appends.watcherUids) });
  await ref.update(patch); ok('member adds a note (noteOnly path) on the deployed rules');

  console.log('\n── the LIVE function ──');
  let found = 0;
  for (let i = 0; i < 12 && !found; i++) {
    await sleep(5000);
    for (const a of adminUids) {
      const fq = await rest('POST', `/userData/${a}:runQuery`, { structuredQuery: { from: [{ collectionId: 'notifications' }], where: { fieldFilter: { field: { fieldPath: 'tag' }, op: 'EQUAL', value: sv('proc:' + ticketId) } } } });
      const docs = (fq.body || []).filter((row) => row.document);
      if (docs.length) { found += docs.length; docs.forEach((d) => console.log('        feed item for admin ' + a.slice(0, 6) + '…: "' + (d.document.fields.title || {}).stringValue + '" — ' + (d.document.fields.body || {}).stringValue)); }
    }
  }
  found ? ok('onProcurementTicketWritten fired in production: ' + found + ' admin feed item(s) with tag proc:' + ticketId) : bad('no admin feed item appeared within 60 s (function not firing? check gcloud functions logs read onProcurementTicketWritten --region us-central1)');
} catch (e) {
  bad('unexpected: ' + (e && e.message));
} finally {
  console.log('\n── clean up ──');
  try {
    for (const a of adminUids) {
      const fq = await rest('POST', `/userData/${a}:runQuery`, { structuredQuery: { from: [{ collectionId: 'notifications' }], where: { fieldFilter: { field: { fieldPath: 'tag' }, op: 'EQUAL', value: sv('proc:' + ticketId) } } } });
      for (const row of (fq.body || [])) if (row.document) { await rest('DELETE', '/' + row.document.name.split('/documents/')[1]); console.log('        deleted feed item for ' + a.slice(0, 6) + '…'); }
    }
    if (ticketId) { const d = await rest('DELETE', `/procurementTickets/${ticketId}`); console.log('        ticket deleted ' + d.status); }
    if (uid) { const d = await rest('DELETE', `/users/${uid}`); console.log('        users doc deleted ' + d.status); }
    if (idToken) { const d = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${CFG.apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }); console.log('        auth user deleted ' + d.status); }
  } catch (e) { console.log('        CLEANUP PROBLEM: ' + e.message + ' — uid=' + uid + ' ticket=' + ticketId); }
  if (app) { try { await app.delete(); } catch (e) {} }
}
console.log(`\nProduction smoke: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
