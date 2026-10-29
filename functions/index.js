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

// Lab Meetings (V3.743) — presenter/slide-pipeline reminders (09:00 + 16:00
// Phoenix), peer-accept slot swaps executed server-side, deck-posted /
// review-decided / presenter-added notices. First consumer of the
// `notifications.apps.meetings.push` user toggle.
// V3.938 — one-on-ones: subscribed / reserved / moved / skipped notices, and
// the afternoon-before reminder inside meetingReminders.
const { meetingReminders, onMeetingSwapWritten, onMeetingWritten, onOneOnOneSlotWritten } = require('./meetings');

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
const { onInventoryQtyWrite, inventoryLowDigest } = require('./inventory-alerts');

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

// Teacher-class assignment/submission notifications (V3.671, teacher
// program R2) — publish fan-out to enrollees, submission → teacher,
// grade → student.
const { onAssignmentWrite, onSubmissionWrite } = require('./class-notify');

// Engagement-hub request notifications (V3.673, teacher program R4) —
// new request → teacher + admins; decision → requester.
const { onEngageRequestWrite, onEngageReviewWrite } = require('./engage-notify');

// Admin-issued teacher setup links (V3.680) — a signed-in teacher redeems
// teacherInvites/{token} and this provisions class + code + category.
const { redeemTeacherInvite } = require('./teacher-invite');

// No-account visit posts (V3.808) — a teacher posts a classroom-visit
// opportunity from #/invite-a-scientist and manages it by private link.
const { engageGuest } = require('./engage-guest');

// BME466 course platform (V3.681) — request-thread replies (denormalize +
// notify the other side) and assignment publish fan-out by section level.
const { onBme466MessageCreated, onBme466AssignmentWrite } = require('./bme466-notify');

// Research-map proposals (V3.851) — a member proposes a card; the
// proposer's advisors + admins are told, and the proposer hears the decision.
const { onResearchFocusWritten } = require('./research-foci-notify');

// One person, two Google logins (V3.806) — an alias login (map in
// auth-alias.js) is swapped for a custom-token session on the primary uid.
const { aliasSignIn } = require('./auth-alias');

// Procurement v2 (V3.813) — ticket lifecycle pushes + daily sweep.
const { onProcurementTicketWritten, procurementDailySweep } = require('./procurement-notify');

// Scientia cloud hub (V3.857) — Gabe's notebook sync protocol (serve.py /
// sisync.py) on Firestore: one record per lab member, the online build and
// the desktop bridge (rm/scientia/scientia-cloud.py) are both its devices.
const { scientiaHub } = require('./scientia-hub');

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
  meetingReminders,
  onMeetingSwapWritten,
  onMeetingWritten,
  onOneOnOneSlotWritten,
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
  onInventoryQtyWrite,
  inventoryLowDigest,
  onBoardCommentCreate,
  restorePaperComments,
  fetchPaperPdf,
  uploadPaperPdf,
  paperPdfFetchProxy,
  releaseAnnounce,
  onAssignmentWrite,
  onSubmissionWrite,
  onEngageRequestWrite,
  onEngageReviewWrite,
  redeemTeacherInvite,
  engageGuest,
  onBme466MessageCreated,
  onBme466AssignmentWrite,
  onResearchFocusWritten,
  aliasSignIn,
  scientiaHub,
  onProcurementTicketWritten,
  procurementDailySweep,
};
