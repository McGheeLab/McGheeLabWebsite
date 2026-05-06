/* settings.js — manage own profile, notifications, and connections.
 *
 * V3.48 added Profile + Notifications tabs at the front of the existing
 * connection-registry page, replacing the corresponding sections of
 * /apps/settings/. The Calendar Integration section + admin diagnostics
 * are deferred to V3.51 alongside the equipment OAuth refactor (the
 * standalone /apps/settings/ URL still resolves until then for users
 * who need those).
 *
 * Data layout:
 *   - Profile  → users/{uid}: { name, bio, shareActivity }
 *   - Notif.   → userSettings/{uid}: {
 *                   notifications: {
 *                     enabled, quietHours: { enabled, start, end },
 *                     apps: { chat, meetings, equipment, huddle,
 *                             scheduler, activityTracker } { push }
 *                   }
 *                 }
 *   - Conns    → settings/connections.json (existing user-scope route)
 *
 * Surgical Firestore writes via firebridge.db() (matches the V3.41
 * meetings + V3.44 procurement patterns). The connection registry path
 * still uses api.load / api.save through the existing route. */

const CONNECTION_FIELDS = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'type', label: 'Type', type: 'select', options: ['email', 'calendar', 'repository', 'messaging', 'finance', 'other'] },
  { key: 'provider', label: 'Provider', type: 'text', placeholder: 'e.g. Google, Microsoft 365, GitHub' },
  { key: 'account', label: 'Account / Username', type: 'text' },
  { key: 'forward_to', label: 'Forward To', type: 'text', placeholder: 'e.g. forwarding address' },
  { key: 'status', label: 'Status', type: 'select', options: ['active', 'not_connected', 'error', 'disabled'] },
  { key: 'notes', label: 'Notes', type: 'textarea' },
];

const DATA_PATH = 'settings/connections.json';
var _settSortKey = null;
var _settSortDir = 'asc';
var CONN_COLUMNS = [
  { label: 'Name', key: 'name' },
  { label: 'Type', key: 'type' },
  { label: 'Provider', key: 'provider' },
  { label: 'Account', key: 'account' },
  { label: 'Forward To', key: 'forward_to' },
  { label: 'Status', key: 'status' },
  { label: 'Notes', key: 'notes' },
  { label: 'Actions', key: null },
];

const TABS = [
  { key: 'profile',       label: 'Profile' },
  { key: 'notifications', label: 'Notifications' },
  // V3.54 — Calendar Sync (Google + Outlook + Apple ICS imports via the
  // /rm/js/calendar-service.js singleton brought into RM in V3.51). Tab
  // key `cal-sync` rather than `calendar` to avoid colliding with the
  // existing connection-registry filter below that filters on
  // connections.type === 'calendar'.
  { key: 'cal-sync',      label: 'Calendar Sync' },
  { key: 'all',           label: 'All Connections' },
  { key: 'email',         label: 'Email' },
  { key: 'calendar',      label: 'Calendars' },
  { key: 'repository',    label: 'Repositories' },
  { key: 'messaging',     label: 'Messaging' },
  { key: 'finance',       label: 'Finance' },
];

let activeTab = 'profile';

function _isConnectionTab() {
  return activeTab !== 'profile'
      && activeTab !== 'notifications'
      && activeTab !== 'cal-sync';
}

function connectionStatusChip(s) {
  const map = {
    active: 'chip-green',
    not_connected: 'chip-muted',
    error: 'chip-red',
    disabled: 'chip-muted',
  };
  return '<span class="chip ' + (map[s] || 'chip-muted') + '">' + (s || '').replace(/_/g, ' ') + '</span>';
}

/* ─── Tabs + dispatcher ─────────────────────────────────── */

