/* V3.986 — public protocols rules test.
 *
 * What this pins down:
 *   1. publicProtocols/{id} and its content/{docId} are world-readable: a
 *      visitor who is not signed in lists the cards and reads a tree.
 *   2. Only the protocol's OWNER or an admin posts, updates and removes the
 *      public copy. Another lab member, a guest and a visitor cannot.
 *   3. The card's `id` is pinned to its doc id, so a card can never be
 *      written under another protocol's name.
 *   4. A non-admin cannot post a protocol that does not exist (the get() of
 *      the missing protocol doc denies; it is not an allow).
 *   5. The WORKING doc is lab-only: a protocol whose status is 'published'
 *      and its version snapshots are no longer readable by a visitor (they
 *      were until V3.986), and a visitor cannot list published protocols.
 *   6. Lab members read every protocol as before, and the owner still
 *      deletes their own protocol after removing its public copy.
 *   7. (V3.987) An HTML protocol's file pieces, protocols/{id}/html/{piece}:
 *      lab members read; only the owner or an admin writes or deletes; a
 *      visitor or guest reads nothing. Posted pieces, content/html-{n}, are
 *      public like the rest of the copy.
 *
 * Setup + run (same harness as research-foci-rules.test.mjs):
 *   cd scripts/tests
 *   firebase emulators:exec --only firestore --project demo-mcgheelab-pp \
 *     "node protocols-public-rules.test.mjs"
 *   RULES=/abs/path/to/other.rules … runs the same cases against another file.
 *
 * Output marks: ok / HOLE (allowed, should deny) / BREAK (denied, should allow).
 */
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, collection, query, where, writeBatch, setLogLevel } from 'firebase/firestore';

setLogLevel('silent');

const RULES = process.env.RULES || new URL('../../firestore.rules', import.meta.url).pathname;
console.log('rules file: ' + RULES);
const env = await initializeTestEnvironment({
  projectId: 'demo-mcgheelab-pp',
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
const admin   = env.authenticatedContext('admin').firestore();
const owner   = env.authenticatedContext('owner').firestore();   // wrote the protocol
const other   = env.authenticatedContext('other').firestore();   // lab member, not the owner
const guest   = env.authenticatedContext('guest').firestore();   // signed in, role guest
const visitor = env.unauthenticatedContext().firestore();        // the public

const card = (id, overrides = {}) => Object.assign({
  id, title: 'Agarose LLS', summary: 'Casting the sieve.', tags: ['hydrogel'],
  contributors: [{ uid: 'owner', name: 'Owner One' }, { uid: 'other', name: 'Other Two' }],
  contributor_uids: ['owner', 'other'], byline: 'Owner One, Other Two',
  version: 2, published_at: '2026-11-13T00:00:00Z', updated_at: '2026-11-13T00:00:00Z',
  schema_version: 1,
}, overrides);
const tree = { tree: { meta: { title: 'Agarose LLS' }, sections: [] }, schema_version: 1 };

async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, 'users/admin'), { role: 'admin', category: 'pi' });
    await setDoc(doc(d, 'users/owner'), { role: 'editor', category: 'grad' });
    await setDoc(doc(d, 'users/other'), { role: 'editor', category: 'grad' });
    await setDoc(doc(d, 'users/guest'), { role: 'guest' });
    // working docs: a draft, and one already posted
    await setDoc(doc(d, 'protocols/p-draft'),  { id: 'p-draft',  ownerUid: 'owner', status: 'draft',     title: 'Draft' });
    await setDoc(doc(d, 'protocols/p-posted'), { id: 'p-posted', ownerUid: 'owner', status: 'published', title: 'Posted' });
    await setDoc(doc(d, 'protocols/p-posted/versions/v1'), { version: 1, snapshot_by_uid: 'owner' });
    await setDoc(doc(d, 'publicProtocols/p-posted'), card('p-posted'));
    await setDoc(doc(d, 'publicProtocols/p-posted/content/current'), tree);
    // an uploaded HTML protocol, posted, with its file in two pieces
    await setDoc(doc(d, 'protocols/p-html'), { id: 'p-html', ownerUid: 'owner', status: 'published', kind: 'html', title: 'Spot anchors',
      html_file: { rev: 1, chunks: 2, size: 20 } });
    await setDoc(doc(d, 'protocols/p-html/html/r1-0'), { rev: 1, n: 0, data: '<html><body>' });
    await setDoc(doc(d, 'protocols/p-html/html/r1-1'), { rev: 1, n: 1, data: '</body></html>' });
    await setDoc(doc(d, 'publicProtocols/p-html'), card('p-html', { kind: 'html', html_chunks: 2 }));
    await setDoc(doc(d, 'publicProtocols/p-html/content/current'), { kind: 'html', html_chunks: 2 });
    await setDoc(doc(d, 'publicProtocols/p-html/content/html-0'), { n: 0, data: '<html><body>' });
    await setDoc(doc(d, 'publicProtocols/p-html/content/html-1'), { n: 1, data: '</body></html>' });
  });
}
await seed();

