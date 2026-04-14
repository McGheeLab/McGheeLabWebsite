/* ================================================================
   test-notifications.js — Admin test endpoint
   ================================================================
   HTTPS callable function that sends a sample push notification
   to the calling user's devices. Admin-only. Bypasses notification
   settings so the test always arrives.
   ================================================================ */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { buildMessage } = require('./helpers/notify');

const TEST_NOTIFICATIONS = {
  chat: {
    title: '#general',
    body: 'Jane Doe: Hey team, the new microfluidic chips arrived today!',
    url: '/#/apps/chat?channel=general',
    tag: 'test-chat',
  },
  'chat-dm': {
    title: 'Jane Doe',
    body: 'Can you check the TFM results when you get a chance?',
    url: '/#/apps/chat?channel=dm_test',
    tag: 'test-chat-dm',
  },
  'chat-mention': {
    title: '#announcements',
    body: 'Jane Doe: @you Please review the protocol before Friday',
    url: '/#/apps/chat?channel=announcements',
    tag: 'test-chat-mention',
  },
  'huddle-join': {
    title: 'Huddle Joined',
    body: 'Jane Doe joined your huddle: Cell culture prep for GELS experiment',
    url: '/#/apps/huddle',
    tag: 'test-huddle-join',
  },
  'huddle-status': {
    title: 'Huddle Updated',
    body: "Jane Doe's huddle was completed: Microfluidic device fabrication",
    url: '/#/apps/huddle',
    tag: 'test-huddle-status',
  },
  'help-request': {
    title: 'Help Request',
    body: 'Jane Doe needs help: TFM calibration producing inconsistent displacement fields',
    url: '/#/apps/huddle',
    tag: 'test-help-request',
  },
  'help-response': {
    title: 'Help Response',
    body: 'Jane Doe responded to: TFM calibration producing inconsistent displacement fields',
    url: '/#/apps/huddle',
    tag: 'test-help-response',
  },
  'equipment-approval': {
    title: 'Booking Request',
    body: 'Jane Doe requests Confocal Microscope on 2026-04-15',
    url: '/#/apps/equipment',
    tag: 'test-equip-approval',
  },
  'equipment-confirmed': {
    title: 'Booking Confirmed',
    body: 'Your Confocal Microscope booking on 2026-04-15 is confirmed',
    url: '/#/apps/equipment',
    tag: 'test-equip-confirmed',
  },
  'equipment-displaced': {
    title: 'Booking Displaced',
    body: 'Your Bioprinter booking on 2026-04-16 needs rebooking',
    url: '/#/apps/equipment',
    tag: 'test-equip-displaced',
  },
};

const sendTestNotification = onCall(async (request) => {
  // Must be authenticated
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be logged in.');
  }

  // Must be admin
  const db = getFirestore();
  const userDoc = await db.collection('users').doc(request.auth.uid).get();
  if (!userDoc.exists || userDoc.data().role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin only.');
  }

  const type = request.data.type;
  if (!type || !TEST_NOTIFICATIONS[type]) {
    throw new HttpsError('invalid-argument',
      `Invalid type. Valid types: ${Object.keys(TEST_NOTIFICATIONS).join(', ')}`);
  }

  const notif = TEST_NOTIFICATIONS[type];
  const messaging = getMessaging();

  // Get all tokens for the calling user (bypass settings check)
  const tokensSnap = await db.collection('users').doc(request.auth.uid)
    .collection('pushTokens').get();

  if (tokensSnap.empty) {
    return { success: false, error: 'No push tokens found for your account. Make sure notifications are enabled on your device.' };
  }

  const tokens = [];
  tokensSnap.forEach((doc) => {
    const data = doc.data();
    tokens.push({ token: data.token || doc.id, docId: doc.id, failCount: data.failCount || 0 });
  });

  const MAX_FAILURES = 3;
  const messages = tokens.map((t) => buildMessage(t.token, notif));
  const response = await messaging.sendEach(messages);

  // Handle stale tokens — increment fail count, delete after MAX_FAILURES
  const staleErrors = [
    'messaging/invalid-registration-token',
    'messaging/registration-token-not-registered',
  ];
  const staleOps = [];
  response.responses.forEach((result, i) => {
    if (result.error && staleErrors.includes(result.error.code)) {
      const docRef = db.collection('users').doc(request.auth.uid)
        .collection('pushTokens').doc(tokens[i].docId);
      const currentFails = (tokens[i].failCount || 0) + 1;

      if (currentFails >= MAX_FAILURES) {
        staleOps.push(docRef.delete());
      } else {
        staleOps.push(docRef.update({
          failCount: currentFails,
          lastFailedAt: new Date().toISOString(),
        }));
      }
    }
  });
  if (staleOps.length > 0) await Promise.all(staleOps);

  // Build detailed response
  const results = response.responses.map((r, i) => ({
    token: tokens[i].token.substring(0, 12) + '...',
    success: r.success,
    error: r.error ? r.error.code : null,
  }));

  console.log(`[Test] Sent "${type}" to ${request.auth.uid}: ${response.successCount}/${messages.length} succeeded`);

  return {
    success: response.successCount > 0,
    sent: response.successCount,
    failed: response.failureCount,
    staleTokensCleaned: staleDeletes.length,
    results,
  };
});

module.exports = { sendTestNotification, TEST_NOTIFICATION_TYPES: Object.keys(TEST_NOTIFICATIONS) };
