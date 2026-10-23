/* V3.805 — profile bootstrap must never overwrite an existing users/{uid}.
 *
 * Incident (2026-10-13): rm/js/profile-bootstrap.js ran on a null profile that
 * meant "the read failed", not "the doc is missing", and merge-wrote
 * { role:'guest', category:'guest', name, photo, createdAt, updatedAt } over
 * the PI's doc. The users update rule allows an admin to rewrite their own
 * role, so the write landed and the only admin locked himself out of RM.
 *
 * This file pins down:
 *   1. The V3.806 rules guard: nobody changes their own role, admins
 *      included, so the incident's write is now denied for the PI as it
 *      always was for members, while admins still manage everyone else.
 *   2. The fix: the create-only transaction (same shape as profile-bootstrap.js
 *      and user-system.js _ensureGuestDoc) leaves an existing doc untouched,
 *      and still creates the guest doc on a true first sign-in.
 *
 * Setup + run (same harness as paper-create-rules.test.mjs):
 *   cd scripts/tests
 *   JAVA_HOME=/opt/homebrew/opt/openjdk@21 PATH=$JAVA_HOME/bin:$PATH \
 *     firebase emulators:exec --only firestore --project demo-mcgheelab-boot \
 *     "node profile-bootstrap-rules.test.mjs"
 *
 * Output marks: ok / HOLE (allowed, should deny) / BREAK (denied, should allow)
 * / WRONG (allowed as expected, but the doc ended up in the wrong state).
 */
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc, getDoc, runTransaction, serverTimestamp, setLogLevel } from 'firebase/firestore';

setLogLevel('silent');

const RULES = new URL('../../firestore.rules', import.meta.url).pathname;
const env = await initializeTestEnvironment({
  projectId: 'demo-mcgheelab-boot',
  firestore: { rules: readFileSync(RULES, 'utf8'), host: '127.0.0.1', port: 8199 }
});

let ok = 0, holes = 0, breaks = 0, wrong = 0;
async function mustAllow(name, fn) {
  try { await fn(); console.log('  ok    ' + name); ok++; }
  catch (e) { console.log('  BREAK ' + name + '  — ' + (e.code || e.message)); breaks++; }
}
async function mustDeny(name, fn) {
  try { await fn(); console.log('  HOLE  ' + name); holes++; }
  catch (e) { console.log('  ok    ' + name); ok++; }
}
function expect(name, cond, detail) {
  if (cond) { console.log('  ok    ' + name); ok++; }
  else { console.log('  WRONG ' + name + '  — ' + detail); wrong++; }
}

// The bootstrap payload, exactly as profile-bootstrap.js builds it.
function guestPayload(name) {
  const now = serverTimestamp();
  return { email: name + '@x.com', name, role: 'guest', category: 'guest', createdAt: now, updatedAt: now,
           photo: { thumb: 'g.png', medium: 'g.png', full: 'g.png' } };
}
// The V3.805 create-only transaction.
function bootstrap(db, uid) {
  const ref = doc(db, 'users/' + uid);
  return runTransaction(db, async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists()) t.set(ref, guestPayload(uid));
  });
}

async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, 'users/pi'),     { role: 'admin',  category: 'pi',   name: 'Alexander McGhee', bio: 'PI bio', photo: { thumb: 'team.webp' } });
    await setDoc(doc(d, 'users/member'), { role: 'editor', category: 'grad', name: 'Grad Student',     bio: 'grad bio' });
  });
}
async function read(uid) {
  let data = null;
  await env.withSecurityRulesDisabled(async (ctx) => { data = (await getDoc(doc(ctx.firestore(), 'users/' + uid))).data() || null; });
  return data;
}

const pi     = env.authenticatedContext('pi').firestore();
const member = env.authenticatedContext('member').firestore();
const fresh  = env.authenticatedContext('fresh').firestore();

console.log('\n1. the old merge write (V3.805 allowed it for an admin; V3.806 rules deny it)');
await seed();
await mustDeny('admin owner: guest merge-write over own admin doc is DENIED (the 2026-10-13 incident)',
  () => setDoc(doc(pi, 'users/pi'), guestPayload('pi'), { merge: true }));
const notClobbered = await read('pi');
expect('…and the doc is still admin', notClobbered.role === 'admin' && notClobbered.category === 'pi', JSON.stringify(notClobbered));
await mustDeny('member owner: the same merge-write is DENIED (role is frozen for non-admins)',
  () => setDoc(doc(member, 'users/member'), guestPayload('member'), { merge: true }));

console.log('\n1b. V3.806 self-role guard: what admins can still do');
await seed();
await mustAllow('admin: change ANOTHER user\'s role', () => setDoc(doc(pi, 'users/member'), { role: 'contributor' }, { merge: true }));
await mustAllow('admin: edit own name/bio/photo/category (role unchanged)',
  () => setDoc(doc(pi, 'users/pi'), { name: 'A. McGhee', bio: 'new', category: 'pi', photo: { thumb: 'x.webp' } }, { merge: true }));
await mustDeny('admin: promote/demote SELF (any role change)', () => setDoc(doc(pi, 'users/pi'), { role: 'editor' }, { merge: true }));
await mustAllow('member: edit own bio (role unchanged)', () => setDoc(doc(member, 'users/member'), { bio: 'x' }, { merge: true }));
await mustDeny('member: promote self to admin', () => setDoc(doc(member, 'users/member'), { role: 'admin' }, { merge: true }));

console.log('\n2. the V3.805 create-only transaction');
await seed();
await mustAllow('admin owner: bootstrap transaction on an existing doc runs', () => bootstrap(pi, 'pi'));
const piAfter = await read('pi');
expect('…and leaves role/category/name/photo/bio untouched',
  piAfter.role === 'admin' && piAfter.category === 'pi' && piAfter.name === 'Alexander McGhee'
    && piAfter.bio === 'PI bio' && piAfter.photo.thumb === 'team.webp',
  JSON.stringify(piAfter));
await mustAllow('member owner: bootstrap transaction on an existing doc runs', () => bootstrap(member, 'member'));
const memberAfter = await read('member');
expect('…and leaves the member doc untouched', memberAfter.role === 'editor' && memberAfter.bio === 'grad bio', JSON.stringify(memberAfter));
await mustAllow('first sign-in: bootstrap transaction creates the missing doc', () => bootstrap(fresh, 'fresh'));
const freshAfter = await read('fresh');
expect('…as a guest', freshAfter && freshAfter.role === 'guest' && freshAfter.category === 'guest', JSON.stringify(freshAfter));
await mustDeny('a user cannot bootstrap someone else\'s missing doc', () => bootstrap(fresh, 'someone-else'));

console.log(`\n${ok} ok, ${holes} HOLE, ${breaks} BREAK, ${wrong} WRONG`);
await env.cleanup();
process.exit(holes || breaks || wrong ? 1 : 0);
