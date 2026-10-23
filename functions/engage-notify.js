/* ================================================================
   engage-notify.js — Engagement-hub request pushes (V3.673)
   ================================================================
   Teacher program R4. Cross-user notifications for the #/engage
   request → teacher-confirms flow:

     engageRequests/{id}  onWritten —
       • created → notify the teacher + every admin (admin oversees
         all scheduling per the program design)
       • status changed by the teacher/admin → notify the requester
         (confirmed / declined); admins additionally hear about
         confirmations so the calendar of real visits stays visible.
       • V3.791 — ALWAYS recount the request's opportunity: pendingCount /
         acceptedCount on engageOpportunities/{id} are how a presenter
         sees "pending acceptance" without being able to read anyone
         else's request. Rules let no client write those two fields.

     engageReviews/{id}   onWritten (V3.787) —
       • created → the visit's teacher + every admin hear that the
         presenter reviewed it. Edits are silent.

   Presenters (V3.785) live on the link-only #/presenters page, so their
   notifications point there. Most presenters are outside the lab and may
   have no push token; the teacher's confirmation EMAIL (a mailto the
   teacher sends from step 7) is what actually reaches them.

   The requester can never write into the teacher's feed (both may be
   role:'guest'), so this must run server-side.
   ================================================================ */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { notifyUsers } = require('./helpers/notify');

const APP_KEY = 'engage';

// V3.808 — a teacher who posted without an account (engage-guest.js) is
// 'guest_{postId}' on every public doc. That is not a user: no push tokens,
// and notifyUsers would otherwise create a userData/guest_…/notifications
// feed for nobody. Admins hear instead, and email the teacher themselves.
const isGuestTeacher = (uid) => typeof uid === 'string' && uid.startsWith('guest_');
const realUsers = (uids) => [...new Set(uids)].filter(u => u && !isGuestTeacher(u));

async function adminUids(db) {
  const snap = await db.collection('users').where('role', '==', 'admin').get();
  return snap.docs.map((d) => d.id);
}

// V3.791 — keep an opportunity's two counts in step with its requests. An
// update (not a merge-set) so a deleted opportunity is not resurrected.
async function recountOpportunity(db, oppId) {
  if (!oppId) return;
  const snap = await db.collection('engageRequests').where('opportunityId', '==', oppId).get();
  let pendingCount = 0, acceptedCount = 0;
  snap.forEach((d) => {
    const st = d.data().status;
    if (st === 'pending') pendingCount++;
    else if (st === 'confirmed') acceptedCount++;
  });
  await db.collection('engageOpportunities').doc(oppId)
    .update({ pendingCount, acceptedCount })
    .catch((e) => console.warn(`[engage] recount ${oppId} skipped: ${e && e.message}`));
}

const onEngageRequestWrite = onDocumentWritten('engageRequests/{reqId}', async (event) => {
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after = event.data.after.exists ? event.data.after.data() : null;
  const db = getFirestore();

  await recountOpportunity(db, (after || before || {}).opportunityId);
  if (!after) return; // deletions (admin cleanup) are otherwise silent

  const messaging = getMessaging();
  const who = after.requesterName || 'Someone';
  const what = after.opportunityTitle || after.activityType || 'a visit';
  const when = [after.date, after.startTime].filter(Boolean).join(' ');

  // 1. New sign-up → teacher + admins.
  if (!before) {
    const admins = await adminUids(db);
    const n = Array.isArray(after.dates) ? after.dates.length : 0;
    const dates = n ? ` — could do ${n} of your date${n === 1 ? '' : 's'}` : '';
    if (isGuestTeacher(after.teacherUid)) {
      // V3.808 — the teacher has no account to notify; the lab tells them.
      await notifyUsers(db, messaging, realUsers(admins), {
        title: 'A presenter signed up (no-account post)',
        body: `${who} signed up for "${what}"${dates}. The teacher posted without an account, so email them from the admin Engagement tab.`,
        url: '/rm/pages/admin-teachers.html?tab=engage',
        tag: `engage-req-${event.params.reqId}`
      }, APP_KEY, 'engage-request');
      return;
    }
    await notifyUsers(db, messaging, realUsers([after.teacherUid, ...admins]), {
      title: 'A presenter signed up',
      body: `${who} signed up for "${what}"${dates}`,
      url: '/#/engage',
      tag: `engage-req-${event.params.reqId}`
    }, APP_KEY, 'engage-request');
    return;
  }

  // 2. Status change → requester. A pending request going to 'cancelled' is
  // the presenter withdrawing it themselves (the only cancel the presenter
  // page offers), so it stays silent. V3.787: an ACCEPTED visit going to
  // 'cancelled' is the teacher (or admin) calling it off — the presenter has
  // to hear about that one.
  if (before.status !== after.status && after.requesterUid) {
    const callOff = after.status === 'cancelled' && before.status === 'confirmed';
    if (after.status === 'cancelled' && !callOff) return;
    const targets = [after.requesterUid];
    if (after.status === 'confirmed' || callOff) targets.push(...await adminUids(db));
    await notifyUsers(db, messaging, realUsers(targets), {
      title: after.status === 'confirmed' ? 'Visit confirmed'
        : callOff ? 'Visit cancelled' : 'Visit request ' + after.status,
      body: after.status === 'confirmed'
        ? `"${what}" is confirmed for ${when} — the teacher will email you the details`
        : callOff
          ? `The visit "${what}" on ${when} has been cancelled`
          : `The teacher ${after.status} your sign-up for "${what}"` +
          (after.teacherNote ? ` — "${after.teacherNote}"` : ''),
      url: '/#/presenters',
      tag: `engage-req-${event.params.reqId}`
    }, APP_KEY, 'engage-decision');
  }
});

// V3.787 — a presenter reviewed a visit. Only the create notifies: an edit
// to a review already seen would just be noise.
const onEngageReviewWrite = onDocumentWritten('engageReviews/{reqId}', async (event) => {
  const before = event.data.before.exists;
  const after = event.data.after.exists ? event.data.after.data() : null;
  if (before || !after) return;

  const db = getFirestore();
  const messaging = getMessaging();
  const admins = await adminUids(db);
  const targets = realUsers([after.teacherUid, ...admins]);
  const who = after.requesterName || 'The presenter';
  await notifyUsers(db, messaging, targets, {
    title: 'Visit reviewed',
    body: `${who} reviewed the visit on ${after.visitDate || 'your class'}` +
      (after.rating ? ` — ${after.rating}/5` : ''),
    url: '/#/engage',
    tag: `engage-review-${event.params.reqId}`
  }, APP_KEY, 'engage-review');
});

module.exports = { onEngageRequestWrite, onEngageReviewWrite, isGuestTeacher, realUsers };
