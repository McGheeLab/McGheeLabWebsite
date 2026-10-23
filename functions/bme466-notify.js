/* ================================================================
   bme466-notify.js — BME466 course-platform pushes (V3.681)
   ================================================================
   Two triggers, both doing work the client provably cannot:

     schedules/bme466/threads/{t}/messages/{m}  onCreated —
       • denormalize onto the parent thread (lastMessageAt,
         lastMessagePreview, messageCount) and raise the unread flag
         for the OTHER side. firestore.rules grants no client the
         right to write those fields, precisely so the inbox's
         "unread" and "last reply" cannot be faked by either party.
       • notify the other side: a student's message goes to the
         instructor + every TA, a staff reply goes to the thread author.

     schedules/bme466/assignments/{slug}  onWritten —
       • the transition INTO published:true fans out to the students
         the assignment is FOR (audience 'all' | '466' | '566',
         resolved from each student's section — staff-assigned value
         first, then their own claim). Later edits stay quiet.

   Cross-user feed writes are impossible from the browser here: both
   students and TAs are role:'guest', so neither can write into
   another user's userData/{uid}/notifications. Hence a function.

   Section is resolved the same way class-builder.js's bme466Section()
   does — sectionAssigned WINS over sectionClaim — and an UNKNOWN
   section FAILS OPEN (the student is notified). A missed notification
   about an assignment that is actually theirs is a real harm; one
   extra notification is not.
   ================================================================ */

const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { getAuth } = require('firebase-admin/auth');
const { notifyUsers } = require('./helpers/notify');

const APP_KEY = 'classes';
const CLASS_URL = '/#/classes/bme466';
const SCHEDULE = 'schedules/bme466';

/* ── section resolution (mirror of bme466Section() in class-builder.js) ── */
function levelOf(profile) {
  const code = (profile && (profile.sectionAssigned || profile.sectionClaim)) || '';
  const m = /(466|566)/.exec(String(code));
  return m ? m[1] : null;            // null = unknown → fails open
}
function inAudience(profile, audience) {
  if (!audience || audience === 'all') return true;
  const lvl = levelOf(profile);
  if (!lvl) return true;             // unknown section → notify anyway
  return lvl === audience;
}

/* ── who is staff ── */
async function staffEmails(db) {
  const snap = await db.doc(SCHEDULE).get();
  const d = snap.exists ? snap.data() : {};
  return [...new Set([
    ...(d.classAdminEmails || []),
    ...(d.courseStaffEmails || [])
  ].map((e) => String(e || '').toLowerCase()).filter(Boolean))];
}

/* Email → uid ladder: the users collection, then Auth, then give up
   loudly. A dropped notification is invisible to everyone involved, so
   the failure is logged rather than swallowed. */
async function uidForEmail(db, email) {
  const e = String(email || '').toLowerCase();
  if (!e) return null;
  try {
    const q = await db.collection('users').where('email', '==', e).limit(1).get();
    if (!q.empty) return q.docs[0].id;
  } catch (err) {
    console.warn(`[bme466] users lookup failed for ${e}: ${err.message}`);
  }
  try {
    const rec = await getAuth().getUserByEmail(e);
    if (rec && rec.uid) return rec.uid;
  } catch (err) {
    /* getUserByEmail throws auth/user-not-found for anyone who has never
       signed in — expected for a TA added by email before their first
       visit, so this is a note, not an error. */
    console.log(`[bme466] no account yet for ${e} (${err.code || err.message})`);
  }
  return null;
}

async function staffUids(db) {
  const emails = await staffEmails(db);
  const uids = await Promise.all(emails.map((e) => uidForEmail(db, e)));
  // Global admins are always included: they are the safety net that keeps a
  // request from disappearing when a TA has not signed in yet.
  let admins = [];
  try {
    const snap = await db.collection('users').where('role', '==', 'admin').get();
    admins = snap.docs.map((d) => d.id);
  } catch (err) {
    console.warn(`[bme466] admin lookup failed: ${err.message}`);
  }
  return [...new Set([...uids, ...admins])].filter(Boolean);
}

