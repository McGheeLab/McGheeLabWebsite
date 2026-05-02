/* oauth-connections.js — Phase 7: per-user Google OAuth for Gmail + Calendar.
 *
 * Renders a "Connections" panel on /pages/settings.html with two cards:
 *   • Gmail (gmail.readonly scope)
 *   • Google Calendar (calendar.readonly scope)
 *
 * Each card shows the current connection state, a "Connect" / "Disconnect"
 * button, and (when connected) when the last scrape ran.
 *
 * Auth flow uses Google Identity Services (GIS) Code Client model with PKCE.
 * Browser exchanges the auth code for a refresh token via a Cloud Function
 * (functions/gmail-oauth.js) so the client_secret never touches the browser.
 *
 * After consent, the Cloud Function stores the refresh token at:
 *   userData/{uid}/private/gmailCredential   ({ refreshToken, scopes, grantedAt })
 *   userData/{uid}/private/calendarCredential
 *
 * Firestore rules (see McGheeLabWebsite/firestore.rules) restrict that
 * subcollection to owner-only read/write — even the PI cannot read another
 * member's tokens via the client SDK. The Cloud Function reads via Admin SDK
 * (which is unrestricted by rules — that's how all CFs work).
 *
 * To use: drop a <div id="integrations-host"></div> into a page after this
 * script loads. The module will mount the panel into that host.
 */

