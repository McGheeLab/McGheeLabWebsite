/* Teacher/student platform (V3.304) firestore.rules stress test.
 *
 * Setup + run (see CodeLog/ClaudesPlan/V3.632_teacher_rules_findings.md):
 *   npm install --legacy-peer-deps @firebase/rules-unit-testing@5 firebase@11
 *   JAVA_HOME=/opt/homebrew/opt/openjdk@21 PATH=$JAVA_HOME/bin:$PATH \
 *     firebase emulators:exec --only firestore --project demo-mcgheelab-tc \
 *     "node teacher-rules.test.mjs"
 *
 * Needs a firebase.json in the working directory with a firestore entry and
 * emulators.firestore.port = 8199; the rules themselves are uploaded from the
 * repo file by initializeTestEnvironment, so the emulator's own rules path is
 * irrelevant. Java 21+ required (firebase-tools 15 rejects older JDKs).
 *
 * Every case declares what SHOULD happen. Output marks:
 *   ok    — behaves as the V3.304 plan intends
 *   HOLE  — succeeded when it should have been denied
 *   BREAK — denied when a legitimate user needs it to work
 */
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import {
  doc, setDoc, getDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, getDocs, orderBy, limit
} from 'firebase/firestore';

// Repo root, two levels up from scripts/tests/.
const RULES = new URL('../../firestore.rules', import.meta.url).pathname;

const env = await initializeTestEnvironment({
  projectId: 'demo-mcgheelab-tc',
  firestore: { rules: readFileSync(RULES, 'utf8'), host: '127.0.0.1', port: 8199 }
});

/* ── personas ── */
const admin    = env.authenticatedContext('admin1', { email: 'admin@x.com' }).firestore();
const teacherA = env.authenticatedContext('tA', { email: 'ta@school.edu' }).firestore();
const teacherB = env.authenticatedContext('tB', { email: 'tb@school.edu' }).firestore();
const studentS = env.authenticatedContext('sS', { email: 'ss@school.edu' }).firestore();
const studentR = env.authenticatedContext('sR', { email: 'sr@school.edu' }).firestore(); // removed student
const outsider = env.authenticatedContext('out', { email: 'out@x.com' }).firestore();
const member   = env.authenticatedContext('mem', { email: 'mem@arizona.edu' }).firestore();
const fresh    = env.authenticatedContext('newbie', { email: 'newbie@gmail.com' }).firestore();
const anon     = env.unauthenticatedContext().firestore();

