/* ================================================================
   calendar-scraper.js — Phase 7: per-user Calendar scrape on schedule
   ================================================================
   Same shape as gmail-scraper.js. Pulls events from primary calendar
   and writes to userData/{uid}/calendarEvents/{eventId}.

   Scope:  https://www.googleapis.com/auth/calendar.readonly
   ================================================================ */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const OAUTH_CLIENT_ID = defineSecret('OAUTH_CLIENT_ID');
const OAUTH_CLIENT_SECRET = defineSecret('OAUTH_CLIENT_SECRET');

const WINDOW_DAYS_PAST = 7;
const WINDOW_DAYS_FUTURE = 365;

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

async function listEvents(accessToken, syncToken) {
  const tMin = new Date(Date.now() - WINDOW_DAYS_PAST * 86400_000).toISOString();
  const tMax = new Date(Date.now() + WINDOW_DAYS_FUTURE * 86400_000).toISOString();
  const events = [];
  let pageToken = null;
  let nextSyncToken = null;
  do {
    const params = new URLSearchParams({ maxResults: '250', singleEvents: 'true' });
    // Incremental sync via syncToken when available; otherwise time-windowed.
    if (syncToken && !pageToken) {
      params.set('syncToken', syncToken);
    } else {
      params.set('timeMin', tMin);
      params.set('timeMax', tMax);
      params.set('orderBy', 'startTime');
    }
    if (pageToken) params.set('pageToken', pageToken);
    const r = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + params.toString(),
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    if (!r.ok) {
      const text = await r.text();
      // 410 means syncToken expired; caller should retry without it.
      if (r.status === 410) {
        const e = new Error('sync-token-expired');
        e.code = 410;
        throw e;
      }
      throw new Error('events list failed (' + r.status + '): ' + text);
    }
    const j = await r.json();
    events.push(...(j.items || []));
    pageToken = j.nextPageToken || null;
    if (j.nextSyncToken) nextSyncToken = j.nextSyncToken;
  } while (pageToken);
  return { events, nextSyncToken };
}

async function scrapeOneUser(db, uid) {
  const credRef = db.collection('userData').doc(uid).collection('private').doc('calendarCredential');
  const credSnap = await credRef.get();
  if (!credSnap.exists) return { uid, skipped: 'no-credential' };
  const cred = credSnap.data();
  if (!cred.refreshToken) return { uid, skipped: 'no-refresh-token' };

  let { accessToken, accessTokenExpiresAt } = cred;
  if (!accessToken || !accessTokenExpiresAt || accessTokenExpiresAt < Date.now() + 60_000) {
    try {
      const refreshed = await refreshAccessToken(cred.refreshToken);
      accessToken = refreshed.accessToken;
      accessTokenExpiresAt = Date.now() + (refreshed.expiresIn - 60) * 1000;
      await credRef.set({ accessToken, accessTokenExpiresAt }, { merge: true });
    } catch (err) {
      await credRef.set({
        lastSyncAt: FieldValue.serverTimestamp(),
        lastSyncError: err.message,
        refreshTokenStored: false,
      }, { merge: true });
      return { uid, error: 'refresh-failed: ' + err.message };
    }
  }

  let result;
  try {
    result = await listEvents(accessToken, cred.calendarSyncToken || null);
  } catch (err) {
    if (err.code === 410) {
      // Sync token expired — drop it and let next run do a full window pull.
      await credRef.set({ calendarSyncToken: null }, { merge: true });
      return { uid, info: 'sync-token-expired-retry-next-run' };
    }
    await credRef.set({ lastSyncAt: FieldValue.serverTimestamp(), lastSyncError: err.message }, { merge: true });
    return { uid, error: 'list-failed: ' + err.message };
  }

  const archive = db.collection('userData').doc(uid).collection('calendarEvents');
  let written = 0;
  // Chunk writes at 400 ops per batch.
  for (let i = 0; i < result.events.length; i += 400) {
    const slice = result.events.slice(i, i + 400);
    const batch = db.batch();
    for (const ev of slice) {
      if (!ev.id) continue;
      // Cancelled events come back with status='cancelled' — delete locally.
      if (ev.status === 'cancelled') {
        batch.delete(archive.doc(ev.id));
        continue;
      }
      const start = ev.start && (ev.start.dateTime || ev.start.date);
      const end = ev.end && (ev.end.dateTime || ev.end.date);
      batch.set(archive.doc(ev.id), {
        id: ev.id,
        summary: ev.summary || '',
        description: ev.description || '',
        location: ev.location || '',
        organizer_email: (ev.organizer && ev.organizer.email) || '',
        start_at: start || '',
        end_at: end || '',
        all_day: !!(ev.start && ev.start.date && !ev.start.dateTime),
        attendees: (ev.attendees || []).map(a => ({
          email: a.email || '',
          name: a.displayName || '',
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
    calendarSyncToken: result.nextSyncToken || cred.calendarSyncToken || null,
  }, { merge: true });

  return { uid, written };
}

const scrapeCalendarForAllUsers = onSchedule(
  {
    schedule: 'every 30 minutes',
    timeZone: 'America/Phoenix',
    secrets: [OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET],
    memory: '512MiB',
    timeoutSeconds: 540,
  },
  async () => {
    const db = getFirestore();
    const credSnap = await db.collectionGroup('private')
      .where('provider', '==', 'calendar')
      .get();
    const results = [];
    for (const doc of credSnap.docs) {
      const uid = doc.ref.parent.parent.id;
      try {
        const r = await scrapeOneUser(db, uid);
        results.push(r);
      } catch (err) {
        results.push({ uid, error: 'unhandled: ' + err.message });
      }
    }
    console.log('[calendar-scrape] run complete', JSON.stringify(results));
  }
);

module.exports = { scrapeCalendarForAllUsers };