/* ═══════════ 1. the public reads the posted copy ═══════════ */
console.log('\n── publicProtocols: anyone reads ──');
await mustAllow('visitor lists the cards',        () => getDocs(collection(visitor, 'publicProtocols')));
await mustAllow('visitor reads a card',           () => getDoc(doc(visitor, 'publicProtocols/p-posted')));
await mustAllow('visitor reads the tree',         () => getDoc(doc(visitor, 'publicProtocols/p-posted/content/current')));
await mustAllow('visitor reads a missing card',   () => getDoc(doc(visitor, 'publicProtocols/nope')));
await mustAllow('guest reads a card',             () => getDoc(doc(guest, 'publicProtocols/p-posted')));

/* ═══════════ 2. who posts ═══════════ */
console.log('\n── posting: the owner or an admin, nobody else ──');
await mustAllow('owner posts their draft (card + tree in one batch)', async () => {
  const b = writeBatch(owner);
  b.set(doc(owner, 'publicProtocols/p-draft'), card('p-draft'));
  b.set(doc(owner, 'publicProtocols/p-draft/content/current'), tree);
  await b.commit();
});
await mustAllow('owner updates the public copy',  () => setDoc(doc(owner, 'publicProtocols/p-draft'), card('p-draft', { title: 'Agarose LLS v2' })));
await mustAllow('admin updates someone else\'s public copy',
  () => updateDoc(doc(admin, 'publicProtocols/p-posted'), { summary: 'Edited by the PI.' }));
await mustAllow('admin rewrites the tree',        () => setDoc(doc(admin, 'publicProtocols/p-posted/content/current'), tree));
await mustDeny ('another member posts over it',   () => setDoc(doc(other, 'publicProtocols/p-posted'), card('p-posted', { title: 'hijack' })));
await mustDeny ('another member edits the tree',  () => setDoc(doc(other, 'publicProtocols/p-posted/content/current'), tree));
await mustDeny ('another member adds themself as a contributor',
  () => updateDoc(doc(other, 'publicProtocols/p-posted'), { contributor_uids: ['other'] }));
await mustDeny ('guest posts',                    () => setDoc(doc(guest, 'publicProtocols/p-draft'), card('p-draft')));
await mustDeny ('visitor posts',                  () => setDoc(doc(visitor, 'publicProtocols/p-draft'), card('p-draft')));
await mustDeny ('visitor edits a tree',           () => setDoc(doc(visitor, 'publicProtocols/p-posted/content/current'), tree));

/* ═══════════ 3. the id is pinned ═══════════ */
console.log('\n── the card\'s id is its doc id ──');
await mustDeny ('owner writes a card whose id names another protocol',
  () => setDoc(doc(owner, 'publicProtocols/p-draft'), card('p-posted')));
await mustDeny ('admin writes a card with the wrong id',
  () => setDoc(doc(admin, 'publicProtocols/p-draft'), card('other-id')));
await mustDeny ('owner changes the id on update',
  () => updateDoc(doc(owner, 'publicProtocols/p-draft'), { id: 'p-posted' }));

