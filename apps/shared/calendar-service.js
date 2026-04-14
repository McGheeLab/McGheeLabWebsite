/* ================================================================
   calendar-service.js — Shared calendar integration for all lab apps
   ================================================================
   Manages multi-provider calendar integration (Google, Outlook, Apple/ICS).
   Loaded in each app via <script defer>. Exposes McgheeLab.CalendarService.

   Config is persisted in Firestore userSettings/{uid}.calendar.
   OAuth tokens are session-lived (sessionStorage).
   ICS URLs are fetched on load and on auto-refresh timer.
   ================================================================ */

window.McgheeLab = window.McgheeLab || {};

McgheeLab.CalendarService = (() => {
  'use strict';

  /* ─── State ──────────────────────────────────────────────── */
  let _config = null;         // persisted calendar config from Firestore
  let _user = null;           // Firebase auth user
  let _events = [];           // all normalized events (all providers, all dates)
  let _gapiLoaded = false;
  let _msalLoaded = false;
  let _gcalToken = null;      // Google OAuth2 access token (session-lived)
  let _msalToken = null;      // Microsoft Graph access token (session-lived)
  let _refreshTimer = null;
  let _initialized = false;
  let _listeners = [];        // onChange callbacks
  let _toastFn = null;        // optional toast callback
  let _dismissedIds = new Set(); // event IDs the user has dismissed
  let _eventStatuses = {};       // eventId → 'unavailable' | 'busy-available'

  const GCAL_SCOPES = 'https://www.googleapis.com/auth/calendar.readonly';
  const MSAL_SCOPES = ['Calendars.Read'];
  const SESSION_KEY_GCAL = 'mcgheelab_cal_gcal_token';
  const SESSION_KEY_MSAL = 'mcgheelab_cal_msal_token';

  /* ─── Helpers ────────────────────────────────────────────── */
  function db() {
    return McgheeLab.db || firebase.firestore();
  }

  function toast(msg, type) {
    if (_toastFn) _toastFn(msg, type);
    else console.log('[CalendarService]', msg);
  }

  function localDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /* ─── Config Persistence ─────────────────────────────────── */
  function getDefaultConfig() {
    return {
      gcalClientId: '',
      msalClientId: '',
      outlookIcsUrl: '',
      icsUrl: '',
      autoRefreshMinutes: 60,
      enabledProviders: [],
      huddle: { autoBlock: false }
    };
  }

  async function loadConfig() {
    try {
      const doc = await db().collection('userSettings').doc(_user.uid).get();
      const data = doc.exists ? doc.data() : {};
      _config = { ...getDefaultConfig(), ...(data.calendar || {}) };
    } catch {
      _config = getDefaultConfig();
    }
  }

  async function saveConfig(updates) {
    _config = { ..._config, ...updates };
    try {
      await db().collection('userSettings').doc(_user.uid).set(
        { calendar: _config },
        { merge: true }
      );
    } catch (err) {
      console.warn('[CalendarService] saveConfig error:', err);
    }
    _notify();
  }

  /* ─── Initialization ─────────────────────────────────────── */
  async function init(user, opts) {
    if (_initialized && _user?.uid === user?.uid) return;
    _user = user;
    _toastFn = opts?.toast || null;

    await loadConfig();
    restoreSessions();

    // Load dismissed event IDs and per-event statuses
    _dismissedIds = new Set(_config.dismissedEventIds || []);
    _eventStatuses = _config.eventStatuses || {};

    // Auto-fetch saved ICS URLs (await so initial render has data)
    const fetchPromises = [];
    if (_config.icsUrl) fetchPromises.push(fetchICSFromUrl(_config.icsUrl, 'ics').catch(() => {}));
    if (_config.outlookIcsUrl) fetchPromises.push(fetchICSFromUrl(_config.outlookIcsUrl, 'outlook_ics').catch(() => {}));
    if (fetchPromises.length) await Promise.all(fetchPromises);

    startAutoRefresh(_config.autoRefreshMinutes);
    _initialized = true;
  }

  function restoreSessions() {
    const savedGcal = sessionStorage.getItem(SESSION_KEY_GCAL);
    if (savedGcal) _gcalToken = savedGcal;
    const savedMsal = sessionStorage.getItem(SESSION_KEY_MSAL);
    if (savedMsal) _msalToken = savedMsal;
  }

  /* ─── Auto-Refresh ───────────────────────────────────────── */
  function startAutoRefresh(intervalMinutes) {
    if (_refreshTimer) clearInterval(_refreshTimer);
    if (!intervalMinutes || intervalMinutes <= 0) return;
    _refreshTimer = setInterval(async () => {
      await fetchAll();
    }, intervalMinutes * 60 * 1000);
  }

  /* ─── Event Normalization ────────────────────────────────── */
  function normalizeEvent(raw, provider) {
    if (provider === 'google') {
      const start = raw.start?.dateTime || raw.start?.date || '';
      const end = raw.end?.dateTime || raw.end?.date || '';
      const startDate = start ? localDateStr(new Date(start)) : '';
      return {
        id: 'g_' + raw.id,
        title: raw.summary || 'Untitled',
        date: startDate,
        startTime: start ? new Date(start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '',
        endTime: end ? new Date(end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '',
        startISO: start,
        endISO: end,
        duration: (start && end) ? Math.round((new Date(end) - new Date(start)) / 60000) : null,
        provider: 'google'
      };
    }
    if (provider === 'outlook') {
      const start = raw.start?.dateTime ? raw.start.dateTime + 'Z' : '';
      const end = raw.end?.dateTime ? raw.end.dateTime + 'Z' : '';
      const startDate = start ? localDateStr(new Date(start)) : '';
      return {
        id: 'o_' + raw.id,
        title: raw.subject || 'Untitled',
        date: startDate,
        startTime: start ? new Date(start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '',
        endTime: end ? new Date(end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '',
        startISO: start,
        endISO: end,
        duration: (start && end) ? Math.round((new Date(end) - new Date(start)) / 60000) : null,
        provider: 'outlook'
      };
    }
    // ICS event (already parsed)
    return { ...raw, provider: raw.provider || 'ics' };
  }

  /* ─── ICS Parsing ────────────────────────────────────────── */
  function parseICSDate(str) {
    if (!str) return null;
    const digits = str.replace(/[^0-9]/g, '');
    if (digits.length >= 14) {
      const y = digits.slice(0, 4), mo = digits.slice(4, 6), d = digits.slice(6, 8);
      const h = digits.slice(8, 10), mi = digits.slice(10, 12), s = digits.slice(12, 14);
      if (str.endsWith('Z')) {
        return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
      }
      return new Date(+y, +mo - 1, +d, +h, +mi, +s);
    }
    if (digits.length >= 8) {
      const y = digits.slice(0, 4), mo = digits.slice(4, 6), d = digits.slice(6, 8);
      return new Date(+y, +mo - 1, +d, 0, 0, 0);
    }
    return null;
  }

  function parseICS(text) {
    const events = [];
    const blocks = text.split('BEGIN:VEVENT');
    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i].split('END:VEVENT')[0];
      const get = (key) => {
        const rx = new RegExp('^' + key + '(?:;[^:]*)?:(.+)$', 'mi');
        const m = block.match(rx);
        return m ? m[1].trim() : '';
      };
      const uid = get('UID') || ('ics_' + i + '_' + Date.now());
      const summary = get('SUMMARY') || 'Untitled';
      const dtstart = parseICSDate(get('DTSTART'));
      const dtend = parseICSDate(get('DTEND'));
      if (!dtstart) continue;
      const startDate = localDateStr(dtstart);
      const duration = (dtstart && dtend) ? Math.round((dtend - dtstart) / 60000) : null;
      events.push({
        id: 'ics_' + uid.replace(/[^a-zA-Z0-9_-]/g, '_'),
        title: summary.replace(/\\,/g, ',').replace(/\\n/g, ' ').replace(/\\;/g, ';'),
        date: startDate,
        startTime: dtstart.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        endTime: dtend ? dtend.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '',
        duration,
        provider: 'ics'
      });
    }
    return events;
  }

  function mergeICSEvents(icsEvents, provider) {
    provider = provider || 'ics';
    _events = _events.filter(e => e.provider !== provider);
    icsEvents.forEach(e => { e.provider = provider; });
    _events.push(...icsEvents);
    _notify();
  }

  /** Normalize a calendar URL — auto-convert .html to .ics for Outlook published calendars */
  function normalizeCalendarUrl(url) {
    if (!url) return url;
    // Outlook published calendars have both .html and .ics variants at the same path
    if (url.match(/outlook\.office365\.com.*\/calendar\.html$/i)) {
      return url.replace(/\/calendar\.html$/i, '/calendar.ics');
    }
    return url;
  }

  async function fetchICSFromUrl(url, provider) {
    provider = provider || 'ics';
    // Auto-convert HTML calendar URLs to ICS
    const icsUrl = normalizeCalendarUrl(url);

    // Build fetch strategy list
    const strategies = [
      // 1. Firebase Cloud Function proxy (most reliable — no CORS issues)
      () => fetch('https://us-central1-mcgheelab-f56cc.cloudfunctions.net/calendarProxy?url=' + encodeURIComponent(icsUrl)),
      // 2. Direct fetch (works if server sends CORS headers)
      () => fetch(icsUrl),
      // 3. corsproxy.io
      () => fetch('https://corsproxy.io/?' + encodeURIComponent(icsUrl)),
      // 4. allorigins
      () => fetch('https://api.allorigins.win/raw?url=' + encodeURIComponent(icsUrl)),
    ];
    let lastErr = null;
    for (let i = 0; i < strategies.length; i++) {
      try {
        const res = await strategies[i]();
        if (!res.ok) { lastErr = new Error('HTTP ' + res.status); continue; }
        const text = await res.text();
        if (!text.includes('BEGIN:VCALENDAR')) { lastErr = new Error('Not a valid ICS file'); continue; }
        const events = parseICS(text);
        mergeICSEvents(events, provider);
        return { count: events.length };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('All fetch strategies failed — try importing the .ics file directly');
  }

  /* ─── Provider: Google Calendar ──────────────────────────── */
  async function loadGoogleIdentityServices() {
    if (_gapiLoaded) return;
    return new Promise((resolve, reject) => {
      if (window.google?.accounts?.oauth2) { _gapiLoaded = true; resolve(); return; }
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.onload = () => { _gapiLoaded = true; resolve(); };
      script.onerror = () => reject(new Error('Failed to load Google Identity Services'));
      document.head.appendChild(script);
    });
  }

  async function connectGoogle(clientId) {
    if (clientId) {
      await saveConfig({ gcalClientId: clientId });
    }
    const cid = clientId || _config.gcalClientId;
    if (!cid) throw new Error('No Google OAuth Client ID configured');

    await loadGoogleIdentityServices();
    return new Promise((resolve, reject) => {
      const tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: cid,
        scope: GCAL_SCOPES,
        callback: async (response) => {
          if (response.access_token) {
            _gcalToken = response.access_token;
            sessionStorage.setItem(SESSION_KEY_GCAL, response.access_token);
            await fetchAll();
            resolve();
          } else {
            reject(new Error('No access token received'));
          }
        }
      });
      tokenClient.requestAccessToken({ prompt: 'consent' });
    });
  }

  function disconnectGoogle() {
    _gcalToken = null;
    sessionStorage.removeItem(SESSION_KEY_GCAL);
    _events = _events.filter(e => e.provider !== 'google');
    _notify();
  }

  async function fetchGoogleEvents(dateStr) {
    if (!_gcalToken) return [];
    const timeMin = new Date(dateStr + 'T00:00:00').toISOString();
    const timeMax = new Date(dateStr + 'T23:59:59').toISOString();
    try {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=50`,
        { headers: { Authorization: 'Bearer ' + _gcalToken } }
      );
      if (res.status === 401) {
        _gcalToken = null;
        sessionStorage.removeItem(SESSION_KEY_GCAL);
        toast('Google Calendar session expired — reconnect.', 'error');
        return [];
      }
      const data = await res.json();
      return (data.items || []).filter(ev => ev.status !== 'cancelled').map(ev => normalizeEvent(ev, 'google'));
    } catch (err) {
      console.warn('[CalendarService] Google fetch error:', err);
      return [];
    }
  }

  /* ─── Provider: Outlook / Microsoft Graph ────────────────── */
  async function loadMSAL() {
    if (_msalLoaded) return;
    return new Promise((resolve, reject) => {
      if (window.msal?.PublicClientApplication) { _msalLoaded = true; resolve(); return; }
      const script = document.createElement('script');
      script.src = 'https://alcdn.msauth.net/browser/2.38.0/js/msal-browser.min.js';
      script.onload = () => { _msalLoaded = true; resolve(); };
      script.onerror = () => reject(new Error('Failed to load MSAL'));
      document.head.appendChild(script);
    });
  }

  async function connectOutlook(clientId) {
    if (clientId) {
      await saveConfig({ msalClientId: clientId });
    }
    const cid = clientId || _config.msalClientId;
    if (!cid) throw new Error('No Azure App ID configured');

    await loadMSAL();
    const msalApp = new msal.PublicClientApplication({
      auth: { clientId: cid, redirectUri: window.location.origin + window.location.pathname }
    });
    await msalApp.initialize();
    const loginResp = await msalApp.loginPopup({ scopes: MSAL_SCOPES });
    const tokenResp = await msalApp.acquireTokenSilent({
      scopes: MSAL_SCOPES, account: loginResp.account
    });
    _msalToken = tokenResp.accessToken;
    sessionStorage.setItem(SESSION_KEY_MSAL, _msalToken);
    await fetchAll();
  }

  function disconnectOutlook() {
    _msalToken = null;
    sessionStorage.removeItem(SESSION_KEY_MSAL);
    _events = _events.filter(e => e.provider !== 'outlook');
    _notify();
  }

  async function fetchOutlookEvents(dateStr) {
    if (!_msalToken) return [];
    const startDate = dateStr + 'T00:00:00';
    const endDate = dateStr + 'T23:59:59';
    try {
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/me/calendarview?startDateTime=${encodeURIComponent(startDate)}&endDateTime=${encodeURIComponent(endDate)}&$top=50&$select=id,subject,start,end,isCancelled&$orderby=start/dateTime`,
        { headers: { Authorization: 'Bearer ' + _msalToken } }
      );
      if (res.status === 401) {
        _msalToken = null;
        sessionStorage.removeItem(SESSION_KEY_MSAL);
        toast('Outlook session expired — reconnect.', 'error');
        return [];
      }
      const data = await res.json();
      return (data.value || []).filter(ev => !ev.isCancelled).map(ev => normalizeEvent(ev, 'outlook'));
    } catch (err) {
      console.warn('[CalendarService] Outlook fetch error:', err);
      return [];
    }
  }

  /* ─── ICS File Import ────────────────────────────────────── */
  async function importICSFile(file, provider) {
    const text = await file.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Not a valid .ics file');
    const events = parseICS(text);
    mergeICSEvents(events, provider || 'ics');
    return { count: events.length };
  }

  /* ─── Fetch All Providers ────────────────────────────────── */
  async function fetchAll(dateStr) {
    // If no date specified, fetch for today
    const d = dateStr || localDateStr(new Date());
    const [gEvents, oEvents] = await Promise.all([
      fetchGoogleEvents(d),
      fetchOutlookEvents(d)
    ]);

    // Remove old API-fetched events for this date, keep ICS events
    _events = _events.filter(e => e.provider !== 'google' && e.provider !== 'outlook');
    _events.push(...gEvents, ...oEvents);
    _events.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    _notify();
  }

  /* ─── Query ──────────────────────────────────────────────── */
  function getEventsForDate(dateStr) {
    return _events.filter(e => e.date === dateStr && !_dismissedIds.has(e.id));
  }

  function getAllEventsForDate(dateStr) {
    // Includes dismissed events (for "restore" UI)
    return _events.filter(e => e.date === dateStr);
  }

  function getAllEvents() {
    return [..._events];
  }

  function isConnected() {
    return {
      google: !!_gcalToken,
      outlook: !!_msalToken,
      ics: !!_config?.icsUrl || _events.some(e => e.provider === 'ics'),
      outlookIcs: _events.some(e => e.provider === 'outlook_ics')
    };
  }

  function getConfig() {
    return _config ? { ..._config } : getDefaultConfig();
  }

  /* ─── Listeners ──────────────────────────────────────────── */
  function onChange(callback) {
    _listeners.push(callback);
    return () => { _listeners = _listeners.filter(fn => fn !== callback); };
  }

  function _notify() {
    _listeners.forEach(fn => {
      try { fn(_events); } catch (e) { console.warn('[CalendarService] listener error:', e); }
    });
  }

  /* ─── Event Dismissal ─────────────────────────────────────── */
  async function dismissEvent(eventId) {
    _dismissedIds.add(eventId);
    await saveConfig({ dismissedEventIds: Array.from(_dismissedIds) });
    _notify();
  }

  async function restoreDismissed() {
    _dismissedIds.clear();
    await saveConfig({ dismissedEventIds: [] });
    _notify();
  }

  function getDismissedCount() {
    return _dismissedIds.size;
  }

  function isDismissed(eventId) {
    return _dismissedIds.has(eventId);
  }

  /* ─── Event Status (unavailable vs busy-available) ────────── */
  async function setEventStatus(eventId, status) {
    // status: 'unavailable' (default, blocks availability) or 'busy-available' (darker available)
    if (status === 'unavailable') {
      delete _eventStatuses[eventId]; // default, no need to store
    } else {
      _eventStatuses[eventId] = status;
    }
    await saveConfig({ eventStatuses: { ..._eventStatuses } });
    _notify();
  }

  function getEventStatus(eventId) {
    return _eventStatuses[eventId] || 'unavailable';
  }

  /* ─── Clear Providers ────────────────────────────────────── */
  function clearProvider(provider) {
    _events = _events.filter(e => e.provider !== provider);
    _notify();
  }

  /* ─── Public API ─────────────────────────────────────────── */
  return {
    init,
    getConfig,
    saveConfig,
    getEventsForDate,
    getAllEventsForDate,
    getAllEvents,
    fetchAll,
    importICSFile,
    connectGoogle,
    disconnectGoogle,
    connectOutlook,
    disconnectOutlook,
    onChange,
    isConnected,
    clearProvider,
    parseICS,
    mergeICSEvents,
    fetchICSFromUrl,
    startAutoRefresh,
    dismissEvent,
    restoreDismissed,
    getDismissedCount,
    isDismissed,
    setEventStatus,
    getEventStatus
  };
})();
