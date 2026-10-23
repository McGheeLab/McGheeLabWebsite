/* BME466 course-platform firestore.rules test (V3.674 / V3.675 / V3.681).
 *
 * Run (same harness as teacher-rules.test.mjs):
 *   JAVA_HOME=/opt/homebrew/opt/openjdk@21 PATH=$JAVA_HOME/bin:$PATH \
 *     firebase emulators:exec --only firestore --project demo-mcgheelab-hwp \
 *     "node hw-progress-rules.test.mjs"
 * from scripts/tests/ (its firebase.json pins the emulator to port 8199).
 *
 * Collections under test:
 *   hwProgress/{assignment}_{uid}          V3.674 — module autosave
 *   schedules/bme466/roster/{email}        V3.675 — FERPA-sealed, staff only
 *   schedules/bme466/assignments/{slug}    V3.681 — world-readable when published
 *   hw466Status/{slug}_{uid}               V3.681 — self-mark ∪ staff ack
 *   schedules/bme466/threads/{id}[/messages] V3.681 — private, messages immutable
 *   schedules/bme466/profiles/{uid}        V3.681 — sectionClaim vs sectionAssigned
 *
 * The load-bearing case is "narrow TA": `ta` sits ONLY in courseStaffEmails,
 * and the suite proves they can run the course surfaces while still being
 * denied the roster, the schedule doc, and hwProgress delete — i.e. that
 * V3.681 did not quietly undo V3.679.
 *
 * Output marks: ok / HOLE (allowed but shouldn't be) / BREAK (denied but
 * a legitimate user needs it).
 */
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import {
  doc, setDoc, getDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, getDocs, serverTimestamp
} from 'firebase/firestore';

const RULES = new URL('../../firestore.rules', import.meta.url).pathname;

const env = await initializeTestEnvironment({
  projectId: 'demo-mcgheelab-hwp',
  firestore: { rules: readFileSync(RULES, 'utf8'), host: '127.0.0.1', port: 8199 }
});

/* ── personas ── */
const admin    = env.authenticatedContext('admin1', { email: 'admin@x.com' }).firestore();
const instr    = env.authenticatedContext('inst', { email: 'mcgheealex@arizona.edu' }).firestore(); // classAdmin, NOT global admin
const stuA     = env.authenticatedContext('stuA', { email: 'wildcat@arizona.edu' }).firestore();
const stuB     = env.authenticatedContext('stuB', { email: 'sundevil@arizona.edu' }).firestore();
const stuX     = env.authenticatedContext('stuX', { email: 'cactus@arizona.edu' }).firestore();  // arizona.edu but NOT on the roster
const gmailKid = env.authenticatedContext('gm', { email: 'kid@gmail.com' }).firestore();
const anon     = env.unauthenticatedContext().firestore();
// V3.681 narrow TA: courseStaffEmails ONLY — never classAdminEmails.
const ta       = env.authenticatedContext('ta', { email: 'gabriel@arizona.edu' }).firestore();

/* ── seed ── */
await env.withSecurityRulesDisabled(async (ctx) => {
  const d = ctx.firestore();
  await setDoc(doc(d, 'users/admin1'), { role: 'admin', name: 'Alex' });
  await setDoc(doc(d, 'users/inst'), { role: 'guest', name: 'Instructor (class admin only)' });
  await setDoc(doc(d, 'users/ta'), { role: 'guest', name: 'TA (course staff only)' });
  await setDoc(doc(d, 'schedules/bme466'), {
    title: 'BME/AME 466/566 — Biomechanics',
    classAdminEmails: ['mcgheealex@arizona.edu'],
    courseStaffEmails: ['gabriel@arizona.edu'],
    ownerUid: null,
    rosterEnforced: true          // flipped to false mid-suite to test the opt-in
  });
  // V3.675 roster: stuA and stuB are invited; stuX is not.
  await setDoc(doc(d, 'schedules/bme466/roster/wildcat@arizona.edu'),
    { name: 'Wilbur Wildcat', email: 'wildcat@arizona.edu', netid: 'wildcat', role: 'student' });
  await setDoc(doc(d, 'schedules/bme466/roster/sundevil@arizona.edu'),
    { name: 'Sunny Devil', email: 'sundevil@arizona.edu', netid: 'sundevil', role: 'student' });
});

/* ── helpers ── */
const results = [];
async function check(name, expect /* 'allow' | 'deny' */, fn) {
  let ok = true, err = '';
  try { await fn(); } catch (e) { ok = false; err = String(e.message || e).slice(0, 90); }
  const verdict = (expect === 'allow')
    ? (ok ? 'ok' : 'BREAK')
    : (ok ? 'HOLE' : 'ok');
  results.push({ name, expect, got: ok ? 'allow' : 'deny', verdict, err });
}
function goodDoc(email, overrides = {}) {
  return Object.assign({
    schema: 1, assignment: 'bme466-pretest',
    sid_norm: 'bme4667q2m', code: 'TZNX3Q',
    email, name: 'Test Student',
    state: '{"v":1,"answers":{}}', clientSavedAt: 1724700000000,
    updatedAt: serverTimestamp(),
    answeredCount: 3, totalQuestions: 26, runCount: 4,
    secondsActive: 60, lastActiveAt: 1724700000000
  }, overrides);
}

