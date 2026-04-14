/* ================================================================
   McGheeLab Cloud Functions — Push Notifications
   ================================================================
   Firestore-triggered functions that send FCM push notifications
   to lab members when relevant events occur.

   Deploy:  firebase deploy --only functions
   Logs:    firebase functions:log
   ================================================================ */

const { initializeApp } = require('firebase-admin/app');

// Initialize Firebase Admin (uses default service account in Cloud Functions)
initializeApp();

// Chat notifications
const { onChatMessageCreate } = require('./chat');

// Huddle & help request notifications
const { onHuddlePlanUpdate, onHelpRequestCreate, onHelpRequestUpdate } = require('./huddle');

// Equipment booking notifications
const { onEquipmentBookingCreate, onEquipmentBookingUpdate } = require('./equipment');

// Admin test notifications
const { sendTestNotification } = require('./test-notifications');

// Calendar proxy (server-side ICS fetch to bypass CORS)
const { calendarProxy } = require('./calendar-proxy');

// Export all functions
module.exports = {
  onChatMessageCreate,
  onHuddlePlanUpdate,
  onHelpRequestCreate,
  onHelpRequestUpdate,
  onEquipmentBookingCreate,
  onEquipmentBookingUpdate,
  sendTestNotification,
  calendarProxy,
};
