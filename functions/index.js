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

// Chat notifications + server-side mention fan-out / channel counters
// (chat program R2) + one-time subscriberUids backfill endpoint
const { onChatMessageCreate, chatBackfillSubscribers, chatImportSlackHistory } = require('./chat');

// Huddle & help request notifications
const { onHuddlePlanUpdate, onHelpRequestCreate, onHelpRequestUpdate } = require('./huddle');

// Voice call "ringing" push — Slack-style huddle in chat (V3.525)
const { onVoiceCallCreate } = require('./voice-call');

// Equipment booking notifications
const { onEquipmentBookingCreate, onEquipmentBookingUpdate } = require('./equipment');

// Equipment scheduled jobs — morning-of / T-30 reminders + Monday
// manager digest (V3.595, FuturePlan 08 Phase 3)
const { equipmentBookingReminders, equipmentWeeklyDigest } = require('./equipment-reminders');

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

// Builder paper lifecycle — full cascade delete of a projects(type==paper)
// paper: owned subtrees (papers/{id}, drafts/{id}), paperExports, Storage
// figures; unlinks (keeps) library associations + evidence highlights (V3.482).
const { deleteBuilderPaper } = require('./delete-builder-paper');

// Paper author roster sync — mirror projects(type==paper) author fields
// onto papers/{id}.authorUids so coauthor read/edit rules + PMR's
// paper-writing query work (V3.473).
const { onPaperAuthorSync, onMentorRosterSync } = require('./paper-author-sync');

// Figure board change signal (V3.612) — one live "board updated"
// notification per board (unread-gated + tag-collapsed).
const { onBoardItemWrite, onBoardCommentCreate } = require('./figure-board-notify');

// Faithful comment restore on paper import (import/export E3) — Admin SDK
// preserves each comment's true authorUid + timestamps (V3.481).
const { restorePaperComments } = require('./restore-paper-comments');

// Library metadata lookup proxy — CrossRef / PubMed / arXiv (V3.308)
const { libraryLookup } = require('./library-lookup');

// Semantic Scholar proxy — references / cited-by / abstract / tldr
// (V3.583). The API sends no CORS header, so the browser could never
// call it from mcgheelab.com and import-time enrichment silently
// never ran on the deploy.
const { semanticScholarLookup } = require('./semantic-scholar');

// Paper compile proxy — public entry point that forwards to the private
// Cloud Run Tectonic service (V3.231).
const { paperCompile } = require('./paper-compile-proxy');

// Scheduler push notifications — guest responses + slot assignments (V3.342).
const { onParticipantUpdated } = require('./scheduler');

// Equation snip → LaTeX transcription for the reader's capture modal
// (V3.461). Needs the ANTHROPIC_API_KEY secret set once before deploy.
const { equationOcr } = require('./equation-ocr');

// Server-side open-access PDF fetcher (V3.498) — tries Unpaywall (all
// locations) + arXiv + Europe PMC + Semantic Scholar + the publisher's
// citation_pdf_url, fetches server-side (no CORS), uploads to Storage.
const { fetchPaperPdf } = require('./fetch-paper-pdf');

// Bookmarklet PDF receiver (V3.500) — the "Grab PDF for RM" bookmarklet
// POSTs paywalled PDFs (fetched in the user's logged-in browser) here,
// authenticated by a per-device uploadTokens/{token}.
const { uploadPaperPdf } = require('./upload-paper-pdf');

// Headless-Chrome PDF grabber proxy (V3.501) — fallback that forwards to
// the private Cloud Run paper-pdf-fetch service (dormant until deployed).
const { paperPdfFetchProxy } = require('./paper-pdf-fetch-proxy');

// "What's New" release broadcast (V3.604) — admin announces a batched app
// release; one push + feed item to every lab member, history in `releases`.
const { releaseAnnounce } = require('./release-announce');

// Export all functions
module.exports = {
  onChatMessageCreate,
  chatBackfillSubscribers,
  chatImportSlackHistory,
  onHuddlePlanUpdate,
  onHelpRequestCreate,
  onHelpRequestUpdate,
  onVoiceCallCreate,
  onEquipmentBookingCreate,
  onEquipmentBookingUpdate,
  equipmentBookingReminders,
  equipmentWeeklyDigest,
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
  deleteBuilderPaper,
  libraryLookup,
  semanticScholarLookup,
  paperCompile,
  onParticipantUpdated,
  equationOcr,
  onPaperAuthorSync,
  onMentorRosterSync,
  onBoardItemWrite,
  onBoardCommentCreate,
  restorePaperComments,
  fetchPaperPdf,
  uploadPaperPdf,
  paperPdfFetchProxy,
  releaseAnnounce,
};