/* ── create ── */
await check('signed-out visitor CANNOT create a progress doc', 'deny',
  () => setDoc(doc(anon, 'hwProgress/bme466-pretest_nobody'), goodDoc('x@arizona.edu')));

await check('NetID student creates their OWN doc', 'allow',
  () => setDoc(doc(stuA, 'hwProgress/bme466-pretest_stuA'), goodDoc('wildcat@arizona.edu')));

await check('student CANNOT create a doc under someone else\'s uid', 'deny',
  () => setDoc(doc(stuA, 'hwProgress/bme466-pretest_stuB'), goodDoc('wildcat@arizona.edu')));

await check('gmail (non-arizona.edu) account CANNOT create', 'deny',
  () => setDoc(doc(gmailKid, 'hwProgress/bme466-pretest_gm'), goodDoc('kid@gmail.com')));

await check('email field must match the auth token (no spoofing)', 'deny',
  () => setDoc(doc(stuB, 'hwProgress/bme466-pretest_stuB'), goodDoc('someoneelse@arizona.edu')));

await check('assignment outside the fixed enum is rejected', 'deny',
  () => setDoc(doc(stuB, 'hwProgress/bme466-hw9_stuB'),
               goodDoc('sundevil@arizona.edu', { assignment: 'bme466-hw9' })));

await check('docId must equal assignment_uid (mismatched assignment prefix)', 'deny',
  () => setDoc(doc(stuB, 'hwProgress/bme466-hw1_stuB'),
               goodDoc('sundevil@arizona.edu', { assignment: 'bme466-pretest' })));

await check('extra key (a grade!) is rejected by the whitelist', 'deny',
  () => setDoc(doc(stuB, 'hwProgress/bme466-pretest_stuB'),
               goodDoc('sundevil@arizona.edu', { grade: 100 })));

await check('missing required key (state) is rejected', 'deny',
  () => { const d = goodDoc('sundevil@arizona.edu'); delete d.state;
          return setDoc(doc(stuB, 'hwProgress/bme466-pretest_stuB'), d); });

await check('updatedAt must be request.time (client number rejected)', 'deny',
  () => setDoc(doc(stuB, 'hwProgress/bme466-pretest_stuB'),
               goodDoc('sundevil@arizona.edu', { updatedAt: 1724700000000 })));

await check('non-string state is rejected', 'deny',
  () => setDoc(doc(stuB, 'hwProgress/bme466-pretest_stuB'),
               goodDoc('sundevil@arizona.edu', { state: { v: 1 } })));

await check('oversized state (>900k chars) is rejected', 'deny',
  () => setDoc(doc(stuB, 'hwProgress/bme466-pretest_stuB'),
               goodDoc('sundevil@arizona.edu', { state: 'x'.repeat(900001) })));

await check('second NetID student creates their own doc (hw enum entry)', 'allow',
  () => setDoc(doc(stuB, 'hwProgress/bme466-hw1_stuB'),
               goodDoc('sundevil@arizona.edu', { assignment: 'bme466-hw1' })));

/* ── update ── */
await check('student updates their own doc (autosave)', 'allow',
  () => setDoc(doc(stuA, 'hwProgress/bme466-pretest_stuA'),
               goodDoc('wildcat@arizona.edu', { answeredCount: 7 })));

await check('student CANNOT update another student\'s doc', 'deny',
  () => setDoc(doc(stuB, 'hwProgress/bme466-pretest_stuA'),
               goodDoc('sundevil@arizona.edu', { answeredCount: 0 })));

/* ── read ── */
await check('student reads their own doc (cross-device resume)', 'allow',
  () => getDoc(doc(stuA, 'hwProgress/bme466-pretest_stuA')));

await check('student CANNOT read another student\'s doc', 'deny',
  () => getDoc(doc(stuB, 'hwProgress/bme466-pretest_stuA')));

await check('signed-out visitor CANNOT read any doc', 'deny',
  () => getDoc(doc(anon, 'hwProgress/bme466-pretest_stuA')));

await check('student CANNOT list the collection (dashboard query)', 'deny',
  () => getDocs(query(collection(stuA, 'hwProgress'),
                      where('assignment', '==', 'bme466-pretest'))));

await check('classAdminEmails instructor lists the dashboard query', 'allow',
  () => getDocs(query(collection(instr, 'hwProgress'),
                      where('assignment', '==', 'bme466-pretest'))));