/* ── seed ── */
await env.withSecurityRulesDisabled(async (ctx) => {
  const d = ctx.firestore();
  await setDoc(doc(d, 'users/admin1'), { role: 'admin', name: 'Alex' });
  await setDoc(doc(d, 'users/tA'), { role: 'guest', category: 'teacher', name: 'Teacher A' });
  await setDoc(doc(d, 'users/tB'), { role: 'guest', category: 'teacher', name: 'Teacher B' });
  await setDoc(doc(d, 'users/sS'), { role: 'guest', category: 'student', name: 'Student S' });
  await setDoc(doc(d, 'users/sR'), { role: 'guest', category: 'student', name: 'Student R' });
  await setDoc(doc(d, 'users/out'), { role: 'guest', name: 'Outsider' });
  await setDoc(doc(d, 'users/mem'), { role: 'editor', category: 'grad', name: 'Lab Member' });
  // NOTE: no users/newbie — first-sign-in bootstrap reads a doc that isn't there yet.

  await setDoc(doc(d, 'schedules/tc-a'), {
    kind: 'teacher-class', title: 'A Class', ownerUid: 'tA', teacherUid: 'tA',
    school: 'A School', grantedFolders: ['optics'], modules: [], enrollmentOpen: true,
    classAdminEmails: []
  });
  await setDoc(doc(d, 'schedules/tc-b'), {
    kind: 'teacher-class', title: 'B Class', ownerUid: 'tB', teacherUid: 'tB',
    school: 'B School', grantedFolders: ['optics'], modules: [], enrollmentOpen: true,
    classAdminEmails: []
  });
  await setDoc(doc(d, 'schedules/tc-closed'), {
    kind: 'teacher-class', title: 'Closed', ownerUid: 'tA', teacherUid: 'tA',
    grantedFolders: ['optics'], modules: [], enrollmentOpen: false, classAdminEmails: []
  });

  await setDoc(doc(d, 'joinCodes/AAA111'), { scheduleId: 'tc-a', teacherUid: 'tA', active: true });
  await setDoc(doc(d, 'joinCodes/DEAD11'), { scheduleId: 'tc-a', teacherUid: 'tA', active: false });
  await setDoc(doc(d, 'joinCodes/BBB222'), { scheduleId: 'tc-b', teacherUid: 'tB', active: true });
  await setDoc(doc(d, 'joinCodes/CLS111'), { scheduleId: 'tc-closed', teacherUid: 'tA', active: true });

  await setDoc(doc(d, 'enrollments/tc-a_sS'), {
    scheduleId: 'tc-a', studentUid: 'sS', teacherUid: 'tA', joinCode: 'AAA111',
    status: 'active', studentName: 'Student S'
  });
  await setDoc(doc(d, 'enrollments/tc-a_sR'), {
    scheduleId: 'tc-a', studentUid: 'sR', teacherUid: 'tA', joinCode: 'AAA111',
    status: 'removed', removedBy: 'teacher', studentName: 'Student R'
  });

  await setDoc(doc(d, 'enrollments/tc-b_sR'), {
    scheduleId: 'tc-b', studentUid: 'sR', teacherUid: 'tB', joinCode: 'GONE11',
    status: 'removed', studentName: 'Student R'   // self-leave: no removedBy
  });

  // "Delete class" leaves enrollments behind for audit — this is that state:
  // an intact enrollment whose schedules/{id} doc is gone.
  await setDoc(doc(d, 'enrollments/tc-vanished_sS'), {
    scheduleId: 'tc-vanished', studentUid: 'sS', teacherUid: 'tA', joinCode: 'AAA111',
    status: 'active', studentName: 'Student S'
  });

  await setDoc(doc(d, 'reviews/r-approved'), {
    authorUid: 'sS', authorRole: 'student', scheduleId: 'tc-a', teacherUid: 'tA',
    rating: 5, text: 'great', status: 'approved', featured: false, createdAt: new Date()
  });
  await setDoc(doc(d, 'reviews/r-pending'), {
    authorUid: 'sR', authorRole: 'student', scheduleId: 'tc-a', teacherUid: 'tA',
    rating: 2, text: 'meh', status: 'pending', featured: false, createdAt: new Date()
  });

  await setDoc(doc(d, 'teacherProfiles/tA'), {
    uid: 'tA', name: 'Teacher A', school: 'A School', status: 'approved'
  });
  // NOTE: no teacherProfiles/tB — first-run read of a nonexistent doc.

  await setDoc(doc(d, 'classRequests/req-a'), {
    teacherUid: 'tA', teacherName: 'Teacher A', school: 'A School',
    requestedFolders: ['optics'], status: 'pending', createdAt: new Date()
  });
});

/* ── runner ── */
const results = [];
async function check(name, expect /* 'allow' | 'deny' */, fn) {
  let ok = false, err = null;
  try { await fn(); ok = true; } catch (e) { err = e; }
  const verdict = ok === (expect === 'allow')
    ? 'ok'
    : (ok ? 'HOLE' : 'BREAK');
  results.push({ name, expect, got: ok ? 'allowed' : 'denied', verdict, err: err?.code || err?.message });
}

/* ================= SCHEDULES / PROVISIONING ================= */
await check('anon can read a teacher class page (public schedules read)', 'allow',
  () => getDoc(doc(anon, 'schedules/tc-a')));

await check('teacher lists own classes (ownerUid ==)', 'allow',
  () => getDocs(query(collection(teacherA, 'schedules'), where('ownerUid', '==', 'tA'))));

await check('teacher renames own class', 'allow',
  () => updateDoc(doc(teacherA, 'schedules/tc-a'), { title: 'A Class v2' }));

