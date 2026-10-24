/* V3.880 — scientiaNotes rules test (Scientia notes filed under RM work).
 *
 * What this pins down:
 *   1. A note shared with the lab (visibility 'lab') is readable by every lab
 *      member; a guest reads nothing.
 *   2. Any other note is readable ONLY by its owner — not another member, not
 *      the PI (the owner chose "only me").
 *   3. RM's two queries — rmIds array-contains X && visibility == 'lab', and
 *      rmIds array-contains X && ownerUid == me — are allowed; an unscoped
 *      list of the collection is denied (it could return someone's private note).
 *   4. Nobody writes from a client: the scientiaHub function (admin SDK) is the
 *      only writer.
 *
 * Run (same harness as research-foci-rules.test.mjs):
 *   cd scripts/tests
 *   JAVA_HOME=/opt/homebrew/opt/openjdk@21 PATH=$JAVA_HOME/bin:$PATH \
 *     firebase emulators:exec --only firestore --project demo-mcgheelab-sn \
 *     "node scientia-notes-rules.test.mjs"
 *   RULES=/abs/path/to/other.rules … runs the same cases against another file
 *   (the scratch LIVE+block deploy copy).
 *
 * Output marks: ok / HOLE (allowed, should deny) / BREAK (denied, should allow).
 */
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, collection, query, where, setLogLevel } from 'firebase/firestore';

setLogLevel('silent');

const RULES = process.env.RULES || new URL('../../firestore.rules', import.meta.url).pathname;
console.log('rules file: ' + RULES);
const env = await initializeTestEnvironment({
  projectId: 'demo-mcgheelab-sn',
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

const admin = env.authenticatedContext('admin').firestore();
const gabe  = env.authenticatedContext('gabe').firestore();
const mo    = env.authenticatedContext('mo').firestore();
const guest = env.authenticatedContext('guest').firestore();

const note = (owner, docId, visibility) => ({ ownerUid: owner, ownerName: owner, docId, title: 'Packing sweep', type: 'experiment', rmIds: ['gels-career', 'gels-career-aim-1'],
  visibility, preview: visibility === 'lab' ? [{ label: 'Setup', text: 'Pack 40 µm granules' }] : [], modified: '2026-10-23T10:00:00' });

await env.clearFirestore();
await env.withSecurityRulesDisabled(async (ctx) => {
  const d = ctx.firestore();
  await setDoc(doc(d, 'users/admin'), { role: 'admin', category: 'pi' });
  await setDoc(doc(d, 'users/gabe'),  { role: 'editor', category: 'grad' });
  await setDoc(doc(d, 'users/mo'),    { role: 'editor', category: 'grad' });
  await setDoc(doc(d, 'users/guest'), { role: 'guest' });
  await setDoc(doc(d, 'scientiaNotes/gabe__dShared'), note('gabe', 'dShared', 'lab'));
  await setDoc(doc(d, 'scientiaNotes/gabe__dMine'), note('gabe', 'dMine', 'private'));
});

console.log('\n── a shared note ──');
await mustAllow('another member reads it',   () => getDoc(doc(mo, 'scientiaNotes/gabe__dShared')));
await mustAllow('its owner reads it',        () => getDoc(doc(gabe, 'scientiaNotes/gabe__dShared')));
await mustDeny ('a guest reads it',          () => getDoc(doc(guest, 'scientiaNotes/gabe__dShared')));

console.log('\n── an only-me note ──');
await mustAllow('its owner reads it',        () => getDoc(doc(gabe, 'scientiaNotes/gabe__dMine')));
await mustDeny ('another member reads it',   () => getDoc(doc(mo, 'scientiaNotes/gabe__dMine')));
await mustDeny ('the PI reads it',           () => getDoc(doc(admin, 'scientiaNotes/gabe__dMine')));

console.log('\n── RM\'s queries ──');
const col = c => collection(c, 'scientiaNotes');
await mustAllow('shared notes on a card',    async () => { const s = await getDocs(query(col(mo), where('rmIds', 'array-contains', 'gels-career'), where('visibility', '==', 'lab'))); if (s.size !== 1) throw new Error('expected 1, got ' + s.size); });
await mustAllow('my own notes on a card',    async () => { const s = await getDocs(query(col(gabe), where('rmIds', 'array-contains', 'gels-career'), where('ownerUid', '==', 'gabe'))); if (s.size !== 2) throw new Error('expected 2, got ' + s.size); });
await mustDeny ('someone else\'s notes by owner', () => getDocs(query(col(mo), where('rmIds', 'array-contains', 'gels-career'), where('ownerUid', '==', 'gabe'))));
await mustDeny ('an unscoped list',          () => getDocs(col(mo)));

console.log('\n── no client writes ──');
await mustDeny ('the owner creates one',     () => setDoc(doc(gabe, 'scientiaNotes/gabe__dNew'), note('gabe', 'dNew', 'lab')));
await mustDeny ('the owner flips visibility', () => updateDoc(doc(gabe, 'scientiaNotes/gabe__dMine'), { visibility: 'lab' }));
await mustDeny ('the PI deletes one',        () => deleteDoc(doc(admin, 'scientiaNotes/gabe__dShared')));

console.log(`\n${ok} ok, ${holes} HOLE, ${breaks} BREAK`);
await env.cleanup();
process.exit(holes || breaks ? 1 : 0);