await check('classAdminEmails instructor reads a single doc', 'allow',
  () => getDoc(doc(instr, 'hwProgress/bme466-pretest_stuA')));

await check('global admin lists the collection', 'allow',
  () => getDocs(collection(admin, 'hwProgress')));

/* ── V3.675 roster gate + roster subcollection ── */
await check('un-rostered arizona.edu student CANNOT create (not invited)', 'deny',
  () => setDoc(doc(stuX, 'hwProgress/bme466-pretest_stuX'), goodDoc('cactus@arizona.edu')));

await check('classAdmin creates their own progress doc without a roster entry', 'allow',
  () => setDoc(doc(instr, 'hwProgress/bme466-pretest_inst'), goodDoc('mcgheealex@arizona.edu')));

await check('student CANNOT read the roster (FERPA — staff only)', 'deny',
  () => getDoc(doc(stuA, 'schedules/bme466/roster/wildcat@arizona.edu')));

await check('student CANNOT list the roster', 'deny',
  () => getDocs(collection(stuA, 'schedules/bme466/roster')));

await check('student CANNOT add themselves to the roster', 'deny',
  () => setDoc(doc(stuX, 'schedules/bme466/roster/cactus@arizona.edu'),
               { name: 'Me', email: 'cactus@arizona.edu', role: 'student' }));

await check('classAdmin instructor adds a roster member (invite)', 'allow',
  () => setDoc(doc(instr, 'schedules/bme466/roster/newkid@arizona.edu'),
               { name: 'New Kid', email: 'newkid@arizona.edu', netid: 'newkid', role: 'student' }));

await check('classAdmin instructor lists the roster', 'allow',
  () => getDocs(collection(instr, 'schedules/bme466/roster')));

await check('classAdmin instructor drops a roster member', 'allow',
  () => deleteDoc(doc(instr, 'schedules/bme466/roster/newkid@arizona.edu')));

await check('global admin writes the roster', 'allow',
  () => setDoc(doc(admin, 'schedules/bme466/roster/ta@arizona.edu'),
               { name: 'The TA', email: 'ta@arizona.edu', netid: 'ta', role: 'ta' }));

/* The gate is OPT-IN: with rosterEnforced off (i.e. before the instructor has
   imported a classlist) an un-rostered @arizona.edu student must still be able
   to save, so a not-yet-imported roster can never lock the class out. */
await env.withSecurityRulesDisabled(async (ctx) => {
  await updateDoc(doc(ctx.firestore(), 'schedules/bme466'), { rosterEnforced: false });
});
await check('rosterEnforced OFF: un-rostered student CAN save (no lockout)', 'allow',
  () => setDoc(doc(stuX, 'hwProgress/bme466-pretest_stuX'), goodDoc('cactus@arizona.edu')));
await check('rosterEnforced OFF: non-arizona.edu is STILL denied', 'deny',
  () => setDoc(doc(gmailKid, 'hwProgress/bme466-pretest_gm'), goodDoc('kid@gmail.com')));
await env.withSecurityRulesDisabled(async (ctx) => {
  await updateDoc(doc(ctx.firestore(), 'schedules/bme466'), { rosterEnforced: true });
});
await check('rosterEnforced back ON: un-rostered student denied again', 'deny',
  () => setDoc(doc(stuX, 'hwProgress/bme466-pretest_stuX'), goodDoc('cactus@arizona.edu')));

await check('classAdmin may flip rosterEnforced on the schedule doc', 'allow',
  () => updateDoc(doc(instr, 'schedules/bme466'), { rosterEnforced: true }));
await check('student CANNOT flip rosterEnforced', 'deny',
  () => updateDoc(doc(stuA, 'schedules/bme466'), { rosterEnforced: false }));

/* ── delete ── */
await check('student CANNOT delete (even their own doc)', 'deny',
  () => deleteDoc(doc(stuA, 'hwProgress/bme466-pretest_stuA')));

await check('classAdminEmails instructor deletes a doc', 'allow',
  () => deleteDoc(doc(instr, 'hwProgress/bme466-hw1_stuB')));

await check('admin deletes a doc', 'allow',
  () => deleteDoc(doc(admin, 'hwProgress/bme466-pretest_stuA')));

/* ══════════════════════════════════════════════════════════════════════════
   V3.681 — course platform
   ══════════════════════════════════════════════════════════════════════════ */