await check('teacher CANNOT expand own grantedFolders', 'deny',
  () => updateDoc(doc(teacherA, 'schedules/tc-a'), { grantedFolders: ['optics', 'heat_transfer'] }));

await check('teacher CANNOT hand class to someone else', 'deny',
  () => updateDoc(doc(teacherA, 'schedules/tc-a'), { ownerUid: 'tB' }));

await check('teacher CANNOT shed the teacher-class kind marker', 'deny',
  () => updateDoc(doc(teacherA, 'schedules/tc-a'), { kind: '' }));

await check('teacher B CANNOT edit teacher A class', 'deny',
  () => updateDoc(doc(teacherB, 'schedules/tc-a'), { title: 'hacked' }));

await check('teacher CANNOT self-provision a class with every module set', 'deny',
  () => setDoc(doc(teacherA, 'schedules/tc-selfmade'), {
    kind: 'teacher-class', title: 'Self Made', ownerUid: 'tA', teacherUid: 'tA',
    grantedFolders: ['optics', 'heat_transfer', 'solid_mechanics', 'surface_functionalization'],
    modules: [], enrollmentOpen: true
  }));

await check('random guest CANNOT self-provision a teacher class', 'deny',
  () => setDoc(doc(outsider, 'schedules/tc-outsider'), {
    kind: 'teacher-class', title: 'Outsider', ownerUid: 'out', grantedFolders: ['optics'], modules: []
  }));

/* ================= JOIN CODES ================= */
await check('student gets a code by exact id (enroll path)', 'allow',
  () => getDoc(doc(studentS, 'joinCodes/AAA111')));

await check('student CANNOT list all join codes', 'deny',
  () => getDocs(collection(studentS, 'joinCodes')));

await check('teacher lists own codes', 'allow',
  () => getDocs(query(collection(teacherA, 'joinCodes'), where('teacherUid', '==', 'tA'))));

await check('teacher CANNOT list another teacher codes', 'deny',
  () => getDocs(query(collection(teacherA, 'joinCodes'), where('teacherUid', '==', 'tB'))));

await check('teacher creates a code for own class', 'allow',
  () => setDoc(doc(teacherA, 'joinCodes/NEW111'), { scheduleId: 'tc-a', teacherUid: 'tA', active: true }));

await check('teacher CANNOT create a code for another teacher class', 'deny',
  () => setDoc(doc(teacherA, 'joinCodes/EVL111'), { scheduleId: 'tc-b', teacherUid: 'tA', active: true }));

await check('teacher CANNOT repoint own code at another teacher class', 'deny',
  () => updateDoc(doc(teacherA, 'joinCodes/AAA111'), { scheduleId: 'tc-b', teacherUid: 'tB' }));

/* ================= ENROLLMENT ================= */
await check('student enrolls with a live code', 'allow',
  () => setDoc(doc(studentS, 'enrollments/tc-b_sS'), {
    scheduleId: 'tc-b', studentUid: 'sS', teacherUid: 'tB', joinCode: 'BBB222',
    status: 'active', studentName: 'Student S'
  }));

await check('student CANNOT enroll with a disabled code', 'deny',
  () => setDoc(doc(studentR, 'enrollments/tc-a_sR2'), {
    scheduleId: 'tc-a', studentUid: 'sR', teacherUid: 'tA', joinCode: 'DEAD11', status: 'active'
  }));

await check('student CANNOT enroll with no code at all', 'deny',
  () => setDoc(doc(outsider, 'enrollments/tc-a_out'), {
    scheduleId: 'tc-a', studentUid: 'out', teacherUid: 'tA', status: 'active'
  }));

await check('student CANNOT enroll a different student', 'deny',
  () => setDoc(doc(outsider, 'enrollments/tc-a_sS2'), {
    scheduleId: 'tc-a', studentUid: 'sS', teacherUid: 'tA', joinCode: 'AAA111', status: 'active'
  }));

await check('code for class X CANNOT enroll into class Y', 'deny',
  () => setDoc(doc(outsider, 'enrollments/tc-a_out'), {
    scheduleId: 'tc-a', studentUid: 'out', teacherUid: 'tA', joinCode: 'BBB222', status: 'active'
  }));

