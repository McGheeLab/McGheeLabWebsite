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
  { key: 'all',           label: 'All Connections' },
  { key: 'email',         label: 'Email' },
  { key: 'calendar',      label: 'Calendars' },
  { key: 'repository',    label: 'Repositories' },
  { key: 'messaging',     label: 'Messaging' },
  { key: 'finance',       label: 'Finance' },
];

let activeTab = 'profile';

function _isConnectionTab() {
  return activeTab !== 'profile' && activeTab !== 'notifications';
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
    else if (t.key !== 'profile' && t.key !== 'notifications') {
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
  return renderConnections(content, connections);
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