/* ── seed the V3.681 shapes ── */
await env.withSecurityRulesDisabled(async (ctx) => {
  const d = ctx.firestore();
  await setDoc(doc(d, 'schedules/bme466/assignments/hw0-pretest'), {
    slug: 'hw0-pretest', title: 'HW0 — Pretest', kind: 'module',
    audience: 'all', published: true, order: 0
  });
  await setDoc(doc(d, 'schedules/bme466/assignments/hw3-blood'), {
    slug: 'hw3-blood', title: 'HW3 — Blood rheology', kind: 'module',
    audience: 'all', published: false, order: 3
  });
  // A thread authored by stuA, so read/message rules can be tested without
  // depending on an earlier check having succeeded.
  await setDoc(doc(d, 'schedules/bme466/threads/T1'), {
    authorUid: 'stuA', authorEmail: 'wildcat@arizona.edu',
    authorName: 'Wilbur Wildcat', subject: 'Extension for HW3?',
    topic: 'assignment', status: 'open', messageCount: 1
  });
  await setDoc(doc(d, 'schedules/bme466/threads/T1/messages/M1'), {
    authorUid: 'stuA', authorEmail: 'wildcat@arizona.edu',
    authorRole: 'student', body: 'I was in the hospital last week.'
  });
});

const now = () => serverTimestamp();
function goodAssign(o = {}) {
  return Object.assign({
    slug: 'hw4-muscle', title: 'HW4 — Muscle mechanics', kind: 'module',
    audience: 'all', published: false, order: 4,
    updatedBy: 'mcgheealex@arizona.edu', updatedAt: now()
  }, o);
}
function goodStatus(o = {}) {
  return Object.assign({
    assignment: 'hw0-pretest', uid: 'stuA', email: 'wildcat@arizona.edu',
    name: 'Wilbur Wildcat', selfMarked: true, selfMarkedAt: 1724700000000,
    updatedAt: now()
  }, o);
}
function goodThread(o = {}) {
  return Object.assign({
    authorUid: 'stuA', authorEmail: 'wildcat@arizona.edu',
    authorName: 'Wilbur Wildcat', authorRole: 'student',
    subject: 'Question about HW1 part c', topic: 'assignment',
    status: 'open', createdAt: now()
  }, o);
}
function goodMsg(o = {}) {
  return Object.assign({
    authorUid: 'stuA', authorEmail: 'wildcat@arizona.edu',
    authorName: 'Wilbur Wildcat', authorRole: 'student',
    body: 'Is the Damköhler number dimensionless here?', createdAt: now()
  }, o);
}
function goodProfile(o = {}) {
  return Object.assign({
    uid: 'stuA', email: 'wildcat@arizona.edu', displayName: 'Wilbur Wildcat',
    major: 'BME', year: 'senior', sectionClaim: 'BME466', updatedAt: now()
  }, o);
}

/* ── the narrow-TA contract: V3.679 must still hold ────────────────────────
   This is the reason courseStaffEmails exists as a SECOND list. A TA runs the
   course surfaces; a TA is not the instructor. */
await check('TA (courseStaff) CANNOT read the roster (V3.679 holds)', 'deny',
  () => getDoc(doc(ta, 'schedules/bme466/roster/wildcat@arizona.edu')));

await check('TA CANNOT list the roster', 'deny',
  () => getDocs(collection(ta, 'schedules/bme466/roster')));

await check('TA CANNOT write the roster (no CSV import)', 'deny',
  () => setDoc(doc(ta, 'schedules/bme466/roster/ringer@arizona.edu'),
               { name: 'Ringer', email: 'ringer@arizona.edu', role: 'student' }));

await check('TA CANNOT drop a student', 'deny',
  () => deleteDoc(doc(ta, 'schedules/bme466/roster/sundevil@arizona.edu')));

await check('TA CANNOT edit the schedule doc (no page-edit chrome)', 'deny',
  () => updateDoc(doc(ta, 'schedules/bme466'), { title: 'TA was here' }));

await check('TA CANNOT promote themselves to classAdmin', 'deny',
  () => updateDoc(doc(ta, 'schedules/bme466'),
                  { classAdminEmails: ['gabriel@arizona.edu'] }));

await check('TA CANNOT delete a student\'s saved progress', 'deny',
  () => deleteDoc(doc(ta, 'hwProgress/bme466-pretest_stuB')));

await check('TA CAN list hwProgress (the status matrix needs it)', 'allow',
  () => getDocs(query(collection(ta, 'hwProgress'),
                      where('assignment', '==', 'bme466-pretest'))));

/* ── assignments ── */
await check('anonymous visitor reads a PUBLISHED assignment (Homeworks page)', 'allow',
  () => getDoc(doc(anon, 'schedules/bme466/assignments/hw0-pretest')));

await check('anonymous visitor CANNOT read an unpublished draft', 'deny',
  () => getDoc(doc(anon, 'schedules/bme466/assignments/hw3-blood')));

await check('public list WITH where(published==true) is allowed', 'allow',
  () => getDocs(query(collection(anon, 'schedules/bme466/assignments'),
                      where('published', '==', true))));

await check('public list WITHOUT the filter is denied (drafts would leak)', 'deny',
  () => getDocs(collection(anon, 'schedules/bme466/assignments')));

