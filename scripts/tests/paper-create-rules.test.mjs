/* V3.729 — /projects paper-create rules test.
 *
 * Two things this file pins down:
 *   1. The per-user 'paper-builder:create' capability lets a GUEST read the
 *      paper slice of /projects and create a self-owned paper row — and
 *      nothing else (no courses, no other people's rows, no admin-only kinds).
 *   2. The reason "+ New paper" never worked for non-admins: the old
 *      whole-collection api.save re-set every row, and the update rule denies
 *      rows the caller doesn't own, so the batch failed. The single-doc create
 *      that replaced it is allowed for members and cap-holders alike.
 *
 * Setup + run (same harness as inventory-rules.test.mjs):
 *   cd scripts/tests
 *   JAVA_HOME=/opt/homebrew/opt/openjdk@21 PATH=$JAVA_HOME/bin:$PATH \
 *     firebase emulators:exec --only firestore --project demo-mcgheelab-paper \
 *     "node paper-create-rules.test.mjs"
 *
 * Output marks: ok / HOLE (allowed, should deny) / BREAK (denied, should allow).
 */
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import {
  doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, collection, query, where,
  writeBatch, setLogLevel
} from 'firebase/firestore';

setLogLevel('silent');

const RULES = new URL('../../firestore.rules', import.meta.url).pathname;
const env = await initializeTestEnvironment({
  projectId: 'demo-mcgheelab-paper',
  firestore: { rules: readFileSync(RULES, 'utf8'), host: '127.0.0.1', port: 8199 }
});

let ok = 0, holes = 0, breaks = 0;
async function mustAllow(name, fn) {
  try { await fn(); console.log('  ok    ' + name); ok++; }
  catch (e) { console.log('  BREAK ' + name + '  — ' + (e.code || e.message)); breaks++; }
}
async function mustDeny(name, fn) {
  try { await fn(); console.log('  HOLE  ' + name); holes++; }
  catch (e) { console.log('  ok    ' + name); ok++; }
}

/* ── personas ── */
const member  = env.authenticatedContext('member').firestore();
const admin   = env.authenticatedContext('admin').firestore();
const guest   = env.authenticatedContext('guest').firestore();     // plain guest, no cap
const writer  = env.authenticatedContext('writer').firestore();    // guest + paper-builder:create

await env.withSecurityRulesDisabled(async (ctx) => {
  const d = ctx.firestore();
  await setDoc(doc(d, 'users/member'), { role: 'editor', category: 'grad' });
  await setDoc(doc(d, 'users/admin'),  { role: 'admin' });
  await setDoc(doc(d, 'users/guest'),  { role: 'guest', category: 'highschool' });
  await setDoc(doc(d, 'users/writer'), { role: 'guest', category: 'highschool' });
  await setDoc(doc(d, 'userPermissions/writer'), { caps: ['paper-builder:create'] });

  // An existing paper owned by the admin, and a course (a non-paper project kind).
  await setDoc(doc(d, 'projects/alex-paper'), {
    type: 'paper', title: 'PI paper', lead_author_uid: 'admin', coauthor_uids: [], status: 'drafting' });
  await setDoc(doc(d, 'projects/bme466'), { type: 'course', title: 'BME 466' });
});

const paperRow = (uid, title) => ({
  type: 'paper', title, status: 'drafting',
  lead_author_uid: uid, coauthor_uids: [], coauthor_emails: [], template_id: 'blank', paper_type: 'journal'
});
const papersQuery = (db) => getDocs(query(collection(db, 'projects'), where('type', '==', 'paper')));

console.log('\n── read: the Paper Builder list query (where type == paper) ──');
await mustAllow('member lists papers',                    () => papersQuery(member));
await mustAllow('cap-holder guest lists papers',          () => papersQuery(writer));
await mustDeny ('plain guest lists papers',               () => papersQuery(guest));
await mustAllow('cap-holder reads one paper doc',         () => getDoc(doc(writer, 'projects/alex-paper')));
await mustDeny ('cap-holder reads a COURSE doc',          () => getDoc(doc(writer, 'projects/bme466')));
await mustDeny ('cap-holder lists ALL projects (unfiltered)', () => getDocs(collection(writer, 'projects')));

console.log('\n── create: one self-owned paper row (what "+ New paper" writes now) ──');
await mustAllow('member creates own paper',               () => setDoc(doc(member, 'projects/m-paper'), paperRow('member', 'M')));
await mustAllow('cap-holder guest creates own paper',     () => setDoc(doc(writer, 'projects/w-paper'), paperRow('writer', 'W')));
await mustDeny ('plain guest creates own paper',          () => setDoc(doc(guest,  'projects/g-paper'), paperRow('guest', 'G')));
await mustDeny ('cap-holder creates a paper owned by someone else',
  () => setDoc(doc(writer, 'projects/w-forge'), paperRow('admin', 'forged')));
await mustDeny ('cap-holder creates a COURSE',            () => setDoc(doc(writer, 'projects/w-course'), { type: 'course', title: 'x' }));
await mustDeny ('member creates a course',                () => setDoc(doc(member, 'projects/m-course'), { type: 'course', title: 'x' }));

console.log('\n── update/delete: unchanged — owner-by-uid only ──');
await mustAllow('cap-holder edits own paper title',       () => updateDoc(doc(writer, 'projects/w-paper'), { title: 'W2' }));
await mustDeny ('cap-holder edits the PI paper',          () => updateDoc(doc(writer, 'projects/alex-paper'), { title: 'hijack' }));
await mustDeny ('member edits the PI paper',              () => updateDoc(doc(member, 'projects/alex-paper'), { title: 'hijack' }));
await mustAllow('cap-holder deletes own paper',           () => deleteDoc(doc(writer, 'projects/w-paper')));
await mustDeny ('cap-holder deletes the PI paper',        () => deleteDoc(doc(writer, 'projects/alex-paper')));

console.log('\n── the old bug: whole-collection save from a non-admin ──');
// This is what api.save("projects/papers.json") did: set(merge) EVERY row.
// One row belongs to the admin → the update rule denies → the whole batch fails.
await mustDeny('member batch re-sets all paper rows (incl. the PI paper) + adds their own', async () => {
  const b = writeBatch(member);
  b.set(doc(member, 'projects/alex-paper'), { title: 'PI paper', updatedAt: new Date() }, { merge: true });
  b.set(doc(member, 'projects/m-paper2'), paperRow('member', 'M2'));
  await b.commit();
});
await mustAllow('admin batch re-sets all rows (the only persona the old path worked for)', async () => {
  const b = writeBatch(admin);
  b.set(doc(admin, 'projects/alex-paper'), { title: 'PI paper', updatedAt: new Date() }, { merge: true });
  b.set(doc(admin, 'projects/m-paper'), { title: 'M', updatedAt: new Date() }, { merge: true });
  await b.commit();
});

console.log(`\n${ok} ok, ${holes} HOLE, ${breaks} BREAK`);
await env.cleanup();
process.exit(holes + breaks ? 1 : 0);
