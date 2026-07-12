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

// Cross-user task assignment notifications (Phase 8)
const { onTaskAssigned } = require('./tasks');

// Task marketplace notifications (V3.314, FuturePlan 04)
const { onMarketPostCreated, onMarketPostUpdated } = require('./task-market');

// Per-user Gmail / Calendar OAuth + scrape (Phase 7)
const { exchangeOAuthCode } = require('./oauth');
const { scrapeGmailForAllUsers } = require('./gmail-scraper');
const { scrapeCalendarForAllUsers } = require('./calendar-scraper');
const { scrapeNow } = require('./scrape-now');
const { scrapeIcsCalendars, scrapeIcsNow } = require('./ics-scraper');

// Per-user pre-aggregated stats (Phase 13)
const { onEmailMessageWrite, onCalendarEventWrite } = require('./stats-updater');

// Yjs update compactor for paper editor (RM Phase G)
const { compactYjsUpdates, compactYjsNow } = require('./yjs-compactor');

// Library lifecycle (delete paper cascade)
const { deletePaper } = require('./library');

// Library metadata lookup proxy — CrossRef / PubMed / arXiv (V3.308)
const { libraryLookup } = require('./library-lookup');

// Paper compile proxy — public entry point that forwards to the private
// Cloud Run Tectonic service (V3.231).
const { paperCompile } = require('./paper-compile-proxy');

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
  onTaskAssigned,
  onMarketPostCreated,
  onMarketPostUpdated,
  exchangeOAuthCode,
  scrapeGmailForAllUsers,
  scrapeCalendarForAllUsers,
  scrapeNow,
  scrapeIcsCalendars,
  scrapeIcsNow,
  onEmailMessageWrite,
  onCalendarEventWrite,
  compactYjsUpdates,
  compactYjsNow,
  deletePaper,
  libraryLookup,
  paperCompile,
};