await check('TA lists assignments unfiltered (sees drafts)', 'allow',
  () => getDocs(collection(ta, 'schedules/bme466/assignments')));

await check('student CANNOT create an assignment', 'deny',
  () => setDoc(doc(stuA, 'schedules/bme466/assignments/hw4-muscle'),
               goodAssign({ updatedBy: 'wildcat@arizona.edu' })));

await check('instructor creates an assignment', 'allow',
  () => setDoc(doc(instr, 'schedules/bme466/assignments/hw4-muscle'), goodAssign()));

await check('TA creates/edits an assignment', 'allow',
  () => setDoc(doc(ta, 'schedules/bme466/assignments/hw5-gait'),
               goodAssign({ slug: 'hw5-gait', title: 'HW5 — Gait',
                            updatedBy: 'gabriel@arizona.edu' })));

await check('instructor publishes an assignment (update)', 'allow',
  () => updateDoc(doc(instr, 'schedules/bme466/assignments/hw4-muscle'),
                  { published: true, updatedAt: now(),
                    updatedBy: 'mcgheealex@arizona.edu' }));

await check('a grade field on an assignment is rejected (D2L is the gradebook)', 'deny',
  () => setDoc(doc(instr, 'schedules/bme466/assignments/hw6-x'),
               goodAssign({ slug: 'hw6-x', grade: 100 })));

await check('a per-student dueOverrides map is rejected (FERPA: world-readable)', 'deny',
  () => setDoc(doc(instr, 'schedules/bme466/assignments/hw6-x'),
               goodAssign({ slug: 'hw6-x', dueOverrides: { stuA: 1 } })));

await check('unknown audience value is rejected', 'deny',
  () => setDoc(doc(instr, 'schedules/bme466/assignments/hw6-x'),
               goodAssign({ slug: 'hw6-x', audience: 'grad-only' })));

await check('unknown kind value is rejected', 'deny',
  () => setDoc(doc(instr, 'schedules/bme466/assignments/hw6-x'),
               goodAssign({ slug: 'hw6-x', kind: 'quiz' })));

await check('slug field must match the doc id', 'deny',
  () => setDoc(doc(instr, 'schedules/bme466/assignments/hw6-x'),
               goodAssign({ slug: 'something-else' })));

await check('slug with an underscore is rejected (docId.split parsing)', 'deny',
  () => setDoc(doc(instr, 'schedules/bme466/assignments/hw6_x'),
               goodAssign({ slug: 'hw6_x' })));

await check('empty title is rejected', 'deny',
  () => setDoc(doc(instr, 'schedules/bme466/assignments/hw6-x'),
               goodAssign({ slug: 'hw6-x', title: '' })));

await check('client-clock updatedAt is rejected', 'deny',
  () => setDoc(doc(instr, 'schedules/bme466/assignments/hw6-x'),
               goodAssign({ slug: 'hw6-x', updatedAt: 1724700000000 })));

await check('updatedBy must be the caller\'s own email', 'deny',
  () => setDoc(doc(ta, 'schedules/bme466/assignments/hw6-x'),
               goodAssign({ slug: 'hw6-x', updatedBy: 'mcgheealex@arizona.edu' })));

await check('TA CANNOT delete an assignment', 'deny',
  () => deleteDoc(doc(ta, 'schedules/bme466/assignments/hw5-gait')));

await check('instructor deletes an assignment', 'allow',
  () => deleteDoc(doc(instr, 'schedules/bme466/assignments/hw5-gait')));

/* ── hw466Status: self-mark ∪ staff ack, pinned both directions ── */
await check('student self-marks their own assignment', 'allow',
  () => setDoc(doc(stuA, 'hw466Status/hw0-pretest_stuA'), goodStatus()));

await check('student CANNOT create a status doc under another uid', 'deny',
  () => setDoc(doc(stuA, 'hw466Status/hw0-pretest_stuB'),
               goodStatus({ uid: 'stuB' })));

await check('student CANNOT forge a staff acknowledgement', 'deny',
  () => setDoc(doc(stuB, 'hw466Status/hw0-pretest_stuB'),
               goodStatus({ uid: 'stuB', email: 'sundevil@arizona.edu',
                            ackBy: 'mcgheealex@arizona.edu' })));

await check('student CANNOT grant themselves an extension', 'deny',
  () => setDoc(doc(stuB, 'hw466Status/hw0-pretest_stuB'),
               goodStatus({ uid: 'stuB', email: 'sundevil@arizona.edu',
                            dueOverrideAt: 1893456000000 })));

await check('status doc with a score field is rejected', 'deny',
  () => setDoc(doc(stuB, 'hw466Status/hw0-pretest_stuB'),
               goodStatus({ uid: 'stuB', email: 'sundevil@arizona.edu', score: 95 })));

