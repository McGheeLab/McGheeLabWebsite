/* ================================================================
   ics-scraper.js — Phase 7.5: ICS calendar subscription scrape
   ================================================================
   For users on Outlook (or any system that publishes a calendar
   share URL), we don't need OAuth — they paste the .ics URL into
   RM Settings → Connections, and a scheduled function fetches it
   every 30 minutes, parses VEVENT blocks, and writes events to
   userData/{uid}/calendarEvents/{eventId}.

   The same collection holds Google Calendar events from the OAuth
   scraper, distinguished by the `source` field.

   ICS URLs are themselves a "secret share link" — anyone with the
   URL can read the calendar — so we store them in the user's
   private subcollection (rules permit owner-only read).

   Setup:
     firebase deploy --only functions:scrapeIcsCalendars,functions:scrapeIcsNow
   ================================================================ */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const ALLOWED_ORIGINS = [
  'https://mcgheelab.com',
  'https://www.mcgheelab.com',
  'http://localhost:8000',
];

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Max-Age', '3600');
}

/* Minimal ICS parser — handles VEVENT blocks with the fields we need
 * (DTSTART, DTEND, SUMMARY, LOCATION, DESCRIPTION, UID, ORGANIZER, RRULE).
 * Doesn't expand recurring events — single instances only. Outlook's
 * published feed already pre-expands occurrences inside a window, so
 * this is sufficient for typical use.
 *
 * Returns array of { id, summary, start_at, end_at, all_day, location,
 * description, organizer_email, recurring_event_id, html_link }.
 */
function parseIcs(text) {
  // Unfold lines (RFC 5545 §3.1: continuation lines start with whitespace).
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);

  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;

    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const left = line.slice(0, colon);
    const value = line.slice(colon + 1);
    // Property name may have parameters separated by ';'
    const semi = left.indexOf(';');
    const prop = (semi < 0 ? left : left.slice(0, semi)).toUpperCase();
    const params = {};
    if (semi >= 0) {
      for (const part of left.slice(semi + 1).split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
      }
    }

    if (prop === 'UID') cur.uid = value;
    else if (prop === 'SUMMARY') cur.summary = unescapeText(value);
    else if (prop === 'LOCATION') cur.location = unescapeText(value);
    else if (prop === 'DESCRIPTION') cur.description = unescapeText(value);
    else if (prop === 'DTSTART') {
      cur.start_raw = value;
      cur.start_iso = icsDateToIso(value, params);
      cur.all_day = (params.VALUE === 'DATE') || /^\d{8}$/.test(value);
    }
    else if (prop === 'DTEND') {
      cur.end_iso = icsDateToIso(value, params);
    }
    else if (prop === 'ORGANIZER') {
      // ORGANIZER;CN=Alex McGhee:mailto:alex@example.com
      const m = value.match(/^mailto:(.+)$/i);
      cur.organizer_email = m ? m[1] : value;
    }
    else if (prop === 'URL') cur.html_link = value;
    else if (prop === 'RECURRENCE-ID') cur.recurring_event_id = value;
    else if (prop === 'STATUS') cur.status = value.toLowerCase();
  }
  return events;
}

function unescapeText(s) {
  return String(s || '')
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function icsDateToIso(s, params) {
  if (!s) return '';
  // YYYYMMDD            (date only — all-day)
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  }
  // YYYYMMDDTHHMMSSZ    (UTC)              → emit ...Z
  // YYYYMMDDTHHMMSS     with TZID param    → parse against TZID and emit -07:00 etc
  // YYYYMMDDTHHMMSS     no params, no Z    → floating local; emit naked ISO so JS
  //                                          Date treats it as the browser's local zone.
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (m) {
    const [, y, mo, d, h, mn, sec, z] = m;
    const naive = `${y}-${mo}-${d}T${h}:${mn}:${sec}`;
    if (z === 'Z') return naive + 'Z';
    if (params && params.TZID) {
      // Resolve TZID → UTC offset using Intl.DateTimeFormat. This handles
      // "US Mountain Standard Time" and the IANA-style names Outlook publishes.
      const offset = tzOffsetMinutes(params.TZID, y, mo, d, h, mn);
      if (offset != null) {
        // Phoenix returns offset = -420 (local is 7h behind UTC) → ISO "-07:00".
        const sign = offset >= 0 ? '+' : '-';
        const abs = Math.abs(offset);
        const oh = String(Math.floor(abs / 60)).padStart(2, '0');
        const om = String(abs % 60).padStart(2, '0');
        return naive + sign + oh + ':' + om;
      }
    }
    // Floating local — return without timezone so JS Date treats it as local.
    return naive;
  }
  return s;
}

