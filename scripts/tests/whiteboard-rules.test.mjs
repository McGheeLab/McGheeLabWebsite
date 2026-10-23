/* Whiteboard firestore.rules test (V3.684 / V3.685).
 *
 * Run (same harness as hw-progress-rules.test.mjs):
 *   JAVA_HOME=/opt/homebrew/opt/openjdk@21 PATH=$JAVA_HOME/bin:$PATH \
 *     firebase emulators:exec --only firestore --project demo-mcgheelab-wb \
 *     "node whiteboard-rules.test.mjs"
 * from scripts/tests/ (its firebase.json pins the emulator to port 8199).
 *
 * Collections under test:
 *   schedules/{id}/whiteboards/{bid}[/strokes|/items]  V3.677/684 — live class board
 *   schedules/{id}/notesBoards/{key_uid}[/…]           V3.685 — a student's own notes
 *   schedules/{id}/hwBoards/{key_uid}[/…]              V3.685 — homework working-out
 *   schedules/{id}/directory/{doc}                     V3.685 — opt-in classmate list
 *   schedules/{id}/directoryOptIn/{uid}                V3.685 — the opt-in itself
 *
 * The load-bearing case is the LAST section: a homework board must be
 * unshareable *structurally*, not by a flag a client could flip. The suite
 * proves that even when a student writes sharedWithUids onto their own hwBoard,
 * the named classmate still cannot read it — because hwBoards' rules contain no
 * sharing clause at all.
 *
 * Output marks: ok / HOLE (allowed but shouldn't be) / BREAK (denied but a
 * legitimate user needs it).
 */
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc, getDoc, updateDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';

const RULES = new URL('../../firestore.rules', import.meta.url).pathname;

const env = await initializeTestEnvironment({
  projectId: 'demo-mcgheelab-wb',
  firestore: { rules: readFileSync(RULES, 'utf8'), host: '127.0.0.1', port: 8199 }
});

/* ── personas ── */
const admin = env.authenticatedContext('admin1', { email: 'admin@x.com' }).firestore();
const instr = env.authenticatedContext('inst', { email: 'mcgheealex@arizona.edu' }).firestore();
const ta    = env.authenticatedContext('ta',   { email: 'gabriel@arizona.edu' }).firestore();
const stuA  = env.authenticatedContext('stuA', { email: 'wildcat@arizona.edu' }).firestore();
const stuB  = env.authenticatedContext('stuB', { email: 'sundevil@arizona.edu' }).firestore();
const stuC  = env.authenticatedContext('stuC', { email: 'cactus@arizona.edu' }).firestore();
const anon  = env.unauthenticatedContext().firestore();
/* V3.685 regression persona: a DELEGATED class admin — email is on
   classAdminEmails but they have NO users doc. The old rule led with
   isAdmin(), which dereferences users/{uid} unguarded and therefore RAISED
   for exactly this person, denying the whole expression; bme466's
   ownerUid:null then raised on the next branch too. Both are now guarded. */
const dlg   = env.authenticatedContext('dlg', { email: 'delegate@arizona.edu' }).firestore();

await env.withSecurityRulesDisabled(async (ctx) => {
  const d = ctx.firestore();
  await setDoc(doc(d, 'users/admin1'), { role: 'admin', name: 'Alex' });
  await setDoc(doc(d, 'users/inst'), { role: 'guest' });
  await setDoc(doc(d, 'users/ta'), { role: 'guest' });
  await setDoc(doc(d, 'schedules/bme466'), {
    title: 'BME466', classAdminEmails: ['mcgheealex@arizona.edu', 'delegate@arizona.edu'],
    courseStaffEmails: ['gabriel@arizona.edu'], ownerUid: null  // null on purpose — see dlg
  });
  // a live class board
  await setDoc(doc(d, 'schedules/bme466/whiteboards/b1'),
    { name: 'Week 3', pages: [{ id: 'p1', background: 'grid' }], activePageId: 'p1' });
  // stuA's notes board, shared with stuB but NOT stuC
  await setDoc(doc(d, 'schedules/bme466/notesBoards/w1-diffusion_stuA'),
    { name: 'My notes', ownerUid: 'stuA', sharedWithUids: ['stuB'],
      pages: [{ id: 'p1', background: 'blank' }], activePageId: 'p1' });
  await setDoc(doc(d, 'schedules/bme466/notesBoards/w1-diffusion_stuA/strokes/s1'),
    { pageId: 'p1', seq: 1, color: '#111', w: 0.004, pts: [0, 0, 0.5], done: true });
  // stuA's HOMEWORK board — with a sharedWithUids that must be inert
  await setDoc(doc(d, 'schedules/bme466/hwBoards/bme466-hw1_stuA'),
    { name: 'My work', ownerUid: 'stuA', sharedWithUids: ['stuB', 'stuC'],
      pages: [{ id: 'p1', background: 'blank' }], activePageId: 'p1' });
  await setDoc(doc(d, 'schedules/bme466/hwBoards/bme466-hw1_stuA/strokes/s1'),
    { pageId: 'p1', seq: 1, color: '#111', w: 0.004, pts: [0, 0, 0.5], done: true });
  await setDoc(doc(d, 'schedules/bme466/directory/optedIn'),
    { people: [{ uid: 'stuB', name: 'Sunny' }], count: 1 });
});