async function loadAndRender() {
  // Render the tab bar. Connection-tab labels show counts; Profile + Notifications show as plain labels.
  let connections = [];
  if (_isConnectionTab()) {
    const data = await api.load(DATA_PATH);
    connections = data.connections || [];
  }

  const tabsEl = document.getElementById('tabs');
  tabsEl.innerHTML = '';
  TABS.forEach(t => {
    let label = t.label;
    if (t.key === 'all') label += ' (' + connections.length + ')';
    else if (_isConnectionTabKey(t.key)) {
      label += ' (' + connections.filter(c => c.type === t.key).length + ')';
    }
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (activeTab === t.key ? ' active' : '');
    btn.textContent = label;
    btn.onclick = function () {
      activeTab = t.key; _settSortKey = null; _settSortDir = 'asc';
      loadAndRender();
    };
    tabsEl.appendChild(btn);
  });

  // The `+ Add Connection` button only makes sense on connection tabs.
  const addBtn = document.getElementById('add-item');
  if (addBtn) addBtn.style.display = _isConnectionTab() ? '' : 'none';

  const content = document.getElementById('content');
  if (activeTab === 'profile') return renderProfile(content);
  if (activeTab === 'notifications') return renderNotifications(content);
  if (activeTab === 'cal-sync') return renderCalendarSync(content);
  return renderConnections(content, connections);
}

// Helper: is `key` a connection-type filter (vs a personal-config tab)?
function _isConnectionTabKey(k) {
  return k !== 'profile' && k !== 'notifications' && k !== 'cal-sync';
}

/* ─── Profile tab ───────────────────────────────────────── */

async function renderProfile(content) {
  content.innerHTML = '<div class="empty-state">Loading profile&hellip;</div>';
  const user = (firebridge && firebridge.getUser && firebridge.getUser()) || null;
  if (!user) {
    content.innerHTML = '<div class="empty-state">Sign in to edit your profile.</div>';
    return;
  }
  let profile = (firebridge.getProfile && firebridge.getProfile()) || {};
  // Prefer a fresh read so off-page edits show up.
  try {
    const doc = await firebridge.db().collection('users').doc(user.uid).get();
    if (doc.exists) profile = doc.data();
  } catch (e) { /* fall back to cached profile */ }

  const initial = ((profile.name || user.email || '?')[0] || '?').toUpperCase();
  const photo = profile.photoURL || profile.photo_url || '';

  content.innerHTML =
    '<div class="settings-card">' +
      '<div class="settings-row" style="align-items:center;gap:14px;">' +
        (photo
          ? '<img src="' + esc(photo) + '" class="settings-avatar" alt="">'
          : '<div class="settings-avatar settings-avatar-fallback">' + esc(initial) + '</div>') +
        '<div>' +
          '<div style="font-size:15px;font-weight:600;">' + esc(profile.name || user.email || '') + '</div>' +
          '<div style="font-size:13px;color:var(--text-muted);">' + esc(user.email || '') + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="form-group" style="margin-top:18px;">' +
        '<label for="prof-name">Display Name</label>' +
        '<input type="text" id="prof-name" value="' + esc(profile.name || '') + '" />' +
      '</div>' +

      '<div class="form-group">' +
        '<label for="prof-bio">Bio</label>' +
        '<textarea id="prof-bio" rows="3">' + esc(profile.bio || '') + '</textarea>' +
      '</div>' +

      '<div class="settings-toggle-row">' +
        '<div>' +
          '<div class="settings-toggle-label">Share Activity with PI</div>' +
          '<div class="settings-toggle-sub">Allow the PI to see your activity tracker entries on the lab dashboard.</div>' +
        '</div>' +
        '<label class="settings-switch">' +
          '<input type="checkbox" id="prof-share" ' + (profile.shareActivity ? 'checked' : '') + ' />' +
          '<span class="settings-switch-track"></span>' +
        '</label>' +
      '</div>' +

      '<div class="settings-actions">' +
        '<button class="btn btn-primary" id="prof-save">Save Profile</button>' +
        '<span class="settings-status" id="prof-status"></span>' +
      '</div>' +
    '</div>';

  document.getElementById('prof-save').addEventListener('click', async () => {
    const btn = document.getElementById('prof-save');
    const status = document.getElementById('prof-status');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const patch = {
        name: (document.getElementById('prof-name').value || '').trim(),
        bio:  (document.getElementById('prof-bio').value || '').trim(),
        shareActivity: !!document.getElementById('prof-share').checked,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };
      await firebridge.db().collection('users').doc(user.uid).set(patch, { merge: true });
      // Mirror onto the cached profile so other pages see fresh values.
      Object.assign(profile, patch);
      status.textContent = 'Saved';
      status.className = 'settings-status settings-status--success';
      setTimeout(() => { status.textContent = ''; }, 2000);
    } catch (err) {
      console.warn('[settings] profile save failed:', err);
      status.textContent = 'Save failed: ' + (err.message || err);
      status.className = 'settings-status settings-status--error';
    }
    btn.disabled = false;
    btn.textContent = 'Save Profile';
  });
}

