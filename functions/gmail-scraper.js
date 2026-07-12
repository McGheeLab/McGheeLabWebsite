/* ================================================================
   gmail-scraper.js — Phase 7: per-user Gmail scrape on schedule
   ================================================================
   Scheduled function (every 10 minutes; V3.288, was 15). For each user
   with a stored gmailCredential, refreshes the access token if needed,
   fetches new message metadata since lastSyncAt, and writes parsed
   entries to userData/{uid}/emailMessages/{messageId}. This is the
   "scrape even when no page is open" path — runs server-side regardless
   of any client. The email-review page adds an on-load + 10-min client
   poll on top for immediacy while a tab is open.

   This replaces the single-tenant scripts/gmail_fetch.py loop on
   server.py — Alex's archive becomes one of N per-user archives.

   Runtime cost: 1 call/10min × N users. For N=10 lab members and
   typical mailbox sizes (~100 new msgs/day) this stays well within
   the Firebase Functions free tier.

   Setup:
     firebase functions:secrets:set OAUTH_CLIENT_ID  (already from oauth.js)
     firebase functions:secrets:set OAUTH_CLIENT_SECRET
     firebase deploy --only functions:scrapeGmailForAllUsers
   ================================================================ */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const OAUTH_CLIENT_ID = defineSecret('OAUTH_CLIENT_ID');
const OAUTH_CLIENT_SECRET = defineSecret('OAUTH_CLIENT_SECRET');

const FETCH_BATCH = 50;          // messages per Gmail API call (max 100)
const MAX_NEW_MSGS_PER_RUN = 200; // cap per user to avoid quota burn

async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID.value(),
    client_secret: OAUTH_CLIENT_SECRET.value(),
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error('Token refresh failed (' + r.status + '): ' + text);
  }
  const j = await r.json();
  return { accessToken: j.access_token, expiresIn: j.expires_in || 3600 };
}

async function listNewMessageIds(accessToken, sinceEpochSeconds) {
  // Gmail's `q` parameter accepts `after:<unix>`. Limit to inbox + sent
  // (most lab activity is one of those).
  const q = sinceEpochSeconds
    ? `after:${Math.floor(sinceEpochSeconds)}`
    : 'newer_than:7d';   // first run: last 7 days only
  const url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?' +
    new URLSearchParams({ q, maxResults: String(MAX_NEW_MSGS_PER_RUN) });
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!r.ok) {
    const text = await r.text();
    throw new Error('Gmail list failed (' + r.status + '): ' + text);
  }
  const j = await r.json();
  return (j.messages || []).map(m => m.id);
}

async function fetchMessage(accessToken, messageId) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!r.ok) return null;
  return r.json();
}

function parseHeaders(headers) {
  const out = {};
  for (const h of headers || []) {
    const k = (h.name || '').toLowerCase();
    out[k] = h.value || '';
  }
  return out;
}

async function scrapeOneUser(db, uid) {
  const credRef = db.collection('userData').doc(uid).collection('private').doc('gmailCredential');
  const credSnap = await credRef.get();
  if (!credSnap.exists) return { uid, skipped: 'no-credential' };
  const cred = credSnap.data();
  if (!cred.refreshToken) return { uid, skipped: 'no-refresh-token' };

  // Refresh access token. Cache the access_token in the doc so re-runs
  // within the expiry window skip a refresh — minor optimization.
  let { accessToken, accessTokenExpiresAt } = cred;
  if (!accessToken || !accessTokenExpiresAt || accessTokenExpiresAt < Date.now() + 60_000) {
    try {
      const refreshed = await refreshAccessToken(cred.refreshToken);
      accessToken = refreshed.accessToken;
      accessTokenExpiresAt = Date.now() + (refreshed.expiresIn - 60) * 1000;
      await credRef.set({ accessToken, accessTokenExpiresAt }, { merge: true });
    } catch (err) {
      // Refresh failed — likely user revoked consent. Mark credential broken
      // and bail; the UI will show "not connected" until they reconnect.
      await credRef.set({
        lastSyncAt: FieldValue.serverTimestamp(),
        lastSyncError: err.message,
        refreshTokenStored: false,
      }, { merge: true });
      return { uid, error: 'refresh-failed: ' + err.message };
    }
  }

  // Determine sincê — last successful sync, or null for first run.
  const sinceEpoch = cred.lastSyncEpoch || null;

  let messageIds;
  try {
    messageIds = await listNewMessageIds(accessToken, sinceEpoch);
  } catch (err) {
    await credRef.set({ lastSyncAt: FieldValue.serverTimestamp(), lastSyncError: err.message }, { merge: true });
    return { uid, error: 'list-failed: ' + err.message };
  }

  let written = 0;
  const archive = db.collection('userData').doc(uid).collection('emailMessages');
  // Fetch + write in chunks so a single user's quota doesn't dominate the run.
  for (let i = 0; i < messageIds.length; i += FETCH_BATCH) {
    const batch = messageIds.slice(i, i + FETCH_BATCH);
    const msgs = await Promise.all(batch.map(id => fetchMessage(accessToken, id)));
    const fbBatch = db.batch();
    for (const m of msgs) {
      if (!m || !m.id) continue;
      const headers = parseHeaders(m.payload && m.payload.headers);
      fbBatch.set(archive.doc(m.id), {
        id: m.id,
        threadId: m.threadId || '',
        from: headers.from || '',
        to: headers.to || '',
        cc: headers.cc || '',
        subject: headers.subject || '',
        date: headers.date || '',
        snippet: m.snippet || '',
        labels: m.labelIds || [],
        internalDate: m.internalDate ? Number(m.internalDate) : 0,
        sizeEstimate: m.sizeEstimate || 0,
        synced_at: FieldValue.serverTimestamp(),
      }, { merge: true });
      written++;
    }
    await fbBatch.commit();
  }

  await credRef.set({
    lastSyncAt: FieldValue.serverTimestamp(),
    lastSyncEpoch: Math.floor(Date.now() / 1000),
    lastSyncError: null,
    lastSyncCount: written,
  }, { merge: true });

  return { uid, written };
}

const scrapeGmailForAllUsers = onSchedule(
  {
    schedule: 'every 10 minutes',
    timeZone: 'America/Phoenix',
    secrets: [OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET],
    memory: '512MiB',
    timeoutSeconds: 540,
  },
  async () => {
    const db = getFirestore();
    // Find all userData/{uid}/private/gmailCredential docs via collectionGroup.
    const credSnap = await db.collectionGroup('private')
      .where('provider', '==', 'gmail')
      .get();
    const results = [];
    for (const doc of credSnap.docs) {
      // Path is userData/{uid}/private/{docId}
      const uid = doc.ref.parent.parent.id;
      try {
        const r = await scrapeOneUser(db, uid);
        results.push(r);
      } catch (err) {
        results.push({ uid, error: 'unhandled: ' + err.message });
      }
    }
    console.log('[gmail-scrape] run complete', JSON.stringify(results));
  }
);

module.exports = { scrapeGmailForAllUsers };