await check('CONSEQUENCE of repointed code: student lands in the other teacher class', 'deny',
  () => setDoc(doc(studentR, 'enrollments/tc-b_sR'), {
    scheduleId: 'tc-b', studentUid: 'sR', teacherUid: 'tB', joinCode: 'AAA111', status: 'active'
  }));

await check('CANNOT enroll while enrollment is closed (issue 4)', 'deny',
  () => setDoc(doc(outsider, 'enrollments/tc-closed_out'), {
    scheduleId: 'tc-closed', studentUid: 'out', teacherUid: 'tA', joinCode: 'CLS111', status: 'active'
  }));

await check('student reads own enrollment', 'allow',
  () => getDoc(doc(studentS, 'enrollments/tc-a_sS')));

await check('student CANNOT read a classmate enrollment', 'deny',
  () => getDoc(doc(studentS, 'enrollments/tc-a_sR')));

await check('teacher lists own roster', 'allow',
  () => getDocs(query(collection(teacherA, 'enrollments'), where('teacherUid', '==', 'tA'))));

await check('teacher CANNOT list every enrollment in the platform', 'deny',
  () => getDocs(collection(teacherA, 'enrollments')));

await check('teacher removes a student', 'allow',
  () => updateDoc(doc(teacherA, 'enrollments/tc-a_sS'), { status: 'removed' }));

await check('TEACHER-REMOVED student CANNOT re-activate themselves', 'deny',
  () => updateDoc(doc(studentR, 'enrollments/tc-a_sR'), { status: 'active' }));

await check('student CANNOT rewrite their enrollment scheduleId', 'deny',
  () => updateDoc(doc(studentR, 'enrollments/tc-a_sR'), { scheduleId: 'tc-b' }));

/* ===== V3.635 fixes: the legitimate paths must still work ===== */
await check('admin still provisions a teacher class', 'allow',
  () => setDoc(doc(admin, 'schedules/tc-admin-made'), {
    kind: 'teacher-class', title: 'Admin Provisioned', ownerUid: 'tA', teacherUid: 'tA',
    grantedFolders: ['optics'], modules: [], enrollmentOpen: true
  }));

await check('anyone still creates a NORMAL (lab) class doc', 'allow',
  () => setDoc(doc(teacherA, 'schedules/lab-class-x'), { title: 'Lab Class', ownerUid: 'tA' }));

await check('teacher still deactivates own code', 'allow',
  () => updateDoc(doc(teacherA, 'joinCodes/NEW111'), { active: false }));

await check('teacher CANNOT smuggle scheduleId alongside active', 'deny',
  () => updateDoc(doc(teacherA, 'joinCodes/AAA111'), { active: false, scheduleId: 'tc-b' }));

await check('student still leaves a class themselves', 'allow',
  () => updateDoc(doc(studentS, 'enrollments/tc-a_sS'), { status: 'removed' }));

await check('student who LEFT re-joins with a live code for that class', 'allow',
  () => updateDoc(doc(studentR, 'enrollments/tc-b_sR'), { status: 'active', joinCode: 'BBB222' }));

await check('re-join CANNOT use a code for a different class', 'deny',
  () => updateDoc(doc(studentR, 'enrollments/tc-b_sR'), { status: 'active', joinCode: 'AAA111' }));

await check('re-join CANNOT use a disabled code', 'deny',
  () => updateDoc(doc(studentR, 'enrollments/tc-b_sR'), { status: 'active', joinCode: 'DEAD11' }));

await check('teacher-removed student CANNOT re-join even holding a live code', 'deny',
  () => updateDoc(doc(studentR, 'enrollments/tc-a_sR'), { status: 'active', joinCode: 'AAA111' }));

await check('student CANNOT clear the removedBy stamp', 'deny',
  () => updateDoc(doc(studentR, 'enrollments/tc-a_sR'), { status: 'active', removedBy: '' }));

await check('teacher can re-activate a student they removed', 'allow',
  () => updateDoc(doc(teacherA, 'enrollments/tc-a_sR'), { status: 'active', removedBy: '' }));

