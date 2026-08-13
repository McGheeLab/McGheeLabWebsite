/* ================================================================
   notify.js — Core push notification sending utility
   ================================================================
   Looks up user settings, fetches FCM tokens, sends messages,
   and cleans up stale tokens.
   ================================================================ */

const { filterByPresence } = require('./presence');

const STALE_TOKEN_ERRORS = [
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
];

// Number of consecutive failures before a token is deleted.
// Gives users time to revisit the app and refresh their token.
const MAX_FAILURES = 3;

/**
 * Build an FCM message payload for one token.
 *
 * Two client shapes need OPPOSITE payloads (Ourlab mobile m-v0.2):
 *
 *  - **Web** (Firebase JS SDK + firebase-messaging-sw.js): DATA-ONLY.
 *    A `notification` field would make the browser auto-display AND the
 *    service worker fire onBackgroundMessage → duplicate notifications.
 *    The SW owns display via onBackgroundMessage.
 *
 *  - **Native** (Capacitor @capacitor-firebase/messaging on iOS/Android):
 *    MUST include a top-level `notification` block, or a backgrounded app
 *    shows NOTHING (data-only pushes don't display on backgrounded iOS —
 *    they arrive silently to the app). We add `apns`/`android` config for
 *    display + sound and keep `data` for tap deep-linking.
 *
 * The distinction is the CLIENT, not the OS: a web PWA on an iPhone still
 * stores platform:'ios' but is a web token. So we branch on an explicit
 * `native` flag stamped by the Capacitor token registrar, never on the
 * platform string.
 *
 * @param {string} token  - FCM device token
 * @param {Object} notif  - { title, body, url, tag }
 * @param {Object} [opts] - { native?: boolean }
 * @returns {Object} FCM message object
 */
function buildMessage(token, { title, body, url, tag }, opts) {
  const t = tag || 'ourlab-' + Date.now();
  const data = {
    title,
    body,
    url: url || '/#/apps',
    tag: t,
  };
  if (opts && opts.native) {
    return {
      token,
      notification: { title, body },
      data,
      apns: {
        payload: { aps: { sound: 'default' } },
      },
      android: {
        priority: 'high',
        notification: { sound: 'default', tag: t },
      },
    };
  }
  // Web (default) — data-only, SW-displayed.
  return { token, data };
}

/**
 * Send a push notification to specific users, respecting their
 * notification settings.
 *
 * @param {Firestore}  db        - Admin Firestore instance
 * @param {Messaging}  messaging - Admin Messaging instance
 * @param {string[]}   userIds   - UIDs to notify
 * @param {Object}     notif     - { title, body, url, tag, urgent? }
 *                                 `urgent: true` bypasses the V3.596
 *                                 presence gate (ringing voice calls).
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

  // V3.596 — drop anyone already looking at the surface this notification
  // points at (Slack-style: one active surface silences ALL their devices).
  // Runs after the pref filter so we only pay a presence read for users who
  // would actually have been notified. Fails open on any error, and
  // `notif.urgent` (a ringing voice call) skips the gate entirely.
  const { send: targetUids, suppressed } = await filterByPresence(db, eligibleUids, notif);
  if (suppressed.length > 0) {
    console.log(`[Notify] Presence-suppressed ${suppressed.length} recipient(s) for "${notif.title}" (${notif.url}).`);
  }
  if (targetUids.length === 0) return 0;

  // Gather all FCM tokens for eligible users
  const tokenEntries = []; // { uid, token, docId, failCount }
  await Promise.all(
    targetUids.map(async (uid) => {
      const snap = await db.collection('users').doc(uid)
        .collection('pushTokens').get();
      snap.forEach((doc) => {
        const data = doc.data();
        tokenEntries.push({
          uid,
          token: data.token || doc.id,
          docId: doc.id,
          failCount: data.failCount || 0,
          native: data.native === true, // Capacitor-stamped; drives payload shape
        });
      });
    })
  );

  if (tokenEntries.length === 0) return 0;

  // Build and send messages
  const messages = tokenEntries.map((entry) => buildMessage(entry.token, notif, { native: entry.native }));
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

/**
 * Record notifications to each user's in-app feed (V3.594).
 *
 * Push is transient: if a student misses the buzz, the information is
 * GONE, and most of it is not re-derivable from current data ("the
 * booking after yours was cancelled" leaves no trace on the calendar
 * once the doc flips). The feed is the catch-up surface — My Day renders
 * it as a 🔔 Notifications section.
 *
 * Deliberately independent of push preferences: a user who muted
 * equipment push should still be able to READ what happened when they
 * open My Day. That's the whole point of a fallback surface.
 *
 * `tag` collapse mirrors FCM: an unread item with the same tag is
 * REPLACED, so a student editing their booking five times in two
 * minutes leaves one current notice, not five stale ones.
 *
 * Admin SDK write → bypasses rules, which is why the client can only
 * read/delete these and flip `readAt` (see firestore.rules).
 *
 * @param {Firestore} db
 * @param {string[]}  userIds
 * @param {Object}    notif  - { title, body, url, tag }
 * @param {string}    appKey
 * @param {string}    kind   - 'adjacency' | 'watch' | 'reminder' | 'coop' | ...
 * @returns {Promise<number>} items written
 */
async function recordFeedItems(db, userIds, notif, appKey, kind) {
  if (!userIds || userIds.length === 0) return 0;
  const uniqueIds = [...new Set(userIds)];
  const FieldValue = require('firebase-admin/firestore').FieldValue;
  let written = 0;

  await Promise.all(uniqueIds.map(async (uid) => {
    if (!uid) return;
    try {
      const col = db.collection('userData').doc(uid).collection('notifications');

      // Collapse on tag: drop this user's existing UNREAD item with the
      // same tag so the feed shows the current state, not a history of
      // every intermediate edit. Read items are left alone as a record.
      if (notif.tag) {
        const dupes = await col
          .where('tag', '==', notif.tag)
          .where('readAt', '==', null)
          .get();
        await Promise.all(dupes.docs.map((d) => d.ref.delete()));
      }

      await col.add({
        title: notif.title || '',
        body: notif.body || '',
        url: notif.url || '/rm/pages/equipment.html',
        tag: notif.tag || null,
        appKey: appKey || null,
        kind: kind || null,
        readAt: null,
        createdAt: FieldValue.serverTimestamp(),
      });
      written++;
    } catch (e) {
      // The feed is a convenience surface — never let it break the push
      // path that already succeeded.
      console.warn(`[Notify] feed write failed for ${uid}: ${e && e.message}`);
    }
  }));

  return written;
}

/**
 * Send a push AND record it to the in-app feed. Use this for anything a
 * student would want to catch up on later; use sendToUsers alone for
 * ephemeral signals (ringing calls, "someone is typing").
 */
async function notifyUsers(db, messaging, userIds, notif, appKey, kind) {
  const sent = await sendToUsers(db, messaging, userIds, notif, appKey);
  await recordFeedItems(db, userIds, notif, appKey, kind);
  return sent;
}

module.exports = { sendToUsers, buildMessage, recordFeedItems, notifyUsers };
