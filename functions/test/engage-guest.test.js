/* ================================================================
   engage-guest.test.js — the no-account visit post (V3.808)
   ================================================================
   Runs functions/engage-guest.js's handle() against the FIRESTORE
   EMULATOR with the real Admin SDK, so queries, count(), transactions
   and serverTimestamp behave exactly as in production — and nothing
   touches the live project or pushes to anyone's phone. From the repo
   root:

       firebase emulators:exec --only firestore --project demo-engage-guest \
         "node functions/test/engage-guest.test.js"

   Covers: submit validation + honeypot + rate limit; token lookup;
   edit while pending; the admin publish (written here the way
   rm/js/admin-teachers.js writes it); a presenter sign-up; accept on a
   ticked date (location copied, opportunity booked, the other sign-up
   auto-declined); a date the presenter didn't tick; emailed; cancel
   (un-books, reopens); a panel (presentersWanted 2) and "enough";
   withdraw; and a stranger's request id.
   ================================================================ */

'use strict';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is not set — run this under `firebase emulators:exec --only firestore`.');
  process.exit(1);
}
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-engage-guest';

const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = getFirestore();
const G = require('../engage-guest');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail !== undefined ? '\n      ' + JSON.stringify(detail).slice(0, 400) : ''));
}
async function expectErr(name, status, fn) {
  try { await fn(); check(name, false, 'no error thrown'); }
  catch (e) { check(name, e instanceof G.HttpError && e.status === status, { status: e.status, msg: e.message }); }
}

const NOW = new Date('2026-10-19T17:00:00Z'); // 10:00 in Arizona
const notified = [];
const ctx = (ip) => ({ ip: ip || '203.0.113.7', now: NOW, notifyAdmins: async (n) => { notified.push(n); return 1; } });

const base = {
  name: 'Ms. Rivera', email: 'P.Rivera@School.Example', phone: '520-555-0100',
  school: 'Desert View High School', schoolType: 'high-school', city: 'Tucson', state: 'AZ',
  subject: 'AP Biology', grade: '11–12', classSize: 28,
  title: 'Guest talk on careers in biomedical engineering',
  activityTypes: ['guest-talk', 'career-chat'], formats: ['at-school'],
  topic: 'What a BME researcher does all day', presentersWanted: 1,
  dates: [
    { date: '2026-11-04', startTime: '10:00', endTime: '10:50' },
    { date: '2026-10-28', startTime: '10:00', endTime: '10:50' }
  ],
  address: '1200 E Example Rd, Tucson, AZ', room: 'B-114', arrivalNotes: 'Sign in at the front office.',
  noteToLab: 'Any time that week works.'
};

// What rm/js/admin-teachers.js does on Publish.
async function adminPublish(guestId) {
  const s = await db.collection('engageGuestPosts').doc(guestId).get();
  const g = s.data();
  const tUid = 'guest_' + guestId;
  const b = db.batch();
  b.set(db.collection('engageProfiles').doc(tUid), {
    teacherUid: tUid, guest: true, guestId, status: 'approved',
    displayName: g.teacher.name, school: g.listing.school, schoolType: g.listing.schoolType, city: g.listing.city,
    gradeLevels: [g.listing.grade], subjects: [g.listing.subject], classSize: g.listing.classSize,
    topics: [], activityTypes: g.opportunity.activityTypes, formats: g.opportunity.formats
  });
  b.set(db.collection('engageProfiles').doc(tUid).collection('private').doc('contact'),
    { address: g.location.address, room: g.location.room, phone: g.teacher.phone, arrivalNotes: g.location.arrivalNotes });
  const oppRef = db.collection('engageOpportunities').doc();
  b.set(oppRef, {
    teacherUid: tUid, title: g.opportunity.title, activityTypes: g.opportunity.activityTypes, formats: g.opportunity.formats,
    topic: g.opportunity.topic, classContext: { subject: g.listing.subject, grade: g.listing.grade, size: g.listing.classSize },
    presentersWanted: g.opportunity.presentersWanted, dates: g.opportunity.dates, dateKeys: g.opportunity.dates.map(d => d.date),
    timezone: 'America/Phoenix', status: 'open', guest: true
  });
  b.update(s.ref, { status: 'published', opportunityId: oppRef.id, publishedAt: FieldValue.serverTimestamp() });
  await b.commit();
  return oppRef.id;
}
// A presenter's sign-up, as engage-presenters.js writes it.
async function signUp(oppId, teacherUid, who, dates) {
  const ref = await db.collection('engageRequests').add({
    opportunityId: oppId, opportunityTitle: base.title, teacherUid,
    requesterUid: 'uid_' + who, requesterName: 'Dr. ' + who, requesterAffiliation: 'University of Arizona',
    requesterEmail: who.toLowerCase() + '@arizona.example', requesterBio: 'Studies cells.',
    dates, okWithOthers: false, activityType: 'guest-talk', format: 'at-school', topic: '', message: 'Happy to help!',
    status: 'pending', createdAt: FieldValue.serverTimestamp()
  });
  return ref.id;
}