(function () {
  // === CONFIG (replace with the OAuth Client ID from GCP console) ===
  // Web client created at console.cloud.google.com/apis/credentials in
  // mcgheelab-f56cc. Authorized JS origins must include the page origin
  // (mcgheelab.com, localhost:8000) and authorized redirect URIs the page URL.
  // The Client ID is a public identifier — safe to commit. The Client SECRET
  // (issued alongside it) lives in the Cloud Function config, never here.
  const GOOGLE_OAUTH_CLIENT_ID = '665438582202-fvv718tqb0vp0evk12nef56o266e16mt.apps.googleusercontent.com';

  // Cloud Function endpoint that exchanges auth-code → refresh token and
  // stores the credential under userData/{uid}/private/...
  // Region defaults to us-central1; set in functions/gmail-oauth.js.
  const OAUTH_EXCHANGE_URL = 'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/exchangeOAuthCode';
  const SCRAPE_NOW_URL = 'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/scrapeNow';
  const SCRAPE_ICS_NOW_URL = 'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/scrapeIcsNow';

  // Both Google scopes are granted in a single consent so the user picks ONE
  // Google account for Gmail + Calendar (instead of being prompted twice and
  // potentially mixing accounts). The exchange Cloud Function stores
  // gmailCredential AND calendarCredential when both scopes come back.
  const GOOGLE_SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.readonly',
  ].join(' ');

  const PROVIDERS = [
    {
      key: 'gmail',
      label: 'Gmail',
      description: 'Reads incoming mail to surface action items and classify lab activity.',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      docPath: 'gmailCredential',
    },
    {
      key: 'calendar',
      label: 'Google Calendar',
      description: 'Reads upcoming events to populate your dashboard and detect conflicts.',
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
      docPath: 'calendarCredential',
    },
  ];

  let _credentials = {};   // { gmail: doc|null, calendar: doc|null, outlook: doc|null }
  let _unsubs = [];

  function _host() { return document.getElementById('integrations-host'); }

  function _isConfigured() {
    return GOOGLE_OAUTH_CLIENT_ID && !GOOGLE_OAUTH_CLIENT_ID.startsWith('__');
  }

  function render() {
    const host = _host();
    if (!host) return;

    if (typeof firebridge === 'undefined' || !firebridge.getUser || !firebridge.getUser()) {
      host.innerHTML = '<div class="card" style="padding:16px;color:#6b7280;">' +
        'Sign in to manage Google integrations.</div>';
      return;
    }

    if (!_isConfigured()) {
      host.innerHTML = '<div class="card" style="padding:16px;color:#6b7280;">' +
        '<strong>Connections (Gmail + Calendar)</strong><br>' +
        'OAuth Client ID not configured yet — admin: see js/oauth-connections.js.' +
        '</div>';
      return;
    }

    let html = '<h2 style="font-size:16px;margin:0 0 12px;">Connections</h2>';
    html += '<div style="display:flex;flex-direction:column;gap:12px;max-width:680px;">';

    // Outlook ICS subscription — not OAuth, just a URL paste. Renders first
    // because it's the more common path for UArizona Outlook users.
    html += renderOutlookIcsCard();

    PROVIDERS.forEach(p => {
      const cred = _credentials[p.key];
      const connected = !!(cred && cred.refreshTokenStored);
      const lastSync = cred && cred.lastSyncAt
        ? new Date(cred.lastSyncAt.seconds ? cred.lastSyncAt.seconds * 1000 : cred.lastSyncAt).toLocaleString()
        : null;
      const statusChip = connected
        ? '<span class="chip chip-green">Connected</span>'
        : '<span class="chip chip-muted">Not connected</span>';
      const btnLabel = connected ? 'Disconnect' : 'Connect ' + p.label;
      const btnClass = connected ? 'btn' : 'btn btn-primary';
      const lastErr = cred && cred.lastSyncError;
      html += '<div class="card" style="padding:14px 16px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-weight:600;font-size:14px;">' + p.label + ' ' + statusChip + '</div>' +
            '<div style="font-size:13px;color:#6b7280;margin-top:2px;">' + p.description + '</div>' +
            (lastSync ? '<div style="font-size:11px;color:#9ca3af;margin-top:4px;">Last synced: ' + lastSync +
              (cred.lastSyncCount != null ? ' · ' + cred.lastSyncCount + ' new' : '') + '</div>' : '') +
            (lastErr ? '<div style="font-size:11px;color:#dc2626;margin-top:4px;">Last error: ' + lastErr + '</div>' : '') +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">' +
            (connected ? '<button class="btn btn-sm sync-btn" data-provider="' + p.key + '">Sync now</button>' : '') +
            '<button class="' + btnClass + ' oauth-btn" data-provider="' + p.key + '">' + btnLabel + '</button>' +
          '</div>' +
        '</div></div>';
    });
    html += '</div>';

    // Note about verification status
    html += '<div style="margin-top:16px;font-size:12px;color:#9ca3af;max-width:680px;">' +
      'Until Google completes OAuth verification (in progress), only listed test users in the ' +
      '<a href="https://console.cloud.google.com/apis/credentials/consent?project=mcgheelab-f56cc" target="_blank" rel="noopener">OAuth consent screen</a> ' +
      'can grant these scopes. Email mcgheealex@gmail.com to be added as a test user.' +
      '</div>';

    host.innerHTML = html;
    host.querySelectorAll('.oauth-btn').forEach(btn => {
      btn.addEventListener('click', () => onClickButton(btn.dataset.provider));
    });
    host.querySelectorAll('.sync-btn').forEach(btn => {
      btn.addEventListener('click', () => syncNow(btn.dataset.provider, btn));
    });
    wireOutlookIcsCard(host);
  }

  /* Outlook ICS card — paste a calendar share URL (.ics) and the Cloud
   * Function `scrapeIcsCalendars` will fetch + parse it on a 30-min schedule.
   * Distinct from Google Calendar OAuth: no popup, no scopes, no verification.
   * Stored at userData/{uid}/private/outlookCalendar = { provider: 'outlook',
   * icsUrl, lastSyncAt, ... }. Events land in the same calendarEvents
   * collection as Google Calendar so the Upcoming page renders both. */
  function renderOutlookIcsCard() {
    const cred = _credentials.outlook;
    const connected = !!(cred && cred.icsUrl);
    const lastSync = cred && cred.lastSyncAt
      ? new Date(cred.lastSyncAt.seconds ? cred.lastSyncAt.seconds * 1000 : cred.lastSyncAt).toLocaleString()
      : null;
    const lastErr = cred && cred.lastSyncError;
    const statusChip = connected
      ? '<span class="chip chip-green">Connected</span>'
      : '<span class="chip chip-muted">Not connected</span>';
    const escUrl = (cred && cred.icsUrl) ? String(cred.icsUrl).replace(/"/g, '&quot;') : '';

    let inner = '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-weight:600;font-size:14px;">Outlook (.ics) ' + statusChip + '</div>' +
        '<div style="font-size:13px;color:#6b7280;margin-top:2px;">' +
          'Paste your Outlook published-calendar URL (Outlook Web → Settings → Calendar → ' +
          'Shared calendars → Publish calendar → ICS link). Read-only — no Microsoft sign-in needed.' +
        '</div>' +
        (lastSync ? '<div style="font-size:11px;color:#9ca3af;margin-top:4px;">Last synced: ' + lastSync +
          (cred && cred.lastSyncCount != null ? ' · ' + cred.lastSyncCount + ' events' : '') + '</div>' : '') +
        (lastErr ? '<div style="font-size:11px;color:#dc2626;margin-top:4px;">Last error: ' + lastErr + '</div>' : '') +
      '</div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;margin-top:10px;">' +
      '<input id="ics-url-input" type="url" placeholder="https://outlook.office365.com/owa/calendar/.../calendar.ics" ' +
        'value="' + escUrl + '" style="flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius);font-size:12px;font-family:monospace;">' +
      (connected
        ? '<button class="btn btn-sm sync-btn" data-provider="outlook">Sync now</button>' +
          '<button class="btn btn-sm" id="ics-disconnect">Disconnect</button>'
        : '<button class="btn btn-primary btn-sm" id="ics-save">Save</button>') +
    '</div>';

    return '<div class="card" style="padding:14px 16px;">' + inner + '</div>';
  }

  function wireOutlookIcsCard(host) {
    const saveBtn = host.querySelector('#ics-save');
    if (saveBtn) saveBtn.addEventListener('click', saveIcsUrl);
    const dropBtn = host.querySelector('#ics-disconnect');
    if (dropBtn) dropBtn.addEventListener('click', disconnectIcs);
  }

  async function saveIcsUrl() {
    const input = document.getElementById('ics-url-input');
    const url = (input && input.value || '').trim();
    if (!url) {
      if (window.TOAST) TOAST.warn('Paste your Outlook ICS URL first.');
      return;
    }
    if (!/^https:\/\/[^\s]+\.ics(\?|$)/i.test(url)) {
      if (window.TOAST) TOAST.warn('That doesn\'t look like an .ics URL. Should end in .ics.');
      return;
    }
    const me = firebridge.getUser();
    if (!me) return;
    try {
      await firebridge.db()
        .collection('userData').doc(me.uid)
        .collection('private').doc('outlookCalendar')
        .set({
          provider: 'outlook',
          icsUrl: url,
          grantedAt: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      if (window.TOAST) TOAST.success('Outlook URL saved. First sync queued.');
      // Trigger an immediate scrape so the user sees data right away.
      try {
        const idToken = await me.getIdToken();
        await fetch(SCRAPE_ICS_NOW_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
          body: '{}',
        });
      } catch (_) { /* scrape-now is best-effort; the scheduled run will catch up */ }
    } catch (err) {
      console.error('[oauth] save ICS url failed', err);
      if (window.TOAST) TOAST.error('Failed to save ICS URL', { detail: err.message });
    }
  }

  async function disconnectIcs() {
    if (!confirm('Disconnect the Outlook calendar feed? Synced events will be cleared on the next scheduled run.')) return;
    const me = firebridge.getUser();
    if (!me) return;
    try {
      _credentials.outlook = null;
      render();
      await firebridge.db()
        .collection('userData').doc(me.uid)
        .collection('private').doc('outlookCalendar')
        .delete();
      if (window.TOAST) TOAST.success('Outlook disconnected.');
    } catch (err) {
      console.error('[oauth] ICS disconnect failed', err);
      if (window.TOAST) TOAST.error('Disconnect failed', { detail: err.message });
    }
  }

  async function syncNow(providerKey, btn) {
    // Outlook ICS goes through a separate Cloud Function (no OAuth refresh
    // tokens). Gmail + Calendar share scrapeNow.
    const isOutlook = providerKey === 'outlook';
    const provider = isOutlook
      ? { label: 'Outlook' }
      : PROVIDERS.find(p => p.key === providerKey);
    if (!provider) return;
    const me = firebridge.getUser();
    if (!me) return;
    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = 'Syncing…';
    try {
      const idToken = await me.getIdToken();
      const url = isOutlook ? SCRAPE_ICS_NOW_URL : SCRAPE_NOW_URL;
      const body = isOutlook ? '{}' : JSON.stringify({ provider: providerKey });
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
        body,
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`${r.status}: ${text}`);
      }
      const j = await r.json();
      // Two response shapes: scrapeNow → {results: {gmail|calendar: ...}}.
      // scrapeIcsNow → {result: {written}}.
      const result = isOutlook ? j.result : (j.results && j.results[providerKey]);
      if (result && result.error === 'rate-limited') {
        const secs = Math.ceil((result.retry_after_ms || 0) / 1000);
        if (window.TOAST) TOAST.warn(`Rate-limited — retry in ${secs}s.`);
      } else if (result && result.error) {
        if (window.TOAST) TOAST.error('Sync failed', { detail: result.error });
      } else if (result && (result.ok || result.written != null)) {
        const n = result.written != null ? result.written : 0;
        if (window.TOAST) TOAST.success(`${provider.label} synced (${n} events).`);
      } else {
        if (window.TOAST) TOAST.info(`${provider.label} sync ran.`);
      }
    } catch (err) {
      console.error('[oauth] syncNow failed', err);
      if (window.TOAST) TOAST.error('Sync failed', { detail: err.message });
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }

  function onClickButton(providerKey) {
    const provider = PROVIDERS.find(p => p.key === providerKey);
    if (!provider) return;
    const cred = _credentials[providerKey];
    const connected = !!(cred && cred.refreshTokenStored);
    if (connected) disconnect(provider);
    else connect(provider);
  }

  function connect(provider) {
    if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
      if (window.TOAST) TOAST.error('Google Identity SDK not loaded yet — try again in a moment.');
      return;
    }
    const me = firebridge.getUser();
    if (!me) return;
    // Always request BOTH Gmail and Calendar scopes in a single consent so
    // the user grants from ONE Google account — avoids the bug where Gmail
    // is connected to acct-A and Calendar to acct-B and they don't match.
    // Either provider's "Connect" button triggers the same combined flow.
    const codeClient = google.accounts.oauth2.initCodeClient({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      scope: GOOGLE_SCOPES,
      ux_mode: 'popup',
      state: 'google-combined',
      callback: async (response) => {
        if (response.error) {
          console.warn('[oauth] consent error', response);
          if (window.TOAST) TOAST.error('Consent failed: ' + (response.error_description || response.error));
          return;
        }
        if (window.TOAST) TOAST.info('Saving credentials…', { ttl: 1500 });
        try {
          const idToken = await firebridge.getUser().getIdToken();
          const r = await fetch(OAUTH_EXCHANGE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
            body: JSON.stringify({
              code: response.code,
              provider: 'google-combined',
              scope: GOOGLE_SCOPES,
              redirect_uri: 'postmessage',
            }),
          });
          if (!r.ok) {
            const text = await r.text();
            throw new Error('Exchange failed (' + r.status + '): ' + text);
          }
          await r.json();
          if (window.TOAST) TOAST.success('Google connected (Gmail + Calendar). First sync queued.');
        } catch (err) {
          console.error('[oauth] exchange failed', err);
          if (window.TOAST) TOAST.error('Failed to save credentials', { detail: err.message });
        }
      },
    });
    codeClient.requestCode();
  }

  async function disconnect(provider) {
    if (!confirm('Disconnect ' + provider.label + '? Synced data older than 30 days will be deleted.')) return;
    const me = firebridge.getUser();
    if (!me) return;
    try {
      // Optimistic: clear local state, fire delete in background.
      _credentials[provider.key] = null;
      render();
      await firebridge.db()
        .collection('userData').doc(me.uid)
        .collection('private').doc(provider.docPath)
        .delete();
      if (window.TOAST) TOAST.success(provider.label + ' disconnected.');
    } catch (err) {
      console.error('[oauth] disconnect failed', err);
      if (window.TOAST) TOAST.error('Disconnect failed', { detail: err.message });
    }
  }

  function attachListeners() {
    if (typeof firebridge === 'undefined' || !firebridge.db) return;
    const me = firebridge.getUser && firebridge.getUser();
    if (!me) return;
    _unsubs.forEach(u => { try { u(); } catch {} });
    _unsubs = [];

    // Subscribe to each Google credential doc (gmail + calendar) AND the
    // outlook ICS doc. All three live under userData/{uid}/private/.
    const watch = [
      ...PROVIDERS.map(p => ({ key: p.key, doc: p.docPath })),
      { key: 'outlook', doc: 'outlookCalendar' },
    ];
    watch.forEach(w => {
      try {
        const unsub = firebridge.db()
          .collection('userData').doc(me.uid)
          .collection('private').doc(w.doc)
          .onSnapshot(snap => {
            _credentials[w.key] = snap.exists ? snap.data() : null;
            render();
          }, err => {
            // Permission errors before the doc exists are normal — Firestore
            // doesn't grant read on a non-existent doc unless rules say so.
            // We treat any error as "not connected" and quietly fall through.
            _credentials[w.key] = null;
            render();
          });
        _unsubs.push(unsub);
      } catch (err) {
        console.warn('[oauth] listener attach failed for', w.key, err.message);
      }
    });
  }

  // Boot
  document.addEventListener('DOMContentLoaded', async () => {
    if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
      try { await firebridge.whenAuthResolved(); } catch (_) {}
    }
    render();
    attachListeners();
  });

  // Expose for console debugging
  window.OAUTH_CONNECTIONS = { render, _credentials };
})();