/* ═══════════ 4. a protocol that does not exist ═══════════ */
console.log('\n── no working doc: a member cannot post it, an admin can clear it ──');
await mustDeny ('member posts a protocol that does not exist',
  () => setDoc(doc(owner, 'publicProtocols/ghost'), card('ghost')));
await mustDeny ('member writes a tree for a protocol that does not exist',
  () => setDoc(doc(owner, 'publicProtocols/ghost/content/current'), tree));
await env.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), 'publicProtocols/orphan'), card('orphan'));
  await setDoc(doc(ctx.firestore(), 'publicProtocols/orphan/content/current'), tree);
});
await mustDeny ('member removes an orphaned public copy', () => deleteDoc(doc(other, 'publicProtocols/orphan')));
await mustAllow('admin removes an orphaned tree',         () => deleteDoc(doc(admin, 'publicProtocols/orphan/content/current')));
await mustAllow('admin removes an orphaned card',         () => deleteDoc(doc(admin, 'publicProtocols/orphan')));

/* ═══════════ 5. the working doc is lab-only ═══════════ */
console.log('\n── protocols/{id}: lab members only, whatever the status ──');
await mustDeny ('visitor reads a published working doc',  () => getDoc(doc(visitor, 'protocols/p-posted')));
await mustDeny ('visitor lists published working docs',
  () => getDocs(query(collection(visitor, 'protocols'), where('status', '==', 'published'))));
await mustDeny ('visitor reads a version of a published protocol',
  () => getDoc(doc(visitor, 'protocols/p-posted/versions/v1')));
await mustDeny ('guest reads a published working doc',    () => getDoc(doc(guest, 'protocols/p-posted')));
await mustDeny ('visitor reads a draft',                  () => getDoc(doc(visitor, 'protocols/p-draft')));
await mustAllow('member lists every protocol',            () => getDocs(collection(other, 'protocols')));
await mustAllow('member reads a draft that is not theirs', () => getDoc(doc(other, 'protocols/p-draft')));
await mustAllow('member reads a version',                 () => getDoc(doc(other, 'protocols/p-posted/versions/v1')));
await mustAllow('owner marks the working doc published',
  () => updateDoc(doc(owner, 'protocols/p-draft'), { status: 'published', published_at: '2026-11-13T00:00:00Z',
    contributors: [{ uid: 'owner', name: 'Owner One' }] }));
await mustDeny ('another member marks it published',
  () => updateDoc(doc(other, 'protocols/p-posted'), { status: 'draft' }));

/* ═══════════ 6. removing ═══════════ */
console.log('\n── removing from the website, and deleting a posted protocol ──');
await mustDeny ('another member removes the public copy', () => deleteDoc(doc(other, 'publicProtocols/p-posted')));
await mustDeny ('visitor removes the public copy',        () => deleteDoc(doc(visitor, 'publicProtocols/p-posted')));
await mustAllow('owner removes their public copy (tree + card in one batch)', async () => {
  const b = writeBatch(owner);
  b.delete(doc(owner, 'publicProtocols/p-draft/content/current'));
  b.delete(doc(owner, 'publicProtocols/p-draft'));
  await b.commit();
});
await mustAllow('owner removes a public copy that is not there (delete flow)',
  () => deleteDoc(doc(owner, 'publicProtocols/p-draft')));
await mustAllow('owner clears the public copy, then deletes the protocol', async () => {
  const b = writeBatch(owner);
  b.delete(doc(owner, 'publicProtocols/p-posted/content/current'));
  b.delete(doc(owner, 'publicProtocols/p-posted'));
  await b.commit();
  await deleteDoc(doc(owner, 'protocols/p-posted/versions/v1'));
  await deleteDoc(doc(owner, 'protocols/p-posted'));
});