/* ══ 1. a message lands in a request thread ══════════════════════════════ */
const onBme466MessageCreated = onDocumentCreated(
  'schedules/bme466/threads/{threadId}/messages/{msgId}',
  async (event) => {
    const msg = event.data && event.data.data();
    if (!msg) return;
    const { threadId } = event.params;
    const db = getFirestore();
    const messaging = getMessaging();
    const threadRef = db.doc(`${SCHEDULE}/threads/${threadId}`);

    const tSnap = await threadRef.get();
    if (!tSnap.exists) return;                  // thread deleted mid-flight
    const thread = tSnap.data();
    const fromStaff = msg.authorRole === 'staff';
    const preview = String(msg.body || '').slice(0, 140);

    // Denormalize + flip the unread flag for the side that did NOT write.
    await threadRef.set({
      lastMessageAt: FieldValue.serverTimestamp(),
      lastMessagePreview: preview,
      messageCount: FieldValue.increment(1),
      unreadForStaff: !fromStaff,
      unreadForAuthor: fromStaff,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    const subject = thread.subject || 'a course request';
    if (fromStaff) {
      if (!thread.authorUid) return;
      await notifyUsers(db, messaging, [thread.authorUid], {
        title: 'Reply from the teaching team',
        body: `"${subject}" — ${preview}`,
        url: CLASS_URL,
        tag: `bme466-thread-${threadId}`
      }, APP_KEY, 'bme466-thread');
      return;
    }

    const targets = (await staffUids(db)).filter((u) => u !== msg.authorUid);
    if (!targets.length) {
      console.warn('[bme466] student message with no resolvable staff account');
      return;
    }
    const who = thread.authorName || msg.authorName || 'A student';
    await notifyUsers(db, messaging, targets, {
      title: `BME466 request — ${thread.topic || 'other'}`,
      body: `${who}: "${subject}" — ${preview}`,
      url: CLASS_URL,
      tag: `bme466-thread-${threadId}`
    }, APP_KEY, 'bme466-thread');
  }
);

/* ══ 2. an assignment is published ═══════════════════════════════════════ */
const onBme466AssignmentWrite = onDocumentWritten(
  'schedules/bme466/assignments/{slug}',
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;                                   // deletions are silent
    if (after.published !== true) return;
    if (before && before.published === true) return;      // only the transition

    const { slug } = event.params;
    // Idempotency: a retry, or a republish after unpublishing, must not
    // re-notify 50 people. notifiedFor is written by this function only.
    if (after.notifiedFor === slug) return;

    const db = getFirestore();
    const messaging = getMessaging();

    const profiles = await db.collection(`${SCHEDULE}/profiles`).get();
    const audience = after.audience || 'all';
    const targets = profiles.docs
      .filter((d) => inAudience(d.data(), audience))
      .map((d) => d.id);

    if (targets.length) {
      const due = after.dueAt ? ` — due ${String(after.dueAt).slice(0, 10)}` : '';
      const only = audience === 'all' ? '' : ` (${audience} only)`;
      await notifyUsers(db, messaging, targets, {
        title: 'New BME466 assignment',
        body: `"${after.title || slug}"${due}${only}`,
        url: CLASS_URL,
        tag: `bme466-assign-${slug}`
      }, APP_KEY, 'bme466-assignment');
    } else {
      // Not an error: nobody has opened their student dashboard yet, so no
      // profile docs exist to notify. Say so rather than looking successful.
      console.log(`[bme466] published ${slug} with no student profiles to notify`);
    }

    await event.data.after.ref.set({
      notifiedFor: slug,
      notifiedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
);

module.exports = {
  onBme466MessageCreated, onBme466AssignmentWrite,
  // exported for the audience-resolution unit test (scripts/tests/
  // bme466-audience.test.mjs) — the fail-open rule is worth pinning.
  _levelOf: levelOf, _inAudience: inAudience
};