/* ─── Notifications tab ─────────────────────────────────── */

function _defaultNotifSettings() {
  return {
    notifications: {
      enabled: true,
      quietHours: { enabled: false, start: '22:00', end: '07:00' },
      apps: {
        chat: { push: true },
        meetings: { push: true },
        equipment: { push: true },
        huddle: { push: true },
        scheduler: { push: true },
        activityTracker: { push: false },
      },
    },
  };
}

async function renderNotifications(content) {
  content.innerHTML = '<div class="empty-state">Loading notification settings&hellip;</div>';
  const user = (firebridge && firebridge.getUser && firebridge.getUser()) || null;
  if (!user) {
    content.innerHTML = '<div class="empty-state">Sign in to manage notifications.</div>';
    return;
  }

  let settings = _defaultNotifSettings();
  try {
    const doc = await firebridge.db().collection('userSettings').doc(user.uid).get();
    if (doc.exists) settings = Object.assign(_defaultNotifSettings(), doc.data());
  } catch (e) { /* fall back to defaults */ }

  const notif = settings.notifications || _defaultNotifSettings().notifications;
  const qh    = notif.quietHours || _defaultNotifSettings().notifications.quietHours;
  const apps  = notif.apps || _defaultNotifSettings().notifications.apps;

  function row(id, label, sub, checked) {
    return (
      '<div class="settings-toggle-row">' +
        '<div>' +
          '<div class="settings-toggle-label">' + esc(label) + '</div>' +
          (sub ? '<div class="settings-toggle-sub">' + esc(sub) + '</div>' : '') +
        '</div>' +
        '<label class="settings-switch">' +
          '<input type="checkbox" id="' + id + '" ' + (checked ? 'checked' : '') + ' />' +
          '<span class="settings-switch-track"></span>' +
        '</label>' +
      '</div>'
    );
  }

  content.innerHTML =
    '<div class="settings-card">' +
      '<h3 class="settings-h3">Master</h3>' +
      row('n-master', 'Push Notifications', 'Top-level switch — turns every channel below off.', notif.enabled) +

      '<h3 class="settings-h3">Per-app push</h3>' +
      row('n-chat',      'Lab Chat',         'Messages, mentions, DMs',                    !!(apps.chat && apps.chat.push)) +
      row('n-meetings',  'Lab Meetings',     'Meeting reminders and agenda updates',       !!(apps.meetings && apps.meetings.push)) +
      row('n-equipment', 'Equipment',        'Booking confirmations and reminders',        !!(apps.equipment && apps.equipment.push)) +
      row('n-huddle',    'The Huddle',       'Weekly plan updates and join requests',      !!(apps.huddle && apps.huddle.push)) +
      row('n-scheduler', 'Scheduler',        'Schedule invitations and assignment changes', !!(apps.scheduler && apps.scheduler.push)) +
      row('n-activity',  'Activity Tracker', 'Daily logging reminders',                     !!(apps.activityTracker && apps.activityTracker.push)) +

      '<h3 class="settings-h3">Quiet Hours</h3>' +
      row('n-quiet', 'Do Not Disturb', 'Silence notifications during the hours below.', qh.enabled) +
      '<div class="settings-time-row" id="n-quiet-times" style="' + (qh.enabled ? '' : 'opacity:.45;pointer-events:none;') + '">' +
        '<label for="n-quiet-start">From</label>' +
        '<input type="time" id="n-quiet-start" value="' + esc(qh.start || '22:00') + '" />' +
        '<label for="n-quiet-end">To</label>' +
        '<input type="time" id="n-quiet-end" value="' + esc(qh.end || '07:00') + '" />' +
      '</div>' +

      '<div class="settings-actions">' +
        '<button class="btn btn-primary" id="n-save">Save Notifications</button>' +
        '<span class="settings-status" id="n-status"></span>' +
      '</div>' +
    '</div>';

  // Quiet-hours toggle dims the time pickers
  document.getElementById('n-quiet').addEventListener('change', e => {
    const wrap = document.getElementById('n-quiet-times');
    if (!wrap) return;
    if (e.target.checked) { wrap.style.opacity = ''; wrap.style.pointerEvents = ''; }
    else { wrap.style.opacity = '.45'; wrap.style.pointerEvents = 'none'; }
  });

  document.getElementById('n-save').addEventListener('click', async () => {
    const btn = document.getElementById('n-save');
    const status = document.getElementById('n-status');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const patch = {
        notifications: {
          enabled: !!document.getElementById('n-master').checked,
          quietHours: {
            enabled: !!document.getElementById('n-quiet').checked,
            start: document.getElementById('n-quiet-start').value || '22:00',
            end:   document.getElementById('n-quiet-end').value   || '07:00',
          },
          apps: {
            chat:            { push: !!document.getElementById('n-chat').checked },
            meetings:        { push: !!document.getElementById('n-meetings').checked },
            equipment:       { push: !!document.getElementById('n-equipment').checked },
            huddle:          { push: !!document.getElementById('n-huddle').checked },
            scheduler:       { push: !!document.getElementById('n-scheduler').checked },
            activityTracker: { push: !!document.getElementById('n-activity').checked },
          },
        },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };
      await firebridge.db().collection('userSettings').doc(user.uid).set(patch, { merge: true });
      status.textContent = 'Saved';
      status.className = 'settings-status settings-status--success';
      setTimeout(() => { status.textContent = ''; }, 2000);
    } catch (err) {
      console.warn('[settings] notif save failed:', err);
      status.textContent = 'Save failed: ' + (err.message || err);
      status.className = 'settings-status settings-status--error';
    }
    btn.disabled = false;
    btn.textContent = 'Save Notifications';
  });
}

