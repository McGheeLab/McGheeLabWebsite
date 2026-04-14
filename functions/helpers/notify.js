/* ================================================================
   notify.js — Core push notification sending utility
   ================================================================
   Looks up user settings, fetches FCM tokens, sends messages,
   and cleans up stale tokens.
   ================================================================ */

const STALE_TOKEN_ERRORS = [
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
];

// Number of consecutive failures before a token is deleted.
// Gives users time to revisit the app and refresh their token.
const MAX_FAILURES = 3;

/**
 * Build an FCM message payload in the format expected by the
 * McGheeLab service worker (firebase-messaging-sw.js).
 *
 * @param {string} token  - FCM device token
 * @param {Object} notif  - { title, body, url, tag }
 * @returns {Object} FCM message object
 */
function buildMessage(token, { title, body, url, tag }) {
  // Data-only message — no `notification` field.
  // The `notification` field causes the browser to auto-display AND
  // the service worker to fire onBackgroundMessage, resulting in
  // duplicate notifications. Data-only lets the service worker
  // handle all display via onBackgroundMessage.
  return {
    token,
    data: {
      title,
      body,
      url: url || '/#/apps',
      tag: tag || 'mcgheelab-' + Date.now(),
    },
  };
}

/**
 * Send a push notification to specific users, respecting their
 * notification settings.
 *
 * @param {Firestore}  db        - Admin Firestore instance
 * @param {Messaging}  messaging - Admin Messaging instance
 * @param {string[]}   userIds   - UIDs to notify
 * @param {Object}     notif     - { title, body, url, tag }
 * @param {string}     appKey    - Settings key: 'chat' | 'huddle' | 'equipment' | 'meetings' | etc.
 * @returns {Promise<number>} Number of messages sent
 */
async function sendToUsers(db, messaging, userIds, notif, appKey) {
  if (!userIds || userIds.length === 0) return 0;

  // Deduplicate
  const uniqueIds = [...new Set(userIds)];

  // Batch-read user settings to check who has notifications enabled
  const settingsDocs = await Promise.all(
    uniqueIds.map((uid) => db.collection('userSettings').doc(uid).get())
  );

  // Filter to users who have notifications enabled for this app
  const eligibleUids = uniqueIds.filter((uid, i) => {
    const doc = settingsDocs[i];
    if (!doc.exists) return true; // no settings doc = default on
    const settings = doc.data();
    const notifSettings = settings.notifications;
    if (!notifSettings) return true; // no notification prefs = default on
    if (notifSettings.enabled === false) return false; // master toggle off
    if (notifSettings.apps && notifSettings.apps[appKey]
        && notifSettings.apps[appKey].push === false) return false; // app toggle off
    return true;
  });

  if (eligibleUids.length === 0) return 0;

  // Gather all FCM tokens for eligible users
  const tokenEntries = []; // { uid, token, docId, failCount }
  await Promise.all(
    eligibleUids.map(async (uid) => {
      const snap = await db.collection('users').doc(uid)
        .collection('pushTokens').get();
      snap.forEach((doc) => {
        const data = doc.data();
        tokenEntries.push({
          uid,
          token: data.token || doc.id,
          docId: doc.id,
          failCount: data.failCount || 0,
        });
      });
    })
  );

  if (tokenEntries.length === 0) return 0;

  // Build and send messages
  const messages = tokenEntries.map((entry) => buildMessage(entry.token, notif));
  const response = await messaging.sendEach(messages);

  // Handle stale tokens — increment fail count, delete after MAX_FAILURES
  const staleOps = [];
  response.responses.forEach((result, i) => {
    if (result.error && STALE_TOKEN_ERRORS.includes(result.error.code)) {
      const entry = tokenEntries[i];
      const docRef = db.collection('users').doc(entry.uid)
        .collection('pushTokens').doc(entry.docId);
      const currentFails = (entry.failCount || 0) + 1;

      if (currentFails >= MAX_FAILURES) {
        staleOps.push(docRef.delete());
        console.log(`[Notify] Deleted token for ${entry.uid} after ${currentFails} consecutive failures.`);
      } else {
        staleOps.push(docRef.update({
          failCount: currentFails,
          lastFailedAt: new Date().toISOString(),
        }));
        console.log(`[Notify] Token for ${entry.uid} failed (${currentFails}/${MAX_FAILURES}).`);
      }
    }
  });
  if (staleOps.length > 0) {
    await Promise.all(staleOps);
  }

  const sent = response.successCount;
  console.log(`[Notify] Sent ${sent}/${messages.length} message(s) for "${notif.title}".`);
  return sent;
}

module.exports = { sendToUsers, buildMessage };
