/* ================================================================
   users.js — User / lab member query helpers
   ================================================================ */

const { sendToUsers } = require('./notify');

/**
 * Send a notification to all lab members (everyone with a user doc),
 * optionally excluding specific UIDs.
 *
 * @param {Firestore}  db          - Admin Firestore instance
 * @param {Messaging}  messaging   - Admin Messaging instance
 * @param {Object}     notif       - { title, body, url, tag }
 * @param {string}     appKey      - Settings key for per-app toggle
 * @param {string[]}   excludeUids - UIDs to skip (e.g., the sender)
 * @returns {Promise<number>} Number of messages sent
 */
async function sendToAllMembers(db, messaging, notif, appKey, excludeUids = []) {
  const usersSnap = await db.collection('users').get();
  const allUids = [];
  usersSnap.forEach((doc) => allUids.push(doc.id));

  const excludeSet = new Set(excludeUids);
  const targetUids = allUids.filter((uid) => !excludeSet.has(uid));

  return sendToUsers(db, messaging, targetUids, notif, appKey);
}

module.exports = { sendToAllMembers };