/* ─── Calendar Sync tab (V3.54) ─────────────────────────────
 * Lifted from /apps/settings/app.js renderCalendarSection() +
 * wireCalendar(), adapted to RM idiom (.cal-card, .btn primary,
 * .settings-toggle-row, .settings-status). Drives the McgheeLab.
 * CalendarService singleton brought into RM in V3.51.
 *
 * Three providers:
 *   - Google Calendar — OAuth Client ID input + GIS token client.
 *   - Outlook / Microsoft 365 — paste public ICS link OR upload .ics
 *     file OR OAuth via Azure App ID (advanced).
 *   - Apple Calendar — upload .ics file OR fetch from URL.
 *
 * Sync settings: auto-refresh interval + "Sync to Huddle" toggle
 * (auto-blocks calendar events as blackout time in the user's
 * Huddle schedule).
 */

function _calSvc() {
  return (typeof McgheeLab !== 'undefined' && McgheeLab.CalendarService) || null;
}

async function renderCalendarSync(content) {
  content.innerHTML = '<div class="empty-state">Loading calendar settings&hellip;</div>';

  const cal = _calSvc();
  if (!cal) {
    content.innerHTML =
      '<div class="empty-state">Calendar service not loaded. ' +
      'Reload the page; if the problem persists, check the browser console for CalendarService errors.</div>';
    return;
  }

  // Ensure service is initialised against the current user (idempotent).
  const user = (firebridge && firebridge.getUser && firebridge.getUser()) || null;
  if (user && cal.init) {
    try { await cal.init(user, {}); } catch (e) { console.warn('[settings] CalendarService init:', e); }
  }

  const cfg  = (cal.getConfig && cal.getConfig()) || {};
  const conn = (cal.isConnected && cal.isConnected()) || {};

  const refreshOpts = [
    { val: 0,   label: 'Disabled' },
    { val: 15,  label: 'Every 15 minutes' },
    { val: 30,  label: 'Every 30 minutes' },
    { val: 60,  label: 'Every hour' },
    { val: 120, label: 'Every 2 hours' },
    { val: 240, label: 'Every 4 hours' },
  ];

  content.innerHTML =
    '<div class="settings-card">' +
      '<h3 class="settings-h3">Providers</h3>' +
      '<div class="cal-providers">' +

        // Google
        '<div class="cal-card">' +
          '<div class="cal-header">' +
            '<span class="cal-icon">' + _googleIcon() + '</span>' +
            '<strong>Google Calendar</strong>' +
            '<span class="cal-badge ' + (conn.google ? 'cal-badge--on' : '') + '">' +
              (conn.google ? 'Connected' : 'Not connected') +
            '</span>' +
          '</div>' +
          (conn.google
            ? '<div class="cal-actions"><button class="btn proc-btn-danger" id="cal-gcal-disconnect">Disconnect</button></div>'
            : '<div class="cal-body">' +
                '<div class="form-group">' +
                  '<label for="cal-gcal-client-id">OAuth Client ID</label>' +
                  '<input type="text" id="cal-gcal-client-id" placeholder="xxxx.apps.googleusercontent.com" value="' + esc(cfg.gcalClientId || '') + '" />' +
                  '<div class="cal-hint">console.cloud.google.com → APIs → Credentials → OAuth 2.0 Client ID. Add this site origin to "Authorized JavaScript origins" before connecting.</div>' +
                '</div>' +
                '<div class="cal-actions"><button class="btn btn-primary" id="cal-gcal-connect">Connect Google Calendar</button></div>' +
              '</div>') +
        '</div>' +

        // Outlook / Microsoft 365
        '<div class="cal-card">' +
          '<div class="cal-header">' +
            '<span class="cal-icon">' + _outlookIcon() + '</span>' +
            '<strong>Outlook / Microsoft 365</strong>' +
            '<span class="cal-badge ' + (conn.outlook || conn.outlookIcs ? 'cal-badge--on' : '') + '">' +
              (conn.outlook ? 'Connected (API)' : conn.outlookIcs ? 'Imported (ICS)' : 'Not connected') +
            '</span>' +
          '</div>' +
          '<div class="cal-body">' +
            '<div class="cal-hint">Paste your published Outlook calendar link (HTML or ICS — both work).</div>' +
            '<div class="cal-row">' +
              '<input type="text" id="cal-outlook-ics-url" placeholder="https://outlook.office365.com/owa/calendar/.../calendar.html" value="' + esc(cfg.outlookIcsUrl || '') + '" />' +
              '<button class="btn btn-primary" id="cal-outlook-ics-fetch">Fetch</button>' +
            '</div>' +
            '<details class="cal-details">' +
              '<summary>Alternative: Import .ics file</summary>' +
              '<div class="cal-row" style="margin-top:8px;">' +
                '<label class="btn" style="cursor:pointer;">' +
                  'Choose .ics file' +
                  '<input type="file" id="cal-outlook-ics-file" accept=".ics,.ical" hidden />' +
                '</label>' +
                (conn.outlookIcs ? '<button class="btn proc-btn-danger" id="cal-outlook-ics-clear">Clear</button>' : '') +
              '</div>' +
            '</details>' +
            '<details class="cal-details">' +
              '<summary>Advanced: OAuth API</summary>' +
              '<div style="margin-top:8px;">' +
                (conn.outlook
                  ? '<button class="btn proc-btn-danger" id="cal-msal-disconnect">Disconnect API</button>'
                  : '<div class="form-group">' +
                      '<label for="cal-msal-client-id">Azure App (Client) ID</label>' +
                      '<input type="text" id="cal-msal-client-id" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="' + esc(cfg.msalClientId || '') + '" />' +
                      '<div class="cal-hint">portal.azure.com → App registrations → New → SPA redirect</div>' +
                      '<div class="cal-actions"><button class="btn btn-primary" id="cal-msal-connect">Connect via OAuth</button></div>' +
                    '</div>') +
              '</div>' +
            '</details>' +
          '</div>' +
        '</div>' +

        // Apple Calendar (ICS)
        '<div class="cal-card">' +
          '<div class="cal-header">' +
            '<span class="cal-icon">' + _appleIcon() + '</span>' +
            '<strong>Apple Calendar</strong>' +
            '<span class="cal-badge ' + (cfg.icsUrl ? 'cal-badge--on' : '') + '">' +
              (cfg.icsUrl ? 'Connected (ICS)' : 'File / URL') +
            '</span>' +
          '</div>' +
          '<div class="cal-body">' +
            '<div class="cal-hint">Export from Calendar.app (File → Export) or publish via iCloud (Share → Public Calendar → copy URL).</div>' +
            '<div class="cal-row">' +
              '<label class="btn" style="cursor:pointer;">' +
                'Choose .ics file' +
                '<input type="file" id="cal-ics-file" accept=".ics,.ical" hidden />' +
              '</label>' +
            '</div>' +
            '<div class="cal-row">' +
              '<input type="text" id="cal-ics-url" placeholder="https://p##-caldav.icloud.com/..." value="' + esc(cfg.icsUrl || '') + '" />' +
              '<button class="btn btn-primary" id="cal-ics-fetch">Fetch</button>' +
              (cfg.icsUrl ? '<button class="btn proc-btn-danger" id="cal-ics-clear">Clear</button>' : '') +
            '</div>' +
          '</div>' +
        '</div>' +

      '</div>' + // .cal-providers

      '<h3 class="settings-h3">Sync Settings</h3>' +

      '<div class="settings-toggle-row">' +
        '<div>' +
          '<div class="settings-toggle-label">Auto-Refresh Interval</div>' +
          '<div class="settings-toggle-sub">How often to re-fetch calendar events from connected providers.</div>' +
        '</div>' +
        '<select id="cal-refresh-interval" class="cal-select">' +
          refreshOpts.map(o => '<option value="' + o.val + '"' + (cfg.autoRefreshMinutes === o.val ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') +
        '</select>' +
      '</div>' +

      '<div class="settings-toggle-row">' +
        '<div>' +
          '<div class="settings-toggle-label">Sync to Huddle</div>' +
          '<div class="settings-toggle-sub">Auto-block calendar events as blackout times in your Huddle schedule.</div>' +
        '</div>' +
        '<label class="settings-switch">' +
          '<input type="checkbox" id="cal-huddle-sync" ' + (cfg.huddle && cfg.huddle.autoBlock ? 'checked' : '') + ' />' +
          '<span class="settings-switch-track"></span>' +
        '</label>' +
      '</div>' +

      '<div class="settings-actions">' +
        '<button class="btn btn-primary" id="cal-save">Save Calendar Settings</button>' +
        '<span class="settings-status" id="cal-status"></span>' +
      '</div>' +
    '</div>';

  wireCalendarSync(cal);
}

function wireCalendarSync(cal) {
  const status = document.getElementById('cal-status');
  function showStatus(msg, kind) {
    if (!status) return;
    status.textContent = msg;
    status.className = 'settings-status' + (kind === 'success' ? ' settings-status--success' : kind === 'error' ? ' settings-status--error' : '');
    if (kind === 'success') setTimeout(() => { if (status) status.textContent = ''; }, 2500);
  }

  // ─── Google Calendar ───────────────────────────────────
  const gConnect = document.getElementById('cal-gcal-connect');
  if (gConnect) gConnect.addEventListener('click', async () => {
    const clientId = (document.getElementById('cal-gcal-client-id').value || '').trim();
    if (!clientId) { showStatus('Enter your OAuth Client ID', 'error'); return; }
    try {
      await cal.connectGoogle(clientId);
      renderCalendarSync(document.getElementById('content'));
      showStatus('Google Calendar connected', 'success');
    } catch (err) {
      showStatus('Google OAuth error: ' + (err.message || err), 'error');
    }
  });

  const gDisc = document.getElementById('cal-gcal-disconnect');
  if (gDisc) gDisc.addEventListener('click', () => {
    cal.disconnectGoogle();
    renderCalendarSync(document.getElementById('content'));
    showStatus('Google Calendar disconnected', 'success');
  });

  // ─── Outlook OAuth ─────────────────────────────────────
  const msConnect = document.getElementById('cal-msal-connect');
  if (msConnect) msConnect.addEventListener('click', async () => {
    const clientId = (document.getElementById('cal-msal-client-id').value || '').trim();
    if (!clientId) { showStatus('Enter your Azure App ID', 'error'); return; }
    try {
      await cal.connectOutlook(clientId);
      renderCalendarSync(document.getElementById('content'));
      showStatus('Outlook connected', 'success');
    } catch (err) {
      showStatus('Outlook auth error: ' + (err.message || err), 'error');
    }
  });

  const msDisc = document.getElementById('cal-msal-disconnect');
  if (msDisc) msDisc.addEventListener('click', () => {
    cal.disconnectOutlook();
    renderCalendarSync(document.getElementById('content'));
    showStatus('Outlook disconnected', 'success');
  });

  // ─── Outlook ICS file ──────────────────────────────────
  const outIcsFile = document.getElementById('cal-outlook-ics-file');
  if (outIcsFile) outIcsFile.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const result = await cal.importICSFile(file, 'outlook_ics');
      renderCalendarSync(document.getElementById('content'));
      showStatus('Imported ' + result.count + ' Outlook event' + (result.count !== 1 ? 's' : ''), 'success');
    } catch (err) {
      showStatus('Failed to parse file: ' + (err.message || err), 'error');
    }
  });

  const outIcsClear = document.getElementById('cal-outlook-ics-clear');
  if (outIcsClear) outIcsClear.addEventListener('click', () => {
    if (cal.clearProvider) cal.clearProvider('outlook_ics');
    cal.saveConfig({ outlookIcsUrl: '' });
    renderCalendarSync(document.getElementById('content'));
    showStatus('Outlook ICS cleared', 'success');
  });

  // ─── Outlook ICS URL fetch ─────────────────────────────
  const outIcsFetch = document.getElementById('cal-outlook-ics-fetch');
  if (outIcsFetch) outIcsFetch.addEventListener('click', async () => {
    const url = (document.getElementById('cal-outlook-ics-url').value || '').trim();
    if (!url) { showStatus('Paste your Outlook ICS link', 'error'); return; }
    outIcsFetch.disabled = true; outIcsFetch.textContent = 'Fetching…';
    try {
      await cal.saveConfig({ outlookIcsUrl: url });
      const result = await cal.fetchICSFromUrl(url, 'outlook_ics');
      renderCalendarSync(document.getElementById('content'));
      showStatus('Outlook ICS fetched — ' + result.count + ' event' + (result.count !== 1 ? 's' : ''), 'success');
    } catch (err) {
      outIcsFetch.disabled = false; outIcsFetch.textContent = 'Fetch';
      showStatus('Failed to fetch ICS: ' + (err.message || 'CORS or network error — try importing the .ics file directly'), 'error');
    }
  });

  // ─── Apple ICS file ────────────────────────────────────
  const aIcsFile = document.getElementById('cal-ics-file');
  if (aIcsFile) aIcsFile.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const result = await cal.importICSFile(file, 'ics');
      renderCalendarSync(document.getElementById('content'));
      showStatus('Imported ' + result.count + ' event' + (result.count !== 1 ? 's' : ''), 'success');
    } catch (err) {
      showStatus('Failed to parse file: ' + (err.message || err), 'error');
    }
  });

  // ─── Apple ICS URL fetch ───────────────────────────────
  const aIcsFetch = document.getElementById('cal-ics-fetch');
  if (aIcsFetch) aIcsFetch.addEventListener('click', async () => {
    const url = (document.getElementById('cal-ics-url').value || '').trim();
    if (!url) { showStatus('Enter an ICS URL', 'error'); return; }
    aIcsFetch.disabled = true; aIcsFetch.textContent = 'Fetching…';
    try {
      await cal.saveConfig({ icsUrl: url });
      const result = await cal.fetchICSFromUrl(url, 'ics');
      renderCalendarSync(document.getElementById('content'));
      showStatus('ICS fetched — ' + result.count + ' event' + (result.count !== 1 ? 's' : ''), 'success');
    } catch (err) {
      aIcsFetch.disabled = false; aIcsFetch.textContent = 'Fetch';
      showStatus('Failed to fetch ICS: ' + (err.message || 'CORS or network error — try importing the .ics file directly'), 'error');
    }
  });

  const aIcsClear = document.getElementById('cal-ics-clear');
  if (aIcsClear) aIcsClear.addEventListener('click', () => {
    if (cal.clearProvider) cal.clearProvider('ics');
    cal.saveConfig({ icsUrl: '' });
    renderCalendarSync(document.getElementById('content'));
    showStatus('Apple ICS cleared', 'success');
  });

  // ─── Save sync settings ────────────────────────────────
  const saveBtn = document.getElementById('cal-save');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      const refreshMinutes = parseInt(document.getElementById('cal-refresh-interval').value, 10) || 0;
      const huddleSync = !!document.getElementById('cal-huddle-sync').checked;
      await cal.saveConfig({
        autoRefreshMinutes: refreshMinutes,
        huddle: { autoBlock: huddleSync },
      });
      if (cal.startAutoRefresh) cal.startAutoRefresh(refreshMinutes);
      showStatus('Calendar settings saved', 'success');
    } catch (err) {
      showStatus('Failed to save: ' + (err.message || err), 'error');
    }
    saveBtn.disabled = false; saveBtn.textContent = 'Save Calendar Settings';
  });
}

