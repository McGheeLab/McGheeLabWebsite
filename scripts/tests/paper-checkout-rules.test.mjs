/* V3.741 — paper checkout-lock rules test.
 *
 * "Export for updates" writes checked_out_by_uid onto projects/{id};
 * paper-author-sync mirrors it to papers/{id}.checkedOutByUid, which the
 * yjs_updates create rule reads. This file pins the four things that make the
 * lock real:
 *   1. While mirrored as checked out, NOBODY appends yjs_updates — coauthor,
 *      lead author, admin — EXCEPT the checkout holder (that is how the edited
 *      bundle comes back).
 *   2. Clearing the mirror re-admits authors; admins were never a bypass.
 *   3. A COAUTHOR may write only the activity/lock fields on the row (check
 *      out, cancel, the 5-minute updatedAt touch) — never title/status/authors.
 *   4. Lead author and admin keep full update; a stranger touches nothing.
 *
 * Setup + run (same harness as paper-create-rules.test.mjs):
 *   cd scripts/tests
 *   JAVA_HOME=/opt/homebrew/opt/openjdk@21 PATH=$JAVA_HOME/bin:$PATH \
 *     firebase emulators:exec --only firestore --project demo-mcgheelab-paper \
 *     "node paper-checkout-rules.test.mjs"
 *
 * Output marks: ok / HOLE (allowed, should deny) / BREAK (denied, should allow).
 */
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc, updateDoc, deleteField, setLogLevel } from 'firebase/firestore';

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
const lead   = env.authenticatedContext('lead').firestore();
const coau   = env.authenticatedContext('coau').firestore();
const admin  = env.authenticatedContext('admin').firestore();
const other  = env.authenticatedContext('other').firestore();   // lab member, not on the paper

const PAPER = 'granule-coating';
async function seed(mirror) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, 'users/lead'),  { role: 'editor' });
    await setDoc(doc(d, 'users/coau'),  { role: 'editor' });
    await setDoc(doc(d, 'users/other'), { role: 'editor' });
    await setDoc(doc(d, 'users/admin'), { role: 'admin' });
    await setDoc(doc(d, `projects/${PAPER}`), {
      type: 'paper', title: 'Granule coating', status: 'drafting',
      lead_author_uid: 'lead', coauthor_uids: ['coau'], coauthor_emails: [],
    });
    // What paper-author-sync would have mirrored.
    await setDoc(doc(d, `papers/${PAPER}`), Object.assign({
      authorUids: ['lead', 'coau'], mentorUids: [], title: 'Granule coating', status: 'drafting',
    }, mirror || {}));
  });
}
const update = (db, uid) => setDoc(doc(db, `papers/${PAPER}/yjs_updates/${Date.now()}-${Math.random().toString(36).slice(2, 6)}`), {
  bytes: 'AAA=', seq: 'x', originId: 'o', authorUid: uid, ts: new Date(),
});
const row = (db) => doc(db, `projects/${PAPER}`);

console.log('\n── unlocked: authors write, strangers don\'t (baseline) ──');
await seed({ checkedOutByUid: null });
await mustAllow('lead appends yjs_updates',            () => update(lead, 'lead'));
await mustAllow('coauthor appends yjs_updates',        () => update(coau, 'coau'));
await mustAllow('admin appends yjs_updates',           () => update(admin, 'admin'));
await mustDeny ('non-author appends yjs_updates',      () => update(other, 'other'));

console.log('\n── locked by the LEAD (mirror checkedOutByUid = lead) ──');
await seed({ checkedOutByUid: 'lead', checkedOutAt: '2026-09-04T14:00:00.000Z' });
await mustDeny ('coauthor appends while locked',       () => update(coau, 'coau'));
await mustDeny ('ADMIN appends while locked (no bypass)', () => update(admin, 'admin'));
await mustAllow('holder (lead) appends while locked — the re-import path', () => update(lead, 'lead'));

console.log('\n── locked by a COAUTHOR ──');
await seed({ checkedOutByUid: 'coau' });
await mustDeny ('lead appends while coauthor holds it', () => update(lead, 'lead'));
await mustAllow('holder (coauthor) appends',            () => update(coau, 'coau'));
await mustDeny ('admin appends',                        () => update(admin, 'admin'));

console.log('\n── unlock re-admits everyone ──');
await seed({ checkedOutByUid: 'lead' });
await mustDeny ('coauthor denied before clear',         () => update(coau, 'coau'));
await env.withSecurityRulesDisabled(async (ctx) => {
  await updateDoc(doc(ctx.firestore(), `papers/${PAPER}`), { checkedOutByUid: null });
});
await mustAllow('coauthor allowed after clear',         () => update(coau, 'coau'));
await mustAllow('admin allowed after clear',            () => update(admin, 'admin'));

console.log('\n── projects row: who may write the lock fields ──');
await seed({ checkedOutByUid: null });
const lockFields = (uid) => ({
  checked_out_by_uid: uid, checked_out_by: 'Someone', checked_out_at: '2026-09-04T14:00:00.000Z',
  checkout_token: 'co-abc', updatedAt: new Date(),
});
await mustAllow('coauthor checks the paper out (lock fields only)', () => setDoc(row(coau), lockFields('coau'), { merge: true }));
await mustAllow('coauthor bumps updatedAt alone (activity touch)',   () => setDoc(row(coau), { updatedAt: new Date() }, { merge: true }));
await mustAllow('coauthor cancels checkout (deletes the fields)',    () => setDoc(row(coau), {
  checked_out_by_uid: deleteField(), checked_out_by: deleteField(), checked_out_at: deleteField(), checkout_token: deleteField(),
}, { merge: true }));
await mustDeny ('coauthor edits the TITLE',                          () => setDoc(row(coau), { title: 'Hijacked' }, { merge: true }));
await mustDeny ('coauthor edits STATUS',                             () => setDoc(row(coau), { status: 'published' }, { merge: true }));
await mustDeny ('coauthor edits lock fields AND title in one write', () => setDoc(row(coau), Object.assign({ title: 'X' }, lockFields('coau')), { merge: true }));
await mustDeny ('coauthor adds himself as lead',                     () => setDoc(row(coau), { lead_author_uid: 'coau' }, { merge: true }));
await mustAllow('lead checks the paper out',                         () => setDoc(row(lead), lockFields('lead'), { merge: true }));
await mustAllow('lead still edits title (full owner update)',        () => setDoc(row(lead), { title: 'Renamed' }, { merge: true }));
await mustAllow('admin force-unlocks',                               () => setDoc(row(admin), {
  checked_out_by_uid: deleteField(), checked_out_by: deleteField(), checked_out_at: deleteField(), checkout_token: deleteField(),
}, { merge: true }));
await mustDeny ('non-author member checks the paper out',            () => setDoc(row(other), lockFields('other'), { merge: true }));
await mustDeny ('non-author member touches updatedAt',               () => setDoc(row(other), { updatedAt: new Date() }, { merge: true }));

console.log(`\n${ok} ok, ${holes} holes, ${breaks} breaks`);
await env.cleanup();
process.exit(holes + breaks ? 1 : 0);