await check('over-long student note (>500) is rejected', 'deny',
  () => setDoc(doc(stuB, 'hw466Status/hw0-pretest_stuB'),
               goodStatus({ uid: 'stuB', email: 'sundevil@arizona.edu',
                            note: 'x'.repeat(501) })));

await check('student updates their own self-mark', 'allow',
  () => updateDoc(doc(stuA, 'hw466Status/hw0-pretest_stuA'),
                  { selfMarked: false, note: 'uploaded the wrong file', updatedAt: now() }));

await check('student CANNOT add ackBy to their own doc', 'deny',
  () => updateDoc(doc(stuA, 'hw466Status/hw0-pretest_stuA'),
                  { ackBy: 'mcgheealex@arizona.edu', updatedAt: now() }));

await check('TA acknowledges + leaves feedback', 'allow',
  () => updateDoc(doc(ta, 'hw466Status/hw0-pretest_stuA'),
                  { ackBy: 'gabriel@arizona.edu', ackAt: 1724700000000,
                    feedback: 'Got it, thanks.', updatedAt: now() }));

await check('TA grants a per-student extension', 'allow',
  () => updateDoc(doc(ta, 'hw466Status/hw0-pretest_stuA'),
                  { dueOverrideAt: 1893456000000, extensionNote: 'medical',
                    updatedAt: now() }));

await check('staff CANNOT forge a student self-mark', 'deny',
  () => updateDoc(doc(instr, 'hw466Status/hw0-pretest_stuA'),
                  { selfMarked: true, updatedAt: now() }));

await check('over-long staff feedback (>2000) is rejected', 'deny',
  () => updateDoc(doc(instr, 'hw466Status/hw0-pretest_stuA'),
                  { feedback: 'x'.repeat(2001), updatedAt: now() }));

await check('staff open a status doc before the student starts (extension)', 'allow',
  () => setDoc(doc(instr, 'hw466Status/hw3-blood_stuB'),
               { assignment: 'hw3-blood', uid: 'stuB', email: 'sundevil@arizona.edu',
                 dueOverrideAt: 1893456000000, extensionNote: 'travel',
                 updatedAt: now() }));

await check('student reads their own status doc', 'allow',
  () => getDoc(doc(stuA, 'hw466Status/hw0-pretest_stuA')));

await check('student CANNOT read another student\'s status doc', 'deny',
  () => getDoc(doc(stuB, 'hw466Status/hw0-pretest_stuA')));

await check('student CANNOT list hw466Status', 'deny',
  () => getDocs(query(collection(stuA, 'hw466Status'),
                      where('assignment', '==', 'hw0-pretest'))));

await check('TA lists hw466Status (status matrix)', 'allow',
  () => getDocs(query(collection(ta, 'hw466Status'),
                      where('assignment', '==', 'hw0-pretest'))));

await check('TA CANNOT delete a status doc', 'deny',
  () => deleteDoc(doc(ta, 'hw466Status/hw3-blood_stuB')));

await check('instructor deletes a status doc', 'allow',
  () => deleteDoc(doc(instr, 'hw466Status/hw3-blood_stuB')));

/* ── threads + messages ── */
await check('student opens a request thread', 'allow',
  () => addDoc(collection(stuA, 'schedules/bme466/threads'), goodThread()));

await check('student CANNOT open a thread as another user', 'deny',
  () => addDoc(collection(stuA, 'schedules/bme466/threads'),
               goodThread({ authorUid: 'stuB' })));

await check('student CANNOT claim authorRole:staff on a thread', 'deny',
  () => addDoc(collection(stuA, 'schedules/bme466/threads'),
               goodThread({ authorRole: 'staff' })));

await check('thread with an unknown topic is rejected', 'deny',
  () => addDoc(collection(stuA, 'schedules/bme466/threads'),
               goodThread({ topic: 'gossip' })));

await check('thread with an over-long subject is rejected', 'deny',
  () => addDoc(collection(stuA, 'schedules/bme466/threads'),
               goodThread({ subject: 'x'.repeat(161) })));

await check('thread cannot be created pre-answered', 'deny',
  () => addDoc(collection(stuA, 'schedules/bme466/threads'),
               goodThread({ status: 'answered' })));

await check('non-arizona.edu account CANNOT open a thread', 'deny',
  () => addDoc(collection(gmailKid, 'schedules/bme466/threads'),
               goodThread({ authorUid: 'gm', authorEmail: 'kid@gmail.com' })));

await check('thread author reads their own thread', 'allow',
  () => getDoc(doc(stuA, 'schedules/bme466/threads/T1')));

await check('a third student CANNOT read someone else\'s thread', 'deny',
  () => getDoc(doc(stuB, 'schedules/bme466/threads/T1')));

await check('TA reads a student thread (the inbox)', 'allow',
  () => getDoc(doc(ta, 'schedules/bme466/threads/T1')));