const results = [];
async function check(name, expect, fn) {
  let ok = true, err = '';
  try { await fn(); } catch (e) { ok = false; err = String(e.message || e).slice(0, 90); }
  const verdict = (expect === 'allow') ? (ok ? 'ok' : 'BREAK') : (ok ? 'HOLE' : 'ok');
  results.push({ name, verdict, err });
}
const P = 'schedules/bme466';

/* ══ 1. live class board — unchanged V3.677 contract ══ */
await check('anyone (signed out) can READ the live board', 'allow',
  () => getDoc(doc(anon, `${P}/whiteboards/b1`)));
await check('anyone (signed out) can READ its strokes', 'allow',
  () => getDocs(collection(anon, `${P}/whiteboards/b1/strokes`)));
await check('class admin can WRITE a stroke', 'allow',
  () => setDoc(doc(instr, `${P}/whiteboards/b1/strokes/x1`), { pageId: 'p1', seq: 2, pts: [0, 0, 0.5] }));
await check('a student CANNOT write on the live class board', 'deny',
  () => setDoc(doc(stuA, `${P}/whiteboards/b1/strokes/x2`), { pageId: 'p1', seq: 3, pts: [0, 0, 0.5] }));
await check('a student CANNOT add an image item to the live board', 'deny',
  () => setDoc(doc(stuA, `${P}/whiteboards/b1/items/i1`), { pageId: 'p1', type: 'image', url: 'x' }));
await check('class admin CAN add an image item (V3.684 snap)', 'allow',
  () => setDoc(doc(instr, `${P}/whiteboards/b1/items/i2`), { pageId: 'p1', type: 'image', url: 'x' }));

await check('★ delegated class admin with NO users doc can write the live board', 'allow',
  () => setDoc(doc(dlg, `${P}/whiteboards/b1/strokes/x3`), { pageId: 'p1', seq: 4, pts: [0, 0, 0.5] }));
await check('★ ...and can add an image item', 'allow',
  () => setDoc(doc(dlg, `${P}/whiteboards/b1/items/i3`), { pageId: 'p1', type: 'image', url: 'x' }));
await check('★ ...and can update the board doc (page flips)', 'allow',
  () => updateDoc(doc(dlg, `${P}/whiteboards/b1`), { activePageId: 'p1' }));

/* ══ 2. notes board — owner private, explicitly shareable ══ */
await check('owner reads their own notes board', 'allow',
  () => getDoc(doc(stuA, `${P}/notesBoards/w1-diffusion_stuA`)));
await check('owner writes their own notes strokes', 'allow',
  () => setDoc(doc(stuA, `${P}/notesBoards/w1-diffusion_stuA/strokes/s2`), { pageId: 'p1', seq: 2, pts: [0, 0, 0.5] }));
await check('owner can CREATE a board that does not exist yet (first visit)', 'allow',
  () => setDoc(doc(stuB, `${P}/notesBoards/w2-gradients_stuB`), { name: 'My notes', ownerUid: 'stuB', sharedWithUids: [] }));
await check('a classmate CANNOT read a notes board they are not on', 'deny',
  () => getDoc(doc(stuC, `${P}/notesBoards/w1-diffusion_stuA`)));
await check('a classmate CANNOT read its strokes either', 'deny',
  () => getDocs(collection(stuC, `${P}/notesBoards/w1-diffusion_stuA/strokes`)));
await check('a SHARED classmate CAN read the notes board', 'allow',
  () => getDoc(doc(stuB, `${P}/notesBoards/w1-diffusion_stuA`)));
await check('a SHARED classmate CAN read its strokes', 'allow',
  () => getDocs(collection(stuB, `${P}/notesBoards/w1-diffusion_stuA/strokes`)));