/* Provider icons (lifted from /apps/settings/app.js so the renderer
 * is self-contained even if the lab-shared icon helpers go away.) */
function _googleIcon() {
  return '<svg viewBox="0 0 24 24" width="18" height="18">' +
    '<path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>' +
    '<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>' +
    '<path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>' +
    '<path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>' +
    '</svg>';
}
function _outlookIcon() {
  return '<svg viewBox="0 0 24 24" width="18" height="18">' +
    '<path fill="#0078D4" d="M24 7.387v10.478c0 .23-.08.424-.238.583a.793.793 0 01-.583.238h-8.87V6.565h8.87c.23 0 .424.08.583.238.159.159.238.353.238.583z"/>' +
    '<path fill="#0364B8" d="M14.309 6.565v12.122L0 16.58V4.674l14.309 1.891z"/>' +
    '<ellipse fill="#fff" cx="7.155" cy="11.626" rx="3.46" ry="3.98"/>' +
    '<ellipse fill="#0078D4" cx="7.155" cy="11.626" rx="2.38" ry="2.93"/>' +
    '</svg>';
}
function _appleIcon() {
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">' +
    '<path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>' +
    '</svg>';
}

/* ─── Connections tab (existing behavior) ───────────────── */

function renderConnections(content, connections) {
  // Filter
  const filtered = activeTab === 'all'
    ? connections
    : connections.filter(c => c.type === activeTab);

  if (filtered.length === 0) {
    content.innerHTML = '<div class="empty-state">No connections in this category. Click <strong>+ Add Connection</strong> to add one.</div>';
    return;
  }

  var sortedConn = sortItems(filtered, _settSortKey, _settSortDir, CONN_COLUMNS);
  let html = '<table class="data-table">' +
    sortableHeader(CONN_COLUMNS, _settSortKey, _settSortDir, 'onSettingsSort') +
    '<tbody>';

  sortedConn.forEach(function (c) {
    const idx = connections.indexOf(c);
    html += '<tr>' +
      '<td><strong>' + (c.name || '') + '</strong></td>' +
      '<td>' + (c.type || '') + '</td>' +
      '<td>' + (c.provider || '') + '</td>' +
      '<td>' + (c.account || '') + '</td>' +
      '<td>' + (c.forward_to || '') + '</td>' +
      '<td>' + connectionStatusChip(c.status) + '</td>' +
      '<td style="font-size:0.85em">' + (c.notes || '') + '</td>' +
      '<td class="row-actions">' +
        '<button onclick="editItem(' + idx + ')">Edit</button>' +
        '<button onclick="deleteItem(' + idx + ')">Delete</button>' +
      '</td>' +
      '</tr>';
  });

  html += '</tbody></table>';
  content.innerHTML = html;
}