await check('author lists their OWN threads (filtered by authorUid)', 'allow',
  () => getDocs(query(collection(stuA, 'schedules/bme466/threads'),
                      where('authorUid', '==', 'stuA'))));

await check('student CANNOT list all threads', 'deny',
  () => getDocs(collection(stuB, 'schedules/bme466/threads')));

await check('TA lists all threads (inbox)', 'allow',
  () => getDocs(collection(ta, 'schedules/bme466/threads')));

await check('author posts a message in their thread', 'allow',
  () => addDoc(collection(stuA, 'schedules/bme466/threads/T1/messages'), goodMsg()));

await check('author CANNOT post a message signed as staff', 'deny',
  () => addDoc(collection(stuA, 'schedules/bme466/threads/T1/messages'),
               goodMsg({ authorRole: 'staff' })));

await check('a third student CANNOT post into someone else\'s thread', 'deny',
  () => addDoc(collection(stuB, 'schedules/bme466/threads/T1/messages'),
               goodMsg({ authorUid: 'stuB', authorEmail: 'sundevil@arizona.edu' })));

await check('a third student CANNOT read the messages', 'deny',
  () => getDocs(collection(stuB, 'schedules/bme466/threads/T1/messages')));

await check('TA replies (authorRole staff is PROVEN, not claimed)', 'allow',
  () => addDoc(collection(ta, 'schedules/bme466/threads/T1/messages'),
               goodMsg({ authorUid: 'ta', authorEmail: 'gabriel@arizona.edu',
                         authorRole: 'staff', body: 'Send me the note and I will extend it.' })));

await check('staff CANNOT post pretending to be a student', 'deny',
  () => addDoc(collection(ta, 'schedules/bme466/threads/T1/messages'),
               goodMsg({ authorUid: 'ta', authorEmail: 'gabriel@arizona.edu',
                         authorRole: 'student' })));

await check('empty message body is rejected', 'deny',
  () => addDoc(collection(stuA, 'schedules/bme466/threads/T1/messages'),
               goodMsg({ body: '' })));

await check('over-long message body (>4000) is rejected', 'deny',
  () => addDoc(collection(stuA, 'schedules/bme466/threads/T1/messages'),
               goodMsg({ body: 'x'.repeat(4001) })));

await check('a posted message is IMMUTABLE (author cannot edit)', 'deny',
  () => updateDoc(doc(stuA, 'schedules/bme466/threads/T1/messages/M1'),
                  { body: 'actually never mind' }));

await check('a posted message is IMMUTABLE (staff cannot edit)', 'deny',
  () => updateDoc(doc(instr, 'schedules/bme466/threads/T1/messages/M1'),
                  { body: 'redacted' }));

await check('a posted message cannot be deleted (even by admin)', 'deny',
  () => deleteDoc(doc(admin, 'schedules/bme466/threads/T1/messages/M1')));

await check('author closes their own thread', 'allow',
  () => updateDoc(doc(stuA, 'schedules/bme466/threads/T1'),
                  { status: 'closed', updatedAt: now() }));

await check('author CANNOT mark their own thread answered', 'deny',
  () => updateDoc(doc(stuA, 'schedules/bme466/threads/T1'),
                  { status: 'answered', updatedAt: now() }));

await check('author CANNOT reassign the thread', 'deny',
  () => updateDoc(doc(stuA, 'schedules/bme466/threads/T1'),
                  { assignedTo: 'gabriel@arizona.edu', updatedAt: now() }));

await check('author CANNOT fake the function-owned message counter', 'deny',
  () => updateDoc(doc(stuA, 'schedules/bme466/threads/T1'),
                  { messageCount: 99, updatedAt: now() }));

await check('TA marks a thread answered and assigns it', 'allow',
  () => updateDoc(doc(ta, 'schedules/bme466/threads/T1'),
                  { status: 'answered', assignedTo: 'gabriel@arizona.edu',
                    unreadForStaff: false, updatedAt: now() }));

await check('TA CANNOT delete a thread', 'deny',
  () => deleteDoc(doc(ta, 'schedules/bme466/threads/T1')));

/* ── profiles: sectionClaim (student) vs sectionAssigned (staff) ── */
await check('student creates their own profile with a section claim', 'allow',
  () => setDoc(doc(stuA, 'schedules/bme466/profiles/stuA'), goodProfile()));

await check('student CANNOT assign themselves a staff-assigned section', 'deny',
  () => setDoc(doc(stuB, 'schedules/bme466/profiles/stuB'),
               goodProfile({ uid: 'stuB', email: 'sundevil@arizona.edu',
                             sectionAssigned: 'BME566' })));

await check('unknown section code is rejected', 'deny',
  () => setDoc(doc(stuB, 'schedules/bme466/profiles/stuB'),
               goodProfile({ uid: 'stuB', email: 'sundevil@arizona.edu',
                             sectionClaim: 'ECE466' })));