await check('a shared classmate CANNOT write on it (read-only share)', 'deny',
  () => setDoc(doc(stuB, `${P}/notesBoards/w1-diffusion_stuA/strokes/evil`), { pageId: 'p1', seq: 9, pts: [0, 0, 0.5] }));
await check('a student CANNOT create a board under another uid', 'deny',
  () => setDoc(doc(stuC, `${P}/notesBoards/w1-diffusion_stuA`), { name: 'hijack' }));
await check('a student CANNOT LIST everyone\'s notes boards', 'deny',
  () => getDocs(collection(stuA, `${P}/notesBoards`)));
await check('signed-out visitor CANNOT read a notes board', 'deny',
  () => getDoc(doc(anon, `${P}/notesBoards/w1-diffusion_stuA`)));
await check('staff CAN read a student notes board (support/grading)', 'allow',
  () => getDoc(doc(instr, `${P}/notesBoards/w1-diffusion_stuA`)));

/* ══ 3. HOMEWORK board — structurally unshareable ══ */
await check('owner reads their own homework board', 'allow',
  () => getDoc(doc(stuA, `${P}/hwBoards/bme466-hw1_stuA`)));
await check('owner writes their own homework strokes', 'allow',
  () => setDoc(doc(stuA, `${P}/hwBoards/bme466-hw1_stuA/strokes/s2`), { pageId: 'p1', seq: 2, pts: [0, 0, 0.5] }));
await check('★ a classmate NAMED in sharedWithUids STILL cannot read the hw board', 'deny',
  () => getDoc(doc(stuB, `${P}/hwBoards/bme466-hw1_stuA`)));
await check('★ ...nor its strokes', 'deny',
  () => getDocs(collection(stuB, `${P}/hwBoards/bme466-hw1_stuA/strokes`)));
await check('★ ...nor its items', 'deny',
  () => getDocs(collection(stuC, `${P}/hwBoards/bme466-hw1_stuA/items`)));
await check('★ a student cannot grant themselves access by writing sharedWithUids', 'deny',
  () => updateDoc(doc(stuC, `${P}/hwBoards/bme466-hw1_stuA`), { sharedWithUids: ['stuC'] }));
await check('signed-out visitor CANNOT read a homework board', 'deny',
  () => getDoc(doc(anon, `${P}/hwBoards/bme466-hw1_stuA`)));
await check('staff CAN read a homework board (grading/support)', 'allow',
  () => getDoc(doc(ta, `${P}/hwBoards/bme466-hw1_stuA`)));
await check('a student CANNOT list all homework boards', 'deny',
  () => getDocs(collection(stuA, `${P}/hwBoards`)));

/* ══ 4. classmate directory ══ */
await check('a NetID student can read the published directory', 'allow',
  () => getDoc(doc(stuA, `${P}/directory/optedIn`)));
await check('signed-out visitor CANNOT read the directory', 'deny',
  () => getDoc(doc(anon, `${P}/directory/optedIn`)));
await check('a student CANNOT publish the directory themselves', 'deny',
  () => setDoc(doc(stuA, `${P}/directory/optedIn`), { people: [], count: 0 }));
await check('staff CAN publish the directory', 'allow',
  () => setDoc(doc(instr, `${P}/directory/optedIn`), { people: [{ uid: 'stuB', name: 'Sunny' }], count: 1 }));
await check('a student can opt IN for themselves', 'allow',
  () => setDoc(doc(stuA, `${P}/directoryOptIn/stuA`), { displayName: 'Wilbur', optIn: true, updatedAt: 'now' }));
await check('a student CANNOT opt someone else in', 'deny',
  () => setDoc(doc(stuA, `${P}/directoryOptIn/stuB`), { displayName: 'Sunny', optIn: true, updatedAt: 'now' }));
await check('opt-in rejects extra fields (closed key set)', 'deny',
  () => setDoc(doc(stuA, `${P}/directoryOptIn/stuA`), { displayName: 'W', optIn: true, updatedAt: 'now', role: 'admin' }));
await check('a student CANNOT list the opt-ins (that would be the roster)', 'deny',
  () => getDocs(collection(stuA, `${P}/directoryOptIn`)));
await check('staff CAN list the opt-ins (to publish the directory)', 'allow',
  () => getDocs(collection(instr, `${P}/directoryOptIn`)));

/* ── report ── */
const bad = results.filter(r => r.verdict !== 'ok');
console.log('\nWhiteboard rules — %d checks · %d ok · %d problems',
  results.length, results.length - bad.length, bad.length);
bad.forEach(r => console.log('  %s %s — %s', r.verdict, r.name, r.err));
await env.cleanup();
process.exit(bad.length ? 1 : 0);