await check('teacher still removes a student (unchanged clause)', 'allow',
  () => updateDoc(doc(teacherA, 'enrollments/tc-a_sR'), { status: 'removed' }));

/* ================= TEACHER PROFILES ================= */
await check('FIRST RUN: teacher reads own not-yet-created profile doc', 'allow',
  () => getDoc(doc(teacherB, 'teacherProfiles/tB')));

await check('teacher saves own profile as pending', 'allow',
  () => setDoc(doc(teacherB, 'teacherProfiles/tB'), { uid: 'tB', name: 'Teacher B', status: 'pending' }));

await check('teacher CANNOT self-approve their public profile', 'deny',
  () => setDoc(doc(teacherB, 'teacherProfiles/tB'), { uid: 'tB', name: 'Teacher B', status: 'approved' }));

await check('admin approves a profile', 'allow',
  () => updateDoc(doc(admin, 'teacherProfiles/tB'), { status: 'approved' }));

await check('anon lists approved teacher profiles (team page)', 'allow',
  () => getDocs(query(collection(anon, 'teacherProfiles'), where('status', '==', 'approved'))));

await check('anon CANNOT list all teacher profiles', 'deny',
  () => getDocs(collection(anon, 'teacherProfiles')));

/* ================= REVIEWS ================= */
await check('anon reads approved reviews strip (needs status+createdAt index)', 'allow',
  () => getDocs(query(collection(anon, 'reviews'), where('status', '==', 'approved'),
                      orderBy('createdAt', 'desc'), limit(12))));

await check('anon CANNOT list all reviews', 'deny',
  () => getDocs(collection(anon, 'reviews')));

await check('author reads own pending review', 'allow',
  () => getDocs(query(collection(studentR, 'reviews'), where('authorUid', '==', 'sR'))));

await check('enrolled student writes a review', 'allow',
  () => addDoc(collection(studentS, 'reviews'), {
    authorUid: 'sS', authorRole: 'student', scheduleId: 'tc-b', teacherUid: 'tB',
    rating: 4, text: 'good', status: 'pending', featured: false, createdAt: new Date()
  }));

await check('non-participant CANNOT write a review', 'deny',
  () => addDoc(collection(outsider, 'reviews'), {
    authorUid: 'out', authorRole: 'student', scheduleId: 'tc-a', teacherUid: 'tA',
    rating: 1, text: 'spam', status: 'pending', featured: false, createdAt: new Date()
  }));

await check('owning teacher writes a review for own class', 'allow',
  () => addDoc(collection(teacherA, 'reviews'), {
    authorUid: 'tA', authorRole: 'teacher', scheduleId: 'tc-a', teacherUid: 'tA',
    rating: 5, text: 'my students loved it', status: 'pending', featured: false, createdAt: new Date()
  }));

await check('author CANNOT self-approve a review', 'deny',
  () => updateDoc(doc(studentR, 'reviews/r-pending'), { status: 'approved' }));

await check('author CANNOT self-feature a review', 'deny',
  () => addDoc(collection(teacherA, 'reviews'), {
    authorUid: 'tA', authorRole: 'teacher', scheduleId: 'tc-a', teacherUid: 'tA',
    rating: 5, text: 'feature me', status: 'pending', featured: true, createdAt: new Date()
  }));

await check('review for a DELETED class (schedule gone, enrollment intact)', 'allow',
  () => addDoc(collection(studentS, 'reviews'), {
    authorUid: 'sS', authorRole: 'student', scheduleId: 'tc-vanished', teacherUid: 'tA',
    rating: 3, text: 'class was deleted', status: 'pending', featured: false, createdAt: new Date()
  }));

await check('teacher CAN still close enrollment on their own class', 'allow',
  () => updateDoc(doc(teacherA, 'schedules/tc-a'), { enrollmentOpen: false }));

await check('...and once closed, a live code no longer enrolls', 'deny',
  () => setDoc(doc(outsider, 'enrollments/tc-a_out'), {
    scheduleId: 'tc-a', studentUid: 'out', teacherUid: 'tA', joinCode: 'AAA111', status: 'active'
  }));

