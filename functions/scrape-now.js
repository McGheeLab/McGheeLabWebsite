/* ================================================================
   scrape-now.js — Phase 7: on-demand Gmail/Calendar scrape
   ================================================================
   HTTP function the settings page calls to trigger an immediate
   scrape for the calling user. Lets users see their data within
   seconds of connecting instead of waiting for the next 15-minute
   scheduled tick.

   Reuses the same scrapeOneUser logic from gmail-scraper.js and
   calendar-scraper.js. To avoid abuse, it rate-limits to one call
   per provider per user per 60 seconds.
   ================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const OAUTH_CLIENT_ID = defineSecret('OAUTH_CLIENT_ID');
const OAUTH_CLIENT_SECRET = defineSecret('OAUTH_CLIENT_SECRET');

const ALLOWED_ORIGINS = [
  'https://mcgheelab.com',
  'https://www.mcgheelab.com',
  'http://localhost:8000',
];

const RATE_LIMIT_MS = 60_000;

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Max-Age', '3600');
}

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
  if (!r.ok) throw new Error('refresh failed (' + r.status + '): ' + await r.text());
  const j = await r.json();
  return { accessToken: j.access_token, expiresIn: j.expires_in || 3600 };
}

// List message ids for a query, following nextPageToken up to `cap`. The
// incremental path (after:lastSync) is usually one short page; an explicit
// `days` backfill can span many pages, so we paginate instead of truncating
// at a single 200-message page (which silently dropped older missed mail).
async function listMessageIds(accessToken, q, cap) {
  const ids = [];
  let pageToken = '';
  while (ids.length < cap) {
    const params = new URLSearchParams({ q, maxResults: '200' });
    if (pageToken) params.set('pageToken', pageToken);
    const r = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?' + params.toString(),
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    if (!r.ok) throw new Error('list failed (' + r.status + '): ' + await r.text());
    const j = await r.json();
    for (const m of (j.messages || [])) ids.push(m.id);
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return ids.slice(0, cap);
}

// `days` (optional): a deliberate "go back N days" backfill from the client.
// When set, the query ignores lastSyncEpoch and reaches back the full window.
async function scrapeGmail(db, uid, days) {
  const credRef = db.collection('userData').doc(uid).collection('private').doc('gmailCredential');
  const credSnap = await credRef.get();
  if (!credSnap.exists) return { error: 'gmail-not-connected' };
  const cred = credSnap.data();
  if (!cred.refreshToken) return { error: 'no-refresh-token' };

  let { accessToken, accessTokenExpiresAt } = cred;
  if (!accessToken || !accessTokenExpiresAt || accessTokenExpiresAt < Date.now() + 60_000) {
    const refreshed = await refreshAccessToken(cred.refreshToken);
    accessToken = refreshed.accessToken;
    accessTokenExpiresAt = Date.now() + (refreshed.expiresIn - 60) * 1000;
    await credRef.set({ accessToken, accessTokenExpiresAt }, { merge: true });
  }

  const sinceEpoch = cred.lastSyncEpoch || null;
  const q = days
    ? `newer_than:${days}d`                                  // explicit backfill
    : (sinceEpoch ? `after:${Math.floor(sinceEpoch)}` : 'newer_than:7d');
  const cap = days ? 2000 : 200;       // backfill can span many pages; incremental stays cheap
  const ids = await listMessageIds(accessToken, q, cap);

  const archive = db.collection('userData').doc(uid).collection('emailMessages');
  let written = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    const msgs = await Promise.all(slice.map(async id => {
      const r = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata`,
        { headers: { Authorization: 'Bearer ' + accessToken } }
      );
      if (!r.ok) return null;
      return r.json();
    }));
    const batch = db.batch();
    for (const m of msgs) {
      if (!m || !m.id) continue;
      const headers = {};
      for (const h of (m.payload && m.payload.headers) || []) headers[(h.name || '').toLowerCase()] = h.value;
      batch.set(archive.doc(m.id), {
        id: m.id, threadId: m.threadId || '',
        from: headers.from || '', to: headers.to || '', cc: headers.cc || '',
        subject: headers.subject || '', date: headers.date || '',
        snippet: m.snippet || '', labels: m.labelIds || [],
        internalDate: m.internalDate ? Number(m.internalDate) : 0,
        sizeEstimate: m.sizeEstimate || 0,
        synced_at: FieldValue.serverTimestamp(),
      }, { merge: true });
      written++;
    }
    await batch.commit();
  }

  await credRef.set({
    lastSyncAt: FieldValue.serverTimestamp(),
    lastSyncEpoch: Math.floor(Date.now() / 1000),
    lastSyncError: null,
    lastSyncCount: written,
  }, { merge: true });
  return { ok: true, written, days: days || null };
}

async function scrapeCalendar(db, uid) {
  const credRef = db.collection('userData').doc(uid).collection('private').doc('calendarCredential');
  const credSnap = await credRef.get();
  if (!credSnap.exists) return { error: 'calendar-not-connected' };
  const cred = credSnap.data();
  if (!cred.refreshToken) return { error: 'no-refresh-token' };

  let { accessToken, accessTokenExpiresAt } = cred;
  if (!accessToken || !accessTokenExpiresAt || accessTokenExpiresAt < Date.now() + 60_000) {
    const refreshed = await refreshAccessToken(cred.refreshToken);
    accessToken = refreshed.accessToken;
    accessTokenExpiresAt = Date.now() + (refreshed.expiresIn - 60) * 1000;
    await credRef.set({ accessToken, accessTokenExpiresAt }, { merge: true });
  }

  const tMin = new Date(Date.now() - 7 * 86400_000).toISOString();
  const tMax = new Date(Date.now() + 365 * 86400_000).toISOString();
  const params = new URLSearchParams({
    timeMin: tMin, timeMax: tMax, maxResults: '250',
    singleEvents: 'true', orderBy: 'startTime',
  });
  const r = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + params.toString(),
    { headers: { Authorization: 'Bearer ' + accessToken } }
  );
  if (!r.ok) throw new Error('list failed (' + r.status + '): ' + await r.text());
  const j = await r.json();

  const archive = db.collection('userData').doc(uid).collection('calendarEvents');
  const events = j.items || [];
  let written = 0;
  for (let i = 0; i < events.length; i += 400) {
    const slice = events.slice(i, i + 400);
    const batch = db.batch();
    for (const ev of slice) {
      if (!ev.id) continue;
      if (ev.status === 'cancelled') { batch.delete(archive.doc(ev.id)); continue; }
      const start = ev.start && (ev.start.dateTime || ev.start.date);
      const end = ev.end && (ev.end.dateTime || ev.end.date);
      batch.set(archive.doc(ev.id), {
        id: ev.id, summary: ev.summary || '',
        description: ev.description || '', location: ev.location || '',
        organizer_email: (ev.organizer && ev.organizer.email) || '',
        start_at: start || '', end_at: end || '',
        all_day: !!(ev.start && ev.start.date && !ev.start.dateTime),
        attendees: (ev.attendees || []).map(a => ({
          email: a.email || '', name: a.displayName || '',
          responseStatus: a.responseStatus || '',
        })),
        recurring_event_id: ev.recurringEventId || '',
        html_link: ev.htmlLink || '',
        synced_at: FieldValue.serverTimestamp(),
      }, { merge: true });
      written++;
    }
    await batch.commit();
  }
  await credRef.set({
    lastSyncAt: FieldValue.serverTimestamp(),
    lastSyncEpoch: Math.floor(Date.now() / 1000),
    lastSyncError: null,
    lastSyncCount: written,
  }, { merge: true });
  return { ok: true, written };
}

const scrapeNow = onRequest(
  { secrets: [OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET], cors: false, timeoutSeconds: 540 },
  async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }
    let uid;
    try {
      const decoded = await getAuth().verifyIdToken(authHeader.slice('Bearer '.length));
      uid = decoded.uid;
    } catch (err) {
      res.status(401).json({ error: 'Invalid ID token: ' + err.message });
      return;
    }

    const { provider } = req.body || {};
    if (!provider || !['gmail', 'calendar', 'both'].includes(provider)) {
      res.status(400).json({ error: 'provider must be gmail, calendar, or both' });
      return;
    }

    // Optional gmail backfill window. A deliberate "go back N days" request
    // bypasses the rate limit (it's an intentional catch-up, not button thrash).
    let days = Number(req.body && req.body.days);
    days = (Number.isFinite(days) && days > 0) ? Math.min(Math.floor(days), 3650) : null;

    // Cheap rate limit via the credential doc's lastSyncAt timestamp.
    const db = getFirestore();
    const providers = provider === 'both' ? ['gmail', 'calendar'] : [provider];
    const out = {};
    for (const p of providers) {
      const isBackfill = p === 'gmail' && !!days;
      const credRef = db.collection('userData').doc(uid).collection('private')
        .doc(p + 'Credential');
      const cred = (await credRef.get()).data();
      if (!isBackfill && cred && cred.lastSyncAt && cred.lastSyncAt.toMillis &&
          (Date.now() - cred.lastSyncAt.toMillis()) < RATE_LIMIT_MS) {
        out[p] = { error: 'rate-limited', retry_after_ms: RATE_LIMIT_MS - (Date.now() - cred.lastSyncAt.toMillis()) };
        continue;
      }
      try {
        out[p] = p === 'gmail' ? await scrapeGmail(db, uid, days) : await scrapeCalendar(db, uid);
      } catch (err) {
        console.error('[scrape-now] failed for', p, uid, err);
        out[p] = { error: err.message };
      }
    }

    res.json({ ok: true, results: out });
  }
);

module.exports = { scrapeNow };
