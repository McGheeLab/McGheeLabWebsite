/* ================================================================
   tasks.js — Push notifications for cross-user task assignment (Phase 8)
   ================================================================
   Trigger: userData/{userId}/tasks/{taskId} onCreate

   When a lab member uses RM's "Send to teammate" flow, the task is
   written to the assignee's tasks subcollection with createdByUid
   set to the assigner. This function fires on that write, detects
   that the doc is a true assignment (createdByUid != userId AND
   bucket == 'assigned'), and pushes a notification to the assignee.
   ================================================================ */

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { sendToUsers } = require('./helpers/notify');

const APP_KEY = 'tasks';
const TEXT_PREVIEW_LEN = 140;

const onTaskAssigned = onDocumentCreated('userData/{userId}/tasks/{taskId}', async (event) => {
  const snap = event.data;
  if (!snap) return;

  const task = snap.data();
  const userId = event.params.userId;

  // Only fire for true cross-user assignments — skip self-created tasks
  // (which are the user's own personal tasks landing in their own queue).
  if (!task) return;
  if (task.createdByUid === userId) return;
  if (task.bucket !== 'assigned') return;
  if (task.done) return; // someone created it already done — skip
  // V3.314 — market-materialized copies are written by the claimant
  // themselves (or announced by task-market.js's own onCreate push in
  // the admin direct-assign flow); a second per-task push is noise.
  if (task.marketPostId) return;

  const db = getFirestore();
  const messaging = getMessaging();

  const assignerName = task.createdByName || 'Teammate';
  const text = task.text || '(untitled task)';
  const preview = text.length > TEXT_PREVIEW_LEN
    ? text.substring(0, TEXT_PREVIEW_LEN) + '...'
    : text;

  const due = task.due_date && task.due_date !== 'TBD'
    ? ' · due ' + task.due_date
    : '';

  const notif = {
    title: 'Task from ' + assignerName,
    body: preview + due,
    url: '/rm/pages/tasks.html',
    tag: 'rm-task-' + (task.id || event.params.taskId),
  };

  await sendToUsers(db, messaging, [userId], notif, APP_KEY);
});

module.exports = { onTaskAssigned };
