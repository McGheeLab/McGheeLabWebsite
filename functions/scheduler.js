/* ================================================================
   scheduler.js — Push notifications for the scheduler (V3.342)
   ================================================================
   Triggers:
     participants/{participantId}  onUpdate —
       • guest submitted / changed availability → notify the owner
         of the parent schedule
       • a slot was assigned → notify the lab member (speakerUid)
         it was assigned to

   Guests are unauthenticated (invite-key writes), so these pushes
   can only originate server-side. External guests without an RM
   account are reached via the admin's mailto compose button in the
   scheduler editor instead.

   Respects the per-user 'scheduler' notification toggle via
   helpers/notify.js (sendToUsers checks userSettings).
   ================================================================ */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { sendToUsers } = require('./helpers/notify');

const APP_KEY = 'scheduler';
const SCHEDULER_URL = '/rm/pages/scheduler.html';

const onParticipantUpdated = onDocumentUpdated('participants/{participantId}', async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!before || !after || !after.scheduleId) return;

  const db = getFirestore();
  const messaging = getMessaging();
  const participantId = event.params.participantId;
  const guestName = after.speakerName || after.speakerEmail || 'A guest';

  // Lazily loaded — both branches need the parent schedule.
  let schedule = null;
  async function loadSchedule() {
    if (schedule) return schedule;
    const doc = await db.collection('schedules').doc(after.scheduleId).get();
    schedule = doc.exists ? doc.data() : {};
    return schedule;
  }

  // 1. Availability submitted or changed → notify the schedule owner
  const availBefore = (before.availability || []).slice().sort().join(',');
  const availAfter = (after.availability || []).slice().sort().join(',');
  if (availBefore !== availAfter) {
    const sched = await loadSchedule();
    const ownerUid = sched.ownerUid;
    // Don't self-notify when the owner edits a guest's availability.
    if (ownerUid && ownerUid !== after.speakerUid) {
      const title = (before.availability || []).length ? 'Availability updated' : 'Availability received';
      await sendToUsers(db, messaging, [ownerUid], {
        title,
        body: `${guestName} responded to "${sched.title || 'your scheduler'}"`,
        url: SCHEDULER_URL,
        tag: `sched-avail-${participantId}`,
      }, APP_KEY);
    }
  }

  // 2. Slot assigned → notify the lab member it was assigned to
  if (before.assignedSlot !== after.assignedSlot && after.assignedSlot && after.speakerUid) {
    const sched = await loadSchedule();
    await sendToUsers(db, messaging, [after.speakerUid], {
      title: "You've been scheduled",
      body: `You were assigned a slot in "${sched.title || 'a scheduler'}"`,
      url: SCHEDULER_URL,
      tag: `sched-assign-${participantId}`,
    }, APP_KEY);
  }
});

module.exports = { onParticipantUpdated };