window.onSettingsSort = function (key) {
  if (_settSortKey === key) { _settSortDir = _settSortDir === 'asc' ? 'desc' : 'asc'; }
  else { _settSortKey = key; _settSortDir = 'asc'; }
  loadAndRender();
};

window.editItem = async function (index) {
  const data = await api.load(DATA_PATH);
  const item = data.connections[index];
  openForm({
    title: 'Edit Connection',
    fields: CONNECTION_FIELDS,
    values: item,
    onSave: async function (vals) {
      Object.assign(data.connections[index], vals);
      data.connections[index].id = slugify(vals.name);
      await api.save(DATA_PATH, data);
      loadAndRender();
    },
  });
};

window.deleteItem = async function (index) {
  if (!confirmAction('Remove this connection?')) return;
  const data = await api.load(DATA_PATH);
  data.connections.splice(index, 1);
  await api.save(DATA_PATH, data);
  loadAndRender();
};

document.getElementById('add-item').onclick = function () {
  // Defensive: when the user is on Profile / Notifications the button is
  // hidden, but this onclick is registered once at module load.
  if (!_isConnectionTab()) return;
  openForm({
    title: 'Add Connection',
    fields: CONNECTION_FIELDS,
    values: { status: 'not_connected' },
    onSave: async function (vals) {
      const data = await api.load(DATA_PATH);
      vals.id = slugify(vals.name);
      data.connections.push(vals);
      await api.save(DATA_PATH, data);
      loadAndRender();
    },
  });
};

/* Tiny utility — escapes HTML entities. (Inline rather than depending on
 * util.js, which uses formatDate / today / sortItems but no esc helper.) */
function esc(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

(async function () {
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) await firebridge.whenAuthResolved();
  await loadAndRender();
  // No LIVE_SYNC.attach: settings are per-user, single-tab in practice.
})();