await check('KNOWN LIMIT: teacher cannot review a class after it is deleted', 'deny',
  () => addDoc(collection(teacherA, 'reviews'), {
    authorUid: 'tA', authorRole: 'teacher', scheduleId: 'tc-vanished', teacherUid: 'tA',
    rating: 4, text: 'ran it last spring', status: 'pending', featured: false, createdAt: new Date()
  }));

/* ================= CLASS REQUESTS ================= */
await check('teacher submits a pending request', 'allow',
  () => addDoc(collection(teacherB, 'classRequests'), {
    teacherUid: 'tB', school: 'B School', requestedFolders: ['optics'], status: 'pending'
  }));

await check('teacher CANNOT self-approve a request', 'deny',
  () => addDoc(collection(teacherB, 'classRequests'), {
    teacherUid: 'tB', school: 'B School', requestedFolders: ['optics'], status: 'approved'
  }));

await check('teacher lists own requests', 'allow',
  () => getDocs(query(collection(teacherA, 'classRequests'), where('teacherUid', '==', 'tA'))));

await check('teacher CANNOT read another teacher request', 'deny',
  () => getDoc(doc(teacherB, 'classRequests/req-a')));

await check('teacher withdraws own pending request', 'allow',
  () => deleteDoc(doc(teacherA, 'classRequests/req-a')));

/* ================= USERS / ROLE HARDENING ================= */
await check('guest CANNOT promote self to admin', 'deny',
  () => updateDoc(doc(teacherA, 'users/tA'), { role: 'admin' }));

await check('guest self-identifies as teacher (category is owner-writable)', 'allow',
  () => updateDoc(doc(outsider, 'users/out'), { category: 'teacher' }));

await check('admin lists all users (Guests panel)', 'allow',
  () => getDocs(collection(admin, 'users')));

await check('teacher CANNOT list all users', 'deny',
  () => getDocs(collection(teacherA, 'users')));

await check('lab member CAN list all users (editor pickers)', 'allow',
  () => getDocs(collection(member, 'users')));

await check('PUBLIC team query (role != guest) still works signed out', 'allow',
  () => getDocs(query(collection(anon, 'users'), where('role', '!=', 'guest'))));

await check('FIRST SIGN-IN: reading own not-yet-created user doc', 'allow',
  () => getDoc(doc(fresh, 'users/newbie')));

await check('FIRST SIGN-IN: bootstrap creates own guest profile', 'allow',
  () => setDoc(doc(fresh, 'users/newbie'), { role: 'guest', name: 'Newbie', email: 'newbie@gmail.com' }));

await check('student CAN still read own profile', 'allow',
  () => getDoc(doc(studentS, 'users/sS')));

/* ================= ADMIN PANEL QUERIES ================= */
await check('SIGNED-OUT visitor CANNOT dump the whole users directory', 'deny',
  () => getDocs(collection(anon, 'users')));

await check('SIGNED-OUT visitor CANNOT read an external student profile', 'deny',
  () => getDoc(doc(anon, 'users/sS')));

await check('external student CANNOT read another external student profile', 'deny',
  () => getDoc(doc(studentS, 'users/sR')));

await check('lab-member profile stays public (team page renders it)', 'allow',
  () => getDoc(doc(anon, 'users/mem')));

await check('admin lists teacher-class schedules', 'allow',
  () => getDocs(query(collection(admin, 'schedules'), where('kind', '==', 'teacher-class'))));
await check('admin lists all joinCodes', 'allow', () => getDocs(collection(admin, 'joinCodes')));
await check('admin lists all enrollments', 'allow', () => getDocs(collection(admin, 'enrollments')));
await check('admin lists all reviews', 'allow', () => getDocs(collection(admin, 'reviews')));
await check('admin lists all classRequests', 'allow', () => getDocs(collection(admin, 'classRequests')));
await check('admin lists all teacherProfiles', 'allow', () => getDocs(collection(admin, 'teacherProfiles')));

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
process.exit(0);
