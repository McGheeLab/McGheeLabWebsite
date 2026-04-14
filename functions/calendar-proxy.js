/* ================================================================
   calendarProxy — Server-side ICS fetch relay
   ================================================================
   Fetches a published calendar ICS URL server-side to bypass CORS
   restrictions. Returns the raw ICS text with permissive CORS headers.

   Used by apps/shared/calendar-service.js as the primary fetch strategy.

   Usage:
     GET /calendarProxy?url=https://outlook.office365.com/.../calendar.ics
   ================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const https = require('https');
const http = require('http');

const calendarProxy = onRequest({ cors: true, maxInstances: 5 }, async (req, res) => {
  // Only allow GET
  if (req.method !== 'GET') {
    res.status(405).send('Method not allowed');
    return;
  }

  const url = req.query.url;
  if (!url) {
    res.status(400).send('Missing ?url= parameter');
    return;
  }

  // Only allow calendar-related URLs (security: prevent open proxy abuse)
  const allowed = [
    'outlook.office365.com',
    'outlook.live.com',
    'calendar.google.com',
    'caldav.icloud.com',
    'p01-caldav.icloud.com',
    'p02-caldav.icloud.com',
    'p03-caldav.icloud.com',
    'p04-caldav.icloud.com',
    'p05-caldav.icloud.com',
    'p06-caldav.icloud.com',
  ];

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    res.status(400).send('Invalid URL');
    return;
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (!allowed.some(h => hostname === h || hostname.endsWith('.' + h))) {
    res.status(403).send('Domain not allowed — only calendar provider URLs are permitted');
    return;
  }

  // Auto-convert .html to .ics for Outlook published calendars
  let fetchUrl = url;
  if (fetchUrl.match(/\/calendar\.html$/i)) {
    fetchUrl = fetchUrl.replace(/\/calendar\.html$/i, '/calendar.ics');
  }

  try {
    const icsText = await fetchWithRedirects(fetchUrl, 5);

    if (!icsText.includes('BEGIN:VCALENDAR')) {
      res.status(422).send('Response is not a valid ICS file');
      return;
    }

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300'); // cache 5 min
    res.status(200).send(icsText);
  } catch (err) {
    console.error('[calendarProxy] Fetch error:', err.message);
    res.status(502).send('Failed to fetch calendar: ' + err.message);
  }
});

/** Fetch URL with redirect following (up to maxRedirects) */
function fetchWithRedirects(url, maxRedirects) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'McGheeLab-CalendarProxy/1.0' } }, (response) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        if (maxRedirects <= 0) {
          reject(new Error('Too many redirects'));
          return;
        }
        const redirectUrl = new URL(response.headers.location, url).href;
        fetchWithRedirects(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error('HTTP ' + response.statusCode));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      response.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

module.exports = { calendarProxy };