/* ═══════════ 7. HTML protocols (V3.987) ═══════════ */
console.log('\n── an uploaded HTML protocol: the file pieces ──');
const piece = (rev, n) => ({ rev, n, data: 'x'.repeat(10) });
await mustAllow('member reads a piece of the file',          () => getDoc(doc(other, 'protocols/p-html/html/r1-0')));
await mustAllow('member lists the pieces',                    () => getDocs(collection(other, 'protocols/p-html/html')));
await mustDeny ('visitor reads a piece of the lab file',      () => getDoc(doc(visitor, 'protocols/p-html/html/r1-0')));
await mustDeny ('guest reads a piece of the lab file',        () => getDoc(doc(guest, 'protocols/p-html/html/r1-0')));
await mustAllow('owner writes a new revision',                () => setDoc(doc(owner, 'protocols/p-html/html/r2-0'), piece(2, 0)));
await mustAllow('admin writes a piece',                       () => setDoc(doc(admin, 'protocols/p-html/html/r3-0'), piece(3, 0)));
await mustDeny ('another member writes a piece',              () => setDoc(doc(other, 'protocols/p-html/html/r2-0'), piece(2, 0)));
await mustDeny ('another member overwrites a piece',          () => setDoc(doc(other, 'protocols/p-html/html/r1-0'), piece(1, 0)));
await mustDeny ('visitor writes a piece',                     () => setDoc(doc(visitor, 'protocols/p-html/html/r9-0'), piece(9, 0)));
await mustDeny ('member writes pieces for a protocol that does not exist',
  () => setDoc(doc(owner, 'protocols/ghost/html/r1-0'), piece(1, 0)));
await mustAllow('member creates their own HTML protocol, then its file', async () => {
  await setDoc(doc(other, 'protocols/p-new-html'), { id: 'p-new-html', ownerUid: 'other', status: 'draft', kind: 'html', title: 'New' });
  const b = writeBatch(other);
  b.set(doc(other, 'protocols/p-new-html/html/r1-0'), piece(1, 0));
  b.set(doc(other, 'protocols/p-new-html/html/r1-1'), piece(1, 1));
  await b.commit();
});
await mustDeny ('another member deletes a piece',             () => deleteDoc(doc(other, 'protocols/p-html/html/r1-1')));
await mustAllow('visitor reads the posted file',              async () => {
  await getDoc(doc(visitor, 'publicProtocols/p-html'));
  await getDoc(doc(visitor, 'publicProtocols/p-html/content/current'));
  await getDoc(doc(visitor, 'publicProtocols/p-html/content/html-0'));
  await getDoc(doc(visitor, 'publicProtocols/p-html/content/html-1'));
});
await mustDeny ('another member rewrites a posted piece',     () => setDoc(doc(other, 'publicProtocols/p-html/content/html-0'), { n: 0, data: 'hijack' }));
await mustDeny ('visitor rewrites a posted piece',            () => setDoc(doc(visitor, 'publicProtocols/p-html/content/html-0'), { n: 0, data: 'hijack' }));
await mustAllow('owner updates the posted copy and drops a piece (one batch)', async () => {
  const b = writeBatch(owner);
  b.set(doc(owner, 'publicProtocols/p-html'), card('p-html', { kind: 'html', html_chunks: 1 }));
  b.set(doc(owner, 'publicProtocols/p-html/content/current'), { kind: 'html', html_chunks: 1 });
  b.set(doc(owner, 'publicProtocols/p-html/content/html-0'), { n: 0, data: '<html></html>' });
  b.delete(doc(owner, 'publicProtocols/p-html/content/html-1'));
  await b.commit();
});
await mustAllow('owner deletes the posted copy, then the protocol and its pieces', async () => {
  const b = writeBatch(owner);
  b.delete(doc(owner, 'publicProtocols/p-html/content/html-0'));
  b.delete(doc(owner, 'publicProtocols/p-html/content/current'));
  b.delete(doc(owner, 'publicProtocols/p-html'));
  await b.commit();
  for (const id of ['r1-0', 'r1-1', 'r2-0', 'r3-0']) await deleteDoc(doc(owner, 'protocols/p-html/html/' + id));
  await deleteDoc(doc(owner, 'protocols/p-html'));
});

console.log(`\nprotocols-public-rules: ${ok} ok, ${holes} HOLE, ${breaks} BREAK`);
await env.cleanup();
process.exit(holes + breaks ? 1 : 0);