await check('student CANNOT write another student\'s profile', 'deny',
  () => setDoc(doc(stuB, 'schedules/bme466/profiles/stuA'),
               goodProfile({ displayName: 'Not Wilbur' })));

await check('non-arizona.edu account CANNOT create a profile', 'deny',
  () => setDoc(doc(gmailKid, 'schedules/bme466/profiles/gm'),
               goodProfile({ uid: 'gm', email: 'kid@gmail.com' })));

await check('student updates their own claim', 'allow',
  () => updateDoc(doc(stuA, 'schedules/bme466/profiles/stuA'),
                  { sectionClaim: 'BME566', updatedAt: now() }));

await check('TA assigns the registrar-truth section (wins over the claim)', 'allow',
  () => updateDoc(doc(ta, 'schedules/bme466/profiles/stuA'),
                  { sectionAssigned: 'BME466', sectionAssignedBy: 'gabriel@arizona.edu',
                    sectionAssignedAt: 1724700000000, updatedAt: now() }));

await check('staff CANNOT overwrite the student\'s own claim', 'deny',
  () => updateDoc(doc(instr, 'schedules/bme466/profiles/stuA'),
                  { sectionClaim: 'AME466', updatedAt: now() }));

await check('staff cannot assign an unknown section code', 'deny',
  () => updateDoc(doc(instr, 'schedules/bme466/profiles/stuA'),
                  { sectionAssigned: 'BME999', updatedAt: now() }));

await check('student reads their own profile', 'allow',
  () => getDoc(doc(stuA, 'schedules/bme466/profiles/stuA')));

await check('student CANNOT read another student\'s profile', 'deny',
  () => getDoc(doc(stuB, 'schedules/bme466/profiles/stuA')));

await check('TA reads a student profile (needs the section)', 'allow',
  () => getDoc(doc(ta, 'schedules/bme466/profiles/stuA')));

await check('TA lists profiles (section roster)', 'allow',
  () => getDocs(collection(ta, 'schedules/bme466/profiles')));

await check('student CANNOT list profiles', 'deny',
  () => getDocs(collection(stuA, 'schedules/bme466/profiles')));

/* ── hwProgressKeys: the assignment enum is now DATA ──
   Legacy keys are checked FIRST and inline, so they never depend on the
   schedule doc; a new key works only once the instructor lists it. */
await check('a new module key is denied before it is listed', 'deny',
  () => setDoc(doc(stuA, 'hwProgress/bme466-hw8_stuA'),
               goodDoc('wildcat@arizona.edu', { assignment: 'bme466-hw8' })));

await check('classAdmin adds the key to hwProgressKeys', 'allow',
  () => updateDoc(doc(instr, 'schedules/bme466'),
                  { hwProgressKeys: ['bme466-hw8'] }));

await check('the newly listed key is now accepted (no rules redeploy)', 'allow',
  () => setDoc(doc(stuA, 'hwProgress/bme466-hw8_stuA'),
               goodDoc('wildcat@arizona.edu', { assignment: 'bme466-hw8' })));

await check('an unlisted key is still denied', 'deny',
  () => setDoc(doc(stuA, 'hwProgress/bme466-hw9_stuA'),
               goodDoc('wildcat@arizona.edu', { assignment: 'bme466-hw9' })));

await check('TA CANNOT extend the assignment enum', 'deny',
  () => updateDoc(doc(ta, 'schedules/bme466'),
                  { hwProgressKeys: ['bme466-hw8', 'bme466-anything'] }));

await env.withSecurityRulesDisabled(async (ctx) => {
  await updateDoc(doc(ctx.firestore(), 'schedules/bme466'), { hwProgressKeys: [] });
});
await check('legacy key still works with hwProgressKeys emptied', 'allow',
  () => setDoc(doc(stuA, 'hwProgress/bme466-hw2_stuA'),
               goodDoc('wildcat@arizona.edu', { assignment: 'bme466-hw2' })));

/* ── report ── */
const pad = (s, n) => String(s).padEnd(n);
console.log('\n' + '='.repeat(100));
for (const r of results) {
  const mark = r.verdict === 'ok' ? '  ok  ' : ` ${r.verdict} `;
  console.log(`${pad(mark, 8)} ${pad(r.name, 64)} expect=${pad(r.expect, 6)} got=${r.got}`);
}
const bad = results.filter(r => r.verdict !== 'ok');
console.log('='.repeat(100));
console.log(`${results.length} checks · ${results.length - bad.length} as intended · ${bad.length} deviations`);
for (const r of bad) console.log(`  ${r.verdict}: ${r.name}${r.err ? ' — ' + r.err : ''}`);
await env.cleanup();
process.exit(bad.length ? 1 : 0);
