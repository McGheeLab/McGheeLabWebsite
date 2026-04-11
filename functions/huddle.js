/* ================================================================
   huddle.js — Push notifications for Huddle plans & help requests
   ================================================================
   Triggers:
     huddlePlans/{planId}           onUpdate  — joiner/watcher/status changes
     huddleHelpRequests/{requestId} onCreate  — new help request
     huddleHelpRequests/{requestId} onUpdate  — new response to a help request
   ================================================================ */

const { onDocumentUpdated, onDocumentCreated } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { sendToUsers } = require('./helpers/notify');
const { sendToAllMembers } = require('./helpers/users');

const APP_KEY = 'huddle';

/* ---------- Huddle Plan Updated ---------- */

const onHuddlePlanUpdate = onDocumentUpdated('huddlePlans/{planId}', async (event) => {
  const beforeData = event.data.before.data();
  const afterData = event.data.after.data();
  if (!beforeData || !afterData) return;

  const db = getFirestore();
  const messaging = getMessaging();
  const planId = event.params.planId;

  const planLabel = afterData.text
    ? (afterData.text.length > 80 ? afterData.text.substring(0, 80) + '...' : afterData.text)
    : 'a huddle plan';

  // Check for new joiners
  const beforeJoiners = (beforeData.joiners || []).map((j) => j.uid);
  const afterJoiners = (afterData.joiners || []).map((j) => j.uid);
  const newJoiners = afterJoiners.filter((uid) => !beforeJoiners.includes(uid));

  for (const joinerUid of newJoiners) {
    const joiner = (afterData.joiners || []).find((j) => j.uid === joinerUid);
    const name = joiner ? joiner.name : 'Someone';
    await sendToUsers(db, messaging, [afterData.ownerUid], {
      title: 'Huddle Joined',
      body: `${name} joined your huddle: ${planLabel}`,
      url: '/#/apps/huddle',
      tag: `huddle-join-${planId}`,
    }, APP_KEY);
  }

  // Check for new watchers
  const beforeWatchers = (beforeData.watchers || []).map((w) => w.uid);
  const afterWatchers = (afterData.watchers || []).map((w) => w.uid);
  const newWatchers = afterWatchers.filter((uid) => !beforeWatchers.includes(uid));

  for (const watcherUid of newWatchers) {
    const watcher = (afterData.watchers || []).find((w) => w.uid === watcherUid);
    const name = watcher ? watcher.name : 'Someone';
    await sendToUsers(db, messaging, [afterData.ownerUid], {
      title: 'Huddle Watcher',
      body: `${name} is watching your huddle: ${planLabel}`,
      url: '/#/apps/huddle',
      tag: `huddle-watch-${planId}`,
    }, APP_KEY);
  }

  // Check for status change
  if (beforeData.status !== afterData.status) {
    // Notify all joiners and watchers (except the owner who likely changed it)
    const notifyUids = [...new Set([...afterJoiners, ...afterWatchers])]
      .filter((uid) => uid !== afterData.ownerUid);

    if (notifyUids.length > 0) {
      const statusLabel = afterData.status === 'completed' ? 'completed'
        : afterData.status === 'cancelled' ? 'cancelled'
        : afterData.status === 'delayed' ? 'delayed'
        : 'updated';

      await sendToUsers(db, messaging, notifyUids, {
        title: 'Huddle Updated',
        body: `${afterData.ownerName}'s huddle was ${statusLabel}: ${planLabel}`,
        url: '/#/apps/huddle',
        tag: `huddle-status-${planId}`,
      }, APP_KEY);
    }
  }
});

/* ---------- Help Request Created ---------- */

const onHelpRequestCreate = onDocumentCreated('huddleHelpRequests/{requestId}', async (event) => {
  const snap = event.data;
  if (!snap) return;

  const req = snap.data();
  const db = getFirestore();
  const messaging = getMessaging();

  const title = req.title
    ? (req.title.length > 80 ? req.title.substring(0, 80) + '...' : req.title)
    : 'a new topic';

  await sendToAllMembers(db, messaging, {
    title: 'Help Request',
    body: `${req.ownerName} needs help: ${title}`,
    url: '/#/apps/huddle',
    tag: `help-${event.params.requestId}`,
  }, APP_KEY, [req.ownerUid]);
});

/* ---------- Help Request Updated (new response) ---------- */

const onHelpRequestUpdate = onDocumentUpdated('huddleHelpRequests/{requestId}', async (event) => {
  const beforeData = event.data.before.data();
  const afterData = event.data.after.data();
  if (!beforeData || !afterData) return;

  const beforeResponses = beforeData.responses || [];
  const afterResponses = afterData.responses || [];

  // Only notify if a new response was added
  if (afterResponses.length <= beforeResponses.length) return;

  const db = getFirestore();
  const messaging = getMessaging();

  // Get the latest response
  const newResponse = afterResponses[afterResponses.length - 1];
  const responderName = newResponse.name || 'Someone';

  const title = afterData.title
    ? (afterData.title.length > 80 ? afterData.title.substring(0, 80) + '...' : afterData.title)
    : 'your help request';

  await sendToUsers(db, messaging, [afterData.ownerUid], {
    title: 'Help Response',
    body: `${responderName} responded to: ${title}`,
    url: '/#/apps/huddle',
    tag: `help-${event.params.requestId}`,
  }, APP_KEY);
});

module.exports = { onHuddlePlanUpdate, onHelpRequestCreate, onHelpRequestUpdate };