(async () => {
  /* ---- submit: validation ---- */
  await expectErr('V1 missing name', 400, () => G.handle(db, { action: 'submit', ...base, name: '' }, ctx()));
  await expectErr('V2 bad email', 400, () => G.handle(db, { action: 'submit', ...base, email: 'nope' }, ctx()));
  await expectErr('V3 no dates', 400, () => G.handle(db, { action: 'submit', ...base, dates: [] }, ctx()));
  await expectErr('V4 past date', 400, () => G.handle(db, { action: 'submit', ...base, dates: [{ date: '2026-10-18', startTime: '10:00', endTime: '10:50' }] }, ctx()));
  await expectErr('V5 end before start', 400, () => G.handle(db, { action: 'submit', ...base, dates: [{ date: '2026-11-04', startTime: '11:00', endTime: '10:00' }] }, ctx()));
  await expectErr('V6 duplicate date', 400, () => G.handle(db, { action: 'submit', ...base, dates: [base.dates[0], base.dates[0]] }, ctx()));
  await expectErr('V7 unknown activity', 400, () => G.handle(db, { action: 'submit', ...base, activityTypes: ['juggling'] }, ctx()));
  await expectErr('V8 at-school with no address', 400, () => G.handle(db, { action: 'submit', ...base, address: '' }, ctx()));
  await expectErr('V9 class size 0', 400, () => G.handle(db, { action: 'submit', ...base, classSize: 0 }, ctx()));
  await expectErr('V10 too many presenters', 400, () => G.handle(db, { action: 'submit', ...base, presentersWanted: 9 }, ctx()));
  await expectErr('V11 honeypot filled', 400, () => G.handle(db, { action: 'submit', ...base, company_url: 'http://spam' }, ctx()));
  const afterInvalid = await db.collection('engageGuestPosts').get();
  check('V12 nothing written by invalid submits', afterInvalid.size === 0, afterInvalid.size);
  check('V13 nobody notified by invalid submits', notified.length === 0, notified.length);

  /* ---- submit: success ---- */
  const sub = await G.handle(db, { action: 'submit', ...base }, ctx());
  check('S1 returns a token + manage url', /^[A-Za-z0-9_-]{32}$/.test(sub.token) && sub.manageUrl === G.MANAGE_BASE + sub.token, sub);
  const doc = (await db.collection('engageGuestPosts').doc(sub.guestId).get()).data();
  check('S2 stored pending with teacherUid guest_<id>', doc.status === 'pending' && doc.teacherUid === 'guest_' + sub.guestId, doc.status);
  check('S3 email lower-cased', doc.teacher.email === 'p.rivera@school.example', doc.teacher.email);
  check('S4 dates sorted', doc.opportunity.dates.map(d => d.date).join() === '2026-10-28,2026-11-04', doc.opportunity.dates);
  check('S5 token stored, timestamps are real', doc.manageToken === sub.token && doc.createdAt && typeof doc.createdAt.toDate === 'function');
  check('S6 admins notified once', notified.length === 1 && /Desert View/.test(notified[0].body) && notified[0].url.includes('admin-teachers'), notified);

  /* ---- get by token ---- */
  const v1 = await G.handle(db, { action: 'get', token: sub.token }, ctx());
  check('G1 view: pending, no opportunity, no requests', v1.post.status === 'pending' && v1.opportunity === null && v1.requests.length === 0, v1.post.status);
  check('G2 view never echoes the token field', !('manageToken' in v1.post), Object.keys(v1.post));
  await expectErr('G3 unknown token → 404', 404, () => G.handle(db, { action: 'get', token: 'A'.repeat(32) }, ctx()));
  await expectErr('G4 malformed token → 404', 404, () => G.handle(db, { action: 'get', token: 'short' }, ctx()));
  await expectErr('G5 accept before publish → 409', 409, () => G.handle(db, { action: 'decide', token: sub.token, requestId: 'x', decision: 'confirmed' }, ctx()));

  /* ---- edit while pending ---- */
  const ed = await G.handle(db, { action: 'update', token: sub.token, ...base, room: 'B-120', classSize: 30 }, ctx());
  check('E1 edit saved', ed.post.location.room === 'B-120' && ed.post.listing.classSize === 30, ed.post.location);

  /* ---- publish (admin) + sign-ups ---- */
  const oppId = await adminPublish(sub.guestId);
  await expectErr('E2 edit after publish → 409', 409, () => G.handle(db, { action: 'update', token: sub.token, ...base }, ctx()));
  const tUid = 'guest_' + sub.guestId;
  const rA = await signUp(oppId, tUid, 'Chen', ['2026-10-28', '2026-11-04']);
  const rB = await signUp(oppId, tUid, 'Okafor', ['2026-11-04']);
  const v2 = await G.handle(db, { action: 'get', token: sub.token }, ctx());
  check('P1 view shows the live opportunity + 2 sign-ups', v2.opportunity && v2.opportunity.id === oppId && v2.requests.length === 2, v2.requests.length);
  check('P2 pending sign-ups carry no presenter email', v2.requests.every(r => !('requesterEmail' in r)), v2.requests);

  await expectErr('D1 a date the presenter did not tick → 400', 400, () =>
    G.handle(db, { action: 'decide', token: sub.token, requestId: rB, decision: 'confirmed', date: '2026-10-28', expectedStudents: 28 }, ctx()));
  await expectErr('D2 no student count → 400', 400, () =>
    G.handle(db, { action: 'decide', token: sub.token, requestId: rA, decision: 'confirmed', date: '2026-10-28' }, ctx()));
  const acc = await G.handle(db, { action: 'decide', token: sub.token, requestId: rA, decision: 'confirmed', date: '2026-10-28', expectedStudents: 28, note: 'Park in the visitor lot.' }, ctx());
  const A = (await db.collection('engageRequests').doc(rA).get()).data();
  const B = (await db.collection('engageRequests').doc(rB).get()).data();
  const O = (await db.collection('engageOpportunities').doc(oppId).get()).data();
  check('D3 accepted with date, times, students, note', A.status === 'confirmed' && A.date === '2026-10-28' && A.startTime === '10:00' && A.endTime === '10:50' && A.expectedStudents === 28 && A.teacherNote === 'Park in the visitor lot.', A);
  check('D4 location copied from the private post (room edit included)', A.location && A.location.address === base.address && A.location.room === 'B-120' && A.location.phone === base.phone, A.location);
  check('D5 opportunity booked on that date', O.status === 'booked' && O.bookedDate === '2026-10-28' && (O.acceptedRequestIds || []).join() === rA, O);
  check('D6 the other sign-up auto-declined with the note', B.status === 'declined' && B.teacherNote === G.DECLINE_NOTES.filled && acc.declined === 1, B);
  check('D7 accepted sign-up now shows the presenter email', acc.requests.find(r => r.id === rA).requesterEmail === 'chen@arizona.example');
  await expectErr('D8 answering it twice → 409', 409, () =>
    G.handle(db, { action: 'decide', token: sub.token, requestId: rA, decision: 'declined' }, ctx()));

  const em = await G.handle(db, { action: 'emailed', token: sub.token, requestId: rA }, ctx());
  check('M1 emailedAt stamped', !!em.requests.find(r => r.id === rA).emailedAt);

  const can = await G.handle(db, { action: 'cancel', token: sub.token, requestId: rA }, ctx());
  const O2 = (await db.collection('engageOpportunities').doc(oppId).get()).data();
  check('C1 cancel: request cancelled', can.requests.find(r => r.id === rA).status === 'cancelled');
  check('C2 cancel: opportunity reopened, date freed', O2.status === 'open' && O2.bookedDate === null && (O2.acceptedRequestIds || []).length === 0, O2);

  /* ---- a stranger's request id ---- */
  const other = await db.collection('engageRequests').add({ opportunityId: 'someone-else', status: 'pending', dates: ['2026-10-28'] });
  await expectErr('X1 a sign-up on someone else’s opportunity → 404', 404, () =>
    G.handle(db, { action: 'decide', token: sub.token, requestId: other.id, decision: 'declined' }, ctx()));
  const otherAfter = (await other.get()).data();
  check('X2 …and it was not touched', otherAfter.status === 'pending');

  /* ---- a panel: presentersWanted 2, then "enough" ---- */
  const sub2 = await G.handle(db, { action: 'submit', ...base, email: 'panel@school.example', presentersWanted: 2, formats: ['virtual'], address: '' }, ctx('198.51.100.9'));
  const opp2 = await adminPublish(sub2.guestId);
  const t2 = 'guest_' + sub2.guestId;
  const p1 = await signUp(opp2, t2, 'Ito', ['2026-11-04']);
  const p2 = await signUp(opp2, t2, 'Diaz', ['2026-10-28', '2026-11-04']);
  const p3 = await signUp(opp2, t2, 'Lane', ['2026-11-04']);
  await G.handle(db, { action: 'decide', token: sub2.token, requestId: p1, decision: 'confirmed', date: '2026-11-04', expectedStudents: 25 }, ctx());
  const Op = (await db.collection('engageOpportunities').doc(opp2).get()).data();
  check('N1 panel stays open after the first of two', Op.status === 'open' && Op.bookedDate === '2026-11-04', Op);
  const P1 = (await db.collection('engageRequests').doc(p1).get()).data();
  check('N2 virtual visit: no location copied', !P1.location, P1.location);
  await expectErr('N3 panel: the second must use the set date', 400, () =>
    G.handle(db, { action: 'decide', token: sub2.token, requestId: p2, decision: 'confirmed', date: '2026-10-28', expectedStudents: 25 }, ctx()));
  const en = await G.handle(db, { action: 'enough', token: sub2.token }, ctx());
  const Op2 = (await db.collection('engageOpportunities').doc(opp2).get()).data();
  check('N4 "enough" closes it and declines the waiting two', Op2.status === 'booked' && en.declined === 2 &&
    en.requests.filter(r => r.status === 'declined').every(r => r.teacherNote === G.DECLINE_NOTES.enough), en.requests.map(r => [r.status, r.teacherNote]));

  /* ---- withdraw ---- */
  const sub3 = await G.handle(db, { action: 'submit', ...base, email: 'w@school.example' }, ctx('192.0.2.1'));
  const opp3 = await adminPublish(sub3.guestId);
  await signUp(opp3, 'guest_' + sub3.guestId, 'Park', ['2026-10-28']);
  const wd = await G.handle(db, { action: 'withdraw', token: sub3.token }, ctx());
  const O3 = (await db.collection('engageOpportunities').doc(opp3).get()).data();
  check('W1 withdraw: post withdrawn, opportunity closed, sign-up declined', wd.post.status === 'withdrawn' && O3.status === 'closed' && wd.declined === 1 &&
    wd.requests[0].teacherNote === G.DECLINE_NOTES.withdrawn, { post: wd.post.status, opp: O3.status, declined: wd.declined });
  const sub4 = await G.handle(db, { action: 'submit', ...base, email: 'w2@school.example' }, ctx('192.0.2.2'));
  const wd2 = await G.handle(db, { action: 'withdraw', token: sub4.token }, ctx());
  check('W2 withdraw before publish just marks it', wd2.post.status === 'withdrawn' && wd2.opportunity === null);

  /* ---- rate limit (5 per IP per hour) ---- */
  for (let i = 0; i < 4; i++) await G.handle(db, { action: 'submit', ...base, email: `r${i}@school.example` }, ctx('203.0.113.50'));
  await G.handle(db, { action: 'submit', ...base, email: 'r4@school.example' }, ctx('203.0.113.50'));
  await expectErr('R1 the sixth post from one IP in an hour → 429', 429, () =>
    G.handle(db, { action: 'submit', ...base, email: 'r5@school.example' }, ctx('203.0.113.50')));
  const later = { ...ctx('203.0.113.50'), now: new Date(NOW.getTime() + 3700 * 1000) };
  const ok = await G.handle(db, { action: 'submit', ...base, email: 'r6@school.example' }, later).then(() => true, () => false);
  check('R2 …and allowed again an hour later', ok);

  await expectErr('U1 unknown action → 400', 400, () => G.handle(db, { action: 'nope', token: sub.token }, ctx()));

  console.log(`engage-guest: ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