// Map common Outlook/Microsoft TZID strings to IANA names. Outlook publishes
// "Pacific Standard Time", "Eastern Standard Time", etc. — these are not IANA
// names. Also accept IANA names directly so other clients keep working.
const TZID_TO_IANA = {
  'pacific standard time': 'America/Los_Angeles',
  'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix',
  'central standard time': 'America/Chicago',
  'eastern standard time': 'America/New_York',
  'gmt standard time': 'Europe/London',
  'utc': 'UTC',
};

function tzOffsetMinutes(tzid, y, mo, d, h, mn) {
  if (!tzid) return null;
  const lower = tzid.toLowerCase().replace(/^"|"$/g, '');
  const iana = TZID_TO_IANA[lower] || tzid.replace(/^"|"$/g, '');
  try {
    // Use Intl to format the wall-clock time in `iana` and compute offset.
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mn, 0));
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: iana, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = fmt.formatToParts(dt).reduce((a, p) => (a[p.type] = p.value, a), {});
    const inTz = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
                          +parts.hour, +parts.minute, +parts.second);
    return Math.round((inTz - dt.getTime()) / 60000);
  } catch (err) {
    return null;
  }
}

async function scrapeOneUser(db, uid) {
  const credRef = db.collection('userData').doc(uid).collection('private').doc('outlookCalendar');
  const credSnap = await credRef.get();
  if (!credSnap.exists) return { uid, skipped: 'no-credential' };
  const cred = credSnap.data();
  if (!cred.icsUrl) return { uid, skipped: 'no-url' };

  let text;
  try {
    const r = await fetch(cred.icsUrl, {
      headers: { 'User-Agent': 'McGheeLabRM/1.0 (mcgheealex@gmail.com)' },
    });
    if (!r.ok) throw new Error('fetch failed (' + r.status + ')');
    text = await r.text();
  } catch (err) {
    await credRef.set({
      lastSyncAt: FieldValue.serverTimestamp(),
      lastSyncError: err.message,
    }, { merge: true });
    return { uid, error: 'fetch-failed: ' + err.message };
  }

  let events;
  try {
    events = parseIcs(text);
  } catch (err) {
    await credRef.set({
      lastSyncAt: FieldValue.serverTimestamp(),
      lastSyncError: 'parse: ' + err.message,
    }, { merge: true });
    return { uid, error: 'parse-failed: ' + err.message };
  }

  const archive = db.collection('userData').doc(uid).collection('calendarEvents');
  let written = 0;
  // Drop events outside a sensible window (2 years past, 2 years future) to
  // keep the per-user collection bounded.
  const lo = new Date(Date.now() - 730 * 86400_000).toISOString();
  const hi = new Date(Date.now() + 730 * 86400_000).toISOString();
  for (let i = 0; i < events.length; i += 400) {
    const slice = events.slice(i, i + 400);
    const batch = db.batch();
    for (const ev of slice) {
      const id = ev.uid;
      if (!id) continue;
      const start = ev.start_iso || '';
      if (start && (start < lo || start > hi)) continue;
      // Stamp the doc id with the source prefix so ICS events can't collide
      // with Google Calendar event ids in the same collection.
      const docId = 'ics-' + id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200);
      if (ev.status === 'cancelled') {
        batch.delete(archive.doc(docId));
        continue;
      }
      batch.set(archive.doc(docId), {
        id: docId,
        source: 'ics',
        summary: ev.summary || '',
        description: ev.description || '',
        location: ev.location || '',
        organizer_email: ev.organizer_email || '',
        start_at: start,
        end_at: ev.end_iso || '',
        all_day: !!ev.all_day,
        attendees: [],
        recurring_event_id: ev.recurring_event_id || '',
        html_link: ev.html_link || '',
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
  return { uid, written };
}

const scrapeIcsCalendars = onSchedule(
  {
    schedule: 'every 30 minutes',
    timeZone: 'America/Phoenix',
    memory: '512MiB',
    timeoutSeconds: 540,
  },
  async () => {
    const db = getFirestore();
    const credSnap = await db.collectionGroup('private')
      .where('provider', '==', 'outlook')
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
    console.log('[ics-scrape] run complete', JSON.stringify(results));
  }
);

/* On-demand scrape, called by the Settings → "Sync now" button. */
const scrapeIcsNow = onRequest(
  { cors: false, timeoutSeconds: 540 },
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

    try {
      const db = getFirestore();
      const r = await scrapeOneUser(db, uid);
      res.json({ ok: true, result: r });
    } catch (err) {
      console.error('[scrapeIcsNow] failed for', uid, err);
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = { scrapeIcsCalendars, scrapeIcsNow };
