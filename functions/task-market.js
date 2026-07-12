/* ================================================================
   task-market.js — Push notifications for the task marketplace
   ================================================================
   V3.314 (FuturePlan 04, Release A2).

   Triggers on taskMarket/{postId}:
   - onCreate:
       · post directed at someone (targetUid set) → push the target.
         Covers both open handoffs ("can you take this over?") and the
         V3.317 admin direct-assign flow (post born status 'accepted' —
         phrased as a plain task-sent push; the legacy per-task push in
         tasks.js is suppressed for market-materialized tasks).
       · kind 'request' ("I need work") → push all admins.
       · undirected offers stay silent — the board is the discovery
         surface; only three notification types are in scope.
   - onUpdate, only on the open → claimed/accepted/declined edge →
       push the post creator. Creator-initiated transitions
       (withdraw / complete) are self-inflicted and stay silent.

   appKey 'tasks' — same notification-settings toggle as task pushes.
   ================================================================ */

const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { sendToUsers } = require('./helpers/notify');

const APP_KEY = 'tasks';
const MARKET_URL = '/rm/pages/task-market.html';
const PREVIEW_LEN = 120;

function preview(s) {
  const t = String(s || '').trim();
  return t.length > PREVIEW_LEN ? t.substring(0, PREVIEW_LEN) + '...' : t;
}

async function adminUids(db) {
  const snap = await db.collection('users').where('role', '==', 'admin').get();
  const uids = [];
  snap.forEach((d) => uids.push(d.id));
  return uids;
}

const onMarketPostCreated = onDocumentCreated('taskMarket/{postId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const post = snap.data();
  if (!post) return;

  const db = getFirestore();
  const messaging = getMessaging();
  const creator = post.createdByName || 'A teammate';
  const title = preview(post.title || '(untitled)');

  if (post.targetUid && post.targetUid !== post.createdByUid) {
    const notif = post.status === 'accepted'
      ? {
          title: 'Task from ' + creator,
          body: title,
          url: '/rm/pages/tasks.html',
          tag: 'rm-market-' + event.params.postId,
        }
      : {
          title: '🤝 ' + creator + ' needs a hand',
          body: title + ' — accept or decline on the Task Market',
          url: MARKET_URL,
          tag: 'rm-market-' + event.params.postId,
        };
    await sendToUsers(db, messaging, [post.targetUid], notif, APP_KEY);
    return;
  }

  if (post.kind === 'request' && post.status === 'open') {
    const admins = (await adminUids(db)).filter((uid) => uid !== post.createdByUid);
    if (!admins.length) return;
    await sendToUsers(db, messaging, admins, {
      title: '🙋 ' + creator + ' is asking for work',
      body: title,
      url: MARKET_URL,
      tag: 'rm-market-' + event.params.postId,
    }, APP_KEY);
  }
});

const onMarketPostUpdated = onDocumentUpdated('taskMarket/{postId}', async (event) => {
  const before = event.data && event.data.before && event.data.before.data();
  const after = event.data && event.data.after && event.data.after.data();
  if (!before || !after) return;
  if (before.status !== 'open') return;
  if (['claimed', 'accepted', 'declined'].indexOf(after.status) === -1) return;

  const creatorUid = after.createdByUid;
  const actor = after.claimedByName || after.targetName || 'A teammate';
  if (!creatorUid) return;
  // Creator transitioning their own post (shouldn't hit this edge, but
  // guard anyway) — no self-push.
  const actorUid = after.claimedByUid || after.targetUid || null;
  if (actorUid === creatorUid) return;

  const title = preview(after.title || '(untitled)');
  let body;
  if (after.status === 'declined') {
    body = actor + ' declined: ' + title;
  } else if (after.kind === 'request') {
    body = actor + ' is on it: ' + title;
  } else if (after.kind === 'handoff') {
    body = actor + ' accepted: ' + title;
  } else {
    body = actor + ' claimed: ' + title;
  }

  const db = getFirestore();
  const messaging = getMessaging();
  await sendToUsers(db, messaging, [creatorUid], {
    title: after.status === 'declined' ? 'Marketplace post declined' : 'Your post was ' + (after.kind === 'request' ? 'answered' : after.status),
    body: body,
    url: MARKET_URL,
    tag: 'rm-market-' + event.params.postId,
  }, APP_KEY);
});

module.exports = { onMarketPostCreated, onMarketPostUpdated };
